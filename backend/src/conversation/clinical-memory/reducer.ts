import {
  clinicalIntentCommandSchema,
  patientClinicalMemorySchema,
  type ClinicalEvent,
  type ClinicalIntentCommand,
  type InformationNeed,
  type PatientClinicalMemory,
} from './contracts.js';
import { sha256, uniqueSorted } from './hash.js';

export interface ReductionResult {
  readonly memory: PatientClinicalMemory;
  readonly createdEventIds: readonly string[];
  readonly createdNeedIds: readonly string[];
  readonly createdUnresolvedReportIds: readonly string[];
  readonly createdReviewItemIds: readonly string[];
}

export function eventIdForCommand(commandId: string): string {
  return `event-${sha256(commandId).slice(0, 24)}`;
}

/**
 * Wave 1a deadlock expiry (owner-approved): an asked need expires after this many SUBSTANTIVE
 * processed inbound turns since its origin turn. Substantive = the turn's committed receipt
 * recorded at least one event, need, unresolved report, or review item; fragments ("ok",
 * "thanks") do not advance the countdown. The contract has no clock — turn distance over the
 * monotonic receipt order is the only axis, paired with the snapshot's today-only day boundary.
 */
export const ASKED_NEED_EXPIRY_SUBSTANTIVE_TURNS = 3;

/**
 * An expired need still resolves from a late clear answer until this many substantive turns
 * have been processed AFTER the turn that expired it; beyond that it is inert history.
 */
export const EXPIRED_NEED_ANSWER_GRACE_TURNS = 1;

/** A committed-turn receipt that recorded at least one event, need, report, or review item. */
export function isSubstantiveReceipt(
  receipt: PatientClinicalMemory['processedBatches'][number],
): boolean {
  return (
    receipt.eventIds.length +
      receipt.needIds.length +
      receipt.unresolvedReportIds.length +
      receipt.reviewItemIds.length >
    0
  );
}

/**
 * Substantive committed turns strictly after the receipt of `sourceInboundMessageId`.
 * Infinity when that receipt has rolled out of the bounded receipt window (ancient history).
 */
export function substantiveProcessedTurnsSince(
  memory: PatientClinicalMemory,
  sourceInboundMessageId: string,
): number {
  const receipts = memory.processedBatches;
  const originIndex = receipts.findIndex(
    ({ sourceMessageId }) => sourceMessageId === sourceInboundMessageId,
  );
  if (originIndex === -1) return Number.POSITIVE_INFINITY;
  return receipts.slice(originIndex + 1).filter(isSubstantiveReceipt).length;
}

/** True while a late clear answer may still resolve this expired need. */
export function isExpiredNeedWithinAnswerGrace(
  memory: PatientClinicalMemory,
  need: InformationNeed,
): boolean {
  return (
    need.state === 'expired' &&
    need.expiredAtInboundMessageId !== undefined &&
    substantiveProcessedTurnsSince(memory, need.expiredAtInboundMessageId) <
      EXPIRED_NEED_ANSWER_GRACE_TURNS
  );
}

function successorNeedId(needId: string, commandId: string): string {
  return `need-${sha256({ needId, commandId }).slice(0, 24)}`;
}

function activeNeed(need: InformationNeed): boolean {
  return need.state === 'open' || need.state === 'asked';
}

function assertNever(value: never): never {
  void value;
  throw new Error('clinical_command_unhandled');
}

function needSatisfiedByEvent(
  need: InformationNeed,
  target: ClinicalEvent,
  event: ClinicalEvent,
): boolean {
  if (need.field === 'medication_identity') return event.medicationId !== undefined;
  if (need.field === 'dose_identity') return event.doseId !== undefined;
  if (need.field === 'symptom_identity') return event.symptomConcept != null;
  if (need.field === 'severity') return event.severity !== undefined;
  if (need.field === 'actual_time') return event.exactTime !== undefined;
  if (need.field === 'duration') return event.duration !== undefined;
  if (need.field === 'body_site') return event.bodySite !== undefined;
  if (need.field === 'frequency') return event.frequency !== undefined;
  // Wave 1e context-battery fields.
  if (need.field === 'onset') return event.onset !== undefined;
  if (need.field === 'quality') return event.quality !== undefined;
  if (need.field === 'triggers') return event.triggers !== undefined;
  if (need.field === 'associated_symptoms') return event.associatedSymptoms !== undefined;
  if (need.field === 'recurrence_history') return event.recurrenceHistory !== undefined;
  // Wave 1c: late_intent is satisfied only by the specific refine that resolves the dose's
  // adherence (pending-undefined to a definite outcome, or a definite outcome corrected to a
  // different one) — an unrelated refine on the same event (e.g. dose_identity resolving) must
  // carry the need forward instead of silently dropping it.
  if (need.field === 'late_intent') return target.adherence !== event.adherence;
  return false;
}

type CreateReportCommand = Extract<ClinicalIntentCommand, { kind: 'CreateReport' }>;
type ReportMutationCommand = Extract<
  ClinicalIntentCommand,
  { kind: 'RefineReport' | 'CorrectReport' | 'RecordContradiction' }
>;

function administrationValues(
  command: Extract<CreateReportCommand, { eventKind: 'administration' }> | ReportMutationCommand,
) {
  const {
    medicationId,
    medicationVersion,
    doseId,
    doseVersion,
    adherence,
    timing,
    timeText,
    exactTime,
    localDate,
    localTime,
  } = command;
  return {
    ...(medicationId === undefined ? {} : { medicationId }),
    ...(medicationVersion === undefined ? {} : { medicationVersion }),
    ...(doseId === undefined ? {} : { doseId }),
    ...(doseVersion === undefined ? {} : { doseVersion }),
    ...(adherence === undefined ? {} : { adherence }),
    ...(timing === undefined ? {} : { timing }),
    ...(timeText === undefined ? {} : { timeText }),
    ...(exactTime === undefined ? {} : { exactTime }),
    ...(localDate === undefined ? {} : { localDate }),
    ...(localTime === undefined ? {} : { localTime }),
  };
}

function symptomValues(
  command: Extract<CreateReportCommand, { eventKind: 'symptom' }> | ReportMutationCommand,
) {
  const {
    timeText,
    rawSymptom,
    symptomConcept,
    symptomStatus,
    severity,
    duration,
    bodySite,
    frequency,
    onset,
    quality,
    triggers,
    associatedSymptoms,
    recurrenceHistory,
  } = command;
  return {
    ...(timeText === undefined ? {} : { timeText }),
    ...(rawSymptom === undefined ? {} : { rawSymptom }),
    ...(symptomConcept === undefined ? {} : { symptomConcept }),
    ...(symptomStatus === undefined ? {} : { symptomStatus }),
    ...(severity === undefined ? {} : { severity }),
    ...(duration === undefined ? {} : { duration }),
    ...(bodySite === undefined ? {} : { bodySite }),
    ...(frequency === undefined ? {} : { frequency }),
    // Wave 1e context-battery fields.
    ...(onset === undefined ? {} : { onset }),
    ...(quality === undefined ? {} : { quality }),
    ...(triggers === undefined ? {} : { triggers }),
    ...(associatedSymptoms === undefined ? {} : { associatedSymptoms }),
    ...(recurrenceHistory === undefined ? {} : { recurrenceHistory }),
  };
}

function assertTargetValueCompatibility(
  target: ClinicalEvent,
  command: Extract<
    ClinicalIntentCommand,
    { kind: 'RefineReport' | 'CorrectReport' | 'RecordContradiction' }
  >,
): void {
  if (target.kind !== command.targetKind) {
    throw new Error('clinical_intent_target_kind_invalid');
  }
}

function assertValidLineage(memory: PatientClinicalMemory): void {
  const byId = new Map(memory.events.map((event) => [event.id, event]));
  const successorCounts = new Map<string, number>();

  for (const event of memory.events) {
    if (event.supersedesEventId === undefined) continue;
    const parent = byId.get(event.supersedesEventId);
    if (
      parent === undefined ||
      parent.id === event.id ||
      parent.version + 1 !== event.version ||
      parent.kind !== event.kind
    ) {
      throw new Error('clinical_lineage_invalid');
    }
    successorCounts.set(parent.id, (successorCounts.get(parent.id) ?? 0) + 1);
  }

  for (const event of memory.events) {
    const successorCount = successorCounts.get(event.id) ?? 0;
    if (successorCount > 1 || event.current !== (successorCount === 0)) {
      throw new Error('clinical_lineage_invalid');
    }
  }
}

function replaceEvent(
  events: readonly ClinicalEvent[],
  event: ClinicalEvent,
): readonly ClinicalEvent[] {
  return events.map((candidate) => (candidate.id === event.id ? event : candidate));
}

function requireCurrentEvent(
  memory: PatientClinicalMemory,
  targetEventId: string,
  targetEventVersion: number,
): ClinicalEvent {
  const target = memory.events.find(({ id }) => id === targetEventId);
  if (target === undefined || !target.current || target.version !== targetEventVersion) {
    throw new Error('stale_event_target');
  }
  return target;
}

function applySuccessor(
  memory: PatientClinicalMemory,
  command: Extract<ClinicalIntentCommand, { kind: 'RefineReport' | 'CorrectReport' }>,
): { memory: PatientClinicalMemory; eventId: string; needIds: string[] } {
  const target = requireCurrentEvent(memory, command.targetEventId, command.targetEventVersion);
  assertTargetValueCompatibility(target, command);
  if (target.authoredBy !== 'patient' || target.reviewState !== 'unreviewed')
    throw new Error(
      command.kind === 'CorrectReport'
        ? 'report_correction_not_eligible'
        : 'report_refinement_not_eligible',
    );
  const eventId = eventIdForCommand(command.id);
  const values =
    command.targetKind === 'administration'
      ? administrationValues(command)
      : symptomValues(command);
  const resolved = { ...target, ...values };
  const successor: ClinicalEvent = {
    ...resolved,
    id: eventId,
    version: target.version + 1,
    operation: command.kind === 'CorrectReport' ? 'correct' : 'refine',
    current: true,
    canonical:
      resolved.kind === 'symptom' ||
      (resolved.kind === 'administration' &&
        resolved.medicationId !== undefined &&
        resolved.doseId !== undefined &&
        resolved.adherence !== undefined),
    sourceMessageIds: uniqueSorted([
      ...target.sourceMessageIds,
      ...command.sourceSpans.map(({ messageId }) => messageId),
    ]),
    sourceSpans: [...target.sourceSpans, ...command.sourceSpans],
    supersedesEventId: target.id,
  };
  const superseded = { ...target, current: false };
  let needs = memory.needs;
  const createdNeedIds: string[] = [];
  for (const need of memory.needs.filter(
    (candidate) => candidate.targetEventId === target.id && activeNeed(candidate),
  )) {
    const supersededNeeds = needs.map((candidate) =>
      candidate.id === need.id
        ? { ...candidate, version: candidate.version + 1, state: 'superseded' as const }
        : candidate,
    );
    if (needSatisfiedByEvent(need, target, successor)) {
      needs = supersededNeeds;
      continue;
    }
    const replacementId = successorNeedId(need.id, command.id);
    const replacement: InformationNeed = {
      ...need,
      id: replacementId,
      version: 1,
      targetEventId: eventId,
      targetEventVersion: successor.version,
      candidateSymptomEventIds: need.candidateSymptomEventIds.map((candidateId) =>
        candidateId === target.id ? eventId : candidateId,
      ),
      state: need.clarificationAttemptUsed ? 'asked' : 'open',
      supersedesNeedId: need.id,
    };
    needs = [...supersededNeeds, replacement];
    createdNeedIds.push(replacementId);
  }
  return {
    memory: {
      ...memory,
      events: [...replaceEvent(memory.events, superseded), successor],
      needs,
    },
    eventId,
    needIds: createdNeedIds,
  };
}

function updateNeed(
  memory: PatientClinicalMemory,
  needId: string,
  expectedVersion: number,
  state: InformationNeed['state'],
  options: {
    /** Resolve/Decline only: accept an expired need while its answer grace is still open. */
    readonly allowExpiredWithinGrace?: boolean;
    /** Expire only: stamp the inbound turn that expired the need (grace anchor). */
    readonly expiredAtInboundMessageId?: string;
  } = {},
): PatientClinicalMemory {
  const need = memory.needs.find(({ id }) => id === needId);
  const eligible =
    need !== undefined &&
    (activeNeed(need) ||
      (options.allowExpiredWithinGrace === true && isExpiredNeedWithinAnswerGrace(memory, need)));
  if (need === undefined || need.version !== expectedVersion || !eligible) {
    throw new Error('stale_information_need');
  }
  return {
    ...memory,
    needs: memory.needs.map((candidate) =>
      candidate.id === needId
        ? {
            ...candidate,
            version: candidate.version + 1,
            state,
            ...(options.expiredAtInboundMessageId === undefined
              ? {}
              : { expiredAtInboundMessageId: options.expiredAtInboundMessageId }),
          }
        : candidate,
    ),
  };
}

export function reducePatientClinicalMemory(
  untrustedMemory: PatientClinicalMemory,
  untrustedCommands: readonly ClinicalIntentCommand[],
): ReductionResult {
  let memory: PatientClinicalMemory = patientClinicalMemorySchema.parse(untrustedMemory);
  assertValidLineage(memory);
  const commands = untrustedCommands.map((command) => clinicalIntentCommandSchema.parse(command));
  if (new Set(commands.map(({ id }) => id)).size !== commands.length)
    throw new Error('command_id_duplicate');
  const createdEventIds: string[] = [];
  const createdNeedIds: string[] = [];
  const createdUnresolvedReportIds: string[] = [];
  const createdReviewItemIds: string[] = [];

  for (const command of commands) {
    if (command.kind === 'CreateReport') {
      const id = eventIdForCommand(command.id);
      const event: ClinicalEvent = {
        id,
        version: 1,
        kind: command.eventKind,
        operation: 'create',
        authoredBy: 'patient',
        reviewState: 'unreviewed',
        current: true,
        canonical:
          command.eventKind === 'symptom' ||
          (command.medicationId !== undefined &&
            command.doseId !== undefined &&
            command.adherence !== undefined),
        sourceMessageIds: uniqueSorted(command.sourceSpans.map(({ messageId }) => messageId)),
        sourceSpans: command.sourceSpans,
        ...(command.eventKind === 'administration'
          ? administrationValues(command)
          : symptomValues(command)),
      };
      memory = { ...memory, events: [...memory.events, event] };
      createdEventIds.push(id);
      continue;
    }

    if (command.kind === 'RefineReport' || command.kind === 'CorrectReport') {
      const result = applySuccessor(memory, command);
      memory = result.memory;
      createdEventIds.push(result.eventId);
      createdNeedIds.push(...result.needIds);
      continue;
    }

    if (command.kind === 'RecordRecurrence') {
      const target = requireCurrentEvent(memory, command.targetEventId, command.targetEventVersion);
      if (target.kind !== 'symptom' || target.symptomStatus !== 'resolved')
        throw new Error('recurrence_target_not_resolved_symptom');
      const id = eventIdForCommand(command.id);
      const event: ClinicalEvent = {
        id,
        version: 1,
        kind: 'symptom',
        operation: 'recur',
        authoredBy: 'patient',
        reviewState: 'unreviewed',
        current: true,
        canonical: true,
        sourceMessageIds: uniqueSorted(command.sourceSpans.map(({ messageId }) => messageId)),
        sourceSpans: command.sourceSpans,
        rawSymptom: command.rawSymptom,
        symptomConcept: target.symptomConcept ?? null,
        symptomStatus: 'current',
        recurrenceOfEventId: target.id,
        ...(command.bodySite === undefined ? {} : { bodySite: command.bodySite }),
      };
      memory = { ...memory, events: [...memory.events, event] };
      createdEventIds.push(id);
      continue;
    }

    if (command.kind === 'RecordContradiction') {
      const target = requireCurrentEvent(memory, command.targetEventId, command.targetEventVersion);
      assertTargetValueCompatibility(target, command);
      if (target.authoredBy === 'patient' && target.reviewState === 'unreviewed')
        throw new Error('report_contradiction_not_eligible');
      const id = eventIdForCommand(command.id);
      const reviewItemId = `review-${sha256(command.id).slice(0, 24)}`;
      const event: ClinicalEvent = {
        id,
        version: 1,
        kind: 'contradiction',
        operation: 'contradict',
        authoredBy: 'patient',
        reviewState: 'unreviewed',
        current: true,
        canonical: false,
        sourceMessageIds: uniqueSorted(command.sourceSpans.map(({ messageId }) => messageId)),
        sourceSpans: command.sourceSpans,
        contradictionOfEventId: target.id,
        ...(command.targetKind === 'administration'
          ? administrationValues(command)
          : symptomValues(command)),
      };
      memory = {
        ...memory,
        events: [...memory.events, event],
        reviewItems: [
          ...memory.reviewItems,
          {
            id: reviewItemId,
            kind: 'contradiction',
            sourceMessageId: command.sourceMessageId,
            targetEventId: target.id,
            reason: command.reason,
            status: 'open',
          },
        ],
      };
      createdEventIds.push(id);
      createdReviewItemIds.push(reviewItemId);
      continue;
    }

    if (command.kind === 'OpenInformationNeed') {
      if (
        command.field !== 'event_identity' &&
        (command.targetEventId === undefined ||
          command.targetEventVersion === undefined ||
          !memory.events.some(
            ({ id, version, current }) =>
              id === command.targetEventId && version === command.targetEventVersion && current,
          ))
      ) {
        throw new Error('information_need_target_not_current');
      }
      const need: InformationNeed = {
        id: command.needId,
        version: 1,
        originInboundMessageId: command.sourceMessageId,
        originInboundSequence: command.originInboundSequence,
        ...(command.targetEventId === undefined ? {} : { targetEventId: command.targetEventId }),
        ...(command.targetEventVersion === undefined
          ? {}
          : { targetEventVersion: command.targetEventVersion }),
        field: command.field,
        candidateMedicationIds: command.candidateMedicationIds,
        candidateDoseIds: command.candidateDoseIds,
        candidateSymptomEventIds: command.candidateSymptomEventIds,
        candidateHistoricalEventIds: command.candidateHistoricalEventIds,
        candidateHistoricalEvents: command.candidateHistoricalEvents,
        questionId: command.questionId,
        clarificationAttemptUsed: false,
        state: 'open',
        priority: command.priority,
        ...(command.pendingOperation === undefined
          ? {}
          : { pendingOperation: command.pendingOperation }),
      };
      memory = { ...memory, needs: [...memory.needs, need] };
      createdNeedIds.push(need.id);
      continue;
    }

    if (command.kind === 'AskInformationNeed') {
      const need = memory.needs.find(({ id }) => id === command.needId);
      if (memory.needs.some(({ id, state }) => id !== command.needId && state === 'asked'))
        throw new Error('information_need_already_asked');
      if (
        need === undefined ||
        need.version !== command.expectedNeedVersion ||
        need.state !== 'open' ||
        need.clarificationAttemptUsed
      ) {
        throw new Error('information_need_not_askable');
      }
      memory = {
        ...memory,
        needs: memory.needs.map((candidate) =>
          candidate.id === need.id
            ? {
                ...candidate,
                version: candidate.version + 1,
                state: 'asked',
                clarificationAttemptUsed: true,
              }
            : candidate,
        ),
      };
      continue;
    }

    if (command.kind === 'ResolveInformationNeed') {
      memory = updateNeed(memory, command.needId, command.expectedNeedVersion, 'resolved', {
        allowExpiredWithinGrace: true,
      });
      continue;
    }
    if (command.kind === 'DeclineInformationNeed') {
      memory = updateNeed(memory, command.needId, command.expectedNeedVersion, command.outcome, {
        allowExpiredWithinGrace: true,
      });
      continue;
    }
    if (command.kind === 'ExpireInformationNeed') {
      memory = updateNeed(memory, command.needId, command.expectedNeedVersion, 'expired', {
        // Only a stale-question (deadlock) expiry opens the short answer-grace window; an
        // expiry that consumed the one clarification attempt stays terminal.
        ...(command.staleQuestion === true
          ? { expiredAtInboundMessageId: command.sourceMessageId }
          : {}),
      });
      continue;
    }
    if (command.kind === 'SupersedeInformationNeed') {
      memory = updateNeed(memory, command.needId, command.expectedNeedVersion, 'superseded');
      continue;
    }
    if (command.kind === 'PauseRoutineClarification') {
      memory = { ...memory, routineClarificationsPaused: true };
      continue;
    }
    if (command.kind === 'ResumeRoutineClarification') {
      const review = memory.reviewItems.find(({ id }) => id === command.reviewItemId);
      if (
        review?.kind !== 'safety' ||
        review.status !== 'confirmed' ||
        memory.reviewItems.some(({ kind, status }) => kind === 'safety' && status === 'open')
      )
        throw new Error('safety_review_not_closed');
      memory = { ...memory, routineClarificationsPaused: false };
      continue;
    }
    if (command.kind === 'RaiseSafetySignal') {
      const eventId = eventIdForCommand(command.id);
      const reviewItemId = `review-${sha256(command.id).slice(0, 24)}`;
      memory = {
        ...memory,
        routineClarificationsPaused:
          command.safetyTier === 'emergency' || memory.routineClarificationsPaused,
        events: [
          ...memory.events,
          {
            id: eventId,
            version: 1,
            kind: 'safety',
            operation: 'raise_safety',
            authoredBy: 'patient',
            reviewState: 'unreviewed',
            current: true,
            canonical: true,
            sourceMessageIds: uniqueSorted(command.sourceSpans.map(({ messageId }) => messageId)),
            sourceSpans: command.sourceSpans,
            safetyTier: command.safetyTier,
          },
        ],
        reviewItems: [
          ...memory.reviewItems,
          {
            id: reviewItemId,
            kind: 'safety',
            sourceMessageId: command.sourceMessageId,
            reason: command.reason,
            status: 'open',
          },
        ],
      };
      createdEventIds.push(eventId);
      createdReviewItemIds.push(reviewItemId);
      continue;
    }
    if (command.kind === 'PreserveUnresolvedContent') {
      const unresolvedId = `unresolved-${sha256(command.id).slice(0, 24)}`;
      const reviewItemId = `review-${sha256(command.id).slice(0, 24)}`;
      memory = {
        ...memory,
        unresolvedReports: [
          ...memory.unresolvedReports,
          {
            id: unresolvedId,
            reason: command.reason,
            sourceMessageId: command.sourceMessageId,
            sourceSpans: command.sourceSpans,
            candidateMedicationIds: command.candidateMedicationIds,
            candidateDoseIds: command.candidateDoseIds,
            candidateEventIds: command.candidateEventIds,
          },
        ],
        reviewItems: [
          ...memory.reviewItems,
          {
            id: reviewItemId,
            kind:
              command.reason === 'unsupported_language'
                ? 'unsupported_language'
                : 'unresolved_report',
            sourceMessageId: command.sourceMessageId,
            reason: command.reason,
            status: 'open',
          },
        ],
      };
      createdUnresolvedReportIds.push(unresolvedId);
      createdReviewItemIds.push(reviewItemId);
      continue;
    }
    assertNever(command);
  }

  const parsedMemory = patientClinicalMemorySchema.parse(memory);
  assertValidLineage(parsedMemory);
  return {
    memory: parsedMemory,
    createdEventIds,
    createdNeedIds,
    createdUnresolvedReportIds,
    createdReviewItemIds,
  };
}
