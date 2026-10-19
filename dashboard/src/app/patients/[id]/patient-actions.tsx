'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { BellRing, PencilLine, RotateCcw, Settings2, UserX, X } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';
import {
  deactivatePatientAction,
  reactivatePatientAction,
  setReminderLimitAction,
  updatePatientDetailsAction,
} from './actions';

/*
 * patient-actions.tsx — patient administration, moved OFF the page-title row (R4/F5,
 * DESIGN-SPEC.md §4.1). A single contextual primary action (Reactivate messaging, only
 * when eligible) sits next to a "Manage patient" trigger that opens a right-side sheet
 * (`--elev-3`) holding everything else: the reminder-limit form, the contact-detail
 * editor, and deactivation.
 *
 * F4: `window.confirm()` is gone. Deactivate/Reactivate expand into an in-page
 * confirmation that names the consequence in the product's own voice, styled with the
 * design system, and never blocks the main thread. No manual "close the confirm" reset
 * is needed on submit — a successful action changes `isActive`/`agentEnabled` via a
 * fresh server render, which naturally swaps which branch renders.
 */

const inputClass =
  'min-h-11 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] ' +
  'bg-[var(--color-surface)] px-3 text-[var(--text-input)] text-[var(--color-ink)] ' +
  'placeholder:text-[var(--color-ink-muted)] disabled:cursor-not-allowed disabled:opacity-50';
const labelClass = 'flex flex-col gap-1 text-left text-sm font-semibold text-[var(--color-ink)]';

interface PatientActionsProps {
  patientId: string;
  isActive: boolean;
  agentEnabled: boolean;
  providerOptedIn: boolean;
  messagingStateVersion: number;
  reminderLimit: number;
  displayName: string | null;
  phone: string;
}

/** Every element inside the sheet that Tab should be able to reach (mirrors mobile-nav.tsx). */
function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled])',
    ),
  );
}

/**
 * The F4 replacement for `window.confirm()` — states the consequence, never blocks.
 * tradeoff: renders inline in place of the trigger button rather than a floating,
 * position-anchored popover — same `--elev-3` treatment and adjacency, less machinery.
 * Upgrade to a positioned popover if a reviewer finds the inline swap disorienting.
 */
function ConfirmInline({
  message,
  confirmLabel,
  pendingLabel,
  pending,
  variant,
  onCancel,
}: {
  message: string;
  confirmLabel: string;
  pendingLabel: string;
  pending: boolean;
  variant: ButtonProps['variant'];
  onCancel: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-label="Confirm action"
      className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[var(--elev-3)]"
    >
      <p className="text-sm text-[var(--color-ink)]">{message}</p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" variant={variant} size="sm" disabled={pending}>
          {pending ? pendingLabel : confirmLabel}
        </Button>
      </div>
    </div>
  );
}

export function PatientActions({
  patientId,
  isActive,
  agentEnabled,
  providerOptedIn,
  messagingStateVersion,
  reminderLimit,
  displayName,
  phone,
}: PatientActionsProps) {
  const [deactivateState, deactivateFormAction, deactivatePending] = useActionState(
    deactivatePatientAction.bind(null, patientId),
    {},
  );
  const [reminderState, reminderFormAction, reminderPending] = useActionState(
    setReminderLimitAction.bind(null, patientId),
    {},
  );
  const [reactivationState, reactivateFormAction, reactivatePending] = useActionState(
    reactivatePatientAction.bind(null, patientId),
    {},
  );
  const [detailsState, detailsFormAction, detailsPending] = useActionState(
    updatePatientDetailsAction.bind(null, patientId),
    {},
  );

  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingDetails, setEditingDetails] = useState<boolean | null>(null);
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false);
  const [confirmingReactivate, setConfirmingReactivate] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const pending = deactivatePending || reminderPending || reactivatePending || detailsPending;
  const error =
    detailsState.error ?? reminderState.error ?? reactivationState.error ?? deactivateState.error;
  const canReactivate = isActive && providerOptedIn && !agentEnabled;
  // A submission already in flight is functionally "confirmed" — never ask the doctor to
  // re-confirm something that is already happening, and never hide its pending state behind
  // a click the render never got to render as unconfirmed in the first place.
  const showDeactivateConfirm = confirmingDeactivate || deactivatePending;
  const showReactivateConfirm = confirmingReactivate || reactivatePending;
  // A rejected edit stays open so the doctor can fix it in place instead of retyping from scratch,
  // until they explicitly open or cancel it themselves.
  const detailsOpen = editingDetails ?? detailsState.error !== undefined;

  const closeSheet = () => {
    setSheetOpen(false);
    triggerRef.current?.focus();
  };

  // Focus trap + initial focus + background scroll lock, only while open (mirrors mobile-nav.tsx).
  useEffect(() => {
    if (!sheetOpen) return;
    const sheet = sheetRef.current;
    if (sheet === null) return;

    focusableElements(sheet)[0]?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSheet();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusableElements(sheet);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeydown);
    return () => {
      document.removeEventListener('keydown', handleKeydown);
      document.body.style.overflow = previousOverflow;
    };
  }, [sheetOpen]);

  return (
    <div className="flex items-center gap-2">
      {canReactivate &&
        (showReactivateConfirm ? (
          <form action={reactivateFormAction}>
            <input type="hidden" name="expectedVersion" value={messagingStateVersion} />
            <ConfirmInline
              message="Reactivate messaging for this patient? Future check-ins will be scheduled again."
              confirmLabel="Reactivate"
              pendingLabel="Reactivating…"
              pending={reactivatePending}
              variant="primary"
              onCancel={() => setConfirmingReactivate(false)}
            />
          </form>
        ) : (
          <Button
            type="button"
            variant="primary"
            onClick={() => setConfirmingReactivate(true)}
            disabled={pending}
          >
            <RotateCcw aria-hidden="true" size={16} />
            Reactivate messaging
          </Button>
        ))}

      <Button
        ref={triggerRef}
        type="button"
        variant="secondary"
        onClick={() => setSheetOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={sheetOpen}
        aria-controls="manage-patient-sheet"
      >
        <Settings2 aria-hidden="true" size={16} />
        Manage patient
      </Button>

      {sheetOpen && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <div
            data-testid="manage-patient-scrim"
            aria-hidden="true"
            onClick={closeSheet}
            className="absolute inset-0 bg-[color-mix(in_srgb,var(--color-ink)_50%,transparent)]"
          />
          <div
            ref={sheetRef}
            id="manage-patient-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="manage-patient-title"
            className="enter-rise relative z-10 flex h-dvh w-full max-w-sm flex-col gap-6 overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--elev-3)] sm:p-6"
          >
            <div className="flex items-center justify-between">
              <h2
                id="manage-patient-title"
                className="text-lg font-semibold text-[var(--color-ink)]"
              >
                Manage patient
              </h2>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={closeSheet}
                aria-label="Close manage patient"
              >
                <X aria-hidden="true" size={18} />
              </Button>
            </div>

            <form action={reminderFormAction} className="flex flex-col gap-2">
              <input type="hidden" name="expectedVersion" value={messagingStateVersion} />
              <label className={labelClass}>
                Reminders per check-in
                <input
                  type="number"
                  name="reminderLimit"
                  min={0}
                  max={5}
                  step={1}
                  required
                  defaultValue={reminderState.reminderLimit ?? reminderLimit}
                  disabled={!isActive || pending}
                  className={inputClass}
                />
              </label>
              <Button
                type="submit"
                variant="secondary"
                disabled={!isActive || pending}
                className="self-start"
              >
                <BellRing aria-hidden="true" size={16} />
                {reminderPending ? 'Saving…' : 'Save reminders'}
              </Button>
            </form>

            <div className="flex flex-col gap-3 border-t border-[var(--color-border-subtle)] pt-4">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setEditingDetails(!detailsOpen)}
                aria-expanded={detailsOpen}
                aria-controls="patient-details-editor"
                disabled={pending}
                className="self-start"
              >
                <PencilLine aria-hidden="true" size={16} />
                Edit details
              </Button>

              {detailsOpen && (
                <form
                  id="patient-details-editor"
                  action={detailsFormAction}
                  className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
                >
                  <input type="hidden" name="expectedVersion" value={messagingStateVersion} />
                  <input type="hidden" name="currentDisplayName" value={displayName ?? ''} />
                  <input type="hidden" name="currentPhoneNumber" value={phone} />
                  <label className={labelClass}>
                    Display name
                    <input
                      type="text"
                      name="displayName"
                      maxLength={80}
                      autoComplete="name"
                      defaultValue={detailsState.displayName ?? displayName ?? ''}
                      disabled={pending}
                      className={inputClass}
                    />
                  </label>
                  <label className={labelClass}>
                    Phone number
                    <input
                      type="tel"
                      name="phoneNumber"
                      inputMode="tel"
                      autoComplete="tel"
                      placeholder="+15145550123"
                      defaultValue={detailsState.phoneNumber ?? phone}
                      disabled={pending}
                      className={inputClass}
                    />
                  </label>
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setEditingDetails(false)}
                      disabled={pending}
                    >
                      Cancel
                    </Button>
                    <Button type="submit" variant="primary" disabled={pending}>
                      {detailsPending ? 'Updating…' : 'Save details'}
                    </Button>
                  </div>
                </form>
              )}
            </div>

            {isActive && !providerOptedIn && (
              <p className="text-sm text-[var(--color-ink-muted)]">
                Messaging is stopped. Reactivation stays unavailable while waiting for the patient
                to text START.
              </p>
            )}
            {canReactivate && (
              <p className="text-sm text-[var(--color-ink-muted)]">
                Patient START is recorded. Doctor reactivation is required before check-ins resume.
              </p>
            )}

            <div className="mt-auto flex flex-col gap-3 border-t border-[var(--color-border-subtle)] pt-4">
              {isActive ? (
                showDeactivateConfirm ? (
                  <form action={deactivateFormAction}>
                    <ConfirmInline
                      message="Deactivate this patient? Monitoring cannot be resumed here, and this will cancel all pending schedules."
                      confirmLabel="Deactivate"
                      pendingLabel="Deactivating…"
                      pending={deactivatePending}
                      variant="destructive"
                      onCancel={() => setConfirmingDeactivate(false)}
                    />
                  </form>
                ) : (
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => setConfirmingDeactivate(true)}
                    disabled={pending}
                    className="self-start"
                  >
                    <UserX aria-hidden="true" size={16} />
                    Deactivate patient
                  </Button>
                )
              ) : (
                <Button type="button" variant="secondary" disabled className="self-start">
                  <UserX aria-hidden="true" size={16} />
                  Patient deactivated
                </Button>
              )}

              {error && (
                <p role="alert" className="text-sm text-[var(--color-danger-700)]">
                  {error}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
