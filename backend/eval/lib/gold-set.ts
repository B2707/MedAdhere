/**
 * gold-set.ts — loader + validation for the signed W0.5 gold set (Plan 04-05).
 *
 * Every label triple is parsed through the SAME shared `.strict()` schema the
 * production classifier enforces (D-16) — the eval and the app cannot drift
 * apart on label vocabulary. The loader throws (never coerces) on any invalid
 * row: the gold set is a signed artifact, and a corrupted row must fail CI.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AdherenceClassification } from '@medadhere/shared';

export const GOLD_SET_PATH = fileURLToPath(new URL('../gold-set.csv', import.meta.url));

export const PER_CLASS_FLOOR = 8; // SC5 amendment (ULTRA LOW batch): below this → "insufficient support"

export const ADHERENCE_STATES = [
  'taken',
  'delayed',
  'skipped',
  'stopped',
  'question',
  'unknown',
] as const;

const SLICE_HINTS = [
  'adherence_core',
  'question',
  'safety_lexicon',
  'safety_semantic',
  'safety_negative_control',
  'ade_match',
  'adversarial',
] as const;

const REGISTERS = ['standard', 'genz', 'vernacular', 'older_adult', 'mixed'] as const;

const goldRowSchema = z.object({
  id: z.string().regex(/^g\d{3}$/),
  slice_hint: z.enum(SLICE_HINTS),
  register: z.enum(REGISTERS),
  source: z.string().min(1),
  text: z.string().min(1),
  lexicon_tags: z.array(z.string()),
  adherence_state: AdherenceClassification.shape.adherence_state,
  reason_code: AdherenceClassification.shape.reason_code,
  safety_flag: AdherenceClassification.shape.safety_flag,
  label_confidence: z.enum(['agreed', 'adjudicated']),
  adjudication_note: z.string(),
  audit_ok: z.string(),
  audit_note: z.string(),
  rater2_adherence_state: z.string(),
  rater2_reason_code: z.string(),
  rater2_safety_flag: z.string(),
});

export type GoldRow = z.infer<typeof goldRowSchema>;

const EXPECTED_COLUMNS = [
  'id',
  'slice_hint',
  'register',
  'source',
  'text',
  'lexicon_tags',
  'adherence_state',
  'reason_code',
  'safety_flag',
  'label_confidence',
  'adjudication_note',
  'audit_ok',
  'audit_note',
  'rater2_adherence_state',
  'rater2_reason_code',
  'rater2_safety_flag',
] as const;

/** Minimal strict RFC-4180 parser (quotes, escaped quotes, embedded commas/newlines). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  // F7 (review LOW): EOF inside a quoted field is malformed input, not data
  if (inQuotes) {
    throw new Error('gold set: unterminated quoted field at end of file');
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export function loadGoldSetFromString(csvText: string): GoldRow[] {
  const raw = parseCsv(csvText);
  if (raw.length < 2) throw new Error('gold set: empty or header-only CSV');
  const header = raw[0];
  if (header.join(',') !== EXPECTED_COLUMNS.join(',')) {
    throw new Error(`gold set: unexpected header — got ${header.join(',')}`);
  }
  const rows: GoldRow[] = [];
  const seenIds = new Set<string>();
  for (const cells of raw.slice(1)) {
    const rowId = cells[0] ?? '(missing id)';
    if (cells.length !== EXPECTED_COLUMNS.length) {
      throw new Error(
        `gold set row ${rowId}: expected ${EXPECTED_COLUMNS.length} columns, got ${cells.length}`,
      );
    }
    const record = Object.fromEntries(EXPECTED_COLUMNS.map((c, i) => [c, cells[i]]));
    const candidate = {
      ...record,
      lexicon_tags: record.lexicon_tags === '' ? [] : record.lexicon_tags.split('|'),
    };
    const parsed = goldRowSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `gold set row ${rowId}: invalid ${issue?.path.join('.')} — ${issue?.message}`,
      );
    }
    if (seenIds.has(parsed.data.id)) {
      throw new Error(`gold set: duplicate id ${parsed.data.id}`);
    }
    seenIds.add(parsed.data.id);
    // the label triple re-parses through the strict shared schema (D-16 gate parity)
    AdherenceClassification.parse({
      adherence_state: parsed.data.adherence_state,
      reason_code: parsed.data.reason_code,
      safety_flag: parsed.data.safety_flag,
    });
    rows.push(parsed.data);
  }
  return rows;
}

export function loadGoldSet(path: string = GOLD_SET_PATH): GoldRow[] {
  return loadGoldSetFromString(readFileSync(path, 'utf8'));
}

export interface FloorReport {
  readonly support: Record<string, number>;
  readonly insufficient: string[];
}

/** Per-adherence-state support vs the SC5 floor; below-floor states are named. */
export function assertPerClassFloors(rows: readonly GoldRow[]): FloorReport {
  const support: Record<string, number> = {};
  for (const state of ADHERENCE_STATES) support[state] = 0;
  for (const r of rows) support[r.adherence_state]++;
  const insufficient = ADHERENCE_STATES.filter((s) => support[s] < PER_CLASS_FLOOR).map(
    (s) => s as string,
  );
  return { support, insufficient };
}
