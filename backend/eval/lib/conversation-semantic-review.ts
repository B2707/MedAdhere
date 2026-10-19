/**
 * Pure binding and validation for external semantic review of conversation
 * outputs. Persisted review items contain only identifiers, hashes, booleans,
 * and committed integer failure codes; patient/model/reviewer prose is never
 * accepted by this contract.
 */
import { createHash } from 'node:crypto';
import { conversationTurnResultSchema } from '@medadhere/shared';
import { z } from 'zod';
import semanticReviewCodebookJson from '../conversation/semantic-review-codebook.v2.json';
import type { ConversationMetricId } from './conversation-metrics.js';
import {
  SEMANTIC_REVIEW_REQUIRED_METRICS,
  type ConversationTurnScores,
} from './conversation-scoring.js';

export const SEMANTIC_REVIEW_CODEBOOK_VERSION = 'semantic-review-codebook.v2';
export const SEMANTIC_REVIEW_CODEBOOK_HASH =
  'sha256:fb0bc2410511978279ce28c50d9e7f1b591195fa715c78dc37001425591a029c';

export type SemanticReviewMetricId = (typeof SEMANTIC_REVIEW_REQUIRED_METRICS)[number];

export interface ConversationSemanticMetricResult {
  readonly metricId: SemanticReviewMetricId;
  readonly passed: boolean;
  readonly failureCodes: readonly number[];
}

export interface ConversationSemanticReviewItem {
  readonly scenarioId: string;
  readonly turnId: string;
  readonly outputHash: string;
  readonly reviewerKind: 'llm_automated';
  readonly reviewerModel: string;
  readonly codebookVersion: typeof SEMANTIC_REVIEW_CODEBOOK_VERSION;
  readonly codebookHash: typeof SEMANTIC_REVIEW_CODEBOOK_HASH;
  readonly metricResults: readonly ConversationSemanticMetricResult[];
  readonly hashEcho: string;
}

declare const ACCEPTED_SEMANTIC_REVIEW: unique symbol;
export type AcceptedConversationSemanticReview = ConversationSemanticReviewItem & {
  readonly [ACCEPTED_SEMANTIC_REVIEW]: true;
};

export interface ConversationSemanticReviewContext {
  readonly scenarioId: string;
  readonly turnId: string;
  readonly turnResult: unknown;
  readonly applicableMetrics: readonly ConversationMetricId[];
}

export class ConversationSemanticReviewValidationError extends Error {
  override readonly name = 'ConversationSemanticReviewValidationError';
}

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/u;

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON requires finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new TypeError('Value is not canonical JSON data');

  const record = value as Readonly<Record<string, unknown>>;
  const members = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(',')}}`;
}

function canonicalJsonSha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

/** Validate, recursively canonicalize, and hash exactly one model turn result. */
export function hashConversationTurnResult(candidate: unknown): string {
  const parsed = conversationTurnResultSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ConversationSemanticReviewValidationError(
      'Hash input must be a validated conversation turn result',
    );
  }
  return canonicalJsonSha256(parsed.data);
}

const codebookEntrySchema = z
  .object({
    code: z.number().int().positive(),
    metricId: z.string().min(1),
    name: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/u),
  })
  .strict();
const codebookSchema = z
  .object({
    version: z.string(),
    codes: z.array(codebookEntrySchema).min(1),
  })
  .strict();

function loadPinnedCodebook(): ReadonlyMap<SemanticReviewMetricId, ReadonlySet<number>> {
  const parsed = codebookSchema.safeParse(semanticReviewCodebookJson);
  if (!parsed.success) throw new Error('Semantic review codebook is invalid');
  if (parsed.data.version !== SEMANTIC_REVIEW_CODEBOOK_VERSION) {
    throw new Error('Semantic review codebook version drifted');
  }
  if (canonicalJsonSha256(semanticReviewCodebookJson) !== SEMANTIC_REVIEW_CODEBOOK_HASH) {
    throw new Error('Semantic review codebook hash drifted');
  }

  const semanticMetricIds = new Set<string>(SEMANTIC_REVIEW_REQUIRED_METRICS);
  const seenCodes = new Set<number>();
  const codesByMetric = new Map<SemanticReviewMetricId, Set<number>>();
  for (const entry of parsed.data.codes) {
    if (!semanticMetricIds.has(entry.metricId) || seenCodes.has(entry.code)) {
      throw new Error('Semantic review codebook contains an invalid metric or duplicate code');
    }
    seenCodes.add(entry.code);
    const metricId = entry.metricId as SemanticReviewMetricId;
    const metricCodes = codesByMetric.get(metricId) ?? new Set<number>();
    metricCodes.add(entry.code);
    codesByMetric.set(metricId, metricCodes);
  }
  if (SEMANTIC_REVIEW_REQUIRED_METRICS.some((metricId) => !codesByMetric.has(metricId))) {
    throw new Error('Semantic review codebook does not cover every semantic metric');
  }
  return codesByMetric;
}

const CODEBOOK_CODES_BY_METRIC = loadPinnedCodebook();

const metricResultInputSchema = z
  .object({
    metricId: z.string().min(1).max(128),
    passed: z.boolean(),
    failureCodes: z.array(z.number().int().positive()).max(16),
  })
  .strict();
const reviewItemInputSchema = z
  .object({
    scenarioId: z.string().regex(OPAQUE_ID_PATTERN),
    turnId: z.string().regex(OPAQUE_ID_PATTERN),
    outputHash: z.string().regex(HASH_PATTERN),
    reviewerKind: z.literal('llm_automated'),
    reviewerModel: z.string().regex(MODEL_ID_PATTERN),
    codebookVersion: z.literal(SEMANTIC_REVIEW_CODEBOOK_VERSION),
    codebookHash: z.literal(SEMANTIC_REVIEW_CODEBOOK_HASH),
    metricResults: z.array(metricResultInputSchema).max(SEMANTIC_REVIEW_REQUIRED_METRICS.length),
    hashEcho: z.string().regex(HASH_PATTERN),
  })
  .strict();

function expectedSemanticMetrics(
  applicableMetrics: readonly ConversationMetricId[],
): readonly SemanticReviewMetricId[] {
  const applicable = new Set<ConversationMetricId>(applicableMetrics);
  return SEMANTIC_REVIEW_REQUIRED_METRICS.filter((metricId) => applicable.has(metricId));
}

function validateMetricCoverage(
  metricResults: readonly { readonly metricId: string }[],
  expectedMetrics: readonly SemanticReviewMetricId[],
): void {
  const actualIds = metricResults.map(({ metricId }) => metricId);
  const actual = new Set(actualIds);
  if (
    actual.size !== actualIds.length ||
    actual.size !== expectedMetrics.length ||
    expectedMetrics.some((metricId) => !actual.has(metricId))
  ) {
    throw new ConversationSemanticReviewValidationError(
      'Semantic review metric coverage does not exactly match the applicable subset',
    );
  }
}

function validateFailureCodes(
  metricResults: readonly {
    readonly metricId: string;
    readonly passed: boolean;
    readonly failureCodes: readonly number[];
  }[],
): void {
  for (const result of metricResults) {
    const allowedCodes = CODEBOOK_CODES_BY_METRIC.get(result.metricId as SemanticReviewMetricId);
    const uniqueCodes = new Set(result.failureCodes);
    const validPassCodes = result.passed && result.failureCodes.length === 0;
    const validFailureCodes =
      !result.passed &&
      result.failureCodes.length > 0 &&
      uniqueCodes.size === result.failureCodes.length &&
      allowedCodes !== undefined &&
      result.failureCodes.every((code) => allowedCodes.has(code));
    if (!validPassCodes && !validFailureCodes) {
      throw new ConversationSemanticReviewValidationError(
        'Semantic review failure codes do not match the committed codebook',
      );
    }
  }
}

/**
 * Accept a semantic review only when it is exact, codebook-pinned, and bound to
 * the canonical hash of the supplied validated model output.
 */
export function validateConversationSemanticReviewItem(
  candidate: unknown,
  context: ConversationSemanticReviewContext,
): AcceptedConversationSemanticReview {
  const parsed = reviewItemInputSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ConversationSemanticReviewValidationError(
      'Invalid semantic review item or failure code representation',
    );
  }
  const item = parsed.data;
  if (item.scenarioId !== context.scenarioId || item.turnId !== context.turnId) {
    throw new ConversationSemanticReviewValidationError(
      'Semantic review identifiers do not match the requested turn',
    );
  }

  const outputHash = hashConversationTurnResult(context.turnResult);
  if (item.outputHash !== outputHash || item.hashEcho !== outputHash) {
    throw new ConversationSemanticReviewValidationError(
      'Semantic review hash does not match the validated turn output',
    );
  }

  const expectedMetrics = expectedSemanticMetrics(context.applicableMetrics);
  validateMetricCoverage(item.metricResults, expectedMetrics);
  validateFailureCodes(item.metricResults);

  const metricResults = Object.freeze(
    item.metricResults.map((result) =>
      Object.freeze({
        metricId: result.metricId as SemanticReviewMetricId,
        passed: result.passed,
        failureCodes: Object.freeze([...result.failureCodes]),
      }),
    ),
  );
  return Object.freeze({ ...item, metricResults }) as AcceptedConversationSemanticReview;
}

/** Merge without mutation; a false signal from either scorer always wins. */
export function mergeConversationSemanticScores(
  mechanicalScores: ConversationTurnScores,
  semanticReview: AcceptedConversationSemanticReview,
): ConversationTurnScores {
  return semanticReview.metricResults.reduce<ConversationTurnScores>(
    (scores, result) => ({
      ...scores,
      [result.metricId]: scores[result.metricId] !== false && result.passed,
    }),
    { ...mechanicalScores },
  );
}
