import type { Pool, PoolClient } from 'pg';
import type { SafetyCategory } from '@medadhere/shared';
import { lockPatientScheduleMutation } from '../lib/patient-schedule-lock';

export interface ReserveInboundIntakeInput {
  readonly phone: string;
  readonly rawBody: string;
  readonly emergencyCategory: SafetyCategory | null;
  readonly messageSid: string;
  readonly createTurnJob: boolean;
  readonly control: 'stop' | 'start' | 'help' | null;
}

export type ReserveInboundIntakeResult =
  | {
      readonly kind: 'unmatched';
      readonly matchCount: number;
    }
  | {
      readonly kind: 'new' | 'duplicate';
      readonly patientId: string;
      readonly inboundMessageId: string;
      readonly inboundSequence: number;
      readonly shouldEnqueue: boolean;
      readonly shouldSweepSchedules: boolean;
      readonly preferredLanguage: string;
      /** Present only when this reservation atomically created the prefilter alert. */
      readonly safetyEventId?: string;
      /** Set when intake capacity refuses a reply/model path. 'notice' is the single reply. */
      readonly rateLimited?: 'notice' | 'silent';
    };

// M-04 locked capacities. limit_units is stored one above each limit: that extra slot is the
// notice slot, so the message that lands in it is the one over-limit reply for the window and
// every later message finds the slot taken and is stored silently.
const BURST_LIMIT = 20;
const BURST_WINDOW = '10 minutes';
const DAY_LIMIT = 50;

interface DuplicateRow {
  readonly id: string;
  readonly patient_id: string;
  readonly inbound_sequence: string | number | null;
  readonly enqueued_at: Date | string | null;
  readonly has_turn_job: boolean;
  readonly completed: boolean;
  readonly original_control: 'stop' | 'start' | 'help' | null;
  readonly control_messaging_state_version: number | null;
}

const DUPLICATE_LOOKUP_SQL = `SELECT ir.id,
       ir.patient_id,
       ir.inbound_sequence,
       ir.enqueued_at,
       ir.original_control,
       ir.control_messaging_state_version,
       (tj.id IS NOT NULL) AS has_turn_job,
       (tj.completed_at IS NOT NULL OR atn.id IS NOT NULL) AS completed
  FROM inbound_reply ir
  LEFT JOIN turn_job tj
    ON tj.patient_id = ir.patient_id AND tj.inbound_message_id = ir.id
  LEFT JOIN agent_turn atn
    ON atn.patient_id = ir.patient_id AND atn.inbound_message_id = ir.id
 WHERE ir.twilio_message_sid = $1`;

const CURRENT_PATIENT_SQL = `SELECT id, timezone, preferred_language, messaging_state_version
     FROM patient
    WHERE phone = $1
      AND is_active = true
      AND ($2::boolean OR (agent_enabled = true AND provider_opted_in = true))
    FOR UPDATE`;

// H-05: an exact signed STOP/START must still reach its patient after the record was retired,
// because opting out can never depend on the agent being active. It runs only when no active
// record answers and still demands exactly one row, so a phone shared by two retired records
// fails closed rather than guessing which consent to change.
const RETIRED_CONSENT_PATIENT_SQL = `SELECT id, timezone, preferred_language, messaging_state_version
     FROM patient
    WHERE phone = $1
      AND is_active = false
    FOR UPDATE`;

// One statement opens or advances both windows under the patient lock already held. A bucket
// already sitting in its notice slot is skipped by the DO UPDATE guard and returns no row.
const CONSUME_INTAKE_CAPACITY_SQL = `INSERT INTO usage_bucket
     (bucket_scope, subject_key, patient_id, window_start, window_end, limit_units, consumed_units)
   SELECT spec.scope, $1::text, $1::uuid, spec.window_start, spec.window_end, spec.limit_units, 1
     FROM (VALUES
       ('patient_burst',
        date_bin($2::interval, now(), timestamptz 'epoch'),
        date_bin($2::interval, now(), timestamptz 'epoch') + $2::interval,
        $3::integer),
       ('patient_day',
        date_trunc('day', now() AT TIME ZONE $4::text) AT TIME ZONE $4::text,
        (date_trunc('day', now() AT TIME ZONE $4::text) + interval '1 day') AT TIME ZONE $4::text,
        $5::integer)
     ) AS spec(scope, window_start, window_end, limit_units)
   ON CONFLICT (bucket_scope, subject_key, window_start)
   DO UPDATE SET consumed_units = usage_bucket.consumed_units + 1, updated_at = now()
     WHERE usage_bucket.consumed_units < usage_bucket.limit_units
   RETURNING bucket_scope, consumed_units, limit_units`;

interface CapacityRow {
  readonly consumed_units: number;
  readonly limit_units: number;
}

/** Both windows had room -> ok. The message that fills a notice slot -> notice. Otherwise silent. */
function readIntakeCapacity(rows: readonly CapacityRow[]): 'ok' | 'notice' | 'silent' {
  const filledNoticeSlot = rows.some(
    (row) => Number(row.consumed_units) >= Number(row.limit_units),
  );
  if (filledNoticeSlot) return 'notice';
  return rows.length === 2 ? 'ok' : 'silent';
}

function isConsentControl(control: ReserveInboundIntakeInput['control']): boolean {
  return control === 'stop' || control === 'start';
}

function parseSequence(value: string | number | null): number {
  const sequence = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('stored inbound sequence is missing or invalid');
  }
  return sequence;
}

function duplicateResult(
  row: DuplicateRow,
  expectedPatientId: string,
  preferredLanguage: string,
  currentMessagingStateVersion: number,
): ReserveInboundIntakeResult {
  if (row.patient_id !== expectedPatientId) {
    throw new Error('MessageSid is already assigned to another patient');
  }
  return {
    kind: 'duplicate',
    patientId: row.patient_id,
    inboundMessageId: row.id,
    inboundSequence: parseSequence(row.inbound_sequence),
    shouldEnqueue: row.enqueued_at === null && row.has_turn_job && !row.completed,
    shouldSweepSchedules:
      row.original_control === 'stop' &&
      row.control_messaging_state_version === currentMessagingStateVersion,
    preferredLanguage,
  };
}

async function applyControlState(
  client: Pick<PoolClient, 'query'>,
  patientId: string,
  control: ReserveInboundIntakeInput['control'],
): Promise<void> {
  if (control === 'stop') {
    await client.query(
      `UPDATE patient
          SET provider_opted_in = false,
              agent_enabled = false,
              messaging_state_version = messaging_state_version + 1,
              opted_out_at = COALESCE(opted_out_at, CURRENT_TIMESTAMP)
        WHERE id = $1`,
      [patientId],
    );
    return;
  }
  if (control === 'start') {
    await client.query(
      `UPDATE patient
          SET provider_opted_in = true,
              opted_out_at = NULL,
              messaging_state_version = messaging_state_version + 1
        WHERE id = $1`,
      [patientId],
    );
  }
}

async function findDuplicate(
  client: Pick<PoolClient, 'query'>,
  messageSid: string,
): Promise<DuplicateRow | undefined> {
  const result = await client.query<DuplicateRow>(DUPLICATE_LOOKUP_SQL, [messageSid]);
  return result.rows[0];
}

const LOCK_STOP_SWEEP_SQL = `SELECT p.messaging_state_version,
       ir.original_control,
       ir.control_messaging_state_version
  FROM patient p
  JOIN inbound_reply ir
    ON ir.patient_id = p.id
   AND ir.id = $2
 WHERE p.id = $1
 FOR UPDATE OF p`;

/**
 * Runs one STOP cleanup only while its durable control epoch is still current. The patient row and
 * patient-scoped advisory lock remain held through every external Scheduler deletion, so START and
 * doctor reactivation cannot cross a cleanup that was authorized before either state transition.
 */
export async function sweepStopSchedulesUnderCurrentEpoch(
  pool: Pool,
  input: { readonly patientId: string; readonly inboundMessageId: string },
  sweep: () => Promise<void>,
): Promise<boolean> {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const selected = await client.query<{
      messaging_state_version: number;
      original_control: string | null;
      control_messaging_state_version: number | null;
    }>(LOCK_STOP_SWEEP_SQL, [input.patientId, input.inboundMessageId]);
    const row = selected.rows[0];
    if (!row) {
      await client.query('COMMIT');
      transactionOpen = false;
      return false;
    }
    await lockPatientScheduleMutation(client, input.patientId);
    const authorized =
      row.original_control === 'stop' &&
      row.control_messaging_state_version === row.messaging_state_version;
    if (!authorized) {
      await client.query('COMMIT');
      transactionOpen = false;
      return false;
    }
    await sweep();
    await client.query('COMMIT');
    transactionOpen = false;
    return true;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the Scheduler or database error; pg discards a broken pooled client.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Stores one authenticated Twilio message under the patient row lock. The sequence counter,
 * inbound row, optional safety alert, and optional queue job commit together; SQS handoff happens
 * later.
 */
export async function reserveInboundIntake(
  pool: Pool,
  input: ReserveInboundIntakeInput,
): Promise<ReserveInboundIntakeResult> {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;

    type PatientRow = {
      readonly id: string;
      readonly timezone: string;
      readonly preferred_language: string;
      readonly messaging_state_version: number;
    };
    let patientRows = (
      await client.query<PatientRow>(CURRENT_PATIENT_SQL, [
        input.phone,
        input.control !== null || input.emergencyCategory !== null,
      ])
    ).rows;
    if (patientRows.length === 0 && isConsentControl(input.control)) {
      patientRows = (await client.query<PatientRow>(RETIRED_CONSENT_PATIENT_SQL, [input.phone]))
        .rows;
    }
    if (patientRows.length !== 1) {
      await client.query('COMMIT');
      transactionOpen = false;
      return { kind: 'unmatched', matchCount: patientRows.length };
    }
    const patient = patientRows[0]!;
    const patientId = patient.id;

    const duplicate = await findDuplicate(client, input.messageSid);
    if (duplicate) {
      await client.query('COMMIT');
      transactionOpen = false;
      return duplicateResult(
        duplicate,
        patientId,
        patient.preferred_language,
        patient.messaging_state_version,
      );
    }

    const allocated = await client.query<{ inbound_sequence: string | number }>(
      `UPDATE patient
          SET next_inbound_sequence = next_inbound_sequence + 1
        WHERE id = $1
        RETURNING next_inbound_sequence - 1 AS inbound_sequence`,
      [patientId],
    );
    const inboundSequence = parseSequence(allocated.rows[0]?.inbound_sequence ?? null);

    const controlMessagingStateVersion = isConsentControl(input.control)
      ? patient.messaging_state_version + 1
      : null;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO inbound_reply
         (patient_id, raw_body, safety_flagged, twilio_message_sid, inbound_sequence,
          original_control, control_messaging_state_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (twilio_message_sid) WHERE twilio_message_sid IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        patientId,
        input.rawBody,
        input.emergencyCategory !== null,
        input.messageSid,
        inboundSequence,
        input.control,
        controlMessagingStateVersion,
      ],
    );
    const inboundMessageId = inserted.rows[0]?.id;
    if (!inboundMessageId) {
      // A different-patient transaction can race the global SID arbiter because the patient locks
      // differ. Roll back the counter allocation, then read the committed winner.
      await client.query('ROLLBACK');
      transactionOpen = false;
      const winner = await findDuplicate(client, input.messageSid);
      if (!winner) throw new Error('MessageSid conflict winner is missing');
      return duplicateResult(
        winner,
        patientId,
        patient.preferred_language,
        patient.messaging_state_version,
      );
    }

    let safetyEventId: string | undefined;
    if (input.emergencyCategory !== null) {
      const alert = await client.query<{ id: string }>(
        `INSERT INTO safety_events
           (patient_id, inbound_message_id, flag_category, trigger_source)
         VALUES ($1, $2, $3, 'prefilter')
         RETURNING id`,
        [patientId, inboundMessageId, input.emergencyCategory],
      );
      safetyEventId = alert.rows[0]?.id;
      if (!safetyEventId) throw new Error('safety event insert returned no id');
    }

    // Every ordinary text/media intake consumes capacity. Controls and deterministic emergencies
    // remain exempt even though all three paths intentionally skip model work.
    let rateLimited: 'notice' | 'silent' | undefined;
    if (input.control === null && input.emergencyCategory === null) {
      const capacity = await client.query<CapacityRow>(CONSUME_INTAKE_CAPACITY_SQL, [
        patientId,
        BURST_WINDOW,
        BURST_LIMIT + 1,
        patient.timezone,
        DAY_LIMIT + 1,
      ]);
      const verdict = readIntakeCapacity(capacity.rows);
      if (verdict === 'ok') {
        if (input.createTurnJob) {
          await client.query(
            `INSERT INTO turn_job
               (patient_id, inbound_message_id, inbound_sequence, messaging_state_version)
             VALUES ($1, $2, $3, $4)`,
            [patientId, inboundMessageId, inboundSequence, patient.messaging_state_version],
          );
        }
      } else {
        rateLimited = verdict;
      }
    }

    await applyControlState(client, patientId, input.control);

    await client.query('COMMIT');
    transactionOpen = false;
    return {
      kind: 'new',
      patientId,
      inboundMessageId,
      inboundSequence,
      shouldEnqueue: input.createTurnJob && rateLimited === undefined,
      shouldSweepSchedules: input.control === 'stop',
      preferredLanguage: patient.preferred_language,
      ...(safetyEventId ? { safetyEventId } : {}),
      rateLimited,
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original intake failure; the pool discards a broken client connection.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Called only after SQS confirms the wake handoff. COALESCE makes duplicate stamp attempts safe. */
export async function markInboundEnqueued(pool: Pool, inboundMessageId: string): Promise<void> {
  const result = await pool.query(
    `UPDATE inbound_reply
        SET enqueued_at = COALESCE(enqueued_at, now())
      WHERE id = $1
      RETURNING enqueued_at`,
    [inboundMessageId],
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new Error('inbound row missing before enqueue stamp');
  }
}
