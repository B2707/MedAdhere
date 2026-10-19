/**
 * stop-sweep.integration.test.ts — the H1 STOP-sweep integration proof (Plan 05-01).
 *
 * This is the runtime companion to the infra synth test (infra/test/inbound.test.ts asserts InboundFn
 * now carries scheduler:ListSchedules(*+region) + DeleteSchedule(group-scoped)). Here we prove the STOP
 * path actually SWEEPS the `dose-`, `reminder-`, and `timeout-` schedule prefixes end-to-end: unlike
 * inbound/handler.test.ts (which mocks `../lib/scheduler-deactivate` entirely), this test mocks ONLY the
 * @aws-sdk/client-scheduler SDK boundary — so the REAL deactivateSchedules runs and issues real
 * ListSchedules + DeleteSchedule commands for both prefixes (the scheduler-deactivate.test.ts posture,
 * driven through the inbound handler). A true live-AWS test would prove the IAM resolves at runtime, but
 * that costs money and is out of scope; the synth test covers the grant, this covers the sweep behavior.
 *
 * Twilio's real validateRequest / getExpectedTwilioSignature exercise the genuine HMAC pipeline;
 * no Twilio REST client is constructed by the handler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, smSend, sqsSend, reserveMock, markEnqueuedMock, schedulerSend, sweepStopMock } =
  vi.hoisted(() => {
    return {
      queryMock: vi.fn(),
      smSend: vi.fn(),
      sqsSend: vi.fn(),
      reserveMock: vi.fn(),
      markEnqueuedMock: vi.fn(),
      sweepStopMock: vi.fn(),
      // The SDK boundary — the REAL deactivateSchedules issues List/Delete against this spy.
      schedulerSend: vi.fn(),
    };
  });

vi.mock('pg', () => ({
  Pool: vi.fn(function () {
    return { query: queryMock, end: vi.fn() };
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

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn(function () {
    return { send: sqsSend };
  }),
  SendMessageCommand: vi.fn(function (input: unknown) {
    return { __type: 'SendMessage', input };
  }),
}));

vi.mock('./intake-repository.js', () => ({
  reserveInboundIntake: reserveMock,
  markInboundEnqueued: markEnqueuedMock,
  sweepStopSchedulesUnderCurrentEpoch: sweepStopMock,
}));

// SDK-boundary mock (NOT the deactivateSchedules helper — that runs for real).
vi.mock('@aws-sdk/client-scheduler', () => ({
  SchedulerClient: vi.fn(function () {
    return { send: schedulerSend };
  }),
  ListSchedulesCommand: vi.fn(function (input: Record<string, unknown>) {
    return { __type: 'list', input };
  }),
  DeleteScheduleCommand: vi.fn(function (input: Record<string, unknown>) {
    return { __type: 'delete', input };
  }),
}));

import twilio from 'twilio';

async function freshHandler() {
  vi.resetModules();
  const mod = await import('./handler.js');
  return mod.handler;
}

const AUTH_TOKEN = 'tok_supersecret_authtoken';
const DB_SECRET = JSON.stringify({ username: 'medadhere_admin', password: 'pw' });
const TWILIO_SECRET = JSON.stringify({ accountSid: 'AC_test', authToken: AUTH_TOKEN });
const INBOUND_URL = 'https://xyz789.execute-api.us-east-1.amazonaws.com/twilio/inbound';
// Real 36-char UUID (Phase-3 HIGH-3).
const PATIENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const INBOUND_ID = '7c9e6679-7425-40de-963d-02d4f4a986e1';
const PATIENT_PHONE = '+15145550123';

function signFor(params: Record<string, string>): string {
  const signer = (
    twilio as unknown as {
      getExpectedTwilioSignature: (t: string, u: string, p: Record<string, string>) => string;
    }
  ).getExpectedTwilioSignature;
  return signer(AUTH_TOKEN, INBOUND_URL, params);
}

function stopEvent(overrides: Record<string, string> = {}) {
  const params: Record<string, string> = {
    MessageSid: 'SM_stop_1',
    AccountSid: 'AC_test',
    From: PATIENT_PHONE,
    To: '+15005550006',
    Body: 'ordinary body to prove OptOutType is authoritative',
    OptOutType: 'STOP',
    ...overrides,
  };
  const body = new URLSearchParams(params).toString();
  return {
    body: Buffer.from(body, 'utf8').toString('base64'),
    isBase64Encoded: true,
    headers: { 'X-Twilio-Signature': signFor(params) },
  };
}

/** Every DeleteScheduleCommand Name issued through the SDK boundary. */
function deletedNames(): string[] {
  return (schedulerSend.mock.calls as Array<[{ __type: string; input: { Name?: string } }]>)
    .map((c) => c[0])
    .filter((cmd) => cmd.__type === 'delete')
    .map((cmd) => cmd.input.Name ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:db';
  process.env.DB_HOST = 'db.internal';
  process.env.DB_PORT = '5432';
  process.env.DB_NAME = 'medadhere';
  process.env.TWILIO_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:twilio';
  process.env.INBOUND_URL = INBOUND_URL;
  process.env.QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/inbound.fifo';

  smSend.mockImplementation((cmd: { __args?: { SecretId?: string } }) => {
    const id = cmd.__args?.SecretId ?? '';
    if (id.includes('twilio')) return Promise.resolve({ SecretString: TWILIO_SECRET });
    return Promise.resolve({ SecretString: DB_SECRET });
  });

  queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
  reserveMock.mockResolvedValue({
    kind: 'new',
    patientId: PATIENT_ID,
    inboundMessageId: INBOUND_ID,
    inboundSequence: 1,
    shouldEnqueue: false,
    shouldSweepSchedules: true,
  });
  sweepStopMock.mockImplementation(
    async (_db: unknown, _input: unknown, sweep: () => Promise<void>) => {
      await sweep();
      return true;
    },
  );

  // The SDK boundary: ListSchedules returns ONE schedule per requested NamePrefix,
  // so the real deactivateSchedules deletes exactly one under each prefix.
  schedulerSend.mockImplementation(
    async (cmd: { __type: string; input: Record<string, unknown> }) => {
      if (cmd.__type === 'list') {
        const prefix = String(cmd.input.NamePrefix ?? '');
        return { Schedules: [{ Name: `${prefix}sched`.slice(0, 64) }], NextToken: undefined };
      }
      return {};
    },
  );
});

describe('H1 — the STOP sweep deletes dose, reminder, and timeout schedules through the real SDK path', () => {
  it('a signed OptOutType=STOP drives all three real prefix sweeps without an app reply', async () => {
    const handler = await freshHandler();
    const res = await handler(stopEvent());

    // Twilio Advanced Opt-Out sends its own STOP ack — the handler returns empty TwiML, no queue wake.
    expect(res.statusCode).toBe(200);
    expect(sqsSend).not.toHaveBeenCalled();
    expect(markEnqueuedMock).not.toHaveBeenCalled();

    // Consent state changed atomically in the real intake repository lane; the handler does not issue
    // a second non-atomic patient update.
    expect(queryMock.mock.calls.some((c) => /UPDATE patient/i.test(String(c[0])))).toBe(false);

    // All prefixes were swept via the REAL deactivateSchedules → real DeleteScheduleCommand issued.
    const deleted = deletedNames();
    expect(deleted.some((n) => n.startsWith(`dose-${PATIENT_ID}-`))).toBe(true);
    expect(deleted.some((n) => n.startsWith(`reminder-${PATIENT_ID}-`))).toBe(true);
    expect(deleted.some((n) => n.startsWith(`timeout-${PATIENT_ID}-`))).toBe(true);

    // And the List side was keyed by both trailing-dash NamePrefixes (the sweep-catches-truncation contract).
    const listPrefixes = (
      schedulerSend.mock.calls as Array<[{ __type: string; input: { NamePrefix?: string } }]>
    )
      .map((c) => c[0])
      .filter((cmd) => cmd.__type === 'list')
      .map((cmd) => cmd.input.NamePrefix);
    expect(listPrefixes).toContain(`dose-${PATIENT_ID}-`);
    expect(listPrefixes).toContain(`reminder-${PATIENT_ID}-`);
    expect(listPrefixes).toContain(`timeout-${PATIENT_ID}-`);
  });

  it('repeats all three idempotent sweeps for a duplicate STOP delivery', async () => {
    reserveMock.mockResolvedValue({
      kind: 'duplicate',
      patientId: PATIENT_ID,
      inboundMessageId: INBOUND_ID,
      inboundSequence: 1,
      shouldEnqueue: false,
      shouldSweepSchedules: true,
    });
    const handler = await freshHandler();
    await handler(stopEvent());

    expect(deletedNames().filter((name) => name.startsWith(`dose-${PATIENT_ID}-`))).toHaveLength(1);
    expect(
      deletedNames().filter((name) => name.startsWith(`reminder-${PATIENT_ID}-`)),
    ).toHaveLength(1);
    expect(deletedNames().filter((name) => name.startsWith(`timeout-${PATIENT_ID}-`))).toHaveLength(
      1,
    );
    expect(sqsSend).not.toHaveBeenCalled();
    expect(queryMock.mock.calls.some((call) => /UPDATE patient/i.test(String(call[0])))).toBe(
      false,
    );
  });

  it('makes no Scheduler call when the locked intake transaction denies a stale STOP replay', async () => {
    reserveMock.mockResolvedValue({
      kind: 'duplicate',
      patientId: PATIENT_ID,
      inboundMessageId: INBOUND_ID,
      inboundSequence: 1,
      shouldEnqueue: false,
      shouldSweepSchedules: false,
    });
    const handler = await freshHandler();
    await handler(stopEvent());

    expect(schedulerSend).not.toHaveBeenCalled();
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it('uses the locked durable STOP authorization even when duplicate replay fields now parse as START', async () => {
    reserveMock.mockResolvedValue({
      kind: 'duplicate',
      patientId: PATIENT_ID,
      inboundMessageId: INBOUND_ID,
      inboundSequence: 1,
      shouldEnqueue: false,
      shouldSweepSchedules: true,
    });
    const handler = await freshHandler();
    await handler(stopEvent({ Body: 'START', OptOutType: 'START' }));

    expect(deletedNames().filter((name) => name.startsWith(`dose-${PATIENT_ID}-`))).toHaveLength(1);
    expect(
      deletedNames().filter((name) => name.startsWith(`reminder-${PATIENT_ID}-`)),
    ).toHaveLength(1);
    expect(deletedNames().filter((name) => name.startsWith(`timeout-${PATIENT_ID}-`))).toHaveLength(
      1,
    );
    expect(sqsSend).not.toHaveBeenCalled();
  });
});
