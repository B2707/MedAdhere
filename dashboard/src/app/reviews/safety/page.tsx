import { z } from 'zod';
import { AppShell } from '@/components/app-shell';
import { FdaDisclaimerNote } from '@/components/fda-disclaimer-note';
import { ReviewPageState } from '@/components/review-page-state';
import { ReviewQueueNav } from '@/components/review-queue-nav';
import { SafetyReviewQueue } from '@/components/safety-review-queue';
import { apiFetch } from '@/lib/api';

export const dynamic = 'force-dynamic';

const safetyReviewEventSchema = z.object({
  id: z.string(),
  patient_id: z.string(),
  display_name: z.string().nullable(),
  inbound_message_id: z.string(),
  raw_body: z.string(),
  flag_category: z.enum(['crisis', 'acute_physical', 'medical_question']),
  trigger_source: z.enum(['prefilter', 'model', 'both']).nullable(),
  auto_reply_status: z.enum(['sending', 'sent', 'failed', 'suppressed']).nullable(),
  created_at: z.string(),
  has_prior_failure: z.boolean(),
  first_detected_minutes_ago: z.number().int().nonnegative(),
  is_stale_sending: z.boolean(),
  is_urgent: z.boolean(),
  hints: z.array(z.unknown()),
});

const safetyReviewsResponseSchema = z.object({
  events: z.array(safetyReviewEventSchema),
  stuckSendingThresholdMinutes: z.number().int().positive(),
  limit: z.number().int().positive(),
});

type SafetyReviewsResponse = z.infer<typeof safetyReviewsResponseSchema>;

export default async function SafetyReviewsPage() {
  const result = await apiFetch('/api/reviews/safety', safetyReviewsResponseSchema);

  if (result.status === 'unauthenticated') {
    return (
      <ReviewPageState
        pageTitle="Safety reviews"
        title="You’re not signed in"
        message="Your session has expired or you’re not signed in. Sign in to continue."
        retryPath="/reviews/safety"
        signIn
      />
    );
  }

  if (result.status === 'error') {
    return (
      <ReviewPageState
        pageTitle="Safety reviews"
        title="Couldn’t load safety reviews"
        message="The safety review queue could not be loaded. This is usually temporary."
        retryPath="/reviews/safety"
      />
    );
  }

  const { events, stuckSendingThresholdMinutes, limit }: SafetyReviewsResponse = result.data;

  return (
    <AppShell
      pageTitle="Safety reviews"
      pageDescription="Review safety detections, auto-reply delivery, and follow-up evidence."
      headerSlot={`${events.length} ${events.length === 1 ? 'event' : 'events'}`}
    >
      <div className="flex flex-col gap-8">
        <ReviewQueueNav activePath="/reviews/safety" />
        {events.length === limit && (
          <p className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-ink-muted)] shadow-[var(--elev-1)]">
            Showing the first {limit} events — list capped; oldest non-urgent items may be hidden.
          </p>
        )}
        <SafetyReviewQueue
          events={events}
          stuckSendingThresholdMinutes={stuckSendingThresholdMinutes}
        />
        <FdaDisclaimerNote />
      </div>
    </AppShell>
  );
}
