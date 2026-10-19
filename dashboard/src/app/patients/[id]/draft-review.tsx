'use client';

import { useActionState, useEffect, useRef } from 'react';
import { Check, ClipboardCheck, X } from 'lucide-react';
import { AttributionLabel, UncertaintyLabel, UtcAndLocalTime } from '@/components/clinical-labels';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import type { Attribution } from '@/components/clinical-labels';
import type { ReviewDraft } from '@/lib/dashboard-contracts';
import { reviewDraftDecisionAction } from './review-actions';

/*
 * draft-review.tsx — where the doctor confirms or rejects an agent-written review draft.
 *
 * This is the ONE surface that carries attribution and uncertainty labels. Everywhere else
 * they would be decoration; here they are the decision. The doctor is being asked whether a
 * model inference should become a doctor-owned fact, so "who said this" and "how sure is
 * this" have to be visible on the item itself.
 *
 * The draft's own arrays supply the attribution — an item's bucket IS its provenance — so
 * nothing is inferred and no stored attribution field is needed.
 *
 * Concurrency is optimistic and explicit. Every decision carries the version the doctor was
 * looking at. A draft the server already superseded (`is_latest === false`) never renders
 * controls at all, and a 409 from a version that went stale mid-read is shown as "reload",
 * not as a failure to retry: retrying the same stale version would fail identically.
 *
 * Corrections are opt-IN, one checkbox each. Confirming a draft must not silently apply a
 * fact revision the doctor did not read, and a rejection applies nothing at all.
 *
 * Clinical Swiss token pass (DESIGN-SPEC.md §5 Lane F, R10): this is the exported component the
 * patient-record page (Lane D) mounts inline at the end of the day thread — the export surface
 * (`DraftReview` props) is unchanged, only the token classes below migrated.
 */

function bucketLabelId(draftId: string, bucket: string): string {
  return `draft-${draftId}-${bucket}`;
}

function AttributedBucket({
  draftId,
  bucket,
  heading,
  attribution,
  items,
}: {
  draftId: string;
  bucket: string;
  heading: string;
  attribution: Attribution;
  items: string[];
}) {
  if (items.length === 0) return null;

  return (
    <section aria-labelledby={bucketLabelId(draftId, bucket)}>
      <div className="flex flex-wrap items-center gap-2">
        <h4
          id={bucketLabelId(draftId, bucket)}
          className="text-sm font-semibold text-[var(--color-ink)]"
        >
          {heading}
        </h4>
        <AttributionLabel attribution={attribution} />
      </div>
      <ul className="mt-1 flex flex-col gap-1">
        {items.map((item) => (
          <li key={item} dir="auto" className="break-words text-base text-[var(--color-ink)]">
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DecisionForm({ patientId, draft }: { patientId: string; draft: ReviewDraft }) {
  const [state, formAction, pending] = useActionState(
    reviewDraftDecisionAction.bind(null, patientId, draft.id),
    {},
  );
  const confirmationRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (state.confirmed) confirmationRef.current?.focus();
  }, [state.confirmed]);

  if (state.confirmed) {
    return (
      <p
        ref={confirmationRef}
        role="status"
        tabIndex={-1}
        className="rounded-[var(--radius-md)] border border-[var(--color-success-700)] bg-[var(--color-success-50)] p-4 text-sm text-[var(--color-ink)]"
      >
        Decision recorded. The patient record has been updated.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="expectedVersion" value={draft.version} />

      {draft.proposed_corrections.length > 0 && (
        <fieldset className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
          <legend className="px-1 text-sm font-semibold text-[var(--color-ink)]">
            Corrections to apply
          </legend>
          <ul className="flex flex-col gap-2">
            {draft.proposed_corrections.map((correction) => (
              <li key={correction.correctionId}>
                <label
                  htmlFor={`correction-${correction.correctionId}`}
                  aria-label={correction.proposedText}
                  className="flex min-h-11 cursor-pointer items-start gap-2"
                >
                  <input
                    type="checkbox"
                    id={`correction-${correction.correctionId}`}
                    name="correctionId"
                    value={correction.correctionId}
                    className="mt-1 size-4 shrink-0"
                  />
                  <span className="min-w-0">
                    <span className="block break-words text-base text-[var(--color-ink)]">
                      {correction.proposedText}
                    </span>
                    <span className="mt-1 block break-words text-sm text-[var(--color-ink-muted)]">
                      {correction.rationale}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}

      <p className="text-sm text-[var(--color-ink-muted)]">
        A rejection records your decision and applies no correction. The draft stays in the record
        either way.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="decision" value="confirm" variant="primary" disabled={pending}>
          <Check aria-hidden="true" size={16} />
          {pending ? 'Recording…' : 'Confirm draft'}
        </Button>
        <Button type="submit" name="decision" value="reject" variant="secondary" disabled={pending}>
          <X aria-hidden="true" size={16} />
          Reject draft
        </Button>
      </div>

      {state.error !== undefined && (
        <p role="alert" className="text-sm text-[var(--color-danger-700)]">
          {state.error}
        </p>
      )}
    </form>
  );
}

function DraftCard({
  patientId,
  draft,
  timeZone,
}: {
  patientId: string;
  draft: ReviewDraft;
  timeZone: string;
}) {
  const titleId = `draft-${draft.id}-title`;

  return (
    <li>
      <article
        aria-labelledby={titleId}
        className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]"
      >
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-subtle)] p-4">
          <div className="min-w-0">
            <h3
              id={titleId}
              className="text-base font-semibold tabular-nums text-[var(--color-ink)]"
            >
              {draft.local_date}
            </h3>
            <UtcAndLocalTime utc={draft.created_at} timeZone={timeZone} />
          </div>
          <Badge variant="outline">Version {draft.version}</Badge>
        </header>

        <div className="flex flex-col gap-4 p-4">
          <p
            dir="auto"
            className="whitespace-pre-wrap break-words text-base text-[var(--color-ink)]"
          >
            {draft.draft_text}
          </p>

          <AttributedBucket
            draftId={draft.id}
            bucket="statements"
            heading="From the patient"
            attribution="patient_statement"
            items={draft.patient_statements.map((statement) => statement.text)}
          />
          <AttributedBucket
            draftId={draft.id}
            bucket="facts"
            heading="Doctor-confirmed fact identifiers"
            attribution="doctor_confirmed"
            items={draft.confirmed_facts}
          />
          <AttributedBucket
            draftId={draft.id}
            bucket="inferences"
            heading="Drawn by the model"
            attribution="model_inference"
            items={draft.model_inferences}
          />

          {draft.uncertainties.length > 0 && (
            <section aria-labelledby={bucketLabelId(draft.id, 'uncertainties')}>
              <h4
                id={bucketLabelId(draft.id, 'uncertainties')}
                className="text-sm font-semibold text-[var(--color-ink)]"
              >
                Still unclear
              </h4>
              <ul className="mt-1 flex flex-wrap gap-1">
                {draft.uncertainties.map((note) => (
                  <li key={note}>
                    <UncertaintyLabel note={note} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {draft.evidence_references.length > 0 && (
            <section aria-labelledby={bucketLabelId(draft.id, 'evidence')}>
              <h4
                id={bucketLabelId(draft.id, 'evidence')}
                className="text-sm font-semibold text-[var(--color-ink)]"
              >
                Cited evidence
              </h4>
              <ul className="mt-1 flex flex-wrap gap-1">
                {draft.evidence_references.map((reference) => (
                  <li
                    key={reference}
                    className="break-all font-[family-name:var(--font-mono)] text-sm text-[var(--color-ink-muted)]"
                  >
                    {reference}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!draft.is_latest ? (
            <p
              role="alert"
              className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-canvas-raised)] p-4 text-sm text-[var(--color-ink)]"
            >
              This draft was replaced by a newer version. Reload the page to review the current one
              — a decision on this version would be refused.
            </p>
          ) : draft.latest_action !== null ? (
            <p className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-canvas-raised)] p-4 text-sm text-[var(--color-ink)]">
              {draft.latest_action.decision === 'confirm'
                ? 'You confirmed this draft.'
                : 'You rejected this draft.'}{' '}
              Recorded <UtcAndLocalTime utc={draft.latest_action.created_at} timeZone={timeZone} />.
            </p>
          ) : (
            <DecisionForm patientId={patientId} draft={draft} />
          )}
        </div>
      </article>
    </li>
  );
}

export function DraftReview({
  patientId,
  drafts,
  timeZone,
}: {
  patientId: string;
  drafts: ReviewDraft[];
  timeZone: string;
}) {
  const ordered = [...drafts].sort(
    (left, right) => Date.parse(right.created_at) - Date.parse(left.created_at),
  );

  return (
    <Card
      role="region"
      aria-labelledby="draft-review-title"
      className="min-w-0 overflow-hidden p-0"
    >
      <CardHeader className="p-6">
        <div className="flex items-start gap-2">
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-canvas-raised)]">
            <ClipboardCheck aria-hidden="true" size={18} />
          </span>
          <div className="min-w-0">
            <CardTitle id="draft-review-title">Drafts to review</CardTitle>
            <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
              Agent-written summaries waiting on you. Nothing here changes your record until you
              confirm it.
            </p>
          </div>
        </div>
      </CardHeader>

      <CardContent className="border-t border-[var(--color-border-subtle)] p-6">
        {ordered.length === 0 ? (
          <EmptyState
            icon={<ClipboardCheck size={24} />}
            title="No drafts to review"
            description="A review draft appears here after the agent writes up a day of conversation."
          />
        ) : (
          <ol className="flex flex-col gap-4">
            {ordered.map((draft) => (
              <DraftCard key={draft.id} patientId={patientId} draft={draft} timeZone={timeZone} />
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
