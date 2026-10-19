// @vitest-environment jsdom
//
// Logic-focused per the D9 posture established by cohort-chart.test.tsx: Recharts' SVG
// internals are unreliable under jsdom, so these assert the pivot, the series wiring, the
// accessible role="img" wrapper, the screen-reader table and the empty states — never SVG.
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  AdherenceOutcomeChart,
  SymptomSeverityChart,
  toSeverityChartData,
} from './patient-trend-charts';
import type { PatientTrends } from '@/lib/dashboard-contracts';

const { lineMock, barMock, yAxisMock } = vi.hoisted(() => ({
  lineMock: vi.fn(),
  barMock: vi.fn(),
  yAxisMock: vi.fn(),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: ReactNode }) => (
    <svg data-testid="recharts-line-chart">{children}</svg>
  ),
  BarChart: ({ children }: { children: ReactNode }) => (
    <svg data-testid="recharts-bar-chart">{children}</svg>
  ),
  Line: (props: Record<string, unknown>) => {
    lineMock(props);
    return null;
  },
  Bar: (props: Record<string, unknown>) => {
    barMock(props);
    return null;
  },
  CartesianGrid: () => null,
  Legend: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: (props: Record<string, unknown>) => {
    yAxisMock(props);
    return null;
  },
}));

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver =
  globalThis.ResizeObserver ?? (ResizeObserverStub as unknown as typeof ResizeObserver);

const SEVERITY: PatientTrends['severity'] = [
  { local_date: '2026-08-10', symptom: 'headache', max_severity: 4, observation_count: 2 },
  { local_date: '2026-08-11', symptom: 'headache', max_severity: 8, observation_count: 3 },
  { local_date: '2026-08-11', symptom: 'nausea', max_severity: 2, observation_count: 1 },
];

const ADHERENCE: PatientTrends['adherence'] = [
  {
    local_date: '2026-08-10',
    taken: 2,
    delayed: 1,
    skipped: 0,
    stopped: 0,
    unknown: 0,
    question: 0,
  },
  {
    local_date: '2026-08-11',
    taken: 1,
    delayed: 0,
    skipped: 1,
    stopped: 0,
    unknown: 1,
    question: 0,
  },
];

describe('toSeverityChartData', () => {
  it('pivots one row per day with one key per symptom', () => {
    const { data, symptoms } = toSeverityChartData(SEVERITY);

    expect(symptoms).toEqual(['headache', 'nausea']);
    expect(data).toEqual([
      { day: '2026-08-10', headache: 4 },
      { day: '2026-08-11', headache: 8, nausea: 2 },
    ]);
  });

  it('leaves an unobserved symptom absent rather than zero-filling it', () => {
    const { data } = toSeverityChartData(SEVERITY);

    expect(data[0]).not.toHaveProperty('nausea');
  });

  it('keeps days in calendar order regardless of input order', () => {
    const { data } = toSeverityChartData([...SEVERITY].reverse());

    expect(data.map((point) => point.day)).toEqual(['2026-08-10', '2026-08-11']);
  });

  it('inserts a gap when no symptom was observed on the intervening day', () => {
    const { data } = toSeverityChartData([
      { local_date: '2026-08-10', symptom: 'headache', max_severity: 4, observation_count: 1 },
      { local_date: '2026-08-12', symptom: 'headache', max_severity: 7, observation_count: 1 },
    ]);

    expect(data).toEqual([
      { day: '2026-08-10', headache: 4 },
      { day: '2026-08-11' },
      { day: '2026-08-12', headache: 7 },
    ]);
  });

  it('keeps the worst severity when a day reports the same symptom twice', () => {
    const { data } = toSeverityChartData([
      ...SEVERITY,
      {
        local_date: '2026-08-11',
        symptom: 'headache',
        max_severity: 5,
        observation_count: 1,
      },
    ]);

    expect(data[1]?.headache).toBe(8);
  });
});

describe('SymptomSeverityChart', () => {
  it('draws one line per symptom and never bridges a day with no observation', () => {
    render(<SymptomSeverityChart series={SEVERITY} />);

    const drawn = lineMock.mock.calls.map(([props]) => props as Record<string, unknown>);
    expect(drawn.map((props) => props.dataKey)).toEqual(['headache', 'nausea']);
    for (const props of drawn) {
      expect(props.connectNulls).toBe(false);
      expect(String(props.stroke)).toMatch(/^var\(--color-/);
    }
  });

  it('uses the contract 1-to-10 scale without implying zero severity', () => {
    render(<SymptomSeverityChart series={SEVERITY} />);

    const axis = yAxisMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(axis.domain).toEqual([1, 10]);
    expect(axis.ticks).not.toContain(0);
  });

  it('exposes the chart as an image with a summary a screen reader can read', () => {
    render(<SymptomSeverityChart series={SEVERITY} />);

    const chart = screen.getByRole('img', { name: /worst symptom severity/i });
    expect(chart).toBeInTheDocument();
    expect(chart.getAttribute('aria-label')).toMatch(/2 symptoms/);
  });

  it('exposes every dated value in a screen-reader table, not just the picture', () => {
    render(<SymptomSeverityChart series={SEVERITY} />);

    const table = screen.getByRole('table', { name: /worst symptom severity by day/i });
    expect(within(table).getByRole('columnheader', { name: 'headache' })).toBeVisible();
    expect(within(table).getByRole('rowheader', { name: '2026-08-11' })).toBeVisible();
    expect(
      within(table)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toContain('8');
  });

  it('says a day had no observation instead of printing a zero severity', () => {
    render(<SymptomSeverityChart series={SEVERITY} />);

    const table = screen.getByRole('table', { name: /worst symptom severity by day/i });
    expect(
      within(table)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toContain('Not reported');
  });

  it('shows an empty state when no symptom was ever reported', () => {
    render(<SymptomSeverityChart series={[]} />);

    expect(screen.getByText(/no symptom reported yet/i)).toBeInTheDocument();
  });

  it('collapses to a one-line status when empty and expands when data exists', () => {
    const empty = render(<SymptomSeverityChart series={[]} />);
    expect(empty.container.querySelector('details')).not.toHaveAttribute('open');
    expect(screen.getByText('No data yet')).toBeInTheDocument();
    empty.unmount();

    const withData = render(<SymptomSeverityChart series={SEVERITY} />);
    expect(withData.container.querySelector('details')).toHaveAttribute('open');
    expect(screen.getByText(/2 symptoms · \d+ observed days/)).toBeInTheDocument();
  });

  it('renders the one shared ChartLegend (C7) with a toggle per symptom that hides its line', () => {
    render(<SymptomSeverityChart series={SEVERITY} />);

    const legend = screen.getByRole('list', { name: /symptom series/i });
    const headacheToggle = within(legend).getByRole('button', { name: /headache/i });
    expect(headacheToggle).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(headacheToggle);
    expect(headacheToggle).toHaveAttribute('aria-pressed', 'false');
    const hiddenLine = lineMock.mock.calls
      .map(([props]) => props as Record<string, unknown>)
      .reverse()
      .find((props) => props.dataKey === 'headache');
    expect(hiddenLine?.hide).toBe(true);
  });

  it('gives each symptom series a parallel dash pattern so a repeated colour still disambiguates (A11)', () => {
    const sixSymptoms = Array.from({ length: 7 }, (_, index) => ({
      local_date: '2026-08-10',
      symptom: `symptom-${index}`,
      max_severity: 5,
      observation_count: 1,
    }));
    lineMock.mockClear();
    render(<SymptomSeverityChart series={sixSymptoms} />);

    const drawn = lineMock.mock.calls.map(([props]) => props as Record<string, unknown>);
    // 7 symptoms wrap the 6-colour cycle (symptom-6 repeats symptom-0's colour); the dash cycle
    // is a different length so the two never repeat their FULL (colour, dash) pair together.
    expect(drawn[0]?.stroke).toBe(drawn[6]?.stroke);
    expect(drawn[0]?.strokeDasharray).not.toBe(drawn[6]?.strokeDasharray);
  });
});

describe('AdherenceOutcomeChart', () => {
  it('draws one stacked bar per adherence outcome, coloured from tokens only', () => {
    render(<AdherenceOutcomeChart series={ADHERENCE} />);

    const drawn = barMock.mock.calls.map(([props]) => props as Record<string, unknown>);
    expect(drawn.map((props) => props.dataKey)).toEqual([
      'taken',
      'delayed',
      'skipped',
      'stopped',
      'unknown',
      'question',
    ]);
    for (const props of drawn) {
      expect(props.stackId).toBe('outcomes');
      expect(String(props.fill)).toMatch(/^var\(--color-/);
    }
  });

  it('exposes the chart as an image with a summary a screen reader can read', () => {
    render(<AdherenceOutcomeChart series={ADHERENCE} />);

    const chart = screen.getByRole('img', { name: /daily adherence outcomes/i });
    expect(chart.getAttribute('aria-label')).toMatch(/2 days/);
  });

  it('exposes every dated count in a screen-reader table', () => {
    render(<AdherenceOutcomeChart series={ADHERENCE} />);

    const table = screen.getByRole('table', { name: /adherence outcomes by day/i });
    expect(within(table).getByRole('columnheader', { name: 'taken' })).toBeVisible();
    expect(within(table).getByRole('rowheader', { name: '2026-08-10' })).toBeVisible();
  });

  it('shows an empty state when no dose has an outcome yet', () => {
    render(<AdherenceOutcomeChart series={[]} />);

    expect(screen.getByText(/no adherence outcome yet/i)).toBeInTheDocument();
  });

  it('collapses to a one-line status when empty and expands when data exists', () => {
    const empty = render(<AdherenceOutcomeChart series={[]} />);
    expect(empty.container.querySelector('details')).not.toHaveAttribute('open');
    expect(screen.getByText('No data yet')).toBeInTheDocument();
    empty.unmount();

    const withData = render(<AdherenceOutcomeChart series={ADHERENCE} />);
    expect(withData.container.querySelector('details')).toHaveAttribute('open');
    expect(screen.getByText(/outcomes · 2 days/)).toBeInTheDocument();
  });

  it('renders the one shared ChartLegend (C7) with a toggle per outcome that hides its bar', () => {
    render(<AdherenceOutcomeChart series={ADHERENCE} />);

    const legend = screen.getByRole('list', { name: /adherence outcome series/i });
    const takenToggle = within(legend).getByRole('button', { name: /^taken/i });
    fireEvent.click(takenToggle);
    expect(takenToggle).toHaveAttribute('aria-pressed', 'false');
    const hiddenBar = barMock.mock.calls
      .map(([props]) => props as Record<string, unknown>)
      .reverse()
      .find((props) => props.dataKey === 'taken');
    expect(hiddenBar?.hide).toBe(true);
  });
});
