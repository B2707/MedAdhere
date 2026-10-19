import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  poolArgs,
  poolQuery,
  smSend,
  sqsSend,
  reserveMock,
  sweepStopMock,
  markEnqueuedMock,
  buildWakeMock,
  deactivateMock,
} = vi.hoisted(() => ({
  poolArgs: [] as Array<Record<string, unknown>>,
  poolQuery: vi.fn(),
  smSend: vi.fn(),
  sqsSend: vi.fn(),
  reserveMock: vi.fn(),
  sweepStopMock: vi.fn(),
  markEnqueuedMock: vi.fn(),
  buildWakeMock: vi.fn(),
  deactivateMock: vi.fn(),
}));

vi.mock('pg', () => ({
  Pool: vi.fn(function (config: Record<string, unknown>) {
    poolArgs.push(config);
    return { query: poolQuery, connect: vi.fn(), end: vi.fn() };
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

vi.mock('../lib/scheduler-deactivate', () => ({
  deactivateSchedules: deactivateMock,
}));

vi.mock('@medadhere/shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildInitialInboundReplyWake: buildWakeMock,
}));

import { Pool } from 'pg';
import twilio from 'twilio';
import {
  HELP_AUTO_REPLY,
  INTAKE_LIMIT_NOTICE,
  MEDIA_UNSUPPORTED_REPLY,
  SAFETY_AUTO_REPLY_EMERGENCY,
  safetyAutoReplyEmergency,
} from '@medadhere/shared';

const AUTH_TOKEN = 'tok_supersecret_authtoken';
const ROTATED_AUTH_TOKEN = 'tok_rotated_supersecret_authtoken';
const DB_SECRET = JSON.stringify({ username: 'medadhere_admin', password: 'pw' });
const TWILIO_SECRET = JSON.stringify({ accountSid: 'AC_test', authToken: AUTH_TOKEN });
const INBOUND_URL = 'https://xyz789.execute-api.us-east-1.amazonaws.com/twilio/inbound';
const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/inbound.fifo';
const PATIENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const INBOUND_ID = '7c9e6679-7425-40de-963d-02d4f4a986e1';
const SAFETY_ID = '9b2e6679-4f89-42de-963d-02d4f4a986aa';
const PATIENT_PHONE = '+15145550123';
const MESSAGE_SID = 'SM11111111111111111111111111111111';
const BENIGN_BODY = 'took it this morning';
const EMERGENCY_BODY = 'having chest pain and cannot breathe';

async function freshHandler() {
  vi.resetModules();
  return (await import('./handler.js')).handler;
}

function signFor(
  params: Record<string, string>,
  authToken = AUTH_TOKEN,
  url = INBOUND_URL,
): string {
  return twilio.getExpectedTwilioSignature(authToken, url, params);
}

function fullInboundParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    MessageSid: MESSAGE_SID,
    AccountSid: 'AC_test',
    From: PATIENT_PHONE,
    To: '+15005550006',
    Body: BENIGN_BODY,
    NumMedia: '0',
    ApiVersion: '2010-04-01',
    ...overrides,
  };
}

function eventFor(
  params: Record<string, string>,
  options: { readonly signParams?: Record<string, string>; readonly signature?: string } = {},
) {
  const form = new URLSearchParams(params).toString();
  return {
    body: Buffer.from(form, 'utf8').toString('base64'),
    isBase64Encoded: true,
    headers: {
      'X-Twilio-Signature': options.signature ?? signFor(options.signParams ?? params),
    },
  };
}

function newReservation(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'new',
    patientId: PATIENT_ID,
    inboundMessageId: INBOUND_ID,
    inboundSequence: 1,
    shouldEnqueue: true,
    shouldSweepSchedules: false,
    preferredLanguage: 'en',
    ...overrides,
  };
}

function wakeInput() {
  return {
    QueueUrl: QUEUE_URL,
    MessageBody: JSON.stringify({ inboundMessageId: INBOUND_ID }),
    MessageGroupId: PATIENT_ID,
    MessageDeduplicationId: `sid:${MESSAGE_SID}`,
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function logLines(): readonly string[] {
  return [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls].map((call) =>
    call.map(String).join(' '),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  poolArgs.length = 0;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:db';
  process.env.DB_HOST = 'db.internal';
  process.env.DB_PORT = '5432';
  process.env.DB_NAME = 'medadhere';
  process.env.TWILIO_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:twilio';
  process.env.INBOUND_URL = INBOUND_URL;
  process.env.QUEUE_URL = QUEUE_URL;

  smSend.mockImplementation((command: { __args?: { SecretId?: string } }) =>
    Promise.resolve({
      SecretString: command.__args?.SecretId?.includes('twilio') ? TWILIO_SECRET : DB_SECRET,
    }),
  );
  reserveMock.mockResolvedValue(newReservation());
  sweepStopMock.mockImplementation(
    async (_db: unknown, _input: unknown, sweep: () => Promise<void>) => {
      await sweep();
      return true;
    },
  );
  markEnqueuedMock.mockResolvedValue(undefined);
  buildWakeMock.mockReturnValue(wakeInput());
  sqsSend.mockResolvedValue({ MessageId: '11111111-1111-4111-8111-111111111111' });
  deactivateMock.mockResolvedValue(2);
  poolQuery.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe('inbound authentication and ordinary queue handoff', () => {
  it('authenticates, stores atomically, sends an id-only patient-group wake, then stamps handoff', async () => {
    const handler = await freshHandler();
    const response = await handler(eventFor(fullInboundParams()));

    expect(response).toMatchObject({ statusCode: 200, headers: { 'content-type': 'text/xml' } });
    expect(reserveMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        phone: PATIENT_PHONE,
        rawBody: BENIGN_BODY,
        emergencyCategory: null,
        messageSid: MESSAGE_SID,
        createTurnJob: true,
        control: null,
      }),
    );
    expect(buildWakeMock).toHaveBeenCalledWith({
      queueUrl: QUEUE_URL,
      inboundMessageId: INBOUND_ID,
      patientId: PATIENT_ID,
      messageSid: MESSAGE_SID,
    });
    expect(sqsSend).toHaveBeenCalledWith({ __type: 'SendMessage', input: wakeInput() });
    expect(markEnqueuedMock).toHaveBeenCalledWith(expect.anything(), INBOUND_ID);
    expect(sqsSend.mock.invocationCallOrder[0]).toBeLessThan(
      markEnqueuedMock.mock.invocationCallOrder[0]!,
    );
  });

  it('rejects a tampered signed body before DB or SQS work', async () => {
    const handler = await freshHandler();
    const original = fullInboundParams();
    const response = await handler(
      eventFor({ ...original, Body: 'STOP' }, { signParams: original }),
    );

    expect(response.statusCode).toBe(403);
    expect(Pool).not.toHaveBeenCalled();
    expect(reserveMock).not.toHaveBeenCalled();
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it('uses AWSCURRENT on every warm invocation so rotated Twilio credentials take effect', async () => {
    let currentAuthToken = AUTH_TOKEN;
    smSend.mockImplementation(
      (command: { __args?: { SecretId?: string; VersionStage?: string } }) =>
        Promise.resolve({
          SecretString: command.__args?.SecretId?.includes('twilio')
            ? JSON.stringify({ accountSid: 'AC_test', authToken: currentAuthToken })
            : DB_SECRET,
        }),
    );
    const handler = await freshHandler();
    const params = fullInboundParams();

    await expect(handler(eventFor(params))).resolves.toMatchObject({ statusCode: 200 });
    currentAuthToken = ROTATED_AUTH_TOKEN;

    await expect(
      handler(eventFor(params, { signature: signFor(params, AUTH_TOKEN) })),
    ).resolves.toMatchObject({ statusCode: 403 });
    expect(reserveMock).toHaveBeenCalledTimes(1);
    await expect(
      handler(eventFor(params, { signature: signFor(params, ROTATED_AUTH_TOKEN) })),
    ).resolves.toMatchObject({ statusCode: 200 });

    const twilioSecretReads = smSend.mock.calls
      .map(([command]) => command as { __args?: { SecretId?: string; VersionStage?: string } })
      .filter((command) => command.__args?.SecretId?.includes('twilio'));
    expect(twilioSecretReads).toHaveLength(3);
    expect(
      twilioSecretReads.every((command) => command.__args?.VersionStage === 'AWSCURRENT'),
    ).toBe(true);
  });

  it('returns retryable 503 and leaves enqueued_at null when SQS rejects the normal wake', async () => {
    sqsSend.mockRejectedValue(new Error('queue unavailable'));
    const handler = await freshHandler();
    const response = await handler(eventFor(fullInboundParams()));

    expect(response.statusCode).toBe(503);
    expect(markEnqueuedMock).not.toHaveBeenCalled();
    expect(logLines().some((line) => line.includes('inbound_enqueue_failure'))).toBe(true);
  });

  it('returns retryable 503 when the post-send enqueue stamp fails', async () => {
    markEnqueuedMock.mockRejectedValue(new Error('database unavailable'));
    const handler = await freshHandler();
    const response = await handler(eventFor(fullInboundParams()));

    expect(response.statusCode).toBe(503);
    expect(sqsSend).toHaveBeenCalledOnce();
    expect(logLines().some((line) => line.includes('inbound_enqueue_stamp_failure'))).toBe(true);
  });

  it('reuses the same durable turn and FIFO dedup key when SQS accepted the wake but the stamp failed', async () => {
    reserveMock
      .mockResolvedValueOnce(newReservation())
      .mockResolvedValueOnce(newReservation({ kind: 'duplicate' }));
    markEnqueuedMock
      .mockRejectedValueOnce(new Error('database unavailable after SQS acceptance'))
      .mockResolvedValueOnce(undefined);
    const handler = await freshHandler();

    await expect(handler(eventFor(fullInboundParams()))).resolves.toMatchObject({
      statusCode: 503,
    });
    await expect(handler(eventFor(fullInboundParams()))).resolves.toMatchObject({
      statusCode: 200,
    });

    expect(reserveMock).toHaveBeenCalledTimes(2);
    expect(sqsSend).toHaveBeenCalledTimes(2);
    expect(sqsSend.mock.calls.map(([command]) => command)).toEqual([
      { __type: 'SendMessage', input: wakeInput() },
      { __type: 'SendMessage', input: wakeInput() },
    ]);
    expect(markEnqueuedMock).toHaveBeenCalledTimes(2);
  });

  it('stores first and returns 503 when queue configuration is absent', async () => {
    delete process.env.QUEUE_URL;
    const handler = await freshHandler();
    const response = await handler(eventFor(fullInboundParams()));

    expect(reserveMock).toHaveBeenCalledOnce();
    expect(response.statusCode).toBe(503);
    expect(sqsSend).not.toHaveBeenCalled();
  });
});

describe('inbound duplicate recovery', () => {
  it('republishes an incomplete duplicate with no successful handoff stamp', async () => {
    reserveMock.mockResolvedValue(newReservation({ kind: 'duplicate' }));
    const handler = await freshHandler();
    const response = await handler(eventFor(fullInboundParams()));

    expect(response.statusCode).toBe(200);
    expect(sqsSend).toHaveBeenCalledOnce();
    expect(markEnqueuedMock).toHaveBeenCalledOnce();
  });

  it.each(['queued', 'completed'])('suppresses an already %s duplicate', async () => {
    reserveMock.mockResolvedValue(newReservation({ kind: 'duplicate', shouldEnqueue: false }));
    const handler = await freshHandler();
    const response = await handler(eventFor(fullInboundParams()));

    expect(response.statusCode).toBe(200);
    expect(sqsSend).not.toHaveBeenCalled();
    expect(markEnqueuedMock).not.toHaveBeenCalled();
  });
});

describe('inbound provider consent controls', () => {
  it('trusts signed OptOutType=STOP over Body, stores no job, and sweeps all three schedule prefixes', async () => {
    reserveMock.mockResolvedValue(
      newReservation({ shouldEnqueue: false, shouldSweepSchedules: true }),
    );
    const handler = await freshHandler();
    const response = await handler(
      eventFor(fullInboundParams({ Body: 'This body is not a control word', OptOutType: 'STOP' })),
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('<Message>');
    expect(reserveMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ control: 'stop', createTurnJob: false }),
    );
    expect(sweepStopMock).toHaveBeenCalledWith(
      expect.anything(),
      { patientId: PATIENT_ID, inboundMessageId: INBOUND_ID },
      expect.any(Function),
    );
    expect(deactivateMock).toHaveBeenNthCalledWith(1, PATIENT_ID, 'dose');
    expect(deactivateMock).toHaveBeenNthCalledWith(2, PATIENT_ID, 'reminder');
    expect(deactivateMock).toHaveBeenNthCalledWith(3, PATIENT_ID, 'timeout');
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it('re-sweeps schedules for a duplicate STOP SID without queueing model work', async () => {
    reserveMock.mockResolvedValue(
      newReservation({
        kind: 'duplicate',
        shouldEnqueue: false,
        shouldSweepSchedules: true,
      }),
    );
    const handler = await freshHandler();
    const response = await handler(
      eventFor(fullInboundParams({ Body: 'STOP', OptOutType: 'STOP' })),
    );

    expect(response.statusCode).toBe(200);
    expect(deactivateMock).toHaveBeenNthCalledWith(1, PATIENT_ID, 'dose');
    expect(deactivateMock).toHaveBeenNthCalledWith(2, PATIENT_ID, 'reminder');
    expect(deactivateMock).toHaveBeenNthCalledWith(3, PATIENT_ID, 'timeout');
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it('does not sweep schedules when the locked repository denies a stale STOP replay', async () => {
    reserveMock.mockResolvedValue(
      newReservation({
        kind: 'duplicate',
        shouldEnqueue: false,
        shouldSweepSchedules: false,
      }),
    );
    const handler = await freshHandler();
    await handler(eventFor(fullInboundParams({ Body: 'STOP', OptOutType: 'STOP' })));

    expect(deactivateMock).not.toHaveBeenCalled();
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it('uses the locked repository authorization instead of re-deriving a duplicate sweep from replay fields', async () => {
    reserveMock.mockResolvedValue(
      newReservation({
        kind: 'duplicate',
        shouldEnqueue: false,
        shouldSweepSchedules: true,
      }),
    );
    const handler = await freshHandler();
    await handler(eventFor(fullInboundParams({ Body: 'START', OptOutType: 'START' })));

    expect(deactivateMock).toHaveBeenNthCalledWith(1, PATIENT_ID, 'dose');
    expect(deactivateMock).toHaveBeenNthCalledWith(2, PATIENT_ID, 'reminder');
    expect(deactivateMock).toHaveBeenNthCalledWith(3, PATIENT_ID, 'timeout');
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it('records signed OptOutType=START without re-enabling the agent, scheduling, queueing, or replying', async () => {
    reserveMock.mockResolvedValue(newReservation({ shouldEnqueue: false }));
    const handler = await freshHandler();
    const response = await handler(
      eventFor(fullInboundParams({ Body: 'anything', OptOutType: 'START' })),
    );

    expect(response).toMatchObject({ statusCode: 200 });
    expect(response.body).not.toContain('<Message>');
    expect(reserveMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ control: 'start', createTurnJob: false }),
    );
    expect(deactivateMock).not.toHaveBeenCalled();
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it('lets signed OptOutType override a contradictory body keyword', async () => {
    reserveMock.mockResolvedValue(newReservation({ shouldEnqueue: false }));
    const handler = await freshHandler();
    await handler(eventFor(fullInboundParams({ Body: 'STOP', OptOutType: 'START' })));

    expect(reserveMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ control: 'start', createTurnJob: false }),
    );
    expect(deactivateMock).not.toHaveBeenCalled();
  });

  it('does not trust OptOutType from a body that fails HMAC authentication', async () => {
    const original = fullInboundParams({ Body: 'ordinary' });
    const handler = await freshHandler();
    const response = await handler(
      eventFor({ ...original, OptOutType: 'STOP' }, { signParams: original }),
    );

    expect(response.statusCode).toBe(403);
    expect(reserveMock).not.toHaveBeenCalled();
    expect(deactivateMock).not.toHaveBeenCalled();
  });

  it('does not deactivate, sweep, or queue when intake rejects a cross-patient SID collision', async () => {
    reserveMock.mockRejectedValue(new Error('MessageSid is already assigned to another patient'));
    const handler = await freshHandler();
    const response = await handler(
      eventFor(fullInboundParams({ Body: 'STOP', OptOutType: 'STOP' })),
    );

    expect(response.statusCode).toBe(503);
    expect(deactivateMock).not.toHaveBeenCalled();
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it('does not duplicate Twilio Advanced Opt-Out HELP confirmation', async () => {
    reserveMock.mockResolvedValue(newReservation({ shouldEnqueue: false }));
    const handler = await freshHandler();
    const response = await handler(
      eventFor(fullInboundParams({ Body: 'anything', OptOutType: 'HELP' })),
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('<Message>');
    expect(reserveMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ control: 'help', createTurnJob: false }),
    );
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it('keeps the legacy exact HELP fallback when OptOutType is absent', async () => {
    reserveMock.mockResolvedValue(newReservation({ shouldEnqueue: false }));
    const handler = await freshHandler();
    const response = await handler(eventFor(fullInboundParams({ Body: 'HELP' })));

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(HELP_AUTO_REPLY);
    expect(reserveMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ control: 'help', createTurnJob: false }),
    );
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it.each(['START', ' start ', 'UnStOp'])(
    'keeps the legacy exact %j fallback when OptOutType is absent',
    async (body) => {
      reserveMock.mockResolvedValue(newReservation({ shouldEnqueue: false }));
      const handler = await freshHandler();
      const response = await handler(eventFor(fullInboundParams({ Body: body })));

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('<Message>');
      expect(reserveMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ control: 'start', createTurnJob: false }),
      );
      expect(deactivateMock).not.toHaveBeenCalled();
      expect(sqsSend).not.toHaveBeenCalled();
    },
  );

  it('does not treat embedded START wording as a consent control', async () => {
    const handler = await freshHandler();
    await handler(eventFor(fullInboundParams({ Body: 'please start my dose log' })));

    expect(reserveMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ control: null, createTurnJob: true }),
    );
    expect(sqsSend).toHaveBeenCalledOnce();
  });

  it('treats embedded stop wording as a normal queued message', async () => {
    const handler = await freshHandler();
    await handler(eventFor(fullInboundParams({ Body: 'please stop texting me' })));
    expect(reserveMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ control: null, createTurnJob: true }),
    );
    expect(sqsSend).toHaveBeenCalledOnce();
  });
});

// M-13 — the intake is plain text only. Media is stored unread and answered with one fixed
// reply; link-looking text is ordinary inert content that the handler never dereferences.
describe('inbound plain-text-only boundary', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('the inbound handler must never fetch anything');
    });
  });

  it('answers a signed NumMedia>0 message with the fixed text-only reply and no model job', async () => {
    reserveMock.mockResolvedValue(newReservation({ shouldEnqueue: false }));
    const handler = await freshHandler();
    const response = await handler(
      eventFor(
        fullInboundParams({
          NumMedia: '1',
          MediaUrl0: 'https://api.twilio.com/media/ME00000000000000000000000000000000',
          MediaContentType0: 'image/jpeg',
        }),
      ),
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(MEDIA_UNSUPPORTED_REPLY);
    expect(reserveMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ control: null, createTurnJob: false }),
    );
    expect(sqsSend).not.toHaveBeenCalled();
    expect(markEnqueuedMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logLines().some((line) => line.includes('inbound_media_unsupported'))).toBe(true);
  });

  it('keeps an exact signed STOP working when it arrives with media attached', async () => {
    reserveMock.mockResolvedValue(
      newReservation({ shouldEnqueue: false, shouldSweepSchedules: true }),
    );
    const handler = await freshHandler();
    const response = await handler(
      eventFor(fullInboundParams({ Body: 'STOP', OptOutType: 'STOP', NumMedia: '2' })),
    );

    expect(response.body).not.toContain(MEDIA_UNSUPPORTED_REPLY);
    expect(deactivateMock).toHaveBeenCalledTimes(3);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('applies the intake cap before replying to media-only messages', async () => {
    reserveMock.mockResolvedValue(newReservation({ shouldEnqueue: false, rateLimited: 'silent' }));
    const handler = await freshHandler();
    const response = await handler(eventFor(fullInboundParams({ NumMedia: '1' })));

    expect(response.body).not.toContain(MEDIA_UNSUPPORTED_REPLY);
    expect(response.body).not.toContain('<Message>');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats link-looking text as ordinary inert content: same job, same wake, never fetched', async () => {
    const handler = await freshHandler();
    const response = await handler(
      eventFor(fullInboundParams({ Body: 'took it, see https://example.invalid/dose?id=7' })),
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('<Message>');
    expect(reserveMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        control: null,
        createTurnJob: true,
        rawBody: 'took it, see https://example.invalid/dose?id=7',
      }),
    );
    expect(sqsSend).toHaveBeenCalledOnce();
    expect(markEnqueuedMock).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// M-04 — the handler only relays the gate's verdict; capacity itself is consumed in the
// intake transaction.
describe('inbound intake capacity responses', () => {
  it('sends exactly one notice for the message that exhausts a window and queues nothing', async () => {
    reserveMock.mockResolvedValue(newReservation({ shouldEnqueue: false, rateLimited: 'notice' }));
    const handler = await freshHandler();
    const response = await handler(eventFor(fullInboundParams()));

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(INTAKE_LIMIT_NOTICE);
    expect(sqsSend).not.toHaveBeenCalled();
    expect(markEnqueuedMock).not.toHaveBeenCalled();
    const limited = logLines().find((line) => line.includes('inbound_intake_limited'));
    expect(JSON.parse(limited!)).toMatchObject({ notified: true });
    expect(limited).not.toContain(PATIENT_PHONE);
  });

  it('stores later over-limit messages silently inside the same window', async () => {
    reserveMock.mockResolvedValue(newReservation({ shouldEnqueue: false, rateLimited: 'silent' }));
    const handler = await freshHandler();
    const response = await handler(eventFor(fullInboundParams()));

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('<Message>');
    expect(sqsSend).not.toHaveBeenCalled();
    expect(
      JSON.parse(logLines().find((line) => line.includes('inbound_intake_limited'))!),
    ).toMatchObject({ notified: false });
  });

  it('never rate-limits the emergency divert', async () => {
    const handler = await freshHandler();
    const response = await handler(eventFor(fullInboundParams({ Body: EMERGENCY_BODY })));

    expect(response.body).toContain(SAFETY_AUTO_REPLY_EMERGENCY);
    expect(reserveMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ createTurnJob: false }),
    );
  });
});

describe('inbound deterministic emergency path', () => {
  it('uses English for the fixed deterministic emergency reply', async () => {
    const body = 'je ne peux pas respirer';
    const handler = await freshHandler();
    const response = await handler(eventFor(fullInboundParams({ Body: body })));

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(safetyAutoReplyEmergency('en'));
    expect(response.body).not.toContain(safetyAutoReplyEmergency('fr'));
    expect(reserveMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ emergencyCategory: 'acute_physical', createTurnJob: false }),
    );
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it('uses English for an ambiguous deterministic emergency term', async () => {
    reserveMock.mockResolvedValue(newReservation({ preferredLanguage: 'fr-CA' }));
    const handler = await freshHandler();
    const response = await handler(eventFor(fullInboundParams({ Body: 'suicide' })));

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(safetyAutoReplyEmergency('en'));
    expect(response.body).not.toContain(safetyAutoReplyEmergency('fr-CA'));
    expect(reserveMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ emergencyCategory: 'crisis', createTurnJob: false }),
    );
  });

  it('runs the prefilter before DB and returns fixed emergency TwiML when persistence fails', async () => {
    reserveMock.mockRejectedValue(new Error('database unavailable'));
    const handler = await freshHandler();
    const response = await handler(eventFor(fullInboundParams({ Body: EMERGENCY_BODY })));

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(SAFETY_AUTO_REPLY_EMERGENCY);
    expect(response.body).toContain('<Message>');
    expect(sqsSend).not.toHaveBeenCalled();
    const emergencyFailure = logLines().find((line) =>
      line.includes('inbound_emergency_persistence_failed'),
    );
    expect(emergencyFailure).toBeDefined();
    expect(JSON.parse(emergencyFailure!)).toEqual({
      metric: 'inbound_emergency_persistence_failed',
      errorName: 'Error',
    });
    expect(emergencyFailure).not.toContain(PATIENT_PHONE);
    expect(emergencyFailure).not.toContain(EMERGENCY_BODY);
  });

  it('records the alert in the reservation and performs no post-commit safety write', async () => {
    reserveMock.mockResolvedValue(newReservation({ safetyEventId: SAFETY_ID }));
    const handler = await freshHandler();
    const response = await handler(eventFor(fullInboundParams({ Body: EMERGENCY_BODY })));

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(SAFETY_AUTO_REPLY_EMERGENCY);
    expect(reserveMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ emergencyCategory: 'acute_physical', createTurnJob: false }),
    );
    expect(poolQuery).not.toHaveBeenCalled();
    const safetyMetric = logLines().find((line) => line.includes('safety_event_recorded'));
    expect(JSON.parse(safetyMetric!)).toEqual({
      metric: 'safety_event_recorded',
      source: 'prefilter',
    });
    for (const sensitiveValue of [
      PATIENT_ID,
      INBOUND_ID,
      SAFETY_ID,
      MESSAGE_SID,
      PATIENT_PHONE,
      EMERGENCY_BODY,
    ]) {
      expect(safetyMetric).not.toContain(sensitiveValue);
    }
    expect(sqsSend).not.toHaveBeenCalled();
    expect(markEnqueuedMock).not.toHaveBeenCalled();
  });

  it('still returns fixed emergency TwiML when SQS is unavailable without attempting a handoff', async () => {
    sqsSend.mockRejectedValue(new Error('queue unavailable'));
    const handler = await freshHandler();
    const response = await handler(eventFor(fullInboundParams({ Body: EMERGENCY_BODY })));

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(SAFETY_AUTO_REPLY_EMERGENCY);
    expect(sqsSend).not.toHaveBeenCalled();
    expect(markEnqueuedMock).not.toHaveBeenCalled();
  });

  it('returns the fixed response when alert persistence fails and never leaks the patient text', async () => {
    reserveMock.mockRejectedValue(new Error('safety table unavailable'));
    const handler = await freshHandler();
    const response = await handler(eventFor(fullInboundParams({ Body: EMERGENCY_BODY })));

    expect(response.statusCode).toBe(200);
    expect(sqsSend).not.toHaveBeenCalled();
    for (const line of logLines()) {
      expect(line).not.toContain(PATIENT_PHONE);
      expect(line).not.toContain(EMERGENCY_BODY);
    }
  });
});

describe('inbound boundary and identity behavior', () => {
  it('accepts an unencoded API Gateway form body and the Twilio SmsSid alias', async () => {
    const params = fullInboundParams();
    params.SmsSid = params.MessageSid!;
    delete params.MessageSid;
    const encodedEvent = eventFor(params);
    const handler = await freshHandler();
    const response = await handler({
      ...encodedEvent,
      body: Buffer.from(encodedEvent.body, 'base64').toString('utf8'),
      isBase64Encoded: false,
    });

    expect(response.statusCode).toBe(200);
    expect(reserveMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messageSid: MESSAGE_SID }),
    );
  });

  it('returns empty TwiML and no queue work when active-phone identity is not singular', async () => {
    reserveMock.mockResolvedValue({ kind: 'unmatched', matchCount: 0 });
    const handler = await freshHandler();
    const response = await handler(eventFor(fullInboundParams()));

    expect(response.statusCode).toBe(200);
    expect(sqsSend).not.toHaveBeenCalled();
    for (const line of logLines()) {
      expect(line).not.toContain(PATIENT_PHONE);
      expect(line).not.toContain(BENIGN_BODY);
    }
  });

  it('returns empty TwiML before DB access when From is missing', async () => {
    const params = fullInboundParams();
    delete params.From;
    const handler = await freshHandler();
    const response = await handler(eventFor(params));
    expect(response.statusCode).toBe(200);
    expect(reserveMock).not.toHaveBeenCalled();
  });

  it('returns empty TwiML before DB access when MessageSid and SmsSid are missing', async () => {
    const params = fullInboundParams();
    delete params.MessageSid;
    const handler = await freshHandler();
    const response = await handler(eventFor(params));
    expect(response.statusCode).toBe(200);
    expect(reserveMock).not.toHaveBeenCalled();
  });

  it('throws on missing INBOUND_URL before DB access', async () => {
    delete process.env.INBOUND_URL;
    const handler = await freshHandler();
    await expect(handler(eventFor(fullInboundParams()))).rejects.toThrow(/INBOUND_URL/);
    expect(reserveMock).not.toHaveBeenCalled();
  });

  it('keeps the pinned TLS pool configuration and never constructs it on failed HMAC', async () => {
    const handler = await freshHandler();
    await handler(eventFor(fullInboundParams()));
    expect(poolArgs).toHaveLength(1);
    expect(poolArgs[0]).toMatchObject({
      max: 2,
      ssl: expect.objectContaining({ rejectUnauthorized: true }),
    });

    vi.clearAllMocks();
    poolArgs.length = 0;
    const fresh = await freshHandler();
    await fresh(eventFor(fullInboundParams(), { signature: 'invalid' }));
    expect(Pool).not.toHaveBeenCalled();
  });
});
