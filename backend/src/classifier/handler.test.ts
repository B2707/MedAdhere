/**
 * handler.test.ts — network-free unit test of the Classifier Lambda (Plan 04-03 / SC2 / SC4 / PIPE-04/06/07/10).
 *
 * NO real AWS, NO real DB, NO live Anthropic call — `pg` and `@aws-sdk/client-secrets-manager`
 * are fully mocked; `@anthropic-ai/sdk` is the capture-ctor stub with REAL error classes (the
 * classify.test.ts posture). A test-local adapter preserves the historical id-only fixture while
 * production calls processStoredReply from the FIFO worker.
 *
 * Pins the gate-amended contracts:
 *   1. CHECK-BEFORE-SPEND replay pre-flight (U-02/REV-H2): existsForInboundMessage runs BEFORE
 *      attribution and BEFORE the paid call — a redelivered event costs $0 and re-attributes nothing.
 *   2. PIPE-10 attribution: most recent outbound_message inside RESPONSE_WINDOW + LATE_ALLOWANCE
 *      with no classifier-decided record; no match → dose_id NULL (single write path).
 *   3. PIPE-06 is_late: reply after the response window (but inside the attribution window) marks
 *      inbound_reply.is_late = true.
 *   4. The SINGLE-ARBITER write contract (U-02): ON CONFLICT (dose_id) DO UPDATE … WHERE
 *      adherence_record.decided_by = 'timeout'; the 23505 race on UNIQUE(inbound_message_id) is
 *      caught and treated as success (the explicit backstop — never a second arbiter).
 *   5. SC4 TERMINAL POLICY (U-04/REV-H3): transient exhaustion and 401 auth failures WRITE the
 *      {unknown, other, none} row and RETURN SUCCESS (one visible terminal row, no re-drive);
 *      401 additionally emits the distinct anthropic_auth_failure metric. Contract failures write
 *      the same terminal row with NO second LLM call.
 *   6. U-16 PII-safe logs: contract-failure logs carry issue paths/codes only — never the reply
 *      text, never received values.
 *   7. U-04 replay-count: a duplicate delivery after a successful run makes ZERO further Anthropic
 *      calls (stub call-count asserted — no hidden retry multiplication).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  queryMock,
  connectMock,
  endMock,
  smSend,
  ssmSend,
  anthropicCtorArgs,
  messagesCreate,
  smsCreate,
  twilioFactory,
  poolArgs,
} = vi.hoisted(() => {
  const smsCreate = vi.fn();
  return {
    queryMock: vi.fn(),
    connectMock: vi.fn(),
    endMock: vi.fn(),
    smSend: vi.fn(),
    ssmSend: vi.fn(),
    anthropicCtorArgs: [] as Array<Record<string, unknown>>,
    messagesCreate: vi.fn(),
    smsCreate,
    // The Twilio client factory — Plan 04-04: the model-flag safety auto-reply send.
    twilioFactory: vi.fn(() => ({ messages: { create: smsCreate } })),
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

vi.mock('twilio', () => ({ default: twilioFactory }));

vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const real = (await importOriginal()) as { default: Record<string, unknown> };
  class MockAnthropic {
    messages = { create: messagesCreate };
    constructor(config: Record<string, unknown>) {
      anthropicCtorArgs.push(config);
    }
  }
  for (const key of [
    'APIError',
    'AuthenticationError',
    'PermissionDeniedError',
    'RateLimitError',
    'InternalServerError',
    'APIConnectionError',
    'APIConnectionTimeoutError',
  ]) {
    (MockAnthropic as unknown as Record<string, unknown>)[key] = real.default[key];
  }
  return { default: MockAnthropic };
});

import Anthropic from '@anthropic-ai/sdk';
import {
  SAFETY_AUTO_REPLY_EMERGENCY,
  SAFETY_AUTO_REPLY_MEDICAL_QUESTION,
  inboundReplyWakeSchema,
} from '@medadhere/shared';

function sdkError(className: string, fields: Record<string, unknown> = {}): Error {
  const cls = (Anthropic as unknown as Record<string, { prototype: object } | undefined>)[
    className
  ];
  if (!cls) throw new Error(`SDK error class ${className} not found on the mock`);
  const err = Object.create(cls.prototype) as Error & Record<string, unknown>;
  Object.assign(err, { message: `${className} (test)`, ...fields });
  return err;
}

async function freshHandler() {
  vi.resetModules();
  const mod = await import('./handler.js');
  return async (event: { detail?: unknown }) => {
    const { inboundMessageId } = inboundReplyWakeSchema.parse(event.detail);
    await mod.processStoredReply(inboundMessageId);
  };
}

// A plainly-fake mock key (deliberately NOT the real key prefix — the pre-commit secret
// scanner treats anything shaped like a vendor key as an exposure).
const FAKE_KEY = 'test-anthropic-api-key';
const ANTHROPIC_SECRET = JSON.stringify({ apiKey: FAKE_KEY });
const DB_SECRET = JSON.stringify({ username: 'medadhere_admin', password: 'pw' });
// Real 36-char UUIDs (HIGH-3 lesson).
const INBOUND_ID = '7c9e6679-7425-40de-963d-02d4f4a986e1';
const PATIENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const DOSE_ID = '9b2e6679-4f89-42de-963d-02d4f4a986aa';
const SAFETY_ID = '1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d';
const PATIENT_PHONE = '+15145550123';
const FROM_NUMBER = '+15005550006';
const RAW_BODY = 'took it this morning but felt dizzy after';
const RECEIVED_AT = new Date('2026-07-03T15:00:00Z');
const SENT_AT_IN_WINDOW = new Date('2026-07-03T14:30:00Z'); // 30 min before reply (window 120 min)
const SENT_AT_LATE = new Date('2026-07-03T11:00:00Z'); // 4 h before reply — late but attributable

const VALID_INPUT = { adherence_state: 'taken', reason_code: 'side_effect', safety_flag: 'none' };
const VALID_RESPONSE = {
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', name: 'record_adherence', input: VALID_INPUT }],
  usage: { input_tokens: 100, output_tokens: 30 },
};

/** Historical id-only envelope retained only to avoid rewriting the classifier behavior suite. */
function busEvent(detail: Record<string, unknown> = { inboundMessageId: INBOUND_ID }) {
  return {
    version: '0',
    id: 'evt-1',
    'detail-type': 'inbound-reply.received',
    source: 'medadhere.inbound',
    detail,
  };
}

function findQuery(re: RegExp): [string, unknown[]] | undefined {
  return (queryMock.mock.calls as Array<[string, unknown[]]>).find((c) => re.test(String(c[0])));
}

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
function allLogLines(): string[] {
  return [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls].map((c) =>
    c.map(String).join(' '),
  );
}

/** Default DB dispatch — overridable per test. */
function defaultDbDispatch(
  overrides: {
    preflightExists?: boolean;
    attributionRows?: Array<{ dose_id: string; sent_at: Date }>;
    replyRow?: Record<string, unknown> | null;
    /** The U-12 upsert outcome: 'inserted' (fresh row), 'updated' (both-write, no send), 'none' (already both). */
    safetyUpsert?: 'inserted' | 'updated' | 'none';
    /** Whether the failed-only retry reservation finds a 'failed' row to retry. */
    failedRetryRow?: boolean;
  } = {},
) {
  const replyRow =
    overrides.replyRow === undefined
      ? {
          id: INBOUND_ID,
          patient_id: PATIENT_ID,
          raw_body: RAW_BODY,
          received_at: RECEIVED_AT,
          safety_flagged: false,
          phone: PATIENT_PHONE, // Plan 04-04: the reply query JOINs patient for the send target
        }
      : overrides.replyRow;
  const attributionRows = overrides.attributionRows ?? [
    { dose_id: DOSE_ID, sent_at: SENT_AT_IN_WINDOW },
  ];
  const safetyUpsert = overrides.safetyUpsert ?? 'inserted';
  queryMock.mockImplementation(async (text: string) => {
    const sql = String(text);
    if (/FROM\s+inbound_reply/i.test(sql)) {
      return replyRow ? { rows: [replyRow], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO safety_events/i.test(sql)) {
      if (safetyUpsert === 'none') return { rows: [], rowCount: 0 };
      return {
        rows: [{ id: SAFETY_ID, inserted: safetyUpsert === 'inserted' }],
        rowCount: 1,
      };
    }
    // The failed-only retry reservation (U-18: replays retry ONLY 'failed' rows).
    if (/UPDATE safety_events/i.test(sql) && /'sending'/.test(sql) && /'failed'/.test(sql)) {
      return overrides.failedRetryRow
        ? { rows: [{ id: SAFETY_ID }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    // NOTE: the attribution query's NOT EXISTS subquery also says "FROM adherence_record", so
    // the outbound_message branch MUST be checked first.
    if (/FROM\s+outbound_message/i.test(sql)) {
      return { rows: attributionRows, rowCount: attributionRows.length };
    }
    if (/FROM\s+adherence_record/i.test(sql)) {
      return overrides.preflightExists
        ? { rows: [{ id: 'existing' }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  poolArgs.length = 0;
  anthropicCtorArgs.length = 0;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:db';
  process.env.DB_HOST = 'db.internal';
  process.env.DB_PORT = '5432';
  process.env.DB_NAME = 'medadhere';
  process.env.ANTHROPIC_SECRET_ARN =
    'arn:aws:secretsmanager:us-east-1:000000000000:secret:anthropic';
  process.env.TWILIO_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:twilio';
  process.env.TWILIO_FROM_PARAM = '/medadhere/twilio-from';
  process.env.RESPONSE_WINDOW_MINUTES = '120';
  process.env.LATE_ALLOWANCE_MINUTES = '1320';

  smSend.mockImplementation((cmd: { __args?: { SecretId?: string } }) => {
    const id = cmd.__args?.SecretId ?? '';
    if (id.includes('anthropic')) return Promise.resolve({ SecretString: ANTHROPIC_SECRET });
    if (id.includes('twilio')) {
      return Promise.resolve({
        SecretString: JSON.stringify({ accountSid: 'AC_test', authToken: 'tok_test' }),
      });
    }
    return Promise.resolve({ SecretString: DB_SECRET });
  });
  ssmSend.mockResolvedValue({ Parameter: { Value: FROM_NUMBER } });
  smsCreate.mockResolvedValue({ sid: 'SM_safety_model_1', status: 'queued' });
  messagesCreate.mockResolvedValue(VALID_RESPONSE);
  defaultDbDispatch();
  // Default label_match writer client: a dedicated pooled client whose queries succeed.
  connectMock.mockImplementation(async () => ({
    query: vi.fn().mockResolvedValue({ rowCount: 1 }),
    release: vi.fn(),
  }));
});

describe('classifier handler — happy path: attribute, classify, single-arbiter write (SC2/PIPE-04)', () => {
  it('exposes the stored-reply processor by id for the FIFO worker', async () => {
    vi.resetModules();
    const { processStoredReply } = await import('./handler.js');

    await expect(processStoredReply(INBOUND_ID)).resolves.toBeUndefined();
    expect(findQuery(/FROM\s+inbound_reply/i)?.[1]).toEqual([INBOUND_ID]);
  });

  it('writes the classifier row with the SINGLE (dose_id) arbiter overwriting ONLY timeout rows', async () => {
    const handler = await freshHandler();
    await expect(handler(busEvent())).resolves.toBeUndefined();

    expect(messagesCreate).toHaveBeenCalledTimes(1);

    const insert = findQuery(/INSERT INTO adherence_record/i);
    expect(insert).toBeDefined();
    const [sql, params] = insert!;
    expect(sql).toMatch(/ON CONFLICT\s*\(\s*dose_id\s*\)\s*DO\s+UPDATE/i);
    expect(sql).toMatch(/WHERE\s+adherence_record\.decided_by\s*=\s*'timeout'/i);
    expect(sql).toMatch(/'classifier'/);
    expect(sql).toMatch(/'recorded'/);
    // H2 (Phase-5 hotfix): the ON CONFLICT DO UPDATE SET must ALSO flip status back to 'recorded'.
    // A late reply overwriting a timeout row previously left status='missed' (only decided_by flipped)
    // → the dashboard rendered a taken dose as missed. Assert the SET clause carries status='recorded'.
    expect(sql).toMatch(/DO\s+UPDATE\s+SET[\s\S]*\bstatus\s*=\s*'recorded'/i);
    // ONE arbiter only — a second ON CONFLICT is a PG syntax error class the plan forbids.
    expect(sql.match(/ON CONFLICT/gi)).toHaveLength(1);
    expect(params).toEqual([PATIENT_ID, DOSE_ID, INBOUND_ID, 'taken', 'side_effect', 'none']);
  });

  it('attributes via the most-recent in-window outbound with no classifier-decided record (PIPE-10)', async () => {
    const handler = await freshHandler();
    await handler(busEvent());
    const attribution = findQuery(/FROM\s+outbound_message/i);
    expect(attribution).toBeDefined();
    const [sql, params] = attribution!;
    expect(sql).toMatch(/ORDER BY\s+.*sent_at\s+DESC/i);
    expect(sql).toMatch(/LIMIT\s+1/i);
    expect(sql).toMatch(/NOT EXISTS/i);
    expect(sql).toMatch(/decided_by\s*=\s*'classifier'/i);
    expect(params).toContain(PATIENT_ID);
  });

  it('marks the reply attributed + NOT late when inside the response window (PIPE-06)', async () => {
    const handler = await freshHandler();
    await handler(busEvent());
    const update = findQuery(/UPDATE inbound_reply/i);
    expect(update).toBeDefined();
    const [, params] = update!;
    expect(params).toEqual([DOSE_ID, false, INBOUND_ID]);
  });

  it('marks is_late = true when the reply arrives after the response window but inside the attribution window', async () => {
    defaultDbDispatch({ attributionRows: [{ dose_id: DOSE_ID, sent_at: SENT_AT_LATE }] });
    const handler = await freshHandler();
    await handler(busEvent());
    const update = findQuery(/UPDATE inbound_reply/i);
    expect(update![1]).toEqual([DOSE_ID, true, INBOUND_ID]);
  });

  it('constructs the Anthropic client per-invoke AFTER the secret read, with the secret apiKey', async () => {
    const handler = await freshHandler();
    await handler(busEvent());
    expect(anthropicCtorArgs).toHaveLength(1);
    expect(anthropicCtorArgs[0]?.apiKey).toBe(FAKE_KEY);
  });
});

describe('classifier handler — 04-obs: per-call usage telemetry (classifier_usage metric, PII-free)', () => {
  function usageLine(): string | undefined {
    return allLogLines().find((l) => /"metric":"classifier_usage"/.test(l));
  }

  it('logs one classifier_usage metric with model/promptVersion/latency/tokens/cost and no identifiers', async () => {
    const handler = await freshHandler();
    await handler(busEvent());

    const line = usageLine();
    expect(line).toBeDefined();
    const rec = JSON.parse(line!) as Record<string, unknown>;
    expect(rec).not.toHaveProperty('inboundMessageId');
    expect(typeof rec.model).toBe('string');
    expect((rec.model as string).length).toBeGreaterThan(0);
    expect(typeof rec.promptVersion).toBe('string');
    expect((rec.promptVersion as string).length).toBeGreaterThan(0);
    expect(typeof rec.latencyMs).toBe('number');
    expect(rec.inputTokens).toBe(100); // VALID_RESPONSE.usage.input_tokens
    expect(rec.outputTokens).toBe(30); // VALID_RESPONSE.usage.output_tokens
    // list price: (100 * $1 + 30 * $5) / 1e6 = 0.00025
    expect(rec.estimatedCostUsd).toBeCloseTo(0.00025, 10);
  });

  it('the usage line is PII-free — carries no reply text or linkable identifiers', async () => {
    const handler = await freshHandler();
    await handler(busEvent());

    const line = usageLine();
    expect(line).toBeDefined();
    expect(line!).not.toContain(RAW_BODY);
    expect(line!.toLowerCase()).not.toContain('dizzy'); // a distinctive token from RAW_BODY
    for (const sensitiveValue of [PATIENT_ID, INBOUND_ID, DOSE_ID, PATIENT_PHONE, SAFETY_ID]) {
      expect(line).not.toContain(sensitiveValue);
    }
  });

  it('a THROWING telemetry sink is swallowed — the classifier row is still written', async () => {
    // Force the classifier_usage log line to throw. The pure core wraps onUsage in try/catch,
    // so this must be swallowed and the classification + write path must still complete —
    // observability can never block the patient path. (The weaker happy-path-only assertion
    // would pass even if the swallow were removed; this genuinely exercises the throw.)
    const handler = await freshHandler();
    logSpy.mockImplementation((line?: unknown) => {
      if (typeof line === 'string' && line.includes('"metric":"classifier_usage"')) {
        throw new Error('telemetry sink exploded');
      }
    });
    await expect(handler(busEvent())).resolves.toBeUndefined();
    expect(findQuery(/INSERT INTO adherence_record/i)).toBeDefined();
  });
});

describe('classifier handler — CHECK-BEFORE-SPEND replay pre-flight (U-02/REV-H2)', () => {
  it('a redelivered event → ZERO Anthropic calls, ZERO attribution queries, no INSERT, success', async () => {
    defaultDbDispatch({ preflightExists: true });
    const handler = await freshHandler();
    await expect(handler(busEvent())).resolves.toBeUndefined();
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(findQuery(/FROM\s+outbound_message/i)).toBeUndefined(); // re-attributes NOTHING
    expect(findQuery(/INSERT INTO adherence_record/i)).toBeUndefined();
  });

  it('U-04 replay-count assertion: success then duplicate delivery = exactly ONE paid call total', async () => {
    const handler = await freshHandler();
    await handler(busEvent()); // first delivery: classifies + writes
    defaultDbDispatch({ preflightExists: true }); // the row now exists
    await handler(busEvent()); // duplicate delivery
    expect(messagesCreate).toHaveBeenCalledTimes(1);
  });
});

describe('classifier handler — unattributed replies (PIPE-10 / U-01: dose_id NULL, single write path)', () => {
  it('no in-window outbound → INSERT with dose_id NULL; no inbound_reply dose update', async () => {
    defaultDbDispatch({ attributionRows: [] });
    const handler = await freshHandler();
    await expect(handler(busEvent())).resolves.toBeUndefined();
    const insert = findQuery(/INSERT INTO adherence_record/i);
    expect(insert).toBeDefined();
    expect(insert![1]).toEqual([PATIENT_ID, null, INBOUND_ID, 'taken', 'side_effect', 'none']);
  });

  it('DOSE COLLISION (review CRITICAL fix): a WHERE-false zero-row conflict on an attributed write persists the reply UNATTRIBUTED instead of discarding it', async () => {
    // The dose already has a classifier-decided row (double-text correction / concurrent
    // same-dose writer): PG affects 0 rows with NO error — the classification must survive.
    const insertParams: unknown[][] = [];
    queryMock.mockImplementation(async (text: string, params?: unknown[]) => {
      const sql = String(text);
      if (/FROM\s+inbound_reply/i.test(sql)) {
        return {
          rows: [
            {
              id: INBOUND_ID,
              patient_id: PATIENT_ID,
              raw_body: RAW_BODY,
              received_at: RECEIVED_AT,
              safety_flagged: false,
            },
          ],
          rowCount: 1,
        };
      }
      if (/FROM\s+outbound_message/i.test(sql)) {
        return { rows: [{ dose_id: DOSE_ID, sent_at: SENT_AT_IN_WINDOW }], rowCount: 1 };
      }
      if (/FROM\s+adherence_record/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO adherence_record/i.test(sql)) {
        insertParams.push(params ?? []);
        // First (attributed) insert: WHERE-false conflict → 0 rows, NO error.
        // Second (compensating, dose_id NULL) insert: plain insert succeeds.
        return { rows: [], rowCount: insertParams.length === 1 ? 0 : 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const handler = await freshHandler();
    await expect(handler(busEvent())).resolves.toBeUndefined();

    expect(insertParams).toHaveLength(2);
    expect(insertParams[0]![1]).toBe(DOSE_ID); // the attributed attempt
    expect(insertParams[1]![1]).toBeNull(); // the compensating UNATTRIBUTED write
    expect(insertParams[1]![2]).toBe(INBOUND_ID); // same reply, classification preserved
    expect(allLogLines().some((l) => l.includes('classifier_dose_collision'))).toBe(true);
  });

  it('a concurrent SAME-EVENT redelivery that hits the collision path lands on the 23505 backstop → success', async () => {
    let insertCalls = 0;
    queryMock.mockImplementation(async (text: string) => {
      const sql = String(text);
      if (/FROM\s+inbound_reply/i.test(sql)) {
        return {
          rows: [
            {
              id: INBOUND_ID,
              patient_id: PATIENT_ID,
              raw_body: RAW_BODY,
              received_at: RECEIVED_AT,
              safety_flagged: false,
            },
          ],
          rowCount: 1,
        };
      }
      if (/FROM\s+outbound_message/i.test(sql)) {
        return { rows: [{ dose_id: DOSE_ID, sent_at: SENT_AT_IN_WINDOW }], rowCount: 1 };
      }
      if (/FROM\s+adherence_record/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO adherence_record/i.test(sql)) {
        insertCalls += 1;
        if (insertCalls === 1) return { rows: [], rowCount: 0 }; // WHERE-false no-op
        // The other writer already recorded this inbound_message_id.
        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
          constraint: 'adherence_record_inbound_message_id_key',
        });
      }
      return { rows: [], rowCount: 1 };
    });

    const handler = await freshHandler();
    await expect(handler(busEvent())).resolves.toBeUndefined();
    expect(insertCalls).toBe(2);
  });

  it('the 23505 race on UNIQUE(inbound_message_id) is caught and treated as SUCCESS (the explicit backstop)', async () => {
    defaultDbDispatch({ attributionRows: [] });
    queryMock.mockImplementation(async (text: string) => {
      const sql = String(text);
      if (/FROM\s+inbound_reply/i.test(sql)) {
        return {
          rows: [
            {
              id: INBOUND_ID,
              patient_id: PATIENT_ID,
              raw_body: RAW_BODY,
              received_at: RECEIVED_AT,
              safety_flagged: false,
            },
          ],
          rowCount: 1,
        };
      }
      if (/FROM\s+outbound_message/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM\s+adherence_record/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO adherence_record/i.test(sql)) {
        const raceErr = Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
          constraint: 'adherence_record_inbound_message_id_key',
        });
        throw raceErr;
      }
      return { rows: [], rowCount: 1 };
    });
    const handler = await freshHandler();
    await expect(handler(busEvent())).resolves.toBeUndefined();
  });
});

describe('classifier handler — SC4 TERMINAL POLICY (U-04/REV-H3: unknown + success, never a re-drive)', () => {
  it('transient exhaustion (RateLimitError) → writes {unknown, other, none} and RESOLVES', async () => {
    messagesCreate.mockRejectedValue(sdkError('RateLimitError', { status: 429 }));
    const handler = await freshHandler();
    await expect(handler(busEvent())).resolves.toBeUndefined();
    const insert = findQuery(/INSERT INTO adherence_record/i);
    expect(insert).toBeDefined();
    expect(insert![1]).toEqual([PATIENT_ID, DOSE_ID, INBOUND_ID, 'unknown', 'other', 'none']);
    expect(allLogLines().some((l) => l.includes('classifier_transient_exhausted'))).toBe(true);
  });

  it('401 AuthenticationError → unknown row + success + the DISTINCT anthropic_auth_failure metric', async () => {
    messagesCreate.mockRejectedValue(sdkError('AuthenticationError', { status: 401 }));
    const handler = await freshHandler();
    await expect(handler(busEvent())).resolves.toBeUndefined();
    const insert = findQuery(/INSERT INTO adherence_record/i);
    expect(insert![1]).toEqual([PATIENT_ID, DOSE_ID, INBOUND_ID, 'unknown', 'other', 'none']);
    expect(allLogLines().some((l) => l.includes('anthropic_auth_failure'))).toBe(true);
  });

  it('contract failure (enum drift) → unknown row, success, NO second LLM call', async () => {
    messagesCreate.mockResolvedValue({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          name: 'record_adherence',
          input: { adherence_state: 'partial', reason_code: 'none', safety_flag: 'none' },
        },
      ],
    });
    const handler = await freshHandler();
    await expect(handler(busEvent())).resolves.toBeUndefined();
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    const insert = findQuery(/INSERT INTO adherence_record/i);
    expect(insert![1]).toEqual([PATIENT_ID, DOSE_ID, INBOUND_ID, 'unknown', 'other', 'none']);
  });

  it('U-16: the contract-failure log carries issue paths/codes ONLY — never the reply text or received values', async () => {
    messagesCreate.mockResolvedValue({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          name: 'record_adherence',
          input: { adherence_state: 'partial', reason_code: 'none', safety_flag: 'none' },
        },
      ],
    });
    const handler = await freshHandler();
    await handler(busEvent());
    const lines = allLogLines();
    expect(lines.some((l) => l.includes('classifier_contract_failure'))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain(RAW_BODY);
      expect(line).not.toContain('partial'); // the received value never leaks into logs
    }
    // The path label IS logged (the diagnosable part).
    expect(lines.some((l) => l.includes('adherence_state'))).toBe(true);
  });

  it('a DB failure is CRASH-CLASS: it propagates for FIFO retry — never a silent success', async () => {
    queryMock.mockRejectedValue(new Error('connection refused'));
    const handler = await freshHandler();
    await expect(handler(busEvent())).rejects.toThrow(/connection refused/);
  });
});

describe('classifier handler — boundary guards', () => {
  it('a malformed detail (extra key) REJECTS — crash-class, never a guessed classification', async () => {
    const handler = await freshHandler();
    await expect(
      handler(busEvent({ inboundMessageId: INBOUND_ID, rawBody: 'smuggled' })),
    ).rejects.toThrow();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('a non-uuid inboundMessageId REJECTS before any DB/LLM work', async () => {
    const handler = await freshHandler();
    await expect(handler(busEvent({ inboundMessageId: 'not-a-uuid' }))).rejects.toThrow();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('a missing inbound_reply row (STUDY-04 wipe race) → success + metric, no LLM call', async () => {
    defaultDbDispatch({ replyRow: null });
    const handler = await freshHandler();
    await expect(handler(busEvent())).resolves.toBeUndefined();
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(allLogLines().some((l) => l.includes(INBOUND_ID))).toBe(false);
  });

  it('missing ANTHROPIC_SECRET_ARN env → rejects with an actionable error', async () => {
    delete process.env.ANTHROPIC_SECRET_ARN;
    const handler = await freshHandler();
    await expect(handler(busEvent())).rejects.toThrow(/ANTHROPIC_SECRET_ARN/);
  });

  it('M3: constructs the pg.Pool with the pinned CA + rejectUnauthorized:true + max 2', async () => {
    const handler = await freshHandler();
    await handler(busEvent());
    expect(poolArgs).toHaveLength(1);
    const ssl = poolArgs[0]?.ssl as { ca?: unknown; rejectUnauthorized?: unknown } | undefined;
    expect(ssl?.rejectUnauthorized).toBe(true);
    expect(typeof ssl?.ca).toBe('string');
    expect(poolArgs[0]?.max).toBe(2);
  });
});

// ================================ Plan 04-04 — safety completion ================================

/** A classification response carrying the given safety flag. */
function responseWithFlag(safetyFlag: string) {
  return {
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        name: 'record_adherence',
        input: { adherence_state: 'taken', reason_code: 'side_effect', safety_flag: safetyFlag },
      },
    ],
  };
}

describe('classifier — 04-04: model-flag safety OR (SC3 second detector, U-12 xmax-gated upsert)', () => {
  it("acute_physical → the EXACT U-12 both-detectors upsert, model provenance, 'sending' reservation, EMERGENCY send, lifecycle → sent", async () => {
    messagesCreate.mockResolvedValue(responseWithFlag('acute_physical'));
    const handler = await freshHandler();
    await expect(handler(busEvent())).resolves.toBeUndefined();

    const upsert = findQuery(/INSERT INTO safety_events/i);
    expect(upsert).toBeDefined();
    const [sql, params] = upsert!;
    // The U-12 normative clause: a mirrored DO NOTHING can never reach 'both'; the xmax trick
    // distinguishes a fresh insert (send) from a both-write (never send).
    expect(sql).toMatch(
      /ON CONFLICT\s*\(\s*inbound_message_id\s*\)\s*DO\s+UPDATE\s+SET\s+trigger_source\s*=\s*'both'/i,
    );
    expect(sql).toMatch(/WHERE\s+safety_events\.trigger_source\s*<>\s*'both'/i);
    expect(sql).toMatch(/RETURNING\s+id\s*,\s*\(\s*xmax\s*=\s*0\s*\)\s+AS\s+inserted/i);
    expect(sql).toMatch(/'model'/); // provenance: this is the classifier-side detector
    expect(sql).toMatch(/'sending'/); // the U-18 lifecycle reservation rides the insert
    expect(params).toEqual([PATIENT_ID, INBOUND_ID, 'acute_physical']);

    // The auto-reply went out with the shared EMERGENCY template.
    expect(smsCreate).toHaveBeenCalledTimes(1);
    expect(smsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: PATIENT_PHONE,
        from: FROM_NUMBER,
        body: SAFETY_AUTO_REPLY_EMERGENCY,
      }),
    );

    // Lifecycle completion on the returned safety-event id.
    const lifecycle = findQuery(/UPDATE safety_events[\s\S]*auto_reply_status\s*=\s*'sent'/i);
    expect(lifecycle).toBeDefined();
    expect(lifecycle![1]).toEqual(['SM_safety_model_1', SAFETY_ID]);

    // The adherence row still carries the REAL validated flag.
    const insert = findQuery(/INSERT INTO adherence_record/i);
    expect(insert![1]).toEqual([
      PATIENT_ID,
      DOSE_ID,
      INBOUND_ID,
      'taken',
      'side_effect',
      'acute_physical',
    ]);
  });

  it('the send is gated STRICTLY on inserted=true: a both-write (row existed) sends NOTHING new', async () => {
    messagesCreate.mockResolvedValue(responseWithFlag('crisis'));
    defaultDbDispatch({ safetyUpsert: 'updated' }); // prefilter already owns the row
    const handler = await freshHandler();
    await handler(busEvent());
    expect(smsCreate).not.toHaveBeenCalled();
  });

  it("…but a both-write over a FAILED prior send retries it (U-18: replays retry ONLY 'failed' rows)", async () => {
    messagesCreate.mockResolvedValue(responseWithFlag('crisis'));
    defaultDbDispatch({ safetyUpsert: 'updated', failedRetryRow: true });
    const handler = await freshHandler();
    await handler(busEvent());

    // The retry reservation flips ONLY a 'failed' row back to 'sending'.
    const retry = findQuery(/UPDATE safety_events[\s\S]*'sending'[\s\S]*'failed'/i);
    expect(retry).toBeDefined();
    expect(smsCreate).toHaveBeenCalledTimes(1);
    const lifecycle = findQuery(/UPDATE safety_events[\s\S]*auto_reply_status\s*=\s*'sent'/i);
    expect(lifecycle).toBeDefined();
  });

  it('an already-both row (no row returned) with no failed send → nothing to do', async () => {
    messagesCreate.mockResolvedValue(responseWithFlag('acute_physical'));
    defaultDbDispatch({ safetyUpsert: 'none' });
    const handler = await freshHandler();
    await handler(busEvent());
    expect(smsCreate).not.toHaveBeenCalled();
  });

  it('medical_question → the softer 811 template (SAFETY-04), flag persisted, NO emergency template', async () => {
    messagesCreate.mockResolvedValue(responseWithFlag('medical_question'));
    const handler = await freshHandler();
    await handler(busEvent());

    const upsert = findQuery(/INSERT INTO safety_events/i);
    expect(upsert![1]).toEqual([PATIENT_ID, INBOUND_ID, 'medical_question']);
    expect(smsCreate).toHaveBeenCalledTimes(1);
    expect((smsCreate.mock.calls[0]![0] as { body: string }).body).toBe(
      SAFETY_AUTO_REPLY_MEDICAL_QUESTION,
    );
    const insert = findQuery(/INSERT INTO adherence_record/i);
    expect(insert![1][5]).toBe('medical_question');
  });

  it('safety_flag none → ZERO safety statements, zero sends', async () => {
    const handler = await freshHandler(); // default VALID_RESPONSE carries safety_flag none
    await handler(busEvent());
    expect(findQuery(/safety_events/i)).toBeUndefined();
    expect(smsCreate).not.toHaveBeenCalled();
  });

  it("a Twilio failure on the model-side send records 'failed' — and the adherence write still happens", async () => {
    messagesCreate.mockResolvedValue(responseWithFlag('acute_physical'));
    smsCreate.mockRejectedValue(new Error('Twilio 30007: carrier violation'));
    const handler = await freshHandler();
    await expect(handler(busEvent())).resolves.toBeUndefined();

    const lifecycle = findQuery(/UPDATE safety_events[\s\S]*auto_reply_status\s*=\s*'failed'/i);
    expect(lifecycle).toBeDefined();
    expect(findQuery(/INSERT INTO adherence_record/i)).toBeDefined();
  });

  it("Twilio 21610 (Advanced Opt-Out blocklist) → 'suppressed' (U-18: a STOP'd tester texting a crisis)", async () => {
    messagesCreate.mockResolvedValue(responseWithFlag('crisis'));
    smsCreate.mockRejectedValue(
      Object.assign(new Error('The recipient is unsubscribed'), { code: 21610 }),
    );
    const handler = await freshHandler();
    await expect(handler(busEvent())).resolves.toBeUndefined();
    const lifecycle = findQuery(/UPDATE safety_events[\s\S]*auto_reply_status\s*=\s*'suppressed'/i);
    expect(lifecycle).toBeDefined();
  });
});

describe('classifier — 04-04: U-11 contract-failure safety salvage (fail-OPEN on safety, fail-CLOSED on the label)', () => {
  it('a malformed object carrying a valid crisis flag STILL escalates: safety action fires, label falls to unknown', async () => {
    messagesCreate.mockResolvedValue({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          name: 'record_adherence',
          // Invalid label axis, VALID safety axis — the exact U-11 case.
          input: { adherence_state: 'partial', reason_code: 'none', safety_flag: 'crisis' },
        },
      ],
    });
    const handler = await freshHandler();
    await expect(handler(busEvent())).resolves.toBeUndefined();

    // Salvaged safety action: upsert with the shallow-read flag + the send.
    const upsert = findQuery(/INSERT INTO safety_events/i);
    expect(upsert).toBeDefined();
    expect(upsert![1]).toEqual([PATIENT_ID, INBOUND_ID, 'crisis']);
    expect(smsCreate).toHaveBeenCalledTimes(1);

    // Label fail-closed: the terminal row is { unknown, other, none } — never the drifted label.
    const insert = findQuery(/INSERT INTO adherence_record/i);
    expect(insert![1]).toEqual([PATIENT_ID, DOSE_ID, INBOUND_ID, 'unknown', 'other', 'none']);
  });

  it('a malformed object with safety_flag none (or absent) salvages NOTHING', async () => {
    messagesCreate.mockResolvedValue({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          name: 'record_adherence',
          input: { adherence_state: 'partial', reason_code: 'none', safety_flag: 'none' },
        },
      ],
    });
    const handler = await freshHandler();
    await handler(busEvent());
    expect(findQuery(/safety_events/i)).toBeUndefined();
    expect(smsCreate).not.toHaveBeenCalled();
  });

  it('a prose response (no tool block at all) has nothing to salvage — no safety action, unknown row', async () => {
    messagesCreate.mockResolvedValue({ stop_reason: 'end_turn', content: [] });
    const handler = await freshHandler();
    await handler(busEvent());
    expect(findQuery(/safety_events/i)).toBeUndefined();
    const insert = findQuery(/INSERT INTO adherence_record/i);
    expect(insert![1]).toEqual([PATIENT_ID, DOSE_ID, INBOUND_ID, 'unknown', 'other', 'none']);
  });
});

describe('classifier — 04-04: SC3 divert-independence (classifier half) + U-17 characterization', () => {
  it('SC3 non-negotiable (classifier side): a prefilter-flagged reply + a THROWING stub → no second SMS, terminal unknown row (the inbound side already sent — 04-02 tests own that half)', async () => {
    messagesCreate.mockRejectedValue(sdkError('RateLimitError', { status: 429 }));
    defaultDbDispatch({
      replyRow: {
        id: INBOUND_ID,
        patient_id: PATIENT_ID,
        raw_body: 'having chest pain since this morning',
        received_at: RECEIVED_AT,
        safety_flagged: true, // the prefilter already diverted inbound-side
        phone: PATIENT_PHONE,
      },
      safetyUpsert: 'updated', // the prefilter row exists; no failed send
    });
    const handler = await freshHandler();
    await expect(handler(busEvent())).resolves.toBeUndefined();
    expect(smsCreate).not.toHaveBeenCalled(); // send-once holds ACROSS detectors
    const insert = findQuery(/INSERT INTO adherence_record/i);
    expect(insert![1].slice(3)).toEqual(['unknown', 'other', 'none']);
  });

  it('U-17 characterization: a prefilter-NEGATIVE reply + a throwing stub → NO safety action anywhere, visible unknown row (the documented semantic-outage residual)', async () => {
    messagesCreate.mockRejectedValue(sdkError('RateLimitError', { status: 429 }));
    const handler = await freshHandler(); // default reply: safety_flagged=false, benign body
    await expect(handler(busEvent())).resolves.toBeUndefined();
    expect(findQuery(/safety_events/i)).toBeUndefined();
    expect(smsCreate).not.toHaveBeenCalled();
    const insert = findQuery(/INSERT INTO adherence_record/i);
    expect(insert![1].slice(3)).toEqual(['unknown', 'other', 'none']);
  });
});

describe('classifier — OnSIDES exclusion boundary', () => {
  const resolvedProfile = { label_features_enabled: true, rxcui: '6809' };

  it('does not run the removed ADE matcher when the patient has no frozen profile', async () => {
    defaultDbDispatch(); // default replyRow has no drug_profile_json
    const handler = await freshHandler();
    await expect(handler(busEvent())).resolves.toBeUndefined();
    expect(allLogLines().some((line) => /ade_matcher_/.test(line))).toBe(false);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('does not consult or persist excluded OnSIDES data even with a resolved drug profile', async () => {
    defaultDbDispatch({
      replyRow: {
        id: INBOUND_ID,
        patient_id: PATIENT_ID,
        raw_body: RAW_BODY,
        received_at: RECEIVED_AT,
        safety_flagged: false,
        phone: PATIENT_PHONE,
        drug_profile_json: resolvedProfile,
      },
    });
    const handler = await freshHandler();
    await expect(handler(busEvent())).resolves.toBeUndefined();
    const lines = allLogLines();
    expect(lines.some((line) => /classifier_recorded/.test(line))).toBe(true);
    expect(lines.some((line) => /ade_matcher_/.test(line))).toBe(false);
    expect(connectMock).not.toHaveBeenCalled();
  });
});

describe('classifier — 05-04 OPS-02: safety_event_recorded identifier-free metric (Q6/L3)', () => {
  it('emits safety_event_recorded without linkable ids when the model detector creates a FRESH safety_events row', async () => {
    messagesCreate.mockResolvedValue(responseWithFlag('crisis'));
    const handler = await freshHandler(); // default safetyUpsert 'inserted'
    await handler(busEvent());
    const line = allLogLines().find((l) => l.includes('safety_event_recorded'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!);
    expect(parsed).toEqual({ metric: 'safety_event_recorded', source: 'model' });
    for (const sensitiveValue of [PATIENT_ID, INBOUND_ID, SAFETY_ID, PATIENT_PHONE, RAW_BODY]) {
      expect(line).not.toContain(sensitiveValue);
    }
  });

  it('does NOT emit safety_event_recorded on a both-write (the row already existed — not a new insert)', async () => {
    messagesCreate.mockResolvedValue(responseWithFlag('crisis'));
    defaultDbDispatch({ safetyUpsert: 'updated' });
    const handler = await freshHandler();
    await handler(busEvent());
    expect(allLogLines().some((l) => l.includes('safety_event_recorded'))).toBe(false);
  });

  it('does NOT emit safety_event_recorded when safety_flag is none (no safety event at all)', async () => {
    const handler = await freshHandler(); // default VALID_RESPONSE → safety_flag none
    await handler(busEvent());
    expect(allLogLines().some((l) => l.includes('safety_event_recorded'))).toBe(false);
  });
});
