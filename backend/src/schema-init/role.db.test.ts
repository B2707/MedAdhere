/**
 * Real PostgreSQL 16 proof for the four database roles managed by schema-init.
 * No AWS services or credentials are involved.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool, type PoolClient } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  appendClinicalFactRevision,
  appendMedicationRevision,
} from '../clinical-knowledge/repository.js';
import { patientClinicalMemorySchema } from '../conversation/clinical-memory/index.js';
import { persistCanonicalProjections } from '../conversation/clinical-memory/canonical-projections.js';
import { applyReviewDecision } from '../review-decision/handler.js';
import { databaseRolesSql, DATABASE_ROLE_USERNAMES } from './handler';

const SCHEMA_SQL = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
const CONTAINER_TIMEOUT_MS = 180_000;

const FIRST_PASSWORDS = {
  application: 'first-app-password',
  inbound: 'first-inbound-password',
  statusCallback: 'first-status-password',
  sourceImport: 'first-source-password',
} as const;

const SECOND_PASSWORDS = {
  application: 'second-app-password',
  inbound: 'second-inbound-password',
  statusCallback: 'second-status-password',
  sourceImport: 'second-source-password',
} as const;

const EXPECTED_GRANTS = {
  medadhere_app: {
    SELECT: [
      'patient',
      'dose_schedule',
      'outbound_message',
      'inbound_reply',
      'adherence_record',
      'safety_events',
      'label_match',
      'source_release',
      'medication_identity_bridge',
      'evidence_record',
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
      'composer_control',
    ],
    INSERT: [
      'patient',
      'dose_schedule',
      'outbound_message',
      'adherence_record',
      'safety_events',
      'label_match',
      'patient_medication',
      'patient_medication_ingredient',
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
      'usage_bucket',
      'provider_circuit',
      'composer_control',
    ],
    UPDATE: [
      'patient',
      'dose_schedule',
      'outbound_message',
      'inbound_reply',
      'adherence_record',
      'safety_events',
      'turn_job',
      'usage_bucket',
      'provider_circuit',
      'composer_control',
    ],
  },
  medadhere_inbound: {
    SELECT: ['patient', 'inbound_reply', 'turn_job', 'agent_turn', 'safety_events', 'usage_bucket'],
    INSERT: ['inbound_reply', 'turn_job', 'safety_events', 'usage_bucket'],
    UPDATE: ['inbound_reply', 'usage_bucket'],
  },
  medadhere_status_callback: {
    SELECT: ['outbound_message'],
    UPDATE: ['outbound_message'],
  },
  medadhere_source_import: {
    SELECT: ['source_release'],
    INSERT: [
      'source_release',
      'source_release_file',
      'evidence_record',
      'medication_identity_bridge',
      'ddinter_drug',
      'ingredient_ddinter_map',
      'medication_interaction',
    ],
    UPDATE: ['source_release'],
  },
} as const;

const GRANTED_TABLES = [
  ...new Set(
    Object.values(EXPECTED_GRANTS).flatMap((privileges) =>
      Object.values(privileges).flatMap((tables) => tables),
    ),
  ),
].sort();

type RoleName = keyof typeof EXPECTED_GRANTS;

let container: StartedPostgreSqlContainer;
let adminClient: Client;
let roleClients: Record<RoleName, Client>;
let appRuntimePool: Pool;
let appRuntimeClient: PoolClient;
let firstPasswordHashes: Record<RoleName, string>;
let secondPasswordHashes: Record<RoleName, string>;

function passwordForRole(
  role: RoleName,
  passwords: typeof FIRST_PASSWORDS | typeof SECOND_PASSWORDS,
): string {
  if (role === DATABASE_ROLE_USERNAMES.application) return passwords.application;
  if (role === DATABASE_ROLE_USERNAMES.inbound) return passwords.inbound;
  if (role === DATABASE_ROLE_USERNAMES.statusCallback) return passwords.statusCallback;
  return passwords.sourceImport;
}

async function rolePasswordHashes(): Promise<Record<RoleName, string>> {
  const { rows } = await adminClient.query<{ rolname: RoleName; rolpassword: string }>(
    `SELECT rolname, rolpassword
       FROM pg_authid
      WHERE rolname = ANY($1::text[])
      ORDER BY rolname`,
    [Object.values(DATABASE_ROLE_USERNAMES)],
  );
  return Object.fromEntries(rows.map((row) => [row.rolname, row.rolpassword])) as Record<
    RoleName,
    string
  >;
}

async function applyRoles(
  passwords: typeof FIRST_PASSWORDS | typeof SECOND_PASSWORDS,
): Promise<void> {
  await adminClient.query('BEGIN');
  try {
    await adminClient.query(databaseRolesSql(container.getDatabase(), passwords));
    await adminClient.query('COMMIT');
  } catch (error) {
    await adminClient.query('ROLLBACK');
    throw error;
  }
}

async function connectAs(role: RoleName, password: string): Promise<Client> {
  const client = new Client({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user: role,
    password,
  });
  await client.connect();
  return client;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  adminClient = new Client({ connectionString: container.getConnectionUri() });
  await adminClient.connect();
  await adminClient.query(SCHEMA_SQL);
  await adminClient.query(`
    CREATE TABLE role_privilege_probe (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  await applyRoles(FIRST_PASSWORDS);
  firstPasswordHashes = await rolePasswordHashes();

  // Model drift from a prior broad-grant implementation. Re-applying schema-init must remove all of
  // it, including the old default privileges that would otherwise leak access to future tables.
  for (const role of Object.values(DATABASE_ROLE_USERNAMES)) {
    await adminClient.query(`GRANT ALL ON TABLE role_privilege_probe TO ${role}`);
    await adminClient.query(`GRANT ALL ON SEQUENCE role_privilege_probe_id_seq TO ${role}`);
    await adminClient.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${role}`,
    );
    await adminClient.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${role}`,
    );
  }
  await adminClient.query(
    `GRANT ALL PRIVILEGES ON DATABASE "${container.getDatabase().replaceAll('"', '""')}" TO PUBLIC`,
  );
  await adminClient.query('GRANT ALL ON SCHEMA public TO PUBLIC');
  await adminClient.query('GRANT ALL ON TABLE role_privilege_probe TO PUBLIC');
  await adminClient.query('GRANT ALL ON SEQUENCE role_privilege_probe_id_seq TO PUBLIC');
  await adminClient.query(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC',
  );
  await adminClient.query(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO PUBLIC',
  );
  await adminClient.query('CREATE ROLE medadhere_stale_access_group NOLOGIN');
  await adminClient.query('GRANT SELECT ON TABLE patient TO medadhere_stale_access_group');
  await adminClient.query('GRANT medadhere_stale_access_group TO medadhere_status_callback');

  await applyRoles(SECOND_PASSWORDS);
  secondPasswordHashes = await rolePasswordHashes();

  roleClients = {} as Record<RoleName, Client>;
  for (const role of Object.values(DATABASE_ROLE_USERNAMES) as RoleName[]) {
    roleClients[role] = await connectAs(role, passwordForRole(role, SECOND_PASSWORDS));
  }
  appRuntimePool = new Pool({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user: DATABASE_ROLE_USERNAMES.application,
    password: SECOND_PASSWORDS.application,
  });
  appRuntimeClient = await appRuntimePool.connect();
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  appRuntimeClient?.release();
  await appRuntimePool?.end();
  await Promise.all(Object.values(roleClients ?? {}).map((client) => client.end()));
  await adminClient?.end();
  await container?.stop();
});

async function inAppTransaction<T>(operation: () => Promise<T>): Promise<T> {
  await appRuntimeClient.query('BEGIN');
  try {
    const result = await operation();
    await appRuntimeClient.query('COMMIT');
    return result;
  } catch (error) {
    await appRuntimeClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

describe('schema-init database roles — real PostgreSQL 16', () => {
  it('runs through an RDS-shaped non-superuser deploy admin with CREATEROLE', async () => {
    const deployAdmin = 'medadhere_deploy_admin_probe';
    const deployPassword = 'deploy-admin-password';
    const databaseName = 'medadhere_role_deploy_probe';
    await adminClient.query(
      `CREATE ROLE ${deployAdmin}
       WITH LOGIN NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS
       PASSWORD '${deployPassword}'`,
    );
    // PostgreSQL 16 grants a CREATEROLE creator ADMIN OPTION on roles it creates. These target roles
    // already exist from the suite setup, so mirror that production relationship explicitly.
    await adminClient.query(
      `GRANT ${Object.values(DATABASE_ROLE_USERNAMES).join(', ')} TO ${deployAdmin} WITH ADMIN OPTION`,
    );
    await adminClient.query(`CREATE DATABASE ${databaseName} OWNER ${deployAdmin}`);
    const deployClient = new Client({
      host: container.getHost(),
      port: container.getPort(),
      database: databaseName,
      user: deployAdmin,
      password: deployPassword,
    });
    await deployClient.connect();
    try {
      for (const table of GRANTED_TABLES) {
        if (table === 'patient') {
          await deployClient.query(
            `CREATE TABLE patient (
                 id uuid,
                 provider_opted_in boolean,
                 agent_enabled boolean,
                 messaging_state_version integer,
                 opted_out_at timestamptz,
                 next_inbound_sequence bigint
               )`,
          );
          continue;
        }
        await deployClient.query(`CREATE TABLE ${table} (id uuid)`);
      }
      await deployClient.query('CREATE ROLE medadhere_deploy_stale_group NOLOGIN');
      await deployClient.query('GRANT SELECT ON patient TO medadhere_deploy_stale_group');
      await deployClient.query('GRANT medadhere_deploy_stale_group TO medadhere_status_callback');
      await deployClient.query('CREATE ROLE medadhere_deploy_stale_consumer NOLOGIN');
      await deployClient.query('GRANT medadhere_app TO medadhere_deploy_stale_consumer');
      await expect(
        deployClient.query(databaseRolesSql(databaseName, SECOND_PASSWORDS)),
      ).resolves.toBeDefined();
      await expect(
        deployClient.query(
          `SELECT pg_has_role(
             'medadhere_status_callback', 'medadhere_deploy_stale_group', 'MEMBER'
           ) AS member`,
        ),
      ).resolves.toMatchObject({ rows: [{ member: false }] });
      await expect(
        deployClient.query(
          `SELECT pg_has_role(
             'medadhere_deploy_stale_consumer', 'medadhere_app', 'MEMBER'
           ) AS member`,
        ),
      ).resolves.toMatchObject({ rows: [{ member: false }] });
    } finally {
      await deployClient.end();
    }
  });

  it('creates and rotates four restricted LOGIN roles repeat-safely', async () => {
    const { rows } = await adminClient.query<{
      rolname: RoleName;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
              rolreplication, rolbypassrls
         FROM pg_roles
        WHERE rolname = ANY($1::text[])
        ORDER BY rolname`,
      [Object.values(DATABASE_ROLE_USERNAMES)],
    );

    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row).toMatchObject({
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
      });
      expect(secondPasswordHashes[row.rolname]).not.toBe(firstPasswordHashes[row.rolname]);
      const oldPasswordClient = new Client({
        host: container.getHost(),
        port: container.getPort(),
        database: container.getDatabase(),
        user: row.rolname,
        password: passwordForRole(row.rolname, FIRST_PASSWORDS),
      });
      await expect(oldPasswordClient.connect()).rejects.toMatchObject({ code: '28P01' });
      await oldPasswordClient.end().catch(() => undefined);
    }
  });

  it('removes inherited role memberships that could bypass the exact table grants', async () => {
    const memberships = await adminClient.query<{ inherited_role: string; member_role: string }>(
      `SELECT inherited.rolname AS inherited_role, member.rolname AS member_role
         FROM pg_auth_members membership
         JOIN pg_roles inherited ON inherited.oid = membership.roleid
         JOIN pg_roles member ON member.oid = membership.member
        WHERE member.rolname = ANY($1::text[])`,
      [Object.values(DATABASE_ROLE_USERNAMES)],
    );
    expect(memberships.rows).toEqual([]);
    const effective = await adminClient.query<{ allowed: boolean }>(
      `SELECT has_table_privilege('medadhere_status_callback', 'patient', 'SELECT') AS allowed`,
    );
    expect(effective.rows[0]!.allowed).toBe(false);
  });

  it('removes managed-role grants to other principals that could export application access', async () => {
    await adminClient.query('CREATE ROLE medadhere_stale_consumer NOLOGIN');
    await adminClient.query('GRANT medadhere_app TO medadhere_stale_consumer');
    try {
      await applyRoles(SECOND_PASSWORDS);
      const { rows } = await adminClient.query<{ member: boolean }>(
        `SELECT pg_has_role(
           'medadhere_stale_consumer', 'medadhere_app', 'MEMBER'
         ) AS member`,
      );
      expect(rows).toEqual([{ member: false }]);
    } finally {
      await adminClient.query('REVOKE medadhere_app FROM medadhere_stale_consumer');
      await applyRoles(SECOND_PASSWORDS);
    }
  });

  it('fails closed when a different grantor leaves an effective table privilege behind', async () => {
    await adminClient.query('CREATE ROLE medadhere_alternate_grantor NOLOGIN');
    await adminClient.query('GRANT USAGE ON SCHEMA public TO medadhere_alternate_grantor');
    await adminClient.query(
      'GRANT SELECT ON TABLE patient TO medadhere_alternate_grantor WITH GRANT OPTION',
    );
    try {
      await adminClient.query('SET ROLE medadhere_alternate_grantor');
      await adminClient.query('GRANT SELECT ON TABLE public.patient TO medadhere_status_callback');
    } finally {
      await adminClient.query('RESET ROLE');
    }

    let detectedError: unknown;
    try {
      await applyRoles(SECOND_PASSWORDS);
    } catch (error) {
      detectedError = error;
    } finally {
      try {
        await adminClient.query('SET ROLE medadhere_alternate_grantor');
        await adminClient.query(
          'REVOKE SELECT ON TABLE public.patient FROM medadhere_status_callback',
        );
      } finally {
        await adminClient.query('RESET ROLE');
      }
      await adminClient.query('REVOKE SELECT ON TABLE patient FROM medadhere_alternate_grantor');
      await adminClient.query('REVOKE USAGE ON SCHEMA public FROM medadhere_alternate_grantor');
      await applyRoles(SECOND_PASSWORDS);
    }

    expect(detectedError).toMatchObject({ code: '42501' });
  });

  it('fails closed when a different grantor leaves a column-only privilege behind', async () => {
    await adminClient.query('CREATE ROLE medadhere_column_grantor NOLOGIN');
    await adminClient.query('GRANT USAGE ON SCHEMA public TO medadhere_column_grantor');
    await adminClient.query(
      'GRANT SELECT(phone) ON TABLE patient TO medadhere_column_grantor WITH GRANT OPTION',
    );
    try {
      await adminClient.query('SET ROLE medadhere_column_grantor');
      await adminClient.query(
        'GRANT SELECT(phone) ON TABLE public.patient TO medadhere_status_callback',
      );
    } finally {
      await adminClient.query('RESET ROLE');
    }

    let detectedError: unknown;
    try {
      await applyRoles(SECOND_PASSWORDS);
    } catch (error) {
      detectedError = error;
    } finally {
      try {
        await adminClient.query('SET ROLE medadhere_column_grantor');
        await adminClient.query(
          'REVOKE SELECT(phone) ON TABLE public.patient FROM medadhere_status_callback',
        );
      } finally {
        await adminClient.query('RESET ROLE');
      }
      await adminClient.query(
        'REVOKE SELECT(phone) ON TABLE patient FROM medadhere_column_grantor',
      );
      await adminClient.query('REVOKE USAGE ON SCHEMA public FROM medadhere_column_grantor');
      await applyRoles(SECOND_PASSWORDS);
    }

    expect(detectedError).toMatchObject({ code: '42501' });
  });

  it('matches the exact table-level privilege matrix with no DELETE or broad leftovers', async () => {
    const { rows } = await adminClient.query<{
      grantee: RoleName;
      table_name: string;
      privilege_type: string;
    }>(
      `SELECT grantee, table_name, privilege_type
         FROM information_schema.table_privileges
        WHERE table_schema = 'public'
          AND grantee = ANY($1::text[])
        ORDER BY grantee, privilege_type, table_name`,
      [Object.values(DATABASE_ROLE_USERNAMES)],
    );
    const actual = rows
      .map((row) => `${row.grantee}:${row.privilege_type}:${row.table_name}`)
      .sort();
    const expected = Object.entries(EXPECTED_GRANTS)
      .flatMap(([role, grants]) =>
        Object.entries(grants).flatMap(([privilege, tables]) =>
          (tables as readonly string[]).map((table) => `${role}:${privilege}:${table}`),
        ),
      )
      .sort();
    expect(actual).toEqual(expected);
  });

  it('allows only CONNECT plus public-schema USAGE and denies persistent or temporary DDL', async () => {
    for (const role of Object.values(DATABASE_ROLE_USERNAMES) as RoleName[]) {
      const databasePrivileges = await adminClient.query<{ connect: boolean; temporary: boolean }>(
        `SELECT has_database_privilege($1, current_database(), 'CONNECT') AS connect,
                has_database_privilege($1, current_database(), 'TEMPORARY') AS temporary`,
        [role],
      );
      expect(databasePrivileges.rows[0]).toEqual({ connect: true, temporary: false });

      const schemaPrivileges = await adminClient.query<{ usage: boolean; create: boolean }>(
        `SELECT has_schema_privilege($1, 'public', 'USAGE') AS usage,
                has_schema_privilege($1, 'public', 'CREATE') AS create`,
        [role],
      );
      expect(schemaPrivileges.rows[0]).toEqual({ usage: true, create: false });
      await expect(
        roleClients[role].query(`CREATE TABLE forbidden_${role} (id integer)`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        roleClients[role].query(`CREATE TEMP TABLE forbidden_temp_${role} (id integer)`),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('revokes all current and future sequence access and all future-table defaults', async () => {
    await adminClient.query('CREATE TABLE future_role_probe (id integer)');
    await adminClient.query('CREATE SEQUENCE future_role_probe_sequence');

    for (const role of Object.values(DATABASE_ROLE_USERNAMES) as RoleName[]) {
      for (const sequence of ['role_privilege_probe_id_seq', 'future_role_probe_sequence']) {
        const { rows } = await adminClient.query<{ allowed: boolean }>(
          `SELECT has_sequence_privilege($1, $2, 'USAGE')
               OR has_sequence_privilege($1, $2, 'SELECT')
               OR has_sequence_privilege($1, $2, 'UPDATE') AS allowed`,
          [role, sequence],
        );
        expect(rows[0]!.allowed).toBe(false);
      }
      await expect(
        roleClients[role].query('SELECT 1 FROM future_role_probe'),
      ).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('executes a durable inbound intake path but rejects unrelated status/source reads and DELETE', async () => {
    const inbound = roleClients.medadhere_inbound;
    const patient = await adminClient.query<{ id: string }>(
      `INSERT INTO patient (phone, medication_name, owner_clinician_sub)
       VALUES ('+16135550101', 'Metformin', '11111111-1111-4111-8111-111111111111')
       RETURNING id`,
    );
    const patientId = patient.rows[0]!.id;

    await inbound.query('BEGIN');
    const sequence = await inbound.query<{ inbound_sequence: string }>(
      `UPDATE patient
          SET next_inbound_sequence = next_inbound_sequence + 1
        WHERE id = $1
        RETURNING next_inbound_sequence - 1 AS inbound_sequence`,
      [patientId],
    );
    const reply = await inbound.query<{ id: string }>(
      `INSERT INTO inbound_reply
         (patient_id, raw_body, safety_flagged, twilio_message_sid, inbound_sequence)
       VALUES ($1, 'permission probe', true, 'SM-role-inbound-probe', $2)
       RETURNING id`,
      [patientId, sequence.rows[0]!.inbound_sequence],
    );
    const inboundMessageId = reply.rows[0]!.id;
    await inbound.query(
      `INSERT INTO safety_events
         (patient_id, inbound_message_id, flag_category, trigger_source)
       VALUES ($1, $2, 'medical_question', 'prefilter')`,
      [patientId, inboundMessageId],
    );
    await inbound.query(
      `INSERT INTO turn_job (patient_id, inbound_message_id, inbound_sequence)
       VALUES ($1, $2, $3)`,
      [patientId, inboundMessageId, sequence.rows[0]!.inbound_sequence],
    );
    await inbound.query(
      `INSERT INTO usage_bucket
         (bucket_scope, subject_key, patient_id, window_start, window_end, limit_units, consumed_units)
       VALUES ('patient_burst', $1::text, $1::uuid, now(), now() + interval '10 minutes', 21, 1)`,
      [patientId],
    );
    await inbound.query('COMMIT');
    await expect(
      inbound.query(
        'UPDATE inbound_reply SET enqueued_at = COALESCE(enqueued_at, now()) WHERE id = $1',
        [inboundMessageId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      adminClient.query('SELECT 1 FROM turn_job WHERE inbound_message_id = $1', [inboundMessageId]),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(inbound.query('SELECT 1 FROM outbound_message WHERE false')).rejects.toMatchObject(
      {
        code: '42501',
      },
    );
    await expect(inbound.query('SELECT 1 FROM source_release WHERE false')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(inbound.query('DELETE FROM patient WHERE false')).rejects.toMatchObject({
      code: '42501',
    });
    await adminClient.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('executes the frozen callback read/update surface on a durable row and rejects every other table', async () => {
    const callback = roleClients.medadhere_status_callback;
    const outbound = await adminClient.query<{ id: string }>(
      `WITH patient_row AS (
         INSERT INTO patient (phone, medication_name, owner_clinician_sub)
         VALUES ('+16135550102', 'Metformin', '22222222-2222-4222-8222-222222222222')
         RETURNING id
       )
       INSERT INTO outbound_message (patient_id, status, callback_token_hash)
       SELECT id, 'sending_unknown', decode(repeat('ab', 32), 'hex') FROM patient_row
       RETURNING id`,
    );
    const outboundId = outbound.rows[0]!.id;
    await expect(
      callback.query('SELECT status FROM outbound_message WHERE id = $1 FOR UPDATE', [outboundId]),
    ).resolves.toMatchObject({ rows: [{ status: 'sending_unknown' }] });
    await expect(
      callback.query(
        `UPDATE outbound_message
            SET twilio_sid = 'SM-role-status-probe', status = 'delivered', status_updated_at = now()
          WHERE id = $1
        RETURNING status`,
        [outboundId],
      ),
    ).resolves.toMatchObject({ rows: [{ status: 'delivered' }] });
    await expect(callback.query('SELECT 1 FROM patient WHERE false')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      callback.query('INSERT INTO outbound_message DEFAULT VALUES'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(callback.query('DELETE FROM outbound_message WHERE false')).rejects.toMatchObject({
      code: '42501',
    });
    await adminClient.query('DELETE FROM patient WHERE phone = $1', ['+16135550102']);
  });

  it('executes a reviewed source activation across every loader table and rejects patient access', async () => {
    const source = roleClients.medadhere_source_import;
    const release = await source.query<{ id: string }>(
      `INSERT INTO source_release
         (source_name, release_version, checksum_sha256, source_url, licence_id, state)
       VALUES ('role-probe', '2026-08-11', repeat('a', 64), 'https://example.invalid/release',
               'probe-licence', 'active')
       RETURNING id`,
    );
    const releaseId = release.rows[0]!.id;
    await source.query(
      `INSERT INTO source_release_file
         (source_release_id, file_name, checksum_sha256, row_count, licence_boundary, import_complete)
       VALUES ($1, 'reviewed.json', repeat('b', 64), 1, 'probe-licence', true)`,
      [releaseId],
    );
    await source.query(
      `INSERT INTO evidence_record
         (source_release_id, evidence_code, evidence_kind, language, passage, source_url,
          coverage_state)
       VALUES ($1, 'probe', 'label', 'en', 'Reviewed evidence.',
               'https://example.invalid/evidence', 'direct_evidence')`,
      [releaseId],
    );
    await source.query(
      `INSERT INTO medication_identity_bridge
         (source_release_id, din, ccdd_product_code, ingredient_order, ingredient_name,
          ccdd_ingredient_code, rxcui, reviewed_by, reviewed_at)
       VALUES ($1, '12345678', 'probe-product', 1, 'Probe ingredient', 'probe-ingredient',
               '12345', 'reviewer', now())`,
      [releaseId],
    );
    await source.query(
      `INSERT INTO ddinter_drug (source_release_id, ddinter_drug_id, display_name)
       VALUES ($1, 'drug-a', 'Drug A'), ($1, 'drug-b', 'Drug B')`,
      [releaseId],
    );
    await source.query(
      `INSERT INTO ingredient_ddinter_map
         (source_release_id, identity_system, identity_code, ddinter_drug_id, mapping_status,
          reviewed_by, reviewed_at)
       VALUES ($1, 'rxnorm', '12345', 'drug-a', 'mapped', 'reviewer', now())`,
      [releaseId],
    );
    await source.query(
      `INSERT INTO medication_interaction
         (source_release_id, low_ddinter_drug_id, high_ddinter_drug_id, interaction_level)
       VALUES ($1, 'drug-a', 'drug-b', 'moderate')`,
      [releaseId],
    );
    await expect(
      source.query('UPDATE source_release SET is_complete = true WHERE id = $1', [releaseId]),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      source.query('SELECT is_complete FROM source_release WHERE id = $1', [releaseId]),
    ).resolves.toMatchObject({ rows: [{ is_complete: true }] });
    await expect(source.query('SELECT 1 FROM patient WHERE false')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(source.query('SELECT 1 FROM evidence_record WHERE false')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(source.query('DELETE FROM source_release WHERE false')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('permits only the application review-evidence read and review-action append surface', async () => {
    const app = roleClients.medadhere_app;
    await expect(
      app.query('SELECT 1 FROM clinical_event_evidence WHERE false'),
    ).resolves.toMatchObject({
      rowCount: 0,
    });
    await expect(
      app.query('SELECT 1 FROM clinician_review_action WHERE false'),
    ).resolves.toMatchObject({ rowCount: 0 });

    const patient = await adminClient.query<{ id: string }>(
      `INSERT INTO patient (phone, medication_name, owner_clinician_sub)
       VALUES ('+16135550103', 'Metformin', '33333333-3333-4333-8333-333333333333')
       RETURNING id`,
    );
    const patientId = patient.rows[0]!.id;
    const draft = await adminClient.query<{ id: string }>(
      `INSERT INTO clinician_review_draft
         (patient_id, local_date, version, input_hash, draft_text)
       VALUES ($1, CURRENT_DATE, 1, repeat('d', 64), 'Role review probe')
       RETURNING id`,
      [patientId],
    );
    const draftId = draft.rows[0]!.id;
    await expect(
      app.query(
        `INSERT INTO clinician_review_action
           (patient_id, clinician_review_draft_id, clinician_sub, decision, expected_version)
         VALUES ($1, $2, '33333333-3333-4333-8333-333333333333', 'reject', 1)
         RETURNING decision`,
        [patientId, draftId],
      ),
    ).resolves.toMatchObject({ rows: [{ decision: 'reject' }] });
    await expect(
      app.query('UPDATE clinician_review_action SET decision = decision WHERE false'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      app.query('DELETE FROM clinician_review_action WHERE false'),
    ).rejects.toMatchObject({ code: '42501' });
    await adminClient.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });
});

describe('application runtime append-only workflows', () => {
  const owner = '44444444-4444-4444-8444-444444444444';

  it('supersedes a medication as medadhere_app without UPDATE on patient_medication', async () => {
    const patient = await adminClient.query<{ id: string }>(
      `INSERT INTO patient (phone, medication_name, owner_clinician_sub)
       VALUES ('+16135550104', 'Original medication', $1)
       RETURNING id`,
      [owner],
    );
    const patientId = patient.rows[0]!.id;
    try {
      const original = await adminClient.query<{ id: string }>(
        `INSERT INTO patient_medication
           (patient_id, entered_name, status, confirmed_by_clinician_sub, confirmed_at)
         VALUES ($1, 'Original medication', 'active', $2, now())
         RETURNING id`,
        [patientId, owner],
      );
      const privilege = await adminClient.query<{ allowed: boolean }>(
        `SELECT has_table_privilege(
           'medadhere_app', 'patient_medication', 'UPDATE'
         ) AS allowed`,
      );
      expect(privilege.rows).toEqual([{ allowed: false }]);

      await expect(
        appendMedicationRevision(appRuntimeClient, {
          patientId,
          clinicianSub: owner,
          input: {
            enteredName: 'Corrected medication',
            identity: null,
            doseText: null,
            form: null,
            route: null,
            validFrom: '2026-08-12',
            validTo: null,
            status: 'corrected',
            supersedesId: original.rows[0]!.id,
            scheduleIds: [],
            ingredients: [{ name: 'ingredient', ccddIngredientCode: null, rxcui: null }],
          },
        }),
      ).resolves.toEqual(expect.any(String));
    } finally {
      await adminClient.query('DELETE FROM patient WHERE id = $1', [patientId]);
    }
  });

  it('supersedes a fact as medadhere_app without UPDATE on clinical_fact', async () => {
    const patient = await adminClient.query<{ id: string }>(
      `INSERT INTO patient (phone, medication_name, owner_clinician_sub)
       VALUES ('+16135550105', 'Metformin', $1)
       RETURNING id`,
      [owner],
    );
    const patientId = patient.rows[0]!.id;
    try {
      const original = await adminClient.query<{ id: string }>(
        `INSERT INTO clinical_fact
           (patient_id, fact_type, statement_text, status, authored_by_clinician_sub)
         VALUES ($1, 'note', 'Original fact', 'current', $2)
         RETURNING id`,
        [patientId, owner],
      );
      const privilege = await adminClient.query<{ allowed: boolean }>(
        `SELECT has_table_privilege('medadhere_app', 'clinical_fact', 'UPDATE') AS allowed`,
      );
      expect(privilege.rows).toEqual([{ allowed: false }]);

      await expect(
        appendClinicalFactRevision(appRuntimeClient, {
          patientId,
          clinicianSub: owner,
          input: {
            factType: 'note',
            factCode: null,
            statementText: 'Corrected fact',
            status: 'corrected',
            supersedesId: original.rows[0]!.id,
          },
        }),
      ).resolves.toEqual(expect.any(String));
    } finally {
      await adminClient.query('DELETE FROM patient WHERE id = $1', [patientId]);
    }
  });

  it('confirms a targeted fact correction as medadhere_app without UPDATE on clinical_fact', async () => {
    const patient = await adminClient.query<{ id: string }>(
      `INSERT INTO patient (phone, medication_name, owner_clinician_sub)
       VALUES ('+16135550106', 'Metformin', $1)
       RETURNING id`,
      [owner],
    );
    const patientId = patient.rows[0]!.id;
    try {
      const original = await adminClient.query<{ id: string }>(
        `INSERT INTO clinical_fact
           (patient_id, fact_type, fact_code, statement_text, status,
            authored_by_clinician_sub)
         VALUES ($1, 'condition', 'MIGRAINE', 'Original fact', 'current', $2)
         RETURNING id`,
        [patientId, owner],
      );
      const correctionId = '55555555-5555-4555-8555-555555555555';
      const sourceMessageId = '66666666-6666-4666-8666-666666666666';
      const draft = await adminClient.query<{ id: string }>(
        `INSERT INTO clinician_review_draft
           (patient_id, local_date, version, input_hash, draft_text, proposed_corrections)
         VALUES ($1, CURRENT_DATE, 1, repeat('e', 64), 'Runtime correction', $2::jsonb)
         RETURNING id`,
        [
          patientId,
          JSON.stringify([
            {
              correctionId,
              factId: original.rows[0]!.id,
              proposedText: 'Corrected fact',
              rationale: 'Clinician confirmed correction',
              sourceMessageIds: [sourceMessageId],
            },
          ]),
        ],
      );
      const privilege = await adminClient.query<{ allowed: boolean }>(
        `SELECT has_table_privilege('medadhere_app', 'clinical_fact', 'UPDATE') AS allowed`,
      );
      expect(privilege.rows).toEqual([{ allowed: false }]);

      await expect(
        inAppTransaction(() =>
          applyReviewDecision(appRuntimeClient, {
            patientId,
            draftId: draft.rows[0]!.id,
            clinicianSub: owner,
            input: {
              decision: 'confirm',
              expectedVersion: 1,
              selectedCorrectionIds: [correctionId],
            },
          }),
        ),
      ).resolves.toMatchObject({ applied: true, createdFactIds: [expect.any(String)] });
    } finally {
      await adminClient.query('DELETE FROM patient WHERE id = $1', [patientId]);
    }
  });

  it('moves a canonical adherence projection across doses as medadhere_app without DELETE', async () => {
    const patient = await adminClient.query<{ id: string }>(
      `INSERT INTO patient (phone, medication_name, owner_clinician_sub, timezone, is_test)
       VALUES ('+16135550107', 'Metformin', $1, 'America/Toronto', true)
       RETURNING id::text`,
      [owner],
    );
    const patientId = patient.rows[0]!.id;
    try {
      const medication = await adminClient.query<{ id: string }>(
        `INSERT INTO patient_medication
           (patient_id, entered_name, identity_system, identity_code, dose_text, valid_from,
            status, confirmed_by_clinician_sub, confirmed_at)
         VALUES ($1, 'Metformin', 'rxnorm', '6809', '500 mg', '2026-08-01',
                 'active', $2, '2026-08-01T12:00:00Z')
         RETURNING id::text`,
        [patientId, owner],
      );
      const medicationId = medication.rows[0]!.id;
      const doses = await adminClient.query<{ id: string; dose_date: string }>(
        `INSERT INTO dose_schedule
           (patient_id, patient_medication_id, scheduled_at, local_dose_time,
            dose_date, schedule_timezone)
         VALUES
           ($1, $2, '2026-08-13T13:00:00Z', '09:00', '2026-08-13', 'America/Toronto'),
           ($1, $2, '2026-08-14T13:00:00Z', '09:00', '2026-08-14', 'America/Toronto')
         RETURNING id::text, dose_date::text`,
        [patientId, medicationId],
      );
      const doseByDate = new Map(doses.rows.map(({ id, dose_date }) => [dose_date, id]));
      const doseAId = doseByDate.get('2026-08-13')!;
      const doseBId = doseByDate.get('2026-08-14')!;
      const originalBody = 'I took the August 13 dose.';
      const correctionBody = 'Correction: I took the August 14 dose.';
      const originalInbound = await adminClient.query<{ id: string }>(
        `INSERT INTO inbound_reply
           (patient_id, raw_body, received_at, inbound_sequence)
         VALUES ($1, $2, '2026-08-13T16:00:00Z', 1)
         RETURNING id::text`,
        [patientId, originalBody],
      );
      const correctionInbound = await adminClient.query<{ id: string }>(
        `INSERT INTO inbound_reply
           (patient_id, raw_body, received_at, inbound_sequence)
         VALUES ($1, $2, '2026-08-14T16:00:00Z', 2)
         RETURNING id::text`,
        [patientId, correctionBody],
      );
      const originalInboundId = originalInbound.rows[0]!.id;
      const correctionInboundId = correctionInbound.rows[0]!.id;
      const originalEventId = 'event-role-projection-original';
      const correctionEventId = 'event-role-projection-correction';
      const originalSpan = {
        messageId: originalInboundId,
        start: 0,
        end: originalBody.length - 1,
        quote: originalBody.slice(0, -1),
      };
      const correctionQuote = 'I took the August 14 dose';
      const correctionSpan = {
        messageId: correctionInboundId,
        start: correctionBody.indexOf(correctionQuote),
        end: correctionBody.indexOf(correctionQuote) + correctionQuote.length,
        quote: correctionQuote,
      };
      const originalEvent = {
        id: originalEventId,
        version: 1,
        kind: 'administration' as const,
        operation: 'create' as const,
        authoredBy: 'patient' as const,
        reviewState: 'unreviewed' as const,
        current: true,
        canonical: true,
        sourceMessageIds: [originalInboundId],
        sourceSpans: [originalSpan],
        medicationId,
        medicationVersion: 1,
        doseId: doseAId,
        doseVersion: 1,
        adherence: 'taken' as const,
        timing: 'on_time' as const,
        localDate: '2026-08-13',
        localTime: '09:00',
      };
      const correctionEvent = {
        ...originalEvent,
        id: correctionEventId,
        version: 2,
        operation: 'correct' as const,
        sourceMessageIds: [correctionInboundId],
        sourceSpans: [correctionSpan],
        doseId: doseBId,
        localDate: '2026-08-14',
        supersedesEventId: originalEventId,
      };
      const before = patientClinicalMemorySchema.parse({
        patientId,
        version: 1,
        events: [originalEvent],
        needs: [],
        unresolvedReports: [],
        reviewItems: [],
        routineClarificationsPaused: false,
        processedBatches: [],
      });
      const memory = patientClinicalMemorySchema.parse({
        ...before,
        version: 2,
        events: [{ ...originalEvent, current: false }, correctionEvent],
      });
      const originalPhysical = await adminClient.query<{ id: string }>(
        `INSERT INTO clinical_event
           (patient_id, source_inbound_id, event_type, occurred_at, local_date,
            semantic_event_id, semantic_event_version, authored_by, review_state,
            clinical_operation, is_canonical_patient_report, source_spans, clinical_values,
            patient_medication_id, dose_id, local_time, patient_timezone)
         VALUES ($1, $2, 'administration', '2026-08-13T13:00:00Z', '2026-08-13',
                 $3, 1, 'patient', 'unreviewed', 'create', true, $4::jsonb, $5::jsonb,
                 $6, $7, '09:00', 'America/Toronto')
         RETURNING id::text`,
        [
          patientId,
          originalInboundId,
          originalEventId,
          JSON.stringify([originalSpan]),
          JSON.stringify({ adherence: 'taken', timing: 'on_time' }),
          medicationId,
          doseAId,
        ],
      );
      await adminClient.query(
        `INSERT INTO clinical_event
           (patient_id, source_inbound_id, event_type, occurred_at, local_date, supersedes_id,
            semantic_event_id, semantic_event_version, authored_by, review_state,
            clinical_operation, is_canonical_patient_report, source_spans, clinical_values,
            patient_medication_id, dose_id, local_time, patient_timezone)
         VALUES ($1, $2, 'administration', '2026-08-14T13:00:00Z', '2026-08-14', $3,
                 $4, 2, 'patient', 'unreviewed', 'correct', true, $5::jsonb, $6::jsonb,
                 $7, $8, '09:00', 'America/Toronto')`,
        [
          patientId,
          correctionInboundId,
          originalPhysical.rows[0]!.id,
          correctionEventId,
          JSON.stringify([correctionSpan]),
          JSON.stringify({ adherence: 'taken', timing: 'on_time' }),
          medicationId,
          doseBId,
        ],
      );
      await adminClient.query(
        `INSERT INTO adherence_record
           (patient_id, dose_id, inbound_message_id, adherence_state,
            reason_code, safety_flag, decided_by, status)
         VALUES ($1, $2, $3, 'taken', 'none', 'none', 'classifier', 'recorded')`,
        [patientId, doseAId, originalInboundId],
      );
      const privilege = await adminClient.query<{ allowed: boolean }>(
        `SELECT has_table_privilege('medadhere_app', 'adherence_record', 'DELETE') AS allowed`,
      );
      expect(privilege.rows).toEqual([{ allowed: false }]);

      await expect(
        inAppTransaction(async () => {
          await appRuntimeClient.query('SELECT id FROM patient WHERE id = $1 FOR UPDATE', [
            patientId,
          ]);
          await persistCanonicalProjections(appRuntimeClient, { patientId, before, memory });
        }),
      ).resolves.toBeUndefined();
      const adherence = await adminClient.query<{
        dose_id: string;
        inbound_message_id: string;
        decided_by: string;
      }>(
        `SELECT dose_id::text, inbound_message_id::text, decided_by::text
           FROM adherence_record
          WHERE patient_id = $1`,
        [patientId],
      );
      expect(adherence.rows).toEqual([
        {
          dose_id: doseBId,
          inbound_message_id: correctionInboundId,
          decided_by: 'classifier',
        },
      ]);
    } finally {
      await adminClient.query('DELETE FROM patient WHERE id = $1', [patientId]);
    }
  });
});
