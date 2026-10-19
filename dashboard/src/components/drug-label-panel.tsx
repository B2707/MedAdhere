import {
  DRUG_PROFILE_SOURCE,
  type DrugProfileData,
} from '../../../packages/shared/src/drug-profile';
import { Database, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { FdaDisclaimerNote } from '@/components/fda-disclaimer-note';

interface DrugLabelPanelProps {
  medicationName: string;
  profile: DrugProfileData | null;
  fetchedAt: string | null;
}

/*
 * drug-label-panel.tsx — UNMOUNTED, retained (DESIGN-SPEC.md R8, §5 Lane D): the page's
 * "Drug label context" section hardcoded `profile={null}` with no real data source, so it
 * can never show anything. Removed from `page.tsx`; the file stays in the tree (and gets
 * the same token pass as every owned file) so the section can be remounted the moment a
 * real drug-profile source lands, without a rewrite.
 *
 * Token pass (DESIGN-SPEC.md §5 Lane D): consumes Lane A's `@theme` names verbatim.
 */
function fetchedDate(value: string | null): string {
  if (value === null) return 'date unavailable';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? 'date unavailable' : parsed.toISOString().slice(0, 10);
}

/*
 * Rendered as flat row content inside the record page's collapsible "Drug label context"
 * section — the section header (title + one-line status) is the caller's, so this component
 * carries only the label content itself. No card-in-card chrome (taste directive).
 */
function UnavailablePanel({ reason }: { reason?: string }) {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-[var(--color-ink-muted)]">
        Stored label features frozen at enrollment.
      </p>
      <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] bg-[var(--color-canvas-raised)] p-3 sm:p-4">
        <Badge variant="secondary">Drug label unavailable</Badge>
        <p className="mt-2 text-[var(--color-ink-muted)]">
          {reason ?? 'The stored drug profile is missing or malformed.'}
        </p>
      </div>
      <FdaDisclaimerNote />
    </div>
  );
}

export function DrugLabelPanel({ profile, fetchedAt }: DrugLabelPanelProps) {
  if (profile === null) {
    return <UnavailablePanel />;
  }

  if (profile.label_features_enabled === false) {
    const reason =
      profile.reason === 'unresolved_ingredient'
        ? 'The medication could not be normalized to an ingredient label.'
        : 'No matching drug label could be resolved.';
    return <UnavailablePanel reason={reason} />;
  }

  const hasFdaLabel = profile.source === DRUG_PROFILE_SOURCE.FDA_LABEL;
  const warningLabel = hasFdaLabel
    ? profile.boxed_warning_present
      ? 'Boxed warning present'
      : 'Boxed warning not present on checked FDA label'
    : 'Unknown — no FDA label';
  const warningVariant = hasFdaLabel
    ? profile.boxed_warning_present
      ? 'destructive'
      : 'outline'
    : 'secondary';
  const provenance = hasFdaLabel
    ? `US FDA label, fetched ${fetchedDate(fetchedAt)} UTC`
    : `RxNorm ingredient / OnSIDES profile, fetched ${fetchedDate(fetchedAt)} UTC`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-[var(--color-ink-muted)]">
          Stored label features frozen at enrollment.
        </p>
        <Badge variant={warningVariant}>{warningLabel}</Badge>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-[var(--radius-md)] bg-[var(--color-canvas-raised)] p-3 sm:p-4">
          <h3 className="text-sm font-semibold">DIN</h3>
          <p className="mt-1 tabular-nums">{profile.dpd.din ?? 'Not available'}</p>
        </div>
        <div className="rounded-[var(--radius-md)] bg-[var(--color-canvas-raised)] p-3 sm:p-4">
          <h3 className="text-sm font-semibold">ATC</h3>
          <p className="mt-1 tabular-nums">{profile.dpd.atc ?? 'Not available'}</p>
        </div>
      </div>

      {profile.boxed_warning.length > 0 && (
        <section className="rounded-[var(--radius-md)] border border-[var(--color-danger-700)] bg-[var(--color-danger-50)] p-3 sm:p-4">
          <div className="flex items-center gap-2">
            <ShieldAlert aria-hidden="true" className="text-[var(--color-danger-700)]" size={18} />
            <h3 className="text-sm font-semibold">Boxed warning</h3>
          </div>
          <p className="mt-2 whitespace-pre-line">{profile.boxed_warning.join('\n\n')}</p>
        </section>
      )}

      <section className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 sm:p-4">
        <div className="flex items-center gap-2">
          <ShieldAlert aria-hidden="true" className="text-[var(--color-ink-muted)]" size={18} />
          <h3 className="text-sm font-semibold">Warnings and precautions</h3>
        </div>
        {profile.warnings_and_cautions.length > 0 ? (
          <p className="mt-2 whitespace-pre-line">{profile.warnings_and_cautions.join('\n\n')}</p>
        ) : (
          <p className="mt-2 text-[var(--color-ink-muted)]">
            No warnings-and-precautions excerpt available.
          </p>
        )}
      </section>

      <p className="flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
        <Database aria-hidden="true" className="shrink-0" size={16} />
        {provenance}
      </p>

      <FdaDisclaimerNote />
    </div>
  );
}
