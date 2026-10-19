'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FlaskConical,
  HelpCircle,
  Search,
  UserRoundPlus,
  X,
} from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';
import type { PatientRow, RecentDoseOutcome } from '@/lib/dashboard-contracts';

export type { PatientRow, RecentDoseOutcome } from '@/lib/dashboard-contracts';

/*
 * PatientList (DASH-01 / D14) — the cohort table on /patients.
 *
 * Every patient renders: `is_test` is a BADGE, never a filter (D14 — the P7
 * validation cohort IS is_test=true, so filtering it would blank the dashboard).
 * Each name links to the /patients/{id} drill-down. Status badges (test / inactive /
 * opted out / active) and an accessible alert indicator on alerting rows stay
 * consistent with the top banner. An empty cohort renders a friendly prompt to the
 * enrollment form. Tokens only.
 *
 * `activeFilter` describes a URL filter the page already applied to `patients` (arriving from a
 * cohort card or the alert banner). The list only SHOWS it — as a chip that names the filter and
 * clears it — so the roster never disagrees with the count that was clicked.
 *
 * C3 (DESIGN-SPEC.md §3.2): below `lg` the roster is a stack of patient cards (the `Table`
 * primitive's `variant="cards"` — a real <table> throughout, restacked by CSS only), never a
 * horizontally-scrolled table; the old "scroll horizontally" instruction line is deleted because
 * there is nothing left to scroll to reach.
 * C4: this is the ONE surviving patient search (the shell header search is deleted by Lane B).
 * `?q=` is kept in sync via `history.replaceState` (debounced) so the query survives a reload or
 * a back-navigation without triggering a server round trip on every keystroke.
 * C1/A7: dose-outcome swatches carry a shape/glyph — not colour alone — at a ≥14px floor, with a
 * persistent (not hover-only, C2) legend naming all four states.
 * C8: the result count is debounced into a separate, screen-reader-only live region so rapid
 * typing does not fire an announcement per keystroke; the visible badge stays instant.
 */

export interface ActiveRosterFilter {
  label: string;
  clearHref: string;
}

const SEARCH_SYNC_DEBOUNCE_MS = 400;
const ANNOUNCE_DEBOUNCE_MS = 400;

/** The clinician-facing label for a patient — display name, falling back to phone. */
function patientLabel(patient: PatientRow): string {
  return patient.display_name?.trim() || patient.phone;
}

function patientInitials(patient: PatientRow): string {
  if (!patient.display_name?.trim()) return 'P';
  const label = patientLabel(patient);
  const words = label.split(/\s+/).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? '')
      .join('') || 'P'
  );
}

function formatLastReply(value: string | null): string {
  if (value === null) return 'No reply yet';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return 'Reply time unavailable';
  return `${new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date)} UTC`;
}

type DoseTone = 'success' | 'danger' | 'warning' | 'neutral';

interface DosePresentation {
  label: string;
  tone: DoseTone;
}

function dosePresentation(dose: RecentDoseOutcome): DosePresentation {
  if (dose.decided_by === 'timeout' && dose.status === 'missed') {
    return { label: 'no response', tone: 'neutral' };
  }
  if (dose.adherence_state === 'taken' || dose.adherence_state === 'delayed') {
    return { label: 'confirmed taken or delayed', tone: 'success' };
  }
  if (dose.adherence_state === 'skipped' || dose.adherence_state === 'stopped') {
    return { label: 'confirmed not taken', tone: 'danger' };
  }
  return { label: 'ambiguous response', tone: 'warning' };
}

const DOSE_LEGEND: DosePresentation[] = [
  { tone: 'success', label: 'confirmed taken or delayed' },
  { tone: 'danger', label: 'confirmed not taken' },
  { tone: 'warning', label: 'ambiguous response' },
  { tone: 'neutral', label: 'no response' },
];

/** A 14px categorical mark — shape/glyph is the primary channel, colour reinforces it (C1/A7). */
function DoseSwatch({ tone }: { tone: DoseTone }) {
  if (tone === 'success') {
    return (
      <span
        aria-hidden="true"
        className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm bg-[var(--color-success-700)] text-[var(--color-surface)]"
      >
        <Check size={10} strokeWidth={3.5} />
      </span>
    );
  }
  if (tone === 'danger') {
    return (
      <span
        aria-hidden="true"
        className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm bg-[var(--color-danger-700)] text-[var(--color-surface)]"
      >
        <X size={10} strokeWidth={3.5} />
      </span>
    );
  }
  if (tone === 'warning') {
    return (
      <span
        aria-hidden="true"
        className="inline-block size-3.5 shrink-0 rounded-sm border-2 border-[var(--color-warning-700)]"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="inline-block size-3.5 shrink-0 rounded-sm border-2 border-dotted border-[var(--color-ink-muted)]"
    />
  );
}

function DoseLegend() {
  return (
    <ul
      aria-label="Dose outcome key"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--color-border)] px-5 py-3 text-xs text-[var(--color-ink-muted)]"
    >
      {DOSE_LEGEND.map((item) => (
        <li key={item.tone} className="inline-flex items-center gap-1.5">
          <DoseSwatch tone={item.tone} />
          <span className="capitalize">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

export function PatientList({
  patients,
  initialQuery = '',
  activeFilter,
}: {
  patients: PatientRow[];
  initialQuery?: string;
  activeFilter?: ActiveRosterFilter;
}) {
  const [query, setQuery] = useState(initialQuery);
  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  const filteredPatients = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery.length === 0) return patients;
    return patients.filter((patient) =>
      [patientLabel(patient), patient.phone, patient.medication_name].some((value) =>
        value.toLocaleLowerCase().includes(normalizedQuery),
      ),
    );
  }, [patients, query]);

  // C4 — the roster search is the ONE surviving `?q=` control; keep it in the URL (debounced,
  // via replaceState — never a fresh history entry per keystroke) so it survives reload/back.
  useEffect(() => {
    const handle = setTimeout(() => {
      const url = new URL(window.location.href);
      if (query.trim().length > 0) {
        url.searchParams.set('q', query);
      } else {
        url.searchParams.delete('q');
      }
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }, SEARCH_SYNC_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  // C8 — the visible count badge updates instantly; a separate sr-only live region announces
  // it on a debounce so a screen reader is not read a new count on every keystroke. The whole
  // sentence (not just the number) is computed on the debounce so the branch and the count
  // never disagree mid-keystroke.
  const announceCount = (count: number): string =>
    count === patients.length
      ? `Showing all ${patients.length} records`
      : `${count} of ${patients.length} records match`;
  const [announcement, setAnnouncement] = useState(() => announceCount(filteredPatients.length));
  useEffect(() => {
    const handle = setTimeout(
      () => setAnnouncement(announceCount(filteredPatients.length)),
      ANNOUNCE_DEBOUNCE_MS,
    );
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredPatients.length, patients.length]);

  const filterChip =
    activeFilter === undefined ? null : (
      <span className="inline-flex min-h-11 items-center gap-1 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent-100)] py-1 pl-3 pr-1 text-sm font-semibold text-[var(--color-accent)]">
        {activeFilter.label}
        <Link
          href={activeFilter.clearHref}
          aria-label={`Clear the ${activeFilter.label.toLocaleLowerCase()} filter`}
          className="inline-flex size-9 items-center justify-center rounded-full transition-colors hover:bg-[var(--color-surface)]"
        >
          <X aria-hidden="true" size={16} />
        </Link>
      </span>
    );

  if (patients.length === 0) {
    return (
      <section aria-labelledby="patient-directory-title">
        <div className="mb-4">
          <h2
            id="patient-directory-title"
            className="text-lg font-semibold tracking-heading text-[var(--color-ink)]"
          >
            Patient roster
          </h2>
          <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
            Enrolled participants and their current monitoring status.
          </p>
        </div>
        {activeFilter === undefined ? (
          <EmptyState
            icon={<UserRoundPlus size={24} />}
            title="No patients enrolled"
            description="Your cohort will appear here after the first patient is enrolled."
            action={
              <Link href="/patients/new" className={buttonVariants({ variant: 'primary' })}>
                Enroll a patient
              </Link>
            }
          />
        ) : (
          // The cohort is not empty — this filter is. Say so, and offer the way back.
          <EmptyState
            icon={<HelpCircle size={24} />}
            title={`No patients under ${activeFilter.label.toLocaleLowerCase()}`}
            description="Nobody in the cohort is in this group right now."
            action={
              <Link
                href={activeFilter.clearHref}
                className={cn(buttonVariants({ variant: 'secondary' }), 'gap-2')}
              >
                <X aria-hidden="true" size={16} />
                Show all patients
              </Link>
            }
          />
        )}
      </section>
    );
  }

  return (
    <section
      aria-labelledby="patient-directory-title"
      className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--elev-1)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-border)] px-5 py-4">
        <div>
          <h2
            id="patient-directory-title"
            className="text-lg font-semibold tracking-heading text-[var(--color-ink)]"
          >
            Patient roster
          </h2>
          <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
            Enrolled participants and their current monitoring status
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {filterChip}
          <label className="relative block">
            <span className="sr-only">Search patients</span>
            <Search
              aria-hidden="true"
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-ink-muted)]"
            />
            <input
              id="patient-roster-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search patients"
              // No text-size utility here on purpose (F2): the base layer already forces every
              // input/select/textarea to --text-input (16px, the iOS auto-zoom floor) — a
              // component-level text-* class has higher specificity and would silently win,
              // undermining that global floor.
              className="min-h-11 w-[min(18rem,70vw)] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-2 pl-9 pr-3 text-[var(--color-ink)] placeholder:text-[var(--color-ink-muted)]"
            />
          </label>
          <Badge variant="secondary">
            {query.trim().length > 0
              ? `${filteredPatients.length} of ${patients.length} records`
              : `${patients.length} ${patients.length === 1 ? 'record' : 'records'}`}
          </Badge>
          <span role="status" aria-live="polite" className="sr-only">
            {announcement}
          </span>
        </div>
      </div>

      <DoseLegend />

      {filteredPatients.length === 0 ? (
        <div className="flex min-h-48 flex-col items-center justify-center px-5 py-8 text-center">
          <span className="mb-3 inline-flex size-10 items-center justify-center rounded-full bg-[var(--color-canvas-raised)] text-[var(--color-ink-muted)]">
            <Search aria-hidden="true" size={18} />
          </span>
          <p className="font-semibold text-[var(--color-ink)]">No matching patients</p>
          <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
            Try a different name, phone number, or medication.
          </p>
          <button
            type="button"
            onClick={() => setQuery('')}
            className={cn(buttonVariants({ variant: 'secondary' }), 'mt-4 gap-2')}
          >
            <X aria-hidden="true" size={16} />
            Clear search
          </button>
        </div>
      ) : (
        <Table
          variant="cards"
          scrollLabel="Patient roster table"
          containerClassName="rounded-none border-0 shadow-none"
        >
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Patient</TableHead>
              <TableHead scope="col">Medication</TableHead>
              <TableHead scope="col">Adherence</TableHead>
              <TableHead scope="col">Last reply</TableHead>
              <TableHead scope="col">Last 14 doses</TableHead>
              <TableHead scope="col">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredPatients.map((patient) => {
              const hasDisplayName = Boolean(patient.display_name?.trim());
              const receivingCheckIns =
                patient.is_active && patient.agent_enabled && patient.provider_opted_in;
              const awaitingDoctor =
                patient.is_active && patient.provider_opted_in && !patient.agent_enabled;
              const waitingForStart = patient.is_active && !patient.provider_opted_in;
              return (
                <TableRow key={patient.id}>
                  <TableCell>
                    <Link
                      href={`/patients/${patient.id}`}
                      className="group inline-flex min-h-11 items-center gap-3 rounded-md text-[var(--color-ink)]"
                    >
                      <span
                        aria-hidden="true"
                        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-50)] text-xs font-semibold text-[var(--color-accent)]"
                      >
                        {patientInitials(patient)}
                      </span>
                      <span className="flex flex-col">
                        <span className="font-semibold group-hover:text-[var(--color-accent)]">
                          {patientLabel(patient)}
                        </span>
                        {hasDisplayName && (
                          <span className="text-sm font-normal text-[var(--color-ink-muted)]">
                            {patient.phone}
                          </span>
                        )}
                      </span>
                      <ChevronRight
                        aria-hidden="true"
                        className="text-[var(--color-ink-muted)] transition-colors group-hover:text-[var(--color-ink)]"
                        size={18}
                      />
                    </Link>
                  </TableCell>
                  <TableCell label="Medication">
                    <span className="font-semibold">{patient.medication_name}</span>
                  </TableCell>
                  <TableCell label="Adherence">
                    {patient.adherence_rate === null ? (
                      <span className="text-[var(--color-ink-muted)]">—</span>
                    ) : (
                      <div className="min-w-24">
                        <span className="font-semibold tabular-nums">
                          {Math.round(patient.adherence_rate * 100)}%
                        </span>
                        <span
                          role="progressbar"
                          aria-label={`${patientLabel(patient)} adherence`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(patient.adherence_rate * 100)}
                          className="mt-2 block h-1.5 overflow-hidden rounded-full bg-[var(--color-canvas-raised)]"
                        >
                          <span
                            aria-hidden="true"
                            className="block h-full rounded-full bg-[var(--color-accent)]"
                            style={{
                              width: `${Math.max(0, Math.min(100, Math.round(patient.adherence_rate * 100)))}%`,
                            }}
                          />
                        </span>
                      </div>
                    )}
                  </TableCell>
                  <TableCell label="Last reply">
                    <time
                      dateTime={patient.last_reply_at ?? undefined}
                      className="whitespace-nowrap text-xs text-[var(--color-ink-muted)]"
                    >
                      {formatLastReply(patient.last_reply_at)}
                    </time>
                  </TableCell>
                  <TableCell label="Last 14 doses">
                    {patient.recent_doses.length === 0 ? (
                      <span className="text-[var(--color-ink-muted)]">—</span>
                    ) : (
                      <ol
                        aria-label={`Last ${patient.recent_doses.length} resolved doses`}
                        className="flex min-w-[154px] flex-wrap items-center gap-1"
                      >
                        {patient.recent_doses.map((dose) => {
                          const presentation = dosePresentation(dose);
                          return (
                            <li
                              key={dose.dose_id}
                              className="inline-flex"
                              title={presentation.label}
                            >
                              <DoseSwatch tone={presentation.tone} />
                              <span className="sr-only">{presentation.label}</span>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </TableCell>
                  <TableCell label="Status">
                    <span className="flex min-w-32 flex-col items-start gap-2">
                      <span className="inline-flex flex-wrap gap-1">
                        {patient.alerting && (
                          <Badge variant="destructive">
                            <AlertTriangle aria-hidden="true" size={14} />
                            needs review
                          </Badge>
                        )}
                        {patient.reported_miss_alerting && (
                          <Badge variant="destructive">
                            <AlertTriangle aria-hidden="true" size={14} />
                            reported misses
                          </Badge>
                        )}
                        {patient.is_test && (
                          <Badge variant="secondary">
                            <FlaskConical aria-hidden="true" size={14} />
                            test
                          </Badge>
                        )}
                        {!patient.is_active && (
                          <Badge variant="destructive">
                            <Ban aria-hidden="true" size={14} />
                            inactive
                          </Badge>
                        )}
                        {waitingForStart && (
                          <Badge variant="outline">
                            <Ban aria-hidden="true" size={14} />
                            messaging stopped
                          </Badge>
                        )}
                        {awaitingDoctor && (
                          <Badge variant="secondary">
                            <Clock3 aria-hidden="true" size={14} />
                            awaiting doctor reactivation
                          </Badge>
                        )}
                        {receivingCheckIns && (
                          <Badge variant="success">
                            <CheckCircle2 aria-hidden="true" size={14} />
                            receiving check-ins
                          </Badge>
                        )}
                      </span>
                      {waitingForStart && (
                        <span className="text-xs text-[var(--color-ink-muted)]">
                          Waiting for patient to text START
                        </span>
                      )}
                      {patient.consecutive_missed > 0 && (
                        <span className="text-xs text-[var(--color-ink-muted)]">
                          {patient.consecutive_missed} unanswered check-ins
                        </span>
                      )}
                      {patient.consecutive_reported_misses > 0 && (
                        <span className="text-xs text-[var(--color-ink-muted)]">
                          {patient.consecutive_reported_misses} reported missed doses in a row
                        </span>
                      )}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
