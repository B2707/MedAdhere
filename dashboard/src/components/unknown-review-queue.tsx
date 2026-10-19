import { Clock, FileQuestion, Inbox, MessageCircle, Tag } from 'lucide-react';
import { AdeHintList } from '@/components/ade-hint-list';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';

export interface UnknownReviewItem {
  id: string;
  patient_id: string;
  display_name: string | null;
  inbound_message_id: string | null;
  raw_body: string | null;
  adherence_state: string | null;
  reason_code: string | null;
  dose_id: string | null;
  created_at: string;
  queue_kind: 'ambiguity' | 'label_match';
  is_unknown: boolean;
  is_unattributed: boolean;
  is_label_match: boolean;
  has_no_outcome: boolean;
  has_elevated_hint: boolean;
  hints: unknown[];
}

function patientLabel(item: UnknownReviewItem): string {
  return item.display_name?.trim() || item.patient_id;
}

function readableLabel(value: string): string {
  return value.replaceAll('_', ' ');
}

function createdAtUtc(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return 'date unavailable';
  return `${parsed.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function ReviewArmBadges({ item }: { item: UnknownReviewItem }) {
  return (
    <span className="flex min-w-48 flex-wrap gap-1">
      {item.is_label_match && <Badge variant="default">Label match</Badge>}
      {item.has_no_outcome && <Badge variant="outline">No classifier outcome</Badge>}
      {item.is_unknown && <Badge variant="secondary">Ambiguous classification</Badge>}
      {item.is_unattributed && <Badge variant="outline">Unattributed reply</Badge>}
    </span>
  );
}

export function UnknownReviewQueue({ items }: { items: UnknownReviewItem[] }) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Inbox size={24} />}
        title="No items awaiting review"
        description="Ambiguous classifications and label matches will appear here for researcher review."
      />
    );
  }

  return (
    <section aria-labelledby="classification-awaiting-title">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div>
          <h2
            id="classification-awaiting-title"
            className="text-lg font-semibold tracking-heading text-[var(--color-ink)]"
          >
            Awaiting review
          </h2>
          <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
            Ambiguous outcomes, unattributed replies, and label-match evidence.
          </p>
        </div>
        <Badge variant="secondary">{items.length}</Badge>
      </div>

      <ol aria-label="Classification items awaiting review" className="flex flex-col gap-4">
        {items.map((item, index) => {
          const titleId = `classification-item-${index}`;
          return (
            <li key={`${item.queue_kind}-${item.id}`}>
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
                      {patientLabel(item)}
                    </h3>
                    <time
                      dateTime={item.created_at}
                      className="mt-1 flex items-center gap-1 text-sm text-[var(--color-ink-muted)]"
                    >
                      <Clock aria-hidden="true" size={14} />
                      Received {createdAtUtc(item.created_at)}
                    </time>
                  </div>
                  <ReviewArmBadges item={item} />
                </header>

                <div className="p-5 sm:p-6">
                  <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-canvas-raised)] p-4">
                    <p className="flex items-center gap-1 text-sm font-semibold text-[var(--color-ink-muted)]">
                      <MessageCircle aria-hidden="true" size={15} />
                      Patient reply
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-base text-[var(--color-ink-secondary)]">
                      {item.raw_body ?? 'Reply text unavailable'}
                    </p>
                  </div>

                  <div className="mt-4 grid gap-4 lg:grid-cols-2">
                    <section className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
                      <div className="flex items-center gap-2">
                        <FileQuestion
                          aria-hidden="true"
                          className="text-[var(--color-ink-muted)]"
                          size={18}
                        />
                        <h4 className="text-base font-semibold text-[var(--color-ink)]">
                          Classification
                        </h4>
                      </div>
                      <p className="mt-2 capitalize text-[var(--color-ink)]">
                        {item.adherence_state === null
                          ? 'Classification unavailable'
                          : readableLabel(item.adherence_state)}
                      </p>
                      <p className="text-sm text-[var(--color-ink-muted)]">
                        {item.reason_code === null
                          ? 'Reason unavailable'
                          : `Reason: ${readableLabel(item.reason_code)}`}
                      </p>
                    </section>

                    <section className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
                      <div className="flex items-center gap-2">
                        <Tag
                          aria-hidden="true"
                          className="text-[var(--color-ink-muted)]"
                          size={18}
                        />
                        <h4 className="text-base font-semibold text-[var(--color-ink)]">
                          Label-match hint
                        </h4>
                      </div>
                      <div className="mt-2">
                        {item.has_elevated_hint && (
                          <Badge variant="destructive" className="mb-2">
                            Elevated label match
                          </Badge>
                        )}
                        {item.hints.length > 0 ? (
                          <AdeHintList hints={item.hints} showElevatedBadge={false} />
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
                  <span className="font-semibold text-[var(--color-ink)]">Review identifiers</span>
                  <span className="break-all text-[var(--color-ink-secondary)]">
                    {item.inbound_message_id ?? 'Reply id unavailable'}
                  </span>
                  <span className="break-all text-[var(--color-ink-muted)]">
                    {item.dose_id === null ? 'Dose not attributed' : `Dose ${item.dose_id}`}
                  </span>
                </footer>
              </article>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
