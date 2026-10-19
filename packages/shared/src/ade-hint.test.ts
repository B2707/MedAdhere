import { describe, it, expect } from 'vitest';
import {
  adeHintInputSchema,
  buildAdeHint,
  type AdeHintInput,
  type AdeHintLevel,
} from './ade-hint.js';

// MedFlow discipline (ported anti-pattern guard): a label-match hint is ASSOCIATIVE,
// never causal or diagnostic. These are the causal verbs the output must never contain.
const CAUSAL_VERBS = ['causes', 'caused', 'due to', 'resulted in', 'leads to', 'induced'];

describe('buildAdeHint — associative, non-causal label-match hint', () => {
  const infoRow: AdeHintInput = {
    matched_phrase: 'felt dizzy',
    meddra_pt: 'Dizziness',
    hint_level: 'info',
  };
  const elevatedRow: AdeHintInput = {
    matched_phrase: 'fainted',
    meddra_pt: 'Syncope',
    hint_level: 'elevated',
  };

  it('accepts the exact label_match database row shape at both hint levels', () => {
    expect(adeHintInputSchema.parse(infoRow)).toEqual(infoRow);
    expect(adeHintInputSchema.parse(elevatedRow)).toEqual(elevatedRow);
  });

  it('rejects the legacy level and legacy camel-case input shape', () => {
    expect(
      adeHintInputSchema.safeParse({
        matched_phrase: 'felt dizzy',
        meddra_pt: 'Dizziness',
        hint_level: 'listed',
      }).success,
    ).toBe(false);
    expect(adeHintInputSchema.safeParse({ term: 'Dizziness', hintLevel: 'info' }).success).toBe(
      false,
    );
  });

  it('requires both matched_phrase and meddra_pt evidence fields', () => {
    expect(
      adeHintInputSchema.safeParse({ meddra_pt: 'Dizziness', hint_level: 'info' }).success,
    ).toBe(false);
    expect(
      adeHintInputSchema.safeParse({ matched_phrase: 'felt dizzy', hint_level: 'info' }).success,
    ).toBe(false);
  });

  it('never emits a causal verb, at either hint level (NO-CAUSAL-VERB)', () => {
    const levels: readonly AdeHintLevel[] = ['info', 'elevated'];
    for (const hintLevel of levels) {
      const out = buildAdeHint({
        matched_phrase: 'felt nauseated',
        meddra_pt: 'Nausea',
        hint_level: hintLevel,
      }).toLowerCase();
      for (const verb of CAUSAL_VERBS) {
        expect(out).not.toContain(verb);
      }
    }
  });

  it('is deterministic for a fixed input', () => {
    const a = buildAdeHint(infoRow);
    const b = buildAdeHint(infoRow);
    expect(a).toBe(b);
  });

  it('names both the patient phrase and the mapped MedDRA preferred term', () => {
    const output = buildAdeHint(infoRow);
    expect(output).toContain('felt dizzy');
    expect(output).toContain('Dizziness');
  });

  it('carries the explicit associative-not-causal disclaimer clause', () => {
    expect(buildAdeHint(infoRow)).toContain('associative only, not a causal or diagnostic finding');
  });

  it('attributes info hints to OnSIDES and names both possible elevated sections', () => {
    const info = buildAdeHint({ ...infoRow, hint_level: 'info' });
    const elevated = buildAdeHint({ ...infoRow, hint_level: 'elevated' });
    expect(info).not.toBe(elevated);
    expect(info).toContain('OnSIDES-extracted FDA labeling');
    expect(elevated.toLowerCase()).toContain('boxed warning');
    expect(elevated.toLowerCase()).toContain('warnings-and-precautions');
    expect(elevated.toLowerCase()).not.toContain('boxed-warning/elevated prominence');
  });

  it.each(['info', 'elevated'] as const)(
    'keeps the non-causal clause and ends %s hints with an action cue',
    (hintLevel) => {
      const output = buildAdeHint({ ...infoRow, hint_level: hintLevel });
      expect(output).toContain('associative only, not a causal or diagnostic finding.');
      expect(output).toMatch(/Consider reviewing\.$/);
    },
  );

  it('never renders undefined for either exact database-shaped input', () => {
    expect(buildAdeHint(infoRow)).not.toContain('undefined');
    expect(buildAdeHint(elevatedRow)).not.toContain('undefined');
  });
});
