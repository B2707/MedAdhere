// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { poolArgs, schedulerSend, secretSend } = vi.hoisted(() => ({
  poolArgs: [] as Array<Record<string, unknown>>,
  schedulerSend: vi.fn(),
  secretSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-scheduler', () => ({
  SchedulerClient: class {
    send = schedulerSend;
  },
  ListSchedulesCommand: class {
    readonly kind = 'list';
    constructor(readonly input: Record<string, unknown>) {}
  },
  DeleteScheduleCommand: class {
    readonly kind = 'delete';
    constructor(readonly input: Record<string, unknown>) {}
  },
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send = secretSend;
  },
  GetSecretValueCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
}));

vi.mock('pg', () => ({
  Pool: class {
    constructor(config: Record<string, unknown>) {
      poolArgs.push(config);
    }
  },
}));

import { buildPool, runWipe, type WipeClient } from './wipe-test-patients.js';

interface FakeClient extends WipeClient {
  readonly statements: string[];
}

function fakeClient(options: { deleteThrows?: boolean } = {}): FakeClient {
  const statements: string[] = [];
  return {
    statements,
    async query(text: string) {
      const normalized = text.replace(/\s+/g, ' ').trim();
      statements.push(normalized);
      if (normalized.includes('count(*)') && normalized.includes('is_test = true')) {
        return { rows: [{ count: '2' }], rowCount: 1 };
      }
      if (normalized.includes('count(*)') && normalized.includes('is_test = false')) {
        return { rows: [{ count: '1' }], rowCount: 1 };
      }
      if (normalized.startsWith('SELECT id FROM patient')) {
        return {
          rows: [
            { id: '11111111-1111-4111-8111-111111111111' },
            { id: '22222222-2222-4222-8222-222222222222' },
          ],
          rowCount: 2,
        };
      }
      if (normalized.startsWith('DELETE FROM patient')) {
        if (options.deleteThrows) throw new Error('delete failed');
        return { rows: [], rowCount: 2 };
      }
      return { rows: [], rowCount: null };
    },
  };
}

const ORIGINAL_CA_PATH = process.env.DB_CA_BUNDLE_PATH;

beforeEach(() => {
  poolArgs.length = 0;
  schedulerSend.mockReset();
  schedulerSend.mockResolvedValue({ Schedules: [] });
  secretSend.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (ORIGINAL_CA_PATH === undefined) {
    delete process.env.DB_CA_BUNDLE_PATH;
  } else {
    process.env.DB_CA_BUNDLE_PATH = ORIGINAL_CA_PATH;
  }
});

describe('runWipe — dry-run/apply safety gate', () => {
  it('dry-run reports both polarity counts without BEGIN or DELETE', async () => {
    const client = fakeClient();
    const result = await runWipe({ client, apply: false });

    expect(result).toEqual({
      mode: 'dry-run',
      testPatients: 2,
      nonTestPatients: 1,
    });
    expect(client.statements).toHaveLength(2);
    expect(client.statements.some((statement) => statement === 'BEGIN')).toBe(false);
    expect(client.statements.some((statement) => statement.startsWith('DELETE'))).toBe(false);
  });

  it('--apply uses one client in BEGIN → wipe → COMMIT order', async () => {
    const client = fakeClient();
    const result = await runWipe({ client, apply: true });

    expect(client.statements).toEqual([
      'BEGIN',
      'SELECT id FROM patient WHERE is_test = true',
      'DELETE FROM patient WHERE id = ANY($1::uuid[])',
      'COMMIT',
    ]);
    expect(result).toEqual({
      mode: 'applied',
      wipe: {
        testersFound: 2,
        patientsDeleted: 2,
        schedulesSwept: 0,
      },
    });
  });

  it('rolls back a mid-wipe failure and never commits', async () => {
    const client = fakeClient({ deleteThrows: true });

    await expect(runWipe({ client, apply: true })).rejects.toThrow('delete failed');
    expect(client.statements.at(-1)).toBe('ROLLBACK');
    expect(client.statements).not.toContain('COMMIT');
  });
});

describe('buildPool — TLS precondition', () => {
  it('fails before Secrets Manager or DB reach when DB_CA_BUNDLE_PATH is unset', async () => {
    delete process.env.DB_CA_BUNDLE_PATH;

    await expect(buildPool()).rejects.toThrow(
      /DB_CA_BUNDLE_PATH.*backend\/src\/schema-init\/rds-global-bundle\.pem/,
    );
    expect(secretSend).not.toHaveBeenCalled();
  });

  it('keeps the RDS hostname as the TLS servername when the socket uses a local tunnel', async () => {
    vi.stubEnv('DB_CA_BUNDLE_PATH', 'backend/src/schema-init/rds-global-bundle.pem');
    vi.stubEnv('DB_SECRET_ARN', 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test');
    vi.stubEnv('DB_HOST', '127.0.0.1');
    vi.stubEnv('DB_TLS_SERVERNAME', 'medadhere.example.us-east-1.rds.amazonaws.com');
    vi.stubEnv('DB_PORT', '5432');
    vi.stubEnv('DB_NAME', 'medadhere');
    secretSend.mockResolvedValue({
      SecretString: JSON.stringify({ username: 'db-user', password: 'db-password' }),
    });

    await buildPool();

    expect(poolArgs[0]).toMatchObject({
      host: '127.0.0.1',
      ssl: {
        rejectUnauthorized: true,
        servername: 'medadhere.example.us-east-1.rds.amazonaws.com',
      },
    });
  });
});
