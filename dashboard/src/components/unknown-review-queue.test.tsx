// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UnknownReviewQueue, type UnknownReviewItem } from './unknown-review-queue';

const baseItem: UnknownReviewItem = {
  id: '11111111-1111-4111-8111-111111111111',
  patient_id: '22222222-2222-4222-8222-222222222222',
  display_name: 'Test patient',
  inbound_message_id: '33333333-3333-4333-8333-333333333333',
  raw_body: 'I am not sure',
  adherence_state: 'unknown',
  reason_code: 'other',
  dose_id: '44444444-4444-4444-8444-444444444444',
  created_at: '2026-07-29T12:00:00.000Z',
  queue_kind: 'ambiguity',
  is_unknown: true,
  is_unattributed: false,
  is_label_match: false,
  has_no_outcome: false,
  has_elevated_hint: false,
  hints: [],
};

describe('UnknownReviewQueue — explicit review arms', () => {
  it('labels ambiguous and unattributed arms independently, including a row in both', () => {
    render(
      <UnknownReviewQueue
        items={[
          baseItem,
          {
            ...baseItem,
            id: 'unattributed',
            inbound_message_id: '55555555-5555-4555-8555-555555555555',
            dose_id: null,
            is_unattributed: true,
          },
        ]}
      />,
    );

    const articles = screen.getAllByRole('article');
    expect(within(articles[0]!).getByText(/ambiguous classification/i)).toBeInTheDocument();
    expect(within(articles[0]!).queryByText(/unattributed reply/i)).toBeNull();
    expect(within(articles[1]!).getByText(/ambiguous classification/i)).toBeInTheDocument();
    expect(within(articles[1]!).getByText(/unattributed reply/i)).toBeInTheDocument();
  });

  it('surfaces a dedicated label-match arm with its DB-shaped associative hint', () => {
    const { container } = render(
      <UnknownReviewQueue
        items={[
          {
            ...baseItem,
            id: 'label-match',
            adherence_state: 'taken',
            reason_code: 'side_effect',
            queue_kind: 'label_match',
            is_unknown: false,
            is_label_match: true,
            has_elevated_hint: false,
            hints: [
              {
                matched_phrase: 'felt queasy',
                meddra_pt: 'Nausea',
                hint_level: 'info',
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText(/label match/i)).toBeInTheDocument();
    expect(screen.getByText(/felt queasy/i)).toBeInTheDocument();
    expect(screen.getByText(/Nausea/)).toBeInTheDocument();
    expect(screen.queryByText(/elevated label match/i)).toBeNull();
    expect(container.textContent).not.toContain('undefined');
  });

  it('renders multiple label-match hints but only one queue row for one backend item', () => {
    render(
      <UnknownReviewQueue
        items={[
          {
            ...baseItem,
            queue_kind: 'label_match',
            is_unknown: false,
            is_label_match: true,
            has_elevated_hint: true,
            hints: [
              {
                matched_phrase: 'nauseous',
                meddra_pt: 'Nausea',
                hint_level: 'info',
              },
              {
                matched_phrase: 'face swelling',
                meddra_pt: 'Angioedema',
                hint_level: 'elevated',
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByText(/nauseous/i)).toBeInTheDocument();
    expect(screen.getByText(/face swelling/i)).toBeInTheDocument();
  });

  it('renders a label match with no joined classification without throwing or showing undefined', () => {
    const { container } = render(
      <UnknownReviewQueue
        items={[
          {
            ...baseItem,
            queue_kind: 'label_match',
            adherence_state: null,
            reason_code: null,
            dose_id: null,
            is_unknown: false,
            is_label_match: true,
          },
        ]}
      />,
    );

    expect(screen.getByText(/classification unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/reason unavailable/i)).toBeInTheDocument();
    expect(container.textContent).not.toContain('undefined');
  });

  it('renders a calm empty state', () => {
    render(<UnknownReviewQueue items={[]} />);
    expect(
      screen.getByRole('heading', { name: /no items awaiting review/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/ambiguous classifications and label matches/i)).toBeInTheDocument();
  });

  it('renders the server-provided elevated and no-outcome markers', () => {
    render(
      <UnknownReviewQueue
        items={[
          {
            ...baseItem,
            queue_kind: 'label_match',
            is_unknown: false,
            is_label_match: true,
            has_no_outcome: true,
            has_elevated_hint: true,
            hints: [
              {
                matched_phrase: 'face swelling',
                meddra_pt: 'Angioedema',
                hint_level: 'elevated',
              },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByText(/elevated label match/i)).toBeInTheDocument();
    expect(screen.getByText(/no classifier outcome/i)).toBeInTheDocument();
  });

  it('renders shuffled input in the server-supplied order without client re-sorting', () => {
    render(
      <UnknownReviewQueue
        items={[
          { ...baseItem, id: 'info-first', raw_body: 'First from server' },
          {
            ...baseItem,
            id: 'elevated-second',
            raw_body: 'Second from server',
            has_elevated_hint: true,
          },
        ]}
      />,
    );
    const articles = screen.getAllByRole('article');
    expect(within(articles[0]!).getByText('First from server')).toBeInTheDocument();
    expect(within(articles[1]!).getByText('Second from server')).toBeInTheDocument();
  });

  it('renders attacker-supplied reply text as escaped text without creating elements', () => {
    const payload = '<img src=x onerror=alert(1)>\n<script>alert(2)</script>';
    const { container } = render(
      <UnknownReviewQueue items={[{ ...baseItem, raw_body: payload }]} />,
    );
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(container.querySelector('img, script')).toBeNull();
  });
});
