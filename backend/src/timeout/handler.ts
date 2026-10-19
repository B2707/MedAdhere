// backend/src/timeout/handler.ts
//
// The in-VPC Timeout Lambda (Plan 05-01 / PIPE-05 / SC1) — the NON-RESPONSE detector. Invoked by an
// EventBridge Scheduler one-shot the Outbound Lambda creates at send time, fired at
// `sent_at + RESPONSE_WINDOW_MINUTES`:
//
//   Scheduler one-shot (timeout-{patientId}-{doseId}) → THIS Lambda { patientId, doseId }
//     → the delivery-gated, wipe-safe idempotent `missed` write → success
//
// Design (05-PLAN "Timeout-detection design", step 3): a SINGLE INSERT … SELECT that
//   - derives patient_id AUTHORITATIVELY from dose_schedule (M4 — NEVER trusts the event's patientId;
//     a wiped dose row (STUDY-04) makes the SELECT no-op → no 23503 FK throw → no false OPS-02 alarm),
//   - gates on the check-in delivery with EXISTS over outbound_message.status NOT IN
//     ('undelivered','failed') (H5 — reminders for the same dose cannot mask check-in non-delivery;
//     a never-delivered dose must NOT be scored `missed`; non-response ≠ non-delivery, and scoring one
//     would corrupt the STUDY-08/Phase-7 denominator),
//   - locks and gates the owning patient still allowing messaging with is_active, agent_enabled, and
//     provider_opted_in all true (H1 —
//     mirrors the outbound H1 re-check: a STOP / admin-deactivate that raced in AFTER this one-shot was
//     created (or a best-effort schedule sweep that partially failed) must NOT write a `missed` row for
//     a deactivated patient → no spurious DASH-04 missed-dose signal; wipe-safe — an absent patient row
//     leaves the eligibility CTE empty → clean 0-row no-op, never a 23503 FK throw),
//   - is idempotent via ON CONFLICT (dose_id) DO NOTHING (Q1) — a classifier row (the patient replied)
//     always wins; a replay/double-fire inserts nothing.
// The written row (Q1) is exactly {adherence_state:'unknown', reason_code:'none', safety_flag:'none',
// decided_by:'timeout', status:'missed', inbound_message_id:NULL}. `unknown` (NOT a `missed`
// adherence_state — there is none, schema.sql:41) makes these a RESPONSE-RATE bucket, never folded into
// confirmed-non-adherence numerators (M13 reporting canon).
//
// PIPE-06 interlock: a LATE reply after this row is overwritten by the classifier's
// `ON CONFLICT (dose_id) DO UPDATE … WHERE decided_by='timeout'` (which the H2 hotfix amends to also set
// status='recorded'). late-reply-then-timeout is the inverse: the timeout INSERT hits DO NOTHING.
//
// Logging (healthcare-phi-compliance / U-16): `timeout_recorded` / `timeout_noop` metric names
// only, with no patient/dose identifiers. SUCCESS on BOTH paths.
//
// Module mode: CommonJS (F11); the shared db-pool provider supplies F28 single-source TLS, M-2 pinned
// CA, D-11 max 2, and per-cold-start secret loading. No Twilio, no SSM, no LLM — the write is the
// only side effect.

import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createDbPoolProvider } from '../shared/db-pool';

/** Reuse the AWS SDK client across warm invocations (module scope → fewer TLS handshakes). */
const sm = new SecretsManagerClient({});

const getPool = createDbPoolProvider(sm);

/** The Scheduler one-shot invoke payload (PIPE-05). */
interface TimeoutEvent {
  patientId: string;
  doseId: string;
}

/** Identifier-free structured metric line (metric name only — U-16). */
function logMetric(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

/**
 * The delivery-gated, wipe-safe idempotent `missed` write (design step 3). Exported so the Phase-5
 * PIPE-06 real-PG write-contract matrix drives the EXACT handler SQL (no drift between the handler and
 * the semantic proof). $1 = doseId — the ONLY bound parameter (patient_id is derived from
 * dose_schedule, M4). ON CONFLICT (dose_id) DO NOTHING (Q1); EXISTS delivery gate (H5) +
 * active/messaging-state gate (H1). The materialized patient CTE serializes with STOP/deactivate before
 * reading consent; an absent dose OR a patient that STOP disabled yields a clean 0-row no-op (M4
 * wipe-safety), never a foreign-key throw.
 */
export const TIMEOUT_INSERT_SQL = `WITH eligible_patient AS MATERIALIZED (
   SELECT ds.patient_id, ds.id AS dose_id
     FROM patient p
     JOIN dose_schedule ds ON ds.patient_id = p.id
    WHERE ds.id = $1
      AND p.is_active = true
      AND p.provider_opted_in = true
      AND p.agent_enabled = true
      FOR NO KEY UPDATE OF p
 )
   INSERT INTO adherence_record
     (patient_id, dose_id, inbound_message_id, adherence_state, reason_code, safety_flag, decided_by, status)
   SELECT ep.patient_id, ep.dose_id, NULL, 'unknown', 'none', 'none', 'timeout', 'missed'
     FROM eligible_patient ep
    WHERE EXISTS (SELECT 1 FROM outbound_message om
                   WHERE om.dose_id = ep.dose_id
                     AND om.message_kind = 'check_in'
                     AND om.status NOT IN ('undelivered', 'failed'))
   ON CONFLICT (dose_id) DO NOTHING`;

/**
 * Build (or return the cached) module-scoped pg.Pool. Cloned VERBATIM from outbound/handler.ts: the DB
 * credential is fetched from Secrets Manager (D-06 — never an env var) ONCE per cold container; the
 * connection env vars are guarded with actionable errors; TLS is single-sourced (F28) via the explicit
 * `ssl` object with the pinned RDS global CA bundle + rejectUnauthorized:true (M-2 / T-03-08).
 */

/**
 * Timeout Lambda entrypoint. Validates the Scheduler payload, then runs the delivery-gated, wipe-safe
 * idempotent `missed` write. RESOLVES success on BOTH paths (a written row AND a no-op) — a no-op is a
 * correct outcome (the patient replied, the send never delivered, or the dose row was wiped), never an
 * error. Only a genuine crash-class failure (DB down, code bug) propagates.
 *
 * @returns `{ recorded }` so a no-op is observable in the logs without leaking any patient PII.
 */
export async function handler(event: TimeoutEvent): Promise<{ recorded: boolean }> {
  const { patientId, doseId } = event ?? {};
  if (!patientId || !doseId) {
    throw new Error('Timeout event must carry { patientId, doseId }');
  }

  const db = await getPool();

  // The single delivery-gated, wipe-safe INSERT (M4/H5/Q1). rowCount 1 → a fresh `missed` row was
  // written; rowCount 0 → the dose was never delivered, was STUDY-04-wiped, or already carries a row
  // (classifier or a prior timeout) — all correct no-ops.
  const result = await db.query(TIMEOUT_INSERT_SQL, [doseId]);
  const recorded = (result.rowCount ?? 0) > 0;

  logMetric({
    metric: recorded ? 'timeout_recorded' : 'timeout_noop',
  });

  return { recorded };
}
