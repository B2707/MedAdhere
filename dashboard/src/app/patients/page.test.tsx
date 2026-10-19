// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetchMock, cohortState, never } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  cohortState: { value: 'pending' as 'pending' | 'error' },
  never: new Promise<never>(() => undefined),
}));

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }));
vi.mock('@/components/auto-refresh', () => ({ AutoRefresh: () => null }));
vi.mock('@/components/app-shell', () => ({
  AppShell: ({
    children,
    pageTitle,
    pageDescription,
    pageActions,
    headerSlot,
  }: {
    children: ReactNode;
    pageTitle: string;
    pageDescription?: string;
    pageActions?: ReactNode;
    headerSlot?: ReactNode;
  }) => (
    <div>
      <h1>{pageTitle}</h1>
      <p>{pageDescription}</p>
      {pageActions}
      {headerSlot}
      {children}
    </div>
  ),
}));
vi.mock('./cohort-chart-section', () => ({
  CohortChartSection: ({ patients, windowDays }: { patients: unknown[]; windowDays: number }) => {
    if (cohortState.value === 'error') {
      return <p>Couldn&apos;t load the cohort chart.</p>;
    }
    return (
      <p>
        Loading {windowDays}d metrics for {patients.length} patients…
      </p>
    );
  },
  CohortChartFallback: () => <p>Loading cohort chart…</p>,
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import PatientsPage from './page';

const listResponse = {
  status: 'ok',
  data: {
    alertThreshold: 3,
    patients: [
      {
        id: 'patient-1',
        display_name: 'Alice',
        phone: '+15145550123',
        medication_name: 'Metformin',
        is_test: true,
        is_active: true,
        agent_enabled: true,
        provider_opted_in: true,
        opted_out_at: null,
        created_at: '2026-07-01T00:00:00.000Z',
        consecutive_missed: 0,
        alerting: false,
        adherence_rate: 0.9,
        last_reply_at: '2026-07-02T13:15:00.000Z',
        recent_doses: [],
      },
    ],
  },
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  cohortState.value = 'pending';
  apiFetchMock.mockImplementation((path: string) =>
    path === '/api/patients' ? Promise.resolve(listResponse) : never,
  );
});

describe('/patients streaming', () => {
  it('renders the patient list and chart fallback without waiting for the cohort read', async () => {
    const page = await PatientsPage({});
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock).toHaveBeenCalledWith('/api/patients', expect.anything());
    render(page);
    expect(screen.getByRole('link', { name: /Alice/ })).toBeInTheDocument();
    expect(screen.getByText(/loading 30d metrics for 1 patient/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: /cohort overview/i })).toBeInTheDocument();
    expect(screen.getByText(/1 patient receiving check-ins/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /enroll patient/i })).toHaveAttribute(
      'href',
      '/patients/new',
    );
    expect(screen.getByRole('navigation', { name: /cohort window/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '30d' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '7d' })).toHaveAttribute('href', '/patients?days=7');
    expect(screen.getByRole('link', { name: '90d' })).toHaveAttribute('href', '/patients?days=90');
    expect(screen.getByRole('searchbox', { name: /search patients/i })).toBeInTheDocument();
  });

  it('does not count START-restored patients as receiving check-ins before doctor reactivation', async () => {
    apiFetchMock.mockResolvedValueOnce({
      ...listResponse,
      data: {
        ...listResponse.data,
        patients: [
          {
            ...listResponse.data.patients[0],
            agent_enabled: false,
            provider_opted_in: true,
          },
        ],
      },
    });
    render(await PatientsPage({}));
    expect(screen.getByText(/0 patients receiving check-ins/i)).toBeInTheDocument();
  });

  it('keeps the patient list visible when the cohort chart degrades', async () => {
    cohortState.value = 'error';
    render(await PatientsPage({}));
    expect(screen.getByRole('link', { name: /Alice/ })).toBeInTheDocument();
    expect(screen.getByText(/couldn.t load the cohort chart/i)).toBeInTheDocument();
  });

  it('applies the top-bar q parameter to the roster search', async () => {
    render(await PatientsPage({ searchParams: Promise.resolve({ q: 'nobody' }) }));
    expect(screen.getByRole('searchbox', { name: /search patients/i })).toHaveValue('nobody');
    expect(screen.getByText(/no matching patients/i)).toBeInTheDocument();
  });

  it('validates and forwards an allowed cohort window while preserving the search query', async () => {
    render(await PatientsPage({ searchParams: Promise.resolve({ q: 'Alice', days: '90' }) }));
    expect(screen.getByText(/loading 90d metrics for 1 patient/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '90d' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '7d' })).toHaveAttribute(
      'href',
      '/patients?days=7&q=Alice',
    );
  });

  it('narrows only the roster when a filter is applied, and keeps the cohort counts whole', async () => {
    apiFetchMock.mockResolvedValueOnce({
      ...listResponse,
      data: {
        ...listResponse.data,
        patients: [
          { ...listResponse.data.patients[0], id: 'calm', display_name: 'Calm' },
          {
            ...listResponse.data.patients[0],
            id: 'alerting',
            display_name: 'Alerting',
            alerting: true,
            consecutive_missed: 4,
          },
        ],
      },
    });
    render(await PatientsPage({ searchParams: Promise.resolve({ filter: 'needs-review' }) }));

    expect(screen.getByRole('link', { name: /Alerting/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Calm/ })).toBeNull();
    // The chart section still receives the whole cohort — the number that was clicked stays true.
    expect(screen.getByText(/loading 30d metrics for 2 patients/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /clear the needs review filter/i })).toHaveAttribute(
      'href',
      '/patients?days=30',
    );
  });

  it('sends the alert banner to the roster filtered to the same patients it counts', async () => {
    apiFetchMock.mockResolvedValueOnce({
      ...listResponse,
      data: {
        ...listResponse.data,
        patients: [{ ...listResponse.data.patients[0], alerting: true, consecutive_missed: 4 }],
      },
    });
    render(await PatientsPage({}));

    expect(screen.getByRole('link', { name: /follow-up needed/i })).toHaveAttribute(
      'href',
      '/patients?days=30&filter=needs-review',
    );
  });

  it('keeps the filter on the cohort window links so switching windows never drops it', async () => {
    render(await PatientsPage({ searchParams: Promise.resolve({ days: '90', filter: 'active' }) }));

    expect(screen.getByRole('link', { name: '7d' })).toHaveAttribute(
      'href',
      '/patients?days=7&filter=active',
    );
  });

  it('ignores an unrecognised filter instead of blanking the roster', async () => {
    render(await PatientsPage({ searchParams: Promise.resolve({ filter: 'open-alerts' }) }));

    expect(screen.getByRole('link', { name: /Alice/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /clear the .* filter/i })).toBeNull();
  });

  it('omits the roster search when the cohort is empty', async () => {
    apiFetchMock.mockResolvedValueOnce({
      status: 'ok',
      data: { alertThreshold: 3, patients: [] },
    });
    render(await PatientsPage({}));
    expect(screen.queryByRole('link', { name: /search patients/i })).toBeNull();
    expect(screen.queryByRole('searchbox', { name: /search patients/i })).toBeNull();
  });

  it('offers an in-page jump to the analytics section instead of a sidebar nav item (N1)', async () => {
    render(await PatientsPage({}));
    const studyAnalyticsLink = screen.getByRole('link', { name: /study analytics/i });
    expect(studyAnalyticsLink).toHaveAttribute('href', '#cohort-analytics');
  });

  it('keeps the sign-in control a form GET when the session is unauthenticated (SIGNIN-DIAGNOSIS §3 Slice D)', async () => {
    apiFetchMock.mockResolvedValueOnce({ status: 'unauthenticated' });
    const { container } = render(await PatientsPage({}));
    const form = container.querySelector('form[action="/api/auth/login"]');
    expect(form).not.toBeNull();
    expect(form).toHaveAttribute('method', 'get');
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
    // Slice D is explicit: this stays a form GET, never a client-side link.
    expect(screen.queryByRole('link', { name: /sign in/i })).toBeNull();
  });

  it('surfaces a calm retry form when the patient list read fails', async () => {
    apiFetchMock.mockResolvedValueOnce({ status: 'error' });
    render(await PatientsPage({}));
    expect(
      screen.getByRole('heading', { name: /couldn.t reach the database/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
