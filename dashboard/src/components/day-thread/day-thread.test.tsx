// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DayThread } from './day-thread';
import type { PatientRecordResponse, ReviewDraft } from '@/lib/dashboard-contracts';

type ConversationMessageRow = PatientRecordResponse['messages'][number];
type ClinicalEventRow = PatientRecordResponse['events'][number];
type DaySummary = NonNullable<PatientRecordResponse['daySummary']>;

const TZ = 'America/Toronto';

function message(
  overrides: Partial<ConversationMessageRow> & Pick<ConversationMessageRow, 'id'>,
): ConversationMessageRow {
  return {
    direction: 'inbound',
    body: 'hello',
    occurred_at: '2026-08-11T14:00:00.000Z',
    language: null,
    detected_language: 'en',
    normalized_english_meaning: null,
    translated_text: null,
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

function clinicalEvent(
  overrides: Partial<ClinicalEventRow> & Pick<ClinicalEventRow, 'id'>,
): ClinicalEventRow {
  return {
    event_type: 'observation',
    event_code: 'symptom:headache',
    statement_text: 'Headache reported',
    normalized_value: null,
    occurred_at: '2026-08-11T15:00:00.000Z',
    local_date: '2026-08-11',
    local_time: '11:00',
    patient_timezone: TZ,
    severity: null,
    patient_medication_id: null,
    dose_id: null,
    agent_turn_id: null,
    source_inbound_id: null,
    supersedes_id: null,
    created_at: '2026-08-11T15:01:00.000Z',
    ...overrides,
  };
}

function daySummary(events: DaySummary['structured_payload']['events']): DaySummary {
  return {
    id: 'summary-1',
    local_date: '2026-08-11',
    version: 1,
    input_hash: 'a'.repeat(64),
    event_count: events.length,
    highest_tier: 'important',
    summary_text: 'summary',
    window_start: '2026-08-11T04:00:00.000Z',
    window_end: '2026-08-12T04:00:00.000Z',
    structured_payload: {
      localDate: '2026-08-11',
      patientTimeZone: TZ,
      eventCount: events.length,
      detailedEventCount: events.length,
      truncated: false,
      eventIds: events.map((event) => event.eventId),
      events,
      symptomCount: 0,
      adherenceCounts: { taken: 0, delayed: 0, skipped: 0, stopped: 0, unknown: 0, question: 0 },
      highestPriority: 'important',
    },
    supersedes_id: null,
    created_at: '2026-08-12T04:00:01.000Z',
  };
}

function draft(overrides: Partial<ReviewDraft> & Pick<ReviewDraft, 'id'>): ReviewDraft {
  return {
    local_date: '2026-08-11',
    version: 1,
    input_hash: 'b'.repeat(64),
    draft_text: 'Patient reports a headache; confirmed dose taken at 10:05.',
    patient_statements: [],
    confirmed_facts: [],
    model_inferences: [],
    uncertainties: [],
    evidence_references: [],
    proposed_corrections: [],
    source_agent_turn_id: null,
    supersedes_id: null,
    created_at: '2026-08-11T20:00:00.000Z',
    is_latest: true,
    latest_action: null,
    ...overrides,
  };
}

describe('DayThread — R1: one merged log, no separate review queue', () => {
  it('renders messages and events together with no "Needs review first" / "Routine record" split', () => {
    render(
      <DayThread
        messages={[message({ id: 'm1' })]}
        events={[clinicalEvent({ id: 'e1' })]}
        evidence={[]}
        daySummary={null}
        timeZone={TZ}
        dayLabel="Aug 11, 2026"
      />,
    );

    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.getByText('Headache reported')).toBeInTheDocument();
    expect(screen.queryByText(/needs review first/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/routine record/i)).not.toBeInTheDocument();
  });
});

describe('DayThread — R2: absent priority renders unmarked, never dropped', () => {
  it('renders a standalone event with no summary coverage as structured but unmarked', () => {
    render(
      <DayThread
        messages={[]}
        events={[clinicalEvent({ id: 'e1' })]}
        evidence={[]}
        daySummary={null}
        timeZone={TZ}
        dayLabel="Aug 11, 2026"
      />,
    );

    expect(screen.getByText('Headache reported')).toBeInTheDocument();
    // Scoped to the log itself — the jump rail (day-census.tsx) always shows the words
    // "Emergency"/"Important" as static button labels regardless of count.
    expect(
      within(screen.getByRole('list')).queryByText(
        /emergency|important|routine|needs human review/i,
      ),
    ).not.toBeInTheDocument();
  });

  it('marks an event the day summary actually classified', () => {
    render(
      <DayThread
        messages={[]}
        events={[clinicalEvent({ id: 'e1' })]}
        evidence={[]}
        daySummary={daySummary([
          {
            eventId: 'e1',
            eventType: 'observation',
            eventCode: null,
            occurredAtUtc: '2026-08-11T15:00:00.000Z',
            severity: null,
            priority: 'emergency',
          },
        ])}
        timeZone={TZ}
        dayLabel="Aug 11, 2026"
      />,
    );

    expect(within(screen.getByRole('list')).getByText(/emergency/i)).toBeInTheDocument();
  });
});

describe('DayThread — R12: heading outline', () => {
  it('emits exactly one h2 for the day and no per-message headings', () => {
    render(
      <DayThread
        messages={[
          message({ id: 'm1' }),
          message({ id: 'm2', occurred_at: '2026-08-11T15:00:00.000Z' }),
        ]}
        events={[]}
        evidence={[]}
        daySummary={null}
        timeZone={TZ}
        dayLabel="Aug 11, 2026"
      />,
    );

    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
    expect(screen.queryByRole('heading', { level: 4 })).toBeNull();
  });
});

describe('DayThread — R10: the draft renders inline as the final marked row', () => {
  it('renders a draft preview row after every message and event', () => {
    render(
      <DayThread
        messages={[message({ id: 'm1' })]}
        events={[]}
        evidence={[]}
        daySummary={null}
        draft={draft({ id: 'd1' })}
        timeZone={TZ}
        dayLabel="Aug 11, 2026"
      />,
    );

    const items = screen.getAllByRole('listitem');
    expect(
      within(items[items.length - 1] as HTMLElement).getByText(/draft ready for review/i),
    ).toBeInTheDocument();
  });

  it('renders no draft row when draft is null', () => {
    render(
      <DayThread
        messages={[message({ id: 'm1' })]}
        events={[]}
        evidence={[]}
        daySummary={null}
        draft={null}
        timeZone={TZ}
        dayLabel="Aug 11, 2026"
      />,
    );

    expect(screen.queryByText(/draft ready for review/i)).not.toBeInTheDocument();
  });
});

describe('DayThread — §4.6 empty state', () => {
  it('shows one empty state naming the date when there are no messages or events', () => {
    render(
      <DayThread
        messages={[]}
        events={[]}
        evidence={[]}
        daySummary={null}
        timeZone={TZ}
        dayLabel="Aug 11, 2026"
      />,
    );

    expect(screen.getByText(/no activity on aug 11, 2026/i)).toBeInTheDocument();
  });
});

describe('DayThread — R15: focus and announcement on day change, not on first paint', () => {
  it('does not move focus or announce on the initial mount', () => {
    render(
      <DayThread
        messages={[message({ id: 'm1' })]}
        events={[]}
        evidence={[]}
        daySummary={null}
        timeZone={TZ}
        dayLabel="Aug 11, 2026"
      />,
    );

    expect(screen.getByRole('heading', { level: 2 })).not.toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('moves focus to the heading and announces the new date when dayLabel changes', () => {
    const { rerender } = render(
      <DayThread
        messages={[message({ id: 'm1' })]}
        events={[]}
        evidence={[]}
        daySummary={null}
        timeZone={TZ}
        dayLabel="Aug 11, 2026"
      />,
    );

    rerender(
      <DayThread
        messages={[message({ id: 'm2' })]}
        events={[]}
        evidence={[]}
        daySummary={null}
        timeZone={TZ}
        dayLabel="Aug 12, 2026"
      />,
    );

    expect(screen.getByRole('heading', { level: 2 })).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent(/aug 12, 2026/i);
  });
});
