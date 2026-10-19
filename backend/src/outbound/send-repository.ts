// Transactional persistence and provider-send state transitions for outbound SMS delivery.

import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { doseResponseWindowMinutes } from '../conversation/clinical-memory/adherence-mapping.js';

/** De-identified structured metric line (metric/count fields only — U-16 / phi-compliance). */
function logMetric(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

/**
 * Lane Q (2026-08-17 live incident) — REMINDER SUPPRESSION: a patient who has texted ANY reply
 * (any dose_id, even unclassified) in the last N minutes is present and engaged — the scheduled
 * "Just a gentle reminder…" nudge is redundant noise, and the pending question resurfaces
 * through the RE-ASK ROUTE (clinical-memory/index.ts) on their next turn instead. Deliberately
 * broader than the existing dose-keyed answered guards below (which require the reply to have
 * resolved THIS dose specifically) — this is a presence signal, not an answer signal.
 */
const RECENT_INBOUND_REPLY_SUPPRESSION_MINUTES = 60;

export interface ScheduledDoseClaimInput {
  readonly patientId: string;
  readonly doseId: string;
}

export interface ReminderClaimInput extends ScheduledDoseClaimInput {
  readonly reminderAttempt: number;
}

export interface AgentSendClaimInput {
  readonly patientId: string;
  readonly agentTurnId: string;
  readonly expectedMessagingStateVersion: number;
}

export interface PreparedAgentTerminalizationInput {
  readonly patientId: string;
  readonly agentTurnId: string;
  readonly outboundMessageId: string;
  /**
   * Wave 1a: true ONLY when a newer inbound superseded this reply (burst suppression) — it
   * stamps `suppressed_by_newer_inbound` so batch coherence can tell burst members apart from
   * consent-stale or provider-failed rows. Defaults to false.
   */
  readonly supersededByNewerInbound?: boolean;
}

interface ClaimedAgentOutboundRow {
  readonly id: string;
  readonly body: string | null;
  /** Wave 1b: the AI-composed text, if this reply was composed. The sender transmits composed_body ?? body. */
  readonly composedBody: string | null;
  /** Wave 1b: composition provenance for the send-time integrity re-check on composed rows. */
  readonly composition: unknown;
  /** Wave 1b: composed text is honored at send ONLY on composable message kinds. */
  readonly messageKind: string;
  readonly phone: string;
  readonly callbackToken: string;
  readonly expectedMessagingStateVersion: number;
}

type AgentClaimFailureReason =
  | 'patient-inactive'
  | 'messaging-disabled'
  | 'messaging-state-changed'
  | 'already-reserved';

export interface AgentClaimResult {
  readonly claimed: ClaimedAgentOutboundRow | null;
  readonly reason: AgentClaimFailureReason | null;
}

export interface ClaimedReminderRow {
  readonly id: string;
  readonly body: string;
  readonly phone: string;
  readonly callbackToken: string;
}

export interface ClaimedCheckInRow {
  readonly id: string;
  readonly callbackToken: string;
}

export interface StatusCallbackConfig {
  readonly baseUrl: string;
  readonly retryFragment: string;
}

interface SendClaimInput {
  readonly patientId: string;
  readonly outboundMessageId: string;
  readonly callbackToken: string;
  readonly callbackConfig: StatusCallbackConfig;
  readonly fromNumber: string;
  readonly body: string;
  readonly expectedMessagingStateVersion: number | null;
}

interface ProviderMessageInput {
  readonly from: string;
  readonly to: string;
  readonly body: string;
  readonly statusCallback: string;
}

type ProviderCreate = (input: ProviderMessageInput) => Promise<{ readonly sid: string }>;

export interface SendClaimResult {
  readonly sent: boolean;
  readonly reason?: string;
  readonly sid?: string;
  readonly sentAt?: Date;
}

export class ClaimedSendError extends Error {
  // providerCode/providerStatus carry only the provider's numeric/string error identifiers —
  // never the provider message, which can embed the recipient phone number.
  constructor(
    readonly outcome: 'provider-failed' | 'status-unknown',
    readonly providerCode?: number | string,
    readonly providerStatus?: number,
  ) {
    super(outcome);
  }
}

const TWILIO_MESSAGE_SID_PATTERN = /^SM[0-9a-fA-F]{32}$/;

function newCallbackCorrelation(): { readonly token: string; readonly hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: createHash('sha256').update(token).digest() };
}

/** The config and generated base64url token are prevalidated, so this post-claim step cannot throw. */
function statusCallbackUrl(config: StatusCallbackConfig, callbackToken: string): string {
  return `${config.baseUrl}?callbackToken=${callbackToken}${config.retryFragment}`;
}

export async function reserveScheduledCheckIn(
  database: Pick<Pool, 'connect'>,
  input: ScheduledDoseClaimInput,
  body: string,
): Promise<ClaimedCheckInRow | null> {
  const client = await database.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const eligible = await client.query(
      `SELECT 1
         FROM patient p
         JOIN dose_schedule ds ON ds.patient_id = p.id
        WHERE p.id = $1
          AND ds.id = $2
          AND p.is_active = true
          AND p.agent_enabled = true
          AND p.provider_opted_in = true
        FOR UPDATE OF p, ds`,
      [input.patientId, input.doseId],
    );
    if ((eligible.rowCount ?? 0) !== 1) {
      await client.query('COMMIT');
      transactionOpen = false;
      return null;
    }

    const correlation = newCallbackCorrelation();
    const reservation = await client.query<{ id: string }>(
      `INSERT INTO outbound_message
         (patient_id, dose_id, status, body, message_kind, callback_token_hash)
       VALUES ($1, $2, 'sending', $3, 'check_in', $4)
       ON CONFLICT (dose_id)
         WHERE dose_id IS NOT NULL AND message_kind = 'check_in'
       DO NOTHING
       RETURNING id`,
      [input.patientId, input.doseId, body, correlation.hash],
    );
    await client.query('COMMIT');
    transactionOpen = false;
    const row = reservation.rows[0];
    return row ? { id: row.id, callbackToken: correlation.token } : null;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original database error; pg.Pool discards a broken client.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

function isDefinitiveProviderRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 500;
}

function providerErrorCode(error: unknown): number | string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' || typeof code === 'string' ? code : undefined;
}

function providerErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/** Re-check consent, commit the durable send start, then call the provider with no database lock. */
export async function sendClaimedOutboundUnderConsent(
  database: Pick<Pool, 'connect'>,
  input: SendClaimInput,
  providerCreate: ProviderCreate,
): Promise<SendClaimResult> {
  const callbackUrl = statusCallbackUrl(input.callbackConfig, input.callbackToken);
  const tokenHash = createHash('sha256').update(input.callbackToken).digest();
  const client = await database.connect();
  let transactionOpen = false;
  let phone: string | undefined;
  let sendStartedAt: Date | undefined;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const patientResult = await client.query<{
      phone: string;
      is_active: boolean;
      agent_enabled: boolean;
      provider_opted_in: boolean;
      messaging_state_version: number;
    }>(
      `SELECT p.phone, p.is_active, p.agent_enabled, p.provider_opted_in,
              p.messaging_state_version
         FROM patient p
        WHERE p.id = $1
        FOR UPDATE OF p`,
      [input.patientId],
    );
    const patient = patientResult.rows[0];

    // Global lock order is patient -> outbound everywhere in this module.
    const outboundResult = await client.query<{ status: string }>(
      `SELECT om.status
         FROM outbound_message om
        WHERE om.id = $1
          AND om.patient_id = $2
          AND om.callback_token_hash = $3
        FOR UPDATE OF om`,
      [input.outboundMessageId, input.patientId, tokenHash],
    );
    const outbound = outboundResult.rows[0];
    if (!outbound || outbound.status !== 'sending') {
      await client.query('COMMIT');
      transactionOpen = false;
      return { sent: false, reason: 'already-reserved' };
    }

    const unavailableReason =
      !patient || !patient.is_active
        ? 'patient-inactive'
        : input.expectedMessagingStateVersion !== null &&
            patient.messaging_state_version !== input.expectedMessagingStateVersion
          ? 'messaging-state-changed'
          : !patient.agent_enabled || !patient.provider_opted_in
            ? 'messaging-disabled'
            : null;
    if (unavailableReason) {
      await client.query(
        `UPDATE outbound_message
            SET status = 'failed', status_updated_at = now()
          WHERE id = $1 AND status = 'sending'`,
        [input.outboundMessageId],
      );
      await client.query('COMMIT');
      transactionOpen = false;
      return { sent: false, reason: unavailableReason };
    }
    if (!patient) throw new Error('patient disappeared while send claim was locked');

    const started = await client.query<{ send_started_at: Date }>(
      `UPDATE outbound_message
          SET status_updated_at = now()
        WHERE id = $1 AND status = 'sending'
      RETURNING status_updated_at AS send_started_at`,
      [input.outboundMessageId],
    );
    sendStartedAt = started.rows[0]?.send_started_at;
    if (!sendStartedAt) throw new Error('send claim disappeared before provider call');
    phone = patient.phone;
    await client.query('COMMIT');
    transactionOpen = false;
  } catch (error: unknown) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original failure; a broken pg client is discarded by the pool.
      }
    }
    throw error;
  } finally {
    client.release();
  }

  if (phone === undefined || sendStartedAt === undefined)
    throw new Error('send claim disappeared before provider call');

  let acceptedSid: string;
  try {
    const message = await providerCreate({
      from: input.fromNumber,
      to: phone,
      body: input.body,
      statusCallback: callbackUrl,
    });
    if (!TWILIO_MESSAGE_SID_PATTERN.test(message.sid))
      throw new Error('provider returned an invalid message identifier');
    acceptedSid = message.sid;
  } catch (error: unknown) {
    const terminalStatus = isDefinitiveProviderRejection(error) ? 'failed' : 'sending_unknown';
    const failureClient = await database.connect();
    try {
      await failureClient.query(
        `UPDATE outbound_message
            SET status = $1,
                status_updated_at = CASE
                  WHEN $1 = 'sending_unknown' THEN COALESCE($3, status_updated_at)
                  ELSE now()
                END
          WHERE id = $2 AND status = 'sending'`,
        [terminalStatus, input.outboundMessageId, sendStartedAt],
      );
    } finally {
      failureClient.release();
    }
    // A definitive 4xx rejection is terminal (row already 'failed'; a redelivery can never succeed),
    // while an ambiguous failure stays 'sending_unknown' so the retry/callback path can reconcile it.
    throw new ClaimedSendError(
      terminalStatus === 'failed' ? 'provider-failed' : 'status-unknown',
      providerErrorCode(error),
      providerErrorStatus(error),
    );
  }

  try {
    const finalClient = await database.connect();
    try {
      const recorded = await finalClient.query<{ sent_at: Date }>(
        `UPDATE outbound_message
            SET twilio_sid = COALESCE(twilio_sid, $1),
                status = CASE
                  WHEN status IN ('sending', 'sending_unknown') THEN 'queued'
                  ELSE status
                END,
                sent_at = COALESCE(sent_at, $3),
                status_updated_at = CASE
                  WHEN status IN ('sending', 'sending_unknown') THEN now()
                  ELSE status_updated_at
                END
          WHERE id = $2
            AND status IN
                ('sending', 'sending_unknown', 'queued', 'sent', 'delivered', 'undelivered', 'failed')
            AND (twilio_sid IS NULL OR twilio_sid = $1)
        RETURNING sent_at`,
        [acceptedSid, input.outboundMessageId, sendStartedAt],
      );
      const sentAt = recorded.rows[0]?.sent_at;
      if (!sentAt) throw new Error('post-send UPDATE returned no sent_at');
      return { sent: true, sid: acceptedSid, sentAt };
    } finally {
      finalClient.release();
    }
  } catch {
    // The durable token hash was committed with the claim before the provider call. This guarded
    // fallback is best-effort only; even if it fails, the authenticated callback can bind the SID.
    try {
      const fallback = await database.connect();
      try {
        await fallback.query(
          `UPDATE outbound_message
              SET twilio_sid = $1,
                  status = 'sending_unknown',
                  sent_at = COALESCE(sent_at, $3),
                  status_updated_at = now()
            WHERE id = $2 AND status = 'sending'`,
          [acceptedSid, input.outboundMessageId, sendStartedAt],
        );
      } finally {
        fallback.release();
      }
    } catch {
      // Callback correlation remains available through callback_token_hash.
    }
    throw new ClaimedSendError('status-unknown');
  }
}

export async function reserveReminderSend(
  database: Pick<Pool, 'connect'>,
  input: ReminderClaimInput,
  body: string,
): Promise<ClaimedReminderRow | null> {
  const prepared = await prepareReminderSend(database, input, body);
  return prepared ? claimPreparedReminderSend(database, input) : null;
}

/** Persist the exact Scheduler-fired attempt before provider setup or any turn-dependent decision. */
export async function prepareReminderSend(
  database: Pick<Pool, 'connect'>,
  input: ReminderClaimInput,
  body: string,
): Promise<boolean> {
  const client = await database.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const dose = await client.query(
      `SELECT 1
         FROM patient p
         JOIN dose_schedule ds ON ds.patient_id = p.id
        WHERE p.id = $1 AND ds.id = $2
        FOR UPDATE OF p, ds`,
      [input.patientId, input.doseId],
    );
    if ((dose.rowCount ?? 0) !== 1) {
      await client.query('COMMIT');
      transactionOpen = false;
      return false;
    }
    const inserted = await client.query<{ status: string }>(
      `INSERT INTO outbound_message
         (patient_id, dose_id, status, body, message_kind, reminder_attempt)
       SELECT p.id, ds.id, 'prepared', $4, 'reminder', $3
         FROM patient p
         JOIN dose_schedule ds ON ds.patient_id = p.id
         JOIN outbound_message ci
           ON ci.patient_id = p.id
          AND ci.dose_id = ds.id
          AND ci.message_kind = 'check_in'
        WHERE p.id = $1
          AND ds.id = $2
          AND ci.sent_at IS NOT NULL
          AND ci.twilio_sid IS NOT NULL
          AND ci.status IN ('sending', 'sending_unknown', 'queued', 'sent', 'delivered')
       ON CONFLICT (dose_id, reminder_attempt)
         WHERE dose_id IS NOT NULL AND message_kind = 'reminder'
       DO NOTHING
       RETURNING status`,
      [input.patientId, input.doseId, input.reminderAttempt, body],
    );
    let status = inserted.rows[0]?.status;
    if (status === undefined) {
      const existing = await client.query<{ status: string }>(
        `SELECT status
           FROM outbound_message
          WHERE patient_id = $1
            AND dose_id = $2
            AND message_kind = 'reminder'
            AND reminder_attempt = $3`,
        [input.patientId, input.doseId, input.reminderAttempt],
      );
      status = existing.rows[0]?.status;
    }
    await client.query('COMMIT');
    transactionOpen = false;
    return status === 'prepared';
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original database error; a broken client is discarded by pg.Pool.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Atomically advance only the prepared row, preserving it only while a patient turn is incomplete. */
export async function claimPreparedReminderSend(
  database: Pick<Pool, 'connect'>,
  input: ReminderClaimInput,
): Promise<ClaimedReminderRow | null> {
  // Validated BEFORE any row is touched: this window feeds a branch that permanently fails
  // rows, so a malformed override throws loudly (response_window_minutes_invalid) instead of
  // silently zeroing the window — the same accessor the timeout/adherence path reads.
  const responseWindowMinutes = doseResponseWindowMinutes();
  const client = await database.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const locked = await client.query<{
      phone: string;
      sent_at: Date | null;
      is_active: boolean;
      agent_enabled: boolean;
      provider_opted_in: boolean;
      reminder_limit: number;
      check_in_status: string;
      twilio_sid: string | null;
      current_reminder_attempt: number | null;
      recently_engaged: boolean;
    }>(
      `SELECT p.phone, p.is_active, p.agent_enabled, p.provider_opted_in, p.reminder_limit,
              ci.sent_at, ci.status AS check_in_status, ci.twilio_sid,
              (
                SELECT max(r.reminder_attempt)::int
                  FROM outbound_message r
                 WHERE r.patient_id = p.id
                   AND r.dose_id = ds.id
                   AND r.message_kind = 'reminder'
                   AND r.status = 'prepared'
              ) AS current_reminder_attempt,
              (
                -- Lane Q: ANY inbound reply (any dose, even unclassified) in the last N
                -- minutes — a broader presence signal than the dose-keyed answered guards below.
                -- Correlated to THIS check-in (ir.received_at > ci.sent_at) like every other
                -- guard in this function: a message the patient sent BEFORE being prompted is
                -- not engagement with the prompt, and must never suppress its nudge.
                -- Scoped to a COMPLETE (or turn_job-less) reply only: a reply whose turn is
                -- still incomplete is already governed by the H-04 hold guard further down
                -- (leaves the attempt 'prepared' for re-evaluation once that turn finishes,
                -- rather than terminalizing it here before the outcome is even known).
                SELECT EXISTS (
                  SELECT 1
                    FROM inbound_reply ir
                    LEFT JOIN turn_job tj ON tj.inbound_message_id = ir.id
                   WHERE ir.patient_id = p.id
                     AND ir.received_at > now() - make_interval(mins => $3)
                     AND ir.received_at > ci.sent_at
                     AND (tj.completed_at IS NOT NULL OR tj.id IS NULL)
                )
              ) AS recently_engaged
         FROM patient p
         JOIN dose_schedule ds ON ds.patient_id = p.id
         JOIN outbound_message ci
           ON ci.patient_id = p.id
          AND ci.dose_id = ds.id
          AND ci.message_kind = 'check_in'
        WHERE p.id = $1 AND ds.id = $2
        FOR UPDATE OF p, ds, ci`,
      [input.patientId, input.doseId, RECENT_INBOUND_REPLY_SUPPRESSION_MINUTES],
    );
    const state = locked.rows[0];
    if (!state || state.current_reminder_attempt === null) {
      await client.query('COMMIT');
      transactionOpen = false;
      return null;
    }
    const currentAttempt = state.current_reminder_attempt;

    // Wave 2: a check-in outside its response window can never be legitimately reminded again.
    // Failing every prepared attempt <= current drains rows a never-completed turn was holding,
    // so a turn-commit failure means "held then reaped" instead of a late duplicate nudge.
    const responseWindowMs = responseWindowMinutes * 60_000;
    const checkInExpired =
      state.sent_at !== null && Date.now() - state.sent_at.getTime() > responseWindowMs;
    const checkInCanBeReminded =
      state.sent_at !== null &&
      state.twilio_sid !== null &&
      !checkInExpired &&
      ['sending', 'sending_unknown', 'queued', 'sent', 'delivered'].includes(state.check_in_status);
    const patientCanBeReminded =
      state.is_active &&
      state.agent_enabled &&
      state.provider_opted_in &&
      state.reminder_limit >= currentAttempt;
    if (!checkInCanBeReminded || !patientCanBeReminded || state.recently_engaged) {
      const reaped = await client.query(
        `UPDATE outbound_message
            SET status = 'failed', status_updated_at = now()
          WHERE patient_id = $1
            AND dose_id = $2
            AND message_kind = 'reminder'
            AND reminder_attempt <= $3
            AND status = 'prepared'`,
        [input.patientId, input.doseId, currentAttempt],
      );
      await client.query('COMMIT');
      transactionOpen = false;
      if (checkInExpired && (reaped.rowCount ?? 0) > 0) {
        // Identifier-free visibility for silent non-nudging: attempts held past the window.
        logMetric({
          metric: 'reminder_held_then_reaped',
          reapedCount: reaped.rowCount,
          reminderAttempt: currentAttempt,
        });
      }
      if (state.recently_engaged && (reaped.rowCount ?? 0) > 0) {
        // Identifier-free visibility (Lane Q): the reminder was suppressed, not silently retried.
        logMetric({
          metric: 'reminder_suppressed_recent_inbound',
          reapedCount: reaped.rowCount,
          reminderAttempt: currentAttempt,
        });
      }
      return null;
    }

    // This second statement gets a fresh READ COMMITTED snapshot after the patient lock. Inbound
    // intake takes the same patient lock before inserting a reply, so a racing reply commits before
    // these absence checks and suppresses the reminder.
    const correlation = newCallbackCorrelation();
    const claimed = await client.query<{ id: string; body: string }>(
      `UPDATE outbound_message om
          SET status = 'sending',
              callback_token_hash = $5,
              status_updated_at = now()
        WHERE om.patient_id = $1
          AND om.dose_id = $2
          AND om.message_kind = 'reminder'
          AND om.reminder_attempt = $3
          AND om.status = 'prepared'
          AND NOT EXISTS (
                SELECT 1 FROM inbound_reply
                 WHERE patient_id = $1 AND dose_id = $2
              )
          AND NOT EXISTS (
                SELECT 1 FROM adherence_record
                 WHERE patient_id = $1 AND dose_id = $2
              )
          AND NOT EXISTS (
                SELECT 1 FROM clinical_event
                 WHERE patient_id = $1 AND dose_id = $2
              )
          AND NOT EXISTS (
                -- Wave 2: inbound_reply.dose_id is stamped with ANSWERED semantics by the
                -- turn-commit transaction (only when that turn resolved an administration
                -- for a dose). An answered reply AFTER this check-in suppresses this nudge
                -- ONLY when the answered dose was itself prompted in the live response
                -- window (its own check-in went out within the window before the reply):
                -- an answer about a backdated/stale dose must never kill a live check-in's
                -- reminder. RECORDED RESIDUAL (accepted): with N same-window medications,
                -- answering ONE terminalizes the nudges for the other N-1.
                SELECT 1
                  FROM inbound_reply answered
                 WHERE answered.patient_id = $1
                   AND answered.dose_id IS NOT NULL
                   AND answered.received_at > $4
                   AND EXISTS (
                         SELECT 1
                           FROM outbound_message ci2
                          WHERE ci2.patient_id = $1
                            AND ci2.message_kind = 'check_in'
                            AND ci2.dose_id = answered.dose_id
                            AND ci2.sent_at IS NOT NULL
                            AND ci2.sent_at <= answered.received_at
                            AND ci2.sent_at > answered.received_at - make_interval(mins => $6)
                       )
              )
          AND NOT EXISTS (
                -- H-04: a Phase-8 inbound is NOT dose-linked when it arrives, so the three dose-keyed
                -- checks above are blind to a reply that is stored but not yet classified. Stand down
                -- while any same-patient inbound received AFTER this check-in still has an incomplete
                -- turn (turn_job.completed_at IS NULL) — the attempt is held, not consumed, and the
                -- worker re-evaluates it the moment that turn completes.
                SELECT 1
                  FROM inbound_reply ir
                  JOIN turn_job tj ON tj.inbound_message_id = ir.id
                 WHERE ir.patient_id = $1
                   AND ir.received_at > $4
                   AND tj.completed_at IS NULL
              )
      RETURNING om.id, om.body`,
      [
        input.patientId,
        input.doseId,
        currentAttempt,
        state.sent_at,
        correlation.hash,
        responseWindowMinutes,
      ],
    );
    const row = claimed.rows[0];
    if (row) {
      await client.query(
        `UPDATE outbound_message
            SET status = 'failed', status_updated_at = now()
          WHERE patient_id = $1
            AND dose_id = $2
            AND message_kind = 'reminder'
            AND reminder_attempt < $3
            AND status = 'prepared'`,
        [input.patientId, input.doseId, currentAttempt],
      );
    } else {
      // Completed answers are terminal. Only an incomplete turn may leave the current prepared set untouched.
      const drained = await client.query(
        `UPDATE outbound_message om
            SET status = 'failed', status_updated_at = now()
          WHERE om.patient_id = $1
            AND om.dose_id = $2
            AND om.message_kind = 'reminder'
            AND om.reminder_attempt <= $3
            AND om.status = 'prepared'
            AND (
              EXISTS (SELECT 1 FROM inbound_reply WHERE patient_id = $1 AND dose_id = $2)
              OR EXISTS (SELECT 1 FROM adherence_record WHERE patient_id = $1 AND dose_id = $2)
              OR EXISTS (SELECT 1 FROM clinical_event WHERE patient_id = $1 AND dose_id = $2)
              OR EXISTS (
                   -- Wave 2: an answered inbound after this check-in is a completed answer
                   -- for the whole prompt window — terminal for this dose's attempts too —
                   -- but ONLY when the answered dose was itself prompted in the live window
                   -- (mirrors the claim-side answered guard above).
                   SELECT 1 FROM inbound_reply answered
                    WHERE answered.patient_id = $1
                      AND answered.dose_id IS NOT NULL
                      AND answered.received_at > $4
                      AND EXISTS (
                            SELECT 1 FROM outbound_message ci2
                             WHERE ci2.patient_id = $1
                               AND ci2.message_kind = 'check_in'
                               AND ci2.dose_id = answered.dose_id
                               AND ci2.sent_at IS NOT NULL
                               AND ci2.sent_at <= answered.received_at
                               AND ci2.sent_at > answered.received_at - make_interval(mins => $5)
                          )
                 )
            )`,
        [input.patientId, input.doseId, currentAttempt, state.sent_at, responseWindowMinutes],
      );
      if ((drained.rowCount ?? 0) === 0) {
        // Nothing terminal fired, so the H-04 incomplete-turn hold left the prepared set
        // untouched. Identifier-free visibility: if the holding turn never completes, no
        // caller arrives after window expiry to reap, so this held line is the only signal
        // that a reminder is being silently withheld.
        logMetric({ metric: 'reminder_attempt_held', reminderAttempt: currentAttempt });
      }
    }
    await client.query('COMMIT');
    transactionOpen = false;
    return row ? { ...row, phone: state.phone, callbackToken: correlation.token } : null;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original database error; a broken client is discarded by pg.Pool.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Claim one prepared agent reply while serializing with STOP.
 *
 * Every writer that changes messaging permission takes the patient row lock. Locking the patient
 * first, then the unique agent-turn outbound row, preserves that global order and makes the following
 * READ COMMITTED patient read observe a STOP that committed while this claimant was waiting.
 */
export async function claimPreparedAgentSend(
  database: Pick<Pool, 'connect'>,
  input: AgentSendClaimInput,
): Promise<AgentClaimResult> {
  const client = await database.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const patientLock = await client.query(
      `SELECT p.id
         FROM patient p
        WHERE p.id = $1
        FOR UPDATE OF p`,
      [input.patientId],
    );
    if ((patientLock.rowCount ?? 0) !== 1) {
      await client.query('COMMIT');
      transactionOpen = false;
      return { claimed: null, reason: 'already-reserved' };
    }

    const outboundLock = await client.query<{
      id: string;
      status: string;
      messaging_consent_epoch: number | null;
    }>(
      `SELECT om.id, om.status, om.messaging_consent_epoch
         FROM outbound_message om
        WHERE om.patient_id = $1
          AND om.agent_turn_id = $2
        FOR UPDATE OF om`,
      [input.patientId, input.agentTurnId],
    );
    const outbound = outboundLock.rows[0];
    if (!outbound || outbound.status !== 'prepared') {
      await client.query('COMMIT');
      transactionOpen = false;
      return { claimed: null, reason: 'already-reserved' };
    }

    // This separate statement gets a fresh READ COMMITTED snapshot after any STOP lock wait.
    const currentPatient = await client.query<{
      phone: string;
      is_active: boolean;
      agent_enabled: boolean;
      provider_opted_in: boolean;
      messaging_state_version: number;
    }>(
      `SELECT phone, is_active, agent_enabled, provider_opted_in, messaging_state_version
         FROM patient
        WHERE id = $1`,
      [input.patientId],
    );
    const patient = currentPatient.rows[0];
    if (!patient) {
      await client.query('COMMIT');
      transactionOpen = false;
      return { claimed: null, reason: 'already-reserved' };
    }

    const storedEpochMatches =
      outbound.messaging_consent_epoch !== null &&
      outbound.messaging_consent_epoch === input.expectedMessagingStateVersion &&
      outbound.messaging_consent_epoch === patient.messaging_state_version;
    const unavailableReason: AgentClaimFailureReason | null = !patient.is_active
      ? 'patient-inactive'
      : !storedEpochMatches
        ? 'messaging-state-changed'
        : !patient.agent_enabled || !patient.provider_opted_in
          ? 'messaging-disabled'
          : null;
    if (unavailableReason !== null) {
      await client.query(
        `UPDATE outbound_message
            SET status = 'failed', status_updated_at = now()
          WHERE id = $1 AND status = 'prepared'`,
        [outbound.id],
      );
      await client.query('COMMIT');
      transactionOpen = false;
      return { claimed: null, reason: unavailableReason };
    }
    if (outbound.messaging_consent_epoch === null)
      throw new Error('prepared_agent_consent_epoch_missing');

    const correlation = newCallbackCorrelation();
    const claim = await client.query<{
      id: string;
      body: string | null;
      composed_body?: string | null;
      composition?: unknown;
      message_kind: string;
    }>(
      `UPDATE outbound_message
          SET status = 'sending', callback_token_hash = $2, status_updated_at = now()
        WHERE id = $1 AND status = 'prepared'
      RETURNING id, body, composed_body, composition, message_kind`,
      [outbound.id, correlation.hash],
    );
    const row = claim.rows[0];
    await client.query('COMMIT');
    transactionOpen = false;
    return row
      ? {
          claimed: {
            id: row.id,
            body: row.body,
            composedBody: row.composed_body ?? null,
            composition: row.composition ?? null,
            messageKind: row.message_kind,
            phone: patient.phone,
            callbackToken: correlation.token,
            expectedMessagingStateVersion: outbound.messaging_consent_epoch,
          },
          reason: null,
        }
      : { claimed: null, reason: 'already-reserved' };
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original database error; a broken client is discarded by pg.Pool.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Terminalizes a stale prepared reply under the same patient -> outbound lock order as claiming. */
export async function terminalizePreparedAgentSend(
  database: Pick<Pool, 'connect'>,
  input: PreparedAgentTerminalizationInput,
): Promise<boolean> {
  const client = await database.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const patient = await client.query(`SELECT id FROM patient WHERE id = $1 FOR UPDATE`, [
      input.patientId,
    ]);
    if ((patient.rowCount ?? 0) !== 1) {
      await client.query('COMMIT');
      transactionOpen = false;
      return false;
    }
    const outbound = await client.query<{ status: string }>(
      `SELECT status
         FROM outbound_message
        WHERE id = $1 AND patient_id = $2 AND agent_turn_id = $3
        FOR UPDATE`,
      [input.outboundMessageId, input.patientId, input.agentTurnId],
    );
    if (outbound.rows[0]?.status !== 'prepared') {
      await client.query('COMMIT');
      transactionOpen = false;
      return false;
    }
    const terminalized = await client.query(
      `UPDATE outbound_message
          SET status = 'failed',
              status_updated_at = now(),
              suppressed_by_newer_inbound = suppressed_by_newer_inbound OR $2
        WHERE id = $1 AND status = 'prepared'`,
      [input.outboundMessageId, input.supersededByNewerInbound === true],
    );
    await client.query('COMMIT');
    transactionOpen = false;
    return (terminalized.rowCount ?? 0) === 1;
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
