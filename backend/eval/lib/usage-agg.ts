/**
 * usage-agg.ts — aggregate per-call ClassifyUsage records (the onUsage seam, U-23) into the
 * thesis latency/cost line + runtime budget figure. Pure and offline-testable (mirrors
 * lib/passk.ts): the live eval collects the records, this folds them.
 *
 * Latency is always present, so mean/p95 span every arrived response. Token/cost fields are
 * present iff the response carried a usage block; latency-only records still count toward
 * latency but are excluded from the token/cost sums (`withTokens`), so a partial response
 * never silently deflates the per-call cost figure.
 */
import type { ClassifyUsage } from '../../src/classifier/classify.js';

export interface UsageAggregate {
  /**
   * All ARRIVED Messages responses (every record onUsage fired). NOT the same population as
   * eval `coverage.classified`: it includes contract-failure responses (they consumed tokens)
   * and EXCLUDES transport/auth failures (429/5xx/timeout/401 — no response arrived, no record).
   * So `$/call` derived from this is cost-per-arrived-response, not cost-per-accepted-label.
   */
  readonly count: number;
  /** Records that carried both token counts (the token/cost denominator). */
  readonly withTokens: number;
  /**
   * Mean call latency (ms), rounded; null when there are no records. Each latency is the
   * wall-clock of `messages.create` INCLUDING any SDK retry+backoff attempts (retry occurrence
   * is nondeterministic and not separately tracked), so the tail reflects the retry policy too.
   */
  readonly meanLatencyMs: number | null;
  /** Nearest-rank p95 latency (ms) — an actual sample, not interpolated; null when empty. */
  readonly p95LatencyMs: number | null;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  /** Total list-price estimate (USD) over token-bearing records. */
  readonly totalCostUsd: number;
  /** totalCostUsd / withTokens (arrived responses with tokens); null when none carried tokens. */
  readonly meanCostUsd: number | null;
}

const P95 = 0.95;

/** Nearest-rank percentile over a NON-EMPTY numeric sample (caller guards emptiness). */
function nearestRank(sortedAsc: readonly number[], p: number): number {
  const rank = Math.ceil(p * sortedAsc.length); // 1-based rank, always >= 1 for p in (0,1]
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx]!;
}

export function aggregateUsage(records: readonly ClassifyUsage[]): UsageAggregate {
  const count = records.length;
  if (count === 0) {
    return {
      count: 0,
      withTokens: 0,
      meanLatencyMs: null,
      p95LatencyMs: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      meanCostUsd: null,
    };
  }

  const latenciesAsc = records.map((r) => r.latencyMs).sort((a, b) => a - b);
  const totalLatency = latenciesAsc.reduce((sum, ms) => sum + ms, 0);

  let withTokens = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  for (const r of records) {
    if (r.inputTokens === undefined || r.outputTokens === undefined) continue;
    withTokens += 1;
    totalInputTokens += r.inputTokens;
    totalOutputTokens += r.outputTokens;
    totalCostUsd += r.estimatedCostUsd ?? 0;
  }

  return {
    count,
    withTokens,
    meanLatencyMs: Math.round(totalLatency / count),
    p95LatencyMs: nearestRank(latenciesAsc, P95),
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    meanCostUsd: withTokens > 0 ? totalCostUsd / withTokens : null,
  };
}
