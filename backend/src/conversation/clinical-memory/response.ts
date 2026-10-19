import { safetyAutoReplyEmergency } from '@medadhere/shared';
import {
  clinicalResponsePlanSchema,
  type ClinicalResponsePlan,
  type NeedField,
} from './contracts.js';

/**
 * Bumped for the Wave 1a template-floor additions (orientation ack + re-ask explainers). NOT
 * bumped again for the Lane Q RE-ASK ROUTE additions (2026-08-17, prompted-dose-checkin restate
 * + human_review append) — see the matching note on CURRENT_CLINICAL_PIPELINE_VERSIONS.renderer
 * in contracts.ts: a real bump needs a coordinated update across every hardcoded
 * pipelineVersions test fixture across the codebase, outside this lane's ownership.
 */
export const CLINICAL_RENDERER_VERSION = 'renderer-v2';

/** Cross-lane literal: the planner sets this acknowledgementId for content-free messages. */
export const ACKNOWLEDGEMENT_ORIENTATION = 'acknowledgement-orientation';

/**
 * Hard SMS reply ceiling — must equal preparedClinicalTurnSchema.responseText's max (contracts.ts)
 * and outbound_message.body varchar(320). An over-cap render would fail that schema parse OUTSIDE
 * prepare's guarded region and poison the turn, so the question renderer degrades instead.
 */
export const MAX_SMS_RESPONSE_CHARS = 320;

const QUESTIONS: Readonly<Record<NeedField, string>> = {
  medication_identity: 'Which medication do you mean?',
  dose_identity: 'Which scheduled dose do you mean?',
  event_identity: 'Which earlier report do you mean?',
  symptom_identity: 'What symptom are you experiencing?',
  severity: 'What number from 1 to 10 best describes the symptom’s intensity?',
  actual_time: 'About what time did you take it?',
  duration: 'How long has this been happening?',
  body_site: 'Where on your body did you notice it?',
  frequency: 'How often is this happening?',
  // Wave 1c pinned wording (owner-approved 2026-08-16): strictly informational, never phrased
  // as permission ("you can take it later"). The question-identity validator gate pins this
  // exact content; the composer may only warm the surrounding tone.
  late_intent: 'Do you plan to take it later today?',
  // Wave 1e — AI-led symptom context gathering. Every text below is DRAFT, owner-gate-pending
  // (decision #3 string review) — the bank the composer/deterministic floor draws from.
  // owner-gate-pending
  onset: 'When did this start?',
  // owner-gate-pending
  quality: 'How would you describe it?',
  // owner-gate-pending
  triggers: 'Does anything make it better or worse?',
  // owner-gate-pending
  associated_symptoms: 'Are you noticing anything else along with it?',
  // owner-gate-pending
  recurrence_history: 'Has this happened to you before?',
};

/**
 * Pre-written plain-language explainer per pinned question, rendered only on a re-ask.
 * Closed map: TS enforces the exact QUESTIONS key set. Explainers grant zero new authority —
 * strictly informational wording about how to answer, never advice.
 */
export const EXPLAINERS = {
  medication_identity: 'You can reply with the medication name from your schedule.',
  dose_identity: 'You can reply with the day and time of the dose, like Tuesday morning.',
  event_identity: 'You can reply with a few words from the earlier message you mean.',
  symptom_identity: 'A short description in your own words is all I need.',
  severity: '1 means you barely notice it, 10 is the worst you have ever felt.',
  actual_time: 'You can reply with an approximate time, like 8 in the morning.',
  duration: 'You can reply with an approximate length of time, like two hours or three days.',
  body_site: 'You can reply with the part of the body where you feel it, like left arm or stomach.',
  frequency: 'You can reply with how many times it happens, per day or per week.',
  // owner-gate-pending: draft explainer text, not yet shown to the owner for the string-gate
  // review (decision #3) — veto/edit expected before this ships on a re-ask.
  late_intent: 'You can just reply yes or no.',
  // Wave 1e — every explainer below is DRAFT, owner-gate-pending (decision #3 string review).
  // owner-gate-pending
  onset: 'You can reply with when it started, like this morning or two days ago.',
  // owner-gate-pending
  quality: 'A few words describing it are enough, like sharp, dull, aching, or burning.',
  // owner-gate-pending
  triggers: 'You can mention anything that makes it feel better or worse.',
  // owner-gate-pending
  associated_symptoms: 'You can mention anything else you are noticing along with it.',
  // owner-gate-pending
  recurrence_history: 'You can reply yes or no, or add a few words if it helps.',
} as const satisfies Readonly<Record<keyof typeof QUESTIONS, string>>;

// Owner-authored floor text (2026-08-16 string review): greetings read like a normal chat,
// not a service notice. Orientation/service info lives in the enrollment disclosure + HELP.
// Fallback floor only (fires when composing fails on a content-free turn). Must read
// sanely at ANY point in a conversation — the previous greeting floor re-greeted
// mid-thread (observed live 2026-08-17), which read as ignoring the patient.
const ORIENTATION_REPLY = "All good — I'm around if you need anything.";

const REASK_LEAD_IN = 'Just following up on my earlier question.';

type PlanQuestion = NonNullable<ClinicalResponsePlan['question']>;
type PendingReask = NonNullable<ClinicalResponsePlan['pendingReask']>;

// Lane Q (2026-08-17 live incident, RE-ASK ROUTE) — DRAFT, owner-gate-pending: the pinned
// question/explainer for restating an unanswered scheduled dose check-in when no information
// need is pending. A prompted check-in is never an InformationNeed record (it is derived from
// outbound_message/reminder state), so it cannot draw from the QUESTIONS/EXPLAINERS bank above.
// Not yet shown to the owner for the string-gate review — veto/edit expected before this ships.
const PROMPTED_DOSE_EXPLAINER = 'A quick yes or no works, or tell me more.';
// owner-gate-pending — label-free overflow fallback, mirrors the QUESTIONS generic-drop pattern.
const PROMPTED_DOSE_GENERIC_QUESTION = 'Have you taken your dose yet?';

function promptedDoseQuestion(medicationLabel: string): string {
  return `Have you taken your ${medicationLabel} yet?`; // owner-gate-pending
}

/**
 * Full standalone re-ask sentence for an unanswered prompted dose check-in. The medication
 * label is schema-bounded at 1000 chars (textSchema), so this degrades to the generic
 * label-free question when the labeled form would exceed the SMS cap — the same overflow-safety
 * pattern renderQuestionText already uses for label-required need fields.
 */
export function promptedDoseReaskSentence(medicationLabel: string): string {
  const full = `${REASK_LEAD_IN} ${promptedDoseQuestion(medicationLabel)} ${PROMPTED_DOSE_EXPLAINER}`;
  if (full.length <= MAX_SMS_RESPONSE_CHARS) return full;
  return `${REASK_LEAD_IN} ${PROMPTED_DOSE_GENERIC_QUESTION} ${PROMPTED_DOSE_EXPLAINER}`;
}

/**
 * Full standalone re-ask sentence for restating an already-asked information need — identical
 * text to the `question.reask=true` branch below, reused here for the `pendingReask` shape a
 * `human_review` plan carries (that plan's `kind` can never be 'question', so it cannot carry
 * `question` itself).
 */
export function pendingNeedReaskSentence(
  field: NeedField,
  targetLabel: string | undefined,
): string {
  const labeled =
    targetLabel === undefined ? QUESTIONS[field] : renderQuestionText({ field, targetLabel });
  const full = `${REASK_LEAD_IN} ${labeled} ${EXPLAINERS[field]}`;
  if (full.length <= MAX_SMS_RESPONSE_CHARS) return full;
  return `${REASK_LEAD_IN} ${QUESTIONS[field]} ${EXPLAINERS[field]}`;
}

/** Dispatches a `pendingReask` payload to its standalone re-ask sentence, either flavor. */
export function pendingReaskStandaloneSentence(pendingReask: PendingReask): string {
  return pendingReask.kind === 'prompted_dose'
    ? promptedDoseReaskSentence(pendingReask.medicationLabel)
    : pendingNeedReaskSentence(pendingReask.field, pendingReask.targetLabel);
}

function renderQuestionText(question: {
  readonly field: NeedField;
  readonly targetLabel?: string;
}): string {
  if (question.field === 'actual_time')
    return `About what time did you take the ${question.targetLabel} dose?`;
  if (question.field === 'severity')
    return `For ${question.targetLabel}, what number from 1 to 10 best describes the symptom’s intensity?`;
  if (question.field === 'duration')
    return `For ${question.targetLabel}, how long has this been happening?`;
  if (question.field === 'body_site')
    return `For ${question.targetLabel}, where on your body did you notice it?`;
  if (question.field === 'frequency')
    return `For ${question.targetLabel}, how often is this happening?`;
  // Wave 1e context-battery fields — same labeled-question shape as the fields above.
  if (question.field === 'onset') return `For ${question.targetLabel}, when did this start?`;
  if (question.field === 'quality')
    return `For ${question.targetLabel}, how would you describe it?`;
  if (question.field === 'triggers')
    return `For ${question.targetLabel}, does anything make it better or worse?`;
  if (question.field === 'associated_symptoms')
    return `For ${question.targetLabel}, are you noticing anything else along with it?`;
  if (question.field === 'recurrence_history')
    return `For ${question.targetLabel}, has this happened to you before?`;
  return QUESTIONS[question.field];
}

/**
 * Cross-lane contract (Wave 1a): the planner lane adds an OPTIONAL boolean `reask` to the
 * response-plan question schema. Read defensively until contracts.ts carries it — a missing
 * field renders the unchanged first-ask text, so the flag grants zero new authority.
 */
function isReask(question: PlanQuestion): boolean {
  return (question as { readonly reask?: unknown }).reask === true;
}

/**
 * Renders an ALREADY schema-validated plan. Production entry stays renderClinicalResponse
 * (parse gate included); this parse-free path exists for the renderer's own use and for
 * fixture-pin tests of the re-ask branch while the `reask` schema field lands in the
 * planner lane.
 */
export function renderParsedClinicalResponse(plan: ClinicalResponsePlan): string {
  if (plan.kind === 'emergency') return safetyAutoReplyEmergency('en');
  if (plan.kind === 'stop')
    return 'You are unsubscribed and will not receive more MedAdhere messages.';
  if (plan.kind === 'unsupported_language') {
    return 'Thanks. I saved your message for your care team to review.';
  }
  if (plan.kind === 'stale_snapshot') return 'Thanks. Please send that update again.';
  if (plan.kind === 'important' || plan.kind === 'human_review') {
    const base = 'Thanks. I saved this update for your doctor to review.';
    // Lane Q — RE-ASK ROUTE (b): a terminal extraction/runtime failure still owes the patient
    // whatever question was already pending. Append the restate when it fits the SMS cap
    // alongside the truthful saved-for-doctor sentence; otherwise that sentence stands alone
    // rather than risk truncating either half. `pendingReask` only ever appears on a
    // `human_review` plan (never `important`), enforced by the contracts.ts schema.
    if (plan.kind !== 'human_review' || plan.pendingReask === undefined) return base;
    const combined = `${base} ${pendingReaskStandaloneSentence(plan.pendingReask)}`;
    return combined.length <= MAX_SMS_RESPONSE_CHARS ? combined : base;
  }
  if (plan.kind === 'question' && plan.question !== undefined) {
    const fits = (text: string): string | undefined =>
      text.length <= MAX_SMS_RESPONSE_CHARS ? text : undefined;
    const labeled = renderQuestionText(plan.question);
    // Overflow degradation: targetLabel is schema-bounded only at 1000 chars, so a labeled
    // question can exceed the cap. The fallback re-renders with the label-free generic
    // question (an EXISTING pinned template — no text is altered), which always fits.
    const generic = QUESTIONS[plan.question.field];
    if (isReask(plan.question)) {
      const explainer = EXPLAINERS[plan.question.field];
      return (
        fits(`${REASK_LEAD_IN} ${labeled} ${explainer}`) ??
        `${REASK_LEAD_IN} ${generic} ${explainer}`
      );
    }
    return fits(`I’ve noted your update. ${labeled}`) ?? `I’ve noted your update. ${generic}`;
  }
  if (plan.kind === 'routine' && plan.pendingReask?.kind === 'prompted_dose') {
    // Lane Q — RE-ASK ROUTE (a): replaces what would otherwise be the content-free orientation
    // reply — a silent, content-free turn still owes an answer to an unanswered scheduled dose
    // check-in, so restate it instead of implying nothing is outstanding.
    return promptedDoseReaskSentence(plan.pendingReask.medicationLabel);
  }
  if (plan.acknowledgementId === ACKNOWLEDGEMENT_ORIENTATION) return ORIENTATION_REPLY;
  return 'Thanks for letting me know.';
}

export function renderClinicalResponse(untrustedPlan: ClinicalResponsePlan): string {
  return renderParsedClinicalResponse(clinicalResponsePlanSchema.parse(untrustedPlan));
}
