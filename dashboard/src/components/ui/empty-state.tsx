import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-8 text-center',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="mb-4 inline-flex size-12 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-canvas-raised)] text-[var(--color-ink-muted)]"
      >
        {icon}
      </span>
      <h3 className="text-base font-semibold text-[var(--color-ink)]">{title}</h3>
      <p className="mt-1 max-w-[36rem] text-sm text-[var(--color-ink-muted)]">{description}</p>
      {action !== undefined && <div className="mt-4">{action}</div>}
    </div>
  );
}
