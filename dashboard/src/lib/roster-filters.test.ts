// Roster filters — the predicates behind /patients?filter=… and the hrefs that reach them.
// Each predicate must stay identical to the count it is reached from (AlertBanner / CohortSummary),
// so a filtered roster can never disagree with the headline number the doctor clicked.
import { describe, expect, it } from 'vitest';
import {
  ROSTER_FILTERS,
  filterRoster,
  parseRosterFilter,
  patientsHref,
  rosterFilterHrefs,
} from './roster-filters';

let seq = 0;
function mk(
  overrides: Partial<{ alerting: boolean; is_active: boolean; opted_out_at: string }> = {},
) {
  return {
    id: `p${seq++}`,
    alerting: false,
    is_active: true,
    opted_out_at: null as string | null,
    ...overrides,
  };
}

describe('parseRosterFilter', () => {
  it('accepts the supported keys', () => {
    expect(parseRosterFilter('needs-review')).toBe('needs-review');
    expect(parseRosterFilter('active')).toBe('active');
  });

  it('falls back to no filter for an unknown or absent value', () => {
    expect(parseRosterFilter('open-alerts')).toBeNull();
    expect(parseRosterFilter('')).toBeNull();
    expect(parseRosterFilter(undefined)).toBeNull();
  });
});

describe('filterRoster', () => {
  it('returns the roster untouched when no filter is applied', () => {
    const patients = [mk(), mk({ alerting: true })];
    expect(filterRoster(patients, null)).toBe(patients);
  });

  it('needs-review keeps alerting patients and excludes inactive ones (D5)', () => {
    const alerting = mk({ alerting: true });
    const result = filterRoster(
      [alerting, mk({ alerting: true, is_active: false }), mk()],
      'needs-review',
    );
    expect(result).toEqual([alerting]);
  });

  it('active keeps patients that are neither deactivated nor opted out', () => {
    const receiving = mk();
    const result = filterRoster(
      [receiving, mk({ is_active: false }), mk({ opted_out_at: '2026-08-01T00:00:00.000Z' })],
      'active',
    );
    expect(result).toEqual([receiving]);
  });

  it('matches the counts the cards show — an alerting patient is also an active one', () => {
    const patients = [mk({ alerting: true }), mk({ is_active: false }), mk()];
    expect(filterRoster(patients, 'needs-review')).toHaveLength(1);
    expect(filterRoster(patients, 'active')).toHaveLength(2);
  });

  it('labels every filter for the active-filter chip', () => {
    expect(ROSTER_FILTERS['needs-review'].label).toBe('Needs review');
    expect(ROSTER_FILTERS.active.label).toBe('Active patients');
  });
});

describe('patientsHref', () => {
  it('carries the window, search, and filter together', () => {
    expect(patientsHref({ days: 7, query: 'Alice', filter: 'needs-review' })).toBe(
      '/patients?days=7&q=Alice&filter=needs-review',
    );
  });

  it('omits the parts that are not set', () => {
    expect(patientsHref()).toBe('/patients');
    expect(patientsHref({ days: 90 })).toBe('/patients?days=90');
    expect(patientsHref({ days: 30, query: '' })).toBe('/patients?days=30');
  });

  it('encodes the search so a query never breaks the URL', () => {
    expect(patientsHref({ days: 30, query: 'a&b=c' })).toBe('/patients?days=30&q=a%26b%3Dc');
  });

  it('builds one href per filter from the current view', () => {
    expect(rosterFilterHrefs({ days: 7, query: 'Bob' })).toEqual({
      'needs-review': '/patients?days=7&q=Bob&filter=needs-review',
      active: '/patients?days=7&q=Bob&filter=active',
    });
  });
});
