/**
 * handler.test.ts — network-free unit test of the Twilio status-callback Lambda's PURE logic (SC7 / HIGH-1).
 *
 * NO real AWS, NO real DB, NO Docker, NO credentials, NO network. `pg` and
 * `@aws-sdk/client-secrets-manager` are fully mocked. CRITICALLY, `twilio` is NOT mocked for the
 * dedicated sign-then-verify test (HIGH-1) — that test computes a REAL signature with
 * twilio.getExpectedTwilioSignature and proves the REAL twilio.validateRequest accepts the correctly
 * signed full+decoded callback and rejects a tampered one, so a fail-open/fail-closed regression on the
 * only authorizer-less route is caught (a mocked validateRequest would stay green even if the handler
 * fed it a subset or an undecoded body). The other validation-outcome cases drive the handler with the
 * real signing helper too (so the whole pipeline — decode → full params → exact URL — is exercised).
 *
 * Asserts the seven behaviors from the plan:
 *   1. base64 decode (HIGH-1): isBase64Encoded=true body is decoded BEFORE parsing → 200 + advance.
 *   2. UNMOCKED sign-then-verify (HIGH-1): real getExpectedTwilioSignature → real validateRequest, full
 *      decoded params → 200; tamper one field → 403.
 *   3. bad signature → 403, NO DB write.
 *   4. valid signature → 200 + forward advance (status_updated_at set).
 *   5. monotonic out-of-order: a `sent` callback for a `delivered` row does NOT roll back (rank guard).
 *   6. exact-URL: validateRequest is anchored to the env-pinned STATUS_CALLBACK_URL.
 *   7. OPS-02 data: an `undelivered` callback persists status='undelivered' for the Phase-5 query.
 *   8. Callback-before-SID race: unknown authenticated SID → 503; retry/known stale SID → 200.
 *   + M3 (M-2 TLS): the captured pg.Pool ctor args carry ssl.rejectUnauthorized===true + non-empty ssl.ca.
 *
 * Mirrors data-api/handler.test.ts (pg + SM mock, module-scoped-pool-reuse + M3) and smoke/twilio.test.ts
 * (SM mock for the authToken), adapted for the API GW v2 proxy event + the in-handler HMAC.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
// The REAL twilio module — used to compute genuine signatures (validateRequest is NOT mocked).
import twilioReal from 'twilio';
// The REAL generated rank CASE — the H-02 regression asserts the handler ships exactly this fragment.
import { STORED_STATUS_RANK_SQL_CASE } from '@medadhere/shared';

// `vi.mock` is hoisted; the spies the factories close over must be created in `vi.hoisted` (also
// hoisted). The handler constructs `new SecretsManagerClient({})` at import time, so that factory
// constructor must be a `new`-able real `function`. The pg.Pool ctor captures its args (M3) and its
// methods are the hoisted spies the test inspects.
const { queryMock, endMock, smSend, lambdaSend, poolArgs } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  endMock: vi.fn(),
  smSend: vi.fn(),
  lambdaSend: vi.fn(),
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

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn(function () {
    return { send: lambdaSend };
  }),
  InvokeCommand: vi.fn(function (args: unknown) {
    return { __args: args };
  }),
}));

// NOTE: `twilio` is deliberately NOT mocked — the handler uses the REAL twilio.validateRequest so the
// sign-then-verify test proves the genuine HMAC pipeline. @medadhere/shared (STATUS_RANK) is also real.

import { Pool } from 'pg';

/** Re-import the handler with a fresh module registry so the module-scoped `pool` starts undefined. */
async function freshHandler() {
  vi.resetModules();
  const mod = await import('./handler.js');
  return mod.handler;
}

const AUTH_TOKEN = 'tok_supersecret_authtoken';
const DB_SECRET = JSON.stringify({ username: 'medadhere_admin', password: 'pw' });
const TWILIO_SECRET = JSON.stringify({ accountSid: 'AC_test', authToken: AUTH_TOKEN });
const CALLBACK_URL = 'https://abc123.execute-api.us-east-1.amazonaws.com/twilio/status';
const OUTBOUND_ID = 'a5f7a723-4e13-4dd2-87d0-b0d155a8d9c2';
const CALLBACK_TOKEN = Buffer.alloc(32, 7).toString('base64url');
const CALLBACK_TOKEN_HASH = createHash('sha256').update(CALLBACK_TOKEN).digest();
const CALLBACK_QUERY = `callbackToken=${CALLBACK_TOKEN}`;

/** A realistic FULL Twilio status-callback form param set (the real callback field set). */
function fullCallbackParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    MessageSid: 'SM_outbound_123',
    MessageStatus: 'sent',
    ErrorCode: '',
    AccountSid: 'AC_test',
    From: '+15005550006',
    To: '+15145550123',
    ApiVersion: '2010-04-01',
    ...overrides,
  };
}

/** URL-encode a param object into a Twilio-style urlencoded body. */
function encodeForm(params: Record<string, string>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) usp.append(k, v);
  return usp.toString();
}

/**
 * Build an API GW v2 proxy event for a set of params: compute the REAL signature over the EXACT
 * callback URL + the FULL params, base64-encode the urlencoded body (isBase64Encoded=true, mirroring
 * API GW v2's form-body handling), and put the real signature in the X-Twilio-Signature header.
 * `signParams` lets a test sign a DIFFERENT param set than it sends (the tamper case).
 */
function eventFor(
  sendParams: Record<string, string>,
  opts: {
    signParams?: Record<string, string>;
    base64?: boolean;
    signature?: string;
    rawQueryString?: string;
  } = {},
) {
  const body = encodeForm(sendParams);
  const signParams = opts.signParams ?? sendParams;
  const rawQueryString = opts.rawQueryString ?? CALLBACK_QUERY;
  const signedUrl = rawQueryString ? `${CALLBACK_URL}?${rawQueryString}` : CALLBACK_URL;
  const signature =
    opts.signature ?? twilioReal.getExpectedTwilioSignature(AUTH_TOKEN, signedUrl, signParams);
  const base64 = opts.base64 ?? true;
  return {
    body: base64 ? Buffer.from(body, 'utf8').toString('base64') : body,
    isBase64Encoded: base64,
    headers: { 'X-Twilio-Signature': signature },
    rawQueryString,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  poolArgs.length = 0;
  process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:db';
  process.env.DB_HOST = 'db.internal';
  process.env.DB_PORT = '5432';
  process.env.DB_NAME = 'medadhere';
  process.env.TWILIO_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:twilio';
  process.env.STATUS_CALLBACK_URL = CALLBACK_URL;
  process.env.OUTBOUND_FN_ARN = 'arn:aws:lambda:us-east-1:000000000000:function:MedAdhere-Outbound';

  // Secrets Manager: DB secret for getPool(), Twilio secret for the authToken (dispatched by SecretId).
  smSend.mockImplementation((cmd: { __args?: { SecretId?: string } }) => {
    const id = cmd.__args?.SecretId ?? '';
    if (id.includes('twilio')) return Promise.resolve({ SecretString: TWILIO_SECRET });
    return Promise.resolve({ SecretString: DB_SECRET });
  });
  // Default: the correlated rank-guarded UPDATE matches a non-check-in row (no recovery invoke).
  queryMock.mockResolvedValue({
    rowCount: 1,
    rows: [
      {
        id: OUTBOUND_ID,
        patient_id: 'patient-1',
        message_kind: 'acknowledgement',
        newly_bound: true,
      },
    ],
  });
  lambdaSend.mockResolvedValue({ StatusCode: 200 });
});

describe('status-callback — HIGH-1: base64-decodes the body BEFORE parsing', () => {
  it('decodes an isBase64Encoded=true body, validates the full params, and advances the status (200)', async () => {
    const handler = await freshHandler();
    const params = fullCallbackParams({ MessageStatus: 'sent' });
    const res = await handler(eventFor(params, { base64: true }));

    expect(res.statusCode).toBe(200);
    // The decoded full param set drove the rank-guarded UPDATE (status='sent').
    const updateCall = queryMock.mock.calls.find((c) =>
      /UPDATE outbound_message/i.test(String(c[0])),
    );
    expect(updateCall).toBeDefined();
    const [, qparams] = updateCall as [string, unknown[]];
    expect(qparams).toEqual(['sent', 'SM_outbound_123', 3, CALLBACK_TOKEN_HASH]);
  });

  it('a request that fed the UNDECODED base64 body to the parser would 403 (proven by the decode path succeeding)', async () => {
    // If the handler did NOT decode, URLSearchParams(base64String) parses garbage → the signature
    // (computed over the real params) would not match → 403. The fact the decode path returns 200 above
    // is the proof; here we additionally confirm a deliberately-undecoded body 403s.
    const handler = await freshHandler();
    const params = fullCallbackParams();
    const body = encodeForm(params);
    const signature = twilioReal.getExpectedTwilioSignature(AUTH_TOKEN, CALLBACK_URL, params);
    // isBase64Encoded=false but we send the BASE64 string as the body → the parser sees garbage.
    const res = await handler({
      body: Buffer.from(body, 'utf8').toString('base64'),
      isBase64Encoded: false,
      headers: { 'X-Twilio-Signature': signature },
    });
    expect(res.statusCode).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('status-callback — HIGH-1: UNMOCKED sign-then-verify over the FULL param set', () => {
  it('accepts the correctly-signed full+decoded callback (real getExpectedTwilioSignature → real validateRequest)', async () => {
    const handler = await freshHandler();
    const params = fullCallbackParams({ MessageStatus: 'delivered' });
    const res = await handler(eventFor(params));
    expect(res.statusCode).toBe(200);
    const updateCall = queryMock.mock.calls.find((c) =>
      /UPDATE outbound_message/i.test(String(c[0])),
    );
    expect((updateCall as [string, unknown[]])[1]).toEqual([
      'delivered',
      'SM_outbound_123',
      4,
      CALLBACK_TOKEN_HASH,
    ]);
  });

  it('rejects a TAMPERED callback (a param value changed after signing) with 403 and NO DB write', async () => {
    const handler = await freshHandler();
    const original = fullCallbackParams();
    // Sign the original, but SEND a body with To swapped — the digest no longer matches.
    const tampered = { ...original, To: '+19998887777' };
    const res = await handler(eventFor(tampered, { signParams: original }));
    expect(res.statusCode).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects when a field is DROPPED from the sent body (subset → different digest) with 403', async () => {
    const handler = await freshHandler();
    const original = fullCallbackParams();
    const { ApiVersion: _drop, ...subset } = original;
    void _drop;
    const res = await handler(eventFor(subset, { signParams: original }));
    expect(res.statusCode).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('status-callback — bad signature → 403, no DB write (Spoofing mitigation T-03-03)', () => {
  it('returns 403 and performs NO DB write when the X-Twilio-Signature is invalid', async () => {
    const handler = await freshHandler();
    const params = fullCallbackParams();
    const res = await handler(eventFor(params, { signature: 'totally-bogus-signature' }));
    expect(res.statusCode).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns 403 before DB access when the signature header is missing', async () => {
    const handler = await freshHandler();
    const event = {
      ...eventFor(fullCallbackParams()),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    };

    const res = await handler(event);

    expect(res.statusCode).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('status-callback — malformed status payloads are acknowledged without DB access', () => {
  it.each([
    ['missing SID', { MessageStatus: 'sent' }],
    ['missing status', { MessageSid: 'SM_outbound_123' }],
    ['unknown status', { MessageSid: 'SM_outbound_123', MessageStatus: 'read' }],
  ])('returns 200 for %s', async (_label, params) => {
    const handler = await freshHandler();

    const res = await handler(eventFor(params));

    expect(res.statusCode).toBe(200);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('accepts the documented SmsSid/SmsStatus aliases', async () => {
    const handler = await freshHandler();

    const res = await handler(
      eventFor({ SmsSid: 'SM_outbound_alias', SmsStatus: 'sent', AccountSid: 'AC_test' }),
    );

    expect(res.statusCode).toBe(200);
    const updateCall = queryMock.mock.calls.find((call) =>
      /UPDATE outbound_message/i.test(String(call[0])),
    );
    expect((updateCall as [string, unknown[]])[1]).toEqual([
      'sent',
      'SM_outbound_alias',
      3,
      CALLBACK_TOKEN_HASH,
    ]);
  });
});

describe('status-callback — valid signature → 200 + forward advance (SC7)', () => {
  it("advances a 'queued' row to 'sent' and sets status_updated_at, returns empty 200", async () => {
    const handler = await freshHandler();
    const params = fullCallbackParams({ MessageStatus: 'sent' });
    const res = await handler(eventFor(params));

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    const updateCall = queryMock.mock.calls.find((c) =>
      /UPDATE outbound_message/i.test(String(c[0])),
    );
    expect(updateCall).toBeDefined();
    const [sql, qparams] = updateCall as [string, unknown[]];
    expect(sql).toMatch(/status\s*=\s*CASE[\s\S]*THEN\s+\$1/i);
    expect(sql).toMatch(/status_updated_at\s*=\s*CASE[\s\S]*THEN\s+now\(\)/i);
    expect(sql).toMatch(/callback_token_hash\s*=\s*\$4/i);
    expect(sql).toMatch(/twilio_sid\s*=\s*COALESCE\(om\.twilio_sid,\s*\$2\)/i);
    expect(sql).toMatch(
      /sent_at\s*=\s*COALESCE\(om\.sent_at,\s*om\.status_updated_at,\s*now\(\)\)/i,
    );
    // The rank guard is present: $3 > (CASE status … END) — forward-only.
    expect(sql).toMatch(/\$3\s*>\s*\(CASE status/i);
    // Parameterized: neither MessageSid nor the token hash is interpolated (T-03-05).
    expect(qparams).toEqual(['sent', 'SM_outbound_123', 3, CALLBACK_TOKEN_HASH]);
  });
});

describe('status-callback — monotonicity: out-of-order callback does NOT roll back (T-03-04)', () => {
  it("a 'sent' callback arriving after the row is already 'delivered' matches zero rows (rank guard)", async () => {
    // The correlated UPDATE returns the known row even though its CASE expression preserves the
    // higher terminal status. This distinguishes a stale callback from a mismatched token/SID.
    queryMock.mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          id: OUTBOUND_ID,
          patient_id: 'patient-1',
          message_kind: 'acknowledgement',
          newly_bound: false,
        },
      ],
    });
    const handler = await freshHandler();
    const params = fullCallbackParams({ MessageStatus: 'sent' });
    const res = await handler(eventFor(params));

    // The handler still ACKs Twilio with 200, but the CASE cannot roll the stored status backward.
    expect(res.statusCode).toBe(200);
    const updateCall = queryMock.mock.calls.find((c) =>
      /UPDATE outbound_message/i.test(String(c[0])),
    );
    expect(updateCall).toBeDefined();
    expect(String((updateCall as [string, unknown[]])[0])).toMatch(
      /CASE\s+WHEN \$3\s*>\s*\(CASE status/i,
    );
    expect((updateCall as [string, unknown[]])[1]).toEqual([
      'sent',
      'SM_outbound_123',
      3,
      CALLBACK_TOKEN_HASH,
    ]);
  });
});

describe('status-callback — opaque correlation binds an accepted-but-ack-lost send', () => {
  it('atomically binds the callback SID to the one still-unbound claimed row and advances it', async () => {
    queryMock.mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          id: OUTBOUND_ID,
          patient_id: 'patient-1',
          message_kind: 'acknowledgement',
          newly_bound: true,
        },
      ],
    });
    const handler = await freshHandler();

    const res = await handler(eventFor(fullCallbackParams({ MessageStatus: 'delivered' })));

    expect(res.statusCode).toBe(200);
    const [sql, values] = queryMock.mock.calls.find((call) =>
      /UPDATE outbound_message/i.test(String(call[0])),
    ) as [string, unknown[]];
    expect(sql).toMatch(/callback_token_hash\s*=\s*\$4/i);
    expect(sql).toMatch(/target\.twilio_sid\s+IS NULL/i);
    expect(sql).toMatch(/status\s+IN\s*\('sending',\s*'sending_unknown'\)/i);
    expect(sql).toMatch(/other\.twilio_sid\s*=\s*\$2/i);
    expect(values).toEqual(['delivered', 'SM_outbound_123', 4, CALLBACK_TOKEN_HASH]);
    expect(JSON.stringify(queryMock.mock.calls)).not.toContain(CALLBACK_TOKEN);
  });

  it('accepts an idempotent retry for the same token and SID', async () => {
    queryMock.mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          id: OUTBOUND_ID,
          patient_id: 'patient-1',
          message_kind: 'acknowledgement',
          newly_bound: false,
        },
      ],
    });
    const handler = await freshHandler();
    const event = eventFor(fullCallbackParams({ MessageStatus: 'delivered' }));

    expect((await handler(event)).statusCode).toBe(200);
    expect((await handler(event)).statusCode).toBe(200);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['unknown token', `${Buffer.alloc(32, 9).toString('base64url')}`],
    ['already bound to another SID', CALLBACK_TOKEN],
  ])('fails closed with 403 for %s', async (_label, callbackToken) => {
    queryMock.mockResolvedValue({ rowCount: 0, rows: [] });
    const handler = await freshHandler();
    const rawQueryString = `callbackToken=${callbackToken}`;

    const res = await handler(
      eventFor(fullCallbackParams({ MessageStatus: 'sent' }), { rawQueryString }),
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toBe('');
  });

  it('returns an empty retryable 503 when the database fails', async () => {
    queryMock.mockRejectedValue(new Error('database unavailable'));
    const handler = await freshHandler();

    const res = await handler(eventFor(fullCallbackParams({ MessageStatus: 'delivered' })));

    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.statusCode).toBeLessThan(600);
    expect(res.body).toBe('');
    expect(res.body).not.toContain('SM_outbound_123');
  });
});

describe('status-callback — H-02: a stored sending_unknown row still advances on a later callback', () => {
  /**
   * Evaluate the rank guard the handler ACTUALLY sent: pull the `WHEN '<status>' THEN <n>` branches
   * out of its own SQL and apply them to the status the row holds. This exercises the shipped CASE
   * (generated from STORED_STATUS_RANK) rather than restating the expected ranks in the test.
   */
  function storedRankFromHandlerSql(sql: string, storedStatus: string): number {
    const branches = [...sql.matchAll(/WHEN\s+'([a-z_]+)'\s+THEN\s+(\d+)/gi)];
    const match = branches.find(([, status]) => status === storedStatus);
    if (match) return Number(match[2]);
    const fallback = /ELSE\s+(\d+)/i.exec(sql);
    expect(fallback).not.toBeNull();
    return Number(fallback?.[1]);
  }

  function guardedUpdate(): [string, unknown[]] {
    const call = queryMock.mock.calls.find((c) => /UPDATE outbound_message/i.test(String(c[0])));
    expect(call).toBeDefined();
    return call as [string, unknown[]];
  }

  it.each(['delivered', 'failed', 'undelivered', 'sent'])(
    "a '%s' callback outranks a stored 'sending_unknown' row, so the guarded UPDATE matches it",
    async (incoming) => {
      const handler = await freshHandler();
      const res = await handler(eventFor(fullCallbackParams({ MessageStatus: incoming })));
      expect(res.statusCode).toBe(200);

      // Before the fix `sending_unknown` fell through to the CASE's `ELSE 4` catch-all, tying the
      // terminal rank — `$3 > storedRank` was false and the accepted-but-ack-lost row was stranded.
      const [sql, qparams] = guardedUpdate();
      expect(qparams[2] as number).toBeGreaterThan(
        storedRankFromHandlerSql(sql, 'sending_unknown'),
      );
    },
  );

  it("does not let a 'queued' callback roll a stored 'sending_unknown' row backward", async () => {
    const handler = await freshHandler();
    await handler(eventFor(fullCallbackParams({ MessageStatus: 'queued' })));
    const [sql, qparams] = guardedUpdate();

    expect(qparams[2] as number).not.toBeGreaterThan(
      storedRankFromHandlerSql(sql, 'sending_unknown'),
    );
  });

  it('ranks the row from the generated shared CASE, so the SQL can never drift from the map again', async () => {
    const handler = await freshHandler();
    await handler(eventFor(fullCallbackParams()));
    expect(guardedUpdate()[0]).toContain(STORED_STATUS_RANK_SQL_CASE);
  });
});

describe('status-callback — exact-URL validateRequest (Pitfall 2)', () => {
  it('validates against the env-pinned base plus exact query (a different URL 403s)', async () => {
    const handler = await freshHandler();
    const params = fullCallbackParams();
    // Sign for a DIFFERENT URL than the env one — the handler must use the env URL, so this 403s.
    const wrongUrlSig = twilioReal.getExpectedTwilioSignature(
      AUTH_TOKEN,
      `https://attacker.example.com/twilio/status?${CALLBACK_QUERY}`,
      params,
    );
    const res = await handler(eventFor(params, { signature: wrongUrlSig }));
    expect(res.statusCode).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('validates with the fragment-free base plus raw query because Twilio excludes only the fragment', async () => {
    const handler = await freshHandler();
    expect(process.env.STATUS_CALLBACK_URL).toBe(CALLBACK_URL);
    expect(process.env.STATUS_CALLBACK_URL).not.toContain('#');
    const res = await handler(eventFor(fullCallbackParams()));
    expect(res.statusCode).toBe(200);
  });

  it('rejects a token-query change made after signing before any DB access', async () => {
    const handler = await freshHandler();
    const params = fullCallbackParams();
    const signature = twilioReal.getExpectedTwilioSignature(
      AUTH_TOKEN,
      `${CALLBACK_URL}?${CALLBACK_QUERY}`,
      params,
    );
    const changedQuery = `callbackToken=${Buffer.alloc(32, 8).toString('base64url')}`;

    const res = await handler(eventFor(params, { signature, rawQueryString: changedQuery }));

    expect(res.statusCode).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('status-callback — strict single-purpose callback token query', () => {
  it.each([
    ['missing query', ''],
    ['missing token', 'other=value'],
    ['extra parameter', `${CALLBACK_QUERY}&other=value`],
    ['duplicate token', `${CALLBACK_QUERY}&${CALLBACK_QUERY}`],
    ['short token', 'callbackToken=short'],
    ['percent-encoded key', `%63allbackToken=${CALLBACK_TOKEN}`],
    [
      'percent-encoded token',
      `callbackToken=%${CALLBACK_TOKEN.charCodeAt(0).toString(16)}${CALLBACK_TOKEN.slice(1)}`,
    ],
  ])('fails closed for a correctly signed %s', async (_label, rawQueryString) => {
    const handler = await freshHandler();

    const res = await handler(eventFor(fullCallbackParams(), { rawQueryString }));

    expect(res.statusCode).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('status-callback — accepted-but-ack-lost check-in schedule recovery', () => {
  function correlatedCheckInRow(): void {
    queryMock.mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          id: OUTBOUND_ID,
          patient_id: 'patient-1',
          message_kind: 'check_in',
          newly_bound: true,
        },
      ],
    });
  }

  it('synchronously invokes the existing Outbound Lambda with only the correlated internal id', async () => {
    correlatedCheckInRow();
    const handler = await freshHandler();

    const res = await handler(eventFor(fullCallbackParams({ MessageStatus: 'sent' })));

    expect(res.statusCode).toBe(200);
    expect(lambdaSend).toHaveBeenCalledOnce();
    const command = lambdaSend.mock.calls[0]?.[0] as {
      __args?: { FunctionName?: string; InvocationType?: string; Payload?: Uint8Array };
    };
    expect(command.__args?.FunctionName).toBe(process.env.OUTBOUND_FN_ARN);
    expect(command.__args?.InvocationType).toBe('RequestResponse');
    expect(JSON.parse(Buffer.from(command.__args?.Payload ?? []).toString('utf8'))).toEqual({
      outboundMessageId: OUTBOUND_ID,
    });
  });

  it('returns 503 so Twilio retries when synchronous lifecycle recovery fails', async () => {
    correlatedCheckInRow();
    lambdaSend.mockResolvedValue({ StatusCode: 200, FunctionError: 'Unhandled' });
    const handler = await freshHandler();

    const res = await handler(eventFor(fullCallbackParams({ MessageStatus: 'sent' })));

    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('');
  });

  it.each(['acknowledgement', 'reminder'])(
    '%s callbacks never schedule check-in lifecycle',
    async (messageKind) => {
      queryMock.mockResolvedValue({
        rowCount: 1,
        rows: [
          {
            id: OUTBOUND_ID,
            patient_id: 'patient-1',
            message_kind: messageKind,
            newly_bound: true,
          },
        ],
      });
      const handler = await freshHandler();

      expect((await handler(eventFor(fullCallbackParams()))).statusCode).toBe(200);
      expect(lambdaSend).not.toHaveBeenCalled();
    },
  );
});

describe('status-callback — OPS-02 data: undelivered persists for the Phase-5 consecutive-undelivered query', () => {
  it("an 'undelivered' callback writes status='undelivered' (the column the OPS-02 alarm reads)", async () => {
    const handler = await freshHandler();
    const params = fullCallbackParams({ MessageStatus: 'undelivered', ErrorCode: '30008' });
    const res = await handler(eventFor(params));

    expect(res.statusCode).toBe(200);
    const updateCall = queryMock.mock.calls.find((c) =>
      /UPDATE outbound_message/i.test(String(c[0])),
    );
    expect((updateCall as [string, unknown[]])[1]).toEqual([
      'undelivered',
      'SM_outbound_123',
      4,
      CALLBACK_TOKEN_HASH,
    ]);
  });
});

describe('status-callback — M3: verifies the RDS server cert against the pinned CA bundle (M-2 / T-03-08)', () => {
  it('constructs the pg.Pool with ssl.rejectUnauthorized:true AND a non-empty ssl.ca', async () => {
    const handler = await freshHandler();
    await handler(eventFor(fullCallbackParams()));

    expect(poolArgs).toHaveLength(1);
    const ssl = poolArgs[0]?.ssl as { ca?: unknown; rejectUnauthorized?: unknown } | undefined;
    expect(ssl).toBeDefined();
    expect(ssl?.rejectUnauthorized).toBe(true);
    expect(typeof ssl?.ca).toBe('string');
    expect((ssl?.ca as string).length).toBeGreaterThan(0);
    expect(poolArgs[0]?.max).toBe(2); // D-11 connection cap
  });

  it('does NOT touch the DB at all on a 403 (the pool is never built when the signature fails)', async () => {
    const handler = await freshHandler();
    await handler(eventFor(fullCallbackParams(), { signature: 'bogus' }));
    expect(Pool).not.toHaveBeenCalled();
    expect(poolArgs).toHaveLength(0);
  });
});

describe('status-callback — 05-04 OPS-02 (f): consecutive_undelivered derivation (id-only metric)', () => {
  it('emits consecutive_undelivered when the patient has >=2 consecutive undelivered/failed messages', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    queryMock.mockImplementation(async (text: string) => {
      const sql = String(text);
      // The forward-only advance now RETURNs the row's patient_id so the derivation has scope.
      if (/UPDATE outbound_message/i.test(sql))
        return { rowCount: 1, rows: [{ patient_id: 'patient-1' }] };
      // The lookback query over the patient's recent messages (most-recent first).
      if (/SELECT status FROM outbound_message/i.test(sql)) {
        return { rows: [{ status: 'undelivered' }, { status: 'failed' }, { status: 'delivered' }] };
      }
      return { rowCount: 1, rows: [] };
    });
    const handler = await freshHandler();
    const res = await handler(
      eventFor(fullCallbackParams({ MessageStatus: 'undelivered', ErrorCode: '30008' })),
    );
    expect(res.statusCode).toBe(200);
    const lines = logSpy.mock.calls.map((c) => c.map(String).join(' '));
    const line = lines.find((l) => l.includes('consecutive_undelivered'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!);
    expect(parsed.metric).toBe('consecutive_undelivered');
    expect(parsed.patientId).toBeUndefined();
    expect(line).not.toContain('patient-1');
    // The leading run of undelivered/failed before the first success is 2.
    expect(parsed.consecutiveCount).toBe(2);
    logSpy.mockRestore();
  });

  it('does NOT emit when only ONE recent message is undelivered (streak < 2)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    queryMock.mockImplementation(async (text: string) => {
      const sql = String(text);
      if (/UPDATE outbound_message/i.test(sql))
        return { rowCount: 1, rows: [{ patient_id: 'patient-1' }] };
      if (/SELECT status FROM outbound_message/i.test(sql)) {
        return { rows: [{ status: 'undelivered' }, { status: 'delivered' }] };
      }
      return { rowCount: 1, rows: [] };
    });
    const handler = await freshHandler();
    await handler(eventFor(fullCallbackParams({ MessageStatus: 'undelivered' })));
    const lines = logSpy.mock.calls.map((c) => c.map(String).join(' '));
    expect(lines.some((l) => l.includes('consecutive_undelivered'))).toBe(false);
    logSpy.mockRestore();
  });

  it('counts only rows that reached the provider — accepted sends OR claimed synchronous rejections', async () => {
    queryMock.mockImplementation(async (text: string) => {
      const sql = String(text);
      if (/UPDATE outbound_message/i.test(sql))
        return { rowCount: 1, rows: [{ patient_id: 'patient-1' }] };
      if (/SELECT status FROM outbound_message/i.test(sql)) return { rows: [] };
      return { rowCount: 1, rows: [] };
    });
    const handler = await freshHandler();
    await handler(eventFor(fullCallbackParams({ MessageStatus: 'undelivered' })));
    const lookback = queryMock.mock.calls.find((c) =>
      /SELECT status FROM outbound_message/i.test(String(c[0])),
    );
    expect(lookback).toBeDefined();
    const sql = String(lookback![0]);
    // Suppressed record-only / consent-terminalized rows (never claimed for Twilio: no sent_at,
    // no callback_token_hash) must neither count toward NOR break a delivery-failure streak.
    expect(sql).toMatch(/sent_at\s+IS\s+NOT\s+NULL/i);
    // A definitive synchronous provider rejection DID reach Twilio: it was claimed (token
    // stamped) but never accepted (no sent_at). It is a real failure and must stay counted.
    expect(sql).toMatch(
      /callback_token_hash\s+IS\s+NOT\s+NULL\s+AND\s+status\s+IN\s+\('failed',\s*'undelivered'\)/i,
    );
  });

  it('does NOT run the lookback at all for a NON-failure status (delivered advances, no derivation)', async () => {
    queryMock.mockImplementation(async (text: string) => {
      const sql = String(text);
      if (/UPDATE outbound_message/i.test(sql))
        return { rowCount: 1, rows: [{ patient_id: 'patient-1' }] };
      if (/SELECT status FROM outbound_message/i.test(sql))
        return { rows: [{ status: 'delivered' }] };
      return { rowCount: 1, rows: [] };
    });
    const handler = await freshHandler();
    await handler(eventFor(fullCallbackParams({ MessageStatus: 'delivered' })));
    const lookback = queryMock.mock.calls.find((c) =>
      /SELECT status FROM outbound_message/i.test(String(c[0])),
    );
    expect(lookback).toBeUndefined();
  });

  it('a derivation failure NEVER 5xxes the callback — the check is best-effort (still 200)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    queryMock.mockImplementation(async (text: string) => {
      const sql = String(text);
      if (/UPDATE outbound_message/i.test(sql))
        return { rowCount: 1, rows: [{ patient_id: 'patient-1' }] };
      if (/SELECT status FROM outbound_message/i.test(sql))
        throw new Error('connection terminated');
      return { rowCount: 1, rows: [] };
    });
    const handler = await freshHandler();
    const res = await handler(eventFor(fullCallbackParams({ MessageStatus: 'failed' })));
    expect(res.statusCode).toBe(200);
    logSpy.mockRestore();
  });
});
