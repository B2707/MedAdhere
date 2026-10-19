/**
 * handler.test.ts — network-free unit test of the Outbound Lambda handler's PURE logic (SC3 / HIGH-2).
 *
 * NO real AWS, NO real Twilio, NO real DB, NO Docker, NO credentials. `pg`, `twilio`,
 * `@aws-sdk/client-secrets-manager`, and `@aws-sdk/client-ssm` are fully mocked so the test drives the
 * reserve → render → send → record flow in isolation and asserts:
 *   - happy path (reservation wins, rowCount===1) → exactly one messages.create with from=SSM,
 *     to=patient.phone, body=rendered, statusCallback=STATUS_CALLBACK_URL, then the post-send UPDATE
 *     sets twilio_sid + status='queued' + sent_at=now() WHERE dose_id (the SC6 anchor).
 *   - reservation conflict (rowCount===0, HIGH-2) → NO messages.create, NO post-send UPDATE (idempotent
 *     skip; no double-SMS).
 *   - M3 (the M-2 TLS assertion): the captured pg.Pool ctor args carry ssl.rejectUnauthorized===true
 *     AND a non-empty ssl.ca (the bundled RDS global CA PEM).
 *   - FROM from SSM: the FROM number is read via GetParameterCommand on TWILIO_FROM_PARAM, not env.
 *   - Twilio error AFTER reservation → the reserved row is UPDATEd to status='failed' and the auth
 *     token never appears in the thrown error.
 *
 * Mirrors data-api/handler.test.ts (pg + SM mock, module-scoped-pool-reuse + M3) and smoke/twilio.test.ts
 * (twilio + ssm mock), adapted for the Scheduler-invoked reservation-first send.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

// `vi.mock` is hoisted; the spies the factories close over must be created in `vi.hoisted` (also
// hoisted). The handler constructs `new SecretsManagerClient({})` / `new SSMClient({})` at import time,
// so those factory constructors must be `new`-able real `function`s. The pg.Pool ctor captures its args
// for the M3 assertion and counts its invocations for the module-scoped-reuse assertion.
const {
  queryMock,
  connectMock,
  releaseMock,
  endMock,
  smSend,
  ssmSend,
  messagesCreate,
  twilioFactory,
  schedulerSend,
  poolArgs,
} = vi.hoisted(() => {
  const messagesCreate = vi.fn();
  return {
    queryMock: vi.fn(),
    connectMock: vi.fn(),
    releaseMock: vi.fn(),
    endMock: vi.fn(),
    smSend: vi.fn(),
    ssmSend: vi.fn(),
    messagesCreate,
    twilioFactory: vi.fn(() => ({ messages: { create: messagesCreate } })),
    // The EventBridge Scheduler client — Plan 05-01: the timeout-{patientId}-{doseId} one-shot created
    // immediately after the sent_at UPDATE.
    schedulerSend: vi.fn(),
    // M3 — captures the `new Pool({...})` constructor args so the test asserts the CA-pinning TLS config.
    poolArgs: [] as Array<Record<string, unknown>>,
  };
});

vi.mock('pg', () => ({
  Pool: vi.fn(function (config: Record<string, unknown>) {
    poolArgs.push(config);
    return { query: queryMock, connect: connectMock, end: endMock };
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

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn(function () {
    return { send: ssmSend };
  }),
  GetParameterCommand: vi.fn(function (args: unknown) {
    return { __args: args };
  }),
}));

// twilio is a default import (`import twilio from 'twilio'`).
vi.mock('twilio', () => ({ default: twilioFactory }));

vi.mock('@aws-sdk/client-scheduler', () => ({
  SchedulerClient: vi.fn(function () {
    return { send: schedulerSend };
  }),
  CreateScheduleCommand: vi.fn(function (input: unknown) {
    return { __type: 'CreateSchedule', input };
  }),
}));

import { Pool } from 'pg';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SCHEDULE_GROUP_NAME, buildTimeoutScheduleExpression } from '@medadhere/shared';

/** Re-import the handler with a fresh module registry so the module-scoped `pool` starts undefined. */
async function freshHandler() {
  vi.resetModules();
  const mod = await import('./handler.js');
  return mod.handler;
}

const DB_SECRET = JSON.stringify({ username: 'medadhere_admin', password: 'pw' });
const TWILIO_SECRET = JSON.stringify({ accountSid: 'AC_test', authToken: 'tok_supersecret' });

// A far-future actual send instant so `sent_at + RESPONSE_WINDOW_MINUTES` is ALWAYS in the future —
// the timeout one-shot's L2 past-instant guard must never false-fail on a normal send.
const SENT_AT = new Date('2099-08-15T14:30:00.000Z');
const TIMEOUT_FN_ARN = 'arn:aws:lambda:us-east-1:000000000000:function:Timeout';
const OUTBOUND_FN_ARN = 'arn:aws:lambda:us-east-1:000000000000:function:Outbound';
const SCHEDULER_TARGET_ROLE_ARN = 'arn:aws:iam::000000000000:role/SchedulerTargetRole';
const PATIENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const DOSE_ID = '9b2e6679-4f89-42de-963d-02d4f4a986aa';
const AGENT_TURN_ID = '59f47f9d-18dd-42ef-89aa-39540b7b5511';
const OUTBOUND_ID = 'a5f7a723-4e13-4dd2-87d0-b0d155a8d9c2';
const TWILIO_SID = `SM${'a'.repeat(32)}`;
const MESSAGING_STATE_VERSION = 1;
const AGENT_SEND_EVENT = Object.freeze({
  patientId: PATIENT_ID,
  agentTurnId: AGENT_TURN_ID,
  expectedMessagingStateVersion: MESSAGING_STATE_VERSION,
});

const PATIENT_ROW = {
  phone: '+15145550123',
  medication_name: 'Metformin',
  display_name: 'Alex',
  timezone: 'America/Toronto',
  is_active: true, // H1 — the Outbound patient SELECT now re-reads is_active (raced-opt-out skip)
  agent_enabled: true,
  provider_opted_in: true,
  reminder_limit: 2,
};

function isSendFinalizerSql(sql: unknown): boolean {
  const statement = String(sql);
  return (
    /UPDATE outbound_message/i.test(statement) &&
    /twilio_sid\s*=\s*COALESCE/i.test(statement) &&
    /RETURNING sent_at/i.test(statement)
  );
}

/**
 * Wire the default mock behaviour: the Secrets Manager `send` returns the DB secret first (getPool),
 * then the Twilio secret; the pg `query` returns the reservation (rowCount 1), then the patient SELECT,
 * then the post-send UPDATE. The reservation rowCount is overridable per-test via `reservationRowCount`.
 */
function wireDefaults(reservationRowCount = 1) {
  // Secrets Manager: 1st call = DB secret (getPool), 2nd call = Twilio creds.
  smSend.mockImplementation((cmd: { __args?: { SecretId?: string } }) => {
    const id = cmd.__args?.SecretId ?? '';
    if (id.includes('twilio')) return Promise.resolve({ SecretString: TWILIO_SECRET });
    return Promise.resolve({ SecretString: DB_SECRET });
  });
  ssmSend.mockResolvedValue({ Parameter: { Value: '+15005550006' } });
  messagesCreate.mockResolvedValue({ sid: TWILIO_SID, status: 'queued' });

  // pg.query: reservation INSERT → patient SELECT → post-send UPDATE. Dispatch by SQL text so the
  // ordering is robust to extra queries.
  queryMock.mockImplementation((sql: string) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) {
      return Promise.resolve({ rowCount: 0, rows: [] });
    }
    if (/INSERT INTO outbound_message/i.test(sql)) {
      return Promise.resolve({
        rowCount: reservationRowCount,
        rows: reservationRowCount === 1 ? [{ id: OUTBOUND_ID }] : [],
      });
    }
    if (/FROM patient/i.test(sql)) {
      return Promise.resolve({ rowCount: 1, rows: [PATIENT_ROW] });
    }
    if (/FROM outbound_message/i.test(sql) && /FOR UPDATE/i.test(sql)) {
      return Promise.resolve({ rowCount: 1, rows: [{ status: 'sending' }] });
    }
    if (/RETURNING status_updated_at AS send_started_at/i.test(sql)) {
      return Promise.resolve({ rowCount: 1, rows: [{ send_started_at: SENT_AT }] });
    }
    // The SC6 post-send UPDATE returns the actual sent_at (the timeout one-shot anchors to it).
    if (isSendFinalizerSql(sql)) {
      return Promise.resolve({ rowCount: 1, rows: [{ sent_at: SENT_AT }] });
    }
    // Other UPDATEs (the failed path).
    return Promise.resolve({ rowCount: 1, rows: [] });
  });
  schedulerSend.mockReset();
  schedulerSend.mockResolvedValue({
    ScheduleArn: 'arn:aws:scheduler:us-east-1:000000000000:schedule/medadhere-prod/timeout-x',
  });
}

function wireAgentSend(
  options: {
    status?: string;
    active?: boolean;
    agentEnabled?: boolean;
    providerOptedIn?: boolean;
    messagingStateVersion?: number;
    finalMessagingStateVersion?: number;
    claimRowCount?: number;
    claimBody?: string;
    claimComposedBody?: string;
    claimComposition?: unknown;
    claimMessageKind?: string;
    claimPhone?: string;
    claimFailure?: Error;
    queuedUpdateFailure?: boolean;
  } = {},
) {
  wireDefaults();
  queryMock.mockImplementation((sql: string) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) {
      return Promise.resolve({ rowCount: 0, rows: [] });
    }
    if (/SELECT[\s\S]*FROM outbound_message/i.test(sql) && !/FOR UPDATE/i.test(sql)) {
      return Promise.resolve({
        rowCount: 1,
        rows: [{ status: options.status ?? 'prepared' }],
      });
    }
    if (/SELECT[\s\S]*FROM patient/i.test(sql) && /FOR UPDATE/i.test(sql)) {
      return /SELECT p\.phone/i.test(sql)
        ? Promise.resolve({
            rowCount: 1,
            rows: [
              {
                phone: options.claimPhone ?? PATIENT_ROW.phone,
                is_active: options.active ?? true,
                agent_enabled: options.agentEnabled ?? true,
                provider_opted_in: options.providerOptedIn ?? true,
                messaging_state_version:
                  options.finalMessagingStateVersion ??
                  options.messagingStateVersion ??
                  MESSAGING_STATE_VERSION,
              },
            ],
          })
        : Promise.resolve({ rowCount: 1, rows: [{ id: PATIENT_ID }] });
    }
    if (/SELECT[\s\S]*FROM outbound_message/i.test(sql) && /FOR UPDATE/i.test(sql)) {
      return Promise.resolve({
        rowCount: 1,
        rows: [
          {
            id: OUTBOUND_ID,
            status: /callback_token_hash/i.test(sql) ? 'sending' : (options.status ?? 'prepared'),
            messaging_consent_epoch: MESSAGING_STATE_VERSION,
          },
        ],
      });
    }
    if (/SELECT[\s\S]*FROM patient/i.test(sql)) {
      return Promise.resolve({
        rowCount: 1,
        rows: [
          {
            phone: options.claimPhone ?? PATIENT_ROW.phone,
            is_active: options.active ?? true,
            agent_enabled: options.agentEnabled ?? true,
            provider_opted_in: options.providerOptedIn ?? true,
            messaging_state_version: options.messagingStateVersion ?? MESSAGING_STATE_VERSION,
          },
        ],
      });
    }
    if (/UPDATE outbound_message/i.test(sql) && /SET\s+status\s*=\s*'sending'/i.test(sql)) {
      if (options.claimFailure) return Promise.reject(options.claimFailure);
      const claimRowCount = options.claimRowCount ?? 1;
      return Promise.resolve({
        rowCount: claimRowCount,
        rows:
          claimRowCount === 1
            ? [
                {
                  id: OUTBOUND_ID,
                  body:
                    options.claimBody ??
                    'Thanks for the update. I recorded that for your care team.',
                  composed_body: options.claimComposedBody ?? null,
                  composition: options.claimComposition ?? null,
                  message_kind: options.claimMessageKind ?? 'acknowledgement',
                },
              ]
            : [],
      });
    }
    if (/UPDATE outbound_message/i.test(sql) && /SET\s+status\s*=\s*'failed'/i.test(sql)) {
      return Promise.resolve({ rowCount: 1, rows: [] });
    }
    if (/RETURNING status_updated_at AS send_started_at/i.test(sql)) {
      return Promise.resolve({ rowCount: 1, rows: [{ send_started_at: SENT_AT }] });
    }
    if (isSendFinalizerSql(sql)) {
      return options.queuedUpdateFailure
        ? Promise.reject(new Error('database unavailable after provider acceptance'))
        : Promise.resolve({ rowCount: 1, rows: [{ sent_at: SENT_AT }] });
    }
    if (/UPDATE outbound_message/i.test(sql)) {
      return Promise.resolve({ rowCount: 1, rows: [{ sent_at: SENT_AT }] });
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  poolArgs.length = 0;
  process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:db';
  process.env.DB_HOST = 'db.internal';
  process.env.DB_PORT = '5432';
  process.env.DB_NAME = 'medadhere';
  process.env.TWILIO_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:twilio';
  process.env.STATUS_CALLBACK_URL =
    'https://abc123.execute-api.us-east-1.amazonaws.com/twilio/status#rc=3&ct=1000&rt=5000&tt=15000&rp=ct,rt,5xx';
  process.env.TIMEOUT_FN_ARN = TIMEOUT_FN_ARN;
  process.env.SCHEDULER_TARGET_ROLE_ARN = SCHEDULER_TARGET_ROLE_ARN;
  delete process.env.TWILIO_FROM_PARAM;
  delete process.env.RESPONSE_WINDOW_MINUTES; // prove the shared-const default (120) is used
  connectMock.mockResolvedValue({ query: queryMock, release: releaseMock });
  wireDefaults();
});

/** Find the first scheduler.send command whose input matches (CreateSchedule). */
function schedulerCall(): { __type: string; input: Record<string, unknown> } | undefined {
  return (schedulerSend.mock.calls as Array<[{ __type: string; input: Record<string, unknown> }]>)
    .map((c) => c[0])
    .find((cmd) => cmd.__type === 'CreateSchedule');
}

function schedulerCalls(): Array<{ __type: string; input: Record<string, unknown> }> {
  return (
    schedulerSend.mock.calls as Array<[{ __type: string; input: Record<string, unknown> }]>
  ).map(([command]) => command);
}

function expectOpaqueStatusCallback(messageCallIndex = 0): string {
  const options = messagesCreate.mock.calls[messageCallIndex]?.[0] as
    | { statusCallback?: string }
    | undefined;
  expect(options?.statusCallback).toBeDefined();
  const callback = new URL(options!.statusCallback!);
  const token = callback.searchParams.get('callbackToken');
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(callback.searchParams.size).toBe(1);
  expect(options?.statusCallback).not.toContain(OUTBOUND_ID);
  expect(callback.hash).toBe('#rc=3&ct=1000&rt=5000&tt=15000&rp=ct,rt,5xx');
  return token!;
}

describe('outbound handler — callback configuration is validated before any durable send claim', () => {
  it.each([
    ['missing', undefined],
    ['malformed', 'not-a-url'],
    ['query-bearing', 'https://example.test/twilio/status?unsafe=1#rc=3'],
    ['empty-query marker', 'https://example.test/twilio/status?#rc=3'],
  ])(
    'leaves no scheduled check-in reservation for a %s callback URL',
    async (_label, configured) => {
      if (configured === undefined) delete process.env.STATUS_CALLBACK_URL;
      else process.env.STATUS_CALLBACK_URL = configured;
      const handler = await freshHandler();

      await expect(handler({ patientId: PATIENT_ID, doseId: DOSE_ID })).rejects.toThrow();

      expect(
        queryMock.mock.calls.some(([sql]) => /INSERT INTO outbound_message/i.test(String(sql))),
      ).toBe(false);
      expect(messagesCreate).not.toHaveBeenCalled();
    },
  );
});

describe('outbound handler — happy path: reserve → render → send → record (SC3 / SC6)', () => {
  it('reserves immediately before sending, then sends exactly one Twilio message with from=SSM/to/body/statusCallback', async () => {
    const handler = await freshHandler();
    const res = await handler({ patientId: PATIENT_ID, doseId: DOSE_ID });

    // The reservation INSERT ran (the HIGH-2 idempotency guard), reserving the row at status='sending'
    // (MED-6). HIGH-1: it is preceded by the throwable pre-send prep (the patient SELECT) and immediately
    // precedes the send.
    const reservationCall = queryMock.mock.calls.find((c) =>
      /INSERT INTO outbound_message/i.test(String(c[0])),
    );
    expect(reservationCall).toBeDefined();
    const reservationSql = String(reservationCall![0]);
    expect(reservationSql).toMatch(/ON CONFLICT \(dose_id\)/i);
    expect(reservationSql).toMatch(
      /WHERE dose_id IS NOT NULL AND message_kind = 'check_in'[\s\S]*DO NOTHING/i,
    );
    // MED-6 — the reserved row is inserted at status='sending' (the pre-send state), parameterized.
    expect(reservationSql).toMatch(/'sending'/);
    expect((reservationCall as [string, unknown[]])[1]).toEqual([
      PATIENT_ID,
      DOSE_ID,
      expect.stringContaining('Metformin'),
      expect.any(Buffer),
    ]);
    expect(reservationSql).toMatch(/callback_token_hash/i);
    expect(reservationSql).toMatch(/body/i);
    expect(reservationSql).toMatch(/message_kind/i);

    // HIGH-1 — the patient SELECT (throwable pre-send prep) runs BEFORE the reservation INSERT.
    const reservationIdx = queryMock.mock.calls.findIndex((c) =>
      /INSERT INTO outbound_message/i.test(String(c[0])),
    );
    const selectIdx = queryMock.mock.calls.findIndex((c) => /FROM patient/i.test(String(c[0])));
    expect(selectIdx).toBeGreaterThanOrEqual(0);
    expect(selectIdx).toBeLessThan(reservationIdx);

    // Exactly one Twilio send with the SSM FROM, the patient phone, a rendered body, and the env URL.
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '+15005550006',
        to: '+15145550123',
      }),
    );
    const callbackToken = expectOpaqueStatusCallback();
    const callbackTokenHash = (reservationCall as [string, unknown[]])[1][3] as Buffer;
    expect(callbackTokenHash).toEqual(createHash('sha256').update(callbackToken).digest());
    expect(JSON.stringify(queryMock.mock.calls)).not.toContain(callbackToken);
    const sentBody = (messagesCreate.mock.calls[0]?.[0] as { body: string }).body;
    expect(sentBody).toContain('Metformin'); // the medication name was rendered into the body (SC3)
    expect(sentBody).toContain('Alex'); // the optional displayName rendered too
    expect(sentBody).toContain('how are you feeling');
    expect(sentBody.indexOf('how are you feeling')).toBeLessThan(sentBody.indexOf('Metformin'));
    expect(sentBody).toContain('text anytime if anything changes');

    // Twilio creds reached the SDK constructor (not undefined).
    expect(twilioFactory).toHaveBeenCalledWith('AC_test', 'tok_supersecret', {
      timeout: 5000,
      autoRetry: false,
    });

    expect(res).toEqual({ sent: true, sid: TWILIO_SID });
  });

  it('post-send UPDATE sets twilio_sid + queued + the send-attempt anchor by claimed id', async () => {
    const handler = await freshHandler();
    await handler({ patientId: PATIENT_ID, doseId: DOSE_ID });

    const updateCall = queryMock.mock.calls.find(
      (c) => /UPDATE outbound_message/i.test(String(c[0])) && /twilio_sid/i.test(String(c[0])),
    );
    expect(updateCall).toBeDefined();
    const [sql, params] = updateCall as [string, unknown[]];
    expect(sql).toMatch(/status\s*=\s*CASE/i);
    expect(sql).toMatch(/WHEN status IN \('sending', 'sending_unknown'\) THEN 'queued'/i);
    expect(sql).toMatch(/sent_at\s*=\s*COALESCE\(sent_at,\s*\$3\)/i);
    expect(sql).toMatch(/WHERE id\s*=\s*\$2/i);
    expect(sql).toMatch(/AND \(twilio_sid IS NULL OR twilio_sid = \$1\)/i);
    // Parameterized: $1=sid, $2=doseId — no string interpolation.
    expect(params).toEqual([TWILIO_SID, OUTBOUND_ID, SENT_AT]);
  });
});

describe('outbound handler — HIGH-2 reservation conflict → idempotent skip (no double-SMS)', () => {
  it('when the reservation inserts 0 rows, it does NOT call messages.create and does NOT post-send UPDATE', async () => {
    wireDefaults(0); // reservation conflict — another invocation already owns the dose
    const handler = await freshHandler();
    const res = await handler({ patientId: PATIENT_ID, doseId: DOSE_ID });

    expect(messagesCreate).not.toHaveBeenCalled();
    // No post-send UPDATE (no twilio_sid write) — the reservation inserted 0 rows so the send was skipped.
    const updateCalls = queryMock.mock.calls.filter((c) =>
      /UPDATE outbound_message/i.test(String(c[0])),
    );
    expect(updateCalls).toHaveLength(0);
    // HIGH-1 — the patient SELECT is throwable pre-send prep, so it runs BEFORE the reservation; on a
    // conflict the reservation then inserts 0 rows and the handler skips the send (still no double-SMS).
    const selectCalls = queryMock.mock.calls.filter((c) => /FROM patient/i.test(String(c[0])));
    expect(selectCalls).toHaveLength(2);
    expect(String(selectCalls[1]?.[0])).toMatch(
      /agent_enabled\s*=\s*true[\s\S]*provider_opted_in\s*=\s*true[\s\S]*FOR UPDATE OF p, ds/i,
    );
    expect(res).toEqual({ sent: false, reason: 'already-reserved' });
  });
});

describe('outbound handler — prepared agent send is stored-first and claimed once', () => {
  it('locks patient then prepared outbound in one transaction and commits the claim before Twilio', async () => {
    wireAgentSend();
    const handler = await freshHandler();

    await handler(AGENT_SEND_EVENT);

    expect(connectMock).toHaveBeenCalledTimes(3);
    const beginIndex = queryMock.mock.calls.findIndex(([sql]) => /^BEGIN$/i.test(String(sql)));
    const patientLockIndex = queryMock.mock.calls.findIndex(
      ([sql]) => /FROM patient/i.test(String(sql)) && /FOR UPDATE/i.test(String(sql)),
    );
    const outboundLockIndex = queryMock.mock.calls.findIndex(
      ([sql]) => /FROM outbound_message/i.test(String(sql)) && /FOR UPDATE/i.test(String(sql)),
    );
    const claimIndex = queryMock.mock.calls.findIndex(
      ([sql]) =>
        /UPDATE outbound_message/i.test(String(sql)) && /status\s*=\s*'sending'/i.test(String(sql)),
    );
    const commitIndex = queryMock.mock.calls.findIndex(([sql]) => /^COMMIT$/i.test(String(sql)));
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(patientLockIndex).toBeGreaterThan(beginIndex);
    expect(outboundLockIndex).toBeGreaterThan(patientLockIndex);
    expect(claimIndex).toBeGreaterThan(outboundLockIndex);
    expect(commitIndex).toBeGreaterThan(claimIndex);
    expect(queryMock.mock.invocationCallOrder[commitIndex]).toBeLessThan(
      messagesCreate.mock.invocationCallOrder[0] as number,
    );
    // Claim, consent preflight, and callback-safe finalization each use one short-lived client.
    expect(releaseMock).toHaveBeenCalledTimes(3);
  });

  it('loads the stored body, atomically claims prepared→sending, records queued, and never schedules a dose timeout', async () => {
    wireAgentSend();
    const handler = await freshHandler();

    await expect(handler(AGENT_SEND_EVENT)).resolves.toEqual({
      sent: true,
      sid: TWILIO_SID,
    });

    const claim = queryMock.mock.calls.find(
      ([sql]) =>
        /UPDATE outbound_message/i.test(String(sql)) && /status\s*=\s*'sending'/i.test(String(sql)),
    ) as [string, unknown[]] | undefined;
    expect(claim).toBeDefined();
    expect(claim?.[0]).toMatch(/status\s*=\s*'prepared'/i);
    expect(claim?.[0]).toMatch(/WHERE id\s*=\s*\$1/i);
    expect(claim?.[0]).toMatch(/callback_token_hash/i);
    expect(claim?.[1]).toEqual([OUTBOUND_ID, expect.any(Buffer)]);
    expect(messagesCreate).toHaveBeenCalledOnce();
    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'Thanks for the update. I recorded that for your care team.',
        to: PATIENT_ROW.phone,
      }),
    );
    expectOpaqueStatusCallback();
    const queued = queryMock.mock.calls.find(([sql]) => isSendFinalizerSql(sql)) as
      | [string, unknown[]]
      | undefined;
    expect(queued?.[1]).toEqual([TWILIO_SID, OUTBOUND_ID, SENT_AT]);
    expect(schedulerSend).not.toHaveBeenCalled();
  });

  it('sends only the claimed body and the phone re-read under the patient lock', async () => {
    wireAgentSend({
      claimBody: 'Corrected reply captured at claim time.',
      claimPhone: '+15145550999',
    });
    const handler = await freshHandler();

    await handler(AGENT_SEND_EVENT);

    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'Corrected reply captured at claim time.',
        to: '+15145550999',
      }),
    );
    const claimSql = String(
      queryMock.mock.calls.find(([sql]) => /status\s*=\s*'sending'/i.test(String(sql)))?.[0],
    );
    expect(claimSql).toMatch(/RETURNING[\s\S]*id[\s\S]*body/i);
    const patientStateSql = String(
      queryMock.mock.calls.find(
        ([sql]) => /SELECT phone/i.test(String(sql)) && !/FOR UPDATE/i.test(String(sql)),
      )?.[0],
    );
    expect(patientStateSql).toMatch(
      /phone[\s\S]*is_active[\s\S]*agent_enabled[\s\S]*provider_opted_in[\s\S]*messaging_state_version/i,
    );
  });

  it('transmits the composed body when the send-time re-check passes, and leaves the row alone', async () => {
    const composed = 'Got it, thanks for the update.';
    wireAgentSend({
      claimComposedBody: composed,
      claimComposition: {
        composedBodySha256: createHash('sha256').update(composed, 'utf8').digest('hex'),
        intent: {
          kind: 'acknowledgement',
          requiredTokens: [],
          allowedTerms: [],
          medications: [],
          patientFacts: [],
        },
        dayContext: { messages: [], latestPatientMessage: 'took it this morning' },
      },
    });
    const handler = await freshHandler();

    await handler(AGENT_SEND_EVENT);

    expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({ body: composed }));
    expect(
      queryMock.mock.calls.some(([sql]) => /SET composed_body\s*=\s*NULL/i.test(String(sql))),
      'an accepted composed body is never withdrawn',
    ).toBe(false);
  });

  it('withdraws a REFUSED composed body from the row so no reader can show unsent text', async () => {
    wireAgentSend({
      claimComposedBody: 'tampered composed text',
      claimComposition: {
        composedBodySha256: createHash('sha256').update('the original', 'utf8').digest('hex'),
        intent: {
          kind: 'acknowledgement',
          requiredTokens: [],
          allowedTerms: [],
          medications: [],
          patientFacts: [],
        },
        dayContext: { messages: [], latestPatientMessage: 'took it this morning' },
      },
    });
    const handler = await freshHandler();

    await handler(AGENT_SEND_EVENT);

    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'Thanks for the update. I recorded that for your care team.',
      }),
    );
    const withdrawal = queryMock.mock.calls.find(([sql]) =>
      /SET composed_body\s*=\s*NULL/i.test(String(sql)),
    ) as [string, unknown[]] | undefined;
    expect(withdrawal, 'the unsent composed text must not survive on the row').toBeDefined();
    expect(withdrawal?.[1]).toEqual([OUTBOUND_ID]);
  });

  it.each(['queued', 'failed', 'sending_unknown', 'sending'])(
    'does not send again when the stored agent row is already %s',
    async (status) => {
      wireAgentSend({ status });
      const handler = await freshHandler();

      await expect(handler(AGENT_SEND_EVENT)).resolves.toEqual({
        sent: false,
        reason: 'already-reserved',
      });
      expect(messagesCreate).not.toHaveBeenCalled();
      expect(schedulerSend).not.toHaveBeenCalled();
    },
  );

  it('does not send when another invocation wins the prepared claimant after the preflight read', async () => {
    wireAgentSend({ claimRowCount: 0 });
    const handler = await freshHandler();

    await expect(handler(AGENT_SEND_EVENT)).resolves.toEqual({
      sent: false,
      reason: 'already-reserved',
    });
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('leaves an agent reply prepared when callback configuration is invalid', async () => {
    wireAgentSend();
    process.env.STATUS_CALLBACK_URL = 'https://example.test/twilio/status?unsafe=1';
    const handler = await freshHandler();

    await expect(handler(AGENT_SEND_EVENT)).rejects.toThrow(/must not contain query parameters/);

    expect(
      queryMock.mock.calls.some(
        ([sql]) =>
          /UPDATE outbound_message/i.test(String(sql)) &&
          /SET\s+status\s*=\s*'sending'/i.test(String(sql)),
      ),
    ).toBe(false);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('rolls back and releases the transaction when the prepared claim update fails', async () => {
    const claimFailure = new Error('claim database unavailable');
    wireAgentSend({ claimFailure });
    const handler = await freshHandler();

    await expect(handler(AGENT_SEND_EVENT)).rejects.toBe(claimFailure);

    expect(queryMock.mock.calls.some(([sql]) => /^ROLLBACK$/i.test(String(sql)))).toBe(true);
    expect(releaseMock).toHaveBeenCalledOnce();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('terminalizes without sending when the patient becomes inactive between preflight and claim', async () => {
    wireAgentSend({ active: false });
    const handler = await freshHandler();

    await expect(handler(AGENT_SEND_EVENT)).resolves.toEqual({
      sent: false,
      reason: 'patient-inactive',
    });
    expect(messagesCreate).not.toHaveBeenCalled();
    const terminalSql = String(
      queryMock.mock.calls.find(([sql]) => /status\s*=\s*'failed'/i.test(String(sql)))?.[0],
    );
    expect(terminalSql).toMatch(/WHERE id\s*=\s*\$1/i);
    expect(terminalSql).toMatch(/status\s*=\s*'prepared'/i);
  });

  it('terminalizes without sending when the prepared reply belongs to an older consent version', async () => {
    wireAgentSend({ messagingStateVersion: MESSAGING_STATE_VERSION + 1 });
    const handler = await freshHandler();

    await expect(
      handler({
        patientId: PATIENT_ID,
        agentTurnId: AGENT_TURN_ID,
        expectedMessagingStateVersion: MESSAGING_STATE_VERSION,
      }),
    ).resolves.toEqual({ sent: false, reason: 'messaging-state-changed' });

    expect(messagesCreate).not.toHaveBeenCalled();
    const terminalSql = String(
      queryMock.mock.calls.find(
        ([sql]) =>
          /UPDATE outbound_message/i.test(String(sql)) &&
          /status\s*=\s*'failed'/i.test(String(sql)),
      )?.[0],
    );
    expect(terminalSql).toMatch(/status\s*=\s*'prepared'/i);
  });

  it('terminalizes the claimed send when START changes only the version before the final lock', async () => {
    wireAgentSend({ finalMessagingStateVersion: MESSAGING_STATE_VERSION + 1 });
    const handler = await freshHandler();

    await expect(handler(AGENT_SEND_EVENT)).resolves.toEqual({
      sent: false,
      reason: 'messaging-state-changed',
    });

    expect(messagesCreate).not.toHaveBeenCalled();
    const terminalSql = String(
      queryMock.mock.calls.find(
        ([sql]) =>
          /UPDATE outbound_message/i.test(String(sql)) &&
          /status\s*=\s*'failed'/i.test(String(sql)) &&
          /status\s*=\s*'sending'/i.test(String(sql)),
      )?.[0],
    );
    expect(terminalSql).toMatch(/WHERE id\s*=\s*\$1/i);
  });

  it.each([
    ['provider_opted_in', { providerOptedIn: false }],
    ['agent_enabled', { agentEnabled: false }],
  ] as const)(
    'terminalizes without sending when %s becomes false before the prepared claim',
    async (_disabledFlag, disabledState) => {
      wireAgentSend(disabledState);
      const handler = await freshHandler();

      await expect(handler(AGENT_SEND_EVENT)).resolves.toEqual({
        sent: false,
        reason: 'messaging-disabled',
      });
      expect(messagesCreate).not.toHaveBeenCalled();
      const terminalSql = String(
        queryMock.mock.calls.find(
          ([sql]) =>
            /UPDATE outbound_message/i.test(String(sql)) &&
            /status\s*=\s*'failed'/i.test(String(sql)),
        )?.[0],
      );
      expect(terminalSql).toMatch(/WHERE id\s*=\s*\$1/i);
      expect(terminalSql).toMatch(/status\s*=\s*'prepared'/i);
    },
  );

  it('terminalizes an invalid claimed body without sending', async () => {
    wireAgentSend({ claimBody: '   ' });
    const handler = await freshHandler();

    await expect(handler(AGENT_SEND_EVENT)).rejects.toThrow(/no valid stored body/);
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(queryMock.mock.calls.some(([sql]) => /status\s*=\s*'failed'/i.test(String(sql)))).toBe(
      true,
    );
  });

  it('terminalizes a prepared agent row without sending when the patient is inactive', async () => {
    wireAgentSend({ active: false });
    const handler = await freshHandler();

    await expect(handler(AGENT_SEND_EVENT)).resolves.toEqual({
      sent: false,
      reason: 'patient-inactive',
    });
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(queryMock.mock.calls.some(([sql]) => /status\s*=\s*'failed'/i.test(String(sql)))).toBe(
      true,
    );
  });

  it('completes a definitive provider rejection as terminal failed without throwing (FIFO group must not block on an unretryable send)', async () => {
    wireAgentSend();
    messagesCreate.mockRejectedValue(
      Object.assign(new Error('recipient rejected'), { status: 400, code: 21610 }),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = await freshHandler();

    await expect(handler(AGENT_SEND_EVENT)).resolves.toEqual({
      sent: false,
      reason: 'provider-rejected',
    });
    const terminal = queryMock.mock.calls.find(
      ([sql, params]) =>
        /UPDATE outbound_message/i.test(String(sql)) &&
        Array.isArray(params) &&
        params[0] === 'failed',
    );
    expect(terminal).toBeDefined();
    expect(schedulerSend).not.toHaveBeenCalled();
    const rejectionLog = logSpy.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.includes('provider_rejected'));
    expect(rejectionLog).toBeDefined();
    expect(JSON.parse(rejectionLog as string)).toEqual({
      stage: 'agent_send',
      outcome: 'provider_rejected',
      providerCode: 21610,
      providerStatus: 400,
    });
    logSpy.mockRestore();
  });

  it('records an ambiguous transport failure as sending_unknown and throws for retry reconciliation', async () => {
    wireAgentSend();
    messagesCreate.mockRejectedValue(new Error('socket reset after write'));
    const handler = await freshHandler();

    await expect(handler(AGENT_SEND_EVENT)).rejects.toThrow(/status is unknown/);
    const terminal = queryMock.mock.calls.find(
      ([sql, params]) =>
        /UPDATE outbound_message/i.test(String(sql)) &&
        Array.isArray(params) &&
        params[0] === 'sending_unknown',
    );
    expect(terminal).toBeDefined();
    expect(schedulerSend).not.toHaveBeenCalled();
  });

  it('records sending_unknown and fails closed when the provider accepted the SMS but queued persistence fails', async () => {
    wireAgentSend({ queuedUpdateFailure: true });
    const handler = await freshHandler();

    await expect(handler(AGENT_SEND_EVENT)).rejects.toThrow(/status is unknown/);
    expect(messagesCreate).toHaveBeenCalledOnce();
    const unknown = queryMock.mock.calls.find(([sql]) =>
      /status\s*=\s*'sending_unknown'/i.test(String(sql)),
    ) as [string, unknown[]] | undefined;
    expect(unknown?.[1]).toEqual([TWILIO_SID, OUTBOUND_ID, SENT_AT]);
    expect(schedulerSend).not.toHaveBeenCalled();
  });

  it('keeps an invalid-SID agent send ambiguous without creating a sent_at anchor', async () => {
    wireAgentSend();
    messagesCreate.mockResolvedValue({ sid: '' });
    const handler = await freshHandler();

    await expect(handler(AGENT_SEND_EVENT)).rejects.toThrow(/status is unknown/);

    const ambiguous = queryMock.mock.calls.find(
      ([sql, params]) =>
        /UPDATE outbound_message/i.test(String(sql)) &&
        Array.isArray(params) &&
        params[0] === 'sending_unknown',
    ) as [string, unknown[]] | undefined;
    expect(ambiguous).toBeDefined();
    expect(ambiguous?.[0]).not.toMatch(/sent_at\s*=/i);
    expect(schedulerSend).not.toHaveBeenCalled();
  });

  it('rejects mixed, extra-key, and malformed events before database or Twilio work', async () => {
    const handler = await freshHandler();
    await expect(handler({ ...AGENT_SEND_EVENT, doseId: DOSE_ID } as never)).rejects.toThrow();
    await expect(handler({ ...AGENT_SEND_EVENT, body: 'smuggled' } as never)).rejects.toThrow();
    await expect(
      handler({ patientId: PATIENT_ID, agentTurnId: AGENT_TURN_ID } as never),
    ).rejects.toThrow();
    await expect(
      handler({ ...AGENT_SEND_EVENT, expectedMessagingStateVersion: 0 } as never),
    ).rejects.toThrow();
    await expect(handler({ patientId: 'not-a-uuid', doseId: DOSE_ID } as never)).rejects.toThrow();
    expect(queryMock).not.toHaveBeenCalled();
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});

describe('outbound handler — M3: verifies the RDS server cert against the pinned CA bundle (M-2 / T-03-08)', () => {
  it('constructs the pg.Pool with ssl.rejectUnauthorized:true AND a non-empty ssl.ca', async () => {
    const handler = await freshHandler();
    await handler({ patientId: PATIENT_ID, doseId: DOSE_ID });

    expect(poolArgs).toHaveLength(1);
    const ssl = poolArgs[0]?.ssl as { ca?: unknown; rejectUnauthorized?: unknown } | undefined;
    expect(ssl).toBeDefined();
    expect(ssl?.rejectUnauthorized).toBe(true);
    expect(typeof ssl?.ca).toBe('string');
    expect((ssl?.ca as string).length).toBeGreaterThan(0);
    // The pool is the D-11 cap.
    expect(poolArgs[0]?.max).toBe(2);
  });
});

describe('outbound handler — FROM is read from SSM at runtime (F45)', () => {
  it('reads the FROM number via GetParameterCommand on the default param, not an env value', async () => {
    const handler = await freshHandler();
    await handler({ patientId: PATIENT_ID, doseId: DOSE_ID });

    expect(GetParameterCommand).toHaveBeenCalledTimes(1);
    expect(GetParameterCommand).toHaveBeenCalledWith({ Name: '/medadhere/twilio-from' });
    // The DB + Twilio secrets are both read by ARN from Secrets Manager (D-06), never an env value.
    expect(GetSecretValueCommand).toHaveBeenCalled();
  });

  it('honours TWILIO_FROM_PARAM so the toll-free re-point needs no redeploy', async () => {
    process.env.TWILIO_FROM_PARAM = '/medadhere/twilio-from-tollfree';
    const handler = await freshHandler();
    await handler({ patientId: PATIENT_ID, doseId: DOSE_ID });
    expect(GetParameterCommand).toHaveBeenCalledWith({ Name: '/medadhere/twilio-from-tollfree' });
  });
});

describe('outbound handler — Twilio error AFTER reservation → mark failed, never leak the token', () => {
  it('UPDATEs the reserved row to status=failed and the thrown error excludes the auth token', async () => {
    wireDefaults(1);
    // A REST error carries the HTTP status the ambiguity classifier reads — 21610 is a definitive 400
    // rejection, so this stays 'failed' (H-03 only re-routes outcomes we genuinely cannot classify).
    messagesCreate.mockRejectedValue(
      Object.assign(new Error('Twilio 21610: unsubscribed recipient'), { status: 400 }),
    );
    const handler = await freshHandler();

    await expect(handler({ patientId: PATIENT_ID, doseId: DOSE_ID })).rejects.toThrow(
      'Outbound check-in send did not complete',
    );

    // The reserved row was flipped to 'failed' (status + dose_id both parameterized since H-03).
    const failedUpdate = queryMock.mock.calls.find(
      (c) =>
        /UPDATE outbound_message/i.test(String(c[0])) &&
        Array.isArray(c[1]) &&
        c[1][0] === 'failed',
    );
    expect(failedUpdate).toBeDefined();
    expect((failedUpdate as [string, unknown[]])[1]).toEqual(['failed', OUTBOUND_ID, SENT_AT]);

    // The auth token must NEVER appear in the rejection.
    try {
      await handler({ patientId: PATIENT_ID, doseId: DOSE_ID });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('tok_supersecret');
      expect(String((e as Error).message)).not.toContain(PATIENT_ID);
      expect(String((e as Error).message)).not.toContain(DOSE_ID);
    }
  });

  it('treats a resolved provider response without a real MessageSid as sending_unknown, never queued', async () => {
    wireDefaults();
    messagesCreate.mockResolvedValue({ sid: '', status: 'queued' });
    const handler = await freshHandler();

    await expect(handler({ patientId: PATIENT_ID, doseId: DOSE_ID })).rejects.toThrow(
      'Outbound check-in send status is unknown',
    );

    const unknown = queryMock.mock.calls.find(
      ([sql, params]) =>
        /UPDATE outbound_message/i.test(String(sql)) &&
        /sending_unknown/i.test(String(sql)) &&
        Array.isArray(params) &&
        params[0] === 'sending_unknown',
    );
    expect(unknown).toBeDefined();
    expect(queryMock.mock.calls.some(([sql]) => isSendFinalizerSql(sql))).toBe(false);
  });
});

describe('outbound handler — H-03: the scheduled check-in classifies ambiguous send outcomes', () => {
  /** wireDefaults, but the SC6 post-send UPDATE (`status='queued'`) rejects after Twilio accepted. */
  function wireCheckInUpdateLoss(): void {
    wireDefaults();
    const base = queryMock.getMockImplementation() as (sql: string) => Promise<unknown>;
    queryMock.mockImplementation((sql: string) => {
      if (isSendFinalizerSql(sql)) {
        return Promise.reject(new Error('connection lost after Twilio acceptance'));
      }
      return base(sql);
    });
  }

  it.each([
    [
      'definitive provider rejection (4xx)',
      Object.assign(new Error('unsubscribed recipient'), { status: 400 }),
      'failed',
    ],
    [
      'accepted-but-response-lost (ambiguous)',
      new Error('socket reset after write'),
      'sending_unknown',
    ],
  ])(
    'terminalizes a %s check-in as %s — never a definite failure for an ambiguous outcome',
    async (_label, failure, expected) => {
      wireDefaults();
      messagesCreate.mockRejectedValue(failure);
      const handler = await freshHandler();

      // A definitive rejection is terminal ('did not complete'); an ambiguous one must surface as
      // unknown so the callback/retry path — not this invocation — decides the row's fate.
      await expect(handler({ patientId: PATIENT_ID, doseId: DOSE_ID })).rejects.toThrow(
        expected === 'failed'
          ? 'Outbound check-in send did not complete'
          : 'Outbound check-in send status is unknown',
      );

      expect(messagesCreate).toHaveBeenCalledOnce();
      const terminal = queryMock.mock.calls.find(
        ([sql, params]) =>
          /UPDATE outbound_message/i.test(String(sql)) &&
          Array.isArray(params) &&
          params[0] === expected,
      );
      // Before the fix this branch hardcoded status='failed', so a lost provider response marked an
      // SMS the patient may well have received as undelivered.
      expect(terminal).toBeDefined();
      const [terminalSql, terminalParams] = terminal as [string, unknown[]];
      // A provider rejection/timeout has no validated SID. It must not create the clinical sent_at
      // anchor until an authenticated callback proves acceptance; preserve the send-start instant in
      // status_updated_at so that later callback recovery can anchor schedules deterministically.
      expect(terminalSql).not.toMatch(/sent_at\s*=/i);
      expect(terminalSql).toMatch(/status_updated_at\s*=\s*CASE/i);
      expect(terminalParams).toEqual([expected, OUTBOUND_ID, SENT_AT]);
    },
  );

  it('records twilio_sid + sending_unknown when the provider accepted but the DB update is lost', async () => {
    wireCheckInUpdateLoss();
    const handler = await freshHandler();

    await expect(handler({ patientId: PATIENT_ID, doseId: DOSE_ID })).rejects.toThrow(
      /send status is unknown/i,
    );

    expect(messagesCreate).toHaveBeenCalledOnce();
    // The SID must be persisted — it is the ONLY handle the status callback can later resolve the row by.
    const recovery = queryMock.mock.calls.find(
      ([sql]) =>
        /UPDATE outbound_message/i.test(String(sql)) &&
        /status\s*=\s*'sending_unknown'/i.test(String(sql)) &&
        /twilio_sid/i.test(String(sql)),
    ) as [string, unknown[]] | undefined;
    expect(recovery).toBeDefined();
    expect(recovery?.[1]).toEqual([TWILIO_SID, OUTBOUND_ID, SENT_AT]);
    expect(recovery?.[0]).toMatch(/AND status\s*=\s*'sending'/i);
    // Fails closed: no timeout / reminder one-shots are anchored to a sent_at we never read.
    expect(schedulerSend).not.toHaveBeenCalled();
  });

  it('does not regress callback-delivered after the primary queued write commits but its response is lost', async () => {
    wireDefaults();
    const base = queryMock.getMockImplementation() as (sql: string) => Promise<unknown>;
    let storedStatus = 'sending';
    queryMock.mockImplementation((sql: string) => {
      if (isSendFinalizerSql(sql)) {
        storedStatus = 'queued'; // primary write committed
        storedStatus = 'delivered'; // callback arrived before the client learned the response was lost
        return Promise.reject(new Error('primary UPDATE response lost'));
      }
      if (/UPDATE outbound_message/i.test(sql) && /status\s*=\s*'sending_unknown'/i.test(sql)) {
        if (!/AND status\s*=\s*'sending'/i.test(sql) || storedStatus === 'sending') {
          storedStatus = 'sending_unknown';
        }
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      return base(sql);
    });
    const handler = await freshHandler();

    await expect(handler({ patientId: PATIENT_ID, doseId: DOSE_ID })).rejects.toThrow(
      /send status is unknown/i,
    );

    const writes = queryMock.mock.calls.filter(([sql]) =>
      /UPDATE outbound_message/i.test(String(sql)),
    );
    const primary = writes.find(([sql]) => isSendFinalizerSql(sql));
    const fallback = writes.find(([sql]) => /status\s*=\s*'sending_unknown'/i.test(String(sql)));
    expect(String(primary?.[0])).toMatch(/AND status IN/i);
    expect(String(primary?.[0])).toMatch(/twilio_sid IS NULL OR twilio_sid = \$1/i);
    expect(String(fallback?.[0])).toMatch(/AND status\s*=\s*'sending'/i);
    expect(storedStatus).toBe('delivered');
  });

  it('never re-sends on the Scheduler retry that follows an ambiguous outcome', async () => {
    wireCheckInUpdateLoss();
    const handler = await freshHandler();
    await expect(handler({ patientId: PATIENT_ID, doseId: DOSE_ID })).rejects.toThrow();

    messagesCreate.mockClear();
    wireDefaults(0); // the retry's reservation loses the ON CONFLICT race
    await expect(handler({ patientId: PATIENT_ID, doseId: DOSE_ID })).resolves.toEqual({
      sent: false,
      reason: 'already-reserved',
    });
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});

describe('outbound handler — Plan 05-01: creates the timeout one-shot after the sent_at UPDATE (PIPE-05)', () => {
  // Real 36-char UUIDs (Phase-3 HIGH-3): `timeout-{uuid}-{uuid}` = 81 chars > the 64-char Scheduler cap,
  // so the name MUST be sliced to 64 while the 45-char `timeout-{patientId}-` NamePrefix stays intact
  // (the STOP/admin sweep still matches). The full doseId travels in Target.Input.
  const P_UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const D_UUID = '9b2e6679-4f89-42de-963d-02d4f4a986aa';

  it('creates a one-shot with the truncated real-UUID name + absolute-UTC at() + UTC tz + DELETE + OFF, targeting the Timeout fn with the FULL doseId', async () => {
    const handler = await freshHandler();
    await handler({ patientId: P_UUID, doseId: D_UUID }, { invokedFunctionArn: OUTBOUND_FN_ARN });

    const cmd = schedulerCall();
    expect(cmd).toBeDefined();
    const input = cmd!.input;

    // Name = `timeout-{patientId}-{doseId}`.slice(0,64); the 45-char `timeout-{patientId}-` prefix survives.
    const expectedName = `timeout-${P_UUID}-${D_UUID}`.slice(0, 64);
    expect(input.Name).toBe(expectedName);
    expect(input.Name).toHaveLength(64);
    expect(String(input.Name).startsWith(`timeout-${P_UUID}-`)).toBe(true);

    expect(input.GroupName).toBe(SCHEDULE_GROUP_NAME);
    // Absolute-UTC at() anchored to the ACTUAL sent_at + the default 120-min window (env unset → shared const).
    expect(input.ScheduleExpression).toBe(buildTimeoutScheduleExpression(SENT_AT, 120));
    expect(input.ScheduleExpression).toBe('at(2099-08-15T16:30:00)');
    expect(input.ScheduleExpressionTimezone).toBe('UTC');
    expect(input.FlexibleTimeWindow).toEqual({ Mode: 'OFF' });
    expect(input.ActionAfterCompletion).toBe('DELETE');

    const target = input.Target as { Arn: string; RoleArn: string; Input: string };
    expect(target.Arn).toBe(TIMEOUT_FN_ARN);
    expect(target.RoleArn).toBe(SCHEDULER_TARGET_ROLE_ARN);
    // The FULL doseId (not the truncated name) rides Target.Input so the Timeout Lambda keys the write.
    expect(JSON.parse(target.Input)).toEqual({ patientId: P_UUID, doseId: D_UUID });
  });

  it('creates the timeout one-shot AFTER the SC6 sent_at UPDATE (never before the send is recorded)', async () => {
    const handler = await freshHandler();
    const order: string[] = [];
    queryMock.mockImplementation((sql: string) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      if (/INSERT INTO outbound_message/i.test(sql))
        return Promise.resolve({ rowCount: 1, rows: [{ id: OUTBOUND_ID }] });
      if (/FROM patient/i.test(sql)) return Promise.resolve({ rowCount: 1, rows: [PATIENT_ROW] });
      if (/FROM outbound_message/i.test(sql) && /FOR UPDATE/i.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [{ status: 'sending' }] });
      }
      if (/RETURNING status_updated_at AS send_started_at/i.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [{ send_started_at: SENT_AT }] });
      }
      if (/UPDATE outbound_message/i.test(sql) && /twilio_sid/i.test(sql)) {
        order.push('sent_at_update');
        return Promise.resolve({ rowCount: 1, rows: [{ sent_at: SENT_AT }] });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    schedulerSend.mockImplementation(async () => {
      order.push('create_schedule');
      return {};
    });
    await handler({ patientId: P_UUID, doseId: D_UUID }, { invokedFunctionArn: OUTBOUND_FN_ARN });
    expect(order).toEqual([
      'sent_at_update',
      'create_schedule',
      'create_schedule',
      'create_schedule',
    ]);
  });

  it('Q3 — a CreateSchedule failure logs a de-identified timeout_schedule_failed and returns success', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    schedulerSend.mockRejectedValue(new Error('scheduler throttled'));
    const handler = await freshHandler();

    // The send already happened — the handler must NOT throw (a Scheduler retry would re-send the SMS).
    const res = await handler({ patientId: P_UUID, doseId: D_UUID });
    expect(res).toEqual({ sent: true, sid: TWILIO_SID });

    const lines = logSpy.mock.calls.map((c) => c.map(String).join(' '));
    const failLine = lines.find((l) => /timeout_schedule_failed/.test(l));
    expect(failLine).toBeDefined();
    expect(failLine!).not.toContain(P_UUID);
    expect(failLine!).not.toContain(D_UUID);
    expect(failLine!).not.toContain('+15145550123');
    logSpy.mockRestore();
  });
});

describe('outbound handler — 08-05 deterministic reminder one-shots', () => {
  it('schedules the configured two reminders evenly at 40 and 80 minutes inside the 120-minute response window', async () => {
    const handler = await freshHandler();

    await handler(
      { patientId: PATIENT_ID, doseId: DOSE_ID },
      { invokedFunctionArn: OUTBOUND_FN_ARN },
    );

    const reminderCommands = schedulerCalls().filter(({ input }) => {
      const target = input.Target as { Input?: string } | undefined;
      return target?.Input ? 'reminderAttempt' in JSON.parse(target.Input) : false;
    });
    expect(reminderCommands).toHaveLength(2);
    expect(reminderCommands.map(({ input }) => input.ScheduleExpression)).toEqual([
      buildTimeoutScheduleExpression(SENT_AT, 40),
      buildTimeoutScheduleExpression(SENT_AT, 80),
    ]);
    expect(reminderCommands.map(({ input }) => input.Name)).toEqual([
      expect.stringMatching(new RegExp(`^reminder-${PATIENT_ID}-.*-1$`)),
      expect.stringMatching(new RegExp(`^reminder-${PATIENT_ID}-.*-2$`)),
    ]);
    expect(new Set(reminderCommands.map(({ input }) => input.Name)).size).toBe(2);
    for (const { input } of reminderCommands) {
      expect(String(input.Name)).toHaveLength(64);
      expect(input.GroupName).toBe(SCHEDULE_GROUP_NAME);
      expect(input.ScheduleExpressionTimezone).toBe('UTC');
      expect(input.FlexibleTimeWindow).toEqual({ Mode: 'OFF' });
      expect(input.ActionAfterCompletion).toBe('DELETE');
      const target = input.Target as { Arn: string; RoleArn: string; Input: string };
      expect(target.Arn).toBe(OUTBOUND_FN_ARN);
      expect(target.RoleArn).toBe(SCHEDULER_TARGET_ROLE_ARN);
      expect(JSON.parse(target.Input)).toMatchObject({ patientId: PATIENT_ID, doseId: DOSE_ID });
    }
  });

  it('schedules no reminder when reminder_limit is zero, while preserving the timeout one-shot', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      if (/INSERT INTO outbound_message/i.test(sql))
        return Promise.resolve({ rowCount: 1, rows: [{ id: OUTBOUND_ID }] });
      if (/FROM patient/i.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [{ ...PATIENT_ROW, reminder_limit: 0 }] });
      }
      if (/FROM outbound_message/i.test(sql) && /FOR UPDATE/i.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [{ status: 'sending' }] });
      }
      if (/RETURNING status_updated_at AS send_started_at/i.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [{ send_started_at: SENT_AT }] });
      }
      if (/UPDATE outbound_message/i.test(sql) && /twilio_sid/i.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [{ sent_at: SENT_AT }] });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    const handler = await freshHandler();

    await handler(
      { patientId: PATIENT_ID, doseId: DOSE_ID },
      { invokedFunctionArn: OUTBOUND_FN_ARN },
    );

    expect(schedulerCalls()).toHaveLength(1);
    expect(schedulerCalls()[0]?.input.Name).toBe(`timeout-${PATIENT_ID}-${DOSE_ID}`.slice(0, 64));
  });

  it('attempts every reminder and returns send success when one reminder schedule creation fails', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    schedulerSend
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('scheduler unavailable'))
      .mockResolvedValueOnce({});
    const handler = await freshHandler();

    await expect(
      handler({ patientId: PATIENT_ID, doseId: DOSE_ID }, { invokedFunctionArn: OUTBOUND_FN_ARN }),
    ).resolves.toEqual({ sent: true, sid: TWILIO_SID });

    expect(schedulerSend).toHaveBeenCalledTimes(3);
    const reminderFailure = logSpy.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.includes('reminder_schedule_failed'));
    expect(reminderFailure).not.toContain(PATIENT_ID);
    expect(reminderFailure).not.toContain(DOSE_ID);
    expect(reminderFailure).not.toContain(PATIENT_ROW.phone);
    logSpy.mockRestore();
  });

  it.each([6, 1.5])(
    'fails closed after the check-in when the stored reminder_limit is invalid (%s)',
    async (reminderLimit) => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      queryMock.mockImplementation((sql: string) => {
        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) {
          return Promise.resolve({ rowCount: 0, rows: [] });
        }
        if (/INSERT INTO outbound_message/i.test(sql)) {
          return Promise.resolve({ rowCount: 1, rows: [{ id: OUTBOUND_ID }] });
        }
        if (/FROM patient/i.test(sql)) {
          return Promise.resolve({
            rowCount: 1,
            rows: [{ ...PATIENT_ROW, reminder_limit: reminderLimit }],
          });
        }
        if (/FROM outbound_message/i.test(sql) && /FOR UPDATE/i.test(sql)) {
          return Promise.resolve({ rowCount: 1, rows: [{ status: 'sending' }] });
        }
        if (/RETURNING status_updated_at AS send_started_at/i.test(sql)) {
          return Promise.resolve({ rowCount: 1, rows: [{ send_started_at: SENT_AT }] });
        }
        if (/UPDATE outbound_message/i.test(sql) && /twilio_sid/i.test(sql)) {
          return Promise.resolve({ rowCount: 1, rows: [{ sent_at: SENT_AT }] });
        }
        return Promise.resolve({ rowCount: 1, rows: [] });
      });
      const handler = await freshHandler();

      await expect(
        handler(
          { patientId: PATIENT_ID, doseId: DOSE_ID },
          { invokedFunctionArn: OUTBOUND_FN_ARN },
        ),
      ).resolves.toEqual({ sent: true, sid: TWILIO_SID });

      expect(schedulerSend).toHaveBeenCalledOnce();
      expect(
        logSpy.mock.calls.some(([line]) => String(line).includes('reminder_schedule_failed')),
      ).toBe(true);
      logSpy.mockRestore();
    },
  );
});

describe('outbound handler — 08-05 reminder send-once invocation', () => {
  function wireReminderClaim(
    options: {
      claim?: boolean;
      preparedStatus?: string;
      updateFailure?: boolean;
      checkInStatus?: string;
    } = {},
  ): void {
    queryMock.mockImplementation((sql: string) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) {
        return Promise.resolve({ rowCount: null, rows: [] });
      }
      if (/INSERT INTO outbound_message/i.test(sql) && /reminder_attempt/i.test(sql)) {
        const status = options.preparedStatus ?? 'prepared';
        return Promise.resolve(
          status === 'prepared' ? { rowCount: 1, rows: [{ status }] } : { rowCount: 0, rows: [] },
        );
      }
      if (/SELECT status[\s\S]*FROM outbound_message/i.test(sql) && /reminder_attempt/i.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [{ status: options.preparedStatus }] });
      }
      if (/FOR UPDATE OF p, ds, ci/i.test(sql)) {
        return Promise.resolve({
          rowCount: 1,
          rows: [
            {
              phone: PATIENT_ROW.phone,
              sent_at: SENT_AT,
              is_active: true,
              agent_enabled: true,
              provider_opted_in: true,
              reminder_limit: 2,
              check_in_status: options.checkInStatus ?? 'queued',
              twilio_sid: 'SM_check_in',
              current_reminder_attempt: 1,
            },
          ],
        });
      }
      if (/SELECT p\.phone/i.test(sql) && /FOR UPDATE OF p/i.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [PATIENT_ROW] });
      }
      if (/SELECT om\.status/i.test(sql) && /callback_token_hash/i.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [{ status: 'sending' }] });
      }
      if (
        /UPDATE outbound_message\s+om/i.test(sql) &&
        /SET status\s*=\s*'sending'/i.test(sql) &&
        /reminder_attempt/i.test(sql)
      ) {
        return Promise.resolve({
          rowCount: options.claim === false ? 0 : 1,
          rows:
            options.claim === false
              ? []
              : [
                  {
                    id: OUTBOUND_ID,
                    body: 'Just a gentle reminder to reply when you can about your medication.',
                  },
                ],
        });
      }
      if (/RETURNING status_updated_at AS send_started_at/i.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [{ send_started_at: SENT_AT }] });
      }
      if (isSendFinalizerSql(sql)) {
        return options.updateFailure
          ? Promise.reject(new Error('connection lost after Twilio acceptance'))
          : Promise.resolve({ rowCount: 1, rows: [{ sent_at: SENT_AT }] });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
  }

  it('durably prepares the real Scheduler attempt before provider setup and sends nothing while it is held', async () => {
    wireReminderClaim({ claim: false });
    const handler = await freshHandler();

    await expect(
      handler({ patientId: PATIENT_ID, doseId: DOSE_ID, reminderAttempt: 1 }),
    ).resolves.toEqual({ sent: false, reason: 'not-eligible-or-already-reserved' });

    const prepared = queryMock.mock.calls.find(
      ([sql]) =>
        /INSERT INTO outbound_message/i.test(String(sql)) && /reminder_attempt/i.test(String(sql)),
    );
    expect(prepared).toBeDefined();
    expect(String(prepared?.[0])).toMatch(/'prepared'/i);
    // Provider setup is intentionally before the atomic claim: a config failure leaves this row
    // prepared rather than stranding it at sending. Held rows may incur these safe reads.
    expect(smSend).toHaveBeenCalledTimes(2); // DB secret + Twilio credentials.
    expect(ssmSend).toHaveBeenCalledOnce();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('leaves the Scheduler attempt prepared when provider configuration fails before the atomic claim', async () => {
    wireReminderClaim();
    ssmSend.mockRejectedValueOnce(new Error('SSM unavailable'));
    const handler = await freshHandler();

    await expect(
      handler({ patientId: PATIENT_ID, doseId: DOSE_ID, reminderAttempt: 1 }),
    ).rejects.toThrow(/SSM unavailable/);

    expect(
      queryMock.mock.calls.some(
        ([sql]) =>
          /INSERT INTO outbound_message/i.test(String(sql)) && /'prepared'/i.test(String(sql)),
      ),
    ).toBe(true);
    expect(
      queryMock.mock.calls.some(
        ([sql]) =>
          /UPDATE outbound_message\s+om/i.test(String(sql)) && /'sending'/i.test(String(sql)),
      ),
    ).toBe(false);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('leaves the Scheduler attempt prepared when callback configuration is missing', async () => {
    wireReminderClaim();
    delete process.env.STATUS_CALLBACK_URL;
    const handler = await freshHandler();

    await expect(
      handler({ patientId: PATIENT_ID, doseId: DOSE_ID, reminderAttempt: 1 }),
    ).rejects.toThrow(/STATUS_CALLBACK_URL/);

    expect(
      queryMock.mock.calls.some(
        ([sql]) =>
          /INSERT INTO outbound_message/i.test(String(sql)) && /'prepared'/i.test(String(sql)),
      ),
    ).toBe(true);
    expect(
      queryMock.mock.calls.some(
        ([sql]) =>
          /UPDATE outbound_message\s+om/i.test(String(sql)) && /'sending'/i.test(String(sql)),
      ),
    ).toBe(false);
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('atomically checks consent/activity/no-response, reserves dose+attempt, sends the stored gentle body, and records queued', async () => {
    wireReminderClaim();
    const handler = await freshHandler();

    await expect(
      handler({ patientId: PATIENT_ID, doseId: DOSE_ID, reminderAttempt: 1 }),
    ).resolves.toEqual({ sent: true, sid: TWILIO_SID });

    const eligibility = queryMock.mock.calls.find(([sql]) =>
      /FOR UPDATE OF p, ds, ci/i.test(String(sql)),
    );
    expect(eligibility).toBeDefined();
    expect(String(eligibility?.[0])).toMatch(/JOIN outbound_message\s+ci/i);
    expect(String(eligibility?.[0])).toMatch(/ci\.message_kind\s*=\s*'check_in'/i);

    const preparation = queryMock.mock.calls.find(
      ([sql]) =>
        /INSERT INTO outbound_message/i.test(String(sql)) && /'prepared'/i.test(String(sql)),
    ) as [string, unknown[]] | undefined;
    expect(preparation).toBeDefined();
    expect(preparation?.[0]).toMatch(/ON CONFLICT \(dose_id, reminder_attempt\)/i);
    expect(preparation?.[1]).toEqual([
      PATIENT_ID,
      DOSE_ID,
      1,
      'Just a gentle reminder to reply when you can about your medication.',
    ]);
    const claim = queryMock.mock.calls.find(
      ([sql]) =>
        /UPDATE outbound_message\s+om/i.test(String(sql)) && /'sending'/i.test(String(sql)),
    ) as [string, unknown[]] | undefined;
    expect(claim?.[0]).toMatch(/status\s*=\s*'prepared'/i);
    expect(claim?.[0]).toMatch(/NOT EXISTS[\s\S]*inbound_reply/i);
    expect(claim?.[0]).toMatch(/NOT EXISTS[\s\S]*adherence_record/i);
    expect(claim?.[0]).toMatch(/NOT EXISTS[\s\S]*clinical_event/i);
    expect(claim?.[0]).toMatch(/callback_token_hash/i);
    // Wave 2: the sixth param is the validated response-window minutes feeding the
    // answered-dose guard's live-check-in scoping.
    expect(claim?.[1]).toEqual([PATIENT_ID, DOSE_ID, 1, SENT_AT, expect.any(Buffer), 120]);
    expect(messagesCreate).toHaveBeenCalledOnce();
    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: PATIENT_ROW.phone,
        body: 'Just a gentle reminder to reply when you can about your medication.',
      }),
    );
    expectOpaqueStatusCallback();
  });

  it.each(['sending', 'sending_unknown'])(
    'sends a reminder after callback recovery proves a %s check-in was accepted',
    async (checkInStatus) => {
      wireReminderClaim({ checkInStatus });
      const handler = await freshHandler();

      await expect(
        handler({ patientId: PATIENT_ID, doseId: DOSE_ID, reminderAttempt: 1 }),
      ).resolves.toEqual({ sent: true, sid: TWILIO_SID });
      expect(messagesCreate).toHaveBeenCalledOnce();

      const prepareSql = String(
        queryMock.mock.calls.find(
          ([sql]) =>
            /INSERT INTO outbound_message/i.test(String(sql)) &&
            /JOIN outbound_message\s+ci/i.test(String(sql)),
        )?.[0],
      );
      expect(prepareSql).toMatch(/ci\.sent_at\s+IS\s+NOT\s+NULL/i);
      expect(prepareSql).toMatch(/ci\.twilio_sid\s+IS\s+NOT\s+NULL/i);
      expect(prepareSql).toMatch(/ci\.status\s+IN\s*\([^)]*'sending'[^)]*'sending_unknown'/i);
    },
  );

  it('suppresses the reminder while a same-patient inbound received after the check-in is still unprocessed (H-04)', async () => {
    wireReminderClaim();
    const handler = await freshHandler();
    await handler({ patientId: PATIENT_ID, doseId: DOSE_ID, reminderAttempt: 1 });

    // Phase-8 inbound rows are not dose-linked on arrival, so the three dose-keyed NOT EXISTS checks
    // cannot see a reply that is stored but not yet classified. The claim must additionally stand down
    // while an inbound received AFTER the check-in still has an incomplete turn_job — otherwise a
    // delayed queue/model path sends a reminder to a patient who already answered.
    const [claimSql, claimParams] = queryMock.mock.calls.find(
      ([sql]) =>
        /UPDATE outbound_message\s+om/i.test(String(sql)) && /'sending'/i.test(String(sql)),
    ) as [string, unknown[]];

    expect(claimSql).toMatch(/NOT EXISTS[\s\S]*turn_job/i);
    expect(claimSql).toMatch(/completed_at\s+IS\s+NULL/i);
    // Anchored to the check-in's own sent_at, so an inbound from BEFORE the check-in cannot suppress it.
    expect(claimSql).toMatch(/received_at\s*>\s*\$4/i);
    expect(claimParams[3]).toBe(SENT_AT);
  });

  it('reads the check-in sent_at under the same lock that authorizes the attempt', async () => {
    wireReminderClaim();
    const handler = await freshHandler();
    await handler({ patientId: PATIENT_ID, doseId: DOSE_ID, reminderAttempt: 1 });

    const [eligibilitySql] = queryMock.mock.calls.find(([sql]) =>
      /FOR UPDATE OF p, ds, ci/i.test(String(sql)),
    ) as [string, unknown[]];
    expect(eligibilitySql).toMatch(/ci\.sent_at/i);
  });

  it('does not send when a raced unprocessed reply makes the claim match zero rows', async () => {
    wireReminderClaim({ claim: false });
    const handler = await freshHandler();

    await expect(
      handler({ patientId: PATIENT_ID, doseId: DOSE_ID, reminderAttempt: 1 }),
    ).resolves.toEqual({ sent: false, reason: 'not-eligible-or-already-reserved' });
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('does not send when the dose+attempt is already reserved', async () => {
    wireReminderClaim({ preparedStatus: 'sending' });
    const handler = await freshHandler();

    await expect(
      handler({ patientId: PATIENT_ID, doseId: DOSE_ID, reminderAttempt: 1 }),
    ).resolves.toEqual({ sent: false, reason: 'not-eligible-or-already-reserved' });
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('records sending_unknown after accepted-but-response-lost and never sends again on replay', async () => {
    wireReminderClaim({ updateFailure: true });
    const handler = await freshHandler();

    await expect(
      handler({ patientId: PATIENT_ID, doseId: DOSE_ID, reminderAttempt: 1 }),
    ).rejects.toThrow(/Reminder outbound send status is unknown/);
    expect(messagesCreate).toHaveBeenCalledOnce();
    expect(
      queryMock.mock.calls.some(([sql]) => /status\s*=\s*'sending_unknown'/i.test(String(sql))),
    ).toBe(true);

    messagesCreate.mockClear();
    wireReminderClaim({ claim: false, preparedStatus: 'sending_unknown' });
    await expect(
      handler({ patientId: PATIENT_ID, doseId: DOSE_ID, reminderAttempt: 1 }),
    ).resolves.toEqual({ sent: false, reason: 'not-eligible-or-already-reserved' });
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('keeps an invalid-SID reminder ambiguous without creating a sent_at anchor', async () => {
    wireReminderClaim();
    messagesCreate.mockResolvedValue({ sid: '' });
    const handler = await freshHandler();

    await expect(
      handler({ patientId: PATIENT_ID, doseId: DOSE_ID, reminderAttempt: 1 }),
    ).rejects.toThrow(/Reminder outbound send status is unknown/);

    const ambiguous = queryMock.mock.calls.find(
      ([sql, params]) =>
        /UPDATE outbound_message/i.test(String(sql)) &&
        Array.isArray(params) &&
        params[0] === 'sending_unknown',
    ) as [string, unknown[]] | undefined;
    expect(ambiguous).toBeDefined();
    expect(ambiguous?.[0]).not.toMatch(/sent_at\s*=/i);
  });

  it.each([
    [
      'definitive provider rejection',
      Object.assign(new Error('recipient rejected'), { status: 400 }),
      'failed',
    ],
    ['ambiguous response loss', new Error('socket reset after write'), 'sending_unknown'],
  ])('terminalizes %s without a hidden provider retry', async (_label, failure, status) => {
    wireReminderClaim();
    messagesCreate.mockRejectedValue(failure);
    const handler = await freshHandler();

    await expect(
      handler({ patientId: PATIENT_ID, doseId: DOSE_ID, reminderAttempt: 1 }),
    ).rejects.toThrow(
      status === 'failed'
        ? /Reminder outbound send did not complete/
        : /Reminder outbound send status is unknown/,
    );

    expect(messagesCreate).toHaveBeenCalledOnce();
    const terminal = queryMock.mock.calls.find(
      ([sql, params]) =>
        /UPDATE outbound_message/i.test(String(sql)) &&
        Array.isArray(params) &&
        params[0] === status,
    );
    expect(terminal).toBeDefined();
  });

  it('rejects invalid attempts and extra keys before database or provider work', async () => {
    const handler = await freshHandler();
    await expect(
      handler({ patientId: PATIENT_ID, doseId: DOSE_ID, reminderAttempt: 0 }),
    ).rejects.toThrow();
    await expect(
      handler({ patientId: PATIENT_ID, doseId: DOSE_ID, reminderAttempt: 1, body: 'smuggled' }),
    ).rejects.toThrow();
    expect(queryMock).not.toHaveBeenCalled();
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});

describe('outbound handler — accepted-but-ack-lost check-in lifecycle recovery', () => {
  function wireRecovery(messageKind = 'check_in', eligible = true): void {
    wireDefaults();
    queryMock.mockImplementation((sql: string) => {
      if (/FROM outbound_message om[\s\S]*JOIN patient/i.test(sql)) {
        return Promise.resolve({
          rowCount: eligible ? 1 : 0,
          rows: eligible
            ? [
                {
                  id: OUTBOUND_ID,
                  patient_id: PATIENT_ID,
                  dose_id: DOSE_ID,
                  message_kind: messageKind,
                  sent_at: SENT_AT,
                  reminder_limit: 2,
                },
              ]
            : [],
        });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
  }

  it('creates the missing timeout and reminders with deterministic names and treats retry conflicts as success', async () => {
    wireRecovery();
    const handler = await freshHandler();
    const event = { outboundMessageId: OUTBOUND_ID };

    await expect(handler(event, { invokedFunctionArn: OUTBOUND_FN_ARN })).resolves.toEqual({
      sent: false,
      reason: 'lifecycle-recovered',
    });
    const firstNames = schedulerCalls().map(({ input }) => input.Name);
    expect(firstNames).toHaveLength(3);
    expect(new Set(firstNames).size).toBe(3);

    schedulerSend.mockRejectedValue(
      Object.assign(new Error('already exists'), { name: 'ConflictException' }),
    );
    await expect(handler(event, { invokedFunctionArn: OUTBOUND_FN_ARN })).resolves.toEqual({
      sent: false,
      reason: 'lifecycle-recovered',
    });
    const retryNames = schedulerCalls()
      .slice(3)
      .map(({ input }) => input.Name);
    expect(retryNames).toEqual(firstNames);
  });

  it.each(['acknowledgement', 'reminder'])(
    '%s recovery events never create check-in lifecycle schedules',
    async (messageKind) => {
      wireRecovery(messageKind);
      const handler = await freshHandler();

      await expect(
        handler({ outboundMessageId: OUTBOUND_ID }, { invokedFunctionArn: OUTBOUND_FN_ARN }),
      ).resolves.toEqual({ sent: false, reason: 'not-eligible' });
      expect(schedulerSend).not.toHaveBeenCalled();
    },
  );

  it('disabled or already-answered check-ins no-op safely', async () => {
    wireRecovery('check_in', false);
    const handler = await freshHandler();

    await expect(
      handler({ outboundMessageId: OUTBOUND_ID }, { invokedFunctionArn: OUTBOUND_FN_ARN }),
    ).resolves.toEqual({ sent: false, reason: 'not-eligible' });
    expect(schedulerSend).not.toHaveBeenCalled();

    const recoverySql = String(queryMock.mock.calls[0]?.[0]);
    expect(recoverySql).toMatch(/p\.is_active\s*=\s*true/i);
    expect(recoverySql).toMatch(/NOT EXISTS[\s\S]*inbound_reply/i);
    expect(recoverySql).toMatch(/NOT EXISTS[\s\S]*adherence_record/i);
    expect(recoverySql).toMatch(/NOT EXISTS[\s\S]*clinical_event/i);
  });
});

describe('outbound handler — H1: a raced opt-out (patient inactive) → clean skip, no send (P4 hotfix)', () => {
  it('when the patient row exists but is_active=false, returns { sent:false, reason:patient-inactive } with NO Twilio send, NO reservation, NO schedule', async () => {
    // The Outbound patient SELECT now re-reads is_active: a STOP that raced in after the schedule fired
    // must skip cleanly (mirror the reserved-skip), NEVER throw the not-found error (which would trip the
    // OPS-02 pipeline-error alarm on an entirely expected condition).
    queryMock.mockImplementation((sql: string) => {
      if (/FROM patient/i.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [{ ...PATIENT_ROW, is_active: false }] });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    const handler = await freshHandler();
    const res = await handler({ patientId: PATIENT_ID, doseId: DOSE_ID });

    expect(res).toEqual({ sent: false, reason: 'patient-inactive' });
    expect(messagesCreate).not.toHaveBeenCalled();
    // No reservation INSERT (the skip is before it) and no timeout schedule.
    expect(
      queryMock.mock.calls.some((c) => /INSERT INTO outbound_message/i.test(String(c[0]))),
    ).toBe(false);
    expect(schedulerCall()).toBeUndefined();
  });

  it('the H1 skip is decided by re-reading is_active in the patient SELECT', async () => {
    const handler = await freshHandler();
    await handler({ patientId: PATIENT_ID, doseId: DOSE_ID });
    const selectCall = queryMock.mock.calls.find((c) => /FROM patient/i.test(String(c[0])));
    expect(selectCall).toBeDefined();
    expect(String(selectCall![0])).toMatch(/is_active/i);
  });

  it('skips a stale scheduled dose after STOP disables provider and agent messaging without deactivating the patient', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (/FROM patient/i.test(sql)) {
        return Promise.resolve({
          rowCount: 1,
          rows: [{ ...PATIENT_ROW, agent_enabled: false, provider_opted_in: false }],
        });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    });
    const handler = await freshHandler();

    await expect(handler({ patientId: PATIENT_ID, doseId: DOSE_ID })).resolves.toEqual({
      sent: false,
      reason: 'messaging-disabled',
    });
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(connectMock).not.toHaveBeenCalled();
    expect(schedulerSend).not.toHaveBeenCalled();
  });
});

describe('outbound handler — env / payload guards', () => {
  it('throws when the Scheduler payload lacks patientId/doseId', async () => {
    const handler = await freshHandler();
    await expect(handler({ patientId: '', doseId: '' } as never)).rejects.toThrow();
    expect(Pool).not.toHaveBeenCalled();
  });
});
