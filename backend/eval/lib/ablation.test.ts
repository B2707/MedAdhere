/**
 * ablation.test.ts — Deliverable 1 (Plan 04-07): the DRUG-03 A/B ablation lib (SC12).
 *
 * Every case is OFFLINE + $0: per-row `EvalRowResult`/`GoldRow` fixtures, fixture `LiveMetrics`,
 * a stubbed OnSIDES `effectsFor`/`hasLabelData`, and a mocked Anthropic SDK for the ONE seam test
 * that exercises `classifyReplyText`. No live Anthropic call is ever made.
 *
 * The 8 RED tests (04-07-PLAN Deliverable 1):
 *   1. Term-block ≤ ~150-token budget (~600-char proxy) + deterministic + provenance-tagged
 *      (incl. per-rxcui coverage status, boxed-warning/elevated first).
 *   2. (item M) effectiveSystemPrompt(appendix) = base + delimiter + block; effectiveSystemPrompt()
 *      = base exactly; arm B via `systemAppendix` reaches the core, arm A does not.
 *   3. Handler call-site: the classifier handler never passes `systemAppendix`.
 *   4. (item A) computeAblationDelta(gold, armA, armB) reads per-row reason labels: adherence
 *      accuracy IDENTICAL across arms, side_effect capture differs → the delta reflects it.
 *   5. (item D + N1/N2/N3) compareNoRegression reads side_effect precision from the PER-ROW delta,
 *      not LiveMetrics: a side_effect-precision drop (accuracy/taken flat) FAILS ship-B; a
 *      within-noise (< epsilon) non-safety negative delta does NOT; a life-safety drop fails with
 *      NO tolerance; a clean B ≥ A PASSES. Reads the real accessors accuracy.point /
 *      lifeSafety.recall / perClass['taken'].precision.
 *   6. (item B) a cap trip / errored arm never reaches computeAblationDelta / compareNoRegression.
 *   7. (item E) side_effect precision + FP count present; a completeness "win" with a side_effect
 *      precision regression is flagged NOT shippable.
 *   8. Ablation report is DATA-01 clean (id-keyed, no reply text).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { messagesCreate } = vi.hoisted(() => ({ messagesCreate: vi.fn() }));

vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const real = (await importOriginal()) as { default: Record<string, unknown> };
  class MockAnthropic {
    messages = { create: messagesCreate };
    constructor() {}
  }
  for (const key of [
    'APIError',
    'AuthenticationError',
    'PermissionDeniedError',
    'RateLimitError',
    'InternalServerError',
    'APIConnectionError',
  ]) {
    (MockAnthropic as unknown as Record<string, unknown>)[key] = real.default[key];
  }
  return { default: MockAnthropic };
});

import type { AdherenceClassificationT } from '@medadhere/shared';
import type { OnsidesEffect } from '../../src/classifier/onsides.js';
import { SYSTEM_PROMPT, effectiveSystemPrompt } from '../../src/classifier/prompt.js';
import { classifyReplyText } from '../../src/classifier/classify.js';
import type { GoldRow } from './gold-set.js';
import type { EvalRowResult } from './runner.js';
import type { LiveMetrics } from './assemble.js';
import {
  TERM_BLOCK_MAX_CHARS,
  NO_REGRESSION_EPSILON,
  REASON_CODES,
  buildAdeTermBlock,
  computeAblationDelta,
  compareNoRegression,
  decideShipArmB,
  buildAblationReport,
  type AblationDelta,
} from './ablation.js';

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────
const FAKE_KEY = 'test-anthropic-api-key';

function goldRow(
  id: string,
  over: Partial<Pick<GoldRow, 'adherence_state' | 'reason_code' | 'safety_flag' | 'text'>> = {},
): GoldRow {
  return {
    id,
    slice_hint: 'adherence_core',
    register: 'standard',
    source: 'synthetic',
    text: over.text ?? `reply text for ${id}`,
    lexicon_tags: [],
    adherence_state: over.adherence_state ?? 'taken',
    reason_code: over.reason_code ?? 'none',
    safety_flag: over.safety_flag ?? 'none',
    label_confidence: 'agreed',
    adjudication_note: '',
    audit_ok: 'y',
    audit_note: '',
    rater2_adherence_state: '',
    rater2_reason_code: '',
    rater2_safety_flag: '',
  };
}

function goldLabel(r: GoldRow): AdherenceClassificationT {
  return {
    adherence_state: r.adherence_state,
    reason_code: r.reason_code,
    safety_flag: r.safety_flag,
  };
}

function result(r: GoldRow, predicted?: AdherenceClassificationT, error?: string): EvalRowResult {
  const base = { id: r.id, gold: goldLabel(r) };
  if (error !== undefined) return { ...base, error };
  return { ...base, predicted };
}

/** Minimal LiveMetrics carrying only the accessors compareNoRegression reads. */
function mkMetrics(over: {
  accuracy: number;
  lifeSafetyRecall: number;
  takenPrecision?: number;
}): LiveMetrics {
  return {
    coverage: { total: 0, classified: 0, errored: [] },
    accuracy: { point: over.accuracy, successes: 0, trials: 0 },
    perClass:
      over.takenPrecision === undefined
        ? {}
        : {
            taken: {
              precision: over.takenPrecision,
              recall: 0,
              support: 0,
              truePositives: 0,
              predictedCount: 0,
            },
          },
    ordSafety: { caught: 0, denominator: 0, recall: 0, missIds: [] },
    lifeSafety: { caught: 0, denominator: 0, recall: over.lifeSafetyRecall, missIds: [] },
    medicalQuestion: {
      tp: 0,
      denominator: 0,
      recall: 0,
      predictedCount: 0,
      precision: null,
      missIds: [],
    },
    semanticSafety: { caught: 0, denominator: 0, recall: 0 },
    reasonCompleteness: { matched: 0, denominator: 0 },
  };
}

/** A full AblationDelta literal — lets compareNoRegression's tolerance logic be tested directly. */
function mkDelta(over: {
  precisionA: number | null;
  precisionB: number | null;
  completenessDelta?: number;
}): AblationDelta {
  const emptyCell = { goldSupport: 0, matched: 0, completeness: 0 };
  const per = Object.fromEntries(REASON_CODES.map((c) => [c, { ...emptyCell }]));
  return {
    reasonCodes: REASON_CODES,
    perReasonA: { ...per },
    perReasonB: { ...per },
    reasonCompletenessA: 0,
    reasonCompletenessB: over.completenessDelta ?? 0,
    reasonCompletenessDelta: over.completenessDelta ?? 0,
    sideEffect: {
      precisionA: over.precisionA,
      precisionB: over.precisionB,
      truePositivesA: 0,
      truePositivesB: 0,
      predictedCountA: over.precisionA === null ? 0 : 1,
      predictedCountB: over.precisionB === null ? 0 : 1,
      falsePositivesA: 0,
      falsePositivesB: 0,
      falsePositiveIdsA: [],
      falsePositiveIdsB: [],
    },
  };
}

// stubbed OnSIDES index — controlled effects, one covered / one uncovered rxcui
const STUB_EFFECTS: Record<string, OnsidesEffect[]> = {
  '435': [
    { meddra_id: '1', pt: 'Tremor', hint_level: 'elevated' },
    { meddra_id: '2', pt: 'Tachycardia', hint_level: 'info' },
    { meddra_id: '3', pt: 'Headache', hint_level: 'info' },
  ],
  '5487': [
    { meddra_id: '4', pt: 'Nausea', hint_level: 'elevated' },
    { meddra_id: '5', pt: 'Headache', hint_level: 'info' }, // dup PT across rxcuis
  ],
  '999': [], // present in the cohort list but NO label data (excluded from block)
};
const stubEffectsFor = (rxcui: string): readonly OnsidesEffect[] => STUB_EFFECTS[rxcui] ?? [];
const stubHasLabelData = (rxcui: string): boolean => rxcui === '435' || rxcui === '5487';

// ── #1 term-block ───────────────────────────────────────────────────────────────────────────
describe('#1 buildAdeTermBlock — budget, determinism, ranking, provenance', () => {
  it('emits a ≤600-char comma block, elevated PTs first, dedup, with per-rxcui coverage + hash', () => {
    const block = buildAdeTermBlock(['435', '5487', '999'], stubEffectsFor, stubHasLabelData);

    expect(block.appendix.length).toBeLessThanOrEqual(TERM_BLOCK_MAX_CHARS);
    // elevated tier (Tremor, Nausea) precedes the info tier (Headache, Tachycardia)
    const tremorAt = block.appendix.indexOf('Tremor');
    const nauseaAt = block.appendix.indexOf('Nausea');
    const tachyAt = block.appendix.indexOf('Tachycardia');
    expect(tremorAt).toBeGreaterThanOrEqual(0);
    expect(nauseaAt).toBeGreaterThanOrEqual(0);
    expect(Math.max(tremorAt, nauseaAt)).toBeLessThan(tachyAt);
    // Headache appears once despite being on two rxcuis (dedup)
    expect(block.appendix.match(/Headache/g)).toHaveLength(1);

    // provenance: per-rxcui coverage status, incl. the excluded no-data rxcui
    const cov = Object.fromEntries(block.provenance.coverage.map((c) => [c.rxcui, c.hasLabelData]));
    expect(cov['435']).toBe(true);
    expect(cov['5487']).toBe(true);
    expect(cov['999']).toBe(false); // excluded, but recorded, never silently dropped
    expect(block.appendix).not.toContain('999');
    expect(block.provenance.onsidesSourceVersion).toBeTruthy();
    expect(block.provenance.blockHash).toMatch(/^[0-9a-f]{64}$/);
    expect(block.provenance.ptCount).toBeGreaterThan(0);
  });

  it('is deterministic — two builds of the same inputs are byte-identical (same hash)', () => {
    const a = buildAdeTermBlock(['5487', '435', '999'], stubEffectsFor, stubHasLabelData);
    const b = buildAdeTermBlock(['999', '435', '5487'], stubEffectsFor, stubHasLabelData);
    expect(a.appendix).toBe(b.appendix); // input order does not matter
    expect(a.provenance.blockHash).toBe(b.provenance.blockHash);
  });

  it('truncates to the budget when the PT set is large, flagging truncated=true', () => {
    const many: OnsidesEffect[] = Array.from({ length: 400 }, (_, i) => ({
      meddra_id: String(i),
      pt: `Effect number ${i} with a fairly long descriptive term`,
      hint_level: 'info',
    }));
    const block = buildAdeTermBlock(
      ['x'],
      () => many,
      () => true,
    );
    expect(block.appendix.length).toBeLessThanOrEqual(TERM_BLOCK_MAX_CHARS);
    expect(block.provenance.truncated).toBe(true);
  });

  it('builds a deterministic prompt block only from the approved RxCUI 6809 slice', async () => {
    const { onsidesEffectsForRxcui, onsidesHasLabelData } =
      await import('../../src/classifier/onsides.js');
    const rxcuis = ['435', '5487', '6809'];
    const a = buildAdeTermBlock(rxcuis, onsidesEffectsForRxcui, onsidesHasLabelData);
    const b = buildAdeTermBlock(rxcuis, onsidesEffectsForRxcui, onsidesHasLabelData);
    expect(a.appendix).toBe(b.appendix);
    expect(a.appendix).toContain('Lactic acidosis');
    expect(a.appendix).toContain('Dizziness');
    expect(a.appendix).not.toMatch(/Fournier|Bladder cancer|Amputation/);
    expect(a.provenance.blockHash).toBe(b.provenance.blockHash);
    expect(a.provenance.blockHash).toBe(
      '57ac4659695c69a2c873aa40a7411b6abc0da76a80bdb9a5dffc12b5530cca72',
    );
    expect(a.provenance.ptCount).toBe(30);
    expect(a.provenance.truncated).toBe(true);
    expect(a.provenance.coverage).toEqual([
      { rxcui: '435', hasLabelData: false, effectCount: 0 },
      { rxcui: '5487', hasLabelData: false, effectCount: 0 },
      { rxcui: '6809', hasLabelData: true, effectCount: 53 },
    ]);
  });
});

// ── #2 prompt seam ────────────────────────────────────────────────────────────────────────────
describe('#2 effectiveSystemPrompt + systemAppendix seam (item M)', () => {
  it('effectiveSystemPrompt() with no appendix returns the base SYSTEM_PROMPT exactly', () => {
    expect(effectiveSystemPrompt()).toBe(SYSTEM_PROMPT);
    expect(effectiveSystemPrompt('')).toBe(SYSTEM_PROMPT); // empty appendix is a no-op
    expect(effectiveSystemPrompt('   ')).toBe(SYSTEM_PROMPT); // whitespace-only is a no-op
  });

  it('effectiveSystemPrompt(appendix) = base + delimiter + appendix (augment, never fork)', () => {
    const block = 'Tremor, Nausea';
    const composed = effectiveSystemPrompt(block);
    expect(composed.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(composed.endsWith(block)).toBe(true);
    expect(composed).toBe(`${SYSTEM_PROMPT}\n\n${block}`);
  });

  it('arm B via systemAppendix reaches the core system param; arm A sends the base unchanged', async () => {
    messagesCreate.mockResolvedValue({
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          name: 'record_adherence',
          input: { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 2 },
    });

    // arm A — no appendix
    await classifyReplyText('took it', { apiKey: FAKE_KEY });
    const armASystem = (messagesCreate.mock.calls.at(-1)![0] as { system: string }).system;
    expect(armASystem).toBe(SYSTEM_PROMPT);

    // arm B — appendix threads through to the SDK call
    const BLOCK = 'Tremor, Nausea, Headache';
    await classifyReplyText('took it', { apiKey: FAKE_KEY, systemAppendix: BLOCK });
    const armBSystem = (messagesCreate.mock.calls.at(-1)![0] as { system: string }).system;
    expect(armBSystem).toBe(`${SYSTEM_PROMPT}\n\n${BLOCK}`);
    expect(armBSystem).not.toBe(armASystem);
  });
});

// ── #3 handler purity ─────────────────────────────────────────────────────────────────────────
describe('#3 the classifier handler NEVER sets systemAppendix (arm B cannot leak to production)', () => {
  it('handler.ts source contains no systemAppendix reference', () => {
    const source = readFileSync(join(__dirname, '../../src/classifier/handler.ts'), 'utf8');
    expect(source).not.toContain('systemAppendix');
  });
});

// ── #4 per-row delta ──────────────────────────────────────────────────────────────────────────
describe('#4 computeAblationDelta reads per-row reason labels (item A)', () => {
  it('accuracy IDENTICAL across arms but side_effect capture differs → the delta shows it', () => {
    // Two gold side_effect rows + one none row. Adherence prediction is IDENTICAL in both arms
    // (so overall accuracy is unchanged); only the reason_code differs.
    const g1 = goldRow('g001', { adherence_state: 'taken', reason_code: 'side_effect' });
    const g2 = goldRow('g002', { adherence_state: 'taken', reason_code: 'side_effect' });
    const g3 = goldRow('g003', { adherence_state: 'taken', reason_code: 'none' });
    const gold = [g1, g2, g3];

    // arm A misses both side_effect reasons (predicts 'none'); arm B captures both.
    const armA = [
      result(g1, { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' }),
      result(g2, { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' }),
      result(g3, { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' }),
    ];
    const armB = [
      result(g1, { adherence_state: 'taken', reason_code: 'side_effect', safety_flag: 'none' }),
      result(g2, { adherence_state: 'taken', reason_code: 'side_effect', safety_flag: 'none' }),
      result(g3, { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' }),
    ];

    const delta = computeAblationDelta(gold, armA, armB);
    // adherence_state is identical in both arms → this is NOT what the delta measures
    expect(delta.perReasonA['side_effect']!.completeness).toBe(0); // 0/2 captured
    expect(delta.perReasonB['side_effect']!.completeness).toBe(1); // 2/2 captured
    expect(delta.perReasonA['side_effect']!.goldSupport).toBe(2);
    expect(delta.reasonCompletenessA).toBe(0);
    expect(delta.reasonCompletenessB).toBe(1);
    expect(delta.reasonCompletenessDelta).toBe(1);
  });
});

// ── #5 no-regression guard ────────────────────────────────────────────────────────────────────
describe('#5 compareNoRegression reads side_effect precision from the delta (N1/N2/N3)', () => {
  it('FAILS ship-B on a side_effect-precision drop with accuracy/taken flat', () => {
    const A = mkMetrics({ accuracy: 0.9, lifeSafetyRecall: 1, takenPrecision: 0.9 });
    const B = mkMetrics({ accuracy: 0.9, lifeSafetyRecall: 1, takenPrecision: 0.9 });
    const delta = mkDelta({ precisionA: 0.9, precisionB: 0.6, completenessDelta: 0.1 });
    const nr = compareNoRegression(A, B, delta);
    expect(nr.pass).toBe(false);
    expect(nr.checks.sideEffectPrecision.ok).toBe(false);
    expect(nr.checks.accuracy.ok).toBe(true);
    expect(nr.checks.takenPrecision.ok).toBe(true);
  });

  it('a within-noise (< epsilon) negative non-safety delta does NOT fail ship-B', () => {
    const A = mkMetrics({ accuracy: 0.9, lifeSafetyRecall: 1, takenPrecision: 0.9 });
    const B = mkMetrics({
      accuracy: 0.9 - NO_REGRESSION_EPSILON / 2,
      lifeSafetyRecall: 1,
      takenPrecision: 0.9 - NO_REGRESSION_EPSILON / 2,
    });
    const delta = mkDelta({
      precisionA: 0.9,
      precisionB: 0.9 - NO_REGRESSION_EPSILON / 2,
      completenessDelta: 0.05,
    });
    const nr = compareNoRegression(A, B, delta);
    expect(nr.pass).toBe(true); // 1-row wobble is not a regression
  });

  it('a life-safety recall drop FAILS with NO tolerance (safety floor is absolute)', () => {
    const A = mkMetrics({ accuracy: 0.9, lifeSafetyRecall: 1, takenPrecision: 0.9 });
    const B = mkMetrics({
      accuracy: 0.9,
      lifeSafetyRecall: 1 - NO_REGRESSION_EPSILON / 2, // below A by less than epsilon
      takenPrecision: 0.9,
    });
    const delta = mkDelta({ precisionA: 0.9, precisionB: 0.9 });
    const nr = compareNoRegression(A, B, delta);
    expect(nr.pass).toBe(false);
    expect(nr.checks.lifeSafetyRecall.ok).toBe(false); // no epsilon on the safety floor
  });

  it('PASSES on a clean B ≥ A across every term', () => {
    const A = mkMetrics({ accuracy: 0.9, lifeSafetyRecall: 1, takenPrecision: 0.9 });
    const B = mkMetrics({ accuracy: 0.92, lifeSafetyRecall: 1, takenPrecision: 0.91 });
    const delta = mkDelta({ precisionA: 0.9, precisionB: 0.95, completenessDelta: 0.05 });
    const nr = compareNoRegression(A, B, delta);
    expect(nr.pass).toBe(true);
  });

  it('reads the REAL LiveMetrics accessors and guards a missing taken key', () => {
    const A = mkMetrics({ accuracy: 0.9, lifeSafetyRecall: 1 }); // no perClass.taken
    const B = mkMetrics({ accuracy: 0.9, lifeSafetyRecall: 1, takenPrecision: 0.9 });
    const delta = mkDelta({ precisionA: 0.9, precisionB: 0.9 });
    const nr = compareNoRegression(A, B, delta);
    expect(nr.checks.takenPrecision.a).toBe(0); // missing key guarded to 0
    expect(nr.pass).toBe(true);
  });

  it('a null side_effect precision on either arm is NOT a precision regression (the null-guard branch)', () => {
    const A = mkMetrics({ accuracy: 0.9, lifeSafetyRecall: 1, takenPrecision: 0.9 });
    const B = mkMetrics({ accuracy: 0.9, lifeSafetyRecall: 1, takenPrecision: 0.9 });

    // arm B never predicted side_effect (precisionB null) — precision measures the FP rate AMONG
    // predictions, so "no predictions" cannot be a precision regression; the guard returns ok=true.
    const bNull = compareNoRegression(A, B, mkDelta({ precisionA: 0.9, precisionB: null }));
    expect(bNull.checks.sideEffectPrecision.ok).toBe(true);
    expect(bNull.checks.sideEffectPrecision.b).toBeNull();
    expect(bNull.failures.some((f) => f.includes('side_effect'))).toBe(false);
    expect(bNull.pass).toBe(true);

    // symmetric: arm A never predicted side_effect (precisionA null) — even with a very low
    // (non-null) B precision, the null on A short-circuits to ok=true (no A baseline to regress from).
    const aNull = compareNoRegression(A, B, mkDelta({ precisionA: null, precisionB: 0.1 }));
    expect(aNull.checks.sideEffectPrecision.ok).toBe(true);
    expect(aNull.checks.sideEffectPrecision.a).toBeNull();
    expect(aNull.pass).toBe(true);
  });

  it('decideShipArmB: ship only when primary improves > epsilon AND no-reg holds AND gates pass', () => {
    const A = mkMetrics({ accuracy: 0.9, lifeSafetyRecall: 1, takenPrecision: 0.9 });
    const B = mkMetrics({ accuracy: 0.92, lifeSafetyRecall: 1, takenPrecision: 0.92 });
    const cleanDelta = mkDelta({ precisionA: 0.9, precisionB: 0.95, completenessDelta: 0.1 });
    const nr = compareNoRegression(A, B, cleanDelta);

    expect(decideShipArmB({ delta: cleanDelta, noRegression: nr, armBGatesPass: true }).ship).toBe(
      true,
    );
    // failing gates blocks ship even with a clean improvement
    expect(decideShipArmB({ delta: cleanDelta, noRegression: nr, armBGatesPass: false }).ship).toBe(
      false,
    );
    // a within-noise primary (not beyond epsilon) is "no effect", never a ship trigger
    const flatDelta = mkDelta({
      precisionA: 0.9,
      precisionB: 0.95,
      completenessDelta: NO_REGRESSION_EPSILON / 2,
    });
    expect(decideShipArmB({ delta: flatDelta, noRegression: nr, armBGatesPass: true }).ship).toBe(
      false,
    );
  });
});

// ── #6 trip / incomplete precedence ───────────────────────────────────────────────────────────
describe('#6 a tripped / errored arm never reaches the delta or the guard (item B)', () => {
  it('buildAblationReport on an incomplete run NEVER computes the delta/guard/ship (the REAL production guard)', () => {
    // Invokes the PRODUCTION guard (buildAblationReport's `status !== 'complete'` early return),
    // not JS array semantics: an arm with a genuine (non-cap) errored row is passed through with
    // status 'incomplete' and NO armA/armB metrics — computeAblationDelta / compareNoRegression /
    // decideShipArmB must all be skipped, exactly as the run-eval --ablation incomplete branch relies on.
    const g1 = goldRow('g001', { reason_code: 'side_effect' });
    const g2 = goldRow('g002', { reason_code: 'side_effect' });
    const gold = [g1, g2];
    const armA = [
      result(g1, { adherence_state: 'taken', reason_code: 'side_effect', safety_flag: 'none' }),
      result(g2, { adherence_state: 'taken', reason_code: 'side_effect', safety_flag: 'none' }),
    ];
    // arm B has a genuine model/API error row (name 'Error', NOT a SpendCapExceededError).
    const armB = [
      result(g1, { adherence_state: 'taken', reason_code: 'side_effect', safety_flag: 'none' }),
      result(g2, undefined, 'Error'),
    ];

    const report = buildAblationReport({
      status: 'incomplete',
      promptVersion: 'v1',
      blockProvenance: buildAdeTermBlock(['435'], stubEffectsFor, stubHasLabelData).provenance,
      gold,
      armA,
      armB,
      // NOTE: no armAMetrics / armBMetrics / armBGatesPass — an incomplete run must not require them.
      generatedAt: '1970-01-01T00:00:00.000Z',
    });

    expect(report.status).toBe('incomplete');
    expect(report.delta).toBeUndefined(); // computeAblationDelta NEVER invoked on a partial run
    expect(report.noRegression).toBeUndefined();
    expect(report.ship).toBeUndefined();
    // the genuine errored row is preserved distinctly (never conflated with a spend-cap error)
    expect(report.arms.B.errored).toEqual([{ id: 'g002', error: 'Error' }]);
  });

  it('buildAblationReport tags a spend-cap partial run and omits the delta', () => {
    const g1 = goldRow('g001', { reason_code: 'side_effect' });
    const partial = buildAblationReport({
      status: 'spendCap',
      promptVersion: 'v1',
      blockProvenance: buildAdeTermBlock(['435'], stubEffectsFor, stubHasLabelData).provenance,
      gold: [g1],
      armA: [result(g1, undefined, 'SpendCapExceededError')],
      armB: [],
      generatedAt: '1970-01-01T00:00:00.000Z',
    });
    expect(partial.status).toBe('spendCap');
    expect(partial.delta).toBeUndefined(); // no delta on a partial arm
    // cap-errored rows are labeled distinctly (their sanitized error name is preserved)
    expect(partial.arms.A.errored.some((e) => e.error === 'SpendCapExceededError')).toBe(true);
  });
});

// ── #7 side_effect precision + FP guard ───────────────────────────────────────────────────────
describe('#7 side_effect precision + FP count present; a completeness win with a precision drop is NOT shippable (item E)', () => {
  it('surfaces the FP count and blocks ship when B gains completeness but loses side_effect precision', () => {
    // arm B captures MORE side_effect reasons (completeness up) but also over-predicts side_effect
    // on a none row (a false positive → precision down).
    const g1 = goldRow('g001', { reason_code: 'side_effect' });
    const g2 = goldRow('g002', { reason_code: 'side_effect' });
    const g3 = goldRow('g003', { reason_code: 'none' }); // over-predicted by B
    const gold = [g1, g2, g3];

    const armA = [
      result(g1, { adherence_state: 'taken', reason_code: 'side_effect', safety_flag: 'none' }),
      result(g2, { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' }), // miss
      result(g3, { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' }),
    ];
    const armB = [
      result(g1, { adherence_state: 'taken', reason_code: 'side_effect', safety_flag: 'none' }),
      result(g2, { adherence_state: 'taken', reason_code: 'side_effect', safety_flag: 'none' }), // now caught
      result(g3, { adherence_state: 'taken', reason_code: 'side_effect', safety_flag: 'none' }), // FALSE positive
    ];

    const delta = computeAblationDelta(gold, armA, armB);
    // completeness went up (1/2 → 2/2)
    expect(delta.reasonCompletenessDelta).toBeGreaterThan(0);
    // side_effect precision: A = 1/1 = 1.0 ; B = 2/3 ≈ 0.667 with one FP
    expect(delta.sideEffect.precisionA).toBe(1);
    expect(delta.sideEffect.precisionB).toBeCloseTo(2 / 3, 5);
    expect(delta.sideEffect.falsePositivesB).toBe(1);
    expect(delta.sideEffect.falsePositiveIdsB).toEqual(['g003']);

    const A = mkMetrics({ accuracy: 0.9, lifeSafetyRecall: 1, takenPrecision: 0.9 });
    const B = mkMetrics({ accuracy: 0.9, lifeSafetyRecall: 1, takenPrecision: 0.9 });
    const nr = compareNoRegression(A, B, delta);
    const decision = decideShipArmB({ delta, noRegression: nr, armBGatesPass: true });
    expect(decision.ship).toBe(false); // completeness win does NOT excuse the precision drop
  });
});

// ── #8 DATA-01 ────────────────────────────────────────────────────────────────────────────────
describe('#8 the persisted ablation report is DATA-01 clean (id-keyed, no reply text)', () => {
  it('never serializes gold reply text; results are id-keyed', () => {
    const g1 = goldRow('g001', {
      reason_code: 'side_effect',
      text: 'SECRET_REPLY_TEXT_XYZ took half',
    });
    const g2 = goldRow('g002', { reason_code: 'none', text: 'ANOTHER_SECRET all good' });
    const gold = [g1, g2];
    const armA = [
      result(g1, { adherence_state: 'taken', reason_code: 'side_effect', safety_flag: 'none' }),
      result(g2, { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' }),
    ];
    const armB = [
      result(g1, { adherence_state: 'taken', reason_code: 'side_effect', safety_flag: 'none' }),
      result(g2, { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' }),
    ];
    const report = buildAblationReport({
      status: 'complete',
      promptVersion: 'v1',
      blockProvenance: buildAdeTermBlock(['435'], stubEffectsFor, stubHasLabelData).provenance,
      gold,
      armA,
      armB,
      armAMetrics: mkMetrics({ accuracy: 0.9, lifeSafetyRecall: 1, takenPrecision: 0.9 }),
      armBMetrics: mkMetrics({ accuracy: 0.9, lifeSafetyRecall: 1, takenPrecision: 0.9 }),
      armBGatesPass: true,
      generatedAt: '1970-01-01T00:00:00.000Z',
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('SECRET_REPLY_TEXT_XYZ');
    expect(serialized).not.toContain('ANOTHER_SECRET');
    expect(report.delta).toBeDefined();
    expect(report.status).toBe('complete');
    // id-keyed coverage present
    expect(report.arms.A.coverage.total).toBe(2);
  });
});
