// @vitest-environment jsdom
//
// 06-03b — AlertBanner (DASH-04 / D5 / M13). Asserts the count semantics (trust the
// API `alerting` flag, exclude inactive), the interpolated threshold, the M13 wording
// ("without a response"), role="status", and the render-nothing-when-zero contract.
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

// next/link has no router context under jsdom — render a plain anchor so `link` roles resolve.
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { AlertBanner, ReportedMissBanner, countAlertingPatients } from './alert-banner';
import type { PatientRow } from './patient-list';

let seq = 0;
/** Build a PatientRow with sensible defaults; override only what a case cares about. */
function mk(overrides: Partial<PatientRow> = {}): PatientRow {
  return {
    id: `p${seq++}`,
    display_name: 'A',
    phone: '+15005550006',
    medication_name: 'Med',
    is_test: true,
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

describe('countAlertingPatients — D5 count semantics', () => {
  it('counts alerting patients that are still active, and excludes inactive ones', () => {
    const patients = [
      mk({ alerting: true }),
      mk({ alerting: true, is_active: false }), // excluded (D5 — never surface inactive)
      mk({ alerting: false }),
    ];
    expect(countAlertingPatients(patients)).toBe(1);
  });

  it('is zero for an empty cohort', () => {
    expect(countAlertingPatients([])).toBe(0);
  });
});

describe('AlertBanner — polite status banner', () => {
  it('interpolates the API threshold and uses the M13 "without a response" wording', () => {
    render(
      <AlertBanner patients={[mk({ alerting: true }), mk({ alerting: true })]} threshold={5} />,
    );
    const status = screen.getByRole('region', { name: /follow-up needed/i });
    expect(status).toHaveTextContent(/2 patients/i);
    expect(status).toHaveTextContent(/5\+/); // threshold interpolated, never hardcoded 3
    expect(status).toHaveTextContent(/without a response/i);
    // M13: never phrase timeout rows as "missed doses" / confirmed non-adherence.
    expect(status).not.toHaveTextContent(/missed doses/i);
  });

  it('uses singular wording for a single alerting patient', () => {
    render(<AlertBanner patients={[mk({ alerting: true })]} threshold={3} />);
    expect(screen.getByRole('region', { name: /follow-up needed/i })).toHaveTextContent(
      /1 patient\b/i,
    );
  });

  it('becomes the way into those patients when a filtered roster is offered', () => {
    render(
      <AlertBanner
        patients={[mk({ alerting: true })]}
        threshold={3}
        href="/patients?days=30&filter=needs-review"
      />,
    );

    expect(screen.getByRole('link', { name: /follow-up needed/i })).toHaveAttribute(
      'href',
      '/patients?days=30&filter=needs-review',
    );
  });

  it('stays plain text when no filtered roster is offered', () => {
    render(<AlertBanner patients={[mk({ alerting: true })]} threshold={3} />);

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('region', { name: /follow-up needed/i })).toBeInTheDocument();
  });

  it('renders nothing when no active patient is alerting', () => {
    const { container } = render(
      <AlertBanner
        patients={[mk({ alerting: false }), mk({ alerting: true, is_active: false })]}
        threshold={3}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('stays silent about reported misses — that is the separate banner', () => {
    render(
      <AlertBanner
        patients={[mk({ alerting: true, reported_miss_alerting: true })]}
        threshold={3}
      />,
    );
    expect(screen.getByRole('region', { name: /follow-up needed/i })).not.toHaveTextContent(
      /reported/i,
    );
  });
});

describe('ReportedMissBanner — the separate reported-miss alert', () => {
  it('names the reported-miss streak with its count when the API flag fires', () => {
    render(
      <ReportedMissBanner
        patient={mk({ reported_miss_alerting: true, consecutive_reported_misses: 3 })}
      />,
    );
    const status = screen.getByRole('region', { name: /reported missed doses/i });
    expect(status).toHaveTextContent(/reported missed doses/i);
    expect(status).toHaveTextContent(/3 reported missed doses in a row/i);
    // Distinct alert — never the silence-streak wording.
    expect(status).not.toHaveTextContent(/without a response/i);
  });

  it('renders nothing when the flag is off, even with a sub-threshold count', () => {
    const { container } = render(
      <ReportedMissBanner
        patient={mk({ reported_miss_alerting: false, consecutive_reported_misses: 2 })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('never surfaces an inactive patient (defence-in-depth, mirrors AlertBanner)', () => {
    const { container } = render(
      <ReportedMissBanner
        patient={mk({
          reported_miss_alerting: true,
          consecutive_reported_misses: 5,
          is_active: false,
        })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
