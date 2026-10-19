import { AppShell } from '@/components/app-shell';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/*
 * Loading state for /patients (UI-SPEC §"Auth & Data States" → Loading). The AppShell
 * renders instantly; the content region shows calm skeletons approximating the page
 * layout — alert banner → cohort chart → patient list — while the RSC awaits the
 * data-API reads. The wrapper owns one assistive announcement for the whole route.
 */
export default function PatientsLoading() {
  return (
    <AppShell pageTitle="Cohort overview">
      <div role="status" aria-live="polite" className="flex flex-col gap-6">
        <span className="sr-only">Loading patients…</span>
        {/* alert-banner slot */}
        <Skeleton className="h-14 w-full" />

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Card key={index} data-slot="metric-skeleton" className="space-y-3 p-5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-8 w-14" />
              <Skeleton className="h-3 w-32" />
            </Card>
          ))}
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(18rem,0.85fr)]">
          <Card className="flex flex-col gap-4">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-56 w-full" />
          </Card>
          <Card className="flex flex-col gap-4">
            <Skeleton className="h-6 w-44" />
            <Skeleton className="h-56 w-full" />
          </Card>
        </div>

        {/* patient list rows */}
        <Card className="flex flex-col gap-2">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </Card>
      </div>
    </AppShell>
  );
}
