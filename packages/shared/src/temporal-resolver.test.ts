import { describe, expect, it } from 'vitest';
import {
  extractExplicitRecentLocalDates,
  MAX_TEMPORAL_CANDIDATES,
  generateScheduledDoseCandidates,
  resolveTemporalExpression,
  type ScheduledDoseCandidateInput,
} from './temporal-resolver.js';

const MEDICATION_ID = '00000000-0000-4000-8000-000000000001';

function dose(
  suffix: number,
  scheduledAtUtc: string,
  localDate: string,
  localTime: string,
): ScheduledDoseCandidateInput {
  return {
    doseId: `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`,
    patientMedicationId: MEDICATION_ID,
    scheduledAtUtc,
    localDate,
    localTime,
    patientTimeZone: 'America/Toronto',
  };
}

describe('extractExplicitRecentLocalDates', () => {
  it('keeps only unique valid non-future ISO dates and caps the result', () => {
    const twentyOneDates = Array.from(
      { length: MAX_TEMPORAL_CANDIDATES + 1 },
      (_, index) => `2026-07-${String(index + 1).padStart(2, '0')}`,
    );

    expect(
      extractExplicitRecentLocalDates(
        [
          'Correction for 2026-08-08, not 2026-02-30 or 2026-08-12.',
          'The same thing happened on 2026-08-08.',
          ...twentyOneDates,
        ].join(' '),
        '2026-08-11',
        'America/Toronto',
      ),
    ).toEqual(['2026-08-08', ...twentyOneDates.slice(0, MAX_TEMPORAL_CANDIDATES - 1)]);
  });

  it('does not treat dates embedded in identifiers as explicit local dates', () => {
    expect(
      extractExplicitRecentLocalDates(
        'ref2026-08-08 and 2026-08-07suffix',
        '2026-08-11',
        'America/Toronto',
      ),
    ).toEqual([]);
  });
});

describe('generateScheduledDoseCandidates', () => {
  it('returns stable today/yesterday candidates and excludes future Toronto doses', () => {
    const yesterday = dose(2, '2026-08-10T13:00:00.000Z', '2026-08-10', '09:00');
    const todayPast = dose(3, '2026-08-11T10:00:00.000Z', '2026-08-11', '06:00');
    const todayFuture = dose(4, '2026-08-11T14:00:00.000Z', '2026-08-11', '10:00');
    const older = dose(1, '2026-08-09T13:00:00.000Z', '2026-08-09', '09:00');
    const scheduledDoses = [todayFuture, todayPast, older, yesterday] as const;

    const candidates = generateScheduledDoseCandidates({
      currentUtc: '2026-08-11T12:00:00.000Z',
      currentLocalDate: '2026-08-11',
      patientTimeZone: 'America/Toronto',
      explicitRecentLocalDates: [],
      pendingCandidateIds: [],
      scheduledDoses,
    });

    expect(candidates.map(({ candidateId }) => candidateId)).toEqual([
      yesterday.doseId,
      todayPast.doseId,
    ]);
    expect(candidates[0]).toMatchObject({
      candidateId: yesterday.doseId,
      doseId: yesterday.doseId,
      occurredAtUtc: yesterday.scheduledAtUtc,
      localDate: yesterday.localDate,
      localTime: yesterday.localTime,
      patientTimeZone: yesterday.patientTimeZone,
      source: 'scheduled_dose',
      ambiguous: true,
    });
    expect(scheduledDoses).toEqual([todayFuture, todayPast, older, yesterday]);
  });

  it("cannot bind today's future prompt to a next-morning reply", () => {
    const yesterday = dose(5, '2026-08-10T13:00:00.000Z', '2026-08-10', '09:00');
    const todayFuture = dose(6, '2026-08-11T13:00:00.000Z', '2026-08-11', '09:00');

    expect(
      generateScheduledDoseCandidates({
        currentUtc: '2026-08-11T11:00:00.000Z',
        currentLocalDate: '2026-08-11',
        patientTimeZone: 'America/Toronto',
        explicitRecentLocalDates: [],
        pendingCandidateIds: [],
        scheduledDoses: [todayFuture, yesterday],
      }),
    ).toEqual([
      {
        candidateId: yesterday.doseId,
        patientMedicationId: MEDICATION_ID,
        doseId: yesterday.doseId,
        occurredAtUtc: yesterday.scheduledAtUtc,
        localDate: yesterday.localDate,
        localTime: yesterday.localTime,
        patientTimeZone: yesterday.patientTimeZone,
        source: 'scheduled_dose',
        ambiguous: false,
      },
    ]);
  });

  it('includes an explicitly referenced recent local date without widening the default window', () => {
    const explicit = dose(7, '2026-08-08T13:00:00.000Z', '2026-08-08', '09:00');
    const unrelated = dose(8, '2026-08-07T13:00:00.000Z', '2026-08-07', '09:00');

    const candidates = generateScheduledDoseCandidates({
      currentUtc: '2026-08-11T16:00:00.000Z',
      currentLocalDate: '2026-08-11',
      patientTimeZone: 'America/Toronto',
      explicitRecentLocalDates: ['2026-08-08'],
      pendingCandidateIds: [],
      scheduledDoses: [unrelated, explicit],
    });

    expect(candidates.map(({ candidateId }) => candidateId)).toEqual([explicit.doseId]);
  });

  it('preserves both distinct UTC instants during the Toronto fall-back hour', () => {
    const first = dose(9, '2026-11-01T05:30:00.000Z', '2026-11-01', '01:30');
    const second = dose(10, '2026-11-01T06:30:00.000Z', '2026-11-01', '01:30');

    const candidates = generateScheduledDoseCandidates({
      currentUtc: '2026-11-01T07:00:00.000Z',
      currentLocalDate: '2026-11-01',
      patientTimeZone: 'America/Toronto',
      explicitRecentLocalDates: [],
      pendingCandidateIds: [],
      scheduledDoses: [second, first],
    });

    expect(
      candidates.map(({ occurredAtUtc, localDate, localTime, patientTimeZone }) => ({
        occurredAtUtc,
        localDate,
        localTime,
        patientTimeZone,
      })),
    ).toEqual([
      {
        occurredAtUtc: first.scheduledAtUtc,
        localDate: '2026-11-01',
        localTime: '01:30',
        patientTimeZone: 'America/Toronto',
      },
      {
        occurredAtUtc: second.scheduledAtUtc,
        localDate: '2026-11-01',
        localTime: '01:30',
        patientTimeZone: 'America/Toronto',
      },
    ]);
    expect(candidates.every(({ ambiguous }) => ambiguous)).toBe(true);
  });

  it('carries only allowlisted non-future pending candidate ids', () => {
    const carried = dose(11, '2026-08-01T13:00:00.000Z', '2026-08-01', '09:00');
    const normal = dose(12, '2026-08-11T10:00:00.000Z', '2026-08-11', '06:00');
    const future = dose(13, '2026-08-11T14:00:00.000Z', '2026-08-11', '10:00');
    const foreign = '00000000-0000-4000-8000-000000000099';

    const candidates = generateScheduledDoseCandidates({
      currentUtc: '2026-08-11T12:00:00.000Z',
      currentLocalDate: '2026-08-11',
      patientTimeZone: 'America/Toronto',
      explicitRecentLocalDates: [],
      pendingCandidateIds: [foreign, future.doseId, carried.doseId],
      expression: resolveTemporalExpression(
        'I took it at 6am.',
        '2026-08-11T12:00:00.000Z',
        'America/Toronto',
      ),
      scheduledDoses: [normal, future, carried],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      candidateId: carried.doseId,
      source: 'pending_clarification',
      ambiguous: false,
    });
  });

  it('fails closed on duplicate dose ids, timezone drift, invalid wall-clock provenance, and overflow', () => {
    const current = dose(14, '2026-08-11T13:00:00.000Z', '2026-08-11', '09:00');
    const common = {
      currentUtc: '2026-08-11T16:00:00.000Z',
      currentLocalDate: '2026-08-11',
      patientTimeZone: 'America/Toronto',
      explicitRecentLocalDates: [],
      pendingCandidateIds: [],
    } as const;

    expect(() =>
      generateScheduledDoseCandidates({ ...common, scheduledDoses: [current, current] }),
    ).toThrow(/duplicate/i);
    expect(() =>
      generateScheduledDoseCandidates({
        ...common,
        scheduledDoses: [{ ...current, patientTimeZone: 'America/Vancouver' }],
      }),
    ).toThrow(/timezone/i);
    expect(() =>
      generateScheduledDoseCandidates({
        ...common,
        scheduledDoses: [{ ...current, localTime: '08:00' }],
      }),
    ).toThrow(/local date\/time/i);

    const overflow = Array.from({ length: MAX_TEMPORAL_CANDIDATES + 1 }, (_, index) => {
      const localHour = Math.min(index, 19).toString().padStart(2, '0');
      const utcHour = Math.min(index + 4, 23)
        .toString()
        .padStart(2, '0');
      const minute = index === MAX_TEMPORAL_CANDIDATES ? '30' : '00';
      return dose(
        index + 100,
        `2026-08-11T${utcHour}:${minute}:00.000Z`,
        '2026-08-11',
        `${localHour}:${minute}`,
      );
    });
    expect(() =>
      generateScheduledDoseCandidates({
        ...common,
        currentUtc: '2026-08-12T00:00:00.000Z',
        scheduledDoses: overflow,
      }),
    ).toThrow(/more than 20/i);
  });
});

describe('resolveTemporalExpression', () => {
  const TZ = 'America/Toronto';
  // 2026-08-11 18:00 local (Toronto is UTC-4 in August).
  const NOW = '2026-08-11T22:00:00.000Z';

  it('resolves an explicit clock time with a meridiem to one same-day window', () => {
    expect(resolveTemporalExpression('I took it at 8am', NOW, TZ)).toEqual({
      kind: 'resolved',
      source: 'explicit_time',
      windows: [{ localDate: '2026-08-11', startLocalTime: '08:00', endLocalTime: '09:00' }],
    });
  });

  it('reports a bare hour that could be morning or evening as a meridiem ambiguity', () => {
    // 22:00 local: both 08:00 and 20:00 have already happened today.
    expect(resolveTemporalExpression('I took it at 8', '2026-08-12T02:00:00.000Z', TZ)).toEqual({
      kind: 'ambiguous',
      source: 'explicit_time',
      clarificationTopic: 'dose_meridiem',
      windows: [
        { localDate: '2026-08-11', startLocalTime: '08:00', endLocalTime: '09:00' },
        { localDate: '2026-08-11', startLocalTime: '20:00', endLocalTime: '21:00' },
      ],
    });
  });

  it.each([
    ['1:05', '01:00', '02:00', '13:00', '14:00'],
    ['8:30', '08:00', '09:00', '20:00', '21:00'],
    ['12:59', '00:00', '01:00', '12:00', '13:00'],
  ])(
    'reports bare 12-hour clock time %s as a meridiem ambiguity',
    (clock, firstStart, firstEnd, secondStart, secondEnd) => {
      expect(
        resolveTemporalExpression(`I took it at ${clock}`, '2026-08-12T02:00:00.000Z', TZ),
      ).toEqual({
        kind: 'ambiguous',
        source: 'explicit_time',
        clarificationTopic: 'dose_meridiem',
        windows: [
          { localDate: '2026-08-11', startLocalTime: firstStart, endLocalTime: firstEnd },
          { localDate: '2026-08-11', startLocalTime: secondStart, endLocalTime: secondEnd },
        ],
      });
    },
  );

  it.each([
    ['00:30', '00:00', '01:00'],
    ['13:30', '13:00', '14:00'],
    ['23:59', '23:00', '24:00'],
  ])('resolves unambiguous 24-hour time %s exactly once', (clock, startLocalTime, endLocalTime) => {
    expect(
      resolveTemporalExpression(`I took it at ${clock}`, '2026-08-13T03:59:59.000Z', TZ),
    ).toEqual({
      kind: 'resolved',
      source: 'explicit_time',
      windows: [{ localDate: '2026-08-12', startLocalTime, endLocalTime }],
    });
  });

  it('resolves a bare hour deterministically when only one reading has already happened', () => {
    // 10:00 local: "at 8" cannot mean 20:00, which has not occurred yet.
    expect(resolveTemporalExpression('took it at 8', '2026-08-11T14:00:00.000Z', TZ)).toEqual({
      kind: 'resolved',
      source: 'explicit_time',
      windows: [{ localDate: '2026-08-11', startLocalTime: '08:00', endLocalTime: '09:00' }],
    });
  });

  it('resolves "this morning" to the current local morning window', () => {
    expect(resolveTemporalExpression('I took it this morning', NOW, TZ)).toEqual({
      kind: 'resolved',
      source: 'relative_time',
      windows: [{ localDate: '2026-08-11', startLocalTime: '04:00', endLocalTime: '12:00' }],
    });
  });

  it('resolves "last night" across midnight into the prior evening and early hours', () => {
    expect(resolveTemporalExpression('I forgot it last night', NOW, TZ)).toEqual({
      kind: 'resolved',
      source: 'relative_time',
      windows: [
        { localDate: '2026-08-10', startLocalTime: '17:00', endLocalTime: '24:00' },
        { localDate: '2026-08-11', startLocalTime: '00:00', endLocalTime: '04:00' },
      ],
    });
  });

  it('resolves retroactive day phrasing combined with a time of day', () => {
    expect(resolveTemporalExpression('I took it yesterday morning', NOW, TZ)).toEqual({
      kind: 'resolved',
      source: 'relative_time',
      windows: [{ localDate: '2026-08-10', startLocalTime: '04:00', endLocalTime: '12:00' }],
    });
  });

  it('refuses to narrow when multiple explicit dates cannot be safely paired to clocks', () => {
    expect(
      resolveTemporalExpression('On 2026-08-01 at 8am and on 2026-08-02 at 6pm.', NOW, TZ),
    ).toEqual({ kind: 'none' });
  });

  it('refuses to assign clocks across mixed explicit and relative date clauses', () => {
    expect(
      resolveTemporalExpression(
        'On 2026-08-01 I took it at 8am, and today I took it at 6pm.',
        NOW,
        TZ,
      ),
    ).toEqual({ kind: 'none' });
  });

  it('drops a window that has not happened yet and reports no usable expression', () => {
    // 10:00 local: "this evening" is still in the future, so it reports no dose.
    expect(
      resolveTemporalExpression('I will take it this evening', '2026-08-11T14:00:00.000Z', TZ),
    ).toEqual({ kind: 'none' });
  });

  it('reports no expression for text without a temporal phrase', () => {
    expect(resolveTemporalExpression('My head hurts', NOW, TZ)).toEqual({ kind: 'none' });
  });
});

describe('generateScheduledDoseCandidates with a resolved expression', () => {
  const common = {
    currentUtc: '2026-08-11T22:00:00.000Z',
    currentLocalDate: '2026-08-11',
    patientTimeZone: 'America/Toronto',
    explicitRecentLocalDates: [],
    pendingCandidateIds: [],
  } as const;
  const morning = dose(30, '2026-08-11T12:00:00.000Z', '2026-08-11', '08:00');
  const evening = dose(31, '2026-08-11T20:00:00.000Z', '2026-08-11', '16:00');

  it('narrows two same-day doses to the one inside a resolved window', () => {
    const candidates = generateScheduledDoseCandidates({
      ...common,
      scheduledDoses: [morning, evening],
      expression: resolveTemporalExpression(
        'I took it this morning',
        common.currentUtc,
        common.patientTimeZone,
      ),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      candidateId: morning.doseId,
      source: 'relative_time',
      ambiguous: false,
    });
  });

  it('keeps both readings of an ambiguous bare hour so one clarifying question is asked', () => {
    const eight = dose(32, '2026-08-11T12:00:00.000Z', '2026-08-11', '08:00');
    const twenty = dose(33, '2026-08-12T00:00:00.000Z', '2026-08-11', '20:00');
    const candidates = generateScheduledDoseCandidates({
      ...common,
      currentUtc: '2026-08-12T02:00:00.000Z',
      scheduledDoses: [eight, twenty],
      expression: resolveTemporalExpression(
        'I took it at 8',
        '2026-08-12T02:00:00.000Z',
        common.patientTimeZone,
      ),
    });

    expect(candidates).toHaveLength(2);
    expect(
      candidates.every(({ ambiguous, source }) => ambiguous && source === 'explicit_time'),
    ).toBe(true);
  });

  it('binds one explicit historical date and clock without selecting the same current-day dose', () => {
    const historical = dose(34, '2026-08-01T12:00:00.000Z', '2026-08-01', '08:00');
    const current = dose(35, '2026-08-11T12:00:00.000Z', '2026-08-11', '08:00');
    const candidates = generateScheduledDoseCandidates({
      ...common,
      explicitRecentLocalDates: ['2026-08-01'],
      scheduledDoses: [current, historical],
      expression: resolveTemporalExpression(
        'I took it on 2026-08-01 at 8am.',
        common.currentUtc,
        common.patientTimeZone,
      ),
    });

    expect(candidates.map(({ candidateId }) => candidateId)).toEqual([historical.doseId]);
  });

  it('keeps every explicitly referenced clock instead of narrowing to the first dose', () => {
    const eight = dose(36, '2026-08-11T12:00:00.000Z', '2026-08-11', '08:00');
    const eighteen = dose(37, '2026-08-11T22:00:00.000Z', '2026-08-11', '18:00');
    const currentUtc = '2026-08-11T23:00:00.000Z';
    const candidates = generateScheduledDoseCandidates({
      ...common,
      currentUtc,
      scheduledDoses: [eight, eighteen],
      expression: resolveTemporalExpression(
        'My morning dose was at 8am and my evening dose was at 6pm.',
        currentUtc,
        common.patientTimeZone,
      ),
    });

    expect(candidates.map(({ candidateId }) => candidateId)).toEqual([
      eight.doseId,
      eighteen.doseId,
    ]);
  });

  it('keeps the unnarrowed pool when the resolved window matches no scheduled dose', () => {
    const candidates = generateScheduledDoseCandidates({
      ...common,
      scheduledDoses: [morning, evening],
      expression: resolveTemporalExpression(
        'I took it this morning',
        common.currentUtc,
        common.patientTimeZone,
      ),
    });
    const unmatched = generateScheduledDoseCandidates({
      ...common,
      scheduledDoses: [evening],
      expression: resolveTemporalExpression(
        'I took it this morning',
        common.currentUtc,
        common.patientTimeZone,
      ),
    });

    expect(candidates).toHaveLength(1);
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]).toMatchObject({ candidateId: evening.doseId, source: 'scheduled_dose' });
  });
});
