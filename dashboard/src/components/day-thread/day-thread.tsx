'use client';

import { useEffect, useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import type { PatientRecordResponse, ReviewDraft } from '@/lib/dashboard-contracts';
import { DayCensus } from './day-census';
import { EventMark } from './event-mark';
import { MessageBubble } from './message-bubble';
import { mergeThread } from './thread-merge';

type ConversationMessageRow = PatientRecordResponse['messages'][number];
type ClinicalEventRow = PatientRecordResponse['events'][number];
type EventEvidence = PatientRecordResponse['evidence'][number];
type DaySummary = PatientRecordResponse['daySummary'];

/*
 * day-thread.tsx — the complete merged day log (DESIGN-SPEC.md §4). Frozen export (§5 Lane C):
 * `<DayThread messages events evidence daySummary draft timeZone dayLabel />`.
 *
 * One flat, chronological list (R1) — no "Needs review first" / "Routine record" split, no
 * separate review queue. `mergeThread` (thread-merge.ts) does every ordering/tethering/priority
 * decision; this component only renders what it returns. R12: ONE `<h2>` for the whole day —
 * there is nothing left to sub-group a single day's thread by, now that R1 removed the
 * escalated/routine split, so no `<h3>` groups are emitted.
 *
 * R10: the day's latest draft (if any) renders as the thread's own final row — a lightweight,
 * non-interactive preview. The INTERACTIVE draft-review UI is `draft-review.tsx` (Lane F's
 * file); this component never imports it, by design (§5 lane boundary) — the page composing
 * `<DayThread>` mounts the real review UI immediately after it, anchored at `#draft-review`.
 *
 * R15: a day change moves focus to the heading and announces the new date via `aria-live` —
 * but never on the component's OWN first paint, which would steal focus from whatever the
 * clinician was doing when the page loaded.
 */

export interface DayThreadProps {
  messages: ConversationMessageRow[];
  events: ClinicalEventRow[];
  evidence: EventEvidence[];
  daySummary: DaySummary;
  /** The day's latest unreviewed draft, if any. Always the thread's last row (R10). */
  draft?: ReviewDraft | null;
  timeZone: string;
  /** Human-readable day label, e.g. "Aug 11, 2026" — announced on change (R15). */
  dayLabel: string;
}

function DraftPreviewRow({ draft }: { draft: ReviewDraft }) {
  return (
    <div
      id={`draft-${draft.id}`}
      className="rounded-[var(--radius-md)] border-l-4 p-3 sm:p-4"
      style={{ borderLeftColor: 'var(--color-accent)' }}
    >
      <p className="text-sm font-semibold text-[var(--color-accent)]">
        Draft ready for review · v{draft.version}
      </p>
      <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm text-[var(--color-ink-secondary)]">
        {draft.draft_text}
      </p>
      <a
        href="#draft-review"
        className="mt-2 inline-block text-sm font-medium underline underline-offset-2"
      >
        Review this draft
      </a>
    </div>
  );
}

export function DayThread({
  messages,
  events,
  evidence,
  daySummary,
  draft = null,
  timeZone,
  dayLabel,
}: DayThreadProps) {
  const items = mergeThread({ messages, events, evidence, daySummary, draft });
  const isEmpty = messages.length === 0 && events.length === 0;

  const headingRef = useRef<HTMLHeadingElement>(null);
  const hasMounted = useRef(false);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }
    headingRef.current?.focus();
    setAnnouncement(`Showing ${dayLabel}`);
    // Deliberately keyed on `dayLabel` alone — messages/events changing under the SAME day
    // (e.g. auto-refresh) must not steal focus or re-announce.
  }, [dayLabel]);

  return (
    <section aria-labelledby="day-thread-heading" className="min-w-0">
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <div className="flex min-w-0 flex-col gap-4 xl:flex-row xl:items-start xl:gap-6">
        <div className="min-w-0 flex-1">
          <h2
            ref={headingRef}
            id="day-thread-heading"
            tabIndex={-1}
            className="text-lg font-semibold tracking-heading text-[var(--color-ink)] focus:outline-none"
          >
            Day thread · {dayLabel}
          </h2>
          {isEmpty ? (
            <EmptyState
              icon={<CalendarDays size={24} />}
              title={`No activity on ${dayLabel}`}
              description="No messages or clinical events were recorded on this day. Pick another day on the calendar."
              className="mt-4"
            />
          ) : (
            <ol className="enter-rise mt-4 flex min-w-0 flex-col gap-4">
              {items.map((item) => (
                <li key={`${item.kind}-${item.id}`} className="min-w-0">
                  {item.kind === 'message' && (
                    <MessageBubble
                      message={item.message}
                      events={item.events}
                      timeZone={timeZone}
                    />
                  )}
                  {item.kind === 'event' && (
                    <EventMark
                      id={item.event.event.id}
                      event={item.event.event}
                      priority={item.event.priority}
                      evidence={item.event.evidence}
                      timeZone={timeZone}
                    />
                  )}
                  {item.kind === 'draft' && <DraftPreviewRow draft={item.draft} />}
                </li>
              ))}
            </ol>
          )}
        </div>
        {!isEmpty && <DayCensus items={items} className="xl:pt-12" />}
      </div>
    </section>
  );
}
