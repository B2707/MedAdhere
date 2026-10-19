// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import {
  FDA_DISCLAIMER_RETRIEVED_DATE,
  FDA_DISCLAIMER_SOURCE,
  FDA_LABEL_DISCLAIMER,
} from '../../../../../packages/shared/src/fda-disclaimer';

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }));
vi.mock('@/components/nav-link', () => ({
  NavLink: ({ href, label }: { href: string; label: string; icon: ReactNode }) => (
    <a href={href}>{label}</a>
  ),
}));

import SafetyReviewsPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('/reviews/safety', () => {
  it('fetches and renders the safety queue contract', async () => {
    apiFetchMock.mockResolvedValue({
      status: 'ok',
      data: {
        stuckSendingThresholdMinutes: 15,
        limit: 100,
        events: [
          {
            id: 'event-1',
            patient_id: 'patient-1',
            display_name: 'Test patient',
            inbound_message_id: 'inbound-1',
            raw_body: 'I need medical advice',
            flag_category: 'medical_question',
            trigger_source: 'model',
            auto_reply_status: 'sent',
            created_at: '2026-07-29T12:00:00.000Z',
            first_detected_minutes_ago: 2,
            has_prior_failure: false,
            is_stale_sending: false,
            is_urgent: false,
            hints: [],
          },
        ],
      },
    });

    render(await SafetyReviewsPage());

    expect(apiFetchMock).toHaveBeenCalledWith('/api/reviews/safety', expect.anything());
    expect(
      screen.getByRole('heading', { level: 1, name: /safety reviews/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('event-1')).toBeInTheDocument();
    expect(screen.getByText(/next business day/i)).toBeInTheDocument();
    expect(screen.getByText(FDA_LABEL_DISCLAIMER)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /openFDA drug label API/i })).toHaveAttribute(
      'href',
      FDA_DISCLAIMER_SOURCE,
    );
    const disclaimer = screen.getByText(FDA_LABEL_DISCLAIMER).closest('footer');
    expect(disclaimer).not.toBeNull();
    expect(
      within(disclaimer!).getByText(new RegExp(FDA_DISCLAIMER_RETRIEVED_DATE)),
    ).toBeInTheDocument();
    expect(screen.getByText(/^1 event$/i)).toBeInTheDocument();
    expect(screen.queryByText(/list capped/i)).toBeNull();
  });

  it('shows an explicit cap note only when the returned event count reaches the limit', async () => {
    apiFetchMock.mockResolvedValue({
      status: 'ok',
      data: {
        stuckSendingThresholdMinutes: 15,
        limit: 1,
        events: [
          {
            id: 'event-1',
            patient_id: 'patient-1',
            display_name: 'Test patient',
            inbound_message_id: 'inbound-1',
            raw_body: 'I need medical advice',
            flag_category: 'medical_question',
            trigger_source: 'model',
            auto_reply_status: 'sent',
            created_at: '2026-07-29T12:00:00.000Z',
            first_detected_minutes_ago: 2,
            has_prior_failure: false,
            is_stale_sending: false,
            is_urgent: false,
            hints: [],
          },
        ],
      },
    });

    render(await SafetyReviewsPage());

    expect(screen.getByText(/^1 event$/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        /showing the first 1 events — list capped; oldest non-urgent items may be hidden/i,
      ),
    ).toBeInTheDocument();
  });

  it.each([
    ['unauthenticated', /not signed in/i],
    ['error', /couldn.t load safety reviews/i],
  ] as const)('renders a calm %s result state', async (status, copy) => {
    apiFetchMock.mockResolvedValue({ status });
    render(await SafetyReviewsPage());
    expect(screen.getByRole('heading', { name: copy })).toBeInTheDocument();
  });
});
