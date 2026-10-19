import { computeScheduledAtUtc } from '@medadhere/shared';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { lockPatientScheduleMutation } from '../lib/patient-schedule-lock';

const reactivationRequestSchema = z
  .object({
    patientId: z.string().uuid(),
    clinicianSub: z.string().uuid(),
    expectedVersion: z.number().int().positive().max(2_147_483_647),
  })
  .strict();

export type ReactivationConflictReason =
  | 'already_enabled'
  | 'invalid_future_dose'
  | 'no_future_doses'
  | 'provider_opted_out'
  | 'stale_version';

export class ReactivationNotFoundError extends Error {
  constructor() {
    super('Patient not found');
    this.name = 'ReactivationNotFoundError';
  }
}

export class ReactivationConflictError extends Error {
  constructor(readonly reason: ReactivationConflictReason) {
    super('Patient reactivation conflict');
    this.name = 'ReactivationConflictError';
  }
}

export class ReactivationScheduleError extends Error {
  constructor() {
    super('Dose schedule restoration failed');
    this.name = 'ReactivationScheduleError';
  }
}

export interface DoseScheduleRestoration {
  readonly patientId: string;
  readonly doseId: string;
  readonly doseDate: string;
  readonly localDoseTime: string;
  readonly scheduleTimezone: string;
}

export interface DoseScheduleRestorer {
  /** Removes every deterministic dose one-shot for this patient before a clean rebuild. */
  reset(patientId: string): Promise<unknown>;
  /** Creates one deterministic EventBridge one-shot for the supplied persisted dose. */
  create(schedule: DoseScheduleRestoration): Promise<unknown>;
}

export interface ReactivationResult {
  readonly agentEnabled: true;
  readonly isActive: boolean;
  readonly messagingStateVersion: number;
  readonly schedulesRestored: number;
}

type PatientRow = {
  readonly agent_enabled: boolean;
  readonly is_active: boolean;
  readonly messaging_state_version: number;
  readonly provider_opted_in: boolean;
};

type FutureDoseRow = {
  readonly dose_date: string | null;
  readonly id: string;
  readonly local_dose_time: string;
  readonly schedule_timezone: string | null;
  readonly scheduled_at: Date | string;
};

const PATIENT_LOCK_SQL = `SELECT is_active, agent_enabled, provider_opted_in,
       messaging_state_version
  FROM patient
 WHERE id = $1
   AND owner_clinician_sub = $2
 FOR UPDATE`;

/**
 * A future dose is restorable only if no check-in claim already exists. Linked medication revisions
 * must still be the current active version on that dose date; legacy unlinked schedules remain valid.
 */
const ELIGIBLE_FUTURE_DOSES_SQL = `SELECT ds.id::text, ds.scheduled_at, ds.dose_date::text,
       ds.local_dose_time, ds.schedule_timezone
  FROM dose_schedule ds
  LEFT JOIN patient_medication pm
    ON pm.patient_id = ds.patient_id
   AND pm.id = ds.patient_medication_id
 WHERE ds.patient_id = $1
   AND ds.scheduled_at > CURRENT_TIMESTAMP
   AND NOT EXISTS (
     SELECT 1
       FROM outbound_message om
      WHERE om.patient_id = ds.patient_id
        AND om.dose_id = ds.id
        AND om.message_kind = 'check_in'
   )
   AND (
     (
       ds.patient_medication_id IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM patient_medication history
          WHERE history.patient_id = ds.patient_id
       )
     )
     OR (
       pm.status = 'active'
       AND pm.valid_from <= ds.dose_date
       AND (pm.valid_to IS NULL OR pm.valid_to >= ds.dose_date)
       AND NOT EXISTS (
         SELECT 1
           FROM patient_medication newer
          WHERE newer.patient_id = pm.patient_id
            AND newer.supersedes_id = pm.id
            AND newer.valid_from <= ds.dose_date
       )
     )
   )
 ORDER BY ds.scheduled_at, ds.id
 FOR UPDATE OF ds`;

const ENABLE_PATIENT_SQL = `UPDATE patient
   SET agent_enabled = true,
       opted_out_at = NULL,
       messaging_state_version = messaging_state_version + 1
 WHERE id = $1
   AND owner_clinician_sub = $2
   AND messaging_state_version = $3
   AND provider_opted_in = true
   AND agent_enabled = false
 RETURNING is_active, agent_enabled, messaging_state_version`;

function isValidLocalTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  return Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function restorationFor(patientId: string, row: FutureDoseRow): DoseScheduleRestoration {
  if (
    row.dose_date === null ||
    row.schedule_timezone === null ||
    !/^\d{4}-\d{2}-\d{2}$/.test(row.dose_date) ||
    !isValidLocalTime(row.local_dose_time) ||
    !isValidTimezone(row.schedule_timezone)
  ) {
    throw new ReactivationConflictError('invalid_future_dose');
  }
  let expectedScheduledAt: string;
  try {
    expectedScheduledAt = computeScheduledAtUtc({
      doseDate: row.dose_date,
      localDoseTime: row.local_dose_time,
      timezone: row.schedule_timezone,
    });
  } catch {
    throw new ReactivationConflictError('invalid_future_dose');
  }
  const storedScheduledAt = new Date(row.scheduled_at);
  if (
    !Number.isFinite(storedScheduledAt.getTime()) ||
    storedScheduledAt.toISOString() !== expectedScheduledAt
  ) {
    throw new ReactivationConflictError('invalid_future_dose');
  }
  return {
    patientId,
    doseId: row.id,
    doseDate: row.dose_date,
    localDoseTime: row.local_dose_time,
    scheduleTimezone: row.schedule_timezone,
  };
}

async function compensateSchedulesIfStillDisabled(
  database: Pick<Pool, 'connect'>,
  request: z.output<typeof reactivationRequestSchema>,
  schedules: DoseScheduleRestorer,
): Promise<void> {
  let client: PoolClient;
  try {
    client = await database.connect();
  } catch {
    return;
  }
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const selected = await client.query<PatientRow>(PATIENT_LOCK_SQL, [
      request.patientId,
      request.clinicianSub,
    ]);
    const patient = selected.rows[0];
    if (
      !patient ||
      patient.agent_enabled ||
      patient.messaging_state_version !== request.expectedVersion
    ) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return;
    }
    await lockPatientScheduleMutation(client, request.patientId);
    await schedules.reset(request.patientId);
    await client.query('COMMIT');
    transactionOpen = false;
  } catch {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The patient remains disabled; any residual one-shot is gated at dispatch.
      }
    }
  } finally {
    client.release();
  }
}

/**
 * Restores future dose one-shots while holding the patient row lock, then enables the agent in the
 * same transaction. STOP/START use the same lock, so neither consent nor its version can change
 * between the schedule rebuild and the final update.
 */
export async function reactivatePatient(
  database: Pick<Pool, 'connect'>,
  untrustedRequest: z.input<typeof reactivationRequestSchema>,
  schedules: DoseScheduleRestorer,
): Promise<ReactivationResult> {
  const request = reactivationRequestSchema.parse(untrustedRequest);
  const client = await database.connect();
  let transactionOpen = false;
  let scheduleMutationStarted = false;
  let commitStarted = false;
  let clientReleased = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;

    const selected = await client.query<PatientRow>(PATIENT_LOCK_SQL, [
      request.patientId,
      request.clinicianSub,
    ]);
    const patient = selected.rows[0];
    if (!patient) throw new ReactivationNotFoundError();
    await lockPatientScheduleMutation(client, request.patientId);
    if (patient.messaging_state_version !== request.expectedVersion) {
      throw new ReactivationConflictError('stale_version');
    }
    if (!patient.provider_opted_in) {
      throw new ReactivationConflictError('provider_opted_out');
    }
    if (patient.agent_enabled) {
      throw new ReactivationConflictError('already_enabled');
    }

    const future = await client.query<FutureDoseRow>(ELIGIBLE_FUTURE_DOSES_SQL, [
      request.patientId,
    ]);
    if (future.rows.length === 0) {
      throw new ReactivationConflictError('no_future_doses');
    }
    const restorations = future.rows.map((row) => restorationFor(request.patientId, row));

    try {
      scheduleMutationStarted = true;
      await schedules.reset(request.patientId);
      for (const restoration of restorations) {
        await schedules.create(restoration);
      }
    } catch {
      throw new ReactivationScheduleError();
    }

    const enabled = await client.query<{
      agent_enabled: boolean;
      is_active: boolean;
      messaging_state_version: number;
    }>(ENABLE_PATIENT_SQL, [request.patientId, request.clinicianSub, request.expectedVersion]);
    const enabledPatient = enabled.rows[0];
    if (!enabledPatient?.agent_enabled) {
      throw new ReactivationConflictError('stale_version');
    }

    commitStarted = true;
    await client.query('COMMIT');
    transactionOpen = false;
    return {
      agentEnabled: true,
      isActive: enabledPatient.is_active,
      messagingStateVersion: enabledPatient.messaging_state_version,
      schedulesRestored: restorations.length,
    };
  } catch (error) {
    let rollbackFailed = false;
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        rollbackFailed = true;
      }
    }
    client.release(rollbackFailed);
    clientReleased = true;

    // A failed or response-lost scheduler create may still have committed remotely. Reacquire the
    // patient row and advisory locks on a fresh session before cleanup. If a retry or control change
    // won after rollback (or a failed connection released the original locks), its newer state makes
    // compensation a no-op. Never compensate after COMMIT begins because it may have committed.
    if (scheduleMutationStarted && !commitStarted) {
      await compensateSchedulesIfStillDisabled(database, request, schedules);
    }
    throw error;
  } finally {
    if (!clientReleased) client.release();
  }
}
