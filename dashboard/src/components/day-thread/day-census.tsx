'use client';

import { computeCensus, flattenCensusEvents, type ThreadItem } from './thread-merge';

/*
 * day-census.tsx — the day bar's count line AND the thread's jump rail (DESIGN-SPEC.md §4.5).
 *
 * "The day bar's census is computed from the merged thread, not from `dayIndex` — so it can
 * never disagree with what is rendered." `computeCensus` is the one place that counts happen;
 * both `<DayBar>` (a plain summary line, via its `census` prop) and `<DayThread>`'s own jump
 * rail read from the SAME merged `ThreadItem[]`, so the two can never drift apart.
 *
 * The census MATH lives in thread-merge.ts (server-safe); this 'use client' module holds only
 * the interactive jump rail. Server code must import computeCensus from thread-merge, never
 * from here — calling a client-module export on the server is a production runtime error.
 */

export { computeCensus } from './thread-merge';
export type { DayCensusCounts } from './thread-merge';

function firstMatch(items: ThreadItem[], priority: 'emergency' | 'important'): string | null {
  return flattenCensusEvents(items).find((event) => event.priority === priority)?.id ?? null;
}

function firstMessageId(items: ThreadItem[]): string | null {
  return items.find((item) => item.kind === 'message')?.id ?? null;
}

function firstEventId(items: ThreadItem[]): string | null {
  return flattenCensusEvents(items)[0]?.id ?? null;
}

function scrollToDomId(domId: string | null) {
  if (domId === null) return;
  document.getElementById(domId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * The interactive jump list DayThread renders alongside its own log. A SINGLE element whose
 * layout direction flips responsively — a sticky vertical rail at ≥1280 (`xl:`), a horizontal
 * chip row below it — rather than two parallel DOM trees, so assistive tech never sees the
 * same four buttons twice.
 */
export function DayCensus({ items, className }: { items: ThreadItem[]; className?: string }) {
  const counts = computeCensus(items);
  const targets: Array<{ label: string; count: number; domId: string | null }> = [
    {
      label: 'Emergency',
      count: counts.emergency,
      domId:
        firstMatch(items, 'emergency') === null ? null : `event-${firstMatch(items, 'emergency')}`,
    },
    {
      label: 'Important',
      count: counts.important,
      domId:
        firstMatch(items, 'important') === null ? null : `event-${firstMatch(items, 'important')}`,
    },
    {
      label: 'Messages',
      count: counts.messages,
      domId: firstMessageId(items) === null ? null : `message-${firstMessageId(items)}`,
    },
    {
      label: 'Events',
      count: counts.events,
      domId: firstEventId(items) === null ? null : `event-${firstEventId(items)}`,
    },
  ];

  return (
    <nav
      aria-label="Jump to"
      className={
        'flex flex-wrap gap-2 xl:sticky xl:top-20 xl:w-44 xl:shrink-0 xl:flex-col xl:gap-2' +
        (className === undefined ? '' : ` ${className}`)
      }
    >
      {targets.map((target) => (
        <button
          key={target.label}
          type="button"
          disabled={target.count === 0}
          onClick={() => scrollToDomId(target.domId)}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 text-sm font-medium text-[var(--color-ink-secondary)] hover:bg-[var(--color-surface-hover)] focus-visible:focus-inset disabled:cursor-not-allowed disabled:opacity-40 xl:justify-between"
        >
          <span className="tabular-nums">{target.count}</span>
          <span>{target.label}</span>
        </button>
      ))}
    </nav>
  );
}
