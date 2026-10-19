// check-eval-csv-guard.mjs — the U-09 real-reply isolation guard (Plan 04-05).
//
// Every tracked CSV must be explicitly allowlisted — only the synthetic
// evaluation gold sets qualify.
// A newly committed export or real-reply CSV would otherwise become
// un-deletable PIPEDA text in history. Runs in CI against `git ls-files`; the
// pure rule is unit-tested from
// backend/eval/lib/csv-guard.test.ts.
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_TRACKED_CSVS = [
  'backend/eval/ade-match-gold.csv',
  'backend/eval/gold-set.csv',
];
const ALLOWED = new Set(ALLOWED_TRACKED_CSVS);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** @param {string[]} paths @returns {string[]} offending paths */
export function findEvalCsvViolations(paths) {
  return paths.filter(
    (p) => p.toLowerCase().endsWith('.csv') && !ALLOWED.has(p),
  );
}

/** Enumerate tracked CSV paths without Git quoting or newline ambiguity. */
export function listTrackedCsvs(root = repoRoot) {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .filter((path) => path.toLowerCase().endsWith('.csv'));
}

const isDirectRun = process.argv[1]?.endsWith('check-eval-csv-guard.mjs');
if (isDirectRun) {
  const tracked = listTrackedCsvs();
  const violations = findEvalCsvViolations(tracked);
  if (violations.length > 0) {
    console.error(
      `U-09 repo CSV guard: only the ${ALLOWED.size} explicitly allowed CSVs may be tracked — violations:`,
    );
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log(
    `U-09 repo CSV guard: clean (${tracked.length} tracked CSVs, ${ALLOWED.size} allowed).`,
  );
}
