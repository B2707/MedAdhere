/**
 * twilio.test.ts — CI-safe unit test of the Twilio app-originated SMS smoke handler's pure logic.
 *
 * NO real AWS, NO real Twilio, NO credentials, NO network. `@aws-sdk/client-secrets-manager`,
 * `@aws-sdk/client-ssm`, and `twilio` are fully mocked so the test proves, in isolation:
 *   - F45 — the FROM number is read from SSM AT RUNTIME (GetParameterCommand on TWILIO_FROM_PARAM,
 *     default "/medadhere/twilio-from"), and the D-05 toll-free re-point works by changing only the
 *     SSM parameter NAME env var (no redeploy).
 *   - WR-02/SEC-2 (post-exec review) — the placeholder secret CDK synthesizes is a NON-EMPTY JSON
 *     object (`{"placeholder":"…"}`), so the empty-string guard cannot catch it; the handler must
 *     still throw the actionable "not yet populated" error (NOT crash in `twilio(undefined,…)`).
 *   - the env/secret/parameter precondition guards.
 *
 * This is the regression gate for the twilio-smoke handler — added in the post-exec review (TEST-1),
 * which flagged that the handler shipped with zero unit tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted; the spies the factories close over must be created in vi.hoisted. The handler
// constructs `new SecretsManagerClient({})` / `new SSMClient({})` at import time, so those factory
// constructors must be `new`-able real `function`s.
const { smSend, ssmSend, messagesCreate, twilioFactory } = vi.hoisted(() => {
  const messagesCreate = vi.fn();
  return {
    smSend: vi.fn(),
    ssmSend: vi.fn(),
    messagesCreate,
    // twilio(accountSid, authToken) → client with messages.create(). vi.fn records the call args so
    // the test can assert the credentials reached the SDK (the WR-02 guard regression) without the
    // factory needing to reference them.
    twilioFactory: vi.fn(() => ({
      messages: { create: messagesCreate },
    })),
  };
});

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

// Import AFTER the mocks are registered.
import { handler } from './twilio.js';
import { GetParameterCommand } from '@aws-sdk/client-ssm';

const VALID_SECRET = JSON.stringify({ accountSid: 'AC_test', authToken: 'tok_test' });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TWILIO_SECRET_ARN =
    'arn:aws:secretsmanager:us-east-1:000000000000:secret:twilio';
  process.env.TEST_RECIPIENT = '+15145550123';
  delete process.env.TWILIO_FROM_PARAM;

  smSend.mockResolvedValue({ SecretString: VALID_SECRET });
  ssmSend.mockResolvedValue({ Parameter: { Value: '+15005550006' } });
  messagesCreate.mockResolvedValue({ sid: 'SM_test', status: 'queued' });
});

describe('twilio-smoke handler — F45 runtime SSM FROM read', () => {
  it('reads the FROM number from SSM at runtime via the default parameter name and sends with it', async () => {
    const res = await handler();

    // F45: the FROM number came from a runtime GetParameterCommand, NOT a baked env var.
    expect(GetParameterCommand).toHaveBeenCalledTimes(1);
    expect(GetParameterCommand).toHaveBeenCalledWith({ Name: '/medadhere/twilio-from' });
    // The SSM-sourced number is what reaches messages.create({ from }).
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ from: '+15005550006', to: '+15145550123' }),
    );
    // Credentials from the secret reached the SDK constructor (not undefined).
    expect(twilioFactory).toHaveBeenCalledWith('AC_test', 'tok_test');
    expect(res).toEqual({ sid: 'SM_test', status: 'queued' });
  });

  it('honours TWILIO_FROM_PARAM so the D-05 toll-free re-point needs no redeploy', async () => {
    process.env.TWILIO_FROM_PARAM = '/medadhere/twilio-from-tollfree';
    await handler();
    expect(GetParameterCommand).toHaveBeenCalledWith({
      Name: '/medadhere/twilio-from-tollfree',
    });
  });

  it('throws an actionable error when the SSM FROM parameter is empty/missing', async () => {
    ssmSend.mockResolvedValue({ Parameter: {} });
    await expect(handler()).rejects.toThrow(/twilio-from.*empty or missing/);
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});

describe('twilio-smoke handler — secret population guard (WR-02/SEC-2 regression)', () => {
  it('throws the actionable F47 error on the NON-EMPTY placeholder secret (no accountSid/authToken)', async () => {
    // The placeholder secret CDK actually synthesizes — a non-empty JSON object missing the creds.
    smSend.mockResolvedValue({ SecretString: JSON.stringify({ placeholder: 'x' }) });

    await expect(handler()).rejects.toThrow(/not yet populated \(no accountSid\/authToken\)/);
    // The whole point of the fix: we must NOT fall through to twilio(undefined, undefined).
    expect(twilioFactory).not.toHaveBeenCalled();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('throws on a truly empty SecretString', async () => {
    smSend.mockResolvedValue({ SecretString: '' });
    await expect(handler()).rejects.toThrow(/not yet populated/);
    expect(twilioFactory).not.toHaveBeenCalled();
  });

  it('WR-06: throws the actionable shape-naming error on a present-but-NON-JSON secret (raw token, not JSON) and NEVER constructs the client', async () => {
    // An operator stored a bare token instead of `{"accountSid":"…","authToken":"…"}` — `JSON.parse`
    // would throw an opaque SyntaxError. The WR-06 guard must turn that into a clear message naming the
    // expected JSON shape, and must NOT fall through to twilio(undefined, undefined).
    smSend.mockResolvedValue({ SecretString: 'AC_rawtoken_not_json' });
    await expect(handler()).rejects.toThrow(/not valid JSON.*accountSid/);
    expect(twilioFactory).not.toHaveBeenCalled();
    expect(messagesCreate).not.toHaveBeenCalled();
  });
});

describe('twilio-smoke handler — env preconditions', () => {
  it('throws when TWILIO_SECRET_ARN is not set', async () => {
    delete process.env.TWILIO_SECRET_ARN;
    await expect(handler()).rejects.toThrow(/TWILIO_SECRET_ARN/);
    expect(smSend).not.toHaveBeenCalled();
  });

  it('throws when TEST_RECIPIENT is not set', async () => {
    delete process.env.TEST_RECIPIENT;
    await expect(handler()).rejects.toThrow(/TEST_RECIPIENT/);
    expect(smSend).not.toHaveBeenCalled();
  });
});
