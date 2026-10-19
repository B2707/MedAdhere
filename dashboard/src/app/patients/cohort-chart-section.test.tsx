// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }));
vi.mock('@/components/cohort-chart', () => ({
  CohortChart: ({ series }: { series: unknown[] }) => <div>Cohort days: {series.length}</div>,
}));
vi.mock('@/components/cohort-summary', () => ({
  CohortSummary: ({
    patients,
    adherencePct,
    responsePct,
  }: {
    patients: unknown[];
    adherencePct: number | null;
    responsePct: number | null;
  }) => (
    <div>
      KPI patients: {patients.length}; adherence: {String(adherencePct)}; response:{' '}
      {String(responsePct)}
    </div>
  ),
}));

import { CohortChartSection } from './cohort-chart-section';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CohortChartSection independent degradation', () => {
  it('keeps a cohort failure inside the chart region', async () => {
    apiFetchMock.mockResolvedValue({ status: 'error' });
    render(await CohortChartSection({ patients: [{ id: 'p1' }] as never[], windowDays: 30 }));
    expect(screen.getByText(/KPI patients: 1; adherence: null; response: null/i)).toBeInTheDocument();
    expect(screen.getByText(/couldn.t load the cohort chart/i)).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith('/api/cohort-adherence?days=30', expect.anything());
  });

  it('renders a validated successful cohort response', async () => {
    apiFetchMock.mockResolvedValue({
      status: 'ok',
      data: {
        series: [
          {
            day: '2026-07-01',
            delivered: 10,
            responded: 8,
            confirmed: 7,
            taken_delayed: 6,
            ambiguous: 1,
            non_response: 2,
            adherence_rate: 0.75,
            response_rate: 0.8,
          },
        ],
      },
    });
    render(await CohortChartSection({ patients: [{ id: 'p1' }] as never[], windowDays: 90 }));
    expect(
      screen.getByText(/KPI patients: 1; adherence: 0.8571428571428571; response: 0.8/i),
    ).toBeInTheDocument();
    expect(screen.getByText('Cohort days: 1')).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith('/api/cohort-adherence?days=90', expect.anything());
  });
});
