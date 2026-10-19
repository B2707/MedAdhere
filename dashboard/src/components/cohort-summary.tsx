import Link from 'next/link';
import { Activity, AlertTriangle, MessageCircle, UserCheck, type LucideIcon } from 'lucide-react';
import type { CohortWindowDays } from '@/lib/cohort-metrics';
import type { RosterFilterHrefs } from '@/lib/roster-filters';
import type { PatientRow } from './patient-list';

/*
 * The two cards that count PATIENTS ("Active patients", "Open alerts") are entry points into the
 * roster: each links to the matching /patients?filter=… view via a stretched overlay link, which
 * keeps the <dl>/<dt>/<dd> structure intact while making the whole card the click target. The two
 * rate cards stay static — a percentage over the cohort window is not a subset of patients, so
 * there is nothing honest to filter the roster down to.
 *
 * C5 (DESIGN-SPEC.md §3.2): the summary is a <dl> with its native description-list semantics —
 * `role="group"` used to override that, so assistive tech lost the term/definition pairing. The
 * accessible name now comes from `aria-labelledby` on a wrapping landmark pointing at a
 * visually-hidden heading, never from re-typing the native role.
 */

interface SummaryItem {
  label: string;
  value: number | string;
  description: string;
  icon: LucideIcon;
  iconClassName: string;
  href?: string;
}

interface CohortSummaryProps {
  patients: PatientRow[];
  adherencePct: number | null;
  responsePct: number | null;
  windowDays?: CohortWindowDays;
  filterHrefs?: RosterFilterHrefs;
}

function formatPct(ratio: number | null): string {
  return ratio === null ? '—' : `${Math.round(ratio * 100)}%`;
}

export function CohortSummary({
  patients,
  adherencePct,
  responsePct,
  windowDays = 30,
  filterHrefs,
}: CohortSummaryProps) {
  const activeCount = patients.filter(
    (patient) => patient.is_active !== false && patient.opted_out_at === null,
  ).length;
  const items: SummaryItem[] = [
    {
      label: 'Cohort adherence',
      value: formatPct(adherencePct),
      description: `Confirmed taken or delayed · ${windowDays}d`,
      icon: Activity,
      iconClassName: 'text-[var(--color-accent)]',
    },
    {
      label: 'Active patients',
      value: `${activeCount} / ${patients.length}`,
      description: 'Receiving check-ins',
      icon: UserCheck,
      iconClassName: 'text-[var(--color-success-700)]',
      href: filterHrefs?.active,
    },
    {
      label: `Reply rate · ${windowDays}d`,
      value: formatPct(responsePct),
      description: 'Delivered check-ins with a reply',
      icon: MessageCircle,
      iconClassName: 'text-[var(--color-info-700)]',
    },
    {
      label: 'Open alerts',
      value: patients.filter((patient) => patient.alerting === true && patient.is_active !== false)
        .length,
      description: 'Consecutive non-response alerts',
      icon: AlertTriangle,
      iconClassName: 'text-[var(--color-danger-700)]',
      href: filterHrefs?.['needs-review'],
    },
  ];

  return (
    <section aria-labelledby="cohort-summary-heading">
      <h2 id="cohort-summary-heading" className="sr-only">
        Cohort summary
      </h2>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <div
              key={item.label}
              className={`relative min-w-0 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4 shadow-[var(--elev-1)]${
                item.href === undefined
                  ? ''
                  : ' transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-surface-hover)]'
              }`}
            >
              {item.href !== undefined && (
                <Link
                  href={item.href}
                  // Stretched overlay: the whole card is the target without nesting an <a> between
                  // the <dl> and its <dt>/<dd>. The negative offset keeps the global focus ring
                  // inside the card, which clips overflow.
                  className="absolute inset-0 z-10 rounded-lg focus-visible:focus-inset"
                >
                  <span className="sr-only">Show {item.label.toLocaleLowerCase()}</span>
                </Link>
              )}
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-col">
                  <dt className="font-[family-name:var(--font-mono)] text-xs font-medium uppercase tracking-mono text-[var(--color-ink-muted)]">
                    {item.label}
                  </dt>
                  <dd className="mt-2 text-2xl font-semibold leading-none tracking-stat tabular-nums text-[var(--color-ink)]">
                    {item.value}
                  </dd>
                </div>
                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-canvas-raised)]">
                  <Icon aria-hidden="true" className={item.iconClassName} size={17} />
                </span>
              </div>
              <p className="mt-3 text-sm text-[var(--color-ink-muted)]">{item.description}</p>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
