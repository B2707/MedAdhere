import {
  APIConnectionError,
  APIConnectionTimeoutError,
  type default as Anthropic,
} from '@anthropic-ai/sdk';
import {
  ADE_SYNONYM_MAP,
  CONVERSATION_SCHEMA_VERSION,
  conversationTurnResultSchema,
  conversationTurnInputSchema,
  type ConversationClarificationTopic,
  type ConversationObservation,
  type ConversationTurnInput,
  type ConversationTurnResult,
} from '@medadhere/shared';
import {
  applyPreparedClinicalTurn,
  clinicalClaimsFromBoundedExtraction,
  clinicalIntentCommandSchema,
  CURRENT_CLINICAL_PIPELINE_VERSIONS,
  prepareClinicalTurn,
  renderClinicalResponse,
} from '../../src/conversation/clinical-memory/index.js';
import {
  buildAnthropicBoundedClaimRequest,
  CLINICAL_EXTRACTOR_PROMPT_VERSION,
  ConversationStageModelError,
  createAnthropicBoundedClaimExtractor,
  type AnthropicStageModelConfig,
  type BoundedClaimStageModel,
  type ConversationMessagesClient,
  type ConversationStageUsage,
} from '../../src/conversation/clinical-memory/anthropic-extractor.js';
import { createBoundedClaimProviderBoundary } from '../../src/conversation/clinical-memory/bounded-provider.js';
import type {
  ClinicalEvent,
  NeedField,
  PatientClinicalMemory,
  PatientClinicalSnapshot,
  PreparedClinicalTurn,
} from '../../src/conversation/clinical-memory/contracts.js';
import { sha256, uniqueSorted } from '../../src/conversation/clinical-memory/hash.js';
import {
  CONVERSATION_MAX_INPUT_TOKENS_PER_CALL,
  type ConversationEvalProviderPayload,
  type ConversationResultScorer,
} from './conversation-provider.js';
import {
  conversationProviderTransportError,
  ConversationRunnerFatalError,
  type ConversationProvider,
  type ConversationProviderResponse,
} from './conversation-runner.js';

const QUESTION_ACKNOWLEDGEMENT = 'I’ve noted your update.';
export const CLINICAL_MEMORY_MAX_SERIALIZED_REQUEST_BYTES = 24_750;
const EVAL_SYMPTOM_CONCEPTS = uniqueSorted([
  'nausea',
  'headache',
  'dizziness',
  'tingling',
  ...ADE_SYNONYM_MAP.flatMap(({ pts }) => pts.map((term) => term.toLocaleLowerCase('en-US'))),
]);

const CLARIFICATION_TOPICS: Readonly<Partial<Record<NeedField, ConversationClarificationTopic>>> = {
  medication_identity: 'medication_identity',
  dose_identity: 'dose_identity',
  event_identity: 'event_identity',
  symptom_identity: 'symptom',
  severity: 'severity',
  actual_time: 'dose_time',
  duration: 'duration',
  body_site: 'body_site',
  frequency: 'frequency',
  // Wave 1c: the missed/pending-dose "will you take it later today?" question.
  late_intent: 'late_intent',
};

export interface ClinicalMemoryConversationMessagesClient extends ConversationMessagesClient {
  countTokens(
    params: Anthropic.MessageCountTokensParams,
  ): Promise<{ readonly input_tokens: number }>;
}

export interface ClinicalMemoryConversationProviderOptions {
  readonly beforeStage?: (dispatch: {
    readonly stage: ConversationStageUsage['stage'];
    readonly inputTokens: number;
    readonly maxOutputTokens: number;
  }) => void;
  readonly nowMs?: () => number;
}

export interface BuiltAnthropicClinicalMemoryTurnPreflight {
  readonly preparedTurnInput: ReturnType<typeof conversationTurnInputSchema.parse>;
  readonly interpretationSerializedUtf8Bytes: number;
  readonly reservedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly reservedModelCalls: 1;
}

class ClinicalMemoryEvalCompatibilityError extends Error {
  override readonly name = 'ClinicalMemoryEvalCompatibilityError';
}

function numericSeverity(value: string | undefined): number | null {
  if (value === undefined || !/^(?:[1-9]|10)$/u.test(value.trim())) return null;
  return Number(value);
}

function eventStatement(event: ClinicalEvent, sourceMessageId: string): string {
  return (
    event.sourceSpans.find(({ messageId }) => messageId === sourceMessageId)?.quote ??
    event.rawSymptom ??
    'Patient update'
  );
}

function projectObservation(
  event: ClinicalEvent,
  sourceMessageId: string,
): ConversationObservation | null {
  if (event.kind === 'safety') return null;
  const kind =
    event.operation === 'correct' || event.kind === 'contradiction'
      ? ('correction' as const)
      : event.kind === 'administration'
        ? ('medication_taking' as const)
        : ('symptom' as const);
  return {
    kind,
    statement: eventStatement(event, sourceMessageId),
    sourceMessageId,
    normalizedValue: event.symptomConcept ?? event.rawSymptom ?? null,
    severity: numericSeverity(event.severity),
    temporalCandidateIds: event.doseId === undefined ? [] : [event.doseId],
    patientMedicationIds: event.medicationId === undefined ? [] : [event.medicationId],
    evidenceIds: [],
    clinicalEventId: null,
    supersedesClinicalEventId: null,
  };
}

function projectAction(prepared: PreparedClinicalTurn): {
  readonly action: ConversationTurnResult['action'];
  readonly socialAcknowledgement: string;
} {
  if (prepared.responsePlan.kind !== 'question' || prepared.responsePlan.question === undefined) {
    return { action: { type: 'complete_turn' }, socialAcknowledgement: prepared.responseText };
  }
  const clarificationTopic = CLARIFICATION_TOPICS[prepared.responsePlan.question.field];
  if (clarificationTopic === undefined) {
    throw new ClinicalMemoryEvalCompatibilityError(
      'clinical_memory_eval_clarification_not_representable',
    );
  }
  const prefix = `${QUESTION_ACKNOWLEDGEMENT} `;
  if (!prepared.responseText.startsWith(prefix)) {
    throw new ClinicalMemoryEvalCompatibilityError(
      'clinical_memory_eval_response_not_representable',
    );
  }
  return {
    action: {
      type: 'ask_clarification',
      clarification: prepared.responseText.slice(prefix.length),
      clarificationTopic,
    },
    socialAcknowledgement: QUESTION_ACKNOWLEDGEMENT,
  };
}

function projectTurnResult(
  snapshot: PatientClinicalSnapshot,
  memory: PatientClinicalMemory,
  prepared: PreparedClinicalTurn,
  createdEventIds: readonly string[],
): ConversationTurnResult {
  const created = new Set(createdEventIds);
  const observations = memory.events.flatMap((event) => {
    if (!created.has(event.id) || !event.current) return [];
    const observation = projectObservation(event, prepared.sourceMessageId);
    return observation === null ? [] : [observation];
  });
  const projectedAction = projectAction(prepared);
  const safetyCandidate =
    prepared.responsePlan.kind === 'emergency'
      ? 'emergency'
      : prepared.responsePlan.kind === 'important'
        ? 'important'
        : observations.length > 0 || prepared.responsePlan.kind === 'human_review'
          ? 'routine'
          : 'none';
  return conversationTurnResultSchema.parse({
    detectedLanguage: 'en',
    languageConfidence: 1,
    mixedLanguage: false,
    translationUncertain: false,
    normalizedEnglishMeaning: snapshot.inboundMessage.body,
    adherenceClassification: null,
    observations,
    // The dose bindings the core actually recorded on the events this turn
    // created — never a harness-side guess. `buildTurnInput` gives every corpus
    // dose fact `candidateId === doseId`, and `buildEvalSnapshot` keys snapshot
    // doses by that same `doseId`, so a committed `event.doseId` is already in
    // the id space `expectedTemporalCandidateIds` uses. Deriving the turn list
    // from the projected observations keeps the two coherent by construction.
    temporalCandidateIds: uniqueSorted(
      observations.flatMap(({ temporalCandidateIds }) => temporalCandidateIds),
    ),
    ...projectedAction,
    clinicalClaim: null,
    clinicianReviewDraft: {
      patientStatements: [],
      establishedFactIds: [],
      inferences: [],
      uncertainties: [],
      evidenceIds: [],
      proposedCorrections: [],
    },
    selectedEvidenceIds: [],
    safetyCandidate,
  });
}

export async function evaluateClinicalMemoryTurn<TExpectation>(
  snapshot: PatientClinicalSnapshot,
  extractor: BoundedClaimStageModel,
  expectation: TExpectation,
  score: ConversationResultScorer<TExpectation>,
): Promise<{
  readonly memory: PatientClinicalMemory;
  readonly prepared: PreparedClinicalTurn;
  readonly response: ConversationProviderResponse;
}> {
  const openInformationNeeds = snapshot.memory.needs
    .filter(({ state }) => state === 'asked')
    .map(({ id, field }) => ({ id, field }))
    .sort(
      (left, right) => left.field.localeCompare(right.field) || left.id.localeCompare(right.id),
    );
  const extraction = await extractor.extract({
    currentMessage: {
      id: snapshot.inboundMessage.id,
      direction: 'inbound',
      body: snapshot.inboundMessage.body,
    },
    openInformationNeeds,
  });
  const prepared = prepareClinicalTurn(
    snapshot,
    clinicalClaimsFromBoundedExtraction(snapshot, extraction),
  );
  const committed = applyPreparedClinicalTurn(snapshot.memory, prepared);
  const turnResult = projectTurnResult(
    snapshot,
    committed.memory,
    prepared,
    committed.createdEventIds,
  );
  return {
    memory: committed.memory,
    prepared,
    response: {
      outcome: 'completed',
      turnResult,
      metricSuccesses: score(expectation, turnResult),
    },
  };
}

function countTokenParams(
  request: Anthropic.MessageCreateParamsNonStreaming,
): Anthropic.MessageCountTokensParams {
  return Object.fromEntries(
    Object.entries(request).filter(([key]) => key !== 'max_tokens' && key !== 'output_config'),
  ) as Anthropic.MessageCountTokensParams;
}

function isFatalProviderError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) return false;
  return new Set([400, 401, 402, 403, 404, 413, 422]).has(
    (error as { readonly status?: unknown }).status as number,
  );
}

function transportErrorClass(
  error: unknown,
): 'api_connection_timeout' | 'api_connection' | 'other' {
  if (error instanceof APIConnectionTimeoutError) return 'api_connection_timeout';
  if (error instanceof APIConnectionError) return 'api_connection';
  return 'other';
}

function contentVersion(value: unknown): number {
  return Number.parseInt(sha256(value).slice(0, 12), 16) + 1;
}

function emptyMemory(patientId: string): PatientClinicalMemory {
  return {
    patientId,
    version: 0,
    events: [],
    needs: [],
    unresolvedReports: [],
    reviewItems: [],
    routineClarificationsPaused: false,
    processedBatches: [],
  };
}

/**
 * Prior-day context observations are already-persisted records, so the eval replays
 * them as one committed clinical turn: the core validates the prepared batch, its
 * reducer mints the event ids, versions, provenance and receipt, and the resulting
 * memory is indistinguishable from one grown organically turn by turn. A prior local
 * day's symptom report is recorded as `resolved` — that closed episode is exactly what
 * a later "it is back" message recurs against. Deterministic: derived only from `input`.
 */
function seedMemoryFromObservations(
  input: ConversationTurnInput,
  memory: PatientClinicalMemory,
): PatientClinicalMemory {
  if (input.recentObservations.some(({ kind }) => kind !== 'symptom')) {
    throw new ClinicalMemoryEvalCompatibilityError('clinical_memory_eval_seed_not_canonical');
  }
  const sourceMessageId = `seed-${sha256(input.recentObservations).slice(0, 24)}`;
  let start = 0;
  const commands = input.recentObservations.map((observation) => {
    const quote = observation.statement;
    const span = { messageId: sourceMessageId, start, end: start + quote.length, quote };
    start = span.end + 1;
    const symptomText = observation.normalizedValue ?? quote;
    const intent = {
      kind: 'CreateReport' as const,
      eventKind: 'symptom' as const,
      sourceMessageId,
      sourceSpans: [span],
      rawSymptom: symptomText,
      symptomConcept:
        EVAL_SYMPTOM_CONCEPTS.find(
          (concept) => concept === symptomText.toLocaleLowerCase('en-US'),
        ) ?? null,
      symptomStatus: 'resolved' as const,
      ...(observation.severity === null ? {} : { severity: String(observation.severity) }),
    };
    return clinicalIntentCommandSchema.parse({
      ...intent,
      id: `command-${sha256(intent).slice(0, 24)}`,
    });
  });
  const responsePlan = {
    kind: 'routine' as const,
    acknowledgementId: 'acknowledgement-recorded',
    reviewReasons: [],
  };
  const integrity = {
    patientId: memory.patientId,
    idempotencyKey: sourceMessageId,
    sourceMessageId,
    sourceSequence: memory.version + 1,
    baseMemoryVersion: memory.version,
    consentEpoch: 1,
    contextHash: sha256(input.recentObservations),
    pipelineVersions: CURRENT_CLINICAL_PIPELINE_VERSIONS,
    commands,
    commandHash: sha256(commands),
    responsePlan,
    responseText: renderClinicalResponse(responsePlan),
  };
  return applyPreparedClinicalTurn(memory, { ...integrity, preparedHash: sha256(integrity) })
    .memory;
}

export function buildEvalSnapshot(
  input: ConversationTurnInput,
  baseMemory: PatientClinicalMemory,
): PatientClinicalSnapshot {
  if (!input.currentMessage.language.toLocaleLowerCase('en-US').startsWith('en')) {
    throw new ClinicalMemoryEvalCompatibilityError('clinical_memory_eval_english_only');
  }
  const memory =
    input.recentObservations.length > 0 && baseMemory.version === 0
      ? seedMemoryFromObservations(input, baseMemory)
      : baseMemory;
  const medications = input.activeMedications
    .map((medication) => ({
      id: medication.patientMedicationId,
      version: contentVersion(medication),
      names: uniqueSorted([medication.enteredName, ...medication.ingredientNames]),
      aliases: [],
      active: true,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const medicationIds = new Set(medications.map(({ id }) => id));
  const doseById = new Map<string, PatientClinicalSnapshot['doses'][number]>();
  for (const candidate of [...input.temporalCandidates].sort((left, right) =>
    (left.doseId ?? left.candidateId).localeCompare(right.doseId ?? right.candidateId),
  )) {
    if (
      candidate.doseId === null ||
      candidate.patientMedicationId === null ||
      !medicationIds.has(candidate.patientMedicationId) ||
      doseById.has(candidate.doseId)
    ) {
      continue;
    }
    const medication = medications.find(({ id }) => id === candidate.patientMedicationId)!;
    doseById.set(candidate.doseId, {
      id: candidate.doseId,
      version: contentVersion(candidate),
      medicationId: candidate.patientMedicationId,
      label: `${medication.names[0]} ${candidate.localTime}`,
      localDate: candidate.localDate,
      localTime: candidate.localTime,
    });
  }
  const doses = [...doseById.values()];
  const contextHash = sha256({
    inboundMessage: {
      id: input.currentMessage.id,
      sequence: memory.version + 1,
      body: input.currentMessage.body,
    },
    memory,
    medications,
    doses,
    promptedDoseId: input.promptedDoseId,
    patientTimeZone: input.locale.patientTimeZone,
    clinicalFacts: input.clinicalFacts,
    drugInteractions: input.drugInteractions,
    evidence: input.evidence,
    pipelineVersions: CURRENT_CLINICAL_PIPELINE_VERSIONS,
  });
  return {
    memory,
    inboundMessage: {
      id: input.currentMessage.id,
      sequence: memory.version + 1,
      body: input.currentMessage.body,
    },
    consentEpoch: 1,
    expectedConsentEpoch: 1,
    expectedMemoryVersion: memory.version,
    medications,
    doses,
    symptomConcepts: EVAL_SYMPTOM_CONCEPTS,
    ...(input.promptedDoseId !== null && doseById.has(input.promptedDoseId)
      ? { promptedDoseId: input.promptedDoseId }
      : {}),
    languageDisposition: 'english',
    emergencyPrefilter: false,
    contextHash,
    pipelineVersions: CURRENT_CLINICAL_PIPELINE_VERSIONS,
  };
}

export function buildAnthropicClinicalMemoryTurnPreflight(
  config: AnthropicStageModelConfig,
  turnInput: ConversationTurnInput,
): BuiltAnthropicClinicalMemoryTurnPreflight {
  const preparedTurnInput = conversationTurnInputSchema.parse({
    ...turnInput,
    promptVersion: CLINICAL_EXTRACTOR_PROMPT_VERSION,
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
  });
  const boundary = createBoundedClaimProviderBoundary(
    {
      currentMessage: {
        id: preparedTurnInput.currentMessage.id,
        direction: 'inbound',
        body: preparedTurnInput.currentMessage.body,
      },
      openInformationNeeds: [],
    },
    { createNonce: () => '0'.repeat(24) },
  );
  const request = buildAnthropicBoundedClaimRequest(config, boundary.input);
  const interpretationSerializedUtf8Bytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
  return {
    preparedTurnInput,
    interpretationSerializedUtf8Bytes,
    reservedInputTokens: Math.min(
      interpretationSerializedUtf8Bytes,
      CONVERSATION_MAX_INPUT_TOKENS_PER_CALL,
    ),
    reservedOutputTokens: config.interpretationMaxTokens,
    reservedModelCalls: 1,
  };
}

export function createAnthropicClinicalMemoryConversationProvider<TExpectation>(
  client: ClinicalMemoryConversationMessagesClient,
  score: ConversationResultScorer<TExpectation>,
  options: ClinicalMemoryConversationProviderOptions = {},
): ConversationProvider<ConversationEvalProviderPayload<TExpectation>> {
  const stateByScenario = new Map<string, PatientClinicalMemory>();
  return async ({ scenarioId, candidateConfig, payload }) => {
    const startedAt = (options.nowMs ?? Date.now)();
    const totals = {
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 0,
      modelCalls: 0,
    };
    const config: AnthropicStageModelConfig = {
      model: candidateConfig.model,
      thinking: candidateConfig.thinking,
      effort: candidateConfig.effort,
      interpretationMaxTokens: candidateConfig.maxTokens,
    };
    const { preparedTurnInput } = buildAnthropicClinicalMemoryTurnPreflight(
      config,
      payload.turnInput,
    );
    const countedClient: ConversationMessagesClient = {
      create: async (request) => {
        if (
          Buffer.byteLength(JSON.stringify(request), 'utf8') >
          CLINICAL_MEMORY_MAX_SERIALIZED_REQUEST_BYTES
        ) {
          throw new ConversationRunnerFatalError('request size ceiling exceeded');
        }
        let counted: { readonly input_tokens: number };
        try {
          counted = await client.countTokens(countTokenParams(request));
        } catch (error) {
          if (isFatalProviderError(error)) {
            throw new ConversationRunnerFatalError('token count request rejected');
          }
          throw conversationProviderTransportError(
            error,
            'interpretation',
            'count_tokens',
            transportErrorClass(error),
          );
        }
        if (
          !Number.isSafeInteger(counted.input_tokens) ||
          counted.input_tokens < 0 ||
          counted.input_tokens > CONVERSATION_MAX_INPUT_TOKENS_PER_CALL
        ) {
          throw new ConversationRunnerFatalError('input token ceiling exceeded');
        }
        options.beforeStage?.({
          stage: 'interpretation',
          inputTokens: counted.input_tokens,
          maxOutputTokens: request.max_tokens,
        });
        totals.modelCalls += 1;
        try {
          return await client.create(request);
        } catch (error) {
          if (isFatalProviderError(error)) {
            throw new ConversationRunnerFatalError('message create request rejected');
          }
          throw conversationProviderTransportError(
            error,
            'interpretation',
            'messages_create',
            transportErrorClass(error),
          );
        }
      },
    };
    const extractor = createAnthropicBoundedClaimExtractor(
      countedClient,
      config,
      ({ inputTokens, cacheCreationInputTokens, cacheReadInputTokens, outputTokens }) => {
        totals.inputTokens += inputTokens;
        totals.cacheCreationInputTokens += cacheCreationInputTokens;
        totals.cacheReadInputTokens += cacheReadInputTokens;
        totals.outputTokens += outputTokens;
      },
    );
    try {
      const memory = stateByScenario.get(scenarioId) ?? emptyMemory(preparedTurnInput.patientId);
      if (memory.patientId !== preparedTurnInput.patientId) {
        throw new ConversationRunnerFatalError('scenario patient changed');
      }
      const evaluated = await evaluateClinicalMemoryTurn(
        buildEvalSnapshot(preparedTurnInput, memory),
        extractor,
        payload.expectation,
        score,
      );
      stateByScenario.set(scenarioId, evaluated.memory);
      return {
        ...evaluated.response,
        latencyMs: Math.max(0, (options.nowMs ?? Date.now)() - startedAt),
        ...totals,
      };
    } catch (error) {
      if (error instanceof ClinicalMemoryEvalCompatibilityError) {
        return {
          outcome: 'malformed',
          modelStage: 'interpretation',
          metricSuccesses: {},
          latencyMs: Math.max(0, (options.nowMs ?? Date.now)() - startedAt),
          ...totals,
        };
      }
      if (!(error instanceof ConversationStageModelError)) throw error;
      return {
        outcome: error.kind,
        modelStage: error.stage,
        metricSuccesses: {},
        latencyMs: Math.max(0, (options.nowMs ?? Date.now)() - startedAt),
        ...totals,
      };
    }
  };
}
