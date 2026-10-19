// @vitest-environment jsdom
//
// 06-03b — PatientList (DASH-01 / D14). Asserts drill-down links, status badges,
// the D14 badge-never-filter rule (test patients still render), the accessible
// alerting indicator, the consecutive-missed count, and the empty state.
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';

// next/link has no router context under jsdom — render a plain anchor so `link` roles resolve.
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

import { PatientList, type PatientRow } from './patient-list';

let seq = 0;
function mk(overrides: Partial<PatientRow> = {}): PatientRow {
  return {
    id: `p${seq++}`,
    display_name: 'Alice',
    phone: '+15005550006',
    medication_name: 'Metformin',
    is_test: false,
    is_active: true,
    agent_enabled: true,
    provider_opted_in: true,
    opted_out_at: null,
    created_at: '2026-07-01T00:00:00.000Z',
    consecutive_missed: 0,
    alerting: false,
    consecutive_reported_misses: 0,
    reported_miss_alerting: false,
    adherence_rate: null,
    last_reply_at: null,
    recent_doses: [],
    ...overrides,
  };
}

describe('PatientList — cohort table', () => {
  it('uses the handoff roster hierarchy and filters locally by patient or medication', () => {
    render(
      <PatientList
        patients={[
          mk({ id: 'a', display_name: 'Alice', medication_name: 'Metformin' }),
          mk({ id: 'b', display_name: 'Bob', medication_name: 'Lisinopril' }),
        ]}
      />,
    );

    expect(screen.getByRole('heading', { name: /patient roster/i })).toBeInTheDocument();
    const search = screen.getByRole('searchbox', { name: /search patients/i });
    // F2 — no component-level text-size class: the global base-layer rule (16px, the iOS
    // auto-zoom floor) must not be overridden by a higher-specificity utility class here.
    expect(search).toHaveClass('min-h-11');
    expect(search.className).not.toMatch(/\btext-(xs|sm|base|md|lg|xl|2xl)\b/);
    fireEvent.change(search, { target: { value: 'lisin' } });
    expect(screen.queryByRole('link', { name: /alice/i })).toBeNull();
    expect(screen.getByRole('link', { name: /bob/i })).toBeInTheDocument();
    expect(screen.getByText(/1 of 2 records/i)).toBeInTheDocument();
  });

  it('shows a useful no-match state without losing the cohort', () => {
    render(<PatientList patients={[mk({ display_name: 'Alice' })]} />);
    fireEvent.change(screen.getByRole('searchbox', { name: /search patients/i }), {
      target: { value: 'nobody' },
    });
    expect(screen.getByText(/no matching patients/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear search/i })).toBeInTheDocument();
  });

  it('hydrates an initial query submitted from the global patient search', () => {
    render(
      <PatientList
        initialQuery="lisin"
        patients={[
          mk({ id: 'a', display_name: 'Alice', medication_name: 'Metformin' }),
          mk({ id: 'b', display_name: 'Bob', medication_name: 'Lisinopril' }),
        ]}
      />,
    );
    expect(screen.getByRole('searchbox', { name: /search patients/i })).toHaveValue('lisin');
    expect(screen.queryByRole('link', { name: /alice/i })).toBeNull();
    expect(screen.getByRole('link', { name: /bob/i })).toBeInTheDocument();
  });

  it('synchronizes the local filter when same-route search params change', () => {
    const patients = [
      mk({ id: 'a', display_name: 'Alice', medication_name: 'Metformin' }),
      mk({ id: 'b', display_name: 'Bob', medication_name: 'Lisinopril' }),
    ];
    const { rerender } = render(<PatientList initialQuery="alice" patients={patients} />);
    expect(screen.getByRole('searchbox', { name: /search patients/i })).toHaveValue('alice');

    rerender(<PatientList initialQuery="lisin" patients={patients} />);

    expect(screen.getByRole('searchbox', { name: /search patients/i })).toHaveValue('lisin');
    expect(screen.queryByRole('link', { name: /alice/i })).toBeNull();
    expect(screen.getByRole('link', { name: /bob/i })).toBeInTheDocument();
  });

  it('uses a neutral patient initial when no display name exists', () => {
    render(<PatientList patients={[mk({ display_name: null, phone: '+15005550006' })]} />);
    expect(screen.getByText('P')).toBeInTheDocument();
    expect(screen.queryByText('+', { selector: '[aria-hidden="true"]' })).toBeNull();
  });

  it('presents the roster as a responsive card table below `lg`, never a forced horizontal scroll (C3)', () => {
    render(<PatientList patients={[mk()]} />);
    // The old "scroll horizontally to see all patient details" admission is gone outright —
    // the table primitive's own `variant="cards"` responsive escape hatch replaces it.
    expect(screen.queryByText(/scroll horizontally/i)).toBeNull();
    const region = screen.getByRole('region', { name: /patient roster table/i });
    expect(region).toHaveAttribute('data-variant', 'cards');
    expect(region.className).not.toMatch(/min-w-\[1000px\]/);
  });

  it('restates every non-identity column as an inline label for the stacked-card view (C3)', () => {
    render(
      <PatientList patients={[mk({ display_name: 'Alice', medication_name: 'Metformin' })]} />,
    );
    // Scoped to the data row — the same label text also legitimately appears once in <thead>.
    const row = screen.getByRole('row', { name: /alice/i });
    expect(within(row).getByText('Medication')).toBeInTheDocument();
    expect(within(row).getByText('Adherence')).toBeInTheDocument();
    expect(within(row).getByText('Last reply')).toBeInTheDocument();
    expect(within(row).getByText('Last 14 doses')).toBeInTheDocument();
    expect(within(row).getByText('Status')).toBeInTheDocument();
  });

  it('shows a persistent, visible dose-outcome legend — never hover-only (C1/C2)', () => {
    render(<PatientList patients={[mk()]} />);
    const legend = screen.getByRole('list', { name: /dose outcome key/i });
    expect(within(legend).getByText(/confirmed taken or delayed/i)).toBeInTheDocument();
    expect(within(legend).getByText(/confirmed not taken/i)).toBeInTheDocument();
    expect(within(legend).getByText(/ambiguous response/i)).toBeInTheDocument();
    expect(within(legend).getByText(/no response/i)).toBeInTheDocument();
  });

  it('marks dose outcomes with a shape, not colour alone, at a ≥14px floor (A7)', () => {
    render(
      <PatientList
        patients={[
          mk({
            recent_doses: [
              {
                dose_id: 'taken',
                scheduled_at: '2026-07-01T13:00:00.000Z',
                status: 'recorded',
                adherence_state: 'taken',
                decided_by: 'classifier',
              },
            ],
          }),
        ]}
      />,
    );
    const doseList = screen.getByRole('list', { name: /last 1 resolved dose/i });
    const swatch = within(doseList).getByText('confirmed taken or delayed').previousElementSibling;
    expect(swatch).toHaveClass('size-3.5');
    expect(swatch?.querySelector('svg')).toBeInTheDocument();
  });

  it('labels timeout streaks as unanswered check-ins, not confirmed missed doses', () => {
    render(<PatientList patients={[mk({ consecutive_missed: 4 })]} />);
    expect(screen.getByText(/4 unanswered check-ins/i)).toBeInTheDocument();
    expect(screen.queryByText(/missed dose|non-adherent/i)).toBeNull();
  });

  it('renders the real adherence, last-reply, and recent-dose handoff columns', () => {
    render(
      <PatientList
        patients={[
          mk({
            adherence_rate: 0.875,
            last_reply_at: '2026-07-02T13:15:00.000Z',
            recent_doses: [
              {
                dose_id: 'taken',
                scheduled_at: '2026-07-01T13:00:00.000Z',
                status: 'recorded',
                adherence_state: 'taken',
                decided_by: 'classifier',
              },
              {
                dose_id: 'timeout',
                scheduled_at: '2026-07-02T13:00:00.000Z',
                status: 'missed',
                adherence_state: 'unknown',
                decided_by: 'timeout',
              },
            ],
          }),
        ]}
      />,
    );

    expect(screen.getByRole('columnheader', { name: 'Adherence' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Last reply' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Last 14 doses' })).toBeInTheDocument();
    expect(screen.getByText('88%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: /alice adherence/i })).toHaveAttribute(
      'aria-valuenow',
      '88',
    );
    expect(screen.getByText(/Jul 2, 1:15 PM UTC/i)).toBeInTheDocument();
    const doses = screen.getByRole('list', { name: /last 2 resolved doses/i });
    expect(doses).toHaveTextContent(/confirmed taken/i);
    expect(doses).toHaveTextContent(/no response/i);
  });

  it('renders one row per patient, each name linking to the /patients/{id} drill-down', () => {
    render(<PatientList patients={[mk({ id: 'abc', display_name: 'Alice' })]} />);
    const link = screen.getByRole('link', { name: /alice/i });
    expect(link).toHaveAttribute('href', '/patients/abc');
  });

  it('badges test / inactive / opted-out and never filters a test patient (D14)', () => {
    render(
      <PatientList
        patients={[
          mk({ id: 'a', display_name: 'Alice', is_test: true }),
          mk({ id: 'b', display_name: 'Bob', is_active: false }),
          mk({
            id: 'c',
            display_name: 'Carol',
            provider_opted_in: false,
            agent_enabled: false,
            opted_out_at: '2026-07-02T00:00:00.000Z',
          }),
        ]}
      />,
    );
    // D14 — the test patient row is present, not filtered out.
    expect(screen.getByRole('link', { name: /alice/i })).toBeInTheDocument();
    expect(screen.getByText('test')).toBeInTheDocument();
    expect(screen.getByText(/inactive/i)).toBeInTheDocument();
    expect(screen.getByText(/messaging stopped/i)).toBeInTheDocument();
    expect(screen.getByText(/waiting for patient to text START/i)).toBeInTheDocument();
  });

  it('uses the full messaging state instead of calling every enrolled patient active', () => {
    render(
      <PatientList
        patients={[
          mk({ id: 'receiving', display_name: 'Receiving' }),
          mk({
            id: 'doctor',
            display_name: 'Doctor',
            agent_enabled: false,
            provider_opted_in: true,
          }),
          mk({
            id: 'start',
            display_name: 'Start',
            agent_enabled: false,
            provider_opted_in: false,
          }),
          mk({ id: 'inactive', display_name: 'Inactive', is_active: false }),
        ]}
      />,
    );

    expect(screen.getByText('receiving check-ins')).toBeInTheDocument();
    expect(screen.getByText('awaiting doctor reactivation')).toBeInTheDocument();
    expect(screen.getByText('messaging stopped')).toBeInTheDocument();
    expect(screen.getByText('inactive')).toBeInTheDocument();
  });

  it('shows an accessible alert indicator on an alerting row', () => {
    render(
      <PatientList
        patients={[mk({ display_name: 'Dana', alerting: true, consecutive_missed: 4 })]}
      />,
    );
    expect(screen.getByText(/needs review/i)).toBeInTheDocument();
    expect(screen.getByText(/4 unanswered check-ins/i)).toBeInTheDocument();
  });

  it('badges a reported-miss streak separately from the silence streak', () => {
    render(
      <PatientList
        patients={[
          mk({
            display_name: 'Dana',
            reported_miss_alerting: true,
            consecutive_reported_misses: 3,
          }),
        ]}
      />,
    );
    expect(screen.getByText(/reported misses/i)).toBeInTheDocument();
    expect(screen.getByText(/3 reported missed doses in a row/i)).toBeInTheDocument();
    // The silence-streak surfaces stay untouched — this row is not silence-alerting.
    expect(screen.queryByText(/needs review/i)).toBeNull();
    expect(screen.queryByText(/unanswered check-ins/i)).toBeNull();
  });

  it('shows no reported-miss text on a silence-only streak (the streaks never mix)', () => {
    render(
      <PatientList
        patients={[mk({ display_name: 'Dana', alerting: true, consecutive_missed: 4 })]}
      />,
    );
    expect(screen.queryByText(/reported miss/i)).toBeNull();
  });

  it('renders a friendly empty state linking to enrollment when there are no patients', () => {
    render(<PatientList patients={[]} />);
    expect(screen.getByRole('heading', { name: /no patients enrolled/i })).toBeInTheDocument();
    expect(screen.getByText(/cohort will appear here/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /enroll/i });
    expect(link).toHaveAttribute('href', '/patients/new');
  });

  it('renders attacker-supplied display names as escaped text without creating elements', () => {
    const payload = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const { container } = render(<PatientList patients={[mk({ display_name: payload })]} />);
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(container.querySelector('img, script')).toBeNull();
  });
});

describe('PatientList — active filter chip', () => {
  const activeFilter = { label: 'Needs review', clearHref: '/patients?days=30' };

  it('names the filter that narrowed the roster and offers a link that clears it', () => {
    render(
      <PatientList
        patients={[mk({ display_name: 'Dana', alerting: true })]}
        activeFilter={activeFilter}
      />,
    );

    expect(screen.getByText('Needs review')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /clear the needs review filter/i })).toHaveAttribute(
      'href',
      '/patients?days=30',
    );
  });

  it('shows no chip when the roster is unfiltered', () => {
    render(<PatientList patients={[mk()]} />);
    expect(screen.queryByRole('link', { name: /clear the .* filter/i })).toBeNull();
  });

  it('explains an empty filter instead of claiming the cohort is empty', () => {
    render(<PatientList patients={[]} activeFilter={activeFilter} />);

    expect(
      screen.getByRole('heading', { name: /no patients under needs review/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /no patients enrolled/i })).toBeNull();
    expect(screen.getByRole('link', { name: /show all patients/i })).toHaveAttribute(
      'href',
      '/patients?days=30',
    );
  });
});

describe('PatientList — search stays in the URL and announces politely (C4/C8)', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/patients');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('syncs the search into ?q= via replaceState, debounced — never a fresh history entry per keystroke (C4)', () => {
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');
    render(
      <PatientList
        patients={[
          mk({ id: 'a', display_name: 'Alice', medication_name: 'Metformin' }),
          mk({ id: 'b', display_name: 'Bob', medication_name: 'Lisinopril' }),
        ]}
      />,
    );

    fireEvent.change(screen.getByRole('searchbox', { name: /search patients/i }), {
      target: { value: 'lisin' },
    });
    // Filtering itself stays instant — no debounce on what the doctor sees.
    expect(screen.queryByRole('link', { name: /alice/i })).toBeNull();
    // The URL has not moved yet; only after the debounce window.
    expect(window.location.search).toBe('');

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(replaceStateSpy).toHaveBeenLastCalledWith(null, '', '/patients?q=lisin');

    fireEvent.change(screen.getByRole('searchbox', { name: /search patients/i }), {
      target: { value: '' },
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(replaceStateSpy).toHaveBeenLastCalledWith(null, '', '/patients');
  });

  it('debounces the screen-reader result-count announcement separately from the visible count (C8)', () => {
    render(
      <PatientList
        patients={[
          mk({ id: 'a', display_name: 'Alice', medication_name: 'Metformin' }),
          mk({ id: 'b', display_name: 'Bob', medication_name: 'Lisinopril' }),
        ]}
      />,
    );

    const liveRegion = screen.getByRole('status');
    expect(liveRegion).toHaveTextContent(/showing all 2 records/i);

    fireEvent.change(screen.getByRole('searchbox', { name: /search patients/i }), {
      target: { value: 'lisin' },
    });
    // The visible badge updates immediately…
    expect(screen.getByText(/1 of 2 records/i)).toBeInTheDocument();
    // …but the live region has not announced it yet.
    expect(liveRegion).toHaveTextContent(/showing all 2 records/i);

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(liveRegion).toHaveTextContent(/1 of 2 records match/i);
  });
});
