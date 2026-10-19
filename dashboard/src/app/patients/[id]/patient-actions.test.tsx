// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { actionState } = vi.hoisted(() => ({
  actionState: {
    value: {} as {
      error?: string;
      conflict?: boolean;
      reminderLimit?: number;
      displayName?: string;
      phoneNumber?: string;
    },
    pending: false,
  },
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useActionState: () => [actionState.value, vi.fn(), actionState.pending],
  };
});

vi.mock('./actions', () => ({
  deactivatePatientAction: vi.fn(),
  reactivatePatientAction: vi.fn(),
  setReminderLimitAction: vi.fn(),
  updatePatientDetailsAction: vi.fn(),
}));

import { PatientActions } from './patient-actions';

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    patientId: 'patient-1',
    isActive: true,
    agentEnabled: true,
    providerOptedIn: true,
    messagingStateVersion: 7,
    reminderLimit: 2,
    displayName: 'Alice',
    phone: '+15145550111',
    ...overrides,
  };
}

/** Every deactivate/reminder/edit-details control moved into the Manage-patient sheet (R4/F5). */
function openSheet() {
  fireEvent.click(screen.getByRole('button', { name: /manage patient/i }));
}

describe('PatientActions', () => {
  beforeEach(() => {
    actionState.value = {};
    actionState.pending = false;
    vi.restoreAllMocks();
  });

  it('keeps administration off the header row until "Manage patient" is opened', () => {
    render(<PatientActions {...baseProps()} />);

    expect(screen.getByRole('button', { name: /manage patient/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /deactivate patient/i })).toBeNull();
    expect(screen.queryByRole('spinbutton', { name: /reminders per check-in/i })).toBeNull();
  });

  it('opens the sheet as a real dialog and exposes deactivate inside it', () => {
    render(<PatientActions {...baseProps()} />);
    openSheet();

    expect(screen.getByRole('dialog', { name: /manage patient/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /deactivate patient/i })).toHaveClass(
      'bg-[var(--color-danger-700)]',
    );
  });

  it('shows the deactivated state inside the sheet without inventing another action', () => {
    render(
      <PatientActions
        {...baseProps({ isActive: false, agentEnabled: false, providerOptedIn: false })}
      />,
    );
    openSheet();

    expect(screen.getByRole('button', { name: /patient deactivated/i })).toBeDisabled();
  });

  it('replaces window.confirm with an in-page consequence panel before deactivating', () => {
    const confirm = vi.spyOn(window, 'confirm');
    render(<PatientActions {...baseProps()} />);
    openSheet();

    fireEvent.click(screen.getByRole('button', { name: /deactivate patient/i }));

    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      /cannot be resumed.*cancel all pending schedules/i,
    );
    expect(screen.getByRole('button', { name: /^deactivate$/i })).toBeInTheDocument();
  });

  it('cancels the deactivate confirmation without submitting', () => {
    render(<PatientActions {...baseProps()} />);
    openSheet();
    fireEvent.click(screen.getByRole('button', { name: /deactivate patient/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('button', { name: /deactivate patient/i })).toBeInTheDocument();
  });

  it('offers reactivation as the primary header action only after patient START restored consent', () => {
    const { rerender } = render(
      <PatientActions {...baseProps({ agentEnabled: false, providerOptedIn: false })} />,
    );
    expect(screen.queryByRole('button', { name: /reactivate messaging/i })).toBeNull();

    rerender(
      <PatientActions
        {...baseProps({ agentEnabled: false, providerOptedIn: true, messagingStateVersion: 8 })}
      />,
    );
    const reactivate = screen.getByRole('button', { name: /reactivate messaging/i });
    expect(reactivate).toBeEnabled();
    // Available without opening the sheet — it is the "one primary action" (§4.1).
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('confirms reactivation in place instead of window.confirm', () => {
    const confirm = vi.spyOn(window, 'confirm');
    render(<PatientActions {...baseProps({ agentEnabled: false })} />);
    fireEvent.click(screen.getByRole('button', { name: /reactivate messaging/i }));

    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      /future check-ins will be scheduled/i,
    );
  });

  it('announces action errors and exposes the pending state inside the sheet', () => {
    actionState.value = { error: 'Unable to deactivate patient.', reminderLimit: 5 };
    actionState.pending = true;
    render(<PatientActions {...baseProps()} />);
    openSheet();

    expect(screen.getByRole('button', { name: /deactivating/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: /reminders per check-in/i })).toHaveValue(5);
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to deactivate patient.');
  });

  it('renders a bounded reminder-limit control with optimistic version input', () => {
    render(<PatientActions {...baseProps()} />);
    openSheet();

    const input = screen.getByRole('spinbutton', { name: /reminders per check-in/i });
    expect(input).toHaveAttribute('min', '0');
    expect(input).toHaveAttribute('max', '5');
    expect(input).toHaveValue(2);
    expect(screen.getAllByDisplayValue('7')).not.toHaveLength(0);
  });

  function renderWithDetailsOpen(displayName: string | null = 'Alice') {
    const utils = render(<PatientActions {...baseProps({ displayName })} />);
    openSheet();
    return utils;
  }

  it('keeps the contact-detail editor closed until the doctor asks for it', () => {
    renderWithDetailsOpen();

    expect(screen.queryByRole('textbox', { name: /display name/i })).toBeNull();
    expect(screen.getByRole('button', { name: /edit details/i })).toBeEnabled();
  });

  it('prefills the editor with the current details and the version being edited', () => {
    renderWithDetailsOpen();
    fireEvent.click(screen.getByRole('button', { name: /edit details/i }));

    expect(screen.getByRole('textbox', { name: /display name/i })).toHaveValue('Alice');
    expect(screen.getByRole('textbox', { name: /phone number/i })).toHaveValue('+15145550111');
    const form = screen.getByRole('textbox', { name: /display name/i }).closest('form')!;
    const hidden = (name: string) =>
      form.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value;
    expect(hidden('currentDisplayName')).toBe('Alice');
    expect(hidden('currentPhoneNumber')).toBe('+15145550111');
    expect(hidden('expectedVersion')).toBe('7');
  });

  it('leaves the display name blank when the patient has none', () => {
    renderWithDetailsOpen(null);
    fireEvent.click(screen.getByRole('button', { name: /edit details/i }));

    expect(screen.getByRole('textbox', { name: /display name/i })).toHaveValue('');
  });

  it('closes the editor again when the doctor cancels', () => {
    renderWithDetailsOpen();
    fireEvent.click(screen.getByRole('button', { name: /edit details/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.queryByRole('textbox', { name: /display name/i })).toBeNull();
  });

  it('keeps a rejected edit open with the doctor typing intact and the reason announced', () => {
    actionState.value = {
      error: 'That phone number is already in use by another patient.',
      conflict: true,
      displayName: 'Alice B',
      phoneNumber: '+15145550999',
    };
    renderWithDetailsOpen();

    expect(screen.getByRole('textbox', { name: /display name/i })).toHaveValue('Alice B');
    expect(screen.getByRole('textbox', { name: /phone number/i })).toHaveValue('+15145550999');
    expect(screen.getByRole('alert')).toHaveTextContent(/already in use by another patient/i);
  });

  it('closes the sheet on Escape and returns focus to the trigger', () => {
    render(<PatientActions {...baseProps()} />);
    const trigger = screen.getByRole('button', { name: /manage patient/i });
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes the sheet on a scrim click', () => {
    render(<PatientActions {...baseProps()} />);
    openSheet();
    fireEvent.click(screen.getByTestId('manage-patient-scrim'));

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
