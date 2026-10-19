import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/*
 * collapsible.tsx — the ONE disclosure treatment for the patient-record sections.
 *
 * Native `<details>/<summary>` (the same pattern original-messages already uses) gives the
 * header keyboard operation and expanded/collapsed announcement without client JS, so every
 * consumer stays a server component. The summary row is the full header: chevron, title,
 * and a one-line status that stays readable while the section is collapsed.
 *
 * Sections render as flat rows inside one raised card (`divide-y` on the parent supplies the
 * single divider rhythm) — never as nested cards. The reveal motion is the shared
 * `.disclosure-body` rise-in defined in globals.css; the chevron turns with the same tokens.
 *
 * Default state is the caller's call — the convention on the record page is open when the
 * section has data and collapsed when it would only show an empty state.
 *
 * `focus-visible:focus-inset` (A5/R11) gives the `<summary>` its OWN visible focus ring —
 * it can't rely on inheriting the global `:focus-visible` outline, which an ancestor's
 * `overflow-hidden`/`[contain:paint]` may clip.
 */

export function CollapsiblePanel({
  title,
  titleId,
  status,
  defaultOpen = false,
  headingLevel = 2,
  className,
  children,
}: {
  title: string;
  titleId: string;
  status: string;
  defaultOpen?: boolean;
  headingLevel?: 2 | 3 | 4;
  className?: string;
  children: ReactNode;
}) {
  const Heading = headingLevel === 2 ? 'h2' : headingLevel === 3 ? 'h3' : 'h4';
  return (
    <details open={defaultOpen} className={cn('group min-w-0', className)}>
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 p-5 hover:bg-[var(--color-surface-hover)] focus-visible:focus-inset sm:p-6 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="shrink-0 text-[var(--color-ink-muted)] transition-transform duration-[var(--motion-fast)] ease-[var(--ease-smooth)] group-open:rotate-90"
          size={16}
        />
        <Heading
          id={titleId}
          className="min-w-0 break-words text-lg font-semibold tracking-heading text-[var(--color-ink)]"
        >
          {title}
        </Heading>
        <span className="min-w-0 break-words text-sm text-[var(--color-ink-muted)] sm:ml-auto">
          {status}
        </span>
      </summary>
      <div className="disclosure-body min-w-0 border-t border-[var(--color-border-subtle)] p-5 sm:p-6">
        {children}
      </div>
    </details>
  );
}
