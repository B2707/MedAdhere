import { describe, expect, it } from 'vitest';
import { mergeThread, type MergeThreadInput } from './thread-merge';
import type { PatientRecordResponse, ReviewDraft } from '@/lib/dashboard-contracts';

/*
 * thread-merge.test.ts — TDD for the ONE pure function behind the day thread
 * (DESIGN-SPEC.md §4.2). This is the R2 mechanism: a `clinical_event` absent from the day
 * summary's structured payload must merge in as an UNMARKED, structured row — never dropped.
 */

type ConversationMessageRow = PatientRecordResponse['messages'][number];
type ClinicalEventRow = PatientRecordResponse['events'][number];
type EventEvidence = PatientRecordResponse['evidence'][number];
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
    statement_text: 'headache',
    normalized_value: null,
    occurred_at: '2026-08-11T14:05:00.000Z',
    local_date: '2026-08-11',
    local_time: '10:05',
    patient_timezone: TZ,
    severity: null,
    patient_medication_id: null,
    dose_id: null,
    agent_turn_id: null,
    source_inbound_id: null,
    supersedes_id: null,
    created_at: '2026-08-11T14:06:00.000Z',
    ...overrides,
  };
}

function evidenceRow(
  overrides: Partial<EventEvidence> & Pick<EventEvidence, 'clinical_event_id'>,
): EventEvidence {
  return {
    evidence_id: 'evidence-1',
    template_id: 'ddi.pair.v1',
    source: 'ddinter',
    source_version: '2.0',
    evidence_code: 'metformin-alcohol',
    passage: 'Direct interaction evidence.',
    url: 'https://ddinter.scbdd.com/',
    language: 'en',
    coverage_state: 'direct_evidence',
    ...overrides,
  };
}

function daySummary(
  events: DaySummary['structured_payload']['events'],
  overrides: Partial<DaySummary> = {},
): DaySummary {
  return {
    id: 'summary-1',
    local_date: '2026-08-11',
    version: 1,
    input_hash: 'a'.repeat(64),
    event_count: events.length,
    highest_tier: 'routine',
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
      highestPriority: 'routine',
    },
    supersedes_id: null,
    created_at: '2026-08-12T04:00:01.000Z',
    ...overrides,
  };
}

function draft(overrides: Partial<ReviewDraft> & Pick<ReviewDraft, 'id'>): ReviewDraft {
  return {
    local_date: '2026-08-11',
    version: 1,
    input_hash: 'b'.repeat(64),
    draft_text: 'Draft summary text.',
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

function baseInput(overrides: Partial<MergeThreadInput> = {}): MergeThreadInput {
  return { messages: [], events: [], evidence: [], daySummary: null, draft: null, ...overrides };
}

describe('mergeThread — ordering and interleaving', () => {
  it('interleaves messages and standalone events into one chronological sequence', () => {
    const items = mergeThread(
      baseInput({
        messages: [
          message({ id: 'm1', occurred_at: '2026-08-11T08:00:00.000Z' }),
          message({ id: 'm2', occurred_at: '2026-08-11T16:00:00.000Z' }),
        ],
        events: [clinicalEvent({ id: 'e1', occurred_at: '2026-08-11T12:00:00.000Z' })],
      }),
    );

    expect(items.map((item) => item.id)).toEqual(['m1', 'e1', 'm2']);
    expect(items.map((item) => item.kind)).toEqual(['message', 'event', 'message']);
  });

  it('uses id as a stable tiebreaker when two items share an exact timestamp', () => {
    const items = mergeThread(
      baseInput({
        messages: [message({ id: 'zzz', occurred_at: '2026-08-11T12:00:00.000Z' })],
        events: [clinicalEvent({ id: 'aaa', occurred_at: '2026-08-11T12:00:00.000Z' })],
      }),
    );

    // 'aaa' < 'zzz' lexicographically — deterministic regardless of input array order.
    expect(items.map((item) => item.id)).toEqual(['aaa', 'zzz']);
  });

  it('produces the identical order regardless of input array order (true sort, not a passthrough)', () => {
    const messages = [
      message({ id: 'm-late', occurred_at: '2026-08-11T20:00:00.000Z' }),
      message({ id: 'm-early', occurred_at: '2026-08-11T06:00:00.000Z' }),
    ];
    const items = mergeThread(baseInput({ messages }));

    expect(items.map((item) => item.id)).toEqual(['m-early', 'm-late']);
  });

  it('orders correctly across a local-midnight boundary using the UTC instant, not local wall time', () => {
    // 2026-08-11T23:30 Toronto (EDT, UTC-4) is 2026-08-12T03:30Z — later in UTC than the
    // 04:00Z entry below despite being on an earlier LOCAL date. Ordering must follow the
    // stored UTC instant, never a locally-recomputed one.
    const items = mergeThread(
      baseInput({
        messages: [
          message({ id: 'late-utc', occurred_at: '2026-08-12T03:30:00.000Z' }),
          message({ id: 'early-utc', occurred_at: '2026-08-11T04:00:00.000Z' }),
        ],
      }),
    );

    expect(items.map((item) => item.id)).toEqual(['early-utc', 'late-utc']);
  });
});

describe('mergeThread — R2: absent priority renders unmarked, never dropped', () => {
  it('gives a standalone event priority "none" when the day summary is null', () => {
    const items = mergeThread(
      baseInput({ events: [clinicalEvent({ id: 'e1' })], daySummary: null }),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'event', id: 'e1' });
    if (items[0]?.kind === 'event') {
      expect(items[0].event.priority).toBe('none');
    }
  });

  it('gives a standalone event priority "none" when it is absent from the summary payload', () => {
    const items = mergeThread(
      baseInput({
        events: [clinicalEvent({ id: 'covered' }), clinicalEvent({ id: 'uncovered' })],
        daySummary: daySummary([
          {
            eventId: 'covered',
            eventType: 'observation',
            eventCode: null,
            occurredAtUtc: '2026-08-11T14:05:00.000Z',
            severity: null,
            priority: 'important',
          },
        ]),
      }),
    );

    const uncovered = items.find((item) => item.id === 'uncovered');
    const covered = items.find((item) => item.id === 'covered');
    expect(uncovered?.kind).toBe('event');
    expect(covered?.kind).toBe('event');
    if (uncovered?.kind === 'event') expect(uncovered.event.priority).toBe('none');
    if (covered?.kind === 'event') expect(covered.event.priority).toBe('important');
  });

  it('never drops an event even when truncated:true and it is missing from the payload', () => {
    const items = mergeThread(
      baseInput({
        events: [clinicalEvent({ id: 'dropped-from-summary' })],
        daySummary: daySummary([], {
          structured_payload: { ...daySummary([]).structured_payload, truncated: true },
        }),
      }),
    );

    expect(items.map((item) => item.id)).toContain('dropped-from-summary');
  });

  it('carries a real priority through for a routine-tier event (routine is MARKED, not unmarked)', () => {
    const items = mergeThread(
      baseInput({
        events: [clinicalEvent({ id: 'e1' })],
        daySummary: daySummary([
          {
            eventId: 'e1',
            eventType: 'observation',
            eventCode: null,
            occurredAtUtc: '2026-08-11T14:05:00.000Z',
            severity: null,
            priority: 'routine',
          },
        ]),
      }),
    );

    const item = items[0];
    expect(item?.kind).toBe('event');
    if (item?.kind === 'event') expect(item.event.priority).toBe('routine');
  });
});

describe('mergeThread — the event row is its own authority on tier (canon inversion guard)', () => {
  // The day summary is OPTIONAL (it may not have run yet) and detail-capped, so it can never
  // be the only source of a mark. `clinical_event.event_type='alert'` + `event_code` IS the
  // AI classification — the same derivation the data API uses for `patient_alert.tier`
  // (backend `PATIENT_ALERTS_SQL`). An emergency that renders as a plain grey row because the
  // summary is missing is the exact canon inversion the day thread exists to prevent.
  it('marks an alert-typed emergency event when the day summary is null', () => {
    const items = mergeThread(
      baseInput({
        events: [clinicalEvent({ id: 'e1', event_type: 'alert', event_code: 'emergency' })],
        daySummary: null,
      }),
    );

    const item = items[0];
    expect(item?.kind).toBe('event');
    if (item?.kind === 'event') expect(item.event.priority).toBe('emergency');
  });

  it('marks an alert-typed important event that is absent from the summary payload', () => {
    const items = mergeThread(
      baseInput({
        events: [clinicalEvent({ id: 'beyond-cap', event_type: 'alert', event_code: 'important' })],
        daySummary: daySummary([], {
          structured_payload: { ...daySummary([]).structured_payload, truncated: true },
        }),
      }),
    );

    const item = items[0];
    if (item?.kind === 'event') expect(item.event.priority).toBe('important');
  });

  it('gives any other alert event_code the fallback tier (system failure, needs a human)', () => {
    const items = mergeThread(
      baseInput({
        events: [clinicalEvent({ id: 'e1', event_type: 'alert', event_code: 'unparsed' })],
      }),
    );

    const item = items[0];
    if (item?.kind === 'event') expect(item.event.priority).toBe('fallback');
  });

  it('keeps the STRONGER tier when the summary under-rates the event row', () => {
    const items = mergeThread(
      baseInput({
        events: [clinicalEvent({ id: 'e1', event_type: 'alert', event_code: 'emergency' })],
        daySummary: daySummary([
          {
            eventId: 'e1',
            eventType: 'alert',
            eventCode: 'emergency',
            occurredAtUtc: '2026-08-11T14:05:00.000Z',
            severity: null,
            priority: 'routine',
          },
        ]),
      }),
    );

    const item = items[0];
    if (item?.kind === 'event') expect(item.event.priority).toBe('emergency');
  });

  it('still honours a summary tier that is STRONGER than the row (non-alert rows are unchanged)', () => {
    const items = mergeThread(
      baseInput({
        events: [clinicalEvent({ id: 'e1', event_type: 'observation', event_code: 'symptom' })],
        daySummary: daySummary([
          {
            eventId: 'e1',
            eventType: 'observation',
            eventCode: 'symptom',
            occurredAtUtc: '2026-08-11T14:05:00.000Z',
            severity: null,
            priority: 'emergency',
          },
        ]),
      }),
    );

    const item = items[0];
    if (item?.kind === 'event') expect(item.event.priority).toBe('emergency');
  });

  it('marks a TETHERED alert emergency too (the mark cannot depend on where it renders)', () => {
    const items = mergeThread(
      baseInput({
        messages: [message({ id: 'm1' })],
        events: [
          clinicalEvent({
            id: 'e1',
            source_inbound_id: 'm1',
            event_type: 'alert',
            event_code: 'emergency',
          }),
        ],
        daySummary: null,
      }),
    );

    const item = items[0];
    if (item?.kind === 'message') expect(item.events[0]?.priority).toBe('emergency');
  });
});

describe('mergeThread — tethering', () => {
  it('attaches an event to its source message when source_inbound_id matches a message in this day', () => {
    const items = mergeThread(
      baseInput({
        messages: [message({ id: 'm1', occurred_at: '2026-08-11T14:00:00.000Z' })],
        events: [
          clinicalEvent({
            id: 'e1',
            source_inbound_id: 'm1',
            occurred_at: '2026-08-11T14:00:05.000Z',
          }),
        ],
      }),
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('message');
    if (items[0]?.kind === 'message') {
      expect(items[0].events.map((e) => e.event.id)).toEqual(['e1']);
    }
  });

  it('renders a tethered event directly beneath its source regardless of millisecond drift', () => {
    const items = mergeThread(
      baseInput({
        messages: [
          message({ id: 'm1', occurred_at: '2026-08-11T14:00:00.000Z' }),
          message({ id: 'm2', occurred_at: '2026-08-11T14:00:01.000Z' }),
        ],
        // The event's own occurred_at is LATER than m2, but it must stay tethered to m1.
        events: [
          clinicalEvent({
            id: 'e1',
            source_inbound_id: 'm1',
            occurred_at: '2026-08-11T15:00:00.000Z',
          }),
        ],
      }),
    );

    expect(items.map((item) => item.id)).toEqual(['m1', 'm2']);
    const m1 = items.find((item) => item.id === 'm1');
    if (m1?.kind === 'message') expect(m1.events.map((e) => e.event.id)).toEqual(['e1']);
  });

  it('emits a standalone event item when source_inbound_id points outside this day’s messages', () => {
    const items = mergeThread(
      baseInput({
        messages: [message({ id: 'm1' })],
        events: [clinicalEvent({ id: 'e1', source_inbound_id: 'not-in-this-day' })],
      }),
    );

    const event = items.find((item) => item.id === 'e1');
    expect(event?.kind).toBe('event');
  });

  it('emits a standalone event item when source_inbound_id is null', () => {
    const items = mergeThread(
      baseInput({ events: [clinicalEvent({ id: 'e1', source_inbound_id: null })] }),
    );

    expect(items[0]?.kind).toBe('event');
  });

  it('attaches multiple events to the same message in occurred_at order', () => {
    const items = mergeThread(
      baseInput({
        messages: [message({ id: 'm1' })],
        events: [
          clinicalEvent({
            id: 'e-second',
            source_inbound_id: 'm1',
            occurred_at: '2026-08-11T14:10:00.000Z',
          }),
          clinicalEvent({
            id: 'e-first',
            source_inbound_id: 'm1',
            occurred_at: '2026-08-11T14:05:00.000Z',
          }),
        ],
      }),
    );

    const m1 = items[0];
    if (m1?.kind === 'message') {
      expect(m1.events.map((e) => e.event.id)).toEqual(['e-first', 'e-second']);
    }
  });
});

describe('mergeThread — evidence joins by clinical_event_id', () => {
  it('attaches matching evidence rows to their event, tethered or standalone', () => {
    const items = mergeThread(
      baseInput({
        events: [clinicalEvent({ id: 'e1' })],
        evidence: [
          evidenceRow({ clinical_event_id: 'e1', evidence_id: 'ev-a' }),
          evidenceRow({ clinical_event_id: 'e1', evidence_id: 'ev-b' }),
          evidenceRow({ clinical_event_id: 'other-event', evidence_id: 'ev-c' }),
        ],
      }),
    );

    const item = items[0];
    if (item?.kind === 'event') {
      expect(item.event.evidence.map((e) => e.evidence_id).sort()).toEqual(['ev-a', 'ev-b']);
    }
  });
});

describe('mergeThread — message passthrough (translation rendering)', () => {
  it('carries translated_text and normalized_english_meaning through unchanged', () => {
    const items = mergeThread(
      baseInput({
        messages: [
          message({
            id: 'm1',
            translated_text: 'My head hurts',
            normalized_english_meaning: 'Patient reports a headache.',
          }),
        ],
      }),
    );

    const item = items[0];
    expect(item?.kind).toBe('message');
    if (item?.kind === 'message') {
      expect(item.message.translated_text).toBe('My head hurts');
      expect(item.message.normalized_english_meaning).toBe('Patient reports a headache.');
    }
  });
});

describe('mergeThread — the draft always appends last (R10)', () => {
  it('appends the draft after every message and event regardless of its own timestamp', () => {
    const items = mergeThread(
      baseInput({
        messages: [message({ id: 'm1', occurred_at: '2026-08-11T23:00:00.000Z' })],
        events: [clinicalEvent({ id: 'e1', occurred_at: '2026-08-11T02:00:00.000Z' })],
        // created_at is EARLY in the day — must still render last.
        draft: draft({ id: 'd1', created_at: '2026-08-11T01:00:00.000Z' }),
      }),
    );

    expect(items.map((item) => item.kind)).toEqual(['event', 'message', 'draft']);
    expect(items[items.length - 1]?.id).toBe('d1');
  });

  it('omits the draft item entirely when no draft is supplied', () => {
    const items = mergeThread(baseInput({ messages: [message({ id: 'm1' })], draft: null }));

    expect(items.some((item) => item.kind === 'draft')).toBe(false);
  });

  it('omits the draft item when draft is undefined (optional input)', () => {
    const items = mergeThread({
      messages: [message({ id: 'm1' })],
      events: [],
      evidence: [],
      daySummary: null,
    });

    expect(items.some((item) => item.kind === 'draft')).toBe(false);
  });
});

describe('mergeThread — empty input', () => {
  it('returns an empty array for a day with no messages, events, or draft', () => {
    expect(mergeThread(baseInput())).toEqual([]);
  });
});
