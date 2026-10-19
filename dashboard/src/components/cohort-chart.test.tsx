// @vitest-environment jsdom
//
// 06-03b — CohortChart (DASH-03 / D4 / D8). Logic-focused per the D9 posture:
// Recharts' SVG internals are unreliable under jsdom, so we assert the bucket
// mapping, the null-safe rate summary, the accessible role="img"+aria-label, the
// M13-named custom legend, and the empty-series state — never SVG paths.
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CohortChart, summarizeCohort, toChartData, type CohortDay } from './cohort-chart';

const { areaChartMock, areaMock } = vi.hoisted(() => ({
  areaChartMock: vi.fn(),
  areaMock: vi.fn(),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AreaChart: ({ children, ...props }: { children: ReactNode }) => {
    areaChartMock(props);
    return <svg data-testid="recharts-area-chart">{children}</svg>;
  },
  Area: (props: Record<string, unknown>) => {
    areaMock(props);
    return null;
  },
  CartesianGrid: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

// Recharts' ResponsiveContainer needs ResizeObserver, which jsdom does not provide.
// A no-op stub keeps the component from throwing; the chart renders empty (0-size)
// while our assertions target the surrounding accessible DOM, not the SVG.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver =
  globalThis.ResizeObserver ?? (ResizeObserverStub as unknown as typeof ResizeObserver);

const SERIES: CohortDay[] = [
  {
    day: '2026-07-01',
    delivered: 10,
    responded: 8,
    confirmed: 6,
    taken_delayed: 5,
    ambiguous: 2,
    non_response: 2,
    adherence_rate: 5 / 6,
    response_rate: 0.8,
  },
  {
    day: '2026-07-02',
    delivered: 5,
    responded: 5,
    confirmed: 4,
    taken_delayed: 4,
    ambiguous: 1,
    non_response: 0,
    adherence_rate: 1,
    response_rate: 1,
  },
];

// A day with doses but nothing delivered/scored — both denominators are zero.
const ZERO_SERIES: CohortDay[] = [
  {
    day: '2026-07-03',
    delivered: 0,
    responded: 0,
    confirmed: 0,
    taken_delayed: 0,
    ambiguous: 0,
    non_response: 0,
    adherence_rate: null,
    response_rate: null,
  },
];

describe('toChartData — API counts → four exhaustive check-in outcome buckets', () => {
  it('maps non_response → noResponse and preserves confirmed/ambiguous per day (M13)', () => {
    expect(toChartData(SERIES)[0]).toMatchObject({
      day: '2026-07-01',
      confirmed: 6,
      ambiguous: 2,
      noResponse: 2,
      unresolved: 0,
      adherencePct: expect.closeTo((5 / 6) * 100),
    });
  });

  it('keeps the API gaps (does not zero-fill missing days — D8)', () => {
    expect(toChartData(SERIES)).toHaveLength(SERIES.length);
    expect(toChartData([])).toEqual([]);
  });
});

describe('summarizeCohort — null-safe aggregate rates', () => {
  it('aggregates adherence-among-responses and response-rate across days', () => {
    const s = summarizeCohort(SERIES);
    expect(s.adherencePct).toBeCloseTo(9 / 10); // (5+4) taken_delayed / (6+4) confirmed
    expect(s.responsePct).toBeCloseTo(13 / 15); // (8+5) responded / (10+5) delivered
  });

  it('returns null (never NaN) when a denominator is zero', () => {
    expect(summarizeCohort(ZERO_SERIES)).toEqual({ adherencePct: null, responsePct: null });
  });
});

describe('CohortChart — accessible render', () => {
  it('matches the handoff analytics hierarchy without inventing metrics', () => {
    render(<CohortChart series={SERIES} />);
    expect(screen.getByRole('heading', { name: /adherence trend/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'All check-in outcomes' })).toBeInTheDocument();
    expect(
      screen.getByText(/denominator-eligible delivered check-ins after the response window/i),
    ).toBeInTheDocument();
    expect(screen.getByText('15 outcomes')).toBeInTheDocument();
  });

  it('keeps delivered rows without a resolved classification in an explicit operational bucket', () => {
    const unresolvedSeries: CohortDay[] = [
      {
        ...SERIES[0]!,
        delivered: 12,
      },
    ];
    render(<CohortChart series={unresolvedSeries} />);
    expect(screen.getByText('12 outcomes')).toBeInTheDocument();
    const unresolved = screen.getByText('unresolved delivery');
    expect(unresolved).toBeInTheDocument();
    expect(unresolved.closest('li')).toHaveTextContent('2 · 17%');
    expect(screen.getByText(/delivered but not yet resolved/i)).toBeInTheDocument();
  });

  it('names the outcome buckets without implying confirmed adherence', () => {
    render(<CohortChart series={SERIES} />);
    const confirmedResponse = screen.getByText('confirmed response');
    expect(confirmedResponse).toBeInTheDocument();
    expect(confirmedResponse.firstElementChild).toHaveStyle({
      backgroundColor: 'var(--color-info-700)',
    });
    // C7 — colour is never the only categorical channel: each outcome swatch also carries
    // a shape/glyph, at the ≥12px legibility floor (A7).
    expect(confirmedResponse.firstElementChild).toHaveClass('size-3.5');
    expect(confirmedResponse.firstElementChild?.querySelector('svg')).toBeInTheDocument();
    expect(screen.queryByText('confirmed')).toBeNull();
    expect(screen.getByText('ambiguous')).toBeInTheDocument();
    expect(screen.getByText('no response')).toBeInTheDocument();
  });

  it('exposes role="img" with an aria-label summarizing adherence and response rate', () => {
    render(<CohortChart series={SERIES} windowDays={7} />);
    const img = screen.getByRole('img');
    const label = img.getAttribute('aria-label') ?? '';
    expect(label).toMatch(/7-day cohort adherence chart/i);
    expect(label).toContain('90%'); // 9/10 adherence among responses
    expect(label).toMatch(/adherence among confirmed responses/i);
    expect(label).toMatch(/response rate/i);
    expect(screen.getAllByText(/adherence among confirmed responses/i).length).toBeGreaterThan(0);
  });

  it('renders the required accessible Recharts trend without connecting missing values', () => {
    const { container } = render(<CohortChart series={SERIES} />);
    const chart = screen.getByTestId('adherence-chart');
    expect(chart).toHaveClass('min-w-[720px]');
    expect(screen.getByRole('region', { name: /scrollable adherence chart/i })).toHaveClass(
      'overflow-x-auto',
    );
    expect(container.firstElementChild).toHaveClass('min-w-0');
    expect(screen.getByRole('img').closest('section')).toHaveClass('min-w-0');
    expect(screen.getByTestId('recharts-area-chart')).toBeInTheDocument();
    expect(areaChartMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ accessibilityLayer: true, data: toChartData(SERIES) }),
    );
    expect(areaMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dataKey: 'adherencePct',
        connectNulls: false,
        isAnimationActive: false,
      }),
    );
  });

  it('labels the wide chart as keyboard-scrollable and shows a mobile cue', () => {
    render(<CohortChart series={SERIES} />);
    expect(screen.getByText(/scroll horizontally to inspect all dates/i)).not.toHaveClass(
      'sm:hidden',
    );
    expect(screen.getByRole('region', { name: /scrollable adherence chart/i })).toHaveAttribute(
      'tabindex',
      '0',
    );
  });

  it('exposes date-level adherence values in a structured text alternative', () => {
    render(<CohortChart series={SERIES} />);
    const table = screen.getByRole('table', { name: /daily adherence data/i });
    expect(table).not.toHaveClass('sr-only');
    expect(table.parentElement).toHaveClass('sr-only', '[contain:paint]');
    expect(within(table).getByText('Jul 1')).toBeInTheDocument();
    expect(within(table).getByText('83%')).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(3);
  });

  it('renders an em-dash (never NaN) when the rate denominators are zero', () => {
    const { container } = render(<CohortChart series={ZERO_SERIES} />);
    expect(container.textContent ?? '').toContain('—');
    expect(container.textContent ?? '').not.toContain('NaN');
    expect(screen.getByRole('img').getAttribute('aria-label') ?? '').not.toContain('NaN');
  });

  it('renders a friendly empty state (no chart) when the series is empty', () => {
    render(<CohortChart series={[]} />);
    expect(screen.getByRole('heading', { name: /no dose activity yet/i })).toBeInTheDocument();
    expect(screen.getByText(/first scheduled check-in/i)).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
