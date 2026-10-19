/**
 * passk-report.test.ts — Deliverable 3 (Plan 04-07): the pure, serializable pass^k report block
 * WITH a completeness verdict. Offline + $0: every input is a hand-built PassKResult / usage
 * aggregate — no live Anthropic call, no disk write (the pure builder does no IO).
 *
 * The load-bearing invariant (ULTRA H1, items C + H1): an incomplete run (any errored life-safety
 * row) or an aborted run (a tripped spend governor) NEVER produces a passK=false safety verdict —
 * `report.passK` is null and `status` records why. ONLY a complete, un-tripped run yields a durable
 * passK boolean. The `--repeat` write path (governor.tripped-FIRST) is covered in run-eval.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { aggregatePassK, type PassKRun } from './passk.js';
import { formatMetric } from './metrics.js';
import type { UsageAggregate } from './usage-agg.js';
import { buildPassKReport, type PassKRunLifeSafety } from './passk-report.js';

// A representative usage aggregate (shape mirrors aggregateUsage output). Cents-scale, offline.
const USAGE: UsageAggregate = {
  count: 99,
  withTokens: 99,
  meanLatencyMs: 420,
  p95LatencyMs: 900,
  totalInputTokens: 12_000,
  totalOutputTokens: 2_400,
  totalCostUsd: 0.0132,
  meanCostUsd: 0.0132 / 99,
};

const clean3: PassKRun[] = [
  { caught: 33, denominator: 33 },
  { caught: 33, denominator: 33 },
  { caught: 33, denominator: 33 },
];
const cleanLifeSafety: PassKRunLifeSafety[] = [
  { caught: 33, denominator: 33, missIds: [] },
  { caught: 33, denominator: 33, missIds: [] },
  { caught: 33, denominator: 33, missIds: [] },
];

describe('buildPassKReport — #1 serializes every field; JSON round-trips passK + aggregateRecall', () => {
  it('a COMPLETE run carries all fields and round-trips through JSON.parse', () => {
    // Arrange
    const pk = aggregatePassK(clean3);

    // Act
    const report = buildPassKReport({
      pk,
      perRunErrored: [[], [], []],
      governorTripped: false,
      perRunLifeSafety: cleanLifeSafety,
      usage: USAGE,
      k: 3,
      promptVersion: 'v1',
      now: new Date(0),
    });
    const parsed = JSON.parse(JSON.stringify(report)) as typeof report;

    // Assert — the boolean verdict + aggregate survive the round-trip
    expect(parsed.passK).toBe(true);
    expect(typeof parsed.passK).toBe('boolean');
    expect(parsed.aggregateRecall).toBe(1);
    // formatted CI is present and matches the metrics-lib rendering (never a bare number)
    expect(parsed.aggregateRecallFormatted).toBe(formatMetric(pk.aggregateRecall, pk.aggregateCI));
    // every declared field is present
    expect(parsed.k).toBe(3);
    expect(parsed.status).toBe('complete');
    expect(parsed.perRunRecall).toEqual([1, 1, 1]);
    expect(parsed.failingRuns).toEqual([]);
    expect(parsed.totalCaught).toBe(99);
    expect(parsed.totalTrials).toBe(99);
    expect(parsed.governorTripped).toBe(false);
    expect(parsed.perRunLifeSafety).toEqual(cleanLifeSafety);
    expect(parsed.usage).toEqual(USAGE);
    expect(parsed.promptVersion).toBe('v1');
    expect(parsed.generatedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(parsed.kind).toBe('passk');
  });
});

describe('buildPassKReport — #2 the persisted block is DATA-01 clean (gold ids only, no reply text)', () => {
  it('records gold ids in missIds/perRunErrored but never any reply-text-bearing field', () => {
    // Arrange — one miss + one errored row, referenced by gold id only
    const pk = aggregatePassK([
      { caught: 32, denominator: 33 },
      { caught: 33, denominator: 33 },
    ]);

    // Act
    const report = buildPassKReport({
      pk,
      perRunErrored: [['g0007'], []],
      governorTripped: false,
      perRunLifeSafety: [
        { caught: 32, denominator: 33, missIds: ['g0042'] },
        { caught: 33, denominator: 33, missIds: [] },
      ],
      usage: USAGE,
      k: 2,
      promptVersion: 'v1',
      now: new Date(0),
    });
    const serialized = JSON.stringify(report);

    // Assert — gold ids ARE allowed (they are not PHI); reply text never is
    expect(serialized).toContain('g0042');
    expect(serialized).toContain('g0007');
    expect(report.perRunLifeSafety[0]!.missIds).toEqual(['g0042']);
    // No field that could carry raw reply text is present anywhere in the artifact.
    expect(serialized).not.toMatch(/"text"|"reply"|"rawBody"|"body"/);
  });
});

describe('buildPassKReport — #4 incomplete/aborted runs never emit a passK=false safety verdict', () => {
  it('a partial-errored run → status "incomplete", passK null (NOT false), errored recorded', () => {
    // Arrange — a run that MISSED a life-safety row: the raw aggregate would say passK=false
    const pk = aggregatePassK([
      { caught: 30, denominator: 33 },
      { caught: 33, denominator: 33 },
    ]);
    expect(pk.passK).toBe(false); // the bare aggregate WOULD read as a safety FAIL

    // Act — but run 1 had errored rows, so the run is not a durable verdict
    const report = buildPassKReport({
      pk,
      perRunErrored: [['g0007', 'g0008'], []],
      governorTripped: false,
      perRunLifeSafety: [
        { caught: 30, denominator: 33, missIds: ['g0007', 'g0008', 'g0009'] },
        { caught: 33, denominator: 33, missIds: [] },
      ],
      usage: USAGE,
      k: 2,
      promptVersion: 'v1',
      now: new Date(0),
    });

    // Assert — the artifact is NOT filed as a passK=false safety verdict
    expect(report.status).toBe('incomplete');
    expect(report.passK).toBeNull();
    expect(report.passK).not.toBe(false);
    expect(report.perRunErrored).toEqual([['g0007', 'g0008'], []]);
    expect(report.governorTripped).toBe(false);
  });

  it('a tripped governor → status "aborted", passK null, governorTripped recorded', () => {
    const pk = aggregatePassK([{ caught: 33, denominator: 33 }]); // would be passK=true

    const report = buildPassKReport({
      pk,
      perRunErrored: [[]],
      governorTripped: true,
      perRunLifeSafety: [{ caught: 33, denominator: 33, missIds: [] }],
      usage: USAGE,
      k: 5,
      promptVersion: 'v1',
      now: new Date(0),
    });

    expect(report.status).toBe('aborted');
    expect(report.passK).toBeNull();
    expect(report.governorTripped).toBe(true);
  });

  it('governor.tripped is checked FIRST (item-B precedence): tripped AND errored → "aborted", not "incomplete"', () => {
    const pk = aggregatePassK([{ caught: 30, denominator: 33 }]);

    const report = buildPassKReport({
      pk,
      perRunErrored: [['g0007']], // also errored
      governorTripped: true, // …but the trip takes precedence
      perRunLifeSafety: [{ caught: 30, denominator: 33, missIds: ['g0007'] }],
      usage: USAGE,
      k: 5,
      promptVersion: 'v1',
      now: new Date(0),
    });

    expect(report.status).toBe('aborted'); // NOT 'incomplete'
    expect(report.passK).toBeNull();
  });
});

describe('buildPassKReport — #5 the metric is labeled descriptive test-retest stability, not inference', () => {
  it('carries the passk.ts semantics wording into the persisted artifact', () => {
    const report = buildPassKReport({
      pk: aggregatePassK(clean3),
      perRunErrored: [[], [], []],
      governorTripped: false,
      perRunLifeSafety: cleanLifeSafety,
      usage: USAGE,
      k: 3,
      promptVersion: 'v1',
      now: new Date(0),
    });

    const serialized = JSON.stringify(report);
    expect(report.metricSemantics).toMatch(/descriptive test-retest stability/i);
    expect(report.metricSemantics).toMatch(/not.*population inference/i);
    // it survives serialization (the thesis artifact carries the caveat, not just the console)
    expect(serialized).toContain('descriptive test-retest stability');
  });
});
