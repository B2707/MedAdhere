// backend/src/classifier/handler.ts
//
// The stored-reply classifier core (Plan 04-03 / SC2 / SC4 / PIPE-04/06/07/10):
//
//   FIFO queue worker → processStoredReply(id)
//     → re-read the reply row from the DB (raw_body NEVER rides SQS)
//     → REPLAY PRE-FLIGHT (existsForInboundMessage — BEFORE attribution, BEFORE the paid call)
//     → PIPE-10 attribution + PIPE-06 is_late
//     → the PURE classifyReplyText core (forced tool + .parse() D-16 gate; U-23)
//     → the SINGLE-ARBITER write contract → success
//
// CHECK-BEFORE-SPEND (gate fix U-02/REV-H2): the pre-flight runs FIRST so a redelivered
// wake retry (Twilio retry upstream or SQS redelivery) costs $0 and
// re-attributes nothing. Attribution CANNOT be the idempotency key: re-running it on a
// redelivery computes a DIFFERENT dose_id because the dose now has a classifier row.
//
// SC4 TERMINAL POLICY (gate fix U-04/REV-H3): after the SDK's own retries exhaust on a
// transient failure, the core WRITES the terminal { unknown, other, none } row and RETURNS
// SUCCESS — one visible terminal row, no re-drive around it. Crash-class failures (DB down or
// code bugs) deliberately propagate for FIFO retry. 401 AuthenticationError also
// writes unknown + success (it will not heal on retry) but emits the DISTINCT
// `anthropic_auth_failure` metric — the stop-the-line operator signal. Contract failures write
// the same terminal row with NO second LLM call (the W0.1 no-repair-retry design note); the
// model-flag safety OR + the U-11 salvage side effects land with Plan 04-04.
//
// WRITE CONTRACT (gate fix U-02): ONE INSERT carries exactly ONE arbiter —
//   ON CONFLICT (dose_id) DO UPDATE … WHERE adherence_record.decided_by = 'timeout'
// (the classifier overwrites ONLY timeout rows — PIPE-06). For dose_id NULL (unattributed)
// rows that arbiter never fires (PG: NULLs never conflict); the rare concurrent-replay race
// that passes the pre-flight surfaces as PG error 23505 on UNIQUE(inbound_message_id) and is
// CAUGHT AND TREATED AS SUCCESS — the explicit backstop, never a second arbiter.
//
// Logging (healthcare-phi-compliance / U-16): identifier-free metrics carry only counts,
// static names/enums, and issue paths + codes. NEVER raw_body, record IDs, SIDs, ZodError
// messages, or received values (they can echo reply-influenced model output).
//
// Module mode: CommonJS (F11); the shared db-pool provider supplies F28 single-source TLS,
// M-2 pinned CA, and D-11 max 2. The Anthropic key is read from Secrets
// Manager PER-INVOKE (D-ANTHROPIC; F47/WR-06 guards) and passed through the pure core's
// injected-key seam — the key is never an env var, never logged.

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { Pool } from 'pg';
import twilio from 'twilio';
import {
  RESPONSE_WINDOW_MINUTES,
  SAFETY_AUTO_REPLY_EMERGENCY,
  SAFETY_AUTO_REPLY_MEDICAL_QUESTION,
  inboundReplyWakeSchema,
} from '@medadhere/shared';
import {
  classifyReplyText,
  ClassifyAuthError,
  ClassifyContractError,
  ClassifyTransientError,
} from './classify';
import { createDbPoolProvider } from '../shared/db-pool';

/** Reuse the AWS SDK clients across warm invocations. */
const sm = new SecretsManagerClient({});
const ssm = new SSMClient({});

const getPool = createDbPoolProvider(sm);

/** Module-scoped Twilio credential cache (the inbound-handler posture — one read per cold start). */
let twilioCreds: TwilioSecret | undefined;

/** Shape of the Anthropic credential secret (medadhere/anthropic — D-ANTHROPIC). */
interface AnthropicSecret {
  apiKey: string;
}

/** Shape of the Twilio credential secret (D-06) — the 04-04 model-flag safety send. */
interface TwilioSecret {
  accountSid: string;
  authToken: string;
}

/** The three flag values that trigger the model-side safety action (SC3 second detector). */
const MODEL_SAFETY_FLAGS = ['acute_physical', 'crisis', 'medical_question'] as const;
type ModelSafetyFlag = (typeof MODEL_SAFETY_FLAGS)[number];

/** The U-11 salvage set: fail-open ONLY on the high-stakes classes. */
const SALVAGE_FLAGS: readonly string[] = ['acute_physical', 'crisis'];

/** Twilio REST error 21610: recipient on the Advanced Opt-Out blocklist (U-18 → 'suppressed'). */
const TWILIO_OPT_OUT_ERROR_CODE = 21610;

/** Cap for the auto_reply_error diagnostic column (DB-only, never logged). */
const AUTO_REPLY_ERROR_MAX_CHARS = 500;

/** The reply row the classifier re-reads (raw_body never rides SQS). The patient JOIN
 *  supplies the safety-send target (Plan 04-04) — never a second lookup. */
interface InboundReplyRow {
  id: string;
  patient_id: string;
  raw_body: string;
  received_at: Date;
  safety_flagged: boolean;
  phone: string;
}

/** The attribution result (PIPE-10). */
interface AttributionRow {
  dose_id: string;
  sent_at: Date;
}

const MS_PER_MINUTE = 60_000;

/** Identifier-free structured metric line (counts + bounded names ONLY — U-16). */
function logMetric(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

/** Cloned VERBATIM from data-api/handler.ts (F28/M-2/D-11 — see status-callback for rationale). */

/** Read the Twilio credentials (the inbound-handler F47/WR-02/WR-06 guard clone, cached). */
async function getTwilioCreds(): Promise<TwilioSecret> {
  if (twilioCreds) return twilioCreds;
  const twilioSecretArn = process.env.TWILIO_SECRET_ARN;
  if (!twilioSecretArn) {
    throw new Error('TWILIO_SECRET_ARN env var is not set');
  }
  const secretValue = await sm.send(new GetSecretValueCommand({ SecretId: twilioSecretArn }));
  if (!secretValue.SecretString || secretValue.SecretString.trim() === '') {
    throw new Error(
      'Twilio secret not yet populated — run `aws secretsmanager put-secret-value` first (D-06)',
    );
  }
  let parsed: Partial<TwilioSecret>;
  try {
    parsed = JSON.parse(secretValue.SecretString) as Partial<TwilioSecret>;
  } catch {
    throw new Error(
      'Twilio secret is not valid JSON — store it as {"accountSid":"…","authToken":"…"} via `aws secretsmanager put-secret-value` (D-06)',
    );
  }
  const { accountSid, authToken } = parsed;
  if (!accountSid || !authToken) {
    throw new Error(
      'Twilio secret not yet populated (no accountSid/authToken) — run `aws secretsmanager put-secret-value` first (D-06)',
    );
  }
  twilioCreds = { accountSid, authToken };
  return twilioCreds;
}

/** Read the Twilio FROM number from SSM at RUNTIME (F45) — only when a safety send fires. */
async function getFromNumber(): Promise<string> {
  const fromParamName = process.env.TWILIO_FROM_PARAM ?? '/medadhere/twilio-from';
  const fromParam = await ssm.send(new GetParameterCommand({ Name: fromParamName }));
  const fromNumber = fromParam.Parameter?.Value;
  if (!fromNumber) {
    throw new Error(`Twilio FROM number SSM parameter ${fromParamName} is empty or missing`);
  }
  return fromNumber;
}

/** Narrow a thrown Twilio REST error to its numeric code (21610 detection — U-18). */
function twilioErrorCode(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'number') return code;
  }
  return undefined;
}

/**
 * Send the safety auto-reply and complete the U-18 lifecycle on the given safety-event row:
 * 'sent' + sid + sent_at, or 'failed' + error, or 'suppressed' on Twilio 21610. Never throws —
 * a safety-send failure must not fail the classification write (the row records the outcome).
 */
async function sendSafetyAutoReply(
  db: Pool,
  args: {
    safetyEventId: string;
    patientPhone: string;
    flag: ModelSafetyFlag;
  },
): Promise<void> {
  const { safetyEventId, patientPhone, flag } = args;
  const body =
    flag === 'medical_question'
      ? SAFETY_AUTO_REPLY_MEDICAL_QUESTION // SAFETY-04: softer 811 redirect, no alarm
      : SAFETY_AUTO_REPLY_EMERGENCY; // acute_physical / crisis: 911/988
  try {
    const creds = await getTwilioCreds();
    const fromNumber = await getFromNumber();
    const client = twilio(creds.accountSid, creds.authToken);
    const msg = await client.messages.create({
      from: fromNumber,
      to: patientPhone,
      body,
    });
    await db.query(
      `UPDATE safety_events
          SET auto_reply_status = 'sent', auto_reply_twilio_sid = $1, auto_reply_sent_at = now()
        WHERE id = $2`,
      [msg.sid, safetyEventId],
    );
  } catch (err: unknown) {
    const code = twilioErrorCode(err);
    const message = err instanceof Error ? err.message : 'unknown safety-send error';
    if (code === TWILIO_OPT_OUT_ERROR_CODE) {
      // U-18: a STOP'd tester texting a crisis — Twilio blocks the send; out-of-band follow-up.
      await db.query(
        `UPDATE safety_events
            SET auto_reply_status = 'suppressed', auto_reply_error = $1
          WHERE id = $2`,
        [message.slice(0, AUTO_REPLY_ERROR_MAX_CHARS), safetyEventId],
      );
    } else {
      await db.query(
        `UPDATE safety_events
            SET auto_reply_status = 'failed', auto_reply_error = $1
          WHERE id = $2`,
        [message.slice(0, AUTO_REPLY_ERROR_MAX_CHARS), safetyEventId],
      );
    }
    logMetric({
      metric: 'classifier_safety_send_failed',
      twilioErrorCode: code ?? null,
      outcome: code === TWILIO_OPT_OUT_ERROR_CODE ? 'suppressed' : 'failed',
    });
  }
}

/**
 * Plan 04-04 — the model-side safety action (SC3 second detector). The U-12 both-detectors
 * upsert distinguishes three outcomes via `(xmax = 0) AS inserted`:
 *   inserted=true  → the model is the FIRST detector: the 'sending' reservation rode the
 *                    insert — send the auto-reply.
 *   inserted=false → the prefilter row existed and is now 'both' — send NOTHING new…
 *   no row         → the row was already 'both' (WHERE-false) — send NOTHING new…
 * …EXCEPT that a prior FAILED send is retried (U-18: replays retry ONLY 'failed' rows) via a
 * status-guarded reservation UPDATE. Never throws (same posture as sendSafetyAutoReply).
 */
async function runModelSafetyAction(
  db: Pool,
  args: {
    patientId: string;
    inboundMessageId: string;
    patientPhone: string;
    flag: ModelSafetyFlag;
  },
): Promise<void> {
  const { patientId, inboundMessageId, patientPhone, flag } = args;

  // The U-12 normative upsert — a mirrored DO NOTHING could never reach 'both'.
  const upsert = await db.query(
    `INSERT INTO safety_events
       (patient_id, inbound_message_id, flag_category, trigger_source, auto_reply_status)
       VALUES ($1, $2, $3, 'model', 'sending')
       ON CONFLICT (inbound_message_id) DO UPDATE SET trigger_source = 'both'
         WHERE safety_events.trigger_source <> 'both'
       RETURNING id, (xmax = 0) AS inserted`,
    [patientId, inboundMessageId, flag],
  );
  const row = upsert.rows[0] as { id: string; inserted: boolean } | undefined;

  if (row?.inserted) {
    // 05-04 OPS-02 (a): a NEW safety_events row was recorded (the model detector is first). The
    // canonical metric line MonitoringConstruct's metric filter matches → next-business-day review.
    logMetric({
      metric: 'safety_event_recorded',
      source: 'model',
    });
    // Fresh model-detected event — the reservation is committed; send.
    await sendSafetyAutoReply(db, {
      safetyEventId: row.id,
      patientPhone,
      flag,
    });
    return;
  }

  // The row pre-existed (prefilter side, or an earlier model pass). Send-once holds — UNLESS
  // the prior send FAILED: reserve exactly the 'failed' row back to 'sending' and retry (U-18).
  const retry = await db.query(
    `UPDATE safety_events
        SET auto_reply_status = 'sending'
      WHERE inbound_message_id = $1 AND auto_reply_status = 'failed'
      RETURNING id`,
    [inboundMessageId],
  );
  const failedRow = retry.rows[0] as { id: string } | undefined;
  if (failedRow) {
    logMetric({ metric: 'classifier_safety_retry_failed_send' });
    await sendSafetyAutoReply(db, {
      safetyEventId: failedRow.id,
      patientPhone,
      flag,
    });
  }
}

/** Per-invoke Anthropic key read (D-ANTHROPIC; the smoke F47/WR-06 guard clones). */
async function getAnthropicApiKey(): Promise<string> {
  const anthropicSecretArn = process.env.ANTHROPIC_SECRET_ARN;
  if (!anthropicSecretArn) {
    throw new Error('ANTHROPIC_SECRET_ARN env var is not set');
  }
  const secretValue = await sm.send(new GetSecretValueCommand({ SecretId: anthropicSecretArn }));
  if (!secretValue.SecretString || secretValue.SecretString.trim() === '') {
    throw new Error(
      'Anthropic secret not yet populated — run `aws secretsmanager put-secret-value` first (D-ANTHROPIC)',
    );
  }
  let parsed: Partial<AnthropicSecret>;
  try {
    parsed = JSON.parse(secretValue.SecretString) as Partial<AnthropicSecret>;
  } catch {
    throw new Error(
      'Anthropic secret is not valid JSON — store it as {"apiKey":"sk-ant-…"} via `aws secretsmanager put-secret-value` (D-ANTHROPIC)',
    );
  }
  const { apiKey } = parsed;
  if (!apiKey) {
    throw new Error(
      'Anthropic secret not yet populated (no apiKey) — run `aws secretsmanager put-secret-value` first (D-ANTHROPIC)',
    );
  }
  return apiKey;
}

/** Read the response-window envs (PIPE-05/PIPE-10; defaults sum to the ratified 24 h total). */
function windowMinutes(): { responseWindow: number; lateAllowance: number } {
  const responseWindow = Number(
    process.env.RESPONSE_WINDOW_MINUTES ?? String(RESPONSE_WINDOW_MINUTES),
  );
  const lateAllowance = Number(process.env.LATE_ALLOWANCE_MINUTES ?? '1320');
  if (!Number.isFinite(responseWindow) || !Number.isFinite(lateAllowance)) {
    throw new Error('RESPONSE_WINDOW_MINUTES / LATE_ALLOWANCE_MINUTES must be numeric');
  }
  return { responseWindow, lateAllowance };
}

/** PG unique-violation code — the 23505 race backstop (U-02). */
const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/**
 * The single-arbiter adherence write SQL (U-02). ONE INSERT, ONE arbiter, timeout-only overwrite.
 * Exported so the Phase-5 PIPE-06 real-PG write-contract matrix drives the EXACT handler SQL (no
 * drift between the handler and the semantic proof).
 *
 * H2 (Phase-5 hotfix): the ON CONFLICT DO UPDATE SET flips `status = 'recorded'` ALONGSIDE
 * `decided_by = 'classifier'`. Before H2 the SET flipped decided_by but LEFT status='missed' on a
 * late reply overwriting a Timeout-Lambda row → the dashboard rendered a taken dose as missed. The
 * arbiter WHERE `adherence_record.decided_by = 'timeout'` guarantees the classifier only ever
 * overwrites a timeout row (never another classifier verdict); PIPE-06.
 */
export const ADHERENCE_UPSERT_SQL = `INSERT INTO adherence_record
       (patient_id, dose_id, inbound_message_id, adherence_state, reason_code, safety_flag, decided_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'classifier', 'recorded')
       ON CONFLICT (dose_id) DO UPDATE
          SET adherence_state = EXCLUDED.adherence_state,
              reason_code = EXCLUDED.reason_code,
              safety_flag = EXCLUDED.safety_flag,
              inbound_message_id = EXCLUDED.inbound_message_id,
              decided_by = 'classifier',
              status = 'recorded'
        WHERE adherence_record.decided_by = 'timeout'`;

/**
 * The single write path (U-02): one INSERT, one arbiter, timeout-only overwrite. The caller
 * catches 23505 as the concurrent-replay backstop and MUST inspect the returned row count:
 * PG's `ON CONFLICT … DO UPDATE … WHERE` silently affects ZERO rows (no error, no 23505)
 * when the conflicting dose row is already classifier-decided (code-review CRITICAL,
 * 2026-07-03) — the double-text/correction case the caller compensates for.
 */
async function writeAdherenceRecord(
  db: Pool,
  row: {
    patientId: string;
    doseId: string | null;
    inboundMessageId: string;
    adherenceState: string;
    reasonCode: string;
    safetyFlag: string;
  },
): Promise<number> {
  const result = await db.query(ADHERENCE_UPSERT_SQL, [
    row.patientId,
    row.doseId,
    row.inboundMessageId,
    row.adherenceState,
    row.reasonCode,
    row.safetyFlag,
  ]);
  return result.rowCount ?? 0;
}

/**
 * Process one validated stored inbound reply. Resolves for every terminal outcome and rejects
 * only for crash-class failures so the FIFO delivery can be retried without reordering the patient.
 */
export async function processStoredReply(inboundMessageId: string, database?: Pool): Promise<void> {
  const { inboundMessageId: validatedInboundMessageId } = inboundReplyWakeSchema.parse({
    inboundMessageId,
  });
  const db = database ?? (await getPool());

  // --- Re-read the reply (raw_body never rides SQS); patient JOIN = the safety-send target -------
  const replyRes = await db.query(
    `SELECT ir.id, ir.patient_id, ir.raw_body, ir.received_at, ir.safety_flagged,
            p.phone
       FROM inbound_reply ir
       JOIN patient p ON p.id = ir.patient_id
      WHERE ir.id = $1`,
    [validatedInboundMessageId],
  );
  const reply = replyRes.rows[0] as InboundReplyRow | undefined;
  if (!reply) {
    // STUDY-04 wipe race: the reply was deleted between publish and delivery — nothing to do.
    logMetric({ metric: 'classifier_reply_row_missing' });
    return;
  }

  // --- REPLAY PRE-FLIGHT (U-02/REV-H2: before attribution, before the paid call) ---------------
  const preflight = await db.query(
    `SELECT id FROM adherence_record WHERE inbound_message_id = $1`,
    [inboundMessageId],
  );
  if ((preflight.rowCount ?? 0) > 0) {
    logMetric({ metric: 'classifier_replay_skip' });
    return;
  }

  // --- PIPE-10 attribution + PIPE-06 is_late ------------------------------------------------------
  // Most recent outbound for this patient, sent within (received_at − window − allowance,
  // received_at], whose dose has no classifier-decided record. No match → dose_id NULL.
  const { responseWindow, lateAllowance } = windowMinutes();
  const windowStart = new Date(
    reply.received_at.getTime() - (responseWindow + lateAllowance) * MS_PER_MINUTE,
  );
  const attributionRes = await db.query(
    `SELECT om.dose_id, om.sent_at
       FROM outbound_message om
      WHERE om.patient_id = $1
        AND om.dose_id IS NOT NULL
        AND om.sent_at IS NOT NULL
        AND om.sent_at >= $2
        AND om.sent_at <= $3
        AND NOT EXISTS (
              SELECT 1 FROM adherence_record ar
               WHERE ar.dose_id = om.dose_id AND ar.decided_by = 'classifier'
            )
      ORDER BY om.sent_at DESC
      LIMIT 1`,
    [reply.patient_id, windowStart, reply.received_at],
  );
  const attribution = attributionRes.rows[0] as AttributionRow | undefined;
  const doseId = attribution?.dose_id ?? null;

  if (attribution) {
    // SEMANTIC-CONFLICT GUARD (Wave 2 live repair, 2026-08-16): this pre-08-04a pipeline is
    // DORMANT — infra wires the SQS trigger to conversation/queue-worker.ts, not this handler —
    // and this write stamps inbound_reply.dose_id with ATTRIBUTION semantics: any timing-matched
    // reply, content-free "Hello?" included. The live reminder claim
    // (outbound/send-repository.ts claimPreparedReminderSend) now reads that same column with
    // ANSWERED semantics — stamped only inside the turn-commit transaction when the turn
    // resolved an administration for that dose. Re-wiring this handler without reworking this
    // write would silently suppress reminders for doses the patient never addressed. Do NOT
    // restore this trigger path while the Wave-2 answered guard reads dose_id.
    // PIPE-06: late = the reply landed after the response window closed (but inside the
    // attribution window, or it would not have matched). Recorded on the reply row.
    const isLate =
      reply.received_at.getTime() > attribution.sent_at.getTime() + responseWindow * MS_PER_MINUTE;
    await db.query(`UPDATE inbound_reply SET dose_id = $1, is_late = $2 WHERE id = $3`, [
      doseId,
      isLate,
      inboundMessageId,
    ]);
  } else {
    logMetric({ metric: 'classifier_unattributed' });
  }

  // --- The paid call, through the PURE core (U-23) with the per-invoke key -----------------------
  const apiKey = await getAnthropicApiKey();

  let adherenceState = 'unknown';
  let reasonCode = 'other';
  let safetyFlag = 'none';
  // The model-side safety flag that triggers the SC3 second-detector action (Plan 04-04) —
  // from a VALID classification, or SALVAGED from a malformed one (U-11).
  let actionFlag: ModelSafetyFlag | null = null;
  try {
    const classification = await classifyReplyText(reply.raw_body, {
      apiKey,
      // Per-call telemetry → thesis latency/cost dataset + budget tracking. The record is
      // PII-free by construction (token counts, timing, version ids only — U-16); the pure
      // core swallows any throw from this sink so it can never block the patient path.
      onUsage: (usage) => logMetric({ metric: 'classifier_usage', ...usage }),
    });
    adherenceState = classification.adherence_state;
    reasonCode = classification.reason_code;
    safetyFlag = classification.safety_flag;
    if ((MODEL_SAFETY_FLAGS as readonly string[]).includes(classification.safety_flag)) {
      actionFlag = classification.safety_flag as ModelSafetyFlag;
    }
  } catch (err: unknown) {
    if (err instanceof ClassifyTransientError) {
      // SC4 terminal policy (U-04): the SDK already retried ×3 — write unknown, return success.
      logMetric({
        metric: 'classifier_transient_exhausted',
        bodyLength: reply.raw_body.length,
      });
    } else if (err instanceof ClassifyAuthError) {
      // Distinct stop-the-line signal: will not heal on retry; operator must rotate/fund.
      logMetric({ metric: 'anthropic_auth_failure' });
    } else if (err instanceof ClassifyContractError) {
      // No repair retry (W0.1 note). U-16: paths + codes only — never values, never raw_body.
      logMetric({
        metric: 'classifier_contract_failure',
        bodyLength: reply.raw_body.length,
        issues: err.issueSummary,
      });
      // U-11 SAFETY SALVAGE: fail-OPEN on safety, fail-CLOSED on the label. Shallow-read the
      // raw tool input's safety_flag BEFORE falling to unknown — a valid high-stakes flag
      // inside a malformed object still escalates; the LABEL stays { unknown, other, none }.
      const raw = err.rawToolInput;
      if (typeof raw === 'object' && raw !== null && 'safety_flag' in raw) {
        const salvaged = (raw as { safety_flag: unknown }).safety_flag;
        if (typeof salvaged === 'string' && SALVAGE_FLAGS.includes(salvaged)) {
          logMetric({ metric: 'classifier_safety_salvage' });
          actionFlag = salvaged as ModelSafetyFlag;
        }
      }
    } else {
      throw err; // crash-class — the FIFO delivery owns the retry
    }
  }

  // --- Plan 04-04: the model-side safety action (BEFORE the label write — safety first) ----------
  if (actionFlag) {
    await runModelSafetyAction(db, {
      patientId: reply.patient_id,
      inboundMessageId,
      patientPhone: reply.phone,
      flag: actionFlag,
    });
  }

  // --- The single-arbiter write (U-02) + the 23505 race backstop ----------------------------------
  try {
    const written = await writeAdherenceRecord(db, {
      patientId: reply.patient_id,
      doseId,
      inboundMessageId,
      adherenceState,
      reasonCode,
      safetyFlag,
    });
    if (written === 0 && doseId !== null) {
      // Code-review CRITICAL fix (2026-07-03): the dose already carries a CLASSIFIER-decided
      // row (a double-text/correction reply, or a concurrent same-dose writer that won) — the
      // WHERE-false conflict is a silent zero-row no-op, NOT a 23505. This reply's
      // classification must not be discarded: persist it UNATTRIBUTED (dose_id NULL — the
      // DASH-07 review queue surfaces it; one-outcome-per-dose stays intact). A concurrent
      // retry of the SAME inbound id lands here too and its compensating insert then raises
      // 23505 on UNIQUE(inbound_message_id) → the catch below treats it as success.
      logMetric({ metric: 'classifier_dose_collision' });
      await writeAdherenceRecord(db, {
        patientId: reply.patient_id,
        doseId: null,
        inboundMessageId,
        adherenceState,
        reasonCode,
        safetyFlag,
      });
    }
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      // Two concurrent replays passed the pre-flight — the other one won. Success by contract.
      logMetric({ metric: 'classifier_replay_race' });
      return;
    }
    throw err;
  }

  logMetric({
    metric: 'classifier_recorded',
    attributed: doseId !== null,
    adherenceState,
  });
}
