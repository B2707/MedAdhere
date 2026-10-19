import { Pill, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { CollapsiblePanel } from '@/components/ui/collapsible';
import { EmptyState } from '@/components/ui/empty-state';
import type { PatientRecordResponse } from '@/lib/dashboard-contracts';

type ClinicalHistory = PatientRecordResponse['history'];

/*
 * medications-history-panel.tsx — the doctor-owned clinical record: every medication and
 * every clinical fact, current and superseded.
 *
 * Superseded entries stay VISIBLE and labelled rather than being filtered out. The record is
 * append-only by design — a correction adds a row and points at the one it replaces — so
 * hiding the replaced row would quietly rewrite the history the chain exists to preserve.
 * Per the versions decision, medications and facts ignore the 30-day window entirely: a
 * medication started a year ago is still what the patient takes today.
 *
 * Allergies are rendered above conditions and notes. It is the one group where missing an
 * entry while scanning is a safety problem, not an inconvenience.
 *
 * The agent is read-only here. Only the owning doctor can create or change these rows, and
 * the panel says so rather than offering controls that would fail server-side.
 *
 * Token pass (DESIGN-SPEC.md §5 Lane D): consumes Lane A's `@theme` names verbatim.
 */

type Medication = ClinicalHistory['medications'][number];
type Fact = ClinicalHistory['facts'][number];

/** Current entries first; a superseded row is still shown, just last. */
const MEDICATION_RANK: Record<Medication['status'], number> = {
  active: 0,
  stopped: 1,
  corrected: 2,
};

const MEDICATION_STATUS_LABELS: Record<Medication['status'], string> = {
  active: 'Active',
  stopped: 'Stopped',
  corrected: 'Superseded by a correction',
};

const FACT_STATUS_LABELS: Record<Fact['status'], string> = {
  current: 'Current',
  corrected: 'Superseded by a correction',
  retracted: 'Retracted',
};

/** Allergies first — see the note above. */
const FACT_GROUPS = [
  { type: 'allergy', heading: 'Allergies' },
  { type: 'condition', heading: 'Conditions' },
  { type: 'note', heading: 'Notes' },
] as const;

const IDENTITY_SYSTEM_LABELS: Record<NonNullable<Medication['identity']>['system'], string> = {
  ccdd: 'CCDD',
  din: 'DIN',
  rxnorm: 'RxCUI',
  local: 'Local code',
};

/** A muted chip for anything the doctor did not fill in — never an invented value. */
function detailLine(medication: Medication): string {
  const parts = [medication.doseText, medication.form, medication.route].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? 'No dose, form or route recorded' : parts.join(' · ');
}

function MedicationRow({ medication }: { medication: Medication }) {
  const isSuperseded = medication.status === 'corrected';
  return (
    <li
      className={`rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 sm:p-4 ${
        isSuperseded ? 'bg-[var(--color-canvas-raised)]' : 'bg-[var(--color-surface)]'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-words font-semibold">{medication.enteredName}</span>
        <Badge variant={isSuperseded ? 'secondary' : 'outline'}>
          {MEDICATION_STATUS_LABELS[medication.status]}
        </Badge>
      </div>

      <p className="mt-1 break-words text-sm text-[var(--color-ink-muted)]">
        {detailLine(medication)}
      </p>

      <p className="mt-1 text-sm tabular-nums text-[var(--color-ink-muted)]">
        {medication.validFrom} → {medication.validTo ?? 'ongoing'}
      </p>

      <p className="mt-1 break-words text-sm text-[var(--color-ink-muted)]">
        {medication.identity === null
          ? 'Not coded to a source'
          : `${IDENTITY_SYSTEM_LABELS[medication.identity.system]} ${medication.identity.code}`}
      </p>

      {medication.ingredients.length > 0 && (
        <p className="mt-1 break-words text-sm text-[var(--color-ink-muted)]">
          Ingredients: {medication.ingredients.map((ingredient) => ingredient.name).join(', ')}
        </p>
      )}
    </li>
  );
}

function FactRow({ entry }: { entry: Fact }) {
  const isSuperseded = entry.status !== 'current';
  return (
    <li
      className={`rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 sm:p-4 ${
        isSuperseded ? 'bg-[var(--color-canvas-raised)]' : 'bg-[var(--color-surface)]'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 break-words text-base">{entry.statementText}</p>
        <Badge variant={isSuperseded ? 'secondary' : 'outline'}>
          {FACT_STATUS_LABELS[entry.status]}
        </Badge>
      </div>
      {entry.factCode !== null && (
        <p className="mt-1 break-all font-[family-name:var(--font-mono)] text-sm text-[var(--color-ink-muted)]">
          {entry.factCode}
        </p>
      )}
    </li>
  );
}

export function MedicationsHistoryPanel({ history }: { history: ClinicalHistory }) {
  const medications = [...history.medications].sort(
    (left, right) => MEDICATION_RANK[left.status] - MEDICATION_RANK[right.status],
  );
  const hasData = medications.length > 0 || history.facts.length > 0;
  const status = hasData
    ? `${medications.length} medication${medications.length === 1 ? '' : 's'} · ${history.facts.length} history entr${history.facts.length === 1 ? 'y' : 'ies'}`
    : 'No data yet';

  return (
    <CollapsiblePanel
      title="Medications and history"
      titleId="medications-history-title"
      status={status}
      defaultOpen={hasData}
    >
      <p className="mb-4 text-sm text-[var(--color-ink-muted)]">
        Only you can add or change these entries. Corrected entries stay visible so the record reads
        as it was written.
      </p>
      <div className="flex flex-col gap-6">
        <section aria-labelledby="medications-title">
          <h3 id="medications-title" className="text-base font-semibold">
            Medications
          </h3>
          {medications.length === 0 ? (
            <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
              No medication recorded for this patient.
            </p>
          ) : (
            <ol className="mt-4 flex flex-col gap-4">
              {medications.map((medication) => (
                <MedicationRow key={medication.id} medication={medication} />
              ))}
            </ol>
          )}
        </section>

        {history.facts.length === 0 ? (
          <section aria-labelledby="clinical-history-title">
            <h3 id="clinical-history-title" className="text-base font-semibold">
              Clinical history
            </h3>
            <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
              No clinical history recorded for this patient.
            </p>
          </section>
        ) : (
          FACT_GROUPS.map(({ type, heading }) => {
            const entries = history.facts.filter((entry) => entry.factType === type);
            if (entries.length === 0) return null;
            return (
              <section key={type} aria-labelledby={`clinical-history-${type}`}>
                <h3
                  id={`clinical-history-${type}`}
                  className="flex items-center gap-1 text-base font-semibold"
                >
                  {type === 'allergy' && <ShieldAlert aria-hidden="true" size={16} />}
                  {heading}
                </h3>
                <ol className="mt-4 flex flex-col gap-4">
                  {entries.map((entry) => (
                    <FactRow key={entry.id} entry={entry} />
                  ))}
                </ol>
              </section>
            );
          })
        )}

        {medications.length === 0 && history.facts.length === 0 && (
          <EmptyState
            icon={<Pill size={24} />}
            title="Nothing recorded yet"
            description="Medications, conditions, allergies and notes you enter for this patient appear here."
            className="min-h-0 py-6"
          />
        )}
      </div>
    </CollapsiblePanel>
  );
}
