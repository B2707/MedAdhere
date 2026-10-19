import type { TimelineRow } from '@/lib/dashboard-contracts';

/*
 * timeline-metrics.ts — the pure dose-timeline math, split out of the Recharts client component
 * the same way cohort-metrics.ts is split out of cohort-chart.tsx.
 *
 * It lives here so SERVER components can call it: `timeline-chart.tsx` is `'use client'`, and a
 * Server Component that imports a function from a client module gets a client reference, not the
 * function — calling it throws. The patient record page needs the resolved-outcome count to label
 * its collapsed dose-timeline row honestly, so the count and the chart must share one predicate.
 */

export type TimelineBucket = 'confirmedTaken' | 'confirmedNotTaken' | 'ambiguous' | 'noResponse';

export interface TimelineChartPoint {
  doseId: string;
  label: string;
  bucket: TimelineBucket;
  reasonCode: string | null;
  confirmedTaken: number;
  confirmedNotTaken: number;
  ambiguous: number;
  noResponse: number;
}

const CONFIRMED_TAKEN_STATES = new Set(['taken', 'delayed']);
const CONFIRMED_NOT_TAKEN_STATES = new Set(['skipped', 'stopped']);
const AMBIGUOUS_STATES = new Set(['unknown', 'question']);

/** The bucket a dose resolved into, or `null` while it is still pending/unscored. */
export function timelineBucket(row: TimelineRow): TimelineBucket | null {
  if (row.decided_by === 'timeout' && row.status === 'missed') return 'noResponse';
  if (row.decided_by !== 'classifier' || row.status !== 'recorded') return null;
  if (row.adherence_state !== null && CONFIRMED_TAKEN_STATES.has(row.adherence_state)) {
    return 'confirmedTaken';
  }
  if (row.adherence_state !== null && CONFIRMED_NOT_TAKEN_STATES.has(row.adherence_state)) {
    return 'confirmedNotTaken';
  }
  if (row.adherence_state !== null && AMBIGUOUS_STATES.has(row.adherence_state)) {
    return 'ambiguous';
  }
  return null;
}

export function doseLabel(row: TimelineRow): string {
  const localTime = row.local_dose_time.slice(0, 5);
  // Legacy rows without dose_date cannot support a trustworthy patient-local day.
  // Deliberately omit the UTC calendar fallback and show only the known local time.
  return row.dose_date === null ? localTime : `${row.dose_date} ${localTime}`;
}

/** Map scored doses to the four clinical-honesty buckets. Pending rows are omitted as gaps. */
export function toTimelineChartData(rows: TimelineRow[]): TimelineChartPoint[] {
  return rows.flatMap((row) => {
    const bucket = timelineBucket(row);
    if (bucket === null) return [];
    return [
      {
        doseId: row.dose_id,
        label: doseLabel(row),
        bucket,
        reasonCode: row.reason_code,
        confirmedTaken: bucket === 'confirmedTaken' ? 1 : 0,
        confirmedNotTaken: bucket === 'confirmedNotTaken' ? 1 : 0,
        ambiguous: bucket === 'ambiguous' ? 1 : 0,
        noResponse: bucket === 'noResponse' ? 1 : 0,
      },
    ];
  });
}

/** How many doses in the window actually have an outcome the timeline can show. */
export function resolvedOutcomeCount(rows: TimelineRow[]): number {
  return rows.reduce((count, row) => (timelineBucket(row) === null ? count : count + 1), 0);
}
