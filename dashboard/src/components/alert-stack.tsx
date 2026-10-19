import Link from 'next/link';
import { LifeBuoy } from 'lucide-react';
import { PriorityLabel } from '@/components/clinical-labels';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import type { PatientAlert } from '@/lib/dashboard-contracts';

/*
 * alert-stack.tsx — REPURPOSED (DESIGN-SPEC.md §4.5/§5 Lane D, R7): the compact
 * "open alerts in window" list, no longer the full alert card.
 *
 * Every clinical alert now renders as a MARK directly inside its own day's thread
 * (day-thread/event-mark.tsx, Lane C) — that is where the statement text, timestamps,
 * severity and evidence live now, so repeating them here would recreate exactly the
 * "same event, two different marks" duplication R7 exists to remove. This component's
 * only remaining job is letting a doctor jump from anywhere in the record window to
 * the DAY an alert happened, landing directly on its thread mark (`#event-<id>`).
 *
 * `fallback` rows keep the RS1 rule ("a system failure, not a clinical severity") via
 * the thread mark's own dashed rail (clinical-labels.tsx TIER_RAIL) — this list no
 * longer needs a second section to preserve that distinction, so it is one flat,
 * most-severe-first list. Reviewing an alert never removes it: same invariant as
 * before, now carried by "marks are never removed" on the mark itself.
 */

const RANK: Record<PatientAlert['tier'], number> = { emergency: 0, important: 1, fallback: 2 };

function rank(left: PatientAlert, right: PatientAlert): number {
  const byTier = RANK[left.tier] - RANK[right.tier];
  return byTier !== 0 ? byTier : Date.parse(right.occurred_at) - Date.parse(left.occurred_at);
}

export function AlertStack({
  alerts,
  patientId,
  days,
}: {
  alerts: PatientAlert[];
  patientId: string;
  days: 7 | 30 | 90;
}) {
  const ordered = [...alerts].sort(rank);

  return (
    <Card role="region" aria-labelledby="alert-stack-title" className="min-w-0">
      <CardHeader>
        <CardTitle id="alert-stack-title">Alerts in this window</CardTitle>
        <p className="text-sm text-[var(--color-ink-muted)]">
          Every alert stays in the record. Jump to its day in the thread — opening it here never
          removes the mark.
        </p>
      </CardHeader>

      <CardContent className="mt-4">
        {ordered.length === 0 ? (
          <EmptyState
            icon={<LifeBuoy size={24} />}
            title="No alerts in this window"
            description="Emergency and important alerts appear here as soon as the agent raises one."
            className="min-h-0 py-6"
          />
        ) : (
          <ol className="flex flex-col gap-2">
            {ordered.map((alert) => (
              <li key={alert.id}>
                <Link
                  href={`/patients/${encodeURIComponent(patientId)}?days=${days}&day=${alert.local_date}#event-${alert.id}`}
                  className="flex min-h-11 flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 hover:bg-[var(--color-surface-hover)] focus-visible:focus-inset"
                >
                  <PriorityLabel priority={alert.tier} />
                  <span className="tabular-nums text-sm text-[var(--color-ink-muted)]">
                    {alert.local_date}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-ink-secondary)]">
                    {alert.statement_text ?? alert.event_code}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
