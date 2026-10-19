/**
 * ade-eval.test.ts — 04-06 component 4. The advisory ADE-matcher eval (precision/recall
 * on the held-out ade-match-gold.csv). REPORTED, never a CI gate. Deps (effects lookup +
 * coverage) are injected so the metric math is tested against synthetic drugs; the real
 * run wires them to onsidesEffectsForRxcui / onsidesHasLabelData.
 */
import { describe, expect, it } from 'vitest';
import { evaluateAdeMatcher, parseAdeGold, type AdeGoldRow } from './ade-eval.js';
import type { OnsidesEffect } from '../../src/classifier/onsides.js';

const eff = (pt: string): OnsidesEffect => ({ meddra_id: `id-${pt}`, pt, hint_level: 'info' });

// Synthetic drug '1' lists Nausea + Dizziness. Drug '2' has label data but no overlap.
const deps = {
  effectsFor: (rx: string): OnsidesEffect[] =>
    rx === '1' ? [eff('Nausea'), eff('Dizziness')] : rx === '2' ? [eff('Rash')] : [],
  hasLabelData: (rx: string) => rx === '1' || rx === '2',
};

const row = (o: Partial<AdeGoldRow>): AdeGoldRow => ({
  id: 'x', text: '', rxcui: '1', reason_code: 'side_effect',
  expected_status: 'matched', expected_pt: '', clinician_symptom: '', ...o,
});

describe('evaluateAdeMatcher — advisory precision/recall + status agreement', () => {
  it('counts a true positive when the matcher produces the expected PT for a gold match', () => {
    const r = evaluateAdeMatcher([row({ id: 'tp', text: 'so nauseous', expected_status: 'matched', expected_pt: 'Nausea' })], deps);
    expect(r.matched.tp).toBe(1);
    expect(r.matched.recall).toBe(1);
    expect(r.matched.precision).toBe(1);
  });

  it('a gold match the map fails to catch is a recall miss, not a crash', () => {
    // "my get-up-and-go is gone" describes fatigue but the map has no such phrase
    const r = evaluateAdeMatcher([row({ id: 'miss', text: 'my get-up-and-go is gone', expected_status: 'matched', expected_pt: 'Fatigue' })], deps);
    expect(r.matched.recall).toBe(0);
    expect(r.recallMisses).toContain('miss');
  });

  it('a match on a gold no-match row is a false positive (precision cost)', () => {
    // drug 2's label has only Rash; "so nauseous" must NOT match → but if it did, it is an FP.
    const r = evaluateAdeMatcher([
      row({ id: 'tp', rxcui: '1', text: 'so nauseous', expected_status: 'matched', expected_pt: 'Nausea' }),
      row({ id: 'fp', rxcui: '1', text: 'so nauseous', expected_status: 'checked_no_match', expected_pt: '' }),
    ], deps);
    expect(r.falsePositives).toContain('fp');
    expect(r.matched.precision).toBe(0.5); // 1 correct of 2 matcher-positives
  });

  it('scores the U-20 status ladder agreement (no_symptom / no_label_data / checked_no_match)', () => {
    const rows = [
      row({ id: 's', text: 'all good today', reason_code: 'none', expected_status: 'no_symptom', expected_pt: '' }),
      row({ id: 'nl', rxcui: '9', text: 'so nauseous', expected_status: 'no_label_data', expected_pt: '' }),
      row({ id: 'cnm', rxcui: '2', text: 'so nauseous', expected_status: 'checked_no_match', expected_pt: '' }),
    ];
    const r = evaluateAdeMatcher(rows, deps);
    expect(r.statusAgreement.correct).toBe(3);
    expect(r.statusAgreement.rate).toBe(1);
  });

  it('precision is null (n/a) when the matcher never produces a match', () => {
    const r = evaluateAdeMatcher([row({ id: 's', text: 'all good', reason_code: 'none', expected_status: 'no_symptom' })], deps);
    expect(r.matched.precision).toBeNull();
  });
});

describe('parseAdeGold — RFC-4180 (quoted commas)', () => {
  it('parses quoted fields containing commas', () => {
    const csv = 'id,text,rxcui,reason_code,expected_status,expected_pt,clinician_symptom\n' +
      'c01,"took it, all good",6809,none,no_symptom,,\n';
    const rows = parseAdeGold(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('took it, all good');
    expect(rows[0].expected_status).toBe('no_symptom');
  });
});
