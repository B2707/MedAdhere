/**
 * Wave 1b Lane B — the SOLE gate for composed patient-facing text. Pure code, block-and-
 * replace: any failure means the deterministic template floor ships instead. Validator
 * classes follow the approved plan's numbering 1-10; the RUNTIME check order puts the
 * structural injection screen (class 9) immediately after JSON parsing so an injected
 * payload is labeled `injection_marker` rather than tripping numeral grounding first —
 * the class set and block-everything semantics are unchanged.
 */
import {
  BANNED_SEVERITY_TERMS,
  containsProhibitedMedicationAdvice,
  runSafetyPrefilter,
  synonymHits,
} from '@medadhere/shared';
import { CONTEXT_BATTERY_FIELDS, type NeedField } from './contracts.js';
import {
  dealiasText,
  medicationNameBoundaryPattern,
  type ComposerDayContext,
  type ComposerMedicationAlias,
} from './composer-envelope.js';

/** Hard ceiling in Unicode code points, post-trim — outbound_message.body errors past 320. */
export const COMPOSER_MAX_CODE_POINTS = 320;

/**
 * Prompt canary: embedded in the system prompt, its appearance in output = leaked prompt.
 * tradeoff: constant (not per-request) canary — digits-free by design so it can never trip
 * numeral grounding; upgrade to per-request canaries if prompt-leak forensics ever need it.
 */
export const COMPOSER_CANARY = 'MEDADHERE-CANARY-XQJZVK';

export type ComposerFallbackReason =
  | 'malformed_output'
  | 'ungrounded_entity'
  | 'missing_required_token'
  | 'question_shape_invalid'
  | 'prohibited_medication_advice'
  | 'advice_pattern'
  | 'reassurance_phrase'
  | 'banned_severity_term'
  | 'injection_marker'
  | 'not_gsm7'
  | 'over_length'
  | 'context_overflow'
  | 'provider_timeout'
  | 'provider_error'
  | 'never_composed';

export interface ComposerIntent {
  readonly kind: 'acknowledgement' | 'question' | 'greeting';
  /** Coverage slots: aliased medication label, outcome word — each must appear. */
  readonly requiredTokens: readonly string[];
  /** Extra intent vocabulary the output may ground against. */
  readonly allowedTerms: readonly string[];
  /** Present iff kind === 'question'. keyVocabulary is any-of, matched inside the question span. */
  readonly question?: {
    readonly field: NeedField;
    readonly keyVocabulary: readonly string[];
    /**
     * Wave 1e item 4 (AI-authored questions, owner-directed): when true AND field is in
     * CONTEXT_BATTERY_FIELDS, the model may author its own question instead of anchoring to
     * keyVocabulary — checkQuestionShape then requires the question-authoring grounding gate
     * instead. False/absent, or a field outside CONTEXT_BATTERY_FIELDS, keeps the existing
     * strict keyVocabulary-anchor pin (zero behavior change for every pre-existing field).
     */
    readonly allowAuthoredQuestion?: boolean;
  };
  readonly medications: readonly ComposerMedicationAlias[];
  /** Deterministic, code-assembled, PHI-minimized status facts ("code fetches, AI writes"). */
  readonly patientFacts: readonly string[];
}

export type ComposedReplyVerdict =
  | {
      readonly ok: true;
      readonly sms: string;
      /** Wave 1e: true when the accepted question text used the authored path, not the bank. */
      readonly authored?: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: ComposerFallbackReason;
      readonly detail?: string;
      readonly overBy?: number;
    };

/** Any-of key vocabulary per need field for the question-span check. */
export const DEFAULT_QUESTION_KEY_VOCABULARY: Readonly<Record<NeedField, readonly string[]>> = {
  medication_identity: ['medication', 'med'],
  dose_identity: ['dose'],
  event_identity: ['earlier', 'which'],
  symptom_identity: ['symptom', 'experiencing', 'feeling'],
  severity: ['1 to 10', 'scale', 'number'],
  actual_time: ['time', 'when'],
  duration: ['how long', 'since when'],
  body_site: ['where', 'body'],
  frequency: ['how often', 'how many times'],
  // owner-gate-pending: anchors for the pinned Wave 1c wording "Do you plan to take it later
  // today?" — reaches the patient only as composer phrasing guidance, never as sent text.
  late_intent: ['later today', 'later', 'plan to'],
  // Wave 1e — owner-gate-pending anchors for the context-battery bank wording above.
  onset: ['start', 'started', 'begin', 'began', 'when'],
  quality: ['describe', 'feel like', 'like', 'sharp', 'dull', 'aching', 'burning'],
  triggers: ['better', 'worse', 'trigger'],
  associated_symptoms: ['else', 'along with', 'other symptoms', 'noticing'],
  recurrence_history: ['before', 'happened before', 'again'],
};

/**
 * Wave 1e item 4 — the closed vocabulary an AI-authored context-battery question may draw on
 * (the union of every bank field's key vocabulary above, plus common question connectives).
 * Every content word in an authored question span must appear either here or in the
 * patient's own words today (checked separately) — this is what keeps a free-form-phrased
 * question from smuggling in a fabricated clinical claim while still allowing natural wording.
 */
const AUTHORED_QUESTION_GLOSSARY: ReadonlySet<string> = new Set(
  [
    ...CONTEXT_BATTERY_FIELDS.flatMap((field) => DEFAULT_QUESTION_KEY_VOCABULARY[field]),
    'what',
    'how',
    'when',
    'where',
    'does',
    'is',
    'are',
    'it',
    'this',
    'that',
    'you',
    'your',
    'feel',
    'feeling',
    'anything',
    'else',
    'noticing',
    'again',
    'ever',
    'happened',
    'happening',
    'is there',
    // The bank questions' own remaining words: without these the grounding gate (now an AND,
    // not a fallback — see checkQuestionShape) would reject the pinned bank wording itself.
    'would',
    'make',
    'makes',
    'been',
    'long',
    'since',
    'much',
    'now',
    'still',
    'first',
    'time',
    'times',
    'often',
    'come',
    'comes',
    'get',
    'gets',
    'kind',
    'sort',
    'more',
    'less',
    'same',
    'different',
    'usually',
  ].flatMap((phrase) => phrase.toLowerCase().split(/\s+/u)),
);

/**
 * Medication advice verbs may NEVER appear in an AI-authored question, even echoed back from
 * the patient's own words ("should I take two of them or stop until it settles?" would
 * otherwise license "Is it better if you stop?"). start/started are exempt — they are the
 * onset field's own temporal vocabulary, and the pinned bank question is "When did this start?".
 */
const AUTHORED_QUESTION_FORBIDDEN_VERB =
  /\b(?:take|taken|took|taking|skip|skipped|stop|stopped|double|increase|reduce|wait|continue|restart|resume|change|switch|halve|hold|pause)\b/iu;

// ---------------------------------------------------------------------------------------
// Normalization + GSM-7
// ---------------------------------------------------------------------------------------

const TYPOGRAPHIC_REPLACEMENTS: readonly (readonly [RegExp, string])[] = [
  [/[‘’‚ʼ]/g, "'"],
  [/[“”„]/g, '"'],
  [/[–—―]/g, '-'],
  [/[\u00A0\u2009\u202F]/gu, ' '],
  [/…/g, '...'],
];

/** Deterministic pre-normalization: typographic punctuation to GSM-safe ASCII. */
export function normalizeForSms(text: string): string {
  return TYPOGRAPHIC_REPLACEMENTS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    text,
  );
}

const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENSION = '^{}\\[~]|€\f';
const GSM7_CHARSET = new Set([...GSM7_BASIC, ...GSM7_EXTENSION]);

export function isGsm7(text: string): boolean {
  return [...text].every((character) => GSM7_CHARSET.has(character));
}

const GSM7_EXTENSION_SET = new Set([...GSM7_EXTENSION]);

/** Septet-accurate segment count for observability (single ≤160, concatenated 153/segment). */
export function gsmSegmentCount(text: string): number {
  const septets = [...text].reduce(
    (sum, character) => sum + (GSM7_EXTENSION_SET.has(character) ? 2 : 1),
    0,
  );
  if (septets === 0) return 0;
  return septets <= 160 ? 1 : Math.ceil(septets / 153);
}

// ---------------------------------------------------------------------------------------
// Denylists (named constants)
// ---------------------------------------------------------------------------------------

const ADVICE_VERBS =
  /\b(?:take|skip|stop|double|increase|reduce|wait|continue|start|restart|resume|change|switch|halve|hold|pause)\b/gi;

/**
 * Interrogative past/future-reference carve-out: "did you take", "when you take", "have you
 * taken" ask about the patient's OWN completed action — the pinned actual_time question
 * uses exactly this shape. "do you plan to take" / "do you planning to take" (owner-pinned
 * late_intent wording) is the same interrogative shape with a future-intent phrase inserted
 * before the verb — carved out identically, named medication or not. Imperatives ("Take it
 * now") and statements ("You should plan to take it") stay blocked.
 *
 * The OBJECT is part of the pattern. It used to be open-ended, so anything after the verb rode
 * the exemption — "do you plan to take FEWER doses", "take A BREAK from your reminders", "take
 * it WITH FOOD" are all dose/care modification proposals that passed every validator. Only the
 * patient's own dose is exempt, and only when nothing but a temporal tail follows it. Matching
 * runs on the advice-MASKED text (every alias and display name is already 'medication' there),
 * so one bounded object list covers both validation passes.
 */
const CARVE_OUT_OBJECT = String.raw`(?:it|them|that|(?:your|the|a)\s+(?:medication|dose|doses|pill|pills))`;
const CARVE_OUT_TEMPORAL_TAIL = String.raw`(?:\s+(?:last|already|yet|still|again|later|today|tonight|tomorrow|yesterday|this|that|the|morning|afternoon|evening|night|noon|midnight|time|at|around|about|on|in|by|before|after|since|and|when|then|dose|doses|medication|am|pm|o'clock|\d{1,2}(?::\d{2})?))*\s*$`;
const ADVICE_CARVE_OUT = new RegExp(
  String.raw`\b(?:did|do|have|had|when|what time)\s+you\s+(?:plan(?:ning)?\s+to\s+)?(?:last\s+)?(?:take|taken|took|taking)\s+` +
    CARVE_OUT_OBJECT +
    CARVE_OUT_TEMPORAL_TAIL,
  'gi',
);

const MEDICATION_REFERENCE =
  /\b(?:med_\d+|medications?|medicines?|meds?|dose|dosage|pills?|tablets?|capsules?|insulin|prescription)\b/i;

/**
 * Care-logistics nouns arm the advice-verb scan too. "You can skip tomorrow's appointment" and
 * "Stop the check-ins for now" are care instructions the agent has no authority to give, and
 * neither sentence contains a medication reference — the medication-only arming let them
 * through. Deliberately narrow (things a patient could be told to skip/stop/change): clinician
 * nouns like "doctor" stay out so ordinary replies ("your doctor will take a look") still pass.
 */
const CARE_LOGISTICS_REFERENCE =
  /\b(?:appointments?|visits?|check-?ins?|refills?|reminders?|texts?|messages?)\b/i;

/**
 * GENERAL (non-medication) care direction. The advice-verb scan below only arms when a
 * sentence names a medication or care-logistics noun, so nothing in the ten-validator chain
 * screened "Lie down and rest for now", "No need to go anywhere tonight", or "Sleep it off" —
 * a composed reply could tell a patient reporting cardiac-sounding symptoms to stay home, and
 * a lexicon-missing message never raises a safety signal to divert it to the template floor.
 * These run on EVERY composed reply unconditionally: the agent has no authority to direct a
 * patient's health behavior or their care-seeking, in any register.
 *
 * Deliberately narrow. Only verbs that direct BODILY or CARE-SEEKING action are listed, and
 * only in imperative position (sentence- or clause-initial, after discourse openers) — so
 * "your doctor will take a look" and "let me know if anything changes" still compose.
 */
const CARE_DIRECTIVE_VERB =
  /^(?:rest|lie|lay|sleep|nap|relax|breathe|drink|eat|hydrate|ice|elevate|apply|exercise|stretch|walk|sit|stand|call|visit|see|go|head|stay|remain|avoid|monitor|watch|ignore|try)\b/iu;

/** Discourse openers that may precede an imperative without softening it. */
const LEADING_DISCOURSE =
  /^(?:\s*(?:ok(?:ay)?|alright|sure|thanks|thank you|got it|noted|hey|hi|hello|well|and|but|so|also|please|maybe|just|for now|honestly|then|now)\b[\s,;:-]*)+/iu;

/** Behaviour-directing frames that carry the same authority without the imperative mood. */
const ADVISORY_FRAMES: readonly (readonly [RegExp, string])[] = [
  [
    /\b(?:you|we)\s+(?:should|ought\s+to|need\s+to|had\s+better|might\s+want|may\s+want)\b/iu,
    'should',
  ],
  [/\b(?:no\s+need|nothing|no\s+reason)\s+to\s+\w+/iu, 'no_need_to'],
  [/\b(?:don'?t|doesn'?t|do\s+not)\s+(?:need|have)\s+to\b/iu, 'need_not'],
  [/\b(?:make|be)\s+sure\s+to\b/iu, 'make_sure'],
  [/\bi(?:'d)?\s+(?:would\s+)?(?:recommend|suggest|advise)\b|\bmy\s+advice\b/iu, 'recommend'],
  [/\bit'?s\s+(?:best|fine|ok(?:ay)?)\s+to\b/iu, 'its_fine_to'],
  [/\btry\s+(?:to\b|\w+ing\b)/iu, 'try_to'],
];

const DOSE_UNIT_PATTERN =
  /\b\d+(?:\.\d+)?\s?(?:mg|mcg|µg|ug|ml|g|units?|iu|tablets?|pills?|capsules?|drops?|puffs?)\b/i;

/** Bounded common-drug lexicon — any hit outside the patient's own list is blocked. */
const COMMON_DRUG_NAMES: readonly string[] = [
  'aspirin',
  'tylenol',
  'acetaminophen',
  'paracetamol',
  'advil',
  'ibuprofen',
  'aleve',
  'naproxen',
  'metformin',
  'lisinopril',
  'atorvastatin',
  'lipitor',
  'amlodipine',
  'metoprolol',
  'omeprazole',
  'losartan',
  'gabapentin',
  'sertraline',
  'zoloft',
  'prozac',
  'fluoxetine',
  'warfarin',
  'xanax',
  'alprazolam',
  'prednisone',
  'amoxicillin',
  'hydrochlorothiazide',
  'levothyroxine',
  'synthroid',
  'benadryl',
  'diphenhydramine',
  'melatonin',
  'ozempic',
  'semaglutide',
];

const REASSURANCE_PHRASES: readonly string[] = [
  "that's normal",
  'thats normal',
  "don't worry",
  'dont worry',
  'no need to worry',
  'nothing to worry',
  'should pass',
  'will pass',
  'common side effect',
  'perfectly normal',
  'totally normal',
  'completely normal',
  "you'll be fine",
  'youll be fine',
  'probably nothing',
  'not a big deal',
  'sounds normal',
  // agreement bait
  "you're right",
  'youre right',
  'you are right',
  'good call to',
  'safe to',
];

const REFUSAL_ROLEPLAY_PHRASES: readonly string[] = [
  'as an ai',
  'as a language model',
  'i cannot help',
  "i can't help",
  'i am unable',
  "i'm unable",
  "i'm sorry, but",
  'ignore previous',
  'ignore the above',
  'disregard previous',
  'system prompt',
  'roleplay',
  'role-play',
  'pretend to be',
  'jailbreak',
  'new instructions',
];

/** A2P campaign-drift denylist — promotional phrasing never belongs in a care reply. */
const MARKETING_PHRASES: readonly string[] = [
  'click here',
  'limited time',
  'buy now',
  'promo code',
  'discount',
  'subscribe',
  'you have won',
  'winner',
  'congratulations, you',
  '% off',
  'special offer',
  'act now',
  'risk-free',
  'money-back',
];

// Any domain-with-path shape (bit.ly/abc, is.gd/x) is flagged regardless of TLD — a shortener
// needs no recognizable TLD to be a live redirect. Bare domains (no path) still need a TLD
// match; the list is widened past the original 8 gTLDs to cover common shortener/URL-shortening
// TLDs (xyz/sh/link/gd/ly/…) so "example.xyz" is flagged even without a trailing path.
const URL_PATTERN =
  /(?:https?:\/\/|www\.)|\b[\w-]+\.[a-z]{2,}\/|\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|ca|co|info|biz|xyz|sh|link|gd|ly|me|to|cc|tv|app|dev|page|site|club|top|win|click|gg|us|uk)\b/i;
const PHONE_PATTERNS: readonly RegExp[] = [
  /\+?\d[\d\s().-]{6,}\d/,
  /\b\d{3}[-.]\d{4}\b/,
  /\b(?:911|988)\b/,
];
const UNICODE_TAG_BLOCK = /[\u{E0000}-\u{E007F}]/u;
const ZERO_WIDTH = /[\u200B-\u200F\u2060\uFEFF]/u;
const UNTRUSTED_TAG_ECHO = /<\/?\s*(?:untrusted|compose_intent|system)/i;
const TIME_REFERENCES =
  /\b(?:\d{1,2}:\d{2}|\d{1,2}\s?(?:am|pm)|morning|afternoon|evening|tonight|noon|midnight|o'?clock|yesterday|tomorrow|today|last night)\b/gi;

function findBase64Run(text: string): string | undefined {
  const match = /[A-Za-z0-9+/]{28,}={0,2}/.exec(text);
  if (match === null) return undefined;
  // Require encoding-shaped content so a long ordinary word never matches.
  return /[\d+/]/.test(match[0]) ? match[0] : undefined;
}

// ---------------------------------------------------------------------------------------
// Core text validation (shared by compose-time and the send-time re-check)
// ---------------------------------------------------------------------------------------

type ValidationMode = 'aliased' | 'final';

interface ValidationContext {
  readonly intent: ComposerIntent;
  readonly dayContext: ComposerDayContext;
}

function fail(
  reason: ComposerFallbackReason,
  detail: string,
  overBy?: number,
): ComposedReplyVerdict {
  return overBy === undefined
    ? { ok: false, reason, detail }
    : { ok: false, reason, detail, overBy };
}

function groundingCorpus({ intent, dayContext }: ValidationContext): string {
  const inboundBodies = dayContext.messages
    .filter(({ direction }) => direction === 'inbound')
    .map(({ body }) => body);
  return [
    ...intent.requiredTokens,
    ...intent.allowedTerms,
    ...(intent.question?.keyVocabulary ?? []),
    ...intent.patientFacts,
    ...intent.medications.flatMap(({ alias, displayName }) => [alias, displayName]),
    dayContext.latestPatientMessage,
    ...inboundBodies,
  ]
    .join('\n')
    .toLowerCase();
}

/** Masks medication tokens so their own characters never count as numerals or dose units. */
function maskMedicationTokens(text: string, intent: ComposerIntent, mode: ValidationMode): string {
  if (mode === 'aliased') return text.replace(/\bmed_\d+\b/gi, 'medname');
  return [...intent.medications]
    .sort((left, right) => right.displayName.length - left.displayName.length)
    .reduce(
      (current, { displayName }) =>
        current.replace(medicationNameBoundaryPattern(displayName), 'medname'),
      text,
    );
}

/**
 * Masks BOTH med_N aliases and display names with a word the recovered shared advice
 * module's MEDICATION_NOUNS window recognizes, so "Start your med_1 again" is seen as
 * "Start your medication again" by validator 5 regardless of aliasing mode.
 */
function maskMedicationTokensForAdvice(text: string, intent: ComposerIntent): string {
  const withAliasesMasked = text.replace(/\bmed_\d+\b/gi, 'medication');
  return [...intent.medications]
    .sort((left, right) => right.displayName.length - left.displayName.length)
    .reduce(
      (current, { displayName }) =>
        current.replace(medicationNameBoundaryPattern(displayName), 'medication'),
      withAliasesMasked,
    );
}

function checkInjection(text: string): ComposedReplyVerdict | null {
  const lower = text.toLowerCase();
  if (lower.includes(COMPOSER_CANARY.toLowerCase())) return fail('injection_marker', 'canary_echo');
  if (UNTRUSTED_TAG_ECHO.test(text)) return fail('injection_marker', 'prompt_tag_echo');
  if (URL_PATTERN.test(text)) return fail('injection_marker', 'url');
  if (PHONE_PATTERNS.some((pattern) => pattern.test(text)))
    return fail('injection_marker', 'phone_number');
  if (findBase64Run(text) !== undefined) return fail('injection_marker', 'base64_run');
  if (UNICODE_TAG_BLOCK.test(text) || ZERO_WIDTH.test(text))
    return fail('injection_marker', 'unicode_tag_block');
  const boilerplate = REFUSAL_ROLEPLAY_PHRASES.find((phrase) => lower.includes(phrase));
  if (boilerplate !== undefined) return fail('injection_marker', `boilerplate:${boilerplate}`);
  if (runSafetyPrefilter(text).hit) return fail('injection_marker', 'safety_lexicon');
  const marketing = MARKETING_PHRASES.find((phrase) => lower.includes(phrase));
  if (marketing !== undefined) return fail('injection_marker', `marketing:${marketing}`);
  return null;
}

const NUMERAL_PATTERN = /\d+(?:[:.,]\d+)?/g;

/**
 * Adherence-outcome ASSERTIONS ("noted as taken", "glad you skipped it"). The reply may only
 * state an outcome the intent's code-assembled patient facts or the patient's own words today
 * already contain — otherwise a bare "No" turn can be acknowledged as a taken dose, which no
 * other validator class catches (numerals/times/symptoms ground fine, and \btake\b never
 * matches "taken"). Present tense ("did you take it?") is NOT an assertion and stays legal so
 * the pinned actual_time question shape keeps working.
 */
const OUTCOME_ASSERTIONS: readonly (readonly [RegExp, string])[] = [
  [/\b(?:taken|took)\b/iu, 'taken'],
  [/\b(?:skipped|missed|forgot|forgotten)\b/iu, 'missed'],
];

function outcomeAssertions(text: string): ReadonlySet<string> {
  return new Set(
    OUTCOME_ASSERTIONS.filter(([pattern]) => pattern.test(text)).map(([, outcome]) => outcome),
  );
}

const NEGATOR = /\b(?:not|no|never|none|nothing|without|cannot|cant)\b|n['’]t\b/iu;

/**
 * Corpus side of the outcome gate: an outcome word inside a NEGATED clause grants the composer
 * nothing. Matching the bare token let the patient's own denial license its opposite — "not yet,
 * I haven't taken it" (the exact Wave 1c pending shape, where NO adherence row is written)
 * grounded the reply "I noted your dose as taken", telling the patient a dose was logged that
 * the clinician chart does not show. Clause-level, so "I didn't skip it, I took it at 8" still
 * grounds 'taken'.
 */
function groundedCorpusOutcomes(corpus: string): ReadonlySet<string> {
  const grounded = new Set<string>();
  for (const clause of corpus.split(/[.!?\n,;]+|\b(?:but|although|though)\b/iu)) {
    if (clause === undefined || NEGATOR.test(clause)) continue;
    for (const outcome of outcomeAssertions(clause)) grounded.add(outcome);
  }
  return grounded;
}

function checkGrounding(
  text: string,
  context: ValidationContext,
  mode: ValidationMode,
): ComposedReplyVerdict | null {
  const aliasSet = new Set(context.intent.medications.map(({ alias }) => alias.toLowerCase()));
  for (const match of text.matchAll(/\bmed_\d+\b/gi)) {
    if (mode === 'final') return fail('ungrounded_entity', `alias_in_final:${match[0]}`);
    if (!aliasSet.has(match[0].toLowerCase()))
      return fail('ungrounded_entity', `unknown_alias:${match[0]}`);
  }
  const corpus = groundingCorpus(context);
  // Numerals and time references ground by exact TOKEN equality against a corpus with every
  // medication token masked out first: 'med_1' can never ground a fabricated '1', and '10'
  // can never ground a fabricated '1' by substring.
  const maskedCorpus = maskMedicationTokensForAdvice(corpus, context.intent).toLowerCase();
  const corpusNumerals = new Set(
    [...maskedCorpus.matchAll(NUMERAL_PATTERN)].map((match) => match[0]),
  );
  const corpusTimeReferences = new Set(
    [...maskedCorpus.matchAll(TIME_REFERENCES)].map((match) => match[0].toLowerCase()),
  );
  const masked = maskMedicationTokens(text, context.intent, mode);
  for (const match of masked.matchAll(NUMERAL_PATTERN)) {
    if (!corpusNumerals.has(match[0].toLowerCase()))
      return fail('ungrounded_entity', `numeral:${match[0]}`);
  }
  for (const match of masked.matchAll(TIME_REFERENCES)) {
    const word = match[0].toLowerCase();
    // Deictic day words are true whenever uttered (the reply sends seconds after the
    // inbound) — observed live 2026-08-17 burning a retry on every casual reply. Specific
    // periods and clock times still require grounding; those can misstate.
    if (word === 'today' || word === 'tonight') continue;
    if (!corpusTimeReferences.has(word)) return fail('ungrounded_entity', `time_reference:${word}`);
  }
  const corpusOutcomes = groundedCorpusOutcomes(normalizeForSms(maskedCorpus));
  for (const outcome of outcomeAssertions(masked)) {
    if (!corpusOutcomes.has(outcome)) return fail('ungrounded_entity', `outcome:${outcome}`);
  }
  for (const hit of synonymHits(text)) {
    if (!corpus.includes(hit.matchedPhrase.toLowerCase()))
      return fail('ungrounded_entity', `symptom:${hit.matchedPhrase}`);
  }
  return null;
}

function checkCoverage(text: string, context: ValidationContext): ComposedReplyVerdict | null {
  const lower = text.toLowerCase();
  for (const token of context.intent.requiredTokens) {
    const dealiased = dealiasText(token, context.intent.medications);
    if (!lower.includes(token.toLowerCase()) && !lower.includes(dealiased.toLowerCase()))
      return fail('missing_required_token', token);
  }
  return null;
}

const QUESTION_MARKS = /[?？؟]/gu;

function questionSpan(text: string, markIndex: number): string {
  const spanStart = Math.max(
    ...['.', '!', '\n', '?', '？', '؟'].map((boundary) =>
      text.lastIndexOf(boundary, markIndex - 1),
    ),
    -1,
  );
  return text.slice(spanStart + 1, markIndex + 1);
}

const MED_ALIAS_TOKEN = /\bmed_\d+\b/giu;

/**
 * Grounded = every med_N alias the span names is a real medication on the patient's own list
 * (never a fabricated or out-of-range alias); a purely generic dose/medication word with no
 * specific alias (e.g. "your dose") is grounded as long as the patient has at least one
 * medication on record to be asking about. On 'final' mode the span carries de-aliased
 * DISPLAY names instead of med_N tokens (validateComposedReply's second, post-de-alias pass),
 * so no med_N token is ever found there — falling through to the same "patient has a
 * medication on record" check is correct: 'aliased' mode already vetted the alias itself.
 */
function groundedGreetingMedicationReference(span: string, context: ValidationContext): boolean {
  // A dose probe is only answerable when the intent actually carries the dose state it asks
  // about. "Grounded" used to mean nothing more than "the patient has a medication on file", so
  // an orientation turn — whose only fact is that nothing was recorded — could still ask whether
  // a dose was taken when no dose exists or is due, and the patient may take an unscheduled one.
  // The plan's own greeting design supplies exactly this ("code fetches next dose / open question
  // / recent recorded state into the intent"); until such a fact is present the probe falls to
  // the deterministic template floor rather than inventing a dose.
  if (!context.intent.patientFacts.some((fact) => MEDICATION_REFERENCE.test(fact))) return false;
  const aliasesInSpan = [...span.matchAll(MED_ALIAS_TOKEN)].map((match) => match[0].toLowerCase());
  if (aliasesInSpan.length === 0) return context.intent.medications.length > 0;
  // The owner signed off on ONE grounded dose question inside a greeting — not a battery of
  // them. A span naming two medications ("how are the med_1 and med_2 doses going?") is two
  // dose probes wearing one question mark, which the '?'-count cap alone never saw.
  if (new Set(aliasesInSpan).size > 1) return false;
  const validAliases = new Set(context.intent.medications.map(({ alias }) => alias.toLowerCase()));
  return aliasesInSpan.every((alias) => validAliases.has(alias));
}

/** Function words exempt from the authored-question per-word grounding check. */
const AUTHORED_QUESTION_STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'at',
  'is',
  'are',
  'was',
  'were',
  'do',
  'does',
  'did',
  'you',
  'your',
  'it',
  'this',
  'that',
  'i',
  'my',
  'me',
  'we',
  'our',
  'for',
  'with',
  'any',
  'has',
  'have',
  'had',
  'so',
  'if',
  'but',
  'not',
  'the',
]);

/**
 * Wave 1e item 4 — the authored-question grounding gate: every content word in the question
 * span must be either in the closed context-question glossary (AUTHORED_QUESTION_GLOSSARY) or
 * in the patient's own words today (their own vocabulary, never invented). Numerals, times, and
 * outcome assertions are already covered by checkGrounding earlier in the chain — this covers
 * ordinary words specifically, which the fixed keyVocabulary anchor does not reach for a
 * freshly-authored (non-bank) phrasing.
 */
function isAuthoredQuestionGrounded(span: string, context: ValidationContext): boolean {
  if (AUTHORED_QUESTION_FORBIDDEN_VERB.test(span)) return false;
  const patientCorpus = [
    context.dayContext.latestPatientMessage,
    ...context.dayContext.messages
      .filter(({ direction }) => direction === 'inbound')
      .map(({ body }) => body),
  ]
    .join(' ')
    .toLowerCase();
  const patientWords = new Set(
    patientCorpus.split(/[^a-z0-9']+/u).filter((word) => word.length > 0),
  );
  const words = span
    .toLowerCase()
    .replace(MED_ALIAS_TOKEN, ' ')
    .split(/[^a-z0-9']+/u)
    .filter((word) => word.length > 0 && !AUTHORED_QUESTION_STOPWORDS.has(word));
  return words.every(
    (word) => AUTHORED_QUESTION_GLOSSARY.has(word) || patientWords.has(word) || /^\d+$/u.test(word),
  );
}

function checkQuestionShape(
  text: string,
  context: ValidationContext,
  mode: ValidationMode,
): ComposedReplyVerdict | null {
  const marks = [...text.matchAll(QUESTION_MARKS)];
  const { intent } = context;
  if (intent.question === undefined) {
    if (intent.kind === 'greeting') {
      if (marks.length > 1) return fail('question_shape_invalid', 'greeting_multiple_questions');
      if (marks.length === 1) {
        // A greeting question may only be phatic, EXCEPT for at most one grounded dose/
        // medication question (W1c, recorded owner sign-off 2026-08-16: "composed greetings
        // KEEP the one-grounded-question carve-out ... natural, AI-decided" — the shipped
        // validator blocked it outright, contradicting that decision). Symptom probes stay
        // blocked unconditionally — no recorded decision covers those.
        const span = questionSpan(text, marks[0]!.index);
        if (synonymHits(span).length > 0)
          return fail('question_shape_invalid', 'greeting_symptom_probe');
        // A raw display name leaking un-aliased in the ALIASED pass stays blocked
        // unconditionally — the composer contract is med_N-only there, so that's an aliasing
        // failure, not a groundable reference. On the FINAL (de-aliased) pass a display name
        // is the EXPECTED shape of an already-grounded med_N reference — skip this check there
        // (the MEDICATION_REFERENCE branch below still re-confirms groundedness).
        if (mode === 'aliased') {
          const patientNames = context.intent.medications.map(({ displayName }) =>
            displayName.toLowerCase(),
          );
          if (patientNames.some((name) => span.toLowerCase().includes(name)))
            return fail('question_shape_invalid', 'greeting_medication_probe');
        }
        if (MEDICATION_REFERENCE.test(span) && !groundedGreetingMedicationReference(span, context))
          return fail('question_shape_invalid', 'greeting_medication_probe');
      }
      return null;
    }
    return marks.length === 0 ? null : fail('question_shape_invalid', 'unexpected_question');
  }
  if (intent.question.keyVocabulary.length === 0)
    return fail('question_shape_invalid', 'empty_key_vocabulary');
  if (marks.length !== 1) return fail('question_shape_invalid', `question_count:${marks.length}`);
  const span = questionSpan(text, marks[0]!.index).toLowerCase();
  // Wave 1e item 4: on a context-battery field with authoring explicitly allowed, the
  // word-grounding gate is an AND, never a fallback. Testing the bank anchor FIRST let one
  // common bank keyword ('when', 'like', 'else', 'before', 'better') skip the gate entirely —
  // and that gate is the ONLY thing bounding free-form wording, so "When did you last speak to
  // your landlord?" and "Would you like your husband to text me instead?" both shipped.
  const authoringAllowed =
    intent.question.allowAuthoredQuestion === true &&
    CONTEXT_BATTERY_FIELDS.includes(intent.question.field);
  if (authoringAllowed && !isAuthoredQuestionGrounded(span, context))
    return fail('question_shape_invalid', 'authored_question_ungrounded');
  const anchored = intent.question.keyVocabulary.some((term) => span.includes(term.toLowerCase()));
  // Every other field keeps the strict bank-anchor-only pin unconditionally (zero change).
  return anchored || authoringAllowed
    ? null
    : fail('question_shape_invalid', 'key_vocabulary_missing');
}

/**
 * Care direction is screened on EVERY sentence and every comma/conjunction-joined clause of
 * every composed reply — the model emitting a legitimate question does not license a directive
 * riding beside it ("Got it. Tell me when it started, and rest?").
 */
function checkCareDirectives(text: string): ComposedReplyVerdict | null {
  for (const sentence of text.split(/[.!\n?？؟]+/u)) {
    const frame = ADVISORY_FRAMES.find(([pattern]) => pattern.test(sentence));
    if (frame !== undefined) return fail('advice_pattern', `advisory_frame:${frame[1]}`);
    for (const clause of sentence.split(/[,;:]+|\s+(?:and|then|or)\s+/iu)) {
      const head = clause.trim().replace(LEADING_DISCOURSE, '').trim();
      const directive = CARE_DIRECTIVE_VERB.exec(head);
      if (directive !== null) return fail('advice_pattern', `care_directive:${directive[0]}`);
    }
  }
  return null;
}

function checkAdvicePatterns(
  text: string,
  context: ValidationContext,
  mode: ValidationMode,
): ComposedReplyVerdict | null {
  const masked = maskMedicationTokens(text, context.intent, mode);
  if (DOSE_UNIT_PATTERN.test(masked)) return fail('advice_pattern', 'dose_units');
  const patientNames = new Set(
    context.intent.medications.map(({ displayName }) => displayName.toLowerCase()),
  );
  const lower = text.toLowerCase();
  for (const drug of COMMON_DRUG_NAMES) {
    if (new RegExp(`\\b${drug}\\b`, 'i').test(lower) && !patientNames.has(drug))
      return fail('advice_pattern', `drug_outside_list:${drug}`);
  }
  // Anaphora defense: a medication or a care-logistics noun ANYWHERE in the reply arms the
  // advice-verb scan for EVERY sentence — "You logged med_1. Take it now." must not slip
  // through on the pronoun. Carve-outs stay per-sentence. The scan runs on advice-MASKED text
  // (aliases and display names alike become 'medication') so the carve-out's bounded object
  // list is identical in both validation passes.
  const sentences = maskMedicationTokensForAdvice(text, context.intent).split(/[.!\n?？؟]+/);
  const anySentenceReferencesCare = sentences.some(
    (sentence) =>
      MEDICATION_REFERENCE.test(sentence) ||
      CARE_LOGISTICS_REFERENCE.test(sentence) ||
      [...patientNames].some((name) => sentence.toLowerCase().includes(name)),
  );
  if (!anySentenceReferencesCare) return null;
  for (const sentence of sentences) {
    const carveOuts = [...sentence.matchAll(ADVICE_CARVE_OUT)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
    }));
    for (const verb of sentence.matchAll(ADVICE_VERBS)) {
      const inCarveOut = carveOuts.some(
        ({ start, end }) => verb.index >= start && verb.index + verb[0].length <= end,
      );
      if (!inCarveOut) return fail('advice_pattern', `advice_verb:${verb[0]}`);
    }
  }
  return null;
}

function checkReassurance(text: string): ComposedReplyVerdict | null {
  const lower = normalizeForSms(text).toLowerCase();
  const phrase = REASSURANCE_PHRASES.find((entry) => lower.includes(entry));
  return phrase === undefined ? null : fail('reassurance_phrase', phrase);
}

/**
 * The trailing \b made every ordinary inflection invisible — "severely", "seriously",
 * "urgently", "dangerously" all shipped where "severe"/"serious" were blocked, letting the
 * composer put a triage label on a symptom in a patient-facing SMS. Matching the STEM plus any
 * word characters covers every inflection with no per-term list to maintain.
 */
function checkSeverityTerms(text: string): ComposedReplyVerdict | null {
  for (const term of BANNED_SEVERITY_TERMS) {
    if (new RegExp(`\\b${term}\\w*`, 'i').test(text)) return fail('banned_severity_term', term);
  }
  return null;
}

function checkGsmAndLength(text: string): ComposedReplyVerdict | null {
  if (!isGsm7(text)) return fail('not_gsm7', 'non_gsm7_character');
  const codePoints = [...text].length;
  if (codePoints > COMPOSER_MAX_CODE_POINTS) {
    return fail('over_length', `code_points:${codePoints}`, codePoints - COMPOSER_MAX_CODE_POINTS);
  }
  return null;
}

/**
 * Wave 1e item 4 — re-derives whether an ACCEPTED question text used the authored path
 * (grounding gate) rather than the bank anchor, so the caller can flag it for the composition
 * audit record ("every AI-authored question is stored and flagged"). Cheap and side-effect
 * free; only ever called after the text has already passed the real gate in checkQuestionShape.
 *
 * Now that the grounding gate is an AND rather than a fallback, "which branch accepted" IS the
 * bank-anchor test: every authoring-enabled question passed the word-grounding gate, and the
 * anchor is what distinguishes bank wording from free-form wording. Residual: a grounded
 * rephrasing that happens to contain a bank keyword audits as bank wording.
 */
function authoredQuestionUsed(text: string, intent: ComposerIntent): boolean {
  const question = intent.question;
  if (
    question === undefined ||
    question.allowAuthoredQuestion !== true ||
    !CONTEXT_BATTERY_FIELDS.includes(question.field)
  )
    return false;
  const marks = [...text.matchAll(QUESTION_MARKS)];
  if (marks.length !== 1) return false;
  const span = questionSpan(text, marks[0]!.index).toLowerCase();
  return !question.keyVocabulary.some((term) => span.includes(term.toLowerCase()));
}

function validateSmsText(
  text: string,
  context: ValidationContext,
  mode: ValidationMode,
): ComposedReplyVerdict | null {
  return (
    checkInjection(text) ??
    checkGrounding(text, context, mode) ??
    checkCoverage(text, context) ??
    checkQuestionShape(text, context, mode) ??
    // Validator 5 runs on advice-masked text: 'med_1' and display names become 'medication'
    // so the shared module's noun window sees them.
    (containsProhibitedMedicationAdvice(maskMedicationTokensForAdvice(text, context.intent))
      ? fail('prohibited_medication_advice', 'medication_change_instruction')
      : null) ??
    checkAdvicePatterns(text, context, mode) ??
    checkCareDirectives(text) ??
    checkReassurance(text) ??
    checkSeverityTerms(text) ??
    checkGsmAndLength(text)
  );
}

// ---------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------

/**
 * Compose-time gate: parses the raw model output ({"sms": "..."} only), validates the
 * aliased text, de-aliases deterministically, then re-validates the FINAL text (the 320
 * code-point ceiling applies to what is actually stored — the DB column errors, it never
 * truncates). Returns the final de-aliased sms on success.
 */
// The model sometimes wraps its JSON in a markdown code fence despite the prompt asking
// for raw JSON (observed live 2026-08-17: both attempts fenced, forcing template
// fallback). Unwrap ONLY when the entire output is a single fenced block; everything
// else reaches JSON.parse unchanged.
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const body = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/u.exec(trimmed)?.[1];
  return body === undefined ? trimmed : body.trim();
}

export function validateComposedReply(
  raw: string,
  intent: ComposerIntent,
  dayContext: ComposerDayContext,
): ComposedReplyVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return fail('malformed_output', 'not_json');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    typeof (parsed as { readonly sms?: unknown }).sms !== 'string'
  ) {
    return fail('malformed_output', 'not_sms_object');
  }
  const aliasedSms = normalizeForSms((parsed as { readonly sms: string }).sms).trim();
  if (aliasedSms.length === 0) return fail('malformed_output', 'empty_sms');

  const context: ValidationContext = { intent, dayContext };
  const aliasedFailure = validateSmsText(aliasedSms, context, 'aliased');
  if (aliasedFailure !== null) return aliasedFailure;

  const finalSms = normalizeForSms(dealiasText(aliasedSms, intent.medications)).trim();
  const finalFailure = validateSmsText(finalSms, context, 'final');
  if (finalFailure !== null) return finalFailure;

  return {
    ok: true,
    sms: finalSms,
    ...(authoredQuestionUsed(finalSms, intent) ? { authored: true } : {}),
  };
}

/**
 * Send-time re-check on the stored composed body (tamper/bit-rot defense replacing
 * render-equality for composed rows). Runs on the stored bytes as-is — no re-normalization,
 * so any drift from what was validated at compose time fails loudly.
 */
export function validateStoredComposedSms(
  sms: string,
  intent: ComposerIntent,
  dayContext: ComposerDayContext,
): ComposedReplyVerdict {
  if (sms.trim().length === 0) return fail('malformed_output', 'empty_sms');
  const failure = validateSmsText(sms, { intent, dayContext }, 'final');
  return failure ?? { ok: true, sms };
}
