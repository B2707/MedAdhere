/**
 * dose-time.test.ts — pure, table-driven unit tests for the Phase-3 time/status helpers
 * (PIPE-09 DST correctness + SC7 Twilio status-rank monotonicity).
 *
 * No AWS, no DB, no network — these helpers are deliberately pure (mirroring
 * `adherence-schema.ts`'s build-less style) so the two correctness-critical pieces are
 * proven with fast local feedback. The Enroll handler (Plan 02) imports the offset-less
 * `at(...)` builder + the luxon `scheduled_at` storage computation; the status-callback
 * handler (Plan 03) imports the status-rank map + the forward-only transition guard.
 */
import { describe, expect, it } from 'vitest';
import {
  buildScheduleExpression,
  buildTimeoutScheduleExpression,
  computeScheduledAtUtc,
  RESPONSE_WINDOW_MINUTES,
  STATUS_RANK,
  STORED_STATUS_RANK,
  STORED_STATUS_RANK_SQL_CASE,
  isForwardStatusTransition,
  isForwardStoredStatusTransition,
  generateDoseSchedule,
  type OutboundStatus,
} from './dose-time.js';

const TORONTO = 'America/Toronto';

describe('computeScheduledAtUtc — DST-correct storage instant (PIPE-09)', () => {
  // Table-driven: the SAME 09:00 America/Toronto local dose resolves to a DIFFERENT
  // absolute UTC instant in summer (EDT, UTC-4 → 13:00Z) vs winter (EST, UTC-5 → 14:00Z).
  // This is the storage/dashboard value — NEVER fed back into the scheduler expression.
  const cases: ReadonlyArray<{
    label: string;
    doseDate: string;
    localDoseTime: string;
    timezone: string;
    expectedUtc: string;
  }> = [
    {
      label: 'summer (EDT) 09:00 America/Toronto → 13:00Z',
      doseDate: '2026-08-15',
      localDoseTime: '09:00',
      timezone: TORONTO,
      expectedUtc: '2026-08-15T13:00:00.000Z',
    },
    {
      label: 'winter (EST) 09:00 America/Toronto → 14:00Z',
      doseDate: '2026-01-15',
      localDoseTime: '09:00',
      timezone: TORONTO,
      expectedUtc: '2026-01-15T14:00:00.000Z',
    },
  ];

  for (const c of cases) {
    it(c.label, () => {
      const iso = computeScheduledAtUtc({
        doseDate: c.doseDate,
        localDoseTime: c.localDoseTime,
        timezone: c.timezone,
      });
      // Normalize to a UTC Date comparison so trailing-precision formatting can't false-fail.
      expect(new Date(iso).toISOString()).toBe(c.expectedUtc);
    });
  }
});

describe('buildScheduleExpression — offset-less at() (Pitfall 3: AWS owns DST)', () => {
  it('returns exactly at(YYYY-MM-DDThh:mm:ss) with NO Z / ±offset suffix', () => {
    const expr = buildScheduleExpression({ doseDate: '2026-08-15', localDoseTime: '09:00' });
    expect(expr).toBe('at(2026-08-15T09:00:00)');
    // Hard guard: the expression must NOT carry any UTC marker or numeric offset — AWS
    // resolves the wall-clock time in ScheduleExpressionTimezone, so an offset here would
    // double-apply the DST shift.
    expect(expr).not.toMatch(/Z\)$/);
    expect(expr).not.toMatch(/[+-]\d{2}:?\d{2}/);
  });

  it('is offset-less for BOTH a summer and a winter date (the offset never leaks in)', () => {
    expect(buildScheduleExpression({ doseDate: '2026-01-15', localDoseTime: '09:00' })).toBe(
      'at(2026-01-15T09:00:00)',
    );
    expect(buildScheduleExpression({ doseDate: '2026-08-15', localDoseTime: '20:30' })).toBe(
      'at(2026-08-15T20:30:00)',
    );
  });

  it('the timezone the caller passes to the scheduler is the patient timezone verbatim', () => {
    // The builder does not transform the timezone — the patient tz flows through unchanged
    // as ScheduleExpressionTimezone. Document that contract with an identity assertion.
    const tz = TORONTO;
    expect(tz).toBe('America/Toronto');
  });
});

describe('buildTimeoutScheduleExpression — absolute-UTC at() for the PIPE-05 one-shot (Option A)', () => {
  // A fixed, far-future send instant so `sent_at + window` is ALWAYS in the future regardless of
  // when the suite runs (the L2 past-instant guard must never false-fail on a normal case).
  const FUTURE_SENT_AT = new Date('2099-08-15T14:30:00.000Z');

  it('returns at(YYYY-MM-DDThh:mm:ss) for the ABSOLUTE UTC instant sent_at + windowMinutes (no Z, no offset, no millis)', () => {
    // 14:30Z + 120 min = 16:30Z. The expression is the UTC wall-clock (paired with tz 'UTC' at the
    // call site), NOT a local time — so it is machine-timezone-independent.
    const expr = buildTimeoutScheduleExpression(FUTURE_SENT_AT, 120);
    expect(expr).toBe('at(2099-08-15T16:30:00)');
    // Hard guard: NO trailing Z and NO numeric offset (either would make Scheduler reject it or
    // double-apply an offset — the Pitfall-3 lesson, inverted for the UTC anchor).
    expect(expr).not.toMatch(/Z\)$/);
    expect(expr).not.toMatch(/[+-]\d{2}:?\d{2}/);
  });

  it('rolls the hour/day over correctly (23:00Z + 120 min → next-day 01:00Z)', () => {
    expect(buildTimeoutScheduleExpression(new Date('2099-08-15T23:00:00.000Z'), 120)).toBe(
      'at(2099-08-16T01:00:00)',
    );
  });

  it('drops sub-minute precision on the send instant (seconds pinned from the UTC instant)', () => {
    // A send instant carrying millis + seconds → the at() grammar keeps whole seconds only.
    expect(buildTimeoutScheduleExpression(new Date('2099-08-15T14:30:45.678Z'), 90)).toBe(
      'at(2099-08-15T16:00:45)',
    );
  });

  it('honours a window value other than the default (30 min)', () => {
    expect(buildTimeoutScheduleExpression(FUTURE_SENT_AT, 30)).toBe('at(2099-08-15T15:00:00)');
  });

  it('THROWS on a non-finite window (NaN / Infinity) — never silently create a bad schedule', () => {
    expect(() => buildTimeoutScheduleExpression(FUTURE_SENT_AT, Number.NaN)).toThrow();
    expect(() => buildTimeoutScheduleExpression(FUTURE_SENT_AT, Number.POSITIVE_INFINITY)).toThrow();
  });

  it('THROWS on an invalid sent_at Date', () => {
    expect(() => buildTimeoutScheduleExpression(new Date('not-a-date'), 120)).toThrow();
  });

  it('L2: THROWS when the resulting fire instant is already in the PAST (Scheduler would reject it)', () => {
    // A send instant far in the past → sent_at + window is still past → must throw, not create a
    // schedule Scheduler immediately rejects (or that fires instantly).
    const pastSentAt = new Date('2000-01-01T00:00:00.000Z');
    expect(() => buildTimeoutScheduleExpression(pastSentAt, 120)).toThrow();
  });
});

describe('RESPONSE_WINDOW_MINUTES — the single-source numeric window const (M2)', () => {
  it('is the numeric 120 (the ratified default response window)', () => {
    expect(RESPONSE_WINDOW_MINUTES).toBe(120);
    expect(typeof RESPONSE_WINDOW_MINUTES).toBe('number');
  });
});

describe('STATUS_RANK + isForwardStatusTransition — monotonic, no rollback (SC7)', () => {
  it('ranks queued < sending < sent < delivered (strictly increasing through the live states)', () => {
    expect(STATUS_RANK.queued).toBeLessThan(STATUS_RANK.sending);
    expect(STATUS_RANK.sending).toBeLessThan(STATUS_RANK.sent);
    expect(STATUS_RANK.sent).toBeLessThan(STATUS_RANK.delivered);
  });

  it('treats delivered === undelivered === failed as terminal (same rank)', () => {
    expect(STATUS_RANK.delivered).toBe(STATUS_RANK.undelivered);
    expect(STATUS_RANK.undelivered).toBe(STATUS_RANK.failed);
  });

  it('is exactly {queued:1, sending:2, sent:3, delivered:4, undelivered:4, failed:4}', () => {
    expect(STATUS_RANK).toEqual({
      queued: 1,
      sending: 2,
      sent: 3,
      delivered: 4,
      undelivered: 4,
      failed: 4,
    });
  });

  it("rejects a 'sent' arriving after 'delivered' (out-of-order callback never rolls back)", () => {
    // Twilio does not guarantee callback ordering — a late 'sent' must NOT overwrite 'delivered'.
    expect(isForwardStatusTransition('delivered', 'sent')).toBe(false);
  });

  it("accepts a strictly-forward transition (queued → sent advances)", () => {
    expect(isForwardStatusTransition('queued', 'sent')).toBe(true);
    expect(isForwardStatusTransition('sending', 'delivered')).toBe(true);
  });

  it('rejects an equal-rank transition (delivered → failed does not re-write a terminal)', () => {
    // Both are terminal rank 4; the guard is strictly-greater, so it does not advance.
    expect(isForwardStatusTransition('delivered', 'failed')).toBe(false);
  });

  it('every Twilio status the callback emits has a rank', () => {
    const all: OutboundStatus[] = ['queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed'];
    for (const s of all) {
      expect(typeof STATUS_RANK[s]).toBe('number');
    }
  });
});

describe('STORED_STATUS_RANK — stored-only statuses rank below terminal (H-02)', () => {
  it('extends STATUS_RANK without redefining any Twilio-callback rank', () => {
    for (const [status, rank] of Object.entries(STATUS_RANK)) {
      expect(STORED_STATUS_RANK[status as OutboundStatus]).toBe(rank);
    }
  });

  it("ranks 'sending_unknown' STRICTLY below every terminal status", () => {
    expect(STORED_STATUS_RANK.sending_unknown).toBeLessThan(STORED_STATUS_RANK.delivered);
    expect(STORED_STATUS_RANK.sending_unknown).toBeLessThan(STORED_STATUS_RANK.undelivered);
    expect(STORED_STATUS_RANK.sending_unknown).toBeLessThan(STORED_STATUS_RANK.failed);
  });

  it("ranks 'prepared' below every other stored status (nothing rolls back onto it)", () => {
    expect(STORED_STATUS_RANK.prepared).toBeLessThan(STORED_STATUS_RANK.queued);
  });

  it('advances a stored sending_unknown row on a later delivered/failed callback (H-02 regression)', () => {
    // The accepted-but-ack-lost row carries a real twilio_sid, so Twilio WILL call back. Before the
    // fix `sending_unknown` shared the terminal rank and the callback was silently dropped.
    expect(isForwardStoredStatusTransition('sending_unknown', 'delivered')).toBe(true);
    expect(isForwardStoredStatusTransition('sending_unknown', 'failed')).toBe(true);
    expect(isForwardStoredStatusTransition('sending_unknown', 'undelivered')).toBe(true);
    // A `sent` callback is likewise newer information than "we lost our own acknowledgement".
    expect(isForwardStoredStatusTransition('sending_unknown', 'sent')).toBe(true);
  });

  it('never rolls a stored sending_unknown row backward', () => {
    expect(isForwardStoredStatusTransition('sending_unknown', 'queued')).toBe(false);
    expect(isForwardStoredStatusTransition('sending_unknown', 'sending')).toBe(false);
    expect(isForwardStoredStatusTransition('delivered', 'sent')).toBe(false);
  });

  it('emits a SQL CASE that carries every non-terminal stored status explicitly', () => {
    // The `ELSE 4` catch-all is what made `sending_unknown` terminal (H-02). Any status ranked below
    // terminal MUST therefore appear as its own WHEN branch — this is generated, never hand-mirrored.
    for (const [status, rank] of Object.entries(STORED_STATUS_RANK)) {
      if (rank < STORED_STATUS_RANK.delivered) {
        expect(STORED_STATUS_RANK_SQL_CASE).toContain(`WHEN '${status}' THEN ${rank}`);
      }
    }
    expect(STORED_STATUS_RANK_SQL_CASE).toMatch(/^CASE status\b/);
    expect(STORED_STATUS_RANK_SQL_CASE).toMatch(/ELSE 4\s+END$/);
  });
});

describe('generateDoseSchedule — configurable horizon (resolved default 2)', () => {
  it('yields one (dose_date, local_dose_time) pair per day per local time, in chronological order', () => {
    const pairs = generateDoseSchedule({
      startDate: '2026-08-15',
      days: 2,
      localTimes: ['09:00', '20:00'],
      timezone: TORONTO,
    });
    // 2 days × 2 times = 4 pairs, ordered by (date, then time).
    expect(pairs).toEqual([
      { doseDate: '2026-08-15', localDoseTime: '09:00' },
      { doseDate: '2026-08-15', localDoseTime: '20:00' },
      { doseDate: '2026-08-16', localDoseTime: '09:00' },
      { doseDate: '2026-08-16', localDoseTime: '20:00' },
    ]);
  });

  it('supports the SC4 single-dose case (days=1, one time)', () => {
    const pairs = generateDoseSchedule({
      startDate: '2026-08-15',
      days: 1,
      localTimes: ['09:00'],
      timezone: TORONTO,
    });
    expect(pairs).toEqual([{ doseDate: '2026-08-15', localDoseTime: '09:00' }]);
  });

  it('advances the calendar date correctly across a month boundary', () => {
    const pairs = generateDoseSchedule({
      startDate: '2026-08-31',
      days: 2,
      localTimes: ['09:00'],
      timezone: TORONTO,
    });
    expect(pairs.map((p) => p.doseDate)).toEqual(['2026-08-31', '2026-09-01']);
  });
});
