/**
 * read-contract.test.ts — the SC0 data-API READ contract MATRIX against a REAL PostgreSQL 16
 * (testcontainers, the timeout/deactivate write-contract posture). The mocked-pg unit test
 * (handler.test.ts) pins the routeKey DISPATCH + SQL TEXT; THIS test proves the pinned read SQL
 * SEMANTICS actually hold in Postgres. It imports the EXACT handler SQL constants, so a future edit
 * that breaks a contract fails HERE — no drift between the read SQL and its semantic proof.
 *
 * Requires a running Docker daemon OR a CI-provided TEST_DATABASE_URL (PG 16). NO AWS, NO credentials.
 *
 * The matrix (06-PLAN 06-01 pins — D4/D5/U-12/U-17..24):
 *   - trailing-miss (D5/U-23): 3-consecutive; miss→undelivered→miss ≠ 2 (a no-record gap breaks the
 *     run); a reply resets the run; the newest-tail open-window (no-record) dose is skipped;
 *   - unknown queue (U-17/U-18): a timeout/missed row is ABSENT; a classifier `unknown` is present;
 *     an unattributed (dose_id NULL) classifier row is present; a row that is BOTH appears exactly once;
 *     every non-safety label match reaches its dedicated arm, while safety wins cross-queue dedup (C-6);
 *   - cohort series (D4/U-20/21/22): dose_date bucketing; the timeout-gate delivery denominator
 *     (undelivered excluded); confirmed = classifier taken/delayed/skipped/stopped; ambiguous split;
 *   - safety queue (U-12/U-19/C-10): fan-out-free json_agg hints; failed/suppressed crisis and stale
 *     `sending` rows sort above newer non-urgent rows; a delivered ('sent') crisis is NOT urgent;
 *   - detail/timeline: 404 branch (0 rows) + chronological ASC ordering with per-dose outcomes;
 *   - list (D14): is_test is a BADGE, never a filter — both a test and a non-test patient appear.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  LIST_PATIENTS_SQL,
  PATIENT_DETAIL_SQL,
  PATIENT_TIMELINE_SQL,
  COHORT_ADHERENCE_SQL,
  SAFETY_QUEUE_SQL,
  UNKNOWN_QUEUE_SQL,
} from './handler.js';
import {
  PatientRecordDayOutsideWindowError,
  loadAlertQueue,
  loadDraftQueue,
  loadPatientRecord,
} from './patient-record.js';
import { handlePatientReadRoute } from './patient-record-route.js';

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema-init', 'schema.sql'), 'utf8');

const CONTAINER_TIMEOUT_MS = 180_000;
const NIL_UUID = '00000000-0000-4000-8000-000000000000';
const DOCTOR_A_SUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DOCTOR_B_SUB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let container: StartedPostgreSqlContainer | undefined;
let client: Client;
let databaseUrl: string;

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
    databaseUrl = ciUrl;
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  } else {
    container = await new PostgreSqlContainer('postgres:16').start();
    databaseUrl = container.getConnectionUri();
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  }
  await applySchema(client);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

// ---- seed helpers (per-test, inside BEGIN/ROLLBACK) -------------------------------------
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+1500${String(phoneCounter).padStart(7, '0')}`;
}

const LEGACY_CONSISTENCY_CONSTRAINTS = [
  ['outbound_message', 'outbound_message_patient_dose_fkey'],
  ['inbound_reply', 'inbound_reply_patient_dose_fkey'],
  ['adherence_record', 'adherence_record_patient_dose_fkey'],
  ['adherence_record', 'adherence_record_patient_inbound_fkey'],
  ['safety_events', 'safety_events_patient_inbound_fkey'],
  ['label_match', 'label_match_patient_inbound_fkey'],
] as const;

/**
 * Phase 8 constraints reject new drift even while NOT VALID. A rolled-back test may temporarily drop
 * selected constraints to model rows restored from a legacy snapshot before reconciliation.
 */
async function allowLegacyCrossPatientRows(
  constraints = LEGACY_CONSISTENCY_CONSTRAINTS,
): Promise<void> {
  for (const [table, constraint] of constraints) {
    await client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraint}`);
  }
}

async function seedPatient(
  opts: {
    isTest?: boolean;
    isActive?: boolean;
    optedOut?: boolean;
    timezone?: string;
    ownerClinicianSub?: string | null;
  } = {},
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO patient
       (phone, medication_name, is_test, is_active, opted_out_at, timezone, owner_clinician_sub)
     VALUES ($1, 'metformin', $2, $3, $4, $5, $6) RETURNING id`,
    [
      nextPhone(),
      opts.isTest ?? false,
      opts.isActive ?? true,
      opts.optedOut ? new Date() : null,
      opts.timezone ?? 'America/Toronto',
      opts.ownerClinicianSub === undefined ? DOCTOR_A_SUB : opts.ownerClinicianSub,
    ],
  );
  return r.rows[0]!.id;
}

/** Seed a restored ownerless legacy row without weakening the committed production constraint. */
async function seedRestoredOwnerlessPatient(): Promise<string> {
  await client.query(
    'ALTER TABLE patient DROP CONSTRAINT IF EXISTS patient_owner_clinician_sub_not_null',
  );
  return seedPatient({ ownerClinicianSub: null });
}

/** Insert a dose. `scheduledAt` orders the trailing-miss run; `doseDate` ('YYYY-MM-DD') buckets the cohort. */
async function seedDose(
  patientId: string,
  scheduledAt = '2026-01-01T09:00:00Z',
  doseDate: string | null = null,
): Promise<string> {
  const d = await client.query<{ id: string }>(
    `INSERT INTO dose_schedule (patient_id, scheduled_at, local_dose_time, dose_date)
     VALUES ($1, $2, '09:00', $3) RETURNING id`,
    [patientId, scheduledAt, doseDate],
  );
  return d.rows[0]!.id;
}

async function seedOutbound(
  patientId: string,
  doseId: string,
  status: string,
  sentAt: string | null = '2020-01-01T00:00:00Z',
): Promise<void> {
  await client.query(
    `INSERT INTO outbound_message (patient_id, dose_id, status, sent_at) VALUES ($1, $2, $3, $4)`,
    [patientId, doseId, status, sentAt],
  );
}

async function seedInbound(
  patientId: string,
  doseId: string | null = null,
  receivedAt: string | null = null,
  rawBody = 'msg',
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO inbound_reply (patient_id, dose_id, raw_body, received_at)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, now())) RETURNING id`,
    [patientId, doseId, rawBody, receivedAt],
  );
  return r.rows[0]!.id;
}

async function seedRecord(opts: {
  patientId: string;
  doseId: string | null;
  inboundId?: string | null;
  adherenceState: string;
  decidedBy: string;
  status: string;
  reasonCode?: string;
  safetyFlag?: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO adherence_record
       (patient_id, dose_id, inbound_message_id, adherence_state, reason_code, safety_flag, decided_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      opts.patientId,
      opts.doseId,
      opts.inboundId ?? null,
      opts.adherenceState,
      opts.reasonCode ?? 'none',
      opts.safetyFlag ?? 'none',
      opts.decidedBy,
      opts.status,
    ],
  );
}

async function seedSafetyEvent(opts: {
  patientId: string;
  inboundId: string;
  flagCategory: string;
  autoReplyStatus?: string | null;
  autoReplyError?: string | null;
  createdAt?: string | null;
}): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO safety_events
       (patient_id, inbound_message_id, flag_category, auto_reply_status, auto_reply_error, created_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()))
     RETURNING id`,
    [
      opts.patientId,
      opts.inboundId,
      opts.flagCategory,
      opts.autoReplyStatus ?? null,
      opts.autoReplyError ?? null,
      opts.createdAt ?? null,
    ],
  );
  return result.rows[0]!.id;
}

async function seedLabelMatch(opts: {
  inboundId: string;
  patientId: string;
  matchedPhrase: string;
  meddraPt: string;
  hintLevel: string;
  createdAt?: string;
}): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO label_match
       (inbound_message_id, patient_id, matched_phrase, meddra_pt, hint_level, created_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()))
     RETURNING id`,
    [
      opts.inboundId,
      opts.patientId,
      opts.matchedPhrase,
      opts.meddraPt,
      opts.hintLevel,
      opts.createdAt ?? null,
    ],
  );
  return result.rows[0]!.id;
}

/** The LIST_PATIENTS_SQL row for one patient, using the optional patient predicate. */
interface ListPatientRow {
  consecutive_missed: number;
  consecutive_reported_misses: number;
  is_test: boolean;
  is_active: boolean;
  agent_enabled: boolean;
  provider_opted_in: boolean;
  adherence_rate: number | null;
  last_reply_at: string | null;
  recent_doses: Array<{
    dose_id: string;
    scheduled_at: string;
    status: string;
    adherence_state: string;
    decided_by: string;
  }>;
}

async function listRowFor(
  patientId: string,
  ownerClinicianSub = DOCTOR_A_SUB,
): Promise<ListPatientRow | undefined> {
  const { rows } = await client.query(LIST_PATIENTS_SQL, [patientId, 120, ownerClinicianSub]);
  return rows[0];
}

/** A delivered dose that timed out with no reply → a {missed, timeout} record. */
async function seedMissed(
  patientId: string,
  scheduledAt: string,
  doseDate: string | null = null,
): Promise<string> {
  const d = await seedDose(patientId, scheduledAt, doseDate);
  await seedOutbound(patientId, d, 'delivered');
  await seedRecord({
    patientId,
    doseId: d,
    adherenceState: 'unknown',
    decidedBy: 'timeout',
    status: 'missed',
  });
  return d;
}

/** A delivered dose the patient replied to → a {recorded, classifier} record. */
async function seedReplied(
  patientId: string,
  scheduledAt: string,
  adherenceState = 'taken',
  doseDate: string | null = null,
): Promise<string> {
  const d = await seedDose(patientId, scheduledAt, doseDate);
  await seedOutbound(patientId, d, 'delivered');
  const ib = await seedInbound(patientId, d);
  await seedRecord({
    patientId,
    doseId: d,
    inboundId: ib,
    adherenceState,
    decidedBy: 'classifier',
    status: 'recorded',
  });
  return d;
}

describe('LIST_PATIENTS_SQL — per-patient trailing-miss run (D5/U-23, real PG16)', () => {
  it('three consecutive delivered misses → consecutive_missed = 3', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    await seedMissed(pid, '2026-01-01T09:00:00Z');
    await seedMissed(pid, '2026-01-02T09:00:00Z');
    await seedMissed(pid, '2026-01-03T09:00:00Z');
    const row = await listRowFor(pid);
    expect(row?.consecutive_missed).toBe(3);
    await client.query('ROLLBACK');
  });

  it('miss → UNDELIVERED (no record) → miss ≠ 2-consecutive: the no-record gap breaks the run → 1', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    await seedMissed(pid, '2026-01-01T09:00:00Z'); // oldest, missed
    // middle: an undelivered send → the timeout H5-gate wrote NO record → a no-record gap
    const gap = await seedDose(pid, '2026-01-02T09:00:00Z');
    await seedOutbound(pid, gap, 'undelivered');
    await seedMissed(pid, '2026-01-03T09:00:00Z'); // newest, missed
    const row = await listRowFor(pid);
    // The most-recent miss counts (1); the undelivered no-record dose breaks the run — NOT 2.
    expect(row?.consecutive_missed).toBe(1);
    await client.query('ROLLBACK');
  });

  it('a timeout miss whose outbound later becomes undelivered breaks the run instead of extending it', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    await seedMissed(pid, '2026-01-01T09:00:00Z');
    await seedMissed(pid, '2026-01-02T09:00:00Z');
    const lateUndelivered = await seedMissed(pid, '2026-01-03T09:00:00Z');
    await client.query(`UPDATE outbound_message SET status = 'undelivered' WHERE dose_id = $1`, [
      lateUndelivered,
    ]);
    const row = await listRowFor(pid);
    expect(row?.consecutive_missed).toBe(0);
    await client.query('ROLLBACK');
  });

  it('a reply as the most-recent scored dose resets the run → 0', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    await seedMissed(pid, '2026-01-01T09:00:00Z');
    await seedMissed(pid, '2026-01-02T09:00:00Z');
    await seedReplied(pid, '2026-01-03T09:00:00Z'); // newest = a reply
    const row = await listRowFor(pid);
    expect(row?.consecutive_missed).toBe(0);
    await client.query('ROLLBACK');
  });

  it('a reply in the MIDDLE breaks the run (DESC: miss, reply, miss) → 1', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    await seedMissed(pid, '2026-01-01T09:00:00Z'); // oldest miss
    await seedReplied(pid, '2026-01-02T09:00:00Z'); // reply
    await seedMissed(pid, '2026-01-03T09:00:00Z'); // newest miss
    const row = await listRowFor(pid);
    expect(row?.consecutive_missed).toBe(1);
    await client.query('ROLLBACK');
  });

  it('the newest-tail open-window (no-record) dose is SKIPPED, the closed misses behind it count → 2', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    await seedMissed(pid, '2026-01-01T09:00:00Z');
    await seedMissed(pid, '2026-01-02T09:00:00Z');
    // newest: delivered but no record yet (window still open) — a PENDING tail dose, not a miss.
    const pending = await seedDose(pid, '2026-01-03T09:00:00Z');
    await seedOutbound(pid, pending, 'delivered', new Date().toISOString());
    const row = await listRowFor(pid);
    expect(row?.consecutive_missed).toBe(2);
    await client.query('ROLLBACK');
  });

  it('a patient with only pending (no-record) doses → consecutive_missed = 0', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const d = await seedDose(pid, '2026-01-01T09:00:00Z');
    await seedOutbound(pid, d, 'delivered', new Date().toISOString());
    const row = await listRowFor(pid);
    expect(row?.consecutive_missed).toBe(0);
    await client.query('ROLLBACK');
  });

  it.each(['sending', 'failed'])(
    'a newest %s outbound with NULL sent_at breaks an older miss run',
    async (status) => {
      await client.query('BEGIN');
      const pid = await seedPatient();
      await seedMissed(pid, '2026-01-01T09:00:00Z');
      await seedMissed(pid, '2026-01-02T09:00:00Z');
      await seedMissed(pid, '2026-01-03T09:00:00Z');
      const breaker = await seedDose(pid, '2026-01-04T09:00:00Z');
      await seedOutbound(pid, breaker, status, null);
      expect((await listRowFor(pid))?.consecutive_missed).toBe(0);
      await client.query('ROLLBACK');
    },
  );

  it('counts only misses newer than a failed NULL-sent_at breaker', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const breaker = await seedDose(pid, '2026-01-01T09:00:00Z');
    await seedOutbound(pid, breaker, 'failed', null);
    await seedMissed(pid, '2026-01-02T09:00:00Z');
    await seedMissed(pid, '2026-01-03T09:00:00Z');
    expect((await listRowFor(pid))?.consecutive_missed).toBe(2);
    await client.query('ROLLBACK');
  });

  it('closed undelivered newest doses break an older three-miss run → consecutive_missed = 0 (U25/RETRO-5)', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    await seedMissed(pid, '2026-01-01T09:00:00Z');
    await seedMissed(pid, '2026-01-02T09:00:00Z');
    await seedMissed(pid, '2026-01-03T09:00:00Z');
    const olderUndelivered = await seedDose(pid, '2026-01-04T09:00:00Z');
    await seedOutbound(pid, olderUndelivered, 'undelivered');
    const newestUndelivered = await seedDose(pid, '2026-01-05T09:00:00Z');
    await seedOutbound(pid, newestUndelivered, 'undelivered');

    const row = await listRowFor(pid);
    expect(row?.consecutive_missed).toBe(0);
    await client.query('ROLLBACK');
  });

  it('the all-patient list and patient-filtered detail form agree on the same D5 fixture (U15/C-8)', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    await seedMissed(pid, '2026-01-01T09:00:00Z');
    await seedMissed(pid, '2026-01-02T09:00:00Z');
    const closedGap = await seedDose(pid, '2026-01-03T09:00:00Z');
    await seedOutbound(pid, closedGap, 'delivered');
    await seedMissed(pid, '2026-01-04T09:00:00Z');

    const listRows = (await client.query(LIST_PATIENTS_SQL, [null, 120, DOCTOR_A_SUB])).rows;
    const detailRows = (await client.query(LIST_PATIENTS_SQL, [pid, 120, DOCTOR_A_SUB])).rows;
    expect(detailRows).toHaveLength(1);
    expect(detailRows[0]).toEqual(listRows.find((row) => row.id === pid));
    expect(detailRows[0].consecutive_missed).toBe(1);
    await client.query('ROLLBACK');
  });
});

describe('LIST_PATIENTS_SQL — per-patient reported-miss run (separate alert, real PG16)', () => {
  it('three consecutive classifier-reported skips → consecutive_reported_misses = 3; the silence streak stays 0', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    await seedReplied(pid, '2026-01-01T09:00:00Z', 'skipped');
    await seedReplied(pid, '2026-01-02T09:00:00Z', 'skipped');
    await seedReplied(pid, '2026-01-03T09:00:00Z', 'skipped');
    const row = await listRowFor(pid);
    expect(row?.consecutive_reported_misses).toBe(3);
    // Reported misses are status='recorded' — they must NEVER feed the silence (timeout) streak.
    expect(row?.consecutive_missed).toBe(0);
    await client.query('ROLLBACK');
  });

  it('an interleaved taken reply breaks the reported run (DESC: skipped, taken, skipped) → 1', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    await seedReplied(pid, '2026-01-01T09:00:00Z', 'skipped');
    await seedReplied(pid, '2026-01-02T09:00:00Z', 'taken');
    await seedReplied(pid, '2026-01-03T09:00:00Z', 'skipped');
    const row = await listRowFor(pid);
    expect(row?.consecutive_reported_misses).toBe(1);
    await client.query('ROLLBACK');
  });

  it('a taken reply as the newest classifier outcome resets the reported run → 0', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    await seedReplied(pid, '2026-01-01T09:00:00Z', 'skipped');
    await seedReplied(pid, '2026-01-02T09:00:00Z', 'skipped');
    await seedReplied(pid, '2026-01-03T09:00:00Z', 'taken');
    const row = await listRowFor(pid);
    expect(row?.consecutive_reported_misses).toBe(0);
    await client.query('ROLLBACK');
  });

  it('three timeout misses feed ONLY the silence streak → consecutive_missed = 3, reported run = 0', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    await seedMissed(pid, '2026-01-01T09:00:00Z');
    await seedMissed(pid, '2026-01-02T09:00:00Z');
    await seedMissed(pid, '2026-01-03T09:00:00Z');
    const row = await listRowFor(pid);
    expect(row?.consecutive_missed).toBe(3);
    expect(row?.consecutive_reported_misses).toBe(0);
    await client.query('ROLLBACK');
  });

  it('a timeout silence between two reported skips neither breaks nor extends the reported run → 2', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    await seedReplied(pid, '2026-01-01T09:00:00Z', 'skipped');
    await seedMissed(pid, '2026-01-02T09:00:00Z');
    await seedReplied(pid, '2026-01-03T09:00:00Z', 'skipped');
    const row = await listRowFor(pid);
    // The reported run ranks classifier-recorded outcomes only — silence is a separate streak.
    expect(row?.consecutive_reported_misses).toBe(2);
    // The newest scored dose is a recorded reply, so the silence streak is broken.
    expect(row?.consecutive_missed).toBe(0);
    await client.query('ROLLBACK');
  });

  it('the all-patient list and patient-filtered detail form agree on the reported run', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    await seedReplied(pid, '2026-01-01T09:00:00Z', 'taken');
    await seedReplied(pid, '2026-01-02T09:00:00Z', 'skipped');
    await seedReplied(pid, '2026-01-03T09:00:00Z', 'skipped');
    const listRows = (await client.query(LIST_PATIENTS_SQL, [null, 120, DOCTOR_A_SUB])).rows;
    const detailRows = (await client.query(LIST_PATIENTS_SQL, [pid, 120, DOCTOR_A_SUB])).rows;
    expect(detailRows).toHaveLength(1);
    expect(detailRows[0]).toEqual(listRows.find((row) => row.id === pid));
    expect(detailRows[0].consecutive_reported_misses).toBe(2);
    await client.query('ROLLBACK');
  });
});

describe('LIST_PATIENTS_SQL — is_test is a BADGE, never a filter (D14, real PG16)', () => {
  it('both a test and a non-test patient appear; the is_test flag is carried, not applied', async () => {
    await client.query('BEGIN');
    const testPid = await seedPatient({ isTest: true });
    const realPid = await seedPatient({ isTest: false });
    const { rows } = await client.query(LIST_PATIENTS_SQL, [null, 120, DOCTOR_A_SUB]);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(testPid);
    expect(ids).toContain(realPid); // NO is_test predicate (D14 badge-not-filter)
    expect(rows.find((r) => r.id === testPid)?.is_test).toBe(true);
    expect(rows.find((r) => r.id === realPid)?.is_test).toBe(false);
    await client.query('ROLLBACK');
  });
});

describe('LIST_PATIENTS_SQL — messaging controls', () => {
  it('carries provider consent and doctor reactivation state to the roster', async () => {
    await client.query('BEGIN');
    const patientId = await seedPatient();
    await client.query(
      `UPDATE patient
          SET provider_opted_in = true,
              agent_enabled = false
        WHERE id = $1`,
      [patientId],
    );

    expect(await listRowFor(patientId)).toMatchObject({
      is_active: true,
      provider_opted_in: true,
      agent_enabled: false,
    });
    await client.query('ROLLBACK');
  });
});

describe('LIST_PATIENTS_SQL — real handoff roster metrics (real PG16)', () => {
  it('returns a numeric trailing-30-day clinical adherence rate and excludes non-contract outcomes', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const { rows: timestamps } = await client.query<{
      recent_1: string;
      recent_2: string;
      recent_3: string;
      recent_4: string;
      recent_5: string;
      recent_6: string;
      old: string;
      future: string;
    }>(`SELECT (CURRENT_TIMESTAMP - INTERVAL '1 day')::text AS recent_1,
               (CURRENT_TIMESTAMP - INTERVAL '2 days')::text AS recent_2,
               (CURRENT_TIMESTAMP - INTERVAL '3 days')::text AS recent_3,
               (CURRENT_TIMESTAMP - INTERVAL '4 days')::text AS recent_4,
               (CURRENT_TIMESTAMP - INTERVAL '5 days')::text AS recent_5,
               (CURRENT_TIMESTAMP - INTERVAL '6 days')::text AS recent_6,
               (CURRENT_TIMESTAMP - INTERVAL '31 days')::text AS old,
               (CURRENT_TIMESTAMP + INTERVAL '1 day')::text AS future`);
    const times = timestamps[0]!;

    await seedReplied(pid, times.recent_1, 'taken');
    await seedReplied(pid, times.recent_2, 'delayed');
    await seedReplied(pid, times.recent_3, 'skipped');
    await seedReplied(pid, times.recent_4, 'stopped');
    await seedReplied(pid, times.recent_5, 'question');
    await seedReplied(pid, times.recent_6, 'unknown');
    await seedMissed(pid, times.recent_6);
    await seedReplied(pid, times.old, 'taken');
    await seedReplied(pid, times.future, 'taken');

    const row = await listRowFor(pid);
    expect(row?.adherence_rate).toBe(0.5);
    expect(typeof row?.adherence_rate).toBe('number');
    await client.query('ROLLBACK');
  });

  it('returns null adherence/last-reply and an empty recent-dose array when no qualifying data exists', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const row = await listRowFor(pid);

    expect(row).toMatchObject({
      adherence_rate: null,
      last_reply_at: null,
      recent_doses: [],
    });
    await client.query('ROLLBACK');
  });

  it('returns the latest real inbound timestamp without exposing message content', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    await seedInbound(pid, null, '2026-07-01T12:30:00.000Z');
    await seedInbound(pid, null, '2026-07-03T09:45:12.345Z');

    const row = await listRowFor(pid);
    expect(row?.last_reply_at).toBe('2026-07-03T09:45:12.345Z');
    expect(row).not.toHaveProperty('raw_body');
    expect(row).not.toHaveProperty('message_preview');
    await client.query('ROLLBACK');
  });

  it('returns only the latest 14 resolved doses, ordered oldest-to-newest with timeout distinct', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const { rows: timestamps } = await client.query<{ position: number; scheduled_at: string }>(
      `SELECT position,
              (CURRENT_TIMESTAMP - ((17 - position) * INTERVAL '1 hour'))::text AS scheduled_at
         FROM generate_series(1, 16) AS positions(position)
        ORDER BY position`,
    );
    const doseIds: string[] = [];
    for (const timestamp of timestamps) {
      doseIds.push(
        timestamp.position === 10
          ? await seedMissed(pid, timestamp.scheduled_at)
          : await seedReplied(pid, timestamp.scheduled_at, 'taken'),
      );
    }

    const row = await listRowFor(pid);
    const recentDoses = row?.recent_doses as Array<{
      dose_id: string;
      scheduled_at: string;
      status: string;
      adherence_state: string;
      decided_by: string;
    }>;
    expect(recentDoses).toHaveLength(14);
    expect(recentDoses.map((dose) => dose.dose_id)).toEqual(doseIds.slice(-14));
    expect(recentDoses.map((dose) => dose.scheduled_at)).toEqual(
      [...recentDoses.map((dose) => dose.scheduled_at)].sort(),
    );
    expect(recentDoses.find((dose) => dose.dose_id === doseIds[9])).toEqual({
      dose_id: doseIds[9],
      scheduled_at: expect.any(String),
      status: 'missed',
      adherence_state: 'unknown',
      decided_by: 'timeout',
    });
    expect(Object.keys(recentDoses[0]!).sort()).toEqual([
      'adherence_state',
      'decided_by',
      'dose_id',
      'scheduled_at',
      'status',
    ]);
    await client.query('ROLLBACK');
  });
});

describe('UNKNOWN_QUEUE_SQL — classifier-only ambiguity queue (U-17/U-18, real PG16)', () => {
  it('a timeout/missed row is ABSENT (decided_by=classifier pin — the missed-dose firehose stays out)', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const d = await seedMissed(pid, '2026-01-01T09:00:00Z'); // decided_by='timeout', adherence_state='unknown'
    const { rows } = await client.query(UNKNOWN_QUEUE_SQL, [100, DOCTOR_A_SUB]);
    expect(rows.find((r) => r.dose_id === d)).toBeUndefined();
    await client.query('ROLLBACK');
  });

  it('a classifier `unknown` (attributed) row IS present, flagged is_unknown', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const d = await seedDose(pid, '2026-01-01T09:00:00Z');
    await seedOutbound(pid, d, 'delivered');
    const ib = await seedInbound(pid, d);
    await seedRecord({
      patientId: pid,
      doseId: d,
      inboundId: ib,
      adherenceState: 'unknown',
      decidedBy: 'classifier',
      status: 'recorded',
    });
    const { rows } = await client.query(UNKNOWN_QUEUE_SQL, [100, DOCTOR_A_SUB]);
    const row = rows.find((r) => r.inbound_message_id === ib);
    expect(row).toBeDefined();
    expect(row.is_unknown).toBe(true);
    expect(row.is_unattributed).toBe(false);
    await client.query('ROLLBACK');
  });

  it('an unattributed (dose_id NULL) classifier row IS present even when its state is not unknown (U-18)', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const ib = await seedInbound(pid, null);
    // The classifier collision path persists an outcome UNATTRIBUTED (dose_id NULL) — a valid `taken`.
    await seedRecord({
      patientId: pid,
      doseId: null,
      inboundId: ib,
      adherenceState: 'taken',
      decidedBy: 'classifier',
      status: 'recorded',
    });
    const { rows } = await client.query(UNKNOWN_QUEUE_SQL, [100, DOCTOR_A_SUB]);
    const row = rows.find((r) => r.inbound_message_id === ib);
    expect(row).toBeDefined();
    expect(row.is_unattributed).toBe(true);
    expect(row.is_unknown).toBe(false);
    await client.query('ROLLBACK');
  });

  it('a row that is BOTH unknown AND unattributed appears exactly ONCE (OR union dedup — U-18)', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const ib = await seedInbound(pid, null);
    await seedRecord({
      patientId: pid,
      doseId: null,
      inboundId: ib,
      adherenceState: 'unknown',
      decidedBy: 'classifier',
      status: 'recorded',
    });
    const { rows } = await client.query(UNKNOWN_QUEUE_SQL, [100, DOCTOR_A_SUB]);
    const matches = rows.filter((r) => r.inbound_message_id === ib);
    expect(matches).toHaveLength(1);
    await client.query('ROLLBACK');
  });

  it('filters a label hint whose denormalized patient_id does not match its inbound reply', async () => {
    await client.query('BEGIN');
    await allowLegacyCrossPatientRows();
    const pid = await seedPatient();
    const driftPid = await seedPatient();
    const doseId = await seedDose(pid, '2026-01-01T09:00:00Z');
    const inboundId = await seedInbound(pid, doseId);
    await seedRecord({
      patientId: pid,
      doseId,
      inboundId,
      adherenceState: 'taken',
      decidedBy: 'classifier',
      status: 'recorded',
    });
    await seedLabelMatch({
      inboundId,
      patientId: pid,
      matchedPhrase: 'felt dizzy',
      meddraPt: 'Dizziness',
      hintLevel: 'info',
    });
    // Simulate a restored legacy row whose denormalized patient_id drifted from its inbound reply.
    // The owned reply remains visible, but the foreign hint must never influence or appear in it.
    await seedLabelMatch({
      inboundId,
      patientId: driftPid,
      matchedPhrase: 'felt faint',
      meddraPt: 'Syncope',
      hintLevel: 'elevated',
    });

    const { rows } = await client.query(UNKNOWN_QUEUE_SQL, [100, DOCTOR_A_SUB]);
    const matches = rows.filter((row) => row.inbound_message_id === inboundId);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      patient_id: pid,
      queue_kind: 'label_match',
      is_unknown: false,
      is_unattributed: false,
      is_label_match: true,
      has_no_outcome: false,
      has_elevated_hint: false,
    });
    expect(matches[0].hints).toEqual([
      {
        matched_phrase: 'felt dizzy',
        meddra_pt: 'Dizziness',
        hint_level: 'info',
      },
    ]);
    await client.query('ROLLBACK');
  });

  it('a label match with no adherence outcome exposes has_no_outcome=true (db-L5)', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const inboundId = await seedInbound(pid);
    await seedLabelMatch({
      inboundId,
      patientId: pid,
      matchedPhrase: 'felt dizzy',
      meddraPt: 'Dizziness',
      hintLevel: 'info',
    });

    const { rows } = await client.query(UNKNOWN_QUEUE_SQL, [100, DOCTOR_A_SUB]);
    const row = rows.find((item) => item.inbound_message_id === inboundId);
    expect(row).toMatchObject({
      patient_id: pid,
      queue_kind: 'label_match',
      has_no_outcome: true,
      has_elevated_hint: false,
    });
    await client.query('ROLLBACK');
  });

  it('an older elevated label match outranks a newer info match (U29-SQL)', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const olderInboundId = await seedInbound(pid);
    const newerInboundId = await seedInbound(pid);
    await seedLabelMatch({
      inboundId: olderInboundId,
      patientId: pid,
      matchedPhrase: 'face swelling',
      meddraPt: 'Angioedema',
      hintLevel: 'elevated',
      createdAt: '2026-01-01T00:00:00Z',
    });
    await seedLabelMatch({
      inboundId: newerInboundId,
      patientId: pid,
      matchedPhrase: 'felt dizzy',
      meddraPt: 'Dizziness',
      hintLevel: 'info',
      createdAt: '2026-06-01T00:00:00Z',
    });

    const { rows } = await client.query(UNKNOWN_QUEUE_SQL, [100, DOCTOR_A_SUB]);
    const olderIndex = rows.findIndex((row) => row.inbound_message_id === olderInboundId);
    const newerIndex = rows.findIndex((row) => row.inbound_message_id === newerInboundId);
    expect(olderIndex).toBeGreaterThanOrEqual(0);
    expect(newerIndex).toBeGreaterThanOrEqual(0);
    expect(olderIndex).toBeLessThan(newerIndex);
    expect(rows[olderIndex].has_elevated_hint).toBe(true);
    expect(rows[newerIndex].has_elevated_hint).toBe(false);
    await client.query('ROLLBACK');
  });

  it('applies the server-owned row limit to the unioned queue (U18)', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    for (const [index, hintLevel] of ['info', 'elevated', 'info'].entries()) {
      const inboundId = await seedInbound(pid);
      await seedLabelMatch({
        inboundId,
        patientId: pid,
        matchedPhrase: `phrase-${index}`,
        meddraPt: `Term ${index}`,
        hintLevel,
      });
    }
    const { rows } = await client.query(UNKNOWN_QUEUE_SQL, [2, DOCTOR_A_SUB]);
    expect(rows).toHaveLength(2);
    await client.query('ROLLBACK');
  });

  it('safety wins for an unknown + unattributed + label-match reply, which appears once across all queues (C-6b)', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const inboundId = await seedInbound(pid, null);
    await seedRecord({
      patientId: pid,
      doseId: null,
      inboundId,
      adherenceState: 'unknown',
      decidedBy: 'classifier',
      status: 'recorded',
      safetyFlag: 'crisis',
    });
    await seedLabelMatch({
      inboundId,
      patientId: pid,
      matchedPhrase: 'cannot breathe',
      meddraPt: 'Dyspnoea',
      hintLevel: 'elevated',
    });
    await seedSafetyEvent({
      patientId: pid,
      inboundId,
      flagCategory: 'crisis',
      autoReplyStatus: 'sent',
    });

    const safetyRows = (await client.query(SAFETY_QUEUE_SQL, [15, 100, DOCTOR_A_SUB])).rows.filter(
      (row) => row.inbound_message_id === inboundId,
    );
    const reviewRows = (await client.query(UNKNOWN_QUEUE_SQL, [100, DOCTOR_A_SUB])).rows.filter(
      (row) => row.inbound_message_id === inboundId,
    );

    expect([...safetyRows, ...reviewRows]).toHaveLength(1);
    expect(safetyRows).toHaveLength(1);
    expect(reviewRows).toHaveLength(0);
    expect(safetyRows[0].hints).toEqual([
      {
        matched_phrase: 'cannot breathe',
        meddra_pt: 'Dyspnoea',
        hint_level: 'elevated',
      },
    ]);
    await client.query('ROLLBACK');
  });
});

describe('COHORT_ADHERENCE_SQL — selectable series, dose_date buckets, timeout-gate denominator (D4/U-20/21/22, real PG16)', () => {
  it('buckets by dose_date and computes confirmed/ambiguous/non_response + the delivered/responded denominators', async () => {
    await client.query('BEGIN');
    const { rows: dateRows } = await client.query<{ today: string; yesterday: string }>(
      `SELECT CURRENT_DATE::text AS today, (CURRENT_DATE - 1)::text AS yesterday`,
    );
    const today = dateRows[0]!.today;
    const yesterday = dateRows[0]!.yesterday;
    const pid = await seedPatient();

    // --- TODAY bucket: a full spread of outcomes -------------------------------------------------
    await seedReplied(pid, '2026-05-10T09:00:00Z', 'taken', today); // confirmed + taken_delayed + responded + delivered
    await seedReplied(pid, '2026-05-10T10:00:00Z', 'delayed', today); // confirmed + taken_delayed + responded + delivered
    await seedReplied(pid, '2026-05-10T11:00:00Z', 'skipped', today); // confirmed + responded + delivered
    await seedReplied(pid, '2026-05-10T12:00:00Z', 'stopped', today); // confirmed + responded + delivered
    await seedReplied(pid, '2026-05-10T13:00:00Z', 'unknown', today); // ambiguous + responded + delivered
    await seedReplied(pid, '2026-05-10T14:00:00Z', 'question', today); // ambiguous + responded + delivered
    await seedMissed(pid, '2026-05-10T15:00:00Z', today); // non_response + delivered (record exists, delivered gate)
    // an UNDELIVERED dose (no record) → excluded from delivered AND responded (U-20 timeout-gate denominator)
    const undel = await seedDose(pid, '2026-05-10T16:00:00Z', today);
    await seedOutbound(pid, undel, 'undelivered');

    // --- YESTERDAY bucket: a single taken (proves dose_date bucketing — U-21) ---------------------
    await seedReplied(pid, '2026-05-09T09:00:00Z', 'taken', yesterday);

    const { rows } = await client.query(COHORT_ADHERENCE_SQL, [120, 30, DOCTOR_A_SUB]);
    const todayRow = rows.find((r) => r.day === today);
    const yRow = rows.find((r) => r.day === yesterday);
    expect(todayRow).toBeDefined();
    expect(yRow).toBeDefined();

    expect(todayRow.confirmed).toBe(4); // taken, delayed, skipped, stopped
    expect(todayRow.taken_delayed).toBe(2); // taken, delayed
    expect(todayRow.ambiguous).toBe(2); // unknown, question
    expect(todayRow.non_response).toBe(1); // the timeout missed
    expect(todayRow.responded).toBe(6); // every classifier record (incl. unknown/question), delivered
    expect(todayRow.delivered).toBe(7); // 6 classifier + 1 timeout; the undelivered dose is excluded

    expect(yRow.confirmed).toBe(1);
    expect(yRow.taken_delayed).toBe(1);
    expect(yRow.delivered).toBe(1);
    await client.query('ROLLBACK');
  });

  it('excludes doses older than the 30-day window', async () => {
    await client.query('BEGIN');
    const { rows: dr } = await client.query<{ old: string }>(
      `SELECT (CURRENT_DATE - 60)::text AS old`,
    );
    const oldDay = dr[0]!.old;
    const pid = await seedPatient();
    await seedReplied(pid, '2026-01-01T09:00:00Z', 'taken', oldDay);
    const { rows } = await client.query(COHORT_ADHERENCE_SQL, [120, 30, DOCTOR_A_SUB]);
    expect(rows.find((r) => r.day === oldDay)).toBeUndefined();
    await client.query('ROLLBACK');
  });

  it('keeps every classifier/non-response bucket within the denominator after a late undelivered DLR (U4)', async () => {
    await client.query('BEGIN');
    const { rows: dateRows } = await client.query<{ today: string }>(
      `SELECT CURRENT_DATE::text AS today`,
    );
    const today = dateRows[0]!.today;
    const pid = await seedPatient();
    await seedReplied(pid, `${today}T09:00:00Z`, 'taken', today);
    await seedReplied(pid, `${today}T09:30:00Z`, 'unknown', today);
    await seedMissed(pid, `${today}T09:45:00Z`, today);
    const laterUndelivered = await seedReplied(pid, `${today}T10:00:00Z`, 'taken', today);
    await client.query(`UPDATE outbound_message SET status = 'undelivered' WHERE dose_id = $1`, [
      laterUndelivered,
    ]);

    const { rows } = await client.query(COHORT_ADHERENCE_SQL, [120, 30, DOCTOR_A_SUB]);
    const row = rows.find((item) => item.day === today);
    expect(row).toMatchObject({
      delivered: 3,
      responded: 2,
      confirmed: 1,
      taken_delayed: 1,
      ambiguous: 1,
      non_response: 1,
    });
    expect(row.confirmed + row.ambiguous + row.non_response).toBeLessThanOrEqual(row.delivered);
    await client.query('ROLLBACK');
  });

  it('includes a closed delivered dose with no adherence_record in the denominator (RETRO-4)', async () => {
    await client.query('BEGIN');
    const { rows: dateRows } = await client.query<{ today: string }>(
      `SELECT CURRENT_DATE::text AS today`,
    );
    const today = dateRows[0]!.today;
    const pid = await seedPatient();
    const doseId = await seedDose(pid, `${today}T09:00:00Z`, today);
    await seedOutbound(pid, doseId, 'delivered');

    const { rows } = await client.query(COHORT_ADHERENCE_SQL, [120, 30, DOCTOR_A_SUB]);
    expect(rows.find((item) => item.day === today)).toMatchObject({
      delivered: 1,
      responded: 0,
      confirmed: 0,
      taken_delayed: 0,
      ambiguous: 0,
      non_response: 0,
    });
    await client.query('ROLLBACK');
  });

  it('excludes an otherwise delivered dose while its response window is still open (RETRO-4)', async () => {
    await client.query('BEGIN');
    const { rows: dateRows } = await client.query<{ today: string }>(
      `SELECT CURRENT_DATE::text AS today`,
    );
    const today = dateRows[0]!.today;
    const pid = await seedPatient();
    const doseId = await seedDose(pid, `${today}T09:00:00Z`, today);
    await seedOutbound(pid, doseId, 'delivered', new Date().toISOString());

    const { rows } = await client.query(COHORT_ADHERENCE_SQL, [120, 30, DOCTOR_A_SUB]);
    expect(rows.find((item) => item.day === today)).toBeUndefined();
    await client.query('ROLLBACK');
  });

  it('excludes CURRENT_DATE + 1 so no future cohort day is returned (U17)', async () => {
    await client.query('BEGIN');
    const { rows: dateRows } = await client.query<{ tomorrow: string }>(
      `SELECT (CURRENT_DATE + 1)::text AS tomorrow`,
    );
    const tomorrow = dateRows[0]!.tomorrow;
    const pid = await seedPatient();
    const doseId = await seedDose(pid, `${tomorrow}T09:00:00Z`, tomorrow);
    await seedOutbound(pid, doseId, 'delivered');

    const { rows } = await client.query(COHORT_ADHERENCE_SQL, [120, 30, DOCTOR_A_SUB]);
    expect(rows.find((item) => item.day === tomorrow)).toBeUndefined();
    await client.query('ROLLBACK');
  });

  it('uses the bound 7/30/90-day window as an inclusive trailing calendar range', async () => {
    await client.query('BEGIN');
    const offsets = [0, 6, 7, 29, 30, 89, 90] as const;
    const { rows: dateRows } = await client.query<{ day: string; day_offset: number }>(
      `SELECT (CURRENT_DATE - day_offset)::text AS day, day_offset
         FROM unnest($1::int[]) AS offsets(day_offset)`,
      [offsets],
    );
    const daysByOffset = new Map(dateRows.map((row) => [row.day_offset, row.day]));
    const pid = await seedPatient();
    for (const row of dateRows) {
      await seedReplied(pid, `${row.day}T09:00:00Z`, 'taken', row.day);
    }

    const cases = [
      { days: 7, includedOffsets: [0, 6] },
      { days: 30, includedOffsets: [0, 6, 7, 29] },
      { days: 90, includedOffsets: [0, 6, 7, 29, 30, 89] },
    ] as const;
    for (const testCase of cases) {
      const { rows } = await client.query(COHORT_ADHERENCE_SQL, [120, testCase.days, DOCTOR_A_SUB]);
      const expectedDays = testCase.includedOffsets
        .map((offset) => daysByOffset.get(offset))
        .sort();
      expect(rows.map((row) => row.day)).toEqual(expectedDays);
    }

    await client.query('ROLLBACK');
  });
});

describe('SAFETY_QUEUE_SQL — fan-out-free hints + U-12 urgent-first ordering (real PG16)', () => {
  it('aggregates multiple label_match hints into ONE event row (no 1-to-many fan-out — U-19)', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const ib = await seedInbound(pid);
    await seedSafetyEvent({ patientId: pid, inboundId: ib, flagCategory: 'medical_question' });
    await seedLabelMatch({
      inboundId: ib,
      patientId: pid,
      matchedPhrase: 'dizzy',
      meddraPt: 'Dizziness',
      hintLevel: 'info',
    });
    await seedLabelMatch({
      inboundId: ib,
      patientId: pid,
      matchedPhrase: 'nausea',
      meddraPt: 'Nausea',
      hintLevel: 'elevated',
    });
    const { rows } = await client.query(SAFETY_QUEUE_SQL, [15, 100, DOCTOR_A_SUB]);
    const evRows = rows.filter((r) => r.inbound_message_id === ib);
    expect(evRows).toHaveLength(1); // ONE row despite two hints
    expect(evRows[0].hints).toHaveLength(2);
    await client.query('ROLLBACK');
  });

  it('a failed CRISIS auto-reply sorts ABOVE a newer medical_question (U-12 — never buried)', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const ibOld = await seedInbound(pid);
    const ibNew = await seedInbound(pid);
    await seedSafetyEvent({
      patientId: pid,
      inboundId: ibOld,
      flagCategory: 'crisis',
      autoReplyStatus: 'failed',
      createdAt: '2026-01-01T00:00:00Z',
    });
    await seedSafetyEvent({
      patientId: pid,
      inboundId: ibNew,
      flagCategory: 'medical_question',
      createdAt: '2026-06-01T00:00:00Z',
    });
    const { rows } = await client.query(SAFETY_QUEUE_SQL, [15, 100, DOCTOR_A_SUB]);
    const idxOld = rows.findIndex((r) => r.inbound_message_id === ibOld);
    const idxNew = rows.findIndex((r) => r.inbound_message_id === ibNew);
    expect(idxOld).toBeGreaterThanOrEqual(0);
    expect(idxNew).toBeGreaterThanOrEqual(0);
    expect(idxOld).toBeLessThan(idxNew); // the old failed-crisis outranks the new medical_question
    expect(rows[idxOld].is_urgent).toBe(true);
    expect(rows[idxNew].is_urgent).toBe(false);
    await client.query('ROLLBACK');
  });

  it('a SUCCESSFULLY-delivered (sent) crisis is NOT urgent — only failed/suppressed crises are (U-12 predicate)', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const ib = await seedInbound(pid);
    await seedSafetyEvent({
      patientId: pid,
      inboundId: ib,
      flagCategory: 'crisis',
      autoReplyStatus: 'sent',
    });
    const { rows } = await client.query(SAFETY_QUEUE_SQL, [15, 100, DOCTOR_A_SUB]);
    const row = rows.find((r) => r.inbound_message_id === ib);
    expect(row).toBeDefined();
    expect(row.is_urgent).toBe(false);
    await client.query('ROLLBACK');
  });

  it('a failed medical_question is in the urgent follow-up tier (U16)', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const inboundId = await seedInbound(pid);
    await seedSafetyEvent({
      patientId: pid,
      inboundId,
      flagCategory: 'medical_question',
      autoReplyStatus: 'failed',
    });
    const { rows } = await client.query(SAFETY_QUEUE_SQL, [15, 100, DOCTOR_A_SUB]);
    expect(rows.find((row) => row.inbound_message_id === inboundId)?.is_urgent).toBe(true);
    await client.query('ROLLBACK');
  });

  it('an older sent crisis outranks a newer sent medical_question by clinical severity (U6-SQL)', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const olderCrisisId = await seedInbound(pid);
    const newerQuestionId = await seedInbound(pid);
    await seedSafetyEvent({
      patientId: pid,
      inboundId: olderCrisisId,
      flagCategory: 'crisis',
      autoReplyStatus: 'sent',
      createdAt: '2026-01-01T00:00:00Z',
    });
    await seedSafetyEvent({
      patientId: pid,
      inboundId: newerQuestionId,
      flagCategory: 'medical_question',
      autoReplyStatus: 'sent',
      createdAt: '2026-06-01T00:00:00Z',
    });

    const { rows } = await client.query(SAFETY_QUEUE_SQL, [15, 100, DOCTOR_A_SUB]);
    const crisisIndex = rows.findIndex((row) => row.inbound_message_id === olderCrisisId);
    const questionIndex = rows.findIndex((row) => row.inbound_message_id === newerQuestionId);
    expect(crisisIndex).toBeGreaterThanOrEqual(0);
    expect(questionIndex).toBeGreaterThanOrEqual(0);
    expect(crisisIndex).toBeLessThan(questionIndex);
    expect(rows[crisisIndex].is_urgent).toBe(false);
    expect(rows[questionIndex].is_urgent).toBe(false);
    await client.query('ROLLBACK');
  });

  it('a re-reserved old failed row exposes first-detected age and has_prior_failure=true (U16)', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const inboundId = await seedInbound(pid);
    await seedSafetyEvent({
      patientId: pid,
      inboundId,
      flagCategory: 'crisis',
      autoReplyStatus: 'sending',
      autoReplyError: 'prior Twilio failure',
      createdAt: '2020-01-01T00:00:00Z',
    });

    const { rows } = await client.query(SAFETY_QUEUE_SQL, [15, 100, DOCTOR_A_SUB]);
    const row = rows.find((item) => item.inbound_message_id === inboundId);
    expect(row).toMatchObject({
      auto_reply_status: 'sending',
      has_prior_failure: true,
      is_stale_sending: true,
      is_urgent: true,
    });
    expect(row.first_detected_minutes_ago).toBeGreaterThanOrEqual(15);
    expect(row).not.toHaveProperty('age_minutes');
    await client.query('ROLLBACK');
  });

  it('a stale sending crisis is urgent and outranks a newer non-urgent row (C-10 / U-12)', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const staleInboundId = await seedInbound(pid);
    const newerInboundId = await seedInbound(pid);
    const staleEventId = await seedSafetyEvent({
      patientId: pid,
      inboundId: staleInboundId,
      flagCategory: 'crisis',
      autoReplyStatus: 'sending',
      createdAt: '2020-01-01T00:00:00Z',
    });
    await seedSafetyEvent({
      patientId: pid,
      inboundId: newerInboundId,
      flagCategory: 'medical_question',
      autoReplyStatus: 'sent',
      createdAt: '2099-01-01T00:00:00Z',
    });

    const { rows } = await client.query(SAFETY_QUEUE_SQL, [15, 100, DOCTOR_A_SUB]);
    const staleIndex = rows.findIndex((row) => row.inbound_message_id === staleInboundId);
    const newerIndex = rows.findIndex((row) => row.inbound_message_id === newerInboundId);

    expect(staleIndex).toBeGreaterThanOrEqual(0);
    expect(newerIndex).toBeGreaterThanOrEqual(0);
    expect(staleIndex).toBeLessThan(newerIndex);
    expect(rows[staleIndex]).toMatchObject({
      id: staleEventId,
      auto_reply_status: 'sending',
      is_stale_sending: true,
      is_urgent: true,
    });
    expect(rows[staleIndex].first_detected_minutes_ago).toBeGreaterThanOrEqual(15);
    expect(rows[newerIndex]).toMatchObject({
      auto_reply_status: 'sent',
      is_stale_sending: false,
      is_urgent: false,
    });
    await client.query('ROLLBACK');
  });

  it('applies the server-owned row limit in SQL (U18)', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    for (const category of ['crisis', 'acute_physical', 'medical_question']) {
      const inboundId = await seedInbound(pid);
      await seedSafetyEvent({
        patientId: pid,
        inboundId,
        flagCategory: category,
        autoReplyStatus: 'sent',
      });
    }
    const { rows } = await client.query(SAFETY_QUEUE_SQL, [15, 2, DOCTOR_A_SUB]);
    expect(rows).toHaveLength(2);
    await client.query('ROLLBACK');
  });
});

describe('PATIENT_DETAIL_SQL / PATIENT_TIMELINE_SQL — 404 branch + chronological outcomes (real PG16)', () => {
  it('an existing patient → exactly one detail row; an unknown uuid → zero rows (the 404 branch)', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const found = await client.query(PATIENT_DETAIL_SQL, [pid, DOCTOR_A_SUB]);
    expect(found.rows).toHaveLength(1);
    const none = await client.query(PATIENT_DETAIL_SQL, [NIL_UUID, DOCTOR_A_SUB]);
    expect(none.rows).toHaveLength(0);
    await client.query('ROLLBACK');
  });

  it('the timeline returns doses in chronological (scheduled_at ASC) order with per-dose outcomes', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const { rows: dateRows } = await client.query<{
      today: string;
      yesterday: string;
      old: string;
    }>(
      // Timeline windows are patient-local, so seed dates must be too; UTC CURRENT_DATE diverges from them between 00:00-04:00 UTC.
      `SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'America/Toronto')::date::text AS today,
              ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Toronto')::date - 1)::text AS yesterday,
              ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Toronto')::date - 60)::text AS old`,
    );
    const { today, yesterday, old } = dateRows[0]!;
    const oldDose = await seedMissed(pid, `${old}T09:00:00Z`, old);
    const d1 = await seedMissed(pid, `${yesterday}T09:00:00Z`, yesterday);
    const d2 = await seedReplied(pid, `${today}T09:00:00Z`, 'taken', today);
    const { rows: inboundRows } = await client.query<{ id: string }>(
      'SELECT id FROM inbound_reply WHERE dose_id = $1',
      [d2],
    );
    const inboundId = inboundRows[0]!.id;
    const firstMatchId = await seedLabelMatch({
      inboundId,
      patientId: pid,
      matchedPhrase: 'felt dizzy',
      meddraPt: 'Dizziness',
      hintLevel: 'info',
    });
    const secondMatchId = await seedLabelMatch({
      inboundId,
      patientId: pid,
      matchedPhrase: 'fainted',
      meddraPt: 'Syncope',
      hintLevel: 'elevated',
    });
    const { rows } = await client.query(PATIENT_TIMELINE_SQL, [pid, 30, DOCTOR_A_SUB, 500]);
    expect(rows.map((r) => r.dose_id)).toEqual([d1, d2]); // ASC
    expect(rows.map((r) => r.dose_id)).not.toContain(oldDose);
    expect(rows[0]).toMatchObject({ status: 'missed', decided_by: 'timeout' });
    expect(rows[1]).toMatchObject({
      status: 'recorded',
      decided_by: 'classifier',
      adherence_state: 'taken',
    });
    for (const row of rows) {
      expect(row.dose_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(rows[1].label_matches).toHaveLength(2);
    expect(rows[1].label_matches).toEqual(
      expect.arrayContaining([
        {
          id: firstMatchId,
          matched_phrase: 'felt dizzy',
          meddra_pt: 'Dizziness',
          hint_level: 'info',
        },
        {
          id: secondMatchId,
          matched_phrase: 'fainted',
          meddra_pt: 'Syncope',
          hint_level: 'elevated',
        },
      ]),
    );
    expect(rows).toHaveLength(2); // two label matches never fan out the dose row
    await client.query('ROLLBACK');
  });

  it('includes patient-zone today and excludes patient-zone tomorrow', async () => {
    await client.query('BEGIN');
    const timezone = 'America/Toronto';
    const pid = await seedPatient({ timezone });
    const { rows: dayRows } = await client.query<{ today: string; tomorrow: string }>(
      `SELECT (CURRENT_TIMESTAMP AT TIME ZONE $1)::date::text AS today,
              ((CURRENT_TIMESTAMP AT TIME ZONE $1)::date + 1)::text AS tomorrow`,
      [timezone],
    );
    const { today, tomorrow } = dayRows[0]!;
    const todayDose = await seedDose(pid, `${today}T09:00:00Z`, today);
    const tomorrowDose = await seedDose(pid, `${tomorrow}T09:00:00Z`, tomorrow);

    const { rows } = await client.query(PATIENT_TIMELINE_SQL, [pid, 30, DOCTOR_A_SUB, 500]);
    expect(rows.map((row) => row.dose_id)).toContain(todayDose);
    expect(rows.map((row) => row.dose_id)).not.toContain(tomorrowDose);
    await client.query('ROLLBACK');
  });
});

describe('clinician ownership — cross-doctor and ownerless rows fail closed (real PG16)', () => {
  it('scopes list and detail in SQL and makes foreign/ownerless IDs indistinguishable from missing IDs', async () => {
    await client.query('BEGIN');
    const patientA = await seedPatient({ ownerClinicianSub: DOCTOR_A_SUB });
    const patientB = await seedPatient({ ownerClinicianSub: DOCTOR_B_SUB });
    const ownerlessPatient = await seedRestoredOwnerlessPatient();

    const listA = await client.query(LIST_PATIENTS_SQL, [null, 120, DOCTOR_A_SUB]);
    expect(listA.rows.map((row) => row.id)).toEqual([patientA]);

    await expect(client.query(PATIENT_DETAIL_SQL, [patientA, DOCTOR_A_SUB])).resolves.toMatchObject(
      { rows: [expect.objectContaining({ id: patientA })] },
    );
    await expect(client.query(PATIENT_DETAIL_SQL, [patientB, DOCTOR_A_SUB])).resolves.toMatchObject(
      { rows: [] },
    );
    await expect(
      client.query(PATIENT_DETAIL_SQL, [ownerlessPatient, DOCTOR_A_SUB]),
    ).resolves.toMatchObject({ rows: [] });

    await client.query('ROLLBACK');
  });

  it('scopes timeline and cohort aggregates before rows can reveal another clinician', async () => {
    await client.query('BEGIN');
    const patientA = await seedPatient({ ownerClinicianSub: DOCTOR_A_SUB });
    const patientB = await seedPatient({ ownerClinicianSub: DOCTOR_B_SUB });
    const ownerlessPatient = await seedRestoredOwnerlessPatient();
    const { rows: days } = await client.query<{ cohort_day: string; timeline_day: string }>(
      `SELECT CURRENT_DATE::text AS cohort_day,
              (CURRENT_TIMESTAMP AT TIME ZONE 'America/Toronto')::date::text AS timeline_day`,
    );
    const { cohort_day: cohortDay, timeline_day: timelineDay } = days[0]!;

    const timelineDoseA = await seedDose(patientA, `${timelineDay}T09:00:00Z`, timelineDay);
    await seedDose(patientB, `${timelineDay}T10:00:00Z`, timelineDay);
    await seedDose(ownerlessPatient, `${timelineDay}T11:00:00Z`, timelineDay);

    const timelineA = await client.query(PATIENT_TIMELINE_SQL, [patientA, 30, DOCTOR_A_SUB, 500]);
    expect(timelineA.rows.map((row) => row.dose_id)).toEqual([timelineDoseA]);
    await expect(
      client.query(PATIENT_TIMELINE_SQL, [patientB, 30, DOCTOR_A_SUB, 500]),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      client.query(PATIENT_TIMELINE_SQL, [ownerlessPatient, 30, DOCTOR_A_SUB, 500]),
    ).resolves.toMatchObject({ rows: [] });

    await seedMissed(patientA, `${cohortDay}T12:00:00Z`, cohortDay);
    await seedReplied(patientA, `${cohortDay}T13:00:00Z`, 'taken', cohortDay);
    await seedMissed(patientB, `${cohortDay}T14:00:00Z`, cohortDay);
    await seedReplied(patientB, `${cohortDay}T15:00:00Z`, 'taken', cohortDay);
    await seedMissed(ownerlessPatient, `${cohortDay}T16:00:00Z`, cohortDay);
    await seedReplied(ownerlessPatient, `${cohortDay}T17:00:00Z`, 'taken', cohortDay);
    const cohortA = await client.query(COHORT_ADHERENCE_SQL, [120, 30, DOCTOR_A_SUB]);
    const cohortDayA = cohortA.rows.find((row) => row.day === cohortDay);
    expect(cohortDayA).toMatchObject({ delivered: 2, responded: 1, confirmed: 1 });

    await client.query('ROLLBACK');
  });

  it('scopes both clinician review queues without exposing foreign or ownerless message text', async () => {
    await client.query('BEGIN');
    const patientA = await seedPatient({ ownerClinicianSub: DOCTOR_A_SUB });
    const patientB = await seedPatient({ ownerClinicianSub: DOCTOR_B_SUB });
    const ownerlessPatient = await seedRestoredOwnerlessPatient();

    const safetyInboundA = await seedInbound(patientA);
    const safetyInboundB = await seedInbound(patientB);
    const safetyInboundOwnerless = await seedInbound(ownerlessPatient);
    await seedSafetyEvent({
      patientId: patientA,
      inboundId: safetyInboundA,
      flagCategory: 'crisis',
    });
    await seedSafetyEvent({
      patientId: patientB,
      inboundId: safetyInboundB,
      flagCategory: 'crisis',
    });
    await seedSafetyEvent({
      patientId: ownerlessPatient,
      inboundId: safetyInboundOwnerless,
      flagCategory: 'crisis',
    });

    const unknownInboundA = await seedInbound(patientA);
    const unknownInboundB = await seedInbound(patientB);
    const unknownInboundOwnerless = await seedInbound(ownerlessPatient);
    for (const [patientId, inboundId] of [
      [patientA, unknownInboundA],
      [patientB, unknownInboundB],
      [ownerlessPatient, unknownInboundOwnerless],
    ] as const) {
      await seedRecord({
        patientId,
        doseId: null,
        inboundId,
        adherenceState: 'unknown',
        decidedBy: 'classifier',
        status: 'recorded',
      });
    }

    const safetyA = await client.query(SAFETY_QUEUE_SQL, [15, 100, DOCTOR_A_SUB]);
    expect(safetyA.rows.map((row) => row.patient_id)).toEqual([patientA]);
    const unknownA = await client.query(UNKNOWN_QUEUE_SQL, [100, DOCTOR_A_SUB]);
    expect(unknownA.rows.map((row) => row.patient_id)).toEqual([patientA]);

    await client.query('ROLLBACK');
  });
});

describe('legacy cross-patient drift — every denormalized join fails closed (real PG16)', () => {
  it('does not attach another patient outcome, inbound, hint, or delivery to an owned dose', async () => {
    await client.query('BEGIN');
    await allowLegacyCrossPatientRows();
    const patientA = await seedPatient({ ownerClinicianSub: DOCTOR_A_SUB });
    const patientB = await seedPatient({ ownerClinicianSub: DOCTOR_B_SUB });
    const { rows: days } = await client.query<{ today: string }>(
      `SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'America/Toronto')::date::text AS today`,
    );
    const today = days[0]!.today;
    const doseA = await seedDose(patientA, `${today}T09:00:00Z`, today);

    await seedOutbound(patientB, doseA, 'delivered');
    const inboundB = await seedInbound(patientB, doseA, null, 'DOCTOR_B_PRIVATE_TIMELINE_TEXT');
    await seedRecord({
      patientId: patientB,
      doseId: doseA,
      inboundId: inboundB,
      adherenceState: 'stopped',
      decidedBy: 'classifier',
      status: 'recorded',
    });
    await seedLabelMatch({
      inboundId: inboundB,
      patientId: patientB,
      matchedPhrase: 'DOCTOR_B_PRIVATE_HINT',
      meddraPt: 'Private term',
      hintLevel: 'elevated',
    });

    const listA = await client.query(LIST_PATIENTS_SQL, [patientA, 120, DOCTOR_A_SUB]);
    expect(listA.rows[0]).toMatchObject({ adherence_rate: null, recent_doses: [] });

    const timelineA = await client.query(PATIENT_TIMELINE_SQL, [patientA, 30, DOCTOR_A_SUB, 500]);
    expect(timelineA.rows).toEqual([
      expect.objectContaining({
        dose_id: doseA,
        status: null,
        adherence_state: null,
        decided_by: null,
        is_late: null,
        label_matches: [],
      }),
    ]);

    const cohortA = await client.query(COHORT_ADHERENCE_SQL, [120, 30, DOCTOR_A_SUB]);
    expect(cohortA.rows.find((row) => row.day === today)).toBeUndefined();

    await client.query('ROLLBACK');
  });

  it('does not expose cross-linked inbound text or label hints in either review queue', async () => {
    await client.query('BEGIN');
    await allowLegacyCrossPatientRows();
    const patientA = await seedPatient({ ownerClinicianSub: DOCTOR_A_SUB });
    const patientB = await seedPatient({ ownerClinicianSub: DOCTOR_B_SUB });

    const safetyInboundB = await seedInbound(patientB, null, null, 'DOCTOR_B_PRIVATE_SAFETY_TEXT');
    const crossLinkedSafetyId = await seedSafetyEvent({
      patientId: patientA,
      inboundId: safetyInboundB,
      flagCategory: 'crisis',
    });
    await seedLabelMatch({
      inboundId: safetyInboundB,
      patientId: patientB,
      matchedPhrase: 'DOCTOR_B_PRIVATE_SAFETY_HINT',
      meddraPt: 'Private safety term',
      hintLevel: 'elevated',
    });

    const ambiguityInboundB = await seedInbound(
      patientB,
      null,
      null,
      'DOCTOR_B_PRIVATE_AMBIGUITY_TEXT',
    );
    await seedRecord({
      patientId: patientA,
      doseId: null,
      inboundId: ambiguityInboundB,
      adherenceState: 'unknown',
      decidedBy: 'classifier',
      status: 'recorded',
    });

    const ownedInboundA = await seedInbound(patientA);
    await seedLabelMatch({
      inboundId: ownedInboundA,
      patientId: patientB,
      matchedPhrase: 'DOCTOR_B_PRIVATE_LABEL_HINT',
      meddraPt: 'Private label term',
      hintLevel: 'elevated',
    });

    const safetyA = await client.query(SAFETY_QUEUE_SQL, [15, 100, DOCTOR_A_SUB]);
    expect(safetyA.rows.find((row) => row.id === crossLinkedSafetyId)).toBeUndefined();
    expect(JSON.stringify(safetyA.rows)).not.toContain('DOCTOR_B_PRIVATE');

    const unknownA = await client.query(UNKNOWN_QUEUE_SQL, [100, DOCTOR_A_SUB]);
    expect(
      unknownA.rows.find((row) => row.inbound_message_id === ambiguityInboundB),
    ).toBeUndefined();
    expect(unknownA.rows.find((row) => row.inbound_message_id === ownedInboundA)).toBeUndefined();
    expect(JSON.stringify(unknownA.rows)).not.toContain('DOCTOR_B_PRIVATE');

    await client.query('ROLLBACK');
  });
});

describe('08-06 patient record — selected patient-local day and bounded window (real PG16)', () => {
  async function torontoDays(): Promise<{ today: string; yesterday: string }> {
    const result = await client.query<{ today: string; yesterday: string }>(
      `SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'America/Toronto')::date::text AS today,
              ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Toronto')::date - 1)::text AS yesterday`,
    );
    return result.rows[0]!;
  }

  async function seedRecordDay(patientId: string, day: string, suffix: string): Promise<string> {
    await client.query(
      `INSERT INTO daily_summary
         (patient_id, local_date, version, window_start, window_end, input_hash, event_count,
          highest_tier, structured_payload, summary_text)
       VALUES ($1, $2::date, 1, $2::date::timestamp AT TIME ZONE 'America/Toronto',
               ($2::date + 1)::timestamp AT TIME ZONE 'America/Toronto', repeat($3, 64), 1,
               'routine', '{}'::jsonb, $4)`,
      [patientId, day, suffix, `summary-${suffix}`],
    );
    const inbound = await client.query<{ id: string }>(
      `INSERT INTO inbound_reply (patient_id, raw_body, received_at)
       VALUES ($1, $3, ($2::date + time '12:00') AT TIME ZONE 'America/Toronto')
       RETURNING id`,
      [patientId, day, `message-${suffix}`],
    );
    await client.query(
      `INSERT INTO clinical_event
         (patient_id, source_inbound_id, event_type, event_code, statement_text, occurred_at, local_date)
       VALUES ($1, $2, 'adherence', 'taken:none', $3,
               ($4::date + time '12:00') AT TIME ZONE 'America/Toronto', $4::date)`,
      [patientId, inbound.rows[0]!.id, `event-${suffix}`, day],
    );
    // Wave-3: adherence trends now read the real adherence_record/dose_schedule outcome (the
    // clinical_event row above is unrelated — it only exercises PATIENT_EVENTS_SQL), so a dose
    // scheduled on this day is needed too, to keep proving trends span the FULL window, not just
    // the selected day. Seeded directly (not via seedReplied) so it does not add extra
    // inbound_reply/outbound_message rows that would inflate this test's `messages` count.
    const doseId = await seedDose(patientId, `${day}T12:00:00Z`, day);
    await seedRecord({
      patientId,
      doseId,
      inboundId: inbound.rows[0]!.id,
      adherenceState: 'taken',
      decidedBy: 'classifier',
      status: 'recorded',
    });
    return inbound.rows[0]!.id;
  }

  it('keeps compact window data while full messages, events, and summary stay on the selected day', async () => {
    await client.query('BEGIN');
    const { today, yesterday } = await torontoDays();
    const patientId = await seedPatient({ timezone: 'America/Toronto' });
    await seedRecordDay(patientId, yesterday, 'a');
    await seedRecordDay(patientId, today, 'b');

    const record = await loadPatientRecord(client, patientId, DOCTOR_A_SUB, {
      days: 7,
      selectedDay: today,
      alerts: { cursor: null, limit: 10 },
      drafts: { cursor: null, limit: 10 },
    });
    expect(record).not.toBeNull();
    expect(record?.selectedDay).toBe(today);
    expect(record?.dayIndex).toHaveLength(7);
    expect(record?.daySummary).toMatchObject({ local_date: today, summary_text: 'summary-b' });
    expect(record?.messages).toHaveLength(1);
    expect(record?.messages[0]).toMatchObject({ body: 'message-b' });
    expect(record?.events).toHaveLength(1);
    expect(record?.events[0]).toMatchObject({ local_date: today, statement_text: 'event-b' });
    expect(record?.trends.adherence).toHaveLength(2);
    expect(record?.history).toEqual({ medications: [], facts: [] });

    await expect(
      loadPatientRecord(client, patientId, DOCTOR_A_SUB, {
        days: 7,
        selectedDay: '2000-01-01',
        alerts: { cursor: null, limit: 10 },
        drafts: { cursor: null, limit: 10 },
      }),
    ).rejects.toBeInstanceOf(PatientRecordDayOutsideWindowError);
    await expect(
      loadPatientRecord(client, patientId, DOCTOR_B_SUB, {
        days: 7,
        selectedDay: today,
        alerts: { cursor: null, limit: 10 },
        drafts: { cursor: null, limit: 10 },
      }),
    ).resolves.toBeNull();
    await client.query('ROLLBACK');
  });

  it('marks never-sent outbound rows with sent_at NULL while provider-accepted rows carry it', async () => {
    await client.query('BEGIN');
    const { today } = await torontoDays();
    const patientId = await seedPatient({ timezone: 'America/Toronto' });
    // One row Twilio accepted (sent_at set) and one suppressed record-only row (never reached the
    // provider: status 'failed', sent_at NULL) — both on the selected day via COALESCE(created_at).
    await client.query(
      `INSERT INTO outbound_message (patient_id, status, body, message_kind, sent_at)
       VALUES ($1, 'delivered', 'sent-reply', 'acknowledgement',
               ($2::date + time '12:00') AT TIME ZONE 'America/Toronto'),
              ($1, 'failed', 'suppressed-reply', 'acknowledgement', NULL)`,
      [patientId, today],
    );

    const record = await loadPatientRecord(client, patientId, DOCTOR_A_SUB, {
      days: 7,
      selectedDay: today,
      alerts: { cursor: null, limit: 10 },
      drafts: { cursor: null, limit: 10 },
    });
    const rows = (record?.messages ?? []) as Array<Record<string, unknown>>;
    const sent = rows.find((row) => row.body === 'sent-reply');
    const suppressed = rows.find((row) => row.body === 'suppressed-reply');
    expect(sent?.sent_at).toBeInstanceOf(Date);
    expect(suppressed).toBeDefined();
    expect(suppressed?.sent_at).toBeNull();
    await client.query('ROLLBACK');
  });

  it('paginates the owner-scoped alert queue without exposing another doctor', async () => {
    await client.query('BEGIN');
    const { today } = await torontoDays();
    const ownedPatient = await seedPatient({ ownerClinicianSub: DOCTOR_A_SUB });
    const foreignPatient = await seedPatient({ ownerClinicianSub: DOCTOR_B_SUB });
    for (const [patientId, code, minute] of [
      [ownedPatient, 'emergency', 1],
      [ownedPatient, 'important', 2],
      [foreignPatient, 'emergency', 3],
    ] as const) {
      await client.query(
        `INSERT INTO clinical_event
           (patient_id, event_type, event_code, occurred_at, local_date)
         VALUES ($1, 'alert', $2, now() + ($3::int * interval '1 minute'), $4::date)`,
        [patientId, code, minute, today],
      );
    }

    const first = await loadAlertQueue(client, DOCTOR_A_SUB, { cursor: null, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ patient_id: ownedPatient, tier: 'emergency' });
    expect(first.nextCursor).not.toBeNull();
    const second = await loadAlertQueue(client, DOCTOR_A_SUB, {
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(second.items[0]).toMatchObject({ patient_id: ownedPatient, tier: 'important' });
    expect(second.nextCursor).toBeNull();
    await client.query('ROLLBACK');
  });
});

describe('08-06 patient record — current leaves, immutable drafts, and one snapshot (real PG16)', () => {
  async function torontoDays(): Promise<{ today: string; yesterday: string }> {
    const result = await client.query<{ today: string; yesterday: string }>(
      `SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'America/Toronto')::date::text AS today,
              ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Toronto')::date - 1)::text AS yesterday`,
    );
    return result.rows[0]!;
  }

  async function seedClinicalEvent(input: {
    patientId: string;
    day: string;
    eventType: 'observation' | 'adherence' | 'alert';
    eventCode: string;
    normalizedValue?: string | null;
    severity?: number | null;
    supersedesId?: string | null;
    sourceInboundId?: string | null;
  }): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO clinical_event
         (patient_id, source_inbound_id, event_type, event_code, statement_text, normalized_value,
          occurred_at, local_date, severity, supersedes_id)
       VALUES ($1, $8, $2, $3, $3, $4,
               ($5::date + time '12:00') AT TIME ZONE 'America/Toronto', $5::date, $6, $7)
       RETURNING id`,
      [
        input.patientId,
        input.eventType,
        input.eventCode,
        input.normalizedValue ?? null,
        input.day,
        input.severity ?? null,
        input.supersedesId ?? null,
        input.sourceInboundId ?? null,
      ],
    );
    return result.rows[0]!.id;
  }

  async function seedDraft(
    patientId: string,
    day: string,
    createdAt: string,
    hashCharacter: string,
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO clinician_review_draft
         (patient_id, local_date, version, input_hash, draft_text, created_at)
       VALUES ($1, $2::date, 1, repeat($4, 64), $2, $3::timestamptz)
       RETURNING id`,
      [patientId, day, createdAt, hashCharacter],
    );
    return result.rows[0]!.id;
  }

  /**
   * Wave-3: seeds a clinical_event row shaped exactly like the live conversational core's writer
   * (repository.ts persistEvent) — event_type='patient_statement' (Lane W storage projection of
   * the semantic kind 'symptom'), every domain field in clinical_values jsonb, the legacy
   * severity/normalized_value/event_code columns left NULL. `severity` is a free-text field on
   * the SAME event (e.g. "8"), not a separate row; passing `supersedesId` models a refine/correct
   * step in the version chain.
   */
  async function seedSymptomEvent(input: {
    patientId: string;
    day: string;
    rawSymptom?: string;
    symptomConcept?: string | null;
    severity?: string;
    onset?: string;
    supersedesId?: string | null;
    /**
     * The physical `event_type` spelling. Defaults to the live writer's 'patient_statement';
     * 'symptom' is the SAME event as stored by writers that predate the Lane W storage projection.
     * Those rows are permanent (clinical_event is append-only), so both spellings stay reachable.
     */
    eventType?: 'symptom' | 'patient_statement';
  }): Promise<string> {
    const clinicalValues: Record<string, string | null> = {};
    if (input.rawSymptom !== undefined) clinicalValues.rawSymptom = input.rawSymptom;
    if (input.symptomConcept !== undefined) clinicalValues.symptomConcept = input.symptomConcept;
    if (input.severity !== undefined) clinicalValues.severity = input.severity;
    if (input.onset !== undefined) clinicalValues.onset = input.onset;
    const result = await client.query<{ id: string }>(
      `INSERT INTO clinical_event
         (patient_id, event_type, occurred_at, local_date, supersedes_id, clinical_values)
       VALUES ($1, $5, ($2::date + time '12:00') AT TIME ZONE 'America/Toronto', $2::date,
               $3, $4::jsonb)
       RETURNING id`,
      [
        input.patientId,
        input.day,
        input.supersedesId ?? null,
        JSON.stringify(clinicalValues),
        input.eventType ?? 'patient_statement',
      ],
    );
    return result.rows[0]!.id;
  }

  it('projects only correction-chain leaves while version history remains unfiltered', async () => {
    await client.query('BEGIN');
    const { today } = await torontoDays();
    const patientId = await seedPatient({ timezone: 'America/Toronto' });

    const oldHeadache = await seedClinicalEvent({
      patientId,
      day: today,
      eventType: 'observation',
      eventCode: 'symptom',
      normalizedValue: 'headache',
      severity: 8,
    });
    const correctedHeadache = await seedClinicalEvent({
      patientId,
      day: today,
      eventType: 'observation',
      eventCode: 'correction',
      normalizedValue: 'headache',
      severity: 2,
      supersedesId: oldHeadache,
    });
    const nausea = await seedClinicalEvent({
      patientId,
      day: today,
      eventType: 'observation',
      eventCode: 'symptom',
      normalizedValue: 'nausea',
      severity: 4,
    });
    const oldAdherence = await seedClinicalEvent({
      patientId,
      day: today,
      eventType: 'adherence',
      eventCode: 'taken:none',
    });
    const correctedAdherence = await seedClinicalEvent({
      patientId,
      day: today,
      eventType: 'adherence',
      eventCode: 'skipped:forgot',
      supersedesId: oldAdherence,
    });
    const oldAlert = await seedClinicalEvent({
      patientId,
      day: today,
      eventType: 'alert',
      eventCode: 'emergency',
    });
    const correctedAlert = await seedClinicalEvent({
      patientId,
      day: today,
      eventType: 'alert',
      eventCode: 'important',
      supersedesId: oldAlert,
    });

    const record = await loadPatientRecord(client, patientId, DOCTOR_A_SUB, {
      days: 7,
      selectedDay: today,
      alerts: { cursor: null, limit: 10 },
      drafts: { cursor: null, limit: 10 },
    });
    expect(record).not.toBeNull();
    const eventIds = (record!.events as Array<{ id: string }>).map(({ id }) => id);
    expect(eventIds).toEqual(
      expect.arrayContaining([correctedHeadache, nausea, correctedAdherence, correctedAlert]),
    );
    expect(eventIds).not.toEqual(expect.arrayContaining([oldHeadache, oldAdherence, oldAlert]));
    expect(
      (record!.dayIndex as Array<Record<string, unknown>>).find(
        ({ local_date }) => local_date === today,
      ),
    ).toMatchObject({ event_count: 4, alert_count: 1 });
    expect(record!.alertsPage.items).toEqual([
      expect.objectContaining({ id: correctedAlert, event_code: 'important' }),
    ]);
    // trends.severity/adherence no longer read this fixture's old-vocabulary rows (Wave-3 rewrite
    // reads clinical_values on the symptom-vocabulary rows and the adherence_record outcome
    // — covered by the dedicated real-shape trend tests below instead.
    expect(record!.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: oldHeadache, supersedes_id: null }),
        expect.objectContaining({ id: correctedHeadache, supersedes_id: oldHeadache }),
        expect.objectContaining({ id: oldAdherence, supersedes_id: null }),
        expect.objectContaining({ id: correctedAdherence, supersedes_id: oldAdherence }),
        expect.objectContaining({ id: oldAlert, supersedes_id: null }),
        expect.objectContaining({ id: correctedAlert, supersedes_id: oldAlert }),
      ]),
    );

    const alertQueue = await loadAlertQueue(client, DOCTOR_A_SUB, { cursor: null, limit: 10 });
    expect(alertQueue.items).toEqual([
      expect.objectContaining({ id: correctedAlert, event_code: 'important' }),
    ]);
    await client.query('ROLLBACK');
  });

  it("counts only the CURRENT leaf of a severity-refinement supersession chain (tonight's live shape)", async () => {
    await client.query('BEGIN');
    const { today } = await torontoDays();
    const patientId = await seedPatient({ timezone: 'America/Toronto' });
    // v1: identity only -> v2: refined with onset -> v3: refined with severity. Only v3 is current;
    // v1/v2 are superseded leaves and must not double-count the observation.
    const v1 = await seedSymptomEvent({ patientId, day: today, rawSymptom: 'my head hurts' });
    const v2 = await seedSymptomEvent({
      patientId,
      day: today,
      rawSymptom: 'my head hurts',
      onset: 'About an hour ago',
      supersedesId: v1,
    });
    await seedSymptomEvent({
      patientId,
      day: today,
      rawSymptom: 'my head hurts',
      symptomConcept: 'headache',
      onset: 'About an hour ago',
      severity: '8',
      supersedesId: v2,
    });

    const record = await loadPatientRecord(client, patientId, DOCTOR_A_SUB, {
      days: 7,
      selectedDay: today,
      alerts: { cursor: null, limit: 10 },
      drafts: { cursor: null, limit: 10 },
    });
    expect(record?.trends.severity).toEqual([
      { local_date: today, symptom: 'headache', max_severity: 8, observation_count: 1 },
    ]);
    await client.query('ROLLBACK');
  });

  it('aggregates distinct symptoms into separate rows and excludes an unidentified or out-of-range severity', async () => {
    await client.query('BEGIN');
    const { today } = await torontoDays();
    const patientId = await seedPatient({ timezone: 'America/Toronto' });
    await seedSymptomEvent({
      patientId,
      day: today,
      rawSymptom: 'my head hurts',
      symptomConcept: 'headache',
      severity: '8',
    });
    await seedSymptomEvent({
      patientId,
      day: today,
      rawSymptom: 'feeling sick to my stomach',
      symptomConcept: 'nausea',
      severity: '4',
    });
    // No symptom identity resolved yet — excluded regardless of severity.
    await seedSymptomEvent({ patientId, day: today, severity: '5' });
    // Out-of-range / non-numeric severity strings never satisfy the 1-10 regex — excluded.
    await seedSymptomEvent({
      patientId,
      day: today,
      rawSymptom: 'dizzy spell',
      severity: '0',
    });
    await seedSymptomEvent({
      patientId,
      day: today,
      rawSymptom: 'tingling',
      severity: 'bad',
    });

    const record = await loadPatientRecord(client, patientId, DOCTOR_A_SUB, {
      days: 7,
      selectedDay: today,
      alerts: { cursor: null, limit: 10 },
      drafts: { cursor: null, limit: 10 },
    });
    expect(record?.trends.severity).toEqual([
      { local_date: today, symptom: 'headache', max_severity: 8, observation_count: 1 },
      { local_date: today, symptom: 'nausea', max_severity: 4, observation_count: 1 },
    ]);
    await client.query('ROLLBACK');
  });

  // Lane W (2026-08-17): the dashboard's clinicalEventRowSchema is STRICT over the five-value read
  // vocabulary and its rewrite preprocessors were deleted in W3 — so every event_type the day
  // record hands back has to already be in that vocabulary. This is the reader half of the writer
  // projection pinned in clinical-memory/repository.db.test.ts.
  //
  // The legacy row below is the load-bearing half: clinical_event is append-only, so the stored
  // 'symptom' spelling can NEVER be converted in place — the day-events read has to project it.
  // Without that projection one such row fails the whole strict envelope (patient, timeline,
  // messages, alerts, ...), blanking the clinician's entire patient-record page.
  it('returns day-record events only under the five-value dashboard read vocabulary', async () => {
    await client.query('BEGIN');
    const { today } = await torontoDays();
    const patientId = await seedPatient({ timezone: 'America/Toronto' });
    await seedSymptomEvent({
      patientId,
      day: today,
      rawSymptom: 'my head hurts',
      symptomConcept: 'headache',
      severity: '8',
    });
    await seedSymptomEvent({
      patientId,
      day: today,
      rawSymptom: 'still dizzy',
      symptomConcept: 'dizziness',
      severity: '3',
      eventType: 'symptom',
    });

    const record = await loadPatientRecord(client, patientId, DOCTOR_A_SUB, {
      days: 7,
      selectedDay: today,
      alerts: { cursor: null, limit: 10 },
      drafts: { cursor: null, limit: 10 },
    });
    // Mirrors dashboard/src/lib/dashboard-contracts.ts CLINICAL_EVENT_TYPES.
    const readVocabulary = ['patient_statement', 'observation', 'adherence', 'context', 'alert'];
    const eventTypes = (record!.events as Array<{ event_type: string }>).map(
      ({ event_type }) => event_type,
    );
    expect(eventTypes).toEqual(['patient_statement', 'patient_statement']);
    expect(eventTypes.every((eventType) => readVocabulary.includes(eventType))).toBe(true);
    await client.query('ROLLBACK');
  });

  // Stitch (2026-08-17): the Wave-3 severity rewrite keyed off event_type='symptom', but the live
  // writer stores exactly those events as 'patient_statement' — so keying the trend off one
  // event_type spelling alone blanks the severity chart on one side of that boundary or the other.
  // Both spellings are permanent (append-only table), and the symptom payload in clinical_values
  // is the real discriminator.
  it('reads severity trends from a symptom event under either stored event_type spelling', async () => {
    await client.query('BEGIN');
    const { today, yesterday } = await torontoDays();
    const patientId = await seedPatient({ timezone: 'America/Toronto' });
    await seedSymptomEvent({
      patientId,
      day: yesterday,
      rawSymptom: 'my head hurts',
      symptomConcept: 'headache',
      severity: '8',
      eventType: 'symptom',
    });
    await seedSymptomEvent({
      patientId,
      day: today,
      rawSymptom: 'my head hurts',
      symptomConcept: 'headache',
      severity: '6',
      eventType: 'patient_statement',
    });

    const record = await loadPatientRecord(client, patientId, DOCTOR_A_SUB, {
      days: 7,
      selectedDay: today,
      alerts: { cursor: null, limit: 10 },
      drafts: { cursor: null, limit: 10 },
    });
    expect(record?.trends.severity).toEqual([
      { local_date: yesterday, symptom: 'headache', max_severity: 8, observation_count: 1 },
      { local_date: today, symptom: 'headache', max_severity: 6, observation_count: 1 },
    ]);
    await client.query('ROLLBACK');
  });

  it('buckets adherence trends by dose_date from adherence_record, excluding timeout non-response', async () => {
    await client.query('BEGIN');
    const { today, yesterday } = await torontoDays();
    const patientId = await seedPatient({ timezone: 'America/Toronto' });
    await seedReplied(patientId, `${today}T09:00:00Z`, 'taken', today);
    await seedReplied(patientId, `${today}T13:00:00Z`, 'delayed', today);
    await seedReplied(patientId, `${today}T17:00:00Z`, 'skipped', today);
    await seedReplied(patientId, `${today}T18:00:00Z`, 'stopped', today);
    await seedReplied(patientId, `${today}T19:00:00Z`, 'unknown', today);
    await seedReplied(patientId, `${today}T20:00:00Z`, 'question', today);
    // A timeout non-response also lands adherence_state='unknown' — must NOT inflate today's
    // 'unknown' bucket (that would hide genuine non-response inside a classifier count).
    await seedMissed(patientId, `${today}T21:00:00Z`, today);
    await seedReplied(patientId, `${yesterday}T09:00:00Z`, 'taken', yesterday);

    const record = await loadPatientRecord(client, patientId, DOCTOR_A_SUB, {
      days: 7,
      selectedDay: today,
      alerts: { cursor: null, limit: 10 },
      drafts: { cursor: null, limit: 10 },
    });
    expect(record?.trends.adherence).toEqual([
      expect.objectContaining({
        local_date: yesterday,
        taken: 1,
        delayed: 0,
        skipped: 0,
        stopped: 0,
        unknown: 0,
        question: 0,
      }),
      expect.objectContaining({
        local_date: today,
        taken: 1,
        delayed: 1,
        skipped: 1,
        stopped: 1,
        unknown: 1,
        question: 1,
      }),
    ]);
    await client.query('ROLLBACK');
  });

  it('does not re-emit a page-one draft after a decision changes mutable action state', async () => {
    await client.query('BEGIN');
    const { today, yesterday } = await torontoDays();
    const patientId = await seedPatient({ timezone: 'America/Toronto' });
    const newest = await seedDraft(patientId, today, `${today}T18:00:00Z`, 'a');
    const older = await seedDraft(patientId, yesterday, `${yesterday}T18:00:00Z`, 'b');

    const first = await loadDraftQueue(client, DOCTOR_A_SUB, { cursor: null, limit: 1 });
    expect(first.items).toEqual([expect.objectContaining({ id: newest, has_action: false })]);
    const cursorPayload = JSON.parse(
      Buffer.from(first.nextCursor!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(cursorPayload).sort()).toEqual(['createdAt', 'id']);

    await client.query(
      `INSERT INTO clinician_review_action
         (patient_id, clinician_review_draft_id, clinician_sub, decision, expected_version)
       VALUES ($1, $2, $3, 'reject', 1)`,
      [patientId, newest, DOCTOR_A_SUB],
    );

    const second = await loadDraftQueue(client, DOCTOR_A_SUB, {
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(second.items).toEqual([expect.objectContaining({ id: older, has_action: false })]);
    const pending = await loadDraftQueue(client, DOCTOR_A_SUB, { cursor: null, limit: 10 });
    expect(pending.items.map(({ id }) => id)).toEqual([older]);

    const history = await loadPatientRecord(client, patientId, DOCTOR_A_SUB, {
      days: 7,
      selectedDay: today,
      alerts: { cursor: null, limit: 10 },
      drafts: { cursor: null, limit: 10 },
    });
    expect(history?.draftsPage.items.map((row) => (row as { id: string }).id)).toEqual([
      newest,
      older,
    ]);
    expect(history?.draftsPage.items[0]).toEqual(
      expect.objectContaining({
        id: newest,
        latest_action: expect.objectContaining({ decision: 'reject' }),
      }),
    );
    await client.query('ROLLBACK');
  });

  it('holds loader, alert state, and timeline reads to one repeatable-read snapshot', async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const patientId = await seedPatient({ timezone: 'America/Toronto' });
    const { today } = await torontoDays();
    const lateEventId = '70000000-0000-4000-8000-000000000001';
    const lateDoseId = '70000000-0000-4000-8000-000000000002';
    let injected = false;

    const injectAfterScope = async (): Promise<void> => {
      if (injected) return;
      injected = true;
      await pool.query(
        `INSERT INTO clinical_event
           (id, patient_id, event_type, event_code, occurred_at, local_date)
         VALUES ($1, $2, 'alert', 'important', now(), $3::date)`,
        [lateEventId, patientId, today],
      );
      await pool.query(
        `INSERT INTO dose_schedule
           (id, patient_id, scheduled_at, local_dose_time, dose_date)
         VALUES ($1, $2, ($3::date + time '18:00') AT TIME ZONE 'America/Toronto', '18:00', $3)`,
        [lateDoseId, patientId, today],
      );
    };

    const intercept = async (
      delegate: (sql: string, params?: unknown[]) => Promise<unknown>,
      sql: string,
      params?: unknown[],
    ): Promise<unknown> => {
      const result = await delegate(sql, params);
      if (sql.includes('selected_day_in_window')) await injectAfterScope();
      return result;
    };

    const database = {
      query: (sql: string, params?: unknown[]) =>
        intercept(pool.query.bind(pool) as never, sql, params),
      connect: async () => {
        const checkedOut = await pool.connect();
        return {
          query: (sql: string, params?: unknown[]) =>
            intercept(checkedOut.query.bind(checkedOut) as never, sql, params),
          release: () => checkedOut.release(),
        };
      },
    };

    try {
      const result = await handlePatientReadRoute(
        {
          routeKey: 'GET /api/patients/{id}/record',
          pathParameters: { id: patientId },
          queryStringParameters: { day: today, days: '7' },
        },
        DOCTOR_A_SUB,
        {
          getPool: async () => database,
          patientDetailSql: PATIENT_DETAIL_SQL,
          patientTimelineSql: PATIENT_TIMELINE_SQL,
          listPatientsSql: LIST_PATIENTS_SQL,
          alertThreshold: () => 3,
          responseWindowMinutes: () => 120,
          timelineWindowDays: () => 30,
          logMetric: () => undefined,
        } as never,
      );

      expect(result?.statusCode).toBe(200);
      expect(JSON.stringify(result?.body)).not.toContain(lateEventId);
      expect(JSON.stringify(result?.body)).not.toContain(lateDoseId);
      expect(
        (result?.body.dayIndex as Array<Record<string, unknown>>).find(
          ({ local_date }) => local_date === today,
        ),
      ).toMatchObject({ event_count: 0, alert_count: 0 });
    } finally {
      await pool.query('DELETE FROM patient WHERE id = $1', [patientId]);
      await pool.end();
    }
  });
});
