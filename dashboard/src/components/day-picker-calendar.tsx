'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';

/*
 * day-picker-calendar.tsx — the compact month calendar that replaced the flat grid of
 * ~30 date buttons in the selected-day summary header.
 *
 * Every in-window day is a real `<Link>` carrying the SAME `?days=N&day=YYYY-MM-DD` href
 * the old buttons carried, so the server-rendered summary flow is untouched. Days outside
 * the record window are inert, muted text. A dot marks days that already have a summary;
 * the patient-local "today" (the last day of the window, by the server's window contract)
 * gets a subtle accent marker; the selected day keeps the accent-filled active state.
 *
 * 'use client' ONLY for the displayed-month state: prev/next flip months locally without a
 * server round-trip, bounded to the months the record window touches. Navigation itself is
 * still plain links.
 *
 * The displayed month is SEEDED from the selected day, not derived from it — `useState`'s
 * initializer runs once per mount, and an App Router soft navigation re-renders this component
 * rather than remounting it. Re-centring on a newly selected day therefore depends on the
 * caller keying this element by the URL day/window (see patients/[id]/page.tsx); without that
 * key the displayed month keeps whatever the clinician last paged to and can contradict the URL.
 *
 * A6 (DESIGN-SPEC.md §3.5): the pre-redesign overflow was never this component's own intrinsic
 * width (7×36px cells + 6×8px gaps = 300px, well under any real viewport) — it came from being
 * laid out INLINE beside the day-view header's other content. `day-thread/day-bar.tsx` now
 * mounts this calendar inside a popover instead, so it never again shares a row with anything
 * else; the fix is relocation, not a cell-size change (§1.5's `size-9` cells stay, as documented
 * below, correct and deliberate).
 */

export interface CalendarDayLink {
  localDate: string;
  href: string;
  selected: boolean;
  hasSummary: boolean;
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;

const MONTH_LABEL = new Intl.DateTimeFormat('en', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const FULL_DATE_LABEL = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'full',
  timeZone: 'UTC',
});

/** Months as `year * 12 + (month - 1)` so prev/next and bounds are plain integer math. */
function monthIndexOf(localDate: string): number {
  return Number(localDate.slice(0, 4)) * 12 + (Number(localDate.slice(5, 7)) - 1);
}

function isoDate(monthIndex: number, day: number): string {
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(monthIndex: number): number {
  return new Date(Date.UTC(Math.floor(monthIndex / 12), (monthIndex % 12) + 1, 0)).getUTCDate();
}

function firstWeekday(monthIndex: number): number {
  return new Date(Date.UTC(Math.floor(monthIndex / 12), monthIndex % 12, 1)).getUTCDay();
}

function utcDate(localDate: string): Date {
  return new Date(`${localDate}T00:00:00.000Z`);
}

function addDays(localDate: string, delta: number): string {
  return new Date(utcDate(localDate).valueOf() + delta * 86_400_000).toISOString().slice(0, 10);
}

const ARROW_DELTAS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -7,
  ArrowDown: 7,
};

export function DayPickerCalendar({ days }: { days: CalendarDayLink[] }) {
  const byDate = new Map(days.map((day) => [day.localDate, day]));
  const dates = days.map((day) => day.localDate).sort();
  const windowStart = dates[0] ?? '';
  // The record window always ends on the patient-local today (server window contract).
  const today = dates[dates.length - 1] ?? '';
  const selected = days.find((day) => day.selected)?.localDate ?? today;

  const minMonth = monthIndexOf(windowStart);
  const maxMonth = monthIndexOf(today);
  const [month, setMonth] = useState(() => monthIndexOf(selected));

  if (days.length === 0) return null;

  const leadingBlanks = firstWeekday(month);
  const dayNumbers = Array.from({ length: daysInMonth(month) }, (_, index) => index + 1);

  /*
   * Arrow keys move focus between the visible month's in-window day links (±1 day
   * horizontally, ±7 vertically). Tab order stays the native link order — every day link is
   * tabbable — so this is an enhancement, not a roving-tabindex requirement.
   */
  function moveFocus(event: React.KeyboardEvent<HTMLAnchorElement>) {
    const delta = ARROW_DELTAS[event.key];
    const current = event.currentTarget.getAttribute('data-date');
    if (delta === undefined || current === null) return;
    const target = event.currentTarget.parentElement?.querySelector<HTMLAnchorElement>(
      `[data-date="${addDays(current, delta)}"]`,
    );
    if (target != null) {
      event.preventDefault();
      target.focus();
    }
  }

  return (
    <nav aria-label="Select a summarised day" className="w-fit max-w-full">
      <div className="flex items-center justify-between gap-1">
        <button
          type="button"
          aria-label="Previous month"
          disabled={month <= minMonth}
          onClick={() => setMonth((current) => current - 1)}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-ink-muted)] transition-transform duration-[var(--motion-fast)] ease-[var(--ease-sharp)] enabled:active:scale-[0.97] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)] focus-visible:focus-inset disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <ChevronLeft aria-hidden="true" size={16} />
        </button>
        <p aria-live="polite" className="text-sm font-semibold text-[var(--color-ink)]">
          {MONTH_LABEL.format(utcDate(isoDate(month, 1)))}
        </p>
        <button
          type="button"
          aria-label="Next month"
          disabled={month >= maxMonth}
          onClick={() => setMonth((current) => current + 1)}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-ink-muted)] transition-transform duration-[var(--motion-fast)] ease-[var(--ease-sharp)] enabled:active:scale-[0.97] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)] focus-visible:focus-inset disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <ChevronRight aria-hidden="true" size={16} />
        </button>
      </div>

      {/* gap-2 (8px) is load-bearing, not spacing taste: each day link expands its hit area with
          a 4px `before:-inset-1` halo, so a gap under 8px lets one day's halo sit over its
          neighbour's visible box and edge clicks navigate to the wrong day. At 8px the halos
          meet exactly at the gap midline. */}
      <div className="mt-1 grid grid-cols-7 gap-2">
        {WEEKDAYS.map((weekday, index) => (
          <span
            key={`${weekday}-${index}`}
            aria-hidden="true"
            className="flex size-9 items-center justify-center font-[family-name:var(--font-mono)] text-xs font-medium uppercase tracking-mono text-[var(--color-ink-muted)]"
          >
            {weekday}
          </span>
        ))}
        {Array.from({ length: leadingBlanks }, (_, index) => (
          <span key={`blank-${index}`} aria-hidden="true" className="size-9" />
        ))}
        {dayNumbers.map((dayNumber) => {
          const date = isoDate(month, dayNumber);
          const link = byDate.get(date);
          if (link === undefined) {
            return (
              <span
                key={date}
                aria-hidden="true"
                className="flex size-9 items-center justify-center rounded-[var(--radius-md)] text-sm tabular-nums text-[var(--color-ink-muted)] opacity-40"
              >
                {dayNumber}
              </span>
            );
          }
          const isToday = date === today;
          const label = `${FULL_DATE_LABEL.format(utcDate(date))}${isToday ? ' (today)' : ''}${
            link.hasSummary ? ', summary available' : ''
          }`;
          return (
            <Link
              key={date}
              href={link.href}
              data-date={date}
              onKeyDown={moveFocus}
              aria-label={label}
              aria-current={link.selected ? 'date' : undefined}
              className={`relative flex size-9 items-center justify-center rounded-[var(--radius-md)] text-sm font-semibold tabular-nums transition-transform duration-[var(--motion-fast)] ease-[var(--ease-sharp)] before:absolute before:-inset-1 before:content-[''] focus-visible:focus-inset active:scale-[0.97] ${
                link.selected
                  ? 'border border-[var(--color-accent)] bg-[var(--color-accent-50)] text-[var(--color-accent)]'
                  : isToday
                    ? 'font-bold text-[var(--color-accent)] hover:bg-[var(--color-surface-hover)]'
                    : 'text-[var(--color-ink)] hover:bg-[var(--color-surface-hover)]'
              }`}
            >
              {dayNumber}
              {link.hasSummary && (
                <span
                  aria-hidden="true"
                  className="absolute bottom-1 left-1/2 size-1 -translate-x-1/2 rounded-full bg-[var(--color-accent)]"
                />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
