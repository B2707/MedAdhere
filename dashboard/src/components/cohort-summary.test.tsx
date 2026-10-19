// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

// next/link has no router context under jsdom — render a plain anchor so `link` roles resolve.
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { CohortSummary } from './cohort-summary';
import type { PatientRow } from './patient-list';

function patient(overrides: Partial<PatientRow> = {}): PatientRow {
  return {
    id: 'patient-1',
    display_name: 'Test patient',
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

describe('CohortSummary — handoff KPI contract', () => {
  it('combines live patient counts with honest 30-day cohort rates', () => {
    render(
      <CohortSummary
        adherencePct={0.875}
        responsePct={0.75}
        patients={[
          patient({ id: 'active-test', is_test: true }),
          patient({ id: 'review', alerting: true }),
          patient({ id: 'inactive', is_active: false }),
        ]}
      />,
    );

    // C5 — the summary is a native <dl>, not a hijacked role="group"; its accessible name
    // comes from aria-labelledby on the landmark wrapper (a region), matching the visually
    // hidden heading rather than an ARIA role override.
    const summary = screen.getByRole('region', { name: /cohort summary/i });
    expect(within(summary).getByText('Cohort adherence').nextElementSibling).toHaveTextContent(
      '88%',
    );
    expect(within(summary).getByText('Active patients').nextElementSibling).toHaveTextContent(
      '2 / 3',
    );
    expect(within(summary).getByText('Reply rate · 30d').nextElementSibling).toHaveTextContent(
      '75%',
    );
    expect(within(summary).getByText('Open alerts').nextElementSibling).toHaveTextContent('1');
    expect(within(summary).queryByText('Reply rate · 24h')).not.toBeInTheDocument();
    expect(within(summary).queryByText('Test cohort')).not.toBeInTheDocument();
  });

  it('uses the clinical type scale on every tile — C6', () => {
    render(<CohortSummary adherencePct={0.5} responsePct={0.75} patients={[patient()]} />);
    const value = screen.getByText('50%');
    expect(value.tagName).toBe('DD');
    expect(value).toHaveClass('text-2xl');
    expect(screen.getByText('Cohort adherence')).toHaveClass('text-xs');
    expect(screen.getByText(/confirmed taken or delayed/i)).toHaveClass('text-sm');
  });

  it('renders unavailable rates as em dashes instead of inventing values', () => {
    render(<CohortSummary adherencePct={null} responsePct={null} patients={[]} windowDays={7} />);

    const summary = screen.getByRole('region', { name: /cohort summary/i });
    expect(within(summary).getByText('Cohort adherence').nextElementSibling).toHaveTextContent('—');
    expect(within(summary).getByText('Reply rate · 7d').nextElementSibling).toHaveTextContent('—');
  });
});

describe('CohortSummary — patient counts are entry points into the roster', () => {
  const filterHrefs = {
    'needs-review': '/patients?days=30&filter=needs-review',
    active: '/patients?days=30&filter=active',
  };

  it('links each patient-count card to the roster filtered to that same set', () => {
    render(
      <CohortSummary
        adherencePct={0.5}
        responsePct={0.5}
        patients={[patient({ alerting: true })]}
        filterHrefs={filterHrefs}
      />,
    );

    expect(screen.getByRole('link', { name: /active patients/i })).toHaveAttribute(
      'href',
      '/patients?days=30&filter=active',
    );
    expect(screen.getByRole('link', { name: /open alerts/i })).toHaveAttribute(
      'href',
      '/patients?days=30&filter=needs-review',
    );
  });

  it('leaves the rate cards static — a percentage is not a subset of patients', () => {
    render(
      <CohortSummary
        adherencePct={0.5}
        responsePct={0.5}
        patients={[]}
        filterHrefs={filterHrefs}
      />,
    );

    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(screen.queryByRole('link', { name: /cohort adherence/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /reply rate/i })).toBeNull();
  });

  it('stays static text when no filtered view is offered', () => {
    render(<CohortSummary adherencePct={0.5} responsePct={0.5} patients={[]} />);

    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});
