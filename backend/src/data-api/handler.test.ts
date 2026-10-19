/**
 * handler.test.ts — network-free unit test of the data-API Lambda handler's PURE logic (SC0 / SC4 data path).
 *
 * NO real AWS, NO real DB, NO Docker, NO credentials. `pg` and `@aws-sdk/client-secrets-manager` are
 * fully mocked so the tests drive the routeKey switch (D1 — the SELECT fn is now the read router for ALL
 * reads) in isolation. The SEMANTICS of the pinned read SQL are proven separately against a real PG16 in
 * read-contract.test.ts; this file pins the DISPATCH + response shape + the health-path regression gates.
 *
 * Health path (SC4, unchanged behavior — now reached via routeKey 'GET /api/health'):
 *   - happy path → { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }
 *   - DB_SECRET_ARN unset / DB_HOST-PORT-NAME guard / empty SecretString → actionable throw
 *   - module-scoped pool reuse → the pg.Pool ctor is constructed exactly ONCE across two calls
 *   - M3 (M-2 TLS unit assertion): captured pg.Pool ctor args carry ssl.rejectUnauthorized===true + non-empty ssl.ca
 *
 * Read expansion (SC0 / D1):
 *   - each read routeKey dispatches its EXACT pinned SQL const (drift guard — imports the const)
 *   - GET /api/patients/{id} validates the uuid param 400-FIRST (zod .parse D-16 gate — no DB reach), 404 on 0 rows
 *   - GET /api/patients maps `alerting` from consecutive_missed + threshold with is_active/opt-out suppression (D5/D14)
 *   - alertThreshold() parses + clamps ALERT_CONSECUTIVE_MISSED (default 3)
 *   - safetySendingStuckMinutes() parses + clamps SAFETY_SENDING_STUCK_MINUTES (default 15)
 *   - responseWindowMinutes(), timelineWindowDays(), and reviewQueueLimit() parse + clamp server bounds
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.mock` is hoisted above all top-level statements, so the spy fns the factories reference must be
// created inside `vi.hoisted` (also hoisted). The handler constructs `new SecretsManagerClient({})` at
// import time, so that factory constructor must be a `new`-able real `function`. The handler builds the
// pool LAZILY inside getPool() (not at import time), but the `pg.Pool` mock is still a constructable
// `function` so the M3 assertion can read its captured args.
const { queryMock, endMock, sendMock, poolArgs, clinicalHistoryHandlerMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  endMock: vi.fn(),
  sendMock: vi.fn(),
  // M3 — captures the `new Pool({...})` constructor args so the test can assert the CA-pinning TLS config.
  poolArgs: [] as Array<Record<string, unknown>>,
  clinicalHistoryHandlerMock: vi.fn(),
}));

vi.mock('../clinical-history/handler', () => ({ handler: clinicalHistoryHandlerMock }));

// --- mock pg: a module-scoped Pool whose methods are the hoisted spies the test inspects ----------
vi.mock('pg', () => ({
  Pool: vi.fn(function (config: Record<string, unknown>) {
    poolArgs.push(config);
    return { query: queryMock, end: endMock };
  }),
}));

// --- mock Secrets Manager: GetSecretValueCommand returns a fake DB credential JSON ----------------
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn(function () {
    return { send: sendMock };
  }),
  GetSecretValueCommand: vi.fn(function (args: unknown) {
    return { __args: args };
  }),
}));

// Import AFTER the mocks are registered. The handler module-scopes `let pool` — so to get a CLEAN pool
// per test we reset modules and re-import (freshHandler below). The SQL consts + alertThreshold are pure
// module exports (stable across the reset), imported here so the dispatch tests assert the EXACT SQL.
import { Pool } from 'pg';
import {
  LIST_PATIENTS_SQL,
  PATIENT_DETAIL_SQL,
  PATIENT_TIMELINE_SQL,
  COHORT_ADHERENCE_SQL,
  SAFETY_QUEUE_SQL,
  UNKNOWN_QUEUE_SQL,
  alertThreshold,
  safetySendingStuckMinutes,
  responseWindowMinutes,
  timelineWindowDays,
  reviewQueueLimit,
} from './handler.js';
import {
  ALERT_QUEUE_SQL,
  DRAFT_QUEUE_SQL,
  PATIENT_DAY_INDEX_SQL,
  PATIENT_RECORD_LIMITS,
  PATIENT_RECORD_SCOPE_SQL,
} from './patient-record.js';
import { UPDATE_PATIENT_DETAILS_SQL } from './patient-details.js';

/** Re-import the handler with a fresh module registry so the module-scoped `pool` starts undefined. */
async function freshHandler() {
  vi.resetModules();
  const mod = await import('./handler.js');
  return (event: Parameters<typeof mod.handler>[0]) =>
    mod.handler({
      ...event,
      requestContext: {
        authorizer: {
          jwt: {
            claims: {
              sub: VALID_CLINICIAN_SUB,
              token_use: 'id',
            },
          },
        },
      },
    });
}

/** Re-import the unwrapped entrypoint for fail-closed authorization tests. */
async function freshRawHandler() {
  vi.resetModules();
  const mod = await import('./handler.js');
  return mod.handler;
}

const HEALTH = { routeKey: 'GET /api/health' } as const;
const VALID_UUID = '11111111-1111-4111-8111-111111111111';
const VALID_CLINICIAN_SUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeEach(() => {
  vi.clearAllMocks();
  poolArgs.length = 0; // reset the captured pg Pool ctor args (M3)
  sendMock.mockResolvedValue({
    SecretString: JSON.stringify({ username: 'medadhere_admin', password: 'pw' }),
  });
  // Default: any query resolves to a single {ok:1} row (the health SELECT 1 shape; harmless for reads).
  queryMock.mockResolvedValue({ rows: [{ ok: 1 }] });
  process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:db';
  process.env.DB_HOST = 'db.internal';
  process.env.DB_PORT = '5432';
  process.env.DB_NAME = 'medadhere';
  delete process.env.ALERT_CONSECUTIVE_MISSED;
  delete process.env.SAFETY_SENDING_STUCK_MINUTES;
  delete process.env.RESPONSE_WINDOW_MINUTES;
  delete process.env.PATIENT_TIMELINE_WINDOW_DAYS;
  delete process.env.REVIEW_QUEUE_LIMIT;
});

describe('data-api handler — clinician claims are required before any DB reach', () => {
  it.each([
    {
      name: 'missing authorizer claims on a patient route',
      event: { routeKey: 'GET /api/patients' },
    },
    {
      name: 'missing authorizer claims on health',
      event: { routeKey: 'GET /api/health' },
    },
    {
      name: 'missing authorizer claims on an unknown route',
      event: { routeKey: 'GET /api/nope' },
    },
    {
      name: 'wrong token_use',
      event: {
        routeKey: 'GET /api/patients',
        requestContext: {
          authorizer: {
            jwt: { claims: { sub: VALID_CLINICIAN_SUB, token_use: 'access' } },
          },
        },
      },
    },
    {
      name: 'invalid Cognito subject',
      event: {
        routeKey: 'GET /api/patients',
        requestContext: {
          authorizer: { jwt: { claims: { sub: 'not-a-uuid', token_use: 'id' } } },
        },
      },
    },
  ])('returns a generic 401 for $name without constructing the pool', async ({ event }) => {
    const handler = await freshRawHandler();
    const res = await handler(event);

    expect(res).toEqual({
      statusCode: 401,
      headers: { 'content-type': 'application/json' },
      body: '{"error":"unauthorized"}',
    });
    expect(Pool).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('data-api handler — GET /api/health runs SELECT 1 and returns { ok: true } (SC4)', () => {
  it('returns 200 + JSON content-type + body {"ok":true} on a stubbed SELECT 1', async () => {
    const handler = await freshHandler();
    const res = await handler(HEALTH);

    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({ 'content-type': 'application/json' });
    expect(res.body).toBe('{"ok":true}');

    const calls = queryMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((q) => /SELECT 1/i.test(q))).toBe(true);
  });

  it('reads the DB credential from Secrets Manager (no hard-coded / env-baked credential — D-06)', async () => {
    const handler = await freshHandler();
    await handler(HEALTH);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('reports { ok: false } if SELECT 1 does not return ok === 1 (defensive)', async () => {
    queryMock.mockResolvedValue({ rows: [{ ok: 0 }] });
    const handler = await freshHandler();
    const res = await handler(HEALTH);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"ok":false}');
  });
});

describe('data-api handler — doctor-only clinical history routes', () => {
  it('delegates the clinical-history route through the existing data API Lambda', async () => {
    clinicalHistoryHandlerMock.mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: '{"history":{}}',
    });
    const handler = await freshHandler();
    const event = {
      routeKey: 'GET /api/patients/{id}/clinical-history',
      pathParameters: { id: VALID_UUID },
    };

    expect(await handler(event)).toMatchObject({ statusCode: 200 });
    expect(clinicalHistoryHandlerMock).toHaveBeenCalledOnce();
  });
});

describe('data-api handler — doctor-owned contact-detail correction', () => {
  const DETAILS = 'POST /api/patients/{id}/details';

  it('dispatches the details write and returns the JSON envelope', async () => {
    queryMock.mockResolvedValue({
      rowCount: 1,
      rows: [{ display_name: 'Alice B', phone: '+15145550199', messaging_state_version: 4 }],
    });
    const handler = await freshHandler();

    const res = await handler({
      routeKey: DETAILS,
      pathParameters: { id: VALID_UUID },
      body: JSON.stringify({ expectedVersion: 3, phoneNumber: '+15145550199' }),
    });

    expect(res).toEqual({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Alice B',
        phoneNumber: '+15145550199',
        messagingStateVersion: 4,
        changed: true,
      }),
    });
    expect(queryMock).toHaveBeenCalledWith(UPDATE_PATIENT_DETAILS_SQL, [
      VALID_UUID,
      VALID_CLINICIAN_SUB,
      null,
      '+15145550199',
      3,
    ]);
  });

  it('400s on an invalid body before any DB reach (the D-16 gate)', async () => {
    const handler = await freshHandler();

    const res = await handler({
      routeKey: DETAILS,
      pathParameters: { id: VALID_UUID },
      body: JSON.stringify({ expectedVersion: 3, phoneNumber: '5145550199' }),
    });

    expect(res).toMatchObject({ statusCode: 400 });
    expect(Pool).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('data-api handler — env guards throw actionable errors (WR-04 analog / D-06)', () => {
  it('throws when DB_SECRET_ARN is unset', async () => {
    delete process.env.DB_SECRET_ARN;
    const handler = await freshHandler();
    await expect(handler(HEALTH)).rejects.toThrow(/DB_SECRET_ARN env var is not set/);
    expect(Pool).not.toHaveBeenCalled();
  });

  it('throws the all-three guard when DB_HOST is missing', async () => {
    delete process.env.DB_HOST;
    const handler = await freshHandler();
    await expect(handler(HEALTH)).rejects.toThrow(/DB_HOST \/ DB_PORT \/ DB_NAME/);
    expect(Pool).not.toHaveBeenCalled();
  });

  it('throws the all-three guard when DB_NAME is missing', async () => {
    delete process.env.DB_NAME;
    const handler = await freshHandler();
    await expect(handler(HEALTH)).rejects.toThrow(/DB_HOST \/ DB_PORT \/ DB_NAME/);
    expect(Pool).not.toHaveBeenCalled();
  });

  it('throws when the secret has an empty SecretString', async () => {
    sendMock.mockResolvedValue({ SecretString: '' });
    const handler = await freshHandler();
    await expect(handler(HEALTH)).rejects.toThrow(/DB secret has no SecretString/);
    expect(Pool).not.toHaveBeenCalled();
  });
});

describe('data-api handler — module-scoped pool is built once and reused across warm invokes (D-11)', () => {
  it('constructs the pg.Pool exactly ONCE across two sequential handler() calls', async () => {
    const handler = await freshHandler();
    await handler(HEALTH);
    await handler(HEALTH);
    expect(Pool).toHaveBeenCalledTimes(1);
    expect(poolArgs).toHaveLength(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('constructs the pool with max: 2 (D-11 connection cap)', async () => {
    const handler = await freshHandler();
    await handler(HEALTH);
    expect(poolArgs).toHaveLength(1);
    expect(poolArgs[0]?.max).toBe(2);
  });
});

describe('data-api handler — M3: verifies the RDS server cert against the pinned CA bundle (M-2 / T-02-08)', () => {
  it('constructs the pg.Pool with ssl.rejectUnauthorized:true AND a non-empty ssl.ca (the bundled RDS global CA PEM)', async () => {
    const handler = await freshHandler();
    await handler(HEALTH);

    expect(poolArgs).toHaveLength(1);
    const ssl = poolArgs[0]?.ssl as { ca?: unknown; rejectUnauthorized?: unknown } | undefined;
    expect(ssl).toBeDefined();
    expect(ssl?.rejectUnauthorized).toBe(true);
    expect(typeof ssl?.ca).toBe('string');
    expect((ssl?.ca as string).length).toBeGreaterThan(0);
  });
});

describe('data-api handler — SC0 read routeKey switch dispatches the EXACT pinned SQL (D1)', () => {
  it('GET /api/patients → LIST_PATIENTS_SQL with real handoff roster fields, 200', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'patient-a',
          is_active: true,
          agent_enabled: true,
          provider_opted_in: true,
          opted_out_at: null,
          consecutive_missed: 3,
          consecutive_reported_misses: 3,
          adherence_rate: 0.75,
          last_reply_at: '2026-07-02T13:15:00.000Z',
          recent_doses: [
            {
              dose_id: 'dose-taken',
              scheduled_at: '2026-07-01T13:00:00.000Z',
              status: 'recorded',
              adherence_state: 'taken',
              decided_by: 'classifier',
            },
            {
              dose_id: 'dose-timeout',
              scheduled_at: '2026-07-02T13:00:00.000Z',
              status: 'missed',
              adherence_state: 'unknown',
              decided_by: 'timeout',
            },
          ],
        },
      ],
    });
    const handler = await freshHandler();
    const res = await handler({ routeKey: 'GET /api/patients' });
    expect(res.statusCode).toBe(200);
    expect(queryMock).toHaveBeenCalledWith(LIST_PATIENTS_SQL, [null, 120, VALID_CLINICIAN_SUB]);
    expect(JSON.parse(res.body)).toEqual({
      patients: [
        expect.objectContaining({
          id: 'patient-a',
          agent_enabled: true,
          provider_opted_in: true,
          consecutive_missed: 3,
          alerting: true,
          consecutive_reported_misses: 3,
          reported_miss_alerting: true,
          adherence_rate: 0.75,
          last_reply_at: '2026-07-02T13:15:00.000Z',
          recent_doses: [
            expect.objectContaining({
              dose_id: 'dose-taken',
              status: 'recorded',
              adherence_state: 'taken',
              decided_by: 'classifier',
            }),
            expect.objectContaining({
              dose_id: 'dose-timeout',
              status: 'missed',
              adherence_state: 'unknown',
              decided_by: 'timeout',
            }),
          ],
        }),
      ],
      alertThreshold: 3,
    });
  });

  it('GET /api/cohort-adherence defaults to a bound 30-day COHORT_ADHERENCE_SQL query', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const handler = await freshHandler();
    const res = await handler({ routeKey: 'GET /api/cohort-adherence' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ series: [] });
    expect(queryMock).toHaveBeenCalledWith(COHORT_ADHERENCE_SQL, [120, 30, VALID_CLINICIAN_SUB]);
  });

  it.each(['7', '30', '90'])(
    'GET /api/cohort-adherence accepts days=%s and binds the validated integer',
    async (days) => {
      queryMock.mockResolvedValueOnce({ rows: [] });
      const handler = await freshHandler();
      const res = await handler({
        routeKey: 'GET /api/cohort-adherence',
        queryStringParameters: { days },
      });

      expect(res.statusCode).toBe(200);
      expect(queryMock).toHaveBeenCalledWith(COHORT_ADHERENCE_SQL, [
        120,
        Number(days),
        VALID_CLINICIAN_SUB,
      ]);
    },
  );

  it.each(['', '07', '7.0', '14', '30 ', ' 30', '91'])(
    'GET /api/cohort-adherence rejects days=%j with 400 before any DB reach',
    async (days) => {
      const handler = await freshHandler();
      const res = await handler({
        routeKey: 'GET /api/cohort-adherence',
        queryStringParameters: { days },
      });

      expect(res.statusCode).toBe(400);
      expect(res.headers).toEqual({ 'content-type': 'application/json' });
      expect(res.body).toBe('{"error":"invalid days"}');
      expect(Pool).not.toHaveBeenCalled();
      expect(queryMock).not.toHaveBeenCalled();
    },
  );

  it('GET /api/reviews/safety → SAFETY_QUEUE_SQL, 200', async () => {
    process.env.SAFETY_SENDING_STUCK_MINUTES = '23';
    process.env.REVIEW_QUEUE_LIMIT = '42';
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'safety-event-id' }] });
    const handler = await freshHandler();
    const res = await handler({ routeKey: 'GET /api/reviews/safety' });
    expect(res.statusCode).toBe(200);
    expect(queryMock).toHaveBeenCalledWith(SAFETY_QUEUE_SQL, [23, 42, VALID_CLINICIAN_SUB]);
    expect(JSON.parse(res.body)).toEqual({
      events: [{ id: 'safety-event-id' }],
      stuckSendingThresholdMinutes: 23,
      limit: 42,
    });
  });

  it('GET /api/reviews/unknown → UNKNOWN_QUEUE_SQL, 200', async () => {
    process.env.REVIEW_QUEUE_LIMIT = '37';
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'unknown-item-id' }] });
    const handler = await freshHandler();
    const res = await handler({ routeKey: 'GET /api/reviews/unknown' });
    expect(res.statusCode).toBe(200);
    expect(queryMock).toHaveBeenCalledWith(UNKNOWN_QUEUE_SQL, [37, VALID_CLINICIAN_SUB]);
    expect(JSON.parse(res.body)).toEqual({
      items: [{ id: 'unknown-item-id' }],
      limit: 37,
    });
  });

  it('GET /api/patients/{id} with a valid uuid → detail + timeline, 200', async () => {
    process.env.ALERT_CONSECUTIVE_MISSED = '3';
    process.env.RESPONSE_WINDOW_MINUTES = '90';
    process.env.PATIENT_TIMELINE_WINDOW_DAYS = '45';
    queryMock.mockImplementation(async (sql: string) => {
      if (sql === PATIENT_DETAIL_SQL) {
        return {
          rows: [
            {
              id: VALID_UUID,
              display_name: 'Detail patient',
              phone: '+15005550006',
              medication_name: 'Metformin',
              is_active: true,
              opted_out_at: null,
            },
          ],
        };
      }
      if (sql === LIST_PATIENTS_SQL) {
        return {
          rows: [
            {
              id: VALID_UUID,
              is_active: true,
              opted_out_at: null,
              consecutive_missed: 4,
            },
          ],
        };
      }
      if (sql === PATIENT_TIMELINE_SQL) {
        return { rows: [{ dose_id: 'dose-1', status: 'missed', decided_by: 'timeout' }] };
      }
      return { rows: [] };
    });

    const handler = await freshHandler();
    const res = await handler({
      routeKey: 'GET /api/patients/{id}',
      pathParameters: { id: VALID_UUID },
    });
    expect(res.statusCode).toBe(200);
    expect(queryMock).toHaveBeenCalledWith(PATIENT_DETAIL_SQL, [VALID_UUID, VALID_CLINICIAN_SUB]);
    expect(queryMock).toHaveBeenCalledWith(LIST_PATIENTS_SQL, [
      VALID_UUID,
      90,
      VALID_CLINICIAN_SUB,
    ]);
    expect(queryMock).toHaveBeenCalledWith(PATIENT_TIMELINE_SQL, [
      VALID_UUID,
      45,
      VALID_CLINICIAN_SUB,
      PATIENT_RECORD_LIMITS.timeline,
    ]);
    expect(JSON.parse(res.body)).toMatchObject({
      patient: {
        id: VALID_UUID,
        consecutive_missed: 4,
        alerting: true,
      },
      alertThreshold: 3,
      timelineWindowDays: 45,
    });
  });

  it('GET /api/patients/{id} runs the independent streak and timeline reads concurrently', async () => {
    let releaseList: ((value: { rows: Array<Record<string, unknown>> }) => void) | undefined;
    let releaseTimeline: ((value: { rows: Array<Record<string, unknown>> }) => void) | undefined;
    const listPending = new Promise<{ rows: Array<Record<string, unknown>> }>((resolve) => {
      releaseList = resolve;
    });
    const timelinePending = new Promise<{ rows: Array<Record<string, unknown>> }>((resolve) => {
      releaseTimeline = resolve;
    });

    queryMock.mockImplementation(async (sql: string) => {
      if (sql === PATIENT_DETAIL_SQL) {
        return {
          rows: [{ id: VALID_UUID, is_active: true, opted_out_at: null }],
        };
      }
      if (sql === LIST_PATIENTS_SQL) return listPending;
      if (sql === PATIENT_TIMELINE_SQL) return timelinePending;
      return { rows: [] };
    });

    const handler = await freshHandler();
    const responsePending = handler({
      routeKey: 'GET /api/patients/{id}',
      pathParameters: { id: VALID_UUID },
    });

    await vi.waitFor(
      () => {
        expect(queryMock).toHaveBeenCalledWith(LIST_PATIENTS_SQL, [
          VALID_UUID,
          120,
          VALID_CLINICIAN_SUB,
        ]);
        expect(queryMock).toHaveBeenCalledWith(PATIENT_TIMELINE_SQL, [
          VALID_UUID,
          30,
          VALID_CLINICIAN_SUB,
          PATIENT_RECORD_LIMITS.timeline,
        ]);
      },
      { timeout: 5_000 },
    );

    releaseList?.({
      rows: [
        {
          id: VALID_UUID,
          is_active: true,
          opted_out_at: null,
          consecutive_missed: 0,
        },
      ],
    });
    releaseTimeline?.({ rows: [] });
    await expect(responsePending).resolves.toMatchObject({ statusCode: 200 });
  });

  it('an unknown routeKey → 404 and NEVER builds the pool', async () => {
    const unknownRoute = `GET /api/nope/${VALID_UUID}`;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = await freshHandler();
    try {
      const res = await handler({ routeKey: unknownRoute });
      expect(res.statusCode).toBe(404);
      expect(Pool).not.toHaveBeenCalled();
      expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual({
        metric: 'data_api_unknown_route',
      });
      expect(String(logSpy.mock.calls[0]?.[0])).not.toContain(VALID_UUID);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('data-api handler — GET /api/patients/{id} zod .parse 400-first gate (D-16, mirrors deactivate)', () => {
  it('a non-UUID id → 400 BEFORE any DB reach (getPool never built)', async () => {
    const handler = await freshHandler();
    const res = await handler({
      routeKey: 'GET /api/patients/{id}',
      pathParameters: { id: 'not-a-uuid' },
    });
    expect(res.statusCode).toBe(400);
    expect(Pool).not.toHaveBeenCalled();
    // The timeline query is never reached — only 0 or the validation short-circuit.
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('a missing id → 400', async () => {
    const handler = await freshHandler();
    const res = await handler({ routeKey: 'GET /api/patients/{id}', pathParameters: {} });
    expect(res.statusCode).toBe(400);
    expect(Pool).not.toHaveBeenCalled();
  });

  it('a valid uuid but no such patient (0 detail rows) → 404, timeline never queried', async () => {
    // The detail query resolves 0 rows → 404 before the timeline query runs.
    queryMock.mockResolvedValueOnce({ rows: [] });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = await freshHandler();
    try {
      const res = await handler({
        routeKey: 'GET /api/patients/{id}',
        pathParameters: { id: VALID_UUID },
      });
      expect(res.statusCode).toBe(404);
      // Exactly ONE query ran (the detail SELECT); the timeline SELECT is skipped on 404.
      expect(queryMock).toHaveBeenCalledTimes(1);
      expect(queryMock).toHaveBeenCalledWith(PATIENT_DETAIL_SQL, [VALID_UUID, VALID_CLINICIAN_SUB]);
      const logs = String(logSpy.mock.calls[0]?.[0]);
      expect(JSON.parse(logs)).toEqual({ metric: 'data_api_patient_not_found' });
      expect(logs).not.toContain(VALID_UUID);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('omits the patient id when the detail exists but its independently scoped alert row is absent', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = await freshHandler();
    try {
      const res = await handler({
        routeKey: 'GET /api/patients/{id}',
        pathParameters: { id: VALID_UUID },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual({
        metric: 'data_api_patient_not_found',
      });
      expect(String(logSpy.mock.calls[0]?.[0])).not.toContain(VALID_UUID);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('data-api handler — GET /api/patients/{id} server-derived alert state (C-8)', () => {
  it.each([
    {
      name: 'active and at threshold',
      row: { is_active: true, opted_out_at: null, consecutive_missed: 3 },
      alerting: true,
      reportedAlerting: false,
    },
    {
      name: 'below threshold',
      row: { is_active: true, opted_out_at: null, consecutive_missed: 2 },
      alerting: false,
      reportedAlerting: false,
    },
    {
      name: 'inactive',
      row: { is_active: false, opted_out_at: null, consecutive_missed: 8 },
      alerting: false,
      reportedAlerting: false,
    },
    {
      name: 'opted out',
      row: { is_active: true, opted_out_at: new Date(), consecutive_missed: 8 },
      alerting: false,
      reportedAlerting: false,
    },
    {
      name: 'reported misses at threshold (silence streak untouched)',
      row: {
        is_active: true,
        opted_out_at: null,
        consecutive_missed: 0,
        consecutive_reported_misses: 3,
      },
      alerting: false,
      reportedAlerting: true,
    },
  ])(
    'returns $name alerting without reimplementing the D5 SQL',
    async ({ row, alerting, reportedAlerting }) => {
      process.env.ALERT_CONSECUTIVE_MISSED = '3';
      queryMock.mockImplementation(async (sql: string) => {
        if (sql === PATIENT_DETAIL_SQL) {
          return { rows: [{ id: VALID_UUID, ...row }] };
        }
        if (sql === LIST_PATIENTS_SQL) {
          return { rows: [{ id: VALID_UUID, ...row }] };
        }
        if (sql === PATIENT_TIMELINE_SQL) {
          return { rows: [] };
        }
        return { rows: [] };
      });

      const handler = await freshHandler();
      const res = await handler({
        routeKey: 'GET /api/patients/{id}',
        pathParameters: { id: VALID_UUID },
      });
      const body = JSON.parse(res.body) as {
        patient: {
          consecutive_missed: number;
          alerting: boolean;
          consecutive_reported_misses: number;
          reported_miss_alerting: boolean;
        };
        alertThreshold: number;
      };

      expect(body.patient.consecutive_missed).toBe(row.consecutive_missed);
      expect(body.patient.alerting).toBe(alerting);
      expect(body.patient.consecutive_reported_misses).toBe(
        'consecutive_reported_misses' in row ? row.consecutive_reported_misses : 0,
      );
      expect(body.patient.reported_miss_alerting).toBe(reportedAlerting);
      expect(body.alertThreshold).toBe(3);
      expect(queryMock).toHaveBeenCalledWith(LIST_PATIENTS_SQL, [
        VALID_UUID,
        120,
        VALID_CLINICIAN_SUB,
      ]);
    },
  );
});

describe('data-api handler — GET /api/patients alerting map (D5 threshold + D14 badge, is_active/opt-out suppression)', () => {
  it('alerting iff is_active && !opted_out && consecutive_missed >= threshold; badges never filter', async () => {
    process.env.ALERT_CONSECUTIVE_MISSED = '3';
    const base = { display_name: 'x', phone: '+1', medication_name: 'm', created_at: new Date() };
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'a',
          ...base,
          is_test: true,
          is_active: true,
          opted_out_at: null,
          consecutive_missed: 3,
        }, // alerting
        {
          id: 'b',
          ...base,
          is_test: false,
          is_active: true,
          opted_out_at: null,
          consecutive_missed: 2,
        }, // below threshold
        {
          id: 'c',
          ...base,
          is_test: false,
          is_active: false,
          opted_out_at: null,
          consecutive_missed: 5,
        }, // inactive → suppressed
        {
          id: 'd',
          ...base,
          is_test: false,
          is_active: true,
          opted_out_at: new Date(),
          consecutive_missed: 5,
        }, // opted-out → suppressed
      ],
    });
    const handler = await freshHandler();
    const res = await handler({ routeKey: 'GET /api/patients' });
    const body = JSON.parse(res.body) as {
      alertThreshold: number;
      patients: Array<{ id: string; is_test: boolean; alerting: boolean }>;
    };
    expect(body.alertThreshold).toBe(3);
    const alertingById = Object.fromEntries(body.patients.map((p) => [p.id, p.alerting]));
    expect(alertingById).toEqual({ a: true, b: false, c: false, d: false });
    // D14 — badge, never filter: BOTH the is_test and non-test rows are present.
    const testById = Object.fromEntries(body.patients.map((p) => [p.id, p.is_test]));
    expect(testById).toEqual({ a: true, b: false, c: false, d: false });
  });
});

describe('data-api handler — reported-miss alert map (separate streak, same suppression rules)', () => {
  it('reported_miss_alerting iff is_active && !opted_out && consecutive_reported_misses >= threshold; streaks never mix', async () => {
    process.env.ALERT_CONSECUTIVE_MISSED = '3';
    const base = {
      display_name: 'x',
      phone: '+1',
      medication_name: 'm',
      created_at: new Date(),
      is_test: false,
      consecutive_missed: 0,
    };
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'a',
          ...base,
          is_active: true,
          opted_out_at: null,
          consecutive_reported_misses: 3,
        }, // at threshold → reported alert
        {
          id: 'b',
          ...base,
          is_active: true,
          opted_out_at: null,
          consecutive_reported_misses: 2,
        }, // below threshold
        {
          id: 'c',
          ...base,
          is_active: false,
          opted_out_at: null,
          consecutive_reported_misses: 5,
        }, // inactive → suppressed
        {
          id: 'd',
          ...base,
          is_active: true,
          opted_out_at: new Date(),
          consecutive_reported_misses: 5,
        }, // opted-out → suppressed
        {
          id: 'e',
          ...base,
          is_active: true,
          opted_out_at: null,
          consecutive_missed: 5,
        }, // silence-only streak, reported field absent → defaults 0/false
      ],
    });
    const handler = await freshHandler();
    const res = await handler({ routeKey: 'GET /api/patients' });
    const body = JSON.parse(res.body) as {
      patients: Array<{
        id: string;
        alerting: boolean;
        consecutive_reported_misses: number;
        reported_miss_alerting: boolean;
      }>;
    };
    const reportedById = Object.fromEntries(
      body.patients.map((p) => [p.id, p.reported_miss_alerting]),
    );
    expect(reportedById).toEqual({ a: true, b: false, c: false, d: false, e: false });
    const byId = Object.fromEntries(body.patients.map((p) => [p.id, p]));
    // The two streaks never mix: a reported run never fires the silence alert and vice versa.
    expect(byId.a?.alerting).toBe(false);
    expect(byId.e?.alerting).toBe(true);
    expect(byId.e?.consecutive_reported_misses).toBe(0);
  });
});

describe('alertThreshold — parse + clamp (D5, default 3, range [1,30])', () => {
  it('defaults to 3 when unset', () => {
    delete process.env.ALERT_CONSECUTIVE_MISSED;
    expect(alertThreshold()).toBe(3);
  });
  it('parses a valid integer', () => {
    process.env.ALERT_CONSECUTIVE_MISSED = '5';
    expect(alertThreshold()).toBe(5);
  });
  it('clamps a below-range value up to 1', () => {
    process.env.ALERT_CONSECUTIVE_MISSED = '0';
    expect(alertThreshold()).toBe(1);
  });
  it('clamps an above-range value down to 30', () => {
    process.env.ALERT_CONSECUTIVE_MISSED = '999';
    expect(alertThreshold()).toBe(30);
  });
  it('falls back to 3 on non-integer garbage', () => {
    process.env.ALERT_CONSECUTIVE_MISSED = 'abc';
    expect(alertThreshold()).toBe(3);
  });
  it('falls back to 3 on a float', () => {
    process.env.ALERT_CONSECUTIVE_MISSED = '2.5';
    expect(alertThreshold()).toBe(3);
  });
});

describe('safetySendingStuckMinutes — parse + clamp (C-10, default 15, range [1,1440])', () => {
  it('defaults to 15 when unset or blank', () => {
    delete process.env.SAFETY_SENDING_STUCK_MINUTES;
    expect(safetySendingStuckMinutes()).toBe(15);
    process.env.SAFETY_SENDING_STUCK_MINUTES = '  ';
    expect(safetySendingStuckMinutes()).toBe(15);
  });

  it('parses a valid integer', () => {
    process.env.SAFETY_SENDING_STUCK_MINUTES = '45';
    expect(safetySendingStuckMinutes()).toBe(45);
  });

  it('clamps valid integers into the safe one-minute to one-day range', () => {
    process.env.SAFETY_SENDING_STUCK_MINUTES = '0';
    expect(safetySendingStuckMinutes()).toBe(1);
    process.env.SAFETY_SENDING_STUCK_MINUTES = '9999';
    expect(safetySendingStuckMinutes()).toBe(1440);
  });

  it('falls back to 15 for non-integers', () => {
    process.env.SAFETY_SENDING_STUCK_MINUTES = 'abc';
    expect(safetySendingStuckMinutes()).toBe(15);
    process.env.SAFETY_SENDING_STUCK_MINUTES = '2.5';
    expect(safetySendingStuckMinutes()).toBe(15);
  });
});

describe('responseWindowMinutes — parse + clamp (D4/D5, default 120, range [1,1440])', () => {
  it('defaults to the timeout scheduling window when unset or blank', () => {
    delete process.env.RESPONSE_WINDOW_MINUTES;
    expect(responseWindowMinutes()).toBe(120);
    process.env.RESPONSE_WINDOW_MINUTES = '  ';
    expect(responseWindowMinutes()).toBe(120);
  });

  it('parses and clamps valid integers', () => {
    process.env.RESPONSE_WINDOW_MINUTES = '180';
    expect(responseWindowMinutes()).toBe(180);
    process.env.RESPONSE_WINDOW_MINUTES = '0';
    expect(responseWindowMinutes()).toBe(1);
    process.env.RESPONSE_WINDOW_MINUTES = '9999';
    expect(responseWindowMinutes()).toBe(1440);
  });

  it('falls back to 120 for non-integers', () => {
    process.env.RESPONSE_WINDOW_MINUTES = 'abc';
    expect(responseWindowMinutes()).toBe(120);
    process.env.RESPONSE_WINDOW_MINUTES = '2.5';
    expect(responseWindowMinutes()).toBe(120);
  });
});

describe('timelineWindowDays — parse + clamp (U18, default 30, range [1,365])', () => {
  it('defaults, parses, clamps, and rejects non-integers', () => {
    expect(timelineWindowDays()).toBe(30);
    process.env.PATIENT_TIMELINE_WINDOW_DAYS = '60';
    expect(timelineWindowDays()).toBe(60);
    process.env.PATIENT_TIMELINE_WINDOW_DAYS = '0';
    expect(timelineWindowDays()).toBe(1);
    process.env.PATIENT_TIMELINE_WINDOW_DAYS = '9999';
    expect(timelineWindowDays()).toBe(365);
    process.env.PATIENT_TIMELINE_WINDOW_DAYS = '2.5';
    expect(timelineWindowDays()).toBe(30);
  });
});

describe('PATIENT_TIMELINE_SQL patient-local calendar contract', () => {
  it('serializes dose_date and uses p.timezone for the fallback and both bounds', () => {
    expect(PATIENT_TIMELINE_SQL).toContain('ds.dose_date::text AS dose_date');
    expect(PATIENT_TIMELINE_SQL).toContain('(ds.scheduled_at AT TIME ZONE p.timezone)::date');
    expect(
      PATIENT_TIMELINE_SQL.match(/\(CURRENT_TIMESTAMP AT TIME ZONE p\.timezone\)::date/g),
    ).toHaveLength(2);
  });
});

describe('reviewQueueLimit — parse + clamp (U18, default 100, range [1,500])', () => {
  it('defaults, parses, clamps, and rejects non-integers', () => {
    expect(reviewQueueLimit()).toBe(100);
    process.env.REVIEW_QUEUE_LIMIT = '75';
    expect(reviewQueueLimit()).toBe(75);
    process.env.REVIEW_QUEUE_LIMIT = '0';
    expect(reviewQueueLimit()).toBe(1);
    process.env.REVIEW_QUEUE_LIMIT = '9999';
    expect(reviewQueueLimit()).toBe(500);
    process.env.REVIEW_QUEUE_LIMIT = 'abc';
    expect(reviewQueueLimit()).toBe(100);
  });
});

describe('SAFETY_QUEUE_SQL — nullable legacy send status stays in the non-urgent tier', () => {
  it('coalesces nullable status predicates and orders by the total is_urgent boolean', () => {
    expect(SAFETY_QUEUE_SQL).toMatch(/COALESCE\(se\.auto_reply_status = 'sending', false\)/);
    expect(SAFETY_QUEUE_SQL).toMatch(
      /COALESCE\(auto_reply_status IN \('failed', 'suppressed'\), false\)/,
    );
    expect(SAFETY_QUEUE_SQL).toMatch(
      /ORDER BY is_urgent DESC,\s+\(flag_category IN \('crisis', 'acute_physical'\)\) DESC/,
    );
    expect(SAFETY_QUEUE_SQL).toMatch(/LIMIT \$2::int/);
  });
});

describe('data-api handler — 08-06 selected-day record reads', () => {
  const patientRecordRow = {
    id: VALID_UUID,
    display_name: 'Patient',
    phone: '+15005550006',
    medication_name: 'metformin',
    timezone: 'America/Toronto',
    is_test: true,
    is_active: true,
    opted_out_at: null,
    created_at: new Date('2026-08-12T00:00:00.000Z'),
    drug_profile_json: null,
    drug_profile_fetched_at: null,
    preferred_language: 'en',
    reminder_limit: 2,
    agent_enabled: true,
    provider_opted_in: true,
    messaging_state_version: 1,
    from_date: '2026-07-14',
    today: '2026-08-12',
    selected_day: '2026-08-12',
    selected_day_in_window: true,
  };

  function mockEmptyRecord(): void {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql === PATIENT_RECORD_SCOPE_SQL) return { rows: [patientRecordRow], rowCount: 1 };
      if (sql === LIST_PATIENTS_SQL) {
        return {
          rows: [{ is_active: true, opted_out_at: null, consecutive_missed: 0 }],
          rowCount: 1,
        };
      }
      if (sql.includes('SELECT 1 FROM patient WHERE id = $1 AND owner_clinician_sub = $2')) {
        return { rows: [{ exists: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  }

  it('returns the strict selected-day envelope and binds the requested 90-day window', async () => {
    mockEmptyRecord();
    const handler = await freshHandler();
    const response = await handler({
      routeKey: 'GET /api/patients/{id}/record',
      pathParameters: { id: VALID_UUID },
      queryStringParameters: {
        days: '90',
        day: '2026-08-12',
        alertsLimit: '25',
        draftsLimit: '10',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      window: { days: 90, selectedDay: '2026-08-12' },
      timelineWindowDays: 90,
      daySummary: null,
      messages: [],
      events: [],
      evidence: [],
      versions: [],
      alertsPage: { items: [], cursor: null, nextCursor: null, limit: 25 },
      draftsPage: { items: [], cursor: null, nextCursor: null, limit: 10 },
      history: { medications: [], facts: [] },
    });
    expect(queryMock).toHaveBeenCalledWith(PATIENT_DAY_INDEX_SQL, [
      VALID_UUID,
      VALID_CLINICIAN_SUB,
      90,
      '2026-08-12',
      PATIENT_RECORD_LIMITS.dayIndex,
    ]);
    expect(queryMock).toHaveBeenCalledWith(PATIENT_TIMELINE_SQL, [
      VALID_UUID,
      90,
      VALID_CLINICIAN_SUB,
      PATIENT_RECORD_LIMITS.timeline,
    ]);
  });

  it.each([
    { days: '14' },
    { day: '2026-02-30' },
    { alertsLimit: '0' },
    { draftsCursor: 'not-base64url!' },
  ])('rejects invalid record query %# before any DB reach', async (queryStringParameters) => {
    const handler = await freshHandler();
    const response = await handler({
      routeKey: 'GET /api/patients/{id}/record',
      pathParameters: { id: VALID_UUID },
      queryStringParameters,
    });
    expect(response.statusCode).toBe(400);
    expect(Pool).not.toHaveBeenCalled();
  });

  it('returns 404 for an unowned record and 400 for a selected day outside the window', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const firstHandler = await freshHandler();
    const notFound = await firstHandler({
      routeKey: 'GET /api/patients/{id}/record',
      pathParameters: { id: VALID_UUID },
    });
    expect(notFound.statusCode).toBe(404);

    queryMock.mockResolvedValueOnce({
      rows: [{ ...patientRecordRow, selected_day_in_window: false }],
      rowCount: 1,
    });
    const secondHandler = await freshHandler();
    const badDay = await secondHandler({
      routeKey: 'GET /api/patients/{id}/record',
      pathParameters: { id: VALID_UUID },
      queryStringParameters: { days: '7', day: '2026-01-01' },
    });
    expect(badDay.statusCode).toBe(400);
  });
});

describe('data-api handler — 08-06 owner-scoped cursor queues', () => {
  it('dispatches independent bounded alert and draft pages', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const alertHandler = await freshHandler();
    const alerts = await alertHandler({
      routeKey: 'GET /api/reviews/alerts',
      queryStringParameters: { limit: '25' },
    });
    expect(alerts.statusCode).toBe(200);
    expect(JSON.parse(alerts.body)).toEqual({
      alertsPage: { items: [], cursor: null, nextCursor: null, limit: 25 },
    });
    expect(queryMock).toHaveBeenCalledWith(ALERT_QUEUE_SQL, [
      VALID_CLINICIAN_SUB,
      null,
      null,
      null,
      26,
    ]);

    vi.clearAllMocks();
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const draftHandler = await freshHandler();
    const drafts = await draftHandler({
      routeKey: 'GET /api/reviews/drafts',
      queryStringParameters: { limit: '10' },
    });
    expect(drafts.statusCode).toBe(200);
    expect(JSON.parse(drafts.body)).toEqual({
      draftsPage: { items: [], cursor: null, nextCursor: null, limit: 10 },
    });
    expect(queryMock).toHaveBeenCalledWith(DRAFT_QUEUE_SQL, [
      VALID_CLINICIAN_SUB,
      null,
      null,
      null,
      11,
    ]);
  });

  it('rejects invalid cursor/limit before constructing the pool', async () => {
    const handler = await freshHandler();
    const response = await handler({
      routeKey: 'GET /api/reviews/alerts',
      queryStringParameters: { cursor: 'bad!', limit: '101' },
    });
    expect(response.statusCode).toBe(400);
    expect(Pool).not.toHaveBeenCalled();
  });
});
