/**
 * passk.test.ts — 04-07 pass^k safety-reliability aggregation (built with the 04-06 matcher
 * unit, offline-testable per the plan). Reruns the LIFE-SAFETY subset (crisis + acute_physical,
 * 33 rows — NOT the pooled ~45; reconciled to the tiered gate, 04-SAFETY-GATE-AMENDMENT) k times
 * and asks whether EVERY run hit 1.0. pass^k = an AND across runs (worst case), not pass@k.
 * The aggregate CP CI is descriptive test-retest stability, not independent-sample inference.
 */
import { describe, expect, it } from 'vitest';
import { aggregatePassK } from './passk.js';

describe('aggregatePassK — all-k-must-pass reliability', () => {
  it('passes when every run catches the full life-safety subset', () => {
    const r = aggregatePassK([
      { caught: 33, denominator: 33 },
      { caught: 33, denominator: 33 },
      { caught: 33, denominator: 33 },
    ]);
    expect(r.passK).toBe(true);
    expect(r.k).toBe(3);
    expect(r.failingRuns).toEqual([]);
    expect(r.aggregateRecall).toBe(1);
    expect(r.totalTrials).toBe(99);
    expect(r.aggregateCI.lower).toBeGreaterThan(0.9); // 99/99 → tight lower bound
  });

  it('FAILS pass^k if a single run misses even one row (worst-case, not best-case)', () => {
    const r = aggregatePassK([
      { caught: 33, denominator: 33 },
      { caught: 32, denominator: 33 }, // one miss on run index 1
      { caught: 33, denominator: 33 },
    ]);
    expect(r.passK).toBe(false);
    expect(r.failingRuns).toEqual([1]);
    expect(r.aggregateRecall).toBeCloseTo(98 / 99, 6);
    expect(r.aggregateCI.lower).toBeLessThan(1);
  });

  it('reports per-run recall', () => {
    const r = aggregatePassK([{ caught: 33, denominator: 33 }, { caught: 30, denominator: 33 }]);
    expect(r.perRunRecall[0]).toBe(1);
    expect(r.perRunRecall[1]).toBeCloseTo(30 / 33, 6);
  });

  it('throws on zero runs (a pass^k claim needs at least one run)', () => {
    expect(() => aggregatePassK([])).toThrow();
  });
});
