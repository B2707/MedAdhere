import { describe, expect, it, vi } from 'vitest';
import type { ConversationTurnInput } from '@medadhere/shared';
import {
  CURRENT_CLINICAL_PIPELINE_VERSIONS,
  prepareClinicalFailureTurn as prepareClinicalFailureTurnCore,
  prepareClinicalTurn as prepareClinicalTurnCore,
  type ClinicalClaimInput,
  type ExtractedClaim,
  type PatientClinicalSnapshot,
  type PreparedClinicalTurn,
} from './clinical-memory/index.js';
import type { ConversationGatewayResponse } from './gateway-contract.js';
import { CONVERSATION_GATEWAY_CONFIG, MAX_CONTEXT_TOKENS } from './gateway-handler.js';
import {
  boundedClaimExtractionSchema,
  createBoundedClaimProviderBoundary,
  type BoundedClaimExtraction,
} from './clinical-memory/bounded-provider.js';
import {
  CLINICAL_EXTRACTOR_PROMPT_VERSION,
  CLINICAL_EXTRACTOR_SCHEMA_VERSION,
} from './clinical-memory/anthropic-extractor.js';
import {
  CONVERSATION_LAMBDA_CLIENT_CONFIG,
  ConversationStageFailure,
  createDurableBoundedClaimExtractor,
  invokeConversationGateway,
  processClinicalMemoryJobCore,
  type ClinicalMemoryOutbound,
  type ClinicalMemoryJobDependencies,
  type DurableStageDependencies,
  type ConversationLambdaInvokeOutput,
} from './turn-processor.js';

const INBOUND_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_ID = '00000000-0000-4000-8000-000000000003';
const AGENT_TURN_ID = '00000000-0000-4000-8000-000000000005';
const TURN_JOB_ID = '00000000-0000-4000-8000-000000000006';
const LEASE_ID = '00000000-0000-4000-8000-000000000007';

const input: ConversationTurnInput = {
  requestId: '00000000-0000-4000-8000-000000000002',
  patientId: PATIENT_ID,
  inboundMessageId: INBOUND_ID,
  currentMessage: {
    id: INBOUND_ID,
    direction: 'inbound',
    body: 'My headache is back.',
    occurredAtUtc: '2026-08-11T13:00:00.000Z',
    language: 'en',
  },
  locale: {
    expectedLanguage: 'en',
    patientTimeZone: 'America/Toronto',
    currentUtc: '2026-08-11T13:01:00.000Z',
    currentLocalDate: '2026-08-11',
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
  promptVersion: 'conversation-v45-single-stage',
  schemaVersion: 'conversation-v3',
};

const PREPARED_OUTBOUND = Object.freeze({
  outboundMessageId: '00000000-0000-4000-8000-000000000004',
  patientId: PATIENT_ID,
  agentTurnId: AGENT_TURN_ID,
  status: 'prepared',
  messagingConsentEpoch: 1,
});

const clinicalSnapshot: PatientClinicalSnapshot = {
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
  inboundMessage: { id: INBOUND_ID, sequence: 1, body: input.currentMessage.body },
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

const headacheClaim: ExtractedClaim = {
  slot: 'symptom-headache',
  kind: 'symptom',
  quote: 'headache',
  polarity: 'positive',
  experiencer: 'patient',
  status: 'current',
  certainty: 'certain',
  symptomText: 'headache',
};

const boundedClaims: BoundedClaimExtraction = {
  claims: [{ sourceMessageId: INBOUND_ID, informationNeedId: null, claim: headacheClaim }],
};

const boundedGatewayInput = {
  currentMessage: {
    id: INBOUND_ID,
    direction: 'inbound' as const,
    body: input.currentMessage.body,
  },
  openInformationNeeds: [],
  promptVersion: CLINICAL_EXTRACTOR_PROMPT_VERSION,
  schemaVersion: CLINICAL_EXTRACTOR_SCHEMA_VERSION,
};

const boundedProviderInput = {
  currentMessage: boundedGatewayInput.currentMessage,
  openInformationNeeds: boundedGatewayInput.openInformationNeeds,
};

function clinicalDependencies(
  overrides: Partial<ClinicalMemoryJobDependencies> = {},
): ClinicalMemoryJobDependencies {
  return {
    findFinalizedOutbound: vi.fn(async () => null),
    loadJob: vi.fn(async () => ({
      kind: 'ready' as const,
      turnJobId: TURN_JOB_ID,
      messagingStateVersion: 1,
      input,
      evidence: [],
    })),
    loadBoundedClaims: vi.fn(async () => boundedClaims),
    loadClinicalSnapshot: vi.fn(async () => clinicalSnapshot),
    prepareClinicalTurn: prepareClinicalTurnCore,
    prepareClinicalFailureTurn: prepareClinicalFailureTurnCore,
    commitPreparedClinicalTurn: vi.fn(async () => PREPARED_OUTBOUND),
    terminalizePreparedOutbound: vi.fn(async () => undefined),
    invokeOutbound: vi.fn(async () => undefined),
    hasNewerInbound: vi.fn(async () => false),
    ...overrides,
  };
}

describe('processClinicalMemoryJobCore — newer-inbound race backstop', () => {
  it('terminalizes an un-sent question reply when a newer inbound arrived instead of sending it', async () => {
    const replay = { ...PREPARED_OUTBOUND, responsePlanKind: 'question' };
    const deps = clinicalDependencies({
      findFinalizedOutbound: vi.fn(async () => replay),
      hasNewerInbound: vi.fn(async () => true),
    });
    await processClinicalMemoryJobCore(INBOUND_ID, deps);
    // The newer-inbound cause is recorded so ONLY burst-suppressed rows join batch coherence.
    expect(deps.terminalizePreparedOutbound).toHaveBeenCalledExactlyOnceWith(replay, true);
    expect(deps.invokeOutbound).not.toHaveBeenCalled();
  });

  it('terminalizes a consent-stale reply WITHOUT the newer-inbound burst marker', async () => {
    const replay = { ...PREPARED_OUTBOUND, responsePlanKind: 'routine', messagingConsentEpoch: 99 };
    const deps = clinicalDependencies({ findFinalizedOutbound: vi.fn(async () => replay) });
    await processClinicalMemoryJobCore(INBOUND_ID, deps);
    expect(deps.terminalizePreparedOutbound).toHaveBeenCalledExactlyOnceWith(replay, false);
    expect(deps.invokeOutbound).not.toHaveBeenCalled();
  });

  it('still sends a safety reply even when a newer inbound arrived', async () => {
    const replay = { ...PREPARED_OUTBOUND, responsePlanKind: 'emergency' };
    const deps = clinicalDependencies({
      findFinalizedOutbound: vi.fn(async () => replay),
      hasNewerInbound: vi.fn(async () => true),
    });
    await processClinicalMemoryJobCore(INBOUND_ID, deps);
    expect(deps.terminalizePreparedOutbound).not.toHaveBeenCalled();
    expect(deps.invokeOutbound).toHaveBeenCalledExactlyOnceWith(replay, 1);
  });

  it('sends a routine reply normally when no newer inbound exists', async () => {
    const replay = { ...PREPARED_OUTBOUND, responsePlanKind: 'routine' };
    const deps = clinicalDependencies({
      findFinalizedOutbound: vi.fn(async () => replay),
      hasNewerInbound: vi.fn(async () => false),
    });
    await processClinicalMemoryJobCore(INBOUND_ID, deps);
    expect(deps.terminalizePreparedOutbound).not.toHaveBeenCalled();
    expect(deps.invokeOutbound).toHaveBeenCalledExactlyOnceWith(replay, 1);
  });
});

describe('processClinicalMemoryJobCore', () => {
  it('cuts a ready stored job from bounded claims to one atomic clinical commit before outbound and replays without legacy semantics', async () => {
    const order: string[] = [];
    const clinicalOutbound = {
      ...PREPARED_OUTBOUND,
      messagingConsentEpoch: 1,
    };
    let replay: typeof clinicalOutbound | null = null;
    let committedPrepared: PreparedClinicalTurn | null = null;
    const prepareClinicalTurn = vi.fn(
      (snapshot: PatientClinicalSnapshot, claims: readonly ClinicalClaimInput[]) => {
        order.push('prepare');
        return prepareClinicalTurnCore(snapshot, claims);
      },
    );
    const commitPreparedClinicalTurn = vi.fn(async (prepared: PreparedClinicalTurn) => {
      order.push('commit');
      committedPrepared = prepared;
      replay = clinicalOutbound;
      throw new Error('commit response lost after COMMIT');
    });
    const deps = clinicalDependencies({
      findFinalizedOutbound: vi.fn(async () => replay),
      loadBoundedClaims: vi.fn(async () => {
        order.push('checkpoint');
        return boundedClaims;
      }),
      loadClinicalSnapshot: vi.fn(async () => {
        order.push('snapshot');
        return clinicalSnapshot;
      }),
      prepareClinicalTurn,
      commitPreparedClinicalTurn,
      invokeOutbound: vi.fn(async () => {
        order.push('outbound');
      }),
    });

    await expect(processClinicalMemoryJobCore(INBOUND_ID, deps)).rejects.toThrow(
      'commit response lost after COMMIT',
    );
    await processClinicalMemoryJobCore(INBOUND_ID, deps);

    expect(order).toEqual(['snapshot', 'checkpoint', 'prepare', 'commit', 'outbound']);
    expect(deps.loadBoundedClaims).toHaveBeenCalledOnce();
    expect(deps.loadClinicalSnapshot).toHaveBeenCalledOnce();
    expect(prepareClinicalTurn).toHaveBeenCalledOnce();
    expect(prepareClinicalTurn).toHaveBeenCalledWith(clinicalSnapshot, [headacheClaim]);
    expect(commitPreparedClinicalTurn).toHaveBeenCalledOnce();
    expect(commitPreparedClinicalTurn.mock.calls[0]?.[0]).toBe(committedPrepared);
    expect(committedPrepared).toEqual(
      expect.objectContaining({
        commandHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        preparedHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
    expect(deps.invokeOutbound).toHaveBeenCalledOnce();
    expect(deps.invokeOutbound).toHaveBeenCalledWith(clinicalOutbound, 1);
    expect(deps.terminalizePreparedOutbound).not.toHaveBeenCalled();
  });

  it('preserves an exact relation but rejects opaque same-field alias order as a target', async () => {
    const firstEventId = 'event-first-symptom';
    const secondEventId = 'event-second-symptom';
    const firstNeedId = 'need-first-severity';
    const secondNeedId = 'need-second-severity';
    const relatedSnapshot: PatientClinicalSnapshot = {
      ...clinicalSnapshot,
      memory: {
        ...clinicalSnapshot.memory,
        version: 4,
        events: [
          {
            id: firstEventId,
            version: 1,
            kind: 'symptom',
            operation: 'create',
            authoredBy: 'patient',
            reviewState: 'unreviewed',
            current: true,
            canonical: true,
            sourceMessageIds: ['message-first-symptom'],
            sourceSpans: [
              {
                messageId: 'message-first-symptom',
                start: 0,
                end: 8,
                quote: 'headache',
              },
            ],
            rawSymptom: 'headache',
            symptomConcept: 'headache',
            symptomStatus: 'current',
          },
          {
            id: secondEventId,
            version: 1,
            kind: 'symptom',
            operation: 'create',
            authoredBy: 'patient',
            reviewState: 'unreviewed',
            current: true,
            canonical: true,
            sourceMessageIds: ['message-second-symptom'],
            sourceSpans: [
              {
                messageId: 'message-second-symptom',
                start: 0,
                end: 6,
                quote: 'nausea',
              },
            ],
            rawSymptom: 'nausea',
            symptomConcept: 'nausea',
            symptomStatus: 'current',
          },
        ],
        needs: [
          {
            id: firstNeedId,
            version: 1,
            originInboundMessageId: 'message-first-symptom',
            originInboundSequence: 1,
            targetEventId: firstEventId,
            targetEventVersion: 1,
            field: 'severity',
            candidateMedicationIds: [],
            candidateDoseIds: [],
            candidateSymptomEventIds: [firstEventId],
            candidateHistoricalEventIds: [],
            questionId: 'question-first-severity',
            clarificationAttemptUsed: true,
            state: 'asked',
            priority: 70,
          },
          {
            id: secondNeedId,
            version: 1,
            originInboundMessageId: 'message-second-symptom',
            originInboundSequence: 2,
            targetEventId: secondEventId,
            targetEventVersion: 1,
            field: 'severity',
            candidateMedicationIds: [],
            candidateDoseIds: [],
            candidateSymptomEventIds: [secondEventId],
            candidateHistoricalEventIds: [],
            questionId: 'question-second-severity',
            clarificationAttemptUsed: true,
            state: 'asked',
            priority: 70,
          },
        ],
      },
      inboundMessage: { id: INBOUND_ID, sequence: 3, body: '7' },
      expectedMemoryVersion: 4,
      symptomConcepts: ['headache', 'nausea'],
    };
    const needAnswer: ExtractedClaim = {
      slot: 'answer-second-severity',
      kind: 'need_answer',
      quote: '7',
      polarity: 'positive',
      experiencer: 'patient',
      status: 'current',
      certainty: 'certain',
      answerField: 'severity',
      answerText: '7',
    };
    let committed: PreparedClinicalTurn | undefined;
    const clinicalOutbound = { ...PREPARED_OUTBOUND, messagingConsentEpoch: 1 };
    const deps = clinicalDependencies({
      findFinalizedOutbound: vi.fn(async () => null),
      loadBoundedClaims: vi.fn(async () =>
        boundedClaimExtractionSchema.parse({
          claims: [
            {
              sourceMessageId: INBOUND_ID,
              informationNeedId: secondNeedId,
              claim: needAnswer,
            },
          ],
        }),
      ),
      loadClinicalSnapshot: vi.fn(async () => relatedSnapshot),
      prepareClinicalTurn: prepareClinicalTurnCore,
      prepareClinicalFailureTurn: prepareClinicalFailureTurnCore,
      commitPreparedClinicalTurn: vi.fn(async (prepared: PreparedClinicalTurn) => {
        committed = prepared;
        return clinicalOutbound;
      }),
      invokeOutbound: vi.fn(async () => undefined),
    });

    await processClinicalMemoryJobCore(INBOUND_ID, deps);

    expect(committed?.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'ResolveInformationNeed', needId: secondNeedId }),
        expect.objectContaining({ kind: 'RefineReport', targetEventId: secondEventId }),
      ]),
    );
    expect(
      committed?.commands.some(
        (command) => command.kind === 'ResolveInformationNeed' && command.needId === firstNeedId,
      ),
    ).toBe(false);
    expect(committed?.commands.some(({ kind }) => kind === 'PreserveUnresolvedContent')).toBe(
      false,
    );

    const staleRelation = prepareClinicalTurnCore(relatedSnapshot, [
      { claim: needAnswer, informationNeedId: 'need-no-longer-asked' },
    ]);
    expect(staleRelation.commands).toEqual([
      expect.objectContaining({
        kind: 'PreserveUnresolvedContent',
        reason: 'pending_target_ambiguous',
      }),
    ]);
    expect(
      staleRelation.commands.some(
        ({ kind }) => kind === 'ResolveInformationNeed' || kind === 'RefineReport',
      ),
    ).toBe(false);

    const prepareFromFirstVisibleNeed = async (
      snapshot: PatientClinicalSnapshot,
    ): Promise<PreparedClinicalTurn> => {
      const boundary = createBoundedClaimProviderBoundary(
        {
          currentMessage: {
            id: snapshot.inboundMessage.id,
            direction: 'inbound',
            body: snapshot.inboundMessage.body,
          },
          openInformationNeeds: snapshot.memory.needs.map(({ id, field }) => ({ id, field })),
        },
        { createNonce: () => 'cccccccccccccccccccccccc' },
      );
      const extraction = boundary.parseResult({
        claims: [
          {
            sourceRef: boundary.input.currentMessage.sourceRef,
            informationNeedRef: boundary.input.openInformationNeeds[0]!.informationNeedRef,
            claim: { ...needAnswer, slot: 'claim_1' },
          },
        ],
      });
      let preparedResult: PreparedClinicalTurn | undefined;
      const runtimeDeps = clinicalDependencies({
        findFinalizedOutbound: vi.fn(async () => null),
        loadBoundedClaims: vi.fn(async () => extraction),
        loadClinicalSnapshot: vi.fn(async () => snapshot),
        prepareClinicalTurn: prepareClinicalTurnCore,
        prepareClinicalFailureTurn: prepareClinicalFailureTurnCore,
        commitPreparedClinicalTurn: vi.fn(async (prepared: PreparedClinicalTurn) => {
          preparedResult = prepared;
          return clinicalOutbound;
        }),
        invokeOutbound: vi.fn(async () => undefined),
      });

      await processClinicalMemoryJobCore(INBOUND_ID, runtimeDeps);
      if (preparedResult === undefined) throw new Error('Expected a prepared clinical turn');
      return preparedResult;
    };
    const reversedSnapshot: PatientClinicalSnapshot = {
      ...relatedSnapshot,
      memory: { ...relatedSnapshot.memory, needs: [...relatedSnapshot.memory.needs].reverse() },
    };
    const firstVisible = await prepareFromFirstVisibleNeed(relatedSnapshot);
    const reversedVisible = await prepareFromFirstVisibleNeed(reversedSnapshot);

    for (const prepared of [firstVisible, reversedVisible]) {
      expect(prepared.commands).toEqual([
        expect.objectContaining({
          kind: 'PreserveUnresolvedContent',
          reason: 'pending_target_ambiguous',
        }),
      ]);
      expect(
        prepared.commands.some(
          ({ kind }) => kind === 'ResolveInformationNeed' || kind === 'RefineReport',
        ),
      ).toBe(false);
    }
    expect(reversedVisible).toEqual(firstVisible);
  });

  it('fails closed when a non-answer claim carries an information-need relation', () => {
    const prepared = prepareClinicalTurnCore(clinicalSnapshot, [
      { claim: headacheClaim, informationNeedId: 'need-not-valid-for-symptom' },
    ]);

    expect(prepared.responsePlan).toEqual({
      kind: 'human_review',
      reviewReasons: ['claim_information_need_relationship_invalid'],
    });
    expect(prepared.commands).toEqual([
      expect.objectContaining({
        kind: 'PreserveUnresolvedContent',
        reason: 'claim_information_need_relationship_invalid',
      }),
    ]);
  });

  it.each([
    'provider_error',
    'malformed_output',
    'budget_exhausted',
    'circuit_open',
    'ambiguous_outcome',
  ] as const)(
    'commits %s as one deterministic clinical review batch without recalling the provider',
    async (failureKind) => {
      const preparedFailure = prepareClinicalFailureTurnCore(clinicalSnapshot, failureKind);
      const clinicalOutbound = { ...PREPARED_OUTBOUND, messagingConsentEpoch: 1 };
      let replay: ClinicalMemoryOutbound | null = null;
      const loadBoundedClaims = vi.fn(async () => {
        throw new ConversationStageFailure(failureKind);
      });
      const prepareClinicalFailureTurn = vi.fn(() => preparedFailure);
      const commitPreparedClinicalTurn = vi.fn(async () => {
        replay = clinicalOutbound;
        return clinicalOutbound;
      });
      const invokeOutbound = vi.fn(async () => {
        replay = { ...clinicalOutbound, status: 'queued' };
      });
      const deps = clinicalDependencies({
        findFinalizedOutbound: vi.fn(async () => replay),
        loadBoundedClaims,
        loadClinicalSnapshot: vi.fn(async () => clinicalSnapshot),
        prepareClinicalTurn: vi.fn(prepareClinicalTurnCore),
        prepareClinicalFailureTurn,
        commitPreparedClinicalTurn,
        invokeOutbound,
      });

      await processClinicalMemoryJobCore(INBOUND_ID, deps);
      await processClinicalMemoryJobCore(INBOUND_ID, deps);

      expect(loadBoundedClaims).toHaveBeenCalledOnce();
      expect(deps.loadClinicalSnapshot).toHaveBeenCalledOnce();
      expect(prepareClinicalFailureTurn).toHaveBeenCalledWith(clinicalSnapshot, failureKind);
      expect(deps.prepareClinicalTurn).not.toHaveBeenCalled();
      expect(commitPreparedClinicalTurn).toHaveBeenCalledOnce();
      expect(commitPreparedClinicalTurn).toHaveBeenCalledWith(preparedFailure);
      expect(preparedFailure).toMatchObject({
        runtimeFailure: failureKind,
        responsePlan: { kind: 'human_review', reviewReasons: [failureKind] },
        commands: [
          {
            kind: 'PreserveUnresolvedContent',
            reason: failureKind,
            sourceMessageId: INBOUND_ID,
            sourceSpans: [
              {
                messageId: INBOUND_ID,
                start: 0,
                end: input.currentMessage.body.length,
                quote: input.currentMessage.body,
              },
            ],
          },
        ],
      });
      expect(invokeOutbound).toHaveBeenCalledOnce();
    },
  );

  it('keeps internal stage defects observable instead of converting them into a review success', async () => {
    const failure = new ConversationStageFailure('internal_error');
    const prepareClinicalFailureTurn = vi.fn();
    const commitPreparedClinicalTurn = vi.fn();
    const deps = clinicalDependencies({
      findFinalizedOutbound: vi.fn(async () => null),
      loadBoundedClaims: vi.fn(async () => {
        throw failure;
      }),
      loadClinicalSnapshot: vi.fn(async () => clinicalSnapshot),
      prepareClinicalTurn: vi.fn(prepareClinicalTurnCore),
      prepareClinicalFailureTurn,
      commitPreparedClinicalTurn,
      invokeOutbound: vi.fn(),
    });

    await expect(processClinicalMemoryJobCore(INBOUND_ID, deps)).rejects.toBe(failure);
    expect(prepareClinicalFailureTurn).not.toHaveBeenCalled();
    expect(commitPreparedClinicalTurn).not.toHaveBeenCalled();
    expect(deps.invokeOutbound).not.toHaveBeenCalled();
  });
});

function durableDependencies(
  overrides: Partial<DurableStageDependencies> = {},
): DurableStageDependencies {
  return {
    loadCheckpoint: vi.fn(async () => null),
    reserve: vi.fn(async () => ({ kind: 'reserved' as const, windowStart: '', windowEnd: '' })),
    releaseReservation: vi.fn(async () => undefined),
    claimCircuit: vi.fn(async () => ({ kind: 'closed' as const })),
    releaseCircuit: vi.fn(async () => undefined),
    persist: vi.fn(async () => ({ kind: 'stored' as const })),
    recordCircuitSuccess: vi.fn(async () => undefined),
    recordCircuitFailure: vi.fn(async () => undefined),
    invokeGateway: vi.fn(async (request): Promise<ConversationGatewayResponse> => {
      if (request.stage !== 'interpretation') throw new Error('writer stage must not run');
      return {
        ok: true,
        requestId: request.requestId,
        stage: 'interpretation',
        result: boundedClaimExtractionSchema.parse(boundedClaims),
        usage: { inputTokens: 100, outputTokens: 20 },
        metadata: {
          modelId: 'claude-sonnet-5',
          promptVersion: CLINICAL_EXTRACTOR_PROMPT_VERSION,
          schemaSha256: 'a'.repeat(64),
          latencyMs: 25,
        },
      };
    }),
    createLeaseId: () => LEASE_ID,
    expectedSchemaSha256: 'a'.repeat(64),
    ...overrides,
  };
}

describe('durable conversation stage model', () => {
  const job = {
    kind: 'ready' as const,
    turnJobId: TURN_JOB_ID,
    messagingStateVersion: 1,
    input,
    evidence: [],
  };

  const extract = (deps: DurableStageDependencies, selectedJob = job) =>
    createDurableBoundedClaimExtractor(selectedJob, [], deps).extract(boundedProviderInput);

  async function storedCheckpoint() {
    const fresh = durableDependencies();
    await extract(fresh);
    return (fresh.persist as ReturnType<typeof vi.fn>).mock.calls[0]![0];
  }

  it('persists one successful bounded extraction and reuses its exact stored checkpoint', async () => {
    const fresh = durableDependencies();
    const model = createDurableBoundedClaimExtractor(job, [], fresh);
    expect(model).not.toHaveProperty('write');
    await expect(model.extract(boundedProviderInput)).resolves.toEqual(boundedClaims);
    // RIGHT-SIZED: one provider call's worth (the gateway's own 12,000-token context gate and
    // its 4,096 interpretationMaxTokens), not the six-call retry ceiling — one in-flight message
    // must never hold most of a patient's day. persist tops it up to the honest summed actual.
    expect(fresh.reserve).toHaveBeenCalledWith('interpretation', 12_000, 4_096);
    // Pinned to the gateway's OWN per-call gates across the file boundary: a gate raised above
    // the reservation would let one call spend more than the turn ever held.
    expect(fresh.reserve).toHaveBeenCalledWith(
      'interpretation',
      MAX_CONTEXT_TOKENS,
      CONVERSATION_GATEWAY_CONFIG.interpretationMaxTokens,
    );
    expect(fresh.releaseReservation).not.toHaveBeenCalled();
    expect(fresh.claimCircuit).toHaveBeenCalledBefore(fresh.reserve as ReturnType<typeof vi.fn>);
    expect(fresh.invokeGateway).toHaveBeenCalledOnce();
    expect(fresh.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'interpretation',
        output: boundedClaims,
        schemaSha256: 'a'.repeat(64),
      }),
    );

    const stored = (fresh.persist as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const replay = durableDependencies({
      loadCheckpoint: vi.fn(async () => stored),
    });
    await expect(extract(replay)).resolves.toEqual(boundedClaims);
    expect(replay.reserve).not.toHaveBeenCalled();
    expect(replay.invokeGateway).not.toHaveBeenCalled();
  });

  it('projects asked AND grace-expired information needs into the provider request, never open ones', async () => {
    const base = durableDependencies();
    const invokeGateway = vi.fn((request: Parameters<typeof base.invokeGateway>[0]) =>
      base.invokeGateway(request),
    );
    const deps = { ...base, invokeGateway };
    // The caller pre-filters expired needs to the within-grace ones (isExpiredNeedWithinAnswerGrace);
    // the factory must project them so a late clear answer can still be claimed as need_answer.
    const needs = [
      { id: 'need-asked', field: 'severity', state: 'asked' as const },
      { id: 'need-open', field: 'severity', state: 'open' as const },
      { id: 'need-expired-grace', field: 'medication_identity', state: 'expired' as const },
    ] as const;
    const model = createDurableBoundedClaimExtractor(job, needs, deps);

    await model.extract(boundedProviderInput);

    expect(invokeGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          openInformationNeeds: [
            { id: 'need-expired-grace', field: 'medication_identity' },
            { id: 'need-asked', field: 'severity' },
          ],
        }),
      }),
    );
  });

  it('fails closed before replaying a checkpoint with a different extractor schema hash', async () => {
    const stored = await storedCheckpoint();
    const loadCheckpoint = vi.fn(async () => ({
      ...stored,
      schemaSha256: 'b'.repeat(64),
    }));
    const deps = durableDependencies({ loadCheckpoint });

    await expect(extract(deps)).rejects.toMatchObject({ failureKind: 'internal_error' });

    expect(loadCheckpoint).toHaveBeenCalledOnce();
    expect(deps.claimCircuit).not.toHaveBeenCalled();
    expect(deps.reserve).not.toHaveBeenCalled();
    expect(deps.invokeGateway).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it('fails closed before replaying a checkpoint from an old prompt version', async () => {
    const stored = await storedCheckpoint();
    const deps = durableDependencies({
      loadCheckpoint: vi.fn(async () => ({
        ...stored,
        promptVersion: 'clinical-extractor-v0',
      })),
    });

    await expect(extract(deps)).rejects.toMatchObject({ failureKind: 'internal_error' });
    expect(deps.loadCheckpoint).toHaveBeenCalledOnce();
    expect(deps.invokeGateway).not.toHaveBeenCalled();
  });

  it('fails closed before replay or dispatch for a non-current schema version', async () => {
    const stored = await storedCheckpoint();
    const deps = durableDependencies({
      loadCheckpoint: vi.fn(async () => ({
        ...stored,
        schemaVersion: 'clinical-extraction-v0',
      })),
    });

    await expect(extract(deps)).rejects.toMatchObject({ failureKind: 'internal_error' });
    expect(deps.loadCheckpoint).toHaveBeenCalledOnce();
    expect(deps.claimCircuit).not.toHaveBeenCalled();
    expect(deps.invokeGateway).not.toHaveBeenCalled();
  });

  it('never recalls a stage whose durable attempt marker has no result', async () => {
    const deps = durableDependencies({
      claimCircuit: vi.fn(async () => ({
        kind: 'half_open' as const,
        leaseId: LEASE_ID,
        leaseExpiresAt: new Date().toISOString(),
      })),
      reserve: vi.fn(async () => ({ kind: 'already_attempted' as const })),
    });
    await expect(extract(deps)).rejects.toMatchObject({
      failureKind: 'ambiguous_outcome',
    });
    expect(deps.invokeGateway).not.toHaveBeenCalled();
    expect(deps.releaseCircuit).toHaveBeenCalledWith(LEASE_ID);
  });

  it('does not duplicate a model call when the gateway connection is lost after dispatch', async () => {
    const reserve = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'reserved', windowStart: '', windowEnd: '' })
      .mockResolvedValueOnce({ kind: 'already_attempted' });
    const invokeGateway = vi.fn().mockRejectedValue(new Error('socket closed after dispatch'));
    const deps = durableDependencies({ reserve, invokeGateway });

    await expect(extract(deps)).rejects.toMatchObject({
      failureKind: 'ambiguous_outcome',
    });
    await expect(extract(deps)).rejects.toMatchObject({
      failureKind: 'ambiguous_outcome',
    });

    expect(invokeGateway).toHaveBeenCalledOnce();
    expect(deps.recordCircuitFailure).toHaveBeenCalledWith(LEASE_ID, 'transient');
  });

  it.each([
    ['open', 'circuit_open'],
    ['budget', 'budget_exhausted'],
  ] as const)(
    'fails safely before dispatch when the %s guard blocks',
    async (guard, failureKind) => {
      const deps = durableDependencies(
        guard === 'open'
          ? {
              claimCircuit: vi.fn(async () => ({
                kind: 'open' as const,
                retryAt: new Date().toISOString(),
              })),
            }
          : {
              claimCircuit: vi.fn(async () => ({
                kind: 'half_open' as const,
                leaseId: LEASE_ID,
                leaseExpiresAt: new Date().toISOString(),
              })),
              reserve: vi.fn(async () => ({ kind: 'budget_exhausted' as const })),
            },
      );
      await expect(extract(deps)).rejects.toMatchObject({
        failureKind,
      });
      expect(deps.invokeGateway).not.toHaveBeenCalled();
      if (guard === 'open') expect(deps.reserve).not.toHaveBeenCalled();
      if (guard === 'budget') expect(deps.releaseCircuit).toHaveBeenCalledWith(LEASE_ID);
      // Nothing was ever reserved on either guard, so nothing may be credited back.
      expect(deps.releaseReservation).not.toHaveBeenCalled();
    },
  );

  it('records a typed provider failure and does not dispatch again', async () => {
    const deps = durableDependencies({
      invokeGateway: vi.fn(
        async (): Promise<ConversationGatewayResponse> => ({
          ok: false,
          requestId: input.requestId,
          stage: 'interpretation',
          failureKind: 'transient',
          usage: null,
          metadata: {
            modelId: 'claude-sonnet-5',
            promptVersion: CLINICAL_EXTRACTOR_PROMPT_VERSION,
            schemaSha256: 'a'.repeat(64),
            latencyMs: 20,
          },
        }),
      ),
    });
    await expect(extract(deps)).rejects.toMatchObject({
      failureKind: 'provider_error',
    });
    expect(deps.recordCircuitFailure).toHaveBeenCalledWith(LEASE_ID, 'transient');
  });

  it('turns an exact context overflow into a budget fallback without penalizing the circuit', async () => {
    const deps = durableDependencies({
      invokeGateway: vi.fn(
        async (): Promise<ConversationGatewayResponse> => ({
          ok: false,
          requestId: input.requestId,
          stage: 'interpretation',
          failureKind: 'input_too_large',
          usage: null,
          metadata: {
            modelId: 'claude-sonnet-5',
            promptVersion: CLINICAL_EXTRACTOR_PROMPT_VERSION,
            schemaSha256: 'a'.repeat(64),
            latencyMs: 20,
          },
        }),
      ),
    });

    await expect(extract(deps)).rejects.toMatchObject({
      failureKind: 'budget_exhausted',
    });
    expect(deps.recordCircuitSuccess).toHaveBeenCalledWith(LEASE_ID);
    expect(deps.recordCircuitFailure).not.toHaveBeenCalled();
  });

  /**
   * Live incident (2026-08-17): the reservation was released ONLY via persist, so every
   * post-reserve failure leaked the turn's whole hold for the rest of the patient's day. One
   * terminally failed extraction (gateway ok:false malformed_output) starved every later turn
   * into budget_exhausted and the agent answered a direct patient question with the
   * human-review template.
   */
  describe('post-reserve failures return their reservation', () => {
    const failureMetadata = {
      modelId: 'claude-sonnet-5',
      promptVersion: CLINICAL_EXTRACTOR_PROMPT_VERSION,
      schemaSha256: 'a'.repeat(64),
      latencyMs: 20,
    };

    it('credits back the honest reported usage when the gateway answers ok:false', async () => {
      const deps = durableDependencies({
        invokeGateway: vi.fn(
          async (): Promise<ConversationGatewayResponse> => ({
            ok: false,
            requestId: input.requestId,
            stage: 'interpretation',
            failureKind: 'malformed',
            usage: { inputTokens: 3_100, outputTokens: 640 },
            metadata: failureMetadata,
          }),
        ),
      });
      await expect(extract(deps)).rejects.toMatchObject({ failureKind: 'malformed_output' });
      expect(deps.releaseReservation).toHaveBeenCalledWith(3_100, 640);
      expect(deps.persist).not.toHaveBeenCalled();
    });

    it('credits back the whole reservation when the failure reports no usage', async () => {
      const deps = durableDependencies({
        invokeGateway: vi.fn(
          async (): Promise<ConversationGatewayResponse> => ({
            ok: false,
            requestId: input.requestId,
            stage: 'interpretation',
            failureKind: 'transient',
            usage: null,
            metadata: failureMetadata,
          }),
        ),
      });
      await expect(extract(deps)).rejects.toMatchObject({ failureKind: 'provider_error' });
      expect(deps.releaseReservation).toHaveBeenCalledWith(0, 0);
    });

    it('credits back the reservation when the gateway transport throws after dispatch', async () => {
      const deps = durableDependencies({
        invokeGateway: vi.fn().mockRejectedValue(new Error('socket closed after dispatch')),
      });
      await expect(extract(deps)).rejects.toMatchObject({ failureKind: 'ambiguous_outcome' });
      expect(deps.releaseReservation).toHaveBeenCalledWith(0, 0);
    });

    it('credits back the reservation when the response breaks the stage contract', async () => {
      const deps = durableDependencies({
        invokeGateway: vi.fn(
          async (): Promise<ConversationGatewayResponse> => ({
            ok: true,
            requestId: input.requestId,
            stage: 'interpretation',
            result: boundedClaimExtractionSchema.parse(boundedClaims),
            usage: { inputTokens: 90, outputTokens: 12 },
            // A schema hash the worker never asked for: a contract mismatch, not a model failure.
            metadata: { ...failureMetadata, schemaSha256: 'f'.repeat(64) },
          }),
        ),
      });
      await expect(extract(deps)).rejects.toMatchObject({ failureKind: 'internal_error' });
      expect(deps.releaseReservation).toHaveBeenCalledWith(90, 12);
      expect(deps.persist).not.toHaveBeenCalled();
    });

    it('credits back the reservation when the checkpoint write itself fails', async () => {
      const persistFailure = new Error('checkpoint write failed');
      const deps = durableDependencies({
        persist: vi.fn(async () => {
          throw persistFailure;
        }),
      });
      await expect(extract(deps)).rejects.toBe(persistFailure);
      expect(deps.releaseReservation).toHaveBeenCalledWith(100, 20);
    });
  });
});

describe('invokeConversationGateway', () => {
  const request = {
    requestId: input.requestId,
    stage: 'interpretation' as const,
    input: boundedGatewayInput,
  };
  const response = {
    ok: true as const,
    requestId: input.requestId,
    stage: 'interpretation' as const,
    result: boundedClaims,
    usage: { inputTokens: 100, outputTokens: 20 },
    metadata: {
      modelId: 'claude-sonnet-5',
      promptVersion: CLINICAL_EXTRACTOR_PROMPT_VERSION,
      schemaSha256: 'a'.repeat(64),
      latencyMs: 250,
    },
  };

  it('uses one synchronous invocation and parses only the matching strict response', async () => {
    const send = vi.fn(async (command: unknown) => {
      void command;
      return { Payload: new TextEncoder().encode(JSON.stringify(response)) };
    });

    await expect(
      invokeConversationGateway(request, { functionArn: 'arn:gateway', send }),
    ).resolves.toEqual(response);

    expect(send).toHaveBeenCalledOnce();
    expect((send.mock.calls[0]![0] as { input: unknown }).input).toEqual({
      FunctionName: 'arn:gateway',
      InvocationType: 'RequestResponse',
      Payload: new TextEncoder().encode(JSON.stringify(request)),
    });
  });

  it.each([
    [{ FunctionError: 'Unhandled', Payload: new Uint8Array() }],
    [{} as ConversationLambdaInvokeOutput],
    [
      {
        Payload: new TextEncoder().encode(JSON.stringify({ ...response, requestId: INBOUND_ID })),
      },
    ],
    [{ Payload: new TextEncoder().encode('not-json') }],
  ])('fails closed on an ambiguous or invalid gateway response', async (providerResponse) => {
    const send = vi.fn(async (command: unknown): Promise<ConversationLambdaInvokeOutput> => {
      void command;
      return providerResponse;
    });

    await expect(
      invokeConversationGateway(request, { functionArn: 'arn:gateway', send }),
    ).rejects.toThrow(/gateway/iu);
  });

  it('rejects a body above the bounded extractor contract before invoking the gateway Lambda', async () => {
    const send = vi.fn(async (command: unknown) => {
      void command;
      return { Payload: new TextEncoder().encode(JSON.stringify(response)) };
    });
    const oversizedInput = {
      ...boundedGatewayInput,
      currentMessage: { ...boundedGatewayInput.currentMessage, body: 'x'.repeat(2_001) },
    };

    await expect(
      invokeConversationGateway(
        { requestId: input.requestId, stage: 'interpretation', input: oversizedInput },
        { functionArn: 'arn:gateway', send },
      ),
    ).rejects.toThrow(/at most 2000/iu);
    expect(send).not.toHaveBeenCalled();
  });

  it('pins one synchronous Lambda attempt with bounded connection and socket timeouts', () => {
    expect(CONVERSATION_LAMBDA_CLIENT_CONFIG).toEqual({
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 2_000, socketTimeout: 65_000 },
    });
  });
});
