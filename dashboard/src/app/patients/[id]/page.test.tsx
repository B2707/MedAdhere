// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { PatientRecordResponse } from '@/lib/dashboard-contracts';

const { apiFetchMock, notFoundMock, patientActionsMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  notFoundMock: vi.fn(),
  patientActionsMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }));
vi.mock('next/navigation', () => ({
  notFound: notFoundMock,
  usePathname: () => '/patients/id',
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock('@/components/nav-link', () => ({
  NavLink: ({ href, label }: { href: string; label: string; icon: ReactNode }) => (
    <a href={href}>{label}</a>
  ),
}));
vi.mock('@/components/timeline-chart', () => ({
  TimelineChart: ({ rows }: { rows: unknown[] }) => <div>Timeline rows: {rows.length}</div>,
}));
vi.mock('@/components/patient-trend-charts', () => ({
  SymptomSeverityChart: () => <h2>Worst symptom severity by day</h2>,
  AdherenceOutcomeChart: () => <h2>Daily adherence outcomes</h2>,
}));
vi.mock('./patient-actions', () => ({
  PatientActions: (props: Record<string, unknown>) => {
    patientActionsMock(props);
    return <div>Patient actions</div>;
  },
}));

import PatientDetailPage from './page';

const PATIENT_ID = '11111111-1111-4111-8111-111111111111';
const LOCAL_DATE = '2026-08-11';

function recordResponse(overrides: Partial<PatientRecordResponse> = {}): PatientRecordResponse {
  return {
    patient: {
      id: PATIENT_ID,
      display_name: 'Alice',
      phone: '+15005550006',
      medication_name: 'Metformin',
      timezone: 'America/Toronto',
      is_test: true,
      is_active: true,
      opted_out_at: null,
      created_at: '2026-07-01T00:00:00.000Z',
      drug_profile_fetched_at: null,
      consecutive_missed: 0,
      alerting: false,
      consecutive_reported_misses: 0,
      reported_miss_alerting: false,
      preferred_language: 'en',
      reminder_limit: 2,
      agent_enabled: true,
      provider_opted_in: true,
      messaging_state_version: 7,
    },
    timeline: [],
    alertThreshold: 3,
    timelineWindowDays: 30,
    window: { days: 30, selectedDay: LOCAL_DATE },
    dayIndex: [
      {
        local_date: LOCAL_DATE,
        latest_summary_version: null,
        highest_tier: 'none',
        message_count: 0,
        event_count: 0,
        alert_count: 0,
        has_draft: false,
      },
    ],
    daySummary: null,
    messages: [],
    events: [],
    evidence: [],
    versions: [],
    alertsPage: { items: [], cursor: null, nextCursor: null, limit: 25 },
    draftsPage: { items: [], cursor: null, nextCursor: null, limit: 3 },
    history: { medications: [], facts: [] },
    trends: { severity: [], adherence: [] },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  notFoundMock.mockImplementation(() => {
    throw new Error('NEXT_NOT_FOUND');
  });
});

function renderPage(searchParams: Record<string, string | string[] | undefined> = {}) {
  return PatientDetailPage({
    params: Promise.resolve({ id: PATIENT_ID }),
    searchParams: Promise.resolve(searchParams),
  }).then(render);
}

describe('/patients/[id] record route and query boundary', () => {
  it('uses the bounded record route with only a validated day/window — no cursor params (R5)', async () => {
    apiFetchMock.mockResolvedValue({ status: 'ok', data: recordResponse() });
    await renderPage({ days: '90', day: LOCAL_DATE });

    expect(apiFetchMock).toHaveBeenCalledWith(
      `/api/patients/${PATIENT_ID}/record?days=90&day=${LOCAL_DATE}`,
      expect.anything(),
      { includeNotFound: true },
    );
  });

  it('defaults malformed or repeated query values instead of forwarding them', async () => {
    apiFetchMock.mockResolvedValue({ status: 'ok', data: recordResponse() });
    await renderPage({ days: '365', day: '2026-02-30' });

    expect(apiFetchMock).toHaveBeenCalledWith(
      `/api/patients/${PATIENT_ID}/record?days=30`,
      expect.anything(),
      { includeNotFound: true },
    );
  });

  it('calls Next notFound for the owner-safe not_found discriminant', async () => {
    apiFetchMock.mockResolvedValue({ status: 'not_found' });
    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unauthenticated', /not signed in/i],
    ['error', /couldn.t load this patient/i],
  ] as const)(
    'renders the calm %s state and stops the auto-refresh poller',
    async (status, copy) => {
      apiFetchMock.mockResolvedValue({ status });
      await renderPage();
      expect(screen.getByRole('heading', { name: copy })).toBeInTheDocument();
      expect(notFoundMock).not.toHaveBeenCalled();
    },
  );
});

describe('/patients/[id] owner-ordered page (§4.0)', () => {
  it('renders the day summary, day thread, alerts, then the trends & record sections in order', async () => {
    apiFetchMock.mockResolvedValue({ status: 'ok', data: recordResponse() });
    await renderPage();

    const outline = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(outline).toEqual([
      'What happened today',
      'Day thread · Aug 11, 2026',
      'Alerts in this window',
      'Trends & record',
      'Dose timeline · last 30 days',
      'Worst symptom severity by day',
      'Daily adherence outcomes',
      'Medications and history',
      'Revision history',
    ]);
  });

  // Pinned 2026-08-17 (owner-approved): nothing in the system generates clinician
  // reply-drafts yet, so the "Drafts to review" panel was a dead surface — unmounted
  // from this page. draft-review.tsx itself is untouched; the feature returns later.
  it('does not mount the drafts-to-review panel (no draft writer exists yet)', async () => {
    apiFetchMock.mockResolvedValue({ status: 'ok', data: recordResponse() });
    const { container } = await renderPage();

    expect(screen.queryByRole('heading', { name: /drafts to review/i })).toBeNull();
    expect(screen.queryByText(/draft ready for review/i)).toBeNull();
    expect(container.querySelector('#draft-review')).toBeNull();
  });

  it('never mounts the empty drug label section (R8)', async () => {
    apiFetchMock.mockResolvedValue({ status: 'ok', data: recordResponse() });
    await renderPage();

    expect(screen.queryByText(/drug label/i)).toBeNull();
  });

  it('never renders a separate "Patient overview" card or a QueuePagination control (R5/R6)', async () => {
    apiFetchMock.mockResolvedValue({ status: 'ok', data: recordResponse() });
    await renderPage();

    expect(screen.queryByText(/patient overview/i)).toBeNull();
    expect(screen.queryByRole('link', { name: /first alerts page/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /next alerts page/i })).toBeNull();
  });

  it('collapses empty trend sections by default and opens ones that carry data', async () => {
    apiFetchMock.mockResolvedValue({ status: 'ok', data: recordResponse() });
    await renderPage();

    for (const name of [/dose timeline/i, /medications and history/i, /revision history/i]) {
      const details = screen.getByRole('heading', { level: 2, name }).closest('details');
      expect(details).not.toHaveAttribute('open');
    }
  });

  it('marks the current window and links the other two on the trends toolbar', async () => {
    apiFetchMock.mockResolvedValue({ status: 'ok', data: recordResponse() });
    await renderPage();

    expect(screen.getByRole('link', { name: '30 days' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '7 days' })).toHaveAttribute(
      'href',
      `/patients/${PATIENT_ID}?days=7&day=${LOCAL_DATE}`,
    );
    expect(screen.getByRole('link', { name: '90 days' })).toHaveAttribute(
      'href',
      `/patients/${PATIENT_ID}?days=90&day=${LOCAL_DATE}`,
    );
  });
});

describe('/patients/[id] patient header strip (R6/R9)', () => {
  it('shows the non-response streak and the latest classifier outcome as plain facts', async () => {
    apiFetchMock.mockResolvedValue({
      status: 'ok',
      data: recordResponse({
        patient: { ...recordResponse().patient, consecutive_missed: 2 },
        timeline: [
          {
            dose_id: 'd1',
            scheduled_at: '2026-08-11T13:00:00.000Z',
            dose_date: LOCAL_DATE,
            local_dose_time: '09:00:00',
            status: 'recorded',
            adherence_state: 'delayed',
            reason_code: 'forgot',
            decided_by: 'classifier',
            is_late: true,
            label_matches: [],
          },
        ],
      }),
    });
    await renderPage();

    expect(screen.getByText('Non-response streak').nextElementSibling).toHaveTextContent('2');
    expect(screen.getByText('Latest classification').nextElementSibling).toHaveTextContent(
      /delayed.*forgot/i,
    );
  });

  it('shows the separate reported-miss fact only when the API flag fires', async () => {
    apiFetchMock.mockResolvedValueOnce({
      status: 'ok',
      data: recordResponse({
        patient: {
          ...recordResponse().patient,
          consecutive_reported_misses: 3,
          reported_miss_alerting: true,
        },
      }),
    });
    const alertingRender = await renderPage();
    expect(screen.getByText('Reported misses').nextElementSibling).toHaveTextContent('3 in a row');
    alertingRender.unmount();

    apiFetchMock.mockResolvedValueOnce({ status: 'ok', data: recordResponse() });
    await renderPage();
    expect(screen.queryByText('Reported misses')).toBeNull();
  });

  it('passes STOP → START awaiting-doctor state to actions and never labels it active', async () => {
    apiFetchMock.mockResolvedValue({
      status: 'ok',
      data: recordResponse({
        patient: {
          ...recordResponse().patient,
          provider_opted_in: true,
          agent_enabled: false,
          messaging_state_version: 8,
          reminder_limit: 4,
        },
      }),
    });
    await renderPage();

    expect(screen.getByText(/awaiting doctor reactivation/i)).toBeInTheDocument();
    expect(screen.queryByText('active', { exact: true })).toBeNull();
    expect(patientActionsMock).toHaveBeenCalledWith({
      patientId: PATIENT_ID,
      isActive: true,
      agentEnabled: false,
      providerOptedIn: true,
      messagingStateVersion: 8,
      reminderLimit: 4,
      displayName: 'Alice',
      phone: '+15005550006',
    });
  });
});

describe('/patients/[id] alerts-in-window jump list (R7)', () => {
  it('deep-links each alert to its day and thread mark, in the current window', async () => {
    apiFetchMock.mockResolvedValue({
      status: 'ok',
      data: recordResponse({
        window: { days: 90, selectedDay: LOCAL_DATE },
        alertsPage: {
          items: [
            {
              id: 'a1',
              event_code: 'symptom:chest_pain',
              tier: 'emergency',
              statement_text: 'chest pain',
              occurred_at: '2026-08-10T14:05:00.000Z',
              local_date: '2026-08-10',
              source_inbound_id: null,
              agent_turn_id: null,
              final_policy_tier: 'emergency',
              created_at: '2026-08-10T14:06:00.000Z',
            },
          ],
          cursor: null,
          nextCursor: null,
          limit: 25,
        },
      }),
    });
    await renderPage({ days: '90' });

    expect(screen.getByRole('link', { name: /emergency.*chest pain/i })).toHaveAttribute(
      'href',
      `/patients/${PATIENT_ID}?days=90&day=2026-08-10#event-a1`,
    );
  });
});

describe('/patients/[id] day thread mounting (R1/R2/R3)', () => {
  it('renders every event even when the day summary omits its priority, unmarked (R2)', async () => {
    apiFetchMock.mockResolvedValue({
      status: 'ok',
      data: recordResponse({
        events: [
          {
            id: 'e1',
            event_type: 'observation',
            event_code: 'symptom:headache',
            statement_text: 'mild headache',
            normalized_value: null,
            occurred_at: '2026-08-11T09:00:00.000Z',
            local_date: LOCAL_DATE,
            local_time: '09:00:00',
            patient_timezone: 'America/Toronto',
            severity: null,
            patient_medication_id: null,
            dose_id: null,
            agent_turn_id: null,
            source_inbound_id: null,
            supersedes_id: null,
            created_at: '2026-08-11T09:00:00.000Z',
          },
        ],
      }),
    });
    await renderPage();

    expect(screen.getByText('mild headache')).toBeInTheDocument();
    expect(screen.queryByText(/no priority recorded/i)).toBeNull();
  });
});
