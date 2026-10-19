/**
 * schema.test.ts — apply-twice idempotency + non-skippable introspection contract test
 * for `schema.sql`, the SSOT database schema (D-12 / PIPE-04 / STUDY-04 / F67).
 *
 * F67 (NON-SKIPPABLE): the introspection assertions MUST run against a REAL PostgreSQL 16.
 * This test spins up a throwaway `postgres:16` via testcontainers (requires a running Docker
 * daemon) OR connects to a CI-provided Postgres via the TEST_DATABASE_URL env var. There is
 * NO silent SQL-lint fallback — if neither a Docker daemon nor TEST_DATABASE_URL is available,
 * the test FAILS LOUD in beforeAll. The schema is applied TWICE (each in its own BEGIN/COMMIT,
 * mirroring the Plan-03 custom-resource Lambda) to prove idempotency, then introspected.
 *
 * No AWS SDK and no AWS credentials are required for the testcontainers path — pure local DB.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
// Single source of truth for the STUDY-04 CASCADE child set — the wipe/scrub helper exports it,
// and the drift guard below asserts it EXACTLY equals the live schema so a future child table
// cannot silently escape the tester-data wipe (05-02).
import { STUDY04_CASCADE_CHILDREN } from '../lib/tester-hygiene';

// Backend handlers/tests are CommonJS (F11) — `__dirname` is available natively, so we read
// the bundled schema.sql directly without an `import.meta.url` ESM derivation (which TS rejects
// under CommonJS output, TS1470). This mirrors the schema-init handler's own CJS file read.
const SCHEMA_SQL = readFileSync(join(__dirname, 'schema.sql'), 'utf8');

// Long timeout: pulling the postgres:16 image on a cold cache can take a while.
const CONTAINER_TIMEOUT_MS = 180_000;
const TEST_OWNER_SUB = '97b4a172-e055-4c37-9d95-2a00664dfe64';

let container: StartedPostgreSqlContainer | undefined;
let client: Client;
let databaseUrl: string;

/** Apply schema.sql inside one BEGIN/COMMIT, mirroring the Plan-03 Lambda. */
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
    // CI-provided Postgres (must be PG 16). Connect directly — F67 real-DB path.
    databaseUrl = ciUrl;
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  } else {
    // Throwaway PostgreSQL 16 via testcontainers. Requires a running Docker daemon.
    // F67: NO silent fallback — if Docker is unavailable this throws and the suite FAILS LOUD.
    container = await new PostgreSqlContainer('postgres:16').start();
    databaseUrl = container.getConnectionUri();
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  }

  // Guard the F67 invariant: assert we are really on PostgreSQL 16.
  const { rows } = await client.query<{ server_version: string }>('SHOW server_version');
  const reported = rows[0]?.server_version ?? '';
  const major = Number.parseInt(reported.split('.')[0] ?? '', 10);
  expect(major, `introspection must run against PostgreSQL 16 (got ${reported})`).toBe(16);

  // Apply the schema TWICE — second apply proving idempotency (D-12 / F67).
  await applySchema(client); // first apply
  await expect(applySchema(client)).resolves.not.toThrow(); // second apply — idempotent
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

// ---- helpers ---------------------------------------------------------------------------

async function columnExists(table: string, column: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows.length > 0;
}

async function column(table: string, col: string) {
  const { rows } = await client.query(
    `SELECT data_type, udt_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`,
    [table, col],
  );
  return rows[0] as
    | { data_type: string; udt_name: string; is_nullable: string; column_default: string | null }
    | undefined;
}

/** True if (table, column) is covered by a UNIQUE/PK constraint OR a btree index (F34). */
async function hasUniqueOrIndex(table: string, col: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1
       FROM pg_index ix
       JOIN pg_class t  ON t.oid = ix.indrelid
       JOIN pg_class i  ON i.oid = ix.indexrelid
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (ix.indkey)
      WHERE t.relname = $1 AND a.attname = $2`,
    [table, col],
  );
  return rows.length > 0;
}

/** True iff a named index exists and is a UNIQUE btree index (regardless of partiality). */
async function uniqueIndexExists(indexName: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
      WHERE i.relname = $1 AND ix.indisunique = true`,
    [indexName],
  );
  return rows.length > 0;
}

/**
 * Introspect a named index's (indisunique, indpred-present) flags. `indpred IS NOT NULL`
 * means the index is PARTIAL (carries a WHERE predicate) — used to prove
 * `uq_outbound_message_twilio_sid` is the partial unique (`WHERE twilio_sid IS NOT NULL`),
 * not a plain UNIQUE.
 */
async function indexFlags(
  indexName: string,
): Promise<{ isUnique: boolean; isPartial: boolean } | undefined> {
  const { rows } = await client.query<{ indisunique: boolean; haspred: boolean }>(
    `SELECT ix.indisunique, (ix.indpred IS NOT NULL) AS haspred
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
      WHERE i.relname = $1`,
    [indexName],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return { isUnique: row.indisunique, isPartial: row.haspred };
}

async function expectConstraintRejection(
  operation: () => Promise<unknown>,
  message: string,
): Promise<void> {
  await client.query('BEGIN');
  try {
    await expect(operation(), message).rejects.toThrow();
  } finally {
    await client.query('ROLLBACK');
  }
}

// ---- tests -----------------------------------------------------------------------------

describe('schema.sql — idempotency + contract introspection (F67, real PG16)', () => {
  it('applies twice without error (idempotency proven in beforeAll — D-12)', () => {
    // The double-apply ran in beforeAll; reaching here means both applies + the PG16 guard passed.
    expect(client).toBeDefined();
  });

  it('creates all six v1 tables (D-02)', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const tables = rows.map((r) => r.table_name);
    for (const t of [
      'patient',
      'dose_schedule',
      'outbound_message',
      'inbound_reply',
      'adherence_record',
      'safety_events',
    ]) {
      expect(tables, `table ${t} must exist`).toContain(t);
    }
  });

  it('adherence_record has a UNIQUE constraint on dose_id (PIPE-04)', async () => {
    const { rows } = await client.query(
      `SELECT con.conname
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_attribute a ON a.attrelid = rel.oid AND a.attnum = ANY (con.conkey)
        WHERE rel.relname = 'adherence_record'
          AND con.contype = 'u'
          AND a.attname = 'dose_id'
          AND array_length(con.conkey, 1) = 1`,
    );
    expect(rows.length, 'adherence_record must have a single-column UNIQUE on dose_id').toBe(1);
  });

  it('projects multiple doses from one inbound while keeping dose outcomes unique', async () => {
    const inboundLookup = await indexFlags('idx_adherence_record_inbound_message_id');
    expect(inboundLookup).toEqual({ isUnique: false, isPartial: false });

    const { rows: inboundConstraints } = await client.query<{ conname: string }>(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid = 'adherence_record'::regclass
          AND conname = 'adherence_record_inbound_message_id_key'`,
    );
    expect(inboundConstraints).toHaveLength(0);

    await client.query('BEGIN');
    try {
      const patientId = await seedPatient();
      const { rows: doses } = await client.query<{ id: string }>(
        `INSERT INTO dose_schedule (patient_id, scheduled_at, local_dose_time)
         VALUES ($1, now(), '09:00'), ($1, now(), '21:00')
         RETURNING id`,
        [patientId],
      );
      const { rows: inbound } = await client.query<{ id: string }>(
        `INSERT INTO inbound_reply (patient_id, raw_body)
         VALUES ($1, 'took both doses') RETURNING id`,
        [patientId],
      );
      const inboundId = inbound[0]!.id;

      await expect(
        client.query(
          `INSERT INTO adherence_record
             (patient_id, dose_id, inbound_message_id, adherence_state, reason_code,
              safety_flag, decided_by, status)
           VALUES ($1, $2, $4, 'taken', 'none', 'none', 'classifier', 'recorded'),
                  ($1, $3, $4, 'taken', 'none', 'none', 'classifier', 'recorded')`,
          [patientId, doses[0]!.id, doses[1]!.id, inboundId],
        ),
        'one inbound message can project one current outcome for each distinct dose',
      ).resolves.toMatchObject({ rowCount: 2 });

      await client.query('SAVEPOINT duplicate_dose');
      await expect(
        client.query(
          `INSERT INTO adherence_record
             (patient_id, dose_id, inbound_message_id, adherence_state, reason_code,
              safety_flag, decided_by, status)
           VALUES ($1, $2, $3, 'taken', 'none', 'none', 'classifier', 'recorded')`,
          [patientId, doses[0]!.id, inboundId],
        ),
        'one dose still has only one current adherence outcome',
      ).rejects.toThrow();
      await client.query('ROLLBACK TO SAVEPOINT duplicate_dose');
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('adherence_record has adherence_state (NOT NULL enum), reason_code (NOT NULL enum), status (F31/F37)', async () => {
    const state = await column('adherence_record', 'adherence_state');
    expect(state?.udt_name).toBe('adherence_state_enum');
    expect(state?.is_nullable).toBe('NO');

    const reason = await column('adherence_record', 'reason_code');
    expect(reason?.udt_name).toBe('reason_code_enum');
    expect(reason?.is_nullable).toBe('NO');

    expect(await columnExists('adherence_record', 'status')).toBe(true);
    expect(await columnExists('adherence_record', 'decided_by')).toBe(true);
  });

  it('both inbound_message_id columns carry a UNIQUE constraint or btree index (F34)', async () => {
    expect(await hasUniqueOrIndex('adherence_record', 'inbound_message_id')).toBe(true);
    expect(await hasUniqueOrIndex('safety_events', 'inbound_message_id')).toBe(true);
  });

  it('safety_events has inbound_message_id (NOT NULL FK), flag_category domain, created_at (F32)', async () => {
    const fk = await column('safety_events', 'inbound_message_id');
    expect(fk?.is_nullable).toBe('NO');

    expect(await columnExists('safety_events', 'created_at')).toBe(true);

    // flag_category admits the three domain values…
    for (const ok of ['acute_physical', 'crisis', 'medical_question']) {
      await client.query('BEGIN');
      const setup = await seedInboundReply();
      await expect(
        client.query(
          `INSERT INTO safety_events (patient_id, inbound_message_id, flag_category)
           VALUES ($1, $2, $3)`,
          [setup.patientId, setup.inboundId, ok],
        ),
        `flag_category should admit '${ok}'`,
      ).resolves.toBeDefined();
      await client.query('ROLLBACK');
    }

    // …and rejects 'none' and a foreign value (F32 — never 'none').
    for (const bad of ['none', 'not_a_flag']) {
      await client.query('BEGIN');
      const setup = await seedInboundReply();
      await expect(
        client.query(
          `INSERT INTO safety_events (patient_id, inbound_message_id, flag_category)
           VALUES ($1, $2, $3)`,
          [setup.patientId, setup.inboundId, bad],
        ),
        `flag_category must reject '${bad}'`,
      ).rejects.toThrow();
      await client.query('ROLLBACK');
    }
  });

  it('outbound_message.status admits its domain and rejects a foreign value (F37)', async () => {
    for (const ok of ['queued', 'sent', 'delivered', 'undelivered', 'failed']) {
      await client.query('BEGIN');
      const patientId = await seedPatient();
      await expect(
        client.query(`INSERT INTO outbound_message (patient_id, status) VALUES ($1, $2)`, [
          patientId,
          ok,
        ]),
        `outbound_message.status should admit '${ok}'`,
      ).resolves.toBeDefined();
      await client.query('ROLLBACK');
    }
    await client.query('BEGIN');
    const patientId = await seedPatient();
    await expect(
      client.query(`INSERT INTO outbound_message (patient_id, status) VALUES ($1, 'bogus')`, [
        patientId,
      ]),
    ).rejects.toThrow();
    await client.query('ROLLBACK');
  });

  it("adherence_record.status admits 'missed'/'recorded' and rejects a foreign value (F37)", async () => {
    for (const ok of ['recorded', 'missed']) {
      await client.query('BEGIN');
      const { patientId, doseId } = await seedDose();
      await expect(
        client.query(
          `INSERT INTO adherence_record
             (patient_id, dose_id, adherence_state, reason_code, safety_flag, decided_by, status)
           VALUES ($1, $2, 'taken', 'none', 'none', 'classifier', $3)`,
          [patientId, doseId, ok],
        ),
        `adherence_record.status should admit '${ok}'`,
      ).resolves.toBeDefined();
      await client.query('ROLLBACK');
    }
    await client.query('BEGIN');
    const { patientId, doseId } = await seedDose();
    await expect(
      client.query(
        `INSERT INTO adherence_record
           (patient_id, dose_id, adherence_state, reason_code, safety_flag, decided_by, status)
         VALUES ($1, $2, 'taken', 'none', 'none', 'classifier', 'no_reply')`,
        [patientId, doseId],
      ),
    ).rejects.toThrow();
    await client.query('ROLLBACK');
  });

  it('safety_flag admits exactly the four values and rejects a fifth — never a boolean (PIPE-04)', async () => {
    // It is an enum type, not a boolean column.
    const sf = await column('adherence_record', 'safety_flag');
    expect(sf?.udt_name).toBe('safety_flag_enum');
    expect(sf?.data_type).not.toBe('boolean');

    // Enum labels are exactly the four contract values (one row per label, ordered).
    const { rows } = await client.query<{ enumlabel: string }>(
      `SELECT e.enumlabel
         FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname = 'safety_flag_enum'
        ORDER BY e.enumsortorder`,
    );
    expect(rows.map((r) => r.enumlabel)).toEqual([
      'none',
      'acute_physical',
      'crisis',
      'medical_question',
    ]);

    // A fifth value is rejected at insert time.
    await client.query('BEGIN');
    const { patientId, doseId } = await seedDose();
    await expect(
      client.query(
        `INSERT INTO adherence_record
           (patient_id, dose_id, adherence_state, reason_code, safety_flag, decided_by, status)
         VALUES ($1, $2, 'taken', 'none', 'self_harm_xyz', 'classifier', 'recorded')`,
        [patientId, doseId],
      ),
    ).rejects.toThrow();
    await client.query('ROLLBACK');
  });

  it('every child table FKs to patient with ON DELETE CASCADE (STUDY-04)', async () => {
    const { rows } = await client.query<{ table_name: string; delete_rule: string }>(
      `SELECT tc.table_name, rc.delete_rule
         FROM information_schema.referential_constraints rc
         JOIN information_schema.table_constraints tc
              ON tc.constraint_name = rc.constraint_name
         JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name = rc.unique_constraint_name
        WHERE ccu.table_name = 'patient'`,
    );
    const childrenCascading = new Set(
      rows.filter((r) => r.delete_rule === 'CASCADE').map((r) => r.table_name),
    );
    for (const child of [
      'dose_schedule',
      'outbound_message',
      'inbound_reply',
      'adherence_record',
      'safety_events',
      'label_match', // Phase-4 append (04-01 / gate fix U-13)
    ]) {
      expect(childrenCascading, `${child} must FK patient ON DELETE CASCADE`).toContain(child);
    }
  });

  it('the live CASCADE-to-patient child set EXACTLY equals STUDY04_CASCADE_CHILDREN (drift guard — no new child can silently escape the wipe/scrub)', async () => {
    const { rows } = await client.query<{ table_name: string; delete_rule: string }>(
      `SELECT tc.table_name, rc.delete_rule
         FROM information_schema.referential_constraints rc
         JOIN information_schema.table_constraints tc
              ON tc.constraint_name = rc.constraint_name
         JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name = rc.unique_constraint_name
        WHERE ccu.table_name = 'patient'`,
    );
    const liveCascade = [
      ...new Set(rows.filter((r) => r.delete_rule === 'CASCADE').map((r) => r.table_name)),
    ].sort();
    expect(
      liveCascade,
      'a new CASCADE child of patient must be added to STUDY04_CASCADE_CHILDREN (backend/src/lib/tester-hygiene.ts) and the 05-02 wipe proof, or it escapes the STUDY-04 wipe',
    ).toEqual([...STUDY04_CASCADE_CHILDREN].sort());
  });

  it('the STUDY-04 wipe (DELETE FROM patient WHERE is_test) cascades with no orphans', async () => {
    await client.query('BEGIN');
    const { patientId, doseId } = await seedDose(true /* is_test */);
    const inboundRows = (
      await client.query<{ id: string }>(
        `INSERT INTO inbound_reply (patient_id, dose_id, raw_body) VALUES ($1, $2, 'took it') RETURNING id`,
        [patientId, doseId],
      )
    ).rows;
    const inboundId = inboundRows[0]?.id;
    expect(inboundId, 'inbound_reply insert must return an id').toBeDefined();
    await client.query(
      `INSERT INTO outbound_message (patient_id, dose_id, status) VALUES ($1, $2, 'sent')`,
      [patientId, doseId],
    );
    await client.query(
      `INSERT INTO adherence_record
         (patient_id, dose_id, inbound_message_id, adherence_state, reason_code, safety_flag, decided_by, status)
       VALUES ($1, $2, $3, 'taken', 'none', 'none', 'classifier', 'recorded')`,
      [patientId, doseId, inboundId],
    );
    await client.query(
      `INSERT INTO safety_events (patient_id, inbound_message_id, flag_category) VALUES ($1, $2, 'crisis')`,
      [patientId, inboundId],
    );
    // Phase-4 append (gate fix U-13): label_match must ride the same STUDY-04 wipe.
    await client.query(
      `INSERT INTO label_match (patient_id, inbound_message_id, matched_phrase, meddra_pt, hint_level)
       VALUES ($1, $2, 'stomach hurt', 'Abdominal pain', 'info')`,
      [patientId, inboundId],
    );

    await client.query(`DELETE FROM patient WHERE is_test = true`);

    for (const t of [
      'dose_schedule',
      'outbound_message',
      'inbound_reply',
      'adherence_record',
      'safety_events',
      'label_match', // Phase-4 append (04-01 / gate fix U-13)
    ]) {
      const { rows } = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`);
      expect(Number(rows[0]?.n), `${t} must have no orphan rows after the cascade wipe`).toBe(0);
    }
    await client.query('ROLLBACK');
  });

  it('patient has is_test (boolean default false), medication_name (NOT NULL), drug_profile_json (jsonb), drug_profile_fetched_at (timestamptz)', async () => {
    const isTest = await column('patient', 'is_test');
    expect(isTest?.data_type).toBe('boolean');
    expect(isTest?.column_default).toMatch(/false/);

    const med = await column('patient', 'medication_name');
    expect(med?.data_type).toBe('text');
    expect(med?.is_nullable).toBe('NO');

    const profile = await column('patient', 'drug_profile_json');
    expect(profile?.data_type).toBe('jsonb');

    const fetched = await column('patient', 'drug_profile_fetched_at');
    expect(fetched?.data_type).toBe('timestamp with time zone');
  });

  it('introduces no schema_migrations table and no migration-tool artifacts (D-12)', async () => {
    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations'`,
    );
    expect(rows.length).toBe(0);
  });

  // ---- Phase 3 additive append (SC1) -------------------------------------------------

  it('dose_schedule has schedule_timezone (text) and dose_date (date), both NULLABLE (additive, PIPE-09)', async () => {
    const tz = await column('dose_schedule', 'schedule_timezone');
    expect(tz?.data_type).toBe('text');
    expect(tz?.is_nullable, 'schedule_timezone must be additive/NULLABLE').toBe('YES');

    const dd = await column('dose_schedule', 'dose_date');
    expect(dd?.data_type).toBe('date');
    expect(dd?.is_nullable, 'dose_date must be additive/NULLABLE').toBe('YES');
  });

  it('outbound_message has status_updated_at (timestamptz), NULLABLE (additive, SC7)', async () => {
    const col = await column('outbound_message', 'status_updated_at');
    expect(col?.data_type).toBe('timestamp with time zone');
    expect(col?.is_nullable, 'status_updated_at must be additive/NULLABLE').toBe('YES');
  });

  it('stores only a nullable unique callback-token hash for opaque Twilio correlation', async () => {
    const tokenHash = await column('outbound_message', 'callback_token_hash');
    expect(tokenHash?.data_type).toBe('bytea');
    expect(tokenHash?.is_nullable).toBe('YES');

    const flags = await indexFlags('uq_outbound_message_callback_token_hash');
    expect(flags).toEqual({ isUnique: true, isPartial: true });

    await client.query('BEGIN');
    const firstPatient = await seedPatient();
    const secondPatient = await seedPatient();
    const hash = Buffer.alloc(32, 7);
    await client.query(
      `INSERT INTO outbound_message (patient_id, status, callback_token_hash)
       VALUES ($1, 'sending', $2)`,
      [firstPatient, hash],
    );
    await client.query('SAVEPOINT duplicate_callback_hash');
    await expect(
      client.query(
        `INSERT INTO outbound_message (patient_id, status, callback_token_hash)
         VALUES ($1, 'sending', $2)`,
        [secondPatient, hash],
      ),
      'one opaque token hash must correlate to at most one outbound row',
    ).rejects.toThrow();
    await client.query('ROLLBACK TO SAVEPOINT duplicate_callback_hash');
    await expect(
      client.query(`INSERT INTO outbound_message (patient_id, status) VALUES ($1, 'sending')`, [
        secondPatient,
      ]),
    ).resolves.toBeDefined();
    await client.query('ROLLBACK');
  });

  it('keeps one check-in and numbered reminder reservations per dose', async () => {
    expect(await uniqueIndexExists('uq_outbound_message_check_in_dose_id')).toBe(true);
    expect(await uniqueIndexExists('uq_outbound_message_reminder_attempt')).toBe(true);
    await client.query('BEGIN');
    const { patientId, doseId } = await seedDose();
    await client.query(
      `INSERT INTO outbound_message (patient_id, dose_id, status, message_kind)
       VALUES ($1, $2, 'queued', 'check_in')`,
      [patientId, doseId],
    );
    await client.query('SAVEPOINT duplicate_check_in');
    await expect(
      client.query(
        `INSERT INTO outbound_message (patient_id, dose_id, status, message_kind)
         VALUES ($1, $2, 'queued', 'check_in')`,
        [patientId, doseId],
      ),
      'a dose can have only one check-in reservation',
    ).rejects.toThrow();
    await client.query('ROLLBACK TO SAVEPOINT duplicate_check_in');
    await client.query(
      `INSERT INTO outbound_message
         (patient_id, dose_id, status, message_kind, reminder_attempt)
       VALUES ($1, $2, 'queued', 'reminder', 1),
              ($1, $2, 'queued', 'reminder', 2)`,
      [patientId, doseId],
    );
    await client.query('SAVEPOINT duplicate_reminder');
    await expect(
      client.query(
        `INSERT INTO outbound_message
           (patient_id, dose_id, status, message_kind, reminder_attempt)
         VALUES ($1, $2, 'queued', 'reminder', 2)`,
        [patientId, doseId],
      ),
      'a reminder attempt can be reserved only once per dose',
    ).rejects.toThrow();
    await client.query('ROLLBACK TO SAVEPOINT duplicate_reminder');
    await client.query('ROLLBACK');
  });

  it('uq_outbound_message_twilio_sid is a PARTIAL unique index (indisunique=true AND indpred present)', async () => {
    const flags = await indexFlags('uq_outbound_message_twilio_sid');
    expect(flags, 'uq_outbound_message_twilio_sid must exist').toBeDefined();
    expect(flags?.isUnique, 'must be a UNIQUE index').toBe(true);
    expect(
      flags?.isPartial,
      'must be PARTIAL (WHERE twilio_sid IS NOT NULL) — not a plain UNIQUE',
    ).toBe(true);

    // The partial predicate means multiple NULL twilio_sid rows are allowed (queued, pre-send)…
    await client.query('BEGIN');
    const p1 = await seedPatient();
    const p2 = await seedPatient();
    await client.query(`INSERT INTO outbound_message (patient_id, status) VALUES ($1, 'queued')`, [
      p1,
    ]);
    await expect(
      client.query(`INSERT INTO outbound_message (patient_id, status) VALUES ($1, 'queued')`, [p2]),
      'multiple NULL twilio_sid rows must be allowed (partial predicate)',
    ).resolves.toBeDefined();
    await client.query('ROLLBACK');

    // …while two rows with the SAME non-null twilio_sid are rejected (unique on the set sid).
    await client.query('BEGIN');
    const p3 = await seedPatient();
    const p4 = await seedPatient();
    await client.query(
      `INSERT INTO outbound_message (patient_id, twilio_sid, status) VALUES ($1, 'SM_dup', 'sent')`,
      [p3],
    );
    await expect(
      client.query(
        `INSERT INTO outbound_message (patient_id, twilio_sid, status) VALUES ($1, 'SM_dup', 'sent')`,
        [p4],
      ),
      'a duplicate non-null twilio_sid must violate the partial unique index',
    ).rejects.toThrow();
    await client.query('ROLLBACK');
  });

  it("outbound_message.status accepts the widened 'sending' value and still rejects a bogus value (HIGH-2)", async () => {
    // The widened CHECK admits 'sending' (the pre-send reservation state)…
    await client.query('BEGIN');
    const patientId = await seedPatient();
    await expect(
      client.query(`INSERT INTO outbound_message (patient_id, status) VALUES ($1, 'sending')`, [
        patientId,
      ]),
      "the widened CHECK must admit 'sending'",
    ).resolves.toBeDefined();
    await client.query('ROLLBACK');

    // …and the full widened domain remains valid…
    for (const ok of ['queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed']) {
      await client.query('BEGIN');
      const pid = await seedPatient();
      await expect(
        client.query(`INSERT INTO outbound_message (patient_id, status) VALUES ($1, $2)`, [
          pid,
          ok,
        ]),
        `widened status CHECK should admit '${ok}'`,
      ).resolves.toBeDefined();
      await client.query('ROLLBACK');
    }

    // …while a bogus value is still rejected (the CHECK is widened, not removed).
    await client.query('BEGIN');
    const pid2 = await seedPatient();
    await expect(
      client.query(`INSERT INTO outbound_message (patient_id, status) VALUES ($1, 'bogus_state')`, [
        pid2,
      ]),
    ).rejects.toThrow();
    await client.query('ROLLBACK');
  });
});

// ---- Phase 4 (04-01) — inbound/classifier/safety appends --------------------------------
// Six guarded DDL items ratified by the 2026-07-03 pre-exec gate (04-PLAN Plan 04-01).

describe('schema.sql — Phase-4 appends (04-01, six guarded DDL items)', () => {
  // (a) PIPE-03 dedup: inbound_reply.twilio_message_sid + partial unique index
  it('inbound_reply.twilio_message_sid is nullable text with a PARTIAL unique index', async () => {
    const col = await column('inbound_reply', 'twilio_message_sid');
    expect(col?.data_type).toBe('text');
    expect(col?.is_nullable).toBe('YES');

    const flags = await indexFlags('uq_inbound_reply_twilio_message_sid');
    expect(flags, 'uq_inbound_reply_twilio_message_sid must exist').toBeDefined();
    expect(flags?.isUnique, 'must be a UNIQUE index').toBe(true);
    expect(
      flags?.isPartial,
      'must be PARTIAL (WHERE twilio_message_sid IS NOT NULL) — pre-existing NULL rows unaffected',
    ).toBe(true);
  });

  it('dedup contract: ON CONFLICT (twilio_message_sid) WHERE … IS NOT NULL DO NOTHING suppresses a replay (gate fix U-03)', async () => {
    await client.query('BEGIN');
    const pid = await seedPatient();
    const insertSql = `INSERT INTO inbound_reply (patient_id, raw_body, twilio_message_sid)
        VALUES ($1, 'took it', 'SMdup00000000000000000000000000000')
        ON CONFLICT (twilio_message_sid) WHERE twilio_message_sid IS NOT NULL DO NOTHING
        RETURNING id`;
    const first = await client.query(insertSql, [pid]);
    expect(first.rowCount, 'first webhook delivery must insert').toBe(1);
    const replay = await client.query(insertSql, [pid]);
    expect(replay.rowCount, 'Twilio retry of the same MessageSid must be a silent no-op').toBe(0);
    // NULL sids stay unconstrained (pre-Phase-4 rows / non-webhook writes).
    await client.query(`INSERT INTO inbound_reply (patient_id, raw_body) VALUES ($1, 'a')`, [pid]);
    await client.query(`INSERT INTO inbound_reply (patient_id, raw_body) VALUES ($1, 'b')`, [pid]);
    await client.query('ROLLBACK');
  });

  // (b) SC3 OR-semantics provenance: safety_events.trigger_source
  it('safety_events.trigger_source is nullable text CHECK-limited to prefilter|model|both', async () => {
    const col = await column('safety_events', 'trigger_source');
    expect(col?.data_type).toBe('text');
    expect(col?.is_nullable).toBe('YES');

    for (const ok of ['prefilter', 'model', 'both']) {
      await client.query('BEGIN');
      const { patientId, inboundId } = await seedInboundReply();
      await expect(
        client.query(
          `INSERT INTO safety_events (patient_id, inbound_message_id, flag_category, trigger_source)
           VALUES ($1, $2, 'crisis', $3)`,
          [patientId, inboundId, ok],
        ),
        `trigger_source CHECK should admit '${ok}'`,
      ).resolves.toBeDefined();
      await client.query('ROLLBACK');
    }

    await client.query('BEGIN');
    const { patientId, inboundId } = await seedInboundReply();
    await expect(
      client.query(
        `INSERT INTO safety_events (patient_id, inbound_message_id, flag_category, trigger_source)
         VALUES ($1, $2, 'crisis', 'webhook')`,
        [patientId, inboundId],
      ),
    ).rejects.toThrow();
    await client.query('ROLLBACK');
  });

  // (c) U-18/REV-H5: auto-reply send-state lifecycle columns
  it('safety_events auto-reply lifecycle columns exist; auto_reply_status CHECK admits sending|sent|failed|suppressed', async () => {
    const status = await column('safety_events', 'auto_reply_status');
    expect(status?.data_type).toBe('text');
    expect(status?.is_nullable).toBe('YES');
    expect((await column('safety_events', 'auto_reply_twilio_sid'))?.data_type).toBe('text');
    expect((await column('safety_events', 'auto_reply_sent_at'))?.data_type).toBe(
      'timestamp with time zone',
    );
    expect((await column('safety_events', 'auto_reply_error'))?.data_type).toBe('text');

    for (const ok of ['sending', 'sent', 'failed', 'suppressed']) {
      await client.query('BEGIN');
      const { patientId, inboundId } = await seedInboundReply();
      await expect(
        client.query(
          `INSERT INTO safety_events (patient_id, inbound_message_id, flag_category, auto_reply_status)
           VALUES ($1, $2, 'crisis', $3)`,
          [patientId, inboundId, ok],
        ),
        `auto_reply_status CHECK should admit '${ok}'`,
      ).resolves.toBeDefined();
      await client.query('ROLLBACK');
    }

    await client.query('BEGIN');
    const { patientId, inboundId } = await seedInboundReply();
    await expect(
      client.query(
        `INSERT INTO safety_events (patient_id, inbound_message_id, flag_category, auto_reply_status)
         VALUES ($1, $2, 'crisis', 'retrying')`,
        [patientId, inboundId],
      ),
    ).rejects.toThrow();
    await client.query('ROLLBACK');
  });

  // (d) DRUG-02: label_match — replay-idempotent multi-match (REV-M1)
  it('label_match: duplicate matcher write is suppressed by UNIQUE (inbound_message_id, matched_phrase, meddra_pt); a different PT is a new row', async () => {
    await client.query('BEGIN');
    const { patientId, inboundId } = await seedInboundReply();
    const insertSql = `INSERT INTO label_match (patient_id, inbound_message_id, matched_phrase, meddra_pt, hint_level)
        VALUES ($1, $2, 'stomach hurt', $3, 'info')
        ON CONFLICT (inbound_message_id, matched_phrase, meddra_pt) DO NOTHING
        RETURNING id`;
    expect((await client.query(insertSql, [patientId, inboundId, 'Abdominal pain'])).rowCount).toBe(
      1,
    );
    expect(
      (await client.query(insertSql, [patientId, inboundId, 'Abdominal pain'])).rowCount,
      'classifier-event replay must not duplicate the ADE hint',
    ).toBe(0);
    expect(
      (await client.query(insertSql, [patientId, inboundId, 'Nausea'])).rowCount,
      'a different mapped PT for the same reply is a legitimate second match',
    ).toBe(1);
    await client.query('ROLLBACK');
  });

  it('label_match.hint_level CHECK admits info|elevated only', async () => {
    // Positive path for BOTH admitted values (04-01 db-review: 'elevated' must not pass only
    // incidentally — a typo'd CHECK list would otherwise survive this suite).
    for (const ok of ['info', 'elevated']) {
      await client.query('BEGIN');
      const { patientId, inboundId } = await seedInboundReply();
      await expect(
        client.query(
          `INSERT INTO label_match (patient_id, inbound_message_id, matched_phrase, meddra_pt, hint_level)
           VALUES ($1, $2, 'rash', 'Rash', $3)`,
          [patientId, inboundId, ok],
        ),
        `hint_level CHECK should admit '${ok}'`,
      ).resolves.toBeDefined();
      await client.query('ROLLBACK');
    }

    await client.query('BEGIN');
    const { patientId, inboundId } = await seedInboundReply();
    await expect(
      client.query(
        `INSERT INTO label_match (patient_id, inbound_message_id, matched_phrase, meddra_pt, hint_level)
         VALUES ($1, $2, 'rash', 'Rash', 'high')`,
        [patientId, inboundId],
      ),
    ).rejects.toThrow();
    await client.query('ROLLBACK');
  });

  it('the two new nullable CHECK columns admit omission (NULL) — the additive contract for pre-Phase-4 rows', async () => {
    await client.query('BEGIN');
    const { patientId, inboundId } = await seedInboundReply();
    const { rows } = await client.query<{
      trigger_source: string | null;
      auto_reply_status: string | null;
    }>(
      `INSERT INTO safety_events (patient_id, inbound_message_id, flag_category)
       VALUES ($1, $2, 'crisis')
       RETURNING trigger_source, auto_reply_status`,
      [patientId, inboundId],
    );
    expect(rows[0]?.trigger_source, 'CHECK must treat NULL as non-violating').toBeNull();
    expect(rows[0]?.auto_reply_status, 'CHECK must treat NULL as non-violating').toBeNull();
    await client.query('ROLLBACK');
  });

  // Mutates un-transactioned state, then restores it (like the pre-check test below).
  it('the guarded ADD CONSTRAINTs re-apply cleanly over a table with LIVE pre-Phase-4 rows (production upgrade path)', async () => {
    // Seed a committed safety_events row shaped like pre-Phase-4 data (new columns NULL).
    const { rows: pr } = await client.query<{ id: string }>(
      `INSERT INTO patient (phone, medication_name, owner_clinician_sub)
       VALUES ('+15005558888', 'metformin', $1)
       RETURNING id`,
      [TEST_OWNER_SUB],
    );
    const seededPatient = pr[0]!.id;
    const { rows: ir } = await client.query<{ id: string }>(
      `INSERT INTO inbound_reply (patient_id, raw_body) VALUES ($1, 'chest pain') RETURNING id`,
      [seededPatient],
    );
    await client.query(
      `INSERT INTO safety_events (patient_id, inbound_message_id, flag_category) VALUES ($1, $2, 'acute_physical')`,
      [seededPatient, ir[0]!.id],
    );

    // Re-apply the full schema over the live data: the pg_constraint-guarded CHECK adds must
    // validate against the existing NULL rows without error.
    await expect(applySchema(client)).resolves.not.toThrow();

    const { rows: after } = await client.query<{ trigger_source: string | null }>(
      `SELECT trigger_source FROM safety_events WHERE patient_id = $1`,
      [seededPatient],
    );
    expect(after).toHaveLength(1);
    expect(after[0]?.trigger_source).toBeNull();

    // Restore: cascade-delete the seeded patient.
    await client.query(`DELETE FROM patient WHERE id = $1`, [seededPatient]);
  });

  // (e) U-01/REV-H2: unattributed classifications persist with dose_id NULL
  it('adherence_record.dose_id is nullable; multiple unattributed (NULL dose_id) rows coexist under UNIQUE(dose_id)', async () => {
    const col = await column('adherence_record', 'dose_id');
    expect(col?.is_nullable, 'dose_id must be nullable (gate fix U-01)').toBe('YES');

    await client.query('BEGIN');
    const a = await seedInboundReply();
    const b = await seedInboundReply();
    const insertSql = `INSERT INTO adherence_record
        (patient_id, dose_id, inbound_message_id, adherence_state, reason_code, safety_flag, decided_by, status)
      VALUES ($1, NULL, $2, 'taken', 'none', 'none', 'classifier', 'recorded')`;
    await expect(client.query(insertSql, [a.patientId, a.inboundId])).resolves.toBeDefined();
    await expect(
      client.query(insertSql, [b.patientId, b.inboundId]),
      'PG unique semantics: multiple NULL dose_id rows must coexist',
    ).resolves.toBeDefined();
    await client.query('ROLLBACK');
  });

  // (f) REV-H4: one active patient per phone
  it('uq_patient_active_phone is a PARTIAL unique index: a second ACTIVE row with the same phone is rejected; deactivated rows may share it', async () => {
    const flags = await indexFlags('uq_patient_active_phone');
    expect(flags, 'uq_patient_active_phone must exist').toBeDefined();
    expect(flags?.isUnique).toBe(true);
    expect(flags?.isPartial, 'must be PARTIAL (WHERE is_active = true)').toBe(true);

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO patient (phone, medication_name, owner_clinician_sub)
       VALUES ('+15005550777', 'metformin', $1)`,
      [TEST_OWNER_SUB],
    );
    await expect(
      client.query(
        `INSERT INTO patient (phone, medication_name, owner_clinician_sub)
         VALUES ('+15005550777', 'lisinopril', $1)`,
        [TEST_OWNER_SUB],
      ),
      'two ACTIVE rows sharing a phone would attach events to the wrong patient (REV-H4)',
    ).rejects.toThrow();
    await client.query('ROLLBACK');

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO patient (phone, medication_name, is_active, owner_clinician_sub)
       VALUES ('+15005550778', 'metformin', false, $1)`,
      [TEST_OWNER_SUB],
    );
    await expect(
      client.query(
        `INSERT INTO patient (phone, medication_name, owner_clinician_sub)
         VALUES ('+15005550778', 'lisinopril', $1)`,
        [TEST_OWNER_SUB],
      ),
      'a deactivated (STOP/opted-out) row must not block re-enrollment on the same phone',
    ).resolves.toBeDefined();
    await client.query('ROLLBACK');
  });

  // Runs LAST in this block: mutates un-transactioned state, then restores it.
  it('duplicate-active-phone pre-check fails the apply with an actionable message and recovers after remediation', async () => {
    // Simulate PRE-EXISTING duplicate data from before the Phase-4 append existed.
    await client.query('DROP INDEX IF EXISTS uq_patient_active_phone');
    await client.query(
      `INSERT INTO patient (phone, medication_name, owner_clinician_sub)
       VALUES ('+15005559999', 'metformin', $1), ('+15005559999', 'lisinopril', $1)`,
      [TEST_OWNER_SUB],
    );
    await expect(applySchema(client)).rejects.toThrow(/uq_patient_active_phone pre-check/);
    // Remediate per the error's own instruction, then the apply must succeed again.
    await client.query(`DELETE FROM patient WHERE phone = '+15005559999'`);
    await expect(applySchema(client)).resolves.not.toThrow();
    const flags = await indexFlags('uq_patient_active_phone');
    expect(flags?.isUnique, 'index must be restored by the recovery apply').toBe(true);
  });
});

describe('schema.sql — Phase-8 clinician ownership append', () => {
  it('adds a nullable text owner_clinician_sub column and an owner lookup index', async () => {
    const ownerColumn = await column('patient', 'owner_clinician_sub');
    expect(ownerColumn?.data_type).toBe('text');
    expect(ownerColumn?.is_nullable).toBe('YES');

    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'patient'
          AND indexname = 'idx_patient_owner_clinician_sub'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toMatch(/\(owner_clinician_sub\)/);
  });

  it('rejects every new ownerless patient while leaving the column physically nullable', async () => {
    await expectConstraintRejection(
      () =>
        client.query(
          `INSERT INTO patient (phone, medication_name)
           VALUES ($1, 'metformin')`,
          [nextSeedPhone()],
        ),
      'new patients must never be silently ownerless',
    );
  });

  it('rejects non-UUID clinician owners while accepting the exact UUID trust-boundary shape', async () => {
    const { rows: constraints } = await client.query<{
      convalidated: boolean;
      definition: string;
    }>(
      `SELECT convalidated, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'patient'::regclass
          AND conname = 'patient_owner_clinician_sub_uuid_shape'`,
    );
    expect(constraints).toHaveLength(1);
    expect(constraints[0]?.convalidated).toBe(false);
    expect(constraints[0]?.definition).toMatch(/owner_clinician_sub IS NULL/);

    await expectConstraintRejection(
      () =>
        client.query(
          `INSERT INTO patient (phone, medication_name, owner_clinician_sub)
           VALUES ($1, 'metformin', 'not-a-cognito-uuid')`,
          [nextSeedPhone()],
        ),
      'new non-NULL owners must match the exact UUID boundary',
    );

    const validPhone = nextSeedPhone();
    try {
      await expect(
        client.query(
          `INSERT INTO patient (phone, medication_name, owner_clinician_sub)
           VALUES ($1, 'metformin', $2)`,
          [validPhone, TEST_OWNER_SUB],
        ),
      ).resolves.toBeDefined();
    } finally {
      await client.query('DELETE FROM patient WHERE phone = $1', [validPhone]);
    }
  });

  it('adds the owner requirement NOT VALID so a restored legacy NULL survives re-apply', async () => {
    const legacyPhone = nextSeedPhone();
    await client.query(
      'ALTER TABLE patient DROP CONSTRAINT IF EXISTS patient_owner_clinician_sub_not_null',
    );
    await client.query(`INSERT INTO patient (phone, medication_name) VALUES ($1, 'metformin')`, [
      legacyPhone,
    ]);

    try {
      await expect(applySchema(client)).resolves.not.toThrow();
      const { rows: constraints } = await client.query<{ convalidated: boolean }>(
        `SELECT convalidated
           FROM pg_constraint
          WHERE conname = 'patient_owner_clinician_sub_not_null'`,
      );
      expect(constraints).toEqual([{ convalidated: false }]);
      const { rows: legacyRows } = await client.query<{ owner_clinician_sub: string | null }>(
        `SELECT owner_clinician_sub FROM patient WHERE phone = $1`,
        [legacyPhone],
      );
      expect(legacyRows).toEqual([{ owner_clinician_sub: null }]);
    } finally {
      await client.query('DELETE FROM patient WHERE phone = $1', [legacyPhone]);
      await applySchema(client);
    }
  });
});

describe('schema.sql — same-patient denormalized relationship constraints', () => {
  it('installs all six composite foreign keys as guarded NOT VALID constraints', async () => {
    const expectedNames = [
      'adherence_record_patient_dose_fkey',
      'adherence_record_patient_inbound_fkey',
      'inbound_reply_patient_dose_fkey',
      'label_match_patient_inbound_fkey',
      'outbound_message_patient_dose_fkey',
      'safety_events_patient_inbound_fkey',
    ];
    const { rows } = await client.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated
         FROM pg_constraint
        WHERE conname = ANY($1::text[])
        ORDER BY conname`,
      [expectedNames],
    );
    expect(rows).toEqual(expectedNames.map((conname) => ({ conname, convalidated: false })));
  });

  it("rejects outbound_message linked to another patient's dose", async () => {
    await expectConstraintRejection(async () => {
      const patientId = await seedPatient();
      const { doseId } = await seedDose();
      return client.query(
        `INSERT INTO outbound_message (patient_id, dose_id, status)
         VALUES ($1, $2, 'queued')`,
        [patientId, doseId],
      );
    }, 'outbound_message.patient_id must own dose_id');
  });

  it("rejects inbound_reply linked to another patient's dose", async () => {
    await expectConstraintRejection(async () => {
      const patientId = await seedPatient();
      const { doseId } = await seedDose();
      return client.query(
        `INSERT INTO inbound_reply (patient_id, dose_id, raw_body)
         VALUES ($1, $2, 'taken')`,
        [patientId, doseId],
      );
    }, 'inbound_reply.patient_id must own dose_id');
  });

  it("rejects adherence_record linked to another patient's dose", async () => {
    await expectConstraintRejection(async () => {
      const patientId = await seedPatient();
      const { doseId } = await seedDose();
      return client.query(
        `INSERT INTO adherence_record
           (patient_id, dose_id, adherence_state, reason_code, safety_flag, decided_by, status)
         VALUES ($1, $2, 'taken', 'none', 'none', 'classifier', 'recorded')`,
        [patientId, doseId],
      );
    }, 'adherence_record.patient_id must own dose_id');
  });

  it("rejects adherence_record linked to another patient's inbound reply", async () => {
    await expectConstraintRejection(async () => {
      const { patientId, doseId } = await seedDose();
      const { inboundId } = await seedInboundReply();
      return client.query(
        `INSERT INTO adherence_record
           (patient_id, dose_id, inbound_message_id, adherence_state, reason_code, safety_flag, decided_by, status)
         VALUES ($1, $2, $3, 'taken', 'none', 'none', 'classifier', 'recorded')`,
        [patientId, doseId, inboundId],
      );
    }, 'adherence_record.patient_id must own inbound_message_id');
  });

  it("rejects safety_events linked to another patient's inbound reply", async () => {
    await expectConstraintRejection(async () => {
      const patientId = await seedPatient();
      const { inboundId } = await seedInboundReply();
      return client.query(
        `INSERT INTO safety_events (patient_id, inbound_message_id, flag_category)
         VALUES ($1, $2, 'crisis')`,
        [patientId, inboundId],
      );
    }, 'safety_events.patient_id must own inbound_message_id');
  });

  it("rejects label_match linked to another patient's inbound reply", async () => {
    await expectConstraintRejection(async () => {
      const patientId = await seedPatient();
      const { inboundId } = await seedInboundReply();
      return client.query(
        `INSERT INTO label_match
           (patient_id, inbound_message_id, matched_phrase, meddra_pt, hint_level)
         VALUES ($1, $2, 'rash', 'Rash', 'info')`,
        [patientId, inboundId],
      );
    }, 'label_match.patient_id must own inbound_message_id');
  });
});

describe('schema.sql — Phase-8 append-only clinical foundation', () => {
  const newTables = [
    'source_release',
    'source_release_file',
    'evidence_record',
    'medication_identity_bridge',
    'patient_medication',
    'patient_medication_ingredient',
    'ingredient_ddinter_map',
    'ddinter_drug',
    'medication_interaction',
    'clinical_fact',
    'turn_job',
    'agent_turn',
    'clinical_event',
    'clinical_event_source',
    'clinical_event_evidence',
    'information_need',
    'information_need_scope',
    'information_need_event_candidate',
    'information_need_transition',
    'clinical_review_item',
    'clinical_review_item_transition',
    'daily_summary',
    'clinician_review_draft',
    'clinician_review_action',
    'usage_bucket',
    'provider_circuit',
  ] as const;

  it('creates exactly the approved new table set and required existing-table columns', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [[...newTables]],
    );
    expect(rows.map((row) => row.table_name)).toEqual([...newTables].sort());
    expect(await columnExists('patient', 'next_inbound_sequence')).toBe(true);
    expect(await columnExists('patient', 'preferred_language')).toBe(true);
    expect(await columnExists('patient', 'reminder_limit')).toBe(true);
    expect(await columnExists('patient', 'agent_enabled')).toBe(true);
    expect(await columnExists('patient', 'provider_opted_in')).toBe(true);
    expect(await columnExists('patient', 'messaging_state_version')).toBe(true);
    expect(await columnExists('patient', 'clinical_memory_version')).toBe(true);
    expect(await columnExists('patient', 'routine_clarifications_paused')).toBe(true);
    expect(await columnExists('inbound_reply', 'enqueued_at')).toBe(true);
    expect(await columnExists('inbound_reply', 'inbound_sequence')).toBe(true);
    expect(await columnExists('inbound_reply', 'original_control')).toBe(true);
    expect(await columnExists('inbound_reply', 'control_messaging_state_version')).toBe(true);
    expect(await columnExists('dose_schedule', 'patient_medication_id')).toBe(true);
    expect(await columnExists('outbound_message', 'body')).toBe(true);
    expect(await columnExists('outbound_message', 'message_kind')).toBe(true);
    expect(await columnExists('outbound_message', 'in_reply_to_inbound_id')).toBe(true);
    expect(await columnExists('outbound_message', 'agent_turn_id')).toBe(true);
    expect(await columnExists('outbound_message', 'language')).toBe(true);
    expect(await columnExists('outbound_message', 'reminder_attempt')).toBe(true);
    expect(await columnExists('outbound_message', 'clarification_topic')).toBe(true);
    expect(await columnExists('outbound_message', 'temporal_candidates')).toBe(true);
    expect(await columnExists('outbound_message', 'asked_information_need_id')).toBe(true);
    expect(await columnExists('outbound_message', 'messaging_consent_epoch')).toBe(true);
    expect(await columnExists('clinical_event', 'normalized_value')).toBe(true);
    expect(await columnExists('clinical_event', 'patient_medication_id')).toBe(true);
    expect(await columnExists('clinical_event', 'dose_id')).toBe(true);
    expect(await columnExists('clinical_event', 'local_time')).toBe(true);
    expect(await columnExists('clinical_event', 'patient_timezone')).toBe(true);
    expect(await columnExists('clinical_event', 'semantic_event_id')).toBe(true);
    expect(await columnExists('clinical_event', 'semantic_event_version')).toBe(true);
    expect(await columnExists('clinical_event', 'authored_by')).toBe(true);
    expect(await columnExists('clinical_event', 'review_state')).toBe(true);
    expect(await columnExists('clinical_event', 'clinical_operation')).toBe(true);
    expect(await columnExists('clinical_event', 'is_current_clinical_leaf')).toBe(false);
    expect(await columnExists('clinical_event', 'is_canonical_patient_report')).toBe(true);
    expect(await columnExists('clinical_event', 'recurrence_of_event_id')).toBe(true);
    expect(await columnExists('clinical_event', 'contradiction_of_event_id')).toBe(true);
    expect(await columnExists('clinical_event', 'source_spans')).toBe(true);
    expect(await columnExists('clinical_event', 'clinical_values')).toBe(true);
    expect(await columnExists('agent_turn', 'prepared_command_batch')).toBe(true);
    expect(await columnExists('agent_turn', 'prepared_command_hash')).toBe(true);
    expect(await columnExists('agent_turn', 'prepared_batch_hash')).toBe(true);
    expect(await columnExists('agent_turn', 'prepared_command_count')).toBe(true);
    expect(await columnExists('agent_turn', 'prepared_response_plan')).toBe(true);
    expect(await columnExists('agent_turn', 'prepared_result_receipt')).toBe(true);
    expect(await columnExists('agent_turn', 'base_clinical_memory_version')).toBe(true);
    expect(await columnExists('agent_turn', 'result_clinical_memory_version')).toBe(true);
    expect(await columnExists('agent_turn', 'clinical_context_hash')).toBe(true);
    expect(await columnExists('agent_turn', 'extractor_version')).toBe(true);
    expect(await columnExists('agent_turn', 'resolver_version')).toBe(true);
    expect(await columnExists('agent_turn', 'reducer_version')).toBe(true);
    expect(await columnExists('agent_turn', 'renderer_version')).toBe(true);
    expect(await columnExists('turn_job', 'messaging_state_version')).toBe(true);
    expect(await columnExists('turn_job', 'interpretation_result')).toBe(true);
    expect(await columnExists('turn_job', 'writer_result')).toBe(true);
    expect(await columnExists('provider_circuit', 'last_failure_kind')).toBe(true);
  });

  it('keeps the intake consent epoch durable without rebasing legacy turn jobs', async () => {
    const version = await column('turn_job', 'messaging_state_version');
    expect(version).toMatchObject({
      data_type: 'integer',
      is_nullable: 'YES',
      column_default: null,
    });

    const turn = await seedTurnJob();
    const stored = await client.query<{ messaging_state_version: number | null }>(
      `SELECT messaging_state_version FROM turn_job WHERE id = $1`,
      [turn.turnJobId],
    );
    expect(stored.rows).toEqual([{ messaging_state_version: null }]);
    await client.query('DELETE FROM patient WHERE id = $1', [turn.patientId]);

    await expectConstraintRejection(async () => {
      const invalid = await seedTurnJob();
      return client.query(`UPDATE turn_job SET messaging_state_version = 0 WHERE id = $1`, [
        invalid.turnJobId,
      ]);
    }, 'captured messaging state versions must be positive');
  });

  it('keeps legacy inbound control metadata unknown and constrains new control epochs', async () => {
    expect(await column('inbound_reply', 'original_control')).toMatchObject({
      data_type: 'character varying',
      is_nullable: 'YES',
      column_default: null,
    });
    expect(await column('inbound_reply', 'control_messaging_state_version')).toMatchObject({
      data_type: 'integer',
      is_nullable: 'YES',
      column_default: null,
    });

    const legacy = await seedInboundReply();
    try {
      const stored = await client.query<{
        original_control: string | null;
        control_messaging_state_version: number | null;
      }>(
        `SELECT original_control, control_messaging_state_version
           FROM inbound_reply
          WHERE id = $1`,
        [legacy.inboundId],
      );
      expect(stored.rows).toEqual([
        { original_control: null, control_messaging_state_version: null },
      ]);

      await expectConstraintRejection(
        () =>
          client.query(
            `UPDATE inbound_reply
                SET original_control = 'stop', control_messaging_state_version = NULL
              WHERE id = $1`,
            [legacy.inboundId],
          ),
        'a consent control must carry its positive post-transition epoch',
      );
      await expectConstraintRejection(
        () =>
          client.query(
            `UPDATE inbound_reply
                SET original_control = 'other', control_messaging_state_version = NULL
              WHERE id = $1`,
            [legacy.inboundId],
          ),
        'stored control metadata must use a known normalized control',
      );
    } finally {
      await client.query('DELETE FROM patient WHERE id = $1', [legacy.patientId]);
    }
  });

  it('stores separate provider consent, application enablement, language, and reminder state', async () => {
    const phone = `+1555${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const row = await client.query<{
      id: string;
      preferred_language: string;
      reminder_limit: number;
      agent_enabled: boolean;
      provider_opted_in: boolean;
      messaging_state_version: number;
    }>(
      `INSERT INTO patient (phone, medication_name, owner_clinician_sub)
       VALUES ($1, 'Medication', $2)
       RETURNING id::text, preferred_language, reminder_limit, agent_enabled,
                 provider_opted_in, messaging_state_version`,
      [phone, TEST_OWNER_SUB],
    );
    expect(row.rows[0]).toMatchObject({
      preferred_language: 'en',
      reminder_limit: 2,
      agent_enabled: true,
      provider_opted_in: true,
      messaging_state_version: 1,
    });
    await client.query('DELETE FROM patient WHERE id = $1', [row.rows[0]!.id]);

    await expectConstraintRejection(
      () =>
        client.query(
          `INSERT INTO patient
             (phone, medication_name, owner_clinician_sub, preferred_language)
           VALUES ('+15550000001', 'Medication', $1, 'not a language')`,
          [TEST_OWNER_SUB],
        ),
      'preferred language must be a bounded language tag',
    );
    for (const reminderLimit of [-1, 6]) {
      await expectConstraintRejection(
        () =>
          client.query(
            `INSERT INTO patient
               (phone, medication_name, owner_clinician_sub, reminder_limit)
             VALUES ($1, 'Medication', $2, $3)`,
            [
              `+1555${randomUUID().replaceAll('-', '').slice(0, 10)}`,
              TEST_OWNER_SUB,
              reminderLimit,
            ],
          ),
        'reminder limit stays within the configured safety bound',
      );
    }
  });

  it('bounds pending clarification metadata and reminder attempt semantics', async () => {
    const turn = await seedAgentTurn();
    const dose = await client.query<{ id: string }>(
      `INSERT INTO dose_schedule
         (patient_id, scheduled_at, local_dose_time, dose_date, schedule_timezone)
       VALUES ($1, now(), '08:00', CURRENT_DATE, 'America/Toronto')
       RETURNING id::text`,
      [turn.patientId],
    );
    try {
      await expect(
        client.query(
          `INSERT INTO outbound_message
             (patient_id, status, body, message_kind, in_reply_to_inbound_id,
              agent_turn_id, language, clarification_topic, temporal_candidates)
           VALUES ($1, 'prepared', 'Was that 8 AM or PM?', 'clarification', $2, $3, 'en',
                   'dose_meridiem', $4::jsonb)`,
          [
            turn.patientId,
            turn.inboundId,
            turn.agentTurnId,
            JSON.stringify([{ candidateId: randomUUID() }]),
          ],
        ),
      ).resolves.toBeDefined();
      await expect(
        client.query(
          `INSERT INTO outbound_message
             (patient_id, dose_id, status, message_kind, reminder_attempt)
           VALUES ($1, $2, 'queued', 'check_in', 1)`,
          [turn.patientId, dose.rows[0]!.id],
        ),
      ).rejects.toThrow();
      await expect(
        client.query(
          `INSERT INTO outbound_message
             (patient_id, status, message_kind, clarification_topic, temporal_candidates)
           VALUES ($1, 'queued', 'clarification', NULL, '[]'::jsonb)`,
          [turn.patientId],
        ),
      ).rejects.toThrow();
      await expect(
        client.query(
          `INSERT INTO outbound_message
             (patient_id, status, message_kind, clarification_topic, temporal_candidates)
           VALUES ($1, 'queued', 'clarification', 'dose_meridiem', $2::jsonb)`,
          [turn.patientId, JSON.stringify({ invalid: true })],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('DELETE FROM patient WHERE id = ANY($1::uuid[])', [[turn.patientId]]);
    }
  });

  it('binds resolved clinical events to same-patient dose and medication revisions', async () => {
    const patientId = await seedPatient();
    const otherPatientId = await seedPatient();
    try {
      const medication = await client.query<{ id: string }>(
        `INSERT INTO patient_medication
           (patient_id, entered_name, status, confirmed_by_clinician_sub, confirmed_at)
         VALUES ($1, 'Medication', 'active', $2, now()) RETURNING id::text`,
        [patientId, TEST_OWNER_SUB],
      );
      const otherDose = await client.query<{ id: string }>(
        `INSERT INTO dose_schedule
           (patient_id, scheduled_at, local_dose_time, dose_date, schedule_timezone)
         VALUES ($1, now(), '20:00', CURRENT_DATE, 'America/Toronto') RETURNING id::text`,
        [otherPatientId],
      );
      await expect(
        client.query(
          `INSERT INTO clinical_event
             (patient_id, event_type, event_code, statement_text, normalized_value,
              occurred_at, local_date, local_time, patient_timezone,
              patient_medication_id, dose_id)
           VALUES ($1, 'observation', 'symptom', 'Headache', 'headache', now(),
                   CURRENT_DATE, '20:00', 'America/Toronto', $2, $3)`,
          [patientId, medication.rows[0]!.id, otherDose.rows[0]!.id],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('DELETE FROM patient WHERE id = ANY($1::uuid[])', [
        [patientId, otherPatientId],
      ]);
    }
  });

  it('allows only one append-only correction per prior clinical event', async () => {
    const patientId = await seedPatient();
    try {
      const original = await client.query<{ id: string }>(
        `INSERT INTO clinical_event
           (patient_id, event_type, event_code, statement_text, occurred_at, local_date,
            local_time, patient_timezone)
         VALUES ($1, 'observation', 'symptom', 'Headache', now(), CURRENT_DATE,
                 '08:00', 'America/Toronto') RETURNING id::text`,
        [patientId],
      );
      await client.query(
        `INSERT INTO clinical_event
           (patient_id, event_type, event_code, statement_text, occurred_at, local_date,
            local_time, patient_timezone, supersedes_id)
         VALUES ($1, 'observation', 'correction', 'No headache', now(), CURRENT_DATE,
                 '08:00', 'America/Toronto', $2)`,
        [patientId, original.rows[0]!.id],
      );
      await expect(
        client.query(
          `INSERT INTO clinical_event
             (patient_id, event_type, event_code, statement_text, occurred_at, local_date,
              local_time, patient_timezone, supersedes_id)
           VALUES ($1, 'observation', 'correction', 'Still no headache', now(), CURRENT_DATE,
                   '08:00', 'America/Toronto', $2)`,
          [patientId, original.rows[0]!.id],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
    }
  });

  it('bounds stored turn-stage results and requires their ordered attempt markers', async () => {
    const turn = await seedTurnJob();
    try {
      await expect(
        client.query(`UPDATE turn_job SET interpretation_result = '{}'::jsonb WHERE id = $1`, [
          turn.turnJobId,
        ]),
      ).rejects.toThrow();
      // Wave 1b widening: a writer (composer) result on a turn that never ATTEMPTED
      // interpretation is allowed — bare yes/no turns skip the extraction stage entirely.
      await client.query(
        `UPDATE turn_job
            SET writer_attempted_at = now(), writer_result = '{}'::jsonb
          WHERE id = $1`,
        [turn.turnJobId],
      );
      await client.query(
        `UPDATE turn_job SET writer_attempted_at = NULL, writer_result = NULL WHERE id = $1`,
        [turn.turnJobId],
      );
      // An attempted-but-FAILED interpretation is a runtime-failure turn: it joins the
      // never-composed set, so the widened CHECK still rejects a writer result there.
      await client.query(`UPDATE turn_job SET interpretation_attempted_at = now() WHERE id = $1`, [
        turn.turnJobId,
      ]);
      await expect(
        client.query(
          `UPDATE turn_job
              SET writer_attempted_at = now(), writer_result = '{}'::jsonb
            WHERE id = $1`,
          [turn.turnJobId],
        ),
      ).rejects.toThrow();
      await client.query(
        `UPDATE turn_job
            SET interpretation_attempted_at = now(), interpretation_result = '{"ok":true}'::jsonb,
                writer_attempted_at = now(), writer_result = '{"ok":true}'::jsonb
          WHERE id = $1`,
        [turn.turnJobId],
      );
      await expect(
        client.query(`UPDATE turn_job SET interpretation_result = '[]'::jsonb WHERE id = $1`, [
          turn.turnJobId,
        ]),
      ).rejects.toThrow();
      await expect(
        client.query(`UPDATE turn_job SET writer_result = '"scalar"'::jsonb WHERE id = $1`, [
          turn.turnJobId,
        ]),
      ).rejects.toThrow();
      await expect(
        client.query(`UPDATE turn_job SET interpretation_result = $2::jsonb WHERE id = $1`, [
          turn.turnJobId,
          JSON.stringify({ text: 'x'.repeat(100_001) }),
        ]),
      ).rejects.toThrow();
      await expect(
        client.query(`UPDATE turn_job SET writer_result = $2::jsonb WHERE id = $1`, [
          turn.turnJobId,
          JSON.stringify({ text: 'x'.repeat(100_001) }),
        ]),
      ).rejects.toThrow();
    } finally {
      await client.query('DELETE FROM patient WHERE id = $1', [turn.patientId]);
    }
  });

  it('creates the widened turn_job_writer_result_dependency_check directly on a fresh install — no create-then-drop (the a654d9a lesson)', () => {
    // The ORIGINAL fresh-install ADD block no longer defines the narrow predicate: if this
    // regressed, the file would once again create-then-drop within one apply, exactly the
    // pattern schema.sql's Wave 1b header explicitly bans.
    expect(SCHEMA_SQL).not.toMatch(
      /ADD CONSTRAINT turn_job_writer_result_dependency_check\s+CHECK \(writer_result IS NULL OR interpretation_result IS NOT NULL\)\s+NOT VALID;/,
    );
    // The later guarded DROP+ADD block must still exist as the live-DB migration path for
    // databases created before this widening.
    expect(SCHEMA_SQL).toContain(
      "pg_get_constraintdef(oid) NOT ILIKE '%interpretation_attempted_at%'",
    );
  });

  it('turn_job_writer_result_dependency_check: single widened definition on a fresh install, idempotent re-run, and the guarded block still repairs a pre-widened live database', async () => {
    // Fresh install (this suite's beforeAll already applied schema.sql twice): exactly one
    // constraint, already widened — proves the original block creates it directly rather than
    // via the later create-then-drop migration path.
    const fresh = await client.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conname = 'turn_job_writer_result_dependency_check'
          AND conrelid = 'turn_job'::regclass`,
    );
    expect(fresh.rows).toHaveLength(1);
    expect(fresh.rows[0]?.definition).toContain('interpretation_attempted_at');

    // Simulate a live database that predates the widening: swap in the historical narrow
    // definition, then re-apply schema.sql — the guarded DROP+ADD block must repair it.
    await client.query(
      'ALTER TABLE turn_job DROP CONSTRAINT turn_job_writer_result_dependency_check',
    );
    await client.query(
      `ALTER TABLE turn_job ADD CONSTRAINT turn_job_writer_result_dependency_check
         CHECK (writer_result IS NULL OR interpretation_result IS NOT NULL) NOT VALID`,
    );

    await expect(applySchema(client)).resolves.not.toThrow();
    await expect(applySchema(client)).resolves.not.toThrow(); // idempotent re-run

    const repaired = await client.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conname = 'turn_job_writer_result_dependency_check'
          AND conrelid = 'turn_job'::regclass`,
    );
    expect(repaired.rows).toHaveLength(1);
    expect(repaired.rows[0]?.definition).toContain('interpretation_attempted_at');
  });

  it('enforces patient-scoped agent outbound links and one send row per agent turn', async () => {
    const turn = await seedAgentTurn();
    const foreign = await seedAgentTurn();
    try {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO outbound_message
           (patient_id, status, body, message_kind, in_reply_to_inbound_id, agent_turn_id, language)
         VALUES ($1, 'prepared', 'Thanks for the update.', 'acknowledgement', $2, $3, 'en')
         RETURNING id`,
        [turn.patientId, turn.inboundId, turn.agentTurnId],
      );
      await expect(
        client.query(
          `INSERT INTO outbound_message
             (patient_id, status, body, message_kind, in_reply_to_inbound_id, agent_turn_id, language)
           VALUES ($1, 'prepared', 'Duplicate', 'acknowledgement', $2, $3, 'en')`,
          [turn.patientId, turn.inboundId, turn.agentTurnId],
        ),
      ).rejects.toThrow();
      await expect(
        client.query(
          `INSERT INTO outbound_message
             (patient_id, status, body, message_kind, in_reply_to_inbound_id, agent_turn_id, language)
           VALUES ($1, 'prepared', 'Cross patient', 'acknowledgement', $2, $3, 'en')`,
          [turn.patientId, foreign.inboundId, turn.agentTurnId],
        ),
      ).rejects.toThrow();
      await expect(
        client.query(
          `INSERT INTO outbound_message
             (patient_id, status, body, message_kind, in_reply_to_inbound_id, agent_turn_id, language)
           VALUES ($1, 'prepared', 'Cross patient', 'acknowledgement', $2, $3, 'en')`,
          [turn.patientId, turn.inboundId, foreign.agentTurnId],
        ),
      ).rejects.toThrow();
      await expect(
        client.query(
          `INSERT INTO outbound_message (patient_id, status, message_kind)
           VALUES ($1, 'queued', 'not_a_kind')`,
          [turn.patientId],
        ),
      ).rejects.toThrow();
      await expect(
        client.query(`UPDATE outbound_message SET status = 'sending_unknown' WHERE id = $1`, [
          inserted.rows[0]!.id,
        ]),
      ).resolves.toMatchObject({ rowCount: 1 });

      const index = await indexFlags('uq_outbound_message_agent_turn_id');
      expect(index).toEqual({ isUnique: true, isPartial: true });
    } finally {
      await client.query('DELETE FROM patient WHERE id = ANY($1::uuid[])', [
        [turn.patientId, foreign.patientId],
      ]);
    }
  });

  it('allows exactly one concurrent prepared-to-sending claimant for an agent turn', async () => {
    const turn = await seedAgentTurn();
    const database = new Pool({ connectionString: databaseUrl, max: 8 });
    try {
      await client.query(
        `INSERT INTO outbound_message
           (patient_id, status, body, message_kind, in_reply_to_inbound_id, agent_turn_id, language)
         VALUES ($1, 'prepared', 'Stored reply', 'acknowledgement', $2, $3, 'en')`,
        [turn.patientId, turn.inboundId, turn.agentTurnId],
      );
      const claims = await Promise.all(
        Array.from({ length: 8 }, () =>
          database.query(
            `UPDATE outbound_message
                SET status = 'sending', status_updated_at = now()
              WHERE patient_id = $1 AND agent_turn_id = $2 AND status = 'prepared'
              RETURNING id`,
            [turn.patientId, turn.agentTurnId],
          ),
        ),
      );
      expect(claims.filter((claim) => claim.rowCount === 1)).toHaveLength(1);
    } finally {
      await database.end();
      await client.query('DELETE FROM patient WHERE id = $1', [turn.patientId]);
    }
  });

  it('rejects empty or whitespace-only bodies on agent outbound rows', async () => {
    const empty = await seedAgentTurn();
    const whitespace = await seedAgentTurn();
    try {
      await expect(
        client.query(
          `INSERT INTO outbound_message
             (patient_id, status, body, message_kind, in_reply_to_inbound_id, agent_turn_id, language)
           VALUES ($1, 'prepared', '', 'acknowledgement', $2, $3, 'en')`,
          [empty.patientId, empty.inboundId, empty.agentTurnId],
        ),
      ).rejects.toThrow();
      await expect(
        client.query(
          `INSERT INTO outbound_message
             (patient_id, status, body, message_kind, in_reply_to_inbound_id, agent_turn_id, language)
           VALUES ($1, 'prepared', '   ', 'acknowledgement', $2, $3, 'en')`,
          [whitespace.patientId, whitespace.inboundId, whitespace.agentTurnId],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('DELETE FROM patient WHERE id = ANY($1::uuid[])', [
        [empty.patientId, whitespace.patientId],
      ]);
    }
  });

  it('stores only bounded new outbound bodies while preserving nullable legacy rows', async () => {
    const patientId = await seedPatient();
    try {
      await expect(
        client.query(
          `INSERT INTO outbound_message (patient_id, status, body)
           VALUES ($1, 'queued', $2)`,
          [patientId, 'x'.repeat(321)],
        ),
      ).rejects.toThrow();
      await expect(
        client.query(
          `INSERT INTO outbound_message (patient_id, status, body)
           VALUES ($1, 'queued', NULL)`,
          [patientId],
        ),
      ).resolves.toBeDefined();
    } finally {
      await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
    }
  });

  it('stores immutable release-scoped medication identity bridges', async () => {
    expect(await columnExists('medication_identity_bridge', 'rxcui')).toBe(true);
    await expectConstraintRejection(
      async () =>
        client.query(
          `INSERT INTO medication_identity_bridge
             (source_release_id, din, ccdd_product_code, ingredient_order,
              ingredient_name, ccdd_ingredient_code, rxcui, reviewed_by, reviewed_at)
           VALUES (gen_random_uuid(), 'not-a-din', 'bad', 1, 'bad', 'bad', 'bad', 'reviewer', now())`,
        ),
      'reviewed identity rows require a DIN-shaped product identity',
    );
  });

  it('pins same-patient revision and schedule-to-medication composite foreign keys', async () => {
    const names = [
      'clinical_event_patient_supersedes_fkey',
      'clinical_fact_patient_supersedes_fkey',
      'clinician_review_draft_patient_supersedes_fkey',
      'daily_summary_patient_supersedes_fkey',
      'dose_schedule_patient_medication_fkey',
      'patient_medication_patient_supersedes_fkey',
    ];
    const { rows } = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[]) ORDER BY conname`,
      [names],
    );
    expect(rows.map((row) => row.conname)).toEqual(names);

    await expectConstraintRejection(async () => {
      const patientId = await seedPatient();
      const otherPatientId = await seedPatient();
      const medication = await client.query<{ id: string }>(
        `INSERT INTO patient_medication
           (patient_id, entered_name, status, confirmed_by_clinician_sub, confirmed_at)
         VALUES ($1, 'metformin', 'active', $2, now()) RETURNING id`,
        [otherPatientId, TEST_OWNER_SUB],
      );
      return client.query(
        `INSERT INTO dose_schedule
           (patient_id, patient_medication_id, scheduled_at, local_dose_time)
         VALUES ($1, $2, now(), '09:00')`,
        [patientId, medication.rows[0]!.id],
      );
    }, 'a dose schedule cannot reference another patient medication');
  });

  it('repairs the legacy medication CASCADE action and preserves medication-bound dose audit history on delete', async () => {
    await client.query(
      'ALTER TABLE dose_schedule DROP CONSTRAINT dose_schedule_patient_medication_fkey',
    );
    await client.query(
      `ALTER TABLE dose_schedule ADD CONSTRAINT dose_schedule_patient_medication_fkey
         FOREIGN KEY (patient_id, patient_medication_id)
         REFERENCES patient_medication (patient_id, id) ON DELETE CASCADE NOT VALID`,
    );

    await expect(applySchema(client)).resolves.not.toThrow();
    await expect(applySchema(client)).resolves.not.toThrow();

    const { rows: constraints } = await client.query<{
      confdeltype: string;
      definition: string;
    }>(
      `SELECT confdeltype, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'dose_schedule'::regclass
          AND conname = 'dose_schedule_patient_medication_fkey'`,
    );
    expect(constraints).toHaveLength(1);
    expect(constraints[0]?.confdeltype).toBe('n');
    expect(constraints[0]?.definition).toMatch(/ON DELETE SET NULL \(patient_medication_id\)/);

    const patientId = await seedPatient();
    try {
      const medication = await client.query<{ id: string }>(
        `INSERT INTO patient_medication
           (patient_id, entered_name, status, confirmed_by_clinician_sub, confirmed_at)
         VALUES ($1, 'metformin', 'active', $2, now()) RETURNING id`,
        [patientId, TEST_OWNER_SUB],
      );
      const dose = await client.query<{ id: string }>(
        `INSERT INTO dose_schedule
           (patient_id, patient_medication_id, scheduled_at, local_dose_time)
         VALUES ($1, $2, now(), '09:00') RETURNING id`,
        [patientId, medication.rows[0]!.id],
      );
      const inbound = await client.query<{ id: string }>(
        `INSERT INTO inbound_reply (patient_id, dose_id, raw_body)
         VALUES ($1, $2, 'taken') RETURNING id`,
        [patientId, dose.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO adherence_record
           (patient_id, dose_id, inbound_message_id, adherence_state, reason_code,
            safety_flag, decided_by, status)
         VALUES ($1, $2, $3, 'taken', 'none', 'none', 'classifier', 'recorded')`,
        [patientId, dose.rows[0]!.id, inbound.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO safety_events (patient_id, inbound_message_id, flag_category)
         VALUES ($1, $2, 'crisis')`,
        [patientId, inbound.rows[0]!.id],
      );

      await client.query('DELETE FROM patient_medication WHERE id = $1', [medication.rows[0]!.id]);

      const { rows } = await client.query<{
        patient_medication_id: string | null;
        inbound_count: string;
        adherence_count: string;
        safety_count: string;
      }>(
        `SELECT ds.patient_medication_id,
                (SELECT count(*)::text FROM inbound_reply ir WHERE ir.dose_id = ds.id) AS inbound_count,
                (SELECT count(*)::text FROM adherence_record ar WHERE ar.dose_id = ds.id) AS adherence_count,
                (SELECT count(*)::text
                   FROM safety_events se
                   JOIN inbound_reply ir ON ir.id = se.inbound_message_id
                  WHERE ir.dose_id = ds.id) AS safety_count
           FROM dose_schedule ds
          WHERE ds.id = $1`,
        [dose.rows[0]!.id],
      );
      expect(rows).toEqual([
        {
          patient_medication_id: null,
          inbound_count: '1',
          adherence_count: '1',
          safety_count: '1',
        },
      ]);
    } finally {
      await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
    }
  });

  it('enforces canonical release-scoped DDI pairs and bounded evidence text', async () => {
    await client.query('BEGIN');
    try {
      const release = await client.query<{ id: string }>(
        `INSERT INTO source_release
           (source_name, release_version, checksum_sha256, source_url, licence_id, state, is_complete)
         VALUES ('ddinter', '2026-01', $1, 'https://example.invalid/ddinter', 'CC-BY-NC-SA-4.0', 'active', true)
         RETURNING id`,
        ['a'.repeat(64)],
      );
      const releaseId = release.rows[0]!.id;
      await client.query(
        `INSERT INTO ddinter_drug (source_release_id, ddinter_drug_id, display_name)
         VALUES ($1, 'DDI001', 'Drug A'), ($1, 'DDI002', 'Drug B')`,
        [releaseId],
      );
      await expect(
        client.query(
          `INSERT INTO medication_interaction
             (source_release_id, low_ddinter_drug_id, high_ddinter_drug_id, interaction_level)
           VALUES ($1, 'DDI002', 'DDI001', 'major')`,
          [releaseId],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
    }

    await expectConstraintRejection(async () => {
      const release = await client.query<{ id: string }>(
        `INSERT INTO source_release
           (source_name, release_version, checksum_sha256, source_url, licence_id, state, is_complete)
         VALUES ('medlineplus', '2026-01', $1, 'https://example.invalid/mlp', 'public-domain', 'active', true)
         RETURNING id`,
        ['b'.repeat(64)],
      );
      return client.query(
        `INSERT INTO evidence_record
           (source_release_id, evidence_code, evidence_kind, language, passage, source_url, coverage_state)
         VALUES ($1, 'too-long', 'medlineplus', 'en', $2, 'https://example.invalid/e', 'direct_evidence')`,
        [release.rows[0]!.id, 'x'.repeat(4001)],
      );
    }, 'evidence passages are bounded to 4000 characters');

    const { rows: mapConstraints } = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conname = 'ingredient_ddinter_map_release_drug_fkey'`,
    );
    expect(mapConstraints).toEqual([{ conname: 'ingredient_ddinter_map_release_drug_fkey' }]);

    await expectConstraintRejection(async () => {
      const release = await client.query<{ id: string }>(
        `INSERT INTO source_release
           (source_name, release_version, checksum_sha256, source_url, licence_id, state, is_complete)
         VALUES ('ddinter', '2026-02', $1, 'https://example.invalid/ddinter-2', 'CC-BY-NC-SA-4.0', 'active', true)
         RETURNING id`,
        ['c'.repeat(64)],
      );
      return client.query(
        `INSERT INTO ingredient_ddinter_map
           (source_release_id, identity_system, identity_code, ddinter_drug_id,
            mapping_status, reviewed_by, reviewed_at)
         VALUES ($1, 'rxnorm', '123', 'missing-ddinter-id', 'mapped', 'reviewer', now())`,
        [release.rows[0]!.id],
      );
    }, 'mapped ingredient IDs must exist in the same complete release membership');
  });

  it('uses one immutable-update trigger across append-only tables while patient cascade DELETE remains allowed', async () => {
    const immutableTables = [
      'source_release_file',
      'evidence_record',
      'medication_identity_bridge',
      'patient_medication',
      'patient_medication_ingredient',
      'ingredient_ddinter_map',
      'ddinter_drug',
      'medication_interaction',
      'clinical_fact',
      'agent_turn',
      'clinical_event',
      'clinical_event_source',
      'clinical_event_evidence',
      'information_need',
      'information_need_scope',
      'information_need_event_candidate',
      'information_need_transition',
      'clinical_review_item',
      'clinical_review_item_transition',
      'daily_summary',
      'clinician_review_draft',
      'clinician_review_action',
    ];
    const { rows: triggers } = await client.query<{ table_name: string }>(
      `SELECT c.relname AS table_name
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE t.tgname = 'reject_immutable_update'
          AND NOT t.tgisinternal
        ORDER BY c.relname`,
    );
    expect(triggers.map((row) => row.table_name)).toEqual(immutableTables.sort());

    const patientId = await seedPatient();
    const fact = await client.query<{ id: string }>(
      `INSERT INTO clinical_fact
         (patient_id, fact_type, statement_text, status, authored_by_clinician_sub)
       VALUES ($1, 'condition', 'Hypertension', 'current', $2) RETURNING id`,
      [patientId, TEST_OWNER_SUB],
    );
    await expect(
      client.query(`UPDATE clinical_fact SET statement_text = 'Changed' WHERE id = $1`, [
        fact.rows[0]!.id,
      ]),
    ).rejects.toThrow(/immutable/);
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
    expect(
      (await client.query(`SELECT 1 FROM clinical_fact WHERE id = $1`, [fact.rows[0]!.id])).rows,
    ).toHaveLength(0);
  });

  it('rejects summary and draft JSON payloads above the declared 100000-byte ceiling', async () => {
    const patientId = await seedPatient();
    try {
      await expect(
        client.query(
          `INSERT INTO daily_summary
             (patient_id, local_date, version, window_start, window_end, input_hash,
              event_count, highest_tier, structured_payload, summary_text)
           VALUES ($1, CURRENT_DATE, 1, now() - interval '1 day', now(), $2,
                   0, 'none', $3::jsonb, 'summary')`,
          [patientId, 'd'.repeat(64), JSON.stringify({ text: 'x'.repeat(100_001) })],
        ),
      ).rejects.toThrow();

      await expect(
        client.query(
          `INSERT INTO clinician_review_draft
             (patient_id, local_date, version, input_hash, patient_statements, draft_text)
           VALUES ($1, CURRENT_DATE, 1, $2, $3::jsonb, 'draft')`,
          [patientId, 'e'.repeat(64), JSON.stringify(['x'.repeat(100_001)])],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
    }
  });

  it('allocates unique gap-free inbound_sequence values under concurrent inserts', async () => {
    const patientId = await seedPatient();
    const pool = new Pool({ connectionString: databaseUrl, max: 12 });
    try {
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          pool.query<{ inbound_sequence: string }>(
            `WITH allocated AS (
               UPDATE patient
                  SET next_inbound_sequence = next_inbound_sequence + 1
                WHERE id = $1
                RETURNING next_inbound_sequence - 1 AS inbound_sequence
             )
             INSERT INTO inbound_reply
               (patient_id, raw_body, twilio_message_sid, inbound_sequence)
             SELECT $1, 'taken', $2, inbound_sequence FROM allocated
             RETURNING inbound_sequence::text`,
            [patientId, `SM-sequence-${patientId}-${index}`],
          ),
        ),
      );
      expect(
        results.map((result) => Number(result.rows[0]!.inbound_sequence)).sort((a, b) => a - b),
      ).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
      await expect(
        client.query(
          `UPDATE inbound_reply
              SET inbound_sequence = inbound_sequence + 100
            WHERE patient_id = $1`,
          [patientId],
        ),
      ).rejects.toThrow(/inbound_sequence.*immutable/);
      await expect(
        client.query(`UPDATE inbound_reply SET enqueued_at = now() WHERE patient_id = $1`, [
          patientId,
        ]),
      ).resolves.toMatchObject({ rowCount: 12 });
    } finally {
      await pool.end();
      await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
    }
  });

  it('atomically reserves usage without overspending a fixed bucket', async () => {
    const patientId = await seedPatient();
    const pool = new Pool({ connectionString: databaseUrl, max: 12 });
    const windowStart = new Date('2026-08-11T00:00:00.000Z');
    try {
      const attempts = await Promise.all(
        Array.from({ length: 12 }, () =>
          pool.query(
            `INSERT INTO usage_bucket
               (bucket_scope, subject_key, patient_id, window_start, window_end,
                limit_units, reserved_units)
             VALUES ('patient_tokens', $1::text, $1::uuid, $2, $2::timestamptz + interval '1 day', 5, 1)
             ON CONFLICT (bucket_scope, subject_key, window_start) DO UPDATE
               SET reserved_units = usage_bucket.reserved_units + EXCLUDED.reserved_units,
                   updated_at = now()
             WHERE usage_bucket.reserved_units + usage_bucket.consumed_units
                   + EXCLUDED.reserved_units <= usage_bucket.limit_units
             RETURNING reserved_units`,
            [patientId, windowStart],
          ),
        ),
      );
      expect(attempts.filter((attempt) => attempt.rowCount === 1)).toHaveLength(5);
      const { rows } = await client.query<{ reserved_units: number }>(
        `SELECT reserved_units FROM usage_bucket
          WHERE bucket_scope = 'patient_tokens' AND subject_key = $1::text AND window_start = $2`,
        [patientId, windowStart],
      );
      expect(rows[0]?.reserved_units).toBe(5);
    } finally {
      await pool.end();
      await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
    }
  });

  it('allows exactly one concurrent provider-circuit half-open lease', async () => {
    const providerKey = `anthropic-${Date.now()}`;
    await client.query(
      `INSERT INTO provider_circuit
         (provider_key, state, consecutive_failures, cooldown_until)
       VALUES ($1, 'open', 5, now() - interval '1 second')`,
      [providerKey],
    );
    const pool = new Pool({ connectionString: databaseUrl, max: 12 });
    try {
      const attempts = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          pool.query(
            `UPDATE provider_circuit
                SET state = 'half_open',
                    half_open_lease_id = $2,
                    half_open_lease_expires_at = now() + interval '1 minute',
                    updated_at = now()
              WHERE provider_key = $1
                AND state = 'open'
                AND cooldown_until <= now()
              RETURNING half_open_lease_id`,
            [providerKey, `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`],
          ),
        ),
      );
      expect(attempts.filter((attempt) => attempt.rowCount === 1)).toHaveLength(1);
    } finally {
      await pool.end();
      await client.query('DELETE FROM provider_circuit WHERE provider_key = $1', [providerKey]);
    }
  });
});

// ---- seed helpers ----------------------------------------------------------------------

// Unique phone per seeded patient: uq_patient_active_phone (Phase-4, REV-H4) allows only ONE
// active row per phone, so the old fixed '+15005550006' would collide whenever a test seeds two
// patients inside one transaction.
let seededPhoneCounter = 0;
function nextSeedPhone(): string {
  seededPhoneCounter += 1;
  return `+1500555${String(seededPhoneCounter).padStart(4, '0')}`;
}

async function seedPatient(isTest = false): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO patient (phone, medication_name, is_test, owner_clinician_sub)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [nextSeedPhone(), 'metformin', isTest, TEST_OWNER_SUB],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('patient insert returned no id');
  return id;
}

async function seedDose(isTest = false): Promise<{ patientId: string; doseId: string }> {
  const patientId = await seedPatient(isTest);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO dose_schedule (patient_id, scheduled_at, local_dose_time)
     VALUES ($1, now(), '09:00') RETURNING id`,
    [patientId],
  );
  const doseId = rows[0]?.id;
  if (doseId === undefined) throw new Error('dose_schedule insert returned no id');
  return { patientId, doseId };
}

async function seedInboundReply(): Promise<{ patientId: string; inboundId: string }> {
  const patientId = await seedPatient();
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO inbound_reply (patient_id, raw_body) VALUES ($1, 'hello') RETURNING id`,
    [patientId],
  );
  const inboundId = rows[0]?.id;
  if (inboundId === undefined) throw new Error('inbound_reply insert returned no id');
  return { patientId, inboundId };
}

async function seedTurnJob(): Promise<{
  patientId: string;
  inboundId: string;
  turnJobId: string;
}> {
  const patientId = await seedPatient();
  const inbound = await client.query<{ id: string }>(
    `INSERT INTO inbound_reply (patient_id, raw_body, inbound_sequence)
     VALUES ($1, 'hello', 1) RETURNING id`,
    [patientId],
  );
  const inboundId = inbound.rows[0]?.id;
  if (inboundId === undefined) throw new Error('inbound_reply insert returned no id');
  const turnJob = await client.query<{ id: string }>(
    `INSERT INTO turn_job (patient_id, inbound_message_id, inbound_sequence)
     VALUES ($1, $2, 1) RETURNING id`,
    [patientId, inboundId],
  );
  const turnJobId = turnJob.rows[0]?.id;
  if (turnJobId === undefined) throw new Error('turn_job insert returned no id');
  return { patientId, inboundId, turnJobId };
}

async function seedAgentTurn(): Promise<{
  patientId: string;
  inboundId: string;
  turnJobId: string;
  agentTurnId: string;
}> {
  const turn = await seedTurnJob();
  const agentTurn = await client.query<{ id: string }>(
    `INSERT INTO agent_turn
       (patient_id, inbound_message_id, turn_job_id, model_id, prompt_version, schema_version,
        context_hash, input_tokens, output_tokens, latency_ms, final_policy_tier)
     VALUES ($1, $2, $3, 'model-test', 'prompt-test', 'schema-test', $4, 1, 1, 1, 'routine')
     RETURNING id`,
    [turn.patientId, turn.inboundId, turn.turnJobId, 'a'.repeat(64)],
  );
  const agentTurnId = agentTurn.rows[0]?.id;
  if (agentTurnId === undefined) throw new Error('agent_turn insert returned no id');
  return { ...turn, agentTurnId };
}
