/**
 * metrics.test.ts — statistical core of the SC5/SC6 eval harness (Plan 04-05).
 *
 * Clopper-Pearson anchors are closed-form checkable at the boundaries:
 * x=n → lower = (α/2)^(1/n); x=0 → upper = 1−(α/2)^(1/n). The 30/30 anchor
 * (≈0.884) is the plan's own U-21 rationale ("at ~30 the honest claim is only
 * recall ≥ ~0.88"); 45/45 (≈0.921) is the enlarged safety subset's bound.
 */
import { describe, expect, it } from 'vitest';
import {
  accuracy,
  clopperPearsonInterval,
  formatMetric,
  perClassPrecisionRecall,
} from './metrics.js';

describe('clopperPearsonInterval (95%)', () => {
  it('x=n closed form: 30/30 → lower ≈ 0.8843, upper = 1 (the U-21 anchor)', () => {
    const ci = clopperPearsonInterval(30, 30);
    expect(ci.lower).toBeCloseTo(Math.pow(0.025, 1 / 30), 4);
    expect(ci.lower).toBeGreaterThan(0.88);
    expect(ci.lower).toBeLessThan(0.89);
    expect(ci.upper).toBe(1);
  });

  it('x=n closed form: 45/45 → lower ≈ 0.9213 (the enlarged safety subset)', () => {
    const ci = clopperPearsonInterval(45, 45);
    expect(ci.lower).toBeCloseTo(Math.pow(0.025, 1 / 45), 4);
    expect(ci.upper).toBe(1);
  });

  it('x=0 closed form: 0/10 → lower = 0, upper ≈ 0.3085', () => {
    const ci = clopperPearsonInterval(0, 10);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBeCloseTo(1 - Math.pow(0.025, 1 / 10), 4);
  });

  it('interior case: 8/10 → ≈ [0.444, 0.975] (standard published values)', () => {
    const ci = clopperPearsonInterval(8, 10);
    expect(ci.lower).toBeCloseTo(0.4439, 2);
    expect(ci.upper).toBeCloseTo(0.9748, 2);
  });

  it('rejects impossible inputs (x > n, negative, zero trials)', () => {
    expect(() => clopperPearsonInterval(11, 10)).toThrow();
    expect(() => clopperPearsonInterval(-1, 10)).toThrow();
    expect(() => clopperPearsonInterval(0, 0)).toThrow();
  });
});

describe('formatMetric — never a bare 1.0', () => {
  it('renders point estimate with CI to 3 decimals: "1.000 [0.921, 1.000]"', () => {
    const s = formatMetric(1, clopperPearsonInterval(45, 45));
    expect(s).toMatch(/^1\.000 \[0\.9\d\d, 1\.000\]$/);
  });
});

describe('perClassPrecisionRecall + accuracy', () => {
  // 6 rows, 2 classes: gold a,a,a,b,b,b; predicted a,a,b,b,b,a
  const results = [
    { gold: 'a', predicted: 'a' },
    { gold: 'a', predicted: 'a' },
    { gold: 'a', predicted: 'b' },
    { gold: 'b', predicted: 'b' },
    { gold: 'b', predicted: 'b' },
    { gold: 'b', predicted: 'a' },
  ];

  it('computes per-class precision, recall, and support', () => {
    const m = perClassPrecisionRecall(results);
    expect(m.a).toEqual(
      expect.objectContaining({ precision: 2 / 3, recall: 2 / 3, support: 3 }),
    );
    expect(m.b).toEqual(
      expect.objectContaining({ precision: 2 / 3, recall: 2 / 3, support: 3 }),
    );
  });

  it('accuracy over all rows', () => {
    expect(accuracy(results)).toBeCloseTo(4 / 6, 10);
  });
});
