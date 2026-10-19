import { Suspense } from 'react';
import Link from 'next/link';
import { AlertTriangle, ChartNoAxesCombined, Plus, XCircle } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { AutoRefresh } from '@/components/auto-refresh';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';
import { AlertBanner } from '@/components/alert-banner';
import { PatientList } from '@/components/patient-list';
import { COHORT_WINDOW_DAYS, parseCohortWindowDays } from '@/lib/cohort-metrics';
import {
  ROSTER_FILTERS,
  filterRoster,
  parseRosterFilter,
  patientsHref,
  rosterFilterHrefs,
} from '@/lib/roster-filters';
import { CohortChartFallback, CohortChartSection } from './cohort-chart-section';
import { patientsResponseSchema, type PatientsResponse } from '@/lib/dashboard-contracts';

/*
 * /patients — the clinician cohort view (06-03b). A server component (D-14: the
 * dashboard tier never imports a Postgres client — all reads go through the data API
 * via the server-only `apiFetch` Bearer wrapper). Layout order: consecutive-miss alert
 * banner (top) → cohort chart → patient list.
 *
 * States mirror the Phase-2 card patterns (UI-SPEC §"Auth & Data States"): an expired
 * session surfaces the sign-in card; a list read failure surfaces the calm error card.
 * The cohort chart degrades independently (a note, not a whole-page error) so a
 * transient cohort failure never blanks the list.
 *
 * Sign-in control (SIGNIN-DIAGNOSIS.md §3 Slice D): the unauthenticated branch's "Sign
 * in" control stays a form GET to /api/auth/login, not a link — Slice C (next.config.ts
 * CSP form-action) is what makes the cross-origin OAuth redirect actually complete;
 * converting this to a client-side link would not fix anything and is explicitly out of
 * scope for this lane.
 *
 * N1 (DESIGN-SPEC.md §3.3): "Study analytics" used to be a persistent-sidebar link into
 * an anchor on this same page, which also broke the sidebar's own active-item highlight.
 * Lane B deletes that sidebar entry; the in-page pill below is its real replacement — a
 * plain same-page jump to the already-rendered `#cohort-analytics` section, owned by the
 * page it actually describes instead of the global shell.
 */

// Always render fresh — the cohort + miss runs must reflect live state (SC1/SC3).
export const dynamic = 'force-dynamic';

interface PatientsPageProps {
  searchParams?: Promise<{
    q?: string | string[];
    days?: string | string[];
    filter?: string | string[];
  }>;
}

export default async function PatientsPage({
  searchParams = Promise.resolve({}),
}: PatientsPageProps) {
  const [listResult, queryParams] = await Promise.all([
    apiFetch('/api/patients', patientsResponseSchema),
    searchParams,
  ]);
  const rawQuery = Array.isArray(queryParams.q) ? queryParams.q[0] : queryParams.q;
  const rawDays = Array.isArray(queryParams.days) ? queryParams.days[0] : queryParams.days;
  const rawFilter = Array.isArray(queryParams.filter) ? queryParams.filter[0] : queryParams.filter;
  const initialQuery = typeof rawQuery === 'string' ? rawQuery.slice(0, 128) : '';
  const windowDays = parseCohortWindowDays(rawDays);
  const rosterFilter = parseRosterFilter(rawFilter);

  // Session expired mid-view (the middleware gate is UX-only; the API-GW authorizer is
  // the real boundary) — mirror the Phase-2 sign-in card.
  if (listResult.status === 'unauthenticated') {
    return (
      <AppShell
        pageTitle="Patients"
        pageDescription="Monitor cohort status, adherence, and check-in response patterns."
      >
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <XCircle aria-hidden="true" className="text-[var(--color-danger-700)]" size={24} />
              <CardTitle>You&apos;re not signed in</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p>Your session has expired or you&apos;re not signed in. Sign in to continue.</p>
            <form action="/api/auth/login" method="get">
              <Button type="submit" variant="primary">
                Sign in
              </Button>
            </form>
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  // The list is the primary content — a hard failure surfaces the calm error card.
  if (listResult.status === 'error') {
    return (
      <AppShell
        pageTitle="Patients"
        pageDescription="Monitor cohort status, adherence, and check-in response patterns."
      >
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle
                aria-hidden="true"
                className="text-[var(--color-danger-700)]"
                size={24}
              />
              <CardTitle>Couldn&apos;t reach the database</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p>
              The dashboard couldn&apos;t load the patient list. This is usually temporary — try
              again in a moment.
            </p>
            <form action="/patients" method="get">
              <Button type="submit" variant="secondary">
                Retry
              </Button>
            </form>
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  const { patients, alertThreshold }: PatientsResponse = listResult.data;
  const receivingCheckInsCount = patients.filter(
    (patient) => patient.is_active && patient.agent_enabled && patient.provider_opted_in,
  ).length;
  // Only the ROSTER narrows — the headline counts and the chart keep describing the whole cohort,
  // so the numbers a doctor filtered from stay on screen to filter back out of.
  const rosterPatients = filterRoster(patients, rosterFilter);
  const filterHrefs = rosterFilterHrefs({ days: windowDays, query: initialQuery });
  const activeFilter =
    rosterFilter === null
      ? undefined
      : {
          label: ROSTER_FILTERS[rosterFilter].label,
          clearHref: patientsHref({ days: windowDays, query: initialQuery }),
        };

  return (
    <AppShell
      pageTitle="Cohort overview"
      topBarLabel="Overview"
      pageDescription={`${receivingCheckInsCount} ${receivingCheckInsCount === 1 ? 'patient' : 'patients'} receiving check-ins in the monitored research cohort.`}
      pageActions={
        <div className="flex flex-wrap items-center gap-3">
          <nav
            aria-label="Cohort window"
            className="flex min-h-11 items-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-[var(--elev-1)]"
          >
            {COHORT_WINDOW_DAYS.map((days) => {
              const isCurrent = days === windowDays;
              return (
                <Link
                  key={days}
                  href={patientsHref({ days, query: initialQuery, filter: rosterFilter })}
                  aria-current={isCurrent ? 'page' : undefined}
                  className={`inline-flex min-h-9 min-w-11 items-center justify-center rounded-sm px-3 font-[family-name:var(--font-mono)] text-xs font-semibold transition-colors ${
                    isCurrent
                      ? 'bg-[var(--color-accent-100)] text-[var(--color-accent)]'
                      : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]'
                  }`}
                >
                  {days}d
                </Link>
              );
            })}
          </nav>
          {/* N1 — the in-page replacement for the deleted sidebar "Study analytics" link:
              a plain same-page jump to the section already rendered below. */}
          <a
            href="#cohort-analytics"
            className={cn(buttonVariants({ variant: 'secondary' }), 'gap-2')}
          >
            <ChartNoAxesCombined aria-hidden="true" size={17} />
            Study analytics
          </a>
          <Link
            href="/patients/new"
            className={cn(buttonVariants({ variant: 'primary' }), 'gap-2')}
          >
            <Plus aria-hidden="true" size={17} />
            Enroll patient
          </Link>
        </div>
      }
    >
      <AutoRefresh />
      <div className="flex flex-col gap-5">
        <AlertBanner
          patients={patients}
          threshold={alertThreshold}
          href={filterHrefs['needs-review']}
        />

        <Suspense fallback={<CohortChartFallback />}>
          <CohortChartSection
            patients={patients}
            windowDays={windowDays}
            filterHrefs={filterHrefs}
          />
        </Suspense>

        <PatientList
          patients={rosterPatients}
          initialQuery={initialQuery}
          activeFilter={activeFilter}
        />
      </div>
    </AppShell>
  );
}
