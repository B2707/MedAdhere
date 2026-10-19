import * as React from 'react';
import { cn } from '@/lib/utils';

/*
 * Table — semantic table primitives (shadcn new-york style, Radix-free for thesis
 * transparency). Real <table>/<thead>/<tbody>/<tr>/<th>/<td> elements so the browser
 * and assistive tech get the native table/rowgroup/row/columnheader/cell roles for
 * free. Tokens only (globals.css @theme, DESIGN-SPEC.md §5 Lane A item 7) — no
 * hardcoded colors.
 *
 * `variant="cards"` is the C3 responsive escape hatch: the table stays a REAL <table> at
 * every width (assistive tech never loses row/cell semantics) but below `lg` each <tr>
 * restacks into a bordered card and <thead> becomes visually hidden (`sr-only`, still
 * announced). This is CSS-only — driven by the container's `data-variant` attribute via
 * Tailwind's `group-data-[variant=cards]:` variant — because these primitives render as
 * React Server Components (no 'use client', no hooks) and must stay that way.
 */

type TableVariant = 'table' | 'cards';

/** The table, wrapped so wide content scrolls horizontally instead of the page body. */
export function Table({
  className,
  containerClassName,
  scrollLabel = 'Scrollable data table',
  variant = 'table',
  ...props
}: React.HTMLAttributes<HTMLTableElement> & {
  containerClassName?: string;
  scrollLabel?: string;
  variant?: TableVariant;
}) {
  const isCards = variant === 'cards';
  return (
    <div
      data-variant={variant}
      role="region"
      aria-label={scrollLabel}
      // A horizontal scroller must be keyboard-focusable for non-pointer users.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className={cn(
        'group w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--elev-1)] focus-visible:focus-inset',
        isCards ? 'lg:overflow-x-auto lg:[contain:paint]' : 'overflow-x-auto [contain:paint]',
        containerClassName,
      )}
    >
      <table
        className={cn(
          'w-full caption-bottom border-collapse text-sm',
          isCards && 'max-lg:block',
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function TableHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn(
        'sticky top-0 z-10 border-b border-[var(--color-border-subtle)] bg-[var(--color-canvas-raised)] group-data-[variant=cards]:max-lg:sr-only',
        className,
      )}
      {...props}
    />
  );
}

export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody
      className={cn(
        'group-data-[variant=cards]:max-lg:grid group-data-[variant=cards]:max-lg:gap-3',
        className,
      )}
      {...props}
    />
  );
}

export function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        'border-b border-[var(--color-border-subtle)] transition-colors duration-200 last:border-b-0 hover:bg-[var(--color-surface-hover)] focus-within:bg-[var(--color-accent-50)]',
        'group-data-[variant=cards]:max-lg:block group-data-[variant=cards]:max-lg:rounded-lg group-data-[variant=cards]:max-lg:border group-data-[variant=cards]:max-lg:border-[var(--color-border)] group-data-[variant=cards]:max-lg:bg-[var(--color-surface)] group-data-[variant=cards]:max-lg:p-4 group-data-[variant=cards]:max-lg:shadow-[var(--elev-1)]',
        className,
      )}
      {...props}
    />
  );
}

/** A column/row header cell. Pass `scope="col"` / `scope="row"` at the call site. */
export function TableHead({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'h-12 px-4 text-left align-middle text-sm font-semibold text-[var(--color-ink)]',
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({
  className,
  label,
  children,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & {
  /** Visible only in `variant="cards"` — restates the cell's column header inline. */
  label?: string;
}) {
  return (
    <td
      className={cn(
        'px-4 py-3 align-middle text-sm text-[var(--color-ink-secondary)]',
        'group-data-[variant=cards]:max-lg:flex group-data-[variant=cards]:max-lg:items-baseline group-data-[variant=cards]:max-lg:justify-between group-data-[variant=cards]:max-lg:gap-3 group-data-[variant=cards]:max-lg:border-b group-data-[variant=cards]:max-lg:border-[var(--color-border-subtle)] group-data-[variant=cards]:max-lg:px-0 group-data-[variant=cards]:max-lg:py-2 group-data-[variant=cards]:max-lg:last:border-b-0',
        className,
      )}
      {...props}
    >
      {label !== undefined && (
        <span
          aria-hidden="true"
          className="hidden text-xs font-medium text-[var(--color-ink-muted)] group-data-[variant=cards]:max-lg:inline"
        >
          {label}
        </span>
      )}
      {children}
    </td>
  );
}

export function TableCaption({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableCaptionElement>) {
  return (
    <caption className={cn('mt-2 text-sm text-[var(--color-ink-muted)]', className)} {...props} />
  );
}
