// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SafetyReviewQueue, type SafetyReviewEvent } from './safety-review-queue';

const baseEvent: SafetyReviewEvent = {
  id: '11111111-1111-4111-8111-111111111111',
  patient_id: '22222222-2222-4222-8222-222222222222',
  display_name: 'Test patient',
  inbound_message_id: '33333333-3333-4333-8333-333333333333',
  raw_body: 'I have a medication question',
  flag_category: 'medical_question',
  trigger_source: 'model',
  auto_reply_status: 'sent',
  created_at: '2026-07-29T12:00:00.000Z',
  first_detected_minutes_ago: 5,
  has_prior_failure: false,
  is_stale_sending: false,
  is_urgent: false,
  hints: [],
};

describe('SafetyReviewQueue — urgency, status, and review evidence', () => {
  it('renders rows in the server-supplied order without re-sorting', () => {
    const urgent: SafetyReviewEvent = {
      ...baseEvent,
      id: 'old-failed-crisis',
      flag_category: 'crisis',
      auto_reply_status: 'failed',
      first_detected_minutes_ago: 120,
      is_urgent: true,
    };
    const newerQuestion: SafetyReviewEvent = {
      ...baseEvent,
      id: 'new-medical-question',
      created_at: '2026-07-29T13:00:00.000Z',
    };

    render(
      <SafetyReviewQueue events={[newerQuestion, urgent]} stuckSendingThresholdMinutes={15} />,
    );

    const articles = screen.getAllByRole('article');
    expect(within(articles[0]!).getByText('new-medical-question')).toBeInTheDocument();
    expect(within(articles[1]!).getByText('old-failed-crisis')).toBeInTheDocument();
    expect(within(articles[1]!).getByText(/delivery failed/i)).toBeInTheDocument();
    const icon = within(articles[1]!)
      .getByText(/delivery failed/i)
      .querySelector('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon).not.toHaveAttribute('aria-label');
  });

  it('shows medical-question rows and the auto-reply status, first-detected age, source, and event id', () => {
    render(<SafetyReviewQueue events={[baseEvent]} stuckSendingThresholdMinutes={15} />);

    expect(screen.getByText(/medical question/i)).toBeInTheDocument();
    expect(screen.getByText('Sent to carrier')).toBeInTheDocument();
    expect(screen.getByText(/^sent$/i)).toBeInTheDocument();
    expect(screen.getByText(/first detected 5 minutes ago/i)).toBeInTheDocument();
    expect(screen.getByText(/source: model/i)).toBeInTheDocument();
    expect(screen.getByText(/created 2026-07-29 12:00 UTC/i)).toBeInTheDocument();
    expect(screen.getByText(baseEvent.id)).toBeInTheDocument();
  });

  it('labels delivery follow-up honestly and marks severe categories independently', () => {
    const crisisSent: SafetyReviewEvent = {
      ...baseEvent,
      id: 'sent-crisis',
      flag_category: 'crisis',
      is_urgent: false,
    };
    render(
      <SafetyReviewQueue events={[crisisSent, baseEvent]} stuckSendingThresholdMinutes={15} />,
    );

    expect(screen.getByRole('heading', { name: /awaiting review/i })).toBeInTheDocument();
    expect(screen.queryByText(/rou[t]ine/i)).toBeNull();
    const articles = screen.getAllByRole('article');
    expect(within(articles[0]!).getByText('Sent to carrier')).toBeInTheDocument();
    expect(within(articles[0]!).getByText('crisis')).toHaveClass('bg-[var(--color-danger-50)]');
    expect(within(articles[1]!).getByText('medical question')).toHaveClass(
      'bg-[var(--color-canvas-raised)]',
    );
  });

  it('identifies a stale sending event using the server-supplied state and threshold context', () => {
    render(
      <SafetyReviewQueue
        events={[
          {
            ...baseEvent,
            id: 'stale-sending',
            flag_category: 'acute_physical',
            auto_reply_status: 'sending',
            first_detected_minutes_ago: 16,
            is_stale_sending: true,
            is_urgent: true,
            has_prior_failure: true,
          },
        ]}
        stuckSendingThresholdMinutes={15}
      />,
    );

    expect(screen.getByText('sending')).toBeInTheDocument();
    expect(screen.getByText(/first detected 16 minutes ago/i)).toBeInTheDocument();
    expect(screen.getByText(/stuck sending/i)).toBeInTheDocument();
    expect(screen.getByText(/prior failure/i)).toBeInTheDocument();
    expect(screen.getByText(/older than 15 minutes/i)).toBeInTheDocument();
  });

  it('renders attached info and elevated ADE hints without inventing info prominence', () => {
    const { container } = render(
      <SafetyReviewQueue
        events={[
          {
            ...baseEvent,
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
        stuckSendingThresholdMinutes={15}
      />,
    );

    expect(screen.getByText(/nauseous/i)).toBeInTheDocument();
    expect(screen.getByText(/face swelling/i)).toBeInTheDocument();
    expect(screen.getAllByText(/elevated label match/i)).toHaveLength(1);
    expect(container.textContent).not.toContain('undefined');
  });

  it('renders a safety event with no recorded auto-reply status without throwing', () => {
    const { container } = render(
      <SafetyReviewQueue
        events={[{ ...baseEvent, auto_reply_status: null }]}
        stuckSendingThresholdMinutes={15}
      />,
    );

    expect(screen.getByText(/not recorded/i)).toBeInTheDocument();
    expect(screen.getByText(/status unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText('Sent to carrier')).toBeNull();
    expect(container.textContent).not.toContain('undefined');
  });

  it('does not claim a fresh sending auto-reply was delivered', () => {
    render(
      <SafetyReviewQueue
        events={[{ ...baseEvent, auto_reply_status: 'sending' }]}
        stuckSendingThresholdMinutes={15}
      />,
    );

    expect(screen.getAllByText(/^sending$/i)).toHaveLength(2);
    expect(screen.queryByText('Sent to carrier')).toBeNull();
  });

  it.each([
    ['failed', 'Delivery failed'],
    ['suppressed', 'Suppressed'],
  ] as const)(
    'keeps an urgent %s delivery status reachable instead of masking it with urgency',
    (autoReplyStatus, expectedLabel) => {
      render(
        <SafetyReviewQueue
          events={[
            {
              ...baseEvent,
              auto_reply_status: autoReplyStatus,
              is_urgent: true,
            },
          ]}
          stuckSendingThresholdMinutes={15}
        />,
      );

      expect(screen.getByText(expectedLabel)).toBeInTheDocument();
      expect(screen.queryByText('Needs follow-up')).toBeNull();
    },
  );

  it('formats event ages from the server-provided minute count without a client clock', () => {
    const ages = [
      [-2, 'less than 1 minute old'],
      [1, '1 minute old'],
      [60, '1 hour old'],
      [120, '2 hours old'],
      [1_440, '1 day old'],
      [2_880, '2 days old'],
    ] as const;

    render(
      <SafetyReviewQueue
        events={ages.map(([ageMinutes], index) => ({
          ...baseEvent,
          id: `event-${index}`,
          display_name: null,
          first_detected_minutes_ago: ageMinutes,
        }))}
        stuckSendingThresholdMinutes={15}
      />,
    );

    for (const [, label] of ages) {
      expect(
        screen.getByText(new RegExp(`first detected ${label.replace(' old', ' ago')}`, 'i')),
      ).toBeInTheDocument();
    }
    expect(screen.getAllByText(baseEvent.patient_id)).toHaveLength(ages.length);
  });

  it('renders attacker-supplied reply text as escaped text without creating elements', () => {
    const payload = '<img src=x onerror=alert(1)>\n<script>alert(2)</script>';
    const { container } = render(
      <SafetyReviewQueue
        events={[{ ...baseEvent, raw_body: payload }]}
        stuckSendingThresholdMinutes={15}
      />,
    );
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(container.querySelector('img, script')).toBeNull();
  });

  it('renders a calm empty state while retaining the next-business-day cadence', () => {
    render(<SafetyReviewQueue events={[]} stuckSendingThresholdMinutes={15} />);
    expect(screen.getByRole('heading', { name: /no items awaiting review/i })).toBeInTheDocument();
    expect(screen.getByText(/safety events will appear here/i)).toBeInTheDocument();
    expect(screen.getByText(/next business day/i)).toBeInTheDocument();
  });
});
