/**
 * ablation.ts — Deliverable 1 (Plan 04-07): the DRUG-03 A/B prompt-enrichment ablation (SC12).
 *
 * Arm A = the production base prompt. Arm B = base + a compact, comma-separated MedDRA term block
 * built OFFLINE from the vendored OnSIDES index intersected with the cohort's ingredient RxCUIs
 * that carry label data. The two arms run through the SAME production `classifyReplyText` core
 * (arm B via the `systemAppendix` seam — AUGMENT, never fork, the U-23 core) and the SAME p-limit
 * runner + single SpendGovernor.
 *
 * HONEST SC12 SCOPE (ULTRA M2, item E): the gold rows are text-only, so arm B appends ONE static
 * UNION block identically to every row (a reply about drug X also sees drugs Y/Z's PTs). This is a
 * fixed-vocabulary LOWER-BOUND proxy for SC12 — "does a generic ADE vocabulary help reason-code
 * capture," NOT per-drug medication-aware conditioning. The 04-SUMMARY must carry that caveat.
 *
 * DESCRIPTIVE, not inferential (N3): temperature=0 is NOT seed-deterministic, there is no seed and
 * no significance test on a ~200-row gold set. Any |delta| below the expected run-to-run variance
 * is "no effect," never a ship trigger — which is why the no-regression guard carries a small
 * NO_REGRESSION_EPSILON on the NON-safety terms rather than literal zero tolerance. The life-safety
 * floor is EXEMPT: it carries NO tolerance and arm B must also pass all four `evaluateGates` floors.
 *
 * DATA-01: every emitted structure is id-keyed and carries NO reply text.
 */
import { createHash } from 'node:crypto';
import type { OnsidesEffect } from '../../src/classifier/onsides.js';
import { ONSIDES_SOURCE_VERSION } from '../../src/classifier/onsides.js';
import type { GoldRow } from './gold-set.js';
import type { EvalRowResult } from './runner.js';
import type { LiveMetrics } from './assemble.js';
import type { CoverageHandoffProvenance } from './coverage-artifact.js';

/** ~150-token budget proxy for the arm-B term block (SC12). The whole appendix stays ≤ this. */
export const TERM_BLOCK_MAX_CHARS = 600;

/**
 * One-to-two rows' worth of stochastic wobble on the ~200-row gold set (≈ 2/200 = 0.01). Applied
 * ONLY to the non-safety no-regression terms (accuracy, taken precision, side_effect precision) so
 * a single-row temperature=0 wobble cannot spuriously block ship-B. The life-safety floor is exempt.
 */
export const NO_REGRESSION_EPSILON = 0.01;

/** The reason_code axis (matches the shared AdherenceClassification enum). */
export const REASON_CODES = ['none', 'side_effect', 'ran_out', 'forgot', 'other'] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** Lead-in for the term block; counted against TERM_BLOCK_MAX_CHARS with the PT list. */
const TERM_BLOCK_HEADER =
  'Reference adverse-effect terms (MedDRA preferred terms) documented for this cohort, ' +
  'for use when assigning reason_code=side_effect: ';

// ── term-block builder ──────────────────────────────────────────────────────────────────────────

export interface RxcuiCoverage {
  readonly rxcui: string;
  /** OnSIDES coverage status — a `false` here means the drug is EXCLUDED, never silently dropped. */
  readonly hasLabelData: boolean;
  readonly effectCount: number;
}

export interface TermBlockProvenance {
  readonly onsidesSourceVersion: string;
  /** The input ingredient RxCUIs, deduped + sorted (input order does not affect the block). */
  readonly sourceRxcuis: readonly string[];
  readonly coverage: readonly RxcuiCoverage[];
  /** Number of unique PTs actually included after dedup + budget truncation. */
  readonly ptCount: number;
  readonly truncated: boolean;
  readonly charLength: number;
  /** sha256 of the appendix string — the reproducibility key the ablation report tags results with. */
  readonly blockHash: string;
}

export interface AdeTermBlock {
  /** The comma-separated MedDRA PT block appended to the SYSTEM prompt for arm B ('' if no data). */
  readonly appendix: string;
  readonly provenance: TermBlockProvenance;
}

/**
 * Build the arm-B term block OFFLINE from a set of ingredient RxCUIs and the injected OnSIDES
 * accessors (same injection shape as ade-eval). PTs are deduped (case-insensitive; the highest
 * hint level wins), ranked boxed-warning/elevated first then alphabetical (deterministic), and the
 * comma list is truncated at PT boundaries so the WHOLE appendix stays ≤ TERM_BLOCK_MAX_CHARS. An
 * RxCUI with no OnSIDES label data is EXCLUDED from the block but recorded in the provenance
 * coverage table with `hasLabelData:false`.
 */
export function buildAdeTermBlock(
  rxcuis: readonly string[],
  effectsFor: (rxcui: string) => readonly OnsidesEffect[],
  hasLabelData: (rxcui: string) => boolean,
): AdeTermBlock {
  const uniqueRxcuis = [...new Set(rxcuis)].sort();
  const coverage: RxcuiCoverage[] = [];
  // Best hint level per normalized PT (elevated beats info); keeps the first-seen display casing.
  const ptBest = new Map<string, { pt: string; elevated: boolean }>();

  for (const rxcui of uniqueRxcuis) {
    const has = hasLabelData(rxcui);
    const effects = has ? effectsFor(rxcui) : [];
    coverage.push({ rxcui, hasLabelData: has, effectCount: effects.length });
    for (const e of effects) {
      const display = e.pt.trim();
      const key = display.toLowerCase();
      if (key === '') continue;
      const elevated = e.hint_level === 'elevated';
      const prev = ptBest.get(key);
      if (!prev) ptBest.set(key, { pt: display, elevated });
      else if (elevated && !prev.elevated) ptBest.set(key, { pt: prev.pt, elevated: true });
    }
  }

  const ranked = [...ptBest.values()].sort((a, b) => {
    if (a.elevated !== b.elevated) return a.elevated ? -1 : 1; // elevated tier first
    return a.pt.localeCompare(b.pt); // deterministic within a tier
  });

  const included: string[] = [];
  let currentLen = TERM_BLOCK_HEADER.length;
  let truncated = false;
  for (const item of ranked) {
    const addLen = (included.length === 0 ? 0 : 2) + item.pt.length; // ", " separator
    if (currentLen + addLen > TERM_BLOCK_MAX_CHARS) {
      truncated = true;
      break;
    }
    included.push(item.pt);
    currentLen += addLen;
  }

  const appendix = included.length === 0 ? '' : `${TERM_BLOCK_HEADER}${included.join(', ')}`;
  const blockHash = createHash('sha256').update(appendix).digest('hex');

  return {
    appendix,
    provenance: {
      onsidesSourceVersion: ONSIDES_SOURCE_VERSION,
      sourceRxcuis: uniqueRxcuis,
      coverage,
      ptCount: included.length,
      truncated,
      charLength: appendix.length,
      blockHash,
    },
  };
}

// ── per-row ablation delta ──────────────────────────────────────────────────────────────────────

export interface ReasonCodeCell {
  readonly goldSupport: number;
  readonly matched: number;
  /** matched / goldSupport (0 when the reason has no gold support). */
  readonly completeness: number;
}

export interface SideEffectStats {
  /** TP / predictedCount; null when the arm never predicted side_effect. */
  readonly precisionA: number | null;
  readonly precisionB: number | null;
  readonly truePositivesA: number;
  readonly truePositivesB: number;
  readonly predictedCountA: number;
  readonly predictedCountB: number;
  readonly falsePositivesA: number;
  readonly falsePositivesB: number;
  readonly falsePositiveIdsA: readonly string[];
  readonly falsePositiveIdsB: readonly string[];
}

export interface AblationDelta {
  readonly reasonCodes: readonly string[];
  readonly perReasonA: Record<string, ReasonCodeCell>;
  readonly perReasonB: Record<string, ReasonCodeCell>;
  /** Overall reason-code completeness (STUDY-08): matched / gold rows with reason != 'none'. */
  readonly reasonCompletenessA: number;
  readonly reasonCompletenessB: number;
  /** B − A (the PRIMARY metric). */
  readonly reasonCompletenessDelta: number;
  readonly sideEffect: SideEffectStats;
}

function perReasonTable(
  gold: readonly GoldRow[],
  arm: readonly EvalRowResult[],
): Record<string, ReasonCodeCell> {
  const predById = new Map(arm.map((r) => [r.id, r.predicted]));
  const out: Record<string, ReasonCodeCell> = {};
  for (const code of REASON_CODES) {
    const goldRows = gold.filter((g) => g.reason_code === code);
    const matched = goldRows.filter((g) => predById.get(g.id)?.reason_code === code).length;
    out[code] = {
      goldSupport: goldRows.length,
      matched,
      completeness: goldRows.length === 0 ? 0 : matched / goldRows.length,
    };
  }
  return out;
}

/** matched / support over every reason code EXCEPT 'none' — mirrors assemble.ts reasonCompleteness. */
function overallCompleteness(table: Record<string, ReasonCodeCell>): number {
  let matched = 0;
  let support = 0;
  for (const code of REASON_CODES) {
    if (code === 'none') continue;
    matched += table[code]!.matched;
    support += table[code]!.goldSupport;
  }
  return support === 0 ? 0 : matched / support;
}

function armSideEffect(
  gold: readonly GoldRow[],
  arm: readonly EvalRowResult[],
): { tp: number; predicted: number; fpIds: string[] } {
  const predById = new Map(arm.map((r) => [r.id, r.predicted]));
  let tp = 0;
  let predicted = 0;
  const fpIds: string[] = [];
  for (const g of gold) {
    if (predById.get(g.id)?.reason_code === 'side_effect') {
      predicted += 1;
      if (g.reason_code === 'side_effect') tp += 1;
      else fpIds.push(g.id);
    }
  }
  return { tp, predicted, fpIds };
}

/**
 * Per-row ablation delta (review HIGH, item A). Takes PER-ROW data — gold + each arm's
 * `EvalRowResult[]` — NOT `(LiveMetrics, LiveMetrics)`: `LiveMetrics` carries only an aggregate
 * `reasonCompleteness`, so it structurally cannot produce a per-reason-code table. Derives the
 * per-reason confusion/completeness table (incl. side_effect) + the side_effect precision/FP count
 * + the overall reason-code completeness delta from `r.gold.reason_code` / `r.predicted?.reason_code`.
 * This is the SINGLE source of truth for side_effect precision that `compareNoRegression` consumes.
 */
export function computeAblationDelta(
  gold: readonly GoldRow[],
  armA: readonly EvalRowResult[],
  armB: readonly EvalRowResult[],
): AblationDelta {
  const perReasonA = perReasonTable(gold, armA);
  const perReasonB = perReasonTable(gold, armB);
  const reasonCompletenessA = overallCompleteness(perReasonA);
  const reasonCompletenessB = overallCompleteness(perReasonB);

  const seA = armSideEffect(gold, armA);
  const seB = armSideEffect(gold, armB);

  return {
    reasonCodes: REASON_CODES,
    perReasonA,
    perReasonB,
    reasonCompletenessA,
    reasonCompletenessB,
    reasonCompletenessDelta: reasonCompletenessB - reasonCompletenessA,
    sideEffect: {
      precisionA: seA.predicted === 0 ? null : seA.tp / seA.predicted,
      precisionB: seB.predicted === 0 ? null : seB.tp / seB.predicted,
      truePositivesA: seA.tp,
      truePositivesB: seB.tp,
      predictedCountA: seA.predicted,
      predictedCountB: seB.predicted,
      falsePositivesA: seA.fpIds.length,
      falsePositivesB: seB.fpIds.length,
      falsePositiveIdsA: seA.fpIds,
      falsePositiveIdsB: seB.fpIds,
    },
  };
}

// ── numeric no-regression guard ───────────────────────────────────────────────────────────────

export interface NoRegressionCheck<T = number> {
  readonly a: T;
  readonly b: T;
  readonly ok: boolean;
}

export interface NoRegressionResult {
  readonly pass: boolean;
  readonly failures: string[];
  readonly checks: {
    readonly accuracy: NoRegressionCheck;
    readonly lifeSafetyRecall: NoRegressionCheck;
    readonly takenPrecision: NoRegressionCheck;
    readonly sideEffectPrecision: NoRegressionCheck<number | null>;
  };
}

/**
 * NUMERIC no-regression guard (item D; re-typed Round 3 for N1/N2). Reads the REAL LiveMetrics
 * accessors — `accuracy.point`, `lifeSafety.recall`, `perClass['taken'].precision` (a missing
 * `taken` key is guarded to 0) — for accuracy / life-safety / taken. The side_effect precision term
 * is CONSUMED from the per-row `delta` (LiveMetrics has NO sideEffectPrecision field), so
 * `computeAblationDelta` and this guard can never diverge on side_effect precision.
 *
 * Tolerance (N3): accuracy, taken precision, and side_effect precision use NO_REGRESSION_EPSILON;
 * life-safety recall is ABSOLUTE (no tolerance — the safety floor). A null side_effect precision on
 * either arm (the arm never predicted side_effect) is NOT a precision regression (precision only
 * measures the false-positive rate among predictions; a completeness loss is caught by the delta).
 */
export function compareNoRegression(
  armA: LiveMetrics,
  armB: LiveMetrics,
  delta: AblationDelta,
): NoRegressionResult {
  const accA = armA.accuracy.point;
  const accB = armB.accuracy.point;
  const lifeA = armA.lifeSafety.recall;
  const lifeB = armB.lifeSafety.recall;
  const takenA = armA.perClass['taken']?.precision ?? 0;
  const takenB = armB.perClass['taken']?.precision ?? 0;
  const seA = delta.sideEffect.precisionA;
  const seB = delta.sideEffect.precisionB;

  const accuracyOk = accB >= accA - NO_REGRESSION_EPSILON;
  const lifeSafetyOk = lifeB >= lifeA; // ABSOLUTE — no tolerance on the safety floor
  const takenOk = takenB >= takenA - NO_REGRESSION_EPSILON;
  const sideEffectOk = seA === null || seB === null ? true : seB >= seA - NO_REGRESSION_EPSILON;

  const failures: string[] = [];
  if (!accuracyOk) failures.push(`accuracy ${accB.toFixed(3)} < ${accA.toFixed(3)} − ε`);
  if (!lifeSafetyOk) {
    failures.push(`life-safety recall ${lifeB.toFixed(3)} < ${lifeA.toFixed(3)} (no tolerance)`);
  }
  if (!takenOk) failures.push(`taken precision ${takenB.toFixed(3)} < ${takenA.toFixed(3)} − ε`);
  if (!sideEffectOk) {
    failures.push(`side_effect precision ${(seB as number).toFixed(3)} < ${(seA as number).toFixed(3)} − ε`);
  }

  return {
    pass: failures.length === 0,
    failures,
    checks: {
      accuracy: { a: accA, b: accB, ok: accuracyOk },
      lifeSafetyRecall: { a: lifeA, b: lifeB, ok: lifeSafetyOk },
      takenPrecision: { a: takenA, b: takenB, ok: takenOk },
      sideEffectPrecision: { a: seA, b: seB, ok: sideEffectOk },
    },
  };
}

// ── ship decision ─────────────────────────────────────────────────────────────────────────────

export interface ShipDecision {
  readonly ship: boolean;
  readonly primaryImproves: boolean;
  readonly reasons: string[];
}

/**
 * Ship arm B ONLY if the PRIMARY metric (reason-code completeness) improves BEYOND
 * NO_REGRESSION_EPSILON AND `compareNoRegression` holds (no non-safety metric drops past tolerance,
 * no side_effect precision drop, life-safety absolute) AND arm B passes all four `evaluateGates`
 * floors. A within-noise completeness gain is "no effect," never a ship trigger.
 */
export function decideShipArmB(input: {
  readonly delta: AblationDelta;
  readonly noRegression: NoRegressionResult;
  readonly armBGatesPass: boolean;
}): ShipDecision {
  const primaryImproves = input.delta.reasonCompletenessDelta > NO_REGRESSION_EPSILON;
  const ship = primaryImproves && input.noRegression.pass && input.armBGatesPass;
  const reasons: string[] = [];
  if (!primaryImproves) {
    reasons.push(
      'reason-code completeness did not improve beyond NO_REGRESSION_EPSILON (descriptive: no effect)',
    );
  }
  if (!input.noRegression.pass) {
    reasons.push(`no-regression guard failed: ${input.noRegression.failures.join('; ')}`);
  }
  if (!input.armBGatesPass) reasons.push('arm B does not pass all four evaluateGates floors');
  return { ship, primaryImproves, reasons };
}

// ── persisted ablation report (DATA-01 clean) ────────────────────────────────────────────────────

export type AblationStatus = 'complete' | 'incomplete' | 'spendCap';

export interface ArmErroredRow {
  readonly id: string;
  /** The runner-sanitized error name — cap errors ('SpendCapExceededError') read distinctly here. */
  readonly error: string;
}

export interface ArmSummary {
  readonly coverage: { total: number; classified: number };
  readonly errored: ArmErroredRow[];
  readonly accuracy: number | null;
  readonly reasonCompleteness: number | null;
}

export interface AblationReport {
  readonly kind: 'ablation';
  readonly status: AblationStatus;
  readonly promptVersion: string;
  readonly block: TermBlockProvenance;
  /** The D2→D1 OnSIDES coverage handoff this block was built from (review HIGH, 04-07). */
  readonly coverageHandoff?: CoverageHandoffProvenance;
  readonly arms: { readonly A: ArmSummary; readonly B: ArmSummary };
  readonly delta?: AblationDelta;
  readonly noRegression?: NoRegressionResult;
  readonly ship?: ShipDecision;
  readonly generatedAt: string;
}

export interface AblationReportInput {
  readonly status: AblationStatus;
  readonly promptVersion: string;
  readonly blockProvenance: TermBlockProvenance;
  /** The D2 coverage handoff (covered cohort ingredients + explicit exclusions) — review HIGH. */
  readonly coverageHandoff?: CoverageHandoffProvenance;
  readonly gold: readonly GoldRow[];
  readonly armA: readonly EvalRowResult[];
  readonly armB: readonly EvalRowResult[];
  /** Present (with armBMetrics + armBGatesPass) only for a 'complete' run. */
  readonly armAMetrics?: LiveMetrics;
  readonly armBMetrics?: LiveMetrics;
  readonly armBGatesPass?: boolean;
  readonly generatedAt: string;
}

function armSummary(
  gold: readonly GoldRow[],
  arm: readonly EvalRowResult[],
  metrics?: LiveMetrics,
): ArmSummary {
  const errored = arm
    .filter((r): r is EvalRowResult & { error: string } => r.error !== undefined)
    .map((r) => ({ id: r.id, error: r.error }));
  const reasonCompleteness =
    metrics === undefined
      ? null
      : metrics.reasonCompleteness.denominator === 0
        ? 0
        : metrics.reasonCompleteness.matched / metrics.reasonCompleteness.denominator;
  return {
    coverage: { total: gold.length, classified: arm.filter((r) => r.predicted).length },
    errored,
    accuracy: metrics?.accuracy.point ?? null,
    reasonCompleteness,
  };
}

/**
 * Assemble the persisted ablation artifact (DATA-01 clean: id-keyed, NO reply text). A partial run
 * ('spendCap' / 'incomplete') omits the delta / no-regression / ship fields entirely — a tripped or
 * errored arm is NEVER run through computeAblationDelta / compareNoRegression (item B). A 'complete'
 * run requires armA/armB metrics + arm-B gate pass and carries the full delta + guard + ship verdict.
 */
export function buildAblationReport(input: AblationReportInput): AblationReport {
  const base: AblationReport = {
    kind: 'ablation',
    status: input.status,
    promptVersion: input.promptVersion,
    block: input.blockProvenance,
    ...(input.coverageHandoff !== undefined ? { coverageHandoff: input.coverageHandoff } : {}),
    arms: {
      A: armSummary(input.gold, input.armA, input.armAMetrics),
      B: armSummary(input.gold, input.armB, input.armBMetrics),
    },
    generatedAt: input.generatedAt,
  };

  if (input.status !== 'complete') return base;

  if (input.armAMetrics === undefined || input.armBMetrics === undefined || input.armBGatesPass === undefined) {
    throw new Error('buildAblationReport: a complete run requires armAMetrics + armBMetrics + armBGatesPass');
  }

  const delta = computeAblationDelta(input.gold, input.armA, input.armB);
  const noRegression = compareNoRegression(input.armAMetrics, input.armBMetrics, delta);
  const ship = decideShipArmB({ delta, noRegression, armBGatesPass: input.armBGatesPass });
  return { ...base, delta, noRegression, ship };
}
