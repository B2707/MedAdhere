import {
  EvidenceList,
  EventMarkChip,
  PriorityLabel,
  TIER_RAIL,
  formatLocalClockTime,
  type ClinicalPriority,
} from '@/components/clinical-labels';
import type { PatientRecordResponse } from '@/lib/dashboard-contracts';

type ClinicalEventRow = PatientRecordResponse['events'][number];
type EventEvidence = PatientRecordResponse['evidence'][number];

/*
 * event-mark.tsx — the ONE mark anatomy for the day thread (DESIGN-SPEC.md §4.4).
 *
 * Two states, never a third: UNMARKED (priority 'none' — plain, structured record; §4.4-a)
 * and MARKED (a rail + tint + tier chip, scaled by tier; §4.4-b). The rail is the ONLY
 * structural mark anywhere in the thread — nothing else (not messages, not the summary lede,
 * not the draft) uses a left rail, so a doctor learns the whole rule in one glance.
 *
 * `tethered` events (attached to their source message by `thread-merge.ts`) render without
 * their own time gutter — the parent bubble already carries the time — but keep every other
 * part of the mark, including the rail, unchanged.
 */

/** The 64px mono time gutter shared with `message-bubble.tsx` (§4.3) — patient-local, tabular. */
export function TimeGutter({ utc, timeZone }: { utc: string; timeZone: string }) {
  return (
    <div
      className="w-16 shrink-0 pt-3 text-right font-[family-name:var(--font-mono)] text-sm tabular-nums text-[var(--color-ink-muted)]"
      aria-hidden="true"
    >
      {formatLocalClockTime(utc, timeZone)}
    </div>
  );
}

export function EventMark({
  id,
  event,
  priority,
  evidence,
  timeZone,
  tethered = false,
}: {
  id: string;
  event: ClinicalEventRow;
  priority: ClinicalPriority;
  evidence: EventEvidence[];
  timeZone: string;
  /** True when rendered directly beneath its source message bubble (no own gutter). */
  tethered?: boolean;
}) {
  const text = event.statement_text ?? event.event_code ?? 'No text recorded';
  const marked = priority !== 'none';
  const tier = marked ? TIER_RAIL[priority as Exclude<ClinicalPriority, 'none'>] : null;

  return (
    <div id={`event-${id}`} className="flex min-w-0 gap-3">
      {!tethered && <TimeGutter utc={event.occurred_at} timeZone={timeZone} />}
      <div
        className={
          tier === null
            ? 'min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3 sm:p-4'
            : 'min-w-0 flex-1 rounded-[var(--radius-md)] border-l-4 p-3 sm:p-4'
        }
        style={
          tier === null
            ? undefined
            : {
                borderLeftColor: tier.rail,
                borderLeftStyle: tier.dashed ? 'dashed' : 'solid',
                backgroundColor: tier.fill ?? undefined,
              }
        }
      >
        {marked && (
          <div className="mb-2">
            <PriorityLabel priority={priority} />
          </div>
        )}
        <p
          dir="auto"
          className={
            marked
              ? 'whitespace-pre-wrap break-words text-base text-[var(--color-ink)]'
              : 'whitespace-pre-wrap break-words text-base text-[var(--color-ink-secondary)]'
          }
        >
          {text}
        </p>
        {event.severity !== null && (
          <div className="mt-2">
            <EventMarkChip>SEV {event.severity} / 10</EventMarkChip>
          </div>
        )}
        {evidence.length > 0 && (
          <details className="group mt-2">
            <summary className="cursor-pointer text-sm font-medium text-[var(--color-accent)] focus-visible:focus-inset [&::-webkit-details-marker]:hidden">
              {evidence.length} source{evidence.length === 1 ? '' : 's'} ▾
            </summary>
            <div className="disclosure-body mt-2 rounded-[var(--radius-sm)] bg-[var(--color-canvas-raised)] p-3">
              <EvidenceList evidence={evidence} />
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
