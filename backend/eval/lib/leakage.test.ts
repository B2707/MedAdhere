/**
 * leakage.test.ts — the automated exemplar-leakage gate (Plan 04-05).
 *
 * Imports the LIVE few-shot registry from the production prompt module, so a
 * future few-shot change re-triggers this check automatically against the
 * committed gold set — exactly the plan's "re-triggers on few-shot changes".
 */
import { describe, expect, it } from 'vitest';
import { EXEMPLAR_REPLY, FEW_SHOT_EXEMPLARS } from '../../src/classifier/prompt.js';
import { loadGoldSet } from './gold-set.js';
import { assertNoExemplarLeakage, findLeaks } from './leakage.js';

const goldRows = loadGoldSet();
const exemplarTexts = FEW_SHOT_EXEMPLARS.map((e) => e.reply);

describe('exemplar-leakage gate (offline CI floor)', () => {
  it('the committed gold set is disjoint from the LIVE few-shot registry', () => {
    expect(() => assertNoExemplarLeakage(goldRows, exemplarTexts)).not.toThrow();
    expect(EXEMPLAR_REPLY.length).toBeGreaterThan(0); // registry actually loaded
  });

  it('a verbatim exemplar smuggled into the gold set fails the run, naming the row', () => {
    const poisoned = [
      ...goldRows,
      { ...goldRows[0], id: 'g999', text: EXEMPLAR_REPLY },
    ];
    expect(() => assertNoExemplarLeakage(poisoned, exemplarTexts)).toThrow(/g999/);
  });

  it('normalization catches case/punctuation paraphrases ("Oops forgot — taking it NOW!!")', () => {
    const leaks = findLeaks(
      [{ id: 'g998', text: 'Oops forgot — taking it NOW!!' }],
      exemplarTexts,
    );
    expect(leaks.map((l) => l.id)).toContain('g998');
  });

  it('F6: punctuation-as-separator variants are caught ("oops forgot-taking it now")', () => {
    const leaks = findLeaks(
      [{ id: 'g995', text: 'oops forgot-taking it now' }],
      exemplarTexts,
    );
    expect(leaks.map((l) => l.id)).toContain('g995');
  });

  it('containment counts as leakage (exemplar embedded in a longer gold text)', () => {
    const leaks = findLeaks(
      [{ id: 'g997', text: `hey so ${EXEMPLAR_REPLY} and thats all` }],
      exemplarTexts,
    );
    expect(leaks.map((l) => l.id)).toContain('g997');
  });

  it('distinct scenarios sharing vocabulary do NOT false-positive (crisis rows vs crisis exemplar)', () => {
    const leaks = findLeaks(goldRows, exemplarTexts);
    expect(leaks).toEqual([]);
  });
});
