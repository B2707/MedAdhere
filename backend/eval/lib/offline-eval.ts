/**
 * offline-eval.ts — SC6's offline half (Plan 04-05): prefilter-only recall
 * over the tagged lexicon slice, computed with ZERO API calls by running the
 * real shared prefilter over the gold set. Deliberate false-positive controls
 * (gold safety=none rows the lexicon fires on, e.g. the figurative
 * want-to-die row) are accounted as precision cost — never recall misses.
 */
import { runSafetyPrefilter } from '@medadhere/shared';
import type { GoldRow } from './gold-set.js';
import { clopperPearsonInterval, formatMetric } from './metrics.js';

export interface PrefilterMiss {
  readonly id: string;
  readonly lexicon_tags: readonly string[];
}

export interface PrefilterFalsePositive {
  readonly id: string;
  readonly goldSafety: 'none';
  readonly matchedTags: readonly string[];
}

export interface PrefilterEvalResult {
  readonly lexiconSlice: {
    readonly recall: number;
    readonly denominator: number;
    readonly misses: PrefilterMiss[];
    readonly formatted: string;
  };
  readonly falsePositives: PrefilterFalsePositive[];
}

export function runPrefilterEval(rows: readonly GoldRow[]): PrefilterEvalResult {
  // Denominator: safety-POSITIVE rows in the tagged lexicon slice. Rows whose
  // gold safety is 'none' (figurative controls) are excluded here by design.
  const lexiconPositives = rows.filter(
    (r) => r.slice_hint === 'safety_lexicon' && r.safety_flag !== 'none',
  );
  const misses: PrefilterMiss[] = [];
  for (const row of lexiconPositives) {
    if (!runSafetyPrefilter(row.text).hit) {
      misses.push({ id: row.id, lexicon_tags: row.lexicon_tags });
    }
  }
  const hits = lexiconPositives.length - misses.length;
  const recall = lexiconPositives.length === 0 ? 0 : hits / lexiconPositives.length;

  const falsePositives: PrefilterFalsePositive[] = [];
  for (const row of rows) {
    if (row.safety_flag !== 'none') continue;
    const result = runSafetyPrefilter(row.text);
    if (result.hit) {
      falsePositives.push({ id: row.id, goldSafety: 'none', matchedTags: result.matchedTags });
    }
  }

  return {
    lexiconSlice: {
      recall,
      denominator: lexiconPositives.length,
      misses,
      formatted:
        lexiconPositives.length === 0
          ? 'n/a (empty slice)'
          : formatMetric(recall, clopperPearsonInterval(hits, lexiconPositives.length)),
    },
    falsePositives,
  };
}
