'use client';

import { Button } from '@/components/ui/button';
import './globals.css';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ reset }: GlobalErrorProps) {
  return (
    <html lang="en">
      <body>
        <main className="flex min-h-screen items-center justify-center bg-[var(--color-background)] p-[var(--spacing-lg)]">
          <section className="flex max-w-[36rem] flex-col items-start gap-[var(--spacing-md)] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-[var(--spacing-lg)]">
            <div
              role="heading"
              aria-level={1}
              className="text-[length:var(--text-heading)] font-semibold"
            >
              Couldn&apos;t load MedAdhere
            </div>
            <p>The dashboard couldn&apos;t load. This is usually temporary.</p>
            <Button type="button" variant="secondary" onClick={reset}>
              Try again
            </Button>
          </section>
        </main>
      </body>
    </html>
  );
}
