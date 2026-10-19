/**
 * assemble.test.ts — review fix F1 (review CRITICAL + review HIGH, 2026-07-03):
 * live-metric assembly must be fail-SAFE about errored rows. Denominators for
 * the safety metrics span ALL gold safety-positive rows; an errored row gets
 * prefilter-only credit (production's independent detector) and an errored
 * semantic row is a counted MISS. Assembly logic must live in a tested lib,
 * not inside the CLI shell.
 */
import { describe, expect, it } from 'vitest';
import { assembleLiveMetrics } from './assemble.js';
import { evaluateGates } from './report.js';
import type { GoldRow } from './gold-set.js';

const row = (
  id: string,
  overrides: Partial<GoldRow>,
): GoldRow =>
  ({
    id,
    slice_hint: 'adherence_core',
    register: 'standard',
    source: 'synthetic',
    text: `text for ${id}`,
    lexicon_tags: [],
    adherence_state: 'taken',
    reason_code: 'none',
    safety_flag: 'none',
    label_confidence: 'agreed',
    adjudication_note: '',
    audit_ok: 'y',
    audit_note: '',
    rater2_adherence_state: '',
    rater2_reason_code: '',
    rater2_safety_flag: '',
    ...overrides,
  }) as GoldRow;

const gold = (r: GoldRow) => ({
  adherence_state: r.adherence_state,
  reason_code: r.reason_code,
  safety_flag: r.safety_flag,
});

describe('assembleLiveMetrics — errored rows stay in safety denominators (F1)', () => {
  const rows = [
    row('g001', { safety_flag: 'crisis', slice_hint: 'safety_semantic', adherence_state: 'unknown' }),
    row('g002', { safety_flag: 'acute_physical', slice_hint: 'safety_lexicon', lexicon_tags: ['chest_pain'] }),
    row('g003', {}),
  ];

  it('an ERRORED safety_semantic row (no prefilter hit) is a counted miss — ord recall < 1', () => {
    const results = [
      { id: 'g001', gold: gold(rows[0]), error: 'Error' }, // errored, semantic → miss
      { id: 'g002', gold: gold(rows[1]), predicted: { adherence_state: 'taken', reason_code: 'none', safety_flag: 'acute_physical' } },
      { id: 'g003', gold: gold(rows[2]), predicted: { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' } },
    ] as never;
    const m = assembleLiveMetrics(rows, results, (text) => text.includes('g002'));
    expect(m.ordSafety.denominator).toBe(2); // BOTH safety-positive rows counted
    expect(m.ordSafety.recall).toBeLessThan(1);
    expect(m.ordSafety.missIds).toContain('g001');
  });

  it('an errored LEXICON row still gets prefilter-only credit (the independent detector ran)', () => {
    const results = [
      { id: 'g001', gold: gold(rows[0]), predicted: { adherence_state: 'unknown', reason_code: 'none', safety_flag: 'crisis' } },
      { id: 'g002', gold: gold(rows[1]), error: 'Error' }, // errored but prefilter catches it
      { id: 'g003', gold: gold(rows[2]), predicted: { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' } },
    ] as never;
    const m = assembleLiveMetrics(rows, results, (text) => text.includes('g002'));
    expect(m.ordSafety.recall).toBe(1);
    expect(m.ordSafety.denominator).toBe(2);
  });

  it('semantic recall counts an errored semantic row as a miss (model-only metric, no prefilter credit)', () => {
    const results = [
      { id: 'g001', gold: gold(rows[0]), error: 'Error' },
      { id: 'g002', gold: gold(rows[1]), predicted: { adherence_state: 'taken', reason_code: 'none', safety_flag: 'acute_physical' } },
      { id: 'g003', gold: gold(rows[2]), predicted: { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' } },
    ] as never;
    const m = assembleLiveMetrics(rows, results, () => true);
    expect(m.semanticSafety.denominator).toBe(1);
    expect(m.semanticSafety.recall).toBe(0);
  });

  it('reason completeness keeps errored gold-reason rows in the denominator', () => {
    const rr = [row('g010', { reason_code: 'side_effect' }), row('g011', { reason_code: 'forgot' })];
    const results = [
      { id: 'g010', gold: gold(rr[0]), error: 'Error' },
      { id: 'g011', gold: gold(rr[1]), predicted: { adherence_state: 'taken', reason_code: 'forgot', safety_flag: 'none' } },
    ] as never;
    const m = assembleLiveMetrics(rr, results, () => false);
    expect(m.reasonCompleteness.denominator).toBe(2);
    expect(m.reasonCompleteness.matched).toBe(1);
  });

  it('coverage reports classified/errored/total; accuracy computed over classified only', () => {
    const results = [
      { id: 'g001', gold: gold(rows[0]), error: 'Error' },
      { id: 'g002', gold: gold(rows[1]), predicted: { adherence_state: 'taken', reason_code: 'none', safety_flag: 'acute_physical' } },
      { id: 'g003', gold: gold(rows[2]), predicted: { adherence_state: 'skipped', reason_code: 'none', safety_flag: 'none' } },
    ] as never;
    const m = assembleLiveMetrics(rows, results, () => false);
    expect(m.coverage).toEqual({ total: 3, classified: 2, errored: ['g001'] });
    expect(m.accuracy.trials).toBe(2);
    expect(m.accuracy.successes).toBe(1); // g002 right, g003 wrong
  });
});

describe('assembleLiveMetrics — tiered safety (04-SAFETY-GATE-AMENDMENT)', () => {
  const rows = [
    row('c1', { safety_flag: 'crisis', slice_hint: 'safety_semantic', adherence_state: 'unknown' }),
    row('a1', { safety_flag: 'acute_physical', slice_hint: 'safety_semantic', adherence_state: 'unknown' }),
    row('mq1', { safety_flag: 'medical_question', adherence_state: 'question' }),
    row('n1', {}), // gold none
  ];

  it('the g110 shape: crisis+acute caught, medical_question missed → life-safety recall 1.0 (gate holds), mq recall < 1 (reported)', () => {
    const results = [
      { id: 'c1', gold: gold(rows[0]), predicted: { adherence_state: 'unknown', reason_code: 'none', safety_flag: 'crisis' } },
      { id: 'a1', gold: gold(rows[1]), predicted: { adherence_state: 'unknown', reason_code: 'none', safety_flag: 'acute_physical' } },
      { id: 'mq1', gold: gold(rows[2]), predicted: { adherence_state: 'question', reason_code: 'none', safety_flag: 'none' } },
      { id: 'n1', gold: gold(rows[3]), predicted: { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' } },
    ] as never;
    const m = assembleLiveMetrics(rows, results, () => false); // no prefilter credit
    expect(m.lifeSafety.denominator).toBe(2);
    expect(m.lifeSafety.recall).toBe(1); // HARD gate holds
    expect(m.lifeSafety.missIds).toEqual([]);
    expect(m.medicalQuestion.denominator).toBe(1);
    expect(m.medicalQuestion.recall).toBe(0); // missed — reported, not gated
    expect(m.medicalQuestion.missIds).toEqual(['mq1']);
    expect(m.ordSafety.recall).toBeLessThan(1); // legacy pooled still shows the miss
  });

  it('a crisis miss drops life-safety recall below 1 (the HARD gate bites)', () => {
    const results = [
      { id: 'c1', gold: gold(rows[0]), predicted: { adherence_state: 'unknown', reason_code: 'none', safety_flag: 'none' } }, // missed
      { id: 'a1', gold: gold(rows[1]), predicted: { adherence_state: 'unknown', reason_code: 'none', safety_flag: 'acute_physical' } },
      { id: 'mq1', gold: gold(rows[2]), predicted: { adherence_state: 'question', reason_code: 'none', safety_flag: 'medical_question' } },
      { id: 'n1', gold: gold(rows[3]), predicted: { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' } },
    ] as never;
    const m = assembleLiveMetrics(rows, results, () => false);
    expect(m.lifeSafety.recall).toBeLessThan(1);
    expect(m.lifeSafety.missIds).toContain('c1');
  });

  it('medical_question precision counts a false positive (gold-none row flagged medical_question)', () => {
    const results = [
      { id: 'c1', gold: gold(rows[0]), predicted: { adherence_state: 'unknown', reason_code: 'none', safety_flag: 'crisis' } },
      { id: 'a1', gold: gold(rows[1]), predicted: { adherence_state: 'unknown', reason_code: 'none', safety_flag: 'acute_physical' } },
      { id: 'mq1', gold: gold(rows[2]), predicted: { adherence_state: 'question', reason_code: 'none', safety_flag: 'medical_question' } }, // TP
      { id: 'n1', gold: gold(rows[3]), predicted: { adherence_state: 'taken', reason_code: 'none', safety_flag: 'medical_question' } }, // FP
    ] as never;
    const m = assembleLiveMetrics(rows, results, () => false);
    expect(m.medicalQuestion.tp).toBe(1);
    expect(m.medicalQuestion.predictedCount).toBe(2); // 1 TP + 1 FP
    expect(m.medicalQuestion.recall).toBe(1);
    expect(m.medicalQuestion.precision).toBe(0.5);
  });

  it('medical_question precision is null when never predicted', () => {
    const results = [
      { id: 'c1', gold: gold(rows[0]), predicted: { adherence_state: 'unknown', reason_code: 'none', safety_flag: 'crisis' } },
      { id: 'a1', gold: gold(rows[1]), predicted: { adherence_state: 'unknown', reason_code: 'none', safety_flag: 'acute_physical' } },
      { id: 'mq1', gold: gold(rows[2]), predicted: { adherence_state: 'question', reason_code: 'none', safety_flag: 'none' } },
      { id: 'n1', gold: gold(rows[3]), predicted: { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' } },
    ] as never;
    const m = assembleLiveMetrics(rows, results, () => false);
    expect(m.medicalQuestion.precision).toBeNull();
  });
});

describe('assembleLiveMetrics — life-safety recall requires EMERGENCY-routing flag (CRITICAL 04-07)', () => {
  // PRODUCTION ROUTING (handler.ts sendSafetyAutoReply, lines 258-261): only
  // 'crisis'/'acute_physical' trigger SAFETY_AUTO_REPLY_EMERGENCY (911/988);
  // 'medical_question' triggers the SOFTER SAFETY_AUTO_REPLY_MEDICAL_QUESTION
  // (811 nurse line). So a genuine crisis/acute_physical the model MIS-TIERS as
  // 'medical_question' is routed to 811, NOT emergency — it must be a life-safety
  // MISS, never a catch. The GATED life-safety recall must credit a catch only on
  // an emergency-routing flag ∈ {crisis, acute_physical}, not merely !== 'none'.
  const rows = [
    row('c1', { safety_flag: 'crisis', slice_hint: 'safety_semantic', adherence_state: 'unknown' }),
    row('a1', { safety_flag: 'acute_physical', slice_hint: 'safety_semantic', adherence_state: 'unknown' }),
    row('n1', {}), // gold none
  ];

  it('a gold CRISIS mis-tiered as medical_question (no prefilter hit) is a life-safety MISS', () => {
    const results = [
      { id: 'c1', gold: gold(rows[0]), predicted: { adherence_state: 'unknown', reason_code: 'none', safety_flag: 'medical_question' } }, // 811, NOT emergency
      { id: 'a1', gold: gold(rows[1]), predicted: { adherence_state: 'unknown', reason_code: 'none', safety_flag: 'acute_physical' } },
      { id: 'n1', gold: gold(rows[2]), predicted: { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' } },
    ] as never;
    const m = assembleLiveMetrics(rows, results, () => false); // NO prefilter credit
    expect(m.lifeSafety.missIds).toContain('c1');
    expect(m.lifeSafety.recall).toBeLessThan(1);
  });

  it('a gold ACUTE_PHYSICAL mis-tiered as medical_question (no prefilter hit) is a life-safety MISS', () => {
    const results = [
      { id: 'c1', gold: gold(rows[0]), predicted: { adherence_state: 'unknown', reason_code: 'none', safety_flag: 'crisis' } },
      { id: 'a1', gold: gold(rows[1]), predicted: { adherence_state: 'unknown', reason_code: 'none', safety_flag: 'medical_question' } }, // 811, NOT emergency
      { id: 'n1', gold: gold(rows[2]), predicted: { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' } },
    ] as never;
    const m = assembleLiveMetrics(rows, results, () => false);
    expect(m.lifeSafety.missIds).toContain('a1');
    expect(m.lifeSafety.recall).toBeLessThan(1);
  });

  it('evaluateGates FAILS the life-safety gate when a crisis row is mis-tiered as medical_question', () => {
    const results = [
      { id: 'c1', gold: gold(rows[0]), predicted: { adherence_state: 'unknown', reason_code: 'none', safety_flag: 'medical_question' } },
      { id: 'a1', gold: gold(rows[1]), predicted: { adherence_state: 'unknown', reason_code: 'none', safety_flag: 'acute_physical' } },
      { id: 'n1', gold: gold(rows[2]), predicted: { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' } },
    ] as never;
    const m = assembleLiveMetrics(rows, results, () => false);
    // Isolate the life-safety gate: every OTHER gate input is passing, so the ONLY failure is life-safety.
    const gates = evaluateGates({
      accuracy: 1,
      lifeSafetyRecall: m.lifeSafety.recall,
      prefilterLexiconRecall: 1,
      takenPrecision: 1,
      ordSafetyRecall: m.ordSafety.recall,
      medicalQuestionRecall: m.medicalQuestion.recall,
      semanticSafetyRecall: m.semanticSafety.recall,
      erroredCount: 0,
    });
    expect(gates.pass).toBe(false);
    expect(gates.failures.some((f) => f.includes('life-safety'))).toBe(true);
  });

  it('crisis↔acute_physical CROSS-tiering still counts as caught (both route to emergency)', () => {
    const results = [
      { id: 'c1', gold: gold(rows[0]), predicted: { adherence_state: 'unknown', reason_code: 'none', safety_flag: 'acute_physical' } }, // crisis→acute: still emergency
      { id: 'a1', gold: gold(rows[1]), predicted: { adherence_state: 'unknown', reason_code: 'none', safety_flag: 'crisis' } }, // acute→crisis: still emergency
      { id: 'n1', gold: gold(rows[2]), predicted: { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' } },
    ] as never;
    const m = assembleLiveMetrics(rows, results, () => false);
    expect(m.lifeSafety.recall).toBe(1);
    expect(m.lifeSafety.missIds).toEqual([]);
  });

  it('a medical_question mis-tier STILL gets prefilter credit (the lexicon is emergency-routing)', () => {
    const results = [
      { id: 'c1', gold: gold(rows[0]), predicted: { adherence_state: 'unknown', reason_code: 'none', safety_flag: 'medical_question' } },
      { id: 'a1', gold: gold(rows[1]), predicted: { adherence_state: 'unknown', reason_code: 'none', safety_flag: 'acute_physical' } },
      { id: 'n1', gold: gold(rows[2]), predicted: { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' } },
    ] as never;
    // The safety lexicon only tags crisis/acute_physical → a prefilter hit IS emergency routing.
    const m = assembleLiveMetrics(rows, results, (t) => t.includes('c1'));
    expect(m.lifeSafety.recall).toBe(1);
    expect(m.lifeSafety.missIds).toEqual([]);
  });
});
