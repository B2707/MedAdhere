// packages/shared/src/safety-lexicon.ts
//
// The shared safety contract (Phase-4 04-01 item 2): the SC3 safety-prefilter lexicon, the
// SC7 STOP/HELP keyword helpers, and the two SAFETY-04 auto-reply templates. Consumed by
// BOTH the inbound Lambda (the divert path that must never depend on the LLM) and the eval
// harness (the exported tagged term list drives the gold-set "lexicon-matchable" slice
// tagging, which is what makes prefilter-recall = 1.0 on that slice checkable offline, SC6).
//
// Regex-vs-LLM boundary (regex-vs-llm-structured-text, decision recorded 2026-07-03):
// the lexicon owns the DETERMINISTIC slice — explicit, literal acute-physical / crisis
// phrasings a regex can match with certainty. Everything semantic (novel phrasings, mild
// side effects like "a bit dizzy", negations) is the MODEL's boundary via safety_flag —
// deliberately NOT matched here. Recall on the semantic slice is the model's metric, not
// the lexicon's.
//
// Backtracking safety (pre-exec gate, ULTRA LOW batch): every pattern is a fixed-word
// alternation with `\s+` separators and `\b` boundaries — no nested quantifiers, no
// unbounded wildcards — so matching is linear in the (already bounded) input length.

export const PREFILTER_MAX_CHARS = 2000;

export type SafetyCategory = 'acute_physical' | 'crisis';
export type SafetyLanguage = 'en' | 'fr' | 'es' | 'ar';

export interface LexiconTerm {
  /** Stable identifier — drives gold-set slice tagging (SC6). Unique across the lexicon. */
  readonly tag: string;
  readonly category: SafetyCategory;
  /** Omitted for the original English terms. */
  readonly language?: Exclude<SafetyLanguage, 'en'>;
  /** Lower-case pattern; input is case-folded before matching. No /g (stateless). */
  readonly pattern: RegExp;
  /** A canonical matching utterance — self-tested (every example must match its own tag). */
  readonly example: string;
}

export const SAFETY_LEXICON: readonly LexiconTerm[] = [
  // ---- crisis -------------------------------------------------------------------------
  {
    tag: 'kill_self',
    category: 'crisis',
    pattern: /\bkill(?:ing)?\s+myself\b/,
    example: 'I want to kill myself',
  },
  {
    tag: 'suicide',
    category: 'crisis',
    pattern: /\bsuicid(?:e|al)\b/,
    example: 'feeling suicidal today',
  },
  {
    tag: 'end_life',
    category: 'crisis',
    pattern: /\bend\s+my\s+life\b/,
    example: 'i want to end my life',
  },
  {
    tag: 'want_to_die',
    category: 'crisis',
    pattern: /\bwant(?:\s+to)?\s+die\b/,
    example: 'some days I just want to die',
  },
  {
    tag: 'self_harm',
    category: 'crisis',
    pattern: /\b(?:self[-\s]?harm|hurt(?:ing)?\s+myself)\b/,
    example: 'been thinking about hurting myself',
  },
  {
    tag: 'better_off_dead',
    category: 'crisis',
    pattern: /\bbetter\s+off\s+dead\b/,
    example: 'everyone would be better off dead without me around',
  },
  {
    tag: 'no_reason_to_live',
    category: 'crisis',
    pattern: /\bno\s+reason\s+to\s+live\b/,
    example: 'there is no reason to live anymore',
  },
  // ---- acute_physical -----------------------------------------------------------------
  {
    tag: 'chest_pain',
    category: 'acute_physical',
    pattern: /\bchest\s+(?:pain|tightness|pressure)\b/,
    example: 'having chest pain since this morning',
  },
  {
    tag: 'cant_breathe',
    category: 'acute_physical',
    pattern: /\b(?:can'?t|cannot|trouble|hard\s+to|difficulty)\s+breath(?:e|ing)\b/,
    example: "took it but now I can't breathe",
  },
  {
    tag: 'short_of_breath',
    category: 'acute_physical',
    pattern: /\bshort(?:ness)?\s+of\s+breath\b/,
    example: 'very short of breath after the dose',
  },
  {
    tag: 'chest_pain_fr',
    category: 'acute_physical',
    language: 'fr',
    pattern: /\b(?:douleur\s+(?:à\s+la\s+)?poitrine|douleur\s+thoracique)\b/u,
    example: 'douleur à la poitrine',
  },
  {
    tag: 'cant_breathe_fr',
    category: 'acute_physical',
    language: 'fr',
    pattern:
      /\b(?:je\s+ne\s+peux\s+pas|je\s+n['’]?arrive\s+pas\s+à|j['’]?arrive\s+pas\s+à)\s+respirer\b/u,
    example: 'je ne peux pas respirer',
  },
  {
    tag: 'suicide_fr',
    category: 'crisis',
    language: 'fr',
    pattern: /\b(?:je\s+veux\s+me\s+suicider|je\s+suis\s+suicidaire|je\s+pense\s+au\s+suicide)\b/u,
    example: 'je veux me suicider',
  },
  {
    tag: 'want_to_die_fr',
    category: 'crisis',
    language: 'fr',
    pattern: /\bje\s+veux\s+mourir\b/u,
    example: 'je veux mourir',
  },
  {
    tag: 'self_harm_fr',
    category: 'crisis',
    language: 'fr',
    pattern: /\bje\s+veux\s+me\s+faire\s+du\s+mal\b/u,
    example: 'je veux me faire du mal',
  },
  {
    tag: 'overdose_fr',
    category: 'acute_physical',
    language: 'fr',
    pattern: /\b(?:j[' ]ai\s+pris\s+une\s+surdose|surdosage)\b/u,
    example: "j'ai pris une surdose",
  },
  {
    tag: 'chest_pain_es',
    category: 'acute_physical',
    language: 'es',
    pattern: /\bdolor\s+en\s+el\s+pecho\b/u,
    example: 'dolor en el pecho',
  },
  {
    tag: 'cant_breathe_es',
    category: 'acute_physical',
    language: 'es',
    pattern: /\bno\s+puedo\s+respirar\b/u,
    example: 'no puedo respirar',
  },
  {
    tag: 'suicide_es',
    category: 'crisis',
    language: 'es',
    pattern: /\b(?:quiero\s+suicidarme|soy\s+suicida)\b/u,
    example: 'quiero suicidarme',
  },
  {
    tag: 'want_to_die_es',
    category: 'crisis',
    language: 'es',
    pattern: /\bquiero\s+morir\b/u,
    example: 'quiero morir',
  },
  {
    tag: 'self_harm_es',
    category: 'crisis',
    language: 'es',
    pattern: /\bquiero\s+hacerme\s+daño\b/u,
    example: 'quiero hacerme daño',
  },
  {
    tag: 'overdose_es',
    category: 'acute_physical',
    language: 'es',
    pattern: /\b(?:tengo\s+una\s+sobredosis|sobredosis)\b/u,
    example: 'tengo una sobredosis',
  },
  {
    tag: 'chest_pain_ar',
    category: 'acute_physical',
    language: 'ar',
    pattern: /ألم\s+في\s+الصدر/u,
    example: 'لدي ألم في الصدر',
  },
  {
    tag: 'cant_breathe_ar',
    category: 'acute_physical',
    language: 'ar',
    pattern: /لا\s+(?:أستطيع|استطيع)\s+التنفس/u,
    example: 'لا أستطيع التنفس',
  },
  {
    tag: 'suicide_ar',
    category: 'crisis',
    language: 'ar',
    pattern: /أريد\s+الانتحار/u,
    example: 'أريد الانتحار',
  },
  {
    tag: 'want_to_die_ar',
    category: 'crisis',
    language: 'ar',
    pattern: /أريد\s+أن\s+أموت/u,
    example: 'أريد أن أموت',
  },
  {
    tag: 'self_harm_ar',
    category: 'crisis',
    language: 'ar',
    pattern: /أريد\s+إيذاء\s+نفسي/u,
    example: 'أريد إيذاء نفسي',
  },
  {
    tag: 'overdose_ar',
    category: 'acute_physical',
    language: 'ar',
    pattern: /أخذت\s+جرعة\s+زائدة/u,
    example: 'أخذت جرعة زائدة',
  },
  {
    tag: 'overdose',
    category: 'acute_physical',
    pattern: /\b(?:overdos(?:e|ed|ing)|took\s+too\s+many)\b/,
    example: 'I think I took too many pills',
  },
  // Healthcare-review MEDIUM fix (2026-07-03): "heart attack" is literal, SMS-common, and squarely
  // in the deterministic slice — chest_pain alone did not cover it.
  {
    tag: 'heart_attack',
    category: 'acute_physical',
    pattern: /\bheart\s+attack\b/,
    example: "I think I'm having a heart attack",
  },
  // Healthcare-review MEDIUM fix (2026-07-03): all inflections of "pass out" — 'passing out' is as
  // common as 'passed out' for the same clinical event.
  {
    tag: 'fainted',
    category: 'acute_physical',
    pattern: /\b(?:pass(?:ed|ing|es)?\s+out|faint(?:ed|ing)?|blacked\s+out)\b/,
    example: 'I passed out after the dose',
  },
  {
    tag: 'seizure',
    category: 'acute_physical',
    pattern: /\bseizures?\b/,
    example: 'had a seizure an hour after taking it',
  },
  {
    tag: 'allergic_reaction',
    category: 'acute_physical',
    pattern: /\b(?:allergic\s+reaction|anaphyla)/,
    example: 'having an allergic reaction to the new pill',
  },
  {
    tag: 'swelling_airway',
    category: 'acute_physical',
    pattern: /\b(?:throat|face|tongue|lips?)\s+(?:is\s+|are\s+)?swell(?:ing|ed)\b/,
    example: 'my throat is swelling up',
  },
  {
    tag: 'vomiting_blood',
    category: 'acute_physical',
    pattern: /\b(?:vomit(?:ing)?|throwing\s+up|coughing\s+up)\s+blood\b/,
    example: 'been throwing up blood since last night',
  },
  {
    tag: 'uncontrolled_bleeding',
    category: 'acute_physical',
    pattern: /\b(?:bleeding\s+(?:a\s+lot|won'?t\s+stop)|won'?t\s+stop\s+bleeding)\b/,
    example: "cut myself and it won't stop bleeding",
  },
  {
    tag: 'stroke_signs',
    category: 'acute_physical',
    pattern:
      /\b(?:face\s+droop(?:ing)?|slurr(?:ed|ing)\s+speech|numb(?:ness)?\s+(?:on\s+)?one\s+side)\b/,
    example: 'my speech is slurred and my arm is numb on one side',
  },
  {
    tag: 'er_mention',
    category: 'acute_physical',
    pattern: /\b(?:call(?:ed|ing)?\s+911|going\s+to\s+the\s+er\b|emergency\s+room)/,
    example: 'on my way to the emergency room',
  },
] as const;

export interface PrefilterResult {
  readonly hit: boolean;
  /** Crisis takes precedence when both categories match (SC3). */
  readonly category: SafetyCategory | null;
  readonly language: SafetyLanguage | null;
  readonly matchedTags: readonly string[];
}

/** Case-fold + normalize curly apostrophes so `can’t` matches `can't` patterns. */
function normalizeForMatch(rawBody: string): string {
  return rawBody
    .slice(0, PREFILTER_MAX_CHARS)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'");
}

/**
 * The SC3 safety prefilter: deterministic, LLM-independent, linear-time. Input is bounded
 * to PREFILTER_MAX_CHARS (aligned with the classifier's defensive truncation) — a hit
 * buried past the bound is the semantic detector's job, not the lexicon's.
 */
export function runSafetyPrefilter(rawBody: string, expectedLanguage?: string): PrefilterResult {
  const bounded = normalizeForMatch(rawBody);
  const matchedTerms = SAFETY_LEXICON.filter((term) => term.pattern.test(bounded));
  const matchedTags = matchedTerms.map((term) => term.tag);
  if (matchedTerms.length === 0) {
    return { hit: false, category: null, language: null, matchedTags };
  }
  const category = matchedTerms.some((term) => term.category === 'crisis')
    ? 'crisis'
    : 'acute_physical';
  const localizedTerm = matchedTerms.find(
    (term) => term.category === category && term.language !== undefined,
  );
  const expectedLanguageBase = expectedLanguage?.toLowerCase().split('-')[0];
  const hintedLanguage =
    expectedLanguageBase === 'fr' ||
    expectedLanguageBase === 'es' ||
    expectedLanguageBase === 'ar' ||
    expectedLanguageBase === 'en'
      ? expectedLanguageBase
      : undefined;
  return {
    hit: true,
    category,
    language: localizedTerm?.language ?? hintedLanguage ?? 'en',
    matchedTags,
  };
}

// ---- STOP/HELP (SC7 amendment: EXACT standalone keyword after trim/case-fold) -----------
// The STOP set matches Twilio's default opt-out keywords so app-side state converges with
// Twilio Advanced Opt-Out (which processes the same words upstream). Embedded mentions
// ("please stop texting", "I want to stop taking it") are medication replies, NOT opt-outs.

export const STOP_KEYWORDS: readonly string[] = [
  'stop',
  'stopall',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
];

export const HELP_KEYWORDS: readonly string[] = ['help', 'info'];
export const START_KEYWORDS: readonly string[] = ['start', 'unstop'];

function foldKeyword(body: string): string {
  return body.trim().toLowerCase();
}

export function isStopKeyword(body: string): boolean {
  return STOP_KEYWORDS.includes(foldKeyword(body));
}

export function isStartKeyword(body: string): boolean {
  return START_KEYWORDS.includes(foldKeyword(body));
}

export function isHelpKeyword(body: string): boolean {
  return HELP_KEYWORDS.includes(foldKeyword(body));
}

// ---- SAFETY-04 auto-reply templates (detect-and-redirect — never triage) -----------------
// Severity-language-free (pre-exec gate definition): triage ADJECTIVES are banned; the
// 911/988/811 DIRECTIVES are required. Two-sided guard: the unit tests assert the
// directives are present AND no banned term appears; the CI grep-guard enforces the same
// ban repo-side. BANNED_SEVERITY_TERMS is the single source both consume.

export const BANNED_SEVERITY_TERMS: readonly string[] = [
  'severe',
  'serious',
  'critical',
  'urgent',
  'life-threatening',
  'dangerous',
];

const SAFETY_AUTO_REPLY_EMERGENCY_BY_LANGUAGE = {
  en:
    'MedAdhere: thank you for your message. If you need help right away, call 911. ' +
    'To talk with someone about how you are feeling, call or text 988 any time.',
  fr:
    'MedAdhere : merci pour votre message. Si vous avez besoin d’aide immédiatement, appelez le 911. ' +
    'Pour parler à quelqu’un de ce que vous ressentez, appelez ou textez le 988 en tout temps.',
  es:
    'MedAdhere: gracias por su mensaje. Si necesita ayuda de inmediato, llame al 911. ' +
    'Para hablar con alguien sobre cómo se siente, llame o envíe un mensaje de texto al 988 en cualquier momento.',
  ar:
    'MedAdhere: شكرًا لرسالتك. إذا كنت بحاجة إلى مساعدة فورية، فاتصل بالرقم 911. ' +
    'للتحدث مع شخص عما تشعر به، اتصل أو أرسل رسالة نصية إلى 988 في أي وقت.',
} as const satisfies Record<SafetyLanguage, string>;

function safetyLanguageBase(language: string): SafetyLanguage {
  const base = language.toLowerCase().split('-')[0];
  return base === 'fr' || base === 'es' || base === 'ar' ? base : 'en';
}

/** Acute-physical / crisis divert reply (SC3 → SAFETY-04). */
export function safetyAutoReplyEmergency(language: string): string {
  return SAFETY_AUTO_REPLY_EMERGENCY_BY_LANGUAGE[safetyLanguageBase(language)];
}

/** Backwards-compatible English default for callers that do not yet know the language. */
export const SAFETY_AUTO_REPLY_EMERGENCY = SAFETY_AUTO_REPLY_EMERGENCY_BY_LANGUAGE.en;

/** medical_question softer redirect (SAFETY-04 — no alarm email, review-queue surfaced). */
export const SAFETY_AUTO_REPLY_MEDICAL_QUESTION =
  'MedAdhere: thank you for your question. This number cannot give medical advice. ' +
  'To speak with a registered nurse, call 811. A note has been made for the research team.';

/**
 * HELP keyword auto-reply (SC7 / OPS-01 — Plan 04-02 step 6, returned as the TwiML
 * <Message> response). Lives with the other templates so the severity ban + the CI
 * grep-guard cover it identically. Names the opt-out and the 811 nurse line; never advice.
 */
/**
 * Phase-8 08-05 (audit M-13) — the fixed reply to an authenticated message carrying media.
 * The attachment is never fetched and never reaches the model; the reply only restates the
 * text-only boundary so the patient knows the message was not read.
 */
export const MEDIA_UNSUPPORTED_REPLY =
  'MedAdhere: this number can only read plain text messages, so an attachment cannot be ' +
  'reviewed. Please reply in text. For health questions, call 811. Reply STOP to opt out.';

/**
 * Phase-8 08-05 (audit M-04) — the single over-limit notice. Sent once per exhausted window;
 * later messages inside the same window are stored without any reply.
 */
export const INTAKE_LIMIT_NOTICE =
  'MedAdhere: your messages have been received and saved, but this number can only reply to a ' +
  'limited number each day. Please wait before sending more. For health questions, call 811.';

export const HELP_AUTO_REPLY =
  'MedAdhere: this is an automated medication check-in for a research study. ' +
  'Reply STOP to opt out at any time. For health questions, call 811. ' +
  'This inbox is not monitored by medical staff.';
