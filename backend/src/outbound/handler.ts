// backend/src/outbound/handler.ts
//
// The in-VPC Outbound Lambda (SC3 / SC6) — the SEND half of the Phase-3 pipeline. Invoked by
// EventBridge Scheduler with a one-shot dose payload { patientId, doseId }:
//
//   Scheduler (assumes target role) → THIS Lambda
//     → read the patient + render the single Mustache SMS body (SC3) + fetch Twilio creds/FROM
//     → RESERVE the dose (HIGH-2 idempotent pre-send guard) — the instant before the send
//     → Twilio messages.create (with a statusCallback → the SC7 status-callback route)
//     → UPDATE outbound_message(twilio_sid, status='queued', sent_at=now())   (SC6 anchor)
//
// HIGH-1 (no stranded 'sending' row). ALL throwable pre-send work — the patient SELECT, the template
// render, and the Secrets Manager / SSM credential fetches — runs BEFORE the reservation INSERT. So if
// any of it throws (e.g. the Twilio secret is not yet populated when a dose fires early, or a transient
// Secrets/SSM throttle), NO reservation row has been written and a Scheduler retry inserts a fresh row
// and proceeds — the dose can never be silently frozen at 'sending'.
//
// HIGH-2 (no double-SMS). The instant BEFORE the Twilio send, the handler RESERVES the dose with an atomic
//   `INSERT INTO outbound_message(patient_id, dose_id, status) VALUES($1,$2,'sending')
//      ON CONFLICT (dose_id) DO NOTHING`
// against the partial uq_outbound_message_check_in_dose_id index. If the INSERT affects 0 rows, a
// concurrent/retry invocation already owns this dose → the handler SKIPs the send entirely and
// returns cleanly. This closes the window a naive read-then-check leaves open: a read-then-check
// double-sends when the Twilio send succeeded but its subsequent DB write failed (no twilio_sid for
// the next invocation to find). The reservation row exists (status='sending') the instant BEFORE the
// send, so the next invocation's ON CONFLICT DO NOTHING inserts 0 rows and skips.
//
// Module mode: CommonJS (F11) — `__dirname` + `readFileSync` resolve natively under NodeNext, so the
// bundled CA PEM and the Mustache template (both copied alongside this handler by the CDK afterBundling
// cp) are read directly at module scope.
//
// Single-source TLS (F28) + CA pinning (M-2): the pg.Pool's explicit `ssl` object is the ONE TLS
// source — `{ ca: <pinned RDS global bundle>, rejectUnauthorized: true }`. NEVER rejectUnauthorized:false,
// NEVER a PGSSLMODE env. The shared db-pool provider owns this contract for every DB Lambda.
//
// Credentials (accountSid / authToken) are read from Secrets Manager (TWILIO_SECRET_ARN; D-06) and the
// FROM number from SSM at RUNTIME (TWILIO_FROM_PARAM; F45) — never an env value, never logged. The
// Twilio auth token is NEVER included in any thrown/logged message (T-03-06).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SchedulerClient, CreateScheduleCommand } from '@aws-sdk/client-scheduler';
import twilio from 'twilio';
import Mustache from 'mustache';
import { z } from 'zod';
import {
  SCHEDULE_GROUP_NAME,
  RESPONSE_WINDOW_MINUTES,
  buildTimeoutScheduleExpression,
} from '@medadhere/shared';
import { createDbPoolProvider } from '../shared/db-pool';
import {
  resolveOutboundSendBody,
  validateStoredCompositionRecord,
} from '../conversation/compose-plumbing';
import {
  ClaimedSendError,
  claimPreparedAgentSend,
  claimPreparedReminderSend,
  prepareReminderSend,
  reserveReminderSend,
  reserveScheduledCheckIn,
  sendClaimedOutboundUnderConsent,
  type SendClaimResult,
  type StatusCallbackConfig,
} from './send-repository';

export {
  claimPreparedAgentSend,
  reserveReminderSend,
  reserveScheduledCheckIn,
  sendClaimedOutboundUnderConsent,
};

/** Reuse the AWS SDK clients across warm invocations (module scope → fewer TLS handshakes). */
const sm = new SecretsManagerClient({});
const ssm = new SSMClient({});
/** Module-scoped SchedulerClient — reused across warm invokes (the PIPE-05 timeout one-shot). */
const scheduler = new SchedulerClient({});

/** De-identified structured metric line (metric/error/count fields only — U-16 / phi-compliance). */
function logMetric(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

const getPool = createDbPoolProvider(sm);

/**
 * The single SC3 SMS body template, read ONCE at module scope (the same CJS
 * `readFileSync(join(__dirname,…))` idiom as the pem). Bundled alongside this handler by the CDK
 * afterBundling cp; the copy is part of the bundle hash so editing it changes the asset S3 key.
 */
const SMS_TEMPLATE = readFileSync(join(__dirname, 'template.mustache'), 'utf8');

/** Shape of the Twilio credential secret (D-06; populated post-deploy). */
interface TwilioSecret {
  accountSid: string;
  authToken: string;
}

const scheduledDoseEventSchema = z
  .object({ patientId: z.string().uuid(), doseId: z.string().uuid() })
  .strict();
const agentSendEventSchema = z
  .object({
    patientId: z.string().uuid(),
    agentTurnId: z.string().uuid(),
    expectedMessagingStateVersion: z.number().int().positive(),
  })
  .strict();
const reminderEventSchema = z
  .object({
    patientId: z.string().uuid(),
    doseId: z.string().uuid(),
    reminderAttempt: z.number().int().min(1).max(5),
  })
  .strict();
const outboundEventSchema = z.union([
  reminderEventSchema,
  scheduledDoseEventSchema,
  agentSendEventSchema,
  z.object({ outboundMessageId: z.string().uuid() }).strict(),
]);

type ScheduledDoseEvent = z.infer<typeof scheduledDoseEventSchema>;
type AgentSendEvent = z.infer<typeof agentSendEventSchema>;
type ReminderEvent = z.infer<typeof reminderEventSchema>;
type RecoveryEvent = { readonly outboundMessageId: string };
type OutboundResult = { sent: boolean; reason?: string; sid?: string };

/** The patient fields the SMS body + send need (+ is_active for the H1 raced-opt-out skip). */
interface PatientRow {
  phone: string;
  medication_name: string;
  display_name: string | null;
  timezone: string;
  is_active: boolean;
  agent_enabled: boolean;
  provider_opted_in: boolean;
  reminder_limit: number;
}

interface AgentOutboundRow {
  readonly status: string;
}

const REMINDER_BODY = 'Just a gentle reminder to reply when you can about your medication.';
const TWILIO_REQUEST_TIMEOUT_MS = 5_000;

function loadStatusCallbackConfig(): StatusCallbackConfig {
  const configured = process.env.STATUS_CALLBACK_URL;
  if (!configured) throw new Error('STATUS_CALLBACK_URL env var is not set');
  const url = new URL(configured);
  const fragmentIndex = configured.indexOf('#');
  const baseUrl = fragmentIndex === -1 ? configured : configured.slice(0, fragmentIndex);
  if (baseUrl.includes('?') || url.search || url.searchParams.size > 0) {
    throw new Error('STATUS_CALLBACK_URL must not contain query parameters');
  }
  return {
    baseUrl,
    retryFragment: fragmentIndex === -1 ? '' : configured.slice(fragmentIndex),
  };
}

/**
 * Build (or return the cached) module-scoped pg.Pool. Cloned VERBATIM from data-api/handler.ts: the DB
 * credential is fetched from Secrets Manager (D-06 — never an env var) ONCE per cold container; the
 * connection env vars are guarded with actionable errors; TLS is single-sourced (F28) via the explicit
 * `ssl` object with the pinned RDS global CA bundle + rejectUnauthorized:true (M-2 / T-03-08).
 */

/** Read the Twilio credentials from Secrets Manager (the smoke/twilio.ts F47/WR-02/WR-06 guards). */
async function getTwilioCreds(): Promise<TwilioSecret> {
  const twilioSecretArn = process.env.TWILIO_SECRET_ARN;
  if (!twilioSecretArn) {
    throw new Error('TWILIO_SECRET_ARN env var is not set');
  }
  const secretValue = await sm.send(new GetSecretValueCommand({ SecretId: twilioSecretArn }));
  if (!secretValue.SecretString || secretValue.SecretString.trim() === '') {
    // F47: a clear, actionable error instead of an opaque JSON-parse crash on the placeholder secret.
    throw new Error(
      'Twilio secret not yet populated — run `aws secretsmanager put-secret-value` first (D-06)',
    );
  }
  // WR-06: a present-but-non-JSON secret must surface an actionable shape-naming error, NOT an opaque
  // SyntaxError. The raw secret is NEVER included in the message.
  let parsed: Partial<TwilioSecret>;
  try {
    parsed = JSON.parse(secretValue.SecretString) as Partial<TwilioSecret>;
  } catch {
    throw new Error(
      'Twilio secret is not valid JSON — store it as {"accountSid":"…","authToken":"…"} via `aws secretsmanager put-secret-value` (D-06)',
    );
  }
  // WR-02: the placeholder secret is a non-empty JSON object missing the creds — guard the keys so we
  // never fall through to twilio(undefined, undefined).
  const { accountSid, authToken } = parsed;
  if (!accountSid || !authToken) {
    throw new Error(
      'Twilio secret not yet populated (no accountSid/authToken) — run `aws secretsmanager put-secret-value` first (D-06)',
    );
  }
  return { accountSid, authToken };
}

/** Read the Twilio FROM number from SSM at RUNTIME (F45) — re-pointable without redeploy. */
async function getFromNumber(): Promise<string> {
  const fromParamName = process.env.TWILIO_FROM_PARAM ?? '/medadhere/twilio-from';
  const fromParam = await ssm.send(new GetParameterCommand({ Name: fromParamName }));
  const fromNumber = fromParam.Parameter?.Value;
  if (!fromNumber) {
    throw new Error(`Twilio FROM number SSM parameter ${fromParamName} is empty or missing`);
  }
  return fromNumber;
}

/**
 * Create the PIPE-05 per-dose timeout one-shot (Plan 05-01), anchored to the ACTUAL `sentAt` + the
 * response window. Name `timeout-{patientId}-{doseId}`.slice(0,64) keeps the 45-char
 * `timeout-{patientId}-` NamePrefix intact (the STOP/admin sweep still matches); the FULL doseId rides
 * Target.Input. `ScheduleExpressionTimezone: 'UTC'` pairs with the absolute-UTC `at(...)`;
 * ActionAfterCompletion 'DELETE' + FlexibleTimeWindow OFF mirror the enroll dose one-shot. Throws on any
 * problem (missing env, past instant, Scheduler error) — the caller records `timeout_schedule_failed`
 * and returns success (Q3: the SMS cannot be un-sent, so never re-send).
 */
async function createTimeoutSchedule(
  patientId: string,
  doseId: string,
  sentAt: Date,
): Promise<void> {
  const timeoutFnArn = process.env.TIMEOUT_FN_ARN;
  const schedulerTargetRoleArn = process.env.SCHEDULER_TARGET_ROLE_ARN;
  if (!timeoutFnArn || !schedulerTargetRoleArn) {
    throw new Error('TIMEOUT_FN_ARN / SCHEDULER_TARGET_ROLE_ARN env vars must both be set');
  }
  // M2 — the window is single-sourced: read the env (deploy-time injected), defaulting to the shared const.
  const windowMinutes = Number(process.env.RESPONSE_WINDOW_MINUTES ?? RESPONSE_WINDOW_MINUTES);
  const name = `timeout-${patientId}-${doseId}`.slice(0, 64);
  try {
    await scheduler.send(
      new CreateScheduleCommand({
        Name: name,
        GroupName: SCHEDULE_GROUP_NAME,
        ScheduleExpression: buildTimeoutScheduleExpression(sentAt, windowMinutes),
        ScheduleExpressionTimezone: 'UTC', // absolute-UTC at() — AWS resolves it to the intended instant
        FlexibleTimeWindow: { Mode: 'OFF' },
        ActionAfterCompletion: 'DELETE',
        Target: {
          Arn: timeoutFnArn,
          RoleArn: schedulerTargetRoleArn,
          Input: JSON.stringify({ patientId, doseId }), // the FULL doseId (not the truncated name)
        },
      }),
    );
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'ConflictException') return;
    throw error;
  }
}

function reminderScheduleName(patientId: string, doseId: string, attempt: number): string {
  const suffix = `-${attempt}`;
  return `${`reminder-${patientId}-${doseId}`.slice(0, 64 - suffix.length)}${suffix}`;
}

async function createReminderSchedules(
  patientId: string,
  doseId: string,
  sentAt: Date,
  reminderLimit: number,
  outboundFnArn: string | undefined,
  throwOnFailure = false,
): Promise<void> {
  if (!Number.isInteger(reminderLimit) || reminderLimit < 0 || reminderLimit > 5) {
    throw new Error('patient reminder limit is outside the supported range');
  }
  const schedulerTargetRoleArn = process.env.SCHEDULER_TARGET_ROLE_ARN;
  if (!outboundFnArn || !schedulerTargetRoleArn) {
    throw new Error('invokedFunctionArn / SCHEDULER_TARGET_ROLE_ARN must both be available');
  }
  const windowMinutes = Number(process.env.RESPONSE_WINDOW_MINUTES ?? RESPONSE_WINDOW_MINUTES);
  for (let attempt = 1; attempt <= reminderLimit; attempt += 1) {
    try {
      await scheduler.send(
        new CreateScheduleCommand({
          Name: reminderScheduleName(patientId, doseId, attempt),
          GroupName: SCHEDULE_GROUP_NAME,
          ScheduleExpression: buildTimeoutScheduleExpression(
            sentAt,
            (windowMinutes * attempt) / (reminderLimit + 1),
          ),
          ScheduleExpressionTimezone: 'UTC',
          FlexibleTimeWindow: { Mode: 'OFF' },
          ActionAfterCompletion: 'DELETE',
          Target: {
            Arn: outboundFnArn,
            RoleArn: schedulerTargetRoleArn,
            Input: JSON.stringify({ patientId, doseId, reminderAttempt: attempt }),
          },
        }),
      );
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'ConflictException') continue;
      logMetric({
        metric: 'reminder_schedule_failed',
        reminderAttempt: attempt,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      if (throwOnFailure) throw error;
    }
  }
}

/**
 * Outbound Lambda entrypoint. Prep (read + render + creds) → reserve → send → record (SC3/SC6),
 * HIGH-1 (no stranded 'sending') + HIGH-2 (no double-SMS) idempotent.
 *
 * @returns a small status object so a duplicate (skipped) invocation is observable in the logs without
 *          leaking any patient PII or the Twilio token.
 */
async function handleScheduledDose(
  event: ScheduledDoseEvent,
  invokedFunctionArn?: string,
): Promise<OutboundResult> {
  const { patientId, doseId } = event;
  const db = await getPool();

  // --- HIGH-1: ALL throwable pre-send work runs BEFORE the reservation ----------------------------
  // Read the patient, render the body, and fetch the Twilio credentials/FROM number BEFORE reserving.
  // If ANY of these throws (Twilio secret not yet populated when a dose fires early; transient Secrets
  // Manager / SSM throttle) NO reservation row has been written, so the dose can never be stranded at
  // 'sending' — a Scheduler retry inserts a fresh row and proceeds.
  const patientResult = await db.query(
    `SELECT phone, medication_name, display_name, timezone, is_active,
            agent_enabled, provider_opted_in, reminder_limit
       FROM patient WHERE id = $1`,
    [patientId],
  );
  const patient = patientResult.rows[0] as PatientRow | undefined;
  if (!patient) {
    // No reservation row exists yet — nothing to mark failed. The dose genuinely has no patient.
    throw new Error('Outbound patient was not found');
  }
  // H1 (P4 hotfix) — a STOP that raced in AFTER this dose's schedule fired: the row exists but is
  // deactivated. Skip cleanly (mirror the reserved-skip below), NEVER throw — throwing would trip the
  // OPS-02 pipeline-error alarm on an entirely expected condition, and a Scheduler retry never sends.
  if (!patient.is_active) {
    return { sent: false, reason: 'patient-inactive' };
  }
  if (!patient.agent_enabled || !patient.provider_opted_in) {
    return { sent: false, reason: 'messaging-disabled' };
  }

  const body = Mustache.render(SMS_TEMPLATE, {
    medicationName: patient.medication_name,
    displayName: patient.display_name ?? undefined,
  });

  const creds = await getTwilioCreds();
  const fromNumber = await getFromNumber();
  const client = twilio(creds.accountSid, creds.authToken, {
    timeout: TWILIO_REQUEST_TIMEOUT_MS,
    autoRetry: false,
  });
  const callbackConfig = loadStatusCallbackConfig();

  // --- HIGH-2: PRE-SEND RESERVATION (atomic, idempotent) — the instant before the send ------------
  // Reserve the dose the instant BEFORE the Twilio send. The partial check-in unique index makes this
  // ON CONFLICT a no-op when a check-in already exists for the dose — so a concurrent/
  // retry invocation inserts 0 rows and SKIPs the send (no double-SMS even if a prior send succeeded but
  // its DB write later failed). This is the idempotency guard; do NOT use a read-then-check.
  const reserved = await reserveScheduledCheckIn(db, event, body);
  if (!reserved) {
    // Another invocation already owns this dose — idempotent skip (no send, no UPDATE).
    return { sent: false, reason: 'already-reserved' };
  }

  let sendResult: SendClaimResult;
  try {
    sendResult = await sendClaimedOutboundUnderConsent(
      db,
      {
        patientId,
        outboundMessageId: reserved.id,
        callbackToken: reserved.callbackToken,
        callbackConfig,
        fromNumber,
        body,
        expectedMessagingStateVersion: null,
      },
      (message) => client.messages.create(message),
    );
  } catch (error: unknown) {
    if (error instanceof ClaimedSendError && error.outcome === 'status-unknown') {
      throw new Error('Outbound check-in send status is unknown');
    }
    throw new Error('Outbound check-in send did not complete');
  }
  if (!sendResult.sent) return sendResult;
  const sentAt = sendResult.sentAt;
  const sid = sendResult.sid;
  if (!sentAt || !sid) throw new Error('Outbound check-in send status is unknown');

  // --- PIPE-05: create the per-dose timeout one-shot (fired at sent_at + RESPONSE_WINDOW_MINUTES) ---
  // Q3 — the SMS is already out. A CreateSchedule failure must NEVER fail the invocation (a Scheduler
  // retry would re-send the SMS): log an OPS-02-alarmable timeout_schedule_failed (id-only) and return
  // success. The reply path still records the dose if the patient replies; only the non-response
  // detection for this one dose is lost, and the alarm surfaces it.
  // The shared transaction's queued write is the sole gate on `sent_at`.
  try {
    await createTimeoutSchedule(patientId, doseId, sentAt);
  } catch (err: unknown) {
    logMetric({
      metric: 'timeout_schedule_failed',
      errorName: err instanceof Error ? err.name : 'unknown',
    });
  }

  try {
    await createReminderSchedules(
      patientId,
      doseId,
      sentAt,
      patient.reminder_limit,
      invokedFunctionArn,
    );
  } catch (error: unknown) {
    logMetric({
      metric: 'reminder_schedule_failed',
      errorName: error instanceof Error ? error.name : 'unknown',
    });
  }

  return { sent: true, sid };
}

async function handleReminderSend(event: ReminderEvent): Promise<OutboundResult> {
  const db = await getPool();
  // Record the Scheduler-fired attempt first. If provider setup fails or an incomplete turn holds it,
  // the exact due attempt remains prepared for a safe replay; no later attempt is synthesized.
  const prepared = await prepareReminderSend(db, event, REMINDER_BODY);
  if (!prepared) return { sent: false, reason: 'not-eligible-or-already-reserved' };
  const creds = await getTwilioCreds();
  const fromNumber = await getFromNumber();
  const client = twilio(creds.accountSid, creds.authToken, {
    timeout: TWILIO_REQUEST_TIMEOUT_MS,
    autoRetry: false,
  });
  const callbackConfig = loadStatusCallbackConfig();
  const claimed = await claimPreparedReminderSend(db, event);
  if (!claimed) return { sent: false, reason: 'not-eligible-or-already-reserved' };

  let result: SendClaimResult;
  try {
    result = await sendClaimedOutboundUnderConsent(
      db,
      {
        patientId: event.patientId,
        outboundMessageId: claimed.id,
        callbackToken: claimed.callbackToken,
        callbackConfig,
        fromNumber,
        body: claimed.body,
        expectedMessagingStateVersion: null,
      },
      (message) => client.messages.create(message),
    );
  } catch (error: unknown) {
    if (error instanceof ClaimedSendError && error.outcome === 'status-unknown') {
      throw new Error('Reminder outbound send status is unknown');
    }
    throw new Error('Reminder outbound send did not complete');
  }
  return result.sent ? { sent: true, sid: result.sid } : result;
}

async function handleAgentSend(event: AgentSendEvent): Promise<OutboundResult> {
  const { patientId, agentTurnId } = event;
  const db = await getPool();
  const stored = await db.query(
    `SELECT om.status
       FROM outbound_message om
      WHERE om.patient_id = $1 AND om.agent_turn_id = $2`,
    [patientId, agentTurnId],
  );
  const row = stored.rows[0] as AgentOutboundRow | undefined;
  if (!row) throw new Error('Agent outbound row was not found');
  if (row.status !== 'prepared') return { sent: false, reason: 'already-reserved' };

  // Complete every credential/config read before claiming. A pre-send failure therefore leaves the
  // row prepared for an operator-controlled retry. The durable claim commits first; the shared sender
  // commits its patient-then-outbound consent preflight before the provider call and finalizes status
  // in a separate short write.
  const creds = await getTwilioCreds();
  const fromNumber = await getFromNumber();
  const client = twilio(creds.accountSid, creds.authToken, {
    timeout: TWILIO_REQUEST_TIMEOUT_MS,
    autoRetry: false,
  });
  const callbackConfig = loadStatusCallbackConfig();
  const claim = await claimPreparedAgentSend(db, event);
  if (!claim.claimed) return { sent: false, reason: claim.reason ?? 'already-reserved' };
  const claimed = claim.claimed;
  if (
    !claimed ||
    typeof claimed.body !== 'string' ||
    claimed.body.trim().length < 1 ||
    claimed.body.length > 320
  ) {
    if (claimed) {
      await db.query(
        `UPDATE outbound_message
            SET status = 'failed', status_updated_at = now()
          WHERE id = $1 AND status = 'sending'`,
        [claimed.id],
      );
    }
    throw new Error('Agent outbound row has no valid stored body');
  }

  // Wave 1b: transmit composed_body ?? body. The send-time re-check (1) refuses composed
  // text on never-composed message kinds, (2) re-verifies the integrity hash, and (3)
  // RE-RUNS the full Lane B validator set against the intent + day context persisted in the
  // composition record — a failed check ships the append-only template body instead.
  const sendBody = resolveOutboundSendBody(
    {
      body: claimed.body,
      composedBody: claimed.composedBody,
      composition: claimed.composition,
      messageKind: claimed.messageKind,
    },
    { validate: (sms) => validateStoredCompositionRecord(sms, claimed.composition) },
  );
  if (claimed.composedBody !== null && !sendBody.usedComposedBody) {
    // The composed text is NOT what this patient receives, so no reader may show it as if it
    // were. The append-only template `body` and the full turn_job.writer_result audit record
    // both survive; only the row's send-time claim is withdrawn.
    await db.query(
      `UPDATE outbound_message SET composed_body = NULL WHERE id = $1 AND status = 'sending'`,
      [claimed.id],
    );
  }

  let result: SendClaimResult;
  try {
    result = await sendClaimedOutboundUnderConsent(
      db,
      {
        patientId,
        outboundMessageId: claimed.id,
        callbackToken: claimed.callbackToken,
        callbackConfig,
        fromNumber,
        body: sendBody.body,
        expectedMessagingStateVersion: claimed.expectedMessagingStateVersion,
      },
      (message) => client.messages.create(message),
    );
  } catch (error: unknown) {
    if (error instanceof ClaimedSendError && error.outcome === 'provider-failed') {
      // Terminal provider rejection: the row is already 'failed', so surfacing an error would only
      // make SQS redeliver a turn that can never send — blocking the patient's FIFO group.
      console.log(
        JSON.stringify({
          stage: 'agent_send',
          outcome: 'provider_rejected',
          providerCode: error.providerCode ?? null,
          providerStatus: error.providerStatus ?? null,
        }),
      );
      return { sent: false, reason: 'provider-rejected' };
    }
    if (error instanceof ClaimedSendError && error.outcome === 'status-unknown') {
      console.log(
        JSON.stringify({
          stage: 'agent_send',
          outcome: 'status_unknown',
          providerCode: error.providerCode ?? null,
          providerStatus: error.providerStatus ?? null,
        }),
      );
      throw new Error('Agent outbound send status is unknown');
    }
    throw new Error('Agent outbound send did not complete');
  }
  return result.sent ? { sent: true, sid: result.sid } : result;
}

async function recoverCheckInLifecycle(
  event: RecoveryEvent,
  invokedFunctionArn?: string,
): Promise<OutboundResult> {
  const db = await getPool();
  const eligible = await db.query<{
    id: string;
    patient_id: string;
    dose_id: string;
    message_kind: string;
    sent_at: Date;
    reminder_limit: number;
  }>(
    `SELECT om.id, om.patient_id, om.dose_id, om.message_kind, om.sent_at,
            p.reminder_limit
       FROM outbound_message om
       JOIN patient p ON p.id = om.patient_id
      WHERE om.id = $1
        AND om.message_kind = 'check_in'
        AND om.dose_id IS NOT NULL
        AND om.twilio_sid IS NOT NULL
        AND om.sent_at IS NOT NULL
        AND om.status IN ('sending', 'sending_unknown', 'queued', 'sent', 'delivered')
        AND p.is_active = true
        AND p.agent_enabled = true
        AND p.provider_opted_in = true
        AND NOT EXISTS (
          SELECT 1 FROM inbound_reply ir
           WHERE ir.patient_id = om.patient_id
             AND (ir.dose_id = om.dose_id OR ir.received_at >= om.sent_at)
        )
        AND NOT EXISTS (
          SELECT 1 FROM adherence_record ar
           WHERE ar.patient_id = om.patient_id AND ar.dose_id = om.dose_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM clinical_event ce
           WHERE ce.patient_id = om.patient_id AND ce.dose_id = om.dose_id
        )`,
    [event.outboundMessageId],
  );
  const row = eligible.rows[0];
  if (!row || row.message_kind !== 'check_in') return { sent: false, reason: 'not-eligible' };

  await createTimeoutSchedule(row.patient_id, row.dose_id, row.sent_at);
  await createReminderSchedules(
    row.patient_id,
    row.dose_id,
    row.sent_at,
    row.reminder_limit,
    invokedFunctionArn,
    true,
  );
  return { sent: false, reason: 'lifecycle-recovered' };
}

export async function handler(
  event: unknown,
  context?: { readonly invokedFunctionArn?: string },
): Promise<OutboundResult> {
  const parsed = outboundEventSchema.parse(event);
  if ('outboundMessageId' in parsed) {
    return recoverCheckInLifecycle(parsed, context?.invokedFunctionArn);
  }
  if ('reminderAttempt' in parsed) return handleReminderSend(parsed);
  return 'doseId' in parsed
    ? handleScheduledDose(parsed, context?.invokedFunctionArn)
    : handleAgentSend(parsed);
}
