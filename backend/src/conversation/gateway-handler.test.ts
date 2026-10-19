import { beforeEach, describe, expect, it, vi } from 'vitest';

const { anthropicConstructor, anthropicCountTokens, anthropicCreate, secretSend } = vi.hoisted(
  () => ({
    anthropicConstructor: vi.fn(),
    anthropicCountTokens: vi.fn(),
    anthropicCreate: vi.fn(),
    secretSend: vi.fn(),
  }),
);

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(function (config: unknown) {
    anthropicConstructor(config);
    return { messages: { countTokens: anthropicCountTokens, create: anthropicCreate } };
  }),
}));

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn(function () {
    return { send: secretSend };
  }),
  GetSecretValueCommand: vi.fn(function (input: unknown) {
    return { input };
  }),
}));

import {
  CLINICAL_COMPOSER_DEFAULT_MODEL_ID,
  CLINICAL_COMPOSER_MODEL_ENV_VAR,
  COMPOSER_MAX_CONTEXT_TOKENS,
  COMPOSER_MAX_OUTPUT_TOKENS,
  CONVERSATION_GATEWAY_CONFIG,
  processConversationGatewayRequest,
  type ConversationGatewayHandlerDependencies,
} from './gateway-handler.js';
import {
  CLINICAL_COMPOSER_PROMPT_SHA256,
  COMPOSER_PROMPT_VERSION,
} from './clinical-memory/composer.js';
import {
  CLINICAL_EXTRACTOR_PROMPT_VERSION,
  CLINICAL_EXTRACTOR_SCHEMA_VERSION,
} from './clinical-memory/anthropic-extractor.js';

/**
 * M-06: the Anthropic client + its secret fetch now live at gateway MODULE scope so a warm Lambda
 * reuses one client and one secret read. Each handler test therefore needs a FRESH module instance —
 * a statically imported `handler` would carry the previous test's cached client into this one.
 */
async function loadHandler(): Promise<
  (event: unknown) => ReturnType<typeof processConversationGatewayRequest>
> {
  vi.resetModules();
  return (await import('./gateway-handler.js')).handler;
}

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_ID = '00000000-0000-4000-8000-000000000002';
const INPUT = {
  currentMessage: {
    id: '00000000-0000-4000-8000-000000000003',
    direction: 'inbound' as const,
    body: 'PRIVATE PATIENT MESSAGE',
  },
  openInformationNeeds: [],
  promptVersion: CLINICAL_EXTRACTOR_PROMPT_VERSION,
  schemaVersion: CLINICAL_EXTRACTOR_SCHEMA_VERSION,
};

const EXTRACTION = { claims: [] } as const;
const WIRE_EXTRACTION = { extracted_claims: [] } as const;

const BOUNDED_CLAIM_TOOL_NAME = 'record_bounded_claims';

function providerResponse(result: unknown, usage = { input_tokens: 100, output_tokens: 20 }) {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: BOUNDED_CLAIM_TOOL_NAME, input: result }],
    usage,
  };
}

function providerExtractionResponse(request: unknown) {
  const content = (request as { messages: Array<{ content: string }> }).messages[0]!.content;
  const serialized = content.match(/<patient_message_json>\n(.+)\n<\/patient_message_json>/su)?.[1];
  if (serialized === undefined) throw new Error('missing provider input');
  JSON.parse(serialized);
  return providerResponse(WIRE_EXTRACTION);
}

/** Builds a tool_use response carrying real claims, source-ref'd off the FIRST user message —
 * the corrective-retry conversation only appends turns after it, so this stays valid on retry. */
function providerClaimResponse(
  request: unknown,
  claims: readonly unknown[],
  usage = { input_tokens: 100, output_tokens: 20 },
) {
  const content = (request as { messages: Array<{ content: string }> }).messages[0]!.content;
  const serialized = content.match(/<patient_message_json>\n(.+)\n<\/patient_message_json>/su)?.[1];
  if (serialized === undefined) throw new Error('missing provider input');
  const sourceRef = (JSON.parse(serialized) as { currentMessage: { sourceRef: string } })
    .currentMessage.sourceRef;
  return providerResponse(
    { extracted_claims: claims.map((claim) => ({ sourceRef, informationNeedRef: null, claim })) },
    usage,
  );
}

function dependencies(
  create: ConversationGatewayHandlerDependencies['create'],
  log = vi.fn(),
  countTokens: ConversationGatewayHandlerDependencies['countTokens'] = vi
    .fn()
    .mockResolvedValue({ input_tokens: 100 }),
): ConversationGatewayHandlerDependencies {
  return {
    countTokens,
    create,
    nowMs: vi.fn().mockReturnValueOnce(1_000).mockReturnValue(1_125),
    log,
  };
}

/** A greeting reply that passes the full Lane B validator set for COMPOSITION_INPUT. */
const COMPOSED_SMS = "Hey, how's it going? Hope today went smoothly.";
const COMPOSED_RAW = JSON.stringify({ sms: COMPOSED_SMS });

const COMPOSITION_INPUT = {
  intent: {
    kind: 'greeting' as const,
    requiredTokens: [],
    allowedTerms: [],
    medications: [{ alias: 'med_1', displayName: 'Metformin' }],
    patientFacts: ['next med_1 dose today 8:00 pm'],
  },
  dayContext: {
    messages: [
      {
        id: '00000000-0000-4000-8000-000000000009',
        direction: 'inbound' as const,
        body: 'PRIVATE COMPOSER INBOUND',
        occurredAtUtc: '2026-08-16T12:00:00.000Z',
      },
    ],
    latestPatientMessage: 'PRIVATE COMPOSER INBOUND',
  },
  promptVersion: COMPOSER_PROMPT_VERSION,
};

function composerProviderResponse(
  text = COMPOSED_RAW,
  usage: Record<string, number> = {
    input_tokens: 30,
    output_tokens: 25,
    cache_creation_input_tokens: 50,
    cache_read_input_tokens: 20,
  },
) {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage,
  };
}

beforeEach(() => {
  anthropicConstructor.mockReset();
  anthropicCountTokens.mockReset();
  anthropicCreate.mockReset();
  secretSend.mockReset();
  process.env.ANTHROPIC_SECRET_ARN =
    'arn:aws:secretsmanager:us-east-1:123456789012:secret:medadhere/anthropic';
  delete process.env[CLINICAL_COMPOSER_MODEL_ENV_VAR];
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

describe('conversation LLM gateway handler', () => {
  it('runs one interpretation stage with fixed configuration and redacted telemetry', async () => {
    const create = vi.fn(async (request) => ({
      ...providerExtractionResponse(request),
      usage: {
        input_tokens: 20,
        output_tokens: 20,
        cache_creation_input_tokens: 70,
        cache_read_input_tokens: 10,
      },
    }));
    const log = vi.fn();
    const countTokens = vi.fn().mockResolvedValue({ input_tokens: 100 });

    const result = await processConversationGatewayRequest(
      { requestId: REQUEST_ID, stage: 'interpretation', input: INPUT },
      dependencies(create, log, countTokens),
    );

    expect(result).toMatchObject({
      ok: true,
      stage: 'interpretation',
      result: EXTRACTION,
      usage: { inputTokens: 100, outputTokens: 20 },
      metadata: {
        modelId: 'claude-sonnet-5',
        promptVersion: CLINICAL_EXTRACTOR_PROMPT_VERSION,
        latencyMs: 125,
      },
    });
    expect(create).toHaveBeenCalledOnce();
    expect(countTokens).toHaveBeenCalledOnce();
    expect(countTokens.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        model: 'claude-sonnet-5',
        system: [
          expect.objectContaining({
            type: 'text',
            cache_control: { type: 'ephemeral' },
          }),
        ],
      }),
    );
    expect(countTokens.mock.calls[0]![0]).not.toHaveProperty('max_tokens');
    expect(countTokens.mock.calls[0]![0]).not.toHaveProperty('output_config');
    // count_tokens prices the forced tool call, so tools + tool_choice must reach it unchanged.
    expect(countTokens.mock.calls[0]![0].tool_choice).toEqual({
      type: 'tool',
      name: BOUNDED_CLAIM_TOOL_NAME,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        thinking: { type: 'disabled' },
        tool_choice: { type: 'tool', name: BOUNDED_CLAIM_TOOL_NAME },
      }),
    );
    const createdRequest = create.mock.calls[0]![0] as {
      messages: unknown;
      system: unknown;
      tools: ReadonlyArray<{
        name: string;
        input_schema: {
          properties: {
            extracted_claims: {
              items: {
                properties: {
                  claim: {
                    anyOf: Array<{ properties: { kind: { const?: string; enum?: string[] } } }>;
                  };
                };
              };
            };
          };
        };
      }>;
    };
    expect(createdRequest).not.toHaveProperty('output_config');
    expect(createdRequest.tools).toHaveLength(1);
    expect(createdRequest.tools[0]!.name).toBe(BOUNDED_CLAIM_TOOL_NAME);
    expect(createdRequest.tools[0]!).not.toHaveProperty('strict');
    expect(countTokens.mock.calls[0]![0].tools).toEqual(createdRequest.tools);
    const claimSchema =
      createdRequest.tools[0]!.input_schema.properties.extracted_claims.items.properties.claim;
    expect(
      claimSchema.anyOf.map(
        (branch) => branch.properties.kind.const ?? branch.properties.kind.enum?.[0],
      ),
    ).toEqual([
      'administration',
      'correction',
      'symptom',
      'symptom_detail',
      'recurrence',
      'need_answer',
      'social',
    ]);
    expect(countTokens.mock.calls[0]![0].messages).toEqual(createdRequest.messages);
    expect(countTokens.mock.calls[0]![0].system).toEqual(createdRequest.system);
    const providerWire = JSON.stringify([
      createdRequest,
      ...countTokens.mock.calls.map(([payload]) => payload),
    ]);
    expect(providerWire).not.toContain(REQUEST_ID);
    expect(providerWire).not.toContain(PATIENT_ID);
    expect(providerWire).not.toContain(INPUT.currentMessage.id);
    expect(providerWire).toMatch(/source_[a-f0-9]{24}_1/u);
    expect(CONVERSATION_GATEWAY_CONFIG).toEqual({
      model: 'claude-sonnet-5',
      thinking: { type: 'disabled' },
      effort: null,
      interpretationMaxTokens: 4096,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(INPUT.currentMessage.body);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'interpretation',
        outcome: 'completed',
        inputTokens: 100,
        outputTokens: 20,
      }),
    );
    expect(log.mock.calls[0]![0]).not.toHaveProperty('requestId');
    expect(JSON.stringify(log.mock.calls)).not.toContain('source_');
  });

  it('keeps claim-kind requirements strict outside the compact provider grammar', async () => {
    const create = vi.fn(async (request) => {
      const content = (request as { messages: Array<{ content: string }> }).messages[0]!.content;
      const serialized = content.match(
        /<patient_message_json>\n(.+)\n<\/patient_message_json>/su,
      )?.[1];
      if (serialized === undefined) throw new Error('missing provider input');
      const input = JSON.parse(serialized) as { currentMessage: { sourceRef: string } };
      return providerResponse({
        extracted_claims: [
          {
            sourceRef: input.currentMessage.sourceRef,
            informationNeedRef: null,
            claim: {
              slot: 'claim_1',
              quote: 'medication',
              polarity: 'positive',
              experiencer: 'patient',
              status: 'current',
              certainty: 'certain',
              kind: 'administration',
            },
          },
        ],
      });
    });

    const result = await processConversationGatewayRequest(
      { requestId: REQUEST_ID, stage: 'interpretation', input: INPUT },
      dependencies(create),
    );

    expect(result).toMatchObject({ ok: false, failureKind: 'malformed' });
  });

  it('uses Anthropic token counting to reject context above 12,000 before model creation', async () => {
    const create = vi.fn();
    const countTokens = vi.fn().mockResolvedValue({ input_tokens: 12_001 });

    const result = await processConversationGatewayRequest(
      { requestId: REQUEST_ID, stage: 'interpretation', input: INPUT },
      dependencies(create, vi.fn(), countTokens),
    );

    expect(result).toMatchObject({ ok: false, failureKind: 'input_too_large', usage: null });
    expect(countTokens).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-sonnet-5' }));
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects the removed writer stage before token counting or provider creation', async () => {
    const create = vi.fn();
    const countTokens = vi.fn();
    const log = vi.fn();

    await expect(
      processConversationGatewayRequest(
        {
          requestId: REQUEST_ID,
          stage: 'writer',
          input: INPUT,
          interpretation: EXTRACTION,
        },
        dependencies(create, log, countTokens),
      ),
    ).rejects.toThrow('Invalid conversation gateway request');
    expect(countTokens).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'auth'],
    [402, 'auth'],
    [403, 'auth'],
    [429, 'rate_limited'],
    [500, 'transient'],
  ] as const)('maps provider status %s to a redacted %s failure', async (status, failureKind) => {
    const log = vi.fn();
    const create = vi
      .fn()
      .mockRejectedValue({ status, message: `provider echoed ${INPUT.currentMessage.body}` });

    const result = await processConversationGatewayRequest(
      { requestId: REQUEST_ID, stage: 'interpretation', input: INPUT },
      dependencies(create, log),
    );

    expect(result).toMatchObject({ ok: false, failureKind, usage: null });
    expect(JSON.stringify(result)).not.toContain(INPUT.currentMessage.body);
    expect(JSON.stringify(log.mock.calls)).not.toContain(INPUT.currentMessage.body);
  });

  it('logs an identifier-free interpretation_retry metric when the grounding retry fires', async () => {
    const quote = 'PATIENT MESSAGE';
    const badClaim = {
      slot: 'claim_1',
      quote,
      polarity: 'positive',
      experiencer: 'patient',
      status: 'current',
      certainty: 'certain',
      kind: 'symptom',
      symptomText: 'urgent issue',
    };
    const goodClaim = { ...badClaim, symptomText: 'MESSAGE' };
    const create = vi
      .fn()
      .mockImplementationOnce(async (r: unknown) => providerClaimResponse(r, [badClaim]))
      .mockImplementationOnce(async (r: unknown) => providerClaimResponse(r, [goodClaim]));
    const log = vi.fn();
    const logRetry = vi.fn();
    const countTokens = vi.fn().mockResolvedValue({ input_tokens: 100 });

    const result = await processConversationGatewayRequest(
      { requestId: REQUEST_ID, stage: 'interpretation', input: INPUT },
      { ...dependencies(create, log, countTokens), logRetry },
    );

    expect(result).toMatchObject({
      ok: true,
      result: { claims: [{ claim: { symptomText: 'MESSAGE' } }] },
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(logRetry).toHaveBeenCalledExactlyOnceWith({ reason: 'source_field_mismatch' });
  });

  // The corrective retry doubles the per-turn provider-call ceiling, and every call is billed.
  // Overwriting instead of accumulating reported one attempt's tokens for the whole turn, so the
  // per-patient daily bucket — the pre-registered runaway ceiling — metered a fraction of real
  // spend. The composition stage below already accumulates; this makes interpretation match.
  it('accumulates billed usage across every provider call the retry makes', async () => {
    const quote = 'PATIENT MESSAGE';
    const badClaim = {
      slot: 'claim_1',
      quote,
      polarity: 'positive',
      experiencer: 'patient',
      status: 'current',
      certainty: 'certain',
      kind: 'symptom',
      symptomText: 'urgent issue',
    };
    const goodClaim = { ...badClaim, symptomText: 'MESSAGE' };
    const create = vi
      .fn()
      .mockImplementationOnce(async (r: unknown) =>
        providerClaimResponse(r, [badClaim], { input_tokens: 5_000, output_tokens: 500 }),
      )
      .mockImplementationOnce(async (r: unknown) =>
        providerClaimResponse(r, [goodClaim], { input_tokens: 5_400, output_tokens: 440 }),
      );
    const countTokens = vi.fn().mockResolvedValue({ input_tokens: 100 });

    const result = await processConversationGatewayRequest(
      { requestId: REQUEST_ID, stage: 'interpretation', input: INPUT },
      dependencies(create, vi.fn(), countTokens),
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: true,
      usage: { inputTokens: 10_400, outputTokens: 940 },
    });
  });

  it('never logs a retry metric when the interpretation stage succeeds on the first attempt', async () => {
    const create = vi.fn(async (r: unknown) => providerExtractionResponse(r));
    const logRetry = vi.fn();
    const countTokens = vi.fn().mockResolvedValue({ input_tokens: 100 });

    const result = await processConversationGatewayRequest(
      { requestId: REQUEST_ID, stage: 'interpretation', input: INPUT },
      { ...dependencies(create, vi.fn(), countTokens), logRetry },
    );

    expect(result.ok).toBe(true);
    expect(logRetry).not.toHaveBeenCalled();
  });

  it('preserves billed usage while returning only a typed malformed failure', async () => {
    const create = vi.fn().mockResolvedValue(providerResponse({ unexpected: true }));

    const result = await processConversationGatewayRequest(
      { requestId: REQUEST_ID, stage: 'interpretation', input: INPUT },
      dependencies(create),
    );

    // All three malformed attempts were billed, so all three are reported — the failure path
    // meters real spend the same way the success path does.
    expect(create).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      ok: false,
      failureKind: 'malformed',
      usage: { inputTokens: 300, outputTokens: 60 },
    });
  });

  it.each([
    ['a second text block', { type: 'text', text: JSON.stringify(WIRE_EXTRACTION) }],
    ['a non-text block', { type: 'thinking', thinking: 'hidden provider content' }],
  ])('rejects an otherwise valid response with %s', async (_label, extraBlock) => {
    const create = vi.fn().mockResolvedValue({
      ...providerResponse(WIRE_EXTRACTION),
      content: [providerResponse(WIRE_EXTRACTION).content[0], extraBlock],
    });

    const result = await processConversationGatewayRequest(
      { requestId: REQUEST_ID, stage: 'interpretation', input: INPUT },
      dependencies(create),
    );

    expect(result).toMatchObject({
      ok: false,
      failureKind: 'malformed',
      usage: { inputTokens: 300, outputTokens: 60 },
    });
  });

  it.each([
    ['refusal', 'refused'],
    ['max_tokens', 'truncated'],
  ] as const)('maps Anthropic stop reason %s to %s', async (stopReason, failureKind) => {
    const create = vi.fn().mockResolvedValue({
      ...providerResponse(WIRE_EXTRACTION),
      stop_reason: stopReason,
    });

    const result = await processConversationGatewayRequest(
      { requestId: REQUEST_ID, stage: 'interpretation', input: INPUT },
      dependencies(create),
    );

    expect(result).toMatchObject({
      ok: false,
      failureKind,
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  });

  it('rejects an invalid request with a generic error before any provider call or log', async () => {
    const create = vi.fn();
    const log = vi.fn();

    await expect(
      processConversationGatewayRequest(
        {
          requestId: REQUEST_ID,
          stage: 'interpretation',
          input: { ...INPUT, patientId: 'invalid', currentMessage: { body: 'SECRET' } },
        },
        dependencies(create, log),
      ),
    ).rejects.toThrow('Invalid conversation gateway request');
    expect(create).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('fails closed on an old prompt version before token counting or provider creation', async () => {
    const create = vi.fn();
    const countTokens = vi.fn();
    const log = vi.fn();

    const result = await processConversationGatewayRequest(
      {
        requestId: REQUEST_ID,
        stage: 'interpretation',
        input: { ...INPUT, promptVersion: 'conversation-v37-staged' },
      },
      dependencies(create, log, countTokens),
    );

    expect(result).toMatchObject({ ok: false, failureKind: 'internal', usage: null });
    expect(countTokens).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(REQUEST_ID);
  });

  it('fails closed on a non-current schema version before token counting or provider creation', async () => {
    const create = vi.fn();
    const countTokens = vi.fn();
    const log = vi.fn();

    const result = await processConversationGatewayRequest(
      {
        requestId: REQUEST_ID,
        stage: 'interpretation',
        input: { ...INPUT, schemaVersion: 'conversation-v2' },
      },
      dependencies(create, log, countTokens),
    );

    expect(result).toMatchObject({ ok: false, failureKind: 'internal', usage: null });
    expect(countTokens).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(REQUEST_ID);
  });

  it('constructs the production Anthropic client with maxRetries 0 and a 45-second timeout', async () => {
    secretSend.mockResolvedValue({ SecretString: JSON.stringify({ apiKey: 'test-api-key' }) });
    anthropicCountTokens.mockResolvedValue({ input_tokens: 100 });
    anthropicCreate.mockImplementation(async (request) => providerExtractionResponse(request));
    const handler = await loadHandler();

    await expect(
      handler({ requestId: REQUEST_ID, stage: 'interpretation', input: INPUT }),
    ).resolves.toMatchObject({ ok: true, stage: 'interpretation' });

    expect(anthropicConstructor).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      maxRetries: 0,
      timeout: 45_000,
    });
    expect(anthropicCreate).toHaveBeenCalledOnce();
    expect(anthropicCountTokens).toHaveBeenCalledOnce();
    expect(secretSend).toHaveBeenCalledOnce();
  });

  it('never includes malformed secret contents in the returned failure or telemetry', async () => {
    secretSend.mockResolvedValue({ SecretString: INPUT.currentMessage.body });
    const handler = await loadHandler();

    const result = await handler({
      requestId: REQUEST_ID,
      stage: 'interpretation',
      input: INPUT,
    });

    expect(result).toMatchObject({ ok: false, failureKind: 'internal' });
    expect(JSON.stringify(result)).not.toContain(INPUT.currentMessage.body);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(
      INPUT.currentMessage.body,
    );
    expect(anthropicConstructor).not.toHaveBeenCalled();
  });

  // M-06 — warm-container reuse. The client + secret promise live at module scope, so a second
  // invocation of the SAME loaded module must not refetch the secret or rebuild the client.
  it('reuses one Anthropic client and one secret fetch across warm invocations', async () => {
    secretSend.mockResolvedValue({ SecretString: JSON.stringify({ apiKey: 'test-api-key' }) });
    anthropicCountTokens.mockResolvedValue({ input_tokens: 100 });
    anthropicCreate.mockImplementation(async (request) => providerExtractionResponse(request));
    const handler = await loadHandler();
    const event = { requestId: REQUEST_ID, stage: 'interpretation', input: INPUT };

    await expect(handler(event)).resolves.toMatchObject({ ok: true });
    await expect(handler(event)).resolves.toMatchObject({ ok: true });

    expect(secretSend).toHaveBeenCalledOnce();
    expect(anthropicConstructor).toHaveBeenCalledOnce();
    expect(anthropicConstructor).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      maxRetries: 0,
      timeout: 45_000,
    });
    expect(anthropicCreate).toHaveBeenCalledTimes(2);
  });

  // A failed secret read must NOT poison the warm container: the next invocation retries the fetch
  // (the repo's `createDbPoolProvider` caches on success only — same posture here).
  it('retries the secret fetch on the next invocation after a failed read', async () => {
    secretSend.mockRejectedValueOnce(new Error('secret unavailable'));
    secretSend.mockResolvedValue({ SecretString: JSON.stringify({ apiKey: 'test-api-key' }) });
    anthropicCountTokens.mockResolvedValue({ input_tokens: 100 });
    anthropicCreate.mockImplementation(async (request) => providerExtractionResponse(request));
    const handler = await loadHandler();
    const event = { requestId: REQUEST_ID, stage: 'interpretation', input: INPUT };

    await expect(handler(event)).resolves.toMatchObject({ ok: false });
    await expect(handler(event)).resolves.toMatchObject({ ok: true });

    expect(secretSend).toHaveBeenCalledTimes(2);
    expect(anthropicConstructor).toHaveBeenCalledOnce();
  });
});

describe('conversation LLM gateway composition stage', () => {
  const compositionEvent = {
    requestId: REQUEST_ID,
    stage: 'composition' as const,
    input: COMPOSITION_INPUT,
  };

  it('runs the REAL Lane B composer on the default Haiku model with redacted telemetry', async () => {
    const create = vi.fn().mockResolvedValue(composerProviderResponse());
    const log = vi.fn();
    const countTokens = vi.fn().mockResolvedValue({ input_tokens: 100 });

    const result = await processConversationGatewayRequest(
      compositionEvent,
      dependencies(create, log, countTokens),
    );

    expect(result).toMatchObject({
      ok: true,
      requestId: REQUEST_ID,
      stage: 'composition',
      result: { composedBody: COMPOSED_SMS },
      usage: { inputTokens: 100, outputTokens: 25 },
      metadata: {
        modelId: CLINICAL_COMPOSER_DEFAULT_MODEL_ID,
        promptVersion: COMPOSER_PROMPT_VERSION,
        promptSha256: CLINICAL_COMPOSER_PROMPT_SHA256,
        latencyMs: 125,
      },
    });
    if (result.ok && result.stage === 'composition') {
      expect(result.result.inputHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(result.result.attempts).toHaveLength(1);
    }
    expect(CLINICAL_COMPOSER_DEFAULT_MODEL_ID).toBe('claude-haiku-4-5-20251001');
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: CLINICAL_COMPOSER_DEFAULT_MODEL_ID,
        max_tokens: COMPOSER_MAX_OUTPUT_TOKENS,
      }),
    );
    // The provider request carries the aliased envelope, never the medication display name.
    expect(JSON.stringify(create.mock.calls)).not.toContain('Metformin');
    expect(countTokens).toHaveBeenCalledOnce();
    expect(countTokens.mock.calls[0]![0]).not.toHaveProperty('max_tokens');
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'composition',
        outcome: 'completed',
        inputTokens: 100,
        outputTokens: 25,
      }),
    );
    expect(log.mock.calls[0]![0]).not.toHaveProperty('requestId');
    const loggedWire = JSON.stringify(log.mock.calls);
    expect(loggedWire).not.toContain(COMPOSITION_INPUT.dayContext.latestPatientMessage);
    expect(loggedWire).not.toContain(COMPOSED_SMS);
  });

  it('swaps the composer model via env without touching the extractor config', async () => {
    process.env[CLINICAL_COMPOSER_MODEL_ENV_VAR] = ' claude-sonnet-5 ';
    const create = vi.fn().mockResolvedValue(composerProviderResponse());

    const result = await processConversationGatewayRequest(
      compositionEvent,
      dependencies(create, vi.fn()),
    );

    expect(result).toMatchObject({
      ok: true,
      metadata: { modelId: 'claude-sonnet-5' },
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-sonnet-5' }));
    expect(CONVERSATION_GATEWAY_CONFIG.model).toBe('claude-sonnet-5');
  });

  it('fails composition LOUDLY on a set-but-empty model env var (unified resolver semantics)', async () => {
    process.env[CLINICAL_COMPOSER_MODEL_ENV_VAR] = '   ';
    const create = vi.fn();

    const result = await processConversationGatewayRequest(
      compositionEvent,
      dependencies(create, vi.fn()),
    );

    expect(result).toMatchObject({ ok: false, stage: 'composition', failureKind: 'internal' });
    expect(create).not.toHaveBeenCalled();
  });

  it("enforces the composer's own context ceiling, never the shared 12,000 gate", async () => {
    expect(COMPOSER_MAX_CONTEXT_TOKENS).toBeLessThan(12_000);
    const overComposerUnderExtractor = COMPOSER_MAX_CONTEXT_TOKENS + 1;
    const create = vi.fn();
    const countTokens = vi.fn().mockResolvedValue({ input_tokens: overComposerUnderExtractor });

    const composition = await processConversationGatewayRequest(
      compositionEvent,
      dependencies(create, vi.fn(), countTokens),
    );

    expect(composition).toMatchObject({
      ok: false,
      stage: 'composition',
      failureKind: 'input_too_large',
      usage: null,
    });
    expect(create).not.toHaveBeenCalled();

    // The same count is UNDER the shared 12,000 interpretation gate, so the extractor
    // stage still runs: the ceilings are provably independent.
    const interpretationCreate = vi.fn(async (request) => providerExtractionResponse(request));
    const interpretation = await processConversationGatewayRequest(
      { requestId: REQUEST_ID, stage: 'interpretation', input: INPUT },
      dependencies(
        interpretationCreate,
        vi.fn(),
        vi.fn().mockResolvedValue({ input_tokens: overComposerUnderExtractor }),
      ),
    );
    expect(interpretation).toMatchObject({ ok: true, stage: 'interpretation' });
  });

  it('accepts a composition context exactly at the composer ceiling', async () => {
    const create = vi.fn().mockResolvedValue(composerProviderResponse());
    const countTokens = vi.fn().mockResolvedValue({ input_tokens: COMPOSER_MAX_CONTEXT_TOKENS });

    const result = await processConversationGatewayRequest(
      compositionEvent,
      dependencies(create, vi.fn(), countTokens),
    );

    expect(result).toMatchObject({ ok: true, stage: 'composition' });
  });

  it('fails closed on a composer prompt version mismatch before any provider call', async () => {
    const create = vi.fn();
    const countTokens = vi.fn();

    const result = await processConversationGatewayRequest(
      {
        ...compositionEvent,
        input: { ...COMPOSITION_INPUT, promptVersion: 'clinical-composer-v0' },
      },
      dependencies(create, vi.fn(), countTokens),
    );

    expect(result).toMatchObject({ ok: false, stage: 'composition', failureKind: 'internal' });
    expect(countTokens).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('blocks non-JSON model output through the validator gate with the per-reason channel', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(
        composerProviderResponse('not json at all', { input_tokens: 30, output_tokens: 25 }),
      );

    const result = await processConversationGatewayRequest(
      compositionEvent,
      dependencies(create, vi.fn()),
    );

    expect(result).toMatchObject({
      ok: false,
      stage: 'composition',
      failureKind: 'malformed',
      fallbackReason: 'malformed_output',
      usage: { inputTokens: 60, outputTokens: 50 },
    });
    // One bounded retry, then the caller ships the template.
    expect(create).toHaveBeenCalledTimes(2);
    if (!result.ok && result.stage === 'composition') {
      expect(result.attempts).toHaveLength(2);
    }
  });

  it('blocks a validator-rejected reply (fabricated numeral) with its exact fallback reason', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(
        composerProviderResponse(JSON.stringify({ sms: 'Noted your pain at 6 today.' })),
      );

    const result = await processConversationGatewayRequest(
      compositionEvent,
      dependencies(create, vi.fn()),
    );

    expect(result).toMatchObject({
      ok: false,
      stage: 'composition',
      failureKind: 'malformed',
      fallbackReason: 'ungrounded_entity',
    });
  });

  it.each([
    [401, 'auth'],
    [429, 'rate_limited'],
    [500, 'transient'],
  ] as const)('maps composer provider status %s to a redacted %s failure', async (status, kind) => {
    const log = vi.fn();
    const create = vi.fn().mockRejectedValue({
      status,
      message: `provider echoed ${COMPOSITION_INPUT.dayContext.latestPatientMessage}`,
    });

    const result = await processConversationGatewayRequest(
      compositionEvent,
      dependencies(create, log),
    );

    expect(result).toMatchObject({ ok: false, stage: 'composition', failureKind: kind });
    expect(JSON.stringify(result)).not.toContain(COMPOSITION_INPUT.dayContext.latestPatientMessage);
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      COMPOSITION_INPUT.dayContext.latestPatientMessage,
    );
  });

  it('composes end-to-end in the production handler through the mocked provider client', async () => {
    const handler = await loadHandler();
    secretSend.mockResolvedValue({ SecretString: JSON.stringify({ apiKey: 'test-key' }) });
    anthropicCountTokens.mockResolvedValue({ input_tokens: 100 });
    anthropicCreate.mockResolvedValue(composerProviderResponse());

    const result = await handler(compositionEvent);

    expect(result).toMatchObject({
      ok: true,
      stage: 'composition',
      result: { composedBody: COMPOSED_SMS },
    });
    expect(anthropicConstructor).toHaveBeenCalledOnce();
  });
});
