/**
 * runner.ts — the live-eval runner (Plan 04-05). Pure and injectable: the
 * classify function is a parameter (U-23 — production `classifyReplyText`
 * with the key injected through the seam in run-eval.ts; a stub in tests).
 *
 * U-24: calls are paced by p-limit — a naive Promise.all over ~200 rows
 * instant-429s Tier-1. DATA-01: the returned results are id-keyed label
 * records; raw reply text never appears in the results payload.
 */
import pLimit from 'p-limit';
import type { AdherenceClassificationT } from '@medadhere/shared';
import type { GoldRow } from './gold-set.js';

export const LIVE_EVAL_CONCURRENCY = 5;

export type ClassifyFn = (rawBody: string) => Promise<AdherenceClassificationT>;

export interface EvalRowResult {
  readonly id: string;
  readonly gold: AdherenceClassificationT;
  readonly predicted?: AdherenceClassificationT;
  readonly error?: string;
}

export interface LiveEvalOutput {
  readonly results: EvalRowResult[];
}

function sanitizeError(err: unknown): string {
  if (err instanceof Error) {
    const status = (err as Error & { status?: unknown }).status;
    return typeof status === 'number' ? `${err.name} (status ${status})` : err.name;
  }
  return 'UnknownError';
}

export async function runLiveEval(
  rows: readonly GoldRow[],
  classify: ClassifyFn,
): Promise<LiveEvalOutput> {
  const limit = pLimit(LIVE_EVAL_CONCURRENCY);
  const results = await Promise.all(
    rows.map((row) =>
      limit(async (): Promise<EvalRowResult> => {
        const gold = {
          adherence_state: row.adherence_state,
          reason_code: row.reason_code,
          safety_flag: row.safety_flag,
        };
        try {
          const predicted = await classify(row.text);
          return { id: row.id, gold, predicted };
        } catch (err) {
          // per-row isolation: one transient failure must not sink the run.
          // F5 (U-16 parity): persist name+status ONLY — a crash-class SDK
          // message can echo request content, and the results JSON is an
          // uploaded CI artifact (wider trust boundary than the Lambda DLQ).
          return { id: row.id, gold, error: sanitizeError(err) };
        }
      }),
    ),
  );
  return { results };
}
