import { GitBranch, History } from 'lucide-react';
import { UtcAndLocalTime } from '@/components/clinical-labels';
import { Badge } from '@/components/ui/badge';
import { CollapsiblePanel } from '@/components/ui/collapsible';
import { EmptyState } from '@/components/ui/empty-state';
import type { PatientRecordResponse } from '@/lib/dashboard-contracts';

type RecordVersion = PatientRecordResponse['versions'][number];

/*
 * version-timeline.tsx — one chronological list of every revision in the patient's record.
 *
 * The chain it renders is append-only: day summaries, review drafts, corrected events, the
 * doctor's facts and the doctor's medications. A correction never overwrites — it appends a
 * row pointing at the one it replaces — so BOTH rows appear here. That is the point of the
 * panel: it is the audit trail that shows a clinical fact was changed, when, and what it
 * grew out of.
 *
 * Which rows are in range is the server's decision (facts and medications ignore the 30-day
 * cutoff; the rest respect it, per the versions decision). This component renders what it is
 * given and never filters the record further.
 *
 * Token pass (DESIGN-SPEC.md §5 Lane D): consumes Lane A's `@theme` names verbatim.
 */

const RECORD_KIND_LABELS: Record<RecordVersion['record_kind'], string> = {
  daily_summary: 'Day summary',
  clinician_review_draft: 'Review draft',
  clinical_event: 'Recorded event',
  clinical_fact: 'Clinical fact',
  patient_medication: 'Medication',
};

export function VersionTimeline({
  versions,
  timeZone,
}: {
  versions: RecordVersion[];
  timeZone: string;
}) {
  const ordered = [...versions].sort(
    (left, right) => Date.parse(right.created_at) - Date.parse(left.created_at),
  );

  return (
    <CollapsiblePanel
      title="Revision history"
      titleId="version-timeline-title"
      status={
        ordered.length === 0
          ? 'No data yet'
          : `${ordered.length} revision${ordered.length === 1 ? '' : 's'}`
      }
      defaultOpen={ordered.length > 0}
    >
      <p className="mb-4 text-sm text-[var(--color-ink-muted)]">
        Every version of this patient&apos;s record, newest first. A correction adds a version; it
        never replaces the earlier one.
      </p>
      <div className="min-w-0">
        {ordered.length === 0 ? (
          <EmptyState
            icon={<History size={24} />}
            title="No revisions yet"
            description="Summaries, drafts, corrections and history changes appear here as they are written."
            className="min-h-0 py-6"
          />
        ) : (
          <ol className="flex flex-col gap-4">
            {ordered.map((entry) => (
              <li
                key={`${entry.record_kind}:${entry.id}`}
                className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 sm:p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{RECORD_KIND_LABELS[entry.record_kind]}</Badge>
                  <span className="text-sm font-semibold tabular-nums">
                    {entry.version === null ? 'Version not recorded' : `Version ${entry.version}`}
                  </span>
                  {entry.supersedes_id !== null && (
                    <Badge variant="secondary">
                      <GitBranch aria-hidden="true" size={14} />
                      Replaces an earlier version
                    </Badge>
                  )}
                </div>

                <div className="mt-1">
                  <UtcAndLocalTime utc={entry.created_at} timeZone={timeZone} />
                </div>

                {entry.supersedes_id !== null && (
                  <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
                    Replaces record{' '}
                    <span className="break-all font-[family-name:var(--font-mono)]">
                      {entry.supersedes_id}
                    </span>
                  </p>
                )}

                <p className="mt-1 break-all font-[family-name:var(--font-mono)] text-sm text-[var(--color-ink-muted)]">
                  {entry.id}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </CollapsiblePanel>
  );
}
