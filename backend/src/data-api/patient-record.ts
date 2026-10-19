import type { Client, Pool } from 'pg';
import { z } from 'zod';

type SqlClient = Pick<Client, 'query'> | Pick<Pool, 'query'>;

export const PATIENT_RECORD_LIMITS = {
  timeline: 100,
  timelineLabelMatches: 5,
  timelineLabelText: 128,
  dayIndex: 90,
  messages: 50,
  events: 50,
  evidence: 25,
  versions: 100,
  alerts: 25,
  alertRequest: 100,
  drafts: 3,
  draftRequest: 10,
  trendPoints: 90,
  historyMedications: 100,
  historyFacts: 200,
  historyIngredients: 4,
  historyIngredientName: 128,
  historyFactText: 500,
  reviewQueue: 100,
} as const;

const localDateSchema = z.string().date();
const cursorTokenSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);
const alertCursorPayloadSchema = z
  .object({
    rank: z.number().int().min(0).max(2),
    occurredAt: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
  })
  .strict();
const draftCursorPayloadSchema = z
  .object({
    createdAt: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
  })
  .strict();
const recordQuerySchema = z
  .object({
    days: z.enum(['7', '30', '90']).default('30'),
    day: localDateSchema.optional(),
    alertsCursor: cursorTokenSchema.optional(),
    alertsLimit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PATIENT_RECORD_LIMITS.alertRequest)
      .default(100),
    draftsCursor: cursorTokenSchema.optional(),
    draftsLimit: z.coerce.number().int().min(1).max(PATIENT_RECORD_LIMITS.draftRequest).default(3),
  })
  .strict();
const queueQuerySchema = z
  .object({
    cursor: cursorTokenSchema.optional(),
    limit: z.coerce.number().int().min(1).max(PATIENT_RECORD_LIMITS.reviewQueue).default(100),
  })
  .strict();

export interface PageRequest {
  cursor: string | null;
  limit: number;
}

export interface PatientRecordQuery {
  days: 7 | 30 | 90;
  selectedDay: string | null;
  alerts: PageRequest;
  drafts: PageRequest;
}

function decodeCursor<T>(token: string, schema: z.ZodType<T>): T {
  const parsedToken = cursorTokenSchema.parse(token);
  try {
    const json = Buffer.from(parsedToken, 'base64url').toString('utf8');
    return schema.parse(JSON.parse(json));
  } catch {
    throw new z.ZodError([{ code: 'custom', path: ['cursor'], message: 'Invalid cursor' }]);
  }
}

function validateCursor<T>(token: string | undefined, schema: z.ZodType<T>): string | null {
  if (token === undefined) return null;
  decodeCursor(token, schema);
  return token;
}

export function parsePatientRecordQuery(
  query: Record<string, string | undefined> | undefined,
): PatientRecordQuery {
  const parsed = recordQuerySchema.parse(query ?? {});
  return {
    days: Number(parsed.days) as 7 | 30 | 90,
    selectedDay: parsed.day ?? null,
    alerts: {
      cursor: validateCursor(parsed.alertsCursor, alertCursorPayloadSchema),
      limit: parsed.alertsLimit,
    },
    drafts: {
      cursor: validateCursor(parsed.draftsCursor, draftCursorPayloadSchema),
      limit: parsed.draftsLimit,
    },
  };
}

export function parseReviewQueueQuery(
  query: Record<string, string | undefined> | undefined,
  queue: 'alerts' | 'drafts' = 'alerts',
): PageRequest {
  const parsed = queueQuerySchema.parse(query ?? {});
  const cursor =
    queue === 'alerts'
      ? validateCursor(parsed.cursor, alertCursorPayloadSchema)
      : validateCursor(parsed.cursor, draftCursorPayloadSchema);
  return { cursor, limit: parsed.limit };
}

// Same canonical current-state semantics used by conversation memory: a row is current only when
// no same-patient event directly replaces it. Version/audit queries deliberately do not use this.
const CURRENT_CLINICAL_EVENT_PREDICATE = `NOT EXISTS (
            SELECT 1
              FROM clinical_event replacement
             WHERE replacement.patient_id = ce.patient_id
               AND replacement.supersedes_id = ce.id
          )`;

const OWNED_WINDOW_CTE = `owned AS MATERIALIZED (
       SELECT p.id,
              p.timezone,
              (CURRENT_TIMESTAMP AT TIME ZONE p.timezone)::date AS today,
              (CURRENT_TIMESTAMP AT TIME ZONE p.timezone)::date - ($3::int - 1) AS from_date,
              COALESCE($4::date, (CURRENT_TIMESTAMP AT TIME ZONE p.timezone)::date) AS selected_day
         FROM patient p
        WHERE p.id = $1
          AND p.owner_clinician_sub = $2
     )`;

export const PATIENT_RECORD_SCOPE_SQL = `WITH ${OWNED_WINDOW_CTE}
     SELECT p.id,
            p.display_name,
            p.phone,
            p.medication_name,
            p.timezone,
            p.is_test,
            p.is_active,
            p.opted_out_at,
            p.created_at,
            p.drug_profile_fetched_at,
            p.preferred_language,
            p.reminder_limit,
            p.agent_enabled,
            p.provider_opted_in,
            p.messaging_state_version,
            o.from_date::text,
            o.today::text,
            o.selected_day::text,
            (o.selected_day BETWEEN o.from_date AND o.today) AS selected_day_in_window
       FROM owned o
       JOIN patient p ON p.id = o.id`;

const PATIENT_RECORD_HISTORY_SQL = `SELECT 'medication'::text AS kind,
            pm.id, pm.entered_name, pm.identity_system, pm.identity_code, pm.dose_text,
            pm.form, pm.route, pm.valid_from::text, pm.valid_to::text, pm.status,
            pm.supersedes_id, pm.created_at,
            COALESCE(
              (
                SELECT json_agg(json_build_object(
                         'name', pmi.ingredient_name,
                         'ccddIngredientCode', pmi.ccdd_ingredient_code,
                         'rxcui', pmi.rxcui
                       ) ORDER BY pmi.ingredient_order)
                  FROM patient_medication_ingredient pmi
                 WHERE pmi.patient_id = pm.patient_id
                   AND pmi.patient_medication_id = pm.id
              ),
              '[]'::json
            ) AS ingredients,
            NULL::text AS fact_type, NULL::text AS fact_code, NULL::text AS statement_text
       FROM patient_medication pm
       JOIN patient p ON p.id = pm.patient_id AND p.owner_clinician_sub = $2
      WHERE pm.patient_id = $1
      ORDER BY pm.created_at DESC, pm.id DESC
      LIMIT $3::int`;

const PATIENT_RECORD_FACT_HISTORY_SQL = `SELECT cf.id, cf.fact_type, cf.fact_code,
            cf.statement_text, cf.status, cf.supersedes_id, cf.created_at
       FROM clinical_fact cf
       JOIN patient p ON p.id = cf.patient_id AND p.owner_clinician_sub = $2
      WHERE cf.patient_id = $1
      ORDER BY cf.created_at DESC, cf.id DESC
      LIMIT $3::int`;

export const PATIENT_DAY_INDEX_SQL = `WITH ${OWNED_WINDOW_CTE},
     days AS (
       SELECT generate_series(o.from_date, o.today, interval '1 day')::date AS local_date
         FROM owned o
     ),
     summaries AS (
       SELECT DISTINCT ON (ds.local_date)
              ds.local_date, ds.version, ds.highest_tier
         FROM owned o
         JOIN daily_summary ds ON ds.patient_id = o.id
        WHERE ds.local_date BETWEEN o.from_date AND o.today
        ORDER BY ds.local_date, ds.version DESC, ds.id DESC
     ),
     message_counts AS (
       SELECT local_date, count(*)::int AS message_count
         FROM (
           SELECT (ir.received_at AT TIME ZONE o.timezone)::date AS local_date
             FROM owned o JOIN inbound_reply ir ON ir.patient_id = o.id
            WHERE (ir.received_at AT TIME ZONE o.timezone)::date BETWEEN o.from_date AND o.today
           UNION ALL
           SELECT (COALESCE(om.sent_at, om.created_at) AT TIME ZONE o.timezone)::date
             FROM owned o JOIN outbound_message om ON om.patient_id = o.id
            WHERE (COALESCE(om.sent_at, om.created_at) AT TIME ZONE o.timezone)::date
                  BETWEEN o.from_date AND o.today
         ) messages
        GROUP BY local_date
     ),
     event_counts AS (
       SELECT ce.local_date,
              count(*)::int AS event_count,
              count(*) FILTER (WHERE ce.event_type = 'alert')::int AS alert_count
        FROM owned o JOIN clinical_event ce ON ce.patient_id = o.id
        WHERE ce.local_date BETWEEN o.from_date AND o.today
          AND ${CURRENT_CLINICAL_EVENT_PREDICATE}
        GROUP BY ce.local_date
     ),
     draft_days AS (
       SELECT DISTINCT d.local_date
         FROM owned o JOIN clinician_review_draft d ON d.patient_id = o.id
        WHERE d.local_date BETWEEN o.from_date AND o.today
     )
     SELECT d.local_date::text AS local_date,
            s.version AS latest_summary_version,
            COALESCE(s.highest_tier, 'none') AS highest_tier,
            COALESCE(m.message_count, 0)::int AS message_count,
            COALESCE(e.event_count, 0)::int AS event_count,
            COALESCE(e.alert_count, 0)::int AS alert_count,
            (dd.local_date IS NOT NULL) AS has_draft
       FROM days d
       LEFT JOIN summaries s ON s.local_date = d.local_date
       LEFT JOIN message_counts m ON m.local_date = d.local_date
      LEFT JOIN event_counts e ON e.local_date = d.local_date
      LEFT JOIN draft_days dd ON dd.local_date = d.local_date
      ORDER BY d.local_date DESC
      LIMIT $5::int`;

export const PATIENT_DAY_SUMMARY_SQL = `WITH ${OWNED_WINDOW_CTE}
     SELECT ds.id,
            ds.local_date::text AS local_date,
            ds.version,
            ds.input_hash,
            ds.event_count,
            ds.highest_tier,
            ds.summary_text,
            ds.window_start,
            ds.window_end,
            ds.structured_payload,
            ds.supersedes_id,
            ds.created_at
       FROM owned o
       JOIN daily_summary ds ON ds.patient_id = o.id
      WHERE ds.local_date = o.selected_day
      ORDER BY ds.version DESC, ds.id DESC
      LIMIT 1`;

export const PATIENT_MESSAGES_SQL = `WITH ${OWNED_WINDOW_CTE},
     messages AS (
       SELECT ir.id,
              'inbound'::text AS direction,
              ir.raw_body AS body,
              ir.received_at AS occurred_at,
              NULL::varchar(35) AS language,
              at.detected_language,
              at.normalized_english_meaning,
              at.translated_text,
              NULL::varchar(24) AS message_kind,
              NULL::text AS status,
              NULL::smallint AS reminder_attempt,
              NULL::varchar(32) AS clarification_topic,
              ir.is_late,
              at.id AS agent_turn_id,
              NULL::uuid AS in_reply_to_inbound_id,
              NULL::timestamptz AS sent_at
         FROM owned o
         JOIN inbound_reply ir ON ir.patient_id = o.id
         LEFT JOIN agent_turn at
           ON at.patient_id = ir.patient_id AND at.inbound_message_id = ir.id
        WHERE (ir.received_at AT TIME ZONE o.timezone)::date = o.selected_day
       UNION ALL
       SELECT om.id,
              'outbound'::text,
              -- Wave 1b: the clinician reads what the patient actually RECEIVED. The sender
              -- transmits composed_body ?? body, and a composed body the send-time re-check
              -- refuses is cleared from the row, so this COALESCE always mirrors the wire.
              COALESCE(om.composed_body, om.body),
              COALESCE(om.sent_at, om.created_at),
              om.language,
              NULL::varchar(35),
              NULL::varchar(2000),
              NULL::varchar(2000),
              om.message_kind,
              om.status,
              om.reminder_attempt,
              om.clarification_topic,
              NULL::boolean,
              om.agent_turn_id,
              om.in_reply_to_inbound_id,
              -- NULL marks a never-sent row (suppressed record-only) for the clinician panel badge.
              om.sent_at
         FROM owned o
         JOIN outbound_message om ON om.patient_id = o.id
        WHERE (COALESCE(om.sent_at, om.created_at) AT TIME ZONE o.timezone)::date = o.selected_day
     ),
     recent AS (
       SELECT * FROM messages ORDER BY occurred_at DESC, id DESC LIMIT $5::int
     )
     SELECT * FROM recent ORDER BY occurred_at ASC, id ASC`;

// Lane W (2026-08-17): the READ projection of clinical_event.event_type, and the only place the
// stored spelling is translated for the API. The live writer stores a symptom-kind semantic event
// as 'patient_statement' (canonical-projections.ts storedEventType), but clinical_event is
// append-only — rows written before that projection keep 'symptom' PERMANENTLY, since no UPDATE
// can convert them (reject_immutable_update, SQLSTATE 55000). The data API emits ONLY the
// canonical five-value vocabulary the dashboard's strict clinicalEventRowSchema parses, so the
// legacy spelling is projected here rather than tolerated downstream: one un-projected row would
// fail the whole strict envelope and blank the clinician's entire patient-record page.
const READ_EVENT_TYPE_SQL = `CASE ce.event_type WHEN 'symptom' THEN 'patient_statement'
                                  ELSE ce.event_type END AS event_type`;

export const PATIENT_EVENTS_SQL = `WITH ${OWNED_WINDOW_CTE}
     SELECT ce.id, ${READ_EVENT_TYPE_SQL}, ce.event_code, ce.statement_text, ce.normalized_value,
            ce.occurred_at, ce.local_date::text AS local_date, ce.local_time,
            ce.patient_timezone, ce.severity, ce.patient_medication_id, ce.dose_id,
            ce.agent_turn_id, ce.source_inbound_id, ce.supersedes_id, ce.created_at
      FROM owned o JOIN clinical_event ce ON ce.patient_id = o.id
      WHERE ce.local_date = o.selected_day
        AND ${CURRENT_CLINICAL_EVENT_PREDICATE}
      ORDER BY ce.occurred_at DESC, ce.id DESC
      LIMIT $5::int`;

export const PATIENT_EVENT_EVIDENCE_SQL = `WITH ${OWNED_WINDOW_CTE}
     SELECT cee.clinical_event_id,
            er.id AS evidence_id,
            cee.template_id,
            sr.source_name AS source,
            sr.release_version AS source_version,
            er.evidence_code,
            er.passage,
            er.source_url AS url,
            er.language,
            er.coverage_state
       FROM owned o
       JOIN clinical_event ce ON ce.patient_id = o.id AND ce.local_date = o.selected_day
       JOIN clinical_event_evidence cee
         ON cee.patient_id = ce.patient_id AND cee.clinical_event_id = ce.id
       JOIN evidence_record er ON er.id = cee.evidence_record_id
       JOIN source_release sr ON sr.id = er.source_release_id
      WHERE ${CURRENT_CLINICAL_EVENT_PREDICATE}
      ORDER BY ce.occurred_at DESC, ce.id DESC, er.id, cee.template_id
      LIMIT $5::int`;

export const PATIENT_RECORD_VERSIONS_SQL = `WITH ${OWNED_WINDOW_CTE},
     revisions AS (
       SELECT 'daily_summary'::text AS record_kind, ds.id, ds.version, ds.supersedes_id, ds.created_at
         FROM owned o JOIN daily_summary ds ON ds.patient_id = o.id
        WHERE ds.local_date = o.selected_day
       UNION ALL
       SELECT 'clinician_review_draft', d.id, d.version, d.supersedes_id, d.created_at
         FROM owned o JOIN clinician_review_draft d ON d.patient_id = o.id
        WHERE d.local_date = o.selected_day
       UNION ALL
       SELECT 'clinical_event', ce.id, NULL::int, ce.supersedes_id, ce.created_at
         FROM owned o JOIN clinical_event ce ON ce.patient_id = o.id
        WHERE ce.local_date = o.selected_day
          AND (ce.supersedes_id IS NOT NULL OR EXISTS (
                SELECT 1 FROM clinical_event successor
                 WHERE successor.patient_id = ce.patient_id
                   AND successor.supersedes_id = ce.id
              ))
       UNION ALL
       SELECT 'clinical_fact', cf.id, NULL::int, cf.supersedes_id, cf.created_at
         FROM owned o JOIN clinical_fact cf ON cf.patient_id = o.id
        WHERE (cf.created_at AT TIME ZONE o.timezone)::date = o.selected_day
       UNION ALL
       SELECT 'patient_medication', pm.id, NULL::int, pm.supersedes_id, pm.created_at
         FROM owned o JOIN patient_medication pm ON pm.patient_id = o.id
        WHERE (pm.created_at AT TIME ZONE o.timezone)::date = o.selected_day
     )
     SELECT record_kind, id, version, supersedes_id, created_at
       FROM revisions
      ORDER BY created_at DESC, id DESC
      LIMIT $5::int`;

export const PATIENT_ALERTS_SQL = `WITH ${OWNED_WINDOW_CTE},
     items AS (
       SELECT ce.id,
              ce.event_code,
              CASE ce.event_code WHEN 'emergency' THEN 'emergency'
                   WHEN 'important' THEN 'important' ELSE 'fallback' END AS tier,
              ce.statement_text, ce.occurred_at, ce.local_date::text AS local_date,
              ce.source_inbound_id, ce.agent_turn_id, at.final_policy_tier, ce.created_at,
              CASE ce.event_code WHEN 'emergency' THEN 0 WHEN 'important' THEN 1 ELSE 2 END AS sort_rank
         FROM owned o
         JOIN clinical_event ce ON ce.patient_id = o.id
         LEFT JOIN agent_turn at ON at.patient_id = ce.patient_id AND at.id = ce.agent_turn_id
        WHERE ce.local_date BETWEEN o.from_date AND o.today
          AND ce.event_type = 'alert' AND ce.event_code IS NOT NULL
          AND ${CURRENT_CLINICAL_EVENT_PREDICATE}
     )
     SELECT id, event_code, tier, statement_text, occurred_at, local_date,
            source_inbound_id, agent_turn_id, final_policy_tier, created_at
       FROM items
      WHERE ($5::int IS NULL OR sort_rank > $5::int OR
             (sort_rank = $5::int AND (occurred_at, id) < ($6::timestamptz, $7::uuid)))
      ORDER BY sort_rank, occurred_at DESC, id DESC
      LIMIT $8::int`;

export const PATIENT_REVIEW_DRAFTS_SQL = `WITH ${OWNED_WINDOW_CTE},
     items AS (
       SELECT d.id, d.local_date::text AS local_date, d.version, d.input_hash, d.draft_text,
              d.patient_statements, d.confirmed_facts, d.model_inferences, d.uncertainties,
              d.evidence_references, d.proposed_corrections, d.source_agent_turn_id,
              d.supersedes_id, d.created_at,
              NOT EXISTS (
                SELECT 1 FROM clinician_review_draft newer
                 WHERE newer.patient_id = d.patient_id AND newer.local_date = d.local_date
                   AND newer.version > d.version
              ) AS is_latest,
              act.action AS latest_action
         FROM owned o
         JOIN clinician_review_draft d ON d.patient_id = o.id
         LEFT JOIN LATERAL (
           SELECT json_build_object(
                    'id', a.id, 'decision', a.decision, 'expected_version', a.expected_version,
                    'selected_correction_ids', a.selected_correction_ids,
                    'created_at', to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                  ) AS action
             FROM clinician_review_action a
            WHERE a.patient_id = d.patient_id AND a.clinician_review_draft_id = d.id
            ORDER BY a.created_at DESC, a.id DESC LIMIT 1
         ) act ON true
        WHERE d.local_date BETWEEN o.from_date AND o.today
     )
     SELECT id, local_date, version, input_hash, draft_text, patient_statements, confirmed_facts,
            model_inferences, uncertainties, evidence_references, proposed_corrections,
            source_agent_turn_id, supersedes_id, created_at, is_latest, latest_action
       FROM items
      WHERE ($5::timestamptz IS NULL OR (created_at, id) < ($5::timestamptz, $6::uuid))
      ORDER BY created_at DESC, id DESC
      LIMIT $7::int`;

// Wave-3 rewrite (2026-08-17): the conversational core (repository.ts persistEvent) never writes
// the old event_type='observation'/event_code='symptom'+'severity'/normalized_value shape — it
// writes event_type = storedEventType(event.kind) ('patient_statement' for a symptom claim, Lane W)
// and puts every domain field
// (rawSymptom, symptomConcept, severity, ...) in the clinical_values jsonb column; the physical
// `severity` smallint and `normalized_value` columns are always NULL (see repository.ts persistEvent
// INSERT — positions 9 and 11 are literal NULL). Severity is a REFINEMENT of the SAME symptom event
// (supersession chain, e.g. v1 rawSymptom-only -> v2 +onset -> v3 +severity), not a separate
// same-turn row, so the old LATERAL same-turn join has no equivalent here — the current-leaf
// predicate alone picks the single latest version.
export const PATIENT_SEVERITY_TRENDS_SQL = `WITH ${OWNED_WINDOW_CTE}, identified AS (
       SELECT ce.local_date,
              (ce.clinical_values ->> 'severity')::smallint AS severity,
              lower(btrim(COALESCE(
                NULLIF(ce.clinical_values ->> 'symptomConcept', ''),
                ce.clinical_values ->> 'rawSymptom'
              ))) AS symptom
         FROM owned o JOIN clinical_event ce ON ce.patient_id = o.id
        WHERE ce.local_date BETWEEN o.from_date AND o.today
          -- Both spellings of the SAME canonical symptom event: the live writer now stores
          -- 'patient_statement' (Lane W storage projection), while rows committed before it keep
          -- 'symptom' PERMANENTLY — clinical_event is append-only, so nothing can convert them.
          -- The tolerance is therefore permanent too; keying off one spelling alone blanks this
          -- chart on one side of that boundary or the other. This is a FILTER, so it stays a
          -- two-value IN rather than the read projection the emitted event_type gets. The
          -- clinical_values symptom payload below is the real discriminator — SYMPTOM_ONLY_FIELDS
          -- (contracts.ts) never appear on an administration/safety/contradiction event.
          AND ce.event_type IN ('symptom', 'patient_statement')
          AND ce.clinical_values ->> 'severity' ~ '^(?:[1-9]|10)$'
          AND COALESCE(ce.clinical_values ->> 'symptomConcept', ce.clinical_values ->> 'rawSymptom')
                IS NOT NULL
          AND btrim(COALESCE(ce.clinical_values ->> 'symptomConcept', ce.clinical_values ->> 'rawSymptom'))
                <> ''
          AND ${CURRENT_CLINICAL_EVENT_PREDICATE}
     ), recent AS (
       SELECT local_date, symptom, max(severity)::int AS max_severity,
              count(*)::int AS observation_count
         FROM identified
        GROUP BY local_date, symptom
        ORDER BY local_date DESC, symptom DESC LIMIT $5::int
     )
     SELECT local_date::text AS local_date, symptom, max_severity, observation_count
       FROM recent ORDER BY local_date, symptom`;

// Wave-3 rewrite (2026-08-17): the six-value adherence_state (taken/delayed/skipped/stopped/
// unknown/question) is derived ONCE, durably, by adherence-mapping.ts's adherenceProjection() +
// the W0.4 derived-timing logic, and persisted to adherence_record (see canonical-projections.ts
// persistAdherence) — clinical_event never carries that outcome (an administration event only
// carries the raw pre-mapping adherence/timing claim in clinical_values). Re-deriving the mapping
// here in SQL would duplicate business logic that can drift from adherence-mapping.ts; this reads
// the already-computed adherence_record row instead, bucketed by dose_schedule.dose_date (the
// patient-local calendar day, matching COHORT_ADHERENCE_SQL's convention) rather than clinical_event
// local_date. decided_by='classifier' excludes timeout non-response rows (adherence_state='unknown',
// decided_by='timeout') from inflating the 'unknown' bucket, matching the old query's implicit
// scope (only clinical_event rows born from an actual patient reply, never a bare timeout).
export const PATIENT_ADHERENCE_TRENDS_SQL = `WITH ${OWNED_WINDOW_CTE}, recent AS (
       SELECT ds.dose_date AS local_date,
              count(*) FILTER (WHERE ar.adherence_state = 'taken')::int AS taken,
              count(*) FILTER (WHERE ar.adherence_state = 'delayed')::int AS delayed,
              count(*) FILTER (WHERE ar.adherence_state = 'skipped')::int AS skipped,
              count(*) FILTER (WHERE ar.adherence_state = 'stopped')::int AS stopped,
              count(*) FILTER (WHERE ar.adherence_state = 'unknown')::int AS unknown,
              count(*) FILTER (WHERE ar.adherence_state = 'question')::int AS question
         FROM owned o
         JOIN dose_schedule ds ON ds.patient_id = o.id
         JOIN adherence_record ar
           ON ar.patient_id = ds.patient_id AND ar.dose_id = ds.id AND ar.decided_by = 'classifier'
        WHERE ds.dose_date BETWEEN o.from_date AND o.today
        GROUP BY ds.dose_date ORDER BY ds.dose_date DESC LIMIT $5::int
     )
     SELECT local_date::text AS local_date, taken, delayed, skipped, stopped, unknown, question
       FROM recent ORDER BY local_date`;

export const ALERT_QUEUE_SQL = `WITH items AS (
       SELECT ce.id, ce.patient_id, p.display_name, ce.event_code,
              CASE ce.event_code WHEN 'emergency' THEN 'emergency'
                   WHEN 'important' THEN 'important' ELSE 'fallback' END AS tier,
              ce.statement_text, ce.occurred_at, ce.local_date::text AS local_date,
              ce.source_inbound_id, ir.raw_body, ce.created_at,
              CASE ce.event_code WHEN 'emergency' THEN 0 WHEN 'important' THEN 1 ELSE 2 END AS sort_rank
         FROM clinical_event ce
         JOIN patient p ON p.id = ce.patient_id AND p.owner_clinician_sub = $1
         LEFT JOIN inbound_reply ir ON ir.patient_id = ce.patient_id AND ir.id = ce.source_inbound_id
        WHERE ce.event_type = 'alert' AND ce.event_code IS NOT NULL
          AND ${CURRENT_CLINICAL_EVENT_PREDICATE}
     )
     SELECT id, patient_id, display_name, event_code, tier, statement_text, occurred_at,
            local_date, source_inbound_id, raw_body, created_at
       FROM items
      WHERE ($2::int IS NULL OR sort_rank > $2::int OR
             (sort_rank = $2::int AND (occurred_at, id) < ($3::timestamptz, $4::uuid)))
      ORDER BY sort_rank, occurred_at DESC, id DESC
      LIMIT $5::int`;

export const DRAFT_QUEUE_SQL = `WITH items AS (
       SELECT d.id, d.patient_id, p.display_name, d.local_date::text AS local_date,
              d.version, d.draft_text,
              jsonb_array_length(d.proposed_corrections)::int AS proposed_correction_count,
              false AS has_action,
              d.created_at
         FROM clinician_review_draft d
         JOIN patient p ON p.id = d.patient_id AND p.owner_clinician_sub = $1
         WHERE NOT EXISTS (
          SELECT 1 FROM clinician_review_draft newer
           WHERE newer.patient_id = d.patient_id AND newer.local_date = d.local_date
              AND newer.version > d.version
         )
          AND NOT EXISTS (
          SELECT 1 FROM clinician_review_action a
           WHERE a.patient_id = d.patient_id AND a.clinician_review_draft_id = d.id
          )
     )
     SELECT id, patient_id, display_name, local_date, version, draft_text,
            proposed_correction_count, has_action, created_at
      FROM items
      WHERE ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        AND $4::int IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT $5::int`;

interface CursorRow {
  id: string;
  occurred_at?: Date | string;
  created_at?: Date | string;
  event_code?: string;
  has_action?: boolean;
  latest_action?: unknown;
}

export interface CursorPage<T = unknown> {
  items: T[];
  cursor: string | null;
  nextCursor: string | null;
  limit: number;
}

function alertRank(row: CursorRow): number {
  return row.event_code === 'emergency' ? 0 : row.event_code === 'important' ? 1 : 2;
}

function encodeCursor(row: CursorRow, rank: number, date: Date | string): string {
  const occurredAt = date instanceof Date ? date.toISOString() : new Date(date).toISOString();
  return Buffer.from(JSON.stringify({ rank, occurredAt, id: row.id })).toString('base64url');
}

function encodeDraftCursor(row: CursorRow): string {
  const date = row.created_at!;
  const createdAt = date instanceof Date ? date.toISOString() : new Date(date).toISOString();
  return Buffer.from(JSON.stringify({ createdAt, id: row.id })).toString('base64url');
}

async function loadPage<T extends CursorRow>(
  db: SqlClient,
  sql: string,
  prefix: readonly unknown[],
  request: PageRequest,
  rankFor: (row: T) => number,
  dateFor: (row: T) => Date | string,
  maximumItems = request.limit,
): Promise<CursorPage<T>> {
  const cursor =
    request.cursor === null ? null : decodeCursor(request.cursor, alertCursorPayloadSchema);
  const result = await db.query<T>(sql, [
    ...prefix,
    cursor?.rank ?? null,
    cursor?.occurredAt ?? null,
    cursor?.id ?? null,
    request.limit + 1,
  ]);
  const visibleLimit = Math.min(request.limit, maximumItems);
  const hasNext = result.rows.length > visibleLimit;
  const items = result.rows.slice(0, visibleLimit);
  const last = items.at(-1);
  return {
    items,
    cursor: request.cursor,
    nextCursor: hasNext && last ? encodeCursor(last, rankFor(last), dateFor(last)) : null,
    limit: request.limit,
  };
}

async function loadDraftPage<T extends CursorRow>(
  db: SqlClient,
  sql: string,
  prefix: readonly unknown[],
  request: PageRequest,
  maximumItems = request.limit,
): Promise<CursorPage<T>> {
  const cursor =
    request.cursor === null ? null : decodeCursor(request.cursor, draftCursorPayloadSchema);
  const parameters: unknown[] = [...prefix, cursor?.createdAt ?? null, cursor?.id ?? null];
  // Preserve the existing global queue limit bind position while removing mutable rank semantics.
  if (prefix.length === 1) parameters.push(null);
  parameters.push(request.limit + 1);
  const result = await db.query<T>(sql, parameters);
  const visibleLimit = Math.min(request.limit, maximumItems);
  const hasNext = result.rows.length > visibleLimit;
  const items = result.rows.slice(0, visibleLimit);
  const last = items.at(-1);
  return {
    items,
    cursor: request.cursor,
    nextCursor: hasNext && last ? encodeDraftCursor(last) : null,
    limit: request.limit,
  };
}

export function loadAlertQueue(
  db: SqlClient,
  clinicianSub: string,
  request: PageRequest,
): Promise<CursorPage<CursorRow>> {
  return loadPage(
    db,
    ALERT_QUEUE_SQL,
    [clinicianSub],
    request,
    alertRank,
    (row) => row.occurred_at!,
  );
}

export function loadDraftQueue(
  db: SqlClient,
  clinicianSub: string,
  request: PageRequest,
): Promise<CursorPage<CursorRow>> {
  return loadDraftPage(db, DRAFT_QUEUE_SQL, [clinicianSub], request);
}

export class PatientRecordDayOutsideWindowError extends Error {}

export interface LoadedPatientRecord {
  patient: Record<string, unknown>;
  selectedDay: string;
  dayIndex: unknown[];
  daySummary: unknown | null;
  messages: unknown[];
  events: unknown[];
  evidence: unknown[];
  versions: unknown[];
  alertsPage: CursorPage;
  draftsPage: CursorPage;
  history: {
    medications: Array<Record<string, unknown>>;
    facts: Array<Record<string, unknown>>;
  };
  trends: { severity: unknown[]; adherence: unknown[] };
}

export async function loadPatientRecord(
  db: SqlClient,
  patientId: string,
  clinicianSub: string,
  request: PatientRecordQuery,
): Promise<LoadedPatientRecord | null> {
  const initialScope = [patientId, clinicianSub, request.days, request.selectedDay];
  const scopeResult = await db.query(PATIENT_RECORD_SCOPE_SQL, initialScope);
  const scopeRow = scopeResult.rows[0] as Record<string, unknown> | undefined;
  if (!scopeRow) return null;
  if (scopeRow.selected_day_in_window !== true) throw new PatientRecordDayOutsideWindowError();

  const selectedDay = String(scopeRow.selected_day);
  const scope = [patientId, clinicianSub, request.days, selectedDay];
  const rows = async (sql: string, limit: number): Promise<unknown[]> =>
    (await db.query(sql, [...scope, limit])).rows;
  const pagePrefix = [patientId, clinicianSub, request.days, selectedDay];
  const historyMedications = await db.query<Record<string, unknown>>(PATIENT_RECORD_HISTORY_SQL, [
    patientId,
    clinicianSub,
    PATIENT_RECORD_LIMITS.historyMedications,
  ]);
  const historyFacts = await db.query<Record<string, unknown>>(PATIENT_RECORD_FACT_HISTORY_SQL, [
    patientId,
    clinicianSub,
    PATIENT_RECORD_LIMITS.historyFacts,
  ]);
  const history = {
    medications: historyMedications.rows.reverse().map((row) => ({
      id: row.id,
      enteredName: row.entered_name,
      identity:
        row.identity_system === null || row.identity_code === null
          ? null
          : { system: row.identity_system, code: row.identity_code },
      doseText: row.dose_text,
      form: row.form,
      route: row.route,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      status: row.status,
      supersedesId: row.supersedes_id,
      ingredients: Array.isArray(row.ingredients)
        ? row.ingredients
            .slice(0, PATIENT_RECORD_LIMITS.historyIngredients)
            .map((ingredient: unknown) => {
              if (typeof ingredient !== 'object' || ingredient === null) return ingredient;
              const value = ingredient as Record<string, unknown>;
              return {
                ...value,
                name:
                  typeof value.name === 'string'
                    ? value.name.slice(0, PATIENT_RECORD_LIMITS.historyIngredientName)
                    : value.name,
              };
            })
        : [],
    })),
    facts: historyFacts.rows.reverse().map((row) => ({
      id: row.id,
      factType: row.fact_type,
      factCode: row.fact_code,
      statementText:
        typeof row.statement_text === 'string'
          ? row.statement_text.slice(0, PATIENT_RECORD_LIMITS.historyFactText)
          : row.statement_text,
      status: row.status,
      supersedesId: row.supersedes_id,
    })),
  };

  const patient = { ...scopeRow };
  delete patient.from_date;
  delete patient.today;
  delete patient.selected_day;
  delete patient.selected_day_in_window;

  return {
    patient,
    selectedDay,
    dayIndex: await rows(PATIENT_DAY_INDEX_SQL, PATIENT_RECORD_LIMITS.dayIndex),
    daySummary: (await db.query(PATIENT_DAY_SUMMARY_SQL, scope)).rows[0] ?? null,
    messages: await rows(PATIENT_MESSAGES_SQL, PATIENT_RECORD_LIMITS.messages),
    events: await rows(PATIENT_EVENTS_SQL, PATIENT_RECORD_LIMITS.events),
    evidence: await rows(PATIENT_EVENT_EVIDENCE_SQL, PATIENT_RECORD_LIMITS.evidence),
    versions: await rows(PATIENT_RECORD_VERSIONS_SQL, PATIENT_RECORD_LIMITS.versions),
    alertsPage: await loadPage(
      db,
      PATIENT_ALERTS_SQL,
      pagePrefix,
      request.alerts,
      alertRank,
      (row) => row.occurred_at!,
      PATIENT_RECORD_LIMITS.alerts,
    ),
    draftsPage: await loadDraftPage(
      db,
      PATIENT_REVIEW_DRAFTS_SQL,
      pagePrefix,
      request.drafts,
      PATIENT_RECORD_LIMITS.drafts,
    ),
    history,
    trends: {
      severity: await rows(PATIENT_SEVERITY_TRENDS_SQL, PATIENT_RECORD_LIMITS.trendPoints),
      adherence: await rows(PATIENT_ADHERENCE_TRENDS_SQL, PATIENT_RECORD_LIMITS.trendPoints),
    },
  };
}
