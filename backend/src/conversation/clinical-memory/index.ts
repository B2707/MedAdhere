import {
  clinicalRuntimeFailureSchema,
  clinicalIntentCommandSchema,
  LABEL_REQUIRED_NEED_FIELDS,
  MAX_RECENT_COMMAND_BATCHES,
  patientClinicalMemorySchema,
  patientClinicalSnapshotSchema,
  preparedClinicalTurnSchema,
  type ClinicalIntentCommand,
  type ClinicalClaimInput,
  type ClinicalResponsePlan,
  type ClinicalRuntimeFailure,
  type PatientClinicalMemory,
  type PatientClinicalSnapshot,
  type PreparedClinicalTurn,
} from './contracts.js';
import { ZodError } from 'zod';
import { sha256 } from './hash.js';
import {
  askCommand,
  expireStaleAskedNeedCommands,
  resolveClinicalClaims,
  selectQuestion,
} from './resolver.js';
import {
  isSubstantiveReceipt,
  reducePatientClinicalMemory,
  type ReductionResult,
} from './reducer.js';
import { renderClinicalResponse } from './response.js';
import { validateExtractedClaims } from './source-validation.js';
import { boundedClaimExtractionSchema, type BoundedClaimExtraction } from './bounded-provider.js';

export * from './contracts.js';
export {
  ASKED_NEED_EXPIRY_SUBSTANTIVE_TURNS,
  EXPIRED_NEED_ANSWER_GRACE_TURNS,
  isExpiredNeedWithinAnswerGrace,
  substantiveProcessedTurnsSince,
} from './reducer.js';
export { reducePatientClinicalMemory, renderClinicalResponse };
export type { ReductionResult };

export interface CommittedClinicalTurn extends ReductionResult {
  readonly prepared: PreparedClinicalTurn;
}

const EXTRACTION_FAILURE_REASONS = new Set([
  'claim_slot_duplicate',
  'claim_target_missing',
  'claim_semantic_duplicate',
  'claim_information_need_relationship_invalid',
  'claim_information_need_relationship_conflict',
  'question_target_label_missing',
  'quote_not_exact',
  'quote_not_unique',
  'source_field_mismatch',
]);

function preserveWholeMessage(
  snapshot: PatientClinicalSnapshot,
  reason: string,
): ClinicalIntentCommand {
  const intent = {
    kind: 'PreserveUnresolvedContent' as const,
    sourceMessageId: snapshot.inboundMessage.id,
    sourceSpans: [
      {
        messageId: snapshot.inboundMessage.id,
        start: 0,
        end: snapshot.inboundMessage.body.length,
        quote: snapshot.inboundMessage.body,
      },
    ],
    reason,
    candidateMedicationIds: [],
    candidateDoseIds: [],
    candidateEventIds: [],
  };
  return clinicalIntentCommandSchema.parse({
    ...intent,
    id: `command-${sha256(intent).slice(0, 24)}`,
  });
}

function finalizePreparedTurn(
  snapshot: PatientClinicalSnapshot,
  commands: readonly ClinicalIntentCommand[],
  responsePlan: ClinicalResponsePlan,
  runtimeFailure?: ClinicalRuntimeFailure,
  recordOnly = false,
): PreparedClinicalTurn {
  const commandHash = sha256(commands);
  const integrity = {
    patientId: snapshot.memory.patientId,
    idempotencyKey: snapshot.inboundMessage.id,
    sourceMessageId: snapshot.inboundMessage.id,
    sourceSequence: snapshot.inboundMessage.sequence,
    baseMemoryVersion: snapshot.memory.version,
    consentEpoch: snapshot.consentEpoch,
    contextHash: snapshot.contextHash,
    pipelineVersions: snapshot.pipelineVersions,
    commands,
    commandHash,
    responsePlan,
    responseText: renderClinicalResponse(responsePlan),
    ...(runtimeFailure === undefined ? {} : { runtimeFailure }),
    ...(recordOnly ? { recordOnly: true as const } : {}),
  };
  return preparedClinicalTurnSchema.parse({ ...integrity, preparedHash: sha256(integrity) });
}

/**
 * Builds the response-plan question payload for a need, resolving the target label from the
 * provisional memory. Returns undefined when a label-required field has no derivable label —
 * the fresh-ask branch treats that as a hard defect, the re-ask branch falls back to a plain
 * acknowledgement.
 */
function questionPayload(
  snapshot: PatientClinicalSnapshot,
  provisional: PatientClinicalMemory,
  need: NonNullable<ReturnType<typeof selectQuestion>>,
): NonNullable<ClinicalResponsePlan['question']> | undefined {
  const targetEvent = provisional.events.find(({ id }) => id === need.targetEventId);
  const targetDose = snapshot.doses.find(({ id }) => id === targetEvent?.doseId);
  const targetMedication = snapshot.medications.find(({ id }) => id === targetEvent?.medicationId);
  const medicationLabel = targetMedication?.names[0];
  const doseLabel = targetDose?.label;
  const administrationLabel =
    medicationLabel !== undefined && doseLabel !== undefined
      ? doseLabel.toLocaleLowerCase('en-US').includes(medicationLabel.toLocaleLowerCase('en-US'))
        ? doseLabel
        : `${medicationLabel} ${doseLabel}`
      : undefined;
  const symptomLabel =
    targetEvent?.kind === 'symptom'
      ? snapshot.symptomConcepts.find((concept) => concept === targetEvent.symptomConcept)
      : undefined;
  const targetLabel = targetEvent?.kind === 'administration' ? administrationLabel : symptomLabel;
  if (LABEL_REQUIRED_NEED_FIELDS.includes(need.field) && targetLabel === undefined) {
    return undefined;
  }
  return {
    needId: need.id,
    eventId: need.targetEventId,
    field: need.field,
    questionId: need.questionId,
    ...(targetLabel === undefined ? {} : { targetLabel }),
  };
}

/** The pending question a restate is bound to: one restate per need, one per prompted dose. */
function pendingReaskKey(pendingReask: NonNullable<ClinicalResponsePlan['pendingReask']>): string {
  return pendingReask.kind === 'need' ? pendingReask.needId : pendingReask.doseId;
}

/**
 * Lane Q (2026-08-17 live incident) — RE-ASK ROUTE: the pending question a turn with no new
 * clinical content should restate instead of a dead-end reply, priority-ordered per the owner
 * spec — an asked information need first, else an unanswered scheduled dose check-in (a
 * prompted check-in is never an InformationNeed record, so it is read straight off
 * `snapshot.promptedDoseId`, never through the need/reducer machinery). Bounded to ONCE per
 * pending question: a committed reply that restated it stored that question's identity on its
 * receipt (`pendingReaskKey`), so the bound is per-episode — tomorrow's check-in for the same
 * medication is a different doseId and gets its own single restate, while a run of failing turns
 * inside one episode never repeats it. Response-plan-only: no new state, no reducer command.
 *
 * SAFETY: nothing routine is ever restated while an emergency safety pause is unresolved — the
 * same durable invariant selectQuestion enforces, kept here (the single choke point every
 * caller routes through) so a future caller cannot reintroduce the bypass.
 */
function selectPendingReask(
  snapshot: PatientClinicalSnapshot,
  memory: PatientClinicalMemory,
): NonNullable<ClinicalResponsePlan['pendingReask']> | undefined {
  if (memory.routineClarificationsPaused) return undefined;
  const alreadyRestated = (key: string): boolean =>
    memory.processedBatches.some((receipt) => receipt.pendingReaskKey === key);
  const askedNeed = memory.needs.find(({ state }) => state === 'asked');
  if (askedNeed !== undefined) {
    const question = questionPayload(snapshot, memory, askedNeed);
    // Label-required field with no derivable label: no restate available. An asked need in
    // scope always takes priority even when unlabelable — it does NOT fall through to the
    // prompted-dose fallback (mirrors the pre-existing question.reask branch's own behavior).
    if (question === undefined) return undefined;
    return alreadyRestated(askedNeed.id)
      ? undefined
      : {
          kind: 'need' as const,
          needId: askedNeed.id,
          field: question.field,
          ...(question.targetLabel === undefined ? {} : { targetLabel: question.targetLabel }),
        };
  }
  const doseId = snapshot.promptedDoseId;
  if (doseId === undefined || alreadyRestated(doseId)) return undefined;
  const dose = snapshot.doses.find(({ id }) => id === doseId);
  const medication = snapshot.medications.find(({ id }) => id === dose?.medicationId);
  const medicationLabel = medication?.names[0];
  if (medicationLabel === undefined) return undefined;
  return { kind: 'prompted_dose' as const, doseId, medicationLabel };
}

/**
 * Wave 1a batch coherence (specified derivation, not an assumed read): the surviving turn of a
 * drained burst reads the suppressed record-only turns' COMMITTED outcomes from their
 * processedBatches receipts. unresolvedReportIds surface here as repeated review reasons;
 * their eventIds and needIds are already part of memory, so the single acknowledgement and
 * selectQuestion cover the whole burst — one reply that addresses every rapid message.
 */
function suppressedBurstReviewReasons(snapshot: PatientClinicalSnapshot): string[] {
  const burstIds = snapshot.suppressedBurstInboundMessageIds ?? [];
  if (burstIds.length === 0) return [];
  const burstSources = new Set(burstIds);
  const unresolvedIds = new Set(
    snapshot.memory.processedBatches
      .filter(({ sourceMessageId }) => burstSources.has(sourceMessageId))
      .flatMap(({ unresolvedReportIds }) => unresolvedReportIds),
  );
  return snapshot.memory.unresolvedReports
    .filter(({ id }) => unresolvedIds.has(id))
    .map(({ reason }) => reason);
}

/**
 * Wave 1a batch coherence: true when any suppressed burst turn COMMITTED clinical content
 * (events, needs, reports, or review items). The survivor's one reply covers the whole burst,
 * so a patient who just reported doses must hear "recorded", never the orientation blurb —
 * even when the surviving fragment itself carries nothing.
 */
function suppressedBurstHasClinicalAction(snapshot: PatientClinicalSnapshot): boolean {
  const burstIds = new Set(snapshot.suppressedBurstInboundMessageIds ?? []);
  if (burstIds.size === 0) return false;
  return snapshot.memory.processedBatches.some(
    (receipt) => burstIds.has(receipt.sourceMessageId) && isSubstantiveReceipt(receipt),
  );
}

export function validatePreparedClinicalTurn(
  untrustedPrepared: PreparedClinicalTurn,
): PreparedClinicalTurn {
  const prepared = preparedClinicalTurnSchema.parse(untrustedPrepared);
  const { preparedHash, ...integrity } = prepared;
  if (
    sha256(prepared.commands) !== prepared.commandHash ||
    sha256(integrity) !== preparedHash ||
    renderClinicalResponse(prepared.responsePlan) !== prepared.responseText ||
    prepared.commands.some(({ id, ...intent }) => id !== `command-${sha256(intent).slice(0, 24)}`)
  ) {
    throw new Error('prepared_batch_integrity_error');
  }
  return prepared;
}

/** Returns false when deterministic snapshot authority must bypass the clinical extractor. */
export function requiresBoundedClinicalExtraction(
  untrustedSnapshot: PatientClinicalSnapshot,
): boolean {
  const snapshot = patientClinicalSnapshotSchema.parse(untrustedSnapshot);
  return (
    snapshot.exactControl !== 'STOP' &&
    !snapshot.emergencyPrefilter &&
    snapshot.consentEpoch === snapshot.expectedConsentEpoch &&
    (snapshot.expectedMemoryVersion === undefined ||
      snapshot.memory.version === snapshot.expectedMemoryVersion) &&
    snapshot.languageDisposition === 'english' &&
    snapshot.temporalProvenanceIssue === undefined
  );
}

export function prepareClinicalTurn(
  untrustedSnapshot: PatientClinicalSnapshot,
  untrustedClaims: readonly ClinicalClaimInput[],
): PreparedClinicalTurn {
  const snapshot = patientClinicalSnapshotSchema.parse(untrustedSnapshot);
  let commands: ClinicalIntentCommand[] = [];
  let responsePlan: ClinicalResponsePlan;
  let recordOnly = false;
  if (snapshot.exactControl === 'STOP') {
    responsePlan = { kind: 'stop', reviewReasons: [] };
  } else if (snapshot.emergencyPrefilter) {
    const sourceSpans = [
      {
        messageId: snapshot.inboundMessage.id,
        start: 0,
        end: snapshot.inboundMessage.body.length,
        quote: snapshot.inboundMessage.body,
      },
    ];
    const intents = [
      {
        kind: 'RaiseSafetySignal' as const,
        sourceMessageId: snapshot.inboundMessage.id,
        sourceSpans,
        safetyTier: 'emergency' as const,
        reason: 'deterministic_emergency_prefilter',
      },
      {
        kind: 'PauseRoutineClarification' as const,
        sourceMessageId: snapshot.inboundMessage.id,
        sourceSpans,
        reason: 'emergency_safety_pause',
      },
      {
        kind: 'PreserveUnresolvedContent' as const,
        sourceMessageId: snapshot.inboundMessage.id,
        sourceSpans,
        reason: 'emergency_content_not_extracted',
        candidateMedicationIds: [],
        candidateDoseIds: [],
        candidateEventIds: [],
      },
    ];
    commands = intents.map((intent) =>
      clinicalIntentCommandSchema.parse({
        ...intent,
        id: `command-${sha256(intent).slice(0, 24)}`,
      }),
    );
    responsePlan = { kind: 'emergency', reviewReasons: ['emergency_safety_pause'] };
  } else if (
    snapshot.consentEpoch !== snapshot.expectedConsentEpoch ||
    (snapshot.expectedMemoryVersion !== undefined &&
      snapshot.memory.version !== snapshot.expectedMemoryVersion)
  ) {
    responsePlan = { kind: 'stale_snapshot', reviewReasons: [] };
  } else if (snapshot.temporalProvenanceIssue === 'scheduled_dose_timezone_mismatch') {
    commands = [preserveWholeMessage(snapshot, 'clinical_context_changed')];
    responsePlan = { kind: 'human_review', reviewReasons: ['clinical_context_changed'] };
  } else if (snapshot.languageDisposition !== 'english') {
    const sourceSpan = {
      messageId: snapshot.inboundMessage.id,
      start: 0,
      end: snapshot.inboundMessage.body.length,
      quote: snapshot.inboundMessage.body,
    };
    const intent = {
      kind: 'PreserveUnresolvedContent' as const,
      sourceMessageId: snapshot.inboundMessage.id,
      sourceSpans: [sourceSpan],
      reason: 'unsupported_language',
      candidateMedicationIds: [],
      candidateDoseIds: [],
      candidateEventIds: [],
    };
    commands = [
      clinicalIntentCommandSchema.parse({
        ...intent,
        id: `command-${sha256(intent).slice(0, 24)}`,
      }),
    ];
    responsePlan = { kind: 'unsupported_language', reviewReasons: ['unsupported_language'] };
  } else {
    try {
      const claims = validateExtractedClaims(snapshot.inboundMessage, untrustedClaims);
      commands = resolveClinicalClaims(snapshot, claims);
      // Deadlock expiry runs against the provisional state of this turn's own resolution so a
      // need this turn already transitioned is never double-bumped.
      const preExpiry = reducePatientClinicalMemory(snapshot.memory, commands).memory;
      commands = [...commands, ...expireStaleAskedNeedCommands(snapshot, preExpiry)];
      const provisional = reducePatientClinicalMemory(snapshot.memory, commands).memory;
      if (provisional.routineClarificationsPaused) {
        responsePlan = { kind: 'emergency', reviewReasons: ['emergency_safety_pause'] };
      } else {
        // Wave 1a chat-style batching: a newer inbound message already exists, so this turn
        // records its claims but asks nothing and its reply is terminal from birth — the
        // surviving turn covers the whole burst with one reply.
        recordOnly = snapshot.newerInboundExists === true;
        const newUnresolvedReasons = provisional.unresolvedReports
          .slice(snapshot.memory.unresolvedReports.length)
          .map(({ reason }) => reason);
        const reviewReasons = [
          ...(recordOnly ? [] : suppressedBurstReviewReasons(snapshot)),
          ...newUnresolvedReasons,
        ];
        const need = recordOnly
          ? undefined
          : selectQuestion(provisional, snapshot.contextQuestionPreference);
        if (need !== undefined) {
          commands = [...commands, askCommand(snapshot, need)];
          const question = questionPayload(snapshot, provisional, need);
          if (question === undefined) throw new Error('question_target_label_missing');
          responsePlan = {
            kind: 'question',
            acknowledgementId: 'acknowledgement-recorded',
            question,
            reviewReasons,
          };
        } else {
          // Re-ask (response-plan-only): a question asked on an earlier turn is still pending,
          // so repeat it WITHOUT any reducer command. A label-required field whose label is no
          // longer derivable falls back to a plain acknowledgement, never to human review.
          // Only clean turns re-ask: a turn whose own resolution produced review-bound
          // unresolved content (e.g. a failed disambiguation answer, frozen matrix pin) keeps
          // the routine reply instead of hammering the identical question.
          const askedNeed =
            recordOnly || newUnresolvedReasons.length > 0
              ? undefined
              : provisional.needs.find(({ state }) => state === 'asked');
          const reask =
            askedNeed === undefined ? undefined : questionPayload(snapshot, provisional, askedNeed);
          if (reask !== undefined) {
            responsePlan = {
              kind: 'question',
              acknowledgementId: 'acknowledgement-recorded',
              question: { ...reask, reask: true },
              reviewReasons,
            };
          } else {
            const isOrientationEligible =
              commands.length === 0 &&
              reviewReasons.length === 0 &&
              !suppressedBurstHasClinicalAction(snapshot);
            // Lane Q — RE-ASK ROUTE (a): no asked need to restate (or the burst produced review
            // content — selectPendingReask only ever fires on the same orientation-eligible
            // condition, never otherwise). A genuinely content-free turn still owes an answer to
            // an unanswered scheduled dose check-in — restate it instead of the content-free
            // orientation reply. NEVER on a record-only turn: that reply is terminal from birth,
            // so restating there would burn the once-per-question bound on a message the patient
            // never receives and leave the surviving turn with nothing to ask.
            const promptedDoseReask =
              !recordOnly && askedNeed === undefined && isOrientationEligible
                ? selectPendingReask(snapshot, provisional)
                : undefined;
            if (promptedDoseReask?.kind === 'prompted_dose') {
              responsePlan = { kind: 'routine', reviewReasons, pendingReask: promptedDoseReask };
            } else if (isOrientationEligible) {
              // Orientation: neither this message nor its suppressed burst produced clinical
              // action — orient the patient instead of implying something was recorded.
              responsePlan = {
                kind: 'routine',
                acknowledgementId: 'acknowledgement-orientation',
                reviewReasons,
              };
            } else {
              responsePlan = {
                kind: 'routine',
                acknowledgementId: 'acknowledgement-recorded',
                reviewReasons,
              };
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('stale_')) throw error;
      const reason =
        error instanceof Error && EXTRACTION_FAILURE_REASONS.has(error.message)
          ? error.message
          : error instanceof ZodError
            ? 'extraction_validation_failed'
            : undefined;
      if (reason === undefined) throw error;
      commands = [preserveWholeMessage(snapshot, reason)];
      // Lane Q — RE-ASK ROUTE (b): a terminal extraction failure still owes the patient whatever
      // question was already pending — response.ts appends the restate to this truthful
      // saved-for-doctor sentence when it fits. Never on a record-only turn (a newer inbound is
      // already waiting; the surviving turn covers the restate). Memory has not advanced this
      // turn (claims/resolution failed before any provisional state), so the snapshot's own
      // memory is the correct, authoritative read.
      const pendingReask =
        snapshot.newerInboundExists === true
          ? undefined
          : selectPendingReask(snapshot, snapshot.memory);
      responsePlan = {
        kind: 'human_review',
        reviewReasons: [reason],
        ...(pendingReask === undefined ? {} : { pendingReask }),
      };
      recordOnly = false;
    }
  }
  return finalizePreparedTurn(snapshot, commands, responsePlan, undefined, recordOnly);
}

/** Uses the same strict provider-source binding for production and offline evaluation. */
/**
 * Deterministic prompted-check-in shortcut: when a dose was prompted ("Reply YES or NO") and the
 * whole inbound message is a bare yes/no answer, the administration claim is synthesized here —
 * the model is never consulted, so the reply is fast and the outcome is replayable. Returns null
 * whenever the message says anything more than a bare confirmation.
 */
export function syntheticPromptedConfirmationClaims(
  untrustedSnapshot: PatientClinicalSnapshot,
): readonly ClinicalClaimInput[] | null {
  const snapshot = patientClinicalSnapshotSchema.parse(untrustedSnapshot);
  if (
    snapshot.promptedDoseId === undefined ||
    !snapshot.doses.some(({ id }) => id === snapshot.promptedDoseId)
  ) {
    return null;
  }
  const body = snapshot.inboundMessage.body.trim();
  const normalized = body
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
  const taken = /^(?:yes|yeah|yep|yup|y|i did|did|done|took it|i took it)$/u.test(normalized);
  // The not-taken family is classified downstream by the resolver's bare-confirmation
  // split (W0.3): no/nope/nah/n -> missed; the not-yet family -> pending.
  const notTaken = /^(?:no|nope|nah|n|not yet|no not yet|i have not|i haven t)$/u.test(normalized);
  if (!taken && !notTaken) return null;
  return [
    {
      slot: 'prompted-check-in-confirmation',
      quote: body,
      polarity: notTaken ? 'negative' : 'positive',
      experiencer: 'patient',
      status: 'current',
      certainty: 'certain',
      kind: 'administration',
      actionText: body,
    },
  ];
}

export function clinicalClaimsFromBoundedExtraction(
  untrustedSnapshot: PatientClinicalSnapshot,
  untrustedExtraction: BoundedClaimExtraction,
): readonly ClinicalClaimInput[] {
  const snapshot = patientClinicalSnapshotSchema.parse(untrustedSnapshot);
  const extraction = boundedClaimExtractionSchema.parse(untrustedExtraction);
  return extraction.claims.map(({ sourceMessageId, informationNeedId, claim }) => {
    if (sourceMessageId !== snapshot.inboundMessage.id) {
      throw new Error('Provider claim source does not match the clinical snapshot');
    }
    return informationNeedId === null ? claim : { claim, informationNeedId };
  });
}

/** Converts an allowlisted runtime failure into one deterministic, review-visible prepared batch. */
export function prepareClinicalFailureTurn(
  untrustedSnapshot: PatientClinicalSnapshot,
  untrustedFailure: ClinicalRuntimeFailure,
): PreparedClinicalTurn {
  const snapshot = patientClinicalSnapshotSchema.parse(untrustedSnapshot);
  const runtimeFailure = clinicalRuntimeFailureSchema.parse(untrustedFailure);
  if (
    snapshot.exactControl === 'STOP' ||
    snapshot.emergencyPrefilter ||
    snapshot.consentEpoch !== snapshot.expectedConsentEpoch ||
    (snapshot.expectedMemoryVersion !== undefined &&
      snapshot.memory.version !== snapshot.expectedMemoryVersion) ||
    snapshot.languageDisposition !== 'english'
  ) {
    const dominant = prepareClinicalTurn(snapshot, []);
    return finalizePreparedTurn(snapshot, dominant.commands, dominant.responsePlan, runtimeFailure);
  }
  const commands = [preserveWholeMessage(snapshot, runtimeFailure)];
  // Lane Q — RE-ASK ROUTE (b): this is the exact 2026-08-17 live-incident path (malformed_output
  // / budget_exhausted) — a direct patient question ("what was your question") must not be met
  // with a plain saved-for-doctor dead end while a scheduled dose check-in (or an asked
  // information need) is still unanswered. Identical rule to the extraction-failure catch block
  // in prepareClinicalTurn above; never on a record-only turn.
  const pendingReask =
    snapshot.newerInboundExists === true
      ? undefined
      : selectPendingReask(snapshot, snapshot.memory);
  return finalizePreparedTurn(
    snapshot,
    commands,
    {
      kind: 'human_review',
      reviewReasons: [runtimeFailure],
      ...(pendingReask === undefined ? {} : { pendingReask }),
    },
    runtimeFailure,
  );
}

export function applyPreparedClinicalTurn(
  untrustedMemory: PatientClinicalMemory,
  untrustedPrepared: PreparedClinicalTurn,
): CommittedClinicalTurn {
  const memory = patientClinicalMemorySchema.parse(untrustedMemory);
  const prepared = validatePreparedClinicalTurn(untrustedPrepared);
  if (memory.patientId !== prepared.patientId) throw new Error('prepared_patient_mismatch');
  if (prepared.responsePlan.kind === 'stale_snapshot') throw new Error('stale_snapshot');
  const receipt = memory.processedBatches.find(
    ({ idempotencyKey }) => idempotencyKey === prepared.idempotencyKey,
  );
  if (receipt !== undefined) {
    if (
      receipt.commandHash !== prepared.commandHash ||
      receipt.preparedHash !== prepared.preparedHash
    )
      throw new Error('prepared_batch_integrity_error');
    return {
      memory,
      createdEventIds: receipt.eventIds,
      createdNeedIds: receipt.needIds,
      createdUnresolvedReportIds: receipt.unresolvedReportIds,
      createdReviewItemIds: receipt.reviewItemIds,
      prepared,
    };
  }
  if (memory.version !== prepared.baseMemoryVersion) throw new Error('stale_memory_version');
  const reduction = reducePatientClinicalMemory(memory, prepared.commands);
  const resultVersion = memory.version + 1;
  return {
    ...reduction,
    memory: patientClinicalMemorySchema.parse({
      ...reduction.memory,
      version: resultVersion,
      processedBatches: [
        ...reduction.memory.processedBatches,
        {
          idempotencyKey: prepared.idempotencyKey,
          sourceMessageId: prepared.sourceMessageId,
          commandHash: prepared.commandHash,
          preparedHash: prepared.preparedHash,
          baseVersion: prepared.baseMemoryVersion,
          resultVersion,
          eventIds: reduction.createdEventIds,
          needIds: reduction.createdNeedIds,
          unresolvedReportIds: reduction.createdUnresolvedReportIds,
          reviewItemIds: reduction.createdReviewItemIds,
          responseText: prepared.responseText,
          ...(prepared.responsePlan.pendingReask === undefined
            ? {}
            : { pendingReaskKey: pendingReaskKey(prepared.responsePlan.pendingReask) }),
        },
      ].slice(-MAX_RECENT_COMMAND_BATCHES),
    }),
    prepared,
  };
}
