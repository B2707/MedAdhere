// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { poolMock, readFileMock } = vi.hoisted(() => ({
  poolMock: vi.fn(function MockPool(config: unknown) {
    return { config };
  }),
  readFileMock: vi.fn(() => 'PINNED_CA'),
}));

vi.mock('pg', () => ({ Pool: poolMock }));
vi.mock('node:fs', () => ({ readFileSync: readFileMock }));

import { createDbPoolProvider } from './db-pool';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:ca-central-1:123:secret:db';
  process.env.DB_HOST = 'db.example.internal';
  process.env.DB_PORT = '5432';
  process.env.DB_NAME = 'medadhere';
  delete process.env.DB_TLS_SERVERNAME;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('createDbPoolProvider', () => {
  it('builds one cached max-2 TLS-verifying pool from Secrets Manager', async () => {
    const send = vi.fn(async () => ({
      SecretString: JSON.stringify({ username: 'app', password: 'secret' }),
    }));
    const getPool = createDbPoolProvider({ send });

    const first = await getPool();
    const second = await getPool();

    expect(first).toBe(second);
    expect(send).toHaveBeenCalledTimes(1);
    expect(readFileMock).toHaveBeenCalledWith(
      expect.stringMatching(/rds-global-bundle\.pem$/),
      'utf8',
    );
    expect(poolMock).toHaveBeenCalledTimes(1);
    expect(poolMock).toHaveBeenCalledWith({
      host: 'db.example.internal',
      port: 5432,
      database: 'medadhere',
      user: 'app',
      password: 'secret',
      max: 2,
      ssl: { ca: 'PINNED_CA', rejectUnauthorized: true },
    });
  });

  it.each([
    ['DB_SECRET_ARN', 'DB_SECRET_ARN env var is not set'],
    ['DB_HOST', 'DB_HOST / DB_PORT / DB_NAME env vars must all be set'],
    ['DB_PORT', 'DB_HOST / DB_PORT / DB_NAME env vars must all be set'],
    ['DB_NAME', 'DB_HOST / DB_PORT / DB_NAME env vars must all be set'],
  ])('fails before a network call when %s is missing', async (name, message) => {
    delete process.env[name];
    const send = vi.fn();
    const getPool = createDbPoolProvider({ send });
    await expect(getPool()).rejects.toThrow(message);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects an invalid database port before a network call', async () => {
    process.env.DB_PORT = '70000';
    const send = vi.fn();
    const getPool = createDbPoolProvider({ send });
    await expect(getPool()).rejects.toThrow('DB_PORT is not a valid TCP port');
    expect(send).not.toHaveBeenCalled();
  });

  it('fails closed when the secret has no SecretString', async () => {
    const getPool = createDbPoolProvider({ send: vi.fn(async () => ({})) });
    await expect(getPool()).rejects.toThrow('DB secret has no SecretString');
    expect(poolMock).not.toHaveBeenCalled();
  });

  it('uses the canonical source CA during unbundled local and test execution', async () => {
    readFileMock
      .mockImplementationOnce(() => {
        const error = new Error('missing bundled CA') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      })
      .mockReturnValueOnce('SOURCE_CA');
    const getPool = createDbPoolProvider({
      send: vi.fn(async () => ({
        SecretString: JSON.stringify({ username: 'app', password: 'secret' }),
      })),
    });

    await getPool();

    expect(readFileMock).toHaveBeenLastCalledWith(
      expect.stringMatching(/schema-init\/rds-global-bundle\.pem$/),
      'utf8',
    );
    expect(poolMock).toHaveBeenCalledWith(
      expect.objectContaining({ ssl: { ca: 'SOURCE_CA', rejectUnauthorized: true } }),
    );
  });

  it('forwards an optional TLS server name for a localhost bastion tunnel', async () => {
    process.env.DB_HOST = '127.0.0.1';
    process.env.DB_TLS_SERVERNAME = 'medadhere.example.ca-central-1.rds.amazonaws.com';
    const getPool = createDbPoolProvider({
      send: vi.fn(async () => ({
        SecretString: JSON.stringify({ username: 'medadhere_source_import', password: 'secret' }),
      })),
    });

    await getPool();

    expect(poolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '127.0.0.1',
        ssl: {
          ca: 'PINNED_CA',
          rejectUnauthorized: true,
          servername: 'medadhere.example.ca-central-1.rds.amazonaws.com',
        },
      }),
    );
  });
});
