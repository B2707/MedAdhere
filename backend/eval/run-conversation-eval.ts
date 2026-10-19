/**
 * Explicit, budget-bounded Phase 8 live conversation evaluation CLI.
 *
 * The corpus is checksum-verified before any credential lookup. Persisted
 * artifacts are allowlist projections: no patient text, model prose, secret,
 * exception message, or stack is retained.
 */
import Anthropic from '@anthropic-ai/sdk';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createHash, randomUUID } from 'node:crypto';
import { conversationTurnResultSchema } from '@medadhere/shared';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CLINICAL_EXTRACTOR_PROMPT_SHA256,
  CLINICAL_EXTRACTOR_PROMPT_VERSION,
  CLINICAL_EXTRACTOR_SCHEMA_SHA256,
} from '../src/conversation/clinical-memory/anthropic-extractor.js';
import { buildConversationRunnerScenarios } from './lib/conversation-input.js';
import {
  deleteConversationEvalCheckpoint,
  readConversationEvalCheckpoint,
  writeConversationEvalCheckpointAtomic,
  type ConversationEvalCheckpoint,
} from './lib/conversation-checkpoint.js';
import {
  cleanupExpiredConversationReviewBundles,
  CONVERSATION_REVIEW_BUNDLE_TTL_MS,
  freezeConversationReviewBundle,
  writeConversationReviewBundle,
  type ConversationReviewCapture,
  type FrozenConversationReviewBundle,
} from './lib/conversation-review-bundle.js';
import {
  buildConversationMetricsReport,
  type ConversationMetricId,
  type ConversationMetricResult,
  type ConversationMetricsReport,
  type ConversationSliceReport,
  type ConversationTurnExpectation,
  type ConversationTurnObservation,
} from './lib/conversation-metrics.js';
import {
  buildAnthropicClinicalMemoryTurnPreflight,
  CLINICAL_MEMORY_MAX_SERIALIZED_REQUEST_BYTES,
  createAnthropicClinicalMemoryConversationProvider,
  type ClinicalMemoryConversationMessagesClient,
} from './lib/conversation-clinical-memory-provider.js';
import {
  CONVERSATION_MAX_INPUT_TOKENS_PER_CALL,
  type ConversationEvalProviderPayload,
} from './lib/conversation-provider.js';
import {
  ConversationProviderTransportError,
  ConversationRunnerFatalError,
  PINNED_SONNET_CONFIG_ID,
  projectConversationProviderResponse,
  runConversationScenarios,
  SONNET_CANDIDATE_CONFIGS,
  type ConversationProvider,
  type ConversationRunResult,
  type SonnetCandidateConfig,
  type SonnetCandidateConfigId,
} from './lib/conversation-runner.js';
import {
  loadConversationScenarioCorpus,
  type ConversationPatientExpectation,
  type ConversationScenarioCorpus,
} from './lib/conversation-scenarios.js';
import {
  CONVERSATION_SCORER_VERSION,
  SEMANTIC_REVIEW_REQUIRED_METRICS,
  scoreConversationTurn,
} from './lib/conversation-scoring.js';

export const ANTHROPIC_SECRET_ID = 'medadhere/anthropic';
export const SONNET_INPUT_USD_PER_MTOK = 2;
export const SONNET_CACHE_CREATION_INPUT_USD_PER_MTOK = 2.5;
export const SONNET_CACHE_READ_INPUT_USD_PER_MTOK = 0.2;
export const SONNET_OUTPUT_USD_PER_MTOK = 10;
export const MAX_INPUT_TOKENS_PER_CALL = CONVERSATION_MAX_INPUT_TOKENS_PER_CALL;
export const MAX_SERIALIZED_REQUEST_BYTES = CLINICAL_MEMORY_MAX_SERIALIZED_REQUEST_BYTES;
export const SONNET_INTRO_PRICING_EXPIRES_AT_UTC = '2026-09-01T00:00:00.000Z';

const SONNET_INTRO_PRICING_EXPIRES_AT_MS = Date.parse(SONNET_INTRO_PRICING_EXPIRES_AT_UTC);

const RESULTS_DIRECTORY = fileURLToPath(new URL('./results/', import.meta.url));
export interface ConversationEvalArgs {
  readonly live: true;
  readonly partition: 'dev' | 'holdout';
  readonly candidateConfigId: SonnetCandidateConfigId;
  readonly clinicalMemory: true;
  readonly scenarioLimit?: number;
  readonly scenarioId?: string;
  readonly resumeCheckpointId?: string;
  readonly recoveryExtraTurns?: number;
  readonly recoveryTurnDelayMs?: number;
  readonly maxCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxCostUsd: number;
}

type ArtifactMetric = Omit<ConversationMetricResult, 'id' | 'label' | 'kind' | 'direction'>;

interface ArtifactSlice {
  readonly expectedTurns: number;
  readonly outcomes: ConversationSliceReport['outcomes'];
  readonly metrics: Record<ConversationMetricId, ArtifactMetric>;
}

interface ArtifactMetrics {
  readonly complete: boolean;
  readonly completeness: ConversationMetricsReport['completeness'];
  readonly overall: ArtifactSlice;
  readonly languages: Readonly<Record<string, ArtifactSlice>>;
  readonly safety: Readonly<Record<string, ArtifactSlice>>;
  readonly temporal: Readonly<Record<string, ArtifactSlice>>;
  readonly retrieval: Readonly<Record<string, ArtifactSlice>>;
}

export interface ConversationEvalArtifactResult extends ConversationRunResult {
  readonly source: 'provider' | 'fixture_contract';
}

export interface ConversationEvalArtifact {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly createdAtUtc: string;
  readonly corpus: {
    readonly evalSetVersion: string;
    readonly partition: 'dev' | 'holdout';
    readonly sha256: string;
    readonly scenarios: number;
    readonly scenarioLimit: number | null;
    readonly scenarioId: string | null;
  };
  readonly config: {
    readonly candidateConfigId: SonnetCandidateConfigId;
    readonly model: string;
    readonly thinkingType: string;
    readonly effort: string | null;
    readonly maxTokensPerCall: number;
    readonly maxInputTokensPerCall: number;
    readonly maxConcurrency: 1;
    readonly promptVersion: string;
    readonly promptSha256: string;
    readonly outputSchemaSha256: string;
    readonly scorerVersion: string;
    readonly architecture: 'clinical_memory';
  };
  readonly pricesUsdPerMillionTokens: {
    readonly input: number;
    readonly cacheCreationInput: number;
    readonly cacheReadInput: number;
    readonly output: number;
  };
  readonly caps: {
    readonly calls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
    readonly projectedWorstCaseCostUsd: number;
    readonly recoveryExtraTurns: number;
    readonly recoveryTurnDelayMs: number;
  };
  readonly execution: {
    readonly status: 'provider_completed_pending_review' | 'pilot_completed' | 'aborted';
    readonly reasonCode:
      | 'provider_completed_pending_review'
      | 'PILOT_ONLY'
      | 'PROVIDER_ABORTED'
      | 'BUDGET_EXCEEDED'
      | 'PROVIDER_INCOMPLETE'
      | 'MECHANICAL_EVALUATION_FAILED'
      | 'REVIEW_BUNDLE_WRITE_FAILED';
    readonly providerAbortCode:
      | 'TOKEN_COUNT_REJECTED'
      | 'MESSAGE_CREATE_REJECTED'
      | 'INPUT_TOKEN_CEILING'
      | 'REQUEST_SIZE_CEILING'
      | 'PROVIDER_USAGE_UNAVAILABLE'
      | 'INVALID_TURN_INPUT'
      | 'CHECKPOINT_WRITE_FAILED'
      | 'UNKNOWN'
      | null;
    readonly acceptanceEligible: boolean;
    readonly expectedTurns: number;
    readonly providerEligibleTurns: number;
    readonly deterministicTurns: number;
    readonly attemptedCalls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheCreationInputTokens: number;
    readonly cacheReadInputTokens: number;
    readonly thinkingTokens: number;
    readonly costUsd: number | null;
    readonly costUpperBoundUsd: number;
  };
  readonly deterministicFixtureCoverage: {
    readonly source: 'fixture_contract';
    readonly expectedTurns: number;
    readonly representedTurns: number;
  };
  readonly results: readonly ConversationEvalArtifactResult[];
  readonly metrics: ArtifactMetrics;
}

type EvalPayload = ConversationEvalProviderPayload<ConversationPatientExpectation>;

export interface ConversationEvalDeps {
  readonly loadCorpus: () => ConversationScenarioCorpus;
  readonly loadApiKey: () => Promise<string>;
  readonly createClinicalMemoryProvider: (apiKey: string) => ConversationProvider<EvalPayload>;
  readonly writeArtifact: (artifact: ConversationEvalArtifact) => string;
  readonly writeReviewBundle: (runId: string, bundle: FrozenConversationReviewBundle) => string;
  readonly cleanupStaleReviewBundles: (now: Date) => void;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly writeCheckpoint: (checkpoint: ConversationEvalCheckpoint) => string;
  readonly readCheckpoint: (
    checkpointId: string,
    expectedBinding: string,
  ) => ConversationEvalCheckpoint;
  readonly deleteCheckpoint: (checkpointId: string) => void;
  readonly now: () => Date;
  readonly randomId: () => string;
  readonly logCode: (code: string) => void;
}

function positiveInteger(value: string | undefined, name: string): number {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${name} is required`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function positiveNumber(value: string | undefined, name: string): number {
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

export function parseConversationEvalArgs(argv: readonly string[]): ConversationEvalArgs {
  const { values, tokens } = parseArgs({
    args: [...argv],
    options: {
      live: { type: 'boolean' },
      'clinical-memory': { type: 'boolean' },
      partition: { type: 'string' },
      candidate: { type: 'string' },
      'scenario-limit': { type: 'string' },
      'scenario-id': { type: 'string' },
      resume: { type: 'string' },
      'recovery-extra-turns': { type: 'string' },
      'recovery-turn-delay-ms': { type: 'string' },
      'max-calls': { type: 'string' },
      'max-input-tokens': { type: 'string' },
      'max-output-tokens': { type: 'string' },
      'max-cost-usd': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
    tokens: true,
  });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new Error(`duplicate --${token.name}`);
    seen.add(token.name);
    if (token.name !== 'live' && token.name !== 'clinical-memory' && token.inlineValue !== true) {
      throw new Error(`--${token.name} requires an inline value`);
    }
  }
  if (values.live !== true) throw new Error('--live is required');
  if (values['clinical-memory'] !== true) throw new Error('--clinical-memory is required');

  const partition = values.partition;
  if (partition !== 'dev' && partition !== 'holdout') {
    throw new Error('partition must be dev or holdout');
  }
  const candidate = values.candidate;
  const candidateConfig = SONNET_CANDIDATE_CONFIGS.find(({ id }) => id === candidate);
  if (candidateConfig === undefined) throw new Error('candidate is invalid');

  const scenarioLimitRaw = values['scenario-limit'];
  const scenarioLimit =
    scenarioLimitRaw === undefined
      ? undefined
      : positiveInteger(scenarioLimitRaw, 'scenario-limit');
  const scenarioId = values['scenario-id'];
  if (scenarioLimit !== undefined && scenarioId !== undefined) {
    throw new Error('scenario-limit and scenario-id are mutually exclusive');
  }
  if (scenarioId !== undefined && (!/^conv-dev-\d{3}$/u.test(scenarioId) || partition !== 'dev')) {
    throw new Error('scenario-id must identify one development scenario');
  }
  if (partition === 'holdout' && (scenarioLimit !== undefined || scenarioId !== undefined)) {
    throw new Error('holdout does not allow scenario-limit or scenario-id');
  }
  const resumeCheckpointId = values.resume;
  if (
    resumeCheckpointId !== undefined &&
    (partition !== 'dev' || scenarioLimit !== undefined || scenarioId !== undefined)
  ) {
    throw new Error('resume requires one full clinical-memory development run');
  }
  if (
    resumeCheckpointId !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(resumeCheckpointId)
  ) {
    throw new Error('resume checkpoint ID is invalid');
  }
  const recoveryExtraTurnsRaw = values['recovery-extra-turns'];
  const recoveryExtraTurns =
    recoveryExtraTurnsRaw === undefined
      ? undefined
      : positiveInteger(recoveryExtraTurnsRaw, 'recovery-extra-turns');
  if (recoveryExtraTurns !== undefined && resumeCheckpointId === undefined) {
    throw new Error('recovery-extra-turns requires resume');
  }
  const recoveryTurnDelayRaw = values['recovery-turn-delay-ms'];
  const recoveryTurnDelayMs =
    recoveryTurnDelayRaw === undefined
      ? undefined
      : positiveInteger(recoveryTurnDelayRaw, 'recovery-turn-delay-ms');
  if (recoveryTurnDelayMs !== undefined && recoveryTurnDelayMs > 300_000) {
    throw new Error('recovery-turn-delay-ms must not exceed 300000');
  }
  if (recoveryTurnDelayMs !== undefined && resumeCheckpointId === undefined) {
    throw new Error('recovery-turn-delay-ms requires resume');
  }
  return {
    live: true,
    partition,
    candidateConfigId: candidateConfig.id,
    clinicalMemory: true,
    ...(scenarioLimit === undefined ? {} : { scenarioLimit }),
    ...(scenarioId === undefined ? {} : { scenarioId }),
    ...(resumeCheckpointId === undefined ? {} : { resumeCheckpointId }),
    ...(recoveryExtraTurns === undefined ? {} : { recoveryExtraTurns }),
    ...(recoveryTurnDelayMs === undefined ? {} : { recoveryTurnDelayMs }),
    maxCalls: positiveInteger(values['max-calls'], 'max-calls'),
    maxInputTokens: positiveInteger(values['max-input-tokens'], 'max-input-tokens'),
    maxOutputTokens: positiveInteger(values['max-output-tokens'], 'max-output-tokens'),
    maxCostUsd: positiveNumber(values['max-cost-usd'], 'max-cost-usd'),
  };
}

export function parseAnthropicSecret(secret: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new Error('invalid Anthropic secret');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('invalid Anthropic secret');
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 1 ||
    keys[0] !== 'apiKey' ||
    typeof record.apiKey !== 'string' ||
    record.apiKey.length === 0 ||
    record.apiKey !== record.apiKey.trim()
  ) {
    throw new Error('invalid Anthropic secret');
  }
  return record.apiKey;
}

async function loadAnthropicApiKey(): Promise<string> {
  const client = new SecretsManagerClient({ maxAttempts: 1 });
  const response = await client.send(
    new GetSecretValueCommand({
      SecretId: ANTHROPIC_SECRET_ID,
      VersionStage: 'AWSCURRENT',
    }),
  );
  if (response.SecretString === undefined) throw new Error('Anthropic secret unavailable');
  return parseAnthropicSecret(response.SecretString);
}

function createClinicalMemoryProvider(apiKey: string): ConversationProvider<EvalPayload> {
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  return createAnthropicClinicalMemoryConversationProvider(
    client.messages as ClinicalMemoryConversationMessagesClient,
    scoreConversationTurn,
  );
}

function projectedCost(
  inputTokens: number,
  outputTokens: number,
  cacheCreationInputTokens = 0,
  cacheReadInputTokens = 0,
): number {
  return (
    (inputTokens * SONNET_INPUT_USD_PER_MTOK +
      cacheCreationInputTokens * SONNET_CACHE_CREATION_INPUT_USD_PER_MTOK +
      cacheReadInputTokens * SONNET_CACHE_READ_INPUT_USD_PER_MTOK +
      outputTokens * SONNET_OUTPUT_USD_PER_MTOK) /
    1_000_000
  );
}

function projectedReservedCost(inputTokens: number, outputTokens: number): number {
  return projectedCost(0, outputTokens, inputTokens);
}

function providerFailureLogCode(error: unknown): string {
  if (!(error instanceof ConversationProviderTransportError)) {
    return 'CONVERSATION_EVAL_PROVIDER_FAILURE';
  }
  const diagnostic = error.transportDiagnostic;
  return `CONVERSATION_EVAL_PROVIDER_FAILURE:${error.modelStage}:${diagnostic.operation}:${diagnostic.errorClass}:${diagnostic.causeCode}`;
}

function candidateById(id: SonnetCandidateConfigId): SonnetCandidateConfig {
  const candidate = SONNET_CANDIDATE_CONFIGS.find((item) => item.id === id);
  if (candidate === undefined) throw new Error('candidate is invalid');
  return candidate;
}

function clinicalMemoryConfig(candidate: SonnetCandidateConfig) {
  return {
    model: candidate.model,
    thinking: candidate.thinking,
    effort: candidate.effort,
    interpretationMaxTokens: candidate.maxTokens,
  } as const;
}

function conversationCheckpointBinding(
  args: ConversationEvalArgs,
  corpus: ConversationScenarioCorpus,
  scenarioIds: readonly string[],
): string {
  const payload = {
    evalSetVersion: corpus.manifest.evalSetVersion,
    partition: args.partition,
    corpusSha256:
      args.partition === 'dev' ? corpus.manifest.devSha256 : corpus.manifest.holdoutSha256,
    scenarioIds,
    candidateConfigId: args.candidateConfigId,
    architecture: 'clinical_memory',
    promptVersion: CLINICAL_EXTRACTOR_PROMPT_VERSION,
    promptSha256: CLINICAL_EXTRACTOR_PROMPT_SHA256,
    outputSchemaSha256: CLINICAL_EXTRACTOR_SCHEMA_SHA256,
    scorerVersion: CONVERSATION_SCORER_VERSION,
    caps: {
      calls: args.maxCalls,
      inputTokens: args.maxInputTokens,
      outputTokens: args.maxOutputTokens,
      costUsd: args.maxCostUsd,
    },
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')}`;
}

function validateCheckpointCoverage(
  checkpoint: ConversationEvalCheckpoint,
  scenarios: ReturnType<typeof buildConversationRunnerScenarios>,
): void {
  const scenarioIds = scenarios.map(({ scenarioId }) => scenarioId);
  const completed = new Set(checkpoint.completedScenarioIds);
  if (
    checkpoint.completedScenarioIds.some((scenarioId) => !scenarioIds.includes(scenarioId)) ||
    scenarioIds.filter((scenarioId) => completed.has(scenarioId)).join('\0') !==
      checkpoint.completedScenarioIds.join('\0')
  ) {
    throw new Error('checkpoint scenario coverage is invalid');
  }
  const expectedProviderTurnKeys = new Set(
    scenarios.flatMap((scenario) =>
      completed.has(scenario.scenarioId)
        ? scenario.turns.flatMap((turn) =>
            turn.eligibleForProvider ? [`${scenario.scenarioId}:${turn.turnId}`] : [],
          )
        : [],
    ),
  );
  const resultTurnKeys = checkpoint.results.map(
    ({ scenarioId, turnId }) => `${scenarioId}:${turnId}`,
  );
  const captureTurnKeys = checkpoint.reviewCaptures.map(
    ({ scenarioId, turnId }) => `${scenarioId}:${turnId}`,
  );
  if (
    resultTurnKeys.length !== expectedProviderTurnKeys.size ||
    captureTurnKeys.length !== expectedProviderTurnKeys.size ||
    checkpoint.results.some(
      ({ scenarioId, turnId, outcome }) =>
        outcome !== 'completed' || !expectedProviderTurnKeys.has(`${scenarioId}:${turnId}`),
    ) ||
    captureTurnKeys.some((key) => !expectedProviderTurnKeys.has(key))
  ) {
    throw new Error('checkpoint turn coverage is invalid');
  }
}

function turnExpectations(
  scenarios: ReturnType<typeof buildConversationRunnerScenarios>,
): ConversationTurnExpectation[] {
  return scenarios.flatMap((scenario) =>
    scenario.turns.map(({ turnId, payload }) => ({
      scenarioId: scenario.scenarioId,
      turnId,
      language: payload.expectation.language,
      safetySlices: payload.expectation.safetySlices,
      temporalSlices: payload.expectation.temporalSlices,
      retrievalSlices: payload.expectation.retrievalSlices,
      applicableMetrics: payload.expectation.applicableMetrics,
    })),
  );
}

function fixtureContractResults(
  scenarios: ReturnType<typeof buildConversationRunnerScenarios>,
): ConversationEvalArtifactResult[] {
  return scenarios.flatMap((scenario) =>
    scenario.turns.flatMap((turn) =>
      turn.eligibleForProvider
        ? []
        : [
            {
              scenarioId: scenario.scenarioId,
              turnId: turn.turnId,
              source: 'fixture_contract' as const,
              outcome: 'completed' as const,
              metricSuccesses: {},
            },
          ],
    ),
  );
}

function projectMetric(metric: ConversationMetricResult): ArtifactMetric {
  const { status, threshold, numerator, denominator, successes, failures, rate, wilson95, pass } =
    metric;
  return { status, threshold, numerator, denominator, successes, failures, rate, wilson95, pass };
}

function projectSlice(slice: ConversationSliceReport): ArtifactSlice {
  return {
    expectedTurns: slice.expectedTurns,
    outcomes: slice.outcomes,
    metrics: Object.fromEntries(
      Object.entries(slice.metrics).map(([id, metric]) => [id, projectMetric(metric)]),
    ) as Record<ConversationMetricId, ArtifactMetric>,
  };
}

function projectNamedSlices(
  slices: Readonly<Record<string, ConversationSliceReport>>,
): Readonly<Record<string, ArtifactSlice>> {
  return Object.fromEntries(Object.entries(slices).map(([id, slice]) => [id, projectSlice(slice)]));
}

function projectMetrics(report: ConversationMetricsReport): ArtifactMetrics {
  return {
    complete: report.complete,
    completeness: report.completeness,
    overall: projectSlice(report.overall),
    languages: projectNamedSlices(report.languages),
    safety: projectNamedSlices(report.safety),
    temporal: projectNamedSlices(report.temporal),
    retrieval: projectNamedSlices(report.retrieval),
  };
}

function mechanicalMetricsPass(
  expectedTurns: readonly ConversationTurnExpectation[],
  observedTurns: readonly ConversationTurnObservation[],
): boolean {
  const semanticMetricIds = new Set<ConversationMetricId>(SEMANTIC_REVIEW_REQUIRED_METRICS);
  const mechanicalReport = buildConversationMetricsReport(
    expectedTurns.map((expectation) => ({
      ...expectation,
      applicableMetrics: expectation.applicableMetrics.filter(
        (metricId) => !semanticMetricIds.has(metricId),
      ),
    })),
    observedTurns,
  );
  return (
    mechanicalReport.complete &&
    Object.values(mechanicalReport.overall.metrics).every(
      (metric) => metric.status === 'not_applicable' || metric.pass,
    )
  );
}

export function writeConversationEvalArtifactAtomic(
  directory: string,
  artifact: ConversationEvalArtifact,
): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const timestamp = artifact.createdAtUtc.replaceAll(/[^0-9A-Za-z]/g, '');
  const unique = randomUUID();
  const finalPath = join(
    directory,
    `conversation-eval-${timestamp}-${artifact.runId}-${unique}.json`,
  );
  const temporaryPath = `${finalPath}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(artifact)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, finalPath);
    chmodSync(finalPath, 0o600);
    return finalPath;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary path may not exist; never mask the original write failure.
    }
    throw error;
  }
}

const defaultDeps: ConversationEvalDeps = {
  loadCorpus: loadConversationScenarioCorpus,
  loadApiKey: loadAnthropicApiKey,
  createClinicalMemoryProvider,
  writeArtifact: (artifact) => writeConversationEvalArtifactAtomic(RESULTS_DIRECTORY, artifact),
  writeReviewBundle: (runId, bundle) =>
    writeConversationReviewBundle(RESULTS_DIRECTORY, runId, bundle),
  cleanupStaleReviewBundles: (now) =>
    cleanupExpiredConversationReviewBundles(RESULTS_DIRECTORY, now),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  writeCheckpoint: (checkpoint) =>
    writeConversationEvalCheckpointAtomic(RESULTS_DIRECTORY, checkpoint),
  readCheckpoint: (checkpointId, expectedBinding) =>
    readConversationEvalCheckpoint(RESULTS_DIRECTORY, checkpointId, expectedBinding),
  deleteCheckpoint: (checkpointId) =>
    deleteConversationEvalCheckpoint(RESULTS_DIRECTORY, checkpointId),
  now: () => new Date(),
  randomId: randomUUID,
  logCode: (code) => process.stderr.write(`${code}\n`),
};

export async function runConversationEvalCli(
  argv: readonly string[],
  deps: ConversationEvalDeps = defaultDeps,
): Promise<0 | 1> {
  let args: ConversationEvalArgs;
  try {
    args = parseConversationEvalArgs(argv);
  } catch {
    deps.logCode('CONVERSATION_EVAL_PREFLIGHT_FAILED');
    return 1;
  }

  const runTime = deps.now();
  const runTimeMs = runTime.getTime();
  if (!Number.isFinite(runTimeMs)) {
    deps.logCode('CONVERSATION_EVAL_PREFLIGHT_FAILED');
    return 1;
  }
  try {
    deps.cleanupStaleReviewBundles(runTime);
  } catch {
    deps.logCode('CONVERSATION_EVAL_STALE_BUNDLE_CLEANUP_FAILED');
    return 1;
  }

  let corpus: ConversationScenarioCorpus;
  try {
    corpus = deps.loadCorpus();
  } catch {
    deps.logCode('CONVERSATION_EVAL_PREFLIGHT_FAILED');
    return 1;
  }

  const pinnedConfigId: SonnetCandidateConfigId | null = PINNED_SONNET_CONFIG_ID;
  if (
    args.partition === 'holdout' &&
    (pinnedConfigId === null || args.candidateConfigId !== pinnedConfigId)
  ) {
    deps.logCode('CONVERSATION_EVAL_HOLDOUT_LOCKED');
    return 1;
  }

  const fullRun = args.scenarioLimit === undefined && args.scenarioId === undefined;

  if (runTimeMs >= SONNET_INTRO_PRICING_EXPIRES_AT_MS) {
    deps.logCode('CONVERSATION_EVAL_PRICING_EXPIRED');
    return 1;
  }

  const document = corpus[args.partition];
  const activeScenarios = document.scenarios.filter(
    ({ primaryLanguage, additionalLanguages }) =>
      primaryLanguage === 'en' && additionalLanguages.length === 0,
  );
  if (args.scenarioLimit !== undefined && args.scenarioLimit > activeScenarios.length) {
    deps.logCode('CONVERSATION_EVAL_PREFLIGHT_FAILED');
    return 1;
  }
  const selectedScenarios =
    args.scenarioId === undefined
      ? activeScenarios.slice(0, args.scenarioLimit)
      : activeScenarios.filter(({ id }) => id === args.scenarioId);
  if (selectedScenarios.length === 0) {
    deps.logCode('CONVERSATION_EVAL_PREFLIGHT_FAILED');
    return 1;
  }
  const scenarios = buildConversationRunnerScenarios(selectedScenarios);
  const expectedTurns = turnExpectations(scenarios);
  const providerTurnKeys = new Set(
    scenarios.flatMap((scenario) =>
      scenario.turns.flatMap((turn) =>
        turn.eligibleForProvider ? [`${scenario.scenarioId}:${turn.turnId}`] : [],
      ),
    ),
  );
  const providerExpectedTurns = expectedTurns.filter((expectation) =>
    providerTurnKeys.has(`${expectation.scenarioId}:${expectation.turnId}`),
  );
  const providerEligibleTurns = scenarios.reduce(
    (count, scenario) =>
      count + scenario.turns.filter(({ eligibleForProvider }) => eligibleForProvider).length,
    0,
  );
  const deterministicTurns = expectedTurns.length - providerEligibleTurns;
  const candidate = candidateById(args.candidateConfigId);
  const recoveryExtraTurns = args.recoveryExtraTurns ?? 0;
  const recoveryTurnDelayMs = args.recoveryTurnDelayMs ?? 0;
  const effectiveCaps = {
    calls: args.maxCalls + recoveryExtraTurns,
    inputTokens: args.maxInputTokens + recoveryExtraTurns * MAX_INPUT_TOKENS_PER_CALL,
    outputTokens: args.maxOutputTokens + recoveryExtraTurns * candidate.maxTokens,
  };
  if (!Object.values(effectiveCaps).every(Number.isSafeInteger)) {
    deps.logCode('CONVERSATION_EVAL_PREFLIGHT_FAILED');
    return 1;
  }
  let projectedInputTokens = 0;
  let projectedOutputTokens = 0;
  let projectedCalls = 0;
  const reservedInputTokensByTurn = new Map<string, number>();
  const reservedOutputTokensByTurn = new Map<string, number>();
  try {
    for (const scenario of scenarios) {
      for (const turn of scenario.turns) {
        if (!turn.eligibleForProvider) continue;
        const built = buildAnthropicClinicalMemoryTurnPreflight(
          clinicalMemoryConfig(candidate),
          turn.payload.turnInput,
        );
        if (
          built.interpretationSerializedUtf8Bytes > CLINICAL_MEMORY_MAX_SERIALIZED_REQUEST_BYTES
        ) {
          throw new Error('request exceeds per-call input ceiling');
        }
        const turnKey = `${scenario.scenarioId}:${turn.turnId}`;
        reservedInputTokensByTurn.set(turnKey, built.reservedInputTokens);
        reservedOutputTokensByTurn.set(turnKey, built.reservedOutputTokens);
        projectedInputTokens += built.reservedInputTokens;
        projectedOutputTokens += built.reservedOutputTokens;
        projectedCalls += built.reservedModelCalls;
      }
    }
  } catch {
    deps.logCode('CONVERSATION_EVAL_REQUEST_SIZE_PREFLIGHT_FAILED');
    return 1;
  }
  let projectedWorstCaseCostUsd = projectedReservedCost(
    projectedInputTokens,
    projectedOutputTokens,
  );
  if (
    projectedCalls > effectiveCaps.calls ||
    projectedInputTokens > effectiveCaps.inputTokens ||
    projectedOutputTokens > effectiveCaps.outputTokens ||
    projectedWorstCaseCostUsd > args.maxCostUsd
  ) {
    deps.logCode('CONVERSATION_EVAL_BUDGET_PREFLIGHT_FAILED');
    return 1;
  }

  const runId = deps.randomId();
  const checkpointEnabled = fullRun;
  const checkpointBinding = conversationCheckpointBinding(
    args,
    corpus,
    scenarios.map(({ scenarioId }) => scenarioId),
  );
  const checkpointId = args.resumeCheckpointId ?? runId;
  let resumedCheckpoint: ConversationEvalCheckpoint | null = null;
  if (checkpointEnabled) {
    try {
      resumedCheckpoint =
        args.resumeCheckpointId === undefined
          ? {
              schemaVersion: 1,
              checkpointId,
              bindingSha256: checkpointBinding,
              completedScenarioIds: [],
              results: [],
              reviewCaptures: [],
              usage: {
                attemptedCalls: 0,
                reservedInputTokens: 0,
                reservedOutputTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
                thinkingTokens: 0,
              },
            }
          : deps.readCheckpoint(checkpointId, checkpointBinding);
      validateCheckpointCoverage(resumedCheckpoint, scenarios);
      if (args.resumeCheckpointId === undefined) deps.writeCheckpoint(resumedCheckpoint);
    } catch {
      deps.logCode(
        args.resumeCheckpointId === undefined
          ? 'CONVERSATION_EVAL_CHECKPOINT_WRITE_FAILED'
          : 'CONVERSATION_EVAL_CHECKPOINT_LOAD_FAILED',
      );
      return 1;
    }
    deps.logCode(`CONVERSATION_EVAL_CHECKPOINT:${checkpointId}`);
  }

  if (resumedCheckpoint !== null) {
    const completedScenarioIds = new Set(resumedCheckpoint.completedScenarioIds);
    const pendingProviderTurns = scenarios.reduce(
      (count, scenario) =>
        completedScenarioIds.has(scenario.scenarioId)
          ? count
          : count + scenario.turns.filter(({ eligibleForProvider }) => eligibleForProvider).length,
      0,
    );
    const resumeProjectedCalls = resumedCheckpoint.usage.attemptedCalls + pendingProviderTurns;
    const resumeProjectedInputTokens =
      resumedCheckpoint.usage.reservedInputTokens +
      pendingProviderTurns * MAX_INPUT_TOKENS_PER_CALL;
    const resumeProjectedOutputTokens =
      resumedCheckpoint.usage.reservedOutputTokens + pendingProviderTurns * candidate.maxTokens;
    projectedWorstCaseCostUsd = projectedReservedCost(
      resumeProjectedInputTokens,
      resumeProjectedOutputTokens,
    );
    if (
      resumeProjectedCalls > effectiveCaps.calls ||
      resumeProjectedInputTokens > effectiveCaps.inputTokens ||
      resumeProjectedOutputTokens > effectiveCaps.outputTokens ||
      projectedWorstCaseCostUsd > args.maxCostUsd
    ) {
      deps.logCode('CONVERSATION_EVAL_BUDGET_PREFLIGHT_FAILED');
      return 1;
    }
  }

  let provider: ConversationProvider<EvalPayload>;
  try {
    const apiKey = await deps.loadApiKey();
    provider = deps.createClinicalMemoryProvider(apiKey);
  } catch {
    deps.logCode('CONVERSATION_EVAL_START_FAILED');
    return 1;
  }

  let attemptedCalls = resumedCheckpoint?.usage.attemptedCalls ?? 0;
  let inputTokens = resumedCheckpoint?.usage.inputTokens ?? 0;
  let outputTokens = resumedCheckpoint?.usage.outputTokens ?? 0;
  let cacheCreationInputTokens = resumedCheckpoint?.usage.cacheCreationInputTokens ?? 0;
  let cacheReadInputTokens = resumedCheckpoint?.usage.cacheReadInputTokens ?? 0;
  let thinkingTokens = resumedCheckpoint?.usage.thinkingTokens ?? 0;
  let reservedAttemptInputTokens = resumedCheckpoint?.usage.reservedInputTokens ?? 0;
  let reservedAttemptOutputTokens = resumedCheckpoint?.usage.reservedOutputTokens ?? 0;
  let budgetExceeded = false;
  const capturedProviderResults: ConversationRunResult[] = [...(resumedCheckpoint?.results ?? [])];
  const capturedProviderResultsByTurn = new Map<string, ConversationRunResult>(
    capturedProviderResults.map((result) => [`${result.scenarioId}:${result.turnId}`, result]),
  );
  const reviewCaptures: ConversationReviewCapture[] = [
    ...(resumedCheckpoint?.reviewCaptures ?? []),
  ];
  const allScenarioIds = scenarios.map(({ scenarioId }) => scenarioId);
  const completedScenarioIdSet = new Set(resumedCheckpoint?.completedScenarioIds ?? []);
  let completedScenarioIds = allScenarioIds.filter((scenarioId) =>
    completedScenarioIdSet.has(scenarioId),
  );
  const attemptedTurnKeys: string[] = [];
  let recoveryTurnsDispatched = 0;
  const boundedProvider: ConversationProvider<EvalPayload> = async (request) => {
    const turnKey = `${request.scenarioId}:${request.turnId}`;
    const builtRequest = buildAnthropicClinicalMemoryTurnPreflight(
      clinicalMemoryConfig(candidate),
      request.payload.turnInput,
    );
    const inputTokenUpperBound = builtRequest.reservedInputTokens;
    const outputTokenUpperBound = builtRequest.reservedOutputTokens;
    const reservedCalls = builtRequest.reservedModelCalls;
    const serializedUtf8Bytes = builtRequest.interpretationSerializedUtf8Bytes;
    const nextAttemptedCalls = attemptedCalls + reservedCalls;
    const nextReservedInputTokens = reservedAttemptInputTokens + inputTokenUpperBound;
    const nextReservedOutputTokens = reservedAttemptOutputTokens + outputTokenUpperBound;
    if (
      serializedUtf8Bytes > CLINICAL_MEMORY_MAX_SERIALIZED_REQUEST_BYTES ||
      nextAttemptedCalls > effectiveCaps.calls ||
      nextReservedInputTokens > effectiveCaps.inputTokens ||
      nextReservedOutputTokens > effectiveCaps.outputTokens ||
      projectedReservedCost(nextReservedInputTokens, nextReservedOutputTokens) > args.maxCostUsd
    ) {
      budgetExceeded = true;
      throw new ConversationRunnerFatalError('budget exceeded');
    }
    attemptedCalls = nextAttemptedCalls;
    reservedAttemptInputTokens = nextReservedInputTokens;
    reservedAttemptOutputTokens = nextReservedOutputTokens;
    reservedInputTokensByTurn.set(turnKey, inputTokenUpperBound);
    reservedOutputTokensByTurn.set(turnKey, outputTokenUpperBound);
    attemptedTurnKeys.push(turnKey);
    if (recoveryTurnDelayMs > 0 && recoveryTurnsDispatched > 0) {
      await deps.sleep(recoveryTurnDelayMs);
    }
    recoveryTurnsDispatched += 1;
    let response: Awaited<ReturnType<ConversationProvider<EvalPayload>>>;
    try {
      response = await provider(request);
    } catch (error) {
      if (
        error instanceof ConversationProviderTransportError &&
        error.transportDiagnostic.operation === 'count_tokens'
      ) {
        attemptedCalls -= reservedCalls;
      }
      if (!(error instanceof ConversationRunnerFatalError)) {
        deps.logCode(providerFailureLogCode(error));
      }
      throw error;
    }
    const parsedTurnResult =
      response.outcome === 'completed' && response.turnResult !== undefined
        ? conversationTurnResultSchema.safeParse(response.turnResult)
        : null;
    if (parsedTurnResult?.success === true) {
      reviewCaptures.push({
        scenarioId: request.scenarioId,
        turnId: request.turnId,
        preparedTurnInput: builtRequest.preparedTurnInput,
        turnResult: parsedTurnResult.data,
        expectation: request.payload.expectation,
      });
    }
    const result = projectConversationProviderResponse(
      request.scenarioId,
      request.turnId,
      response,
    );
    if (result.modelCalls !== undefined) {
      attemptedCalls -= reservedCalls - result.modelCalls;
    }
    capturedProviderResults.push(result);
    capturedProviderResultsByTurn.set(turnKey, result);
    inputTokens += result.inputTokens ?? 0;
    outputTokens += result.outputTokens ?? 0;
    cacheCreationInputTokens += result.cacheCreationInputTokens ?? 0;
    cacheReadInputTokens += result.cacheReadInputTokens ?? 0;
    thinkingTokens += result.thinkingTokens ?? 0;
    const returnedInputTokens =
      (result.inputTokens ?? 0) +
      (result.cacheCreationInputTokens ?? 0) +
      (result.cacheReadInputTokens ?? 0);
    const billedInputTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
    const costUsd = projectedCost(
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
    );
    budgetExceeded =
      attemptedCalls > effectiveCaps.calls ||
      returnedInputTokens > MAX_INPUT_TOKENS_PER_CALL * (result.modelCalls ?? reservedCalls) ||
      billedInputTokens > effectiveCaps.inputTokens ||
      outputTokens > effectiveCaps.outputTokens ||
      costUsd > args.maxCostUsd;
    deps.logCode(`CONVERSATION_EVAL_PROGRESS:${attemptedCalls}:${projectedCalls}`);
    if (budgetExceeded) throw new ConversationRunnerFatalError('budget exceeded');
    return response;
  };

  let providerResults: readonly ConversationRunResult[] = [];
  let providerAborted = false;
  let providerAbortCode: ConversationEvalArtifact['execution']['providerAbortCode'] = null;
  try {
    const pendingScenarios = scenarios.filter(
      ({ scenarioId }) => !completedScenarioIdSet.has(scenarioId),
    );
    const output = await runConversationScenarios(pendingScenarios, boundedProvider, {
      candidateConfigId: args.candidateConfigId,
      onScenarioComplete: ({ scenarioId, completed }) => {
        if (!checkpointEnabled) return;
        if (completed) completedScenarioIdSet.add(scenarioId);
        completedScenarioIds = allScenarioIds.filter((id) => completedScenarioIdSet.has(id));
        const checkpointScenarioIds = new Set(completedScenarioIds);
        try {
          deps.writeCheckpoint({
            schemaVersion: 1,
            checkpointId,
            bindingSha256: checkpointBinding,
            completedScenarioIds,
            results: capturedProviderResults.filter(({ scenarioId: id }) =>
              checkpointScenarioIds.has(id),
            ),
            reviewCaptures: reviewCaptures.filter(({ scenarioId: id }) =>
              checkpointScenarioIds.has(id),
            ),
            usage: {
              attemptedCalls,
              reservedInputTokens: reservedAttemptInputTokens,
              reservedOutputTokens: reservedAttemptOutputTokens,
              inputTokens,
              outputTokens,
              cacheCreationInputTokens,
              cacheReadInputTokens,
              thinkingTokens,
            },
          });
        } catch {
          throw new ConversationRunnerFatalError('checkpoint write failed');
        }
      },
    });
    providerResults = [...(resumedCheckpoint?.results ?? []), ...output.results];
  } catch (error) {
    providerAborted = true;
    const abortCodes: Readonly<
      Record<string, NonNullable<ConversationEvalArtifact['execution']['providerAbortCode']>>
    > = {
      'token count request rejected': 'TOKEN_COUNT_REJECTED',
      'message create request rejected': 'MESSAGE_CREATE_REJECTED',
      'input token ceiling exceeded': 'INPUT_TOKEN_CEILING',
      'request size ceiling exceeded': 'REQUEST_SIZE_CEILING',
      'provider usage unavailable': 'PROVIDER_USAGE_UNAVAILABLE',
      'invalid conversation turn input': 'INVALID_TURN_INPUT',
      'checkpoint write failed': 'CHECKPOINT_WRITE_FAILED',
    };
    providerAbortCode =
      error instanceof ConversationRunnerFatalError
        ? (abortCodes[error.message] ?? 'UNKNOWN')
        : 'UNKNOWN';
    providerResults = capturedProviderResults;
  }

  const ambiguousTurnKeys = new Set(
    providerResults.flatMap((result) =>
      result.outcome === 'timeout' || result.outcome === 'provider_error'
        ? [`${result.scenarioId}:${result.turnId}`]
        : [],
    ),
  );
  for (const turnKey of attemptedTurnKeys) {
    if (!capturedProviderResultsByTurn.has(turnKey)) ambiguousTurnKeys.add(turnKey);
  }
  let ambiguousMeasuredInputTokens = 0;
  let ambiguousMeasuredCacheCreationInputTokens = 0;
  let ambiguousMeasuredCacheReadInputTokens = 0;
  let ambiguousMeasuredOutputTokens = 0;
  let ambiguousReservedInputTokens = 0;
  let ambiguousReservedOutputTokens = 0;
  for (const turnKey of ambiguousTurnKeys) {
    const captured = capturedProviderResultsByTurn.get(turnKey);
    ambiguousMeasuredInputTokens += captured?.inputTokens ?? 0;
    ambiguousMeasuredCacheCreationInputTokens += captured?.cacheCreationInputTokens ?? 0;
    ambiguousMeasuredCacheReadInputTokens += captured?.cacheReadInputTokens ?? 0;
    ambiguousMeasuredOutputTokens += captured?.outputTokens ?? 0;
    ambiguousReservedInputTokens +=
      reservedInputTokensByTurn.get(turnKey) ?? MAX_INPUT_TOKENS_PER_CALL;
    ambiguousReservedOutputTokens += reservedOutputTokensByTurn.get(turnKey) ?? candidate.maxTokens;
  }
  const resumedCompletedModelCalls = (resumedCheckpoint?.results ?? []).reduce(
    (total, result) => total + (result.modelCalls ?? 0),
    0,
  );
  const resumedAmbiguousUsage =
    resumedCheckpoint !== null &&
    resumedCheckpoint.usage.attemptedCalls > resumedCompletedModelCalls;
  const measuredCostUsd = projectedCost(
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
  );
  const costUsd = ambiguousTurnKeys.size === 0 && !resumedAmbiguousUsage ? measuredCostUsd : null;
  const costUpperBoundUsd = resumedAmbiguousUsage
    ? projectedReservedCost(reservedAttemptInputTokens, reservedAttemptOutputTokens)
    : projectedCost(
        inputTokens - ambiguousMeasuredInputTokens,
        outputTokens - ambiguousMeasuredOutputTokens,
        cacheCreationInputTokens - ambiguousMeasuredCacheCreationInputTokens,
        cacheReadInputTokens - ambiguousMeasuredCacheReadInputTokens,
      ) + projectedReservedCost(ambiguousReservedInputTokens, ambiguousReservedOutputTokens);
  const ceilingPassed = !providerAborted && !budgetExceeded;
  const expectationById = new Map(
    expectedTurns.map((expectation) => [
      `${expectation.scenarioId}:${expectation.turnId}`,
      expectation,
    ]),
  );
  const projectedProviderResults: ConversationEvalArtifactResult[] = providerResults.map(
    (result) => {
      const expectation = expectationById.get(`${result.scenarioId}:${result.turnId}`);
      const costMetricApplies = expectation?.applicableMetrics.includes(
        'token_context_cost_ceiling',
      );
      return {
        ...result,
        source: 'provider',
        metricSuccesses: {
          ...result.metricSuccesses,
          ...(costMetricApplies ? { token_context_cost_ceiling: ceilingPassed } : {}),
        },
      };
    },
  );
  const scoredProviderResults = fullRun
    ? projectedProviderResults.map((result) => ({
        ...result,
        metricSuccesses: Object.fromEntries(
          Object.entries(result.metricSuccesses).filter(
            ([metricId]) =>
              !SEMANTIC_REVIEW_REQUIRED_METRICS.includes(
                metricId as (typeof SEMANTIC_REVIEW_REQUIRED_METRICS)[number],
              ),
          ),
        ),
      }))
    : projectedProviderResults;
  const expectedProviderTurnKeys = new Set(
    providerExpectedTurns.map(({ scenarioId, turnId }) => `${scenarioId}:${turnId}`),
  );
  const resultTurnKeys = providerResults.map(({ scenarioId, turnId }) => `${scenarioId}:${turnId}`);
  const capturedReviewTurnKeys = reviewCaptures.map(
    ({ scenarioId, turnId }) => `${scenarioId}:${turnId}`,
  );
  const executionComplete =
    !providerAborted &&
    !budgetExceeded &&
    providerResults.length === providerEligibleTurns &&
    providerResults.every(({ outcome }) => outcome === 'completed') &&
    new Set(resultTurnKeys).size === resultTurnKeys.length &&
    resultTurnKeys.every((key) => expectedProviderTurnKeys.has(key));
  const reviewCaptureComplete =
    capturedReviewTurnKeys.length === expectedProviderTurnKeys.size &&
    new Set(capturedReviewTurnKeys).size === capturedReviewTurnKeys.length &&
    capturedReviewTurnKeys.every((key) => expectedProviderTurnKeys.has(key));
  const fullProviderComplete = executionComplete && reviewCaptureComplete;
  const fixtureResults = fixtureContractResults(scenarios);
  const results = [...scoredProviderResults, ...fixtureResults];
  const report = buildConversationMetricsReport(
    providerExpectedTurns,
    scoredProviderResults satisfies readonly ConversationTurnObservation[],
  );
  const mechanicalPassed = mechanicalMetricsPass(providerExpectedTurns, scoredProviderResults);
  let reviewBundleWriteFailed = false;
  if (fullRun && fullProviderComplete) {
    try {
      const frozenBundle = freezeConversationReviewBundle(
        reviewCaptures,
        new Date(runTimeMs + CONVERSATION_REVIEW_BUNDLE_TTL_MS).toISOString(),
        {
          evalSetVersion: corpus.manifest.evalSetVersion,
          partition: args.partition,
          corpusSha256:
            args.partition === 'dev' ? corpus.manifest.devSha256 : corpus.manifest.holdoutSha256,
        },
      );
      deps.writeReviewBundle(runId, frozenBundle);
    } catch {
      reviewBundleWriteFailed = true;
      deps.logCode('CONVERSATION_EVAL_REVIEW_BUNDLE_WRITE_FAILED');
    }
  }
  const providerPendingReview =
    fullRun && fullProviderComplete && mechanicalPassed && !reviewBundleWriteFailed;
  const status =
    providerAborted || budgetExceeded || !executionComplete || (fullRun && !fullProviderComplete)
      ? 'aborted'
      : fullRun
        ? providerPendingReview
          ? 'provider_completed_pending_review'
          : 'aborted'
        : 'pilot_completed';
  const reasonCode = budgetExceeded
    ? 'BUDGET_EXCEEDED'
    : providerAborted
      ? 'PROVIDER_ABORTED'
      : !executionComplete || (fullRun && !fullProviderComplete)
        ? 'PROVIDER_INCOMPLETE'
        : reviewBundleWriteFailed
          ? 'REVIEW_BUNDLE_WRITE_FAILED'
          : fullRun && !mechanicalPassed
            ? 'MECHANICAL_EVALUATION_FAILED'
            : fullRun
              ? 'provider_completed_pending_review'
              : 'PILOT_ONLY';
  const artifact: ConversationEvalArtifact = {
    schemaVersion: 1,
    runId,
    createdAtUtc: runTime.toISOString(),
    corpus: {
      evalSetVersion: corpus.manifest.evalSetVersion,
      partition: args.partition,
      sha256: args.partition === 'dev' ? corpus.manifest.devSha256 : corpus.manifest.holdoutSha256,
      scenarios: selectedScenarios.length,
      scenarioLimit: args.scenarioLimit ?? null,
      scenarioId: args.scenarioId ?? null,
    },
    config: {
      candidateConfigId: candidate.id,
      model: candidate.model,
      thinkingType: candidate.thinking.type,
      effort: candidate.effort,
      maxTokensPerCall: candidate.maxTokens,
      maxInputTokensPerCall: MAX_INPUT_TOKENS_PER_CALL,
      maxConcurrency: 1,
      promptVersion: CLINICAL_EXTRACTOR_PROMPT_VERSION,
      promptSha256: CLINICAL_EXTRACTOR_PROMPT_SHA256,
      outputSchemaSha256: CLINICAL_EXTRACTOR_SCHEMA_SHA256,
      scorerVersion: CONVERSATION_SCORER_VERSION,
      architecture: 'clinical_memory',
    },
    pricesUsdPerMillionTokens: {
      input: SONNET_INPUT_USD_PER_MTOK,
      cacheCreationInput: SONNET_CACHE_CREATION_INPUT_USD_PER_MTOK,
      cacheReadInput: SONNET_CACHE_READ_INPUT_USD_PER_MTOK,
      output: SONNET_OUTPUT_USD_PER_MTOK,
    },
    caps: {
      calls: effectiveCaps.calls,
      inputTokens: effectiveCaps.inputTokens,
      outputTokens: effectiveCaps.outputTokens,
      costUsd: args.maxCostUsd,
      projectedWorstCaseCostUsd,
      recoveryExtraTurns,
      recoveryTurnDelayMs,
    },
    execution: {
      status,
      reasonCode,
      providerAbortCode,
      acceptanceEligible: false,
      expectedTurns: expectedTurns.length,
      providerEligibleTurns,
      deterministicTurns,
      attemptedCalls,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      thinkingTokens,
      costUsd,
      costUpperBoundUsd,
    },
    deterministicFixtureCoverage: {
      source: 'fixture_contract',
      expectedTurns: deterministicTurns,
      representedTurns: fixtureResults.length,
    },
    results,
    metrics: projectMetrics(report),
  };

  try {
    deps.writeArtifact(artifact);
  } catch {
    deps.logCode('CONVERSATION_EVAL_ARTIFACT_WRITE_FAILED');
    return 1;
  }
  if (checkpointEnabled && fullProviderComplete && !reviewBundleWriteFailed) {
    try {
      deps.deleteCheckpoint(checkpointId);
    } catch {
      deps.logCode('CONVERSATION_EVAL_CHECKPOINT_DELETE_FAILED');
    }
  }
  if (!fullRun) {
    const pilotPassed = executionComplete;
    deps.logCode(pilotPassed ? 'CONVERSATION_EVAL_PILOT_COMPLETED' : 'CONVERSATION_EVAL_FAILED');
    return pilotPassed ? 0 : 1;
  }
  deps.logCode(
    providerPendingReview
      ? 'CONVERSATION_EVAL_PROVIDER_COMPLETED_PENDING_REVIEW'
      : 'CONVERSATION_EVAL_FAILED',
  );
  return providerPendingReview ? 0 : 1;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void runConversationEvalCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
