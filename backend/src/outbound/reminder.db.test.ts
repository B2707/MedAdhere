import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { findDeferredReminders } from '../conversation/queue-worker.js';
import {
  claimPreparedAgentSend,
  reserveReminderSend,
  reserveScheduledCheckIn,
  sendClaimedOutboundUnderConsent,
} from './handler.js';
import { terminalizePreparedAgentSend } from './send-repository.js';

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema-init', 'schema.sql'), 'utf8');
const CONTAINER_TIMEOUT_MS = 180_000;
const OWNER_SUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REMINDER_BODY = 'Just a gentle reminder to reply when you can about your medication.';

let container: StartedPostgreSqlContainer | undefined;
let pool: Pool;
let phoneCounter = 0;

async function applySchema(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(SCHEMA_SQL);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedDose(
  options: {
    readonly active?: boolean;
    readonly agentEnabled?: boolean;
    readonly providerOptedIn?: boolean;
    readonly reminderLimit?: number;
  } = {},
): Promise<{ readonly patientId: string; readonly doseId: string }> {
  phoneCounter += 1;
  const patient = await pool.query<{ id: string }>(
    `INSERT INTO patient
       (phone, medication_name, owner_clinician_sub, is_active, agent_enabled,
        provider_opted_in, reminder_limit)
     VALUES ($1, 'reminder test medication', $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      `+1500888${String(phoneCounter).padStart(4, '0')}`,
      OWNER_SUB,
      options.active ?? true,
      options.agentEnabled ?? true,
      options.providerOptedIn ?? true,
      options.reminderLimit ?? 2,
    ],
  );
  const patientId = patient.rows[0]!.id;
  const dose = await pool.query<{ id: string }>(
    `INSERT INTO dose_schedule (patient_id, scheduled_at, local_dose_time)
     VALUES ($1, now(), '09:00')
     RETURNING id`,
    [patientId],
  );
  return { patientId, doseId: dose.rows[0]!.id };
}

async function seedSentCheckIn(dose: {
  readonly patientId: string;
  readonly doseId: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO outbound_message
       (patient_id, dose_id, status, body, message_kind, twilio_sid, sent_at)
     VALUES ($1, $2, 'queued', 'Initial medication check-in', 'check_in', $3, now())`,
    [dose.patientId, dose.doseId, `SM${randomUUID().replaceAll('-', '')}`],
  );
}

async function seedPendingTurn(
  patientId: string,
): Promise<{ readonly inboundId: string; readonly turnJobId: string }> {
  const inbound = await pool.query<{ id: string }>(
    `INSERT INTO inbound_reply (patient_id, raw_body, inbound_sequence, received_at)
     VALUES ($1, 'I am replying to the check-in', 1, now() + interval '1 second')
     RETURNING id::text`,
    [patientId],
  );
  const turnJob = await pool.query<{ id: string }>(
    `INSERT INTO turn_job (patient_id, inbound_message_id, inbound_sequence)
     VALUES ($1, $2, 1)
     RETURNING id::text`,
    [patientId, inbound.rows[0]!.id],
  );
  return { inboundId: inbound.rows[0]!.id, turnJobId: turnJob.rows[0]!.id };
}

async function seedPreparedAgentSend(
  patientId: string,
): Promise<{ readonly agentTurnId: string; readonly outboundId: string }> {
  const { inboundId, turnJobId } = await seedPendingTurn(patientId);
  const agentTurn = await pool.query<{ id: string }>(
    `INSERT INTO agent_turn
       (patient_id, inbound_message_id, turn_job_id, model_id, prompt_version, schema_version,
        context_hash, input_tokens, output_tokens, latency_ms, final_policy_tier)
     VALUES ($1, $2, $3, 'test-model', 'test-prompt', 'test-schema', $4, 1, 1, 1, 'routine')
     RETURNING id::text`,
    [patientId, inboundId, turnJobId, 'b'.repeat(64)],
  );
  const agentTurnId = agentTurn.rows[0]!.id;
  const outbound = await pool.query<{ id: string }>(
    `INSERT INTO outbound_message
       (patient_id, status, body, message_kind, in_reply_to_inbound_id, agent_turn_id, language,
        messaging_consent_epoch)
     VALUES ($1, 'prepared', 'Stored agent reply', 'acknowledgement', $2, $3, 'en', 1)
     RETURNING id::text`,
    [patientId, inboundId, agentTurnId],
  );
  return { agentTurnId, outboundId: outbound.rows[0]!.id };
}

beforeAll(async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl) {
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
  } else {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 8 });
  }
  await applySchema();
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('reserveReminderSend against PostgreSQL 16', () => {
  it('waits for the patient lock before terminalizing one stale prepared agent row', async () => {
    const dose = await seedDose();
    const prepared = await seedPreparedAgentSend(dose.patientId);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM patient WHERE id = $1 FOR UPDATE', [dose.patientId]);

      let settled = false;
      const pending = terminalizePreparedAgentSend(pool, {
        patientId: dose.patientId,
        agentTurnId: prepared.agentTurnId,
        outboundMessageId: prepared.outboundId,
      }).finally(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      await blocker.query('COMMIT');

      await expect(pending).resolves.toBe(true);
      const stored = await pool.query<{ status: string }>(
        'SELECT status FROM outbound_message WHERE id = $1',
        [prepared.outboundId],
      );
      expect(stored.rows).toEqual([{ status: 'failed' }]);
    } finally {
      try {
        await blocker.query('ROLLBACK');
      } catch {
        // COMMIT already closed the expected transaction.
      }
      blocker.release();
    }
  });

  it('waits for an in-flight STOP, then terminalizes the prepared agent send without claiming it', async () => {
    const dose = await seedDose();
    const prepared = await seedPreparedAgentSend(dose.patientId);
    const stop = await pool.connect();
    try {
      await stop.query('BEGIN');
      await stop.query('SELECT id FROM patient WHERE id = $1 FOR UPDATE', [dose.patientId]);
      await stop.query(
        `UPDATE patient
            SET provider_opted_in = false, agent_enabled = false,
                messaging_state_version = messaging_state_version + 1
          WHERE id = $1`,
        [dose.patientId],
      );

      let claimSettled = false;
      const pendingClaim = claimPreparedAgentSend(pool, {
        patientId: dose.patientId,
        agentTurnId: prepared.agentTurnId,
        expectedMessagingStateVersion: 1,
      }).finally(() => {
        claimSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(claimSettled).toBe(false);
      await stop.query('COMMIT');

      await expect(pendingClaim).resolves.toEqual({
        claimed: null,
        reason: 'messaging-state-changed',
      });
      const stored = await pool.query<{ status: string }>(
        'SELECT status FROM outbound_message WHERE id = $1',
        [prepared.outboundId],
      );
      expect(stored.rows).toEqual([{ status: 'failed' }]);
    } finally {
      try {
        await stop.query('ROLLBACK');
      } catch {
        // COMMIT already closed the transaction on the expected path.
      }
      stop.release();
    }
  });

  it('rejects a stale prepared agent epoch after STOP and START restore the current state', async () => {
    const dose = await seedDose();
    const prepared = await seedPreparedAgentSend(dose.patientId);
    await pool.query(
      `UPDATE patient
          SET provider_opted_in = true,
              agent_enabled = true,
              messaging_state_version = 3
        WHERE id = $1`,
      [dose.patientId],
    );

    await expect(
      claimPreparedAgentSend(pool, {
        patientId: dose.patientId,
        agentTurnId: prepared.agentTurnId,
        expectedMessagingStateVersion: 3,
      }),
    ).resolves.toEqual({ claimed: null, reason: 'messaging-state-changed' });
    const stored = await pool.query<{ status: string }>(
      'SELECT status FROM outbound_message WHERE id = $1',
      [prepared.outboundId],
    );
    expect(stored.rows).toEqual([{ status: 'failed' }]);
  });

  it('does not invent a reminder when the turn completes before Scheduler records the due attempt', async () => {
    const dose = await seedDose();
    await seedSentCheckIn(dose);
    const { turnJobId } = await seedPendingTurn(dose.patientId);
    await pool.query('UPDATE turn_job SET completed_at = now() WHERE id = $1', [turnJobId]);

    await expect(findDeferredReminders(pool, dose.patientId)).resolves.toEqual([]);
    const reminders = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM outbound_message
        WHERE patient_id = $1 AND message_kind = 'reminder'`,
      [dose.patientId],
    );
    expect(reminders.rows[0]?.count).toBe('0');
  });

  it('stores the real Scheduler attempt as prepared while a turn is incomplete, then (2026-08-17, Lane Q) suppresses it once the turn completes — the completing reply is itself fresh', async () => {
    const dose = await seedDose();
    await seedSentCheckIn(dose);
    const { turnJobId } = await seedPendingTurn(dose.patientId);

    await expect(
      reserveReminderSend(pool, { ...dose, reminderAttempt: 1 }, REMINDER_BODY),
    ).resolves.toBeNull();
    const held = await pool.query<{ id: string; status: string; reminder_attempt: number }>(
      `SELECT id::text, status, reminder_attempt
         FROM outbound_message
        WHERE patient_id = $1 AND dose_id = $2 AND message_kind = 'reminder'`,
      [dose.patientId, dose.doseId],
    );
    expect(held.rows).toEqual([
      expect.objectContaining({ status: 'prepared', reminder_attempt: 1 }),
    ]);

    await pool.query('UPDATE turn_job SET completed_at = now() WHERE id = $1', [turnJobId]);
    const [due] = await findDeferredReminders(pool, dose.patientId);
    expect(due).toEqual({ ...dose, reminderAttempt: 1 });

    // Lane Q: the H-04 hold clears (the turn completed), but the reply that just completed is
    // itself a fresh inbound — the any-recent-reply presence guard suppresses this attempt
    // entirely instead of releasing it to send. Concurrency safety still holds: neither
    // concurrent claim races into a send, and the row is never left stranded 'prepared'.
    const claims = await Promise.all([
      reserveReminderSend(pool, due!, REMINDER_BODY),
      reserveReminderSend(pool, due!, REMINDER_BODY),
    ]);
    expect(claims.every((claim) => claim === null)).toBe(true);
    await expect(reserveReminderSend(pool, due!, REMINDER_BODY)).resolves.toBeNull();

    const stored = await pool.query<{ id: string; status: string }>(
      `SELECT id::text, status
         FROM outbound_message
        WHERE patient_id = $1 AND dose_id = $2 AND message_kind = 'reminder'`,
      [dose.patientId, dose.doseId],
    );
    expect(stored.rows).toEqual([{ id: held.rows[0]?.id, status: 'failed' }]);
  });

  it('(2026-08-17, Lane Q) suppresses BOTH held attempts once the turn completes — the completing reply is itself fresh, not a release-to-send', async () => {
    const dose = await seedDose();
    await seedSentCheckIn(dose);
    const { turnJobId } = await seedPendingTurn(dose.patientId);

    await expect(
      reserveReminderSend(pool, { ...dose, reminderAttempt: 1 }, REMINDER_BODY),
    ).resolves.toBeNull();
    await expect(
      reserveReminderSend(pool, { ...dose, reminderAttempt: 2 }, REMINDER_BODY),
    ).resolves.toBeNull();
    const held = await pool.query<{ reminder_attempt: number; status: string }>(
      `SELECT reminder_attempt, status
         FROM outbound_message
        WHERE patient_id = $1 AND dose_id = $2 AND message_kind = 'reminder'
        ORDER BY reminder_attempt`,
      [dose.patientId, dose.doseId],
    );
    expect(held.rows).toEqual([
      { reminder_attempt: 1, status: 'prepared' },
      { reminder_attempt: 2, status: 'prepared' },
    ]);

    await pool.query('UPDATE turn_job SET completed_at = now() WHERE id = $1', [turnJobId]);
    const [due] = await findDeferredReminders(pool, dose.patientId);
    expect(due).toEqual({ ...dose, reminderAttempt: 2 });
    // Unlike the pre-Lane-Q behavior (release the newest attempt to send, terminalize only the
    // older sibling), the completing reply is itself fresh — the any-recent-reply presence
    // guard suppresses the whole prepared set instead.
    await expect(reserveReminderSend(pool, due!, REMINDER_BODY)).resolves.toBeNull();

    const released = await pool.query<{ reminder_attempt: number; status: string }>(
      `SELECT reminder_attempt, status
         FROM outbound_message
        WHERE patient_id = $1 AND dose_id = $2 AND message_kind = 'reminder'
        ORDER BY reminder_attempt`,
      [dose.patientId, dose.doseId],
    );
    expect(released.rows).toEqual([
      { reminder_attempt: 1, status: 'failed' },
      { reminder_attempt: 2, status: 'failed' },
    ]);
    await expect(reserveReminderSend(pool, due!, REMINDER_BODY)).resolves.toBeNull();
    await expect(findDeferredReminders(pool, dose.patientId)).resolves.toEqual([]);
  });

  it('(2026-08-17, Lane Q) suppresses the held attempt for each of two distinct doses once the turn completes — neither is stranded, neither sends', async () => {
    const firstDose = await seedDose();
    const secondDoseRow = await pool.query<{ id: string }>(
      `INSERT INTO dose_schedule (patient_id, scheduled_at, local_dose_time)
       VALUES ($1, now() + interval '1 minute', '10:00')
       RETURNING id`,
      [firstDose.patientId],
    );
    const secondDose = { patientId: firstDose.patientId, doseId: secondDoseRow.rows[0]!.id };
    await Promise.all([seedSentCheckIn(firstDose), seedSentCheckIn(secondDose)]);
    const { turnJobId } = await seedPendingTurn(firstDose.patientId);

    await expect(
      Promise.all([
        reserveReminderSend(pool, { ...firstDose, reminderAttempt: 1 }, REMINDER_BODY),
        reserveReminderSend(pool, { ...secondDose, reminderAttempt: 1 }, REMINDER_BODY),
      ]),
    ).resolves.toEqual([null, null]);
    await pool.query('UPDATE turn_job SET completed_at = now() WHERE id = $1', [turnJobId]);

    const due = await findDeferredReminders(pool, firstDose.patientId);
    expect(due).toEqual(
      expect.arrayContaining([
        { ...firstDose, reminderAttempt: 1 },
        { ...secondDose, reminderAttempt: 1 },
      ]),
    );
    expect(due).toHaveLength(2);
    // The any-recent-reply presence guard is patient-level, not dose-scoped — one completing
    // reply suppresses BOTH doses' reminders, terminal ('failed'), never stranded 'prepared'.
    const claims = await Promise.all(
      due.map((attempt) => reserveReminderSend(pool, attempt, REMINDER_BODY)),
    );
    expect(claims.every((claim) => claim === null)).toBe(true);

    await expect(findDeferredReminders(pool, firstDose.patientId)).resolves.toEqual([]);
    const statuses = await pool.query<{ dose_id: string; status: string }>(
      `SELECT dose_id::text, status
         FROM outbound_message
        WHERE patient_id = $1 AND message_kind = 'reminder'
        ORDER BY dose_id`,
      [firstDose.patientId],
    );
    expect(statuses.rows).toEqual([
      { dose_id: [firstDose.doseId, secondDose.doseId].sort()[0], status: 'failed' },
      { dose_id: [firstDose.doseId, secondDose.doseId].sort()[1], status: 'failed' },
    ]);
  });

  it('terminalizes held attempts that become answered, disabled, or over budget', async () => {
    const answered = await seedDose();
    const disabled = await seedDose();
    const overBudget = await seedDose();
    await Promise.all([answered, disabled, overBudget].map((dose) => seedSentCheckIn(dose)));
    const answeredTurn = await seedPendingTurn(answered.patientId);
    await seedPendingTurn(disabled.patientId);
    await seedPendingTurn(overBudget.patientId);

    for (const dose of [answered, disabled, overBudget]) {
      await expect(
        reserveReminderSend(pool, { ...dose, reminderAttempt: 1 }, REMINDER_BODY),
      ).resolves.toBeNull();
    }
    await Promise.all([
      pool.query('UPDATE inbound_reply SET dose_id = $1 WHERE id = $2', [
        answered.doseId,
        answeredTurn.inboundId,
      ]),
      pool.query('UPDATE turn_job SET completed_at = now() WHERE id = $1', [
        answeredTurn.turnJobId,
      ]),
      pool.query('UPDATE patient SET agent_enabled = false WHERE id = $1', [disabled.patientId]),
      pool.query('UPDATE patient SET reminder_limit = 0 WHERE id = $1', [overBudget.patientId]),
    ]);

    await expect(
      Promise.all(
        [answered, disabled, overBudget].map((dose) =>
          reserveReminderSend(pool, { ...dose, reminderAttempt: 1 }, REMINDER_BODY),
        ),
      ),
    ).resolves.toEqual([null, null, null]);
    const terminal = await pool.query<{ patient_id: string; status: string }>(
      `SELECT patient_id::text, status
         FROM outbound_message
        WHERE patient_id = ANY($1::uuid[])
          AND message_kind = 'reminder'
        ORDER BY patient_id`,
      [[answered.patientId, disabled.patientId, overBudget.patientId]],
    );
    expect(terminal.rows).toHaveLength(3);
    expect(terminal.rows.every(({ status }) => status === 'failed')).toBe(true);
  });

  it('allows exactly one claimant for a concurrent dose+attempt reservation', async () => {
    const dose = await seedDose();
    await seedSentCheckIn(dose);

    const claims = await Promise.all([
      reserveReminderSend(pool, { ...dose, reminderAttempt: 1 }, REMINDER_BODY),
      reserveReminderSend(pool, { ...dose, reminderAttempt: 1 }, REMINDER_BODY),
    ]);

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
    const stored = await pool.query<{
      message_kind: string;
      reminder_attempt: number;
      status: string;
      body: string;
    }>(
      `SELECT message_kind, reminder_attempt, status, body
         FROM outbound_message
        WHERE patient_id = $1 AND dose_id = $2`,
      [dose.patientId, dose.doseId],
    );
    expect(stored.rows).toEqual(
      expect.arrayContaining([
        {
          message_kind: 'reminder',
          reminder_attempt: 1,
          status: 'sending',
          body: REMINDER_BODY,
        },
      ]),
    );
  });

  it('fails closed for inactive/disabled/over-limit patients and for any linked reply or adherence', async () => {
    const inactive = await seedDose({ active: false });
    const disabled = await seedDose({ agentEnabled: false });
    const overLimit = await seedDose({ reminderLimit: 1 });
    const replied = await seedDose();
    const recorded = await seedDose();
    const withoutCheckIn = await seedDose();
    await Promise.all(
      [inactive, disabled, overLimit, replied, recorded].map((dose) => seedSentCheckIn(dose)),
    );
    await pool.query(
      `INSERT INTO inbound_reply (patient_id, dose_id, raw_body)
       VALUES ($1, $2, 'taken')`,
      [replied.patientId, replied.doseId],
    );
    await pool.query(
      `INSERT INTO adherence_record
         (patient_id, dose_id, adherence_state, reason_code, safety_flag, decided_by, status)
       VALUES ($1, $2, 'unknown', 'none', 'none', 'timeout', 'missed')`,
      [recorded.patientId, recorded.doseId],
    );

    const results = await Promise.all([
      reserveReminderSend(pool, { ...inactive, reminderAttempt: 1 }, REMINDER_BODY),
      reserveReminderSend(pool, { ...disabled, reminderAttempt: 1 }, REMINDER_BODY),
      reserveReminderSend(pool, { ...overLimit, reminderAttempt: 2 }, REMINDER_BODY),
      reserveReminderSend(pool, { ...replied, reminderAttempt: 1 }, REMINDER_BODY),
      reserveReminderSend(pool, { ...recorded, reminderAttempt: 1 }, REMINDER_BODY),
      reserveReminderSend(pool, { ...withoutCheckIn, reminderAttempt: 1 }, REMINDER_BODY),
    ]);
    expect(results).toEqual([null, null, null, null, null, null]);
  });

  it('terminalizes without sending when the Phase-8 conversation attributed a clinical event to the dose', async () => {
    const dose = await seedDose();
    await seedSentCheckIn(dose);
    const inbound = await pool.query<{ id: string }>(
      `INSERT INTO inbound_reply (patient_id, raw_body, inbound_sequence)
       VALUES ($1, 'I took it this morning', 1)
       RETURNING id::text`,
      [dose.patientId],
    );
    const turnJob = await pool.query<{ id: string }>(
      `INSERT INTO turn_job (patient_id, inbound_message_id, inbound_sequence)
       VALUES ($1, $2, 1)
       RETURNING id::text`,
      [dose.patientId, inbound.rows[0]!.id],
    );
    const agentTurn = await pool.query<{ id: string }>(
      `INSERT INTO agent_turn
         (patient_id, inbound_message_id, turn_job_id, model_id, prompt_version, schema_version,
          context_hash, input_tokens, output_tokens, latency_ms, final_policy_tier)
       VALUES ($1, $2, $3, 'test-model', 'test-prompt', 'test-schema', $4, 1, 1, 1, 'routine')
       RETURNING id::text`,
      [dose.patientId, inbound.rows[0]!.id, turnJob.rows[0]!.id, 'a'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO clinical_event
         (patient_id, agent_turn_id, source_inbound_id, event_type, event_code, statement_text,
          normalized_value, occurred_at, local_date, local_time, patient_timezone, dose_id)
       VALUES ($1, $2, $3, 'adherence', 'medication_taking', 'I took it this morning',
               'taken', now(), CURRENT_DATE, '08:00', 'America/Toronto', $4)`,
      [dose.patientId, agentTurn.rows[0]!.id, inbound.rows[0]!.id, dose.doseId],
    );

    await expect(
      reserveReminderSend(pool, { ...dose, reminderAttempt: 1 }, REMINDER_BODY),
    ).resolves.toBeNull();
    const reminders = await pool.query<{ status: string }>(
      `SELECT status
         FROM outbound_message
        WHERE patient_id = $1 AND dose_id = $2 AND message_kind = 'reminder'`,
      [dose.patientId, dose.doseId],
    );
    expect(reminders.rows).toEqual([{ status: 'failed' }]);
  });

  it('serializes behind inbound intake and rechecks the reply after acquiring the patient lock', async () => {
    const dose = await seedDose();
    await seedSentCheckIn(dose);
    const inbound = await pool.connect();
    try {
      await inbound.query('BEGIN');
      await inbound.query('SELECT id FROM patient WHERE id = $1 FOR UPDATE', [dose.patientId]);
      await inbound.query(
        `INSERT INTO inbound_reply (patient_id, dose_id, raw_body, twilio_message_sid)
         VALUES ($1, $2, 'already replied', $3)`,
        [dose.patientId, dose.doseId, `SM${randomUUID().replaceAll('-', '')}`],
      );

      const pendingClaim = reserveReminderSend(
        pool,
        { ...dose, reminderAttempt: 1 },
        REMINDER_BODY,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      await inbound.query('COMMIT');

      await expect(pendingClaim).resolves.toBeNull();
    } finally {
      try {
        await inbound.query('ROLLBACK');
      } catch {
        // COMMIT already closed the transaction on the expected path.
      }
      inbound.release();
    }
  });

  it('rolls back a rejected stored body without leaving a reservation or patient lock behind', async () => {
    const dose = await seedDose();
    await seedSentCheckIn(dose);

    await expect(
      reserveReminderSend(pool, { ...dose, reminderAttempt: 1 }, 'x'.repeat(321)),
    ).rejects.toThrow();
    const afterFailure = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM outbound_message
        WHERE patient_id = $1 AND dose_id = $2`,
      [dose.patientId, dose.doseId],
    );
    expect(afterFailure.rows[0]?.count).toBe('1');

    await expect(
      reserveReminderSend(pool, { ...dose, reminderAttempt: 1 }, REMINDER_BODY),
    ).resolves.toMatchObject({ body: REMINDER_BODY });
  });

  it('atomically reserves a check-in only while patient, provider, and agent messaging remain enabled', async () => {
    const allowed = await seedDose();
    await expect(
      reserveScheduledCheckIn(pool, allowed, 'Your medication check-in'),
    ).resolves.toMatchObject({
      id: expect.any(String),
      callbackToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    await expect(
      reserveScheduledCheckIn(pool, allowed, 'Your medication check-in'),
    ).resolves.toBeNull();

    const stopped = await seedDose();
    await pool.query(
      `UPDATE patient
          SET provider_opted_in = false, agent_enabled = false
        WHERE id = $1`,
      [stopped.patientId],
    );
    await expect(
      reserveScheduledCheckIn(pool, stopped, 'Your medication check-in'),
    ).resolves.toBeNull();
  });

  it('serializes a scheduled check-in claim behind STOP and rechecks messaging consent', async () => {
    const dose = await seedDose();
    const stop = await pool.connect();
    try {
      await stop.query('BEGIN');
      await stop.query('SELECT id FROM patient WHERE id = $1 FOR UPDATE', [dose.patientId]);
      await stop.query(
        `UPDATE patient
            SET provider_opted_in = false, agent_enabled = false
          WHERE id = $1`,
        [dose.patientId],
      );

      const pendingClaim = reserveScheduledCheckIn(pool, dose, 'Your medication check-in');
      await new Promise<void>((resolve) => setImmediate(resolve));
      await stop.query('COMMIT');

      await expect(pendingClaim).resolves.toBeNull();
      const stored = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM outbound_message
          WHERE patient_id = $1 AND dose_id = $2`,
        [dose.patientId, dose.doseId],
      );
      expect(stored.rows[0]?.count).toBe('0');
    } finally {
      try {
        await stop.query('ROLLBACK');
      } catch {
        // COMMIT already closed the expected transaction.
      }
      stop.release();
    }
  });

  it('rolls back a rejected check-in body so a corrected invocation can still reserve the dose', async () => {
    const dose = await seedDose();

    await expect(reserveScheduledCheckIn(pool, dose, 'x'.repeat(321))).rejects.toThrow();
    await expect(
      reserveScheduledCheckIn(pool, dose, 'Your medication check-in'),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('commits the durable claim, then waits for STOP and suppresses the provider call', async () => {
    const dose = await seedDose();
    const claim = await reserveScheduledCheckIn(pool, dose, 'Your medication check-in');
    expect(claim).not.toBeNull();
    const providerCreate = vi.fn();
    const stop = await pool.connect();
    try {
      await stop.query('BEGIN');
      await stop.query('SELECT id FROM patient WHERE id = $1 FOR UPDATE', [dose.patientId]);
      await stop.query(
        `UPDATE patient
            SET provider_opted_in = false, agent_enabled = false
          WHERE id = $1`,
        [dose.patientId],
      );

      let sendSettled = false;
      const pendingSend = sendClaimedOutboundUnderConsent(
        pool,
        {
          patientId: dose.patientId,
          outboundMessageId: claim!.id,
          callbackToken: claim!.callbackToken,
          callbackConfig: {
            baseUrl: 'https://example.test/twilio/status',
            retryFragment: '#rc=3&ct=1000&rt=5000&tt=15000&rp=ct,rt,5xx',
          },
          fromNumber: '+15005550006',
          body: 'Your medication check-in',
          expectedMessagingStateVersion: null,
        },
        providerCreate,
      ).finally(() => {
        sendSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(sendSettled).toBe(false);
      expect(providerCreate).not.toHaveBeenCalled();
      await stop.query('COMMIT');

      await expect(pendingSend).resolves.toEqual({ sent: false, reason: 'messaging-disabled' });
      expect(providerCreate).not.toHaveBeenCalled();
    } finally {
      try {
        await stop.query('ROLLBACK');
      } catch {
        // COMMIT already closed the expected transaction.
      }
      stop.release();
    }
  });

  it('waits for START, then suppresses a claimed agent send whose consent epoch is stale', async () => {
    const dose = await seedDose();
    const prepared = await seedPreparedAgentSend(dose.patientId);
    const claim = await claimPreparedAgentSend(pool, {
      patientId: dose.patientId,
      agentTurnId: prepared.agentTurnId,
      expectedMessagingStateVersion: 1,
    });
    expect(claim.claimed).not.toBeNull();
    const providerCreate = vi.fn();
    const start = await pool.connect();
    try {
      await start.query('BEGIN');
      await start.query('SELECT id FROM patient WHERE id = $1 FOR UPDATE', [dose.patientId]);
      await start.query(
        `UPDATE patient
            SET provider_opted_in = true,
                messaging_state_version = messaging_state_version + 1
          WHERE id = $1`,
        [dose.patientId],
      );

      let sendSettled = false;
      const pendingSend = sendClaimedOutboundUnderConsent(
        pool,
        {
          patientId: dose.patientId,
          outboundMessageId: claim.claimed!.id,
          callbackToken: claim.claimed!.callbackToken,
          callbackConfig: {
            baseUrl: 'https://example.test/twilio/status',
            retryFragment: '#rc=3&ct=1000&rt=5000&tt=15000&rp=ct,rt,5xx',
          },
          fromNumber: '+15005550006',
          body: claim.claimed!.body!,
          expectedMessagingStateVersion: 1,
        },
        providerCreate,
      ).finally(() => {
        sendSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(sendSettled).toBe(false);
      expect(providerCreate).not.toHaveBeenCalled();
      await start.query('COMMIT');

      await expect(pendingSend).resolves.toEqual({
        sent: false,
        reason: 'messaging-state-changed',
      });
      expect(providerCreate).not.toHaveBeenCalled();
      const stored = await pool.query<{ status: string }>(
        'SELECT status FROM outbound_message WHERE id = $1',
        [prepared.outboundId],
      );
      expect(stored.rows).toEqual([{ status: 'failed' }]);
    } finally {
      try {
        await start.query('ROLLBACK');
      } catch {
        // COMMIT already closed the expected transaction.
      }
      start.release();
    }
  });

  it('releases the patient lock before the provider call so STOP commits while the send is pending', async () => {
    const dose = await seedDose();
    const claim = await reserveScheduledCheckIn(pool, dose, 'Your medication check-in');
    expect(claim).not.toBeNull();
    let providerStartedResolve: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      providerStartedResolve = resolve;
    });
    let providerResolve: ((value: { sid: string }) => void) | undefined;
    const providerResult = new Promise<{ sid: string }>((resolve) => {
      providerResolve = resolve;
    });
    const providerCreate = vi.fn(() => {
      providerStartedResolve?.();
      return providerResult;
    });

    const pendingSend = sendClaimedOutboundUnderConsent(
      pool,
      {
        patientId: dose.patientId,
        outboundMessageId: claim!.id,
        callbackToken: claim!.callbackToken,
        callbackConfig: {
          baseUrl: 'https://example.test/twilio/status',
          retryFragment: '#rc=3&ct=1000&rt=5000&tt=15000&rp=ct,rt,5xx',
        },
        fromNumber: '+15005550006',
        body: 'Your medication check-in',
        expectedMessagingStateVersion: null,
      },
      providerCreate,
    );
    await providerStarted;

    const stop = await pool.connect();
    try {
      await stop.query('BEGIN');
      await stop.query(`SET LOCAL lock_timeout = '250ms'`);
      let stopError: unknown;
      try {
        await stop.query('SELECT id FROM patient WHERE id = $1 FOR UPDATE', [dose.patientId]);
        await stop.query(
          `UPDATE patient
              SET provider_opted_in = false, agent_enabled = false,
                  messaging_state_version = messaging_state_version + 1
            WHERE id = $1`,
          [dose.patientId],
        );
        await stop.query('COMMIT');
      } catch (error) {
        stopError = error;
        await stop.query('ROLLBACK');
      }

      providerResolve?.({ sid: `SM${randomUUID().replaceAll('-', '')}` });
      await expect(pendingSend).resolves.toMatchObject({ sent: true, sid: expect.any(String) });
      expect(stopError).toBeUndefined();
      expect(providerCreate).toHaveBeenCalledOnce();
      const stored = await pool.query<{ status: string }>(
        'SELECT status FROM outbound_message WHERE id = $1',
        [claim!.id],
      );
      expect(stored.rows).toEqual([{ status: 'queued' }]);
      const patient = await pool.query<{
        provider_opted_in: boolean;
        agent_enabled: boolean;
        messaging_state_version: number;
      }>(
        `SELECT provider_opted_in, agent_enabled, messaging_state_version
           FROM patient WHERE id = $1`,
        [dose.patientId],
      );
      expect(patient.rows).toEqual([
        { provider_opted_in: false, agent_enabled: false, messaging_state_version: 2 },
      ]);
    } finally {
      try {
        await stop.query('ROLLBACK');
      } catch {
        // COMMIT already closed the expected transaction.
      }
      stop.release();
    }
  });

  it('keeps sent_at null when the provider outcome is ambiguous and no callback has proved acceptance', async () => {
    const dose = await seedDose();
    const claim = await reserveScheduledCheckIn(pool, dose, 'Your medication check-in');
    expect(claim).not.toBeNull();

    await expect(
      sendClaimedOutboundUnderConsent(
        pool,
        {
          patientId: dose.patientId,
          outboundMessageId: claim!.id,
          callbackToken: claim!.callbackToken,
          callbackConfig: {
            baseUrl: 'https://example.test/twilio/status',
            retryFragment: '#rc=3&ct=1000&rt=5000&tt=15000&rp=ct,rt,5xx',
          },
          fromNumber: '+15005550006',
          body: 'Your medication check-in',
          expectedMessagingStateVersion: null,
        },
        vi.fn().mockRejectedValue(new Error('socket reset after write')),
      ),
    ).rejects.toThrow('status-unknown');

    const stored = await pool.query<{
      status: string;
      twilio_sid: string | null;
      sent_at: Date | null;
      status_updated_at: Date;
    }>(
      `SELECT status, twilio_sid, sent_at, status_updated_at
         FROM outbound_message
        WHERE id = $1`,
      [claim!.id],
    );
    expect(stored.rows[0]).toMatchObject({
      status: 'sending_unknown',
      twilio_sid: null,
      sent_at: null,
      status_updated_at: expect.any(Date),
    });
  });
});
