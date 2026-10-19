import Link from 'next/link';
import { AppShell } from '@/components/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function PatientNotFound() {
  return (
    <AppShell pageTitle="Patient not found">
      <Card>
        <CardHeader>
          <CardTitle>Patient not found</CardTitle>
        </CardHeader>
        <CardContent className="mt-4 flex flex-col items-start gap-4">
          <p>This patient does not exist or is no longer available.</p>
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
