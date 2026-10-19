import {
  clinicalIntentCommandSchema,
  CONTEXT_BATTERY_FIELDS,
  type ClinicalEvent,
  type ClinicalIntentCommand,
  type InformationNeed,
  type NeedField,
  type PatientClinicalMemory,
  type PatientClinicalSnapshot,
  type SourceSpan,
  type ValidatedClaim,
} from './contracts.js';
import { sha256, uniqueSorted } from './hash.js';
import {
  ASKED_NEED_EXPIRY_SUBSTANTIVE_TURNS,
  eventIdForCommand,
  isExpiredNeedWithinAnswerGrace,
  reducePatientClinicalMemory,
  substantiveProcessedTurnsSince,
} from './reducer.js';

const NEED_PRIORITY: Readonly<Record<NeedField, number>> = {
  medication_identity: 100,
  dose_identity: 90,
  event_identity: 110,
  symptom_identity: 80,
  severity: 70,
  // Wave 1e: the NEW context-battery fields (onset/quality/triggers/associated_symptoms/
  // recurrence_history) rank strictly between severity and actual_time — symptom
  // characterization (the whole point of this battery) outranks dose logistics, the same
  // healthcare-gate rule that already places severity above actual_time/late_intent. Order
  // within the battery follows typical clinical questioning (onset first, recurrence history
  // last) — it is only the FALLBACK order (selectQuestion's preferredField overrides it when
  // valid); it does not change duration/body_site/frequency, which stay at their pinned Wave
  // 1c values below dose logistics.
  onset: 69,
  quality: 68,
  triggers: 67,
  associated_symptoms: 66,
  recurrence_history: 65,
  actual_time: 60,
  // Wave 1c: strictly below actual_time — symptom characterization outranks dose logistics
  // (healthcare gate) — but still asked ahead of the lower-value symptom detail fields.
  late_intent: 50,
  duration: 30,
  body_site: 20,
  frequency: 10,
};

/** Wave 1e stop rule: never ask more than this many context-battery questions per episode. */
const CONTEXT_BATTERY_MAX_QUESTIONS = 4;

const CONTEXT_BATTERY_FIELD_SET: ReadonlySet<NeedField> = new Set(CONTEXT_BATTERY_FIELDS);

/**
 * The fields the stop rule and the per-episode cap SPAN — the whole symptom bank, not just the
 * five NEW fields. severity is the bank's "strength" category and carries the HIGHEST priority
 * of the set (70, above every context field), so it is the question actually asked FIRST:
 * excluding it meant an "idk" on the one question the patient answers first stopped nothing and
 * the patient got interrogated across four more turns, and it made the real per-episode ceiling
 * severity + 4 = 5 questions instead of the planned 4. Deliberately NOT the same set as
 * CONTEXT_BATTERY_FIELD_SET above: severity keeps its strict pinned 1-10 bank wording and is
 * never AI-authorable or AI-reorderable.
 */
const CONTEXT_BATTERY_EPISODE_FIELD_SET: ReadonlySet<NeedField> = new Set<NeedField>([
  ...CONTEXT_BATTERY_FIELDS,
  'severity',
]);

/** Deterministic field order the battery opens needs in, highest-priority first (mirrors NEED_PRIORITY). */
const CONTEXT_BATTERY_FIELD_ORDER: readonly NeedField[] = [
  'onset',
  'quality',
  'triggers',
  'associated_symptoms',
  'recurrence_history',
];

/**
 * Maps a NeedField to its ClinicalEvent property name (snake_case -> camelCase). Single
 * source for the two need/event naming schemes — used both to read a context-battery
 * field's current value off an event and to write a generic need_answer's answer text back.
 */
function needFieldEventKey(field: NeedField): string {
  if (field === 'body_site') return 'bodySite';
  if (field === 'associated_symptoms') return 'associatedSymptoms';
  if (field === 'recurrence_history') return 'recurrenceHistory';
  return field;
}

function contextBatteryEventValue(event: ClinicalEvent, field: NeedField): string | undefined {
  const value = (event as unknown as Record<string, unknown>)[needFieldEventKey(field)];
  return typeof value === 'string' ? value : undefined;
}

/** All event ids in a symptom event's version lineage, walking supersedesEventId back to the root. */
function symptomEventLineageIds(
  events: readonly ClinicalEvent[],
  eventId: string,
): ReadonlySet<string> {
  const byId = new Map(events.map((event) => [event.id, event]));
  const ids = new Set<string>();
  let cursor = byId.get(eventId);
  while (cursor !== undefined && !ids.has(cursor.id)) {
    ids.add(cursor.id);
    cursor =
      cursor.supersedesEventId === undefined ? undefined : byId.get(cursor.supersedesEventId);
  }
  return ids;
}

/** Every context-battery need ever opened anywhere in a symptom event's lineage. */
function contextBatteryLineageNeeds(
  needs: readonly InformationNeed[],
  lineageIds: ReadonlySet<string>,
): InformationNeed[] {
  return needs.filter(
    (need) =>
      need.targetEventId !== undefined &&
      lineageIds.has(need.targetEventId) &&
      CONTEXT_BATTERY_EPISODE_FIELD_SET.has(need.field),
  );
}

/**
 * Wave 1e stop rule: any non-answer (expiry), "I don't know" (patient_does_not_know), or
 * decline anywhere in the lineage ends the WHOLE battery permanently — not just the one
 * field that was asked. Terminal states only; 'superseded' is a normal answered transition,
 * not a stop.
 */
function contextBatteryStoppedForLineage(lineageNeeds: readonly InformationNeed[]): boolean {
  return lineageNeeds.some(
    (need) =>
      need.state === 'declined' ||
      need.state === 'patient_does_not_know' ||
      need.state === 'expired',
  );
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

/**
 * Past-tense administration wording inside a late_intent answer — see the late_intent branch of
 * resolveNeedAnswer. Matched against `normalize`d text, so apostrophes are already spaces
 * ("didn't" -> "didn t"). Deliberately narrow: this only decides "is this still a plain forward
 * intent?", never what the dose's outcome actually is.
 */
const LATE_INTENT_TAKEN_ANSWER = /\b(?:took|taken|swallowed)\b/u;
const LATE_INTENT_NEGATED = /\b(?:not|never|didn t|haven t|hasn t|wasn t|isn t|won t|can t)\b/u;

function isSupportedActualTime(value: string): boolean {
  return /^(?:(?:around|about|approximately)\s+)?(?:(?:[01]?\d|2[0-3]):[0-5]\d|(?:1[0-2]|[1-9])(?:\s*(?:a\.?m\.?|p\.?m\.?))?|noon|midnight)$/iu.test(
    value.trim(),
  );
}

function embeddedActualTime(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const matches = value.match(
    /\b(?:(?:around|about|approximately)\s+)?(?:(?:[01]?\d|2[0-3]):[0-5]\d|(?:1[0-2]|[1-9])\s*(?:a\.?m\.?|p\.?m\.?)|noon|midnight)\b/giu,
  );
  if (matches === null) return undefined;
  const unique = [...new Set(matches.map((match) => match.trim()))];
  return unique.length === 1 ? unique[0] : undefined;
}

function makeCommand(
  intent: Omit<ClinicalIntentCommand, 'id'> | Record<string, unknown>,
): ClinicalIntentCommand {
  return clinicalIntentCommandSchema.parse({
    ...intent,
    id: `command-${sha256(intent).slice(0, 24)}`,
  });
}

function unresolved(
  sourceMessageId: string,
  sourceSpans: readonly SourceSpan[],
  reason: string,
  candidates: {
    readonly medicationIds?: readonly string[];
    readonly doseIds?: readonly string[];
    readonly eventIds?: readonly string[];
  } = {},
): ClinicalIntentCommand {
  return makeCommand({
    kind: 'PreserveUnresolvedContent',
    sourceMessageId,
    sourceSpans,
    reason,
    candidateMedicationIds: uniqueSorted(candidates.medicationIds ?? []),
    candidateDoseIds: uniqueSorted(candidates.doseIds ?? []),
    candidateEventIds: uniqueSorted(candidates.eventIds ?? []),
  });
}

function medicationCandidates(
  snapshot: PatientClinicalSnapshot,
  text: string | undefined,
): string[] {
  if (text === undefined)
    return snapshot.medications
      .filter(({ active }) => active)
      .map(({ id }) => id)
      .sort();
  const wanted = normalize(text);
  return snapshot.medications
    .filter(
      ({ active, names, aliases }) =>
        active && [...names, ...aliases].some((candidate) => normalize(candidate) === wanted),
    )
    .map(({ id }) => id)
    .sort();
}

function oneEditApart(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  let edits = 0;
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return edits + Number(leftIndex < left.length || rightIndex < right.length) <= 1;
}

function nearMedicationCandidates(
  snapshot: PatientClinicalSnapshot,
  text: string | undefined,
): string[] {
  if (text === undefined) return [];
  const wanted = normalize(text);
  return snapshot.medications
    .filter(
      ({ active, names }) =>
        active && names.some((candidate) => oneEditApart(normalize(candidate), wanted)),
    )
    .map(({ id }) => id)
    .sort();
}

function symptomMatches(event: ClinicalEvent, text: string | undefined): boolean {
  if (event.kind !== 'symptom' || !event.current) return false;
  if (text === undefined) return true;
  const wanted = normalize(text);
  return (
    normalize(event.symptomConcept ?? '') === wanted || normalize(event.rawSymptom ?? '') === wanted
  );
}

interface ResolvedTarget {
  readonly id: string;
  readonly version: number;
  readonly kind: ClinicalEvent['kind'];
  readonly authoredBy: ClinicalEvent['authoredBy'];
  readonly reviewState: ClinicalEvent['reviewState'];
  readonly medicationId?: string;
  readonly localDate?: string;
  readonly symptomStatus?: ClinicalEvent['symptomStatus'];
  readonly bodySite?: string;
}

function detailValues(
  claim: Extract<ValidatedClaim, { kind: 'symptom_detail' }>,
): Record<string, unknown> {
  if (claim.detailField === 'status') return { symptomStatus: claim.status };
  if (claim.detailField === 'body_site') return { bodySite: claim.detailText };
  return { [claim.detailField]: claim.detailText };
}

function actionAdherence(actionText: string | undefined): 'taken' | 'missed' | undefined {
  if (actionText === undefined) return undefined;
  const action = normalize(actionText);
  if (
    /\b(?:missed|skipped|forgot|did not take|didn t take|have not taken|haven t taken)\b/u.test(
      action,
    )
  )
    return 'missed';
  if (/\b(?:took|taken|did take)\b/u.test(action)) return 'taken';
  return undefined;
}

/**
 * A bare confirmation is meaningful ONLY against a prompted dose: the check-in itself asked
 * "Reply YES or NO", so an anchored whole-answer yes/no is the patient answering that question.
 * Never applied when the message names a medication or no dose was prompted.
 *
 * W0.3 split: a flat "No" is a reported miss, but the not-yet family is 'pending' —
 * the patient has not decided the dose outcome, so no adherence is recorded until a
 * later message resolves it either way.
 */
function bareConfirmationAdherence(
  actionText: string | undefined,
): 'taken' | 'missed' | 'pending' | undefined {
  if (actionText === undefined) return undefined;
  const action = normalize(actionText);
  if (/^(?:yes|yeah|yep|yup|y|i did|did|done|took it|i took it)$/u.test(action)) return 'taken';
  if (/^(?:no|nope|nah|n)$/u.test(action)) return 'missed';
  if (/^(?:not yet|no not yet|i have not|i haven t)$/u.test(action)) return 'pending';
  return undefined;
}

function correctionValues(
  snapshot: PatientClinicalSnapshot,
  claim: Extract<ValidatedClaim, { kind: 'correction' }>,
  target?: Pick<ResolvedTarget, 'kind' | 'medicationId' | 'localDate'>,
):
  | { readonly values: Record<string, unknown> }
  | {
      readonly reason: string;
      readonly medicationIds: readonly string[];
      readonly doseIds: readonly string[];
    } {
  if (
    claim.doseText !== undefined &&
    claim.medicationText === undefined &&
    (target?.kind !== 'administration' || target.medicationId === undefined)
  ) {
    return { reason: 'correction_dose_unresolved', medicationIds: [], doseIds: [] };
  }
  if (claim.timeText !== undefined && target?.kind !== 'administration') {
    return { reason: 'correction_time_unresolved', medicationIds: [], doseIds: [] };
  }
  const medicationIds =
    claim.medicationText === undefined ? [] : medicationCandidates(snapshot, claim.medicationText);
  if (claim.medicationText !== undefined && medicationIds.length !== 1) {
    return {
      reason: 'correction_medication_unresolved',
      medicationIds,
      doseIds: [],
    };
  }
  const medicationId = medicationIds[0] ?? target?.medicationId;
  const medication = snapshot.medications.find(({ id }) => id === medicationId);
  const changesMedication =
    claim.medicationText !== undefined && medicationId !== target?.medicationId;
  const resolvesDose =
    target?.kind === 'administration' && (changesMedication || claim.doseText !== undefined);
  const explicitDate =
    claim.timeText !== undefined && /^\d{4}-\d{2}-\d{2}$/u.test(claim.timeText)
      ? claim.timeText
      : undefined;
  if (
    explicitDate !== undefined &&
    target?.localDate !== undefined &&
    explicitDate !== target.localDate
  ) {
    return {
      reason: 'correction_time_unresolved',
      medicationIds: medication === undefined ? [] : [medication.id],
      doseIds: [],
    };
  }
  const exactTime = explicitDate === undefined ? embeddedActualTime(claim.timeText) : undefined;
  if (claim.timeText !== undefined && explicitDate === undefined && exactTime === undefined) {
    return {
      reason: 'correction_time_unresolved',
      medicationIds: medication === undefined ? [] : [medication.id],
      doseIds: [],
    };
  }
  const compatibleDate = target?.localDate ?? explicitDate;
  const doses = resolvesDose
    ? snapshot.doses.filter(
        (dose) =>
          medication !== undefined &&
          dose.medicationId === medication.id &&
          (claim.doseText === undefined || normalize(dose.label) === normalize(claim.doseText)) &&
          (compatibleDate === undefined || dose.localDate === compatibleDate),
      )
    : [];
  if (resolvesDose && doses.length !== 1) {
    return {
      reason: 'correction_dose_unresolved',
      medicationIds: medication === undefined ? [] : [medication.id],
      doseIds: doses.map(({ id }) => id),
    };
  }
  const adherence = actionAdherence(claim.actionText);
  if (claim.actionText !== undefined && adherence === undefined) {
    return {
      reason: 'correction_action_unresolved',
      medicationIds,
      doseIds: doses.map(({ id }) => id),
    };
  }
  if (
    claim.actionText !== undefined &&
    /\b(?:half|partial|partially|partly|stopped|stop taking|stopped taking)\b/iu.test(
      claim.actionText,
    )
  ) {
    return {
      reason: 'correction_action_noncounting',
      medicationIds,
      doseIds: doses.map(({ id }) => id),
    };
  }
  if (
    !changesMedication &&
    !resolvesDose &&
    adherence === undefined &&
    claim.symptomText === undefined &&
    claim.timeText === undefined
  ) {
    return { reason: 'correction_values_unresolved', medicationIds: [], doseIds: [] };
  }
  const symptomConcept =
    claim.symptomText === undefined
      ? undefined
      : snapshot.symptomConcepts.find(
          (candidate) => normalize(candidate) === normalize(claim.symptomText!),
        );
  return {
    values: {
      ...((!changesMedication && !resolvesDose) || medication === undefined
        ? {}
        : { medicationId: medication.id, medicationVersion: medication.version }),
      ...(doses.length === 1
        ? {
            doseId: doses[0]!.id,
            doseVersion: doses[0]!.version,
            localDate: doses[0]!.localDate,
            localTime: doses[0]!.localTime,
          }
        : {}),
      ...(adherence === undefined ? {} : { adherence }),
      ...(claim.symptomText === undefined
        ? {}
        : { rawSymptom: claim.symptomText, symptomConcept: symptomConcept ?? null }),
      ...(claim.timeText === undefined
        ? {}
        : explicitDate === undefined
          ? { exactTime, timeText: claim.timeText }
          : { timeText: claim.timeText }),
    },
  };
}

function correctionChanges(
  values: Readonly<Record<string, unknown>>,
): Extract<NonNullable<InformationNeed['pendingOperation']>, { kind: 'correct' }>['changes'] {
  type CorrectionChange = Extract<
    NonNullable<InformationNeed['pendingOperation']>,
    { kind: 'correct' }
  >['changes'][number];
  const changes: CorrectionChange[] = [];
  if (values.adherence === 'taken' || values.adherence === 'missed')
    changes.push({ kind: 'set_adherence', value: values.adherence });
  if (
    typeof values.medicationId === 'string' &&
    typeof values.medicationVersion === 'number' &&
    typeof values.doseId === 'string' &&
    typeof values.doseVersion === 'number' &&
    typeof values.localDate === 'string' &&
    typeof values.localTime === 'string'
  )
    changes.push({
      kind: 'set_medication_dose',
      medicationId: values.medicationId,
      medicationVersion: values.medicationVersion,
      doseId: values.doseId,
      doseVersion: values.doseVersion,
      localDate: values.localDate,
      localTime: values.localTime,
    });
  if (
    typeof values.rawSymptom === 'string' &&
    (typeof values.symptomConcept === 'string' || values.symptomConcept === null)
  )
    changes.push({
      kind: 'set_symptom_identity',
      rawSymptom: values.rawSymptom,
      symptomConcept: values.symptomConcept,
    });
  return changes;
}

function valuesFromCorrectionChanges(
  changes: Extract<
    NonNullable<InformationNeed['pendingOperation']>,
    { kind: 'correct' }
  >['changes'],
): Record<string, unknown> {
  return Object.assign(
    {},
    ...changes.map((change) =>
      change.kind === 'set_adherence'
        ? { adherence: change.value }
        : change.kind === 'set_medication_dose'
          ? {
              medicationId: change.medicationId,
              medicationVersion: change.medicationVersion,
              doseId: change.doseId,
              doseVersion: change.doseVersion,
              localDate: change.localDate,
              localTime: change.localTime,
            }
          : { rawSymptom: change.rawSymptom, symptomConcept: change.symptomConcept },
    ),
  );
}

function claimTarget(
  snapshot: PatientClinicalSnapshot,
  claim: ValidatedClaim,
  sameMessageTargets: ReadonlyMap<string, ResolvedTarget>,
): ResolvedTarget | undefined {
  if ('targetSemanticId' in claim && claim.targetSemanticId !== undefined) {
    const target = sameMessageTargets.get(claim.targetSemanticId);
    if (target !== undefined) return target;
    return undefined;
  }
  const matches = historicalTargets(snapshot, claim);
  const match = matches.length === 1 ? matches[0] : undefined;
  return match === undefined
    ? undefined
    : {
        id: match.id,
        version: match.version,
        kind: match.kind,
        authoredBy: match.authoredBy,
        reviewState: match.reviewState,
        ...(match.medicationId === undefined ? {} : { medicationId: match.medicationId }),
        ...(match.localDate === undefined ? {} : { localDate: match.localDate }),
        ...(match.symptomStatus === undefined ? {} : { symptomStatus: match.symptomStatus }),
        ...(match.bodySite === undefined ? {} : { bodySite: match.bodySite }),
      };
}

function historicalTargets(
  snapshot: PatientClinicalSnapshot,
  claim: ValidatedClaim,
): ClinicalEvent[] {
  const targetText = 'targetText' in claim ? claim.targetText : undefined;
  return snapshot.memory.events.filter((event) => {
    if (!event.current) return false;
    if (targetText === undefined) return true;
    if (event.kind === 'symptom') return symptomMatches(event, targetText);
    const medication = snapshot.medications.find(({ id }) => id === event.medicationId);
    return (
      medication !== undefined &&
      [...medication.names, ...medication.aliases].some(
        (candidate) => normalize(candidate) === normalize(targetText),
      )
    );
  });
}

function historicalTargetQuestion(
  snapshot: PatientClinicalSnapshot,
  candidates: readonly ClinicalEvent[],
  pendingOperation: NonNullable<InformationNeed['pendingOperation']>,
): ClinicalIntentCommand {
  const compatibleCandidates = candidates.filter((candidate) => {
    if (pendingOperation.kind === 'recur') return candidate.kind === 'symptom';
    return pendingOperation.changes.every((change) =>
      change.kind === 'set_symptom_identity'
        ? candidate.kind === 'symptom'
        : candidate.kind === 'administration' &&
          (change.kind !== 'set_medication_dose' || change.localDate === candidate.localDate),
    );
  });
  const candidateHistoricalEvents = compatibleCandidates
    .map(({ id, version }) => ({ eventId: id, eventVersion: version }))
    .sort(
      (left, right) =>
        left.eventId.localeCompare(right.eventId) || left.eventVersion - right.eventVersion,
    );
  const needId = `need-${sha256({
    field: 'event_identity',
    candidateHistoricalEvents,
    pendingOperation,
  }).slice(0, 24)}`;
  return makeCommand({
    kind: 'OpenInformationNeed',
    sourceMessageId: snapshot.inboundMessage.id,
    sourceSpans: pendingOperation.sourceSpans,
    needId,
    originInboundSequence: snapshot.inboundMessage.sequence,
    field: 'event_identity',
    candidateMedicationIds: [],
    candidateDoseIds: [],
    candidateSymptomEventIds: [],
    candidateHistoricalEventIds: [],
    candidateHistoricalEvents,
    questionId: `question-${sha256({ needId, candidateHistoricalEvents }).slice(0, 24)}`,
    priority: NEED_PRIORITY.event_identity,
    pendingOperation,
  });
}

function historicalAnswerKeys(
  snapshot: PatientClinicalSnapshot,
  event: ClinicalEvent,
): readonly string[] {
  const keys = [event.localDate, event.bodySite, event.symptomConcept, event.rawSymptom];
  if (event.localDate !== undefined) {
    const [year, month, day] = event.localDate.split('-').map(Number);
    const monthName = [
      'january',
      'february',
      'march',
      'april',
      'may',
      'june',
      'july',
      'august',
      'september',
      'october',
      'november',
      'december',
    ][(month ?? 0) - 1];
    if (year !== undefined && monthName !== undefined && day !== undefined) {
      keys.push(`${monthName} ${day}`, `${monthName} ${day} ${year}`);
    }
  }
  const medication = snapshot.medications.find(({ id }) => id === event.medicationId);
  if (medication !== undefined) keys.push(...medication.names, ...medication.aliases);
  const dose = snapshot.doses.find(({ id }) => id === event.doseId);
  if (dose !== undefined) keys.push(dose.label);
  return keys.flatMap((key) => (key == null ? [] : [normalize(key)]));
}

function resolveAdministration(
  snapshot: PatientClinicalSnapshot,
  claim: Extract<ValidatedClaim, { kind: 'administration' }>,
): {
  commands: ClinicalIntentCommand[];
  eventId?: string;
  eventVersion?: number;
  medicationId?: string;
  localDate?: string;
} {
  const base = { sourceMessageId: snapshot.inboundMessage.id, sourceSpans: [claim.sourceSpan] };
  if (claim.certainty !== 'certain') {
    return {
      commands: [unresolved(base.sourceMessageId, base.sourceSpans, 'uncertain_administration')],
    };
  }
  if (claim.experiencer !== 'patient') {
    return {
      commands: [unresolved(base.sourceMessageId, base.sourceSpans, 'non_patient_experiencer')],
    };
  }
  if (
    claim.status === 'resolved' ||
    claim.status === 'future' ||
    claim.status === 'habitual' ||
    claim.status === 'hypothetical'
  ) {
    return {
      commands: [
        unresolved(base.sourceMessageId, base.sourceSpans, 'non_completed_administration'),
      ],
    };
  }
  if (
    claim.status === 'historical' &&
    (claim.timeText === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(claim.timeText))
  ) {
    return {
      commands: [
        unresolved(base.sourceMessageId, base.sourceSpans, 'historical_event_date_unresolved'),
      ],
    };
  }
  if (
    /\b(?:half|partial|partially|partly|refuse|refused|stopped|stop taking|stopped taking)\b/iu.test(
      claim.actionText,
    )
  ) {
    return {
      commands: [
        unresolved(base.sourceMessageId, base.sourceSpans, 'non_counting_medication_change'),
      ],
    };
  }
  const promptedBare =
    claim.medicationText === undefined &&
    snapshot.doses.some(({ id }) => id === snapshot.promptedDoseId)
      ? bareConfirmationAdherence(claim.actionText)
      : undefined;
  const explicitOutcome = actionAdherence(claim.actionText);
  const pendingConfirmation = explicitOutcome === undefined && promptedBare === 'pending';
  const adherence = explicitOutcome ?? (promptedBare === 'pending' ? undefined : promptedBare);
  const explicitNegativeNonAdministration =
    /\b(?:did not|didn t) take\b/u.test(normalize(claim.actionText)) ||
    promptedBare === 'missed' ||
    pendingConfirmation;
  if (
    (adherence === undefined && !pendingConfirmation) ||
    (claim.polarity === 'negative' &&
      !((adherence === 'missed' || pendingConfirmation) && explicitNegativeNonAdministration))
  ) {
    return {
      commands: [
        unresolved(base.sourceMessageId, base.sourceSpans, 'administration_action_unresolved'),
      ],
    };
  }

  const exactMedicationIds =
    claim.medicationText === undefined && snapshot.promptedDoseId === undefined
      ? []
      : medicationCandidates(snapshot, claim.medicationText);
  const suggestedMedicationIds =
    exactMedicationIds.length === 0 ? nearMedicationCandidates(snapshot, claim.medicationText) : [];
  const promptedDose = snapshot.doses.find(({ id }) => id === snapshot.promptedDoseId);
  if (
    claim.medicationText !== undefined &&
    promptedDose !== undefined &&
    exactMedicationIds.length === 1 &&
    exactMedicationIds[0] !== promptedDose.medicationId
  ) {
    return {
      commands: [
        unresolved(base.sourceMessageId, base.sourceSpans, 'prompted_dose_medication_mismatch', {
          medicationIds: exactMedicationIds,
          doseIds: [promptedDose.id],
        }),
      ],
    };
  }

  const medicationIds =
    claim.medicationText === undefined && promptedDose !== undefined
      ? [promptedDose.medicationId]
      : exactMedicationIds;
  const candidateMedicationIds =
    medicationIds.length === 0 ? suggestedMedicationIds : medicationIds;
  const medicationId = medicationIds.length === 1 ? medicationIds[0] : undefined;
  const explicitDate = /^\d{4}-\d{2}-\d{2}$/u.test(claim.timeText ?? '')
    ? claim.timeText
    : undefined;
  const frozenCandidateDoseIds = snapshot.doses
    .filter(
      ({ medicationId: candidateMedicationId, localDate }) =>
        candidateMedicationIds.includes(candidateMedicationId) &&
        (explicitDate === undefined || localDate === explicitDate),
    )
    .map(({ id }) => id);
  const allDoseCandidates = snapshot.doses.filter(
    (dose) =>
      dose.medicationId === medicationId &&
      (explicitDate === undefined || dose.localDate === explicitDate),
  );
  const doseText = claim.doseText === undefined ? undefined : normalize(claim.doseText);
  const matchingDoses =
    doseText !== undefined
      ? allDoseCandidates.filter(({ label }) => normalize(label) === doseText)
      : promptedDose !== undefined && allDoseCandidates.some(({ id }) => id === promptedDose.id)
        ? [promptedDose]
        : allDoseCandidates;
  const dose = matchingDoses.length === 1 ? matchingDoses[0] : undefined;
  const medication = snapshot.medications.find(({ id }) => id === medicationId);
  const timing =
    claim.timeText !== undefined && /\blate\b/iu.test(claim.timeText) ? 'late' : undefined;
  const exactTime = embeddedActualTime(claim.timeText);
  const create = makeCommand({
    ...base,
    kind: 'CreateReport',
    eventKind: 'administration',
    ...(medication === undefined
      ? {}
      : { medicationId: medication.id, medicationVersion: medication.version }),
    ...(dose === undefined
      ? {}
      : {
          doseId: dose.id,
          doseVersion: dose.version,
          localDate: dose.localDate,
          localTime: dose.localTime,
        }),
    ...(adherence === undefined ? {} : { adherence }),
    ...(timing === undefined ? {} : { timing }),
    ...(exactTime === undefined ? {} : { exactTime }),
    ...(claim.timeText === undefined ? {} : { timeText: claim.timeText }),
  });
  const existing =
    dose === undefined
      ? undefined
      : snapshot.memory.events.find(
          (event) =>
            event.current &&
            // W0.3: the pending "not yet" record is non-canonical (adherence undefined)
            // and must be found here so the later message resolves it instead of
            // creating a duplicate administration for the same dose.
            (event.canonical || event.adherence === undefined) &&
            event.kind === 'administration' &&
            event.doseId === dose.id &&
            event.localDate === dose.localDate,
        );
  if (existing !== undefined) {
    const refinable = existing.authoredBy === 'patient' && existing.reviewState === 'unreviewed';
    if (refinable && existing.adherence === undefined && adherence !== undefined) {
      // W0.3: the later dose resolution closes the pending record either way.
      const refine = makeCommand({
        ...base,
        kind: 'RefineReport',
        targetEventId: existing.id,
        targetEventVersion: existing.version,
        targetKind: 'administration',
        adherence,
        ...(timing === undefined ? {} : { timing }),
        ...(exactTime === undefined ? {} : { exactTime }),
        ...(claim.timeText === undefined ? {} : { timeText: claim.timeText }),
      });
      return {
        commands: [refine],
        eventId: eventIdForCommand(refine.id),
        eventVersion: existing.version + 1,
        medicationId: existing.medicationId,
        localDate: existing.localDate,
      };
    }
    if (refinable && adherence !== undefined && existing.adherence === adherence) {
      const refine = makeCommand({
        ...base,
        kind: 'RefineReport',
        targetEventId: existing.id,
        targetEventVersion: existing.version,
        targetKind: 'administration',
        adherence,
      });
      return {
        commands: [refine],
        eventId: eventIdForCommand(refine.id),
        eventVersion: existing.version + 1,
        medicationId: existing.medicationId,
        localDate: existing.localDate,
      };
    }
    return {
      commands: [
        unresolved(base.sourceMessageId, base.sourceSpans, 'duplicate_administration_conflict', {
          eventIds: [existing.id],
        }),
      ],
    };
  }
  const eventId = eventIdForCommand(create.id);
  const commands: ClinicalIntentCommand[] = [];
  if (medicationId === undefined) {
    const reason =
      medicationIds.length > 1
        ? 'medication_ambiguous'
        : suggestedMedicationIds.length > 0
          ? 'medication_candidate_only'
          : 'medication_unresolved';
    commands.push(create);
    if (candidateMedicationIds.length > 0) {
      commands.push(
        openNeedCommand(
          snapshot,
          {
            id: eventId,
            version: 1,
            kind: 'administration',
            operation: 'create',
            authoredBy: 'patient',
            reviewState: 'unreviewed',
            current: true,
            canonical: false,
            sourceMessageIds: [base.sourceMessageId],
            sourceSpans: base.sourceSpans,
            adherence,
          },
          'medication_identity',
          { medicationIds: candidateMedicationIds, doseIds: frozenCandidateDoseIds },
        ),
      );
    }
    commands.push(
      unresolved(base.sourceMessageId, base.sourceSpans, reason, {
        medicationIds: candidateMedicationIds,
      }),
    );
  } else if (matchingDoses.length > 1) {
    commands.push(create);
    commands.push(
      openNeedCommand(
        snapshot,
        {
          id: eventId,
          version: 1,
          kind: 'administration',
          operation: 'create',
          authoredBy: 'patient',
          reviewState: 'unreviewed',
          current: true,
          canonical: false,
          sourceMessageIds: [base.sourceMessageId],
          sourceSpans: base.sourceSpans,
          medicationId,
          medicationVersion: medication?.version,
          adherence,
        },
        'dose_identity',
        {
          medicationIds: [medicationId],
          doseIds: matchingDoses.map(({ id }) => id),
        },
      ),
    );
    commands.push(
      unresolved(base.sourceMessageId, base.sourceSpans, 'dose_ambiguous', {
        medicationIds: [medicationId],
        doseIds: matchingDoses.map(({ id }) => id),
      }),
    );
  } else if (dose === undefined) {
    commands.push(
      unresolved(base.sourceMessageId, base.sourceSpans, 'dose_unresolved', {
        medicationIds: [medicationId],
      }),
    );
  } else {
    commands.push(create);
  }
  return {
    commands,
    ...(commands.some(({ kind }) => kind === 'CreateReport')
      ? {
          eventId,
          eventVersion: 1,
          ...(medicationId === undefined ? {} : { medicationId }),
          ...(dose?.localDate === undefined ? {} : { localDate: dose.localDate }),
        }
      : {}),
  };
}

function resolveSymptom(
  snapshot: PatientClinicalSnapshot,
  claim: Extract<ValidatedClaim, { kind: 'symptom' }>,
): {
  commands: ClinicalIntentCommand[];
  eventId?: string;
  eventVersion?: number;
  medicationId?: string;
  localDate?: string;
} {
  const base = { sourceMessageId: snapshot.inboundMessage.id, sourceSpans: [claim.sourceSpan] };
  if (claim.experiencer !== 'patient') {
    return {
      commands: [unresolved(base.sourceMessageId, base.sourceSpans, 'non_patient_experiencer')],
    };
  }
  if (claim.polarity !== 'positive') {
    return {
      commands: [unresolved(base.sourceMessageId, base.sourceSpans, 'non_positive_symptom')],
    };
  }
  if (
    claim.certainty !== 'certain' ||
    claim.status === 'hypothetical' ||
    claim.status === 'future' ||
    claim.status === 'habitual'
  ) {
    return {
      commands: [unresolved(base.sourceMessageId, base.sourceSpans, 'non_current_symptom')],
    };
  }
  const concept = snapshot.symptomConcepts.find(
    (candidate) => normalize(candidate) === normalize(claim.symptomText),
  );
  const identityNeeds = snapshot.memory.needs.filter(
    (need) => activeNeed(need) && need.field === 'symptom_identity',
  );
  if (
    concept !== undefined &&
    identityNeeds.length === 1 &&
    (claim.targetSemanticId !== undefined ||
      normalize(claim.quote) === normalize(claim.symptomText))
  ) {
    const need = identityNeeds[0]!;
    const target = snapshot.memory.events.find(
      ({ id, version, current }) =>
        id === need.targetEventId && version === need.targetEventVersion && current,
    );
    if (target !== undefined && target.kind === 'symptom') {
      const refine = makeCommand({
        ...base,
        kind: 'RefineReport',
        targetEventId: target.id,
        targetEventVersion: target.version,
        targetKind: 'symptom',
        symptomConcept: concept,
      });
      return {
        commands: [
          makeCommand({
            ...base,
            kind: 'ResolveInformationNeed',
            needId: need.id,
            expectedNeedVersion: need.version,
          }),
          refine,
        ],
        eventId: eventIdForCommand(refine.id),
        eventVersion: target.version + 1,
      };
    }
  }
  if (claim.status === 'resolved') {
    const targets = snapshot.memory.events.filter(
      (event) =>
        symptomMatches(event, claim.symptomText) &&
        event.symptomStatus !== 'resolved' &&
        (claim.bodySiteText === undefined ||
          normalize(event.bodySite ?? '') === normalize(claim.bodySiteText)) &&
        (claim.timeText === undefined ||
          normalize(event.timeText ?? '') === normalize(claim.timeText)),
    );
    if (targets.length !== 1) {
      return {
        commands: [
          unresolved(base.sourceMessageId, base.sourceSpans, 'resolved_symptom_target_unresolved', {
            eventIds: targets.map(({ id }) => id),
          }),
        ],
      };
    }
    const target = targets[0]!;
    const protectedTarget = target.authoredBy !== 'patient' || target.reviewState !== 'unreviewed';
    return {
      commands: [
        makeCommand({
          ...base,
          kind: protectedTarget ? 'RecordContradiction' : 'RefineReport',
          targetEventId: target.id,
          targetEventVersion: target.version,
          targetKind: 'symptom',
          ...(protectedTarget ? { reason: 'protected_record_contradiction' } : {}),
          symptomStatus: 'resolved',
        }),
      ],
    };
  }
  if (/\b(?:still|ongoing|continues|continuing)\b/iu.test(claim.quote)) {
    const targets = snapshot.memory.events.filter(
      (event) =>
        symptomMatches(event, claim.symptomText) &&
        event.symptomStatus === 'current' &&
        (claim.bodySiteText === undefined ||
          normalize(event.bodySite ?? '') === normalize(claim.bodySiteText)),
    );
    const target = targets.length === 1 ? targets[0] : undefined;
    if (
      target === undefined ||
      target.authoredBy !== 'patient' ||
      target.reviewState !== 'unreviewed'
    ) {
      return {
        commands: [
          unresolved(base.sourceMessageId, base.sourceSpans, 'symptom_continuation_unresolved', {
            eventIds: targets.map(({ id }) => id),
          }),
        ],
      };
    }
    const refine = makeCommand({
      ...base,
      kind: 'RefineReport',
      targetEventId: target.id,
      targetEventVersion: target.version,
      targetKind: 'symptom',
      symptomStatus: 'current',
    });
    return {
      commands: [refine],
      eventId: eventIdForCommand(refine.id),
      eventVersion: target.version + 1,
    };
  }
  const create = makeCommand({
    ...base,
    kind: 'CreateReport',
    eventKind: 'symptom',
    rawSymptom: claim.symptomText,
    symptomConcept: concept ?? null,
    symptomStatus: claim.status === 'historical' ? 'historical' : 'current',
    ...(claim.bodySiteText === undefined ? {} : { bodySite: claim.bodySiteText }),
    ...(claim.timeText === undefined ? {} : { timeText: claim.timeText }),
  });
  return { commands: [create], eventId: eventIdForCommand(create.id), eventVersion: 1 };
}

function resolveNeedAnswer(
  snapshot: PatientClinicalSnapshot,
  claim: Extract<ValidatedClaim, { kind: 'need_answer' }>,
): ClinicalIntentCommand[] {
  const base = { sourceMessageId: snapshot.inboundMessage.id, sourceSpans: [claim.sourceSpan] };
  const folded = normalize(claim.answerText);
  const doesNotKnow = /^(?:i )?(?:don t know|do not know|not sure|unsure)$/u.test(folded);
  const declines = /\b(?:rather not|prefer not|don t want|do not want)\b/u.test(folded);
  if (
    claim.experiencer !== 'patient' ||
    claim.polarity !== 'positive' ||
    claim.status !== 'current' ||
    (claim.certainty !== 'certain' && !doesNotKnow)
  ) {
    return [unresolved(base.sourceMessageId, base.sourceSpans, 'need_answer_ineligible')];
  }
  const currentlyAskedNeeds = snapshot.memory.needs.filter(
    (need) => need.state === 'asked' && need.field === claim.answerField,
  );
  // Wave 1a grace: when nothing is asked for this field, a recently EXPIRED need still accepts
  // a late clear answer instead of misrouting it as a new topic. Asked needs always win.
  const askedNeeds =
    currentlyAskedNeeds.length > 0
      ? currentlyAskedNeeds
      : snapshot.memory.needs.filter(
          (need) =>
            need.field === claim.answerField &&
            isExpiredNeedWithinAnswerGrace(snapshot.memory, need),
        );
  const needs =
    claim.informationNeedId === undefined
      ? (() => {
          const scopeMatches =
            doesNotKnow || declines
              ? askedNeeds
              : askedNeeds.filter((need) => {
                  if (need.field === 'event_identity')
                    return (need.candidateHistoricalEvents ?? []).some(
                      ({ eventId, eventVersion }) => {
                        const event = snapshot.memory.events.find(
                          (candidate) =>
                            candidate.id === eventId &&
                            candidate.version === eventVersion &&
                            candidate.current,
                        );
                        return (
                          event !== undefined &&
                          historicalAnswerKeys(snapshot, event).includes(folded)
                        );
                      },
                    );
                  if (need.field === 'medication_identity')
                    return medicationCandidates(snapshot, claim.answerText).some((id) =>
                      need.candidateMedicationIds.includes(id),
                    );
                  if (need.field === 'dose_identity')
                    return snapshot.doses.some(
                      ({ id, label }) =>
                        need.candidateDoseIds.includes(id) && normalize(label) === folded,
                    );
                  return true;
                });
          return scopeMatches.length === 0 && askedNeeds.length === 1 ? askedNeeds : scopeMatches;
        })()
      : askedNeeds.filter(({ id }) => id === claim.informationNeedId);
  if (needs.length !== 1) {
    return [
      unresolved(base.sourceMessageId, base.sourceSpans, 'pending_target_ambiguous', {
        eventIds: askedNeeds.flatMap(({ targetEventId }) =>
          targetEventId === undefined ? [] : [targetEventId],
        ),
      }),
    ];
  }
  const need = needs[0]!;
  // An expired-in-grace need must never receive a second state bump (Expire/Supersede) — its
  // failure paths fall through to the unresolved report alone.
  const needIsExpired = need.state === 'expired';
  if (doesNotKnow) {
    return [
      makeCommand({
        ...base,
        kind: 'DeclineInformationNeed',
        needId: need.id,
        expectedNeedVersion: need.version,
        outcome: 'patient_does_not_know',
      }),
    ];
  }
  if (declines) {
    return [
      makeCommand({
        ...base,
        kind: 'DeclineInformationNeed',
        needId: need.id,
        expectedNeedVersion: need.version,
        outcome: 'declined',
      }),
    ];
  }
  if (need.field === 'event_identity') {
    const pending = need.pendingOperation;
    const candidates = need.candidateHistoricalEvents;
    if (pending === undefined || candidates === undefined)
      throw new Error('event_identity_scope_invalid');
    const matches = candidates
      .map(({ eventId, eventVersion }) =>
        snapshot.memory.events.find(
          (event) => event.id === eventId && event.version === eventVersion && event.current,
        ),
      )
      .filter((event): event is ClinicalEvent => event !== undefined)
      .filter((event) => historicalAnswerKeys(snapshot, event).includes(folded));
    const target = matches.length === 1 ? matches[0] : undefined;
    const eligible =
      target !== undefined &&
      (pending.kind === 'correct'
        ? pending.changes.every((change) =>
            change.kind === 'set_symptom_identity'
              ? target.kind === 'symptom'
              : target.kind === 'administration' &&
                (change.kind !== 'set_medication_dose' || change.localDate === target.localDate),
          )
        : target.kind === 'symptom' && target.symptomStatus === 'resolved');
    if (!eligible || target === undefined) {
      return [
        ...(needIsExpired
          ? []
          : [
              makeCommand({
                ...base,
                kind: 'ExpireInformationNeed',
                needId: need.id,
                expectedNeedVersion: need.version,
              }),
            ]),
        unresolved(base.sourceMessageId, base.sourceSpans, 'historical_target_unresolved', {
          eventIds: candidates.map(({ eventId }) => eventId),
        }),
      ];
    }
    const sourceSpans = [...pending.sourceSpans, claim.sourceSpan];
    const operation =
      pending.kind === 'recur'
        ? makeCommand({
            kind: 'RecordRecurrence',
            sourceMessageId: base.sourceMessageId,
            sourceSpans,
            targetEventId: target.id,
            targetEventVersion: target.version,
            rawSymptom: pending.rawSymptom,
            ...(pending.bodySite === undefined ? {} : { bodySite: pending.bodySite }),
          })
        : makeCommand({
            kind:
              target.authoredBy === 'patient' && target.reviewState === 'unreviewed'
                ? 'CorrectReport'
                : 'RecordContradiction',
            sourceMessageId: base.sourceMessageId,
            sourceSpans,
            targetEventId: target.id,
            targetEventVersion: target.version,
            targetKind: target.kind,
            ...valuesFromCorrectionChanges(pending.changes),
            ...(target.authoredBy === 'patient' && target.reviewState === 'unreviewed'
              ? {}
              : { reason: 'protected_record_contradiction' }),
          });
    return [
      makeCommand({
        ...base,
        kind: 'ResolveInformationNeed',
        needId: need.id,
        expectedNeedVersion: need.version,
      }),
      operation,
    ];
  }
  if (need.targetEventId === undefined || need.targetEventVersion === undefined)
    throw new Error('targeted_need_scope_invalid');
  const event = snapshot.memory.events.find(
    ({ id, version, current }) =>
      id === need.targetEventId && version === need.targetEventVersion && current,
  );
  if (event === undefined)
    return [unresolved(base.sourceMessageId, base.sourceSpans, 'pending_target_stale')];

  const terminalFailure = (
    reason: string,
    candidates: Parameters<typeof unresolved>[3] = {},
  ): ClinicalIntentCommand[] => [
    ...(needIsExpired
      ? []
      : [
          makeCommand({
            ...base,
            kind: 'SupersedeInformationNeed',
            needId: need.id,
            expectedNeedVersion: need.version,
          }),
        ]),
    unresolved(base.sourceMessageId, base.sourceSpans, reason, candidates),
  ];

  // Wave 1c: late_intent has no dedicated event field — a genuine forward-intent answer ("yes,
  // later tonight") just retires the pinned question, and whatever administration report comes
  // next decides the dose's outcome. But an answer reporting the dose was ALREADY taken IS an
  // administration outcome, and retiring the question on it left the dose recorded 'missed'
  // forever while the patient was thanked — a false miss feeding the reported-miss streak alert.
  // The deterministic core never infers an outcome from free text (that is the extractor's job),
  // so it refuses to resolve and routes the turn to clinician review with the wording preserved.
  if (need.field === 'late_intent') {
    if (LATE_INTENT_TAKEN_ANSWER.test(folded) && !LATE_INTENT_NEGATED.test(folded))
      return terminalFailure('late_intent_outcome_unresolved', { eventIds: [event.id] });
    return [
      makeCommand({
        ...base,
        kind: 'ResolveInformationNeed',
        needId: need.id,
        expectedNeedVersion: need.version,
      }),
    ];
  }

  let values: Record<string, unknown> = {};
  if (need.field === 'medication_identity') {
    const answerIds = medicationCandidates(snapshot, claim.answerText);
    const narrowed = answerIds.filter((id) => need.candidateMedicationIds.includes(id));
    if (answerIds.length !== 1 || narrowed.length !== 1) {
      return terminalFailure(
        answerIds.length === 1 ? 'candidate_widening_forbidden' : 'medication_unresolved',
        {
          medicationIds: need.candidateMedicationIds,
          eventIds: [event.id],
        },
      );
    }
    const medication = snapshot.medications.find(({ id }) => id === narrowed[0])!;
    const compatibleDoses = snapshot.doses.filter(
      ({ id, medicationId }) =>
        medicationId === medication.id && need.candidateDoseIds.includes(id),
    );
    if (compatibleDoses.length === 0) {
      return terminalFailure('dose_unresolved', {
        medicationIds: [medication.id],
        doseIds: need.candidateDoseIds,
        eventIds: [event.id],
      });
    }
    values = {
      medicationId: medication.id,
      medicationVersion: medication.version,
      ...(compatibleDoses.length === 1
        ? {
            doseId: compatibleDoses[0]!.id,
            doseVersion: compatibleDoses[0]!.version,
            localDate: compatibleDoses[0]!.localDate,
            localTime: compatibleDoses[0]!.localTime,
          }
        : {}),
    };
  } else if (need.field === 'dose_identity') {
    const matches = snapshot.doses.filter(
      ({ id, label }) => need.candidateDoseIds.includes(id) && normalize(label) === folded,
    );
    if (matches.length !== 1) {
      return terminalFailure('dose_unresolved', {
        doseIds: need.candidateDoseIds,
        eventIds: [event.id],
      });
    }
    const dose = matches[0]!;
    const medication = snapshot.medications.find(({ id }) => id === dose.medicationId);
    if (medication === undefined) {
      return terminalFailure('dose_unresolved', {
        doseIds: need.candidateDoseIds,
        eventIds: [event.id],
      });
    }
    values = {
      doseId: dose.id,
      doseVersion: dose.version,
      medicationId: medication.id,
      medicationVersion: medication.version,
      localDate: dose.localDate,
      localTime: dose.localTime,
    };
  } else if (need.field === 'symptom_identity') {
    const concept = snapshot.symptomConcepts.find((candidate) => normalize(candidate) === folded);
    if (concept === undefined)
      return terminalFailure('symptom_unresolved', { eventIds: [event.id] });
    values = { symptomConcept: concept };
  } else if (need.field === 'severity') {
    const priorSeverity =
      folded === 'same as before' &&
      event.kind === 'symptom' &&
      event.operation === 'recur' &&
      event.recurrenceOfEventId !== undefined
        ? snapshot.memory.events.find(
            ({ id, current, kind, symptomStatus, severity }) =>
              id === event.recurrenceOfEventId &&
              current &&
              kind === 'symptom' &&
              symptomStatus === 'resolved' &&
              /^(?:[1-9]|10)$/u.test(severity ?? ''),
          )?.severity
        : undefined;
    const severity = /^(?:[1-9]|10)$/u.test(folded) ? folded : priorSeverity;
    if (severity === undefined)
      return terminalFailure('severity_unresolved', { eventIds: [event.id] });
    values = { severity };
  } else if (need.field === 'actual_time') {
    if (!isSupportedActualTime(claim.answerText))
      return terminalFailure('actual_time_unresolved', { eventIds: [event.id] });
    values = { exactTime: claim.answerText };
  } else {
    values = { [needFieldEventKey(need.field)]: claim.answerText };
  }

  return [
    makeCommand({
      ...base,
      kind: 'ResolveInformationNeed',
      needId: need.id,
      expectedNeedVersion: need.version,
    }),
    makeCommand({
      ...base,
      kind: 'RefineReport',
      targetEventId: event.id,
      targetEventVersion: event.version,
      targetKind: event.kind,
      ...values,
    }),
  ];
}

function resolveDetail(
  snapshot: PatientClinicalSnapshot,
  claim: Extract<ValidatedClaim, { kind: 'symptom_detail' }>,
  sameMessageTargets: ReadonlyMap<string, ResolvedTarget>,
): ClinicalIntentCommand[] {
  const base = { sourceMessageId: snapshot.inboundMessage.id, sourceSpans: [claim.sourceSpan] };
  if (
    claim.experiencer !== 'patient' ||
    claim.certainty !== 'certain' ||
    claim.polarity !== 'positive' ||
    claim.status === 'hypothetical' ||
    claim.status === 'future' ||
    claim.status === 'habitual' ||
    (claim.detailField === 'status' && claim.status !== 'current' && claim.status !== 'resolved')
  ) {
    return [unresolved(base.sourceMessageId, base.sourceSpans, 'symptom_detail_ineligible')];
  }
  const target = claimTarget(snapshot, claim, sameMessageTargets);
  if (target === undefined || target.kind !== 'symptom') {
    return [unresolved(base.sourceMessageId, base.sourceSpans, 'symptom_detail_target_unresolved')];
  }
  if (claim.status === 'historical' && target.symptomStatus !== 'historical') {
    return [unresolved(base.sourceMessageId, base.sourceSpans, 'symptom_detail_target_unresolved')];
  }
  if (target.authoredBy !== 'patient' || target.reviewState !== 'unreviewed') {
    return [
      makeCommand({
        ...base,
        kind: 'RecordContradiction',
        targetEventId: target.id,
        targetEventVersion: target.version,
        targetKind: 'symptom',
        reason: 'protected_record_contradiction',
        ...detailValues(claim),
      }),
    ];
  }
  const matchingNeed = snapshot.memory.needs.find(
    (need) =>
      activeNeed(need) &&
      need.targetEventId === target.id &&
      claim.detailField !== 'status' &&
      need.field === claim.detailField,
  );
  return [
    ...(matchingNeed === undefined
      ? []
      : [
          makeCommand({
            ...base,
            kind: 'ResolveInformationNeed',
            needId: matchingNeed.id,
            expectedNeedVersion: matchingNeed.version,
          }),
        ]),
    makeCommand({
      ...base,
      kind: 'RefineReport',
      targetEventId: target.id,
      targetEventVersion: target.version,
      targetKind: 'symptom',
      ...detailValues(claim),
    }),
  ];
}

function activeNeed(need: InformationNeed): boolean {
  return need.state === 'open' || need.state === 'asked';
}

function openNeedCommand(
  snapshot: PatientClinicalSnapshot,
  event: ClinicalEvent,
  field: NeedField,
  candidates: {
    readonly medicationIds?: readonly string[];
    readonly doseIds?: readonly string[];
    readonly symptomEventIds?: readonly string[];
    readonly historicalEventIds?: readonly string[];
  } = {},
): ClinicalIntentCommand {
  const needId = `need-${sha256({ eventId: event.id, eventVersion: event.version, field }).slice(0, 24)}`;
  return makeCommand({
    kind: 'OpenInformationNeed',
    sourceMessageId: snapshot.inboundMessage.id,
    sourceSpans: event.sourceSpans.filter(
      ({ messageId }) => messageId === snapshot.inboundMessage.id,
    ),
    needId,
    originInboundSequence: snapshot.inboundMessage.sequence,
    targetEventId: event.id,
    targetEventVersion: event.version,
    field,
    candidateMedicationIds: uniqueSorted(candidates.medicationIds ?? []),
    candidateDoseIds: uniqueSorted(candidates.doseIds ?? []),
    candidateSymptomEventIds: uniqueSorted(candidates.symptomEventIds ?? []),
    candidateHistoricalEventIds: uniqueSorted(candidates.historicalEventIds ?? []),
    questionId: `question-${sha256({ eventId: event.id, eventVersion: event.version, field }).slice(0, 24)}`,
    priority: NEED_PRIORITY[field],
  });
}

function addMissingNeeds(
  snapshot: PatientClinicalSnapshot,
  commands: readonly ClinicalIntentCommand[],
): ClinicalIntentCommand[] {
  const provisional = reducePatientClinicalMemory(snapshot.memory, commands).memory;
  const additions: ClinicalIntentCommand[] = [];
  const resolvedNeedIds = new Set(
    commands.flatMap((command) =>
      command.kind === 'ResolveInformationNeed' ? [command.needId] : [],
    ),
  );
  const eventCommands = new Map(
    commands.flatMap((command) =>
      command.kind === 'CreateReport' ||
      command.kind === 'RefineReport' ||
      command.kind === 'CorrectReport' ||
      command.kind === 'RecordRecurrence'
        ? [[eventIdForCommand(command.id), command] as const]
        : [],
    ),
  );
  const affectedEventIds = new Set(
    commands.flatMap((command) =>
      command.kind === 'CreateReport' ||
      command.kind === 'RefineReport' ||
      command.kind === 'CorrectReport' ||
      command.kind === 'RecordRecurrence'
        ? [eventIdForCommand(command.id)]
        : [],
    ),
  );
  for (const event of provisional.events.filter(
    ({ id, current }) => current && affectedEventIds.has(id),
  )) {
    const fields: Array<{ field: NeedField; candidates?: Parameters<typeof openNeedCommand>[3] }> =
      [];
    if (event.kind === 'administration' && event.medicationId === undefined) continue;
    if (event.kind === 'administration' && event.doseId === undefined) {
      const medicationId = event.medicationId;
      if (medicationId === undefined) continue;
      const eventCommand = eventCommands.get(event.id);
      const resolvedMedicationNeed =
        eventCommand?.kind === 'RefineReport' || eventCommand?.kind === 'CorrectReport'
          ? snapshot.memory.needs.find(
              (need) =>
                resolvedNeedIds.has(need.id) &&
                need.field === 'medication_identity' &&
                need.targetEventId === eventCommand.targetEventId,
            )
          : undefined;
      const compatibleDoses = snapshot.doses.filter(
        (dose) =>
          dose.medicationId === medicationId &&
          (resolvedMedicationNeed === undefined ||
            resolvedMedicationNeed.candidateDoseIds.includes(dose.id)),
      );
      if (compatibleDoses.length > 1) {
        fields.push({
          field: 'dose_identity',
          candidates: {
            medicationIds: [medicationId],
            doseIds: compatibleDoses.map(({ id }) => id),
          },
        });
      }
    }
    if (
      event.kind === 'administration' &&
      event.adherence === 'taken' &&
      event.timing === 'late' &&
      event.exactTime === undefined
    ) {
      fields.push({ field: 'actual_time' });
    }
    // Wave 1c: a missed OR still-pending ("not yet") administration report opens the
    // late_intent question. medicationId is already guaranteed by the top-of-loop continue;
    // doseId may still be ambiguous — late_intent's pinned wording never names the dose, so it
    // does not wait on dose_identity resolution.
    if (
      event.kind === 'administration' &&
      (event.adherence === 'missed' || event.adherence === undefined)
    ) {
      fields.push({ field: 'late_intent' });
    }
    if (event.kind === 'symptom' && event.symptomConcept === null)
      fields.push({ field: 'symptom_identity' });
    if (
      event.kind === 'symptom' &&
      event.symptomConcept !== null &&
      event.symptomConcept !== undefined &&
      event.symptomStatus !== 'resolved' &&
      event.severity === undefined
    ) {
      fields.push({ field: 'severity', candidates: { symptomEventIds: [event.id] } });
    }
    // Wave 1e — AI-led symptom context gathering. Rollout-gated (contextBatteryEnabled): a
    // current, identified, unresolved symptom event spawns needs for its missing context
    // fields, oldest-priority-first, capped at CONTEXT_BATTERY_MAX_QUESTIONS DISTINCT fields
    // ever asked across the whole version lineage (counting distinct fields, not need rows —
    // a field carried forward across several refinements must not eat multiple cap slots).
    // Any terminal non-answer (idk/decline/expiry) anywhere in the lineage stops the WHOLE
    // battery permanently — no further context field for this episode is ever opened again.
    if (
      snapshot.contextBatteryEnabled === true &&
      event.kind === 'symptom' &&
      event.symptomConcept !== null &&
      event.symptomConcept !== undefined &&
      event.symptomStatus !== 'resolved'
    ) {
      const lineageIds = symptomEventLineageIds(provisional.events, event.id);
      const lineageNeeds = contextBatteryLineageNeeds(provisional.needs, lineageIds);
      if (!contextBatteryStoppedForLineage(lineageNeeds)) {
        // The cap spans the whole symptom bank, and severity is queued into `fields` a few lines
        // above on this very turn — counting only needs already committed to memory let the
        // first burst open severity plus a full four context fields (five questions, not four).
        const askedFields = new Set([
          ...lineageNeeds.map((need) => need.field),
          ...fields
            .map(({ field }) => field)
            .filter((field) => CONTEXT_BATTERY_EPISODE_FIELD_SET.has(field)),
        ]);
        let remaining = CONTEXT_BATTERY_MAX_QUESTIONS - askedFields.size;
        for (const field of CONTEXT_BATTERY_FIELD_ORDER) {
          if (remaining <= 0) break;
          if (contextBatteryEventValue(event, field) !== undefined) continue;
          fields.push({ field, candidates: { symptomEventIds: [event.id] } });
          remaining -= 1;
        }
      }
    }

    for (const { field, candidates } of fields) {
      if (
        !provisional.needs.some((need) => need.targetEventId === event.id && need.field === field)
      ) {
        additions.push(openNeedCommand(snapshot, event, field, candidates));
      }
    }
  }
  return additions;
}

export function resolveClinicalClaims(
  snapshot: PatientClinicalSnapshot,
  claims: readonly ValidatedClaim[],
): ClinicalIntentCommand[] {
  let commands: ClinicalIntentCommand[] = [];
  const sameMessageTargets = new Map<string, ResolvedTarget>();
  const primaryResults: Array<{
    claim: Extract<ValidatedClaim, { kind: 'administration' | 'symptom' }>;
    commands: ClinicalIntentCommand[];
    eventId?: string;
    eventVersion?: number;
    medicationId?: string;
    localDate?: string;
  }> = [];
  const primaries = claims
    .filter((claim) => claim.kind === 'administration' || claim.kind === 'symptom')
    .sort((left, right) => left.semanticId.localeCompare(right.semanticId));
  for (const claim of primaries) {
    const result =
      claim.kind === 'administration'
        ? resolveAdministration(snapshot, claim)
        : resolveSymptom(snapshot, claim);
    primaryResults.push({ claim, ...result });
    if (result.eventId !== undefined) {
      sameMessageTargets.set(claim.semanticId, {
        id: result.eventId,
        version: result.eventVersion ?? 1,
        kind: claim.kind,
        authoredBy: 'patient',
        reviewState: 'unreviewed',
        ...(claim.kind === 'symptom'
          ? {
              symptomStatus: claim.status === 'historical' ? 'historical' : 'current',
              ...(claim.bodySiteText === undefined ? {} : { bodySite: claim.bodySiteText }),
            }
          : {
              ...(result.medicationId === undefined ? {} : { medicationId: result.medicationId }),
              ...(result.localDate === undefined ? {} : { localDate: result.localDate }),
            }),
      });
    }
  }
  const explicitlyTargeted = new Set(
    claims
      .filter(
        (claim): claim is Extract<ValidatedClaim, { kind: 'correction' }> =>
          claim.kind === 'correction',
      )
      .map(({ targetSemanticId }) => targetSemanticId)
      .filter((semanticId): semanticId is string => semanticId !== undefined),
  );
  const administrationGroups = new Map<string, typeof primaryResults>();
  for (const result of primaryResults.filter(
    (candidate) =>
      candidate.claim.kind === 'administration' &&
      !explicitlyTargeted.has(candidate.claim.semanticId),
  )) {
    const create = result.commands.find(
      (command): command is Extract<ClinicalIntentCommand, { kind: 'CreateReport' }> =>
        command.kind === 'CreateReport',
    );
    if (create === undefined) continue;
    const medicationNeed = result.commands.find(
      (command): command is Extract<ClinicalIntentCommand, { kind: 'OpenInformationNeed' }> =>
        command.kind === 'OpenInformationNeed' &&
        command.targetEventId === eventIdForCommand(create.id) &&
        command.field === 'medication_identity',
    );
    const key =
      create.doseId ??
      create.medicationId ??
      medicationNeed?.candidateMedicationIds.join('|') ??
      create.id;
    administrationGroups.set(key, [...(administrationGroups.get(key) ?? []), result]);
  }
  const suppressedSemanticIds = new Set<string>();
  const duplicateAdministrationCommands: ClinicalIntentCommand[] = [];
  const suppressedAdministrationGroups: Array<{
    readonly claims: typeof primaryResults;
    readonly reason: string;
  }> = [];
  for (const group of administrationGroups.values()) {
    if (group.length < 2) continue;
    const adherence = new Set(
      group.flatMap(({ commands: resultCommands }) =>
        resultCommands
          .filter(
            (command): command is Extract<ClinicalIntentCommand, { kind: 'CreateReport' }> =>
              command.kind === 'CreateReport',
          )
          .flatMap((command) => (command.adherence === undefined ? [] : [command.adherence])),
      ),
    );
    group.forEach(({ claim }) => {
      suppressedSemanticIds.add(claim.semanticId);
      sameMessageTargets.delete(claim.semanticId);
    });
    const creates = group.flatMap(({ commands: resultCommands }) =>
      resultCommands.filter(
        (command): command is Extract<ClinicalIntentCommand, { kind: 'CreateReport' }> =>
          command.kind === 'CreateReport',
      ),
    );
    const clinicalIntents = creates.map((command) =>
      Object.fromEntries(
        Object.entries(command).filter(
          ([field]) => field !== 'id' && field !== 'sourceMessageId' && field !== 'sourceSpans',
        ),
      ),
    );
    const clinicallyEquivalent =
      clinicalIntents.length > 0 &&
      clinicalIntents.every((intent) => sha256(intent) === sha256(clinicalIntents[0]));
    if (
      adherence.size === 1 &&
      clinicallyEquivalent &&
      creates.length === group.length &&
      creates.every(({ doseId }) => doseId !== undefined) &&
      group.every(({ commands: resultCommands }) => resultCommands.length === 1)
    ) {
      const intent = Object.fromEntries(
        Object.entries(creates[0]!).filter(([field]) => field !== 'id'),
      );
      duplicateAdministrationCommands.push(
        makeCommand({
          ...intent,
          sourceSpans: group
            .flatMap(({ claim }) => claim.sourceSpan)
            .sort((left, right) => left.start - right.start || left.end - right.end),
        }),
      );
      continue;
    }
    suppressedAdministrationGroups.push({
      claims: group,
      reason:
        adherence.size > 1 || !clinicallyEquivalent
          ? 'same_message_conflict'
          : 'duplicate_administration_claims',
    });
  }
  for (const result of primaryResults) {
    if (!suppressedSemanticIds.has(result.claim.semanticId)) {
      commands.push(...result.commands);
    }
  }
  commands.push(...duplicateAdministrationCommands);
  for (const { claims: suppressed, reason } of suppressedAdministrationGroups) {
    commands.push(
      unresolved(
        snapshot.inboundMessage.id,
        suppressed.map(({ claim }) => claim.sourceSpan),
        reason,
      ),
    );
  }

  const secondary = claims
    .filter(
      (claim) =>
        claim.kind !== 'administration' && claim.kind !== 'symptom' && claim.kind !== 'social',
    )
    .sort((left, right) => left.semanticId.localeCompare(right.semanticId));
  for (const claim of secondary) {
    if (claim.kind === 'need_answer') {
      commands.push(...resolveNeedAnswer(snapshot, claim));
    } else if (claim.kind === 'symptom_detail') {
      commands.push(...resolveDetail(snapshot, claim, sameMessageTargets));
    } else if (claim.kind === 'recurrence') {
      if (
        claim.experiencer !== 'patient' ||
        claim.polarity !== 'positive' ||
        claim.certainty !== 'certain' ||
        claim.status !== 'current'
      ) {
        commands.push(
          unresolved(snapshot.inboundMessage.id, [claim.sourceSpan], 'recurrence_ineligible'),
        );
        continue;
      }
      const targets = snapshot.memory.events.filter(
        (event) =>
          symptomMatches(event, claim.symptomText) &&
          event.symptomStatus === 'resolved' &&
          (claim.bodySiteText === undefined ||
            normalize(event.bodySite ?? '') === normalize(claim.bodySiteText)),
      );
      if (targets.length === 1) {
        commands.push(
          makeCommand({
            kind: 'RecordRecurrence',
            sourceMessageId: snapshot.inboundMessage.id,
            sourceSpans: [claim.sourceSpan],
            targetEventId: targets[0]!.id,
            targetEventVersion: targets[0]!.version,
            rawSymptom: claim.symptomText,
            ...(claim.bodySiteText === undefined ? {} : { bodySite: claim.bodySiteText }),
          }),
        );
      } else if (targets.length > 1) {
        commands.push(
          historicalTargetQuestion(snapshot, targets, {
            kind: 'recur',
            sourceMessageId: snapshot.inboundMessage.id,
            sourceSpans: [claim.sourceSpan],
            rawSymptom: claim.symptomText,
            ...(claim.bodySiteText === undefined ? {} : { bodySite: claim.bodySiteText }),
          }),
        );
      } else {
        commands.push(
          unresolved(snapshot.inboundMessage.id, [claim.sourceSpan], 'recurrence_target_ambiguous'),
        );
      }
    } else if (claim.kind === 'correction') {
      if (
        claim.experiencer !== 'patient' ||
        claim.certainty !== 'certain' ||
        claim.polarity !== 'positive' ||
        claim.status === 'hypothetical' ||
        claim.status === 'future' ||
        claim.status === 'habitual'
      ) {
        commands.push(
          unresolved(snapshot.inboundMessage.id, [claim.sourceSpan], 'correction_ineligible'),
        );
        continue;
      }
      const target = claimTarget(snapshot, claim, sameMessageTargets);
      if (target === undefined) {
        const candidates =
          claim.targetSemanticId === undefined ? historicalTargets(snapshot, claim) : [];
        if (candidates.length > 1) {
          if (
            claim.medicationText !== undefined ||
            claim.doseText !== undefined ||
            claim.timeText !== undefined
          ) {
            commands.push(
              unresolved(
                snapshot.inboundMessage.id,
                [claim.sourceSpan],
                'correction_values_require_target',
                { eventIds: candidates.map(({ id }) => id) },
              ),
            );
            continue;
          }
          const resolvedValues = correctionValues(snapshot, claim);
          if ('reason' in resolvedValues) {
            commands.push(
              unresolved(snapshot.inboundMessage.id, [claim.sourceSpan], resolvedValues.reason, {
                medicationIds: resolvedValues.medicationIds,
                doseIds: resolvedValues.doseIds,
                eventIds: candidates.map(({ id }) => id),
              }),
            );
            continue;
          }
          commands.push(
            historicalTargetQuestion(snapshot, candidates, {
              kind: 'correct',
              sourceMessageId: snapshot.inboundMessage.id,
              sourceSpans: [claim.sourceSpan],
              changes: correctionChanges(resolvedValues.values),
            }),
          );
          continue;
        }
        commands.push(
          unresolved(
            snapshot.inboundMessage.id,
            [claim.sourceSpan],
            'correction_target_unresolved',
          ),
        );
        continue;
      }
      const resolvedValues = correctionValues(snapshot, claim, target);
      if ('reason' in resolvedValues) {
        commands.push(
          unresolved(snapshot.inboundMessage.id, [claim.sourceSpan], resolvedValues.reason, {
            medicationIds: resolvedValues.medicationIds,
            doseIds: resolvedValues.doseIds,
            eventIds: [target.id],
          }),
        );
        continue;
      }
      if (
        (target.kind === 'symptom' &&
          (resolvedValues.values.adherence !== undefined ||
            resolvedValues.values.medicationId !== undefined ||
            resolvedValues.values.doseId !== undefined)) ||
        (target.kind === 'administration' && resolvedValues.values.symptomConcept !== undefined)
      ) {
        commands.push(
          unresolved(
            snapshot.inboundMessage.id,
            [claim.sourceSpan],
            'correction_target_kind_mismatch',
            { eventIds: [target.id] },
          ),
        );
        continue;
      }
      commands.push(
        makeCommand({
          kind:
            target.authoredBy === 'patient' && target.reviewState === 'unreviewed'
              ? 'CorrectReport'
              : 'RecordContradiction',
          sourceMessageId: snapshot.inboundMessage.id,
          sourceSpans: [claim.sourceSpan],
          targetEventId: target.id,
          targetEventVersion: target.version,
          targetKind: target.kind,
          ...(target.authoredBy === 'patient' && target.reviewState === 'unreviewed'
            ? {}
            : { reason: 'protected_record_contradiction' }),
          ...resolvedValues.values,
        }),
      );
    }
  }

  const mutatingGroups = new Map<
    string,
    Array<Extract<ClinicalIntentCommand, { kind: 'RefineReport' | 'CorrectReport' }>>
  >();
  for (const command of commands) {
    if (command.kind !== 'RefineReport' && command.kind !== 'CorrectReport') continue;
    const key = `${command.targetEventId}:${command.targetEventVersion}`;
    mutatingGroups.set(key, [...(mutatingGroups.get(key) ?? []), command]);
  }
  for (const group of mutatingGroups.values()) {
    if (group.length < 2) continue;
    const first = group[0]!;
    const correctionCount = group.filter(({ kind }) => kind === 'CorrectReport').length;
    if (correctionCount !== 0 && correctionCount !== group.length) {
      const groupIds = new Set(group.map(({ id }) => id));
      commands = commands.filter(({ id }) => !groupIds.has(id));
      commands.push(
        unresolved(
          first.sourceMessageId,
          group.flatMap(({ sourceSpans }) => sourceSpans),
          'mixed_correction_refinement_unresolved',
          { eventIds: [first.targetEventId] },
        ),
      );
      continue;
    }
    const mergedIntent: Record<string, unknown> = {
      kind: correctionCount === group.length ? 'CorrectReport' : 'RefineReport',
      sourceMessageId: first.sourceMessageId,
      sourceSpans: group
        .flatMap(({ sourceSpans }) => sourceSpans)
        .sort((left, right) => left.start - right.start || left.end - right.end),
      targetEventId: first.targetEventId,
      targetEventVersion: first.targetEventVersion,
      targetKind: first.targetKind,
    };
    const valueKeys = [
      'medicationId',
      'medicationVersion',
      'doseId',
      'doseVersion',
      'adherence',
      'timing',
      'timeText',
      'exactTime',
      'localDate',
      'localTime',
      'rawSymptom',
      'symptomConcept',
      'symptomStatus',
      'severity',
      'duration',
      'bodySite',
      'frequency',
    ] as const;
    let conflict = false;
    for (const key of valueKeys) {
      const values = group.flatMap((command) => (command[key] === undefined ? [] : [command[key]]));
      if (new Set(values.map((value) => JSON.stringify(value))).size > 1) conflict = true;
      if (values[0] !== undefined) mergedIntent[key] = values[0];
    }
    const groupIds = new Set(group.map(({ id }) => id));
    commands = commands.filter(({ id }) => !groupIds.has(id));
    commands.push(
      conflict
        ? unresolved(
            first.sourceMessageId,
            group.flatMap(({ sourceSpans }) => sourceSpans),
            'conflicting_refinement_values',
            { eventIds: [first.targetEventId] },
          )
        : makeCommand(mergedIntent),
    );
  }

  const ordered = commands.sort((left, right) => {
    const priority = (command: ClinicalIntentCommand): number =>
      command.kind === 'ResolveInformationNeed' || command.kind === 'DeclineInformationNeed'
        ? 0
        : command.kind === 'CreateReport'
          ? 1
          : command.kind === 'RefineReport' || command.kind === 'CorrectReport'
            ? 2
            : 3;
    const firstOffset = (command: ClinicalIntentCommand): number =>
      command.sourceSpans.reduce(
        (lowest, { start }) => Math.min(lowest, start),
        Number.MAX_SAFE_INTEGER,
      );
    return (
      priority(left) - priority(right) ||
      firstOffset(left) - firstOffset(right) ||
      left.id.localeCompare(right.id)
    );
  });
  return [...ordered, ...addMissingNeeds(snapshot, ordered)];
}

/**
 * Wave 1a deadlock expiry: emits one ExpireInformationNeed per asked need that has outlived its
 * question — either its origin turn is from a prior local day (the snapshot's today-only
 * boundary: no question survives overnight) or ASKED_NEED_EXPIRY_SUBSTANTIVE_TURNS substantive
 * turns have been processed since its origin. Evaluated against the PROVISIONAL memory so a
 * need this turn already resolved, declined, or superseded is never double-transitioned.
 * Expiry marks the need expired — never deletes it — so a late clear answer within the short
 * grace window still resolves it via resolveNeedAnswer instead of opening a new topic.
 */
export function expireStaleAskedNeedCommands(
  snapshot: PatientClinicalSnapshot,
  provisionalMemory: PatientClinicalSnapshot['memory'],
): ClinicalIntentCommand[] {
  const wholeMessageSpan: SourceSpan = {
    messageId: snapshot.inboundMessage.id,
    start: 0,
    end: snapshot.inboundMessage.body.length,
    quote: snapshot.inboundMessage.body,
  };
  return provisionalMemory.needs
    .filter((need) => {
      if (need.state !== 'asked') return false;
      if ((snapshot.overnightAskedNeedIds ?? []).includes(need.id)) return true;
      // Count-based expiry needs the origin receipt in the bounded window; an origin that has
      // rolled out is from a prior day (the 50/day intake cap is far below the 128-receipt
      // window), which the overnight axis above already covers.
      const distance = substantiveProcessedTurnsSince(
        provisionalMemory,
        need.originInboundMessageId,
      );
      return Number.isFinite(distance) && distance >= ASKED_NEED_EXPIRY_SUBSTANTIVE_TURNS;
    })
    .map((need) =>
      makeCommand({
        kind: 'ExpireInformationNeed',
        sourceMessageId: snapshot.inboundMessage.id,
        sourceSpans: [wholeMessageSpan],
        needId: need.id,
        expectedNeedVersion: need.version,
        staleQuestion: true,
      }),
    );
}

/** True when a context-battery need's episode lineage has already stopped (Wave 1e stop rule). */
function isStoppedContextBatteryNeed(
  memory: PatientClinicalMemory,
  need: InformationNeed,
): boolean {
  if (!CONTEXT_BATTERY_EPISODE_FIELD_SET.has(need.field) || need.targetEventId === undefined)
    return false;
  const lineageIds = symptomEventLineageIds(memory.events, need.targetEventId);
  return contextBatteryStoppedForLineage(contextBatteryLineageNeeds(memory.needs, lineageIds));
}

/**
 * Wave 1e AI selection: `preferredField`, when supplied, is an upstream (untrusted) model's
 * preference for which eligible need to ask next. Honored ONLY when it names one of the
 * candidate needs below AND that need's field is in CONTEXT_BATTERY_FIELDS — the AI has no
 * authority to reorder medication/dose/event identity or the pre-existing Wave 1c fields.
 * Any other value (not eligible, not a context-battery field, undefined) falls through to the
 * unchanged deterministic priority order.
 */
export function selectQuestion(
  memory: PatientClinicalSnapshot['memory'],
  preferredField?: NeedField,
): InformationNeed | undefined {
  if (memory.routineClarificationsPaused) return undefined;
  if (memory.needs.some(({ state }) => state === 'asked')) return undefined;
  const eligible = memory.needs
    .filter(
      (need) =>
        need.state === 'open' &&
        !need.clarificationAttemptUsed &&
        !isStoppedContextBatteryNeed(memory, need),
    )
    .sort(
      (left, right) =>
        NEED_PRIORITY[right.field] - NEED_PRIORITY[left.field] ||
        left.originInboundSequence - right.originInboundSequence ||
        left.questionId.localeCompare(right.questionId),
    );
  if (preferredField !== undefined && CONTEXT_BATTERY_FIELD_SET.has(preferredField)) {
    const preferred = eligible.find((need) => need.field === preferredField);
    if (preferred !== undefined) return preferred;
  }
  return eligible[0];
}

export function askCommand(
  snapshot: PatientClinicalSnapshot,
  need: InformationNeed,
): ClinicalIntentCommand {
  return makeCommand({
    kind: 'AskInformationNeed',
    sourceMessageId: snapshot.inboundMessage.id,
    sourceSpans: [],
    needId: need.id,
    expectedNeedVersion: need.version,
  });
}
