import { AppShell } from '@/components/app-shell';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { NewPatientForm } from './new-patient-form';

/*
 * /patients/new — the clinician enrollment form (DASH-05 / D3). A simple RSC: it renders the enrollment
 * form (a small client component wired to the enroll server action via useActionState) inside the app
 * shell. Auth is enforced at request time by the middleware (/patients/:path*) AND re-checked inside the
 * action; the server action validates the FormData, POSTs to the data-API, and on success revalidates
 * /patients before redirecting there (D3). This page reads no cookies and fetches no data itself.
 */
export default function NewPatientPage() {
  return (
    <AppShell
      pageTitle="Enroll patient"
      pageDescription="Add a test participant and schedule their medication check-ins."
    >
      <div className="mx-auto max-w-[640px]">
        <Link
          href="/patients"
          className="mb-4 inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-md)] text-sm font-semibold text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          <ArrowLeft aria-hidden="true" size={17} />
          Back to overview
        </Link>
        <Card className="p-0">
          <CardHeader className="border-b border-[var(--color-border-subtle)] px-6 py-5">
            <CardTitle>Enrollment details</CardTitle>
            <p className="text-sm text-[var(--color-ink-muted)]">
              Required fields are validated before scheduling begins.
            </p>
          </CardHeader>
          <CardContent className="px-6 py-6">
            <NewPatientForm />
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
