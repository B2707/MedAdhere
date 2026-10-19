import { AlertTriangle, CheckCircle2, Clock, MessageCircle, Send, ShieldCheck } from 'lucide-react';
import { AdeHintList } from '@/components/ade-hint-list';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';

export interface SafetyReviewEvent {
  id: string;
  patient_id: string;
  display_name: string | null;
  inbound_message_id: string;
  raw_body: string;
  flag_category: string;
  trigger_source: string | null;
  auto_reply_status: string | null;
  created_at: string;
  first_detected_minutes_ago: number;
  has_prior_failure: boolean;
  is_stale_sending: boolean;
  is_urgent: boolean;
  hints: unknown[];
}

function readableLabel(value: string | null, fallback = 'Not recorded'): string {
  return value === null ? fallback : value.replaceAll('_', ' ');
}

function eventAge(minutes: number): string {
  const wholeMinutes = Math.max(0, Math.floor(minutes));
  if (wholeMinutes === 0) return 'less than 1 minute ago';
  if (wholeMinutes === 1) return '1 minute ago';
  if (wholeMinutes < 60) return `${wholeMinutes} minutes ago`;

  const hours = Math.floor(wholeMinutes / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;

  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

function patientLabel(event: SafetyReviewEvent): string {
  return event.display_name?.trim() || event.patient_id;
}

function followUpLabel(event: SafetyReviewEvent): string {
  if (event.auto_reply_status === 'failed') return 'Delivery failed';
  if (event.auto_reply_status === 'suppressed') return 'Suppressed';
  if (event.is_urgent) return 'Needs follow-up';
  if (event.auto_reply_status === 'sent') return 'Sent to carrier';
  if (event.auto_reply_status === 'sending') return 'Sending';
  return 'Status unavailable';
}

function createdAtUtc(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return 'date unavailable';
  return `${parsed.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function CadenceNote({ thresholdMinutes }: { thresholdMinutes: number }) {
  return (
    <Card className="flex items-start gap-4">
      <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-canvas-raised)] text-[var(--color-ink-muted)]">
        <Clock aria-hidden="true" size={20} />
      </span>
      <div>
        <p className="font-semibold text-[var(--color-ink)]">
          Researcher review cadence: next business day
        </p>
        <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
          Review every safety event and record it in the append-only review log. Auto-replies still
          sending when older than {thresholdMinutes} minutes are marked as needing follow-up.
        </p>
      </div>
    </Card>
  );
}

function AutoReplyBadge({ event }: { event: SafetyReviewEvent }) {
  if (event.auto_reply_status === 'sent') {
    return (
      <Badge variant="success">
        <CheckCircle2 aria-hidden="true" size={14} />
        sent
      </Badge>
    );
  }
  if (event.auto_reply_status === 'failed') {
    return <Badge variant="destructive">failed</Badge>;
  }
  if (event.auto_reply_status === 'suppressed') {
    return <Badge variant="secondary">suppressed</Badge>;
  }
  return <Badge variant="outline">{readableLabel(event.auto_reply_status)}</Badge>;
}

export function SafetyReviewQueue({
  events,
  stuckSendingThresholdMinutes,
}: {
  events: SafetyReviewEvent[];
  stuckSendingThresholdMinutes: number;
}) {
  return (
    <div className="flex flex-col gap-6">
      <CadenceNote thresholdMinutes={stuckSendingThresholdMinutes} />

      {events.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck size={24} />}
          title="No items awaiting review"
          description="New safety events will appear here with auto-reply and follow-up status."
        />
      ) : (
        <section aria-labelledby="safety-awaiting-title">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div>
              <h2
                id="safety-awaiting-title"
                className="text-lg font-semibold tracking-heading text-[var(--color-ink)]"
              >
                Awaiting review
              </h2>
              <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
                Safety detections with delivery evidence and review identifiers.
              </p>
            </div>
            <Badge variant="secondary">{events.length}</Badge>
          </div>

          <ol aria-label="Safety events awaiting review" className="flex flex-col gap-4">
            {events.map((event, index) => {
              const titleId = `safety-event-${index}`;
              const severe = ['crisis', 'acute_physical'].includes(event.flag_category);
              return (
                <li key={event.id}>
                  <article
                    aria-labelledby={titleId}
                    className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--elev-1)]"
                  >
                    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border-subtle)] p-5 sm:p-6">
                      <div>
                        <p className="text-sm text-[var(--color-ink-muted)]">Patient</p>
                        <h3
                          id={titleId}
                          className="text-lg font-semibold tracking-heading text-[var(--color-ink)]"
                        >
                          {patientLabel(event)}
                        </h3>
                        <time
                          dateTime={event.created_at}
                          className="mt-1 flex items-center gap-1 text-sm text-[var(--color-ink-muted)]"
                        >
                          <Clock aria-hidden="true" size={14} />
                          Created {createdAtUtc(event.created_at)}
                        </time>
                      </div>
                      <div className="flex flex-wrap justify-end gap-1">
                        {event.is_urgent ? (
                          <Badge variant="destructive">
                            <AlertTriangle aria-hidden="true" size={14} />
                            {followUpLabel(event)}
                          </Badge>
                        ) : (
                          <Badge variant="outline">{followUpLabel(event)}</Badge>
                        )}
                        {severe ? (
                          <Badge variant="destructive" className="capitalize">
                            <AlertTriangle aria-hidden="true" size={14} />
                            {readableLabel(event.flag_category)}
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="capitalize">
                            <MessageCircle aria-hidden="true" size={14} />
                            {readableLabel(event.flag_category)}
                          </Badge>
                        )}
                      </div>
                    </header>

                    <div className="p-5 sm:p-6">
                      <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-canvas-raised)] p-4">
                        <p className="text-sm font-semibold text-[var(--color-ink-muted)]">
                          Patient reply
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-base text-[var(--color-ink-secondary)]">
                          {event.raw_body}
                        </p>
                      </div>

                      <div className="mt-4 grid gap-4 lg:grid-cols-2">
                        <section className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
                          <div className="flex items-center gap-2">
                            <Send
                              aria-hidden="true"
                              className="text-[var(--color-ink-muted)]"
                              size={18}
                            />
                            <h4 className="text-base font-semibold text-[var(--color-ink)]">
                              Auto-reply
                            </h4>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1">
                            <AutoReplyBadge event={event} />
                            {event.has_prior_failure && (
                              <Badge variant="secondary">Prior failure</Badge>
                            )}
                            {event.is_stale_sending && (
                              <Badge variant="destructive">Stuck sending</Badge>
                            )}
                          </div>
                          <p className="mt-2 text-sm text-[var(--color-ink-muted)]">
                            First detected {eventAge(event.first_detected_minutes_ago)}
                          </p>
                          <p className="text-sm text-[var(--color-ink-muted)]">
                            Source: {readableLabel(event.trigger_source)}
                          </p>
                        </section>

                        <section className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
                          <h4 className="text-base font-semibold text-[var(--color-ink)]">
                            Label-match hint
                          </h4>
                          <div className="mt-2">
                            {event.hints.length > 0 ? (
                              <AdeHintList hints={event.hints} />
                            ) : (
                              <p className="text-sm text-[var(--color-ink-muted)]">
                                No associative label match recorded.
                              </p>
                            )}
                          </div>
                        </section>
                      </div>
                    </div>

                    <footer className="flex flex-col gap-1 border-t border-[var(--color-border-subtle)] bg-[var(--color-canvas-raised)] px-5 py-4 text-sm sm:px-6">
                      <span className="font-semibold text-[var(--color-ink)]">Review key</span>
                      <span className="break-all text-[var(--color-ink-secondary)]">
                        {event.id}
                      </span>
                      <span className="break-all text-[var(--color-ink-muted)]">
                        Reply {event.inbound_message_id}
                      </span>
                    </footer>
                  </article>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}
