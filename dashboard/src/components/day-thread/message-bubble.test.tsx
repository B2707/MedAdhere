// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageBubble } from './message-bubble';
import type { PatientRecordResponse } from '@/lib/dashboard-contracts';

type ConversationMessageRow = PatientRecordResponse['messages'][number];

const TZ = 'America/Toronto';

function message(
  overrides: Partial<ConversationMessageRow> & Pick<ConversationMessageRow, 'id'>,
): ConversationMessageRow {
  return {
    direction: 'inbound',
    body: 'راسي يوجعني',
    occurred_at: '2026-08-11T14:05:00.000Z',
    language: null,
    detected_language: 'ar',
    normalized_english_meaning: 'The patient reports a headache.',
    translated_text: 'My head hurts',
    message_kind: null,
    status: null,
    reminder_attempt: null,
    clarification_topic: null,
    is_late: null,
    agent_turn_id: null,
    in_reply_to_inbound_id: null,
    sent_at: null,
    ...overrides,
  };
}

describe('MessageBubble — direction (§4.3, three redundant channels)', () => {
  it('aligns an inbound message with a top-left tail corner, no per-message heading', () => {
    render(<MessageBubble message={message({ id: 'm1' })} events={[]} timeZone={TZ} />);

    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText('راسي يوجعني')).toBeInTheDocument();
  });

  it('renders an outbound message with a kicker built from message_kind', () => {
    render(
      <MessageBubble
        message={message({
          id: 'out',
          direction: 'outbound',
          body: 'Time for your dose.',
          message_kind: 'check_in',
        })}
        events={[]}
        timeZone={TZ}
      />,
    );

    expect(screen.getByText('CHECK-IN')).toBeInTheDocument();
  });

  it('builds a REMINDER kicker with the attempt number', () => {
    render(
      <MessageBubble
        message={message({
          id: 'out',
          direction: 'outbound',
          body: 'Still there?',
          message_kind: 'reminder',
          reminder_attempt: 2,
        })}
        events={[]}
        timeZone={TZ}
      />,
    );

    expect(screen.getByText('REMINDER 2')).toBeInTheDocument();
  });

  it('builds a CLARIFICATION kicker naming the topic', () => {
    render(
      <MessageBubble
        message={message({
          id: 'out',
          direction: 'outbound',
          body: 'What time did you take it?',
          message_kind: 'clarification',
          clarification_topic: 'dose_time',
        })}
        events={[]}
        timeZone={TZ}
      />,
    );

    expect(screen.getByText('CLARIFICATION · DOSE TIME')).toBeInTheDocument();
  });

  it('renders no kicker for an inbound message', () => {
    render(<MessageBubble message={message({ id: 'm1' })} events={[]} timeZone={TZ} />);

    expect(screen.queryByText(/^CHECK-IN$|^SAFETY$|^FALLBACK$/)).not.toBeInTheDocument();
  });
});

describe('MessageBubble — never-sent evidence (exact guard preserved from original-messages)', () => {
  it('badges an outbound row that never reached the provider as "Not sent"', () => {
    render(
      <MessageBubble
        message={message({
          id: 'x',
          direction: 'outbound',
          body: 'Did you take it?',
          status: 'failed',
          sent_at: null,
        })}
        events={[]}
        timeZone={TZ}
      />,
    );

    expect(screen.getByText(/not sent/i)).toBeInTheDocument();
  });

  it('does not badge an in-flight reply that has not reached the provider yet', () => {
    render(
      <MessageBubble
        message={message({
          id: 'x',
          direction: 'outbound',
          body: 'Did you take it?',
          status: 'prepared',
          sent_at: null,
        })}
        events={[]}
        timeZone={TZ}
      />,
    );

    expect(screen.queryByText(/not sent/i)).not.toBeInTheDocument();
  });

  it('does not badge inbound rows even when sent_at is explicitly null', () => {
    render(
      <MessageBubble message={message({ id: 'in', sent_at: null })} events={[]} timeZone={TZ} />,
    );

    expect(screen.queryByText(/not sent/i)).not.toBeInTheDocument();
  });

  it('does not badge an outbound row an old backend omits sent_at for (cannot distinguish)', () => {
    const withoutSentAt = message({
      id: 'legacy',
      direction: 'outbound',
      body: 'legacy',
      status: 'failed',
    });
    delete (withoutSentAt as { sent_at?: string | null }).sent_at;
    render(<MessageBubble message={withoutSentAt} events={[]} timeZone={TZ} />);

    expect(screen.queryByText(/not sent/i)).not.toBeInTheDocument();
  });
});

describe('MessageBubble — R3: translation and normalized meaning are now rendered', () => {
  it('shows the immutable original body with the derived text collapsed behind a disclosure', () => {
    render(<MessageBubble message={message({ id: 'm1' })} events={[]} timeZone={TZ} />);

    expect(screen.getByText('راسي يوجعني')).toBeInTheDocument();
    expect(screen.getByText('My head hurts')).not.toBeVisible();

    const disclosure = screen.getByText(/translation.*normalized meaning/i);
    expect(disclosure).toBeInTheDocument();
  });

  it('reveals the translation and normalized meaning once the disclosure is opened', () => {
    render(<MessageBubble message={message({ id: 'm1' })} events={[]} timeZone={TZ} />);

    fireEvent.click(screen.getByText(/translation.*normalized meaning/i));

    expect(screen.getByText('My head hurts')).toBeVisible();
    expect(screen.getByText('The patient reports a headache.')).toBeVisible();
  });

  it('renders no disclosure when both derived fields are null', () => {
    render(
      <MessageBubble
        message={message({ id: 'm1', translated_text: null, normalized_english_meaning: null })}
        events={[]}
        timeZone={TZ}
      />,
    );

    expect(screen.queryByText(/translation.*normalized meaning/i)).not.toBeInTheDocument();
  });

  it('renders the disclosure with only translated_text present', () => {
    render(
      <MessageBubble
        message={message({ id: 'm1', normalized_english_meaning: null })}
        events={[]}
        timeZone={TZ}
      />,
    );

    expect(screen.getByText(/translation.*normalized meaning/i)).toBeInTheDocument();
    expect(screen.getByText('My head hurts')).toBeInTheDocument();
  });

  it('never replaces the original body with the translation', () => {
    render(<MessageBubble message={message({ id: 'm1' })} events={[]} timeZone={TZ} />);

    const original = screen.getByText('راسي يوجعني');
    expect(original.textContent).toBe('راسي يوجعني');
  });
});

describe('MessageBubble — legacy and time', () => {
  it('states a legacy body was never stored and does not reconstruct it (verbatim copy)', () => {
    render(
      <MessageBubble message={message({ id: 'legacy', body: null })} events={[]} timeZone={TZ} />,
    );

    const note = screen.getByText(/was not stored for this legacy record/i);
    expect(note.textContent).toMatch(/It is not reconstructed\.$/);
  });

  it('shows the patient-local clock time in the gutter', () => {
    render(<MessageBubble message={message({ id: 'm1' })} events={[]} timeZone={TZ} />);

    expect(screen.getByText('10:05')).toBeInTheDocument();
  });

  it('wraps long unbroken text so a narrow viewport cannot overflow', () => {
    render(
      <MessageBubble
        message={message({ id: 'm1', body: 'a'.repeat(400) })}
        events={[]}
        timeZone={TZ}
      />,
    );

    expect(screen.getByText('a'.repeat(400))).toHaveClass('break-words');
  });

  it('renders the body with dir="auto" for bidi-safe rendering', () => {
    render(<MessageBubble message={message({ id: 'm1' })} events={[]} timeZone={TZ} />);

    expect(screen.getByText('راسي يوجعني')).toHaveAttribute('dir', 'auto');
  });
});

describe('MessageBubble — tethered events render beneath the bubble', () => {
  it('renders each tethered event mark below the message', () => {
    render(
      <MessageBubble
        message={message({ id: 'm1' })}
        events={[
          {
            event: {
              id: 'e1',
              event_type: 'observation',
              event_code: 'symptom:headache',
              statement_text: 'Headache reported',
              normalized_value: null,
              occurred_at: '2026-08-11T14:05:30.000Z',
              local_date: '2026-08-11',
              local_time: '10:05',
              patient_timezone: TZ,
              severity: null,
              patient_medication_id: null,
              dose_id: null,
              agent_turn_id: null,
              source_inbound_id: 'm1',
              supersedes_id: null,
              created_at: '2026-08-11T14:06:00.000Z',
            },
            priority: 'important',
            evidence: [],
          },
        ]}
        timeZone={TZ}
      />,
    );

    expect(screen.getByText('Headache reported')).toBeInTheDocument();
    expect(screen.getByText(/important/i)).toBeInTheDocument();
  });

  it('renders nothing extra when there are no tethered events', () => {
    const { container } = render(
      <MessageBubble message={message({ id: 'm1' })} events={[]} timeZone={TZ} />,
    );

    expect(container.querySelectorAll('[id^="event-"]')).toHaveLength(0);
  });
});
