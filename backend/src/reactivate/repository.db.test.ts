import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  ReactivationNotFoundError,
  reactivatePatient,
  type DoseScheduleRestorer,
} from './repository.js';
import { sweepStopSchedulesUnderCurrentEpoch } from '../inbound/intake-repository.js';

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema-init', 'schema.sql'), 'utf8');
const CONTAINER_TIMEOUT_MS = 180_000;
const OWNER_A = '97b4a172-e055-4c37-9d95-2a00664dfe64';
const OWNER_B = 'a6e4e0c8-32a0-4514-a6b6-67c504bf80b4';

let container: StartedPostgreSqlContainer | undefined;
let pool: Pool;
let phoneCounter = 0;

beforeAll(async () => {
  const ciUrl = process.env.TEST_DATABASE_URL;
  if (ciUrl) {
    pool = new Pool({ connectionString: ciUrl, max: 6 });
  } else {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  }
  await pool.query(SCHEMA_SQL);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

function nextPhone(): string {
  phoneCounter += 1;
  return `+1500888${String(phoneCounter).padStart(4, '0')}`;
}

async function seedPatient(
  options: {
    owner?: string;
    version?: number;
    providerOptedIn?: boolean;
    agentEnabled?: boolean;
    isActive?: boolean;
  } = {},
): Promise<{ id: string; version: number }> {
  const version = options.version ?? 7;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO patient
       (phone, medication_name, owner_clinician_sub, provider_opted_in, agent_enabled,
        messaging_state_version, is_active, opted_out_at)
     VALUES ($1, 'metformin', $2, $3, $4, $5, $6, now())
     RETURNING id::text`,
    [
      nextPhone(),
      options.owner ?? OWNER_A,
      options.providerOptedIn ?? true,
      options.agentEnabled ?? false,
      version,
      options.isActive ?? true,
    ],
  );
  return { id: result.rows[0]!.id, version };
}

async function seedDose(
  patientId: string,
  scheduledAt: string,
  doseDate: string | null,
  options: { scheduleTimezone?: string | null; withCheckIn?: boolean } = {},
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO dose_schedule
       (patient_id, scheduled_at, local_dose_time, schedule_timezone, dose_date)
     VALUES ($1, $2, '09:15', $3, $4)
     RETURNING id::text`,
    [patientId, scheduledAt, options.scheduleTimezone ?? 'America/Toronto', doseDate],
  );
  const doseId = result.rows[0]!.id;
  if (options.withCheckIn) {
    await pool.query(
      `INSERT INTO outbound_message (patient_id, dose_id, status, body, message_kind)
       VALUES ($1, $2, 'sent', 'check-in', 'check_in')`,
      [patientId, doseId],
    );
  }
  return doseId;
}

function restorer(): DoseScheduleRestorer & {
  reset: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
} {
  return {
    reset: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(undefined),
  };
}

async function state(patientId: string) {
  const result = await pool.query<{
    is_active: boolean;
    agent_enabled: boolean;
    provider_opted_in: boolean;
    messaging_state_version: number;
    opted_out_at: Date | null;
  }>(
    `SELECT is_active, agent_enabled, provider_opted_in,
            messaging_state_version, opted_out_at
       FROM patient WHERE id = $1`,
    [patientId],
  );
  return result.rows[0]!;
}

describe('reactivatePatient PostgreSQL contract', () => {
  it('restores every eligible future unsent dose before enabling and clears only the STOP timestamp', async () => {
    const patient = await seedPatient({ isActive: false });
    const past = await seedDose(patient.id, '2026-08-11T12:00:00Z', '2026-08-11');
    const future = await seedDose(patient.id, '2099-08-15T13:15:00Z', '2099-08-15');
    const sentFuture = await seedDose(patient.id, '2099-08-16T13:15:00Z', '2099-08-16', {
      withCheckIn: true,
    });
    const schedules = restorer();

    const result = await reactivatePatient(
      pool,
      {
        patientId: patient.id,
        clinicianSub: OWNER_A,
        expectedVersion: patient.version,
      },
      schedules,
    );

    expect(result).toEqual({
      agentEnabled: true,
      isActive: false,
      messagingStateVersion: patient.version + 1,
      schedulesRestored: 1,
    });
    expect(schedules.reset).toHaveBeenCalledOnce();
    expect(schedules.reset).toHaveBeenCalledWith(patient.id);
    expect(schedules.create).toHaveBeenCalledWith({
      patientId: patient.id,
      doseId: future,
      doseDate: '2099-08-15',
      localDoseTime: '09:15',
      scheduleTimezone: 'America/Toronto',
    });
    expect(schedules.create).not.toHaveBeenCalledWith(expect.objectContaining({ doseId: past }));
    expect(schedules.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ doseId: sentFuture }),
    );
    expect(await state(patient.id)).toMatchObject({
      is_active: false,
      agent_enabled: true,
      provider_opted_in: true,
      messaging_state_version: patient.version + 1,
      opted_out_at: null,
    });
  });

  it('fails closed for foreign ownership, a stale version, or absent provider consent', async () => {
    const foreign = await seedPatient();
    const stale = await seedPatient();
    const optedOut = await seedPatient({ providerOptedIn: false });
    for (const patient of [foreign, stale, optedOut]) {
      await seedDose(patient.id, '2099-08-15T13:15:00Z', '2099-08-15');
    }
    const schedules = restorer();

    await expect(
      reactivatePatient(
        pool,
        {
          patientId: foreign.id,
          clinicianSub: OWNER_B,
          expectedVersion: foreign.version,
        },
        schedules,
      ),
    ).rejects.toBeInstanceOf(ReactivationNotFoundError);
    await expect(
      reactivatePatient(
        pool,
        {
          patientId: stale.id,
          clinicianSub: OWNER_A,
          expectedVersion: stale.version - 1,
        },
        schedules,
      ),
    ).rejects.toMatchObject({ reason: 'stale_version' });
    await expect(
      reactivatePatient(
        pool,
        {
          patientId: optedOut.id,
          clinicianSub: OWNER_A,
          expectedVersion: optedOut.version,
        },
        schedules,
      ),
    ).rejects.toMatchObject({ reason: 'provider_opted_out' });
    expect(schedules.reset).not.toHaveBeenCalled();
    expect(schedules.create).not.toHaveBeenCalled();
  });

  it('treats an already-enabled current version as a conflict without rebuilding schedules', async () => {
    const patient = await seedPatient({ agentEnabled: true });
    await seedDose(patient.id, '2099-08-15T13:15:00Z', '2099-08-15');
    const schedules = restorer();

    await expect(
      reactivatePatient(
        pool,
        {
          patientId: patient.id,
          clinicianSub: OWNER_A,
          expectedVersion: patient.version,
        },
        schedules,
      ),
    ).rejects.toMatchObject({ reason: 'already_enabled' });
    expect(schedules.reset).not.toHaveBeenCalled();
    expect(schedules.create).not.toHaveBeenCalled();
  });

  it('refuses to enable when there is no eligible future dose or a future row lacks schedule metadata', async () => {
    const empty = await seedPatient();
    await seedDose(empty.id, '2026-08-11T12:00:00Z', '2026-08-11');
    const malformed = await seedPatient();
    await seedDose(malformed.id, '2099-08-15T13:15:00Z', null);
    const schedules = restorer();

    await expect(
      reactivatePatient(
        pool,
        {
          patientId: empty.id,
          clinicianSub: OWNER_A,
          expectedVersion: empty.version,
        },
        schedules,
      ),
    ).rejects.toMatchObject({ reason: 'no_future_doses' });
    await expect(
      reactivatePatient(
        pool,
        {
          patientId: malformed.id,
          clinicianSub: OWNER_A,
          expectedVersion: malformed.version,
        },
        schedules,
      ),
    ).rejects.toMatchObject({ reason: 'invalid_future_dose' });

    expect((await state(empty.id)).agent_enabled).toBe(false);
    expect((await state(malformed.id)).agent_enabled).toBe(false);
    expect(schedules.reset).not.toHaveBeenCalled();
  });

  it('rejects invalid timezone metadata and a stored instant that disagrees with the local dose', async () => {
    const invalidZone = await seedPatient();
    await seedDose(invalidZone.id, '2099-08-15T13:15:00Z', '2099-08-15', {
      scheduleTimezone: 'Mars/Olympus',
    });
    const mismatchedInstant = await seedPatient();
    await seedDose(mismatchedInstant.id, '2099-08-15T14:15:00Z', '2099-08-15');
    const schedules = restorer();

    for (const patient of [invalidZone, mismatchedInstant]) {
      await expect(
        reactivatePatient(
          pool,
          {
            patientId: patient.id,
            clinicianSub: OWNER_A,
            expectedVersion: patient.version,
          },
          schedules,
        ),
      ).rejects.toMatchObject({ reason: 'invalid_future_dose' });
      expect((await state(patient.id)).agent_enabled).toBe(false);
    }
    expect(schedules.reset).not.toHaveBeenCalled();
  });

  it('does not recreate a future dose deliberately detached by a stopped medication revision', async () => {
    const patient = await seedPatient();
    const doseId = await seedDose(patient.id, '2099-08-15T13:15:00Z', '2099-08-15');
    const active = await pool.query<{ id: string }>(
      `INSERT INTO patient_medication
         (patient_id, entered_name, valid_from, status,
          confirmed_by_clinician_sub, confirmed_at)
       VALUES ($1, 'metformin', '2026-08-11', 'active', $2, now())
       RETURNING id::text`,
      [patient.id, OWNER_A],
    );
    const activeMedicationId = active.rows[0]!.id;
    await pool.query(
      'UPDATE dose_schedule SET patient_medication_id = $2 WHERE patient_id = $1 AND id = $3',
      [patient.id, activeMedicationId, doseId],
    );
    await pool.query(
      `INSERT INTO patient_medication
         (patient_id, entered_name, valid_from, status,
          confirmed_by_clinician_sub, confirmed_at, supersedes_id)
       VALUES ($1, 'metformin', '2026-08-12', 'stopped', $2, now(), $3)`,
      [patient.id, OWNER_A, activeMedicationId],
    );
    await pool.query(
      'UPDATE dose_schedule SET patient_medication_id = NULL WHERE patient_id = $1 AND id = $2',
      [patient.id, doseId],
    );
    const schedules = restorer();

    await expect(
      reactivatePatient(
        pool,
        {
          patientId: patient.id,
          clinicianSub: OWNER_A,
          expectedVersion: patient.version,
        },
        schedules,
      ),
    ).rejects.toMatchObject({ reason: 'no_future_doses' });
    expect(schedules.reset).not.toHaveBeenCalled();
    expect(schedules.create).not.toHaveBeenCalled();
    expect((await state(patient.id)).agent_enabled).toBe(false);
  });

  it('rolls back enablement and resweeps accepted or partial schedules after a create failure', async () => {
    const patient = await seedPatient();
    await seedDose(patient.id, '2099-08-15T13:15:00Z', '2099-08-15');
    await seedDose(patient.id, '2099-08-16T13:15:00Z', '2099-08-16');
    const schedules = restorer();
    schedules.create.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('timeout'));

    await expect(
      reactivatePatient(
        pool,
        {
          patientId: patient.id,
          clinicianSub: OWNER_A,
          expectedVersion: patient.version,
        },
        schedules,
      ),
    ).rejects.toThrow(/schedule restoration failed/i);

    expect(schedules.reset).toHaveBeenCalledTimes(2);
    expect(await state(patient.id)).toMatchObject({
      agent_enabled: false,
      messaging_state_version: patient.version,
    });
    expect((await state(patient.id)).opted_out_at).not.toBeNull();
  });

  it('holds the mutation locks through failure compensation before a concurrent retry rebuilds', async () => {
    const patient = await seedPatient();
    const doseId = await seedDose(patient.id, '2099-08-15T13:15:00Z', '2099-08-15');
    const remoteDoseIds = new Set<string>();
    const events: string[] = [];
    let releaseCompensation!: () => void;
    let announceCompensation!: () => void;
    const compensationStarted = new Promise<void>((resolve) => {
      announceCompensation = resolve;
    });
    const compensationReleased = new Promise<void>((resolve) => {
      releaseCompensation = resolve;
    });
    let resetCount = 0;
    const failingSchedules = restorer();
    failingSchedules.reset.mockImplementation(async () => {
      resetCount += 1;
      if (resetCount === 1) {
        events.push('failed-reset');
        remoteDoseIds.clear();
        return;
      }
      events.push('compensation-start');
      announceCompensation();
      await compensationReleased;
      remoteDoseIds.clear();
      events.push('compensation-finished');
    });
    failingSchedules.create.mockImplementation(async (schedule) => {
      events.push('failed-create-accepted');
      remoteDoseIds.add(schedule.doseId);
      throw new Error('accepted response lost');
    });

    const failedActivation = reactivatePatient(
      pool,
      {
        patientId: patient.id,
        clinicianSub: OWNER_A,
        expectedVersion: patient.version,
      },
      failingSchedules,
    );
    await compensationStarted;

    const probe = await pool.connect();
    await probe.query('BEGIN');
    const available = await probe.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS acquired`,
      [patient.id],
    );
    const compensationLockWasAvailable = available.rows[0]!.acquired;
    await probe.query('ROLLBACK');
    probe.release();

    const retrySchedules = restorer();
    retrySchedules.reset.mockImplementation(async () => {
      events.push('retry-reset');
      remoteDoseIds.clear();
    });
    retrySchedules.create.mockImplementation(async (schedule) => {
      events.push('retry-create');
      remoteDoseIds.add(schedule.doseId);
    });
    const retry = reactivatePatient(
      pool,
      {
        patientId: patient.id,
        clinicianSub: OWNER_A,
        expectedVersion: patient.version,
      },
      retrySchedules,
    );
    let retryFinishedBeforeCompensation = false;
    if (compensationLockWasAvailable) {
      await expect(retry).resolves.toMatchObject({ agentEnabled: true });
      retryFinishedBeforeCompensation = true;
    }

    releaseCompensation();
    await expect(failedActivation).rejects.toThrow(/schedule restoration failed/i);
    if (!compensationLockWasAvailable) {
      await expect(retry).resolves.toMatchObject({ agentEnabled: true });
    }

    expect(compensationLockWasAvailable).toBe(false);
    expect(retryFinishedBeforeCompensation).toBe(false);
    expect(events).toEqual([
      'failed-reset',
      'failed-create-accepted',
      'compensation-start',
      'compensation-finished',
      'retry-reset',
      'retry-create',
    ]);
    expect(remoteDoseIds).toEqual(new Set([doseId]));
    expect(await state(patient.id)).toMatchObject({
      agent_enabled: true,
      messaging_state_version: patient.version + 1,
    });
  });

  it('reacquires mutation locks for compensation after the original database session dies', async () => {
    const patient = await seedPatient();
    const doseId = await seedDose(patient.id, '2099-08-15T13:15:00Z', '2099-08-15');
    const failedClient = await pool.connect();
    failedClient.on('error', () => undefined);
    const backend = await failedClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    let connectionCount = 0;
    const reconnectingDatabase = {
      connect: async () => {
        connectionCount += 1;
        return connectionCount === 1 ? failedClient : pool.connect();
      },
    } as Pick<Pool, 'connect'>;
    const remoteDoseIds = new Set<string>();
    const events: string[] = [];
    let releaseCompensation!: () => void;
    let announceCompensation!: () => void;
    const compensationStarted = new Promise<void>((resolve) => {
      announceCompensation = resolve;
    });
    const compensationReleased = new Promise<void>((resolve) => {
      releaseCompensation = resolve;
    });
    let resetCount = 0;
    const failingSchedules = restorer();
    failingSchedules.reset.mockImplementation(async () => {
      resetCount += 1;
      if (resetCount === 1) {
        events.push('failed-reset');
        remoteDoseIds.clear();
        return;
      }
      events.push('compensation-start');
      announceCompensation();
      await compensationReleased;
      remoteDoseIds.clear();
      events.push('compensation-finished');
    });
    failingSchedules.create.mockImplementation(async (schedule) => {
      events.push('failed-create-accepted');
      remoteDoseIds.add(schedule.doseId);
      await pool.query('SELECT pg_terminate_backend($1)', [backend.rows[0]!.pid]);
    });

    const failedActivation = reactivatePatient(
      reconnectingDatabase,
      {
        patientId: patient.id,
        clinicianSub: OWNER_A,
        expectedVersion: patient.version,
      },
      failingSchedules,
    );
    await compensationStarted;

    const probe = await pool.connect();
    await probe.query('BEGIN');
    const available = await probe.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS acquired`,
      [patient.id],
    );
    const compensationLockWasAvailable = available.rows[0]!.acquired;
    await probe.query('ROLLBACK');
    probe.release();

    const retrySchedules = restorer();
    retrySchedules.reset.mockImplementation(async () => {
      events.push('retry-reset');
      remoteDoseIds.clear();
    });
    retrySchedules.create.mockImplementation(async (schedule) => {
      events.push('retry-create');
      remoteDoseIds.add(schedule.doseId);
    });
    const retry = reactivatePatient(
      pool,
      {
        patientId: patient.id,
        clinicianSub: OWNER_A,
        expectedVersion: patient.version,
      },
      retrySchedules,
    );
    let retryFinishedBeforeCompensation = false;
    if (compensationLockWasAvailable) {
      await expect(retry).resolves.toMatchObject({ agentEnabled: true });
      retryFinishedBeforeCompensation = true;
    }

    releaseCompensation();
    await expect(failedActivation).rejects.toThrow();
    if (!compensationLockWasAvailable) {
      await expect(retry).resolves.toMatchObject({ agentEnabled: true });
    }

    expect(compensationLockWasAvailable).toBe(false);
    expect(retryFinishedBeforeCompensation).toBe(false);
    expect(events).toEqual([
      'failed-reset',
      'failed-create-accepted',
      'compensation-start',
      'compensation-finished',
      'retry-reset',
      'retry-create',
    ]);
    expect(remoteDoseIds).toEqual(new Set([doseId]));
    expect(await state(patient.id)).toMatchObject({
      agent_enabled: true,
      messaging_state_version: patient.version + 1,
    });
  });

  it('holds the patient lock through remote creation so a concurrent STOP cannot commit first', async () => {
    const patient = await seedPatient();
    await seedDose(patient.id, '2099-08-15T13:15:00Z', '2099-08-15');
    let releaseCreate!: () => void;
    let announceCreate!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      announceCreate = resolve;
    });
    const createReleased = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const schedules = restorer();
    schedules.create.mockImplementation(async () => {
      announceCreate();
      await createReleased;
    });

    const activation = reactivatePatient(
      pool,
      {
        patientId: patient.id,
        clinicianSub: OWNER_A,
        expectedVersion: patient.version,
      },
      schedules,
    );
    await createStarted;

    const stopClient = await pool.connect();
    await stopClient.query(`SET lock_timeout = '75ms'`);
    await expect(
      stopClient.query(
        `UPDATE patient
            SET provider_opted_in = false, agent_enabled = false,
                messaging_state_version = messaging_state_version + 1
          WHERE id = $1`,
        [patient.id],
      ),
    ).rejects.toMatchObject({ code: '55P03' });
    stopClient.release();

    releaseCreate();
    await expect(activation).resolves.toMatchObject({ messagingStateVersion: patient.version + 1 });
    await pool.query(
      `UPDATE patient
          SET provider_opted_in = false, agent_enabled = false,
              messaging_state_version = messaging_state_version + 1
        WHERE id = $1`,
      [patient.id],
    );
    expect(await state(patient.id)).toMatchObject({
      provider_opted_in: false,
      agent_enabled: false,
      messaging_state_version: patient.version + 2,
    });
  });

  it('creates no schedules when STOP owns the lock and commits a newer consent version first', async () => {
    const patient = await seedPatient();
    await seedDose(patient.id, '2099-08-15T13:15:00Z', '2099-08-15');
    const schedules = restorer();
    const stopClient = await pool.connect();
    await stopClient.query('BEGIN');
    await stopClient.query(
      `UPDATE patient
          SET provider_opted_in = false, agent_enabled = false,
              messaging_state_version = messaging_state_version + 1
        WHERE id = $1`,
      [patient.id],
    );

    const activation = reactivatePatient(
      pool,
      {
        patientId: patient.id,
        clinicianSub: OWNER_A,
        expectedVersion: patient.version,
      },
      schedules,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await stopClient.query('COMMIT');
    stopClient.release();

    await expect(activation).rejects.toMatchObject({ reason: 'stale_version' });
    expect(schedules.reset).not.toHaveBeenCalled();
    expect(schedules.create).not.toHaveBeenCalled();
    expect(await state(patient.id)).toMatchObject({
      provider_opted_in: false,
      agent_enabled: false,
      messaging_state_version: patient.version + 1,
    });
  });

  it('orders a previously admitted STOP sweep before START and the doctor schedule rebuild', async () => {
    const patient = await seedPatient({ providerOptedIn: false });
    await seedDose(patient.id, '2099-08-15T13:15:00Z', '2099-08-15');
    const storedStop = await pool.query<{ id: string }>(
      `INSERT INTO inbound_reply
         (patient_id, raw_body, inbound_sequence, original_control,
          control_messaging_state_version)
       VALUES ($1, 'STOP', 1, 'stop', $2)
       RETURNING id::text`,
      [patient.id, patient.version],
    );
    const events: string[] = [];
    let releaseOldSweep!: () => void;
    let announceOldSweep!: () => void;
    const oldSweepStarted = new Promise<void>((resolve) => {
      announceOldSweep = resolve;
    });
    const oldSweepReleased = new Promise<void>((resolve) => {
      releaseOldSweep = resolve;
    });
    const oldSweep = sweepStopSchedulesUnderCurrentEpoch(
      pool,
      { patientId: patient.id, inboundMessageId: storedStop.rows[0]!.id },
      async () => {
        events.push('old-stop-delete');
        announceOldSweep();
        await oldSweepReleased;
        events.push('old-stop-finished');
      },
    );
    await oldSweepStarted;

    const schedules = restorer();
    schedules.reset.mockImplementation(async () => {
      events.push('reactivation-reset');
    });
    schedules.create.mockImplementation(async () => {
      events.push('reactivation-create');
    });
    const startThenReactivate = (async () => {
      const started = await pool.query<{ messaging_state_version: number }>(
        `UPDATE patient
            SET provider_opted_in = true, opted_out_at = NULL,
                messaging_state_version = messaging_state_version + 1
          WHERE id = $1
          RETURNING messaging_state_version`,
        [patient.id],
      );
      return reactivatePatient(
        pool,
        {
          patientId: patient.id,
          clinicianSub: OWNER_A,
          expectedVersion: started.rows[0]!.messaging_state_version,
        },
        schedules,
      );
    })();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(['old-stop-delete']);

    releaseOldSweep();
    await expect(oldSweep).resolves.toBe(true);
    await expect(startThenReactivate).resolves.toMatchObject({
      agentEnabled: true,
      schedulesRestored: 1,
    });
    expect(events).toEqual([
      'old-stop-delete',
      'old-stop-finished',
      'reactivation-reset',
      'reactivation-create',
    ]);
  });
});
