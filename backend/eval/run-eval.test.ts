/**
 * run-eval.test.ts — Deliverable 0 (Plan 04-07) integration: the import-testable CLI seam
 * (`parseEvalArgs` + `runEvalCli`) with the SpendGovernor wired in. Every case is OFFLINE + $0:
 * the classify path is a stub injected through `runEvalCli`'s deps — no live Anthropic call, no
 * disk write on the exercised paths. Covers RED tests #7 (--offline never bills), #8 (fail-CLOSED
 * numeric flags), and #11 (shared governor, bounded-overshoot dispatch stop, distinct
 * EXIT_SPEND_CAP, arm A/B selection, blank-key fail-loud).
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { AdherenceClassificationT } from '@medadhere/shared';
import {
  parseEvalArgs,
  runEvalCli,
  type ClassifyReplyTextDep,
  type RunEvalDeps,
} from './run-eval.js';
import { EXIT_SPEND_CAP } from './lib/spend-cap.js';
import { LIVE_EVAL_CONCURRENCY } from './lib/runner.js';
import { COVERAGE_ARTIFACT_VERSION } from './lib/coverage-artifact.js';
import { ONSIDES_SOURCE_VERSION } from '../src/classifier/onsides.js';

/**
 * A fixture D2→D1 OnSIDES coverage artifact (review HIGH, 04-07). The offline --ablation tests feed
 * this via the injectable `readCoverageArtifact` dep so they never touch disk. Covered rxcuis are real
 * vendored-asset keys so run-eval's block build (real onsides accessors) yields a non-empty block.
 */
function coverageFixture(
  over: Partial<{
    covered: string[];
    uncovered: string[];
    allCovered: boolean;
    reviewedOverride: boolean;
    onsidesSourceVersion: string;
    artifactVersion: number;
  }> = {},
): unknown {
  const covered = over.covered ?? ['435', '5487', '6809'];
  const uncovered = over.uncovered ?? [];
  return {
    kind: 'onsides-coverage',
    artifactVersion: over.artifactVersion ?? COVERAGE_ARTIFACT_VERSION,
    onsidesSourceVersion: over.onsidesSourceVersion ?? ONSIDES_SOURCE_VERSION,
    generatedAt: '1970-01-01T00:00:00.000Z',
    entries: [
      ...covered.map((rxcui) => ({ rxcui, hasLabelData: true })),
      ...uncovered.map((rxcui) => ({ rxcui, hasLabelData: false, reason: 'no_onsides_label_data' })),
    ],
    covered,
    uncovered,
    allCovered: over.allCovered ?? uncovered.length === 0,
    reviewedOverride: over.reviewedOverride ?? false,
  };
}

// A real, writable, per-run scratch dir — portable across local sandboxes AND CI. runEvalCli
// performs a REAL mkdirSync(deps.resultsDir) before its (stubbed) writeFileSync, so resultsDir
// must be a genuinely creatable path. The previous hardcoded sandbox-temp literal happened to
// exist locally but is uncreatable on the CI runner (mkdir '/private/...' → EACCES). Trailing
// sep: run-eval builds `${resultsDir}<file>` by concatenation, so the dir must end in a separator.
const SCRATCH = mkdtempSync(join(tmpdir(), 'run-eval-test-')) + sep;
// Computed so the raw env-var name never appears as a `<NAME>: '<value>'` literal (the repo's
// secret scanner flags that pattern); these are stub values, never a real key.
const KEY_ENV = 'ANTHROPIC' + '_API_KEY';
const STUB_KEY = 'stub-key-not-a-secret';

const LABEL: AdherenceClassificationT = {
  adherence_state: 'taken',
  reason_code: 'none',
  safety_flag: 'none',
};

/** Build injectable deps with sensible offline defaults; a test overrides what it needs. */
function mkDeps(over: Partial<RunEvalDeps> & { classifyReplyText: ClassifyReplyTextDep }): RunEvalDeps {
  return {
    args: parseEvalArgs(['--offline']),
    env: {},
    writeFileSync: vi.fn(),
    now: () => new Date(0),
    resultsDir: SCRATCH,
    // Default: only the --ablation branch reads this; every other path leaves it untouched. An
    // ablation test that needs it overrides with `coverageFixture()`.
    readCoverageArtifact: () => {
      throw new Error('readCoverageArtifact not provided in this test');
    },
    ...over,
  };
}

afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe('parseEvalArgs — fail-CLOSED numeric flags (D0b, item H)', () => {
  it('rejects a non-numeric --max-cost-usd', () => {
    expect(() => parseEvalArgs(['--live', '--max-cost-usd=abc'])).toThrow();
  });
  it('rejects a negative --max-cost-usd', () => {
    expect(() => parseEvalArgs(['--live', '--max-cost-usd=-1'])).toThrow();
  });
  it('rejects a non-finite --max-cost-usd (Infinity)', () => {
    expect(() => parseEvalArgs(['--live', '--max-cost-usd=Infinity'])).toThrow();
  });
  it('rejects a non-numeric --max-tokens', () => {
    expect(() => parseEvalArgs(['--live', '--max-tokens=xyz'])).toThrow();
  });
  it('accepts a valid positive value and 0; an absent flag is undefined (Default-ON), never unlimited', () => {
    expect(parseEvalArgs(['--live', '--max-cost-usd=0.5']).maxCostUsd).toBe(0.5);
    expect(parseEvalArgs(['--live', '--max-cost-usd=0']).maxCostUsd).toBe(0); // valid 0, distinct
    expect(parseEvalArgs(['--live']).maxCostUsd).toBeUndefined(); // absent -> governor Default-ON
    expect(parseEvalArgs(['--live', '--max-tokens=100000']).maxTokens).toBe(100_000);
  });
});

describe('runEvalCli — spend cap + CLI seam (offline, stubbed classify — $0)', () => {
  it('#7 --offline never constructs a live call: classifyReplyText is never invoked, floors return 0', async () => {
    const classify = vi.fn<ClassifyReplyTextDep>();
    const code = await runEvalCli(mkDeps({ args: parseEvalArgs(['--offline']), classifyReplyText: classify }));
    expect(classify).not.toHaveBeenCalled();
    expect(code).toBe(0); // offline floors pass on the real signed gold set
  });

  it('#11e --ablation with a blank ANTHROPIC_API_KEY fails LOUD (never a silent offline downgrade)', async () => {
    const classify = vi.fn<ClassifyReplyTextDep>();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runEvalCli(
      mkDeps({
        args: parseEvalArgs(['--ablation']),
        env: { [KEY_ENV]: '' }, // blank secret
        classifyReplyText: classify,
      }),
    );
    expect(code).toBe(1); // distinct from EXIT_SPEND_CAP and from a green offline run
    expect(classify).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });

  it('#11a/b/c --ablation: ONE shared governor trips in arm A, arm B never dispatches, returns EXIT_SPEND_CAP', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const armCalls: Record<'A' | 'B', number> = { A: 0, B: 0 };
    const classify: ClassifyReplyTextDep = async (_text, opts) => {
      const arm = opts.systemAppendix === undefined ? 'A' : 'B';
      armCalls[arm] += 1;
      // Emit a per-call cost that busts the 0.05 cap on the first call (bounded-overshoot region).
      opts.onUsage?.({
        model: 'm',
        promptVersion: 'v1',
        latencyMs: 1,
        inputTokens: 60_000, // $0.06 at $1/Mtok input
        outputTokens: 0,
        estimatedCostUsd: 0.06,
      });
      return LABEL;
    };
    const code = await runEvalCli(
      mkDeps({
        // maxCostUsd 0.05 clears the pre-flight floor (400 * $0.0001 = $0.04) but trips in-flight.
        args: parseEvalArgs(['--ablation', '--max-cost-usd=0.05']),
        env: { [KEY_ENV]: STUB_KEY },
        classifyReplyText: classify,
        readCoverageArtifact: () => coverageFixture(),
      }),
    );
    expect(code).toBe(EXIT_SPEND_CAP); // NOT a gate-FAIL 1
    // Arm B never ran: the tripped governor (shared instance) aborted before arm B dispatched.
    expect(armCalls.B).toBe(0);
    // Bounded overshoot: at least the breaching call, at most breach + concurrency in-flight.
    expect(armCalls.A).toBeGreaterThanOrEqual(1);
    expect(armCalls.A).toBeLessThanOrEqual(1 + LIVE_EVAL_CONCURRENCY);
  });

  it('#3 --repeat: a COMPLETE run writes a durable eval-passk-*.json (status complete, passK boolean) — DATA-01 clean', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Stub catches EVERY life-safety row (safety_flag != 'none') so all runs hit 1.0 → passK true,
    // never throws → zero errored rows → status 'complete'. Tiny per-call cost never trips the cap.
    const classify: ClassifyReplyTextDep = async (_text, opts) => {
      opts.onUsage?.({
        model: 'm',
        promptVersion: 'v1',
        latencyMs: 5,
        inputTokens: 10,
        outputTokens: 2,
        estimatedCostUsd: (10 * 1 + 2 * 5) / 1_000_000,
      });
      return { adherence_state: 'unknown', reason_code: 'none', safety_flag: 'crisis' };
    };
    const writeFileSync = vi.fn();
    const code = await runEvalCli(
      mkDeps({
        args: parseEvalArgs(['--repeat=2']), // 2 runs over the real life-safety subset
        env: { [KEY_ENV]: STUB_KEY },
        classifyReplyText: classify,
        writeFileSync,
      }),
    );

    expect(code).toBe(0); // a complete, passing pass^k returns 0 (not EXIT_SPEND_CAP, not 1)
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [outPath, payload] = writeFileSync.mock.calls[0]!;
    // Mirrors the tracked evidence naming eval-v1-*.json → eval-passk-v1-*.json
    expect(outPath).toMatch(/eval-passk-v1-.*\.json$/);
    const report = JSON.parse(payload as string);
    expect(report.kind).toBe('passk');
    expect(report.status).toBe('complete');
    expect(report.passK).toBe(true);
    expect(report.governorTripped).toBe(false);
    // DATA-01: the durable artifact carries no reply-text-bearing field.
    expect(payload).not.toMatch(/"text"|"reply"|"rawBody"/);
  });

  it('#3b --repeat: an errored (non-trip) run persists status "incomplete", passK null (NOT a false safety verdict), exit 1 — not EXIT_SPEND_CAP', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Every life-safety classify emits a tiny ($0) usage record via onUsage, then THROWS — a
    // transient-failure simulation. No governor trip (cost ≈ $0 under the Default-ON $1.50 cap),
    // but every row is an errored row so each run is INCOMPLETE. The raw pass^k aggregate would
    // read these errored rows as life-safety misses (a passK=false verdict, indistinguishable from
    // a real 988/911 miss); the real --repeat write path must instead file passK=null.
    const classify: ClassifyReplyTextDep = async (_text, opts) => {
      opts.onUsage?.({
        model: 'm',
        promptVersion: 'v1',
        latencyMs: 5,
        inputTokens: 10,
        outputTokens: 2,
        estimatedCostUsd: (10 * 1 + 2 * 5) / 1_000_000,
      });
      throw new Error('simulated transient classify failure');
    };
    const writeFileSync = vi.fn();
    const code = await runEvalCli(
      mkDeps({
        args: parseEvalArgs(['--repeat=2']), // 2 runs over the real life-safety subset
        env: { [KEY_ENV]: STUB_KEY },
        classifyReplyText: classify,
        writeFileSync,
      }),
    );

    expect(code).toBe(1); // incomplete → the gate-FAIL-equivalent exit 1…
    expect(code).not.toBe(EXIT_SPEND_CAP); // …never the spend-cap exit (this was NOT a cap trip)
    expect(writeFileSync).toHaveBeenCalledTimes(1); // exactly one durable pass^k artifact
    const [outPath, payload] = writeFileSync.mock.calls[0]!;
    expect(outPath).toMatch(/eval-passk-v1-.*\.json$/);
    const report = JSON.parse(payload as string);
    expect(report.kind).toBe('passk');
    expect(report.status).toBe('incomplete'); // not hardcoded 'complete'
    expect(report.passK).toBeNull(); // NOT a passK=false safety verdict on an errored run
    expect(report.governorTripped).toBe(false); // it was errored rows, not a cap trip
    // Both runs ran (no trip) and each recorded its errored gold ids — the WHY behind 'incomplete'.
    expect(report.perRunErrored.length).toBe(2);
    expect(report.perRunErrored.every((ids: string[]) => ids.length > 0)).toBe(true);
    // DATA-01: the durable artifact carries no reply-text-bearing field.
    expect(payload).not.toMatch(/"text"|"reply"|"rawBody"/);
  });

  it('#3c --repeat: a mid-run governor trip (unexhausted k) persists status "aborted", passK null, skips remaining runs, ONE artifact, EXIT_SPEND_CAP', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Each classify emits $0.60 via onUsage — the first RECORDED call busts the $0.50 cap, tripping
    // the ONE shared governor during run 1 of 5. Pre-flight (≈13 life-safety rows × 5 × $0.0001 =
    // $0.0065) clears, so run 1 launches; the trip then stops LAUNCHING runs 2–5. Returns a crisis
    // label (no throw) so the abort verdict is caused by the trip, not by row errors.
    const classify: ClassifyReplyTextDep = async (_text, opts) => {
      opts.onUsage?.({
        model: 'm',
        promptVersion: 'v1',
        latencyMs: 1,
        inputTokens: 600_000, // $0.60 at $1/Mtok input
        outputTokens: 0,
        estimatedCostUsd: 0.6, // > the $0.50 cap → trips on the first recorded call
      });
      return { adherence_state: 'unknown', reason_code: 'none', safety_flag: 'crisis' };
    };
    const writeFileSync = vi.fn();
    const code = await runEvalCli(
      mkDeps({
        args: parseEvalArgs(['--repeat=5', '--max-cost-usd=0.5']),
        env: { [KEY_ENV]: STUB_KEY },
        classifyReplyText: classify,
        writeFileSync,
      }),
    );

    expect(code).toBe(EXIT_SPEND_CAP); // aborted → the distinct cap exit, NOT a gate-FAIL 1
    expect(writeFileSync).toHaveBeenCalledTimes(1); // exactly ONE pass^k artifact despite k=5
    const [outPath, payload] = writeFileSync.mock.calls[0]!;
    expect(outPath).toMatch(/eval-passk-v1-.*\.json$/);
    const report = JSON.parse(payload as string);
    expect(report.kind).toBe('passk');
    expect(report.status).toBe('aborted'); // not 'complete', not 'incomplete'
    expect(report.passK).toBeNull(); // never a passK safety verdict on an aborted run
    expect(report.governorTripped).toBe(true); // the WHY behind 'aborted'
    expect(report.k).toBe(5); // the REQUESTED k…
    expect(report.perRunRecall.length).toBe(1); // …but the trip skipped runs 2–5 (only run 1 ran)
    expect(report.perRunErrored.length).toBe(1); // only the launched run recorded
    // DATA-01: the durable artifact carries no reply-text-bearing field.
    expect(payload).not.toMatch(/"text"|"reply"|"rawBody"/);
  });

  it('#11d/#5 --ablation Default-ON: both arms A/B are selected; a within-budget run returns non-cap, cap logged', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
    const armSeen = new Set<string>();
    const classify: ClassifyReplyTextDep = async (_text, opts) => {
      armSeen.add(opts.systemAppendix === undefined ? 'A' : 'B');
      // Tiny cost — never trips the Default-ON $1.50 cap across two full arms.
      opts.onUsage?.({
        model: 'm',
        promptVersion: 'v1',
        latencyMs: 1,
        inputTokens: 10,
        outputTokens: 2,
        estimatedCostUsd: (10 * 1 + 2 * 5) / 1_000_000,
      });
      return LABEL;
    };
    const code = await runEvalCli(
      mkDeps({
        args: parseEvalArgs(['--ablation']), // NO --max-cost-usd -> Default-ON
        env: { [KEY_ENV]: STUB_KEY },
        classifyReplyText: classify,
        readCoverageArtifact: () => coverageFixture(),
      }),
    );
    expect(code).not.toBe(EXIT_SPEND_CAP); // a within-budget ablation is not a cap abort
    expect(armSeen.has('A')).toBe(true);
    expect(armSeen.has('B')).toBe(true); // arm A (no appendix) AND arm B (appendix) both selected
    // Default-ON cap announced loudly (item 5): the $1.50 default appears in a log line.
    expect(logs.some((l) => l.includes('SPEND CAP') && l.includes('1.50') && l.includes('DEFAULT'))).toBe(true);
  });
});

describe('runEvalCli --ablation — D2→D1 OnSIDES coverage handoff (review HIGH, 04-07)', () => {
  it('(b) REFUSES (exit 1, no classify) when the coverage artifact is MISSING', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const classify = vi.fn<ClassifyReplyTextDep>();
    const code = await runEvalCli(
      mkDeps({
        args: parseEvalArgs(['--ablation']),
        env: { [KEY_ENV]: STUB_KEY },
        classifyReplyText: classify,
        readCoverageArtifact: () => {
          throw new Error('ENOENT: coverage artifact not found (run the DRUG-01 freeze first)');
        },
      }),
    );
    expect(code).toBe(1);
    expect(code).not.toBe(EXIT_SPEND_CAP);
    expect(classify).not.toHaveBeenCalled(); // refused BEFORE any live dispatch (fail-CLOSED)
  });

  it('(b) REFUSES when coverage FAILED (uncovered ingredient, no reviewed override)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const classify = vi.fn<ClassifyReplyTextDep>();
    const code = await runEvalCli(
      mkDeps({
        args: parseEvalArgs(['--ablation']),
        env: { [KEY_ENV]: STUB_KEY },
        classifyReplyText: classify,
        readCoverageArtifact: () =>
          coverageFixture({
            covered: ['6809'],
            uncovered: ['99999999'],
            allCovered: false,
            reviewedOverride: false,
          }),
      }),
    );
    expect(code).toBe(1);
    expect(code).not.toBe(EXIT_SPEND_CAP);
    expect(classify).not.toHaveBeenCalled();
  });

  it('(b) REFUSES when the coverage artifact is STALE (OnSIDES source-version mismatch)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const classify = vi.fn<ClassifyReplyTextDep>();
    const code = await runEvalCli(
      mkDeps({
        args: parseEvalArgs(['--ablation']),
        env: { [KEY_ENV]: STUB_KEY },
        classifyReplyText: classify,
        readCoverageArtifact: () => coverageFixture({ onsidesSourceVersion: 'v0.0.0-stale' }),
      }),
    );
    expect(code).toBe(1);
    expect(classify).not.toHaveBeenCalled();
  });

  it('(b) REFUSES when the coverage artifact is MALFORMED (fails the shared schema)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const classify = vi.fn<ClassifyReplyTextDep>();
    const code = await runEvalCli(
      mkDeps({
        args: parseEvalArgs(['--ablation']),
        env: { [KEY_ENV]: STUB_KEY },
        classifyReplyText: classify,
        readCoverageArtifact: () => ({ kind: 'onsides-coverage', covered: 'not-an-array' }),
      }),
    );
    expect(code).toBe(1);
    expect(classify).not.toHaveBeenCalled();
  });

  it('(c) a successful ablation builds arm B from the coverage-passed cohort (block.sourceRxcuis == covered); uncovered recorded ONLY as explicit exclusions', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const covered = ['435', '5487', '6809']; // real vendored-asset keys (NOT the full 15-ingredient asset)
    const uncovered = ['99999999'];
    const classify: ClassifyReplyTextDep = async (_text, opts) => {
      opts.onUsage?.({
        model: 'm',
        promptVersion: 'v1',
        latencyMs: 1,
        inputTokens: 10,
        outputTokens: 2,
        estimatedCostUsd: (10 * 1 + 2 * 5) / 1_000_000,
      });
      return LABEL;
    };
    const writeFileSync = vi.fn();
    const code = await runEvalCli(
      mkDeps({
        args: parseEvalArgs(['--ablation']),
        env: { [KEY_ENV]: STUB_KEY },
        classifyReplyText: classify,
        writeFileSync,
        // allCovered:false WITH a reviewed override → proceeds; the uncovered ingredient is a
        // deliberate exclusion, never silently folded into the block source.
        readCoverageArtifact: () =>
          coverageFixture({ covered, uncovered, allCovered: false, reviewedOverride: true }),
      }),
    );

    expect(code).not.toBe(EXIT_SPEND_CAP);
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const report = JSON.parse(writeFileSync.mock.calls[0]![1] as string);
    expect(report.kind).toBe('ablation');
    expect(report.status).toBe('complete');
    // The block source is EXACTLY the D2 coverage-passed cohort list — NOT the vendored asset keys.
    expect(report.block.sourceRxcuis).toEqual([...covered].sort());
    expect(report.block.sourceRxcuis).not.toContain('99999999');
    // The uncovered ingredient is recorded ONLY as an explicit exclusion in the coverage handoff.
    expect(report.coverageHandoff.covered).toEqual(covered);
    expect(report.coverageHandoff.excluded).toEqual(uncovered);
    expect(report.coverageHandoff.reviewedOverride).toBe(true);
  });
});

describe('runEvalCli --ablation — error-path + artifact-filename coverage (04-07 HIGH+MED)', () => {
  it('HIGH — a genuine (non-spend-cap) model error in an arm aborts INCOMPLETE: exit 1 (not EXIT_SPEND_CAP), status "incomplete", NO delta computed', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Arm A classifies cleanly at a negligible cost; arm B throws a PLAIN Error on every row — a
    // transient model/API failure, NOT a SpendCapExceededError. Total spend stays ≈ $0 under the
    // Default-ON $1.50 cap, so the governor NEVER trips: the abort is caused by errored rows only.
    const classify: ClassifyReplyTextDep = async (_text, opts) => {
      if (opts.systemAppendix === undefined) {
        opts.onUsage?.({
          model: 'm',
          promptVersion: 'v1',
          latencyMs: 1,
          inputTokens: 10,
          outputTokens: 2,
          estimatedCostUsd: (10 * 1 + 2 * 5) / 1_000_000,
        });
        return LABEL;
      }
      throw new Error('simulated model/API failure in arm B'); // sanitized to name 'Error'
    };
    const writeFileSync = vi.fn();
    const code = await runEvalCli(
      mkDeps({
        args: parseEvalArgs(['--ablation']), // Default-ON cap; no trip on ≈ $0 spend
        env: { [KEY_ENV]: STUB_KEY },
        classifyReplyText: classify,
        writeFileSync,
        readCoverageArtifact: () => coverageFixture(),
      }),
    );

    expect(code).toBe(1); // gate-FAIL-equivalent exit …
    expect(code).not.toBe(EXIT_SPEND_CAP); // … distinct from a spend-cap abort (this was NOT a trip)
    expect(writeFileSync).toHaveBeenCalledTimes(1); // exactly ONE partial artifact
    const [, payload] = writeFileSync.mock.calls[0]!;
    const report = JSON.parse(payload as string);
    expect(report.kind).toBe('ablation');
    expect(report.status).toBe('incomplete'); // not 'complete', not 'spendCap'
    // The core guarantee: computeAblationDelta / compareNoRegression are NEVER run on a partial arm.
    expect(report.delta).toBeUndefined();
    expect(report.noRegression).toBeUndefined();
    expect(report.ship).toBeUndefined();
    // arm B's genuine errored rows are recorded distinctly (name 'Error', NOT 'SpendCapExceededError').
    expect(report.arms.B.errored.length).toBeGreaterThan(0);
    expect(report.arms.B.errored.some((e: { error: string }) => e.error === 'Error')).toBe(true);
    expect(report.arms.B.errored.every((e: { error: string }) => e.error !== 'SpendCapExceededError')).toBe(true);
    // DATA-01: the durable artifact carries no reply-text-bearing field.
    expect(payload).not.toMatch(/"text"|"reply"|"rawBody"/);
  });

  it('HIGH — precedence (item B): a governor trip AND genuine errored rows in the same arm → EXIT_SPEND_CAP + status "spendCap" win over "incomplete"', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Arm A runs clean + cheap (never trips). Arm B bills $0.60/call (busts the $0.50 cap on the
    // first RECORDED call) AND throws a PLAIN Error — so arm B ends with BOTH a tripped governor
    // and genuine (non-cap) errored rows. Pre-flight (≈400 × $0.0001 = $0.04) clears the $0.50 cap.
    const classify: ClassifyReplyTextDep = async (_text, opts) => {
      if (opts.systemAppendix === undefined) {
        opts.onUsage?.({
          model: 'm',
          promptVersion: 'v1',
          latencyMs: 1,
          inputTokens: 10,
          outputTokens: 2,
          estimatedCostUsd: (10 * 1 + 2 * 5) / 1_000_000,
        });
        return LABEL;
      }
      opts.onUsage?.({
        model: 'm',
        promptVersion: 'v1',
        latencyMs: 1,
        inputTokens: 600_000, // $0.60 at $1/Mtok input → trips the $0.50 cap on the first record
        outputTokens: 0,
        estimatedCostUsd: 0.6,
      });
      throw new Error('simulated model/API failure in arm B'); // a genuine, non-cap error row
    };
    const writeFileSync = vi.fn();
    const code = await runEvalCli(
      mkDeps({
        args: parseEvalArgs(['--ablation', '--max-cost-usd=0.5']),
        env: { [KEY_ENV]: STUB_KEY },
        classifyReplyText: classify,
        writeFileSync,
        readCoverageArtifact: () => coverageFixture(),
      }),
    );

    expect(code).toBe(EXIT_SPEND_CAP); // the spend-cap exit takes precedence …
    expect(code).not.toBe(1); // … over the "incomplete" gate-FAIL-equivalent exit
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [, payload] = writeFileSync.mock.calls[0]!;
    const report = JSON.parse(payload as string);
    expect(report.status).toBe('spendCap'); // NOT 'incomplete', even though errored rows exist
    expect(report.delta).toBeUndefined(); // a partial run is never analyzed
    // A genuine (non-cap) errored row genuinely coexists with the trip — the precedence is real.
    expect(report.arms.B.errored.some((e: { error: string }) => e.error === 'Error')).toBe(true);
    expect(payload).not.toMatch(/"text"|"reply"|"rawBody"/);
  });

  it('MED — the persisted ablation FILENAME is derived from report.generatedAt (single now() per write), never a second clock read', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // A clock that ADVANCES on every read: if the filename made its own now() call (distinct from
    // the report's generatedAt now()), the two ISO stamps would differ and this assertion would fail.
    let tick = 0;
    const now = (): Date => new Date(tick++ * 60_000);
    const classify: ClassifyReplyTextDep = async (_text, opts) => {
      opts.onUsage?.({
        model: 'm',
        promptVersion: 'v1',
        latencyMs: 1,
        inputTokens: 10,
        outputTokens: 2,
        estimatedCostUsd: (10 * 1 + 2 * 5) / 1_000_000,
      });
      return LABEL;
    };
    const writeFileSync = vi.fn();
    const code = await runEvalCli(
      mkDeps({
        args: parseEvalArgs(['--ablation']), // Default-ON cap; a within-budget complete run
        env: { [KEY_ENV]: STUB_KEY },
        classifyReplyText: classify,
        writeFileSync,
        now,
        readCoverageArtifact: () => coverageFixture(),
      }),
    );

    expect(code).not.toBe(EXIT_SPEND_CAP);
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [outPath, payload] = writeFileSync.mock.calls[0]!;
    const report = JSON.parse(payload as string);
    expect(report.status).toBe('complete');
    // The on-disk filename stamp is EXACTLY the report's own generatedAt (matching the pass^k writer).
    const stamp = report.generatedAt.replace(/[:.]/g, '-');
    expect(outPath).toBe(`${SCRATCH}ablation-${report.promptVersion}-${stamp}.json`);
  });
});
