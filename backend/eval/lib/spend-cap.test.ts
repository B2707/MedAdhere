/**
 * spend-cap.test.ts — Deliverable 0 (Plan 04-07): the hard, default-ON spend cap for the live
 * eval. Every test is OFFLINE + $0: no live Anthropic call, only stubbed ClassifyUsage records
 * and the injectable runLiveEval seam. The governor REUSES the same ClassifyUsage cost telemetry
 * the onUsage seam emits (classify.ts:258-262) — it never runs a parallel cost calc, so test #6
 * pins it to aggregateUsage over the identical stream.
 */
import { describe, expect, it } from 'vitest';
import type { ClassifyUsage } from '../../src/classifier/classify.js';
import { aggregateUsage } from './usage-agg.js';
import { LIVE_EVAL_CONCURRENCY, runLiveEval } from './runner.js';
import {
  DEFAULT_MAX_COST_USD,
  MIN_COST_PER_CALL,
  SpendCapExceededError,
  SpendGovernor,
} from './spend-cap.js';

const MODEL = 'claude-haiku-4-5-20251001';
const V = 'v1';

/** A token-bearing usage record whose estimatedCostUsd follows the real Haiku list price. */
function rec(latencyMs: number, tokens: { in: number; out: number }): ClassifyUsage {
  return {
    model: MODEL,
    promptVersion: V,
    latencyMs,
    inputTokens: tokens.in,
    outputTokens: tokens.out,
    estimatedCostUsd: (tokens.in * 1 + tokens.out * 5) / 1_000_000,
  };
}

/** A usage record with an explicit cost (tokens set so input contributes exactly that cost). */
function costRec(costUsd: number): ClassifyUsage {
  return {
    model: MODEL,
    promptVersion: V,
    latencyMs: 1,
    inputTokens: Math.round(costUsd * 1_000_000),
    outputTokens: 0,
    estimatedCostUsd: costUsd,
  };
}

const mkRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `g${String(i + 1).padStart(3, '0')}`,
    text: `sample reply number ${i + 1} zzqx`,
    adherence_state: 'taken',
    reason_code: 'none',
    safety_flag: 'none',
    slice_hint: 'adherence_core',
    lexicon_tags: [] as string[],
  }));

describe('SpendGovernor — cost/token trips (offline, stubbed usage)', () => {
  it('#1 trips when cumulative estimatedCostUsd crosses --max-cost-usd; next assertWithinBudget throws', () => {
    const g = new SpendGovernor({ maxCostUsd: 0.05 });
    g.record(costRec(0.02));
    g.assertWithinBudget(); // 0.02 < 0.05 — no throw
    g.record(costRec(0.02));
    g.assertWithinBudget(); // 0.04 < 0.05 — no throw
    expect(g.tripped).toBe(false);
    g.record(costRec(0.02)); // 0.06 >= 0.05 — trips
    expect(g.tripped).toBe(true);
    expect(() => g.assertWithinBudget()).toThrow(SpendCapExceededError);
  });

  it('#2 trips on cumulative inputTokens+outputTokens crossing --max-tokens', () => {
    // maxCostUsd huge so ONLY the token ceiling can trip it.
    const g = new SpendGovernor({ maxTokens: 1000, maxCostUsd: 999 });
    g.record(rec(1, { in: 400, out: 200 })); // 600 tok
    expect(g.tripped).toBe(false);
    g.record(rec(1, { in: 300, out: 200 })); // +500 = 1100 >= 1000
    expect(g.tripped).toBe(true);
    expect(() => g.assertWithinBudget()).toThrow(SpendCapExceededError);
  });

  it('#4 projectAndGuard refuses (throws) before any call when callCount×minCostPerCall exceeds the cap', () => {
    const g = new SpendGovernor({ maxCostUsd: 0.05 });
    // 1000 * 0.0001 = 0.10 > 0.05 — the MINIMUM projection alone busts the cap.
    expect(() => g.projectAndGuard(1000, MIN_COST_PER_CALL)).toThrow(SpendCapExceededError);
    expect(g.tripped).toBe(true);
    // And it does NOT refuse a projection that fits.
    const g2 = new SpendGovernor({ maxCostUsd: 0.05 });
    expect(() => g2.projectAndGuard(100, MIN_COST_PER_CALL)).not.toThrow(); // 0.01 <= 0.05
    expect(g2.tripped).toBe(false);
  });

  it('#5 Default-ON: no maxCostUsd applies DEFAULT_MAX_COST_USD; an explicit 0 is honored, never unlimited', () => {
    expect(new SpendGovernor({}).costCeilingUsd).toBe(DEFAULT_MAX_COST_USD);
    expect(new SpendGovernor({ maxTokens: 100 }).costCeilingUsd).toBe(DEFAULT_MAX_COST_USD);
    // 0 must NOT be widened to the default (nullish-coalescing, not ||): a 0 cap trips instantly.
    expect(new SpendGovernor({ maxCostUsd: 0 }).costCeilingUsd).toBe(0);
  });

  it('#6 governor totals equal aggregateUsage over the identical record stream (no parallel cost calc)', () => {
    const stream: ClassifyUsage[] = [
      rec(120, { in: 100, out: 20 }),
      rec(80, { in: 50, out: 10 }),
      rec(200, { in: 300, out: 40 }),
    ];
    const g = new SpendGovernor({ maxCostUsd: 999 });
    for (const u of stream) g.record(u);
    const agg = aggregateUsage(stream);
    expect(g.spentUsd).toBeCloseTo(agg.totalCostUsd, 12);
    expect(g.tokensUsed).toBe(agg.totalInputTokens + agg.totalOutputTokens);
  });

  it('#9 record() cannot throw and never NaN-poisons for any well-typed ClassifyUsage (undefined token fields)', () => {
    const g = new SpendGovernor({ maxCostUsd: 999, maxTokens: 999_999 });
    const weird: ClassifyUsage[] = [
      { model: MODEL, promptVersion: V, latencyMs: 10 }, // all token fields undefined
      { model: MODEL, promptVersion: V, latencyMs: 10, inputTokens: 100 }, // only input
      { model: MODEL, promptVersion: V, latencyMs: 10, outputTokens: 50, estimatedCostUsd: 0.0001 },
    ];
    for (const u of weird) expect(() => g.record(u)).not.toThrow();
    expect(Number.isFinite(g.spentUsd)).toBe(true);
    expect(Number.isNaN(g.spentUsd)).toBe(false);
    expect(Number.isFinite(g.tokensUsed)).toBe(true);
    expect(g.spentUsd).toBe(0.0001); // only the one defined cost contributed
    expect(g.tokensUsed).toBe(150); // 0 + 100 + 50 — undefined fields contributed 0, never NaN
  });

  it('#12 record() clamps a NEGATIVE inputTokens/outputTokens/estimatedCostUsd to 0 (monotonic total, never decremented)', () => {
    const g = new SpendGovernor({ maxCostUsd: 999, maxTokens: 999_999 });
    g.record(costRec(0.02)); // seed a positive running total (0.02 USD, 20_000 tok)
    const seededCost = g.spentUsd;
    const seededTokens = g.tokensUsed;
    // A negative (impossible-but-defensive) usage record must contribute exactly 0 to every total —
    // never DECREMENT the running spend, which would let a later call slip back under the cap.
    g.record({
      model: MODEL,
      promptVersion: V,
      latencyMs: 1,
      inputTokens: -100,
      outputTokens: -50,
      estimatedCostUsd: -0.05,
    });
    expect(g.spentUsd).toBe(seededCost); // unchanged — the negative cost contributed 0, not -0.05
    expect(g.tokensUsed).toBe(seededTokens); // unchanged — negative tokens contributed 0, not -150
    expect(Number.isNaN(g.spentUsd)).toBe(false);
    expect(g.spentUsd).toBeGreaterThanOrEqual(0); // the running total can never go negative
    // and record() stayed TOTAL / non-throwing even on the all-negative record.
    expect(() =>
      g.record({ model: MODEL, promptVersion: V, latencyMs: 1, estimatedCostUsd: -1 }),
    ).not.toThrow();
    expect(g.spentUsd).toBe(seededCost); // still unchanged after the second negative record
  });
});

describe('SpendGovernor — bounded-overshoot breaker through runLiveEval (item O)', () => {
  it('#3 once tripped, runLiveEval stops invoking classify within LIVE_EVAL_CONCURRENCY of the breach', async () => {
    const g = new SpendGovernor({ maxCostUsd: 0.05 });
    let calls = 0;
    const COST_PER_CALL = 0.02; // breach at the 3rd record (0.06 >= 0.05)
    const classify = async () => {
      g.assertWithinBudget(); // throws once tripped — the "stop dispatching NEW calls" gate
      calls += 1;
      await new Promise((r) => setTimeout(r, 1));
      g.record(costRec(COST_PER_CALL));
      return { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' } as const;
    };
    await runLiveEval(mkRows(50) as never, classify);
    const breachIndex = 3;
    expect(calls).toBeGreaterThanOrEqual(breachIndex);
    // BOUNDED OVERSHOOT, not "never exceeds": the breaching call + up to concurrency in-flight.
    expect(calls).toBeLessThanOrEqual(breachIndex + LIVE_EVAL_CONCURRENCY);
    expect(g.tripped).toBe(true);
  });

  it('#10 ONE governor across two sequential runLiveEval calls accumulates and persists tripped', async () => {
    const g = new SpendGovernor({ maxCostUsd: 0.05 });
    const classify = async () => {
      g.assertWithinBudget();
      g.record(costRec(0.02));
      return { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' } as const;
    };
    await runLiveEval(mkRows(2) as never, classify); // 2 calls -> 0.04, not tripped
    expect(g.tripped).toBe(false);
    expect(g.spentUsd).toBeCloseTo(0.04, 12);
    await runLiveEval(mkRows(2) as never, classify); // accumulates on the SAME instance -> trips
    expect(g.tripped).toBe(true);
    expect(g.spentUsd).toBeGreaterThanOrEqual(0.05);
    // 2 (run 1) + 1 (run 2's first call trips at 0.06) — run 2's SECOND call is gated by the
    // persisted trip, so 3 records total: the shared governor carried run 1's spend into run 2.
    expect(g.calls).toBe(3);
  });
});
