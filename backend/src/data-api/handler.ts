// backend/src/data-api/handler.ts
//
// The in-VPC data-API Lambda — the SOLE DB client for the dashboard tier (D-14 no-pg-from-Vercel forces
// every read through this fn). Since Phase-2 this was a single GET /api/health → SELECT 1 probe; Plan
// 06-01 (SC0 / D1) turns it into the READ ROUTER for the whole dashboard: an internal `routeKey` switch
// serves five reads behind the SAME API GW HTTP API + the SAME Cognito JWT defaultAuthorizer.
//
//   Bearer id_token → API GW HTTP API ( native Cognito JWT authorizer = the enforcement boundary, D-09 )
//     → THIS Lambda (routeKey switch) → RDS SELECT → JSON
//
// Routes (all read-only, all on THIS one SELECT-role fn — D1, zero IAM delta; writes stay on their own
// dedicated least-privilege fns):
//   GET /api/health            → SELECT 1 (the SC4 probe, unchanged)
//   GET /api/patients          → roster badges + trailing adherence/last reply/recent outcomes +
//                                per-patient consecutive-miss run (D5) + the alert threshold
//   GET /api/patients/{id}     → detail (patient + frozen drug profile) + the per-dose timeline
//   GET /api/cohort-adherence  → the selectable 7/30/90-day cohort series (D4: dose_date buckets,
//                                timeout-gate denominator, 4-state confirmed numerator, ambiguous split)
//   GET /api/reviews/safety    → the safety review queue (U-12/C-10 urgent-first; U-19 fan-out-free hints)
//   GET /api/reviews/unknown   → ambiguity + non-safety label-match arms (U-17/U-18/C-6)
//
// API Gateway validates the JWT signature/audience; this Lambda additionally requires the verified ID
// token's Cognito `sub` and binds it into every patient-bearing SQL statement. The `{id}` route validates
// its path param with the zod `.parse()` D-16 gate BEFORE any DB reach (a non-UUID 400s before getPool()),
// mirroring the deactivate write fn. Every read SQL is exported as a constant so the
// read-contract.test.ts real-PG16 matrix drives the EXACT handler SQL (no drift between semantics/proof).
//
// PII posture: this is the AUTHENTICATED single-admin clinician surface (behind the Cognito authorizer),
// so the review queues legitimately return the patient's message text for the reviewer. Logs remain
// identifier-free (never record IDs, clinician IDs, phone, or body).
//
// Reuses the Phase-1/2 posture EXACTLY: a module-scoped `pg.Pool({ max: 2 })` (D-11) reused across warm
// invokes; the DB credential fetched from Secrets Manager (D-06 — never an env var) ONCE per cold
// container; single-source TLS (F28) via the explicit `ssl` object pinned to the RDS global CA bundle
// with rejectUnauthorized:true (M-2). Module mode: CommonJS (F11) — `__dirname`/`readFileSync` resolve
// the bundled CA PEM natively.

import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { RESPONSE_WINDOW_MINUTES } from '@medadhere/shared';
import { Pool } from 'pg';
import { z } from 'zod';
import { ClinicianClaimsError, requireClinicianClaims } from '../shared/clinician-claims';
import { createDbPoolProvider } from '../shared/db-pool';
import { handler as clinicalHistoryHandler } from '../clinical-history/handler';
import { handlePatientReadRoute, patientAlertState } from './patient-record-route';
import { PATIENT_DETAILS_ROUTE_KEY, handlePatientDetailsRoute } from './patient-details';

/** Reuse the Secrets Manager client across warm invocations (module scope → fewer TLS handshakes). */
const sm = new SecretsManagerClient({});

const getPool = createDbPoolProvider(sm);

/**
 * The API GW v2 HTTP-proxy event subset this handler consumes: the `routeKey` selects the read, and
 * `pathParameters.id` carries the `{id}` path param and `queryStringParameters.days` carries the cohort
 * window. No aws-lambda types import (mirrors deactivate).
 */
interface DataApiEvent {
  routeKey?: string;
  pathParameters?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    authorizer?: {
      jwt?: {
        claims?: Record<string, unknown>;
      };
    };
  };
}

/** The API GW HTTP-integration response shape. */
interface HttpResult {
  statusCode: number;
  headers: { 'content-type': string };
  body: string;
}

/** Exact supported cohort windows. Missing `days` preserves the original trailing-30-day default. */
const cohortWindowDaysSchema = z
  .enum(['7', '30', '90'])
  .default('30')
  .transform((days) => Number(days));

// --- ALERT threshold (D5) -----------------------------------------------------------------------------
// The consecutive-miss count at/above which the DASH-04 banner fires. Env-tunable (default 3), parsed and
// clamped so a misconfigured deploy can never disable the alert or set a nonsensical value.
const DEFAULT_ALERT_CONSECUTIVE_MISSED = 3;
const MIN_ALERT_THRESHOLD = 1;
const MAX_ALERT_THRESHOLD = 30;

/**
 * The parsed + clamped `ALERT_CONSECUTIVE_MISSED` threshold (D5). Defaults to 3 when unset; falls back to
 * 3 on any non-integer garbage; clamps a valid integer into [1, 30]. Exported + read at call time so the
 * unit test drives it directly and a warm Lambda picks up the (rare) env override.
 */
export function alertThreshold(): number {
  const raw = process.env.ALERT_CONSECUTIVE_MISSED;
  if (raw === undefined || raw.trim() === '') return DEFAULT_ALERT_CONSECUTIVE_MISSED;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return DEFAULT_ALERT_CONSECUTIVE_MISSED;
  return Math.min(MAX_ALERT_THRESHOLD, Math.max(MIN_ALERT_THRESHOLD, parsed));
}

// --- Stuck safety-send threshold (C-10) ---------------------------------------------------------------
// A safety reservation left in `sending` cannot be retried by the classifier. Surface it as urgent after
// a bounded operator-tunable interval. One day is a deliberately generous maximum that still prevents a
// configuration typo from hiding stranded sends indefinitely.
const DEFAULT_SAFETY_SENDING_STUCK_MINUTES = 15;
const MIN_SAFETY_SENDING_STUCK_MINUTES = 1;
const MAX_SAFETY_SENDING_STUCK_MINUTES = 1440;

/** Parse + clamp SAFETY_SENDING_STUCK_MINUTES at call time so warm invocations observe env changes. */
export function safetySendingStuckMinutes(): number {
  const raw = process.env.SAFETY_SENDING_STUCK_MINUTES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_SAFETY_SENDING_STUCK_MINUTES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return DEFAULT_SAFETY_SENDING_STUCK_MINUTES;
  return Math.min(
    MAX_SAFETY_SENDING_STUCK_MINUTES,
    Math.max(MIN_SAFETY_SENDING_STUCK_MINUTES, parsed),
  );
}

// --- Response window + read bounds (RETRO-4/5, U18) -----------------------------------------------
// The Timeout scheduler fires at sent_at + RESPONSE_WINDOW_MINUTES. The dashboard reads must use that
// same anchor/default so a dose never changes denominator or streak semantics merely by crossing tiers.
const DEFAULT_RESPONSE_WINDOW_MINUTES = RESPONSE_WINDOW_MINUTES;
const MIN_RESPONSE_WINDOW_MINUTES = 1;
const MAX_RESPONSE_WINDOW_MINUTES = 1440;

/** Parse + clamp RESPONSE_WINDOW_MINUTES at call time; default 120 matches the Timeout scheduler. */
export function responseWindowMinutes(): number {
  const raw = process.env.RESPONSE_WINDOW_MINUTES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_RESPONSE_WINDOW_MINUTES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return DEFAULT_RESPONSE_WINDOW_MINUTES;
  return Math.min(MAX_RESPONSE_WINDOW_MINUTES, Math.max(MIN_RESPONSE_WINDOW_MINUTES, parsed));
}

const DEFAULT_PATIENT_TIMELINE_WINDOW_DAYS = 30;
const MIN_PATIENT_TIMELINE_WINDOW_DAYS = 1;
const MAX_PATIENT_TIMELINE_WINDOW_DAYS = 365;

/** Parse + clamp the server-owned per-patient timeline window. */
export function timelineWindowDays(): number {
  const raw = process.env.PATIENT_TIMELINE_WINDOW_DAYS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PATIENT_TIMELINE_WINDOW_DAYS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return DEFAULT_PATIENT_TIMELINE_WINDOW_DAYS;
  return Math.min(
    MAX_PATIENT_TIMELINE_WINDOW_DAYS,
    Math.max(MIN_PATIENT_TIMELINE_WINDOW_DAYS, parsed),
  );
}

const DEFAULT_REVIEW_QUEUE_LIMIT = 100;
const MIN_REVIEW_QUEUE_LIMIT = 1;
const MAX_REVIEW_QUEUE_LIMIT = 500;

/** Parse + clamp the shared server-owned safety/unknown review queue row limit. */
export function reviewQueueLimit(): number {
  const raw = process.env.REVIEW_QUEUE_LIMIT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_REVIEW_QUEUE_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return DEFAULT_REVIEW_QUEUE_LIMIT;
  return Math.min(MAX_REVIEW_QUEUE_LIMIT, Math.max(MIN_REVIEW_QUEUE_LIMIT, parsed));
}

// --- Pinned read SQL (exported for the real-PG read-contract test — no drift) -------------------------

/**
 * GET /api/patients — the cohort list (D1/D5/D14). One row per patient (NO is_test filter — D14 badges,
 * never filters) with the badge columns, per-patient trailing consecutive-miss run, and real handoff
 * roster data: trailing-30-day clinical adherence, last real inbound reply, and latest 14 resolved doses.
 *
 * Trailing-miss run (D5/U-23/RETRO-5), computed per patient over doses ordered
 * `(scheduled_at, id) DESC`:
 *   - `ordered`: excludes future not-yet-fired schedules. A no-record dose is exempt ONLY while a real,
 *     non-failed outbound send's `sent_at + $2 response-window minutes` is still open. Every closed
 *     no-record case is a breaker: failed/undelivered, `sending` with NULL sent_at, any other outbound
 *     status with NULL sent_at, and already-fired/no-outbound doses. A timeout `missed` whose final
 *     outbound status later becomes failed/undelivered also becomes a breaker.
 *   - `scored`: drops only those genuinely open windows, then ranks every closed/outcome row DESC.
 *   - `miss_run`: the run length = the position of the FIRST non-'missed' outcome minus 1 (a 'recorded'
 *     reply OR a closed no-record/delivery-failure gap breaks the run via `IS DISTINCT FROM 'missed'`),
 *     or count(*) when every retained dose is a delivery-eligible closed `missed`. `::int` keeps JS numeric.
 * A patient with zero scored doses simply has no miss_run row → COALESCE(…, 0).
 *
 * Reported-miss run (separate alert — never mixed with the silence streak above): `reported_ranked`
 * ranks ONLY classifier-recorded outcomes (`status='recorded' AND decided_by='classifier'`, the
 * clinical_30d filter discipline — deliberately NO outbound_message join: a reported outcome needs no
 * delivery/response-window gate) per patient over `(scheduled_at, id) DESC`; `reported_miss_run` counts
 * the leading consecutive `adherence_state='skipped'` rows. A non-skipped reply breaks the run; a
 * timeout silence is invisible here (it is the OTHER streak), so it neither breaks nor extends it.
 *
 * $1 = optional patient UUID (NULL means the whole list); $2 = clamped response-window minutes;
 * $3 = authenticated clinician subject. `owned_patients` is the sole patient root for every child CTE,
 * so foreign and ownerless rows cannot influence either visible rows or derived metrics.
 */
export const LIST_PATIENTS_SQL = `WITH owned_patients AS MATERIALIZED (
       SELECT id
         FROM patient
        WHERE owner_clinician_sub = $3
     ),
     ordered AS (
       SELECT op.id AS patient_id,
              ds.scheduled_at,
              ds.id AS dose_id,
              CASE
                WHEN ar.status = 'missed' THEN
                  CASE
                    WHEN om.sent_at IS NOT NULL
                      AND om.status NOT IN ('undelivered', 'failed')
                      AND om.sent_at + ($2::int * INTERVAL '1 minute') <= CURRENT_TIMESTAMP
                    THEN 'missed'::text
                    ELSE NULL
                  END
                ELSE ar.status
              END AS streak_status,
              (
                ar.id IS NULL
                AND om.sent_at IS NOT NULL
                AND om.status NOT IN ('undelivered', 'failed')
                AND om.sent_at + ($2::int * INTERVAL '1 minute') > CURRENT_TIMESTAMP
              ) AS is_open_window
         FROM owned_patients op
         JOIN dose_schedule ds ON ds.patient_id = op.id
         LEFT JOIN adherence_record ar
           ON ar.dose_id = ds.id
          AND ar.patient_id = ds.patient_id
         LEFT JOIN outbound_message om
           ON om.dose_id = ds.id
          AND om.patient_id = ds.patient_id
        WHERE ($1::uuid IS NULL OR op.id = $1)
          AND (ds.scheduled_at <= CURRENT_TIMESTAMP OR ar.id IS NOT NULL)
     ),
     scored AS (
       SELECT patient_id,
              streak_status AS status,
              row_number() OVER (
                PARTITION BY patient_id
                ORDER BY scheduled_at DESC, dose_id DESC
              ) AS rn
         FROM ordered
        WHERE NOT is_open_window
     ),
     miss_run AS (
       SELECT patient_id,
              COALESCE(min(rn) FILTER (WHERE status IS DISTINCT FROM 'missed') - 1, count(*))::int
                AS consecutive_missed
         FROM scored
        GROUP BY patient_id
     ),
     reported_ranked AS (
       SELECT ds.patient_id,
              ar.adherence_state,
              row_number() OVER (
                PARTITION BY ds.patient_id
                ORDER BY ds.scheduled_at DESC, ds.id DESC
              ) AS rn
         FROM owned_patients op
         JOIN dose_schedule ds ON ds.patient_id = op.id
         JOIN adherence_record ar
           ON ar.dose_id = ds.id
          AND ar.patient_id = ds.patient_id
        WHERE ($1::uuid IS NULL OR ds.patient_id = $1)
          AND ar.status = 'recorded'
          AND ar.decided_by = 'classifier'
     ),
     reported_miss_run AS (
       SELECT patient_id,
              COALESCE(min(rn) FILTER (WHERE adherence_state IS DISTINCT FROM 'skipped') - 1,
                       count(*))::int AS consecutive_reported_misses
         FROM reported_ranked
        GROUP BY patient_id
     ),
     clinical_30d AS (
       SELECT ds.patient_id,
              count(*) FILTER (
                WHERE ar.adherence_state IN ('taken', 'delayed')
              )::double precision AS adherent,
              count(*) FILTER (
                WHERE ar.adherence_state IN ('taken', 'delayed', 'skipped', 'stopped')
              )::double precision AS clinically_classified
         FROM owned_patients op
         JOIN dose_schedule ds ON ds.patient_id = op.id
         JOIN adherence_record ar
           ON ar.dose_id = ds.id
          AND ar.patient_id = ds.patient_id
        WHERE ($1::uuid IS NULL OR ds.patient_id = $1)
          AND ds.scheduled_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'
          AND ds.scheduled_at <= CURRENT_TIMESTAMP
          AND ar.status = 'recorded'
          AND ar.decided_by = 'classifier'
        GROUP BY ds.patient_id
     ),
     last_reply AS (
       SELECT ir.patient_id,
              max(ir.received_at) AS last_reply_at
         FROM owned_patients op
         JOIN inbound_reply ir ON ir.patient_id = op.id
        WHERE ($1::uuid IS NULL OR ir.patient_id = $1)
        GROUP BY ir.patient_id
     ),
     recent_ranked AS (
       SELECT ds.patient_id,
              ds.id AS dose_id,
              ds.scheduled_at,
              ar.status,
              ar.adherence_state,
              ar.decided_by,
              row_number() OVER (
                PARTITION BY ds.patient_id
                ORDER BY ds.scheduled_at DESC, ds.id DESC
              ) AS recent_rank
         FROM owned_patients op
         JOIN dose_schedule ds ON ds.patient_id = op.id
         JOIN adherence_record ar
           ON ar.dose_id = ds.id
          AND ar.patient_id = ds.patient_id
        WHERE ($1::uuid IS NULL OR ds.patient_id = $1)
     ),
     recent_resolved AS (
       SELECT patient_id,
              json_agg(
                json_build_object(
                  'dose_id', dose_id,
                  'scheduled_at', to_char(
                    scheduled_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                  ),
                  'status', status,
                  'adherence_state', adherence_state,
                  'decided_by', decided_by
                )
                ORDER BY scheduled_at ASC, dose_id ASC
              ) AS recent_doses
         FROM recent_ranked
        WHERE recent_rank <= 14
        GROUP BY patient_id
     )
     SELECT p.id,
            p.display_name,
            p.phone,
            p.medication_name,
            p.is_test,
            p.is_active,
            p.agent_enabled,
            p.provider_opted_in,
            p.opted_out_at,
            p.created_at,
            COALESCE(mr.consecutive_missed, 0)::int AS consecutive_missed,
            COALESCE(rmr.consecutive_reported_misses, 0)::int AS consecutive_reported_misses,
            CASE
              WHEN COALESCE(c30.clinically_classified, 0) = 0 THEN NULL
              ELSE c30.adherent / c30.clinically_classified
            END AS adherence_rate,
            to_char(
              lr.last_reply_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ) AS last_reply_at,
            COALESCE(rr.recent_doses, '[]'::json) AS recent_doses
       FROM owned_patients op
       JOIN patient p ON p.id = op.id
       LEFT JOIN miss_run mr ON mr.patient_id = p.id
       LEFT JOIN reported_miss_run rmr ON rmr.patient_id = p.id
       LEFT JOIN clinical_30d c30 ON c30.patient_id = p.id
       LEFT JOIN last_reply lr ON lr.patient_id = p.id
       LEFT JOIN recent_resolved rr ON rr.patient_id = p.id
      WHERE ($1::uuid IS NULL OR p.id = $1)
      ORDER BY p.created_at DESC, p.id DESC`;

/** Patient detail. $1 = patient UUID; $2 = authenticated clinician subject. */
export const PATIENT_DETAIL_SQL = `SELECT id,
            display_name,
            phone,
            medication_name,
            timezone,
            is_test,
            is_active,
            opted_out_at,
            created_at,
            drug_profile_json,
            drug_profile_fetched_at
       FROM patient
      WHERE id = $1
        AND owner_clinician_sub = $2`;

/**
 * GET /api/patients/{id} — the per-dose timeline (DASH-02). One row per scheduled dose (LEFT JOIN its
 * outcome, so pending/no-record doses still appear), ordered chronologically (scheduled_at ASC). `is_late`
 * rides the linked inbound reply (NULL for timeout rows). The server-owned trailing window preserves
 * legacy NULL dose_date rows via a patient-timezone fallback. Both bounds use the patient's local
 * calendar date. $1 = patient id; $2 = clamped window days; $3 = clinician subject.
 */
export const PATIENT_TIMELINE_SQL = `SELECT ds.id AS dose_id,
            ds.scheduled_at,
            ds.dose_date::text AS dose_date,
            ds.local_dose_time,
            ar.status,
            ar.adherence_state,
            ar.reason_code,
            ar.decided_by,
            ir.is_late,
            COALESCE(
              (
                SELECT jsonb_agg(
                         jsonb_build_object(
                           'id', lm.id,
                           'matched_phrase', lm.matched_phrase,
                           'meddra_pt', lm.meddra_pt,
                           'hint_level', lm.hint_level
                         )
                         ORDER BY lm.created_at ASC, lm.id ASC
                       )
                  FROM label_match lm
                 WHERE lm.inbound_message_id = ir.id
                   AND lm.patient_id = ir.patient_id
              ),
              '[]'::jsonb
            ) AS label_matches
       FROM patient p
       JOIN dose_schedule ds ON ds.patient_id = p.id
       LEFT JOIN adherence_record ar
         ON ar.dose_id = ds.id
        AND ar.patient_id = ds.patient_id
       LEFT JOIN inbound_reply ir
         ON ir.id = ar.inbound_message_id
        AND ir.patient_id = ar.patient_id
      WHERE p.id = $1
        AND p.owner_clinician_sub = $3
        AND COALESCE(ds.dose_date, (ds.scheduled_at AT TIME ZONE p.timezone)::date)
              BETWEEN (CURRENT_TIMESTAMP AT TIME ZONE p.timezone)::date - ($2::int - 1)
                  AND (CURRENT_TIMESTAMP AT TIME ZONE p.timezone)::date
      ORDER BY ds.scheduled_at ASC, ds.id ASC
      LIMIT $4::int`;

/**
 * GET /api/cohort-adherence — the selectable trailing 7/30/90-day cohort series (D4/U-20/21/22).
 * Bucketed on
 * `dose_schedule.dose_date` (the patient-local calendar day — U-21; UTC `scheduled_at::date` would
 * mis-bucket evening Toronto doses). The trailing report bounds deliberately use the database UTC
 * calendar so one mixed-timezone cohort has a stable shared reporting window. Days with no doses
 * simply have no row (gaps, not zero-fill — D8).
 *
 * Per day the aggregates are (M13 reporting canon — timeout rows are a RESPONSE-RATE bucket only):
 *   - delivered   = denominator-eligible doses: the unique outbound send has a `sent_at`, its final
 *                   status is not failed/undelivered, and `sent_at + $1 response-window minutes` is closed.
 *                   Eligibility is independent of whether an adherence_record write succeeded (RETRO-4).
 *   - responded   = eligible doses with a classifier outcome (decided_by='classifier' — any reply,
 *                   including an ambiguous unknown/question). numerator ⊆ delivered by construction.
 *   - confirmed   = classifier records in the 4 confirmed states taken/delayed/skipped/stopped (U-22).
 *   - taken_delayed = the adherent subset (taken/delayed) — the adherence-among-responses numerator.
 *   - ambiguous   = classifier unknown/question (reported separately — NOT in confirmed — U-22).
 *   - non_response = timeout `missed` rows (decided_by='timeout') — the non-response bucket, never folded
 *                   into a confirmed-non-adherence count (U-28 / M13).
 * `dose_rows AS MATERIALIZED` evaluates eligibility once. The final WHERE removes ineligible/open doses
 * before grouping, so every aggregate is a subset of the same denominator and open-only days stay gaps.
 * $1 = clamped response-window minutes; $2 = validated trailing-window days (7, 30, or 90);
 * $3 = authenticated clinician subject.
 */
export const COHORT_ADHERENCE_SQL = `WITH dose_rows AS MATERIALIZED (
       SELECT ds.dose_date,
              ar.decided_by,
              ar.adherence_state,
              ar.status,
              (
                om.id IS NOT NULL
                AND om.sent_at IS NOT NULL
                AND om.status NOT IN ('undelivered', 'failed')
                AND om.sent_at + ($1::int * INTERVAL '1 minute') <= CURRENT_TIMESTAMP
              ) AS denominator_eligible
         FROM dose_schedule ds
         JOIN patient p
           ON p.id = ds.patient_id
          AND p.owner_clinician_sub = $3
         LEFT JOIN adherence_record ar
           ON ar.dose_id = ds.id
          AND ar.patient_id = ds.patient_id
         LEFT JOIN outbound_message om
           ON om.dose_id = ds.id
          AND om.patient_id = ds.patient_id
        WHERE ds.dose_date IS NOT NULL
          AND ds.dose_date >= (CURRENT_DATE - ($2::int - 1))
          AND ds.dose_date <= CURRENT_DATE
     )
     SELECT dose_date::text AS day,
            count(*)::int AS delivered,
            count(*) FILTER (WHERE decided_by = 'classifier')::int AS responded,
            count(*) FILTER (
              WHERE decided_by = 'classifier'
                AND adherence_state IN ('taken', 'delayed', 'skipped', 'stopped')
            )::int AS confirmed,
            count(*) FILTER (
              WHERE decided_by = 'classifier' AND adherence_state IN ('taken', 'delayed')
            )::int AS taken_delayed,
            count(*) FILTER (
              WHERE decided_by = 'classifier' AND adherence_state IN ('unknown', 'question')
            )::int AS ambiguous,
            count(*) FILTER (WHERE decided_by = 'timeout' AND status = 'missed')::int AS non_response
       FROM dose_rows
      WHERE denominator_eligible
      GROUP BY dose_date
      ORDER BY dose_date ASC`;

/**
 * GET /api/reviews/safety — the safety review queue (DASH-07). One row per safety_event, joined to the
 * patient + the flagged inbound reply (the reviewer needs the message text). ADE hints are aggregated via
 * a json_agg subquery keyed on inbound_message_id (U-19 — a direct join to label_match fans out 1-to-many
 * on multi-PT replies; the subquery keeps it one row per event with a hints array).
 *
 * Ordering (U-12/C-10/U16): every failed/suppressed auto-reply and every `sending` reservation older
 * than the $1-minute threshold forms the delivery-follow-up tier. Crisis/acute severity is the secondary
 * sort, then first-detection recency. `created_at` is the event's first-detection time, NOT a retry
 * reservation time; `has_prior_failure` exposes the zero-DDL retry discriminator. Both auto-reply
 * writers set auto_reply_error only after a failed first attempt; tester scrubbing may later NULL that
 * diagnostic after the test cohort is no longer part of reporting. $2 is the clamped row limit;
 * $3 is the authenticated clinician subject.
 */
export const SAFETY_QUEUE_SQL = `WITH queued AS (
       SELECT se.id,
              se.patient_id,
              p.display_name,
              se.inbound_message_id,
              ir.raw_body,
              se.flag_category,
              se.trigger_source,
              se.auto_reply_status,
              se.created_at,
              (se.auto_reply_error IS NOT NULL) AS has_prior_failure,
              GREATEST(
                0,
                FLOOR(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - se.created_at)) / 60)
              )::int AS first_detected_minutes_ago,
              (
                COALESCE(se.auto_reply_status = 'sending', false)
                AND se.created_at <= CURRENT_TIMESTAMP - ($1::int * INTERVAL '1 minute')
              ) AS is_stale_sending,
              COALESCE(lm.hints, '[]'::jsonb) AS hints
         FROM safety_events se
         JOIN patient p ON p.id = se.patient_id
         JOIN inbound_reply ir
           ON ir.id = se.inbound_message_id
          AND ir.patient_id = se.patient_id
         LEFT JOIN (
           SELECT patient_id,
                  inbound_message_id,
                  jsonb_agg(
                    jsonb_build_object(
                      'meddra_pt', meddra_pt,
                      'hint_level', hint_level,
                      'matched_phrase', matched_phrase
                    ) ORDER BY meddra_pt, matched_phrase
                  ) AS hints
             FROM label_match
            GROUP BY patient_id, inbound_message_id
         ) lm
           ON lm.inbound_message_id = se.inbound_message_id
          AND lm.patient_id = se.patient_id
        WHERE p.owner_clinician_sub = $3
     )
     SELECT queued.*,
            (
              COALESCE(auto_reply_status IN ('failed', 'suppressed'), false)
              OR is_stale_sending
            ) AS is_urgent
       FROM queued
      ORDER BY is_urgent DESC,
               (flag_category IN ('crisis', 'acute_physical')) DESC,
               created_at DESC,
               id DESC
      LIMIT $2::int`;

/**
 * GET /api/reviews/unknown — a unioned reviews surface with two labeled arms:
 *   - `label_match`: every non-safety inbound carrying one or more label_match rows (C-6);
 *   - `ambiguity`: classifier unknown/unattributed rows with no safety event and no label match (U-17/18).
 *
 * Precedence is safety > label_match > ambiguity, keyed on inbound_message_id. This makes a reply appear
 * exactly once across all queues while keeping every label row reachable in either the safety row's hints
 * or the dedicated label-match arm. Hints aggregate per inbound, so multiple PTs never fan out the row.
 * $1 is the row limit; $2 is the authenticated clinician subject.
 */
export const UNKNOWN_QUEUE_SQL = `WITH label_hints AS (
       SELECT lm.patient_id,
              lm.inbound_message_id,
              max(lm.created_at) AS created_at,
              bool_or(lm.hint_level = 'elevated') AS has_elevated_hint,
              jsonb_agg(
                jsonb_build_object(
                  'matched_phrase', lm.matched_phrase,
                  'meddra_pt', lm.meddra_pt,
                  'hint_level', lm.hint_level
                ) ORDER BY lm.created_at ASC, lm.id ASC
              ) AS hints
         FROM label_match lm
        GROUP BY lm.patient_id, lm.inbound_message_id
     ),
     label_items AS (
       SELECT COALESCE(ar.id, lh.inbound_message_id) AS id,
              ir.patient_id,
              p.display_name,
              lh.inbound_message_id,
              ir.raw_body,
              ar.adherence_state,
              ar.reason_code,
              ar.dose_id,
              lh.created_at,
              'label_match'::text AS queue_kind,
              COALESCE(ar.adherence_state = 'unknown', false) AS is_unknown,
              COALESCE(ar.id IS NOT NULL AND ar.dose_id IS NULL, false) AS is_unattributed,
              true AS is_label_match,
              (ar.id IS NULL) AS has_no_outcome,
              lh.has_elevated_hint,
              lh.hints
         FROM label_hints lh
         JOIN inbound_reply ir
           ON ir.id = lh.inbound_message_id
          AND ir.patient_id = lh.patient_id
         JOIN patient p ON p.id = ir.patient_id
         LEFT JOIN adherence_record ar
           ON ar.inbound_message_id = lh.inbound_message_id
          AND ar.patient_id = ir.patient_id
        WHERE NOT EXISTS (
                SELECT 1
                  FROM safety_events se
                 WHERE se.inbound_message_id = lh.inbound_message_id
                   AND se.patient_id = ir.patient_id
              )
          AND p.owner_clinician_sub = $2
     ),
     ambiguity_items AS (
       SELECT ar.id,
              ar.patient_id,
              p.display_name,
              ar.inbound_message_id,
              ir.raw_body,
              ar.adherence_state,
              ar.reason_code,
              ar.dose_id,
              ar.created_at,
              'ambiguity'::text AS queue_kind,
              (ar.adherence_state = 'unknown') AS is_unknown,
              (ar.dose_id IS NULL) AS is_unattributed,
              false AS is_label_match,
              false AS has_no_outcome,
              false AS has_elevated_hint,
              '[]'::jsonb AS hints
         FROM adherence_record ar
         JOIN patient p ON p.id = ar.patient_id
         LEFT JOIN inbound_reply ir
           ON ir.id = ar.inbound_message_id
          AND ir.patient_id = ar.patient_id
        WHERE ar.decided_by = 'classifier'
          AND p.owner_clinician_sub = $2
          AND (ar.adherence_state = 'unknown' OR ar.dose_id IS NULL)
          AND (ar.inbound_message_id IS NULL OR ir.id IS NOT NULL)
          AND NOT EXISTS (
                SELECT 1
                  FROM safety_events se
                 WHERE se.inbound_message_id = ar.inbound_message_id
                   AND se.patient_id = ar.patient_id
              )
          AND NOT EXISTS (
                SELECT 1
                  FROM label_match lm
                 WHERE lm.inbound_message_id = ar.inbound_message_id
                   AND lm.patient_id = ar.patient_id
              )
     )
     SELECT id, patient_id, display_name, inbound_message_id, raw_body,
            adherence_state, reason_code, dose_id, created_at, queue_kind,
            is_unknown, is_unattributed, is_label_match, has_no_outcome,
            has_elevated_hint, hints
       FROM label_items
     UNION ALL
     SELECT id, patient_id, display_name, inbound_message_id, raw_body,
            adherence_state, reason_code, dose_id, created_at, queue_kind,
            is_unknown, is_unattributed, is_label_match, has_no_outcome,
            has_elevated_hint, hints
       FROM ambiguity_items
     ORDER BY has_elevated_hint DESC, created_at DESC, id DESC
     LIMIT $1::int`;

/** Identifier-free structured metric line (counts + static route names only — U-16). */
function logMetric(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

/** Build the API GW HTTP-integration response envelope. */
function json(statusCode: number, body: Record<string, unknown>): HttpResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * Build (or return the cached) module-scoped pg.Pool. The DB credential is fetched from Secrets Manager
 * (D-06 — never an env var) ONCE per cold container, on the first call only; warm invokes reuse the cached
 * pool. Connection env vars are guarded with actionable errors (the schema-init WR-04 posture). Cloned
 * VERBATIM from the Phase-2 health fn / the timeout fn (F28 single-source TLS, M-2 pinned CA, D-11 max 2).
 */

// --- per-route read handlers --------------------------------------------------------------------------

/** GET /api/health → SELECT 1 (the SC4 probe). Zero user input — no injection surface (T-02-10). */
async function health(db: Pool): Promise<HttpResult> {
  const r = await db.query('SELECT 1 AS ok');
  return json(200, { ok: r.rows[0].ok === 1 });
}

/**
 * GET /api/patients — the list. Maps each row to its badges + the per-patient consecutive-miss run, and
 * derives `alerting` = (is_active AND not opted-out AND consecutive_missed >= threshold) so the banner
 * (06-03b/04) is suppressed for inactive/opted-out patients (D5). Returns the threshold for the UI copy.
 */
async function listPatients(db: Pool, clinicianSub: string): Promise<HttpResult> {
  const responseWindow = responseWindowMinutes();
  const { rows } = await db.query(LIST_PATIENTS_SQL, [null, responseWindow, clinicianSub]);
  const threshold = alertThreshold();
  const patients = rows.map((row) => ({ ...row, ...patientAlertState(row, threshold) }));
  return json(200, { patients, alertThreshold: threshold });
}

/** GET /api/cohort-adherence — the selected series + two derived ratios (null when denominator is 0). */
async function cohortAdherence(db: Pool, days: number, clinicianSub: string): Promise<HttpResult> {
  const responseWindow = responseWindowMinutes();
  const { rows } = await db.query(COHORT_ADHERENCE_SQL, [responseWindow, days, clinicianSub]);
  const series = rows.map((r) => ({
    day: r.day,
    delivered: r.delivered,
    responded: r.responded,
    confirmed: r.confirmed,
    taken_delayed: r.taken_delayed,
    ambiguous: r.ambiguous,
    non_response: r.non_response,
    // adherence-among-responses (U-22) and response rate (U-20) — gaps (null), never a divide-by-zero.
    adherence_rate: r.confirmed > 0 ? r.taken_delayed / r.confirmed : null,
    response_rate: r.delivered > 0 ? r.responded / r.delivered : null,
  }));
  return json(200, { series });
}

/** GET /api/reviews/safety — urgent-first, hint-aggregated, with the stuck-send threshold exposed. */
async function safetyQueue(db: Pool, clinicianSub: string): Promise<HttpResult> {
  const threshold = safetySendingStuckMinutes();
  const limit = reviewQueueLimit();
  const { rows } = await db.query(SAFETY_QUEUE_SQL, [threshold, limit, clinicianSub]);
  return json(200, {
    events: rows,
    stuckSendingThresholdMinutes: threshold,
    limit,
  });
}

/** GET /api/reviews/unknown — deduped ambiguity + label-match arms. */
async function unknownQueue(db: Pool, clinicianSub: string): Promise<HttpResult> {
  const limit = reviewQueueLimit();
  const { rows } = await db.query(UNKNOWN_QUEUE_SQL, [limit, clinicianSub]);
  return json(200, { items: rows, limit });
}

/**
 * The data-API entrypoint — the read router (D1). Dispatches on `routeKey`. The `{id}` route validates its
 * path param FIRST (400 before getPool() — the zod `.parse()` D-16 gate, mirroring deactivate); every
 * other read builds the pool only for a KNOWN route (an unknown routeKey 404s without a DB reach). The
 * native authorizer verifies the JWT; `requireClinicianClaims` supplies the only trusted owner ID.
 */
export async function handler(event: DataApiEvent): Promise<HttpResult> {
  let clinicianSub: string;
  try {
    clinicianSub = requireClinicianClaims(event).sub;
  } catch (error) {
    if (!(error instanceof ClinicianClaimsError)) throw error;
    logMetric({ metric: 'data_api_unauthorized' });
    return json(401, { error: 'unauthorized' });
  }

  const routeKey = event?.routeKey;

  if (
    routeKey === 'GET /api/patients/{id}/clinical-history' ||
    routeKey === 'POST /api/patients/{id}/medications' ||
    routeKey === 'POST /api/patients/{id}/clinical-facts'
  ) {
    return clinicalHistoryHandler(event);
  }

  // The doctor-owned contact-detail correction rides this fn like the clinical-history writes above:
  // no new Lambda, no IAM delta, the same Cognito authorizer. It validates 400-FIRST (D-16) internally.
  if (routeKey === PATIENT_DETAILS_ROUTE_KEY) {
    const details = await handlePatientDetailsRoute(event, clinicianSub, { getPool, logMetric });
    return json(details.statusCode, details.body);
  }

  const patientRead = await handlePatientReadRoute(event, clinicianSub, {
    getPool,
    patientDetailSql: PATIENT_DETAIL_SQL,
    patientTimelineSql: PATIENT_TIMELINE_SQL,
    listPatientsSql: LIST_PATIENTS_SQL,
    alertThreshold,
    responseWindowMinutes,
    timelineWindowDays,
    logMetric,
  });
  if (patientRead) return json(patientRead.statusCode, patientRead.body);

  switch (routeKey) {
    case 'GET /api/health':
      return health(await getPool());
    case 'GET /api/patients':
      return listPatients(await getPool(), clinicianSub);
    case 'GET /api/cohort-adherence': {
      let days: number;
      try {
        days = cohortWindowDaysSchema.parse(event?.queryStringParameters?.days);
      } catch {
        logMetric({ metric: 'data_api_bad_request', routeKey });
        return json(400, { error: 'invalid days' });
      }
      return cohortAdherence(await getPool(), days, clinicianSub);
    }
    case 'GET /api/reviews/safety':
      return safetyQueue(await getPool(), clinicianSub);
    case 'GET /api/reviews/unknown':
      return unknownQueue(await getPool(), clinicianSub);
    default:
      logMetric({ metric: 'data_api_unknown_route' });
      return json(404, { error: 'not found' });
  }
}
