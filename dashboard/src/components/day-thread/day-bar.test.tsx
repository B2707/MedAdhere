// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DayBar } from './day-bar';
import type { CalendarDayLink } from '@/components/day-picker-calendar';
import type { DayCensusCounts } from './day-census';

function dayLinks(): CalendarDayLink[] {
  const days: CalendarDayLink[] = [];
  for (let day = 9; day <= 13; day += 1) {
    const localDate = `2026-08-${String(day).padStart(2, '0')}`;
    days.push({
      localDate,
      href: `/patients/p1?days=30&day=${localDate}`,
      selected: localDate === '2026-08-11',
      hasSummary: false,
    });
  }
  return days;
}

function census(overrides: Partial<DayCensusCounts> = {}): DayCensusCounts {
  return { emergency: 2, important: 1, messages: 14, events: 6, ...overrides };
}

describe('DayBar', () => {
  it('names the selected day and shows the merged-thread census as plain text', () => {
    render(<DayBar dayLinks={dayLinks()} selectedDay="2026-08-11" census={census()} />);

    expect(screen.getByText(/tue.*aug.*11.*2026/i)).toBeInTheDocument();
    const censusLine = document.querySelector('p.text-sm')?.textContent ?? '';
    expect(censusLine).toMatch(/2\s*emergency/i);
    expect(censusLine).toMatch(/1\s*important/i);
    expect(censusLine).toMatch(/14\s*messages/i);
    expect(censusLine).toMatch(/6\s*events/i);
  });

  it('links the previous and next day within the window', () => {
    render(<DayBar dayLinks={dayLinks()} selectedDay="2026-08-11" census={census()} />);

    expect(screen.getByRole('link', { name: /previous day, 2026-08-10/i })).toHaveAttribute(
      'href',
      '/patients/p1?days=30&day=2026-08-10',
    );
    expect(screen.getByRole('link', { name: /next day, 2026-08-12/i })).toHaveAttribute(
      'href',
      '/patients/p1?days=30&day=2026-08-12',
    );
  });

  it('disables stepping past the record window instead of linking off it', () => {
    render(<DayBar dayLinks={dayLinks()} selectedDay="2026-08-09" census={census()} />);

    expect(screen.queryByRole('link', { name: /previous day/i })).toBeNull();
  });

  it('calls the optional onPrev/onNext hooks without blocking real navigation', () => {
    const onPrev = vi.fn();
    render(
      <DayBar dayLinks={dayLinks()} selectedDay="2026-08-11" census={census()} onPrev={onPrev} />,
    );

    fireEvent.click(screen.getByRole('link', { name: /previous day/i }));
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it('opens the day-picker calendar from the calendar button', () => {
    render(<DayBar dayLinks={dayLinks()} selectedDay="2026-08-11" census={census()} />);

    expect(screen.queryByRole('navigation', { name: /select a summarised day/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /open calendar/i }));
    expect(
      screen.getByRole('navigation', { name: /select a summarised day/i }),
    ).toBeInTheDocument();
  });
});
