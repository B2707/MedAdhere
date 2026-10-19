import { RESPONSE_WINDOW_MINUTES } from '@medadhere/shared';

/**
 * Wave-0 single source for how a resolved administration event projects into
 * `adherence_record` and the daily-summary adherence buckets. Wave 3 imports this
 * same table for the dashboard `event_code` mapping and the trend chart.
 *
 * The table (plan 08-LIVE-REPAIR W0.2):
 *   taken  + on-window -> 'taken'
 *   taken  + late      -> 'delayed'
 *   missed             -> 'skipped'   (status 'recorded', decided_by 'classifier')
 *   pending (adherence undefined) -> null: no adherence row, no summary adherence
 *     event — the "not yet" record is non-canonical (contracts.ts
 *     `canonical_administration_incomplete`), so the canonical projection gate
 *     skips it upstream; a null reaching a projection consumer is a contract
 *     violation and throws loudly.
 *   partial            -> loud throw (unreachable from the agent path — set_adherence
 *     allows only taken|missed; partial/stopped stays human-review).
 *   'unknown' stays timeout-owned: this mapping never emits it.
 */

/**
 * Carrier-transit margin added to the response window before a reply counts as
 * late (plan W4b.2c pulled into W0.4).
 */
export const ON_WINDOW_GRACE_MINUTES = 15;

const MS_PER_MINUTE = 60_000;

export type DerivedAdministrationTiming = 'on_time' | 'late';

/**
 * The single in-repo dose response window — the same constant that drives the
 * 2-hour timeout decider (`sent_at + RESPONSE_WINDOW_MINUTES`). Honors the same
 * environment override the outbound scheduler reads so the two can never drift.
 */
export function doseResponseWindowMinutes(): number {
  const raw = process.env.RESPONSE_WINDOW_MINUTES;
  if (raw === undefined || raw.trim() === '') return RESPONSE_WINDOW_MINUTES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('response_window_minutes_invalid');
  return parsed;
}

/**
 * W0.4 derivation — timing is derived, never asserted. 'late' when the patient's
 * own claim said late (the resolver's /late/ signal) OR the reply arrived after
 * scheduled_at + window + grace; otherwise 'on_time'. A claimed 'on_time' or
 * 'unknown' is ignored: the model/claims never assert on-time.
 */
export function deriveAdministrationTiming(input: {
  readonly claimedTiming: 'on_time' | 'late' | 'unknown' | undefined;
  readonly receivedAt: Date;
  readonly scheduledAt: Date;
}): DerivedAdministrationTiming {
  if (input.claimedTiming === 'late') return 'late';
  const boundaryMs =
    input.scheduledAt.getTime() +
    (doseResponseWindowMinutes() + ON_WINDOW_GRACE_MINUTES) * MS_PER_MINUTE;
  return input.receivedAt.getTime() <= boundaryMs ? 'on_time' : 'late';
}

export type AdherenceProjection = {
  readonly adherenceState: 'taken' | 'delayed' | 'skipped';
  readonly reasonCode: 'none';
  readonly safetyFlag: 'none';
  readonly decidedBy: 'classifier';
  readonly status: 'recorded';
};

/**
 * Maps a resolved administration outcome to its adherence-row projection.
 * Returns null for the explicit pending row (adherence undefined — "not yet");
 * pending records are non-canonical and skipped upstream by the canonical
 * projection gate, so consumers treat a null here as a contract violation.
 */
export function adherenceProjection(
  adherence: 'taken' | 'missed' | 'partial' | undefined,
  timing: DerivedAdministrationTiming,
): AdherenceProjection | null {
  if (adherence === undefined) return null;
  if (adherence === 'partial') throw new Error('clinical_projection_policy_unresolved');
  return {
    adherenceState: adherence === 'missed' ? 'skipped' : timing === 'late' ? 'delayed' : 'taken',
    reasonCode: 'none',
    safetyFlag: 'none',
    decidedBy: 'classifier',
    status: 'recorded',
  };
}
