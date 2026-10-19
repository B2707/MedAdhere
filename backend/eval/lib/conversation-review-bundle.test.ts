import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationTurnResult } from '@medadhere/shared';
import { buildConversationRunnerScenarios } from './conversation-input.js';
import {
  cleanupExpiredConversationReviewBundles,
  freezeConversationReviewBundle,
  writeConversationReviewBundle,
  type ConversationReviewCapture,
} from './conversation-review-bundle.js';
import { hashConversationTurnResult } from './conversation-semantic-review.js';
import { loadConversationScenarioCorpus } from './conversation-scenarios.js';
import { SEMANTIC_REVIEW_REQUIRED_METRICS } from './conversation-scoring.js';

const temporaryDirectories: string[] = [];
const EXPIRES_AT_UTC = '2026-08-10T20:00:00.000Z';
const DEV_V2_PROVENANCE = {
  evalSetVersion: 'v2',
  partition: 'dev',
  corpusSha256: 'afdfbff857e8452e0c80f65a9c73fa936579cf43777d292027f5309848be798a',
} as const;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function turnResult(sourceMessageId: string): ConversationTurnResult {
  return {
    detectedLanguage: 'en',
    languageConfidence: 0.99,
    mixedLanguage: false,
    translationUncertain: false,
    normalizedEnglishMeaning: 'The patient says they took the medication.',
    adherenceClassification: {
      adherence_state: 'taken',
      reason_code: 'none',
      safety_flag: 'none',
    },
    observations: [],
    temporalCandidateIds: [],
    action: { type: 'complete_turn' },
    socialAcknowledgement: 'Thanks for letting me know.',
    clinicalClaim: null,
    clinicianReviewDraft: {
      patientStatements: [{ sourceMessageId, text: 'Synthetic patient statement.' }],
      establishedFactIds: [],
      inferences: [],
      uncertainties: [],
      evidenceIds: [],
      proposedCorrections: [],
    },
    selectedEvidenceIds: [],
    safetyCandidate: 'routine',
  };
}

function capture(): ConversationReviewCapture {
  const corpus = loadConversationScenarioCorpus();
  const scenario = buildConversationRunnerScenarios(corpus.dev.scenarios.slice(0, 1))[0]!;
  const turn = scenario.turns.find(({ eligibleForProvider }) => eligibleForProvider)!;
  return {
    scenarioId: scenario.scenarioId,
    turnId: turn.turnId,
    preparedTurnInput: turn.payload.turnInput,
    turnResult: turnResult(turn.payload.turnInput.currentMessage.id),
    expectation: turn.payload.expectation,
  };
}

describe('conversation review bundle', () => {
  it('freezes exact inputs, outputs, hashes, and ordered semantic metric IDs without review results', () => {
    const base = capture();
    const frozen = freezeConversationReviewBundle([base], EXPIRES_AT_UTC, DEV_V2_PROVENANCE);

    expect(frozen.bundle.items[0]).toMatchObject({
      scenarioId: base.scenarioId,
      turnId: base.turnId,
      preparedTurnInput: base.preparedTurnInput,
      turnResult: base.turnResult,
      outputHash: hashConversationTurnResult(base.turnResult),
      semanticMetricIds: SEMANTIC_REVIEW_REQUIRED_METRICS.filter((metricId) =>
        base.expectation.applicableMetrics.includes(metricId),
      ),
    });
    expect(frozen.bundle).toMatchObject({
      schemaVersion: 2,
      evalSetVersion: 'v2',
      partition: 'dev',
      corpusSha256: 'afdfbff857e8452e0c80f65a9c73fa936579cf43777d292027f5309848be798a',
    });
    expect(Object.isFrozen(frozen.bundle.items[0]?.semanticMetricIds)).toBe(true);
    expect(frozen.serialized).not.toContain('reviewerModel');
    expect(frozen.serialized).not.toContain('metricResults');
    expect(frozen.serialized).not.toContain('hashEcho');
  });

  it('rejects duplicate turns and invalid expirations', () => {
    const base = capture();

    expect(() =>
      freezeConversationReviewBundle([base, base], EXPIRES_AT_UTC, DEV_V2_PROVENANCE),
    ).toThrow(/duplicate conversation review turn/iu);
    expect(() => freezeConversationReviewBundle([base], 'not-a-date', DEV_V2_PROVENANCE)).toThrow(
      /invalid conversation review bundle expiration/iu,
    );
    expect(() =>
      freezeConversationReviewBundle([base], EXPIRES_AT_UTC, {
        ...DEV_V2_PROVENANCE,
        corpusSha256: 'not-a-hash',
      }),
    ).toThrow(/invalid conversation review bundle provenance/iu);
  });

  it('rejects mixed prompt versions before Phoenix can label the bundle', () => {
    const base = capture();
    const mixedPrompt = {
      ...base,
      scenarioId: 'conv-dev-002',
      turnId: '00000000-0000-4000-8000-000000000099',
      preparedTurnInput: {
        ...base.preparedTurnInput,
        promptVersion: 'conversation-other',
      },
    };

    expect(() =>
      freezeConversationReviewBundle([base, mixedPrompt], EXPIRES_AT_UTC, DEV_V2_PROVENANCE),
    ).toThrow(/mixed prompt versions/iu);
  });

  it('writes one path-safe mode-0600 bundle and leaves it for manual review', () => {
    const directory = mkdtempSync(join(tmpdir(), 'medadhere-conversation-review-'));
    temporaryDirectories.push(directory);
    const frozen = freezeConversationReviewBundle([capture()], EXPIRES_AT_UTC, DEV_V2_PROVENANCE);

    const path = writeConversationReviewBundle(
      directory,
      '00000000-0000-4000-8000-000000000099',
      frozen,
    );

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe(`${frozen.serialized}\n`);
    expect(path).toContain('conversation-review-');
    expect(() => writeConversationReviewBundle(directory, '../escape', frozen)).toThrow(
      /invalid conversation review run ID/iu,
    );
  });

  it('deletes only expired generic bundles during preflight cleanup', () => {
    const directory = mkdtempSync(join(tmpdir(), 'medadhere-review-cleanup-'));
    temporaryDirectories.push(directory);
    const expiredPath = writeConversationReviewBundle(
      directory,
      'expired',
      freezeConversationReviewBundle([capture()], '2026-08-09T19:59:59.999Z', DEV_V2_PROVENANCE),
    );
    const currentPath = writeConversationReviewBundle(
      directory,
      'current',
      freezeConversationReviewBundle([capture()], EXPIRES_AT_UTC, DEV_V2_PROVENANCE),
    );

    cleanupExpiredConversationReviewBundles(directory, new Date('2026-08-09T20:00:00.000Z'));

    expect(existsSync(expiredPath)).toBe(false);
    expect(existsSync(currentPath)).toBe(true);
  });
});
