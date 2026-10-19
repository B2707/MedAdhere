import Link from 'next/link';
import { AppShell } from '@/components/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function RootNotFound() {
  return (
    <AppShell pageTitle="Page not found">
      <Card>
        <CardHeader>
          <CardTitle>Page not found</CardTitle>
        </CardHeader>
        <CardContent className="mt-[var(--spacing-md)] flex flex-col items-start gap-[var(--spacing-md)]">
          <p>This page does not exist or is no longer available.</p>
          <Link
            href="/patients"
            className="font-semibold text-[var(--color-accent)] underline underline-offset-2"
          >
            Back to patients
          </Link>
        </CardContent>
      </Card>
    </AppShell>
  );
}
