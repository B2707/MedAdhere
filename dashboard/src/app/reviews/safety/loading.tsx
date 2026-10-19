import { AppShell } from '@/components/app-shell';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function SafetyReviewsLoading() {
  return (
    <AppShell pageTitle="Safety reviews">
      <div role="status" aria-live="polite" className="flex flex-col gap-6">
        <span className="sr-only">Loading safety reviews…</span>
        <Skeleton className="h-11 w-full max-w-96" />
        <Card className="flex flex-col gap-2">
          <Skeleton className="h-6 w-72" />
          <Skeleton className="h-5 w-full" />
        </Card>
        <Card className="flex flex-col gap-2">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </Card>
      </div>
    </AppShell>
  );
}
