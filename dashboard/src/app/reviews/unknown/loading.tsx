import { AppShell } from '@/components/app-shell';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function UnknownReviewsLoading() {
  return (
    <AppShell pageTitle="Classification and label-match reviews">
      <div role="status" aria-live="polite" className="flex flex-col gap-6">
        <span className="sr-only">Loading classification reviews and label matches…</span>
        <Skeleton className="h-11 w-full max-w-96" />
        <Card className="flex flex-col gap-2">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </Card>
      </div>
    </AppShell>
  );
}
