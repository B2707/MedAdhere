/**
 * ade-synonyms.ts — 04-06 DRUG-02, component 2. A deterministic lay-phrase → MedDRA PT
 * map + matcher, used by the ADE matcher to translate a patient's plain-language symptom
 * into the standardized terms that appear on drug labels (OnSIDES uses MedDRA PTs).
 *
 * PROVENANCE (H8, anti train-on-test): entries are authored from GENERAL lay-medical
 * vocabulary — common ways people describe the most frequent drug side effects across
 * standard/vernacular/Gen-Z registers — NOT from the gold `ade_match` phrasings. The
 * held-out `backend/eval/ade-match-gold.csv` scores whether this general map GENERALIZES;
 * it is never the source of the map. PT strings use canonical MedDRA (British spelling,
 * e.g. "Diarrhoea", "Oedema"); the matcher intersects case-insensitively for robustness.
 *
 * Pure + deterministic: patterns carry the `i` flag but NEVER the `g` flag (a global regex
 * keeps `lastIndex` state and would make repeated calls non-deterministic).
 */

export interface AdeSynonymEntry {
  readonly pattern: RegExp;
  readonly pts: readonly string[];
}

export interface SynonymHit {
  /** The verbatim matched span from the input (M1 — the exact fragment, not the whole text). */
  readonly matchedPhrase: string;
  readonly pts: readonly string[];
}

// ~45 entries. Grouped by body system for readability; order does not matter (all are scanned).
export const ADE_SYNONYM_MAP: readonly AdeSynonymEntry[] = [
  // --- GI ---
  { pattern: /\b(stomach|tummy|belly|gut)('?s| is|s been| been)?\s*(killing|hurting|aching|upset|bothering|actin(?:g)? up|messed up)/i, pts: ['Abdominal pain', 'Abdominal pain upper'] },
  { pattern: /\b(feel(?:ing)?|felt)\s+(sick|nauseous|queasy)\b/i, pts: ['Nausea'] },
  { pattern: /\b(nausea|nauseous|queasy|sick to my stomach)\b/i, pts: ['Nausea'] },
  { pattern: /\b(throw(?:ing)?\s*up|threw up|puk(?:e|ed|ing)|vomit(?:ing|ed)?)\b/i, pts: ['Vomiting'] },
  { pattern: /\b(the runs|diarrh(?:o?ea)|loose stool|runny stomach|runnin(?:g)? to the (?:bathroom|toilet))\b/i, pts: ['Diarrhoea'] },
  { pattern: /\b(constipated|can'?t (?:poop|go)|backed up|blocked up)\b/i, pts: ['Constipation'] },
  { pattern: /\b(heartburn|acid reflux|indigestion)\b/i, pts: ['Dyspepsia'] },
  { pattern: /\b(bloated|bloating|so gassy|really gassy)\b/i, pts: ['Abdominal distension', 'Flatulence'] },
  { pattern: /\b(no appetite|not hungry|lost my appetite|don'?t (?:feel like|wanna) eat(?:ing)?)\b/i, pts: ['Decreased appetite'] },
  { pattern: /\b(always hungry|hungry all the time|can'?t stop eating)\b/i, pts: ['Increased appetite'] },
  { pattern: /\b(dry mouth|mouth('?s| is| been| feels)?\s*(so |really |super )?dry|cotton mouth)\b/i, pts: ['Dry mouth'] },
  // --- Neuro / head ---
  { pattern: /\b(head('?s| is| been)?\s*(killing|pounding|banging|bangin|hurting|throbbing)|headache|migraine)\b/i, pts: ['Headache'] },
  { pattern: /\b((?:the )?room|everything|head)('?s| is| been| keeps)?\s*spinning\b/i, pts: ['Dizziness'] },
  { pattern: /\b(dizzy|light[- ]?headed|woozy|off balance)\b/i, pts: ['Dizziness'] },
  { pattern: /\b(brain fog|foggy|can'?t (?:think|focus|concentrate)|brain('?s| is| feels)?\s*(soup|offline|mush|fried))\b/i, pts: ['Disturbance in attention'] },
  { pattern: /\b(numb(?:ness)?|tingling|pins and needles)\b/i, pts: ['Paraesthesia'] },
  { pattern: /\b(ringing in (?:my )?ears|ears (?:are )?ringing)\b/i, pts: ['Tinnitus'] },
  { pattern: /\b(blurr?y vision|vision('?s| is)?\s*blurr?y|can'?t see (?:right|straight))\b/i, pts: ['Vision blurred'] },
  // --- Sleep / energy ---
  { pattern: /\b((?:can'?t|cannot|could ?n'?t|could not|couldn) sleep|no sleep|up all night|ly(?:ing)? awake|wide awake|insomnia|haven'?t slept|barely sl(?:eep|ept))\b/i, pts: ['Insomnia'] },
  { pattern: /\b(so tired|exhausted|no energy|wiped out|drained|worn out|fatigued)\b/i, pts: ['Fatigue'] },
  { pattern: /\b(sleepy|drowsy|can'?t stay awake|nodding off|out of it|zombie)\b/i, pts: ['Somnolence'] },
  { pattern: /\b((?:weird|wild|crazy|vivid|strange)\s+dreams|nightmares?)\b/i, pts: ['Abnormal dreams'] },
  // --- Cardio ---
  { pattern: /\b(heart('?s| is| been)?\s*(racing|pounding|poundin|fluttering|going crazy)|palpitations|racing heart)\b/i, pts: ['Palpitations'] },
  { pattern: /\b(chest (?:pain|hurts|tight(?:ness)?)|tight chest|pressure in my chest)\b/i, pts: ['Chest pain'] },
  // --- Respiratory ---
  { pattern: /\b(short of breath|can'?t breathe|hard to breathe|out of breath|winded)\b/i, pts: ['Dyspnoea'] },
  { pattern: /\b(cough(?:ing)?|can'?t stop coughing)\b/i, pts: ['Cough'] },
  { pattern: /\b(stuffy nose|runny nose|congested|blocked nose)\b/i, pts: ['Rhinitis'] },
  // --- Skin ---
  { pattern: /\b(rash|breaking out|red bumps|blotchy)\b/i, pts: ['Rash'] },
  { pattern: /\b(hives|welts)\b/i, pts: ['Urticaria'] },
  { pattern: /\b(itch(?:y|ing)?|so itchy)\b/i, pts: ['Pruritus'] },
  { pattern: /\b(swollen|swelling|puffy|puffed up)\b/i, pts: ['Oedema', 'Oedema peripheral'] },
  { pattern: /\b(flushed|hot flash(?:es)?|face (?:is )?red|red in the face)\b/i, pts: ['Flushing'] },
  { pattern: /\b(sweating|night sweats|drenched in sweat|so sweaty)\b/i, pts: ['Hyperhidrosis'] },
  // --- Musculoskeletal ---
  { pattern: /\b(back (?:pain|hurts|aches)|back('?s| is)?\s*killing)\b/i, pts: ['Back pain'] },
  { pattern: /\b(joints? (?:hurt|ache|are sore)|achy joints)\b/i, pts: ['Arthralgia'] },
  { pattern: /\b(muscles? (?:hurt|ache|are sore)|achy muscles|body aches)\b/i, pts: ['Myalgia'] },
  { pattern: /\b((?:leg|muscle|calf|foot) cramp(?:s|ing)?|charley horse)\b/i, pts: ['Muscle spasms'] },
  { pattern: /\b(?:stomach|belly|tummy|abdominal|gut|menstrual|period) cramp(?:s|ing)?\b/i, pts: ['Abdominal pain'] },
  { pattern: /\b(shaky|shaking|trembling|tremors?|hands (?:won'?t )?(?:quit )?shak(?:e|ing))\b/i, pts: ['Tremor'] },
  // --- Metabolic / weight ---
  { pattern: /\b(gained (?:some )?weight|put on weight|weight gain|gaining weight|packed on)\b/i, pts: ['Weight increased'] },
  { pattern: /\b(lost weight|losing weight|dropping weight|weight loss)\b/i, pts: ['Weight decreased'] },
  { pattern: /\b(fever|temperature|burning up|feverish)\b/i, pts: ['Pyrexia'] },
  { pattern: /\b(chills|shivering|cold sweats)\b/i, pts: ['Chills'] },
  // --- Psych ---
  { pattern: /\b(anxious|anxiety|on edge|panicky|panic attacks?)\b/i, pts: ['Anxiety'] },
  { pattern: /\b(depressed|so down|low mood|no motivation)\b/i, pts: ['Depression'] },
  // --- GU / sexual ---
  { pattern: /\b(low sex drive|no sex drive|lost my (?:sex )?drive|no libido|low libido)\b/i, pts: ['Libido decreased'] },
  { pattern: /\b(bedroom (?:isn'?t|not|ain'?t) working|can'?t (?:get it up|perform)|erectile)\b/i, pts: ['Erectile dysfunction'] },
];

// Negation before a symptom span flips it: "no nausea", "not dizzy", "haven't had a
// headache", "denies chest pain" must NOT annotate. Only the ~4 tokens IMMEDIATELY
// PRECEDING the matched span are inspected — a negator INSIDE the matched idiom ("no
// appetite", "can't sleep", "can't breathe") is part of the symptom and never self-rejects.
const NEGATOR = /(?:\b(?:no|not|never|without|none|den(?:y|ies|ied)|zero|neither|nor)\b|n['’]t\b)/i;
// A contrastive conjunction ends the negation's scope: "no fever BUT so nauseous" — the
// "no" negates fever, not nausea, so only tokens after "but" count.
const CLAUSE_BOUNDARY = /\b(?:but|however|yet|though|although|otherwise|except|aside from)\b/gi;
const NEGATION_WINDOW_CHARS = 40;

function isNegated(text: string, matchIndex: number): boolean {
  let before = text.slice(Math.max(0, matchIndex - NEGATION_WINDOW_CHARS), matchIndex);
  const boundary = [...before.matchAll(CLAUSE_BOUNDARY)].pop();
  if (boundary?.index !== undefined) before = before.slice(boundary.index + boundary[0].length);
  const precedingTokens = before.trim().split(/\s+/).slice(-4).join(' ');
  return NEGATOR.test(precedingTokens);
}

/**
 * Every lay-phrase hit in `text`, each carrying the VERBATIM matched span (M1) and the
 * mapped MedDRA PTs. Deterministic and pure. Negated symptoms are dropped; duplicate spans
 * (same matched text) are collapsed so one phrase does not double-count.
 */
export function synonymHits(text: string): SynonymHit[] {
  const hits: SynonymHit[] = [];
  const seen = new Set<string>();
  for (const entry of ADE_SYNONYM_MAP) {
    const m = entry.pattern.exec(text);
    if (!m) continue;
    if (isNegated(text, m.index)) continue;
    const matchedPhrase = m[0].trim();
    const key = `${matchedPhrase.toLowerCase()}::${entry.pts.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ matchedPhrase, pts: entry.pts });
  }
  return hits;
}
