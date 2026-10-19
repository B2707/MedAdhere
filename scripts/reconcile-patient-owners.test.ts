// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

const { secretSend } = vi.hoisted(() => ({
  secretSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send = secretSend;
  },
  GetSecretValueCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
}));

import {
  buildPool,
  parseOwnerMappings,
  reconcilePatientOwners,
  runReconcilePatientOwnersCli,
  type ReconciliationClient,
  type ReconciliationResult,
} from './reconcile-patient-owners.js';

afterEach(() => {
  secretSend.mockReset();
  vi.unstubAllEnvs();
});

const SCHEMA_SQL = readFileSync(
  join(__dirname, '..', 'backend', 'src', 'schema-init', 'schema.sql'),
  'utf8',
);
const CONTAINER_TIMEOUT_MS = 180_000;

let container: StartedPostgreSqlContainer | undefined;
let postgres: Client;

async function applySchema(client: Client): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(SCHEMA_SQL);
    await client.query('COMMIT');
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  }
}

beforeAll(async () => {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (testDatabaseUrl) {
    postgres = new Client({ connectionString: testDatabaseUrl });
    await postgres.connect();
  } else {
    container = await new PostgreSqlContainer('postgres:16').start();
    postgres = new Client({ connectionString: container.getConnectionUri() });
    await postgres.connect();
  }
  const version = await postgres.query<{ server_version: string }>('SHOW server_version');
  expect(Number.parseInt(version.rows[0]!.server_version.split('.')[0]!, 10)).toBe(16);
  await applySchema(postgres);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await postgres?.end();
  await container?.stop();
});

const PATIENT_A = '11111111-1111-4111-8111-111111111111';
const PATIENT_B = '22222222-2222-4222-8222-222222222222';
const PATIENT_UNKNOWN = '33333333-3333-4333-8333-333333333333';
const CLINICIAN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLINICIAN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEDICATION_A = '44444444-4444-4444-8444-444444444444';
const MEDICATION_B = '55555555-5555-4555-8555-555555555555';

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeClientOptions {
  readonly nullOwnerIds?: readonly string[];
  readonly medicationNames?: Readonly<Record<string, string>>;
  readonly patientsWithMedication?: readonly string[];
  readonly updateRowCounts?: readonly number[];
  readonly insertRowCounts?: readonly number[];
  readonly insertedMedicationIds?: readonly string[];
  readonly remainingNullCount?: number;
  readonly medicationMismatchCount?: number;
  readonly scheduleMismatchCount?: number;
  readonly throwOnUpdate?: Error;
}

function makeClient(options: FakeClientOptions = {}): ReconciliationClient & {
  readonly calls: RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  const updateRowCounts = [...(options.updateRowCounts ?? [])];
  const insertRowCounts = [...(options.insertRowCounts ?? [])];
  const insertedMedicationIds = [
    ...(options.insertedMedicationIds ?? [MEDICATION_A, MEDICATION_B]),
  ];
  return {
    calls,
    async query(text: string, values: readonly unknown[] = []) {
      const normalized = text.replace(/\s+/g, ' ').trim();
      calls.push({ text: normalized, values: [...values] });
      if (normalized.startsWith('SELECT p.id::text AS id')) {
        return {
          rows: (options.nullOwnerIds ?? []).map((id) => ({
            id,
            medication_name: options.medicationNames?.[id] ?? 'Stored metformin',
            has_medication: options.patientsWithMedication?.includes(id) ?? false,
          })),
          rowCount: options.nullOwnerIds?.length ?? 0,
        };
      }
      if (normalized.startsWith('UPDATE patient')) {
        if (options.throwOnUpdate) throw options.throwOnUpdate;
        return { rows: [], rowCount: updateRowCounts.shift() ?? 1 };
      }
      if (normalized.startsWith('INSERT INTO patient_medication')) {
        const rowCount = insertRowCounts.shift() ?? 1;
        return {
          rows: rowCount === 1 ? [{ id: insertedMedicationIds.shift() }] : [],
          rowCount,
        };
      }
      if (normalized.startsWith('UPDATE dose_schedule')) {
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith('SELECT count(*)::text AS count FROM patient')) {
        return {
          rows: [{ count: String(options.remainingNullCount ?? 0) }],
          rowCount: 1,
        };
      }
      if (normalized.includes('AS medication_mismatches')) {
        return {
          rows: [{ medication_mismatches: String(options.medicationMismatchCount ?? 0) }],
          rowCount: 1,
        };
      }
      if (normalized.includes('AS schedule_mismatches')) {
        return {
          rows: [{ schedule_mismatches: String(options.scheduleMismatchCount ?? 0) }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: null };
    },
  };
}

function mappingJson(
  rows: readonly {
    legacyPatientId: string;
    clinicianSub: string;
    confirmStoredMedication?: true;
  }[] = [
    { legacyPatientId: PATIENT_A, clinicianSub: CLINICIAN_A },
    { legacyPatientId: PATIENT_B, clinicianSub: CLINICIAN_B },
  ],
): string {
  return JSON.stringify(
    rows.map((row) => ({
      ...row,
      confirmStoredMedication: row.confirmStoredMedication ?? true,
    })),
  );
}

describe('parseOwnerMappings — explicit UUID-only boundary', () => {
  it('accepts and freezes a strict legacy patient UUID to Cognito subject array', () => {
    const mappings = parseOwnerMappings(mappingJson());

    expect(mappings).toEqual([
      {
        legacyPatientId: PATIENT_A,
        clinicianSub: CLINICIAN_A,
        confirmStoredMedication: true,
      },
      {
        legacyPatientId: PATIENT_B,
        clinicianSub: CLINICIAN_B,
        confirmStoredMedication: true,
      },
    ]);
    expect(Object.isFrozen(mappings)).toBe(true);
    expect(mappings.every(Object.isFrozen)).toBe(true);
  });

  it.each([
    ['not JSON', '{'],
    ['not an array', JSON.stringify({ [PATIENT_A]: CLINICIAN_A })],
    [
      'invalid patient UUID',
      mappingJson([{ legacyPatientId: 'patient-a', clinicianSub: CLINICIAN_A }]),
    ],
    [
      'invalid clinician UUID',
      mappingJson([{ legacyPatientId: PATIENT_A, clinicianSub: 'doctor-a' }]),
    ],
    [
      'phone/name inference fields',
      JSON.stringify([
        {
          legacyPatientId: PATIENT_A,
          clinicianSub: CLINICIAN_A,
          confirmStoredMedication: true,
          phone: '+16135550100',
          displayName: 'Private Patient',
        },
      ]),
    ],
  ])('rejects %s', (_name, json) => {
    expect(() => parseOwnerMappings(json)).toThrow(/mapping file/i);
  });

  it.each([
    [
      'missing medication attestation',
      JSON.stringify([{ legacyPatientId: PATIENT_A, clinicianSub: CLINICIAN_A }]),
    ],
    [
      'false medication attestation',
      JSON.stringify([
        {
          legacyPatientId: PATIENT_A,
          clinicianSub: CLINICIAN_A,
          confirmStoredMedication: false,
        },
      ]),
    ],
  ])('rejects %s', (_name, json) => {
    expect(() => parseOwnerMappings(json)).toThrow(/confirmStoredMedication/i);
  });

  it('rejects duplicate legacy patient mappings, including UUID case variants', () => {
    expect(() =>
      parseOwnerMappings(
        mappingJson([
          { legacyPatientId: PATIENT_A, clinicianSub: CLINICIAN_A },
          { legacyPatientId: PATIENT_A.toUpperCase(), clinicianSub: CLINICIAN_B },
        ]),
      ),
    ).toThrow(/duplicate/i);
  });
});

describe('reconcilePatientOwners — exact coverage and dry-run/apply gate', () => {
  it('defaults to validation-only dry-run with no transaction or update', async () => {
    const client = makeClient({ nullOwnerIds: [PATIENT_A, PATIENT_B] });

    const result = await reconcilePatientOwners({
      client,
      mappings: parseOwnerMappings(mappingJson()),
      apply: false,
    });

    expect(result).toEqual({ mode: 'dry-run', mappedPatients: 2 });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.text).toBe(
      'SELECT p.id::text AS id, p.medication_name, EXISTS ( SELECT 1 FROM patient_medication pm WHERE pm.patient_id = p.id ) AS has_medication FROM patient p WHERE p.owner_clinician_sub IS NULL ORDER BY p.id',
    );
    expect(client.calls.every(({ text }) => !/BEGIN|UPDATE|INSERT|COMMIT/.test(text))).toBe(true);
    expect(client.calls[0]!.text).toContain('p.medication_name');
    expect(client.calls[0]!.text).not.toMatch(/phone|display_name/i);
  });

  it.each([
    {
      name: 'blank stored medication',
      options: { nullOwnerIds: [PATIENT_A], medicationNames: { [PATIENT_A]: '   ' } },
      expected: /stored medication precondition.*invalid=1.*existing=0/i,
    },
    {
      name: 'overlong stored medication',
      options: { nullOwnerIds: [PATIENT_A], medicationNames: { [PATIENT_A]: 'm'.repeat(321) } },
      expected: /stored medication precondition.*invalid=1.*existing=0/i,
    },
    {
      name: 'existing medication row',
      options: { nullOwnerIds: [PATIENT_A], patientsWithMedication: [PATIENT_A] },
      expected: /stored medication precondition.*invalid=0.*existing=1/i,
    },
  ])('fails closed on $name without writing', async ({ options, expected }) => {
    const client = makeClient(options);

    await expect(
      reconcilePatientOwners({
        client,
        mappings: parseOwnerMappings(
          mappingJson([{ legacyPatientId: PATIENT_A, clinicianSub: CLINICIAN_A }]),
        ),
        apply: false,
      }),
    ).rejects.toThrow(expected);
    expect(client.calls.some(({ text }) => /UPDATE|INSERT/.test(text))).toBe(false);
  });

  it.each([
    {
      name: 'missing mapping',
      nullOwnerIds: [PATIENT_A, PATIENT_B],
      mappings: [{ legacyPatientId: PATIENT_A, clinicianSub: CLINICIAN_A }],
      expected: /missing=1.*unknown=0/i,
    },
    {
      name: 'unknown or already-owned mapping',
      nullOwnerIds: [PATIENT_A],
      mappings: [
        { legacyPatientId: PATIENT_A, clinicianSub: CLINICIAN_A },
        { legacyPatientId: PATIENT_UNKNOWN, clinicianSub: CLINICIAN_B },
      ],
      expected: /missing=0.*unknown=1/i,
    },
  ])('fails dry-run on an exact-coverage $name', async ({ nullOwnerIds, mappings, expected }) => {
    const client = makeClient({ nullOwnerIds });

    await expect(
      reconcilePatientOwners({
        client,
        mappings: parseOwnerMappings(mappingJson(mappings)),
        apply: false,
      }),
    ).rejects.toThrow(expected);
    expect(client.calls.some(({ text }) => text.startsWith('UPDATE'))).toBe(false);
  });

  it('--apply updates each locked NULL owner with parameters, rechecks zero NULL, and commits once', async () => {
    const client = makeClient({ nullOwnerIds: [PATIENT_A, PATIENT_B] });

    const result = await reconcilePatientOwners({
      client,
      mappings: parseOwnerMappings(
        mappingJson([
          { legacyPatientId: PATIENT_B, clinicianSub: CLINICIAN_B },
          { legacyPatientId: PATIENT_A, clinicianSub: CLINICIAN_A },
        ]),
      ),
      apply: true,
    });

    expect(result).toEqual({ mode: 'applied', updatedPatients: 2 });
    expect(client.calls.map(({ text }) => text)).toEqual([
      'BEGIN',
      'LOCK TABLE patient IN SHARE ROW EXCLUSIVE MODE',
      'LOCK TABLE patient_medication IN SHARE ROW EXCLUSIVE MODE',
      'LOCK TABLE dose_schedule IN SHARE ROW EXCLUSIVE MODE',
      'SELECT p.id::text AS id, p.medication_name, EXISTS ( SELECT 1 FROM patient_medication pm WHERE pm.patient_id = p.id ) AS has_medication FROM patient p WHERE p.owner_clinician_sub IS NULL ORDER BY p.id FOR UPDATE OF p',
      'UPDATE patient SET owner_clinician_sub = $1 WHERE id = $2::uuid AND owner_clinician_sub IS NULL',
      "INSERT INTO patient_medication ( patient_id, entered_name, status, confirmed_by_clinician_sub, confirmed_at ) SELECT p.id, p.medication_name, 'active', $1::text, CURRENT_TIMESTAMP FROM patient p WHERE p.id = $2::uuid AND p.owner_clinician_sub = $1::text AND NOT EXISTS ( SELECT 1 FROM patient_medication pm WHERE pm.patient_id = p.id ) RETURNING id::text AS id",
      'UPDATE dose_schedule SET patient_medication_id = $1::uuid WHERE patient_id = $2::uuid AND patient_medication_id IS NULL',
      'UPDATE patient SET owner_clinician_sub = $1 WHERE id = $2::uuid AND owner_clinician_sub IS NULL',
      "INSERT INTO patient_medication ( patient_id, entered_name, status, confirmed_by_clinician_sub, confirmed_at ) SELECT p.id, p.medication_name, 'active', $1::text, CURRENT_TIMESTAMP FROM patient p WHERE p.id = $2::uuid AND p.owner_clinician_sub = $1::text AND NOT EXISTS ( SELECT 1 FROM patient_medication pm WHERE pm.patient_id = p.id ) RETURNING id::text AS id",
      'UPDATE dose_schedule SET patient_medication_id = $1::uuid WHERE patient_id = $2::uuid AND patient_medication_id IS NULL',
      'SELECT count(*)::text AS count FROM patient WHERE owner_clinician_sub IS NULL',
      "SELECT count(*)::text AS medication_mismatches FROM ( SELECT p.id FROM patient p LEFT JOIN patient_medication pm ON pm.patient_id = p.id WHERE p.id = ANY($1::uuid[]) GROUP BY p.id HAVING count(pm.id) <> 1 OR count(pm.id) FILTER (WHERE pm.status = 'active') <> 1 ) mismatched",
      "WITH carried AS ( SELECT * FROM unnest($1::uuid[], $2::uuid[]) AS pair(patient_id, medication_id) ) SELECT count(*)::text AS schedule_mismatches FROM dose_schedule ds JOIN carried c ON c.patient_id = ds.patient_id LEFT JOIN patient_medication pm ON pm.patient_id = ds.patient_id AND pm.id = ds.patient_medication_id WHERE ds.patient_medication_id IS DISTINCT FROM c.medication_id OR pm.id IS NULL OR pm.status IS DISTINCT FROM 'active'",
      'COMMIT',
    ]);
    expect(client.calls[5]!.values).toEqual([CLINICIAN_A, PATIENT_A]);
    expect(client.calls[6]!.values).toEqual([CLINICIAN_A, PATIENT_A]);
    expect(client.calls[7]!.values).toEqual([MEDICATION_A, PATIENT_A]);
    expect(client.calls[8]!.values).toEqual([CLINICIAN_B, PATIENT_B]);
    expect(client.calls[9]!.values).toEqual([CLINICIAN_B, PATIENT_B]);
    expect(client.calls[10]!.values).toEqual([MEDICATION_B, PATIENT_B]);
    expect(client.calls[12]!.values).toEqual([[PATIENT_A, PATIENT_B]]);
    expect(client.calls[13]!.values).toEqual([
      [PATIENT_A, PATIENT_B],
      [MEDICATION_A, MEDICATION_B],
    ]);
    expect(client.calls[5]!.text).not.toContain(CLINICIAN_A);
    expect(client.calls[5]!.text).not.toContain(PATIENT_A);
    expect(client.calls[6]!.text).not.toContain('Stored metformin');
  });

  it('validates exact mappings inside the apply transaction and rolls back before updates', async () => {
    const client = makeClient({ nullOwnerIds: [PATIENT_A, PATIENT_B] });

    await expect(
      reconcilePatientOwners({
        client,
        mappings: parseOwnerMappings(
          mappingJson([{ legacyPatientId: PATIENT_A, clinicianSub: CLINICIAN_A }]),
        ),
        apply: true,
      }),
    ).rejects.toThrow(/missing=1/i);

    expect(client.calls.map(({ text }) => text)).toEqual([
      'BEGIN',
      'LOCK TABLE patient IN SHARE ROW EXCLUSIVE MODE',
      'LOCK TABLE patient_medication IN SHARE ROW EXCLUSIVE MODE',
      'LOCK TABLE dose_schedule IN SHARE ROW EXCLUSIVE MODE',
      'SELECT p.id::text AS id, p.medication_name, EXISTS ( SELECT 1 FROM patient_medication pm WHERE pm.patient_id = p.id ) AS has_medication FROM patient p WHERE p.owner_clinician_sub IS NULL ORDER BY p.id FOR UPDATE OF p',
      'ROLLBACK',
    ]);
  });

  it.each([
    {
      name: 'a guarded update no longer matches',
      options: { nullOwnerIds: [PATIENT_A], updateRowCounts: [0] },
      expected: /concurrent owner change/i,
    },
    {
      name: 'the final NULL-owner recheck is nonzero',
      options: { nullOwnerIds: [PATIENT_A], remainingNullCount: 1 },
      expected: /null-owner recheck failed/i,
    },
    {
      name: 'the guarded medication insert no longer matches',
      options: { nullOwnerIds: [PATIENT_A], insertRowCounts: [0] },
      expected: /stored medication insert failed/i,
    },
    {
      name: 'the final medication cardinality recheck fails',
      options: { nullOwnerIds: [PATIENT_A], medicationMismatchCount: 1 },
      expected: /medication recheck failed/i,
    },
    {
      name: 'the final schedule linkage recheck fails',
      options: { nullOwnerIds: [PATIENT_A], scheduleMismatchCount: 1 },
      expected: /schedule recheck failed/i,
    },
  ])('rolls back and never commits when $name', async ({ options, expected }) => {
    const client = makeClient(options);

    await expect(
      reconcilePatientOwners({
        client,
        mappings: parseOwnerMappings(
          mappingJson([{ legacyPatientId: PATIENT_A, clinicianSub: CLINICIAN_A }]),
        ),
        apply: true,
      }),
    ).rejects.toThrow(expected);
    expect(client.calls.at(-1)!.text).toBe('ROLLBACK');
    expect(client.calls.some(({ text }) => text === 'COMMIT')).toBe(false);
  });

  it('rolls back raw database failures', async () => {
    const client = makeClient({
      nullOwnerIds: [PATIENT_A],
      throwOnUpdate: new Error('database included private patient text'),
    });

    await expect(
      reconcilePatientOwners({
        client,
        mappings: parseOwnerMappings(
          mappingJson([{ legacyPatientId: PATIENT_A, clinicianSub: CLINICIAN_A }]),
        ),
        apply: true,
      }),
    ).rejects.toThrow('database included private patient text');
    expect(client.calls.at(-1)!.text).toBe('ROLLBACK');
  });
});

describe('runReconcilePatientOwnersCli — injected file/DB/console boundary', () => {
  it('is dry-run by default and logs counts only', async () => {
    const client = makeClient({ nullOwnerIds: [PATIENT_A, PATIENT_B] });
    const logs: string[] = [];
    const errors: string[] = [];
    const withClient = vi.fn(
      async (run: (client: ReconciliationClient) => Promise<ReconciliationResult>) => run(client),
    );

    const exitCode = await runReconcilePatientOwnersCli(['--mapping', 'owners.json'], {
      readFile: vi.fn(() => mappingJson()),
      withClient,
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    });

    expect(exitCode).toBe(0);
    expect(withClient).toHaveBeenCalledOnce();
    expect(logs).toEqual([
      '[reconcile] dry-run complete — 2 owner/medication mapping(s) validated; no rows updated',
      '[reconcile] pass --apply to update NULL owners and carry stored medications in one transaction',
    ]);
    expect(errors).toEqual([]);
    expect([...logs, ...errors].join('\n')).not.toMatch(
      /11111111|22222222|aaaaaaaa|bbbbbbbb|Stored metformin|\+1613|Private Patient/i,
    );
  });

  it('requires an explicit mapping path and --apply before any update', async () => {
    const client = makeClient({ nullOwnerIds: [] });
    const readFile = vi.fn(() => '[]');
    const withClient = vi.fn(
      async (run: (client: ReconciliationClient) => Promise<ReconciliationResult>) => run(client),
    );
    const errors: string[] = [];

    const missingExit = await runReconcilePatientOwnersCli([], {
      readFile,
      withClient,
      log: vi.fn(),
      error: (line) => errors.push(line),
    });
    const applyExit = await runReconcilePatientOwnersCli(['--apply', '--mapping', 'owners.json'], {
      readFile,
      withClient,
      log: vi.fn(),
      error: (line) => errors.push(line),
    });

    expect(missingExit).toBe(1);
    expect(readFile).toHaveBeenCalledOnce();
    expect(withClient).toHaveBeenCalledOnce();
    expect(applyExit).toBe(0);
    expect(client.calls.map(({ text }) => text)).toEqual([
      'BEGIN',
      'LOCK TABLE patient IN SHARE ROW EXCLUSIVE MODE',
      'LOCK TABLE patient_medication IN SHARE ROW EXCLUSIVE MODE',
      'LOCK TABLE dose_schedule IN SHARE ROW EXCLUSIVE MODE',
      'SELECT p.id::text AS id, p.medication_name, EXISTS ( SELECT 1 FROM patient_medication pm WHERE pm.patient_id = p.id ) AS has_medication FROM patient p WHERE p.owner_clinician_sub IS NULL ORDER BY p.id FOR UPDATE OF p',
      'SELECT count(*)::text AS count FROM patient WHERE owner_clinician_sub IS NULL',
      "SELECT count(*)::text AS medication_mismatches FROM ( SELECT p.id FROM patient p LEFT JOIN patient_medication pm ON pm.patient_id = p.id WHERE p.id = ANY($1::uuid[]) GROUP BY p.id HAVING count(pm.id) <> 1 OR count(pm.id) FILTER (WHERE pm.status = 'active') <> 1 ) mismatched",
      "WITH carried AS ( SELECT * FROM unnest($1::uuid[], $2::uuid[]) AS pair(patient_id, medication_id) ) SELECT count(*)::text AS schedule_mismatches FROM dose_schedule ds JOIN carried c ON c.patient_id = ds.patient_id LEFT JOIN patient_medication pm ON pm.patient_id = ds.patient_id AND pm.id = ds.patient_medication_id WHERE ds.patient_medication_id IS DISTINCT FROM c.medication_id OR pm.id IS NULL OR pm.status IS DISTINCT FROM 'active'",
      'COMMIT',
    ]);
    expect(errors[0]).toMatch(/--mapping/i);
  });

  it('fails malformed mappings before DB reach and never logs mapping values', async () => {
    const withClient = vi.fn();
    const errors: string[] = [];
    const privateValue = '+16135550100 Private Patient';

    const exitCode = await runReconcilePatientOwnersCli(['--mapping', 'owners.json'], {
      readFile: () => `{${privateValue}`,
      withClient,
      log: vi.fn(),
      error: (line) => errors.push(line),
    });

    expect(exitCode).toBe(1);
    expect(withClient).not.toHaveBeenCalled();
    expect(errors).toEqual(['[reconcile] failed — mapping file must be valid JSON']);
    expect(errors.join('\n')).not.toContain(privateValue);
  });

  it('sanitizes unexpected database errors instead of logging PHI-bearing messages', async () => {
    const client = makeClient({
      nullOwnerIds: [PATIENT_A],
      throwOnUpdate: new Error('private phone +16135550100 and raw message'),
    });
    const errors: string[] = [];

    const exitCode = await runReconcilePatientOwnersCli(['--mapping', 'owners.json', '--apply'], {
      readFile: () => mappingJson([{ legacyPatientId: PATIENT_A, clinicianSub: CLINICIAN_A }]),
      withClient: async (run) => run(client),
      log: vi.fn(),
      error: (line) => errors.push(line),
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual(['[reconcile] failed — database reconciliation failed']);
    expect(errors.join('\n')).not.toMatch(/16135550100|raw message|11111111|aaaaaaaa/i);
  });
});

describe('buildPool — production adapter remains TLS-pinned and mockable', () => {
  it('fails before Secrets Manager or PostgreSQL when the tracked CA path is absent', async () => {
    vi.stubEnv('DB_CA_BUNDLE_PATH', '');

    await expect(buildPool()).rejects.toThrow(/DB_CA_BUNDLE_PATH/i);
    expect(secretSend).not.toHaveBeenCalled();
  });

  it('rejects an invalid port before Secrets Manager or PostgreSQL reach', async () => {
    vi.stubEnv('DB_CA_BUNDLE_PATH', 'backend/src/schema-init/rds-global-bundle.pem');
    vi.stubEnv('DB_SECRET_ARN', 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test');
    vi.stubEnv('DB_HOST', '127.0.0.1');
    vi.stubEnv('DB_TLS_SERVERNAME', 'medadhere.example.us-east-1.rds.amazonaws.com');
    vi.stubEnv('DB_PORT', 'not-a-port');
    vi.stubEnv('DB_NAME', 'medadhere');

    await expect(buildPool()).rejects.toThrow(/DB_PORT/i);
    expect(secretSend).not.toHaveBeenCalled();
  });

  it('builds one CA-verified connection using Secrets Manager credentials', async () => {
    vi.stubEnv('DB_CA_BUNDLE_PATH', 'backend/src/schema-init/rds-global-bundle.pem');
    vi.stubEnv('DB_SECRET_ARN', 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test');
    vi.stubEnv('DB_HOST', '127.0.0.1');
    vi.stubEnv('DB_TLS_SERVERNAME', 'medadhere.example.us-east-1.rds.amazonaws.com');
    vi.stubEnv('DB_PORT', '5432');
    vi.stubEnv('DB_NAME', 'medadhere');
    secretSend.mockResolvedValue({
      SecretString: JSON.stringify({ username: 'db-user', password: 'db-password' }),
    });

    const pool = await buildPool();

    expect(secretSend).toHaveBeenCalledOnce();
    expect(pool).toBeInstanceOf(Pool);
    expect(pool.options).toMatchObject({
      host: '127.0.0.1',
      port: 5432,
      database: 'medadhere',
      user: 'db-user',
      password: 'db-password',
      max: 1,
      ssl: {
        rejectUnauthorized: true,
        servername: 'medadhere.example.us-east-1.rds.amazonaws.com',
      },
    });
    await pool.end();
  });
});

let integrationPhoneCounter = 0;

async function seedLegacyPatients(medicationNames: readonly string[]): Promise<readonly string[]> {
  await postgres.query('BEGIN');
  try {
    await postgres.query(
      'ALTER TABLE patient DROP CONSTRAINT IF EXISTS patient_owner_clinician_sub_not_null',
    );
    const patientIds: string[] = [];
    for (const medicationName of medicationNames) {
      integrationPhoneCounter += 1;
      const inserted = await postgres.query<{ id: string }>(
        `INSERT INTO patient (phone, medication_name, owner_clinician_sub)
         VALUES ($1, $2, NULL)
         RETURNING id::text AS id`,
        [`+150099${String(integrationPhoneCounter).padStart(4, '0')}`, medicationName],
      );
      const patientId = inserted.rows[0]!.id;
      patientIds.push(patientId);
      await postgres.query(
        `INSERT INTO dose_schedule (patient_id, scheduled_at, local_dose_time)
         VALUES
           ($1, CURRENT_TIMESTAMP - INTERVAL '2 days', '09:00'),
           ($1, CURRENT_TIMESTAMP - INTERVAL '1 day', '21:00')`,
        [patientId],
      );
    }
    await postgres.query(
      `ALTER TABLE patient ADD CONSTRAINT patient_owner_clinician_sub_not_null
       CHECK (owner_clinician_sub IS NOT NULL) NOT VALID`,
    );
    await postgres.query('COMMIT');
    return patientIds;
  } catch (error: unknown) {
    await postgres.query('ROLLBACK');
    throw error;
  }
}

function realReconciliationClient(): ReconciliationClient {
  return {
    async query(text, values = []) {
      const result = await postgres.query(text, [...values]);
      return {
        rows: result.rows as Record<string, unknown>[],
        rowCount: result.rowCount,
      };
    },
  };
}

describe('reconcilePatientOwners — real PostgreSQL 16 restore contract', () => {
  it('proves dry-run is read-only and apply atomically writes owners plus one stored medication each', async () => {
    const medicationNames = ['  Stored metformin  ', 'Stored warfarin'] as const;
    const patientIds = await seedLegacyPatients(medicationNames);
    const mappings = parseOwnerMappings(
      mappingJson([
        { legacyPatientId: patientIds[0]!, clinicianSub: CLINICIAN_A },
        { legacyPatientId: patientIds[1]!, clinicianSub: CLINICIAN_B },
      ]),
    );
    try {
      await expect(
        reconcilePatientOwners({
          client: realReconciliationClient(),
          mappings,
          apply: false,
        }),
      ).resolves.toEqual({ mode: 'dry-run', mappedPatients: 2 });

      const afterDryRun = await postgres.query<{
        owner_clinician_sub: string | null;
        medication_count: number;
      }>(
        `SELECT p.owner_clinician_sub, count(pm.id)::int AS medication_count
           FROM patient p
           LEFT JOIN patient_medication pm ON pm.patient_id = p.id
          WHERE p.id = ANY($1::uuid[])
          GROUP BY p.id, p.owner_clinician_sub
          ORDER BY p.id`,
        [patientIds],
      );
      expect(afterDryRun.rows).toEqual([
        { owner_clinician_sub: null, medication_count: 0 },
        { owner_clinician_sub: null, medication_count: 0 },
      ]);
      const schedulesAfterDryRun = await postgres.query<{
        schedule_count: number;
        linked_count: number;
      }>(
        `SELECT count(*)::int AS schedule_count,
                count(patient_medication_id)::int AS linked_count
           FROM dose_schedule
          WHERE patient_id = ANY($1::uuid[])`,
        [patientIds],
      );
      expect(schedulesAfterDryRun.rows).toEqual([{ schedule_count: 4, linked_count: 0 }]);

      await expect(
        reconcilePatientOwners({
          client: realReconciliationClient(),
          mappings,
          apply: true,
        }),
      ).resolves.toEqual({ mode: 'applied', updatedPatients: 2 });

      const applied = await postgres.query<{
        id: string;
        owner_clinician_sub: string;
        entered_name: string;
        status: string;
        confirmed_by_clinician_sub: string;
        medication_id: string;
        medication_count: number;
        active_count: number;
        inferred_field_count: number;
      }>(
        `SELECT p.id::text AS id,
                p.owner_clinician_sub,
                min(pm.entered_name) AS entered_name,
                min(pm.status) AS status,
                min(pm.confirmed_by_clinician_sub) AS confirmed_by_clinician_sub,
                min(pm.id::text) AS medication_id,
                count(pm.id)::int AS medication_count,
                count(pm.id) FILTER (WHERE pm.status = 'active')::int AS active_count,
                count(pm.id) FILTER (
                  WHERE pm.identity_system IS NOT NULL
                     OR pm.identity_code IS NOT NULL
                     OR pm.dose_text IS NOT NULL
                     OR pm.form IS NOT NULL
                     OR pm.route IS NOT NULL
                )::int AS inferred_field_count
           FROM patient p
           JOIN patient_medication pm ON pm.patient_id = p.id
          WHERE p.id = ANY($1::uuid[])
          GROUP BY p.id, p.owner_clinician_sub
          ORDER BY p.id`,
        [patientIds],
      );
      const expectedByPatient = new Map(
        patientIds.map((id, index) => [
          id,
          {
            owner: index === 0 ? CLINICIAN_A : CLINICIAN_B,
            medicationName: medicationNames[index]!,
          },
        ]),
      );
      for (const row of applied.rows) {
        const expected = expectedByPatient.get(row.id)!;
        expect(row).toMatchObject({
          owner_clinician_sub: expected.owner,
          entered_name: expected.medicationName,
          status: 'active',
          confirmed_by_clinician_sub: expected.owner,
          medication_count: 1,
          active_count: 1,
          inferred_field_count: 0,
        });
        expect(row.medication_id).toMatch(/^[0-9a-f-]{36}$/);
      }
      expect(applied.rows).toHaveLength(2);
      const scheduleLinks = await postgres.query<{
        patient_id: string;
        medication_id: string;
        schedule_count: number;
        matching_count: number;
      }>(
        `SELECT ds.patient_id::text AS patient_id,
                min(pm.id::text) AS medication_id,
                count(ds.id)::int AS schedule_count,
                count(ds.id) FILTER (
                  WHERE ds.patient_medication_id = pm.id AND pm.status = 'active'
                )::int AS matching_count
           FROM dose_schedule ds
           JOIN patient_medication pm ON pm.patient_id = ds.patient_id
          WHERE ds.patient_id = ANY($1::uuid[])
          GROUP BY ds.patient_id
          ORDER BY ds.patient_id`,
        [patientIds],
      );
      expect(scheduleLinks.rows).toHaveLength(2);
      for (const row of scheduleLinks.rows) {
        expect(row.schedule_count).toBe(2);
        expect(row.matching_count).toBe(2);
        expect(row.medication_id).toBe(
          applied.rows.find(({ id }) => id === row.patient_id)!.medication_id,
        );
      }
      const ingredients = await postgres.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM patient_medication_ingredient
          WHERE patient_id = ANY($1::uuid[])`,
        [patientIds],
      );
      expect(ingredients.rows[0]!.count).toBe(0);
    } finally {
      await postgres.query('DELETE FROM patient WHERE id = ANY($1::uuid[])', [patientIds]);
    }
  });

  it('rolls back when a restored patient already has a medication row', async () => {
    const patientIds = await seedLegacyPatients(['Stored preexisting medication']);
    const patientId = patientIds[0]!;
    await postgres.query(
      `INSERT INTO patient_medication
         (patient_id, entered_name, status, confirmed_by_clinician_sub, confirmed_at)
       VALUES ($1, 'Preexisting record', 'active', $2, CURRENT_TIMESTAMP)`,
      [patientId, CLINICIAN_A],
    );
    try {
      await expect(
        reconcilePatientOwners({
          client: realReconciliationClient(),
          mappings: parseOwnerMappings(
            mappingJson([{ legacyPatientId: patientId, clinicianSub: CLINICIAN_A }]),
          ),
          apply: true,
        }),
      ).rejects.toThrow(/stored medication precondition.*existing=1/i);

      const restored = await postgres.query<{
        owner_clinician_sub: string | null;
        medication_count: number;
      }>(
        `SELECT p.owner_clinician_sub, count(pm.id)::int AS medication_count
           FROM patient p
           LEFT JOIN patient_medication pm ON pm.patient_id = p.id
          WHERE p.id = $1
          GROUP BY p.id, p.owner_clinician_sub`,
        [patientId],
      );
      expect(restored.rows).toEqual([{ owner_clinician_sub: null, medication_count: 1 }]);
    } finally {
      await postgres.query('DELETE FROM patient WHERE id = $1', [patientId]);
    }
  });
});
