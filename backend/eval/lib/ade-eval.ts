/**
 * ade-eval.ts — 04-06 component 4. Advisory ADE-matcher evaluation over the held-out
 * `ade-match-gold.csv`. Precision/recall + U-20 status-agreement are REPORTED (target
 * precision ≥ 0.8), never a CI gate. Deps are injected so the metric math is unit-tested
 * against synthetic drugs; the live run wires them to the real OnSIDES loader.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { matchAde, type AdeMatchStatus } from '../../src/classifier/ade-matcher.js';
import type { OnsidesEffect } from '../../src/classifier/onsides.js';

export const ADE_GOLD_PATH = fileURLToPath(new URL('../ade-match-gold.csv', import.meta.url));

export interface AdeGoldRow {
  readonly id: string;
  readonly text: string;
  readonly rxcui: string;
  readonly reason_code: string;
  readonly expected_status: AdeMatchStatus;
  readonly expected_pt: string;
  readonly clinician_symptom: string;
}

export interface AdeMatcherDeps {
  effectsFor(rxcui: string): readonly OnsidesEffect[];
  hasLabelData(rxcui: string): boolean;
}

export interface AdeEvalResult {
  readonly total: number;
  readonly matched: {
    readonly tp: number;
    readonly goldPositives: number;
    readonly matcherPositives: number;
    readonly recall: number;
    readonly precision: number | null;
  };
  readonly statusAgreement: { readonly correct: number; readonly total: number; readonly rate: number };
  readonly recallMisses: readonly string[];
  readonly falsePositives: readonly string[];
  readonly perRow: readonly {
    readonly id: string;
    readonly expected: AdeMatchStatus;
    readonly actual: AdeMatchStatus;
    readonly expectedPt: string;
    readonly gotExpectedPt: boolean;
  }[];
}

const COLUMNS = ['id', 'text', 'rxcui', 'reason_code', 'expected_status', 'expected_pt', 'clinician_symptom'] as const;
const VALID_STATUSES: readonly AdeMatchStatus[] = [
  'no_symptom', 'symptom_unmapped', 'no_drug_profile', 'no_label_data', 'checked_no_match', 'matched',
];

/** Minimal RFC-4180 parser: double-quoted fields, escaped quotes, embedded commas. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); if (row.some((f) => f !== '')) rows.push(row); }
  return rows;
}

export function parseAdeGold(csvText: string): AdeGoldRow[] {
  const raw = parseCsv(csvText);
  const [header, ...body] = raw;
  if (!header || header.join(',') !== COLUMNS.join(',')) {
    throw new Error(`ade-match-gold: unexpected header ${header?.join(',')}`);
  }
  const seen = new Set<string>();
  return body.map((cells, i) => {
    if (cells.length !== COLUMNS.length) {
      throw new Error(`ade-match-gold row ${i + 1}: expected ${COLUMNS.length} columns, got ${cells.length}`);
    }
    const row = Object.fromEntries(COLUMNS.map((c, j) => [c, cells[j] ?? ''])) as unknown as AdeGoldRow;
    if (!VALID_STATUSES.includes(row.expected_status)) {
      throw new Error(`ade-match-gold row ${row.id}: invalid expected_status "${row.expected_status}"`);
    }
    if (seen.has(row.id)) throw new Error(`ade-match-gold: duplicate id ${row.id}`);
    seen.add(row.id);
    return row;
  });
}

export function loadAdeGold(path: string = ADE_GOLD_PATH): AdeGoldRow[] {
  return parseAdeGold(readFileSync(path, 'utf8'));
}

/**
 * Precision = correct matcher-matches / all matcher-matches; recall = gold matches the
 * matcher caught with the right PT / all gold matches. A wrong-PT or off-target match is
 * a precision cost; a missed gold match is a recall cost. Status agreement scores the
 * whole U-20 ladder, not just the binary match.
 */
export function evaluateAdeMatcher(rows: readonly AdeGoldRow[], deps: AdeMatcherDeps): AdeEvalResult {
  let tp = 0;
  let goldPositives = 0;
  let matcherPositives = 0;
  let agree = 0;
  const recallMisses: string[] = [];
  const falsePositives: string[] = [];
  // Mutable accumulator element type (widened to the readonly result type on return) — a
  // `readonly` annotation here would forbid the .push below (Code review LOW-A).
  const perRow: {
    id: string;
    expected: AdeMatchStatus;
    actual: AdeMatchStatus;
    expectedPt: string;
    gotExpectedPt: boolean;
  }[] = [];

  for (const r of rows) {
    const rxcui = r.rxcui || '';
    const res = matchAde({
      text: r.text,
      reasonCode: r.reason_code,
      rxcui: rxcui || null,
      effects: rxcui ? deps.effectsFor(rxcui) : [],
      hasLabelData: rxcui ? deps.hasLabelData(rxcui) : false,
    });
    const isGoldMatch = r.expected_status === 'matched';
    const isMatcherMatch = res.status === 'matched';
    if (isGoldMatch) goldPositives++;
    if (isMatcherMatch) matcherPositives++;
    const gotExpectedPt =
      isMatcherMatch &&
      r.expected_pt !== '' &&
      res.candidates.some((c) => c.meddraPt.toLowerCase() === r.expected_pt.toLowerCase());
    if (isGoldMatch && gotExpectedPt) tp++;
    else if (isGoldMatch) recallMisses.push(r.id);
    if (!isGoldMatch && isMatcherMatch) falsePositives.push(r.id);
    if (res.status === r.expected_status) agree++;
    perRow.push({ id: r.id, expected: r.expected_status, actual: res.status, expectedPt: r.expected_pt, gotExpectedPt });
  }

  return {
    total: rows.length,
    matched: {
      tp,
      goldPositives,
      matcherPositives,
      recall: goldPositives === 0 ? 0 : tp / goldPositives,
      precision: matcherPositives === 0 ? null : tp / matcherPositives,
    },
    statusAgreement: { correct: agree, total: rows.length, rate: rows.length === 0 ? 0 : agree / rows.length },
    recallMisses,
    falsePositives,
    perRow,
  };
}
