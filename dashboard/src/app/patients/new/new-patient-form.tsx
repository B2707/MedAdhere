'use client';

/*
 * NewPatientForm — the /patients/new enrollment form (DASH-05 / D3). A minimal client component (native
 * inputs + shadcn Button/Card idiom, semantic tokens, NO new UI primitives) wired to the enroll server
 * action via useActionState so the action's generic error state renders inline (React 19 / Next 15).
 *
 * The action owns auth re-check + validation + the POST; this component only collects the fields:
 * phone, medication_name, optional display_name/timezone, bounded day horizon, and one-or-more dose
 * times (localTimes). The server action always records enrollment as a test participant.
 *
 * Clinical Swiss (DESIGN-SPEC.md §5 Lane F):
 *   F1 — every dose-time input gets a real visible <label>, not just an aria-label.
 *   F2 — `--text-input` (16px) is now the global base-layer default for input/select/textarea
 *        (globals.css), so this file no longer needs to opt in per field.
 *   F3 — every field can show ITS OWN error (aria-invalid + aria-describedby + message below the
 *        field), an error summary with anchor links sits at the top, and the first invalid field
 *        gets focus after a failed submit.
 *   F6 — the five ad hoc spacing picks (`gap-7`, mismatched `pt-5`/`pt-6`) collapse onto the
 *        rhythm tiers (§1.4): `gap-8`/`pt-8` for section-level dividers.
 *   F7 — `rounded-md` (now a real 10px token) replaces the one-off error-box radius.
 */

import { useActionState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { enrollAction, type EnrollFieldKey } from './actions';

const inputClass =
  'min-h-11 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] ' +
  'bg-[var(--color-surface)] px-3 py-2 text-[var(--color-ink)] ' +
  'placeholder:text-[var(--color-ink-muted)] aria-[invalid=true]:border-[var(--color-danger-700)]';
const labelClass = 'flex flex-col gap-1.5 text-sm font-semibold text-[var(--color-ink)]';

/** Field label text, shared by the per-field error message and the top error summary's anchors.
 *  Object key insertion order IS the canonical field order used below (phone first, then the
 *  rest in form-visual order) — there is no separate order array to keep in sync. */
const FIELD_LABELS: Record<EnrollFieldKey, string> = {
  phone: 'Phone',
  medication_name: 'Medication',
  display_name: 'Display name',
  timezone: 'Timezone',
  days: 'Days to schedule',
  localTimes: 'Dose times',
};
const FIELD_ORDER = Object.keys(FIELD_LABELS) as EnrollFieldKey[];

/** The element each field's error should move focus to — dose times share one fieldset, so
 *  `localTimes` focuses the first dose-time input rather than a non-existent shared id. */
const FIELD_FOCUS_ID: Record<EnrollFieldKey, string> = {
  ...Object.fromEntries(FIELD_ORDER.map((key) => [key, key])),
  localTimes: 'dose-time-1',
} as Record<EnrollFieldKey, string>;

/** The message + aria-invalid/aria-describedby wiring one erroring field needs, in one place. */
function FieldError({ id, message }: { id: string; message?: string }) {
  if (message === undefined) return null;
  return (
    <span id={id} className="font-normal text-[var(--color-danger-700)]">
      {message}
    </span>
  );
}

export function NewPatientForm() {
  const [state, formAction, pending] = useActionState(enrollAction, {});
  const summaryRef = useRef<HTMLDivElement>(null);
  const errorFields = FIELD_ORDER.filter((key) => state.fieldErrors?.[key] !== undefined);

  // F3 — move focus to the first invalid field after a failed submit; if the failure has no
  // field to blame (e.g. a 409 duplicate), focus the summary itself so the message is announced.
  useEffect(() => {
    if (errorFields.length > 0) {
      document.getElementById(FIELD_FOCUS_ID[errorFields[0]!])?.focus();
    } else if (state.error !== undefined) {
      summaryRef.current?.focus();
    }
    // Only re-run when the action produces a NEW result, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={formAction} className="flex flex-col gap-8">
      {state.error && (
        <div
          ref={summaryRef}
          role="alert"
          tabIndex={-1}
          className="rounded-[var(--radius-md)] border border-[var(--color-danger-700)] bg-[var(--color-danger-50)] px-4 py-3 text-[var(--color-danger-700)]"
        >
          <p>{state.error}</p>
          {errorFields.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1 text-sm">
              {errorFields.map((key) => (
                <li key={key}>
                  <a href={`#${FIELD_FOCUS_ID[key]}`} className="underline underline-offset-2">
                    {FIELD_LABELS[key]}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <section aria-labelledby="patient-details-title" className="space-y-4">
        <div>
          <h2
            id="patient-details-title"
            className="text-lg font-semibold tracking-heading text-[var(--color-ink)]"
          >
            Patient details
          </h2>
          <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
            Use the participant&apos;s research contact details.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label htmlFor="display_name" className={labelClass}>
            Display name (optional)
            <input
              id="display_name"
              name="display_name"
              type="text"
              autoComplete="name"
              defaultValue={state.values?.display_name}
              aria-invalid={state.fieldErrors?.display_name ? true : undefined}
              aria-describedby={state.fieldErrors?.display_name ? 'display_name-error' : undefined}
              className={inputClass}
            />
            <FieldError id="display_name-error" message={state.fieldErrors?.display_name} />
          </label>

          <label htmlFor="phone" className={labelClass}>
            Phone (E.164)
            <input
              id="phone"
              name="phone"
              type="tel"
              required
              inputMode="tel"
              autoComplete="tel"
              placeholder="+15145550123"
              aria-invalid={state.fieldErrors?.phone ? true : undefined}
              aria-describedby={state.fieldErrors?.phone ? 'phone-error' : undefined}
              className={inputClass}
            />
            <FieldError id="phone-error" message={state.fieldErrors?.phone} />
          </label>

          <label htmlFor="medication_name" className={`${labelClass} sm:col-span-2`}>
            Medication
            <input
              id="medication_name"
              name="medication_name"
              type="text"
              required
              autoComplete="off"
              placeholder="Metformin"
              defaultValue={state.values?.medication_name}
              aria-invalid={state.fieldErrors?.medication_name ? true : undefined}
              aria-describedby={
                state.fieldErrors?.medication_name ? 'medication_name-error' : undefined
              }
              className={inputClass}
            />
            <FieldError id="medication_name-error" message={state.fieldErrors?.medication_name} />
          </label>
        </div>
      </section>

      <section
        aria-labelledby="schedule-title"
        className="space-y-4 border-t border-[var(--color-border-subtle)] pt-8"
      >
        <div>
          <h2
            id="schedule-title"
            className="text-lg font-semibold tracking-heading text-[var(--color-ink)]"
          >
            Check-in schedule
          </h2>
          <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
            Times are interpreted in the participant&apos;s local timezone.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label htmlFor="timezone" className={labelClass}>
            Timezone (IANA)
            <input
              id="timezone"
              name="timezone"
              type="text"
              autoComplete="off"
              defaultValue={state.values ? state.values.timezone : 'America/Toronto'}
              aria-invalid={state.fieldErrors?.timezone ? true : undefined}
              aria-describedby={state.fieldErrors?.timezone ? 'timezone-error' : undefined}
              className={inputClass}
            />
            <FieldError id="timezone-error" message={state.fieldErrors?.timezone} />
          </label>

          <label htmlFor="days" className={labelClass}>
            Days to schedule
            <input
              id="days"
              name="days"
              type="number"
              min={1}
              max={14}
              required
              defaultValue={state.values ? state.values.days : 3}
              aria-invalid={state.fieldErrors?.days ? true : undefined}
              aria-describedby={state.fieldErrors?.days ? 'days-error' : undefined}
              className={inputClass}
            />
            <FieldError id="days-error" message={state.fieldErrors?.days} />
          </label>
        </div>

        <fieldset>
          <legend className="mb-1.5 text-sm font-semibold text-[var(--color-ink)]">
            Dose times (local)
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <label htmlFor="dose-time-1" className={labelClass}>
              Dose 1
              <input
                id="dose-time-1"
                aria-label="First dose time"
                name="localTimes"
                type="time"
                required
                defaultValue={state.values ? (state.values.localTimes[0] ?? '') : '09:00'}
                aria-invalid={state.fieldErrors?.localTimes ? true : undefined}
                aria-describedby={state.fieldErrors?.localTimes ? 'dose-time-error' : undefined}
                className={inputClass}
              />
            </label>
            <label htmlFor="dose-time-2" className={labelClass}>
              Dose 2 (optional)
              <input
                id="dose-time-2"
                aria-label="Second dose time (optional)"
                name="localTimes"
                type="time"
                defaultValue={state.values?.localTimes[1]}
                className={inputClass}
              />
            </label>
          </div>
          <FieldError id="dose-time-error" message={state.fieldErrors?.localTimes} />
        </fieldset>
      </section>

      <section className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-canvas-raised)] p-4">
        <div className="flex items-start gap-3">
          <Info
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-[var(--color-accent)]"
            size={18}
          />
          <div>
            <p className="font-semibold text-[var(--color-ink)]">Research cohort only</p>
            <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
              This dashboard is for designated test participants and does not replace clinical care.
            </p>
            <p className="mt-3 font-semibold text-[var(--color-ink)]">
              Every enrollment is stored as a test participant.
            </p>
          </div>
        </div>
      </section>

      <div className="flex flex-col-reverse gap-3 border-t border-[var(--color-border-subtle)] pt-8 sm:flex-row sm:justify-end">
        <Link
          href="/patients"
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 text-sm font-semibold text-[var(--color-ink)] hover:bg-[var(--color-surface-hover)]"
        >
          Cancel
        </Link>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Enrolling…' : 'Enroll patient'}
        </Button>
      </div>
    </form>
  );
}
