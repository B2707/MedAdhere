/**
 * handler.test.ts — network-free unit test of the clinician Deactivation Lambda (STUDY-05 / SC4).
 *
 * NO real AWS, NO real DB, NO Docker, NO credentials. `pg`, `@aws-sdk/client-secrets-manager`, AND the
 * `../lib/scheduler-deactivate` sweep are fully mocked so the test drives the handler contract in
 * isolation and pins the M1 ORDER (the real-PG UPDATE semantics are proven in write-contract.test.ts):
 *   - missing/invalid clinician ID-token claims → generic 401 BEFORE path, DB, or scheduler reach;
 *   - M1: a non-UUID {id} → 400 after auth but before DB or scheduler reach;
 *   - a valid id → owner-scoped `UPDATE patient SET is_active=false` (NO opted_out_at) then
 *     deactivateSchedules(id,'dose') + (id,'timeout') (BOTH prefixes);
 *   - unknown, foreign-owned, or ownerless UUID → 404 and the sweep is NOT reached;
 *   - already-inactive → idempotent clean 200 (rowCount 1 regardless of prior is_active);
 *   - a partial-sweep failure SURFACES — the handler rejects (never a false-success 200), and the
 *     is_active=false write already committed (mirror inbound STOP, inbound/handler.ts:451-465);
 *   - identifier-free logs (the route never logs patient/clinician ids, phone, or body);
 *   - M3 (M-2 TLS): the pg.Pool ctor args carry ssl.rejectUnauthorized===true + a non-empty ssl.ca + max 2.
 *
 * Mirrors timeout/handler.test.ts (pg + SM mock, module-scoped-pool-reuse + M3), plus the scheduler-sweep
 * mock the STOP-mirror route needs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, endMock, smSend, poolArgs, deactivateSchedulesMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  endMock: vi.fn(),
  smSend: vi.fn(),
  // M3 — captures the `new Pool({...})` constructor args so the test asserts the CA-pinning TLS config.
  poolArgs: [] as Array<Record<string, unknown>>,
  // The scheduler sweep is an AWS-touching side effect; mock it so the unit test asserts the STOP-mirror
  // both-prefix call shape + the partial-failure-surfaces semantic without any real scheduler call.
  deactivateSchedulesMock: vi.fn(),
}));

vi.mock('pg', () => ({
  Pool: vi.fn(function (config: Record<string, unknown>) {
    poolArgs.push(config);
    return { query: queryMock, end: endMock };
  }),
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn(function () {
    return { send: smSend };
  }),
  GetSecretValueCommand: vi.fn(function (args: unknown) {
    return { __args: args };
  }),
}));

vi.mock('../lib/scheduler-deactivate', () => ({
  deactivateSchedules: deactivateSchedulesMock,
}));

import { Pool } from 'pg';

/** Re-import the handler with a fresh module registry so the module-scoped `pool` starts undefined. */
async function freshHandler() {
  vi.resetModules();
  const mod = await import('./handler.js');
  return mod.handler;
}

const DB_SECRET = JSON.stringify({ username: 'medadhere_admin', password: 'pw' });
// Real 36-char UUIDs (Phase-3 HIGH-3 lesson — never short fake ids; the truncated timeout- name must
// still be swept, which is exercised end-to-end in write-contract + the scheduler sweep's own tests).
const PATIENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const CLINICIAN_SUB = '97b4a172-e055-4c37-9d95-2a00664dfe64';

/** Build the API GW v2 proxy event with an {id} path parameter and valid clinician ID-token claims. */
function evt(id: string | undefined) {
  return {
    pathParameters: { id },
    requestContext: {
      authorizer: {
        jwt: { claims: { sub: CLINICIAN_SUB, token_use: 'id' } },
      },
    },
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;

function allLogLines(): string[] {
  return (logSpy.mock.calls as unknown[][]).map((c) => c.map(String).join(' '));
}

function findQuery(re: RegExp): [string, unknown[]] | undefined {
  return (queryMock.mock.calls as Array<[string, unknown[]]>).find((c) => re.test(String(c[0])));
}

/** Wire the default mocks: SM returns the DB secret; the UPDATE affects `updateRowCount` rows; sweep 0. */
function wireDefaults(updateRowCount = 1) {
  smSend.mockResolvedValue({ SecretString: DB_SECRET });
  queryMock.mockImplementation((sql: string) => {
    if (/UPDATE\s+patient/i.test(sql)) {
      return Promise.resolve({ rowCount: updateRowCount, rows: [] });
    }
    return Promise.resolve({ rowCount: 0, rows: [] });
  });
  deactivateSchedulesMock.mockResolvedValue(0);
}

beforeEach(() => {
  vi.clearAllMocks();
  poolArgs.length = 0;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:db';
  process.env.DB_HOST = 'db.internal';
  process.env.DB_PORT = '5432';
  process.env.DB_NAME = 'medadhere';
  wireDefaults();
});

describe('deactivate handler — M1 UUID gate (400 BEFORE any DB/scheduler reach)', () => {
  it('a non-UUID {id} → 400 and NEVER builds the pool NOR calls the scheduler sweep', async () => {
    const handler = await freshHandler();
    const res = await handler(evt('not-a-uuid'));
    expect(res.statusCode).toBe(400);
    // M1 — after successful auth, the 400 short-circuits before getPool() and any sweep.
    expect(Pool).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(deactivateSchedulesMock).not.toHaveBeenCalled();
  });

  it('a missing {id} path parameter → 400, no DB/scheduler reach', async () => {
    const handler = await freshHandler();
    const res = await handler(evt(undefined));
    expect(res.statusCode).toBe(400);
    expect(Pool).not.toHaveBeenCalled();
    expect(deactivateSchedulesMock).not.toHaveBeenCalled();
  });
});

describe('deactivate handler — clinician claims gate', () => {
  it('missing claims → generic 401 before path validation, DB, or scheduler reach', async () => {
    const handler = await freshHandler();
    const res = await handler({ pathParameters: { id: 'not-a-uuid' } });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'unauthorized' });
    expect(Pool).not.toHaveBeenCalled();
    expect(smSend).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(deactivateSchedulesMock).not.toHaveBeenCalled();
  });

  it('an access-token claim set → generic 401 before DB or scheduler reach', async () => {
    const handler = await freshHandler();
    const event = evt(PATIENT_ID);
    event.requestContext.authorizer.jwt.claims.token_use = 'access';
    const res = await handler(event);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'unauthorized' });
    expect(Pool).not.toHaveBeenCalled();
    expect(smSend).not.toHaveBeenCalled();
    expect(deactivateSchedulesMock).not.toHaveBeenCalled();
  });
});

describe('deactivate handler — happy path (is_active=false + all-prefix sweep)', () => {
  it('a valid id → owner-scoped UPDATE bound to patient id and clinician sub, NO opted_out_at', async () => {
    const handler = await freshHandler();
    await handler(evt(PATIENT_ID));
    const update = findQuery(/UPDATE\s+patient/i);
    expect(update).toBeDefined();
    const [sql, params] = update!;
    expect(sql).toMatch(/is_active\s*=\s*false/i);
    expect(sql).toMatch(/WHERE\s+id\s*=\s*\$1\s+AND\s+owner_clinician_sub\s*=\s*\$2/i);
    // Admin deactivation is NOT a patient-STOP: it must NOT set opted_out_at (inbound STOP owns that).
    expect(sql).not.toMatch(/opted_out_at/i);
    expect(params).toEqual([PATIENT_ID, CLINICIAN_SUB]);
  });

  it('sweeps dose, reminder, and timeout schedules for the patient', async () => {
    const handler = await freshHandler();
    const res = await handler(evt(PATIENT_ID));
    expect(res.statusCode).toBe(200);
    expect(deactivateSchedulesMock).toHaveBeenCalledTimes(3);
    expect(deactivateSchedulesMock).toHaveBeenCalledWith(PATIENT_ID, 'dose');
    expect(deactivateSchedulesMock).toHaveBeenCalledWith(PATIENT_ID, 'reminder');
    expect(deactivateSchedulesMock).toHaveBeenCalledWith(PATIENT_ID, 'timeout');
  });

  it('logs an identifier-free deactivate_recorded line and returns 200 { deactivated: true }', async () => {
    const handler = await freshHandler();
    const res = await handler(evt(PATIENT_ID));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ deactivated: true });
    const line = allLogLines().find((l) => /deactivate_recorded/.test(l));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toEqual({ metric: 'deactivate_recorded', schedulesDeleted: 0 });
    expect(line).not.toContain(PATIENT_ID);
    expect(line).not.toContain(CLINICIAN_SUB);
  });
});

describe('deactivate handler — 404 on unknown patient (never a masking 200)', () => {
  it('an unknown or foreign-owner id → identical 404 and the scheduler sweep is NOT reached', async () => {
    wireDefaults(0);
    const handler = await freshHandler();
    const res = await handler(evt(PATIENT_ID));
    expect(res.statusCode).toBe(404);
    // An unmatched owner-scoped write never sweeps schedules (and never falsely 200s — M1).
    expect(deactivateSchedulesMock).not.toHaveBeenCalled();
    const line = allLogLines().find((entry) => /deactivate_not_found/.test(entry));
    expect(JSON.parse(line!)).toEqual({ metric: 'deactivate_not_found' });
    expect(line).not.toContain(PATIENT_ID);
    expect(line).not.toContain(CLINICIAN_SUB);
  });
});

describe('deactivate handler — idempotent already-inactive → clean 200', () => {
  it('a second owned deactivation (still rowCount 1) → 200, sweep runs again (no orphans)', async () => {
    // The real-PG proof that an already-inactive row still matches (rowCount 1) lives in
    // write-contract.test.ts; here the rowCount-1 → 200 idempotent branch is pinned.
    wireDefaults(1);
    const handler = await freshHandler();
    const res = await handler(evt(PATIENT_ID));
    expect(res.statusCode).toBe(200);
    expect(deactivateSchedulesMock).toHaveBeenCalledTimes(3);
  });
});

describe('deactivate handler — a partial-sweep failure SURFACES (never a false-success 200)', () => {
  it('the dose sweep throwing → the handler REJECTS, and the is_active=false write already committed', async () => {
    wireDefaults(1);
    // The first sweep (dose-) fails at runtime (e.g. an AccessDenied on ListSchedules); mirror the
    // inbound STOP contract — the throw propagates (a 5xx), never swallowed into a success.
    deactivateSchedulesMock.mockRejectedValueOnce(new Error('AccessDenied on ListSchedules'));
    const handler = await freshHandler();
    await expect(handler(evt(PATIENT_ID))).rejects.toThrow(/AccessDenied/);
    // The compliance-critical is_active=false write ran BEFORE the sweep (STOP-mirror ordering).
    expect(findQuery(/UPDATE\s+patient/i)).toBeDefined();
    // Only the first (dose) sweep was attempted; the failure surfaced before the timeout sweep.
    expect(deactivateSchedulesMock).toHaveBeenCalledTimes(1);
    // No false-success line was emitted.
    expect(allLogLines().some((l) => /deactivate_recorded/.test(l))).toBe(false);
  });
});

describe('deactivate handler — M3: verifies the RDS server cert against the pinned CA bundle (M-2)', () => {
  it('constructs the pg.Pool with ssl.rejectUnauthorized:true, a non-empty ssl.ca, and max 2', async () => {
    const handler = await freshHandler();
    await handler(evt(PATIENT_ID));
    expect(poolArgs).toHaveLength(1);
    const ssl = poolArgs[0]?.ssl as { ca?: unknown; rejectUnauthorized?: unknown } | undefined;
    expect(ssl?.rejectUnauthorized).toBe(true);
    expect(typeof ssl?.ca).toBe('string');
    expect((ssl?.ca as string).length).toBeGreaterThan(0);
    expect(poolArgs[0]?.max).toBe(2);
  });
});
