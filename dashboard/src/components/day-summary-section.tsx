import { ClipboardList } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import type { PatientRecordResponse } from '@/lib/dashboard-contracts';

type DaySummary = PatientRecordResponse['daySummary'];
type EventEvidence = PatientRecordResponse['evidence'][number];

/*
 * day-summary-section.tsx — REWRITTEN to a prose lede only (DESIGN-SPEC.md §4.0, R1/R2/R14).
 *
 * The event-by-event listing this component used to own — split into "Needs review first" /
 * "Routine record" — is now `day-thread/day-thread.tsx`, which renders EVERY event (R2: absent
 * priority ⇒ unmarked, never dropped) alongside every message in one merged log. Keeping both
 * would recreate the exact "separate review queue" pattern the owner canon rejects (R1).
 *
 * This component keeps only what the merged log cannot show on its own: the agent's headline
 * prose plus the two caveats that qualify it — a bounded-subset warning and the evidence
 * coverage note. `events`/`timeZone` are no longer needed (no per-event rendering survives
 * here), so they are dropped from the props Lane D's page composition passes in.
 *
 * R14: the dead `PRIORITY_RANK.fallback` branch (unreachable — `SUMMARY_TIERS` never emits
 * `fallback`) is deleted along with the escalated/routine split it belonged to.
 */

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
 * Preserved verbatim from the pre-redesign component (day-summary-section.tsx:57-65,
 * DESIGN-SPEC.md §4.6): no entry may imply an all-clear.
 */
function coverageNote(summary: NonNullable<DaySummary>, evidence: EventEvidence[]): string | null {
  const eventIds = summary.structured_payload.eventIds;
  if (eventIds.length === 0) return null;
  const evidenceByEvent = groupEvidenceByEvent(evidence);
  const evidencedCount = eventIds.filter((id) => (evidenceByEvent.get(id) ?? []).length > 0).length;
  if (evidencedCount === 0) return 'Coverage for this day is unknown. This is not an all-clear.';
  if (evidencedCount < eventIds.length) {
    return 'Some evidence for this day could not be retrieved. This is not an all-clear.';
  }
  return null;
}

export function DaySummarySection({
  summary,
  evidence,
}: {
  summary: DaySummary;
  evidence: EventEvidence[];
}) {
  const coverage = summary === null ? null : coverageNote(summary, evidence);

  return (
    <section
      aria-labelledby="day-summary-title"
      className="min-w-0 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--elev-1)] sm:p-6"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-canvas-raised)]">
          <ClipboardList aria-hidden="true" size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2
            id="day-summary-title"
            className="text-lg font-semibold tracking-heading text-[var(--color-ink)]"
          >
            What happened today
          </h2>
          {summary === null ? (
            <EmptyState
              icon={<ClipboardList size={24} />}
              title="No agent summary for this day"
              description="The full log is below — every message and clinical event, whether or not a summary has run yet."
              className="mt-4 min-h-0 py-6"
            />
          ) : (
            <>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-[family-name:var(--font-mono)] text-xs font-medium uppercase tracking-mono text-[var(--color-ink-muted)]">
                <span>agent-generated</span>
                <span aria-hidden="true">·</span>
                <span>v{summary.version}</span>
                {summary.structured_payload.truncated && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="text-[var(--color-warning-700)]">
                      bounded subset — read full log
                    </span>
                  </>
                )}
              </p>
              <p
                dir="auto"
                className="mt-3 whitespace-pre-wrap break-words text-md text-[var(--color-ink)]"
              >
                {summary.summary_text}
              </p>
              {coverage !== null && (
                <p className="mt-3 text-sm text-[var(--color-ink-muted)]">{coverage}</p>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
