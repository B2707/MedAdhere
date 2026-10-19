import { describe, it, expect, vi, beforeEach } from 'vitest';

// Anthropic-direct (D-ANTHROPIC) unit test (CI-safe — no live network, no AWS credentials, no real
// API key). It covers (1) the pure helpers the handler is factored into — the Messages-API forced-
// tool shape (`input_schema` + `tool_choice:{type:'tool',name}`) and the `.parse()` @medadhere/shared
// D-16 contract gate — and (2) the handler's runtime guards, by mocking
// @aws-sdk/client-secrets-manager + @anthropic-ai/sdk. The live Messages API call against Haiku 4.5
// runs only in the deployed Lambda, never here.
//
// The handler block is the regression gate the post-exec review (MEDIUM) mandated: the
// no-apiKey guard is the D-DEPLOY-1 deploy-blocker-class guard (the placeholder secret CDK
// synthesizes is a NON-EMPTY JSON object, so the empty-string guard can't catch it) — it must throw
// the actionable "not yet populated" error and NOT fall through to `new Anthropic({apiKey:undefined})`.
// This mirrors the sibling twilio.test.ts (TEST-1), the proven in-repo precedent for this exact guard.

// vi.mock is hoisted above the imports; spies the factories close over must be created via vi.hoisted.
// anthropic.ts constructs `new SecretsManagerClient({})` at import time (must be a `new`-able real
// function); `new Anthropic({apiKey,…})` is constructed per-invoke inside the handler.
const { smSend, messagesCreate, anthropicFactory } = vi.hoisted(() => {
  const messagesCreate = vi.fn();
  return {
    smSend: vi.fn(),
    messagesCreate,
    // `new Anthropic({apiKey,…})` → returns this object; vi.fn records the ctor args so the test can
    // assert the apiKey from the secret reached the SDK (and is never an env var). Must be a `new`-able
    // real `function` (an arrow fn is not a constructor — `new` would throw).
    anthropicFactory: vi.fn(function () {
      return { messages: { create: messagesCreate } };
    }),
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

// @anthropic-ai/sdk is a default import (`import Anthropic from '@anthropic-ai/sdk'`).
vi.mock('@anthropic-ai/sdk', () => ({ default: anthropicFactory }));

// Import AFTER the mocks are registered. @medadhere/shared is the REAL .parse() gate (never mocked).
import {
  AdherenceClassification,
  adherenceClassificationJsonSchema,
} from '@medadhere/shared';
import {
  TOOL_NAME,
  buildAnthropicToolConfig,
  parseToolUseOrThrow,
  handler,
} from './anthropic.js';

describe('buildAnthropicToolConfig (Anthropic Messages-API forced-tool shape, D-ANTHROPIC)', () => {
  it('forces the record_adherence tool via tool_choice:{type:"tool",name} (never "auto")', () => {
    const cfg = buildAnthropicToolConfig();
    // The FORCED Anthropic Messages-API shape — `{ type: 'tool', name }`, never `"auto"`.
    expect(cfg.tool_choice).toEqual({ type: 'tool', name: TOOL_NAME });
    expect(cfg.tool_choice).not.toBe('auto');
  });

  it('tools[0] has the snake_case input_schema = the self-contained packages/shared schema', () => {
    const cfg = buildAnthropicToolConfig();
    const tool = cfg.tools[0];
    expect(tool).toBeDefined();
    // Anthropic Messages-API shape: { name, description, input_schema } — the field is `input_schema`.
    expect(tool?.name).toBe(TOOL_NAME);
    expect(typeof tool?.description).toBe('string');
    expect(tool?.input_schema).toEqual(adherenceClassificationJsonSchema);
    // The tool carries exactly the Anthropic field names — no stray `toolSpec`/`inputSchema` wrappers.
    expect('toolSpec' in tool!).toBe(false);
    expect('inputSchema' in tool!).toBe(false);
  });

  it('input_schema is self-contained ($refStrategy:"none" — no $ref / definitions)', () => {
    const cfg = buildAnthropicToolConfig();
    const json = JSON.stringify(cfg.tools[0]?.input_schema);
    expect(json).not.toContain('$ref');
    expect(json).not.toContain('definitions');
  });
});

describe('parseToolUseOrThrow (the .parse() contract gate over the Anthropic response shape, D-16)', () => {
  it('returns the parsed AdherenceClassification for a well-formed tool_use block', () => {
    const res = {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          name: TOOL_NAME,
          input: {
            adherence_state: 'delayed',
            reason_code: 'side_effect',
            safety_flag: 'none',
          },
        },
      ],
    };
    const parsed = parseToolUseOrThrow(res);
    expect(parsed).toEqual({
      adherence_state: 'delayed',
      reason_code: 'side_effect',
      safety_flag: 'none',
    });
    // Sanity: it is exactly what the canonical schema would accept.
    expect(() => AdherenceClassification.parse(parsed)).not.toThrow();
  });

  it('throws on out-of-enum input inside a tool_use block (the .parse() gate rejects model enum drift)', () => {
    const res = {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          name: TOOL_NAME,
          input: {
            adherence_state: 'definitely_took_it', // not a member of the enum
            reason_code: 'none',
            safety_flag: 'none',
          },
        },
      ],
    };
    expect(() => parseToolUseOrThrow(res)).toThrow();
  });

  it('throws when stop_reason !== "tool_use" (no silent prose acceptance)', () => {
    const res = {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Sure — they took it!' }],
    };
    expect(() => parseToolUseOrThrow(res)).toThrow(/tool_use|end_turn/);
  });

  it('throws when there is no tool_use block in content[] (only a text block under a tool_use stop_reason)', () => {
    const res = {
      stop_reason: 'tool_use',
      content: [{ type: 'text', text: 'no tool here' }],
    };
    expect(() => parseToolUseOrThrow(res)).toThrow();
  });

  it('throws when content[] is empty/undefined under a tool_use stop_reason', () => {
    expect(() => parseToolUseOrThrow({ stop_reason: 'tool_use', content: [] })).toThrow();
    expect(() => parseToolUseOrThrow({ stop_reason: 'tool_use' })).toThrow();
  });

  it('throws when the tool_use block has a DIFFERENT name than the forced tool (WR-01 — never parse another tool as a classification)', () => {
    // Input is a VALID classification, so only the name check can reject it — proving the helper does
    // not parse a foreign tool's payload as an adherence classification (matters for the Phase-4 reuse).
    const res = {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          name: 'some_other_tool',
          input: { adherence_state: 'delayed', reason_code: 'side_effect', safety_flag: 'none' },
        },
      ],
    };
    expect(() => parseToolUseOrThrow(res)).toThrow(/record_adherence/);
  });
});

// --- Handler runtime guards (TEST-quality gate; mirrors twilio.test.ts TEST-1) ------------
describe('anthropic-smoke handler — secret population & env guards (D-DEPLOY-1 regression)', () => {
  const VALID_SECRET = JSON.stringify({ apiKey: 'sk-ant-test' });
  const WELL_FORMED_RESPONSE = {
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        name: TOOL_NAME,
        input: { adherence_state: 'delayed', reason_code: 'side_effect', safety_flag: 'none' },
      },
    ],
    usage: { input_tokens: 12, output_tokens: 7 },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_SECRET_ARN =
      'arn:aws:secretsmanager:us-east-1:000000000000:secret:anthropic';
    smSend.mockResolvedValue({ SecretString: VALID_SECRET });
    messagesCreate.mockResolvedValue(WELL_FORMED_RESPONSE);
  });

  it('throws the actionable error on the NON-EMPTY placeholder secret (no apiKey) and NEVER constructs the client', async () => {
    // The placeholder secret CDK actually synthesizes — a non-empty JSON object with no apiKey.
    smSend.mockResolvedValue({ SecretString: JSON.stringify({ placeholder: 'x' }) });
    await expect(handler()).rejects.toThrow(/not yet populated \(no apiKey\)/);
    // The load-bearing assertion: we must NOT fall through to new Anthropic({apiKey:undefined}).
    expect(anthropicFactory).not.toHaveBeenCalled();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('throws on a truly empty SecretString', async () => {
    smSend.mockResolvedValue({ SecretString: '' });
    await expect(handler()).rejects.toThrow(/not yet populated/);
    expect(anthropicFactory).not.toHaveBeenCalled();
  });

  it('WR-06: throws the actionable shape-naming error on a present-but-NON-JSON secret (raw key, not JSON) and NEVER constructs the client', async () => {
    // An operator stored the raw `sk-ant-…` key instead of `{"apiKey":"sk-ant-…"}` — `JSON.parse`
    // would throw an opaque SyntaxError. The WR-06 guard must turn that into a clear message naming the
    // expected `{"apiKey":"sk-ant-…"}` shape, and must NOT fall through to new Anthropic({...}).
    smSend.mockResolvedValue({ SecretString: 'sk-ant-rawkey-not-json' });
    await expect(handler()).rejects.toThrow(/not valid JSON.*apiKey/);
    expect(anthropicFactory).not.toHaveBeenCalled();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it('throws when ANTHROPIC_SECRET_ARN is not set (and never reads the secret)', async () => {
    delete process.env.ANTHROPIC_SECRET_ARN;
    await expect(handler()).rejects.toThrow(/ANTHROPIC_SECRET_ARN/);
    expect(smSend).not.toHaveBeenCalled();
  });

  it('on a populated key: constructs the client with the secret apiKey (never an env var), parses via the D-16 gate, and returns {ok, classification, usage}', async () => {
    const res = await handler();
    // IN-06: the apiKey from the secret reached the SDK constructor AND the 30s-Lambda-budget timing
    // contract is pinned — maxRetries:0 + timeout:25_000 keeps a single SDK attempt cleanly under the
    // 30s Lambda timeout (a regression to the SDK default 2 retries / 10-min timeout fails this test).
    expect(anthropicFactory).toHaveBeenCalledTimes(1);
    expect(anthropicFactory).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-ant-test', maxRetries: 0, timeout: 25_000 }),
    );
    // The key is NEVER promoted to an env var (D-ANTHROPIC).
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    // The forced-tool response parsed through the canonical schema; usage passed through (the SC3 proof).
    expect(res).toEqual({
      ok: true,
      classification: {
        adherence_state: 'delayed',
        reason_code: 'side_effect',
        safety_flag: 'none',
      },
      usage: { input_tokens: 12, output_tokens: 7 },
    });
  });
});
