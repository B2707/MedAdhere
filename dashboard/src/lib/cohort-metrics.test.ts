// Cohort metrics — pure functions behind the /patients cohort window + chart data shaping.
// toChartData/summarizeCohort also get higher-level coverage via cohort-chart.test.tsx;
// this file is the canonical home for the pure-function contract, including the window
// parser that previously had no direct test anywhere.
import { describe, expect, it } from 'vitest';
import {
  COHORT_WINDOW_DAYS,
  parseCohortWindowDays,
  summarizeCohort,
  toChartData,
  type CohortDay,
} from './cohort-metrics';

describe('parseCohortWindowDays', () => {
  it('accepts every supported window', () => {
    for (const days of COHORT_WINDOW_DAYS) {
      expect(parseCohortWindowDays(String(days))).toBe(days);
    }
  });

  it('falls back to 30 for an unsupported, empty, or absent value', () => {
    expect(parseCohortWindowDays('14')).toBe(30);
    expect(parseCohortWindowDays('abc')).toBe(30);
    expect(parseCohortWindowDays('')).toBe(30);
    expect(parseCohortWindowDays(undefined)).toBe(30);
  });
});

const SERIES: CohortDay[] = [
  {
    day: '2026-07-01',
    delivered: 10,
    responded: 8,
    confirmed: 6,
    taken_delayed: 5,
    ambiguous: 2,
    non_response: 2,
    adherence_rate: 5 / 6,
    response_rate: 0.8,
  },
];

describe('toChartData', () => {
  it('maps API counts onto the four exhaustive chart buckets', () => {
    expect(toChartData(SERIES)[0]).toMatchObject({
      day: '2026-07-01',
      confirmed: 6,
      ambiguous: 2,
      noResponse: 2,
      unresolved: 0,
    });
  });
});

describe('summarizeCohort', () => {
  it('returns null (never NaN) rates when the denominator is zero', () => {
    expect(summarizeCohort([])).toEqual({ adherencePct: null, responsePct: null });
  });
});
