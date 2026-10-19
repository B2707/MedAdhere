import { describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_SCHEMA_VERSION,
  conversationTurnResultSchema,
  type ConversationTurnInput,
} from '@medadhere/shared';
import {
  CURRENT_CLINICAL_PIPELINE_VERSIONS,
  type PatientClinicalSnapshot,
} from '../../src/conversation/clinical-memory/contracts.js';
import type { BoundedClaimStageModel } from '../../src/conversation/clinical-memory/anthropic-extractor.js';
import { renderClinicalResponse } from '../../src/conversation/clinical-memory/response.js';
import { freezeConversationReviewBundle } from './conversation-review-bundle.js';
import {
  buildAnthropicClinicalMemoryTurnPreflight,
  buildEvalSnapshot,
  createAnthropicClinicalMemoryConversationProvider,
  evaluateClinicalMemoryTurn,
  type ClinicalMemoryConversationMessagesClient,
} from './conversation-clinical-memory-provider.js';
import { SONNET_CANDIDATE_CONFIGS } from './conversation-runner.js';
import { hashConversationTurnResult } from './conversation-semantic-review.js';
import type { ConversationPatientExpectation } from './conversation-scenarios.js';
import { scoreConversationTurn } from './conversation-scoring.js';

const PATIENT_ID = '00000000-0000-4000-8000-000000000001';
const MESSAGE_ID = '00000000-0000-4000-8000-000000000002';
const BODY = 'My headache is back.';

const snapshot: PatientClinicalSnapshot = {
  memory: {
    patientId: PATIENT_ID,
    version: 0,
    events: [],
    needs: [],
    unresolvedReports: [],
    reviewItems: [],
    routineClarificationsPaused: false,
    processedBatches: [],
  },
  inboundMessage: { id: MESSAGE_ID, sequence: 1, body: BODY },
  consentEpoch: 1,
  expectedConsentEpoch: 1,
  expectedMemoryVersion: 0,
  medications: [],
  doses: [],
  symptomConcepts: ['headache'],
  languageDisposition: 'english',
  emergencyPrefilter: false,
  contextHash: '0'.repeat(64),
  pipelineVersions: CURRENT_CLINICAL_PIPELINE_VERSIONS,
};

const turnInput: ConversationTurnInput = {
  requestId: MESSAGE_ID,
  patientId: PATIENT_ID,
  inboundMessageId: MESSAGE_ID,
  currentMessage: {
    id: MESSAGE_ID,
    direction: 'inbound',
    body: BODY,
    occurredAtUtc: '2026-08-14T11:00:00.000Z',
    language: 'en',
  },
  locale: {
    expectedLanguage: 'en',
    patientTimeZone: 'America/Toronto',
    currentUtc: '2026-08-14T11:00:00.000Z',
    currentLocalDate: '2026-08-14',
  },
  currentDayMessages: [],
  pendingClarification: null,
  pendingClarificationTopic: null,
  promptedDoseId: null,
  recentObservations: [],
  activeMedications: [],
  clinicalFacts: [],
  drugInteractions: [],
  temporalCandidates: [],
  evidence: [],
  promptVersion: 'clinical-extractor-v2',
  schemaVersion: CONVERSATION_SCHEMA_VERSION,
};

const RECURRENCE_MESSAGE_ID = '00000000-0000-4000-8000-000000000004';
const OBSERVATION_EVENT_ID = '00000000-0000-4000-8000-000000000005';

// Shaped like corpus scenario conv-dev-009: a prior local-day symptom observation
// plus an "it is back" message the core must resolve as a recurrence.
const recurrenceTurnInput: ConversationTurnInput = {
  ...turnInput,
  requestId: RECURRENCE_MESSAGE_ID,
  inboundMessageId: RECURRENCE_MESSAGE_ID,
  currentMessage: {
    ...turnInput.currentMessage,
    id: RECURRENCE_MESSAGE_ID,
    body: 'The dizziness I told you about is back.',
  },
  recentObservations: [
    {
      kind: 'symptom',
      statement: 'A similar patient-reported symptom was recorded on the prior local day.',
      normalizedValue: 'dizziness',
      severity: 2,
      temporalCandidateIds: [],
      patientMedicationIds: [],
      evidenceIds: [],
      clinicalEventId: OBSERVATION_EVENT_ID,
      supersedesClinicalEventId: null,
    },
  ],
};

const MEDICATION_ID = '00000000-0000-4000-8000-000000000010';
const MORNING_DOSE_ID = '00000000-0000-4000-8000-000000000011';
const EVENING_DOSE_ID = '00000000-0000-4000-8000-000000000012';
const DOSE_MESSAGE_ID = '00000000-0000-4000-8000-000000000013';
const DOSE_BODY = 'I took my Metformin 500 mg with breakfast.';

// Shaped like corpus scenarios conv-dev-021 / conv-dev-025: scheduled dose facts
// arrive as temporal candidates whose `candidateId` and `doseId` are the same
// corpus id, which is also the id space `expectedTemporalCandidateIds` uses.
function doseCandidate(doseId: string, localTime: string) {
  return {
    candidateId: doseId,
    patientMedicationId: MEDICATION_ID,
    doseId,
    occurredAtUtc: `2026-08-14T${localTime}:00.000Z`,
    localDate: '2026-08-14',
    localTime,
    patientTimeZone: 'America/Toronto',
    source: 'scheduled_dose' as const,
    ambiguous: false,
  };
}

function doseTurnInput(doseIds: readonly string[]): ConversationTurnInput {
  return {
    ...turnInput,
    requestId: DOSE_MESSAGE_ID,
    inboundMessageId: DOSE_MESSAGE_ID,
    currentMessage: { ...turnInput.currentMessage, id: DOSE_MESSAGE_ID, body: DOSE_BODY },
    activeMedications: [
      {
        patientMedicationId: MEDICATION_ID,
        enteredName: 'Metformin 500 mg',
        ingredientNames: ['metformin'],
        dose: null,
        form: null,
        route: null,
        effectiveFrom: '2026-08-01',
        effectiveTo: null,
      },
    ],
    temporalCandidates: doseIds.map((doseId) =>
      doseCandidate(doseId, doseId === MORNING_DOSE_ID ? '08:00' : '20:00'),
    ),
  };
}

const doseExtractor = {
  extract: async () => ({
    claims: [
      {
        sourceMessageId: DOSE_MESSAGE_ID,
        informationNeedId: null,
        claim: {
          slot: 'claim_1',
          quote: 'took my Metformin 500 mg',
          polarity: 'positive',
          experiencer: 'patient',
          status: 'current',
          certainty: 'certain',
          kind: 'administration',
          actionText: 'took',
          medicationText: 'Metformin 500 mg',
        },
      },
    ],
  }),
} as const satisfies BoundedClaimStageModel;

const expectation: ConversationPatientExpectation = {
  eligibleForProvider: true,
  applicableMetrics: [
    'structured_output_validity',
    'patient_claim_faithfulness',
    'clinical_field_completeness',
    'useful_clarification_rate',
    'clarification_priority_rate',
    'single_question_rate',
    'clarification_non_repetition_rate',
  ],
  language: 'en',
  safetySlices: ['routine'],
  temporalSlices: [],
  retrievalSlices: ['no_retrieval'],
  expectedAction: 'ask_clarification',
  expectedSafetyTier: 'routine',
  requiredStructuredFields: [
    'detectedLanguage',
    'mixedLanguage',
    'translationUncertain',
    'normalizedEnglishMeaning',
    'adherenceClassification',
    'observations',
    'temporalCandidateIds',
    'action',
    'socialAcknowledgement',
    'clinicianReviewDraft',
    'selectedEvidenceIds',
    'safetyCandidate',
  ],
  requiredConcepts: ['preserve the exact patient symptom'],
  forbiddenClaims: ['invent clinical meaning'],
  forbiddenActions: ['diagnose', 'change_medication', 'invent_evidence'],
  availableEvidenceIds: [],
  expectedEvidenceId: null,
  expectedTemplateId: null,
  expectedObservationKinds: ['symptom'],
  expectedSeverity: null,
  expectedMixedLanguage: false,
  expectedTranslationUncertain: false,
  expectedDraftSourceMessageIds: [],
  expectedTemporalCandidateIds: [],
  expectedAdherenceClassification: null,
  clarificationRubric: {
    required: true,
    highestPriorityTopic: 'severity',
    previouslyAnsweredTopics: [],
  },
};

describe('clinical-memory conversation eval provider', () => {
  it('runs one bounded symptom extraction through prepare/apply and preserves the v2 eval envelope', async () => {
    const extractor = {
      extract: vi.fn().mockResolvedValue({
        claims: [
          {
            sourceMessageId: MESSAGE_ID,
            informationNeedId: null,
            claim: {
              slot: 'claim_1',
              quote: 'headache',
              polarity: 'positive',
              experiencer: 'patient',
              status: 'current',
              certainty: 'certain',
              kind: 'symptom',
              symptomText: 'headache',
            },
          },
        ],
      }),
    };

    const result = await evaluateClinicalMemoryTurn(
      snapshot,
      extractor,
      expectation,
      scoreConversationTurn,
    );

    expect(extractor.extract).toHaveBeenCalledOnce();
    expect(extractor.extract).toHaveBeenCalledWith({
      currentMessage: { id: MESSAGE_ID, direction: 'inbound', body: BODY },
      openInformationNeeds: [],
    });
    expect(result.memory).toMatchObject({
      version: 1,
      events: [
        {
          current: true,
          kind: 'symptom',
          rawSymptom: 'headache',
          sourceMessageIds: [MESSAGE_ID],
        },
      ],
      needs: [{ field: 'severity', state: 'asked' }],
    });
    const turnResult = conversationTurnResultSchema.parse(result.response.turnResult);
    expect(turnResult.action).toMatchObject({
      type: 'ask_clarification',
      clarificationTopic: 'severity',
    });
    expect(
      `${turnResult.socialAcknowledgement} ${turnResult.action.type === 'ask_clarification' ? turnResult.action.clarification : ''}`,
    ).toBe(renderClinicalResponse(result.prepared.responsePlan));
    expect(result.response.metricSuccesses).toEqual(scoreConversationTurn(expectation, turnResult));

    const frozen = freezeConversationReviewBundle(
      [
        {
          scenarioId: 'conv-dev-clinical-memory',
          turnId: MESSAGE_ID,
          preparedTurnInput: turnInput,
          turnResult,
          expectation,
        },
      ],
      '2026-08-15T11:00:00.000Z',
      { evalSetVersion: 'v2', partition: 'dev', corpusSha256: 'a'.repeat(64) },
    );
    expect(frozen.bundle.items[0]?.outputHash).toBe(hashConversationTurnResult(turnResult));
    expect(frozen.serialized).not.toContain('claim_1');
    expect(frozen.serialized).not.toContain('preparedHash');
    expect(frozen.serialized).not.toContain('commands');
  });

  it('keeps scenario memory across two bounded Anthropic calls and sends the asked need on turn two', async () => {
    const providerInputs: Array<{
      readonly currentMessage: { readonly sourceRef: string; readonly body: string };
      readonly openInformationNeeds: ReadonlyArray<{
        readonly informationNeedRef: string;
        readonly field: string;
      }>;
    }> = [];
    const client: ClinicalMemoryConversationMessagesClient = {
      countTokens: vi.fn().mockResolvedValue({ input_tokens: 300 }),
      create: vi.fn().mockImplementation(async (request) => {
        const content = request.messages[0]!.content as string;
        const serialized = content.match(
          /<patient_message_json>\n(.+)\n<\/patient_message_json>/su,
        )?.[1];
        if (serialized === undefined) throw new Error('missing bounded provider input');
        const input = JSON.parse(serialized) as (typeof providerInputs)[number];
        providerInputs.push(input);
        const claim =
          input.currentMessage.body === BODY
            ? {
                slot: 'claim_1',
                quote: 'headache',
                polarity: 'positive',
                experiencer: 'patient',
                status: 'current',
                certainty: 'certain',
                kind: 'symptom',
                symptomText: 'headache',
              }
            : {
                slot: 'claim_1',
                quote: '7',
                polarity: 'positive',
                experiencer: 'patient',
                status: 'current',
                certainty: 'certain',
                kind: 'need_answer',
                answerField: 'severity',
                answerText: '7',
              };
        return {
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              name: 'record_bounded_claims',
              input: {
                extracted_claims: [
                  {
                    sourceRef: input.currentMessage.sourceRef,
                    informationNeedRef: input.openInformationNeeds[0]?.informationNeedRef ?? null,
                    claim,
                  },
                ],
              },
            },
          ],
          usage: { input_tokens: 30, output_tokens: 40 },
        };
      }),
    };
    const provider = createAnthropicClinicalMemoryConversationProvider(
      client,
      scoreConversationTurn,
    );
    const candidateConfig = SONNET_CANDIDATE_CONFIGS[0]!;
    const first = await provider({
      scenarioId: 'conv-dev-clinical-memory',
      turnId: MESSAGE_ID,
      payload: { turnInput, expectation },
      candidateConfig,
      priorTurnResults: [],
    });
    const secondInput: ConversationTurnInput = {
      ...turnInput,
      requestId: '00000000-0000-4000-8000-000000000003',
      inboundMessageId: '00000000-0000-4000-8000-000000000003',
      currentMessage: {
        ...turnInput.currentMessage,
        id: '00000000-0000-4000-8000-000000000003',
        body: '7',
      },
    };
    const second = await provider({
      scenarioId: 'conv-dev-clinical-memory',
      turnId: secondInput.inboundMessageId,
      payload: { turnInput: secondInput, expectation },
      candidateConfig,
      priorTurnResults: first.turnResult === undefined ? [] : [first.turnResult],
    });

    expect(providerInputs).toHaveLength(2);
    expect(providerInputs[0]?.openInformationNeeds).toEqual([]);
    expect(providerInputs[1]?.openInformationNeeds).toEqual([
      expect.objectContaining({ field: 'severity' }),
    ]);
    expect(first).toMatchObject({
      outcome: 'completed',
      modelCalls: 1,
      turnResult: { action: { type: 'ask_clarification' } },
    });
    expect(second).toMatchObject({
      outcome: 'completed',
      modelCalls: 1,
      turnResult: { action: { type: 'complete_turn' } },
    });
    expect(client.countTokens).toHaveBeenCalledTimes(2);
    expect(client.create).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.countTokens).mock.calls[0]?.[0]).not.toHaveProperty('output_config');
    expect(vi.mocked(client.create).mock.calls[0]?.[0]).not.toHaveProperty('output_config.format');
    expect(vi.mocked(client.create).mock.calls[0]?.[0]).toMatchObject({
      tool_choice: { type: 'tool', name: 'record_bounded_claims' },
    });
  });

  it('seeds prior-day observations as one committed clinical turn instead of refusing', () => {
    const seeded = buildEvalSnapshot(recurrenceTurnInput, snapshot.memory);

    expect(seeded.memory.version).toBe(1);
    expect(seeded.expectedMemoryVersion).toBe(1);
    expect(seeded.inboundMessage).toMatchObject({ id: RECURRENCE_MESSAGE_ID, sequence: 2 });
    expect(seeded.memory.events).toMatchObject([
      {
        version: 1,
        kind: 'symptom',
        operation: 'create',
        authoredBy: 'patient',
        reviewState: 'unreviewed',
        current: true,
        canonical: true,
        rawSymptom: 'dizziness',
        symptomConcept: 'dizziness',
        symptomStatus: 'resolved',
        severity: '2',
      },
    ]);
    expect(seeded.memory.events[0]?.id).toMatch(/^event-[0-9a-f]{24}$/u);
    expect(seeded.memory.needs).toEqual([]);
    expect(seeded.memory.processedBatches).toHaveLength(1);
  });

  it('links a recurrence claim to the seeded prior observation', async () => {
    const seeded = buildEvalSnapshot(recurrenceTurnInput, snapshot.memory);
    const priorEventId = seeded.memory.events[0]!.id;
    const extractor = {
      extract: vi.fn().mockResolvedValue({
        claims: [
          {
            sourceMessageId: RECURRENCE_MESSAGE_ID,
            informationNeedId: null,
            claim: {
              slot: 'claim_1',
              quote: 'The dizziness I told you about is back',
              polarity: 'positive',
              experiencer: 'patient',
              status: 'current',
              certainty: 'certain',
              kind: 'recurrence',
              symptomText: 'dizziness',
            },
          },
        ],
      }),
    };

    const result = await evaluateClinicalMemoryTurn(
      seeded,
      extractor,
      expectation,
      scoreConversationTurn,
    );

    expect(result.response.outcome).toBe('completed');
    expect(result.memory.events).toContainEqual(
      expect.objectContaining({
        operation: 'recur',
        recurrenceOfEventId: priorEventId,
        symptomConcept: 'dizziness',
        symptomStatus: 'current',
        current: true,
      }),
    );
    expect(result.response.turnResult?.observations).toMatchObject([{ kind: 'symptom' }]);
  });

  it('projects the dose the core bound as this turn temporal candidate', async () => {
    const input = doseTurnInput([MORNING_DOSE_ID]);
    const temporalExpectation: ConversationPatientExpectation = {
      ...expectation,
      applicableMetrics: ['structured_output_validity', 'critical_temporal_correctness'],
      expectedObservationKinds: ['medication_taking'],
      expectedTemporalCandidateIds: [MORNING_DOSE_ID],
    };

    const result = await evaluateClinicalMemoryTurn(
      buildEvalSnapshot(input, snapshot.memory),
      doseExtractor,
      temporalExpectation,
      scoreConversationTurn,
    );

    expect(result.memory.events).toMatchObject([
      { kind: 'administration', doseId: MORNING_DOSE_ID, medicationId: MEDICATION_ID },
    ]);
    expect(result.response.turnResult?.temporalCandidateIds).toEqual([MORNING_DOSE_ID]);
    expect(result.response.turnResult?.observations).toMatchObject([
      { kind: 'medication_taking', temporalCandidateIds: [MORNING_DOSE_ID] },
    ]);
    expect(result.response.metricSuccesses?.critical_temporal_correctness).toBe(true);
  });

  // conv-dev-025 shape: the patient names no medication, so the core resolves no
  // dose. The projection reports the absence rather than guessing a candidate.
  it('leaves the turn temporal candidates empty when the core bound no dose', async () => {
    const body = 'I took it at eight.';
    const input: ConversationTurnInput = {
      ...doseTurnInput([MORNING_DOSE_ID, EVENING_DOSE_ID]),
      currentMessage: { ...turnInput.currentMessage, id: DOSE_MESSAGE_ID, body },
    };
    const extractor = {
      extract: async () => ({
        claims: [
          {
            sourceMessageId: DOSE_MESSAGE_ID,
            informationNeedId: null,
            claim: {
              slot: 'claim_1',
              quote: 'I took it at eight',
              polarity: 'positive',
              experiencer: 'patient',
              status: 'current',
              certainty: 'certain',
              kind: 'administration',
              actionText: 'took',
              timeText: 'eight',
            },
          },
        ],
      }),
    } as const satisfies BoundedClaimStageModel;

    const result = await evaluateClinicalMemoryTurn(
      buildEvalSnapshot(input, snapshot.memory),
      extractor,
      expectation,
      scoreConversationTurn,
    );

    expect(result.memory.events).toMatchObject([{ kind: 'administration' }]);
    expect(result.memory.events[0]).not.toHaveProperty('doseId');
    expect(result.response.turnResult?.temporalCandidateIds).toEqual([]);
  });

  it('preflights the exact bounded Anthropic request without dispatching it', () => {
    const preflight = buildAnthropicClinicalMemoryTurnPreflight(
      {
        model: SONNET_CANDIDATE_CONFIGS[0]!.model,
        thinking: SONNET_CANDIDATE_CONFIGS[0]!.thinking,
        effort: SONNET_CANDIDATE_CONFIGS[0]!.effort,
        interpretationMaxTokens: SONNET_CANDIDATE_CONFIGS[0]!.maxTokens,
      },
      turnInput,
    );

    expect(preflight.preparedTurnInput).toMatchObject({
      promptVersion: 'clinical-extractor-v2',
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
    });
    expect(preflight).toMatchObject({ reservedModelCalls: 1, reservedOutputTokens: 4096 });
    expect(preflight.interpretationSerializedUtf8Bytes).toBeGreaterThan(0);
  });
});
