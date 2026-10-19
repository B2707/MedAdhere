import { AppShell } from '@/components/app-shell';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function PatientDetailLoading() {
  return (
    <AppShell pageTitle="Patient detail">
      <div role="status" aria-live="polite" className="flex flex-col gap-6">
        <span className="sr-only">Loading patient detail…</span>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-16 w-full" />
        <Card className="flex flex-col gap-4">
          <Skeleton className="h-6 w-52" />
          <Skeleton className="h-72 w-full" />
        </Card>
        <Card className="flex flex-col gap-4">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-36 w-full" />
        </Card>
      </div>
    </AppShell>
  );
}
