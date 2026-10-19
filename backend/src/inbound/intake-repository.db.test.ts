import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  markInboundEnqueued,
  reserveInboundIntake,
  sweepStopSchedulesUnderCurrentEpoch,
} from './intake-repository.js';
import { hasNewerInboundReply } from '../conversation/runtime-repository.js';

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema-init', 'schema.sql'), 'utf8');
const CONTAINER_TIMEOUT_MS = 180_000;
const OWNER_SUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

async function seedPatient(
  timezone = 'America/Toronto',
): Promise<{ readonly id: string; readonly phone: string }> {
  phoneCounter += 1;
  const phone = `+1500777${String(phoneCounter).padStart(4, '0')}`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO patient (phone, medication_name, owner_clinician_sub, timezone)
     VALUES ($1, 'repository test medication', $2, $3)
     RETURNING id`,
    [phone, OWNER_SUB, timezone],
  );
  return { id: inserted.rows[0]!.id, phone };
}

/** Retires the record the way the clinician deactivation path does: is_active only. */
async function retirePatient(patientId: string): Promise<void> {
  await pool.query('UPDATE patient SET is_active = false WHERE id = $1', [patientId]);
}

async function consentState(patientId: string) {
  const state = await pool.query<{
    is_active: boolean;
    provider_opted_in: boolean;
    agent_enabled: boolean;
  }>('SELECT is_active, provider_opted_in, agent_enabled FROM patient WHERE id = $1', [patientId]);
  return state.rows[0];
}

async function bucketRows(patientId: string) {
  const buckets = await pool.query<{
    bucket_scope: string;
    consumed_units: number;
    limit_units: number;
    window_start: Date;
  }>(
    `SELECT bucket_scope, consumed_units, limit_units, window_start
       FROM usage_bucket WHERE patient_id = $1 ORDER BY bucket_scope, window_start`,
    [patientId],
  );
  return buckets.rows;
}

function intakeInput(phone: string, messageSid = `SM${randomUUID().replaceAll('-', '')}`) {
  return {
    phone,
    rawBody: 'taken this morning',
    emergencyCategory: null,
    messageSid,
    createTurnJob: true,
    control: null,
  } as const;
}

function mediaInput(phone: string, messageSid = `SM${randomUUID().replaceAll('-', '')}`) {
  return {
    ...intakeInput(phone, messageSid),
    rawBody: '',
    createTurnJob: false,
  } as const;
}

function emergencyInput(phone: string, messageSid = `SM${randomUUID().replaceAll('-', '')}`) {
  return {
    ...mediaInput(phone, messageSid),
    rawBody: 'je ne peux pas respirer',
    emergencyCategory: 'acute_physical',
  } as const;
}

function controlInput(
  phone: string,
  control: 'stop' | 'start' | 'help',
  messageSid = `SM${randomUUID().replaceAll('-', '')}`,
) {
  return {
    phone,
    rawBody: control.toUpperCase(),
    emergencyCategory: null,
    messageSid,
    createTurnJob: false,
    control,
  } as const;
}

beforeAll(async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl) {
    pool = new Pool({ connectionString: databaseUrl });
  } else {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
  }
  await applySchema();
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('reserveInboundIntake against PostgreSQL 16', () => {
  it('serializes concurrent patient-local sequences and keeps queue stamping post-commit', async () => {
    const patient = await seedPatient();
    const inputs = Array.from({ length: 6 }, () => intakeInput(patient.phone));

    const reservations = await Promise.all(
      inputs.map((input) => reserveInboundIntake(pool, input)),
    );
    const stored = reservations.filter((result) => result.kind !== 'unmatched');

    expect(stored).toHaveLength(6);
    expect(stored.map((result) => result.inboundSequence).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(stored.every((result) => result.kind === 'new' && result.shouldEnqueue)).toBe(true);

    const state = await pool.query<{
      next_inbound_sequence: string;
      inbound_count: string;
      job_count: string;
      unstamped_count: string;
    }>(
      `SELECT p.next_inbound_sequence,
              count(DISTINCT ir.id)::text AS inbound_count,
              count(DISTINCT tj.id)::text AS job_count,
              count(DISTINCT ir.id) FILTER (WHERE ir.enqueued_at IS NULL)::text AS unstamped_count
         FROM patient p
         LEFT JOIN inbound_reply ir ON ir.patient_id = p.id
         LEFT JOIN turn_job tj
           ON tj.patient_id = ir.patient_id
          AND tj.inbound_message_id = ir.id
          AND tj.inbound_sequence = ir.inbound_sequence
        WHERE p.id = $1
        GROUP BY p.id`,
      [patient.id],
    );
    expect(state.rows[0]).toMatchObject({
      next_inbound_sequence: '7',
      inbound_count: '6',
      job_count: '6',
      unstamped_count: '6',
    });

    const first = stored[0]!;
    await markInboundEnqueued(pool, first.inboundMessageId);
    await markInboundEnqueued(pool, first.inboundMessageId);
    const stamped = await pool.query<{ enqueued_at: Date | null }>(
      `SELECT enqueued_at FROM inbound_reply WHERE id = $1`,
      [first.inboundMessageId],
    );
    expect(stamped.rows[0]?.enqueued_at).toBeInstanceOf(Date);
  });

  // Wave 1a invariant pin: the inbound row + monotonic sequence are DURABLY committed before
  // any SQS handoff, so an in-flight older turn's newer-inbound recency gate (record-only
  // batching / send backstop) can already see the newer message from another connection.
  it('persists the inbound row and sequence before any enqueue stamp — the recency-gate precondition', async () => {
    const patient = await seedPatient();
    const first = await reserveInboundIntake(pool, intakeInput(patient.phone));
    const second = await reserveInboundIntake(pool, intakeInput(patient.phone));
    if (first.kind === 'unmatched' || second.kind === 'unmatched') {
      throw new Error('expected_matched_intake');
    }

    // Neither message has been enqueued, yet both are durable with allocated sequences and
    // turn jobs — visible to any other connection.
    const stored = await pool.query<{
      id: string;
      inbound_sequence: string;
      enqueued_at: Date | null;
      has_job: boolean;
    }>(
      `SELECT ir.id::text, ir.inbound_sequence::text, ir.enqueued_at,
              (tj.id IS NOT NULL) AS has_job
         FROM inbound_reply ir
         LEFT JOIN turn_job tj
           ON tj.patient_id = ir.patient_id AND tj.inbound_message_id = ir.id
        WHERE ir.patient_id = $1
        ORDER BY ir.inbound_sequence`,
      [patient.id],
    );
    expect(stored.rows).toEqual([
      expect.objectContaining({
        id: first.inboundMessageId,
        inbound_sequence: '1',
        enqueued_at: null,
        has_job: true,
      }),
      expect.objectContaining({
        id: second.inboundMessageId,
        inbound_sequence: '2',
        enqueued_at: null,
        has_job: true,
      }),
    ]);

    // The recency gate consuming this invariant already sees the newer message pre-enqueue.
    await expect(hasNewerInboundReply(pool, first.inboundMessageId)).resolves.toBe(true);
    await expect(hasNewerInboundReply(pool, second.inboundMessageId)).resolves.toBe(false);

    // The stamp is strictly post-persist: it can never create the row it stamps.
    await expect(markInboundEnqueued(pool, patient.id)).rejects.toThrow(
      'inbound row missing before enqueue stamp',
    );
    await markInboundEnqueued(pool, first.inboundMessageId);
    const stamped = await pool.query<{ enqueued_at: Date | null }>(
      'SELECT enqueued_at FROM inbound_reply WHERE id = $1',
      [first.inboundMessageId],
    );
    expect(stamped.rows[0]?.enqueued_at).toBeInstanceOf(Date);
  });

  it('deduplicates a concurrent SID and rolls back sequence/inbound writes when job creation fails', async () => {
    const patient = await seedPatient();
    const duplicateInput = intakeInput(patient.phone);

    const duplicates = await Promise.all([
      reserveInboundIntake(pool, duplicateInput),
      reserveInboundIntake(pool, duplicateInput),
    ]);
    expect(duplicates.map((result) => result.kind).sort()).toEqual(['duplicate', 'new']);
    expect(
      duplicates.every((result) => result.kind !== 'unmatched' && result.inboundSequence === 1),
    ).toBe(true);

    const rollbackPatient = await seedPatient();
    await pool.query(`CREATE FUNCTION intake_job_failure_for_test() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced turn_job failure';
      END;
    $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER intake_job_failure_for_test
      BEFORE INSERT ON turn_job FOR EACH ROW EXECUTE FUNCTION intake_job_failure_for_test()`);
    try {
      await expect(reserveInboundIntake(pool, intakeInput(rollbackPatient.phone))).rejects.toThrow(
        /forced turn_job failure/i,
      );
    } finally {
      await pool.query('DROP TRIGGER intake_job_failure_for_test ON turn_job');
      await pool.query('DROP FUNCTION intake_job_failure_for_test()');
    }

    const state = await pool.query<{
      next_inbound_sequence: string;
      inbound_count: string;
      job_count: string;
    }>(
      `SELECT p.next_inbound_sequence,
              count(DISTINCT ir.id)::text AS inbound_count,
              count(DISTINCT tj.id)::text AS job_count
         FROM patient p
         LEFT JOIN inbound_reply ir ON ir.patient_id = p.id
         LEFT JOIN turn_job tj ON tj.patient_id = p.id
        WHERE p.id = $1
        GROUP BY p.id`,
      [rollbackPatient.id],
    );
    expect(state.rows[0]).toMatchObject({
      next_inbound_sequence: '1',
      inbound_count: '0',
      job_count: '0',
    });
  });

  it('captures the intake consent epoch once and keeps it when the SID is redriven after START', async () => {
    const patient = await seedPatient();
    const input = intakeInput(patient.phone);

    const first = await reserveInboundIntake(pool, input);
    expect(first).toMatchObject({ kind: 'new', shouldEnqueue: true });
    await reserveInboundIntake(pool, controlInput(patient.phone, 'start'));
    const duplicate = await reserveInboundIntake(pool, input);

    expect(duplicate).toMatchObject({
      kind: 'duplicate',
      inboundMessageId: first.kind === 'unmatched' ? '' : first.inboundMessageId,
      shouldEnqueue: true,
    });
    const epochs = await pool.query<{
      patient_version: number;
      job_version: number;
      job_count: string;
    }>(
      `SELECT p.messaging_state_version AS patient_version,
              min(tj.messaging_state_version)::int AS job_version,
              count(tj.id)::text AS job_count
         FROM patient p
         JOIN turn_job tj ON tj.patient_id = p.id
        WHERE p.id = $1
        GROUP BY p.id`,
      [patient.id],
    );
    expect(epochs.rows).toEqual([{ patient_version: 2, job_version: 1, job_count: '1' }]);
  });

  it('fails closed when a globally unique SID is replayed for a different patient', async () => {
    const owner = await seedPatient();
    const foreign = await seedPatient();
    const sharedSid = `SM${randomUUID().replaceAll('-', '')}`;

    const first = await reserveInboundIntake(pool, intakeInput(owner.phone, sharedSid));
    expect(first.kind).toBe('new');
    await expect(reserveInboundIntake(pool, intakeInput(foreign.phone, sharedSid))).rejects.toThrow(
      'MessageSid is already assigned to another patient',
    );

    const state = await pool.query<{
      id: string;
      next_inbound_sequence: string;
      inbound_count: string;
    }>(
      `SELECT p.id, p.next_inbound_sequence,
              count(ir.id)::text AS inbound_count
         FROM patient p
         LEFT JOIN inbound_reply ir ON ir.patient_id = p.id
        WHERE p.id = ANY($1::uuid[])
        GROUP BY p.id, p.next_inbound_sequence
        ORDER BY p.id`,
      [[owner.id, foreign.id]],
    );
    expect(state.rows).toEqual(
      expect.arrayContaining([
        { id: owner.id, next_inbound_sequence: '2', inbound_count: '1' },
        { id: foreign.id, next_inbound_sequence: '1', inbound_count: '0' },
      ]),
    );
  });

  it('serializes concurrent STOP/START, increments each accepted control once, and leaves the agent disabled', async () => {
    const patient = await seedPatient();
    const before = await pool.query<{ messaging_state_version: number }>(
      'SELECT messaging_state_version FROM patient WHERE id = $1',
      [patient.id],
    );
    const initialVersion = before.rows[0]!.messaging_state_version;

    const results = await Promise.all([
      reserveInboundIntake(pool, controlInput(patient.phone, 'stop')),
      reserveInboundIntake(pool, controlInput(patient.phone, 'start')),
    ]);
    expect(results.every((result) => result.kind === 'new')).toBe(true);

    const state = await pool.query<{
      agent_enabled: boolean;
      provider_opted_in: boolean;
      messaging_state_version: number;
      is_active: boolean;
      latest_control: string;
      job_count: string;
    }>(
      `SELECT p.agent_enabled,
              p.provider_opted_in,
              p.messaging_state_version,
              p.is_active,
              latest.raw_body AS latest_control,
              count(tj.id)::text AS job_count
         FROM patient p
         JOIN LATERAL (
           SELECT ir.raw_body
             FROM inbound_reply ir
            WHERE ir.patient_id = p.id
            ORDER BY ir.inbound_sequence DESC
            LIMIT 1
         ) latest ON true
         LEFT JOIN turn_job tj ON tj.patient_id = p.id
        WHERE p.id = $1
        GROUP BY p.id, latest.raw_body`,
      [patient.id],
    );
    expect(state.rows[0]).toMatchObject({
      agent_enabled: false,
      provider_opted_in: state.rows[0]?.latest_control === 'START',
      messaging_state_version: initialVersion + 2,
      is_active: true,
      job_count: '0',
    });
  });

  it('applies a concurrent duplicate STOP exactly once and never creates a model job', async () => {
    const patient = await seedPatient();
    const before = await pool.query<{ messaging_state_version: number }>(
      'SELECT messaging_state_version FROM patient WHERE id = $1',
      [patient.id],
    );
    const input = controlInput(patient.phone, 'stop');

    const results = await Promise.all([
      reserveInboundIntake(pool, input),
      reserveInboundIntake(pool, input),
    ]);
    expect(results.map(({ kind }) => kind).sort()).toEqual(['duplicate', 'new']);
    expect(
      results
        .filter((result) => result.kind !== 'unmatched')
        .map((result) => ({
          kind: result.kind,
          shouldSweepSchedules: result.shouldSweepSchedules,
        })),
    ).toEqual(
      expect.arrayContaining([
        { kind: 'new', shouldSweepSchedules: true },
        { kind: 'duplicate', shouldSweepSchedules: true },
      ]),
    );

    const state = await pool.query<{
      provider_opted_in: boolean;
      agent_enabled: boolean;
      messaging_state_version: number;
      inbound_count: string;
      job_count: string;
    }>(
      `SELECT p.provider_opted_in, p.agent_enabled, p.messaging_state_version,
              count(DISTINCT ir.id)::text AS inbound_count,
              count(DISTINCT tj.id)::text AS job_count
         FROM patient p
         LEFT JOIN inbound_reply ir ON ir.patient_id = p.id
         LEFT JOIN turn_job tj ON tj.patient_id = p.id
        WHERE p.id = $1
        GROUP BY p.id`,
      [patient.id],
    );
    expect(state.rows[0]).toMatchObject({
      provider_opted_in: false,
      agent_enabled: false,
      messaging_state_version: before.rows[0]!.messaging_state_version + 1,
      inbound_count: '1',
      job_count: '0',
    });
  });

  it('fails closed for a legacy duplicate STOP without durable control epoch metadata', async () => {
    const patient = await seedPatient();
    const messageSid = `SM${randomUUID().replaceAll('-', '')}`;
    await pool.query(
      `INSERT INTO inbound_reply
         (patient_id, raw_body, twilio_message_sid, inbound_sequence)
       VALUES ($1, 'STOP', $2, 1)`,
      [patient.id, messageSid],
    );

    await expect(
      reserveInboundIntake(pool, controlInput(patient.phone, 'stop', messageSid)),
    ).resolves.toMatchObject({
      kind: 'duplicate',
      shouldSweepSchedules: false,
    });
    expect(await consentState(patient.id)).toMatchObject({
      provider_opted_in: true,
      agent_enabled: true,
    });
  });

  it('authorizes only the current STOP epoch across START, clinician reactivation, and ABA', async () => {
    const patient = await seedPatient();
    const initial = await pool.query<{ messaging_state_version: number }>(
      'SELECT messaging_state_version FROM patient WHERE id = $1',
      [patient.id],
    );
    const initialVersion = initial.rows[0]!.messaging_state_version;
    const stopA = controlInput(patient.phone, 'stop');
    const startB = controlInput(patient.phone, 'start');
    const stopC = controlInput(patient.phone, 'stop');

    await expect(reserveInboundIntake(pool, stopA)).resolves.toMatchObject({
      kind: 'new',
      shouldSweepSchedules: true,
    });
    await expect(reserveInboundIntake(pool, stopA)).resolves.toMatchObject({
      kind: 'duplicate',
      shouldSweepSchedules: true,
    });
    await reserveInboundIntake(pool, startB);
    await pool.query(
      `UPDATE patient
          SET agent_enabled = true,
              messaging_state_version = messaging_state_version + 1
        WHERE id = $1`,
      [patient.id],
    );

    await expect(reserveInboundIntake(pool, stopA)).resolves.toMatchObject({
      kind: 'duplicate',
      shouldSweepSchedules: false,
    });
    await expect(reserveInboundIntake(pool, stopC)).resolves.toMatchObject({
      kind: 'new',
      shouldSweepSchedules: true,
    });
    await expect(reserveInboundIntake(pool, stopA)).resolves.toMatchObject({
      kind: 'duplicate',
      shouldSweepSchedules: false,
    });
    await expect(reserveInboundIntake(pool, stopC)).resolves.toMatchObject({
      kind: 'duplicate',
      shouldSweepSchedules: true,
    });

    const stored = await pool.query<{
      original_control: string;
      control_messaging_state_version: number;
    }>(
      `SELECT original_control, control_messaging_state_version
         FROM inbound_reply
        WHERE patient_id = $1
        ORDER BY inbound_sequence`,
      [patient.id],
    );
    expect(stored.rows).toEqual([
      {
        original_control: 'stop',
        control_messaging_state_version: initialVersion + 1,
      },
      {
        original_control: 'start',
        control_messaging_state_version: initialVersion + 2,
      },
      {
        original_control: 'stop',
        control_messaging_state_version: initialVersion + 4,
      },
    ]);
  });

  it('holds the patient and schedule-mutation locks across the external STOP sweep barrier', async () => {
    const patient = await seedPatient();
    const stop = await reserveInboundIntake(pool, controlInput(patient.phone, 'stop'));
    if (stop.kind === 'unmatched') throw new Error('expected stored STOP');
    let releaseSweep!: () => void;
    let announceSweep!: () => void;
    const sweepStarted = new Promise<void>((resolve) => {
      announceSweep = resolve;
    });
    const sweepReleased = new Promise<void>((resolve) => {
      releaseSweep = resolve;
    });
    const sweep = sweepStopSchedulesUnderCurrentEpoch(
      pool,
      { patientId: patient.id, inboundMessageId: stop.inboundMessageId },
      async () => {
        announceSweep();
        await sweepReleased;
      },
    );
    await sweepStarted;

    const startClient = await pool.connect();
    await startClient.query(`SET lock_timeout = '75ms'`);
    await expect(
      startClient.query(
        `UPDATE patient
            SET provider_opted_in = true,
                messaging_state_version = messaging_state_version + 1
          WHERE id = $1`,
        [patient.id],
      ),
    ).rejects.toMatchObject({ code: '55P03' });
    startClient.release();

    releaseSweep();
    await expect(sweep).resolves.toBe(true);
    await pool.query(
      `UPDATE patient
          SET provider_opted_in = true,
              messaging_state_version = messaging_state_version + 1
        WHERE id = $1`,
      [patient.id],
    );
    await expect(
      sweepStopSchedulesUnderCurrentEpoch(
        pool,
        { patientId: patient.id, inboundMessageId: stop.inboundMessageId },
        async () => {
          throw new Error('stale STOP must not reach Scheduler');
        },
      ),
    ).resolves.toBe(false);
  });

  it('accepts START for the current disabled agent but continues rejecting ordinary messages', async () => {
    const patient = await seedPatient();
    const stopped = await reserveInboundIntake(pool, controlInput(patient.phone, 'stop'));
    expect(stopped.kind).toBe('new');

    await expect(reserveInboundIntake(pool, intakeInput(patient.phone))).resolves.toEqual({
      kind: 'unmatched',
      matchCount: 0,
    });

    const started = await reserveInboundIntake(pool, controlInput(patient.phone, 'start'));
    expect(started).toMatchObject({ kind: 'new', shouldEnqueue: false });
    await expect(reserveInboundIntake(pool, intakeInput(patient.phone))).resolves.toEqual({
      kind: 'unmatched',
      matchCount: 0,
    });

    const state = await pool.query<{
      provider_opted_in: boolean;
      agent_enabled: boolean;
      is_active: boolean;
      opted_out_at: Date | null;
    }>(
      'SELECT provider_opted_in, agent_enabled, is_active, opted_out_at FROM patient WHERE id = $1',
      [patient.id],
    );
    expect(state.rows[0]).toEqual({
      provider_opted_in: true,
      agent_enabled: false,
      is_active: true,
      opted_out_at: null,
    });
  });

  it('stores a deterministic emergency for one active stopped patient without model work', async () => {
    const patient = await seedPatient();
    await reserveInboundIntake(pool, controlInput(patient.phone, 'stop'));

    const emergency = await reserveInboundIntake(pool, emergencyInput(patient.phone));
    expect(emergency).toMatchObject({ kind: 'new', patientId: patient.id, shouldEnqueue: false });

    const stored = await pool.query<{
      safety_flagged: boolean;
      job_count: string;
    }>(
      `SELECT ir.safety_flagged, count(tj.id)::text AS job_count
         FROM inbound_reply ir
         LEFT JOIN turn_job tj ON tj.inbound_message_id = ir.id
        WHERE ir.id = $1
        GROUP BY ir.id`,
      [emergency.kind === 'unmatched' ? '' : emergency.inboundMessageId],
    );
    expect(stored.rows[0]).toEqual({ safety_flagged: true, job_count: '0' });
    expect(await bucketRows(patient.id)).toEqual([]);
  });

  it('atomically records one clinician alert for a fresh emergency and its duplicate', async () => {
    const patient = await seedPatient();
    const input = emergencyInput(patient.phone);

    const reservations = await Promise.all([
      reserveInboundIntake(pool, input),
      reserveInboundIntake(pool, input),
    ]);

    expect(reservations.map(({ kind }) => kind).sort()).toEqual(['duplicate', 'new']);
    const alerts = await pool.query<{
      flag_category: string;
      trigger_source: string;
    }>(
      `SELECT flag_category, trigger_source
         FROM safety_events
        WHERE patient_id = $1`,
      [patient.id],
    );
    expect(alerts.rows).toEqual([{ flag_category: 'acute_physical', trigger_source: 'prefilter' }]);
  });

  it('rolls back the inbound row and alert when emergency alert persistence fails', async () => {
    const patient = await seedPatient();
    await pool.query(`CREATE FUNCTION intake_safety_failure_for_test() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced safety_events failure';
      END;
    $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER intake_safety_failure_for_test
      BEFORE INSERT ON safety_events FOR EACH ROW EXECUTE FUNCTION intake_safety_failure_for_test()`);
    try {
      await expect(reserveInboundIntake(pool, emergencyInput(patient.phone))).rejects.toThrow(
        /forced safety_events failure/i,
      );
    } finally {
      await pool.query('DROP TRIGGER intake_safety_failure_for_test ON safety_events');
      await pool.query('DROP FUNCTION intake_safety_failure_for_test()');
    }

    const state = await pool.query<{
      next_inbound_sequence: string;
      inbound_count: string;
      alert_count: string;
    }>(
      `SELECT p.next_inbound_sequence,
              count(DISTINCT ir.id)::text AS inbound_count,
              count(DISTINCT se.id)::text AS alert_count
         FROM patient p
         LEFT JOIN inbound_reply ir ON ir.patient_id = p.id
         LEFT JOIN safety_events se ON se.patient_id = p.id
        WHERE p.id = $1
        GROUP BY p.id`,
      [patient.id],
    );
    expect(state.rows[0]).toEqual({
      next_inbound_sequence: '1',
      inbound_count: '0',
      alert_count: '0',
    });
  });

  it('fails closed for a deterministic emergency from a retired patient', async () => {
    const retired = await seedPatient();
    await retirePatient(retired.id);
    await expect(reserveInboundIntake(pool, emergencyInput(retired.phone))).resolves.toEqual({
      kind: 'unmatched',
      matchCount: 0,
    });
  });
});

// H-05 — a retired record must still be reachable by an exact signed STOP/START, because
// opting out can never depend on the agent being active.
describe('retired-record consent controls against PostgreSQL 16', () => {
  it('records STOP for a retired patient without reviving the record or creating a job', async () => {
    const patient = await seedPatient();
    await retirePatient(patient.id);

    const stopped = await reserveInboundIntake(pool, controlInput(patient.phone, 'stop'));

    expect(stopped).toMatchObject({
      kind: 'new',
      shouldEnqueue: false,
      shouldSweepSchedules: true,
    });
    expect(await consentState(patient.id)).toEqual({
      is_active: false,
      provider_opted_in: false,
      agent_enabled: false,
    });
    const jobs = await pool.query('SELECT id FROM turn_job WHERE patient_id = $1', [patient.id]);
    expect(jobs.rowCount).toBe(0);
    expect(await bucketRows(patient.id)).toEqual([]);
  });

  it('records START for a retired patient as consent only — no reactivation, no conversation', async () => {
    const patient = await seedPatient();
    await reserveInboundIntake(pool, controlInput(patient.phone, 'stop'));
    await retirePatient(patient.id);

    const started = await reserveInboundIntake(pool, controlInput(patient.phone, 'start'));

    expect(started).toMatchObject({ kind: 'new', shouldEnqueue: false });
    expect(await consentState(patient.id)).toEqual({
      is_active: false,
      provider_opted_in: true,
      agent_enabled: false,
    });
    // Consent alone never reopens the conversation: doctor-only reactivation still stands.
    await expect(reserveInboundIntake(pool, intakeInput(patient.phone))).resolves.toEqual({
      kind: 'unmatched',
      matchCount: 0,
    });
  });

  it('prefers the single active record when a retired record shares the same phone', async () => {
    const active = await seedPatient();
    const retired = await seedPatient();
    await retirePatient(retired.id);
    await pool.query('UPDATE patient SET phone = $1 WHERE id = $2', [active.phone, retired.id]);

    const stopped = await reserveInboundIntake(pool, controlInput(active.phone, 'stop'));

    expect(stopped).toMatchObject({ kind: 'new', patientId: active.id });
    expect(await consentState(retired.id)).toMatchObject({ provider_opted_in: true });
  });

  it('fails closed and writes nothing when two retired records share one phone', async () => {
    const first = await seedPatient();
    const second = await seedPatient();
    await retirePatient(first.id);
    await retirePatient(second.id);
    await pool.query('UPDATE patient SET phone = $1 WHERE id = $2', [first.phone, second.id]);

    await expect(reserveInboundIntake(pool, controlInput(first.phone, 'stop'))).resolves.toEqual({
      kind: 'unmatched',
      matchCount: 2,
    });

    for (const id of [first.id, second.id]) {
      expect(await consentState(id)).toMatchObject({ provider_opted_in: true });
      const stored = await pool.query('SELECT id FROM inbound_reply WHERE patient_id = $1', [id]);
      expect(stored.rowCount).toBe(0);
    }
  });
});

// M-04 — burst 20/10 min and 50/patient-local day, consumed under the patient lock the intake
// already holds, before any turn job exists.
describe('intake capacity gate against PostgreSQL 16', () => {
  it('counts unread media against the same limits without creating model jobs', async () => {
    const patient = await seedPatient();

    const admitted = [];
    for (let i = 0; i < 20; i += 1) {
      admitted.push(await reserveInboundIntake(pool, mediaInput(patient.phone)));
    }
    const twentyFirst = await reserveInboundIntake(pool, mediaInput(patient.phone));
    const twentySecond = await reserveInboundIntake(pool, mediaInput(patient.phone));

    expect(admitted.every((r) => r.kind === 'new' && !r.shouldEnqueue)).toBe(true);
    expect(twentyFirst).toMatchObject({ shouldEnqueue: false, rateLimited: 'notice' });
    expect(twentySecond).toMatchObject({ shouldEnqueue: false, rateLimited: 'silent' });

    const counts = await pool.query<{ inbound_count: string; job_count: string }>(
      `SELECT count(DISTINCT ir.id)::text AS inbound_count,
              count(DISTINCT tj.id)::text AS job_count
         FROM inbound_reply ir
         LEFT JOIN turn_job tj ON tj.inbound_message_id = ir.id
        WHERE ir.patient_id = $1`,
      [patient.id],
    );
    expect(counts.rows[0]).toEqual({ inbound_count: '22', job_count: '0' });
  });

  it('admits exactly 20 turns per burst window, then notices once and stores the rest silently', async () => {
    const patient = await seedPatient();

    const admitted = [];
    for (let i = 0; i < 20; i += 1) {
      admitted.push(await reserveInboundIntake(pool, intakeInput(patient.phone)));
    }
    const twentyFirst = await reserveInboundIntake(pool, intakeInput(patient.phone));
    const twentySecond = await reserveInboundIntake(pool, intakeInput(patient.phone));

    expect(admitted.every((r) => r.kind === 'new' && r.shouldEnqueue)).toBe(true);
    expect(twentyFirst).toMatchObject({ kind: 'new', shouldEnqueue: false, rateLimited: 'notice' });
    expect(twentySecond).toMatchObject({
      kind: 'new',
      shouldEnqueue: false,
      rateLimited: 'silent',
    });

    const counts = await pool.query<{ inbound_count: string; job_count: string }>(
      `SELECT count(DISTINCT ir.id)::text AS inbound_count,
              count(DISTINCT tj.id)::text AS job_count
         FROM inbound_reply ir
         LEFT JOIN turn_job tj ON tj.inbound_message_id = ir.id
        WHERE ir.patient_id = $1`,
      [patient.id],
    );
    // Every message is stored; only the 20 within capacity became model work.
    expect(counts.rows[0]).toEqual({ inbound_count: '22', job_count: '20' });

    const burst = (await bucketRows(patient.id)).find((b) => b.bucket_scope === 'patient_burst');
    expect(burst).toMatchObject({ consumed_units: 21, limit_units: 21 });
  });

  it('notices once at the daily cap and stays silent while burst capacity remains', async () => {
    const patient = await seedPatient();
    await pool.query(
      `INSERT INTO usage_bucket
         (bucket_scope, subject_key, patient_id, window_start, window_end, limit_units, consumed_units)
       SELECT 'patient_day', p.id::text, p.id,
              date_trunc('day', now() AT TIME ZONE p.timezone) AT TIME ZONE p.timezone,
              (date_trunc('day', now() AT TIME ZONE p.timezone) + interval '1 day')
                AT TIME ZONE p.timezone,
              51, 50
         FROM patient p WHERE p.id = $1`,
      [patient.id],
    );

    const capping = await reserveInboundIntake(pool, intakeInput(patient.phone));
    const after = await reserveInboundIntake(pool, intakeInput(patient.phone));

    expect(capping).toMatchObject({ shouldEnqueue: false, rateLimited: 'notice' });
    expect(after).toMatchObject({ shouldEnqueue: false, rateLimited: 'silent' });
    const jobs = await pool.query('SELECT id FROM turn_job WHERE patient_id = $1', [patient.id]);
    expect(jobs.rowCount).toBe(0);
  });

  it('opens the daily window at the patient-local midnight and never reuses a spent one', async () => {
    const patient = await seedPatient('Pacific/Kiritimati');
    await pool.query(
      `INSERT INTO usage_bucket
         (bucket_scope, subject_key, patient_id, window_start, window_end, limit_units, consumed_units)
       SELECT 'patient_day', p.id::text, p.id,
              (date_trunc('day', now() AT TIME ZONE p.timezone) - interval '1 day')
                AT TIME ZONE p.timezone,
              date_trunc('day', now() AT TIME ZONE p.timezone) AT TIME ZONE p.timezone,
              51, 51
         FROM patient p WHERE p.id = $1`,
      [patient.id],
    );

    const today = await reserveInboundIntake(pool, intakeInput(patient.phone));
    expect(today).toMatchObject({ kind: 'new', shouldEnqueue: true });

    const windows = await pool.query<{ matches_local_midnight: boolean; utc_offset_hours: string }>(
      `SELECT ub.window_start = (date_trunc('day', now() AT TIME ZONE p.timezone)
                                   AT TIME ZONE p.timezone) AS matches_local_midnight,
              (extract(epoch FROM (now() AT TIME ZONE p.timezone) - now()) / 3600)::text
                AS utc_offset_hours
         FROM usage_bucket ub
         JOIN patient p ON p.id = ub.patient_id
        WHERE ub.patient_id = $1 AND ub.bucket_scope = 'patient_day'
          AND ub.consumed_units = 1`,
      [patient.id],
    );
    expect(windows.rows).toHaveLength(1);
    expect(windows.rows[0]?.matches_local_midnight).toBe(true);
    // The chosen zone is +14, so this window is provably not the UTC day.
    expect(Number(windows.rows[0]?.utc_offset_hours)).toBe(14);
  });

  it('opens a fresh burst window once the previous one has passed', async () => {
    const patient = await seedPatient();
    await pool.query(
      `INSERT INTO usage_bucket
         (bucket_scope, subject_key, patient_id, window_start, window_end, limit_units, consumed_units)
       VALUES ('patient_burst', $1::text, $1::uuid,
               date_bin('10 minutes', now(), timestamptz 'epoch') - interval '10 minutes',
               date_bin('10 minutes', now(), timestamptz 'epoch'), 21, 21)`,
      [patient.id],
    );

    await expect(reserveInboundIntake(pool, intakeInput(patient.phone))).resolves.toMatchObject({
      shouldEnqueue: true,
    });
    const burstWindows = (await bucketRows(patient.id)).filter(
      (b) => b.bucket_scope === 'patient_burst',
    );
    expect(burstWindows).toHaveLength(2);
    expect(burstWindows.at(-1)).toMatchObject({ consumed_units: 1 });
  });

  it.each(['stop', 'help'] as const)('never consumes capacity for %s', async (control) => {
    const patient = await seedPatient();
    await reserveInboundIntake(pool, controlInput(patient.phone, control));
    expect(await bucketRows(patient.id)).toEqual([]);
  });
});
