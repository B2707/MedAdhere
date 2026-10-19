// write-contract.test.ts — the DASH-06 export SELECT contract against a REAL PostgreSQL 16
// (testcontainers, mirroring deactivate/write-contract.test.ts + schema.test.ts). The core unit test
// pins the allowlist + CSV + D14 polarity with a fake client; THIS test proves the exported SQL
// SEMANTICS actually hold in Postgres. It imports the EXACT SSOT constant (EXPORT_ANON_SQL), so a
// handler-side SQL edit that breaks a contract fails HERE — no drift between the SQL and its proof.
//
// Requires a running Docker daemon OR a CI-provided TEST_DATABASE_URL (PG 16). NO AWS, NO credentials.
//
// Contracts proven (06-06 real-PG arms + D7/D14/U-25):
//   - the emitted column set is EXACTLY the D7 allowlist (set-equality, real pg keys);
//   - multi-reply determinism: a dose with TWO inbound replies emits ONE row keyed to the OUTCOME reply
//     (ar.inbound_message_id), and the latency is that reply's — no dose fan-out (U-25);
//   - timeout rows carry response_latency_seconds NULL + is_late NULL + dose_status='missed' (M13);
//   - D14 polarity: is_test=true rows are INCLUDED by default and only excluded under excludeTest=true;
//   - the PIPE-10 unattributed outcome (dose_id NULL) → is_unattributed=true, study_day/dose_weekday NULL;
//   - study_day is the dose_date offset from the cohort's earliest dose; dose_weekday is the ISO weekday.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ALLOWLIST_COLUMNS, EXPORT_ANON_SQL } from './core.js';

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema-init', 'schema.sql'), 'utf8');
const CONTAINER_TIMEOUT_MS = 180_000;
const TEST_OWNER_SUB = '8f6e7138-fd21-4b31-8ac3-934cfc610f44';

let container: StartedPostgreSqlContainer | undefined;
let client: Client;

async function applySchema(c: Client): Promise<void> {
  await c.query('BEGIN');
  try {
    await c.query(SCHEMA_SQL);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  }
}

beforeAll(async () => {
  const ciUrl = process.env.TEST_DATABASE_URL;
  if (ciUrl) {
    client = new Client({ connectionString: ciUrl });
    await client.connect();
  } else {
    container = await new PostgreSqlContainer('postgres:16').start();
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
  }
  await applySchema(client);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

// ---- seed helpers (each test wraps its seeds in BEGIN/ROLLBACK for isolation) ----------------
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+1500888${String(phoneCounter).padStart(4, '0')}`;
}

async function seedPatient(opts: { isTest?: boolean } = {}): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO patient (owner_clinician_sub, phone, medication_name, is_test) VALUES ($1, $2, 'metformin', $3) RETURNING id`,
    [TEST_OWNER_SUB, nextPhone(), opts.isTest ?? true],
  );
  return rows[0]!.id;
}

async function seedDose(patientId: string, doseDate: string, localTime = '09:00'): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO dose_schedule (patient_id, scheduled_at, local_dose_time, dose_date)
       VALUES ($1, ($2::date + time '09:00') AT TIME ZONE 'UTC', $3, $2::date) RETURNING id`,
    [patientId, doseDate, localTime],
  );
  return rows[0]!.id;
}

async function seedOutbound(
  patientId: string,
  doseId: string,
  status: string,
  sentAt: string | null,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO outbound_message (patient_id, dose_id, status, sent_at) VALUES ($1, $2, $3, $4) RETURNING id`,
    [patientId, doseId, status, sentAt],
  );
  return rows[0]!.id;
}

async function seedReply(
  patientId: string,
  doseId: string | null,
  receivedAt: string,
  isLate = false,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO inbound_reply (patient_id, dose_id, raw_body, is_late, received_at)
       VALUES ($1, $2, 'took it', $3, $4) RETURNING id`,
    [patientId, doseId, isLate, receivedAt],
  );
  return rows[0]!.id;
}

interface RecordSeed {
  patientId: string;
  doseId: string | null;
  inboundMessageId: string | null;
  adherenceState: string;
  decidedBy: 'classifier' | 'timeout';
  status: 'recorded' | 'missed';
  safetyFlag?: string;
}
async function seedRecord(s: RecordSeed): Promise<void> {
  await client.query(
    `INSERT INTO adherence_record
       (patient_id, dose_id, inbound_message_id, adherence_state, safety_flag, decided_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      s.patientId,
      s.doseId,
      s.inboundMessageId,
      s.adherenceState,
      s.safetyFlag ?? 'none',
      s.decidedBy,
      s.status,
    ],
  );
}

interface ExportRow {
  patient_pseudonym: string;
  is_test: boolean;
  adherence_state: string;
  reason_code: string;
  safety_flag: string;
  decided_by: string;
  dose_status: string;
  is_late: boolean | null;
  is_unattributed: boolean;
  study_day: number | null;
  local_dose_time: string | null;
  dose_weekday: number | null;
  outbound_status: string | null;
  response_latency_seconds: number | null;
}
async function runExport(excludeTest: boolean): Promise<ExportRow[]> {
  const { rows } = await client.query<ExportRow>(EXPORT_ANON_SQL, [excludeTest]);
  return rows;
}

describe('export-anon SELECT — real PG16 semantics (D7/D14/U-25)', () => {
  it('emits EXACTLY the D7 allowlist columns (set-equality, real pg row keys)', async () => {
    await client.query('BEGIN');
    const p = await seedPatient();
    const d = await seedDose(p, '2026-08-24');
    await seedOutbound(p, d, 'delivered', '2026-08-24T13:00:00Z');
    const reply = await seedReply(p, d, '2026-08-24T13:01:00Z');
    await seedRecord({
      patientId: p,
      doseId: d,
      inboundMessageId: reply,
      adherenceState: 'taken',
      decidedBy: 'classifier',
      status: 'recorded',
    });
    const rows = await runExport(false);
    expect(rows).toHaveLength(1);
    expect(new Set(Object.keys(rows[0]!))).toEqual(new Set(ALLOWLIST_COLUMNS));
    await client.query('ROLLBACK');
  });

  it('multi-reply determinism: TWO replies on one dose → ONE row keyed to the outcome reply, its latency', async () => {
    await client.query('BEGIN');
    const p = await seedPatient();
    const d = await seedDose(p, '2026-08-24');
    await seedOutbound(p, d, 'delivered', '2026-08-24T13:00:00Z');
    // Two inbound replies for the SAME dose; the classifier's outcome reply is the SECOND one.
    await seedReply(p, d, '2026-08-24T13:02:00Z'); // an earlier, non-outcome reply
    const outcomeReply = await seedReply(p, d, '2026-08-24T13:05:00Z'); // +300s from send
    await seedRecord({
      patientId: p,
      doseId: d,
      inboundMessageId: outcomeReply,
      adherenceState: 'delayed',
      decidedBy: 'classifier',
      status: 'recorded',
    });
    const rows = await runExport(false);
    // No fan-out: exactly ONE row despite two replies on the dose (anchored on adherence_record, U-25).
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decided_by).toBe('classifier');
    // Latency is the OUTCOME reply's (13:05 − 13:00 = 300s), not the earlier reply's.
    expect(rows[0]!.response_latency_seconds).toBe(300);
    await client.query('ROLLBACK');
  });

  it('a timeout (missed, no-reply) row → response_latency_seconds NULL + is_late NULL + dose_status missed', async () => {
    await client.query('BEGIN');
    const p = await seedPatient();
    const d = await seedDose(p, '2026-08-24');
    await seedOutbound(p, d, 'delivered', '2026-08-24T13:00:00Z');
    await seedRecord({
      patientId: p,
      doseId: d,
      inboundMessageId: null, // timeout writes a missed row with NO inbound reply
      adherenceState: 'unknown',
      decidedBy: 'timeout',
      status: 'missed',
    });
    const rows = await runExport(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decided_by).toBe('timeout');
    expect(rows[0]!.dose_status).toBe('missed');
    expect(rows[0]!.response_latency_seconds).toBeNull(); // U-25 — NULL latency for timeout rows
    expect(rows[0]!.is_late).toBeNull(); // no inbound reply → no is_late
    await client.query('ROLLBACK');
  });

  it('D14 polarity: is_test=true rows are INCLUDED by default and EXCLUDED only under excludeTest=true', async () => {
    await client.query('BEGIN');
    const testPatient = await seedPatient({ isTest: true });
    const dt = await seedDose(testPatient, '2026-08-24');
    await seedOutbound(testPatient, dt, 'delivered', '2026-08-24T13:00:00Z');
    const rt = await seedReply(testPatient, dt, '2026-08-24T13:01:00Z');
    await seedRecord({
      patientId: testPatient,
      doseId: dt,
      inboundMessageId: rt,
      adherenceState: 'taken',
      decidedBy: 'classifier',
      status: 'recorded',
    });
    // Default (excludeTest=false): the cohort is present and tagged is_test=true.
    const included = await runExport(false);
    expect(included).toHaveLength(1);
    expect(included[0]!.is_test).toBe(true);
    // --exclude-test: the same is_test row is filtered out (a 0-row set the caller then fails loudly on).
    const excluded = await runExport(true);
    expect(excluded).toHaveLength(0);
    await client.query('ROLLBACK');
  });

  it('an unattributed outcome (dose_id NULL — PIPE-10) → is_unattributed=true, study_day/dose_weekday NULL', async () => {
    await client.query('BEGIN');
    const p = await seedPatient();
    const reply = await seedReply(p, null, '2026-08-24T13:00:00Z');
    await seedRecord({
      patientId: p,
      doseId: null, // the collision path persists the record dose_id NULL
      inboundMessageId: reply,
      adherenceState: 'unknown',
      decidedBy: 'classifier',
      status: 'recorded',
    });
    const rows = await runExport(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_unattributed).toBe(true);
    expect(rows[0]!.study_day).toBeNull(); // no dose → no dose_date → no study day
    expect(rows[0]!.dose_weekday).toBeNull();
    expect(rows[0]!.local_dose_time).toBeNull();
    await client.query('ROLLBACK');
  });

  it('study_day is the dose_date offset from the cohort earliest dose; dose_weekday is the ISO weekday', async () => {
    await client.query('BEGIN');
    const p = await seedPatient();
    const early = await seedDose(p, '2026-08-24'); // cohort day 0
    const later = await seedDose(p, '2026-08-27'); // +3 days
    await seedOutbound(p, early, 'delivered', '2026-08-24T13:00:00Z');
    await seedOutbound(p, later, 'delivered', '2026-08-27T13:00:00Z');
    const r1 = await seedReply(p, early, '2026-08-24T13:00:30Z');
    const r2 = await seedReply(p, later, '2026-08-27T13:00:30Z');
    await seedRecord({
      patientId: p,
      doseId: early,
      inboundMessageId: r1,
      adherenceState: 'taken',
      decidedBy: 'classifier',
      status: 'recorded',
    });
    await seedRecord({
      patientId: p,
      doseId: later,
      inboundMessageId: r2,
      adherenceState: 'taken',
      decidedBy: 'classifier',
      status: 'recorded',
    });

    const rows = await runExport(false);
    expect(rows).toHaveLength(2);
    // ORDER BY dose_date → row[0] is the earliest (day 0), row[1] is +3.
    expect(rows[0]!.study_day).toBe(0);
    expect(rows[1]!.study_day).toBe(3);
    // dose_weekday matches a direct ISO-weekday extract on the same date (no locale dependence).
    const { rows: dow } = await client.query<{ d: number }>(
      `SELECT EXTRACT(ISODOW FROM DATE '2026-08-24')::int AS d`,
    );
    expect(rows[0]!.dose_weekday).toBe(dow[0]!.d);
    await client.query('ROLLBACK');
  });
});
