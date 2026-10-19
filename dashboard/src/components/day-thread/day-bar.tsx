'use client';

import { useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { DayPickerCalendar, type CalendarDayLink } from '@/components/day-picker-calendar';
import type { DayCensusCounts } from './day-census';

/*
 * day-bar.tsx — the day-stepper + census line above the thread (DESIGN-SPEC.md §4.0, §4.1).
 * Frozen export (§5 Lane C): `<DayBar dayLinks selectedDay census onPrev onNext />`.
 *
 * Day-to-day navigation is a real `<Link>` (works without JS, matches the rest of the app's
 * URL-driven pattern) bounded to the record window, the same way `day-picker-calendar.tsx`
 * bounds month navigation. `onPrev`/`onNext` are OPTIONAL supplementary hooks a caller can use
 * for side effects (e.g. focus management) — DayBar navigates correctly with or without them.
 *
 * The calendar (A6) is now a POPOVER triggered by the 📅 button rather than something laid out
 * beside the header — see the note in `day-picker-calendar.tsx`.
 */

const DAY_LABEL = new Intl.DateTimeFormat('en', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

function addDaysIso(localDate: string, delta: number): string {
  const instant = new Date(`${localDate}T00:00:00.000Z`).valueOf() + delta * 86_400_000;
  return new Date(instant).toISOString().slice(0, 10);
}

export interface DayBarProps {
  dayLinks: CalendarDayLink[];
  selectedDay: string;
  census: DayCensusCounts;
  onPrev?: () => void;
  onNext?: () => void;
}

export function DayBar({ dayLinks, selectedDay, census, onPrev, onNext }: DayBarProps) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const byDate = new Map(dayLinks.map((day) => [day.localDate, day]));
  const prevLink = byDate.get(addDaysIso(selectedDay, -1)) ?? null;
  const nextLink = byDate.get(addDaysIso(selectedDay, 1)) ?? null;
  const dayLabel = DAY_LABEL.format(new Date(`${selectedDay}T00:00:00.000Z`));

  return (
    <div className="relative rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--elev-1)] sm:p-5">
      <div className="flex flex-wrap items-center gap-1">
        <nav aria-label="Change day" className="flex items-center gap-1">
          {prevLink === null ? (
            <span
              aria-hidden="true"
              className="inline-flex min-h-11 min-w-11 items-center justify-center text-[var(--color-ink-muted)] opacity-40"
            >
              <ChevronLeft size={18} />
            </span>
          ) : (
            <Link
              href={prevLink.href}
              onClick={onPrev}
              aria-label={`Previous day, ${prevLink.localDate}`}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)] focus-visible:focus-inset"
            >
              <ChevronLeft aria-hidden="true" size={18} />
            </Link>
          )}
          <p className="min-w-0 px-1 text-lg font-semibold tracking-heading text-[var(--color-ink)]">
            {dayLabel}
          </p>
          {nextLink === null ? (
            <span
              aria-hidden="true"
              className="inline-flex min-h-11 min-w-11 items-center justify-center text-[var(--color-ink-muted)] opacity-40"
            >
              <ChevronRight size={18} />
            </span>
          ) : (
            <Link
              href={nextLink.href}
              onClick={onNext}
              aria-label={`Next day, ${nextLink.localDate}`}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)] focus-visible:focus-inset"
            >
              <ChevronRight aria-hidden="true" size={18} />
            </Link>
          )}
        </nav>
        <button
          type="button"
          aria-expanded={calendarOpen}
          aria-label="Open calendar"
          onClick={() => setCalendarOpen((open) => !open)}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)] focus-visible:focus-inset"
        >
          <CalendarDays aria-hidden="true" size={18} />
        </button>
      </div>
      <p className="mt-2 text-sm text-[var(--color-ink-muted)]">
        <span className="tabular-nums">{census.emergency}</span> emergency ·{' '}
        <span className="tabular-nums">{census.important}</span> important ·{' '}
        <span className="tabular-nums">{census.messages}</span> messages ·{' '}
        <span className="tabular-nums">{census.events}</span> events
      </p>
      {calendarOpen && (
        <div className="absolute left-0 top-full z-10 mt-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--elev-3)]">
          <DayPickerCalendar days={dayLinks} />
        </div>
      )}
    </div>
  );
}
