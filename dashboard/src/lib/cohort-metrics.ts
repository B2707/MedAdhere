import type { CohortDay } from '@/lib/dashboard-contracts';

export type { CohortDay } from '@/lib/dashboard-contracts';

export interface CohortChartPoint {
  day: string;
  confirmed: number;
  ambiguous: number;
  noResponse: number;
  unresolved: number;
  adherencePct: number | null;
}

export const COHORT_WINDOW_DAYS = [7, 30, 90] as const;
export type CohortWindowDays = (typeof COHORT_WINDOW_DAYS)[number];

export function parseCohortWindowDays(value: string | undefined): CohortWindowDays {
  const parsed = Number(value);
  return COHORT_WINDOW_DAYS.includes(parsed as CohortWindowDays)
    ? (parsed as CohortWindowDays)
    : 30;
}

/** Preserve omitted API days as gaps rather than inventing zero-value observations. */
export function toChartData(series: CohortDay[]): CohortChartPoint[] {
  return series.map((day) => ({
    day: day.day,
    confirmed: day.confirmed,
    ambiguous: day.ambiguous,
    noResponse: day.non_response,
    unresolved: Math.max(0, day.delivered - day.confirmed - day.ambiguous - day.non_response),
    adherencePct:
      day.adherence_rate === null ? null : Math.round(day.adherence_rate * 10_000) / 100,
  }));
}

/** Aggregate ratios from counts, never by averaging daily percentages. */
export function summarizeCohort(series: CohortDay[]): {
  adherencePct: number | null;
  responsePct: number | null;
} {
  const total = (pick: (day: CohortDay) => number): number =>
    series.reduce((sum, day) => sum + pick(day), 0);
  const confirmed = total((day) => day.confirmed);
  const takenDelayed = total((day) => day.taken_delayed);
  const delivered = total((day) => day.delivered);
  const responded = total((day) => day.responded);

  return {
    adherencePct: confirmed > 0 ? takenDelayed / confirmed : null,
    responsePct: delivered > 0 ? responded / delivered : null,
  };
}
