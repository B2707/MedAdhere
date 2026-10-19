/**
 * usage-agg.test.ts — aggregates the per-call ClassifyUsage records (onUsage seam, U-23) that
 * the live eval collects into the thesis latency/cost line: count, mean/p95 latency, total
 * tokens, and total/mean list-price cost. Pure + offline-testable (no live calls); mirrors the
 * lib/passk.ts posture. Records without a usage block (latency-only) still count toward latency
 * but are excluded from token/cost sums (withTokens).
 */
import { describe, expect, it } from 'vitest';
import type { ClassifyUsage } from '../../src/classifier/classify.js';
import { aggregateUsage } from './usage-agg.js';

const MODEL = 'claude-haiku-4-5-20251001';
const V = 'v1';

function rec(latencyMs: number, tokens?: { in: number; out: number }): ClassifyUsage {
  if (!tokens) {
    return { model: MODEL, promptVersion: V, latencyMs };
  }
  return {
    model: MODEL,
    promptVersion: V,
    latencyMs,
    inputTokens: tokens.in,
    outputTokens: tokens.out,
    // list price: ($1/Mtok in + $5/Mtok out)
    estimatedCostUsd: (tokens.in * 1 + tokens.out * 5) / 1_000_000,
  };
}

describe('aggregateUsage — thesis latency/cost aggregation', () => {
  it('returns an empty aggregate (nulls, zero totals) for no records', () => {
    const a = aggregateUsage([]);
    expect(a.count).toBe(0);
    expect(a.withTokens).toBe(0);
    expect(a.meanLatencyMs).toBeNull();
    expect(a.p95LatencyMs).toBeNull();
    expect(a.totalInputTokens).toBe(0);
    expect(a.totalOutputTokens).toBe(0);
    expect(a.totalCostUsd).toBe(0);
    expect(a.meanCostUsd).toBeNull();
  });

  it('sums tokens/cost and computes mean + nearest-rank p95 latency over full records', () => {
    const a = aggregateUsage([
      rec(100, { in: 100, out: 30 }),
      rec(200, { in: 200, out: 60 }),
      rec(300, { in: 300, out: 90 }),
    ]);
    expect(a.count).toBe(3);
    expect(a.withTokens).toBe(3);
    expect(a.meanLatencyMs).toBe(200); // (100+200+300)/3
    // nearest-rank p95: ceil(0.95*3)=3 -> 3rd value = 300
    expect(a.p95LatencyMs).toBe(300);
    expect(a.totalInputTokens).toBe(600);
    expect(a.totalOutputTokens).toBe(180);
    expect(a.totalCostUsd).toBeCloseTo(0.0015, 10); // 0.00025 + 0.0005 + 0.00075
    expect(a.meanCostUsd).toBeCloseTo(0.0005, 10);
  });

  it('counts latency-only records for latency but excludes them from token/cost sums', () => {
    const a = aggregateUsage([
      rec(50), // usage block absent (missing token counts)
      rec(150, { in: 100, out: 30 }),
    ]);
    expect(a.count).toBe(2);
    expect(a.withTokens).toBe(1);
    expect(a.meanLatencyMs).toBe(100); // (50+150)/2
    expect(a.totalInputTokens).toBe(100);
    expect(a.totalOutputTokens).toBe(30);
    expect(a.totalCostUsd).toBeCloseTo(0.00025, 10);
    expect(a.meanCostUsd).toBeCloseTo(0.00025, 10); // total / withTokens, not / count
  });

  it('uses nearest-rank (not interpolation) for p95 on a 1..20 distribution', () => {
    const records = Array.from({ length: 20 }, (_, i) => rec(i + 1, { in: 1, out: 1 }));
    const a = aggregateUsage(records);
    // ceil(0.95*20)=19 -> 19th smallest = 19
    expect(a.p95LatencyMs).toBe(19);
    expect(a.meanLatencyMs).toBe(11); // mean(1..20)=10.5 -> round -> 11
  });
});
