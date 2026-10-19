/**
 * Injected Phase 8 conversation-eval runner.
 *
 * Scenarios and turns run sequentially. The returned artifact is allowlist-
 * projected to IDs, typed outcomes, metric booleans, and numeric telemetry.
 * Patient messages, model turn results, provider prose, and exception text are
 * omitted.
 */
import {
  CONVERSATION_CLARIFICATION_TOPICS,
  type ConversationClarificationTopic,
  type ConversationTurnResult,
} from '@medadhere/shared';
import {
  CONVERSATION_METRIC_IDS,
  type ConversationMetricId,
  type ObservedConversationOutcome,
} from './conversation-metrics.js';

export const SONNET_CANDIDATE_CONFIGS = [
  {
    id: 'thinking_disabled',
    model: 'claude-sonnet-5',
    thinking: { type: 'disabled' },
    effort: null,
    maxTokens: 4096,
  },
  {
    id: 'adaptive_high',
    model: 'claude-sonnet-5',
    thinking: { type: 'adaptive' },
    effort: 'high',
    maxTokens: 8192,
  },
] as const;

export type SonnetCandidateConfig = (typeof SONNET_CANDIDATE_CONFIGS)[number];
export type SonnetCandidateConfigId = SonnetCandidateConfig['id'];

export class ConversationRunnerFatalError extends Error {
  override readonly name = 'ConversationRunnerFatalError';
}

export const CONVERSATION_TRANSPORT_CAUSE_CODES = [
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
] as const;

export type ConversationTransportCauseCode =
  | (typeof CONVERSATION_TRANSPORT_CAUSE_CODES)[number]
  | 'unknown';

export interface ConversationTransportDiagnostic {
  readonly operation: 'count_tokens' | 'messages_create';
  readonly errorClass: 'api_connection_timeout' | 'api_connection' | 'other';
  readonly causeCode: ConversationTransportCauseCode;
}

export class ConversationProviderTransportError extends Error {
  override readonly name = 'ConversationProviderTransportError';
  readonly modelStage: 'interpretation' | 'writer';
  readonly transportDiagnostic: ConversationTransportDiagnostic;

  constructor(options: {
    readonly modelStage: 'interpretation' | 'writer';
    readonly operation: ConversationTransportDiagnostic['operation'];
    readonly errorClass: ConversationTransportDiagnostic['errorClass'];
    readonly causeCode: ConversationTransportCauseCode;
  }) {
    super('conversation provider transport error');
    this.modelStage = options.modelStage;
    this.transportDiagnostic = {
      operation: options.operation,
      errorClass: options.errorClass,
      causeCode: options.causeCode,
    };
  }
}

const TRANSPORT_CAUSE_CODES = new Set<string>(CONVERSATION_TRANSPORT_CAUSE_CODES);

function errorRecord(error: unknown): Readonly<Record<string, unknown>> {
  return typeof error === 'object' && error !== null
    ? (error as Readonly<Record<string, unknown>>)
    : {};
}

function transportCauseCode(error: unknown): ConversationTransportCauseCode {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null || seen.has(current)) break;
    seen.add(current);
    const record = errorRecord(current);
    if (typeof record.code === 'string' && TRANSPORT_CAUSE_CODES.has(record.code)) {
      return record.code as ConversationTransportCauseCode;
    }
    current = record.cause;
  }
  return 'unknown';
}

export function conversationProviderTransportError(
  error: unknown,
  modelStage: 'interpretation' | 'writer',
  operation: ConversationTransportDiagnostic['operation'],
  errorClass: ConversationTransportDiagnostic['errorClass'],
): ConversationProviderTransportError {
  return new ConversationProviderTransportError({
    modelStage,
    operation,
    errorClass,
    causeCode: transportCauseCode(error),
  });
}

/** Set only after the v2 development comparison passes independent review. */
export const PINNED_SONNET_CONFIG_ID: SonnetCandidateConfigId | null = null;

export const MALFORMED_DIAGNOSTIC_STAGES = [
  'stop_reason',
  'content_shape',
  'json_parse',
  'zod_validation',
] as const;
export const MAX_MALFORMED_DIAGNOSTIC_ISSUES = 20;
export type MalformedDiagnosticStage = (typeof MALFORMED_DIAGNOSTIC_STAGES)[number];

export interface MalformedDiagnosticIssue {
  readonly path: string;
  readonly code: string;
}

export interface ConversationRunnerTurn<TPayload> {
  readonly turnId: string;
  readonly eligibleForProvider: boolean;
  readonly payload: TPayload;
}

export interface ConversationRunnerScenario<TPayload> {
  readonly scenarioId: string;
  readonly turns: readonly ConversationRunnerTurn<TPayload>[];
}

export interface ConversationProviderRequest<TPayload> {
  readonly scenarioId: string;
  readonly turnId: string;
  readonly payload: TPayload;
  readonly candidateConfig: SonnetCandidateConfig;
  readonly priorTurnResults: readonly ConversationTurnResult[];
}

export interface ConversationProviderResponse {
  readonly outcome: ObservedConversationOutcome;
  readonly turnResult?: ConversationTurnResult;
  readonly metricSuccesses?: Readonly<Record<string, unknown>>;
  readonly latencyMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly thinkingTokens?: number;
  readonly modelCalls?: number;
  readonly modelStage?: 'interpretation' | 'writer';
  readonly malformedStage?: MalformedDiagnosticStage;
  readonly malformedIssues?: readonly MalformedDiagnosticIssue[];
}

export type ConversationProvider<TPayload> = (
  request: ConversationProviderRequest<TPayload>,
) => Promise<ConversationProviderResponse>;

export interface ConversationRunResult {
  readonly scenarioId: string;
  readonly turnId: string;
  readonly outcome: ObservedConversationOutcome;
  readonly metricSuccesses: Partial<Record<ConversationMetricId, boolean>>;
  readonly latencyMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly thinkingTokens?: number;
  readonly modelCalls?: number;
  readonly modelStage?: 'interpretation' | 'writer';
  readonly transportDiagnostic?: ConversationTransportDiagnostic;
  readonly actionType?: ConversationTurnResult['action']['type'];
  readonly clarificationTopic?: ConversationClarificationTopic;
  readonly malformedStage?: MalformedDiagnosticStage;
  readonly malformedIssues?: readonly MalformedDiagnosticIssue[];
}

export interface ConversationRunOutput {
  readonly candidateConfigId: SonnetCandidateConfigId;
  readonly results: readonly ConversationRunResult[];
}

export interface ConversationRunnerOptions {
  readonly candidateConfigId: SonnetCandidateConfigId;
  readonly onScenarioComplete?: (boundary: ConversationScenarioBoundary) => void | Promise<void>;
}

export interface ConversationScenarioBoundary {
  readonly scenarioId: string;
  readonly completed: boolean;
  readonly results: readonly ConversationRunResult[];
}

const PROVIDER_OUTCOMES = new Set<ObservedConversationOutcome>([
  'completed',
  'refused',
  'truncated',
  'malformed',
  'timeout',
  'provider_error',
]);
const MODEL_STAGES = new Set(['interpretation', 'writer']);
const ACTION_TYPES = new Set<ConversationTurnResult['action']['type']>([
  'acknowledge',
  'ask_clarification',
  'complete_turn',
]);
const CLARIFICATION_TOPICS = new Set<ConversationClarificationTopic>(
  CONVERSATION_CLARIFICATION_TOPICS,
);
const METRIC_IDS = new Set<ConversationMetricId>(CONVERSATION_METRIC_IDS);
const MALFORMED_STAGES = new Set<MalformedDiagnosticStage>(MALFORMED_DIAGNOSTIC_STAGES);
const ZOD_ISSUE_CODES = new Set([
  'invalid_type',
  'invalid_literal',
  'custom',
  'invalid_union',
  'invalid_union_discriminator',
  'invalid_enum_value',
  'unrecognized_keys',
  'invalid_arguments',
  'invalid_return_type',
  'invalid_date',
  'invalid_string',
  'too_small',
  'too_big',
  'invalid_intersection_types',
  'not_multiple_of',
  'not_finite',
]);
const SAFE_ZOD_PATH = /^(?:\$|[A-Za-z][A-Za-z0-9_]*(?:\.(?:[A-Za-z][A-Za-z0-9_]*|\d+))*)$/u;

function findCandidate(candidateConfigId: string): SonnetCandidateConfig | undefined {
  return SONNET_CANDIDATE_CONFIGS.find(({ id }) => id === candidateConfigId);
}

function validateScenarios<TPayload>(
  scenarios: readonly ConversationRunnerScenario<TPayload>[],
): void {
  const scenarioIds = new Set<string>();
  const turnIds = new Set<string>();
  for (const scenario of scenarios) {
    if (scenarioIds.has(scenario.scenarioId)) {
      throw new Error(`conversation runner: duplicate scenario ID ${scenario.scenarioId}`);
    }
    scenarioIds.add(scenario.scenarioId);

    for (const turn of scenario.turns) {
      const key = `${scenario.scenarioId}:${turn.turnId}`;
      if (turnIds.has(key)) throw new Error(`conversation runner: duplicate turn ID ${key}`);
      turnIds.add(key);
    }
  }
}

function sanitizeMetricSuccesses(
  input: Readonly<Record<string, unknown>> | undefined,
): Partial<Record<ConversationMetricId, boolean>> {
  if (input === undefined) return {};
  const entries: Array<readonly [ConversationMetricId, boolean]> = [];
  for (const [id, value] of Object.entries(input)) {
    if (METRIC_IDS.has(id as ConversationMetricId) && typeof value === 'boolean') {
      entries.push([id as ConversationMetricId, value]);
    }
  }
  return Object.fromEntries(entries) as Partial<Record<ConversationMetricId, boolean>>;
}

function sanitizeNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sanitizeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sanitizeMalformedIssues(input: unknown): readonly MalformedDiagnosticIssue[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const issues: MalformedDiagnosticIssue[] = [];
  for (const candidate of input) {
    if (issues.length >= MAX_MALFORMED_DIAGNOSTIC_ISSUES) break;
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue;
    const { path, code } = candidate as Readonly<Record<string, unknown>>;
    if (
      typeof path !== 'string' ||
      path.length > 200 ||
      !SAFE_ZOD_PATH.test(path) ||
      typeof code !== 'string' ||
      !ZOD_ISSUE_CODES.has(code)
    ) {
      continue;
    }
    const key = `${path}:${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ path, code });
  }
  return issues;
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { readonly code?: unknown }).code;
  return (
    error.name === 'TimeoutError' ||
    error.name === 'AbortError' ||
    error.name === 'APIConnectionTimeoutError' ||
    error.name === 'APIUserAbortError' ||
    code === 'ETIMEDOUT'
  );
}

export function projectConversationProviderResponse(
  scenarioId: string,
  turnId: string,
  response: ConversationProviderResponse,
): ConversationRunResult {
  const validOutcome = PROVIDER_OUTCOMES.has(response.outcome);
  const outcome: ObservedConversationOutcome = validOutcome ? response.outcome : 'malformed';
  const metricSuccesses = validOutcome ? sanitizeMetricSuccesses(response.metricSuccesses) : {};
  const latencyMs = sanitizeNonNegativeNumber(response.latencyMs);
  const inputTokens = sanitizeNonNegativeNumber(response.inputTokens);
  const outputTokens = sanitizeNonNegativeNumber(response.outputTokens);
  const cacheCreationInputTokens = sanitizeNonNegativeNumber(response.cacheCreationInputTokens);
  const cacheReadInputTokens = sanitizeNonNegativeNumber(response.cacheReadInputTokens);
  const thinkingTokens = sanitizeNonNegativeNumber(response.thinkingTokens);
  const modelCalls = sanitizeNonNegativeInteger(response.modelCalls);
  const modelStage = MODEL_STAGES.has(response.modelStage ?? '')
    ? (response.modelStage as 'interpretation' | 'writer')
    : undefined;
  const responseAction = outcome === 'completed' ? response.turnResult?.action : undefined;
  const actionType = ACTION_TYPES.has(
    responseAction?.type as ConversationTurnResult['action']['type'],
  )
    ? responseAction?.type
    : undefined;
  const clarificationTopic =
    responseAction?.type === 'ask_clarification' &&
    CLARIFICATION_TOPICS.has(responseAction.clarificationTopic)
      ? responseAction.clarificationTopic
      : undefined;
  const malformedStage =
    outcome === 'malformed' &&
    MALFORMED_STAGES.has(response.malformedStage as MalformedDiagnosticStage)
      ? (response.malformedStage as MalformedDiagnosticStage)
      : undefined;
  const malformedIssues =
    malformedStage === 'zod_validation' ? sanitizeMalformedIssues(response.malformedIssues) : [];

  return {
    scenarioId,
    turnId,
    outcome,
    metricSuccesses,
    ...(latencyMs === undefined ? {} : { latencyMs }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(thinkingTokens === undefined ? {} : { thinkingTokens }),
    ...(modelCalls === undefined ? {} : { modelCalls }),
    ...(modelStage === undefined ? {} : { modelStage }),
    ...(actionType === undefined ? {} : { actionType }),
    ...(clarificationTopic === undefined ? {} : { clarificationTopic }),
    ...(malformedStage === undefined ? {} : { malformedStage }),
    ...(malformedIssues.length === 0 ? {} : { malformedIssues }),
  };
}

/**
 * Run an injected provider once per eligible turn until a scenario's first
 * non-completed outcome. Remaining turns stay absent so metric construction
 * records them as missing instead of evaluating impossible teacher-forced
 * history. No provider SDK or credential is imported here.
 */
export async function runConversationScenarios<TPayload>(
  scenarios: readonly ConversationRunnerScenario<TPayload>[],
  provider: ConversationProvider<TPayload>,
  options: ConversationRunnerOptions,
): Promise<ConversationRunOutput> {
  const candidateConfig = findCandidate(options.candidateConfigId);
  if (candidateConfig === undefined) {
    throw new Error(`conversation runner: unknown candidate ${options.candidateConfigId}`);
  }

  validateScenarios(scenarios);

  const results: ConversationRunResult[] = [];
  for (const scenario of scenarios) {
    const resultStart = results.length;
    let completed = true;
    let priorTurnResults: readonly ConversationTurnResult[] = [];
    for (const turn of scenario.turns) {
      if (!turn.eligibleForProvider) continue;

      try {
        const response = await provider({
          scenarioId: scenario.scenarioId,
          turnId: turn.turnId,
          payload: turn.payload,
          candidateConfig,
          priorTurnResults: [...priorTurnResults],
        });
        const projected = projectConversationProviderResponse(
          scenario.scenarioId,
          turn.turnId,
          response,
        );
        results.push(projected);
        if (projected.outcome !== 'completed') {
          completed = false;
          break;
        }
        if (response.turnResult !== undefined) {
          priorTurnResults = [...priorTurnResults, response.turnResult];
        }
      } catch (error) {
        if (error instanceof ConversationRunnerFatalError) throw error;
        const transportError =
          error instanceof ConversationProviderTransportError ? error : undefined;
        results.push({
          scenarioId: scenario.scenarioId,
          turnId: turn.turnId,
          outcome: transportError === undefined && isTimeout(error) ? 'timeout' : 'provider_error',
          metricSuccesses: {},
          ...(transportError === undefined
            ? {}
            : {
                modelStage: transportError.modelStage,
                transportDiagnostic: transportError.transportDiagnostic,
              }),
        });
        completed = false;
        break;
      }
    }
    await options.onScenarioComplete?.({
      scenarioId: scenario.scenarioId,
      completed,
      results: Object.freeze(results.slice(resultStart)),
    });
  }

  return {
    candidateConfigId: candidateConfig.id,
    results,
  };
}
