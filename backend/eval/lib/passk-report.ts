/**
 * passk-report.ts — Deliverable 3 (Plan 04-07): fold a live pass^k run into a durable,
 * serializable report artifact WITH a completeness verdict (closes the map-claim ii gap — the
 * `--repeat` branch used to console-log pass^k and return with no `writeFileSync`).
 *
 * Pure and offline-testable (mirrors lib/passk.ts / lib/usage-agg.ts): the live `--repeat` branch
 * collects the per-run life-safety tallies + per-run errored ids + the usage aggregate, and this
 * folds them into the block. The actual JSON write lives in run-eval.ts.
 *
 * COMPLETENESS VERDICT (ULTRA H1, items C + H1). The `--repeat` branch has no `evaluateGates`
 * `erroredCount` belt, so a governor trip or a transient 429 could turn remaining rows into errored
 * → life-safety MISS → passK=false, INDISTINGUISHABLE from a real 988/911 miss. This block closes
 * that hole: if the governor tripped OR any run had errored rows, `status` is 'aborted'/'incomplete'
 * and `passK` is null — the artifact is NEVER a passK pass/fail safety verdict. ONLY a
 * status:'complete', un-tripped run yields a durable `passK` boolean. Precedence (item B): a tripped
 * governor is checked FIRST, so a trip reads as 'aborted' even when rows also errored.
 *
 * DATA-01: every emitted structure is id-keyed (gold ids in missIds / perRunErrored) and carries NO
 * reply text — the builder only ever receives ids + numeric tallies, never GoldRow text.
 */
import { formatMetric } from './metrics.js';
import type { PassKResult } from './passk.js';
import type { UsageAggregate } from './usage-agg.js';

/**
 * The aggregate Clopper-Pearson interval over k×N life-safety trials is DESCRIPTIVE test-retest
 * stability, not an independent-sample population inference (the SAME rows are re-drawn k times).
 * Carried into the artifact verbatim so the thesis figure keeps the caveat (passk.ts:9-10), not
 * just the console. (RED #5.)
 */
export const PASSK_METRIC_SEMANTICS =
  'descriptive test-retest stability, not an independent-sample population inference ' +
  '(the same life-safety rows are re-drawn k times)';

export type PassKStatus = 'complete' | 'incomplete' | 'aborted';

/** Per-run life-safety tally — id-keyed misses only (DATA-01), never reply text. */
export interface PassKRunLifeSafety {
  readonly caught: number;
  readonly denominator: number;
  readonly missIds: readonly string[];
}

export interface PassKReport {
  readonly kind: 'passk';
  /**
   * The completeness verdict. 'complete' = every run ran clean and the governor never tripped;
   * 'incomplete' = at least one run had errored rows; 'aborted' = the spend governor tripped
   * (checked FIRST). Only 'complete' carries a durable passK safety verdict.
   */
  readonly status: PassKStatus;
  readonly promptVersion: string;
  /** The REQUESTED k (from --repeat[=k]); perRunRecall.length shows how many runs actually ran. */
  readonly k: number;
  /**
   * The pass^k boolean safety verdict — present ONLY on a 'complete', un-tripped run; `null`
   * otherwise. An 'incomplete'/'aborted' run is NEVER filed as a passK=false safety verdict.
   */
  readonly passK: boolean | null;
  readonly perRunRecall: readonly number[];
  /** Indices (0-based) of runs that did not catch the full life-safety subset. */
  readonly failingRuns: readonly number[];
  readonly totalCaught: number;
  readonly totalTrials: number;
  /** Descriptive aggregate recall over k×N trials (recorded for every status). */
  readonly aggregateRecall: number;
  /** "point [lo, hi]" via formatMetric — never a bare number. */
  readonly aggregateRecallFormatted: string;
  /** Per-run life-safety caught/denominator + id-keyed misses. */
  readonly perRunLifeSafety: readonly PassKRunLifeSafety[];
  /** Per-run errored gold ids (empty arrays on a clean run) — records WHY status is 'incomplete'. */
  readonly perRunErrored: readonly (readonly string[])[];
  /** True iff the spend governor tripped — records WHY status is 'aborted' (item-B precedence). */
  readonly governorTripped: boolean;
  /** The onUsage cost/token/latency aggregate over the pass^k run (thesis cost line). */
  readonly usage: UsageAggregate;
  /** passk.ts:9-10 wording — the metric is descriptive stability, not population inference. */
  readonly metricSemantics: string;
  readonly generatedAt: string;
}

export interface BuildPassKReportInput {
  readonly pk: PassKResult;
  /** Per-run errored gold ids (index = run). A non-empty entry makes the run 'incomplete'. */
  readonly perRunErrored: readonly (readonly string[])[];
  /** Whether the shared spend governor tripped during the run (item-B precedence: checked FIRST). */
  readonly governorTripped: boolean;
  readonly perRunLifeSafety: readonly PassKRunLifeSafety[];
  readonly usage: UsageAggregate;
  /** The requested k (--repeat[=k]). */
  readonly k: number;
  readonly promptVersion: string;
  readonly now: Date;
}

/**
 * Build the pure, serializable pass^k report block. No IO. The completeness verdict is derived
 * here so the write path cannot accidentally persist a passK=false artifact for an incomplete or
 * aborted run.
 */
export function buildPassKReport(input: BuildPassKReportInput): PassKReport {
  const { pk } = input;

  // Item-B precedence: a tripped governor is checked FIRST → 'aborted' wins over 'incomplete'.
  const anyErrored = input.perRunErrored.some((ids) => ids.length > 0);
  const status: PassKStatus = input.governorTripped
    ? 'aborted'
    : anyErrored
      ? 'incomplete'
      : 'complete';

  // ONLY a complete, un-tripped run yields a durable passK boolean; otherwise the artifact carries
  // no pass/fail safety verdict (null), never passK=false-as-evidence.
  const passK = status === 'complete' ? pk.passK : null;

  return {
    kind: 'passk',
    status,
    promptVersion: input.promptVersion,
    k: input.k,
    passK,
    perRunRecall: [...pk.perRunRecall],
    failingRuns: [...pk.failingRuns],
    totalCaught: pk.totalCaught,
    totalTrials: pk.totalTrials,
    aggregateRecall: pk.aggregateRecall,
    aggregateRecallFormatted: formatMetric(pk.aggregateRecall, pk.aggregateCI),
    perRunLifeSafety: input.perRunLifeSafety.map((r) => ({
      caught: r.caught,
      denominator: r.denominator,
      missIds: [...r.missIds],
    })),
    perRunErrored: input.perRunErrored.map((ids) => [...ids]),
    governorTripped: input.governorTripped,
    usage: input.usage,
    metricSemantics: PASSK_METRIC_SEMANTICS,
    generatedAt: input.now.toISOString(),
  };
}
