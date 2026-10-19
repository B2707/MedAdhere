/**
 * assemble.ts — live-metric assembly (review fix F1, review CRITICAL + review
 * HIGH, 2026-07-03: errored rows must never shrink a gate denominator).
 *
 * Fail-safe accounting: the safety denominators span ALL gold safety-positive
 * rows. An errored row contributes only what production's independent
 * prefilter detector would have contributed (it runs inbound-side regardless
 * of the model); an errored safety_semantic row is therefore a counted MISS.
 * Accuracy/per-class metrics are computed over classified rows only, with
 * coverage reported — and evaluateGates separately fails any run with
 * errored rows, so a shrunken accuracy sample can never pass silently.
 */
import type { GoldRow } from './gold-set.js';
import { accuracy, perClassPrecisionRecall, type ClassMetrics } from './metrics.js';
import type { EvalRowResult } from './runner.js';

/**
 * The EXACT set production routes to 911/988 emergency (handler.ts
 * sendSafetyAutoReply: only these get SAFETY_AUTO_REPLY_EMERGENCY;
 * 'medical_question' gets the SOFTER 811 nurse-line redirect). The GATED
 * life-safety recall credits a catch ONLY on one of these flags — a genuine
 * crisis/acute_physical the model mis-tiers as 'medical_question' is routed to
 * 811, NOT emergency, so it is a life-safety MISS, not a catch (CRITICAL 04-07).
 * A crisis↔acute_physical cross-tier still counts caught (both route to
 * emergency) — the set is deliberately the routing class, not the exact tier.
 */
const EMERGENCY_ROUTING_FLAGS: readonly string[] = ['crisis', 'acute_physical'];

export interface LiveMetrics {
  readonly coverage: { total: number; classified: number; errored: string[] };
  readonly accuracy: { point: number; successes: number; trials: number };
  readonly perClass: Record<string, ClassMetrics>;
  readonly ordSafety: {
    caught: number;
    denominator: number;
    recall: number;
    missIds: string[];
  };
  // Tiered safety (04-SAFETY-GATE-AMENDMENT 2026-07-03). lifeSafety = the GATED
  // tier (crisis + acute_physical, OR'd with the prefilter). medicalQuestion =
  // the REPORTED 811-routing tier (recall + precision, non-gating).
  readonly lifeSafety: {
    caught: number;
    denominator: number;
    recall: number;
    missIds: string[];
  };
  readonly medicalQuestion: {
    tp: number;
    denominator: number; // gold medical_question rows
    recall: number;
    predictedCount: number; // tp + fp (all rows the model flagged medical_question)
    precision: number | null; // null when never predicted
    missIds: string[];
  };
  readonly semanticSafety: { caught: number; denominator: number; recall: number };
  readonly reasonCompleteness: { matched: number; denominator: number };
}

export function assembleLiveMetrics(
  rows: readonly GoldRow[],
  results: readonly EvalRowResult[],
  prefilterHit: (text: string) => boolean,
): LiveMetrics {
  const resultById = new Map(results.map((r) => [r.id, r]));
  const classified = results.filter((r) => r.predicted);
  const errored = results.filter((r) => r.error).map((r) => r.id);

  const stateResults = classified.map((r) => ({
    gold: r.gold.adherence_state,
    predicted: r.predicted!.adherence_state,
  }));
  const successes = stateResults.filter((r) => r.gold === r.predicted).length;

  // OR'd safety recall — denominator: EVERY gold safety-positive row. This
  // pooled metric is REPORTED-ONLY (report.ts: ordSafetyRecall is deliberately
  // unused in gating, 04-SAFETY-GATE-AMENDMENT). `!== 'none'` is CORRECT here and
  // must NOT be narrowed to emergency-routing like the gated life-safety tier:
  // the denominator also spans gold `medical_question` rows, whose correct
  // production route is the 811 nurse line — a non-none flag IS the right catch
  // for those. Narrowing would wrongly score a correctly-811-routed medical
  // question as a miss (scope note, CRITICAL 04-07).
  const safetyPositive = rows.filter((r) => r.safety_flag !== 'none');
  const missIds: string[] = [];
  for (const row of safetyPositive) {
    const result = resultById.get(row.id);
    const modelCaught = result?.predicted ? result.predicted.safety_flag !== 'none' : false;
    if (!prefilterHit(row.text) && !modelCaught) missIds.push(row.id);
  }
  const ordCaught = safetyPositive.length - missIds.length;

  // Tiered safety (04-SAFETY-GATE-AMENDMENT). Life-safety tier (crisis +
  // acute_physical) is the HARD gate: OR'd with the prefilter. A model catch
  // requires an EMERGENCY-ROUTING predicted flag (crisis/acute_physical) — the
  // exact set handler.ts routes to 911/988. A crisis/acute_physical the model
  // mis-tiers as 'medical_question' is routed to the SOFTER 811 nurse line, so
  // it is a life-safety MISS, NOT a catch (CRITICAL 04-07 — was `!== 'none'`,
  // which scored an 811-routed false-assurance as caught). The prefilter credit
  // stays: the lexicon only tags crisis/acute_physical, so a hit IS emergency.
  const lifeSafetyPositive = rows.filter(
    (r) => r.safety_flag === 'crisis' || r.safety_flag === 'acute_physical',
  );
  const lifeMissIds: string[] = [];
  for (const row of lifeSafetyPositive) {
    const result = resultById.get(row.id);
    const modelCaught = result?.predicted
      ? EMERGENCY_ROUTING_FLAGS.includes(result.predicted.safety_flag)
      : false;
    if (!prefilterHit(row.text) && !modelCaught) lifeMissIds.push(row.id);
  }
  const lifeCaught = lifeSafetyPositive.length - lifeMissIds.length;

  // medical_question tier — REPORTED (recall + precision), never gated. Uses
  // exact-category match (predicted flag === 'medical_question'), the honest
  // per-category confusion; an errored row is a counted miss.
  const mqGold = rows.filter((r) => r.safety_flag === 'medical_question');
  const mqMissIds: string[] = [];
  let mqTp = 0;
  for (const row of mqGold) {
    const result = resultById.get(row.id);
    if (result?.predicted && result.predicted.safety_flag === 'medical_question') mqTp += 1;
    else mqMissIds.push(row.id);
  }
  const mqPredictedCount = classified.filter(
    (r) => r.predicted!.safety_flag === 'medical_question',
  ).length;

  // Model-only semantic recall — errored rows are misses (no prefilter credit
  // here). REPORTED-ONLY (report.ts: semanticSafetyRecall is unused in gating).
  // `!== 'none'` is intentional and NOT narrowed to emergency-routing: the
  // safety_semantic slice includes gold `medical_question` rows (811 routing),
  // for which any non-none flag is the correct catch (scope note, CRITICAL 04-07).
  const semanticPositive = rows.filter(
    (r) => r.slice_hint === 'safety_semantic' && r.safety_flag !== 'none',
  );
  const semanticCaught = semanticPositive.filter((row) => {
    const result = resultById.get(row.id);
    return result?.predicted ? result.predicted.safety_flag !== 'none' : false;
  }).length;

  // STUDY-08 reason completeness — errored gold-reason rows stay in the denominator.
  const reasonPositive = rows.filter((r) => r.reason_code !== 'none');
  const reasonMatched = reasonPositive.filter((row) => {
    const result = resultById.get(row.id);
    return result?.predicted ? result.predicted.reason_code === row.reason_code : false;
  }).length;

  return {
    coverage: { total: rows.length, classified: classified.length, errored },
    accuracy: {
      point: stateResults.length === 0 ? 0 : accuracy(stateResults),
      successes,
      trials: stateResults.length,
    },
    perClass: perClassPrecisionRecall(stateResults),
    ordSafety: {
      caught: ordCaught,
      denominator: safetyPositive.length,
      recall: safetyPositive.length === 0 ? 0 : ordCaught / safetyPositive.length,
      missIds,
    },
    lifeSafety: {
      caught: lifeCaught,
      denominator: lifeSafetyPositive.length,
      recall: lifeSafetyPositive.length === 0 ? 0 : lifeCaught / lifeSafetyPositive.length,
      missIds: lifeMissIds,
    },
    medicalQuestion: {
      tp: mqTp,
      denominator: mqGold.length,
      recall: mqGold.length === 0 ? 0 : mqTp / mqGold.length,
      predictedCount: mqPredictedCount,
      precision: mqPredictedCount === 0 ? null : mqTp / mqPredictedCount,
      missIds: mqMissIds,
    },
    semanticSafety: {
      caught: semanticCaught,
      denominator: semanticPositive.length,
      recall: semanticPositive.length === 0 ? 0 : semanticCaught / semanticPositive.length,
    },
    reasonCompleteness: { matched: reasonMatched, denominator: reasonPositive.length },
  };
}
