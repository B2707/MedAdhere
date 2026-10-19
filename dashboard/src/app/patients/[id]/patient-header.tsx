import { CheckCircle2, FlaskConical } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { PatientRecordResponse, TimelineRow } from '@/lib/dashboard-contracts';

/*
 * patient-header.tsx — the patient header strip (DESIGN-SPEC.md §4.1, §5 Lane D).
 *
 * Replaces three pre-redesign components with one card: the "Patient overview" card
 * (R6), the AlertBanner/ReportedMissBanner pair (their counts become plain facts here —
 * a loud "follow-up needed" callout on the page you're already looking at was
 * redundant), and "Latest classification" (R9, folded into row 2). Split out of
 * `page.tsx` to keep that file under the §5 Lane D line budget.
 */

function latestClassifierRow(timeline: TimelineRow[]): TimelineRow | null {
  return timeline.reduce<TimelineRow | null>((latest, row) => {
    if (row.decided_by !== 'classifier' || row.status !== 'recorded') return latest;
    if (latest === null) return row;
    return Date.parse(row.scheduled_at) > Date.parse(latest.scheduled_at) ? row : latest;
  }, null);
}

function localDoseLabel(row: TimelineRow): string {
  const time = row.local_dose_time.slice(0, 5);
  if (row.dose_date === null) return time;
  const date = new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${row.dose_date}T00:00:00.000Z`));
  return `${date} · ${time}`;
}

/** Row 2's third fact — outcome · reason · scheduled dose, absorbing the old panel (R9). */
function LatestClassificationFact({ timeline }: { timeline: TimelineRow[] }) {
  const latest = latestClassifierRow(timeline);
  const state = latest?.adherence_state?.replaceAll('_', ' ') ?? null;
  const reason = latest?.reason_code?.replaceAll('_', ' ') ?? null;
  const parts = [
    state ?? 'No data yet',
    reason !== null && reason !== 'none' ? `reason: ${reason}` : null,
    latest !== null ? `scheduled ${localDoseLabel(latest)}` : null,
  ].filter((part): part is string => part !== null);

  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className="font-[family-name:var(--font-mono)] text-xs font-medium uppercase tracking-mono text-[var(--color-ink-muted)]">
        Latest classification
      </dt>
      <dd className="min-w-0 break-words font-semibold">{parts.join(' · ')}</dd>
    </div>
  );
}

export function PatientHeaderStrip({
  patient,
  receivingCheckIns,
  timeline,
}: {
  patient: PatientRecordResponse['patient'];
  receivingCheckIns: boolean;
  timeline: TimelineRow[];
}) {
  return (
    <Card role="region" aria-label="Patient status" className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        {patient.is_test && (
          <Badge variant="secondary">
            <FlaskConical aria-hidden="true" size={14} />
            test
          </Badge>
        )}
        {patient.is_active === false && <Badge variant="destructive">inactive</Badge>}
        {!patient.provider_opted_in && <Badge variant="outline">opted out</Badge>}
        {patient.is_active && patient.provider_opted_in && !patient.agent_enabled && (
          <Badge variant="secondary">awaiting doctor reactivation</Badge>
        )}
        {receivingCheckIns && (
          <Badge variant="success">
            <CheckCircle2 aria-hidden="true" size={14} />
            active
          </Badge>
        )}
        <span className="text-sm text-[var(--color-ink-muted)]">{patient.timezone}</span>
      </div>
      <dl className="mt-3 flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-baseline gap-2">
          <dt className="font-[family-name:var(--font-mono)] text-xs font-medium uppercase tracking-mono text-[var(--color-ink-muted)]">
            Non-response streak
          </dt>
          <dd className="font-semibold tabular-nums">{patient.consecutive_missed} unanswered</dd>
        </div>
        {patient.reported_miss_alerting && (
          <div className="flex items-baseline gap-2">
            <dt className="font-[family-name:var(--font-mono)] text-xs font-medium uppercase tracking-mono text-[var(--color-ink-muted)]">
              Reported misses
            </dt>
            <dd className="font-semibold tabular-nums text-[var(--color-warning-700)]">
              {patient.consecutive_reported_misses} in a row
            </dd>
          </div>
        )}
        <LatestClassificationFact timeline={timeline} />
      </dl>
    </Card>
  );
}
