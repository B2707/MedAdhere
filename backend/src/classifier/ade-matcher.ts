/**
 * ade-matcher.ts — 04-06 DRUG-02, component 3: the PURE ADE matcher core.
 *
 * Given a reply's text, its classifier reason_code, and the patient's drug label effects
 * (INJECTED — H2, mirroring classifyReplyText's DI so this core does no I/O and never
 * throws), decide whether any reported symptom matches a known label side effect of that
 * drug. The impure handler shell loads the effects (readFileSync) and writes the rows.
 *
 * Returns a U-20 status (H5) so an EMPTY candidate list is never ambiguous downstream:
 *   no_symptom      — no side_effect signal and no lay-phrase hit; nothing to check
 *   no_drug_profile — a symptom was reported but the patient has no frozen rxcui
 *   no_label_data   — rxcui present but the drug has no vendored OnSIDES label data
 *   checked_no_match— label data present, symptom checked, no PT overlap
 *   matched         — one or more (matched_phrase, PT) candidates
 */
import { synonymHits } from '@medadhere/shared';
import type { HintLevel, OnsidesEffect } from './onsides.js';

export type AdeMatchStatus =
  | 'no_symptom'
  | 'symptom_unmapped'
  | 'no_drug_profile'
  | 'no_label_data'
  | 'checked_no_match'
  | 'matched';

export interface AdeMatchCandidate {
  /** Verbatim matched reply fragment (M1 / U-13 — the exact span, never the whole body). */
  readonly matchedPhrase: string;
  /** Canonical MedDRA PT as it appears on the drug's label (the effect's own casing). */
  readonly meddraPt: string;
  readonly hintLevel: HintLevel;
}

export interface MatchAdeInput {
  readonly text: string;
  readonly reasonCode: string;
  /** Frozen RxNorm ingredient id, or null when the patient has no resolved drug profile. */
  readonly rxcui: string | null;
  /** The drug's vendored OnSIDES effects (empty when no label data). */
  readonly effects: readonly OnsidesEffect[];
  /** onsidesHasLabelData(rxcui) — true iff the asset carries ANY label data for this drug. */
  readonly hasLabelData: boolean;
}

export interface AdeMatchResult {
  readonly status: AdeMatchStatus;
  readonly candidates: readonly AdeMatchCandidate[];
}

const EMPTY: readonly AdeMatchCandidate[] = [];

export function matchAde(input: MatchAdeInput): AdeMatchResult {
  const hits = synonymHits(input.text);

  // Trigger = classifier said side_effect OR a lay-phrase matched. No trigger → nothing to do.
  if (input.reasonCode !== 'side_effect' && hits.length === 0) {
    return { status: 'no_symptom', candidates: EMPTY };
  }
  // MEDIUM-1: the classifier flagged a side effect but the lay-phrase map produced no PT to
  // intersect. This is NOT "checked, no match" — we never had a symptom to check the label
  // against. Distinct status so a downstream clinician can't read a map coverage gap as a
  // label-cleared absence (false reassurance).
  if (hits.length === 0) return { status: 'symptom_unmapped', candidates: EMPTY };
  // A symptom was reported; establish coverage before claiming anything.
  if (!input.rxcui) return { status: 'no_drug_profile', candidates: EMPTY };
  if (!input.hasLabelData) return { status: 'no_label_data', candidates: EMPTY };

  // Case-insensitive PT index: lowercased PT → the effect's canonical form (keep label casing).
  const effectByPt = new Map<string, OnsidesEffect>();
  for (const e of input.effects) {
    const key = e.pt.toLowerCase();
    if (!effectByPt.has(key)) effectByPt.set(key, e);
  }

  const candidates: AdeMatchCandidate[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    for (const pt of hit.pts) {
      const effect = effectByPt.get(pt.toLowerCase());
      if (!effect) continue;
      const dedupKey = `${hit.matchedPhrase.toLowerCase()}::${effect.pt.toLowerCase()}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      candidates.push({
        matchedPhrase: hit.matchedPhrase,
        meddraPt: effect.pt,
        hintLevel: effect.hint_level,
      });
    }
  }

  return candidates.length > 0
    ? { status: 'matched', candidates }
    : { status: 'checked_no_match', candidates: EMPTY };
}
