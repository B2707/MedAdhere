// Lane Q (2026-08-17 live incident) — REMINDER SUPPRESSION driving tests.
//
// Observed live failure: a scheduled reminder ("Just a gentle reminder…") fired at 19:24:56Z,
// 12 minutes after the patient's last inbound text — nagging mid-conversation while the patient
// was actively engaged. The claim path already suppresses a reminder when a reply resolved THIS
// dose specifically (Wave 2); this closes the broader gap — ANY inbound reply (any dose, even
// unclassified) within the last hour means the patient is present, so the nudge is redundant.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { claimPreparedReminderSend, prepareReminderSend } from './send-repository.js';

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema-init', 'schema.sql'), 'utf8');
const CONTAINER_TIMEOUT_MS = 180_000;
const OWNER_SUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REMINDER_BODY = 'Just a gentle reminder to reply when you can about your medication.';

let container: StartedPostgreSqlContainer | undefined;
let pool: Pool;
let phoneCounter = 0;
let sequenceCounter = 0;

interface SeededPatient {
  readonly id: string;
}

interface SeededDose {
  readonly id: string;
}

async function seedPatient(): Promise<SeededPatient> {
  phoneCounter += 1;
  const phone = `+1500998${String(phoneCounter).padStart(4, '0')}`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO patient
       (phone, medication_name, owner_clinician_sub, timezone, is_test)
     VALUES ($1, 'suppression test medication', $2, 'America/Toronto', true)
     RETURNING id::text`,
    [phone, OWNER_SUB],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('patient_seed_failed');
  return { id: row.id };
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

async function seedDose(
  patientId: string,
  medicationId: string,
  minutesAgo: number,
): Promise<SeededDose> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO dose_schedule
       (patient_id, patient_medication_id, scheduled_at, local_dose_time,
        dose_date, schedule_timezone)
     SELECT $1, $2, ts,
            to_char(ts at time zone 'America/Toronto', 'HH24:MI'),
            (ts at time zone 'America/Toronto')::date,
            'America/Toronto'
       FROM (SELECT date_trunc('minute', now() - make_interval(mins => $3)) AS ts) AS anchor
     RETURNING id::text`,
    [patientId, medicationId, minutesAgo],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('dose_seed_failed');
  return { id };
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
    [patientId, doseId, `SM${Math.random().toString(16).slice(2)}`, ageMinutes],
  );
}

/** A bare inbound_reply row, unattached to any dose — the broad "patient is present" signal. */
async function seedInboundReply(patientId: string, minutesAgo: number): Promise<void> {
  sequenceCounter += 1;
  await pool.query(
    `INSERT INTO inbound_reply (patient_id, raw_body, inbound_sequence, received_at)
     VALUES ($1, 'unrelated chitchat', $2, now() - make_interval(mins => $3))`,
    [patientId, sequenceCounter, minutesAgo],
  );
}

async function reminderStatus(patientId: string, doseId: string): Promise<string | undefined> {
  const result = await pool.query<{ status: string }>(
    `SELECT status FROM outbound_message
      WHERE patient_id = $1 AND dose_id = $2 AND message_kind = 'reminder' AND reminder_attempt = 1`,
    [patientId, doseId],
  );
  return result.rows[0]?.status;
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

describe('Lane Q reminder suppression against PostgreSQL 16', () => {
  it('suppresses a due reminder when the patient replied (any dose) within the last 60 minutes, terminal — no reschedule storm', async () => {
    const patient = await seedPatient();
    const medicationId = await seedMedication(patient.id);
    const dose = await seedDose(patient.id, medicationId, 25);
    await seedSentCheckIn(patient.id, dose.id, 20);
    // Present and engaged: a reply arrived 12 minutes ago — AFTER this check-in went out,
    // unrelated to this dose entirely.
    await seedInboundReply(patient.id, 12);

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

    // Terminal ('failed'), not 'prepared' — no later invocation can resend it (no storm).
    await expect(reminderStatus(patient.id, dose.id)).resolves.toBe('failed');

    const line = loggedLines.find((entry) => entry.includes('reminder_suppressed_recent_inbound'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toEqual({
      metric: 'reminder_suppressed_recent_inbound',
      reapedCount: 1,
      reminderAttempt: 1,
    });
    expect(line).not.toContain(patient.id);
    expect(line).not.toContain(dose.id);
  });

  it('still sends when the patient last replied more than 60 minutes ago (quiet hour) — today unchanged', async () => {
    const patient = await seedPatient();
    const medicationId = await seedMedication(patient.id);
    const dose = await seedDose(patient.id, medicationId, 10);
    await seedSentCheckIn(patient.id, dose.id, 5);
    // Stale presence signal: outside the 60-minute suppression window.
    await seedInboundReply(patient.id, 90);

    await expect(
      prepareReminderSend(
        pool,
        { patientId: patient.id, doseId: dose.id, reminderAttempt: 1 },
        REMINDER_BODY,
      ),
    ).resolves.toBe(true);

    await expect(
      claimPreparedReminderSend(pool, {
        patientId: patient.id,
        doseId: dose.id,
        reminderAttempt: 1,
      }),
    ).resolves.toMatchObject({ body: REMINDER_BODY });
    await expect(reminderStatus(patient.id, dose.id)).resolves.toBe('sending');
  });

  it('still sends when the only recent reply PREDATES the check-in — a message sent before the prompt is not an answer to it', async () => {
    const patient = await seedPatient();
    const medicationId = await seedMedication(patient.id);
    const dose = await seedDose(patient.id, medicationId, 10);
    // Reply at T-15, check-in sent at T-5: inside the 60-minute lookback, but the patient has
    // said nothing since being prompted, so the nudge is exactly what is owed.
    await seedInboundReply(patient.id, 15);
    await seedSentCheckIn(patient.id, dose.id, 5);

    await expect(
      prepareReminderSend(
        pool,
        { patientId: patient.id, doseId: dose.id, reminderAttempt: 1 },
        REMINDER_BODY,
      ),
    ).resolves.toBe(true);

    await expect(
      claimPreparedReminderSend(pool, {
        patientId: patient.id,
        doseId: dose.id,
        reminderAttempt: 1,
      }),
    ).resolves.toMatchObject({ body: REMINDER_BODY });
    await expect(reminderStatus(patient.id, dose.id)).resolves.toBe('sending');
  });

  it('still sends when the patient has never replied at all', async () => {
    const patient = await seedPatient();
    const medicationId = await seedMedication(patient.id);
    const dose = await seedDose(patient.id, medicationId, 10);
    await seedSentCheckIn(patient.id, dose.id, 5);

    await expect(
      prepareReminderSend(
        pool,
        { patientId: patient.id, doseId: dose.id, reminderAttempt: 1 },
        REMINDER_BODY,
      ),
    ).resolves.toBe(true);

    await expect(
      claimPreparedReminderSend(pool, {
        patientId: patient.id,
        doseId: dose.id,
        reminderAttempt: 1,
      }),
    ).resolves.toMatchObject({ body: REMINDER_BODY });
  });
});
