// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DayPickerCalendar, type CalendarDayLink } from './day-picker-calendar';

/** A 2026-07-28 → 2026-08-11 window (spans two months); selected 2026-08-10. */
function windowDays(): CalendarDayLink[] {
  const days: CalendarDayLink[] = [];
  for (const [month, from, to] of [
    ['07', 28, 31],
    ['08', 1, 11],
  ] as const) {
    for (let day = from; day <= to; day += 1) {
      const localDate = `2026-${month}-${String(day).padStart(2, '0')}`;
      days.push({
        localDate,
        href: `/patients/p1?days=30&day=${localDate}`,
        selected: localDate === '2026-08-10',
        hasSummary: localDate === '2026-08-11' || localDate === '2026-07-30',
      });
    }
  }
  return days;
}

/** A 2026-12-28 → 2027-01-05 window (spans the year seam); selected 2027-01-02. */
function yearSeamDays(): CalendarDayLink[] {
  const days: CalendarDayLink[] = [];
  for (const [year, month, from, to] of [
    ['2026', '12', 28, 31],
    ['2027', '01', 1, 5],
  ] as const) {
    for (let day = from; day <= to; day += 1) {
      const localDate = `${year}-${month}-${String(day).padStart(2, '0')}`;
      days.push({
        localDate,
        href: `/patients/p1?days=30&day=${localDate}`,
        selected: localDate === '2027-01-02',
        hasSummary: false,
      });
    }
  }
  return days;
}

/** The rendered month grid: 7 weekday headers, then leading blanks, then the month's cells. */
function monthGridCells(): Element[] {
  const navigation = screen.getByRole('navigation', { name: /select a summarised day/i });
  const grid = navigation.querySelector('.grid-cols-7');
  return [...(grid?.children ?? [])];
}

/** Which weekday column a rendered day cell actually sits in ('Su'…'Sa'). */
function weekdayColumnOf(cell: Element): string | null {
  const cells = monthGridCells();
  const headers = cells.slice(0, 7).map((header) => header.textContent);
  return headers[(cells.indexOf(cell) - 7) % 7] ?? null;
}

describe('DayPickerCalendar', () => {
  it('renders the selected day’s month with a stable 7-column weekday header', () => {
    render(<DayPickerCalendar days={windowDays()} />);

    const navigation = screen.getByRole('navigation', { name: /select a summarised day/i });
    expect(within(navigation).getByText('August 2026')).toBeInTheDocument();
    const grid = within(navigation).getByText('August 2026').parentElement
      ?.nextElementSibling as HTMLElement;
    expect(grid).toHaveClass('grid-cols-7');
    const headers = [...grid.children].slice(0, 7).map((cell) => cell.textContent);
    expect(headers).toEqual(['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']);
  });

  it('links each in-window day with the exact existing query semantics', () => {
    render(<DayPickerCalendar days={windowDays()} />);

    const selected = screen.getByRole('link', { name: /monday, august 10, 2026/i });
    expect(selected).toHaveAttribute('href', '/patients/p1?days=30&day=2026-08-10');
    expect(selected).toHaveAttribute('aria-current', 'date');
    expect(screen.getByRole('link', { name: /sunday, august 9, 2026/i })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('marks today and summary days in the accessible name and disables out-of-window days', () => {
    render(<DayPickerCalendar days={windowDays()} />);

    const today = screen.getByRole('link', { name: /tuesday, august 11, 2026/i });
    expect(today.getAttribute('aria-label')).toMatch(/\(today\)/);
    expect(today.getAttribute('aria-label')).toMatch(/summary available/);
    // Aug 12 is after the window's end: rendered as inert muted text, never a link.
    expect(screen.queryByRole('link', { name: /august 12, 2026/i })).toBeNull();
    expect(
      screen.getByRole('link', { name: /sunday, august 9, 2026/i }).getAttribute('aria-label'),
    ).not.toMatch(/summary available/);
  });

  it('keeps day cells compact with an expanded 44px-class hit area', () => {
    render(<DayPickerCalendar days={windowDays()} />);

    const day = screen.getByRole('link', { name: /monday, august 10, 2026/i });
    expect(day).toHaveClass('size-9', 'before:-inset-1', 'relative');
  });

  it('bounds month navigation to the record window', () => {
    render(<DayPickerCalendar days={windowDays()} />);

    const previous = screen.getByRole('button', { name: /previous month/i });
    const next = screen.getByRole('button', { name: /next month/i });
    expect(next).toBeDisabled();
    expect(previous).toBeEnabled();

    fireEvent.click(previous);
    expect(screen.getByText('July 2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /previous month/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /next month/i })).toBeEnabled();
    const julySummaryDay = screen.getByRole('link', { name: /thursday, july 30, 2026/i });
    expect(julySummaryDay.getAttribute('aria-label')).toMatch(/summary available/);
    // July days before the 28th are outside the window.
    expect(screen.queryByRole('link', { name: /july 27, 2026/i })).toBeNull();
  });

  it('moves focus between day links with arrow keys without touching tab order', () => {
    render(<DayPickerCalendar days={windowDays()} />);

    const tenth = screen.getByRole('link', { name: /monday, august 10, 2026/i });
    tenth.focus();
    fireEvent.keyDown(tenth, { key: 'ArrowLeft' });
    expect(screen.getByRole('link', { name: /sunday, august 9, 2026/i })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('link', { name: /sunday, august 9, 2026/i }), {
      key: 'ArrowUp',
    });
    expect(screen.getByRole('link', { name: /sunday, august 2, 2026/i })).toHaveFocus();
  });

  it('keeps neighbouring hit-area halos from overlapping the next day’s visible box', () => {
    render(<DayPickerCalendar days={windowDays()} />);

    // size-9 (36px) + a 4px `before:-inset-1` halo per side needs an 8px gap: anything smaller
    // puts one day's halo over its neighbour, and edge clicks navigate to the wrong day.
    const grid = monthGridCells()[0]?.parentElement;
    expect(grid).toHaveClass('gap-2');
    expect(grid).not.toHaveClass('gap-0.5');
    expect(screen.getByRole('link', { name: /monday, august 10, 2026/i })).toHaveClass(
      'size-9',
      'before:-inset-1',
    );
  });

  it('aligns a known date under its real weekday column', () => {
    render(<DayPickerCalendar days={windowDays()} />);

    expect(weekdayColumnOf(screen.getByRole('link', { name: /monday, august 10, 2026/i }))).toBe(
      'Mo',
    );
    expect(weekdayColumnOf(screen.getByRole('link', { name: /saturday, august 1, 2026/i }))).toBe(
      'Sa',
    );
  });

  it('navigates and aligns correctly across the December → January year seam', () => {
    render(<DayPickerCalendar days={yearSeamDays()} />);

    expect(screen.getByText('January 2027')).toBeInTheDocument();
    // Jan 1 2027 is a Friday — the month-index math must not lose the year rollover.
    expect(weekdayColumnOf(screen.getByRole('link', { name: /friday, january 1, 2027/i }))).toBe(
      'Fr',
    );

    fireEvent.click(screen.getByRole('button', { name: /previous month/i }));
    expect(screen.getByText('December 2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /previous month/i })).toBeDisabled();
    expect(weekdayColumnOf(screen.getByRole('link', { name: /monday, december 28, 2026/i }))).toBe(
      'Mo',
    );
    expect(screen.queryByRole('link', { name: /december 27, 2026/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /next month/i }));
    expect(screen.getByText('January 2027')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next month/i })).toBeDisabled();
  });

  it('renders nothing when the window has no days', () => {
    const { container } = render(<DayPickerCalendar days={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
