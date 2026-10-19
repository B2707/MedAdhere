import Anthropic from '@anthropic-ai/sdk';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  CLINICAL_EXTRACTOR_PROMPT_VERSION,
  CLINICAL_EXTRACTOR_SCHEMA_SHA256,
  CLINICAL_EXTRACTOR_SCHEMA_VERSION,
  ConversationStageModelError,
  createAnthropicBoundedClaimExtractor,
  type AnthropicStageModelConfig,
  type ConversationMessagesClient,
  type ConversationStageUsage,
} from './clinical-memory/anthropic-extractor.js';
import {
  conversationGatewayRequestSchema,
  conversationGatewayResponseSchema,
  composedBodySchema,
  type ConversationGatewayRequest,
  type ConversationGatewayResponse,
} from './gateway-contract.js';
import {
  CLINICAL_COMPOSER_PROMPT_SHA256,
  COMPOSER_MODEL_ENV,
  COMPOSER_PROMPT_VERSION,
  DEFAULT_COMPOSER_MODEL,
  createClinicalComposer,
  resolveComposerModel,
  type ComposerStageUsage,
} from './clinical-memory/composer.js';
import type { ComposerFallbackReason } from './clinical-memory/composer-validators.js';

export const CONVERSATION_GATEWAY_CONFIG = {
  model: 'claude-sonnet-5',
  thinking: { type: 'disabled' },
  effort: null,
  interpretationMaxTokens: 4_096,
} as const satisfies AnthropicStageModelConfig;

/**
 * Exported so the worker's per-call reservation can be pinned equal to it: the reservation is
 * right-sized to exactly one provider call, and a gate raised above the reservation would let a
 * single call spend more than the turn ever held.
 */
export const MAX_CONTEXT_TOKENS = 12_000;

/**
 * Composer model (owner decision #2, 2026-08-16): Haiku by default, swappable to Sonnet via
 * CLINICAL_COMPOSER_MODEL — config only, never code changes. Resolution is unified with the
 * FIFO worker's compose plumbing (resolveComposerModel): a set-but-empty value fails LOUDLY
 * in both places instead of silently masking the misconfiguration.
 */
export const CLINICAL_COMPOSER_DEFAULT_MODEL_ID = DEFAULT_COMPOSER_MODEL;
/** Same env var name the FIFO worker's compose plumbing reads: infra sets ONE variable. */
export const CLINICAL_COMPOSER_MODEL_ENV_VAR = COMPOSER_MODEL_ENV;

/**
 * Wave 1b isolation item 6: the composer has its OWN context ceiling and typed
 * `input_too_large` failure — it never trips the shared 12,000-token interpretation gate and
 * never reaches the caller's bare 96k-byte transport throw. The PHI envelope is deliberately
 * minimal, so the ceiling is tighter than the extractor's.
 */
export const COMPOSER_MAX_CONTEXT_TOKENS = 8_000;
/** The composed body caps at 320 code points; 1,024 output tokens is generous headroom. */
export const COMPOSER_MAX_OUTPUT_TOKENS = 1_024;

class ConversationContextLimitError extends Error {
  override readonly name = 'ConversationContextLimitError';
}

class ComposedBodyInvalidError extends Error {
  override readonly name = 'ComposedBodyInvalidError';
}

interface GatewayTelemetry {
  readonly stage: ConversationGatewayResponse['stage'];
  readonly modelId: string;
  readonly promptVersion: string | null;
  readonly schemaSha256?: string;
  readonly latencyMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly outcome: 'completed' | ConversationGatewayFailureKind;
}

type ConversationGatewayFailureKind = Extract<
  ConversationGatewayResponse,
  { readonly ok: false }
>['failureKind'];

export interface ConversationGatewayHandlerDependencies {
  readonly countTokens: (
    params: Anthropic.MessageCountTokensParams,
  ) => Promise<{ readonly input_tokens: number }>;
  readonly create: ConversationMessagesClient['create'];
  readonly nowMs: () => number;
  readonly log: (telemetry: GatewayTelemetry) => void;
  /**
   * Live-fault fix (2026-08-17): an identifier-free ping every time the interpretation stage's
   * bounded corrective retry fires, tagged with the triggering error class. Optional so existing
   * dependency fixtures keep working unchanged; a caller that omits it just gets no signal.
   */
  readonly logRetry?: (info: { readonly reason: string }) => void;
}

function latencyMs(startedAt: number, nowMs: () => number): number {
  return Math.max(0, Math.floor(nowMs() - startedAt));
}

function failureKind(error: unknown): ConversationGatewayFailureKind {
  if (error instanceof ConversationContextLimitError) return 'input_too_large';
  if (error instanceof ComposedBodyInvalidError) return 'malformed';
  if (error instanceof ConversationStageModelError) return error.kind;
  if (typeof error !== 'object' || error === null) return 'internal';

  const status = 'status' in error ? error.status : undefined;
  if (status === 401 || status === 402 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (typeof status === 'number' && status >= 500) return 'transient';

  const name = 'name' in error && typeof error.name === 'string' ? error.name : '';
  return /(?:APIConnection|APIConnectionTimeout|InternalServer|Overloaded)/u.test(name)
    ? 'transient'
    : 'internal';
}

function tokenCountParams(
  request: Anthropic.MessageCreateParamsNonStreaming,
): Anthropic.MessageCountTokensParams {
  return Object.fromEntries(
    Object.entries(request).filter(([key]) => key !== 'max_tokens' && key !== 'output_config'),
  ) as Anthropic.MessageCountTokensParams;
}

function emitTelemetry(
  dependencies: ConversationGatewayHandlerDependencies,
  response: ConversationGatewayResponse,
): void {
  dependencies.log({
    stage: response.stage,
    modelId: response.metadata.modelId,
    promptVersion: response.metadata.promptVersion,
    ...(response.stage === 'interpretation'
      ? { schemaSha256: response.metadata.schemaSha256 }
      : {}),
    latencyMs: response.metadata.latencyMs,
    inputTokens: response.usage?.inputTokens ?? null,
    outputTokens: response.usage?.outputTokens ?? null,
    outcome: response.ok ? 'completed' : response.failureKind,
  });
}

/** One token-counting gate per stage; each stage passes its OWN ceiling (isolation item 6). */
function guardedMessagesClient(
  dependencies: ConversationGatewayHandlerDependencies,
  maxContextTokens: number,
): ConversationMessagesClient {
  return {
    create: async (modelRequest) => {
      const counted = await dependencies.countTokens(tokenCountParams(modelRequest));
      if (
        !Number.isSafeInteger(counted.input_tokens) ||
        counted.input_tokens < 0 ||
        counted.input_tokens > maxContextTokens
      ) {
        throw new ConversationContextLimitError();
      }
      return dependencies.create(modelRequest);
    },
  };
}

function summedUsage(usage: ConversationStageUsage | ComposerStageUsage): {
  readonly inputTokens: number;
  readonly outputTokens: number;
} {
  return {
    inputTokens: usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens,
    outputTokens: usage.outputTokens,
  };
}

async function runInterpretationStage(
  request: Extract<ConversationGatewayRequest, { readonly stage: 'interpretation' }>,
  dependencies: ConversationGatewayHandlerDependencies,
  startedAt: number,
): Promise<ConversationGatewayResponse> {
  // ACCUMULATE, never overwrite. The extractor's malformed loop and its corrective grounding
  // retry both fire onUsage once per billed provider call — up to MAX_INTERPRETATION_PROVIDER_CALLS
  // per turn — and reporting only the last attempt meant the per-patient daily token bucket
  // (the pre-registered runaway ceiling) metered a fraction of what was actually spent. The
  // composition stage below has always done it this way; the reservation in turn-processor.ts
  // is sized for the same worst case.
  const usageState: { inputTokens: number; outputTokens: number; recorded: boolean } = {
    inputTokens: 0,
    outputTokens: 0,
    recorded: false,
  };
  const usage = () =>
    usageState.recorded
      ? { inputTokens: usageState.inputTokens, outputTokens: usageState.outputTokens }
      : null;
  const model = createAnthropicBoundedClaimExtractor(
    guardedMessagesClient(dependencies, MAX_CONTEXT_TOKENS),
    CONVERSATION_GATEWAY_CONFIG,
    (stageUsage) => {
      const summed = summedUsage(stageUsage);
      usageState.inputTokens += summed.inputTokens;
      usageState.outputTokens += summed.outputTokens;
      usageState.recorded = true;
    },
    (info) => dependencies.logRetry?.(info),
  );
  const metadata = () => ({
    modelId: CONVERSATION_GATEWAY_CONFIG.model,
    promptVersion: CLINICAL_EXTRACTOR_PROMPT_VERSION,
    schemaSha256: CLINICAL_EXTRACTOR_SCHEMA_SHA256,
    latencyMs: latencyMs(startedAt, dependencies.nowMs),
  });

  try {
    if (
      request.input.promptVersion !== CLINICAL_EXTRACTOR_PROMPT_VERSION ||
      request.input.schemaVersion !== CLINICAL_EXTRACTOR_SCHEMA_VERSION
    ) {
      throw new Error('Conversation prompt or schema version is not current');
    }
    const result = await model.extract({
      currentMessage: request.input.currentMessage,
      openInformationNeeds: request.input.openInformationNeeds,
    });
    const completedUsage = usage();
    if (completedUsage === null) throw new Error('Conversation stage usage was not recorded');
    return conversationGatewayResponseSchema.parse({
      ok: true,
      requestId: request.requestId,
      stage: request.stage,
      result,
      usage: completedUsage,
      metadata: metadata(),
    });
  } catch (error: unknown) {
    return conversationGatewayResponseSchema.parse({
      ok: false,
      requestId: request.requestId,
      stage: request.stage,
      failureKind: failureKind(error),
      usage: usage(),
      metadata: metadata(),
    });
  }
}

/** Maps a composer-level fallback reason to the typed gateway failure kind. */
function compositionFailureKind(
  reason: ComposerFallbackReason,
): Extract<ConversationGatewayResponse, { readonly ok: false }>['failureKind'] {
  if (reason === 'context_overflow') return 'input_too_large';
  if (reason === 'provider_timeout' || reason === 'provider_error') return 'transient';
  return 'malformed';
}

async function runCompositionStage(
  request: Extract<ConversationGatewayRequest, { readonly stage: 'composition' }>,
  dependencies: ConversationGatewayHandlerDependencies,
  startedAt: number,
): Promise<ConversationGatewayResponse> {
  const usageState: { inputTokens: number; outputTokens: number; recorded: boolean } = {
    inputTokens: 0,
    outputTokens: 0,
    recorded: false,
  };
  const usage = () =>
    usageState.recorded
      ? { inputTokens: usageState.inputTokens, outputTokens: usageState.outputTokens }
      : null;
  const metadata = (modelId: string) => ({
    modelId,
    promptVersion: COMPOSER_PROMPT_VERSION,
    promptSha256: CLINICAL_COMPOSER_PROMPT_SHA256,
    latencyMs: latencyMs(startedAt, dependencies.nowMs),
  });
  let modelId = DEFAULT_COMPOSER_MODEL;

  try {
    modelId = resolveComposerModel(process.env);
    if (request.input.promptVersion !== COMPOSER_PROMPT_VERSION) {
      throw new Error('Clinical composer prompt version is not current');
    }
    // Provider errors are captured so a composer-level 'provider_error' fallback keeps its
    // typed auth/rate-limit/transient identity instead of collapsing to one bucket.
    let lastProviderError: unknown;
    const guarded = guardedMessagesClient(dependencies, COMPOSER_MAX_CONTEXT_TOKENS);
    const composer = createClinicalComposer(
      {
        create: async (modelRequest) => {
          try {
            return await guarded.create(modelRequest);
          } catch (error: unknown) {
            lastProviderError = error;
            throw error;
          }
        },
      },
      { model: modelId, maxTokens: COMPOSER_MAX_OUTPUT_TOKENS },
      (stageUsage) => {
        const summed = summedUsage(stageUsage);
        usageState.inputTokens += summed.inputTokens;
        usageState.outputTokens += summed.outputTokens;
        usageState.recorded = true;
      },
    );
    const run = await composer.compose(request.input.intent, request.input.dayContext);
    if (!run.ok) {
      if (run.reason === 'provider_error' && lastProviderError !== undefined) {
        throw lastProviderError;
      }
      return conversationGatewayResponseSchema.parse({
        ok: false,
        requestId: request.requestId,
        stage: request.stage,
        failureKind: compositionFailureKind(run.reason),
        fallbackReason: run.reason,
        inputHash: run.inputHash,
        attempts: run.attempts,
        usage: usage(),
        metadata: metadata(modelId),
      });
    }
    if (!composedBodySchema.safeParse(run.sms).success) throw new ComposedBodyInvalidError();
    if (!usageState.recorded) throw new Error('Conversation stage usage was not recorded');
    return conversationGatewayResponseSchema.parse({
      ok: true,
      requestId: request.requestId,
      stage: request.stage,
      result: { composedBody: run.sms, inputHash: run.inputHash, attempts: run.attempts },
      usage: usage(),
      metadata: metadata(modelId),
    });
  } catch (error: unknown) {
    return conversationGatewayResponseSchema.parse({
      ok: false,
      requestId: request.requestId,
      stage: request.stage,
      failureKind: failureKind(error),
      fallbackReason: null,
      inputHash: null,
      attempts: [],
      usage: usage(),
      metadata: metadata(modelId),
    });
  }
}

export async function processConversationGatewayRequest(
  untrustedRequest: unknown,
  dependencies: ConversationGatewayHandlerDependencies,
): Promise<ConversationGatewayResponse> {
  const parsed = conversationGatewayRequestSchema.safeParse(untrustedRequest);
  if (!parsed.success) throw new Error('Invalid conversation gateway request');

  const request = parsed.data;
  const startedAt = dependencies.nowMs();
  const response =
    request.stage === 'interpretation'
      ? await runInterpretationStage(request, dependencies, startedAt)
      : await runCompositionStage(request, dependencies, startedAt);

  emitTelemetry(dependencies, response);
  return response;
}

const secrets = new SecretsManagerClient({});

async function getAnthropicApiKey(): Promise<string> {
  const secretArn = process.env.ANTHROPIC_SECRET_ARN;
  if (!secretArn) throw new Error('Anthropic secret is unavailable');
  const value = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!value.SecretString) throw new Error('Anthropic secret is unavailable');

  let parsed: unknown;
  try {
    parsed = JSON.parse(value.SecretString);
  } catch {
    throw new Error('Anthropic secret is invalid');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('apiKey' in parsed) ||
    typeof parsed.apiKey !== 'string' ||
    parsed.apiKey.trim() === ''
  ) {
    throw new Error('Anthropic secret is invalid');
  }
  return parsed.apiKey;
}

/**
 * M-06 — one client and one secret read per WARM container. `client` is MODULE scope (it used to be
 * handler scope, so every warm invocation refetched the secret and rebuilt the client). It is
 * assigned only AFTER the secret resolves, mirroring `createDbPoolProvider`: a failed read leaves
 * the cache empty so the next invocation retries instead of serving a permanently poisoned
 * container. `maxRetries: 0` keeps provider retries disabled.
 */
let client: Anthropic | undefined;

async function getClient(): Promise<Anthropic> {
  if (client) return client;
  const apiKey = await getAnthropicApiKey();
  client = new Anthropic({ apiKey, maxRetries: 0, timeout: 45_000 });
  return client;
}

export async function handler(event: unknown): Promise<ConversationGatewayResponse> {
  return processConversationGatewayRequest(event, {
    countTokens: async (request) =>
      (await getClient()).messages.countTokens(request, { timeout: 5_000 }),
    create: async (request) => (await getClient()).messages.create(request),
    nowMs: Date.now,
    log: (telemetry) => console.info(JSON.stringify(telemetry)),
    logRetry: (info) =>
      console.info(
        JSON.stringify({ metric: 'interpretation_retry', stage: 'interpretation', ...info }),
      ),
  });
}
