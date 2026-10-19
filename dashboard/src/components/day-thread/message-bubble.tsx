import { Badge } from '@/components/ui/badge';
import { EventMarkChip } from '@/components/clinical-labels';
import type { PatientRecordResponse } from '@/lib/dashboard-contracts';
import { EventMark, TimeGutter } from './event-mark';
import type { ThreadEvent } from './thread-merge';

type ConversationMessageRow = PatientRecordResponse['messages'][number];

/*
 * message-bubble.tsx — one row of the UNMARKED complete log (DESIGN-SPEC.md §4.3). Direction
 * is carried by THREE redundant channels (fill + alignment + corner) so it survives greyscale
 * and low vision — the pre-redesign build distinguished direction by the words "From patient" /
 * "From MedAdhere" alone.
 *
 * Original messages are immutable evidence: the verbatim body is never replaced by its
 * translation (R3) — translated_text / normalized_english_meaning are a disclosure UNDER the
 * bubble, shown only when the backend actually stored one.
 *
 * No <details> wrapper around the whole message and no per-message heading (R12/R13) — a
 * message is a plain bubble; <details> is reserved for the translation/normalized-meaning and
 * evidence disclosures.
 */

const CLARIFICATION_TOPIC_WORDS = (topic: string) => topic.toUpperCase().replaceAll('_', ' ');

/** The outbound-only mono kicker (§4.3): CHECK-IN · REMINDER 2 · CLARIFICATION · DOSE TIME · … */
function outboundKicker(message: ConversationMessageRow): string | null {
  if (message.direction !== 'outbound' || message.message_kind === null) return null;
  switch (message.message_kind) {
    case 'check_in':
      return 'CHECK-IN';
    case 'reminder':
      return message.reminder_attempt === null
        ? 'REMINDER'
        : `REMINDER ${message.reminder_attempt}`;
    case 'clarification':
      return message.clarification_topic === null
        ? 'CLARIFICATION'
        : `CLARIFICATION · ${CLARIFICATION_TOPIC_WORDS(message.clarification_topic)}`;
    case 'safety':
      return 'SAFETY';
    case 'fallback':
      return 'FALLBACK';
    case 'acknowledgement':
      return 'ACKNOWLEDGEMENT';
  }
}

/**
 * A TERMINAL-unsent reply is provably never delivered: status 'failed' with sent_at
 * explicitly NULL (suppressed record-only rows and definitive provider rejections). In-flight
 * and ambiguous rows, and an old backend that omits either field, show no badge rather than a
 * false claim — exact guard carried over from `original-messages.tsx`.
 */
function isProvablyUnsent(message: ConversationMessageRow): boolean {
  return (
    message.direction === 'outbound' && message.status === 'failed' && message.sent_at === null
  );
}

export function MessageBubble({
  message,
  events,
  timeZone,
}: {
  message: ConversationMessageRow;
  events: ThreadEvent[];
  timeZone: string;
}) {
  const inbound = message.direction === 'inbound';
  const kicker = outboundKicker(message);
  const hasDerivedText =
    message.translated_text !== null || message.normalized_english_meaning !== null;

  return (
    <div id={`message-${message.id}`} className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 gap-3">
        <TimeGutter utc={message.occurred_at} timeZone={timeZone} />
        <div
          className={
            inbound ? 'flex min-w-0 flex-1 justify-start' : 'flex min-w-0 flex-1 justify-end'
          }
        >
          <div
            className={
              inbound
                ? 'min-w-0 max-w-[72ch] rounded-[var(--radius-md)] rounded-tl-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3 sm:p-4'
                : 'min-w-0 max-w-[88%] rounded-[var(--radius-md)] rounded-tr-[var(--radius-sm)] bg-[var(--color-canvas-raised)] p-3 sm:p-4'
            }
          >
            {(kicker !== null || isProvablyUnsent(message)) && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {kicker !== null && <EventMarkChip>{kicker}</EventMarkChip>}
                {isProvablyUnsent(message) && <Badge variant="outline">Not sent</Badge>}
              </div>
            )}
            {message.body === null ? (
              <p className="text-base text-[var(--color-ink-muted)]">
                Message body was not stored for this legacy record. It is not reconstructed.
              </p>
            ) : (
              <p
                dir="auto"
                className="whitespace-pre-wrap break-words text-md text-[var(--color-ink)]"
              >
                {message.body}
              </p>
            )}
            {hasDerivedText && (
              <details className="group mt-2">
                <summary className="cursor-pointer text-sm font-medium text-[var(--color-accent)] focus-visible:focus-inset [&::-webkit-details-marker]:hidden">
                  Translation · Normalized meaning
                </summary>
                <div className="disclosure-body mt-2 flex flex-col gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-canvas-raised)] p-3">
                  {message.translated_text !== null && (
                    <div>
                      <p className="font-[family-name:var(--font-mono)] text-xs font-medium uppercase tracking-mono text-[var(--color-ink-muted)]">
                        Translation
                      </p>
                      <p
                        dir="auto"
                        className="mt-1 whitespace-pre-wrap break-words text-sm text-[var(--color-ink-secondary)]"
                      >
                        {message.translated_text}
                      </p>
                    </div>
                  )}
                  {message.normalized_english_meaning !== null && (
                    <div>
                      <p className="font-[family-name:var(--font-mono)] text-xs font-medium uppercase tracking-mono text-[var(--color-ink-muted)]">
                        Normalized meaning
                      </p>
                      <p
                        dir="auto"
                        className="mt-1 whitespace-pre-wrap break-words text-sm text-[var(--color-ink-secondary)]"
                      >
                        {message.normalized_english_meaning}
                      </p>
                    </div>
                  )}
                </div>
              </details>
            )}
          </div>
        </div>
      </div>
      {events.length > 0 && (
        // tradeoff: a plain left-indent stands in for the spec's precise "2px connector from
        // the bubble's bottom-left into the rail's top" geometry — upgrade to a drawn SVG/border
        // connector if a reviewer flags the approximation as insufficient.
        <div className="flex min-w-0 flex-col gap-2 border-l-2 border-[var(--color-border)] pl-3 ml-[4.75rem]">
          {events.map((threadEvent) => (
            <EventMark
              key={threadEvent.event.id}
              id={threadEvent.event.id}
              event={threadEvent.event}
              priority={threadEvent.priority}
              evidence={threadEvent.evidence}
              timeZone={timeZone}
              tethered
            />
          ))}
        </div>
      )}
    </div>
  );
}
