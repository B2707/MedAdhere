import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  poolConstructor: vi.fn(),
  runExportAnon: vi.fn(),
  secretsSend: vi.fn(),
  s3Send: vi.fn(),
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send = mocks.secretsSend;
  },
  GetSecretValueCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = mocks.s3Send;
  },
  PutObjectCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

vi.mock('pg', () => ({
  Pool: class {
    constructor(options: unknown) {
      mocks.poolConstructor(options);
    }
  },
}));

vi.mock('./core.js', () => ({ runExportAnon: mocks.runExportAnon }));

const ENV_KEYS = [
  'DB_SECRET_ARN',
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'EXPORT_BUCKET_NAME',
] as const;

async function loadHandler() {
  vi.resetModules();
  return import('./handler.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:db';
  process.env.DB_HOST = 'db.example.test';
  process.env.DB_PORT = '5432';
  process.env.DB_NAME = 'medadhere';
  process.env.EXPORT_BUCKET_NAME = 'exports-test';
  mocks.secretsSend.mockResolvedValue({
    SecretString: JSON.stringify({ username: 'reader', password: 'secret' }),
  });
  mocks.s3Send.mockResolvedValue({});
  mocks.runExportAnon.mockResolvedValue({
    rowCount: 4,
    destination: 's3://exports-test/exports/result.csv',
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('export-anon Lambda handler seams', () => {
  it('writes timestamped CSV with the exact S3 content type', async () => {
    const { makeS3Putter } = await loadHandler();
    const client = { send: mocks.s3Send };
    const putter = makeS3Putter(
      client as never,
      'exports-test',
      () => new Date('2026-08-03T12:34:56.789Z'),
    );

    await expect(putter.put('patient_id\nabc\n')).resolves.toEqual({
      destination: 's3://exports-test/exports/adherence-anon-2026-08-03T12-34-56-789Z.csv',
    });
    expect(mocks.s3Send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: 'exports-test',
          Body: 'patient_id\nabc\n',
          ContentType: 'text/csv',
        }),
      }),
    );
  });

  it('fails before database access when the export bucket is missing', async () => {
    delete process.env.EXPORT_BUCKET_NAME;
    const { handler } = await loadHandler();
    await expect(handler()).rejects.toThrow('EXPORT_BUCKET_NAME env var is not set');
    expect(mocks.secretsSend).not.toHaveBeenCalled();
  });

  it('requires the database secret ARN', async () => {
    delete process.env.DB_SECRET_ARN;
    const { handler } = await loadHandler();
    await expect(handler()).rejects.toThrow('DB_SECRET_ARN env var is not set');
  });

  it.each(['DB_HOST', 'DB_PORT', 'DB_NAME'] as const)(
    'requires the complete database endpoint when %s is missing',
    async (key) => {
      delete process.env[key];
      const { handler } = await loadHandler();
      await expect(handler()).rejects.toThrow('DB_HOST / DB_PORT / DB_NAME');
    },
  );

  it.each(['not-a-port', '0', '65536'])(
    'rejects invalid DB_PORT value %s',
    async (port) => {
      process.env.DB_PORT = port;
      const { handler } = await loadHandler();
      await expect(handler()).rejects.toThrow('DB_PORT is not a valid TCP port');
    },
  );

  it('rejects an unpopulated database secret', async () => {
    mocks.secretsSend.mockResolvedValue({ SecretString: undefined });
    const { handler } = await loadHandler();
    await expect(handler()).rejects.toThrow('DB secret has no SecretString');
  });

  it('includes test patients by default, honors an explicit exclusion, and reuses the pool', async () => {
    const { handler } = await loadHandler();

    await expect(handler()).resolves.toEqual({
      rowCount: 4,
      destination: 's3://exports-test/exports/result.csv',
    });
    await expect(handler({ excludeTest: true })).resolves.toEqual({
      rowCount: 4,
      destination: 's3://exports-test/exports/result.csv',
    });

    expect(mocks.secretsSend).toHaveBeenCalledTimes(1);
    expect(mocks.poolConstructor).toHaveBeenCalledTimes(1);
    expect(mocks.poolConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'db.example.test',
        port: 5432,
        database: 'medadhere',
        user: 'reader',
        password: 'secret',
        max: 2,
        ssl: expect.objectContaining({ rejectUnauthorized: true }),
      }),
    );
    expect(mocks.runExportAnon).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ options: { excludeTest: false } }),
    );
    expect(mocks.runExportAnon).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ options: { excludeTest: true } }),
    );
  });
});
