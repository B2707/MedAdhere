// Wave 2 (reminder correctness) — live-repair driving tests.
//
// Observed live failure: the patient answered a check-in at 19:21:30Z and a reminder still
// fired at 19:24:45Z — the claim path never consulted whether the patient had replied.
// These tests drive, through the REAL functions (commitPreparedClinicalTurn and the
// prepare/claim reminder repository), the four Wave-2 behaviors:
//   (a) an administration-resolving turn stamps inbound_reply.dose_id INSIDE the commit
//       transaction, and the dose-keyed answered guard consumes the reminder attempt;
//   (b) a content-free reply ("Hello?") is NOT stamped by the dose-keyed answered guard — but
//       (2026-08-17, Lane Q) it now suppresses the reminder anyway, via the broader
//       any-recent-reply presence guard added to close exactly this gap;
//   (c) a check-in older than RESPONSE_WINDOW_MINUTES fails every prepared attempt <=
//       current (draining held/stuck rows) and emits the identifier-free
//       reminder_held_then_reaped metric line;
//   (d) with two same-window doses sharing one prompted dose, the patient-level
//       replied-after-check-in guard covers the second dose on the Scheduler path.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  claimPreparedReminderSend,
  prepareReminderSend,
  reserveReminderSend,
} from './send-repository.js';
import {
  clinicalIntentCommandSchema,
  renderClinicalResponse,
  type ClinicalIntentCommand,
  type PatientClinicalMemory,
  type PreparedClinicalTurn,
} from '../conversation/clinical-memory/index.js';
import { sha256 } from '../conversation/clinical-memory/hash.js';
import {
  commitPreparedClinicalTurn,
  loadPatientClinicalMemory,
} from '../conversation/clinical-memory/repository.js';

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema-init', 'schema.sql'), 'utf8');
const CONTAINER_TIMEOUT_MS = 180_000;
const OWNER_SUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTEXT_HASH = 'a'.repeat(64);
const PIPELINE_VERSIONS = {
  extractor: 'extractor-v1',
  resolver: 'resolver-v1',
  reducer: 'reducer-v1',
  renderer: 'renderer-v2',
} as const;
const REMINDER_BODY = 'Just a gentle reminder to reply when you can about your medication.';
const RESPONSE_WINDOW_MINUTES = 120;

let container: StartedPostgreSqlContainer | undefined;
let pool: Pool;
let phoneCounter = 0;

interface SeededPatient {
  readonly id: string;
  readonly phone: string;
  readonly messagingStateVersion: number;
}

interface SeededTurn {
  readonly patientId: string;
  readonly inboundMessageId: string;
  readonly turnJobId: string;
  readonly sequence: number;
  readonly body: string;
  readonly messagingStateVersion: number;
}

async function seedPatient(): Promise<SeededPatient> {
  phoneCounter += 1;
  const phone = `+1500999${String(phoneCounter).padStart(4, '0')}`;
  const result = await pool.query<{ id: string; messaging_state_version: number }>(
    `INSERT INTO patient
       (phone, medication_name, owner_clinician_sub, timezone, is_test)
     VALUES ($1, 'wave2 test medication', $2, 'America/Toronto', true)
     RETURNING id::text, messaging_state_version`,
    [phone, OWNER_SUB],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('patient_seed_failed');
  return { id: row.id, phone, messagingStateVersion: row.messaging_state_version };
}

async function seedMedication(patientId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO patient_medication
       (patient_id, entered_name, identity_system, identity_code, dose_text, valid_from,
        status, confirmed_by_clinician_sub, confirmed_at)
     VALUES ($1, 'Metformin', 'rxnorm', '6809', '500 mg', '2026-08-01',
             'active', $2, '2026-08-01T12:00:00Z')
     RETURNING id::text`,
    [patientId, OWNER_SUB],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('medication_seed_failed');
  return id;
}

interface SeededDose {
  readonly id: string;
  readonly localDate: string;
  readonly localTime: string;
}

/** A recent dose whose scheduled_at, dose_date, and local_dose_time are mutually consistent. */
async function seedDose(
  patientId: string,
  medicationId: string,
  minutesAgo: number,
): Promise<SeededDose> {
  const result = await pool.query<{ id: string; dose_date: string; local_dose_time: string }>(
    `INSERT INTO dose_schedule
       (patient_id, patient_medication_id, scheduled_at, local_dose_time,
        dose_date, schedule_timezone)
     SELECT $1, $2, ts,
            to_char(ts at time zone 'America/Toronto', 'HH24:MI'),
            (ts at time zone 'America/Toronto')::date,
            'America/Toronto'
       FROM (SELECT date_trunc('minute', now() - make_interval(mins => $3)) AS ts) AS anchor
     RETURNING id::text, dose_date::text, local_dose_time::text`,
    [patientId, medicationId, minutesAgo],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('dose_seed_failed');
  return { id: row.id, localDate: row.dose_date, localTime: row.local_dose_time.slice(0, 5) };
}

async function seedSentCheckIn(
  patientId: string,
  doseId: string,
  ageMinutes: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO outbound_message
       (patient_id, dose_id, status, body, message_kind, twilio_sid, sent_at)
     VALUES ($1, $2, 'queued', 'Initial medication check-in', 'check_in', $3,
             now() - make_interval(mins => $4))`,
    [patientId, doseId, `SM${randomUUID().replaceAll('-', '')}`, ageMinutes],
  );
}

/** Inbound arrives AFTER every seeded check-in (received_at anchored just past now()). */
async function seedTurn(
  patient: SeededPatient,
  sequence: number,
  body: string,
): Promise<SeededTurn> {
  const inbound = await pool.query<{ id: string }>(
    `INSERT INTO inbound_reply (patient_id, raw_body, inbound_sequence, received_at)
     VALUES ($1, $2, $3, now() + ($4::int * interval '1 second'))
     RETURNING id::text`,
    [patient.id, body, sequence, sequence],
  );
  const inboundMessageId = inbound.rows[0]?.id;
  if (inboundMessageId === undefined) throw new Error('inbound_seed_failed');
  const job = await pool.query<{ id: string }>(
    `INSERT INTO turn_job
       (patient_id, inbound_message_id, inbound_sequence, messaging_state_version,
        clinical_context_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id::text`,
    [patient.id, inboundMessageId, sequence, patient.messagingStateVersion, CONTEXT_HASH],
  );
  const turnJobId = job.rows[0]?.id;
  if (turnJobId === undefined) throw new Error('turn_job_seed_failed');
  return {
    patientId: patient.id,
    inboundMessageId,
    turnJobId,
    sequence,
    body,
    messagingStateVersion: patient.messagingStateVersion,
  };
}

function prepareCommands(
  memory: PatientClinicalMemory,
  turn: SeededTurn,
  commands: readonly ClinicalIntentCommand[],
): PreparedClinicalTurn {
  const responsePlan = {
    kind: 'routine',
    acknowledgementId: 'acknowledgement-recorded',
    reviewReasons: [],
  } as const;
  const integrity = {
    patientId: turn.patientId,
    idempotencyKey: turn.inboundMessageId,
    sourceMessageId: turn.inboundMessageId,
    sourceSequence: turn.sequence,
    baseMemoryVersion: memory.version,
    consentEpoch: turn.messagingStateVersion,
    contextHash: CONTEXT_HASH,
    pipelineVersions: PIPELINE_VERSIONS,
    commands,
    commandHash: sha256(commands),
    responsePlan,
    responseText: renderClinicalResponse(responsePlan),
  };
  return { ...integrity, preparedHash: sha256(integrity) };
}

function administrationCommand(
  turn: SeededTurn,
  medicationId: string,
  dose: SeededDose,
  quote: string,
): ClinicalIntentCommand {
  const start = turn.body.indexOf(quote);
  if (start < 0) throw new Error('test_source_quote_missing');
  const intent = {
    kind: 'CreateReport' as const,
    sourceMessageId: turn.inboundMessageId,
    sourceSpans: [{ messageId: turn.inboundMessageId, start, end: start + quote.length, quote }],
    eventKind: 'administration' as const,
    medicationId,
    medicationVersion: 1,
    doseId: dose.id,
    doseVersion: 1,
    adherence: 'taken' as const,
    timing: 'on_time' as const,
    localDate: dose.localDate,
    localTime: dose.localTime,
  };
  return clinicalIntentCommandSchema.parse({
    ...intent,
    id: `command-${sha256(intent).slice(0, 24)}`,
  });
}

async function commitTurn(
  turn: SeededTurn,
  commands: readonly ClinicalIntentCommand[],
): Promise<void> {
  const memory = await loadPatientClinicalMemory(pool, turn.patientId);
  const prepared = prepareCommands(memory, turn, commands);
  await commitPreparedClinicalTurn(pool, prepared, async () => prepared.contextHash);
}

async function completeJob(turnJobId: string): Promise<void> {
  const completed = await pool.query(
    `UPDATE turn_job SET completed_at = now() WHERE id = $1 AND completed_at IS NULL`,
    [turnJobId],
  );
  expect(completed.rowCount).toBe(1);
}

async function stampedDoseId(inboundMessageId: string): Promise<string | null> {
  const result = await pool.query<{ dose_id: string | null }>(
    'SELECT dose_id::text FROM inbound_reply WHERE id = $1',
    [inboundMessageId],
  );
  return result.rows[0]?.dose_id ?? null;
}

async function reminderAttempts(
  patientId: string,
  doseId: string,
): Promise<ReadonlyArray<{ reminder_attempt: number; status: string }>> {
  const result = await pool.query<{ reminder_attempt: number; status: string }>(
    `SELECT reminder_attempt, status
       FROM outbound_message
      WHERE patient_id = $1 AND dose_id = $2 AND message_kind = 'reminder'
      ORDER BY reminder_attempt`,
    [patientId, doseId],
  );
  return result.rows;
}

async function doseKeyedGuardCounts(
  patientId: string,
  doseId: string,
): Promise<{ inboundReplies: string; adherenceRecords: string; clinicalEvents: string }> {
  const result = await pool.query<{
    inbound_replies: string;
    adherence_records: string;
    clinical_events: string;
  }>(
    `SELECT
       (SELECT count(*) FROM inbound_reply
         WHERE patient_id = $1 AND dose_id = $2)::text AS inbound_replies,
       (SELECT count(*) FROM adherence_record
         WHERE patient_id = $1 AND dose_id = $2)::text AS adherence_records,
       (SELECT count(*) FROM clinical_event
         WHERE patient_id = $1 AND dose_id = $2)::text AS clinical_events`,
    [patientId, doseId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('guard_count_query_failed');
  return {
    inboundReplies: row.inbound_replies,
    adherenceRecords: row.adherence_records,
    clinicalEvents: row.clinical_events,
  };
}

beforeAll(async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl) {
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
  } else {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 8 });
  }
  await pool.query(SCHEMA_SQL);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('Wave 2 reminder correctness against PostgreSQL 16', () => {
  it('(a) stamps inbound_reply.dose_id inside the turn commit and the answered-dose guard consumes the attempt', async () => {
    const patient = await seedPatient();
    const medicationId = await seedMedication(patient.id);
    const dose = await seedDose(patient.id, medicationId, 10);
    await seedSentCheckIn(patient.id, dose.id, 5);
    const turn = await seedTurn(patient, 1, 'I took my morning dose.');

    await commitTurn(turn, [
      administrationCommand(turn, medicationId, dose, 'I took my morning dose'),
    ]);

    // The stamp happened INSIDE the patient-locked turn-commit transaction, with answered
    // semantics: this reply resolved an administration for exactly this dose.
    await expect(stampedDoseId(turn.inboundMessageId)).resolves.toBe(dose.id);

    await completeJob(turn.turnJobId);

    await expect(
      reserveReminderSend(
        pool,
        { patientId: patient.id, doseId: dose.id, reminderAttempt: 1 },
        REMINDER_BODY,
      ),
    ).resolves.toBeNull();

    // WHICH guard: the dose-keyed answered guards (stamped inbound_reply + the Wave-0
    // clinical_event dose link) are present for this dose, so the claim's terminal drain
    // consumed the exact prepared attempt as 'failed' — nothing is left claimable or held.
    const guards = await doseKeyedGuardCounts(patient.id, dose.id);
    expect(guards.inboundReplies).toBe('1');
    expect(guards.clinicalEvents).toBe('1');
    await expect(reminderAttempts(patient.id, dose.id)).resolves.toEqual([
      { reminder_attempt: 1, status: 'failed' },
    ]);
  });

  it('(b) leaves a content-free reply unstamped, but Lane Q suppresses the reminder anyway — the patient just texted', async () => {
    const patient = await seedPatient();
    const medicationId = await seedMedication(patient.id);
    const dose = await seedDose(patient.id, medicationId, 10);
    await seedSentCheckIn(patient.id, dose.id, 5);
    const turn = await seedTurn(patient, 1, 'Hello?');

    // A completed turn with no clinical commands: nothing was answered.
    await commitTurn(turn, []);
    await expect(stampedDoseId(turn.inboundMessageId)).resolves.toBeNull();
    await completeJob(turn.turnJobId);

    // The dose-keyed answered guard does not fire (nothing was stamped) — but (2026-08-17,
    // Lane Q) the patient replied moments ago, so the broader any-recent-reply presence guard
    // suppresses the reminder anyway: terminal ('failed'), never sent, never held for a retry.
    await expect(
      reserveReminderSend(
        pool,
        { patientId: patient.id, doseId: dose.id, reminderAttempt: 1 },
        REMINDER_BODY,
      ),
    ).resolves.toBeNull();
    await expect(reminderAttempts(patient.id, dose.id)).resolves.toEqual([
      { reminder_attempt: 1, status: 'failed' },
    ]);
  });

  it('(c) fails every prepared attempt <= current for a stale check-in and emits the identifier-free reap metric', async () => {
    const patient = await seedPatient();
    const medicationId = await seedMedication(patient.id);
    const dose = await seedDose(patient.id, medicationId, 10);
    await seedSentCheckIn(patient.id, dose.id, RESPONSE_WINDOW_MINUTES + 1);
    // A turn that never completes was holding the prepared attempts (turn-commit failure).
    await seedTurn(patient, 1, 'held forever');

    await expect(
      prepareReminderSend(
        pool,
        { patientId: patient.id, doseId: dose.id, reminderAttempt: 1 },
        REMINDER_BODY,
      ),
    ).resolves.toBe(true);
    await expect(
      prepareReminderSend(
        pool,
        { patientId: patient.id, doseId: dose.id, reminderAttempt: 2 },
        REMINDER_BODY,
      ),
    ).resolves.toBe(true);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let loggedLines: readonly string[];
    try {
      await expect(
        claimPreparedReminderSend(pool, {
          patientId: patient.id,
          doseId: dose.id,
          reminderAttempt: 1,
        }),
      ).resolves.toBeNull();
      loggedLines = logSpy.mock.calls.map(([entry]) => String(entry));
    } finally {
      logSpy.mockRestore();
    }

    // WHICH guard: the age bound (sent_at outside RESPONSE_WINDOW_MINUTES). It consumed
    // ALL prepared attempts <= current — current is the max-prepared attempt (2), not the
    // requested attempt (1) — draining the stuck rows.
    await expect(reminderAttempts(patient.id, dose.id)).resolves.toEqual([
      { reminder_attempt: 1, status: 'failed' },
      { reminder_attempt: 2, status: 'failed' },
    ]);

    const line = loggedLines.find((entry) => entry.includes('reminder_held_then_reaped'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toEqual({
      metric: 'reminder_held_then_reaped',
      reapedCount: 2,
      reminderAttempt: 2,
    });
    // Identifier-free: no patient id, dose id, or phone number in the metric line.
    expect(line).not.toContain(patient.id);
    expect(line).not.toContain(dose.id);
    expect(line).not.toContain(patient.phone.slice(1));
  });

  it('(d) blocks the second same-window dose on the Scheduler path via the patient-level replied-after-check-in guard', async () => {
    const patient = await seedPatient();
    const medicationId = await seedMedication(patient.id);
    const promptedDose = await seedDose(patient.id, medicationId, 10);
    const secondDose = await seedDose(patient.id, medicationId, 9);
    await seedSentCheckIn(patient.id, promptedDose.id, 6);
    await seedSentCheckIn(patient.id, secondDose.id, 5);

    // One shared reply resolves an administration for the prompted dose only.
    const turn = await seedTurn(patient, 1, 'I took my meds.');
    await commitTurn(turn, [
      administrationCommand(turn, medicationId, promptedDose, 'I took my meds'),
    ]);
    await expect(stampedDoseId(turn.inboundMessageId)).resolves.toBe(promptedDose.id);
    await completeJob(turn.turnJobId);

    // Scheduler path for the SECOND dose: the one-shot invokes prepare+claim directly and
    // never consults findDeferredReminders.
    await expect(
      reserveReminderSend(
        pool,
        { patientId: patient.id, doseId: secondDose.id, reminderAttempt: 1 },
        REMINDER_BODY,
      ),
    ).resolves.toBeNull();

    // WHICH guard: every dose-keyed guard is absent for the second dose and the turn is
    // complete (so the incomplete-turn hold cannot be the blocker) — only the patient-level
    // replied-after-check-in guard (an answered inbound after this check-in) fired.
    // RECORDED RESIDUAL (accepted design): this blast radius is every same-window medication —
    // with N concurrent medications prompted together, answering ONE terminalizes the nudges
    // for the other N-1. The guard is scoped to answered doses whose OWN check-in is inside the
    // live response window, so a backdated answer can never widen it further (test (e)).
    await expect(doseKeyedGuardCounts(patient.id, secondDose.id)).resolves.toEqual({
      inboundReplies: '0',
      adherenceRecords: '0',
      clinicalEvents: '0',
    });
    const incomplete = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM turn_job
        WHERE patient_id = $1 AND completed_at IS NULL`,
      [patient.id],
    );
    expect(incomplete.rows[0]?.count).toBe('0');

    // The answered patient is terminal for the attempt: consumed as 'failed', never held.
    await expect(reminderAttempts(patient.id, secondDose.id)).resolves.toEqual([
      { reminder_attempt: 1, status: 'failed' },
    ]);
  });

  it('(e) an answer about a backdated dose does NOT dose-keyed-block the live reminder, but Lane Q still suppresses it — a reply just arrived', async () => {
    const patient = await seedPatient();
    const medicationId = await seedMedication(patient.id);
    // A dose from three days ago whose check-in window is long closed.
    const backdatedDose = await seedDose(patient.id, medicationId, 3 * 24 * 60);
    await seedSentCheckIn(patient.id, backdatedDose.id, 3 * 24 * 60 - 5);
    // Tonight's live dose, prompted five minutes ago and never answered.
    const liveDose = await seedDose(patient.id, medicationId, 10);
    await seedSentCheckIn(patient.id, liveDose.id, 5);

    // The reply resolves an administration for the BACKDATED dose only.
    const turn = await seedTurn(patient, 1, 'I took my dose three days ago.');
    await commitTurn(turn, [
      administrationCommand(turn, medicationId, backdatedDose, 'I took my dose three days ago'),
    ]);
    await expect(stampedDoseId(turn.inboundMessageId)).resolves.toBe(backdatedDose.id);
    await completeJob(turn.turnJobId);

    // The live dose was never addressed: no dose-keyed guard exists for it, and the dose-keyed
    // answered guard must not fire because the answered dose's own check-in is OUTSIDE the live
    // window — this narrow point is unchanged.
    await expect(doseKeyedGuardCounts(patient.id, liveDose.id)).resolves.toEqual({
      inboundReplies: '0',
      adherenceRecords: '0',
      clinicalEvents: '0',
    });
    // But (2026-08-17, Lane Q) the patient DID just text, about anything — the broader
    // any-recent-reply presence guard suppresses the live dose's reminder regardless of which
    // dose (or none) that reply addressed.
    await expect(
      reserveReminderSend(
        pool,
        { patientId: patient.id, doseId: liveDose.id, reminderAttempt: 1 },
        REMINDER_BODY,
      ),
    ).resolves.toBeNull();
    await expect(reminderAttempts(patient.id, liveDose.id)).resolves.toEqual([
      { reminder_attempt: 1, status: 'failed' },
    ]);
  });

  it('(f) an incomplete turn holds the prepared attempt and emits the identifier-free held metric', async () => {
    const patient = await seedPatient();
    const medicationId = await seedMedication(patient.id);
    const dose = await seedDose(patient.id, medicationId, 10);
    await seedSentCheckIn(patient.id, dose.id, 5);
    // An inbound whose turn never completes (turn-commit failure) — H-04 holds the attempt.
    await seedTurn(patient, 1, 'on my way');

    await expect(
      prepareReminderSend(
        pool,
        { patientId: patient.id, doseId: dose.id, reminderAttempt: 1 },
        REMINDER_BODY,
      ),
    ).resolves.toBe(true);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let loggedLines: readonly string[];
    try {
      await expect(
        claimPreparedReminderSend(pool, {
          patientId: patient.id,
          doseId: dose.id,
          reminderAttempt: 1,
        }),
      ).resolves.toBeNull();
      loggedLines = logSpy.mock.calls.map(([entry]) => String(entry));
    } finally {
      logSpy.mockRestore();
    }

    // Held, not consumed: the attempt stays 'prepared' for the worker's post-turn release. If
    // the holding turn never completes, no caller arrives after expiry to reap, so this held
    // line is the only visibility for silent non-nudging.
    await expect(reminderAttempts(patient.id, dose.id)).resolves.toEqual([
      { reminder_attempt: 1, status: 'prepared' },
    ]);
    const line = loggedLines.find((entry) => entry.includes('reminder_attempt_held'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toEqual({ metric: 'reminder_attempt_held', reminderAttempt: 1 });
    // Identifier-free: no patient id, dose id, or phone number in the metric line.
    expect(line).not.toContain(patient.id);
    expect(line).not.toContain(dose.id);
    expect(line).not.toContain(patient.phone.slice(1));
  });

  it('(g) rejects loudly when RESPONSE_WINDOW_MINUTES is malformed instead of silently reaping', async () => {
    const previous = process.env.RESPONSE_WINDOW_MINUTES;
    process.env.RESPONSE_WINDOW_MINUTES = 'not-a-number';
    try {
      await expect(
        claimPreparedReminderSend(pool, {
          patientId: randomUUID(),
          doseId: randomUUID(),
          reminderAttempt: 1,
        }),
      ).rejects.toThrow('response_window_minutes_invalid');
    } finally {
      if (previous === undefined) delete process.env.RESPONSE_WINDOW_MINUTES;
      else process.env.RESPONSE_WINDOW_MINUTES = previous;
    }
  });
});
