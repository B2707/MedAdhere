// @medadhere/shared — dose-time + Twilio status-rank helpers (Phase 3).
//
// A PURE, build-less module (mirroring `adherence-schema.ts`): plain exported functions
// and consts, NO AWS imports, NO I/O, NO network. This isolates the two correctness-critical
// Phase-3 pieces into a fast, CI-testable unit:
//
//   1. PIPE-09 — DST-correct scheduling. EventBridge Scheduler OWNS daylight-saving
//      resolution: we pass it an OFFSET-LESS `at(YYYY-MM-DDThh:mm:ss)` expression together
//      with `ScheduleExpressionTimezone = patient.timezone`, and AWS computes the absolute
//      UTC fire instant (Pattern 2 / Pitfall 3). We NEVER hand-compute the UTC offset for the
//      scheduler. The luxon `computeScheduledAtUtc` below is for STORAGE/dashboard/tests ONLY
//      (`dose_schedule.scheduled_at`) — it is NEVER fed back into the `at(...)` expression.
//
//   2. SC7 — Twilio delivery-status monotonicity. Twilio does NOT guarantee callback
//      ordering (`delivered` can arrive before `sent`). The status-RANK map + the
//      forward-only transition guard ensure a late callback never rolls a status backward.
//
// luxon is used ONLY for the storage-instant computation + the horizon date arithmetic
// (both pure, no clock reads beyond the explicit inputs). The `at()` builder itself is pure
// string assembly with no luxon dependency.
import { DateTime } from 'luxon';

/** The Twilio `MessageStatus` lifecycle values the status callback can deliver (F37 + 'sending'). */
export type OutboundStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'undelivered'
  | 'failed';

/**
 * Monotonic rank for each outbound-message status (SC7). Strictly increasing through the
 * live transitions `queued(1) < sending(2) < sent(3) < delivered(4)`, with the three
 * TERMINAL states sharing rank 4 (`delivered === undelivered === failed`). The status
 * callback advances `outbound_message.status` only when the incoming rank is STRICTLY
 * greater than the stored rank, so an out-of-order callback can never roll a status
 * backward (Pitfall 1). The map is frozen so downstream importers cannot mutate it.
 */
export const STATUS_RANK: Readonly<Record<OutboundStatus, number>> = Object.freeze({
  queued: 1,
  sending: 2,
  sent: 3,
  delivered: 4,
  undelivered: 4,
  failed: 4,
});

/**
 * Statuses `outbound_message.status` can HOLD that Twilio never sends as a callback value:
 *   - `prepared`        — the agent reply is stored but not yet claimed for sending.
 *   - `sending_unknown` — the provider call completed ambiguously (accepted-but-ack-lost).
 */
export type StoredOnlyOutboundStatus = 'prepared' | 'sending_unknown';

/** Every value the `outbound_message.status` CHECK constraint allows. */
export type StoredOutboundStatus = OutboundStatus | StoredOnlyOutboundStatus;

/**
 * {@link STATUS_RANK} EXTENDED (never redefined) with the two stored-only statuses, so the
 * forward-only guard ranks a row by what is actually persisted (H-02).
 *
 * `sending_unknown` sits at the `sending` rank — BELOW `sent` and below the terminal states. The only
 * ambiguous send a callback can ever reach is one where Twilio ACCEPTED the message and we lost just
 * our own acknowledgement: the row carries a real `twilio_sid`, so any later
 * `sent`/`delivered`/`undelivered`/`failed` callback is strictly newer information and MUST advance it.
 * Before this entry existed, the SQL guard's `ELSE 4` catch-all gave `sending_unknown` the TERMINAL
 * rank, so every such callback was silently dropped and the row stranded forever.
 */
export const STORED_STATUS_RANK: Readonly<Record<StoredOutboundStatus, number>> = Object.freeze({
  prepared: 0,
  ...STATUS_RANK,
  sending_unknown: 2,
});

/** The rank shared by the three TERMINAL statuses (`delivered`/`undelivered`/`failed`). */
const TERMINAL_RANK = STORED_STATUS_RANK.delivered;

/**
 * The `CASE status … END` fragment the status-callback UPDATE ranks the STORED row with, GENERATED
 * from {@link STORED_STATUS_RANK} so the SQL can never drift from the map again — the hand-mirrored
 * copy is exactly what produced H-02. Every below-terminal status gets its own `WHEN` branch, so
 * `ELSE` then only ever catches the three genuine terminals.
 */
export const STORED_STATUS_RANK_SQL_CASE: string = [
  'CASE status',
  ...Object.entries(STORED_STATUS_RANK)
    .filter(([, rank]) => rank < TERMINAL_RANK)
    .map(([status, rank]) => `                    WHEN '${status}' THEN ${rank}`),
  `                    ELSE ${TERMINAL_RANK}`,
  '                  END',
].join('\n');

/**
 * The single EventBridge Scheduler group name every dose one-shot is created into (OPS-01/STUDY-05).
 * SSOT (WR-02): imported by the Enroll Lambda handler (CreateSchedule + the deactivation helper), the
 * infra Scheduler/Enroll CDK constructs (group creation + the scoped IAM ARNs), and the LOW-8 drain
 * script — so the group name can never drift across the three modules that must agree on it.
 */
export const SCHEDULE_GROUP_NAME = 'medadhere-prod';

/**
 * The single-source response-window length in MINUTES (M2 / PIPE-05). A non-response is scored a
 * `missed` outcome once `sent_at + RESPONSE_WINDOW_MINUTES` elapses with no reply. This numeric const
 * is the ONE source of truth: the Outbound Lambda anchors the timeout one-shot to it, the Timeout
 * Lambda + Classifier envs are synth-asserted to carry the same value, and the classifier handler's
 * `process.env.RESPONSE_WINDOW_MINUTES` default references it — so the window can never drift across
 * the Outbound/Timeout/Classifier fns (the SSM alternative was rejected as YAGNI). 120 min is the
 * ratified default; `LATE_ALLOWANCE_MINUTES` (classifier-only) stays separate.
 */
export const RESPONSE_WINDOW_MINUTES = 120;

/** Milliseconds in one minute — the timeout-instant arithmetic below (no magic number). */
const MS_PER_MINUTE = 60_000;

/**
 * Build the ABSOLUTE-UTC `at(YYYY-MM-DDThh:mm:ss)` schedule expression for the PIPE-05 per-dose
 * timeout one-shot (Option A). Unlike {@link buildScheduleExpression} — which is offset-less LOCAL
 * wall-clock paired with the patient timezone — this returns the UTC wall-clock of the ABSOLUTE
 * instant `sentAt + windowMinutes`, to be paired with `ScheduleExpressionTimezone: 'UTC'` at the call
 * site. Do NOT reuse `buildScheduleExpression` (wrong shape — it carries no offset and expects a
 * timezone param).
 *
 * The expression carries NO `Z` and NO numeric offset — the `at(...)` grammar is a bare
 * `yyyy-mm-ddThh:mm:ss`; the `'UTC'` timezone at the call site makes AWS resolve it to the intended
 * absolute instant. Sub-second precision on `sentAt` is dropped to whole seconds.
 *
 * L2 fail-loud guards (never silently create a schedule Scheduler rejects):
 *   - a non-finite `windowMinutes` (NaN / Infinity) throws;
 *   - an invalid `sentAt` Date throws;
 *   - a resulting fire instant that is NOT in the future (already elapsed) throws.
 */
export function buildTimeoutScheduleExpression(sentAt: Date, windowMinutes: number): string {
  if (!Number.isFinite(windowMinutes)) {
    throw new Error(
      `buildTimeoutScheduleExpression: windowMinutes must be finite (got ${windowMinutes})`,
    );
  }
  const sentMs = sentAt.getTime();
  if (!Number.isFinite(sentMs)) {
    throw new Error('buildTimeoutScheduleExpression: sentAt is not a valid Date');
  }
  const fireInstant = new Date(sentMs + windowMinutes * MS_PER_MINUTE);
  if (fireInstant.getTime() <= Date.now()) {
    // A fire time already in the past (a badly-delayed send, or a mis-computed window) must throw —
    // Scheduler rejects a past `at(...)`, and a silently-created one would either error at create or
    // fire immediately. Surface it so the caller records `timeout_schedule_failed` (Q3).
    throw new Error(
      `buildTimeoutScheduleExpression: fire instant ${fireInstant.toISOString()} is not in the future`,
    );
  }
  // The UTC wall-clock, whole seconds only (drop the '.mmmZ' suffix) — paired with tz 'UTC'.
  const utc = fireInstant.toISOString().slice(0, 19); // 'YYYY-MM-DDTHH:mm:ss'
  return `at(${utc})`;
}

/**
 * True iff transitioning from `current` to `next` is a strictly-forward move under
 * {@link STATUS_RANK}. STRICTLY greater (`>`), so a terminal status (rank 4) never
 * re-writes another terminal, and a late lower-ranked callback (e.g. a `sent` arriving
 * after `delivered`) is rejected. This is the in-memory mirror of the SQL rank guard the
 * status-callback handler uses (`WHERE … $rank > (CASE status … END)`).
 */
export function isForwardStatusTransition(
  current: OutboundStatus,
  next: OutboundStatus,
): boolean {
  return STATUS_RANK[next] > STATUS_RANK[current];
}

/**
 * {@link isForwardStatusTransition} over the STORED rank map — the in-memory mirror of
 * {@link STORED_STATUS_RANK_SQL_CASE}. `current` is whatever the row holds (including the stored-only
 * statuses); `next` is the incoming Twilio callback status.
 */
export function isForwardStoredStatusTransition(
  current: StoredOutboundStatus,
  next: OutboundStatus,
): boolean {
  return STORED_STATUS_RANK[next] > STORED_STATUS_RANK[current];
}

/** Inputs for the offset-less EventBridge Scheduler `at(...)` expression. */
export interface ScheduleExpressionInput {
  /** Local calendar date of the dose, `YYYY-MM-DD` (e.g. `'2026-08-15'`). */
  doseDate: string;
  /** Patient-local wall-clock dose time, `HH:mm` (e.g. `'09:00'`). */
  localDoseTime: string;
}

/**
 * Build the OFFSET-LESS `at(YYYY-MM-DDThh:mm:ss)` schedule expression for EventBridge
 * Scheduler (PIPE-09 / Pitfall 3). The expression carries NO `Z` and NO numeric offset —
 * AWS resolves the wall-clock time inside `ScheduleExpressionTimezone` (the patient
 * timezone, passed verbatim by the caller) and computes the absolute UTC fire instant,
 * automatically handling DST. Appending an offset here would double-apply the DST shift.
 *
 * `localDoseTime` is `HH:mm`; the seconds are pinned to `:00` to satisfy the
 * `at(yyyy-mm-ddThh:mm:ss)` grammar.
 */
export function buildScheduleExpression({
  doseDate,
  localDoseTime,
}: ScheduleExpressionInput): string {
  return `at(${doseDate}T${localDoseTime}:00)`;
}

/** Inputs for the luxon storage-instant computation. */
export interface ScheduledAtInput {
  /** Local calendar date of the dose, `YYYY-MM-DD`. */
  doseDate: string;
  /** Patient-local wall-clock dose time, `HH:mm`. */
  localDoseTime: string;
  /** IANA timezone of the patient (e.g. `'America/Toronto'`). */
  timezone: string;
}

/**
 * Compute the absolute UTC instant (`dose_schedule.scheduled_at`) for STORAGE / dashboard /
 * tests ONLY — via luxon `DateTime.fromISO(local, { zone }).toUTC()`. This is the DST-correct
 * resolution of the patient-local dose time, e.g. 09:00 America/Toronto is `13:00Z` on a
 * summer (EDT) date and `14:00Z` on a winter (EST) date.
 *
 * IMPORTANT: this value is NEVER fed back into {@link buildScheduleExpression} — the scheduler
 * receives the offset-less local expression + the timezone and owns DST resolution at fire
 * time. This function exists so the persisted `scheduled_at` and the PIPE-09 timestamp test
 * have a single authoritative computation.
 *
 * Throws if the inputs do not form a valid zoned datetime (fail-loud, not silent NaN).
 */
export function computeScheduledAtUtc({
  doseDate,
  localDoseTime,
  timezone,
}: ScheduledAtInput): string {
  const local = DateTime.fromISO(`${doseDate}T${localDoseTime}`, { zone: timezone });
  if (!local.isValid) {
    throw new Error(
      `Invalid dose datetime: ${doseDate}T${localDoseTime} in zone ${timezone} (${local.invalidReason ?? 'unknown'})`,
    );
  }
  const iso = local.toUTC().toISO();
  if (iso === null) {
    throw new Error(`Failed to compute UTC ISO for ${doseDate}T${localDoseTime} in ${timezone}`);
  }
  return iso;
}

/** A single scheduled-dose slot produced by the horizon generator. */
export interface DoseSlot {
  /** Local calendar date, `YYYY-MM-DD`. */
  doseDate: string;
  /** Patient-local wall-clock time, `HH:mm`. */
  localDoseTime: string;
}

/** Inputs for the configurable-horizon dose generator. */
export interface DoseScheduleInput {
  /** First local calendar date in the horizon, `YYYY-MM-DD`. */
  startDate: string;
  /** Number of consecutive local days to schedule (>= 1). SC4 uses 1; default cadence is small. */
  days: number;
  /** The patient-local wall-clock times for each day, `HH:mm` (one or more). */
  localTimes: readonly string[];
  /** IANA timezone of the patient — used for DST-safe calendar-date arithmetic. */
  timezone: string;
}

/**
 * Generate the `(dose_date, local_dose_time)` slots for a configurable horizon (resolved
 * default 2 — see the plan assumption). Produces `days × localTimes.length` slots in
 * chronological order (date ascending, then `localTimes` in the order supplied). The
 * calendar date advances by whole LOCAL days in `timezone` (via luxon `plus({ days })`), so
 * month/year boundaries and any DST day-length quirk are handled by luxon rather than naive
 * `Date` arithmetic. Pure: it reads no clock beyond the explicit `startDate`.
 */
export function generateDoseSchedule({
  startDate,
  days,
  localTimes,
  timezone,
}: DoseScheduleInput): DoseSlot[] {
  if (days < 1) throw new Error(`generateDoseSchedule: days must be >= 1 (got ${days})`);
  if (localTimes.length === 0) {
    throw new Error('generateDoseSchedule: localTimes must contain at least one time');
  }
  const start = DateTime.fromISO(startDate, { zone: timezone });
  if (!start.isValid) {
    throw new Error(
      `generateDoseSchedule: invalid startDate ${startDate} in zone ${timezone} (${start.invalidReason ?? 'unknown'})`,
    );
  }

  const slots: DoseSlot[] = [];
  for (let day = 0; day < days; day += 1) {
    const date = start.plus({ days: day });
    const doseDate = date.toISODate();
    if (doseDate === null) {
      throw new Error(`generateDoseSchedule: failed to format date for day offset ${day}`);
    }
    for (const localDoseTime of localTimes) {
      slots.push({ doseDate, localDoseTime });
    }
  }
  return slots;
}
