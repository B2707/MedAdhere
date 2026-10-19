/**
 * write-contract.test.ts — the clinician-deactivation UPDATE contract against a REAL PostgreSQL 16
 * (testcontainers, the schema.test.ts / timeout-write-contract posture). The mocked-pg unit test pins the
 * SQL TEXT + handler order; this test proves the SQL SEMANTICS actually hold in Postgres. It imports the
 * EXACT handler SQL constant (DEACTIVATE_PATIENT_SQL), so a future edit to the handler that breaks the
 * contract fails HERE — no drift between test and code.
 *
 * Requires a running Docker daemon OR a CI-provided TEST_DATABASE_URL (PG 16). NO AWS, NO credentials.
 * (The scheduler sweep is NOT exercised here — it is an AWS call proven by the mocked unit test + the
 * scheduler-deactivate suite. This file proves ONLY the patient-row write contract.)
 *
 * The contract (05-PLAN 05-03 "RED tests"):
 *   - a valid owned patient → is_active flips false, rowCount 1, and opted_out_at STAYS NULL (route is
 *     NOT a patient-STOP — inbound STOP owns opted_out_at, inbound/handler.ts:456);
 *   - unknown, foreign-owned, and ownerless UUIDs → rowCount 0 (the indistinguishable 404 branch);
 *   - an already-inactive owned patient → still rowCount 1 (idempotent clean 200), is_active stays false,
 *     opted_out_at stays NULL.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DEACTIVATE_PATIENT_SQL } from './handler.js';

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema-init', 'schema.sql'), 'utf8');

const CONTAINER_TIMEOUT_MS = 180_000;
const OWNER_A = '97b4a172-e055-4c37-9d95-2a00664dfe64';
const OWNER_B = 'a6e4e0c8-32a0-4514-a6b6-67c504bf80b4';

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

// ---- seed helpers (per-test, inside BEGIN/ROLLBACK) -------------------------------------
let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+1500777${String(phoneCounter).padStart(4, '0')}`;
}

/** Insert an ACTIVE patient (is_active defaults true, opted_out_at NULL). Returns the id. */
async function seedPatient(ownerClinicianSub: string | null = OWNER_A): Promise<string> {
  const p = await client.query<{ id: string }>(
    `INSERT INTO patient (phone, medication_name, owner_clinician_sub)
     VALUES ($1, 'metformin', $2)
     RETURNING id`,
    [nextPhone(), ownerClinicianSub],
  );
  return p.rows[0]!.id;
}

async function patientRow(id: string) {
  const { rows } = await client.query<{ is_active: boolean; opted_out_at: string | null }>(
    `SELECT is_active, opted_out_at FROM patient WHERE id = $1`,
    [id],
  );
  return rows[0];
}

describe('Clinician deactivation UPDATE — owner isolation, no opted_out_at, 404 + idempotent semantics (real PG16)', () => {
  it('a valid ACTIVE owned patient → is_active=false, rowCount 1, opted_out_at STAYS NULL (route ≠ STOP)', async () => {
    await client.query('BEGIN');
    const id = await seedPatient();
    const res = await client.query(DEACTIVATE_PATIENT_SQL, [id, OWNER_A]);
    expect(res.rowCount).toBe(1);
    const row = await patientRow(id);
    expect(row?.is_active).toBe(false);
    // The clinician route must NOT record a STOP opt-out timestamp — only inbound STOP sets opted_out_at.
    expect(row?.opted_out_at).toBeNull();
    await client.query('ROLLBACK');
  });

  it('an UNKNOWN uuid → rowCount 0 (the 404 branch — never a masking update)', async () => {
    await client.query('BEGIN');
    const res = await client.query(DEACTIVATE_PATIENT_SQL, [
      '00000000-0000-4000-8000-000000000000',
      OWNER_A,
    ]);
    expect(res.rowCount).toBe(0);
    await client.query('ROLLBACK');
  });

  it('an ALREADY-INACTIVE owned patient → still rowCount 1 (idempotent 200), stays inactive, opted_out_at NULL', async () => {
    await client.query('BEGIN');
    const id = await seedPatient();
    // First deactivation.
    expect((await client.query(DEACTIVATE_PATIENT_SQL, [id, OWNER_A])).rowCount).toBe(1);
    // Second deactivation on the now-inactive row STILL matches id + owner (idempotent clean 200).
    expect((await client.query(DEACTIVATE_PATIENT_SQL, [id, OWNER_A])).rowCount).toBe(1);
    const row = await patientRow(id);
    expect(row?.is_active).toBe(false);
    expect(row?.opted_out_at).toBeNull();
    await client.query('ROLLBACK');
  });

  it('a patient owned by another clinician → rowCount 0 and remains active', async () => {
    await client.query('BEGIN');
    const id = await seedPatient(OWNER_A);
    const res = await client.query(DEACTIVATE_PATIENT_SQL, [id, OWNER_B]);
    expect(res.rowCount).toBe(0);
    expect((await patientRow(id))?.is_active).toBe(true);
    await client.query('ROLLBACK');
  });

  it('a legacy patient with NULL owner → rowCount 0 and remains active (fail closed)', async () => {
    await client.query('BEGIN');
    // Simulate a restored row that predates the NOT VALID owner check. New NULL-owner rows are rejected;
    // adding the check back as NOT VALID preserves this already-existing legacy violation.
    await client.query('ALTER TABLE patient DROP CONSTRAINT patient_owner_clinician_sub_not_null');
    const id = await seedPatient(null);
    await client.query(
      `ALTER TABLE patient ADD CONSTRAINT patient_owner_clinician_sub_not_null
       CHECK (owner_clinician_sub IS NOT NULL) NOT VALID`,
    );
    const res = await client.query(DEACTIVATE_PATIENT_SQL, [id, OWNER_A]);
    expect(res.rowCount).toBe(0);
    expect((await patientRow(id))?.is_active).toBe(true);
    await client.query('ROLLBACK');
  });
});
