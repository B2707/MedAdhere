import { describe, expect, it } from 'vitest';
import {
  CLINICAL_COMPOSER_PROVIDER_KEY,
  clinicalComposerBucketSubjectKeys,
  conversationGatewayRequestSchema,
  conversationGatewayResponseSchema,
  type ConversationGatewayRequest,
  type ConversationGatewayResponse,
} from './gateway-contract.js';
import {
  CLINICAL_EXTRACTOR_PROMPT_VERSION,
  CLINICAL_EXTRACTOR_SCHEMA_VERSION,
} from './clinical-memory/anthropic-extractor.js';

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_ID = '00000000-0000-4000-8000-000000000002';
const INPUT = {
  currentMessage: {
    id: '00000000-0000-4000-8000-000000000003',
    direction: 'inbound' as const,
    body: 'I took it this morning.',
  },
  openInformationNeeds: [],
  promptVersion: CLINICAL_EXTRACTOR_PROMPT_VERSION,
  schemaVersion: CLINICAL_EXTRACTOR_SCHEMA_VERSION,
};

const EXTRACTION = {
  claims: [
    {
      sourceMessageId: INPUT.currentMessage.id,
      informationNeedId: null,
      claim: {
        slot: 'claim_1',
        kind: 'administration' as const,
        quote: 'took it this morning',
        polarity: 'positive' as const,
        experiencer: 'patient' as const,
        status: 'current' as const,
        certainty: 'certain' as const,
        actionText: 'took',
        timeText: 'this morning',
      },
    },
  ],
};

const METADATA = {
  modelId: 'claude-sonnet-5',
  promptVersion: CLINICAL_EXTRACTOR_PROMPT_VERSION,
  schemaSha256: 'a'.repeat(64),
  latencyMs: 125,
};

describe('conversation gateway contract', () => {
  it('accepts only strict interpretation requests and exposes the exact inferred type', () => {
    const interpretationRequest: ConversationGatewayRequest = {
      requestId: REQUEST_ID,
      stage: 'interpretation',
      input: INPUT,
    };

    expect(conversationGatewayRequestSchema.parse(interpretationRequest)).toEqual(
      interpretationRequest,
    );
    expect(
      conversationGatewayRequestSchema.safeParse({
        requestId: REQUEST_ID,
        stage: 'writer',
        input: INPUT,
        interpretation: EXTRACTION,
      }).success,
    ).toBe(false);
    expect(
      conversationGatewayRequestSchema.safeParse({
        ...interpretationRequest,
        input: { ...INPUT, patientId: PATIENT_ID },
      }).success,
    ).toBe(false);
  });

  it('accepts only validated interpretation success responses', () => {
    const interpretationResponse: ConversationGatewayResponse = {
      ok: true,
      requestId: REQUEST_ID,
      stage: 'interpretation',
      result: EXTRACTION,
      usage: { inputTokens: 120, outputTokens: 48 },
      metadata: METADATA,
    };
    expect(conversationGatewayResponseSchema.parse(interpretationResponse)).toEqual(
      interpretationResponse,
    );
    expect(
      conversationGatewayResponseSchema.safeParse({
        ...interpretationResponse,
        stage: 'writer',
        result: { acknowledgementTemplateId: 'received-update' },
      }).success,
    ).toBe(false);
  });

  it('allows typed redacted failures with optional usage but rejects provider prose', () => {
    const failure: ConversationGatewayResponse = {
      ok: false,
      requestId: REQUEST_ID,
      stage: 'interpretation',
      failureKind: 'transient',
      usage: null,
      metadata: METADATA,
    };

    expect(conversationGatewayResponseSchema.parse(failure)).toEqual(failure);
    expect(
      conversationGatewayResponseSchema.safeParse({
        ...failure,
        providerMessage: 'raw provider response containing patient text',
      }).success,
    ).toBe(false);
    expect(
      conversationGatewayResponseSchema.parse({ ...failure, failureKind: 'input_too_large' }),
    ).toMatchObject({ ok: false, failureKind: 'input_too_large' });
  });
});

const COMPOSER_PROMPT_VERSION = 'clinical-composer-v1';
const COMPOSER_PROMPT_SHA256 = 'b'.repeat(64);

/** The FULL ComposerIntent — the validator context crosses the contract intact. */
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
        body: 'hey there',
        occurredAtUtc: '2026-08-16T12:00:00.000Z',
      },
    ],
    latestPatientMessage: 'hey there',
  },
  promptVersion: COMPOSER_PROMPT_VERSION,
};

const COMPOSITION_METADATA = {
  modelId: 'claude-haiku-4-5-20251001',
  promptVersion: COMPOSER_PROMPT_VERSION,
  promptSha256: COMPOSER_PROMPT_SHA256,
  latencyMs: 125,
};

const COMPOSITION_ATTEMPT = {
  rawOutput: '{"sms": "Hey, how\'s it going?"}',
  verdict: { ok: true as const, sms: "Hey, how's it going?" },
};

describe('conversation gateway composition contract', () => {
  const compositionRequest: ConversationGatewayRequest = {
    requestId: REQUEST_ID,
    stage: 'composition',
    input: COMPOSITION_INPUT,
  };

  it('accepts only strict composition requests with composable intent kinds', () => {
    expect(conversationGatewayRequestSchema.parse(compositionRequest)).toEqual(compositionRequest);
    expect(
      conversationGatewayRequestSchema.safeParse({
        ...compositionRequest,
        input: { ...COMPOSITION_INPUT, patientId: PATIENT_ID },
      }).success,
    ).toBe(false);
    // Safety, review, and failure replies are structurally never composable: the fixed
    // templates are the only representation those turns have at this boundary.
    for (const uncomposableKind of [
      'emergency',
      'stop',
      'important',
      'human_review',
      'unsupported_language',
      'stale_snapshot',
    ]) {
      expect(
        conversationGatewayRequestSchema.safeParse({
          ...compositionRequest,
          input: {
            ...COMPOSITION_INPUT,
            intent: { ...COMPOSITION_INPUT.intent, kind: uncomposableKind },
          },
        }).success,
      ).toBe(false);
    }
  });

  it('requires the question payload exactly when the intent kind is question', () => {
    expect(
      conversationGatewayRequestSchema.safeParse({
        ...compositionRequest,
        input: {
          ...COMPOSITION_INPUT,
          intent: { ...COMPOSITION_INPUT.intent, kind: 'question' },
        },
      }).success,
    ).toBe(false);
    expect(
      conversationGatewayRequestSchema.safeParse({
        ...compositionRequest,
        input: {
          ...COMPOSITION_INPUT,
          intent: {
            ...COMPOSITION_INPUT.intent,
            kind: 'question',
            question: { field: 'severity', keyVocabulary: ['1 to 10'] },
          },
        },
      }).success,
    ).toBe(true);
  });

  it('counts the 320-character composed-body ceiling in code points post-trim', () => {
    const success = (composedBody: string): ConversationGatewayResponse => ({
      ok: true,
      requestId: REQUEST_ID,
      stage: 'composition',
      result: { composedBody, inputHash: 'c'.repeat(64), attempts: [COMPOSITION_ATTEMPT] },
      usage: { inputTokens: 90, outputTokens: 40 },
      metadata: COMPOSITION_METADATA,
    });

    // 320 astral code points are 640 UTF-16 units: passing proves code-point counting.
    expect(conversationGatewayResponseSchema.parse(success('\u{1F600}'.repeat(320)))).toMatchObject(
      {
        ok: true,
        stage: 'composition',
      },
    );
    expect(
      conversationGatewayResponseSchema.safeParse(success('\u{1F600}'.repeat(321))).success,
    ).toBe(false);
    expect(conversationGatewayResponseSchema.safeParse(success(' padded body ')).success).toBe(
      false,
    );
    expect(conversationGatewayResponseSchema.safeParse(success('')).success).toBe(false);
  });

  it('allows typed composition failures carrying the per-reason fallback channel', () => {
    const failure: ConversationGatewayResponse = {
      ok: false,
      requestId: REQUEST_ID,
      stage: 'composition',
      failureKind: 'malformed',
      fallbackReason: 'ungrounded_entity',
      inputHash: 'c'.repeat(64),
      attempts: [
        {
          rawOutput: '{"sms": "fabricated"}',
          verdict: { ok: false, reason: 'ungrounded_entity', detail: 'numeral:6' },
        },
      ],
      usage: null,
      metadata: COMPOSITION_METADATA,
    };

    expect(conversationGatewayResponseSchema.parse(failure)).toEqual(failure);
    expect(
      conversationGatewayResponseSchema.parse({
        ...failure,
        failureKind: 'input_too_large',
        fallbackReason: null,
        inputHash: null,
        attempts: [],
      }),
    ).toMatchObject({ ok: false, failureKind: 'input_too_large' });
    expect(
      conversationGatewayResponseSchema.safeParse({
        ...failure,
        providerMessage: 'raw provider response containing patient text',
      }).success,
    ).toBe(false);
  });

  it('keeps composer budget and circuit keys isolated from the extractor keys', () => {
    expect(CLINICAL_COMPOSER_PROVIDER_KEY).toBe('anthropic:clinical-composer');
    // The extractor circuit key is model-derived; the composer key must stay distinct even
    // when the composer model is env-swapped to the same Sonnet model.
    expect(CLINICAL_COMPOSER_PROVIDER_KEY).not.toBe('anthropic:claude-sonnet-5');

    const keys = clinicalComposerBucketSubjectKeys(PATIENT_ID);
    expect(keys).toEqual({
      input: `${PATIENT_ID}:writer-input`,
      output: `${PATIENT_ID}:writer-output`,
    });
    expect(keys.input).not.toBe(`${PATIENT_ID}:input`);
    expect(keys.output).not.toBe(`${PATIENT_ID}:output`);
  });
});
