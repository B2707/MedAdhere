import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  CONVERSATION_CLARIFICATION_TOPICS,
  conversationTurnInputSchema,
  conversationTurnResultSchema,
  type ConversationClarificationTopic,
} from '@medadhere/shared';
import { z } from 'zod';
import {
  CONVERSATION_METRIC_IDS,
  type ConversationMetricId,
  type ObservedConversationOutcome,
} from './conversation-metrics.js';
import {
  MALFORMED_DIAGNOSTIC_STAGES,
  type ConversationRunResult,
  type MalformedDiagnosticStage,
} from './conversation-runner.js';
import type { ConversationReviewCapture } from './conversation-review-bundle.js';
import type { ConversationPatientExpectation } from './conversation-scenarios.js';

export interface ConversationEvalCheckpointUsage {
  readonly attemptedCalls: number;
  readonly reservedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly thinkingTokens: number;
}

export interface ConversationEvalCheckpoint {
  readonly schemaVersion: 1;
  readonly checkpointId: string;
  readonly bindingSha256: string;
  readonly completedScenarioIds: readonly string[];
  readonly results: readonly ConversationRunResult[];
  readonly reviewCaptures: readonly ConversationReviewCapture[];
  readonly usage: ConversationEvalCheckpointUsage;
}

export class ConversationEvalCheckpointError extends Error {
  override readonly name = 'ConversationEvalCheckpointError';
}

const CHECKPOINT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BINDING_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SCENARIO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TURN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MODEL_STAGE_VALUES = ['interpretation', 'writer'] as const;
const ACTION_TYPES = ['acknowledge', 'ask_clarification', 'complete_turn'] as const;

const metricIdSchema = z.enum(CONVERSATION_METRIC_IDS);
const metricSuccessesSchema = z.record(metricIdSchema, z.boolean());
const malformedIssueSchema = z
  .object({
    path: z.string().min(1).max(200),
    code: z.string().min(1).max(80),
  })
  .strict();
const nonNegativeNumberSchema = z.number().finite().min(0);
const nonNegativeIntegerSchema = z.number().int().min(0);
const conversationRunResultSchema = z
  .object({
    scenarioId: z.string().regex(SCENARIO_ID_PATTERN),
    turnId: z.string().regex(TURN_ID_PATTERN),
    outcome: z.enum([
      'completed',
      'refused',
      'truncated',
      'malformed',
      'timeout',
      'provider_error',
    ]),
    metricSuccesses: metricSuccessesSchema,
    latencyMs: nonNegativeNumberSchema.optional(),
    inputTokens: nonNegativeNumberSchema.optional(),
    outputTokens: nonNegativeNumberSchema.optional(),
    cacheCreationInputTokens: nonNegativeNumberSchema.optional(),
    cacheReadInputTokens: nonNegativeNumberSchema.optional(),
    thinkingTokens: nonNegativeNumberSchema.optional(),
    modelCalls: nonNegativeIntegerSchema.optional(),
    modelStage: z.enum(MODEL_STAGE_VALUES).optional(),
    actionType: z.enum(ACTION_TYPES).optional(),
    clarificationTopic: z.enum(CONVERSATION_CLARIFICATION_TOPICS).optional(),
    malformedStage: z.enum(MALFORMED_DIAGNOSTIC_STAGES).optional(),
    malformedIssues: z.array(malformedIssueSchema).max(20).optional(),
  })
  .strict();
const usageSchema = z
  .object({
    attemptedCalls: nonNegativeIntegerSchema,
    reservedInputTokens: nonNegativeIntegerSchema,
    reservedOutputTokens: nonNegativeIntegerSchema,
    inputTokens: nonNegativeNumberSchema,
    outputTokens: nonNegativeNumberSchema,
    cacheCreationInputTokens: nonNegativeNumberSchema,
    cacheReadInputTokens: nonNegativeNumberSchema,
    thinkingTokens: nonNegativeNumberSchema,
  })
  .strict();
const checkpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    checkpointId: z.string().regex(CHECKPOINT_ID_PATTERN),
    bindingSha256: z.string().regex(BINDING_PATTERN),
    completedScenarioIds: z.array(z.string().regex(SCENARIO_ID_PATTERN)),
    results: z.array(conversationRunResultSchema),
    reviewCaptures: z.array(z.unknown()),
    usage: usageSchema,
  })
  .strict();

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function checkpointPath(directory: string, checkpointId: string): string {
  if (!CHECKPOINT_ID_PATTERN.test(checkpointId)) {
    throw new ConversationEvalCheckpointError('invalid conversation eval checkpoint ID');
  }
  return join(directory, `conversation-checkpoint-${checkpointId}.json`);
}

function validateReviewCapture(candidate: unknown): ConversationReviewCapture {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new ConversationEvalCheckpointError('invalid conversation review capture');
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  if (
    typeof record.scenarioId !== 'string' ||
    !SCENARIO_ID_PATTERN.test(record.scenarioId) ||
    typeof record.turnId !== 'string' ||
    !TURN_ID_PATTERN.test(record.turnId)
  ) {
    throw new ConversationEvalCheckpointError('invalid conversation review capture');
  }
  try {
    return {
      scenarioId: record.scenarioId,
      turnId: record.turnId,
      preparedTurnInput: conversationTurnInputSchema.parse(record.preparedTurnInput),
      turnResult: conversationTurnResultSchema.parse(record.turnResult),
      expectation: structuredClone(record.expectation) as ConversationPatientExpectation,
    };
  } catch {
    throw new ConversationEvalCheckpointError('invalid conversation review capture');
  }
}

function assertUniqueCompletedScenarioIds(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new ConversationEvalCheckpointError('duplicate completed scenario ID');
    }
    seen.add(id);
  }
}

function assertUniqueTurnIds(
  label: 'result' | 'review capture',
  turns: readonly { readonly scenarioId: string; readonly turnId: string }[],
): void {
  const seen = new Set<string>();
  for (const turn of turns) {
    const key = `${turn.scenarioId}:${turn.turnId}`;
    if (seen.has(key)) {
      throw new ConversationEvalCheckpointError(`duplicate checkpoint ${label} turn ID`);
    }
    seen.add(key);
  }
}

function validateCheckpoint(candidate: unknown): ConversationEvalCheckpoint {
  const parsed = checkpointSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ConversationEvalCheckpointError('invalid conversation eval checkpoint');
  }
  assertUniqueCompletedScenarioIds(parsed.data.completedScenarioIds);
  const results = parsed.data.results.map(
    (result): ConversationRunResult => ({
      scenarioId: result.scenarioId,
      turnId: result.turnId,
      outcome: result.outcome as ObservedConversationOutcome,
      metricSuccesses: result.metricSuccesses as Partial<Record<ConversationMetricId, boolean>>,
      ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
      ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
      ...(result.outputTokens === undefined ? {} : { outputTokens: result.outputTokens }),
      ...(result.cacheCreationInputTokens === undefined
        ? {}
        : { cacheCreationInputTokens: result.cacheCreationInputTokens }),
      ...(result.cacheReadInputTokens === undefined
        ? {}
        : { cacheReadInputTokens: result.cacheReadInputTokens }),
      ...(result.thinkingTokens === undefined ? {} : { thinkingTokens: result.thinkingTokens }),
      ...(result.modelCalls === undefined ? {} : { modelCalls: result.modelCalls }),
      ...(result.modelStage === undefined ? {} : { modelStage: result.modelStage }),
      ...(result.actionType === undefined ? {} : { actionType: result.actionType }),
      ...(result.clarificationTopic === undefined
        ? {}
        : { clarificationTopic: result.clarificationTopic as ConversationClarificationTopic }),
      ...(result.malformedStage === undefined
        ? {}
        : { malformedStage: result.malformedStage as MalformedDiagnosticStage }),
      ...(result.malformedIssues === undefined ? {} : { malformedIssues: result.malformedIssues }),
    }),
  );
  assertUniqueTurnIds('result', results);
  const reviewCaptures = parsed.data.reviewCaptures.map(validateReviewCapture);
  assertUniqueTurnIds('review capture', reviewCaptures);
  return deepFreeze({
    schemaVersion: 1,
    checkpointId: parsed.data.checkpointId,
    bindingSha256: parsed.data.bindingSha256,
    completedScenarioIds: parsed.data.completedScenarioIds,
    results,
    reviewCaptures,
    usage: parsed.data.usage,
  });
}

function assertSecureCheckpointFile(path: string): void {
  const linkStats = lstatSync(path);
  if (!linkStats.isFile()) {
    throw new ConversationEvalCheckpointError('not a regular checkpoint file');
  }
  if ((linkStats.mode & 0o777) !== 0o600) {
    throw new ConversationEvalCheckpointError('insecure checkpoint file mode');
  }
}

export function writeConversationEvalCheckpointAtomic(
  directory: string,
  checkpoint: ConversationEvalCheckpoint,
): string {
  const validated = validateCheckpoint(checkpoint);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const finalPath = checkpointPath(directory, validated.checkpointId);
  const temporaryPath = join(directory, `.conversation-checkpoint-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(validated)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, finalPath);
    return finalPath;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Never mask the original checkpoint-write failure.
    }
    throw error;
  }
}

export function readConversationEvalCheckpoint(
  directory: string,
  checkpointId: string,
  expectedBinding: string,
): ConversationEvalCheckpoint {
  if (!BINDING_PATTERN.test(expectedBinding)) {
    throw new ConversationEvalCheckpointError('invalid conversation eval checkpoint binding');
  }
  const path = checkpointPath(directory, checkpointId);
  assertSecureCheckpointFile(path);
  const checkpoint = validateCheckpoint(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  if (checkpoint.checkpointId !== checkpointId) {
    throw new ConversationEvalCheckpointError('checkpoint ID mismatch');
  }
  if (checkpoint.bindingSha256 !== expectedBinding) {
    throw new ConversationEvalCheckpointError('checkpoint binding mismatch');
  }
  return checkpoint;
}

export function deleteConversationEvalCheckpoint(directory: string, checkpointId: string): void {
  const path = checkpointPath(directory, checkpointId);
  if (!existsSync(path)) return;
  assertSecureCheckpointFile(path);
  unlinkSync(path);
}
