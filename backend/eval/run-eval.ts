/**
 * run-eval.ts — SC5/SC6 eval harness CLI (Plan 04-05; spend cap + import-testable seam 04-07 D0).
 * In-repo TypeScript only: reply text NEVER goes to a hosted eval platform (DATA-01).
 *
 * Modes:
 *   offline (default without ANTHROPIC_API_KEY, or --offline):
 *     gold-set integrity + exemplar leakage + prefilter lexicon floor. $0.
 *   live (--live, or ANTHROPIC_API_KEY set):
 *     additionally classifies every row through the PRODUCTION `classifyReplyText` core (U-23),
 *     paced by the p-limit runner (U-24), then assembles metrics fail-safe and writes an id-keyed
 *     results JSON (no reply text; errors sanitized to name+status — F5).
 *   pass^k (--repeat[=k]): reruns the life-safety subset k times (aggregation in lib/passk.ts).
 *   ablation (--ablation): a two-arm A/B dispatch skeleton (D0) — arm A = base prompt, arm B =
 *     base + a term-block appendix. The delta + no-regression analysis is Deliverable 1 (SEAM
 *     below); D0 ships only the shared-governor two-arm dispatch with a tripped-FIRST abort.
 *
 * SPEND CAP (04-07 D0): every live path is governed by ONE SpendGovernor (default-ON $1.50). See
 * lib/spend-cap.ts. The guarantee is BOUNDED OVERSHOOT (≤ LIVE_EVAL_CONCURRENCY in-flight), and a
 * cap abort returns the distinct EXIT_SPEND_CAP, never a gate-FAIL 1.
 *
 * Run: npx tsx backend/eval/run-eval.ts [--offline | --live | --repeat[=k] | --ablation]
 *          [--max-cost-usd=<usd>] [--max-tokens=<n>]
 * Exit: 0 = gates pass · 1 = gate FAIL / missing key · EXIT_SPEND_CAP (3) = spend cap aborted.
 *
 * This file is a thin orchestration shell — ALL metric assembly lives in ./lib/* under test.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runSafetyPrefilter } from '@medadhere/shared';
import type { AdherenceClassificationT } from '@medadhere/shared';
import {
  ONSIDES_SOURCE_VERSION,
  onsidesEffectsForRxcui,
  onsidesHasLabelData,
} from '../src/classifier/onsides.js';
import { classifyReplyText, type ClassifyUsage } from '../src/classifier/classify.js';
import { evaluateAdeMatcher, loadAdeGold } from './lib/ade-eval.js';
import { aggregatePassK, type PassKRun } from './lib/passk.js';
import { buildPassKReport, type PassKRunLifeSafety } from './lib/passk-report.js';
import { EXEMPLAR_REPLY, FEW_SHOT_EXEMPLARS, PROMPT_VERSION } from '../src/classifier/prompt.js';
import { assembleLiveMetrics } from './lib/assemble.js';
import { assertPerClassFloors, loadGoldSet } from './lib/gold-set.js';
import { assertNoExemplarLeakage } from './lib/leakage.js';
import { clopperPearsonInterval, formatMetric } from './lib/metrics.js';
import { runPrefilterEval } from './lib/offline-eval.js';
import { buildPerClassReport, evaluateGates, interRaterSection } from './lib/report.js';
import { LIVE_EVAL_CONCURRENCY, runLiveEval, type ClassifyFn, type EvalRowResult } from './lib/runner.js';
import { aggregateUsage } from './lib/usage-agg.js';
import {
  EXIT_SPEND_CAP,
  MIN_COST_PER_CALL,
  SpendCapExceededError,
  SpendGovernor,
} from './lib/spend-cap.js';
import {
  buildAblationReport,
  buildAdeTermBlock,
  computeAblationDelta,
  compareNoRegression,
  decideShipArmB,
  type AblationReport,
} from './lib/ablation.js';
import {
  COVERAGE_ARTIFACT_FILENAME,
  CoverageArtifactError,
  coverageHandoffFromArtifact,
  parseCoverageArtifact,
} from './lib/coverage-artifact.js';

const RESULTS_DIR = fileURLToPath(new URL('./results/', import.meta.url));
/** The D2→D1 coverage handoff the freeze writer persists + --ablation reads (review HIGH, 04-07). */
const COVERAGE_ARTIFACT_PATH = fileURLToPath(
  new URL(`./${COVERAGE_ARTIFACT_FILENAME}`, import.meta.url),
);

/** Thrown by parseEvalArgs on a malformed flag — fail CLOSED, never a silent uncapped run (D0b). */
export class EvalArgError extends Error {
  override readonly name = 'EvalArgError';
}

export interface EvalArgs {
  readonly offline: boolean;
  readonly live: boolean;
  readonly ablation: boolean;
  /** k, present iff --repeat[=k] was given (defaults to 5 when bare, matching prior behavior). */
  readonly repeat?: number;
  /** Validated finite, non-negative cost cap (absent -> Default-ON in the governor). */
  readonly maxCostUsd?: number;
  /** Validated finite, non-negative token cap. */
  readonly maxTokens?: number;
}

/**
 * The injected classify seam. Structurally the production `classifyReplyText` is assignable here
 * (the extra optional `systemAppendix` is ignored by the current core; Deliverable 1 formalizes
 * it on ClassifyOptions + `effectiveSystemPrompt`). Keeping the seam local to run-eval avoids a
 * D0 edit to the production classify contract that D1 owns.
 */
export type ClassifyReplyTextDep = (
  rawBody: string,
  opts: { apiKey: string; onUsage?: (usage: ClassifyUsage) => void; systemAppendix?: string },
) => Promise<AdherenceClassificationT>;

export interface RunEvalDeps {
  readonly args: EvalArgs;
  readonly env: NodeJS.ProcessEnv;
  readonly classifyReplyText: ClassifyReplyTextDep;
  readonly writeFileSync: (path: string, data: string) => void;
  readonly now: () => Date;
  readonly resultsDir: string;
  /**
   * Lazily read + JSON.parse the D2→D1 OnSIDES coverage artifact (raw, unvalidated). Called ONLY in
   * the --ablation branch; MUST throw if the artifact is missing (fail-CLOSED). Injected so the
   * offline ablation unit tests feed a fixture without touching disk (review HIGH, 04-07).
   */
  readonly readCoverageArtifact: () => unknown;
}

/** Read a finite, non-negative numeric flag; throw EvalArgError on anything malformed (D0b). */
function parseNonNegativeNumericFlag(
  argv: readonly string[],
  name: string,
): number | undefined {
  const idx = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (idx === -1) return undefined;
  const arg = argv[idx]!;
  const raw = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[idx + 1];
  const n = Number(raw);
  // NaN ('abc'), ±Infinity, an empty/absent value, or a negative all fail CLOSED — a malformed
  // flag must NEVER silently construct a governor that never trips. `0` is a valid (immediate)
  // cap, distinct from an absent flag (Default-ON).
  if (raw === undefined || raw === '' || !Number.isFinite(n) || n < 0) {
    throw new EvalArgError(
      `${name} must be a finite, non-negative number (got "${raw ?? ''}")`,
    );
  }
  return n;
}

/** Pure flag decoder (import-testable). Fail-CLOSED on malformed numeric flags (D0b). */
export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  const offline = argv.includes('--offline');
  const live = argv.includes('--live');
  const ablation = argv.includes('--ablation');

  const repeatArg = argv.find((a) => a === '--repeat' || a.startsWith('--repeat='));
  let repeat: number | undefined;
  if (repeatArg !== undefined) {
    const raw = repeatArg.includes('=') ? repeatArg.slice('--repeat='.length) : undefined;
    if (raw === undefined || raw === '') {
      repeat = 5; // bare --repeat keeps the prior default k=5
    } else {
      const k = Math.floor(Number(raw));
      if (!Number.isFinite(k) || k < 1) {
        throw new EvalArgError(`--repeat must be a positive integer (got "${raw}")`);
      }
      repeat = k;
    }
  }

  const maxCostUsd = parseNonNegativeNumericFlag(argv, '--max-cost-usd');
  const maxTokens = parseNonNegativeNumericFlag(argv, '--max-tokens');
  return { offline, live, ablation, repeat, maxCostUsd, maxTokens };
}

/**
 * Injectable eval body (import-testable). ALL of the old `main()` lives here; `process.exit`
 * stays ONLY in `main()`. Deterministic via injected `classifyReplyText` / `writeFileSync` /
 * `now`, so the integration test drives it with a stub classify at $0.
 */
export async function runEvalCli(deps: RunEvalDeps): Promise<number> {
  const { args, env } = deps;

  // D0c: compute once and require ANTHROPIC_API_KEY for EVERY live mode. A blank CI secret with
  // --live/--ablation/--repeat must fail LOUD, never silently downgrade to the offline floors and
  // exit green (the exact bug class F2 was written to prevent).
  const wantsAnyLiveMode = args.live || args.ablation || args.repeat !== undefined;
  if (wantsAnyLiveMode && !env.ANTHROPIC_API_KEY) {
    console.error(
      'run-eval: live modes (--live/--ablation/--repeat) require ANTHROPIC_API_KEY (blank CI secret?)',
    );
    return 1;
  }
  const offline = !wantsAnyLiveMode && (args.offline || !env.ANTHROPIC_API_KEY);

  const rows = loadGoldSet();
  assertNoExemplarLeakage(rows, [EXEMPLAR_REPLY, ...FEW_SHOT_EXEMPLARS.map((e) => e.reply)]);
  const floors = assertPerClassFloors(rows);
  const prefilter = runPrefilterEval(rows);
  const interRater = interRaterSection(rows);

  console.log(`gold set: ${rows.length} rows · prompt ${PROMPT_VERSION} · leakage clean`);
  console.log(`per-class support: ${JSON.stringify(floors.support)}`);
  if (floors.insufficient.length > 0) {
    console.log(`insufficient-support classes: ${floors.insufficient.join(', ')}`);
  }
  console.log(`prefilter lexicon recall (SC6 offline floor): ${prefilter.lexiconSlice.formatted}`);
  console.log(
    `prefilter false positives on gold-none rows (precision cost, by design): ${prefilter.falsePositives.map((f) => f.id).join(', ') || 'none'}`,
  );
  console.log(
    interRater.skipped ? `inter-rater: SKIPPED — ${interRater.reason}` : 'inter-rater: computable',
  );

  // DRUG-02 ADE matcher — advisory eval on the held-out matcher gold set (offline, $0).
  // Precision target ≥ 0.8 is REPORTED, NOT a gate (04-06 pre-exec: matcher is advisory).
  // Wrapped (Code review LOW-B): an advisory feature must NEVER fail the unrelated offline
  // floor — a missing/corrupt OnSIDES asset degrades to a skipped line, not a harness exit 1.
  try {
    const ade = evaluateAdeMatcher(loadAdeGold(), {
      effectsFor: onsidesEffectsForRxcui,
      hasLabelData: onsidesHasLabelData,
    });
    const adePrecision = ade.matched.precision === null ? 'n/a' : ade.matched.precision.toFixed(3);
    console.log(
      `ADE matcher (advisory, NOT gated): precision ${adePrecision} (target ≥0.80), ` +
        `recall ${ade.matched.recall.toFixed(3)} (${ade.matched.tp}/${ade.matched.goldPositives}), ` +
        `U-20 status agreement ${ade.statusAgreement.correct}/${ade.statusAgreement.total}`,
    );
    if (ade.recallMisses.length > 0) console.log(`  ADE recall misses (map coverage gaps): ${ade.recallMisses.join(', ')}`);
    if (ade.falsePositives.length > 0) console.log(`  ADE false positives (precision cost): ${ade.falsePositives.join(', ')}`);
  } catch (err) {
    console.log(`ADE matcher eval: skipped (${err instanceof Error ? err.name : 'error'}) — advisory, does not gate`);
  }

  if (offline) {
    const pass = prefilter.lexiconSlice.recall === 1;
    console.log(pass ? 'OFFLINE FLOORS: PASS' : 'OFFLINE FLOORS: FAIL (prefilter recall < 1.0)');
    return pass ? 0 : 1;
  }

  const apiKey = env.ANTHROPIC_API_KEY as string;

  // ONE SpendGovernor for the whole process (item G). Default-ON when no --max-cost-usd (item 5),
  // logged loudly: there is no uncapped live path.
  const governor = new SpendGovernor({ maxCostUsd: args.maxCostUsd, maxTokens: args.maxTokens });
  console.log(
    `SPEND CAP: $${governor.costCeilingUsd.toFixed(2)} max` +
      (args.maxCostUsd === undefined ? ' (DEFAULT-ON — no --max-cost-usd given)' : ' (explicit)') +
      (args.maxTokens !== undefined ? ` · ${args.maxTokens} tok max` : '') +
      ` · BOUNDED OVERSHOOT ≤ ${LIVE_EVAL_CONCURRENCY} in-flight calls after a trip`,
  );

  /** Wrap the injected classify with the governor: assert-before-dispatch + record-in-onUsage. */
  const makeClassify = (sink: ClassifyUsage[], systemAppendix?: string): ClassifyFn => (text) => {
    // "Stop dispatching NEW calls" gate — throws once tripped; runner records it as an error row
    // (never a live call). Called BEFORE classifyReplyText so a tripped governor never bills.
    governor.assertWithinBudget();
    return deps.classifyReplyText(text, {
      apiKey,
      onUsage: (u) => {
        sink.push(u);
        governor.record(u); // TOTAL, non-throwing — folds into the ONE shared governor
      },
      ...(systemAppendix !== undefined ? { systemAppendix } : {}),
    });
  };

  /** Pre-flight refusal wrapper: convert a SpendCapExceededError into the distinct EXIT code. */
  const preflight = (projectedCalls: number): number | null => {
    try {
      governor.projectAndGuard(projectedCalls, MIN_COST_PER_CALL);
      return null;
    } catch (err) {
      if (err instanceof SpendCapExceededError) {
        console.error(`ABORTED (pre-flight): ${err.message}`);
        return EXIT_SPEND_CAP;
      }
      throw err;
    }
  };

  // ── ablation (--ablation): DRUG-03 A/B prompt-enrichment, SC12 (D1). ─────────────────────────
  if (args.ablation) {
    // D2→D1 coverage handoff (review HIGH, 04-07): REQUIRE + LOAD the DRUG-01 freeze's coverage
    // artifact and build arm B's term block ONLY from the COHORT's coverage-passed ingredient
    // rxcuis — NOT from Object.keys(loadOnsidesIndex().labels) (the 15-ingredient REPRESENTATIVE
    // asset, which is not the cohort). Fail CLOSED: refuse to run if the artifact is
    // missing/malformed/stale, or if coverage FAILED and no reviewed override was recorded.
    let coverageRaw: unknown;
    try {
      coverageRaw = deps.readCoverageArtifact();
    } catch (err) {
      console.error(
        'run-eval --ablation: cannot load the D2 OnSIDES coverage artifact ' +
          '(run the DRUG-01 freeze first — scripts/freeze-drug-profiles.ts): ' +
          (err instanceof Error ? err.message : String(err)),
      );
      return 1;
    }
    let coverage;
    try {
      coverage = parseCoverageArtifact(coverageRaw, ONSIDES_SOURCE_VERSION);
    } catch (err) {
      if (err instanceof CoverageArtifactError) {
        console.error(`run-eval --ablation: ${err.message}`);
        return 1;
      }
      throw err;
    }
    if (!coverage.allCovered && !coverage.reviewedOverride) {
      console.error(
        'run-eval --ablation: D2 OnSIDES coverage FAILED — uncovered cohort ingredient(s): ' +
          `${coverage.uncovered.join(', ')}. Re-vendor OnSIDES for the cohort rxcuis, or re-run the ` +
          'freeze with an explicit reviewed override; refusing to run on an unresolved coverage gate.',
      );
      return 1;
    }

    // The gold rows are text-only, so ONE static union block is appended identically to every row —
    // the fixed-vocabulary LOWER-BOUND proxy for SC12. Built from coverage.covered; the uncovered
    // ingredients are carried as EXPLICIT exclusions in the coverage handoff, never silently dropped.
    const coverageHandoff = coverageHandoffFromArtifact(coverage);
    const block = buildAdeTermBlock(coverage.covered, onsidesEffectsForRxcui, onsidesHasLabelData);
    console.log(
      `ablation arm B term block: ${block.provenance.ptCount} PTs from ` +
        `${coverage.covered.length} coverage-passed cohort rxcuis` +
        (coverage.uncovered.length > 0
          ? ` (excluded ${coverage.uncovered.length}: ${coverage.uncovered.join(', ')})`
          : '') +
        ` · ${block.provenance.charLength} chars` +
        (block.provenance.truncated ? ' (truncated)' : '') +
        ` · block ${block.provenance.blockHash.slice(0, 12)}` +
        ` · OnSIDES ${block.provenance.onsidesSourceVersion}`,
    );

    const arms: { readonly label: 'A' | 'B'; readonly systemAppendix?: string }[] = [
      { label: 'A', systemAppendix: undefined }, // production base prompt
      { label: 'B', systemAppendix: block.appendix }, // base + the OnSIDES term block
    ];
    const pf = preflight(rows.length * arms.length);
    if (pf !== null) return pf;

    /**
     * Persist the ablation artifact (DATA-01: id-keyed, no reply text). Filename derived from the
     * report's OWN generatedAt (one now() per write, set at the buildAblationReport call site) so
     * the on-disk name always matches the artifact's generatedAt field — mirrors the pass^k writer.
     */
    const writeAblationArtifact = (report: AblationReport): void => {
      mkdirSync(deps.resultsDir, { recursive: true });
      const outPath = `${deps.resultsDir}ablation-${PROMPT_VERSION}-${report.generatedAt.replace(/[:.]/g, '-')}.json`;
      deps.writeFileSync(outPath, JSON.stringify(report, null, 2));
      console.log(`ablation results written: ${outPath}`);
    };

    const armResults: { label: 'A' | 'B'; results: EvalRowResult[] }[] = [];
    for (const arm of arms) {
      // Tripped-FIRST (item B): a tripped/partial arm is DISCARDED, never analyzed. Check BEFORE
      // dispatching the next arm so a cap trip in arm A never lets arm B run.
      if (governor.tripped) {
        console.error(
          `ABORTED: spend cap $${governor.costCeilingUsd.toFixed(2)} reached before ablation arm ` +
            `${arm.label} — arm discarded, not analyzed (after ${governor.calls} calls, ` +
            `$${governor.spentUsd.toFixed(4)})`,
        );
        writeAblationArtifact(
          buildAblationReport({
            status: 'spendCap',
            promptVersion: PROMPT_VERSION,
            blockProvenance: block.provenance,
            coverageHandoff,
            gold: rows,
            armA: armResults.find((a) => a.label === 'A')?.results ?? [],
            armB: armResults.find((a) => a.label === 'B')?.results ?? [],
            generatedAt: deps.now().toISOString(),
          }),
        );
        return EXIT_SPEND_CAP;
      }
      const armUsage: ClassifyUsage[] = [];
      console.log(`ablation arm ${arm.label}: classifying ${rows.length} rows…`);
      const { results } = await runLiveEval(rows, makeClassify(armUsage, arm.systemAppendix));
      armResults.push({ label: arm.label, results });
    }

    const armA = armResults.find((a) => a.label === 'A')!.results;
    const armB = armResults.find((a) => a.label === 'B')!.results;

    // Tripped-FIRST post-run (item B): a trip during arm B aborts before ANY delta/guard — a
    // partial artifact is persisted and computeAblationDelta / compareNoRegression are NEVER run.
    if (governor.tripped) {
      console.error(
        `ABORTED: spend cap $${governor.costCeilingUsd.toFixed(2)} reached during the ablation ` +
          `after ${governor.calls} calls ($${governor.spentUsd.toFixed(4)})`,
      );
      writeAblationArtifact(
        buildAblationReport({
          status: 'spendCap',
          promptVersion: PROMPT_VERSION,
          blockProvenance: block.provenance,
          gold: rows,
          armA,
          armB,
          generatedAt: deps.now().toISOString(),
        }),
      );
      return EXIT_SPEND_CAP;
    }

    // Completeness precedence (item B): BOTH arms must have zero errored rows before any delta —
    // unequal errored-row counts would compare accuracy/precision over unequal samples. A model/API
    // error in either arm aborts as INCOMPLETE (distinct from a spend-cap trip), with a partial
    // artifact and no delta.
    const erroredA = armA.filter((r) => r.error).map((r) => r.id);
    const erroredB = armB.filter((r) => r.error).map((r) => r.id);
    if (erroredA.length > 0 || erroredB.length > 0) {
      console.error(
        `ABORTED: ablation arm(s) had errored rows (A: ${erroredA.length}, B: ${erroredB.length}) — ` +
          'an incomplete arm is not analyzable; rerun',
      );
      writeAblationArtifact(
        buildAblationReport({
          status: 'incomplete',
          promptVersion: PROMPT_VERSION,
          blockProvenance: block.provenance,
          gold: rows,
          armA,
          armB,
          generatedAt: deps.now().toISOString(),
        }),
      );
      return 1;
    }

    // Both arms complete + un-tripped: compute the per-row delta + the numeric no-regression guard,
    // and require arm B to independently pass all four evaluateGates floors.
    const prefilterHit = (text: string): boolean => runSafetyPrefilter(text).hit;
    const armAMetrics = assembleLiveMetrics(rows, armA, prefilterHit);
    const armBMetrics = assembleLiveMetrics(rows, armB, prefilterHit);
    const armBGates = evaluateGates({
      accuracy: armBMetrics.accuracy.point,
      lifeSafetyRecall: armBMetrics.lifeSafety.recall,
      prefilterLexiconRecall: prefilter.lexiconSlice.recall,
      takenPrecision: armBMetrics.perClass.taken?.precision ?? 0,
      ordSafetyRecall: armBMetrics.ordSafety.recall,
      medicalQuestionRecall: armBMetrics.medicalQuestion.recall,
      semanticSafetyRecall: armBMetrics.semanticSafety.recall,
      erroredCount: armBMetrics.coverage.errored.length,
    });

    // The per-row delta + numeric no-regression guard + ship verdict (the SC12 analysis). Computed
    // once here for the console summary; buildAblationReport recomputes the same from armA/armB for
    // the persisted artifact (both share the delta's per-row side_effect table as the SSOT).
    const delta = computeAblationDelta(rows, armA, armB);
    const noReg = compareNoRegression(armAMetrics, armBMetrics, delta);
    const ship = decideShipArmB({ delta, noRegression: noReg, armBGatesPass: armBGates.pass });

    writeAblationArtifact(
      buildAblationReport({
        status: 'complete',
        promptVersion: PROMPT_VERSION,
        blockProvenance: block.provenance,
        coverageHandoff,
        gold: rows,
        armA,
        armB,
        armAMetrics,
        armBMetrics,
        armBGatesPass: armBGates.pass,
        generatedAt: deps.now().toISOString(),
      }),
    );
    console.log(
      `ablation complete (${governor.calls} calls, $${governor.spentUsd.toFixed(4)}): ` +
        `reason-code completeness A=${delta.reasonCompletenessA.toFixed(3)} B=${delta.reasonCompletenessB.toFixed(3)} ` +
        `(Δ ${delta.reasonCompletenessDelta.toFixed(4)}) · side_effect precision A=${delta.sideEffect.precisionA ?? 'n/a'} ` +
        `B=${delta.sideEffect.precisionB ?? 'n/a'} (FP B=${delta.sideEffect.falsePositivesB})`,
    );
    console.log(
      `SC12 ship arm B? ${ship.ship ? 'SHIP' : 'HOLD'} — no-regression ${noReg.pass ? 'OK' : 'FAIL'}, ` +
        `arm-B gates ${armBGates.pass ? 'PASS' : 'FAIL'}` +
        (ship.reasons.length ? ` — ${ship.reasons.join(' | ')}` : '') +
        ' (DESCRIPTIVE single-pass delta; adopting arm B is a separate PROMPT_VERSION decision — 04-SUMMARY)',
    );
    return 0;
  }

  // ── pass^k (--repeat[=k]): rerun the life-safety subset k times. ─────────────────────────────
  if (args.repeat !== undefined) {
    const k = args.repeat;
    const lifeRows = rows.filter((r) => r.safety_flag === 'crisis' || r.safety_flag === 'acute_physical');
    console.log(`pass^k: rerunning ${lifeRows.length} life-safety rows (crisis+acute_physical) ×${k}…`);
    const pf = preflight(lifeRows.length * k);
    if (pf !== null) return pf;

    /**
     * Persist the pass^k artifact (D3, closes map-claim ii gap). Filename derived from the report's
     * own ISO timestamp so it always matches generatedAt. Mirrors the ablation write path.
     */
    const writePassKArtifact = (report: ReturnType<typeof buildPassKReport>): void => {
      mkdirSync(deps.resultsDir, { recursive: true });
      const outPath = `${deps.resultsDir}eval-passk-${PROMPT_VERSION}-${report.generatedAt.replace(/[:.]/g, '-')}.json`;
      deps.writeFileSync(outPath, JSON.stringify(report, null, 2));
      console.log(`pass^k results written: ${outPath}`);
    };

    // Each run's metrics are assembled EVEN when the governor trips mid-run: the runner still
    // returns that run's (partial) results with errored rows, and both the per-run errored ids and
    // the completeness verdict must record them (item C / H1). A trip stops LAUNCHING further runs.
    const runs: PassKRun[] = [];
    const perRunErrored: string[][] = [];
    const perRunLifeSafety: PassKRunLifeSafety[] = [];
    const passkUsage: ClassifyUsage[] = [];
    for (let i = 0; i < k; i++) {
      const { results } = await runLiveEval(lifeRows, makeClassify(passkUsage));
      const m = assembleLiveMetrics(lifeRows, results, (t) => runSafetyPrefilter(t).hit);
      runs.push({ caught: m.lifeSafety.caught, denominator: m.lifeSafety.denominator });
      perRunErrored.push(m.coverage.errored);
      perRunLifeSafety.push({
        caught: m.lifeSafety.caught,
        denominator: m.lifeSafety.denominator,
        missIds: m.lifeSafety.missIds,
      });
      console.log(
        `  run ${i + 1}/${k}: life-safety ${m.lifeSafety.caught}/${m.lifeSafety.denominator}` +
          (m.lifeSafety.missIds.length ? ` — MISSES ${m.lifeSafety.missIds.join(', ')}` : '') +
          (m.coverage.errored.length ? ` — ERRORED ${m.coverage.errored.join(', ')}` : ''),
      );
      // Tripped-FIRST (item B/C): once tripped, stop launching runs — the run is recorded above,
      // and the artifact below is written with status='aborted' (NOT a passK safety verdict).
      if (governor.tripped) {
        console.error(
          `ABORTED: spend cap $${governor.costCeilingUsd.toFixed(2)} reached during pass^k run ` +
            `${i + 1}/${k} after ${governor.calls} calls ($${governor.spentUsd.toFixed(4)}) — ` +
            'pass^k artifact written with status=aborted (no passK safety verdict)',
        );
        break;
      }
    }

    const pkUsage = aggregateUsage(passkUsage);
    console.log(
      `pass^k usage: ${pkUsage.count} calls · mean ${pkUsage.meanLatencyMs ?? 'n/a'}ms · ` +
        `p95 ${pkUsage.p95LatencyMs ?? 'n/a'}ms · ${pkUsage.totalInputTokens}+${pkUsage.totalOutputTokens} tok · ` +
        `$${pkUsage.totalCostUsd.toFixed(4)} total`,
    );

    // Build the durable report WITH the completeness verdict, then persist it on EVERY path below.
    const pk = aggregatePassK(runs);
    const report = buildPassKReport({
      pk,
      perRunErrored,
      governorTripped: governor.tripped,
      perRunLifeSafety,
      usage: pkUsage,
      k,
      promptVersion: PROMPT_VERSION,
      now: deps.now(),
    });
    writePassKArtifact(report);

    // Governor trip (item-B precedence): aborted → distinct EXIT_SPEND_CAP, no passK verdict.
    if (report.status === 'aborted') return EXIT_SPEND_CAP;
    // Errored rows without a trip: incomplete → gate-FAIL-equivalent 1, no passK verdict (this is
    // the --repeat mirror of the main path's evaluateGates erroredCount belt).
    if (report.status === 'incomplete') {
      console.error(
        `pass^k INCOMPLETE — ${perRunErrored.reduce((n, ids) => n + ids.length, 0)} errored row(s) ` +
          'across runs; no passK safety verdict is written (rerun)',
      );
      return 1;
    }

    console.log(
      `pass^${k}: ${pk.passK ? 'PASS' : 'FAIL'} | aggregate ${pk.totalCaught}/${pk.totalTrials} = ` +
        `${report.aggregateRecallFormatted} (${report.metricSemantics})`,
    );
    if (!pk.passK) console.log(`  failing runs: ${pk.failingRuns.map((i) => i + 1).join(', ')}`);
    return pk.passK ? 0 : 1;
  }

  // ── base --live: classify every gold row once through the production core. ───────────────────
  console.log(`live eval: classifying ${rows.length} rows via the production core…`);
  const pf = preflight(rows.length);
  if (pf !== null) return pf;

  const usageRecords: ClassifyUsage[] = [];
  const { results } = await runLiveEval(rows, makeClassify(usageRecords));
  // Tripped-FIRST (item B): check the governor BEFORE any gate/metric verdict — an aborted run
  // must return EXIT_SPEND_CAP, never a (partial-data) gate PASS/FAIL.
  if (governor.tripped) {
    console.error(
      `ABORTED: spend cap $${governor.costCeilingUsd.toFixed(2)} reached after ${governor.calls} ` +
        `calls ($${governor.spentUsd.toFixed(4)}) — no gate verdict is written for an aborted run`,
    );
    return EXIT_SPEND_CAP;
  }
  const usage = aggregateUsage(usageRecords);
  const metrics = assembleLiveMetrics(rows, results, (text) => runSafetyPrefilter(text).hit);
  console.log(
    `classified ${metrics.coverage.classified}/${metrics.coverage.total} (${metrics.coverage.errored.length} errored)`,
  );
  console.log(
    `usage: ${usage.count} calls · mean ${usage.meanLatencyMs ?? 'n/a'}ms · p95 ${usage.p95LatencyMs ?? 'n/a'}ms · ` +
      `${usage.totalInputTokens}+${usage.totalOutputTokens} tok · $${usage.totalCostUsd.toFixed(4)} total` +
      (usage.meanCostUsd !== null ? ` · $${usage.meanCostUsd.toFixed(6)}/call` : ''),
  );

  const gates = evaluateGates({
    accuracy: metrics.accuracy.point,
    lifeSafetyRecall: metrics.lifeSafety.recall, // GATED tier (crisis + acute_physical)
    prefilterLexiconRecall: prefilter.lexiconSlice.recall,
    takenPrecision: metrics.perClass.taken?.precision ?? 0,
    ordSafetyRecall: metrics.ordSafety.recall, // reported only (04-SAFETY-GATE-AMENDMENT)
    medicalQuestionRecall: metrics.medicalQuestion.recall, // reported only
    semanticSafetyRecall: metrics.semanticSafety.recall,
    erroredCount: metrics.coverage.errored.length,
  });

  const report = {
    promptVersion: PROMPT_VERSION,
    coverage: metrics.coverage,
    // Per-call latency/cost aggregate (onUsage seam) — thesis cost line + budget figure.
    usage,
    accuracy: formatMetric(
      metrics.accuracy.point,
      clopperPearsonInterval(metrics.accuracy.successes, Math.max(metrics.accuracy.trials, 1)),
    ),
    perClass: buildPerClassReport(metrics.perClass),
    // GATED safety tier (04-SAFETY-GATE-AMENDMENT): crisis + acute_physical.
    lifeSafetyRecall_GATED: formatMetric(
      metrics.lifeSafety.recall,
      clopperPearsonInterval(
        metrics.lifeSafety.caught,
        Math.max(metrics.lifeSafety.denominator, 1),
      ),
    ),
    lifeSafetyMisses: metrics.lifeSafety.missIds,
    // REPORTED, non-gating tiers.
    medicalQuestionRecall_reportedTargetNotGated: formatMetric(
      metrics.medicalQuestion.recall,
      clopperPearsonInterval(
        metrics.medicalQuestion.tp,
        Math.max(metrics.medicalQuestion.denominator, 1),
      ),
    ),
    medicalQuestionPrecision_reported:
      metrics.medicalQuestion.precision === null
        ? 'n/a (never predicted)'
        : formatMetric(
            metrics.medicalQuestion.precision,
            clopperPearsonInterval(
              metrics.medicalQuestion.tp,
              Math.max(metrics.medicalQuestion.predictedCount, 1),
            ),
          ),
    medicalQuestionMisses: metrics.medicalQuestion.missIds,
    // Legacy pooled OR'd safety recall — kept for continuity, no longer the gate.
    ordSafetyRecall_legacyPooledReported: formatMetric(
      metrics.ordSafety.recall,
      clopperPearsonInterval(metrics.ordSafety.caught, Math.max(metrics.ordSafety.denominator, 1)),
    ),
    ordSafetyMisses: metrics.ordSafety.missIds,
    semanticSafetyRecall_reportedTargetNotGated: formatMetric(
      metrics.semanticSafety.recall,
      clopperPearsonInterval(
        metrics.semanticSafety.caught,
        Math.max(metrics.semanticSafety.denominator, 1),
      ),
    ),
    reasonCodeCompleteness_STUDY08: formatMetric(
      metrics.reasonCompleteness.denominator === 0
        ? 0
        : metrics.reasonCompleteness.matched / metrics.reasonCompleteness.denominator,
      clopperPearsonInterval(
        metrics.reasonCompleteness.matched,
        Math.max(metrics.reasonCompleteness.denominator, 1),
      ),
    ),
    prefilterLexiconRecall: prefilter.lexiconSlice.formatted,
    interRater,
    gates,
    // DATA-01: id-keyed label records only — no reply text; errors are
    // sanitized to name+status by the runner (F5)
    results,
  };

  mkdirSync(deps.resultsDir, { recursive: true });
  const outPath = `${deps.resultsDir}eval-${PROMPT_VERSION}-${deps.now().toISOString().replace(/[:.]/g, '-')}.json`;
  deps.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, results: `(${results.length} rows in file)` }, null, 2));
  console.log(`results written: ${outPath}`);
  console.log(gates.pass ? 'GATES: PASS' : `GATES: FAIL — ${gates.failures.join(' | ')}`);
  return gates.pass ? 0 : 1;
}

/** Thin CLI wrapper — the ONLY place `process.exit` lives (item K). */
async function main(): Promise<number> {
  return runEvalCli({
    args: parseEvalArgs(process.argv),
    env: process.env,
    classifyReplyText,
    writeFileSync,
    now: () => new Date(),
    resultsDir: RESULTS_DIR,
    // Read the committed D2→D1 coverage handoff. Throws (fail-CLOSED) if the DRUG-01 freeze has not
    // written it yet — the --ablation branch turns that into a clear refusal + non-zero exit.
    readCoverageArtifact: () => JSON.parse(readFileSync(COVERAGE_ARTIFACT_PATH, 'utf8')),
  });
}

// Only auto-run as a CLI, never on import (so the integration test can import runEvalCli).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error('eval run failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
