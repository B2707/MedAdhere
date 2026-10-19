/**
 * spend-cap.ts — Deliverable 0 (Plan 04-07): a hard, default-ON spend cap for the live eval.
 *
 * Under D-ANTHROPIC the classifier's LLM call bills the Anthropic account DIRECTLY, and nothing
 * else caps a live run (run-eval.ts only aggregates usage AFTER the run finishes). This governor
 * is the runtime breaker.
 *
 * GUARANTEE — BOUNDED OVERSHOOT, not "never exceeds" (item O): because runLiveEval paces at
 * LIVE_EVAL_CONCURRENCY = 5 (runner.ts:14), the breaching call PLUS up to 5 already-in-flight
 * calls can still finish after the trip. This is a "stop dispatching NEW calls" gate, not a
 * hard mid-request kill.
 *
 * The governor REUSES the exact cost telemetry the onUsage seam emits — `ClassifyUsage`
 * (`classify.ts:110-119`) whose `estimatedCostUsd` is derived from HAIKU_INPUT/OUTPUT list price
 * (`classify.ts:102-103,258-262`). It runs NO parallel cost calc (pinned by spend-cap.test #6
 * against `aggregateUsage`).
 */
import type { ClassifyUsage } from '../../src/classifier/classify.js';

/**
 * Default cap applied to ANY live path with no explicit --max-cost-usd (logged loudly at the
 * call site). There is no uncapped live path. One ~200-row pass ≈ cents (~200 calls ×
 * ~$0.0003/call ≈ $0.06), so $1.50 comfortably covers the ablation's two passes AND pass^k with
 * large headroom while still refusing a runaway loop. (The ~$3–5 in project decision record/04-PLAN is the
 * authorized envelope across ALL 04-07 runs incl. re-runs — a different figure than one run.)
 */
export const DEFAULT_MAX_COST_USD = 1.5;

/**
 * Conservative per-call cost floor for the pre-flight projection. A SMALL floor is deliberate:
 * projectAndGuard must only refuse a run whose MINIMUM plausible spend already busts the cap, and
 * must NOT false-refuse a legitimate ~200-row × 2-arm run (400 × $0.0001 = $0.04 << $1.50).
 */
export const MIN_COST_PER_CALL = 0.0001;

/** Distinct non-zero exit for a spend-cap abort — separate from the gate-FAIL exit of 1. */
export const EXIT_SPEND_CAP = 3;

/** Thrown by assertWithinBudget()/projectAndGuard() once the cap is (or would be) exceeded. */
export class SpendCapExceededError extends Error {
  override readonly name = 'SpendCapExceededError';
}

export interface SpendGovernorLimits {
  /** Absent -> DEFAULT_MAX_COST_USD (Default-ON). An explicit 0 is honored (immediate trip). */
  readonly maxCostUsd?: number;
  /** Optional secondary token ceiling; independent of the cost ceiling. */
  readonly maxTokens?: number;
}

/**
 * A non-negative finite number, or 0. The guard for the non-throwing accumulator: undefined, NaN,
 * ±Infinity — AND any negative finite value — all contribute 0. A token/cost count can never
 * legitimately be negative, and letting one through would DECREMENT the running total and let a
 * later call slip back under the cap. Clamping to 0 keeps the total monotonic and the cap
 * un-bypassable.
 */
function numOrZero(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * ONE instance spans the whole process (item G): the base --live path, all k pass^k iterations,
 * and BOTH ablation arms record into and are gated by the SAME governor. A per-iteration governor
 * would multiply the ceiling by k / by 2 arms — the exact runaway D0 exists to prevent.
 */
export class SpendGovernor {
  private readonly maxCostUsd: number;
  private readonly maxTokens?: number;
  private totalCostUsd = 0;
  private totalTokens = 0;
  private callCount = 0;
  private _tripped = false;

  constructor(limits: SpendGovernorLimits = {}) {
    // Nullish-coalescing (NOT ||): an explicit 0 must survive as a 0 cap, not widen to the default.
    this.maxCostUsd = limits.maxCostUsd ?? DEFAULT_MAX_COST_USD;
    this.maxTokens = limits.maxTokens;
  }

  get tripped(): boolean {
    return this._tripped;
  }
  get spentUsd(): number {
    return this.totalCostUsd;
  }
  get tokensUsed(): number {
    return this.totalTokens;
  }
  get calls(): number {
    return this.callCount;
  }
  get costCeilingUsd(): number {
    return this.maxCostUsd;
  }

  /**
   * TOTAL, NON-THROWING accumulator (item I). It runs INSIDE classify.ts's swallow-all onUsage
   * try/catch (`classify.ts:263-274`), so a throw here would vanish silently and DISABLE the cap.
   * Therefore it guards its own optional/undefined inputs (a missing token count contributes 0,
   * never NaN-poisons the running total), never throws, and ONLY mutates internal state. Sets
   * tripped once a running total reaches OR would exceed a ceiling.
   */
  record(usage: ClassifyUsage): void {
    const inputTokens = numOrZero(usage.inputTokens);
    const outputTokens = numOrZero(usage.outputTokens);
    const cost = numOrZero(usage.estimatedCostUsd);
    this.totalCostUsd += cost;
    this.totalTokens += inputTokens + outputTokens;
    this.callCount += 1;
    if (this.totalCostUsd >= this.maxCostUsd) this._tripped = true;
    if (this.maxTokens !== undefined && this.totalTokens >= this.maxTokens) this._tripped = true;
  }

  /** Throws a distinguished SpendCapExceededError once tripped — call BEFORE each dispatch. */
  assertWithinBudget(): void {
    if (this._tripped) {
      throw new SpendCapExceededError(
        `spend cap reached: $${this.totalCostUsd.toFixed(4)} / $${this.maxCostUsd.toFixed(2)} ` +
          `(${this.totalTokens} tok) after ${this.callCount} calls`,
      );
    }
  }

  /**
   * PRE-FLIGHT refusal: if the MINIMUM projected spend (callCount × minCostPerCall) already
   * exceeds the cost cap, trip and throw BEFORE any call is made. Wired ONCE before the dispatch
   * loop(s) so an obviously-too-large run never bills a single token.
   */
  projectAndGuard(callCount: number, minCostPerCall: number): void {
    const projected = callCount * minCostPerCall;
    if (projected > this.maxCostUsd) {
      this._tripped = true;
      throw new SpendCapExceededError(
        `pre-flight refusal: ${callCount} calls × $${minCostPerCall} = $${projected.toFixed(4)} ` +
          `exceeds cap $${this.maxCostUsd.toFixed(2)}`,
      );
    }
  }
}
