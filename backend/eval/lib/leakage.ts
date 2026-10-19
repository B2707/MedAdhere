/**
 * leakage.ts — the automated exemplar-leakage gate (Plan 04-05).
 *
 * A gold row "leaks" when, after normalization (case-fold, strip punctuation,
 * collapse whitespace), it equals an exemplar, contains one, or is itself a
 * ≥80%-length fragment of one. The 80% guard exists because tiny gold texts
 * ("k", emoji-only rows) normalize to near-empty strings that would otherwise
 * false-positive as substrings of every exemplar.
 */

export interface LeakCandidate {
  readonly id: string;
  readonly text: string;
}

export interface Leak {
  readonly id: string;
  readonly exemplar: string;
}

const FRAGMENT_RATIO = 0.8;

function normalize(s: string): string {
  // F6 (review MEDIUM): punctuation becomes a SEPARATOR, not deletion —
  // "forgot-taking" must normalize to "forgot taking", matching the exemplar.
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function findLeaks(
  rows: readonly LeakCandidate[],
  exemplarTexts: readonly string[],
): Leak[] {
  const normalizedExemplars = exemplarTexts
    .map((e) => ({ raw: e, norm: normalize(e) }))
    .filter((e) => e.norm.length > 0);
  const leaks: Leak[] = [];
  for (const row of rows) {
    const ng = normalize(row.text);
    if (ng.length === 0) continue; // emoji-only / punctuation-only rows cannot leak
    for (const ex of normalizedExemplars) {
      const isLeak =
        ng === ex.norm ||
        ng.includes(ex.norm) ||
        (ex.norm.includes(ng) && ng.length >= FRAGMENT_RATIO * ex.norm.length);
      if (isLeak) {
        leaks.push({ id: row.id, exemplar: ex.raw });
        break;
      }
    }
  }
  return leaks;
}

/** Fails the eval run (throws, naming rows) when the gold set overlaps the few-shot registry. */
export function assertNoExemplarLeakage(
  rows: readonly LeakCandidate[],
  exemplarTexts: readonly string[],
): void {
  const leaks = findLeaks(rows, exemplarTexts);
  if (leaks.length > 0) {
    const detail = leaks.map((l) => `${l.id} ~ "${l.exemplar}"`).join('; ');
    throw new Error(`exemplar leakage: ${leaks.length} gold row(s) overlap few-shots — ${detail}`);
  }
}
