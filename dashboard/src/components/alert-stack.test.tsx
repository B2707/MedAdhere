// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import type { PatientAlert } from '@/lib/dashboard-contracts';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { AlertStack } from './alert-stack';

const PATIENT_ID = '11111111-1111-4111-8111-111111111111';

function alert(overrides: Partial<PatientAlert> & Pick<PatientAlert, 'id' | 'tier'>): PatientAlert {
  return {
    event_code: 'symptom:chest_pain',
    statement_text: 'chest pain right now',
    occurred_at: '2026-08-11T14:05:00.000Z',
    local_date: '2026-08-11',
    source_inbound_id: null,
    agent_turn_id: null,
    final_policy_tier: 'emergency',
    created_at: '2026-08-11T14:06:00.000Z',
    ...overrides,
  };
}

function renderStack(alerts: PatientAlert[], days: 7 | 30 | 90 = 30) {
  return render(<AlertStack alerts={alerts} patientId={PATIENT_ID} days={days} />);
}

describe('AlertStack — the "open alerts in window" jump list (R7)', () => {
  it('deep-links each alert to its own day and thread mark, most severe first', () => {
    renderStack([
      alert({ id: 'i1', tier: 'important', local_date: '2026-08-10' }),
      alert({ id: 'e1', tier: 'emergency', local_date: '2026-08-11' }),
    ]);

    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveAttribute(
      'href',
      `/patients/${PATIENT_ID}?days=30&day=2026-08-11#event-e1`,
    );
    expect(links[1]).toHaveAttribute(
      'href',
      `/patients/${PATIENT_ID}?days=30&day=2026-08-10#event-i1`,
    );
  });

  it('orders alerts within a tier most recent first', () => {
    renderStack([
      alert({ id: 'older', tier: 'emergency', occurred_at: '2026-08-11T09:00:00.000Z' }),
      alert({ id: 'newer', tier: 'emergency', occurred_at: '2026-08-11T18:00:00.000Z' }),
    ]);

    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveAttribute('href', expect.stringContaining('#event-newer'));
    expect(links[1]).toHaveAttribute('href', expect.stringContaining('#event-older'));
  });

  it('carries the priority tier and the requested window into the link', () => {
    renderStack([alert({ id: 'e1', tier: 'emergency' })], 90);

    expect(screen.getByText('Emergency')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/patients\/.*\?days=90&day=2026-08-11#event-e1$/),
    );
  });

  it('falls back to the event code when no patient text was recorded', () => {
    renderStack([alert({ id: 'e1', tier: 'emergency', statement_text: null })]);

    expect(screen.getByText('symptom:chest_pain')).toBeInTheDocument();
  });

  it('places a fallback (needs-human) row in the same flat list, not a separate section', () => {
    renderStack([
      alert({ id: 'f1', tier: 'fallback', statement_text: 'turn could not be completed' }),
      alert({ id: 'e1', tier: 'emergency' }),
    ]);

    expect(screen.queryByRole('region', { name: /needs human review/i })).toBeNull();
    expect(screen.getByText('turn could not be completed')).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    // Emergency still ranks ahead of a fallback row.
    expect(links[0]).toHaveAttribute('href', expect.stringContaining('#event-e1'));
  });

  it('never presents a reviewed alert as closed or resolved', () => {
    renderStack([alert({ id: 'e1', tier: 'emergency' })]);

    expect(screen.queryByText(/\bclosed\b/i)).toBeNull();
    expect(screen.queryByText(/\bresolved\b/i)).toBeNull();
    expect(screen.getByText(/never removes the mark/i)).toBeInTheDocument();
  });

  it('says no alerts were raised without implying the patient is safe', () => {
    renderStack([]);

    expect(screen.getByText(/no alerts in this window/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bsafe\b/i);
  });
});
