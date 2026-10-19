import type { ReactNode } from 'react';
import {
  AlertTriangle,
  CircleDot,
  HelpCircle,
  MessageSquare,
  ShieldCheck,
  Siren,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ALERT_TIERS, SUMMARY_TIERS, type PatientRecordResponse } from '@/lib/dashboard-contracts';

type EventEvidence = PatientRecordResponse['evidence'][number];

/*
 * clinical-labels.tsx — the shared priority / attribution / provenance primitives for the
 * Phase-8 patient page, plus the one UTC-and-local timestamp renderer.
 *
 * Why these live in one module: every Phase-8 section has to mark how severe an item is and
 * where it came from "with text/icon labels, never color alone". Centralising that removes
 * the chance of one panel drifting into a colour-only encoding.
 *
 * Token pass (DESIGN-SPEC.md §1, §5 Lane C): consumes Lane A's `@theme` names verbatim —
 * `--text-label`/`--text-body`/`--text-heading`/`--spacing-*`/`--color-foreground`/
 * `--color-muted-foreground`/`--color-surface-muted`/`--radius-control` no longer exist.
 *
 * The colour-alone rule is not merely stylistic here — it is measured (DESIGN-SPEC.md §1.1):
 * even the NEW warning/danger 700-tier pair is closer in lightness than hue, so priority is
 * carried by the icon and the words; hue (via TIER_RAIL, §4.4) is reinforcement only.
 *
 * `AttributionLabel` and `UncertaintyLabel` are used ONLY by the draft-review UI — the
 * doctor decides there whether a model inference becomes a fact, so that is the one place
 * where "who said this" and "how sure is this" change a decision.
 */

/**
 * The doctor-facing priority of one item. `none`..`emergency` is the clinical ladder from
 * `daily_summary`; `fallback` is a degraded-turn marker that is deliberately NOT on that
 * ladder (RS1) — it means the turn needs a human, not that the patient is in danger.
 */
export type ClinicalPriority = (typeof SUMMARY_TIERS)[number] | (typeof ALERT_TIERS)[number];

/**
 * The subset of `ClinicalPriority` that is ever rendered as a **mark** (§4.4-b). `none` is
 * deliberately excluded — it is the one value that renders UNMARKED (§4.4-a), so it has no
 * rail/fill entry here. Reaching into `TIER_RAIL.none` is a type error, not a silent no-op.
 */
export type MarkedTier = Exclude<ClinicalPriority, 'none'>;

/**
 * How a draft item came to be known. This is derived from WHICH `clinician_review_draft`
 * array an item sits in (`patient_statements` / `confirmed_facts` / `model_inferences`) —
 * it is not a stored field, and it is never shown outside the draft-review UI.
 */
export type Attribution = 'patient_statement' | 'doctor_confirmed' | 'model_inference';

/** Readable names for the canon evidence sources (`eventEvidenceSchema.source`). */
export const SOURCE_LABELS: Record<EventEvidence['source'], string> = {
  ccdd: 'CCDD',
  ddinter: 'DDInter',
  openfda: 'OpenFDA',
  health_canada: 'Health Canada DPD',
  onsides: 'OnSIDES',
  medlineplus: 'MedlinePlus',
};

/**
 * Coverage copy for the canon `coverage_state` values.
 *
 * No entry may say or imply "safe". A dataset miss means "not found in this dataset /
 * coverage unknown" — never an assurance.
 */
export const COVERAGE_LABELS: Record<EventEvidence['coverage_state'], string> = {
  direct_evidence: 'Direct evidence',
  candidate_only: 'Candidate only — not confirmed',
  coverage_unknown: 'Coverage unknown — not found in this dataset',
};

const ATTRIBUTION_LABELS: Record<Attribution, { text: string; Icon: typeof MessageSquare }> = {
  patient_statement: { text: 'Patient statement', Icon: MessageSquare },
  doctor_confirmed: { text: 'Doctor-confirmed fact', Icon: ShieldCheck },
  model_inference: { text: 'Model inference', Icon: CircleDot },
};

const PRIORITY_LABELS: Record<
  ClinicalPriority,
  { text: string; Icon: typeof Siren; variant: 'destructive' | 'secondary' | 'outline' }
> = {
  emergency: { text: 'Emergency', Icon: Siren, variant: 'destructive' },
  important: { text: 'Important', Icon: AlertTriangle, variant: 'secondary' },
  routine: { text: 'Routine', Icon: CircleDot, variant: 'outline' },
  none: { text: 'No priority recorded', Icon: CircleDot, variant: 'outline' },
  fallback: { text: 'Needs human review', Icon: HelpCircle, variant: 'secondary' },
};

/**
 * The day-thread mark anatomy (DESIGN-SPEC.md §4.4) — the ONE structural mark in the thread.
 * `rail` is the 4px left-edge colour; `fill` is the row's 50-tint background (`null` for
 * routine — "tinting routine floods the page and destroys the signal"); `dashed` distinguishes
 * `fallback` as a system-failure texture, never a clinical severity (RS1).
 *
 * Values are CSS `var(--color-*)` references, not raw hex — every entry traces back to Lane
 * A's `@theme` tokens so a future palette edit updates the day thread automatically.
 */
export const TIER_RAIL: Record<MarkedTier, { rail: string; fill: string | null; dashed: boolean }> =
  {
    routine: { rail: 'var(--color-neutral-700)', fill: null, dashed: false },
    important: { rail: 'var(--color-warning-700)', fill: 'var(--color-warning-50)', dashed: false },
    emergency: { rail: 'var(--color-danger-700)', fill: 'var(--color-danger-50)', dashed: false },
    fallback: { rail: 'var(--color-info-700)', fill: 'var(--color-info-50)', dashed: true },
  };

/**
 * Render a stored UTC instant as both UTC and the patient's local wall time.
 *
 * The local rendering is DERIVED from the instant plus the patient's IANA zone rather than
 * read from a second stored field, so it can never disagree with the stored instant.
 * Returns `null` for an unparseable instant so callers state that plainly instead of
 * printing "Invalid Date".
 */
export function formatUtcAndLocal(
  utc: string,
  timeZone: string,
): { utc: string; local: string } | null {
  const instant = new Date(utc);
  if (Number.isNaN(instant.valueOf())) return null;

  let local: string;
  try {
    local = new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(instant);
  } catch {
    // An unusable stored zone must not cost us the UTC instant.
    local = 'local time unavailable';
  }

  return { utc: `${instant.toISOString().slice(0, 16).replace('T', ' ')} UTC`, local };
}

/**
 * The bare patient-local clock time for the day thread's 64px mono gutter (§4.3), e.g. "14:32".
 * Always 24-hour (`en-GB`) so the gutter never varies width between AM/PM rows. Falls back to
 * `--:--` rather than "Invalid Date" for the same reasons as `formatUtcAndLocal`.
 */
export function formatLocalClockTime(utc: string, timeZone: string): string {
  const instant = new Date(utc);
  if (Number.isNaN(instant.valueOf())) return '--:--';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone,
    }).format(instant);
  } catch {
    return '--:--';
  }
}

export function UtcAndLocalTime({
  utc,
  timeZone,
  className,
}: {
  utc: string;
  timeZone: string;
  className?: string;
}) {
  const formatted = formatUtcAndLocal(utc, timeZone);
  if (formatted === null) {
    return <span className="text-xs text-[var(--color-ink-muted)]">Time unavailable</span>;
  }

  return (
    <time
      dateTime={utc}
      className={className ?? 'text-xs tabular-nums text-[var(--color-ink-muted)]'}
    >
      {formatted.utc} · {formatted.local} local
    </time>
  );
}

export function PriorityLabel({ priority }: { priority: ClinicalPriority }) {
  const { text, Icon, variant } = PRIORITY_LABELS[priority];
  return (
    <Badge variant={variant}>
      <Icon aria-hidden="true" size={14} />
      {text}
    </Badge>
  );
}

export function AttributionLabel({ attribution }: { attribution: Attribution }) {
  const { text, Icon } = ATTRIBUTION_LABELS[attribution];
  return (
    <Badge variant="outline">
      <Icon aria-hidden="true" size={14} />
      {text}
    </Badge>
  );
}

export function UncertaintyLabel({ note }: { note?: string | null }) {
  return (
    <Badge variant="secondary">
      <HelpCircle aria-hidden="true" size={14} />
      {note === null || note === undefined ? 'Uncertain' : `Uncertain — ${note}`}
    </Badge>
  );
}

/**
 * A small mono metadata chip — severity ("SEV 7 / 10"), the outbound kicker
 * ("REMINDER 2"), the "Reviewed · <date>" tag. One shared visual so these tiny labels never
 * drift into their own one-off styling (§4.3, §4.4).
 */
export function EventMarkChip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={
        'inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-canvas-raised)] px-2 py-0.5 font-[family-name:var(--font-mono)] text-xs font-medium uppercase tracking-mono text-[var(--color-ink-muted)] tabular-nums' +
        (className === undefined ? '' : ` ${className}`)
      }
    >
      {children}
    </span>
  );
}

/** Provenance for a cited claim: which dataset, which version, and what coverage means. */
export function EvidenceList({ evidence }: { evidence: EventEvidence[] }) {
  if (evidence.length === 0) return null;

  return (
    <ul className="flex flex-col gap-1">
      {evidence.map((ref) => (
        <li
          key={ref.evidence_id}
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-ink-muted)]"
        >
          <span className="font-semibold text-[var(--color-ink)]">{SOURCE_LABELS[ref.source]}</span>
          <span className="break-all tabular-nums">v{ref.source_version}</span>
          <span>{COVERAGE_LABELS[ref.coverage_state]}</span>
          <span className="break-words">{ref.evidence_code}</span>
        </li>
      ))}
    </ul>
  );
}
