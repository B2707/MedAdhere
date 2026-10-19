/**
 * offline-eval.test.ts — SC6's offline half: prefilter-only recall = 1.0 on
 * the tagged lexicon slice, computed with ZERO API calls by running the real
 * shared runSafetyPrefilter over the committed gold set. This test IS the
 * CI floor (ai-regression-testing): a lexicon regression that loses a
 * tagged gold row blocks every push.
 */
import { describe, expect, it } from 'vitest';
import { loadGoldSet } from './gold-set.js';
import { runPrefilterEval } from './offline-eval.js';

describe('prefilter offline eval (the SC6 lexicon-slice gate)', () => {
  const rows = loadGoldSet();
  const result = runPrefilterEval(rows);

  it('prefilter-only recall over safety-positive lexicon-slice rows is EXACTLY 1.0', () => {
    expect(result.lexiconSlice.recall).toBe(1);
    expect(result.lexiconSlice.misses).toEqual([]);
    expect(result.lexiconSlice.denominator).toBeGreaterThan(0);
  });

  it('reports the Clopper-Pearson lower bound alongside the 1.0 (never a bare 1.0)', () => {
    expect(result.lexiconSlice.formatted).toMatch(/^1\.000 \[0\.\d{3}, 1\.000\]$/);
  });

  it('deliberate false-positive controls (gold-none rows the lexicon hits, e.g. figurative want-to-die) are counted as FPs, never recall misses', () => {
    const fpIds = result.falsePositives.map((f) => f.id);
    expect(fpIds.length).toBeGreaterThanOrEqual(1); // g202-class control exists by design
    for (const fp of result.falsePositives) {
      expect(fp.goldSafety).toBe('none');
    }
    expect(result.lexiconSlice.misses).toEqual([]);
  });

  it('a fabricated tagged row the prefilter misses drops recall below 1.0 and is named', () => {
    const fabricated = [
      ...rows,
      {
        ...rows[0],
        id: 'g996',
        slice_hint: 'safety_lexicon' as const,
        text: 'completely benign words the lexicon cannot match',
        lexicon_tags: ['chest_pain'],
        safety_flag: 'acute_physical' as const,
      },
    ];
    const broken = runPrefilterEval(fabricated);
    expect(broken.lexiconSlice.recall).toBeLessThan(1);
    expect(broken.lexiconSlice.misses.map((m) => m.id)).toContain('g996');
  });
});
