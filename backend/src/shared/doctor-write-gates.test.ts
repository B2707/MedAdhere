import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, connectMock, releaseMock, smSend, logSpy } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  connectMock: vi.fn(),
  releaseMock: vi.fn(),
  smSend: vi.fn(),
  logSpy: vi.spyOn(console, 'log').mockImplementation(() => {}),
}));

vi.mock('pg', () => ({
  Pool: vi.fn(function () {
    return { query: queryMock, connect: connectMock };
  }),
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn(function () {
    return { send: smSend };
  }),
  GetSecretValueCommand: vi.fn(function (args: unknown) {
    return { args };
  }),
}));

import { Pool } from 'pg';

const PATIENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const DRAFT_ID = '5c2504e0-4f89-41d3-9a0c-0305e82c3399';
const ACTION_ID = '6c2504e0-4f89-41d3-9a0c-0305e82c3398';
const FACT_ID = '7c2504e0-4f89-41d3-9a0c-0305e82c3397';
const CLINICIAN_SUB = '97b4a172-e055-4c37-9d95-2a00664dfe64';

type WriteHandler = (
  event: Record<string, unknown>,
) => Promise<{ statusCode: number; body: string }>;

async function freshHandler(modulePath: string): Promise<WriteHandler> {
  vi.resetModules();
  const mod = (await import(modulePath)) as { handler: WriteHandler };
  return mod.handler;
}

const ROUTES = [
  {
    name: 'review-decision',
    modulePath: '../review-decision/handler.js',
    pathParameters: { id: PATIENT_ID, draftId: DRAFT_ID },
    body: { decision: 'reject', expectedVersion: 1, selectedCorrectionIds: [] },
    invalidBodies: [
      { decision: 'maybe', expectedVersion: 1, selectedCorrectionIds: [] },
      { decision: 'reject', expectedVersion: 0, selectedCorrectionIds: [] },
      { decision: 'reject', expectedVersion: 1, selectedCorrectionIds: [FACT_ID] },
      { decision: 'confirm', expectedVersion: 1, selectedCorrectionIds: [], patientId: PATIENT_ID },
    ],
  },
  {
    name: 'reminder-limit',
    modulePath: '../reminder-limit/handler.js',
    pathParameters: { id: PATIENT_ID },
    body: { expectedVersion: 1, reminderLimit: 3 },
    invalidBodies: [
      { expectedVersion: 1, reminderLimit: 6 },
      { expectedVersion: 1, reminderLimit: -1 },
      { expectedVersion: 1 },
      { expectedVersion: 1, reminderLimit: 3, patientId: PATIENT_ID },
    ],
  },
] as const;

function event(route: (typeof ROUTES)[number], overrides: Record<string, unknown> = {}) {
  return {
    pathParameters: route.pathParameters,
    body: JSON.stringify(route.body),
    requestContext: {
      authorizer: { jwt: { claims: { sub: CLINICIAN_SUB, token_use: 'id' } } },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  logSpy.mockClear();
  smSend.mockResolvedValue({
    SecretString: JSON.stringify({ username: 'medadhere_app', password: 'pw' }),
  });
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  connectMock.mockResolvedValue({ query: queryMock, release: releaseMock });
  process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:db';
  process.env.DB_HOST = 'db.internal';
  process.env.DB_PORT = '5432';
  process.env.DB_NAME = 'medadhere';
});

describe.each(ROUTES)('$name doctor write trust boundary', (route) => {
  it.each([
    { claims: undefined },
    { claims: { sub: CLINICIAN_SUB, token_use: 'access' } },
    { claims: { sub: 'not-a-uuid', token_use: 'id' } },
  ])('returns generic 401 before path, body, or DB', async ({ claims }) => {
    const handler = await freshHandler(route.modulePath);
    const response = await handler({
      pathParameters: { id: 'bad' },
      body: '{',
      requestContext: claims ? { authorizer: { jwt: { claims } } } : {},
    });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'unauthorized' });
    expect(Pool).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid path before parsing a valid-looking body or reaching DB', async () => {
    const handler = await freshHandler(route.modulePath);
    const response = await handler(
      event(route, { pathParameters: { ...route.pathParameters, id: 'not-a-uuid' } }),
    );
    expect(response.statusCode).toBe(400);
    expect(Pool).not.toHaveBeenCalled();
  });

  it.each([
    { body: undefined },
    { body: '{' },
    { body: 'e30=', isBase64Encoded: true },
    { body: `{"pad":"${'x'.repeat(9_000)}"}` },
  ])(
    'returns 400 for malformed, missing, base64, or oversized body before DB',
    async (overrides) => {
      const handler = await freshHandler(route.modulePath);
      const response = await handler(event(route, overrides));
      expect(response.statusCode).toBe(400);
      expect(Pool).not.toHaveBeenCalled();
    },
  );

  it('returns 400 for every strict shared-contract violation before DB', async () => {
    for (const invalidBody of route.invalidBodies) {
      const handler = await freshHandler(route.modulePath);
      const response = await handler(event(route, { body: JSON.stringify(invalidBody) }));
      expect(response.statusCode).toBe(400);
      expect(Pool).not.toHaveBeenCalled();
    }
  });
});

describe('doctor write status and privacy gates', () => {
  it('reminder limit maps owner-hidden absence to 404 and stale state to 409', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({ rows: [] });
    let handler = await freshHandler('../reminder-limit/handler.js');
    expect((await handler(event(ROUTES[1]))).statusCode).toBe(404);

    queryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ messaging_state_version: 7 }] });
    handler = await freshHandler('../reminder-limit/handler.js');
    const conflict = await handler(event(ROUTES[1]));
    expect(conflict.statusCode).toBe(409);
    expect(JSON.parse(conflict.body)).toMatchObject({ messagingStateVersion: 7 });
  });

  it('success responses pass the strict shared response contracts', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ reminder_limit: 3, messaging_state_version: 2 }],
      rowCount: 1,
    });
    let handler = await freshHandler('../reminder-limit/handler.js');
    expect(JSON.parse((await handler(event(ROUTES[1]))).body)).toEqual({
      reminderLimit: 3,
      messagingStateVersion: 2,
    });

    queryMock.mockClear();
    queryMock.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return Promise.resolve({ rows: [], rowCount: 0 });
      if (/FROM patient/.test(sql))
        return Promise.resolve({ rows: [{ id: PATIENT_ID }], rowCount: 1 });
      if (/FROM clinician_review_draft/.test(sql) && /supersedes_id/.test(sql)) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (/FROM clinician_review_draft/.test(sql)) {
        return Promise.resolve({
          rows: [{ version: 1, proposed_corrections: [] }],
          rowCount: 1,
        });
      }
      if (/INSERT INTO clinician_review_action/.test(sql)) {
        return Promise.resolve({ rows: [{ id: ACTION_ID }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    handler = await freshHandler('../review-decision/handler.js');
    expect(JSON.parse((await handler(event(ROUTES[0]))).body)).toEqual({
      decision: 'reject',
      applied: true,
      actionId: ACTION_ID,
      createdFactIds: [],
    });
    const sqlCalls = queryMock.mock.calls.map(([sql]) => String(sql));
    expect(sqlCalls[0]).toBe('BEGIN');
    expect(sqlCalls[1]).toMatch(/FROM patient[\s\S]*owner_clinician_sub[\s\S]*FOR UPDATE/);

    const serializedLogs = JSON.stringify(logSpy.mock.calls);
    for (const forbidden of [PATIENT_ID, DRAFT_ID, ACTION_ID, FACT_ID, CLINICIAN_SUB]) {
      expect(serializedLogs).not.toContain(forbidden);
    }
  });

  it('routine logs contain no patient, draft, action, fact, clinician identifiers or text', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ reminder_limit: 3, messaging_state_version: 2 }],
      rowCount: 1,
    });
    const handler = await freshHandler('../reminder-limit/handler.js');
    await handler(event(ROUTES[1]));
    const serialized = JSON.stringify(logSpy.mock.calls);
    for (const forbidden of [PATIENT_ID, DRAFT_ID, ACTION_ID, FACT_ID, CLINICIAN_SUB]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('review decision transaction', () => {
  it('rolls back and releases when the owned patient lock matches nothing', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const handler = await freshHandler('../review-decision/handler.js');
    expect((await handler(event(ROUTES[0]))).statusCode).toBe(404);
    expect(queryMock).toHaveBeenCalledWith('ROLLBACK');
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it('rolls back, releases, and rethrows unexpected errors', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve({ rows: [], rowCount: 0 });
      return Promise.reject(new Error('connection reset'));
    });
    const handler = await freshHandler('../review-decision/handler.js');
    await expect(handler(event(ROUTES[0]))).rejects.toThrow('connection reset');
    expect(queryMock).toHaveBeenCalledWith('ROLLBACK');
    expect(releaseMock).toHaveBeenCalledOnce();
  });
});
