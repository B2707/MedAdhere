import type { ConversationMessage, ConversationTurnInput } from '@medadhere/shared';
import type { ConversationEvalProviderPayload } from './conversation-provider.js';
import type { ConversationRunnerScenario } from './conversation-runner.js';
import type {
  ConversationPatientExpectation,
  ConversationScenario,
  ConversationTranscriptMessage,
} from './conversation-scenarios.js';

const PATIENT_ID = '00000000-0000-4000-8000-000000000001';
const SOURCE_RELEASE_ID = '00000000-0000-4000-8000-000000000002';
const CURRENT_UTC_MS = Date.parse('2026-08-09T13:00:00.000Z');
const TIME_ZONE = 'America/Toronto';

function messageAt(
  message: ConversationTranscriptMessage,
  index: number,
  referenceLanguage: string,
): ConversationMessage {
  return {
    id: message.id,
    direction: message.role === 'patient' ? 'inbound' : 'outbound',
    body: message.text,
    occurredAtUtc: new Date(CURRENT_UTC_MS + index * 60_000).toISOString(),
    language: message.role === 'patient' ? message.expectation.language : referenceLanguage,
  };
}

function previousClarification(messages: readonly ConversationTranscriptMessage[]): {
  readonly text: string | null;
  readonly sourceMessageId: string | null;
} {
  const last = messages.at(-1);
  if (last?.role !== 'reference_agent' || !/[?؟]/u.test(last.text)) {
    return { text: null, sourceMessageId: null };
  }
  const source = [...messages].reverse().find(({ role }) => role === 'patient');
  return { text: last.text, sourceMessageId: source?.id ?? null };
}

function buildTurnInput(
  scenario: ConversationScenario,
  message: Extract<ConversationTranscriptMessage, { role: 'patient' }>,
  transcriptIndex: number,
): ConversationTurnInput {
  const previous = scenario.transcript.slice(0, transcriptIndex);
  const context = scenario.scenarioContext;
  const availableEvidence = new Set(message.expectation.availableEvidenceIds);
  const pending = previousClarification(previous);
  return {
    requestId: message.id,
    patientId: PATIENT_ID,
    inboundMessageId: message.id,
    currentMessage: messageAt(message, transcriptIndex, scenario.primaryLanguage),
    locale: {
      expectedLanguage: message.expectation.language,
      patientTimeZone: TIME_ZONE,
      currentUtc: new Date(CURRENT_UTC_MS + transcriptIndex * 60_000).toISOString(),
      currentLocalDate: '2026-08-09',
    },
    currentDayMessages: previous.map((priorMessage, index) =>
      messageAt(priorMessage, index, scenario.primaryLanguage),
    ),
    pendingClarification: pending.text,
    pendingClarificationTopic: null,
    pendingClarificationSourceMessageId: pending.sourceMessageId,
    promptedDoseId: null,
    recentObservations: context.recentObservations.map((observation) => ({
      kind: observation.kind,
      statement: observation.statement,
      normalizedValue: observation.normalizedValue ?? null,
      severity: observation.severity,
      temporalCandidateIds: [],
      patientMedicationIds: [],
      evidenceIds: [],
      // Prior-day context observations are already persisted, so they carry their
      // corpus id as the clinical event id a later correction can supersede.
      clinicalEventId: observation.id,
      supersedesClinicalEventId: null,
    })),
    activeMedications: context.activeMedications.map((medication) => ({
      patientMedicationId: medication.id,
      enteredName: medication.name,
      ingredientNames: medication.ingredients,
      dose: null,
      form: null,
      route: null,
      effectiveFrom: '2026-08-01',
      effectiveTo: null,
    })),
    clinicalFacts: context.clinicalFacts.map((fact) => ({
      factId: fact.id,
      kind: 'note' as const,
      statement: fact.statement,
      confirmedAtUtc: '2026-08-01T13:00:00.000Z',
    })),
    drugInteractions: [],
    temporalCandidates: context.doseTimeFacts.map((dose) => ({
      candidateId: dose.id,
      patientMedicationId: dose.medicationId,
      doseId: dose.id,
      occurredAtUtc: new Date(`${dose.localDate}T${dose.localTime}:00-04:00`).toISOString(),
      localDate: dose.localDate,
      localTime: dose.localTime,
      patientTimeZone: TIME_ZONE,
      source: 'scheduled_dose' as const,
      ambiguous: scenario.categories.includes('am_pm_ambiguity'),
    })),
    evidence: context.evidence
      .filter((evidence) => availableEvidence.has(evidence.id))
      .map((evidence) => ({
        evidenceId: evidence.id,
        source: 'medlineplus' as const,
        sourceReleaseId: SOURCE_RELEASE_ID,
        sourceVersion: 'eval-v1',
        title: evidence.id,
        passage: evidence.summary,
        url: 'https://medlineplus.gov/',
        language: message.expectation.language,
        coverageState: 'direct_evidence' as const,
        allowedTemplateIds: evidence.allowedTemplateIds,
      })),
    promptVersion: 'conversation-v24',
    schemaVersion: 'conversation-v2',
  };
}

export function buildConversationRunnerScenarios(
  scenarios: readonly ConversationScenario[],
): Array<
  ConversationRunnerScenario<ConversationEvalProviderPayload<ConversationPatientExpectation>>
> {
  return scenarios.map((scenario) => ({
    scenarioId: scenario.id,
    turns: scenario.transcript.flatMap((message, transcriptIndex) =>
      message.role === 'reference_agent'
        ? []
        : [
            {
              turnId: message.id,
              eligibleForProvider: message.expectation.eligibleForProvider,
              payload: {
                turnInput: buildTurnInput(scenario, message, transcriptIndex),
                expectation: message.expectation,
              },
            },
          ],
    ),
  }));
}
