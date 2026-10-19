import * as React from 'react';
import { cn } from '@/lib/utils';

/*
 * Card — raised clinical surface (DESIGN-SPEC.md §1.5, §5 Lane A item 5).
 * `--radius-lg` / `--elev-1`; padding is the spec's responsive card rhythm — 20px below
 * `sm`, 24px at `sm` and up.
 */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--elev-1)] sm:p-6',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1', className)} {...props} />;
}

/** A left title + right controls row for a Card's header — filters, "Manage" buttons, etc. */
export function CardToolbar({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-wrap items-center justify-between gap-2', className)}
      {...props}
    />
  );
}

export function CardTitle({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn('text-lg font-semibold tracking-heading text-[var(--color-ink)]', className)}
      {...props}
    >
      {children}
    </h2>
  );
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('text-base text-[var(--color-ink-secondary)]', className)} {...props} />
  );
}
