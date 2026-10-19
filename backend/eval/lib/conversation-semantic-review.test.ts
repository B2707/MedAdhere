import { describe, expect, it } from 'vitest';
import type { ConversationTurnResult } from '@medadhere/shared';
import type { ConversationMetricId } from './conversation-metrics.js';
import { CONVERSATION_OBSERVATION_DEFAULTS } from './conversation-observation-fixture.js';
import {
  SEMANTIC_REVIEW_CODEBOOK_HASH,
  SEMANTIC_REVIEW_CODEBOOK_VERSION,
  hashConversationTurnResult,
  mergeConversationSemanticScores,
  validateConversationSemanticReviewItem,
  type ConversationSemanticReviewItem,
} from './conversation-semantic-review.js';

const scenarioId = 'conv-dev-001';
const turnId = 'cdd6c9aa-30aa-40af-8990-99754af4ca30';

function turnResult(): ConversationTurnResult {
  return {
    detectedLanguage: 'en-CA',
    languageConfidence: 0.98,
    mixedLanguage: false,
    translationUncertain: false,
    normalizedEnglishMeaning: 'Synthetic normalized meaning.',
    adherenceClassification: {
      adherence_state: 'taken',
      reason_code: 'none',
      safety_flag: 'none',
    },
    observations: [
      {
        ...CONVERSATION_OBSERVATION_DEFAULTS,
        kind: 'medication_taking',
        statement: 'Synthetic observation.',
        normalizedValue: null,
        severity: null,
        temporalCandidateIds: [],
        patientMedicationIds: ['11111111-1111-4111-8111-111111111111'],
        evidenceIds: [],
      },
    ],
    temporalCandidateIds: [],
    action: { type: 'complete_turn' },
    socialAcknowledgement: 'Thanks for the update.',
    clinicalClaim: null,
    clinicianReviewDraft: {
      patientStatements: [{ sourceMessageId: turnId, text: 'Synthetic patient statement.' }],
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

const applicableMetrics: readonly ConversationMetricId[] = [
  'structured_output_validity',
  'patient_claim_faithfulness',
  'clinical_field_completeness',
  'unnecessary_question_rate',
];

function reviewCandidate(
  result: ConversationTurnResult,
  overrides: Partial<ConversationSemanticReviewItem> = {},
): ConversationSemanticReviewItem {
  const outputHash = hashConversationTurnResult(result);
  return {
    scenarioId,
    turnId,
    outputHash,
    reviewerKind: 'llm_automated',
    reviewerModel: 'semantic-reviewer-v1',
    codebookVersion: SEMANTIC_REVIEW_CODEBOOK_VERSION,
    codebookHash: SEMANTIC_REVIEW_CODEBOOK_HASH,
    metricResults: [
      {
        metricId: 'patient_claim_faithfulness',
        passed: true,
        failureCodes: [],
      },
      {
        metricId: 'clinical_field_completeness',
        passed: false,
        failureCodes: [5001],
      },
    ],
    hashEcho: outputHash,
    ...overrides,
  };
}

function validationContext(result: ConversationTurnResult) {
  return { scenarioId, turnId, turnResult: result, applicableMetrics } as const;
}

describe('hashConversationTurnResult', () => {
  it('returns a stable canonical UTF-8 SHA-256 independent of input key order', () => {
    const result = turnResult();
    const reordered = {
      safetyCandidate: result.safetyCandidate,
      selectedEvidenceIds: result.selectedEvidenceIds,
      clinicianReviewDraft: {
        proposedCorrections: result.clinicianReviewDraft.proposedCorrections,
        evidenceIds: result.clinicianReviewDraft.evidenceIds,
        uncertainties: result.clinicianReviewDraft.uncertainties,
        inferences: result.clinicianReviewDraft.inferences,
        establishedFactIds: result.clinicianReviewDraft.establishedFactIds,
        patientStatements: result.clinicianReviewDraft.patientStatements.map((statement) => ({
          text: statement.text,
          sourceMessageId: statement.sourceMessageId,
        })),
      },
      clinicalClaim: result.clinicalClaim,
      socialAcknowledgement: result.socialAcknowledgement,
      action: result.action,
      temporalCandidateIds: result.temporalCandidateIds,
      observations: result.observations.map((observation) => ({
        supersedesClinicalEventId: observation.supersedesClinicalEventId,
        clinicalEventId: observation.clinicalEventId,
        evidenceIds: observation.evidenceIds,
        patientMedicationIds: observation.patientMedicationIds,
        temporalCandidateIds: observation.temporalCandidateIds,
        severity: observation.severity,
        normalizedValue: observation.normalizedValue,
        statement: observation.statement,
        kind: observation.kind,
      })),
      adherenceClassification: result.adherenceClassification,
      normalizedEnglishMeaning: result.normalizedEnglishMeaning,
      translationUncertain: result.translationUncertain,
      mixedLanguage: result.mixedLanguage,
      languageConfidence: result.languageConfidence,
      detectedLanguage: result.detectedLanguage,
    };

    expect(hashConversationTurnResult(result)).toBe(
      'sha256:115d70c1c8169e100a2dc4d69dff4eb9b34c4bdf724f5873b33ad5fde79da42a',
    );
    expect(hashConversationTurnResult(reordered)).toBe(hashConversationTurnResult(result));
    expect(
      hashConversationTurnResult({
        ...result,
        observations: [{ ...result.observations[0]!, statement: 'Changed nested value.' }],
      }),
    ).not.toBe(hashConversationTurnResult(result));
  });

  it('rejects a result that does not satisfy the strict shared output contract', () => {
    expect(() =>
      hashConversationTurnResult({ ...turnResult(), unexpectedOutput: 'not allowed' }),
    ).toThrow(/validated conversation turn result/u);
  });
});

describe('validateConversationSemanticReviewItem', () => {
  it('accepts only the exact applicable semantic subset bound to the output hash', () => {
    const result = turnResult();
    const accepted = validateConversationSemanticReviewItem(
      reviewCandidate(result),
      validationContext(result),
    );

    expect(accepted.metricResults.map(({ metricId }) => metricId)).toEqual([
      'patient_claim_faithfulness',
      'clinical_field_completeness',
    ]);
    expect(accepted.outputHash).toBe(hashConversationTurnResult(result));
    expect(accepted.hashEcho).toBe(accepted.outputHash);
    expect(JSON.stringify(accepted)).not.toContain(result.normalizedEnglishMeaning);
    expect(JSON.stringify(accepted)).not.toContain(result.socialAcknowledgement);
  });

  it('pins the committed codebook version and canonical content hash', () => {
    expect(SEMANTIC_REVIEW_CODEBOOK_VERSION).toBe('semantic-review-codebook.v2');
    expect(SEMANTIC_REVIEW_CODEBOOK_HASH).toBe(
      'sha256:fb0bc2410511978279ce28c50d9e7f1b591195fa715c78dc37001425591a029c',
    );
  });

  it.each([
    ['scenario ID', { scenarioId: 'conv-dev-999' }],
    ['turn ID', { turnId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
    ['reviewer kind', { reviewerKind: 'human' }],
    ['reviewer model', { reviewerModel: '' }],
    ['codebook version', { codebookVersion: 'semantic-review-codebook.v1' }],
    ['codebook hash', { codebookHash: `sha256:${'0'.repeat(64)}` }],
    ['output hash', { outputHash: `sha256:${'1'.repeat(64)}` }],
    ['hash echo', { hashEcho: `sha256:${'2'.repeat(64)}` }],
  ] as const)('rejects a mismatched or invalid %s', (_label, override) => {
    const result = turnResult();
    expect(() =>
      validateConversationSemanticReviewItem(
        { ...reviewCandidate(result), ...override },
        validationContext(result),
      ),
    ).toThrow();
  });

  it('rejects missing, duplicate, nonsemantic, and extra metric IDs', () => {
    const result = turnResult();
    const valid = reviewCandidate(result);
    const cases: unknown[] = [
      { ...valid, metricResults: valid.metricResults.slice(0, 1) },
      { ...valid, metricResults: [valid.metricResults[0], valid.metricResults[0]] },
      {
        ...valid,
        metricResults: [
          ...valid.metricResults,
          { metricId: 'structured_output_validity', passed: true, failureCodes: [] },
        ],
      },
      {
        ...valid,
        metricResults: [
          ...valid.metricResults,
          { metricId: 'cross_doctor_isolation', passed: true, failureCodes: [] },
        ],
      },
    ];

    for (const candidate of cases) {
      expect(() =>
        validateConversationSemanticReviewItem(candidate, validationContext(result)),
      ).toThrow(/metric coverage/u);
    }
  });

  it('requires integer, unique, metric-specific codebook failures only on failed metrics', () => {
    const result = turnResult();
    const valid = reviewCandidate(result);
    const patientMetric = valid.metricResults[0]!;
    const clinicalMetric = valid.metricResults[1]!;
    const cases: unknown[] = [
      {
        ...valid,
        metricResults: [patientMetric, { ...clinicalMetric, failureCodes: [] }],
      },
      {
        ...valid,
        metricResults: [{ ...patientMetric, failureCodes: [2001] }, clinicalMetric],
      },
      {
        ...valid,
        metricResults: [patientMetric, { ...clinicalMetric, failureCodes: [2001] }],
      },
      {
        ...valid,
        metricResults: [patientMetric, { ...clinicalMetric, failureCodes: [5001, 5001] }],
      },
      {
        ...valid,
        metricResults: [patientMetric, { ...clinicalMetric, failureCodes: [5001.5] }],
      },
    ];

    for (const candidate of cases) {
      expect(() =>
        validateConversationSemanticReviewItem(candidate, validationContext(result)),
      ).toThrow(/failure code/u);
    }
  });

  it('rejects extra fields instead of persisting reviewer prose', () => {
    const result = turnResult();
    const valid = reviewCandidate(result);

    expect(() =>
      validateConversationSemanticReviewItem(
        { ...valid, rationale: 'raw reviewer prose' },
        validationContext(result),
      ),
    ).toThrow();
    expect(() =>
      validateConversationSemanticReviewItem(
        {
          ...valid,
          metricResults: [
            { ...valid.metricResults[0]!, rationale: 'raw reviewer prose' },
            valid.metricResults[1],
          ],
        },
        validationContext(result),
      ),
    ).toThrow();
  });
});

describe('mergeConversationSemanticScores', () => {
  it('adds accepted semantic results while preserving every mechanical false', () => {
    const result = turnResult();
    const accepted = validateConversationSemanticReviewItem(
      reviewCandidate(result),
      validationContext(result),
    );

    expect(
      mergeConversationSemanticScores(
        {
          structured_output_validity: true,
          patient_claim_faithfulness: false,
          clinical_field_completeness: true,
        },
        accepted,
      ),
    ).toEqual({
      structured_output_validity: true,
      patient_claim_faithfulness: false,
      clinical_field_completeness: false,
    });
  });

  it('does not mutate either input', () => {
    const result = turnResult();
    const mechanical = { structured_output_validity: true } as const;
    const accepted = validateConversationSemanticReviewItem(
      reviewCandidate(result),
      validationContext(result),
    );
    const mechanicalBefore = structuredClone(mechanical);
    const reviewBefore = structuredClone(accepted);

    mergeConversationSemanticScores(mechanical, accepted);

    expect(mechanical).toEqual(mechanicalBefore);
    expect(accepted).toEqual(reviewBefore);
  });
});
