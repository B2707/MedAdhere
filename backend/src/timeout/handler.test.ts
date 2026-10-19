/**
 * handler.test.ts — network-free unit test of the Timeout Lambda handler (Plan 05-01 / PIPE-05 / SC1).
 *
 * NO real AWS, NO real DB, NO Docker, NO credentials. `pg` and `@aws-sdk/client-secrets-manager` are
 * fully mocked so the test drives the delivery-gated, wipe-safe idempotent `missed` write in isolation
 * and pins the SQL CONTRACT (the real-PG SEMANTICS are proven in write-contract.test.ts, testcontainers):
 *   - validates the Scheduler payload { patientId, doseId } (throws + never builds the pool on a bad one);
 *   - the INSERT derives patient_id AUTHORITATIVELY from dose_schedule (M4 — never the event's patientId),
 *     gates on check-in delivery via EXISTS outbound_message.status NOT IN ('undelivered','failed')
 *     (H5), rechecks active/provider/agent messaging state, and is
 *     idempotent via ON CONFLICT (dose_id) DO NOTHING (Q1 row = {unknown,none,none,timeout,missed});
 *   - rowCount 1 → `timeout_recorded`; rowCount 0 → `timeout_noop`; SUCCESS on both paths;
 *   - identifier-free logs (the timeout path never logs patient/dose ids, phone, or body);
 *   - M3 (M-2 TLS): the pg.Pool ctor args carry ssl.rejectUnauthorized===true + a non-empty ssl.ca + max 2.
 *
 * Mirrors outbound/handler.test.ts (pg + SM mock, module-scoped-pool-reuse + M3), minus Twilio/SSM (the
 * timeout write touches neither).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, endMock, smSend, poolArgs } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  endMock: vi.fn(),
  smSend: vi.fn(),
  // M3 — captures the `new Pool({...})` constructor args so the test asserts the CA-pinning TLS config.
  poolArgs: [] as Array<Record<string, unknown>>,
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

import { Pool } from 'pg';

/** Re-import the handler with a fresh module registry so the module-scoped `pool` starts undefined. */
async function freshHandler() {
  vi.resetModules();
  const mod = await import('./handler.js');
  return mod.handler;
}

const DB_SECRET = JSON.stringify({ username: 'medadhere_admin', password: 'pw' });
// Real 36-char UUIDs (Phase-3 HIGH-3 lesson — never short fake ids).
const PATIENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const DOSE_ID = '9b2e6679-4f89-42de-963d-02d4f4a986aa';

let logSpy: ReturnType<typeof vi.spyOn>;

function allLogLines(): string[] {
  return (logSpy.mock.calls as unknown[][]).map((c) => c.map(String).join(' '));
}

function findQuery(re: RegExp): [string, unknown[]] | undefined {
  return (queryMock.mock.calls as Array<[string, unknown[]]>).find((c) => re.test(String(c[0])));
}

/** Wire the default mocks: SM returns the DB secret; the INSERT affects `insertRowCount` rows. */
function wireDefaults(insertRowCount = 1) {
  smSend.mockResolvedValue({ SecretString: DB_SECRET });
  queryMock.mockImplementation((sql: string) => {
    if (/INSERT INTO adherence_record/i.test(sql)) {
      return Promise.resolve({ rowCount: insertRowCount, rows: [] });
    }
    return Promise.resolve({ rowCount: 0, rows: [] });
  });
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

describe('timeout handler — delivery-gated, wipe-safe idempotent missed write (PIPE-05 / SC1)', () => {
  it('writes exactly one INSERT deriving patient_id from dose_schedule (M4) — never the event patientId', async () => {
    const handler = await freshHandler();
    await handler({ patientId: PATIENT_ID, doseId: DOSE_ID });

    const insert = findQuery(/INSERT INTO adherence_record/i);
    expect(insert).toBeDefined();
    const [sql, params] = insert!;
    // M4 — patient_id + dose come from a SELECT over dose_schedule (authoritative), keyed by dose id.
    expect(sql).toMatch(/SELECT\s+ds\.patient_id/i);
    expect(sql).toMatch(/(?:FROM|JOIN)\s+dose_schedule\s+ds/i);
    expect(sql).toMatch(/WHERE\s+ds\.id\s*=\s*\$1/i);
    // The ONLY bound parameter is the dose id — the event's patientId is NEVER trusted into the write.
    expect(params).toEqual([DOSE_ID]);
  });

  it('H5 — gates the write on delivery: EXISTS outbound_message.status NOT IN (undelivered, failed)', async () => {
    const handler = await freshHandler();
    await handler({ patientId: PATIENT_ID, doseId: DOSE_ID });
    const [sql] = findQuery(/INSERT INTO adherence_record/i)!;
    expect(sql).toMatch(/EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+outbound_message/i);
    expect(sql).toMatch(/message_kind\s*=\s*'check_in'/i);
    expect(sql).toMatch(/status\s+NOT\s+IN\s*\(\s*'undelivered'\s*,\s*'failed'\s*\)/i);
  });

  it('U-2/H1 — locks the active consent row before deciding timeout eligibility', async () => {
    const handler = await freshHandler();
    await handler({ patientId: PATIENT_ID, doseId: DOSE_ID });
    const [sql] = findQuery(/INSERT INTO adherence_record/i)!;
    // Serialize with STOP/deactivate before reading consent, then keep the single-statement write.
    expect(sql).toMatch(/WITH\s+eligible_patient\s+AS\s+MATERIALIZED/i);
    expect(sql).toMatch(/FROM\s+patient\s+p/i);
    expect(sql).toMatch(/is_active\s*=\s*true/i);
    expect(sql).toMatch(/provider_opted_in\s*=\s*true/i);
    expect(sql).toMatch(/agent_enabled\s*=\s*true/i);
    expect(sql).toMatch(/FOR\s+NO\s+KEY\s+UPDATE\s+OF\s+p/i);
  });

  it('a STOP committed after send/schedule creation still makes the timeout a no-op', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (!/INSERT INTO adherence_record/i.test(sql)) {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      const rechecksCompleteMessagingState =
        /p\.is_active\s*=\s*true/i.test(sql) &&
        /p\.provider_opted_in\s*=\s*true/i.test(sql) &&
        /p\.agent_enabled\s*=\s*true/i.test(sql);
      // Model STOP as already committed at this write boundary: only the complete state predicate no-ops.
      return Promise.resolve({ rowCount: rechecksCompleteMessagingState ? 0 : 1, rows: [] });
    });
    const handler = await freshHandler();

    await expect(handler({ patientId: PATIENT_ID, doseId: DOSE_ID })).resolves.toEqual({
      recorded: false,
    });
  });

  it('an undelivered check-in is not masked by a delivered reminder for the same dose', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (!/INSERT INTO adherence_record/i.test(sql)) {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      const gatesOnCheckIn = /om\.message_kind\s*=\s*'check_in'/i.test(sql);
      // Model check_in=undelivered plus reminder=delivered: a kind-scoped delivery gate returns no row.
      return Promise.resolve({ rowCount: gatesOnCheckIn ? 0 : 1, rows: [] });
    });
    const handler = await freshHandler();

    await expect(handler({ patientId: PATIENT_ID, doseId: DOSE_ID })).resolves.toEqual({
      recorded: false,
    });
  });

  it('Q1 — writes the {unknown, none, none, timeout, missed} row shape, NULL inbound_message_id', async () => {
    const handler = await freshHandler();
    await handler({ patientId: PATIENT_ID, doseId: DOSE_ID });
    const [sql] = findQuery(/INSERT INTO adherence_record/i)!;
    // The SELECT projects the fixed timeout row literals (state unknown, no reason, no safety flag,
    // decided_by timeout, status missed, NULL inbound reply — no reply exists on a timeout).
    expect(sql).toMatch(/'unknown'/);
    expect(sql).toMatch(/'timeout'/);
    expect(sql).toMatch(/'missed'/);
    expect(sql).toMatch(/NULL/);
  });

  it('is idempotent via ON CONFLICT (dose_id) DO NOTHING — a prior row (classifier or replay) wins', async () => {
    const handler = await freshHandler();
    await handler({ patientId: PATIENT_ID, doseId: DOSE_ID });
    const [sql] = findQuery(/INSERT INTO adherence_record/i)!;
    expect(sql).toMatch(/ON CONFLICT\s*\(\s*dose_id\s*\)\s*DO\s+NOTHING/i);
    // Exactly ONE arbiter — never a second ON CONFLICT.
    expect(sql.match(/ON CONFLICT/gi)).toHaveLength(1);
  });

  it('rowCount 1 → logs identifier-free timeout_recorded and RESOLVES success', async () => {
    wireDefaults(1);
    const handler = await freshHandler();
    await expect(handler({ patientId: PATIENT_ID, doseId: DOSE_ID })).resolves.toBeDefined();
    const line = allLogLines().find((l) => /timeout_recorded/.test(l));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toEqual({ metric: 'timeout_recorded' });
    expect(line).not.toContain(PATIENT_ID);
    expect(line).not.toContain(DOSE_ID);
  });

  it('rowCount 0 (no delivered send / wiped dose / prior row) → logs timeout_noop and RESOLVES success', async () => {
    wireDefaults(0);
    const handler = await freshHandler();
    await expect(handler({ patientId: PATIENT_ID, doseId: DOSE_ID })).resolves.toBeDefined();
    const line = allLogLines().find((l) => /timeout_noop/.test(l));
    expect(line).toBeDefined();
    expect(allLogLines().some((l) => /timeout_recorded/.test(l))).toBe(false);
  });
});

describe('timeout handler — M3: verifies the RDS server cert against the pinned CA bundle (M-2)', () => {
  it('constructs the pg.Pool with ssl.rejectUnauthorized:true, a non-empty ssl.ca, and max 2', async () => {
    const handler = await freshHandler();
    await handler({ patientId: PATIENT_ID, doseId: DOSE_ID });
    expect(poolArgs).toHaveLength(1);
    const ssl = poolArgs[0]?.ssl as { ca?: unknown; rejectUnauthorized?: unknown } | undefined;
    expect(ssl?.rejectUnauthorized).toBe(true);
    expect(typeof ssl?.ca).toBe('string');
    expect((ssl?.ca as string).length).toBeGreaterThan(0);
    expect(poolArgs[0]?.max).toBe(2);
  });
});

describe('timeout handler — payload / env guards', () => {
  it('throws when the Scheduler payload lacks patientId/doseId, without building the pool', async () => {
    const handler = await freshHandler();
    await expect(handler({ patientId: '', doseId: '' } as never)).rejects.toThrow(
      /patientId, doseId/,
    );
    expect(Pool).not.toHaveBeenCalled();
  });
});
