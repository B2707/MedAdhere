/**
 * csv-guard.test.ts — the U-09 real-reply isolation guard: the ONLY csvs
 * allowed under backend/eval/ in git are the SYNTHETIC gold sets
 * (gold-set.csv + ade-match-gold.csv). A committed real-reply CSV would be
 * un-deletable PIPEDA text in history (DATA-01 amendment). Both allowed files
 * are hand-authored fixtures, not patient text.
 * The pure rule is tested here; scripts/check-eval-csv-guard.mjs applies it
 * to `git ls-files` in CI.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRACKED_CSVS,
  findEvalCsvViolations,
  listTrackedCsvs,
} from '../../../scripts/check-eval-csv-guard.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('U-09 eval CSV guard rule', () => {
  it('allows the exact pinned set of legitimate tracked CSV fixtures', () => {
    expect(ALLOWED_TRACKED_CSVS).toHaveLength(2);
    expect(findEvalCsvViolations(ALLOWED_TRACKED_CSVS)).toEqual([]);
  });

  it('flags any other CSV under backend/eval/ (real-*.csv, subdirs, case variants)', () => {
    expect(findEvalCsvViolations(['backend/eval/real-replies.csv'])).toHaveLength(1);
    expect(findEvalCsvViolations(['backend/eval/subset/extra.CSV'])).toHaveLength(1);
    expect(findEvalCsvViolations(['backend/eval/gold-set-v2.csv'])).toHaveLength(1);
  });

  it('ignores non-CSV files but flags CSVs anywhere outside the exact allowlist', () => {
    expect(
      findEvalCsvViolations([
        'backend/eval/results/run-v1.json',
        'backend/eval/LABELING-GUIDE.md',
      ]),
    ).toEqual([]);
    expect(findEvalCsvViolations(['infra/data/whatever.csv'])).toEqual([
      'infra/data/whatever.csv',
    ]);
  });

  it('enumerates the whole repository when invoked from a subdirectory', () => {
    const output = execFileSync(
      process.execPath,
      [join(repoRoot, 'scripts/check-eval-csv-guard.mjs')],
      { cwd: join(repoRoot, 'infra'), encoding: 'utf8' },
    );

    expect(output).toContain('clean (2 tracked CSVs, 2 allowed)');
  });

  it('preserves unusual tracked CSV filenames without Git quoting or newline splitting', () => {
    const temporaryRepo = mkdtempSync(join(tmpdir(), 'medadhere-csv-guard-'));
    const unusualPath = 'unexpected\nname.csv';
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: temporaryRepo });
      writeFileSync(join(temporaryRepo, unusualPath), 'header\nvalue\n');
      execFileSync('git', ['add', '--', unusualPath], { cwd: temporaryRepo });

      expect(listTrackedCsvs(temporaryRepo)).toEqual([unusualPath]);
    } finally {
      rmSync(temporaryRepo, { recursive: true, force: true });
    }
  });
});
