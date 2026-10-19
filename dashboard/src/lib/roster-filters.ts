import type { CohortWindowDays } from '@/lib/cohort-metrics';

/*
 * Roster filters (/patients?filter=…).
 *
 * The cohort headline numbers name subsets of the roster, so each one is a real navigation
 * target into that subset rather than static text. Every predicate is derived from the patient
 * rows the page ALREADY fetched — no new endpoint, no second source of truth — and each mirrors
 * the count it is reached from: `needs-review` is the AlertBanner / "Open alerts" predicate
 * (D5 — trust the API `alerting` flag, never surface an inactive patient), `active` is the
 * "Active patients" predicate.
 *
 * "Open alerts", the "Follow-up needed" banner, and the per-row "needs review" badge all
 * describe the SAME set, so they share one key instead of three aliases for one predicate.
 * An unrecognised value falls back to no filter, mirroring `parseCohortWindowDays`.
 */

/** Only the fields the predicates read — AlertBanner passes a narrower row than the roster does. */
interface FilterablePatient {
  alerting: boolean;
  is_active: boolean;
  opted_out_at: string | null;
}

export interface RosterFilter {
  /** Chip text, and the accessible name of the link that reaches this filter. */
  label: string;
  matches: (patient: FilterablePatient) => boolean;
}

export const ROSTER_FILTER_KEYS = ['needs-review', 'active'] as const;
export type RosterFilterKey = (typeof ROSTER_FILTER_KEYS)[number];

export const ROSTER_FILTERS: Record<RosterFilterKey, RosterFilter> = {
  'needs-review': {
    label: 'Needs review',
    matches: (patient) => patient.alerting === true && patient.is_active !== false,
  },
  active: {
    label: 'Active patients',
    matches: (patient) => patient.is_active !== false && patient.opted_out_at === null,
  },
};

export function parseRosterFilter(value: string | undefined): RosterFilterKey | null {
  return ROSTER_FILTER_KEYS.includes(value as RosterFilterKey) ? (value as RosterFilterKey) : null;
}

export function filterRoster<T extends FilterablePatient>(
  patients: T[],
  filter: RosterFilterKey | null,
): T[] {
  return filter === null ? patients : patients.filter(ROSTER_FILTERS[filter].matches);
}

interface PatientsHrefParams {
  days?: CohortWindowDays;
  query?: string;
  filter?: RosterFilterKey | null;
}

/** Every roster link carries the whole view — changing the filter never drops the window or search. */
export function patientsHref({ days, query = '', filter = null }: PatientsHrefParams = {}): string {
  const params: string[] = [];
  if (days !== undefined) params.push(`days=${days}`);
  if (query.length > 0) params.push(`q=${encodeURIComponent(query)}`);
  if (filter !== null) params.push(`filter=${filter}`);
  return params.length === 0 ? '/patients' : `/patients?${params.join('&')}`;
}

export type RosterFilterHrefs = Record<RosterFilterKey, string>;

/** The hrefs the cohort cards and the alert banner link to, built once by the page that owns the URL. */
export function rosterFilterHrefs(params: Omit<PatientsHrefParams, 'filter'>): RosterFilterHrefs {
  return {
    'needs-review': patientsHref({ ...params, filter: 'needs-review' }),
    active: patientsHref({ ...params, filter: 'active' }),
  };
}
