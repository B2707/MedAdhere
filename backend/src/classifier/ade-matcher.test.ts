/**
 * ade-matcher.test.ts — 04-06 component 3. The PURE matcher core (H2): effects are
 * INJECTED, never loaded here, so the core is deterministic and never does I/O / throws.
 * Returns a U-20 status (H5) so "checked, no match" is distinguishable from "no label
 * data" and "no drug profile" downstream (DASH-07), never a bare empty list.
 */
import { describe, expect, it } from 'vitest';
import { matchAde } from './ade-matcher.js';
import type { OnsidesEffect } from './onsides.js';

const eff = (pt: string, hint_level: 'info' | 'elevated' = 'info'): OnsidesEffect => ({
  meddra_id: `id-${pt}`,
  pt,
  hint_level,
});

// A drug whose label lists Nausea (elevated) + Dizziness (info).
const drugEffects: OnsidesEffect[] = [eff('Nausea', 'elevated'), eff('Dizziness'), eff('Headache')];

const base = { rxcui: '860975', effects: drugEffects, hasLabelData: true };

describe('matchAde — U-20 status ladder', () => {
  it('no trigger (not side_effect, no synonym hit) → no_symptom, no candidates', () => {
    const r = matchAde({ text: 'took it this morning, all good', reasonCode: 'none', ...base });
    expect(r.status).toBe('no_symptom');
    expect(r.candidates).toEqual([]);
  });

  it('symptom present but rxcui null → no_drug_profile (the common case today)', () => {
    const r = matchAde({ text: 'I feel so nauseous', reasonCode: 'side_effect', rxcui: null, effects: [], hasLabelData: false });
    expect(r.status).toBe('no_drug_profile');
    expect(r.candidates).toEqual([]);
  });

  it('symptom + rxcui but the drug has no vendored label data → no_label_data (never false "all clear")', () => {
    const r = matchAde({ text: 'I feel so nauseous', reasonCode: 'side_effect', rxcui: '999', effects: [], hasLabelData: false });
    expect(r.status).toBe('no_label_data');
    expect(r.candidates).toEqual([]);
  });

  it('symptom maps to a PT on the drug label → matched, with canonical PT + hint from the effect', () => {
    const r = matchAde({ text: 'honestly I feel so nauseous since starting this', reasonCode: 'side_effect', ...base });
    expect(r.status).toBe('matched');
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.meddraPt).toBe('Nausea'); // canonical casing from the effect, not the map
    expect(r.candidates[0]!.hintLevel).toBe('elevated');
    expect(r.candidates[0]!.matchedPhrase.toLowerCase()).toContain('nauseous');
  });

  it('symptom present, label covered, but no PT overlap → checked_no_match (NOT no_label_data)', () => {
    // "back is killing me" → Back pain, which this drug's label does not list
    const r = matchAde({ text: 'my back is killing me', reasonCode: 'side_effect', ...base });
    expect(r.status).toBe('checked_no_match');
    expect(r.candidates).toEqual([]);
  });

  it('reason_code=side_effect but no lay-phrase hit → symptom_unmapped, NOT checked_no_match (MEDIUM-1)', () => {
    // The classifier flagged a side effect but our map produced no PT — we never checked the
    // label, so this must be distinguishable from a genuine label-cleared no-match.
    const r = matchAde({ text: 'this med just disagrees with me somehow', reasonCode: 'side_effect', ...base });
    expect(r.status).toBe('symptom_unmapped');
    expect(r.candidates).toEqual([]);
  });

  it('PT intersection is case-insensitive', () => {
    const lower: OnsidesEffect[] = [eff('nausea')]; // effect stored lower-case
    const r = matchAde({ text: 'so nauseous', reasonCode: 'side_effect', rxcui: '1', effects: lower, hasLabelData: true });
    expect(r.status).toBe('matched');
    expect(r.candidates[0]!.meddraPt).toBe('nausea'); // preserves the effect's own casing
  });

  it('dedups candidates by (matchedPhrase, meddraPt) to match the label_match replay key', () => {
    const dup: OnsidesEffect[] = [eff('Nausea'), eff('Nausea')];
    const r = matchAde({ text: 'so nauseous', reasonCode: 'side_effect', rxcui: '1', effects: dup, hasLabelData: true });
    expect(r.candidates).toHaveLength(1);
  });

  it('never throws on empty/degenerate input', () => {
    expect(() => matchAde({ text: '', reasonCode: '', rxcui: null, effects: [], hasLabelData: false })).not.toThrow();
  });
});
