import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  conversationTurnInputSchema,
  conversationTurnResultSchema,
  type ConversationTurnInput,
  type ConversationTurnResult,
} from '@medadhere/shared';
import {
  hashConversationTurnResult,
  type SemanticReviewMetricId,
} from './conversation-semantic-review.js';
import type { ConversationPatientExpectation } from './conversation-scenarios.js';
import { SEMANTIC_REVIEW_REQUIRED_METRICS } from './conversation-scoring.js';

export const CONVERSATION_REVIEW_BUNDLE_TTL_MS = 24 * 60 * 60 * 1_000;

export interface ConversationReviewCapture {
  readonly scenarioId: string;
  readonly turnId: string;
  readonly preparedTurnInput: ConversationTurnInput;
  readonly turnResult: ConversationTurnResult;
  readonly expectation: ConversationPatientExpectation;
}

export interface ConversationReviewBundleItem extends ConversationReviewCapture {
  readonly outputHash: string;
  readonly semanticMetricIds: readonly SemanticReviewMetricId[];
}

export interface ConversationReviewBundle {
  readonly schemaVersion: 2;
  readonly evalSetVersion: string;
  readonly partition: 'dev' | 'holdout';
  readonly corpusSha256: string;
  readonly expiresAtUtc: string;
  readonly items: readonly ConversationReviewBundleItem[];
}

export type ConversationReviewBundleProvenance = Pick<
  ConversationReviewBundle,
  'evalSetVersion' | 'partition' | 'corpusSha256'
>;

export interface FrozenConversationReviewBundle {
  readonly bundle: ConversationReviewBundle;
  readonly serialized: string;
}

export class ConversationReviewBundleError extends Error {
  override readonly name = 'ConversationReviewBundleError';
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function semanticMetricIds(
  expectation: ConversationPatientExpectation,
): readonly SemanticReviewMetricId[] {
  return SEMANTIC_REVIEW_REQUIRED_METRICS.filter((metricId) =>
    expectation.applicableMetrics.includes(metricId),
  );
}

export function freezeConversationReviewBundle(
  captures: readonly ConversationReviewCapture[],
  expiresAtUtc: string,
  provenance: ConversationReviewBundleProvenance,
): FrozenConversationReviewBundle {
  const expiresAt = new Date(expiresAtUtc);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.toISOString() !== expiresAtUtc) {
    throw new ConversationReviewBundleError('invalid conversation review bundle expiration');
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(provenance.evalSetVersion) ||
    !/^[a-f0-9]{64}$/u.test(provenance.corpusSha256)
  ) {
    throw new ConversationReviewBundleError('invalid conversation review bundle provenance');
  }
  const keys = new Set<string>();
  let promptVersion: string | undefined;
  const items = captures.map((capture) => {
    const key = `${capture.scenarioId}:${capture.turnId}`;
    if (keys.has(key))
      throw new ConversationReviewBundleError('duplicate conversation review turn');
    keys.add(key);
    const preparedTurnInput = conversationTurnInputSchema.parse(capture.preparedTurnInput);
    if (promptVersion !== undefined && preparedTurnInput.promptVersion !== promptVersion) {
      throw new ConversationReviewBundleError(
        'mixed prompt versions in conversation review bundle',
      );
    }
    promptVersion ??= preparedTurnInput.promptVersion;
    const turnResult = conversationTurnResultSchema.parse(capture.turnResult);
    return deepFreeze({
      scenarioId: capture.scenarioId,
      turnId: capture.turnId,
      preparedTurnInput,
      turnResult,
      expectation: structuredClone(capture.expectation),
      outputHash: hashConversationTurnResult(turnResult),
      semanticMetricIds: semanticMetricIds(capture.expectation),
    });
  });
  const bundle: ConversationReviewBundle = deepFreeze({
    schemaVersion: 2,
    ...provenance,
    expiresAtUtc,
    items,
  });
  return Object.freeze({ bundle, serialized: JSON.stringify(bundle) });
}

export function writeConversationReviewBundle(
  directory: string,
  runId: string,
  frozen: FrozenConversationReviewBundle,
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId)) {
    throw new ConversationReviewBundleError('invalid conversation review run ID');
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const finalPath = join(directory, `conversation-review-${runId}-${randomUUID()}.json`);
  const temporaryPath = `${finalPath}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, `${frozen.serialized}\n`, 'utf8');
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
      // Never mask the original bundle-write failure.
    }
    throw error;
  }
}

export function cleanupExpiredConversationReviewBundles(directory: string, now: Date): void {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new ConversationReviewBundleError('invalid conversation review cleanup time');
  }
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !entry.name.startsWith('conversation-review-') ||
      !entry.name.endsWith('.json')
    ) {
      continue;
    }
    const path = join(directory, entry.name);
    const document = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const expiresAtUtc =
      typeof document === 'object' && document !== null && !Array.isArray(document)
        ? (document as Readonly<Record<string, unknown>>).expiresAtUtc
        : undefined;
    let expiresAtMs: number;
    if (expiresAtUtc === undefined) {
      expiresAtMs = statSync(path).mtimeMs + CONVERSATION_REVIEW_BUNDLE_TTL_MS;
    } else {
      if (typeof expiresAtUtc !== 'string') {
        throw new ConversationReviewBundleError('invalid conversation review bundle expiration');
      }
      const expiresAt = new Date(expiresAtUtc);
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt.toISOString() !== expiresAtUtc) {
        throw new ConversationReviewBundleError('invalid conversation review bundle expiration');
      }
      expiresAtMs = expiresAt.getTime();
    }
    if (expiresAtMs <= nowMs) unlinkSync(path);
  }
}
