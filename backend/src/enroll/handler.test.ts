/**
 * handler.test.ts — network-free unit test of the Enroll Lambda handler's PURE logic
 * (PIPE-01 / PIPE-08 / PIPE-09 / SC2 / MED-6).
 *
 * NO real AWS, NO real DB, NO Docker, NO credentials. `pg`, `@aws-sdk/client-secrets-manager`, and
 * `@aws-sdk/client-scheduler` are fully mocked (the repo's `vi.hoisted` + `vi.mock` factory style — the
 * same hermetic posture as data-api/handler.test.ts and outbound/handler.test.ts; aws-sdk-client-mock is
 * deliberately NOT a dependency so the install surface stays minimal). The test drives the
 * patient-insert → dose-insert → per-dose CreateSchedule flow in isolation and asserts:
 *
 *   1. writes + schedules: ONE patient row (with medication_name — PIPE-08) + N dose_schedule rows +
 *      N CreateScheduleCommand calls, each Name='dose-{patientId}-{doseId}', GroupName='medadhere-prod',
 *      ScheduleExpressionTimezone=patient.timezone, FlexibleTimeWindow Mode 'OFF',
 *      ActionAfterCompletion 'DELETE', Target.Arn=OUTBOUND_FN_ARN, Target.RoleArn=SCHEDULER_TARGET_ROLE_ARN,
 *      Input=JSON {patientId, doseId}.
 *   2. PIPE-09 stored instant: dose_schedule.scheduled_at = the DST-correct UTC (summer 09:00 Toronto →
 *      13:00Z, winter → 14:00Z); schedule_timezone/dose_date/local_dose_time persisted.
 *   3. offset-less assertion: the ScheduleExpression has NO Z/offset suffix and the tz param equals the
 *      patient timezone (Pitfall 3 — no double DST conversion).
 *   4. CA pinning (M3): pg.Pool constructed with ssl.ca (non-empty PEM) + ssl.rejectUnauthorized:true.
 *   5. deactivation: deactivateSchedules(patientId) paginates ListSchedules(GroupName='medadhere-prod',
 *      NamePrefix='dose-{patientId}') across NextToken pages and DeleteSchedule for every returned schedule.
 *   6. MED-6 partial-failure compensation: when the K+1-th CreateSchedule rejects, the handler deletes the
 *      K already-created schedules AND rolls back the patient+dose rows (ROLLBACK) AND surfaces the failure
 *      (does NOT return success).
 *   7. parameterized SQL: all patient/dose writes use $1,$2 placeholders (no interpolation).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.mock` is hoisted above all top-level statements, so the spies the factories close over must be
// created in `vi.hoisted` (also hoisted). The handler constructs `new SecretsManagerClient({})` and
// `new SchedulerClient({})` at import time, so those factory constructors must be `new`-able real
// `function`s. The pg.Pool ctor captures its args (M3) and counts invocations (module-scoped reuse).
const {
  queryMock,
  endMock,
  connectMock,
  clientQueryMock,
  clientReleaseMock,
  smSend,
  schedulerSend,
  poolArgs,
} = vi.hoisted(() => {
  const clientQueryMock = vi.fn();
  const clientReleaseMock = vi.fn();
  return {
    queryMock: vi.fn(),
    endMock: vi.fn(),
    clientQueryMock,
    clientReleaseMock,
    // pool.connect() yields a dedicated client for the BEGIN/…/COMMIT transaction (MED-6).
    connectMock: vi.fn(async () => ({
      query: clientQueryMock,
      release: clientReleaseMock,
    })),
    smSend: vi.fn(),
    schedulerSend: vi.fn(),
    // M3 — captures the `new Pool({...})` constructor args so the test asserts CA-pinning TLS config.
    poolArgs: [] as Array<Record<string, unknown>>,
  };
});

vi.mock('pg', () => ({
  Pool: vi.fn(function (config: Record<string, unknown>) {
    poolArgs.push(config);
    return { query: queryMock, end: endMock, connect: connectMock };
  }),
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn(function () {
    return { send: smSend };
  }),
  GetSecretValueCommand: vi.fn(function (args: unknown) {
    return { __type: 'GetSecretValue', ...((args as object) ?? {}) };
  }),
}));

// The scheduler command mocks tag each command with a discriminant + its input so the test can read
// exactly what the handler passed (Name / GroupName / ScheduleExpression / tz / Target / NextToken).
vi.mock('@aws-sdk/client-scheduler', () => ({
  SchedulerClient: vi.fn(function () {
    return { send: schedulerSend };
  }),
  CreateScheduleCommand: vi.fn(function (input: unknown) {
    return { __type: 'CreateSchedule', input };
  }),
  DeleteScheduleCommand: vi.fn(function (input: unknown) {
    return { __type: 'DeleteSchedule', input };
  }),
  ListSchedulesCommand: vi.fn(function (input: unknown) {
    return { __type: 'ListSchedules', input };
  }),
}));

import { Pool } from 'pg';

/** Re-import the handler with a fresh module registry so the module-scoped `pool` starts undefined. */
async function freshModule() {
  vi.resetModules();
  return import('./handler.js');
}

const DB_SECRET = JSON.stringify({ username: 'medadhere_admin', password: 'pw' });
const OWNER_SUB = '9d2c9a43-1f08-4fac-b1dd-b41fd85bcdd4';

/** Type the create-schedule commands the test inspects. */
interface SchedulerCommand {
  __type: string;
  input: Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  poolArgs.length = 0;

  // Secrets Manager → a well-formed DB credential.
  smSend.mockResolvedValue({ SecretString: DB_SECRET });

  // Default scheduler send: every command resolves. ListSchedules returns one empty page.
  schedulerSend.mockImplementation(async (cmd: SchedulerCommand) => {
    if (cmd.__type === 'ListSchedules') return { Schedules: [], NextToken: undefined };
    return {};
  });

  // Default pool.query (non-transactional reads, if any) resolves empty.
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });

  // Transaction client: INSERT patient RETURNING id → a fixed uuid; INSERT dose RETURNING id → ids.
  let doseSeq = 0;
  clientQueryMock.mockImplementation(async (text: string) => {
    if (/INSERT INTO patient/i.test(text)) {
      return { rows: [{ id: 'patient-uuid-1' }], rowCount: 1 };
    }
    if (/INSERT INTO dose_schedule/i.test(text)) {
      doseSeq += 1;
      return { rows: [{ id: `dose-uuid-${doseSeq}` }], rowCount: 1 };
    }
    // BEGIN / COMMIT / ROLLBACK and anything else.
    return { rows: [], rowCount: 0 };
  });
  clientReleaseMock.mockReset();
  connectMock.mockClear();

  process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:db';
  process.env.DB_HOST = 'db.internal';
  process.env.DB_PORT = '5432';
  process.env.DB_NAME = 'medadhere';
  process.env.OUTBOUND_FN_ARN = 'arn:aws:lambda:us-east-1:000000000000:function:Outbound';
  process.env.SCHEDULER_TARGET_ROLE_ARN = 'arn:aws:iam::000000000000:role/SchedulerTargetRole';
});

/** A summer (EDT) single-dose enrollment payload — 09:00 America/Toronto → 13:00Z. */
const SUMMER_PAYLOAD = {
  owner_clinician_sub: OWNER_SUB,
  phone: '+15145550123',
  medication_name: 'Metformin',
  display_name: 'Alex',
  timezone: 'America/Toronto',
  startDate: '2026-08-15',
  days: 1,
  localTimes: ['09:00'],
};

/** A two-dose (two-day) enrollment payload to exercise multi-schedule + partial-failure. */
const TWO_DOSE_PAYLOAD = {
  owner_clinician_sub: OWNER_SUB,
  phone: '+15145550123',
  medication_name: 'Metformin',
  display_name: 'Alex',
  timezone: 'America/Toronto',
  startDate: '2026-08-15',
  days: 2,
  localTimes: ['09:00'],
};

function createCommands(): SchedulerCommand[] {
  return (schedulerSend.mock.calls as Array<[SchedulerCommand]>)
    .map((c) => c[0])
    .filter((c) => c.__type === 'CreateSchedule');
}
function deleteCommands(): SchedulerCommand[] {
  return (schedulerSend.mock.calls as Array<[SchedulerCommand]>)
    .map((c) => c[0])
    .filter((c) => c.__type === 'DeleteSchedule');
}
function listCommands(): SchedulerCommand[] {
  return (schedulerSend.mock.calls as Array<[SchedulerCommand]>)
    .map((c) => c[0])
    .filter((c) => c.__type === 'ListSchedules');
}

describe('enroll handler — writes patient + dose rows + per-dose CreateSchedule (PIPE-01/08, SC2)', () => {
  it('inserts ONE patient (with medication_name — PIPE-08) + N dose rows + N CreateSchedule calls', async () => {
    const { handler } = await freshModule();
    const res = await handler(TWO_DOSE_PAYLOAD);

    expect(res.enrolled).toBe(true);
    expect(res.patientId).toBe('patient-uuid-1');
    expect(res.doseCount).toBe(2);

    // PIPE-08 — the patient INSERT carries medication_name as a parameter.
    const patientInsert = (clientQueryMock.mock.calls as Array<[string, unknown[]?]>).find((c) =>
      /INSERT INTO patient/i.test(c[0]),
    );
    expect(patientInsert).toBeDefined();
    expect(patientInsert![0]).toMatch(/owner_clinician_sub/i);
    expect(patientInsert![1]).toContain(OWNER_SUB);
    expect(patientInsert![1]).toContain('Metformin');
    expect(patientInsert![1]).toContain('America/Toronto');

    // N dose_schedule INSERTs.
    const doseInserts = (clientQueryMock.mock.calls as Array<[string, unknown[]?]>).filter((c) =>
      /INSERT INTO dose_schedule/i.test(c[0]),
    );
    expect(doseInserts).toHaveLength(2);

    // N CreateScheduleCommand calls, each correctly shaped.
    const creates = createCommands();
    expect(creates).toHaveLength(2);
    for (const cmd of creates) {
      expect(String(cmd.input.Name)).toMatch(/^dose-patient-uuid-1-dose-uuid-\d+$/);
      expect(cmd.input.GroupName).toBe('medadhere-prod');
      expect(cmd.input.ScheduleExpressionTimezone).toBe('America/Toronto');
      expect(cmd.input.FlexibleTimeWindow).toEqual({ Mode: 'OFF' });
      expect(cmd.input.ActionAfterCompletion).toBe('DELETE');
      const target = cmd.input.Target as { Arn: string; RoleArn: string; Input: string };
      expect(target.Arn).toBe(process.env.OUTBOUND_FN_ARN);
      expect(target.RoleArn).toBe(process.env.SCHEDULER_TARGET_ROLE_ARN);
      const payload = JSON.parse(target.Input) as { patientId: string; doseId: string };
      expect(payload.patientId).toBe('patient-uuid-1');
      expect(payload.doseId).toMatch(/^dose-uuid-\d+$/);
    }
  });
});

describe('enroll handler — clinician ownership is required internally', () => {
  it.each([undefined, '', 'not-a-uuid'])(
    'rejects owner_clinician_sub=%s before opening the database',
    async (owner) => {
      const { handler } = await freshModule();

      await expect(
        handler({ ...SUMMER_PAYLOAD, owner_clinician_sub: owner } as never),
      ).rejects.toThrow(/owner_clinician_sub|clinician owner/i);
      expect(connectMock).not.toHaveBeenCalled();
      expect(schedulerSend).not.toHaveBeenCalled();
    },
  );
});

describe('enroll handler — HIGH-3: schedule Name respects the 64-char EventBridge cap with REAL UUIDs', () => {
  it('truncates dose-{patientId}-{doseId} to <=64 chars while preserving the dose-{patientId} NamePrefix', async () => {
    // Real 36-char UUIDs (not the short mocks the other tests use), so `dose-{patientId}-{doseId}` is 78
    // chars > the EventBridge 64-char Name cap — the exact class of bug the live smoke caught (the short
    // mocks never exercise the `.slice(0, 64)` truncation, so removing it would keep them green).
    const PATIENT_UUID = '6b6f55a0-64e5-47a3-8f5c-e34795ac440b'; // 36 chars
    const DOSE_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'; // 36 chars
    clientQueryMock.mockImplementation(async (text: string) => {
      if (/INSERT INTO patient/i.test(text)) {
        return { rows: [{ id: PATIENT_UUID }], rowCount: 1 };
      }
      if (/INSERT INTO dose_schedule/i.test(text)) {
        return { rows: [{ id: DOSE_UUID }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const { handler } = await freshModule();
    await handler(SUMMER_PAYLOAD); // single dose

    const create = createCommands()[0]!;
    const name = String(create.input.Name);
    // The untruncated name would be 78 chars; the handler MUST cap it at 64.
    expect(`dose-${PATIENT_UUID}-${DOSE_UUID}`.length).toBe(78);
    expect(name.length).toBeLessThanOrEqual(64);
    // The dose-{patientId} prefix (41 chars) MUST survive so NamePrefix-based deactivation/compensation
    // (deactivateSchedules → ListSchedules NamePrefix='dose-{patientId}') still matches this schedule.
    expect(name.startsWith(`dose-${PATIENT_UUID}`)).toBe(true);
    // And the FULL doseId still travels in the Target Input — the fire is unaffected by the name cap.
    const target = create.input.Target as { Input: string };
    const payload = JSON.parse(target.Input) as { patientId: string; doseId: string };
    expect(payload.patientId).toBe(PATIENT_UUID);
    expect(payload.doseId).toBe(DOSE_UUID);
  });
});

describe('enroll handler — PIPE-09 stored instant is DST-correct (SC5)', () => {
  it('stores scheduled_at = 13:00Z for a summer (EDT) 09:00 America/Toronto dose', async () => {
    const { handler } = await freshModule();
    await handler(SUMMER_PAYLOAD);
    const doseInsert = (clientQueryMock.mock.calls as Array<[string, unknown[]?]>).find((c) =>
      /INSERT INTO dose_schedule/i.test(c[0]),
    );
    expect(doseInsert).toBeDefined();
    const params = doseInsert![1] as unknown[];
    // scheduled_at (an ISO UTC instant) appears among the parameters and resolves to 13:00Z.
    const scheduledAt = params.find(
      (p) => typeof p === 'string' && /^2026-08-15T13:00:00\.000Z$/.test(p),
    );
    expect(scheduledAt).toBeDefined();
    // schedule_timezone + dose_date + local_dose_time are persisted.
    expect(params).toContain('America/Toronto');
    expect(params).toContain('2026-08-15');
    expect(params).toContain('09:00');
  });

  it('stores scheduled_at = 14:00Z for a winter (EST) 09:00 America/Toronto dose', async () => {
    const { handler } = await freshModule();
    await handler({ ...SUMMER_PAYLOAD, startDate: '2026-01-15' });
    const doseInsert = (clientQueryMock.mock.calls as Array<[string, unknown[]?]>).find((c) =>
      /INSERT INTO dose_schedule/i.test(c[0]),
    );
    const params = doseInsert![1] as unknown[];
    const scheduledAt = params.find(
      (p) => typeof p === 'string' && /^2026-01-15T14:00:00\.000Z$/.test(p),
    );
    expect(scheduledAt).toBeDefined();
  });
});

describe('enroll handler — offset-less ScheduleExpression (Pitfall 3 — AWS owns DST)', () => {
  it('passes an at() expression with NO Z/offset suffix and the tz param = patient timezone', async () => {
    const { handler } = await freshModule();
    await handler(SUMMER_PAYLOAD);
    const create = createCommands()[0]!;
    const expr = String(create.input.ScheduleExpression);
    // The expression is offset-less local wall-clock: at(2026-08-15T09:00:00).
    expect(expr).toBe('at(2026-08-15T09:00:00)');
    // No Z and no numeric offset (+hh:mm / -hh:mm) — double-DST guard.
    expect(expr).not.toMatch(/Z\)/);
    expect(expr).not.toMatch(/[+-]\d{2}:\d{2}/);
    // The tz is carried separately so AWS resolves DST.
    expect(create.input.ScheduleExpressionTimezone).toBe('America/Toronto');
  });
});

describe('enroll handler — M3: CA-pinned TLS (M-2)', () => {
  it('constructs the pg.Pool with ssl.rejectUnauthorized:true AND a non-empty ssl.ca', async () => {
    const { handler } = await freshModule();
    await handler(SUMMER_PAYLOAD);
    expect(poolArgs.length).toBeGreaterThanOrEqual(1);
    const ssl = poolArgs[0]?.ssl as { ca?: unknown; rejectUnauthorized?: unknown } | undefined;
    expect(ssl).toBeDefined();
    expect(ssl?.rejectUnauthorized).toBe(true);
    expect(typeof ssl?.ca).toBe('string');
    expect((ssl?.ca as string).length).toBeGreaterThan(0);
  });

  it('builds the module-scoped pool exactly ONCE across two enrollments (D-11)', async () => {
    const { handler } = await freshModule();
    await handler(SUMMER_PAYLOAD);
    await handler(SUMMER_PAYLOAD);
    expect(Pool).toHaveBeenCalledTimes(1);
  });
});

describe('enroll handler — deactivation helper (OPS-01/STUDY-05)', () => {
  it('paginates ListSchedules across NextToken pages and DeleteSchedule for every returned schedule', async () => {
    const { deactivateSchedules } = await freshModule();
    // Two pages: page 1 has two schedules + a NextToken, page 2 has one + no token.
    schedulerSend.mockImplementation(async (cmd: SchedulerCommand) => {
      if (cmd.__type === 'ListSchedules') {
        const token = (cmd.input as { NextToken?: string }).NextToken;
        if (!token) {
          return {
            Schedules: [{ Name: 'dose-p1-a' }, { Name: 'dose-p1-b' }],
            NextToken: 'page2',
          };
        }
        return { Schedules: [{ Name: 'dose-p1-c' }], NextToken: undefined };
      }
      return {};
    });

    await deactivateSchedules('p1');

    // Both list pages were requested with the scoped group + name prefix.
    const lists = listCommands();
    expect(lists).toHaveLength(2);
    for (const l of lists) {
      expect(l.input.GroupName).toBe('medadhere-prod');
      // Phase-4 contract (04-01 item 3): trailing-dash NamePrefix (42 chars with a real UUID).
      expect(l.input.NamePrefix).toBe('dose-p1-');
    }
    expect((lists[1]!.input as { NextToken?: string }).NextToken).toBe('page2');

    // Every returned schedule was deleted by name, in the scoped group.
    const deletes = deleteCommands();
    expect(deletes.map((d) => d.input.Name).sort()).toEqual([
      'dose-p1-a',
      'dose-p1-b',
      'dose-p1-c',
    ]);
    for (const d of deletes) {
      expect(d.input.GroupName).toBe('medadhere-prod');
    }
  });
});

describe('enroll handler — MED-6 partial-failure compensation', () => {
  it('when the 2nd CreateSchedule rejects: deletes the 1 created schedule, ROLLBACKs the rows, and surfaces the failure', async () => {
    const { handler } = await freshModule();

    // The first CreateSchedule succeeds, the second rejects; ListSchedules (the cleanup) returns the
    // one already-created schedule so the compensation deletes exactly it.
    let createCount = 0;
    schedulerSend.mockImplementation(async (cmd: SchedulerCommand) => {
      if (cmd.__type === 'CreateSchedule') {
        createCount += 1;
        if (createCount === 2) {
          throw new Error('CreateSchedule rejected (simulated AWS throttle)');
        }
        return {};
      }
      if (cmd.__type === 'ListSchedules') {
        const token = (cmd.input as { NextToken?: string }).NextToken;
        if (!token) {
          return {
            Schedules: [{ Name: 'dose-patient-uuid-1-dose-uuid-1' }],
            NextToken: undefined,
          };
        }
        return { Schedules: [], NextToken: undefined };
      }
      return {};
    });

    await expect(handler(TWO_DOSE_PAYLOAD)).rejects.toThrow(/CreateSchedule|enroll/i);

    // The already-created schedule was deleted (compensation).
    const deletes = deleteCommands();
    expect(deletes.map((d) => d.input.Name)).toContain('dose-patient-uuid-1-dose-uuid-1');

    // The patient + dose rows were rolled back (the transaction client ran ROLLBACK, never COMMIT).
    const clientStatements = (clientQueryMock.mock.calls as Array<[string]>).map((c) =>
      c[0].trim().toUpperCase(),
    );
    expect(clientStatements.some((s) => s.startsWith('ROLLBACK'))).toBe(true);
    expect(clientStatements.some((s) => s.startsWith('COMMIT'))).toBe(false);
  });
});

describe('enroll handler — D14: is_test flows into the patient INSERT', () => {
  it('includes is_test in the patient INSERT column list + params (true when the payload marks a cohort row)', async () => {
    const { handler } = await freshModule();
    await handler({ ...SUMMER_PAYLOAD, is_test: true });
    const patientInsert = (clientQueryMock.mock.calls as Array<[string, unknown[]?]>).find((c) =>
      /INSERT INTO patient/i.test(c[0]),
    );
    expect(patientInsert).toBeDefined();
    // The column is in the INSERT list (D14 threads it through — never a filter, a stored badge).
    expect(patientInsert![0]).toMatch(/is_test/i);
    // ...and the value TRUE is a bound parameter (never interpolated).
    expect(patientInsert![1]).toContain(true);
  });

  it('defaults is_test to FALSE when the payload omits it (the seed/dev default; the schema DEFAULT false)', async () => {
    const { handler } = await freshModule();
    await handler(SUMMER_PAYLOAD); // no is_test on the payload
    const patientInsert = (clientQueryMock.mock.calls as Array<[string, unknown[]?]>).find((c) =>
      /INSERT INTO patient/i.test(c[0]),
    );
    expect(patientInsert![1]).toContain(false);
    expect(patientInsert![1]).not.toContain(true);
  });
});

describe('enroll handler — U-15: mirrored E.164 validation (the seed path bypasses the enroll-api zod)', () => {
  it('throws (no writes, no schedules) when phone is not E.164 — the enroll-api zod is mirrored in-handler', async () => {
    const { handler } = await freshModule();
    await expect(handler({ ...SUMMER_PAYLOAD, phone: '514-555-0123' })).rejects.toThrow(
      /E\.164|phone/i,
    );

    // The reject happens at validation — no patient/dose write, no CreateSchedule.
    const writes = (clientQueryMock.mock.calls as Array<[string]>).filter((c) =>
      /INSERT INTO (patient|dose_schedule)/i.test(c[0]),
    );
    expect(writes).toHaveLength(0);
    expect(createCommands()).toHaveLength(0);
  });

  it('accepts a valid E.164 phone (the mirrored check does not reject the happy path)', async () => {
    const { handler } = await freshModule();
    const res = await handler({ ...SUMMER_PAYLOAD, phone: '+447911123456' });
    expect(res.enrolled).toBe(true);
  });
});

describe('enroll handler — mirrored timezone validation', () => {
  it.each(['local', 'system', 'UTC+5'])(
    'rejects the host-dependent or pseudo timezone %s before writes or schedules',
    async (timezone) => {
      const { handler } = await freshModule();
      await expect(handler({ ...SUMMER_PAYLOAD, timezone })).rejects.toThrow(/timezone/i);
      expect(clientQueryMock).not.toHaveBeenCalled();
      expect(createCommands()).toHaveLength(0);
    },
  );

  it.each(['GMT', 'EST5EDT'])('accepts the Intl-supported timezone %s', async (timezone) => {
    const { handler } = await freshModule();
    await expect(handler({ ...SUMMER_PAYLOAD, timezone })).resolves.toMatchObject({
      enrolled: true,
    });
  });
});

describe('enroll handler — all writes are parameterized (Tampering / V5)', () => {
  it('uses $1,$2 placeholders for the patient + dose inserts (no string interpolation of inputs)', async () => {
    const { handler } = await freshModule();
    await handler(SUMMER_PAYLOAD);
    const writes = (clientQueryMock.mock.calls as Array<[string, unknown[]?]>).filter((c) =>
      /INSERT INTO (patient|dose_schedule)/i.test(c[0]),
    );
    expect(writes.length).toBeGreaterThanOrEqual(2);
    for (const [text, params] of writes) {
      // Placeholders present; no raw phone/medication_name/tz literal interpolated into the SQL.
      expect(text).toMatch(/\$1/);
      expect(text).not.toContain('+15145550123');
      expect(text).not.toContain('Metformin');
      expect(Array.isArray(params)).toBe(true);
    }
  });
});

describe('enroll handler — one ACTIVE patient per phone (Plan 04-02 companion, gate fix REV-H4)', () => {
  it('rejects an active duplicate with a stable non-PHI class, no writes, and no schedules', async () => {
    // The in-transaction pre-check finds a live active row for the same phone.
    clientQueryMock.mockImplementation(async (text: string) => {
      if (/SELECT\s+1\s+FROM\s+patient/i.test(text)) {
        return { rows: [{ id: 'prior-active-uuid' }], rowCount: 1 };
      }
      if (/INSERT INTO patient/i.test(text)) {
        return { rows: [{ id: 'patient-uuid-1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const { handler } = await freshModule();
    let thrown: unknown;
    try {
      await handler(SUMMER_PAYLOAD);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      name: 'ActivePatientConflictError',
      message: 'ENROLL_ACTIVE_PATIENT_CONFLICT',
    });
    const serialized = String(thrown);
    expect(serialized).not.toContain('prior-active-uuid');
    expect(serialized).not.toContain(SUMMER_PAYLOAD.phone);
    expect(serialized).not.toContain('UPDATE patient');
    expect(serialized).not.toContain('is_active');

    // No patient/dose write and no schedule creation happened.
    const writes = (clientQueryMock.mock.calls as Array<[string]>).filter((c) =>
      /INSERT INTO (patient|dose_schedule)/i.test(c[0]),
    );
    expect(writes).toHaveLength(0);
    expect(createCommands()).toHaveLength(0);
  });

  it('the pre-check runs INSIDE the transaction and only sees ACTIVE rows (deactivated rows never block re-enrollment)', async () => {
    const { handler } = await freshModule();
    const res = await handler(SUMMER_PAYLOAD); // default dispatch: pre-check SELECT returns no rows
    expect(res.enrolled).toBe(true);

    const precheck = (clientQueryMock.mock.calls as Array<[string, unknown[]?]>).find((c) =>
      /SELECT\s+1\s+FROM\s+patient/i.test(c[0]),
    );
    expect(precheck).toBeDefined();
    const [sql, params] = precheck!;
    expect(sql).toMatch(/is_active\s*=\s*true/i);
    expect(params).toEqual(['+15145550123']);

    // Ordering: BEGIN precedes the pre-check (it participates in the one-transaction contract).
    const statements = (clientQueryMock.mock.calls as Array<[string]>).map((c) => c[0]);
    const beginIdx = statements.findIndex((s) => s.trim().toUpperCase().startsWith('BEGIN'));
    const precheckIdx = statements.findIndex((s) => /SELECT\s+1\s+FROM\s+patient/i.test(s));
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(precheckIdx).toBeGreaterThan(beginIdx);
  });
});
