import Link from 'next/link';
import { AlertTriangle, ChevronRight } from 'lucide-react';

interface AlertPatient {
  alerting: boolean;
  is_active: boolean;
}

/*
 * AlertBanner (DASH-04 / D5 / M13) — the consecutive-miss alert pinned to the top of
 * the patients page.
 *
 * The data-API `alerting` flag already encodes D5 semantics (is_active AND not
 * opted-out AND consecutive_missed ≥ threshold), so we TRUST it rather than recompute;
 * we additionally guard `is_active !== false` (defence-in-depth — never surface an
 * inactive patient). The threshold is interpolated from the API (never a hardcoded 3).
 *
 * M13 (binding): timeout rows are a RESPONSE-RATE bucket — the copy says "without a
 * response", never "missed doses" / confirmed non-adherence. The banner is omitted
 * entirely when nothing is alerting.
 *
 * `href` turns the banner into the way INTO those patients (the roster filtered to the same
 * set this count is drawn from). It stays optional so the banner keeps working as plain text
 * wherever no filtered view exists to link to.
 *
 * A9 (DESIGN-SPEC.md §3.5): NOT `role="status"`. A polite live region is for content that
 * changes while the user is looking at it and needs an announcement of *what* changed —
 * this banner's only "change" is a full page (re)render, so `role="status"` fires an
 * announcement with no preceding context to attach it to. A plain `role="region"` with a
 * name is discoverable by landmark navigation without the false live-update signal.
 */

/** Count active patients the banner should fire for (D5 — trust `alerting`, exclude inactive). */
export function countAlertingPatients(patients: AlertPatient[]): number {
  return patients.filter((patient) => patient.alerting === true && patient.is_active !== false)
    .length;
}

export function AlertBanner({
  patients,
  threshold,
  href,
}: {
  patients: AlertPatient[];
  threshold: number;
  href?: string;
}) {
  const count = countAlertingPatients(patients);
  if (count === 0) return null;

  const subject = count === 1 ? '1 patient has' : `${count} patients have`;
  const body = (
    <>
      <p className="text-sm font-semibold text-[var(--color-warning-700)]">Follow-up needed</p>
      <p className="mt-0.5 break-words text-sm text-[var(--color-ink-muted)]">
        {subject} {threshold}+ consecutive check-ins without a response.
      </p>
    </>
  );

  return (
    <div
      role="region"
      aria-label="Follow-up needed"
      className="flex items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--color-warning-700)] bg-[var(--color-warning-50)] px-4 py-3 text-[var(--color-ink)]"
    >
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface)] text-[var(--color-warning-700)]">
        <AlertTriangle aria-hidden="true" size={17} />
      </span>
      {href === undefined ? (
        <div className="min-w-0">{body}</div>
      ) : (
        <Link
          href={href}
          className="group flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-md)] focus-visible:focus-inset"
        >
          <span className="min-w-0">{body}</span>
          <ChevronRight
            aria-hidden="true"
            size={18}
            className="ml-auto shrink-0 text-[var(--color-warning-700)] transition-transform group-hover:translate-x-0.5"
          />
        </Link>
      )}
    </div>
  );
}

interface ReportedMissPatient {
  reported_miss_alerting: boolean;
  consecutive_reported_misses: number;
  is_active: boolean;
}

/*
 * ReportedMissBanner — the SEPARATE reported-miss alert on the patient record. Tracks
 * consecutive classifier-confirmed 'skipped' replies (the patient TEXTED that a dose was
 * missed), never the silence streak above — the API keeps the two streaks apart and this
 * banner keeps their wording apart. Trust the API `reported_miss_alerting` flag (same
 * posture as AlertBanner), guard `is_active` defence-in-depth, render nothing otherwise.
 */
export function ReportedMissBanner({ patient }: { patient: ReportedMissPatient }) {
  if (patient.reported_miss_alerting !== true || patient.is_active === false) return null;

  return (
    <div
      role="region"
      aria-label="Reported missed doses"
      className="flex items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--color-warning-700)] bg-[var(--color-warning-50)] px-4 py-3 text-[var(--color-ink)]"
    >
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface)] text-[var(--color-warning-700)]">
        <AlertTriangle aria-hidden="true" size={17} />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-[var(--color-warning-700)]">
          Reported missed doses
        </p>
        <p className="mt-0.5 break-words text-sm text-[var(--color-ink-muted)]">
          {patient.consecutive_reported_misses} reported missed doses in a row.
        </p>
      </div>
    </div>
  );
}
