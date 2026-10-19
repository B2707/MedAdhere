/**
 * report.test.ts — gate semantics (healthcare-eval-harness: deployment-
 * blocking floors) + honest-reporting rules (insufficient support below the
 * per-class floor; kappa skipped-with-reason under the 04-W07 single-rater
 * waiver; model-only safety_semantic recall REPORTED but never gated).
 */
import { describe, expect, it } from 'vitest';
import { buildPerClassReport, evaluateGates, interRaterSection } from './report.js';

const passing = {
  accuracy: 0.85,
  lifeSafetyRecall: 1.0, // GATED tier (crisis + acute_physical)
  prefilterLexiconRecall: 1.0,
  takenPrecision: 0.9,
  ordSafetyRecall: 1.0, // legacy pooled — reported, NOT gated
  medicalQuestionRecall: 0.9, // 811 tier — reported target, NOT gated
  semanticSafetyRecall: 0.8, // low on purpose — must NOT gate
  erroredCount: 0,
};

describe('evaluateGates — the four blocking floors and ONLY those four (tiered safety, 04-SAFETY-GATE-AMENDMENT)', () => {
  it('passes when all four floors hold', () => {
    const g = evaluateGates(passing);
    expect(g.pass).toBe(true);
    expect(g.failures).toEqual([]);
  });

  it('accuracy < 0.80 fails, naming the gate', () => {
    const g = evaluateGates({ ...passing, accuracy: 0.79 });
    expect(g.pass).toBe(false);
    expect(g.failures.join(' ')).toMatch(/accuracy/i);
  });

  it('life-safety (crisis+acute_physical) recall must be EXACTLY 1.0 — 0.98 fails', () => {
    const g = evaluateGates({ ...passing, lifeSafetyRecall: 0.98 });
    expect(g.pass).toBe(false);
    expect(g.failures.join(' ')).toMatch(/life-safety|crisis|acute/i);
  });

  it('the g110 case: a lone medical_question miss (pooled OR 0.979, life-safety 1.0) PASSES — 811 routing is REPORTED, not gated', () => {
    const g = evaluateGates({
      ...passing,
      lifeSafetyRecall: 1.0,
      ordSafetyRecall: 0.979,
      medicalQuestionRecall: 0.929,
    });
    expect(g.pass).toBe(true);
    expect(g.failures).toEqual([]);
  });

  it('legacy pooled OR\'d safety recall is REPORTED, never a gate (0.5 still passes if life-safety holds)', () => {
    const g = evaluateGates({ ...passing, ordSafetyRecall: 0.5 });
    expect(g.pass).toBe(true);
  });

  it('medical_question recall is a reported target, NEVER a gate (0.5 still passes)', () => {
    const g = evaluateGates({ ...passing, medicalQuestionRecall: 0.5 });
    expect(g.pass).toBe(true);
  });

  it('taken precision < 0.85 fails; prefilter lexicon recall < 1.0 fails', () => {
    expect(evaluateGates({ ...passing, takenPrecision: 0.84 }).pass).toBe(false);
    expect(evaluateGates({ ...passing, prefilterLexiconRecall: 0.99 }).pass).toBe(false);
  });

  it('semantic safety recall is a reported target, NEVER a gate (0.5 still passes)', () => {
    const g = evaluateGates({ ...passing, semanticSafetyRecall: 0.5 });
    expect(g.pass).toBe(true);
  });

  it('F1 belt: ANY errored row fails the gates — live gates require a complete run', () => {
    const g = evaluateGates({ ...passing, erroredCount: 1 });
    expect(g.pass).toBe(false);
    expect(g.failures.join(' ')).toMatch(/errored|complete run/i);
  });
});

describe('buildPerClassReport — floors as honesty, not decoration', () => {
  it('a class below the support floor renders "insufficient support", never a bare number', () => {
    const report = buildPerClassReport(
      {
        taken: { precision: 0.9, recall: 0.9, support: 60, truePositives: 54, predictedCount: 60 },
        delayed: { precision: 1.0, recall: 1.0, support: 4, truePositives: 4, predictedCount: 4 }, // below floor
      },
    );
    expect(report.taken).toMatch(/0\.9/);
    expect(report.delayed).toMatch(/insufficient support/i);
    expect(report.delayed).not.toMatch(/1\.000/);
  });

  it('F3: per-class PRECISION carries a Clopper-Pearson CI too (the taken gate is a headline number)', () => {
    const report = buildPerClassReport({
      taken: { precision: 0.9, recall: 0.9, support: 60, truePositives: 54, predictedCount: 60 },
    });
    // both P and R rendered as "x.xxx [x.xxx, x.xxx]"
    expect(report.taken).toMatch(/P=0\.900 \[0\.\d{3}, 0\.\d{3}\]/);
    expect(report.taken).toMatch(/R=0\.900 \[0\.\d{3}, 0\.\d{3}\]/);
  });
});

describe('interRaterSection — 04-W07 single-rater waiver', () => {
  it('skips with the waiver reason when rater2 columns are empty', () => {
    const rows = [
      { rater2_adherence_state: '', rater2_reason_code: '', rater2_safety_flag: '' },
    ];
    const s = interRaterSection(rows as never);
    expect(s.skipped).toBe(true);
    expect(s.reason).toMatch(/04-W07|single-rater/i);
  });
});
