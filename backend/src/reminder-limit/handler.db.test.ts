import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SELECT_MESSAGING_STATE_SQL, SET_REMINDER_LIMIT_SQL } from './handler.js';

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema-init', 'schema.sql'), 'utf8');
const CONTAINER_TIMEOUT_MS = 180_000;
const OWNER_A = '97b4a172-e055-4c37-9d95-2a00664dfe64';
const OWNER_B = 'a6e4e0c8-32a0-4514-a6b6-67c504bf80b4';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

let container: StartedPostgreSqlContainer | undefined;
let client: Client;
let connectionString: string;

beforeAll(async () => {
  const ciUrl = process.env.TEST_DATABASE_URL;
  if (ciUrl) {
    connectionString = ciUrl;
  } else {
    container = await new PostgreSqlContainer('postgres:16').start();
    connectionString = container.getConnectionUri();
  }
  client = new Client({ connectionString });
  await client.connect();
  await client.query(SCHEMA_SQL);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+1500881${String(phoneCounter).padStart(4, '0')}`;
}

async function seedPatient(ownerClinicianSub: string | null = OWNER_A): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO patient (phone, medication_name, owner_clinician_sub)
     VALUES ($1, 'metformin', $2) RETURNING id`,
    [nextPhone(), ownerClinicianSub],
  );
  return result.rows[0]!.id;
}

async function patientRow(id: string) {
  const { rows } = await client.query<{
    reminder_limit: number;
    messaging_state_version: number;
  }>(`SELECT reminder_limit, messaging_state_version FROM patient WHERE id = $1`, [id]);
  return rows[0];
}

async function inRollback<T>(work: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    return await work();
  } finally {
    await client.query('ROLLBACK');
  }
}

describe('doctor reminder limit (real PG16)', () => {
  it('serializes concurrent updates and rechecks the expected version after the lock', async () => {
    const patientId = await seedPatient();
    const firstClient = new Client({ connectionString });
    const secondClient = new Client({ connectionString });
    await firstClient.connect();
    await secondClient.connect();
    try {
      await firstClient.query('BEGIN');
      await secondClient.query('BEGIN');
      expect(
        (await firstClient.query(SET_REMINDER_LIMIT_SQL, [patientId, OWNER_A, 4, 1])).rowCount,
      ).toBe(1);
      await secondClient.query("SET LOCAL lock_timeout = '100ms'");
      await expect(
        secondClient.query(SET_REMINDER_LIMIT_SQL, [patientId, OWNER_A, 0, 1]),
      ).rejects.toMatchObject({ code: '55P03' });
      await secondClient.query('ROLLBACK');
      await firstClient.query('COMMIT');
      expect(
        (await secondClient.query(SET_REMINDER_LIMIT_SQL, [patientId, OWNER_A, 0, 1])).rowCount,
      ).toBe(0);
      expect(await patientRow(patientId)).toEqual({
        reminder_limit: 4,
        messaging_state_version: 2,
      });
    } finally {
      await firstClient.query('ROLLBACK').catch(() => undefined);
      await secondClient.query('ROLLBACK').catch(() => undefined);
      await firstClient.end();
      await secondClient.end();
      await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
    }
  });

  it.each([0, 5])(
    'atomically stores boundary %i and advances the messaging version',
    async (limit) => {
      await inRollback(async () => {
        const patientId = await seedPatient();
        const result = await client.query(SET_REMINDER_LIMIT_SQL, [patientId, OWNER_A, limit, 1]);
        expect(result.rows[0]).toEqual({ reminder_limit: limit, messaging_state_version: 2 });
        expect(await patientRow(patientId)).toEqual({
          reminder_limit: limit,
          messaging_state_version: 2,
        });
      });
    },
  );

  it('a stale version writes nothing and classifies as a conflict', async () => {
    await inRollback(async () => {
      const patientId = await seedPatient();
      expect(
        (await client.query(SET_REMINDER_LIMIT_SQL, [patientId, OWNER_A, 4, 1])).rowCount,
      ).toBe(1);
      expect(
        (await client.query(SET_REMINDER_LIMIT_SQL, [patientId, OWNER_A, 0, 1])).rowCount,
      ).toBe(0);
      expect(await patientRow(patientId)).toEqual({
        reminder_limit: 4,
        messaging_state_version: 2,
      });
      expect(
        (await client.query(SELECT_MESSAGING_STATE_SQL, [patientId, OWNER_A])).rows[0]
          ?.messaging_state_version,
      ).toBe(2);
    });
  });

  it('makes unknown, foreign-owned, and ownerless patients indistinguishable', async () => {
    await inRollback(async () => {
      const foreignId = await seedPatient(OWNER_B);
      await client.query(
        'ALTER TABLE patient DROP CONSTRAINT patient_owner_clinician_sub_not_null',
      );
      const ownerlessId = await seedPatient(null);
      await client.query(
        `ALTER TABLE patient ADD CONSTRAINT patient_owner_clinician_sub_not_null
         CHECK (owner_clinician_sub IS NOT NULL) NOT VALID`,
      );
      for (const patientId of [UNKNOWN_ID, foreignId, ownerlessId]) {
        expect(
          (await client.query(SET_REMINDER_LIMIT_SQL, [patientId, OWNER_A, 3, 1])).rowCount,
        ).toBe(0);
        expect(
          (await client.query(SELECT_MESSAGING_STATE_SQL, [patientId, OWNER_A])).rowCount,
        ).toBe(0);
      }
      expect(await patientRow(foreignId)).toEqual({
        reminder_limit: 2,
        messaging_state_version: 1,
      });
    });
  });

  it('the database constraint backs the shared 0..5 boundary', async () => {
    await inRollback(async () => {
      const patientId = await seedPatient();
      await expect(
        client.query(SET_REMINDER_LIMIT_SQL, [patientId, OWNER_A, 6, 1]),
      ).rejects.toThrow(/patient_reminder_limit_check/);
    });
  });
});
