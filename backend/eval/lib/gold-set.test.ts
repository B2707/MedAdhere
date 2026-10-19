/**
 * gold-set.test.ts — the gold-set loader IS an offline CI regression gate
 * (Plan 04-05, ai-regression-testing wiring): these tests run on every
 * push via the root vitest suite, so a corrupted/regressed gold set blocks CI.
 *
 * Floors (SC5, ULTRA LOW batch): ≥8 per adherence state; safety subset 40–50;
 * ≥10 adversarial. Label triples must parse through the SAME shared schema
 * the production classifier enforces (D-16 — no drifting label vocabulary).
 */
import { describe, expect, it } from 'vitest';
import {
  GOLD_SET_PATH,
  assertPerClassFloors,
  loadGoldSet,
  loadGoldSetFromString,
} from './gold-set.js';

describe('gold-set loader (real committed file)', () => {
  const rows = loadGoldSet();

  it('loads the signed gold set: 150–250 rows, unique gNNN ids', () => {
    expect(rows.length).toBeGreaterThanOrEqual(150);
    expect(rows.length).toBeLessThanOrEqual(250);
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^g\d{3}$/);
  });

  it('every label triple parses through the shared AdherenceClassification schema', () => {
    // loader throws on any invalid triple — reaching here with >0 rows proves it
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(['taken', 'delayed', 'skipped', 'stopped', 'question', 'unknown']).toContain(
        r.adherence_state,
      );
    }
  });

  it('meets the per-class floors: every adherence state ≥ 8 (no insufficient-support class in the shipped set)', () => {
    const floors = assertPerClassFloors(rows);
    expect(floors.insufficient).toEqual([]);
    for (const state of ['taken', 'delayed', 'skipped', 'stopped', 'question', 'unknown']) {
      expect(floors.support[state]).toBeGreaterThanOrEqual(8);
    }
  });

  it('safety subset is 40–50 rows (U-21) and adversarial ≥ 10', () => {
    const safety = rows.filter((r) =>
      ['safety_lexicon', 'safety_semantic', 'safety_negative_control'].includes(r.slice_hint),
    );
    expect(safety.length).toBeGreaterThanOrEqual(40);
    expect(safety.length).toBeLessThanOrEqual(50);
    expect(rows.filter((r) => r.slice_hint === 'adversarial').length).toBeGreaterThanOrEqual(10);
  });

  it('every safety_lexicon row carries at least one lexicon tag; semantic rows carry none', () => {
    for (const r of rows) {
      if (r.slice_hint === 'safety_lexicon') expect(r.lexicon_tags.length).toBeGreaterThan(0);
      if (r.slice_hint === 'safety_semantic') expect(r.lexicon_tags).toEqual([]);
    }
  });

  it('GOLD_SET_PATH points at the committed gold CSV (U-09: the ONE allowed csv)', () => {
    expect(GOLD_SET_PATH.endsWith('backend/eval/gold-set.csv')).toBe(true);
  });
});

describe('gold-set loader (validation failures)', () => {
  const header =
    'id,slice_hint,register,source,text,lexicon_tags,adherence_state,reason_code,safety_flag,label_confidence,adjudication_note,audit_ok,audit_note,rater2_adherence_state,rater2_reason_code,rater2_safety_flag';

  it('throws naming the row id on an out-of-menu label', () => {
    const bad = `${header}\ng001,adherence_core,standard,synthetic,took it,,TAKEN,none,none,agreed,,y,,,,\n`;
    expect(() => loadGoldSetFromString(bad)).toThrow(/g001/);
  });

  it('throws on a duplicate id', () => {
    const dupe = `${header}\ng001,adherence_core,standard,synthetic,took it,,taken,none,none,agreed,,y,,,,\ng001,adherence_core,standard,synthetic,skipped it,,skipped,none,none,agreed,,y,,,,\n`;
    expect(() => loadGoldSetFromString(dupe)).toThrow(/duplicate/i);
  });

  it('throws on a malformed column count', () => {
    const short = `${header}\ng001,adherence_core,standard\n`;
    expect(() => loadGoldSetFromString(short)).toThrow(/g001|column/i);
  });

  it('F7: rejects EOF inside an unterminated quoted field (RFC-4180 strictness)', () => {
    const unterminated = `${header}\ng001,adherence_core,standard,synthetic,took it,,taken,none,none,agreed,,y,,,,"none`;
    expect(() => loadGoldSetFromString(unterminated)).toThrow(/unterminated/i);
  });
});
