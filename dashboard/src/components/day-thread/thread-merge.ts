import type { PatientRecordResponse, ReviewDraft } from '@/lib/dashboard-contracts';
import type { ClinicalPriority } from '@/components/clinical-labels';

/*
 * thread-merge.ts — the ONE pure function behind the day thread (DESIGN-SPEC.md §4.2).
 *
 * Pure, server-safe, unit-testable without rendering — same posture as `lib/timeline-metrics.ts`.
 * No fetch, no DOM, no React import. `day-thread.tsx` and any future consumer (Lane D's page,
 * building the census for `<DayBar>`) call this directly.
 *
 * The mechanism that makes R2 hold ("the day log must contain EVERYTHING; only AI-verified
 * events carry marks"): every `clinical_event` in `events` becomes a `ThreadItem` no matter
 * what, and its `priority` is the STRONGER of two independent authorities — the day summary's
 * `structured_payload.events[eventId].priority`, and the event row's OWN classification
 * (`tierFromEventRow`). Only when neither says anything does it fall to `'none'` (⇒ renders
 * UNMARKED, §4.4-a). Nothing is ever filtered out, and nothing AI-classified ever renders
 * unmarked because the summary is missing, stale, or detail-capped.
 */

type ConversationMessageRow = PatientRecordResponse['messages'][number];
type ClinicalEventRow = PatientRecordResponse['events'][number];
type EventEvidence = PatientRecordResponse['evidence'][number];
type DaySummary = PatientRecordResponse['daySummary'];

/** A `clinical_event` plus the two things the thread needs to decide how to draw it. */
export interface ThreadEvent {
  event: ClinicalEventRow;
  priority: ClinicalPriority;
  evidence: EventEvidence[];
}

export type ThreadItem =
  | {
      kind: 'message';
      id: string;
      at: string;
      message: ConversationMessageRow;
      events: ThreadEvent[];
    }
  | { kind: 'event'; id: string; at: string; event: ThreadEvent }
  | { kind: 'draft'; id: string; at: string; draft: ReviewDraft };

export interface MergeThreadInput {
  messages: ConversationMessageRow[];
  events: ClinicalEventRow[];
  evidence: EventEvidence[];
  daySummary: DaySummary;
  /** The day's latest unreviewed draft, if any. Always rendered LAST regardless of `at`. */
  draft?: ReviewDraft | null;
}

function groupEvidenceByEvent(rows: EventEvidence[]): Map<string, EventEvidence[]> {
  const grouped = new Map<string, EventEvidence[]>();
  for (const row of rows) {
    const existing = grouped.get(row.clinical_event_id);
    if (existing === undefined) grouped.set(row.clinical_event_id, [row]);
    else existing.push(row);
  }
  return grouped;
}

/**
 * "Strongest wins" ordering for the two priority authorities. `fallback` (a system failure that
 * needs a human, never a clinical severity — RS1) sits above `routine` and below `important`.
 */
const PRIORITY_RANK: Record<ClinicalPriority, number> = {
  none: 0,
  routine: 1,
  fallback: 2,
  important: 3,
  emergency: 4,
};

/**
 * The event row's OWN tier, derived exactly as the data API derives `patient_alert.tier`
 * (backend `PATIENT_ALERTS_SQL`: `event_type = 'alert'` + `event_code`).
 *
 * Load-bearing: the day summary is optional (it may not have run for today yet) and its detail
 * list is capped, so an AI-classified emergency that depended on the summary for its mark would
 * render as a plain grey record row — the exact canon inversion the thread exists to prevent.
 */
function tierFromEventRow(event: ClinicalEventRow): ClinicalPriority {
  if (event.event_type !== 'alert' || event.event_code === null) return 'none';
  if (event.event_code === 'emergency') return 'emergency';
  if (event.event_code === 'important') return 'important';
  return 'fallback';
}

/** Stable ordering key: chronological by the stored UTC instant, `id` as a deterministic tiebreak. */
function compareByAtThenId(
  left: { at: string; id: string },
  right: { at: string; id: string },
): number {
  const diff = Date.parse(left.at) - Date.parse(right.at);
  if (diff !== 0) return diff;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function mergeThread(input: MergeThreadInput): ThreadItem[] {
  const priorityByEventId = new Map<string, ClinicalPriority>(
    (input.daySummary?.structured_payload.events ?? []).map((entry) => [
      entry.eventId,
      entry.priority,
    ]),
  );
  const evidenceByEventId = groupEvidenceByEvent(input.evidence);

  const toThreadEvent = (event: ClinicalEventRow): ThreadEvent => {
    const fromSummary = priorityByEventId.get(event.id) ?? 'none';
    const fromRow = tierFromEventRow(event);
    return {
      event,
      priority: PRIORITY_RANK[fromRow] > PRIORITY_RANK[fromSummary] ? fromRow : fromSummary,
      evidence: evidenceByEventId.get(event.id) ?? [],
    };
  };

  // Only a message present IN THIS DAY's set can tether an event — the caller is expected to
  // have already scoped `messages` to the selected day (§4.2 step 2).
  const messageIdsInThisDay = new Set(input.messages.map((row) => row.id));
  const tetheredByMessageId = new Map<string, ThreadEvent[]>();
  const standaloneEvents: ClinicalEventRow[] = [];

  for (const event of input.events) {
    const sourceId = event.source_inbound_id;
    if (sourceId !== null && messageIdsInThisDay.has(sourceId)) {
      const existing = tetheredByMessageId.get(sourceId);
      if (existing === undefined) tetheredByMessageId.set(sourceId, [toThreadEvent(event)]);
      else existing.push(toThreadEvent(event));
    } else {
      standaloneEvents.push(event);
    }
  }
  // Tethered events render in their own chronological order beneath the shared source bubble.
  for (const tethered of tetheredByMessageId.values()) {
    tethered.sort((left, right) =>
      compareByAtThenId(
        { at: left.event.occurred_at, id: left.event.id },
        { at: right.event.occurred_at, id: right.event.id },
      ),
    );
  }

  const messageItems: ThreadItem[] = input.messages.map((message) => ({
    kind: 'message',
    id: message.id,
    at: message.occurred_at,
    message,
    events: tetheredByMessageId.get(message.id) ?? [],
  }));

  const standaloneItems: ThreadItem[] = standaloneEvents.map((event) => ({
    kind: 'event',
    id: event.id,
    at: event.occurred_at,
    event: toThreadEvent(event),
  }));

  const timeline = [...messageItems, ...standaloneItems].sort(compareByAtThenId);

  if (input.draft == null) return timeline;
  return [
    ...timeline,
    { kind: 'draft', id: input.draft.id, at: input.draft.created_at, draft: input.draft },
  ];
}

/*
 * Census math lives HERE, not in day-census.tsx: the patient page (a Server Component)
 * calls computeCensus() during render, and calling a function exported from a
 * 'use client' module on the server is a runtime error the jsdom suite cannot catch
 * (2026-08-17 production incident). This module carries no 'use client' directive —
 * keep it that way; day-census.test.ts pins both sides of the boundary.
 */

export interface DayCensusCounts {
  emergency: number;
  important: number;
  messages: number;
  events: number;
}

/** Every event the census counts, tethered or standalone, with the DOM id it can jump to. */
export function flattenCensusEvents(items: ThreadItem[]): Array<{ id: string; priority: string }> {
  const flattened: Array<{ id: string; priority: string }> = [];
  for (const item of items) {
    if (item.kind === 'message') {
      for (const threadEvent of item.events) {
        flattened.push({ id: threadEvent.event.id, priority: threadEvent.priority });
      }
    } else if (item.kind === 'event') {
      flattened.push({ id: item.event.event.id, priority: item.event.priority });
    }
  }
  return flattened;
}

export function computeCensus(items: ThreadItem[]): DayCensusCounts {
  const events = flattenCensusEvents(items);
  return {
    emergency: events.filter((event) => event.priority === 'emergency').length,
    important: events.filter((event) => event.priority === 'important').length,
    messages: items.filter((item) => item.kind === 'message').length,
    events: events.length,
  };
}
