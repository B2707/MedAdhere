import { CohortChart } from '@/components/cohort-chart';
import { CohortSummary } from '@/components/cohort-summary';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api';
import { summarizeCohort, type CohortWindowDays } from '@/lib/cohort-metrics';
import type { RosterFilterHrefs } from '@/lib/roster-filters';
import type { PatientRow } from '@/components/patient-list';
import { cohortResponseSchema } from '@/lib/dashboard-contracts';

export function CohortChartFallback() {
  return (
    <div id="cohort-analytics" role="status" aria-live="polite" className="space-y-4">
      <span className="sr-only">Loading cohort chart…</span>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-[126px] w-full" />
        ))}
      </div>
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

export async function CohortChartSection({
  patients,
  windowDays,
  filterHrefs,
}: {
  patients: PatientRow[];
  windowDays: CohortWindowDays;
  filterHrefs?: RosterFilterHrefs;
}) {
  const result = await apiFetch(`/api/cohort-adherence?days=${windowDays}`, cohortResponseSchema);
  if (result.status !== 'ok') {
    return (
      <section id="cohort-analytics" className="space-y-4">
        <CohortSummary
          patients={patients}
          adherencePct={null}
          responsePct={null}
          windowDays={windowDays}
          filterHrefs={filterHrefs}
        />
        <p className="text-base text-[var(--color-ink-muted)]">
          Couldn&apos;t load the cohort chart — try refreshing in a moment.
        </p>
      </section>
    );
  }

  const { adherencePct, responsePct } = summarizeCohort(result.data.series);
  return (
    <section id="cohort-analytics" className="space-y-4">
      <CohortSummary
        patients={patients}
        adherencePct={adherencePct}
        responsePct={responsePct}
        windowDays={windowDays}
        filterHrefs={filterHrefs}
      />
      <CohortChart series={result.data.series} windowDays={windowDays} />
    </section>
  );
}
