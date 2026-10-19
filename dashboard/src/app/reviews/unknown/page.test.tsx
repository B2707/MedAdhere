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

import UnknownReviewsPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('/reviews/unknown', () => {
  it('fetches and renders the dedicated label-match arm', async () => {
    apiFetchMock.mockResolvedValue({
      status: 'ok',
      data: {
        limit: 100,
        items: [
          {
            id: 'label-item',
            patient_id: 'patient-1',
            display_name: 'Test patient',
            inbound_message_id: 'inbound-1',
            raw_body: 'I felt queasy',
            adherence_state: 'taken',
            reason_code: 'side_effect',
            dose_id: 'dose-1',
            created_at: '2026-07-29T12:00:00.000Z',
            queue_kind: 'label_match',
            is_unknown: false,
            is_unattributed: false,
            is_label_match: true,
            has_no_outcome: false,
            has_elevated_hint: true,
            hints: [
              {
                matched_phrase: 'queasy',
                meddra_pt: 'Nausea',
                hint_level: 'elevated',
              },
            ],
          },
        ],
      },
    });

    render(await UnknownReviewsPage());

    expect(apiFetchMock).toHaveBeenCalledWith('/api/reviews/unknown', expect.anything());
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: /classification and label-match reviews/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Label match')).toBeInTheDocument();
    expect(screen.getAllByText(/queasy/i)).toHaveLength(2);
    expect(screen.getByText(/elevated label match/i)).toBeInTheDocument();
    expect(screen.getByText(/researcher review cadence: next business day/i)).toBeInTheDocument();
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
    expect(screen.getByText(/^1 item$/i)).toBeInTheDocument();
    expect(screen.queryByText(/list capped/i)).toBeNull();
  });

  it('shows an explicit cap note only when the returned item count reaches the limit', async () => {
    apiFetchMock.mockResolvedValue({
      status: 'ok',
      data: {
        limit: 1,
        items: [
          {
            id: 'unknown-item',
            patient_id: 'patient-1',
            display_name: 'Test patient',
            inbound_message_id: 'inbound-1',
            raw_body: 'Maybe later',
            adherence_state: 'unknown',
            reason_code: 'other',
            dose_id: 'dose-1',
            created_at: '2026-07-29T12:00:00.000Z',
            queue_kind: 'ambiguity',
            is_unknown: true,
            is_unattributed: false,
            is_label_match: false,
            has_no_outcome: false,
            has_elevated_hint: false,
            hints: [],
          },
        ],
      },
    });

    render(await UnknownReviewsPage());

    expect(screen.getByText(/^1 item$/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        /showing the first 1 items — list capped; oldest lower-priority items may be hidden/i,
      ),
    ).toBeInTheDocument();
  });

  it.each([
    ['unauthenticated', /not signed in/i],
    ['error', /couldn.t load classification and label-match reviews/i],
  ] as const)('renders a calm %s result state', async (status, copy) => {
    apiFetchMock.mockResolvedValue({ status });
    render(await UnknownReviewsPage());
    expect(screen.getByRole('heading', { name: copy })).toBeInTheDocument();
  });
});
