'use client';

import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface ErrorBoundaryProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorBoundary({ reset }: ErrorBoundaryProps) {
  return (
    <AppShell pageTitle="Dashboard error">
      <Card>
        <CardHeader>
          <CardTitle>Something went wrong</CardTitle>
        </CardHeader>
        <CardContent className="mt-[var(--spacing-md)] flex flex-col items-start gap-[var(--spacing-md)]">
          <p>The dashboard couldn&apos;t load this view. This is usually temporary.</p>
          <Button type="button" variant="secondary" onClick={reset}>
            Try again
          </Button>
        </CardContent>
      </Card>
    </AppShell>
  );
}
