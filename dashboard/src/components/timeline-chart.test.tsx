// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BarChart: ({
    children,
    accessibilityLayer,
  }: {
    children: ReactNode;
    accessibilityLayer: boolean;
  }) => (
    <div data-testid="bar-chart" data-accessibility-layer={String(accessibilityLayer)}>
      {children}
    </div>
  ),
  XAxis: ({ interval, minTickGap }: { interval?: string; minTickGap?: number }) => (
    <div data-testid="x-axis" data-interval={interval} data-min-tick-gap={String(minTickGap)} />
  ),
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Bar: ({ name, fill }: { name: string; fill: string }) => (
    <div data-testid="bar-series" data-name={name} data-fill={fill} />
  ),
}));
import {
  TIMELINE_BUCKETS,
  TimelineChart,
  toTimelineChartData,
  type TimelineRow,
} from './timeline-chart';

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver =
  globalThis.ResizeObserver ?? (ResizeObserverStub as unknown as typeof ResizeObserver);

const baseRow = {
  scheduled_at: '2026-07-01T13:00:00.000Z',
  dose_date: '2026-07-01',
  local_dose_time: '09:00:00',
  reason_code: 'none',
  is_late: false,
  label_matches: [],
} satisfies Omit<TimelineRow, 'dose_id' | 'status' | 'adherence_state' | 'decided_by'>;

function row(
  doseId: string,
  adherenceState: TimelineRow['adherence_state'],
  decidedBy: TimelineRow['decided_by'] = 'classifier',
  status: TimelineRow['status'] = 'recorded',
): TimelineRow {
  return {
    ...baseRow,
    dose_id: doseId,
    status,
    adherence_state: adherenceState,
    decided_by: decidedBy,
  };
}

const ROWS: TimelineRow[] = [
  row('taken', 'taken'),
  row('delayed', 'delayed'),
  row('skipped', 'skipped'),
  row('stopped', 'stopped'),
  row('unknown', 'unknown'),
  row('question', 'question'),
  row('timeout', 'unknown', 'timeout', 'missed'),
  row('pending', null, null, null),
];

describe('toTimelineChartData — D4/M13 timeline buckets', () => {
  it('maps classifier states into confirmed/ambiguous and timeout missed into no response', () => {
    const data = toTimelineChartData(ROWS);
    expect(data.map((point) => [point.doseId, point.bucket])).toEqual([
      ['taken', 'confirmedTaken'],
      ['delayed', 'confirmedTaken'],
      ['skipped', 'confirmedNotTaken'],
      ['stopped', 'confirmedNotTaken'],
      ['unknown', 'ambiguous'],
      ['question', 'ambiguous'],
      ['timeout', 'noResponse'],
    ]);
  });

  it('omits pending/no-record doses as gaps instead of zero-filling them', () => {
    const data = toTimelineChartData(ROWS);
    expect(data.find((point) => point.doseId === 'pending')).toBeUndefined();
    expect(data).toHaveLength(7);
  });

  it('uses distinct handoff colors while preserving clinical-honesty labels', () => {
    const buckets = Object.values(TIMELINE_BUCKETS);
    expect(new Set(buckets.map((bucket) => bucket.label))).toHaveLength(4);
    expect(new Set(buckets.map((bucket) => bucket.color))).toHaveLength(4);
    expect(TIMELINE_BUCKETS.confirmedNotTaken.label).not.toBe(
      TIMELINE_BUCKETS.confirmedTaken.label,
    );
    expect(TIMELINE_BUCKETS.confirmedTaken.color).toBe('var(--color-success-700)');
    expect(TIMELINE_BUCKETS.ambiguous.color).toBe('var(--color-warning-700)');
  });

  it('makes a null dose date explicit without silently presenting a UTC date as local', () => {
    const [point] = toTimelineChartData([{ ...row('legacy', 'taken'), dose_date: null }]);
    expect(point?.label).not.toContain('2026-07-01');
  });
});

describe('TimelineChart — accessible timeline and associative hints', () => {
  it('renders a role=img summary and an explicit four-bucket legend', () => {
    render(<TimelineChart rows={ROWS} />);
    expect(screen.getByRole('img')).toHaveAccessibleName(/adherence timeline/i);
    const legend = screen.getByRole('list', { name: /dose outcome legend/i });
    expect(within(legend).getByText('confirmed — taken/late')).toBeInTheDocument();
    expect(within(legend).getByText('confirmed — not taken (skipped/stopped)')).toBeInTheDocument();
    expect(within(legend).getByText('ambiguous response')).toBeInTheDocument();
    expect(within(legend).getByText('no response')).toBeInTheDocument();
    expect(within(legend).getByText('no response')).not.toHaveTextContent(
      /missed dose|non-adherent/i,
    );
  });

  it('renders the required Recharts dose timeline with one honest series per bucket', () => {
    render(<TimelineChart rows={ROWS} />);
    expect(screen.getByTestId('bar-chart')).toHaveAttribute('data-accessibility-layer', 'true');
    expect(screen.getByTestId('x-axis')).toHaveAttribute('data-interval', 'preserveStartEnd');
    expect(screen.getAllByTestId('bar-series')).toHaveLength(4);
    expect(
      screen.getAllByTestId('bar-series').map((series) => series.getAttribute('data-fill')),
    ).toEqual(Object.values(TIMELINE_BUCKETS).map((bucket) => bucket.color));
  });

  it('labels the wide timeline as keyboard-scrollable and shows a mobile cue', () => {
    render(<TimelineChart rows={ROWS} />);
    const scrollCue = screen.getByText(/scroll horizontally to inspect all doses/i);
    expect(scrollCue).toBeInTheDocument();
    expect(scrollCue).not.toHaveClass('sm:hidden');
    expect(screen.getByRole('region', { name: /scrollable dose timeline/i })).toHaveAttribute(
      'tabindex',
      '0',
    );
  });

  it('exposes each dated dose outcome in a structured text alternative', () => {
    render(<TimelineChart rows={ROWS} />);
    const table = screen.getByRole('table', { name: /dated dose outcomes/i });
    expect(table).not.toHaveClass('sr-only');
    expect(table.parentElement).toHaveClass('sr-only', '[contain:paint]');
    expect(within(table).getAllByRole('row')).toHaveLength(8);
    expect(
      within(table)
        .getAllByRole('row')
        .some((rowElement) => /2026-07-01 09:00.*no response/i.test(rowElement.textContent ?? '')),
    ).toBe(true);
  });

  it('renders the stopped reason code in outcome details', () => {
    render(<TimelineChart rows={[{ ...row('stopped', 'stopped'), reason_code: 'side_effect' }]} />);
    expect(screen.getByText(/reason: side effect/i)).toBeInTheDocument();
  });

  it('renders exact DB-shaped ADE evidence as escaped React text, never injected HTML', () => {
    const malicious = {
      ...row('hinted', 'taken'),
      label_matches: [
        {
          id: 'hint-1',
          matched_phrase: '<img src=x onerror=alert(1)>',
          meddra_pt: 'Nausea',
          hint_level: 'info' as const,
        },
      ],
    };
    const { container } = render(<TimelineChart rows={[malicious]} />);
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(screen.getByText(/Nausea/)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).not.toContain('undefined');
  });

  it('renders a large bounded response without truncating its input hints', () => {
    const manyRows = Array.from({ length: 180 }, (_, index) => ({
      ...row(`dose-${index}`, index % 2 === 0 ? 'taken' : 'stopped'),
      label_matches: [
        {
          id: `match-${index}`,
          matched_phrase: `phrase ${index}`,
          meddra_pt: `Term ${index}`,
          hint_level: 'info' as const,
        },
      ],
    }));
    render(<TimelineChart rows={manyRows} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(184);
    expect(screen.getAllByText(/Patient-reported phrase/)).toHaveLength(180);
  });

  it('aggregates the bar chart past 60 points (PF2) while the accessible table stays full-fidelity', () => {
    const manyRows = Array.from({ length: 180 }, (_, index) =>
      row(`dose-${index}`, index % 2 === 0 ? 'taken' : 'stopped'),
    );
    render(<TimelineChart rows={manyRows} />);
    // 180 doses decimate into 60 chunks (chunk size 3) — the SVG's declared width tracks the
    // aggregated point count, not the raw dose count (720 vs 180 * 44 = 7,920px).
    expect(screen.getByTestId('dose-timeline-chart')).toHaveStyle({ width: '2640px' });
    // The sr-only text table is never aggregated — every dose is still individually listed.
    const table = screen.getByRole('table', { name: /dated dose outcomes/i });
    expect(within(table).getAllByRole('row')).toHaveLength(181);
  });

  it('uses label-match ids so identical hints on one dose do not produce duplicate keys', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <TimelineChart
        rows={[
          {
            ...row('duplicate-hints', 'taken'),
            label_matches: [
              {
                id: 'match-a',
                matched_phrase: 'same phrase',
                meddra_pt: 'Same term',
                hint_level: 'info',
              },
              {
                id: 'match-b',
                matched_phrase: 'same phrase',
                meddra_pt: 'Same term',
                hint_level: 'info',
              },
            ],
          },
        ]}
      />,
    );
    expect(screen.getAllByText(/Patient-reported phrase/)).toHaveLength(2);
    expect(consoleError.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(
      false,
    );
    consoleError.mockRestore();
  });

  it('renders a friendly empty state when every dose is still pending', () => {
    render(<TimelineChart rows={[row('pending', null, null, null)]} />);
    expect(screen.getByRole('heading', { name: /no recorded outcomes yet/i })).toBeInTheDocument();
    expect(screen.getByText(/appear after a check-in/i)).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
