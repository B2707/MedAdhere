import { z } from 'zod';
import { Clock } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { FdaDisclaimerNote } from '@/components/fda-disclaimer-note';
import { ReviewPageState } from '@/components/review-page-state';
import { ReviewQueueNav } from '@/components/review-queue-nav';
import { UnknownReviewQueue } from '@/components/unknown-review-queue';
import { Card } from '@/components/ui/card';
import { apiFetch } from '@/lib/api';

export const dynamic = 'force-dynamic';

const unknownReviewItemSchema = z.object({
  id: z.string(),
  patient_id: z.string(),
  display_name: z.string().nullable(),
  inbound_message_id: z.string().nullable(),
  raw_body: z.string().nullable(),
  adherence_state: z
    .enum(['taken', 'delayed', 'skipped', 'stopped', 'unknown', 'question'])
    .nullable(),
  reason_code: z.enum(['none', 'side_effect', 'ran_out', 'forgot', 'other']).nullable(),
  dose_id: z.string().nullable(),
  created_at: z.string(),
  queue_kind: z.enum(['ambiguity', 'label_match']),
  is_unknown: z.boolean(),
  is_unattributed: z.boolean(),
  is_label_match: z.boolean(),
  has_no_outcome: z.boolean(),
  has_elevated_hint: z.boolean(),
  hints: z.array(z.unknown()),
});

const unknownReviewsResponseSchema = z.object({
  items: z.array(unknownReviewItemSchema),
  limit: z.number().int().positive(),
});

type UnknownReviewsResponse = z.infer<typeof unknownReviewsResponseSchema>;

const PAGE_TITLE = 'Classification and label-match reviews';

export default async function UnknownReviewsPage() {
  const result = await apiFetch('/api/reviews/unknown', unknownReviewsResponseSchema);

  if (result.status === 'unauthenticated') {
    return (
      <ReviewPageState
        pageTitle={PAGE_TITLE}
        title="You’re not signed in"
        message="Your session has expired or you’re not signed in. Sign in to continue."
        retryPath="/reviews/unknown"
        signIn
      />
    );
  }

  if (result.status === 'error') {
    return (
      <ReviewPageState
        pageTitle={PAGE_TITLE}
        title="Couldn’t load classification and label-match reviews"
        message="The classification and label-match queue could not be loaded. This is usually temporary."
        retryPath="/reviews/unknown"
      />
    );
  }

  const { items, limit }: UnknownReviewsResponse = result.data;

  return (
    <AppShell
      pageTitle={PAGE_TITLE}
      pageDescription="Review ambiguous outcomes, unattributed replies, and associative label matches."
      headerSlot={`${items.length} ${items.length === 1 ? 'item' : 'items'}`}
    >
      <div className="flex flex-col gap-8">
        <ReviewQueueNav activePath="/reviews/unknown" />
        {items.length === limit && (
          <p className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-ink-muted)] shadow-[var(--elev-1)]">
            Showing the first {limit} items — list capped; oldest lower-priority items may be
            hidden.
          </p>
        )}
        <Card className="flex items-start gap-4">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-canvas-raised)] text-[var(--color-ink-muted)]">
            <Clock aria-hidden="true" size={20} />
          </span>
          <div>
            <p className="font-semibold text-[var(--color-ink)]">
              Researcher review cadence: next business day
            </p>
            <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
              Review every classification and label-match item and record it in the append-only
              review log.
            </p>
          </div>
        </Card>
        <UnknownReviewQueue items={items} />
        <FdaDisclaimerNote />
      </div>
    </AppShell>
  );
}
