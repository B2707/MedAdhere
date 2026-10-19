'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  patientDetailsInputSchema,
  patientDetailsResponseSchema,
  patientReactivationInputSchema,
  patientReactivationResponseSchema,
  reminderLimitInputSchema,
  reminderLimitResponseSchema,
} from '../../../../../packages/shared/src/clinical-review';
import { ID_TOKEN_COOKIE } from '@/lib/auth';
import { dataApiUrl } from '@/lib/cognito';

interface DeactivateState {
  error?: string;
}

export interface ReminderLimitState {
  error?: string;
  conflict?: boolean;
  reminderLimit?: number;
}

export interface ReactivationState {
  error?: string;
  conflict?: boolean;
}

/** The submitted values are echoed back so a rejected edit does not lose the doctor's typing. */
export interface PatientDetailsState {
  error?: string;
  conflict?: boolean;
  displayName?: string;
  phoneNumber?: string;
}

const patientIdSchema = z.string().uuid();
const GENERIC_FAILURE = "Couldn't pause monitoring. Please refresh and try again.";
const REMINDER_FAILURE = "Couldn't update the reminder limit. Please refresh and try again.";
const REMINDER_VALIDATION_FAILURE = 'Choose a reminder limit from 0 to 5.';
const REMINDER_CONFLICT =
  'This messaging setting changed while you were editing it. Reload the page, then choose the reminder limit again.';
const REACTIVATION_FAILURE = "Couldn't reactivate messaging. Please refresh and try again.";
const REACTIVATION_CONFLICT =
  'This messaging state changed while you were viewing it. Reload the page before reactivating.';
const DETAILS_FAILURE = "Couldn't save these details. Please refresh and try again.";
const DETAILS_UNCHANGED = 'Nothing to save — these details are unchanged.';
const DETAILS_PHONE_INVALID =
  'Enter the phone number in international format, for example +15145550123.';
const DETAILS_NAME_TOO_LONG = 'Use a display name of 80 characters or fewer.';
const DETAILS_PHONE_TAKEN = 'That phone number is already in use by another patient.';
const DETAILS_CONFLICT =
  'These details changed while you were editing them. Reload the page, then edit again.';

/** A form text field, trimmed; blank reads as "left alone" rather than as an empty value. */
function textField(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function revalidatePatientPaths(patientId: string): void {
  revalidatePath('/patients');
  revalidatePath(`/patients/${patientId}`);
}

export async function deactivatePatientAction(
  patientId: string,
  _previousState: DeactivateState,
  _formData: FormData,
): Promise<DeactivateState> {
  void _previousState;
  void _formData;
  const parsedId = patientIdSchema.safeParse(patientId);
  if (!parsedId.success) return { error: GENERIC_FAILURE };

  const idToken = (await cookies()).get(ID_TOKEN_COOKIE)?.value;
  if (!idToken) redirect('/api/auth/login');

  let response: Response;
  try {
    response = await fetch(
      `${dataApiUrl()}/api/patients/${encodeURIComponent(parsedId.data)}/deactivate`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}` },
        cache: 'no-store',
      },
    );
  } catch {
    return { error: GENERIC_FAILURE };
  }

  if (!response.ok) return { error: GENERIC_FAILURE };

  revalidatePatientPaths(parsedId.data);
  redirect(`/patients/${parsedId.data}`);
}

export async function setReminderLimitAction(
  patientId: string,
  _previousState: ReminderLimitState,
  formData: FormData,
): Promise<ReminderLimitState> {
  void _previousState;
  const parsedId = patientIdSchema.safeParse(patientId);
  const reminderValue = formData.get('reminderLimit');
  const expectedVersionValue = formData.get('expectedVersion');
  const reminderLimit =
    typeof reminderValue === 'string' && reminderValue.trim() !== ''
      ? Number(reminderValue)
      : Number.NaN;
  const input = reminderLimitInputSchema.safeParse({
    reminderLimit,
    expectedVersion:
      typeof expectedVersionValue === 'string' && expectedVersionValue.trim() !== ''
        ? Number(expectedVersionValue)
        : Number.NaN,
  });
  if (!parsedId.success || !input.success) {
    return {
      error: REMINDER_VALIDATION_FAILURE,
      ...(Number.isInteger(reminderLimit) && reminderLimit >= 0 && reminderLimit <= 5
        ? { reminderLimit }
        : {}),
    };
  }

  const idToken = (await cookies()).get(ID_TOKEN_COOKIE)?.value;
  if (!idToken) redirect('/api/auth/login');

  let response: Response;
  try {
    response = await fetch(
      `${dataApiUrl()}/api/patients/${encodeURIComponent(parsedId.data)}/reminder-limit`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input.data),
        cache: 'no-store',
      },
    );
  } catch {
    return { error: REMINDER_FAILURE, reminderLimit: input.data.reminderLimit };
  }

  if (response.status === 401) redirect('/api/auth/login');
  if (response.status === 409) {
    return {
      conflict: true,
      error: REMINDER_CONFLICT,
      reminderLimit: input.data.reminderLimit,
    };
  }
  if (!response.ok) return { error: REMINDER_FAILURE, reminderLimit: input.data.reminderLimit };

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    return { error: REMINDER_FAILURE, reminderLimit: input.data.reminderLimit };
  }
  if (!reminderLimitResponseSchema.safeParse(responseBody).success) {
    return { error: REMINDER_FAILURE, reminderLimit: input.data.reminderLimit };
  }

  revalidatePatientPaths(parsedId.data);
  redirect(`/patients/${parsedId.data}`);
}

export async function reactivatePatientAction(
  patientId: string,
  _previousState: ReactivationState,
  formData: FormData,
): Promise<ReactivationState> {
  void _previousState;
  const parsedId = patientIdSchema.safeParse(patientId);
  const expectedVersionValue = formData.get('expectedVersion');
  const input = patientReactivationInputSchema.safeParse({
    expectedVersion:
      typeof expectedVersionValue === 'string' && expectedVersionValue.trim() !== ''
        ? Number(expectedVersionValue)
        : Number.NaN,
  });
  if (!parsedId.success || !input.success) return { error: REACTIVATION_FAILURE };

  const idToken = (await cookies()).get(ID_TOKEN_COOKIE)?.value;
  if (!idToken) redirect('/api/auth/login');

  let response: Response;
  try {
    response = await fetch(
      `${dataApiUrl()}/api/patients/${encodeURIComponent(parsedId.data)}/reactivate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input.data),
        cache: 'no-store',
      },
    );
  } catch {
    return { error: REACTIVATION_FAILURE };
  }

  if (response.status === 401) redirect('/api/auth/login');
  if (response.status === 409) return { conflict: true, error: REACTIVATION_CONFLICT };
  if (!response.ok) return { error: REACTIVATION_FAILURE };

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    return { error: REACTIVATION_FAILURE };
  }
  if (!patientReactivationResponseSchema.safeParse(responseBody).success) {
    return { error: REACTIVATION_FAILURE };
  }

  revalidatePatientPaths(parsedId.data);
  redirect(`/patients/${parsedId.data}`);
}

/**
 * Doctor-owned correction of a patient's display name and phone number (people change both).
 *
 * The form carries the values currently on the record, so this action posts only the fields the
 * doctor actually changed — an untouched or resubmitted form never reaches the API and never burns
 * a messaging version. Blank means "leave this one alone", so one field can change without
 * restating the other. Rejected edits echo the typed values back so the doctor's typing survives.
 */
export async function updatePatientDetailsAction(
  patientId: string,
  _previousState: PatientDetailsState,
  formData: FormData,
): Promise<PatientDetailsState> {
  void _previousState;
  const displayName = textField(formData, 'displayName');
  const phoneNumber = textField(formData, 'phoneNumber');
  const echo = { displayName, phoneNumber };

  const parsedId = patientIdSchema.safeParse(patientId);
  if (!parsedId.success) return { error: DETAILS_FAILURE, ...echo };

  const changes: { displayName?: string; phoneNumber?: string } = {};
  if (displayName !== undefined && displayName !== textField(formData, 'currentDisplayName')) {
    changes.displayName = displayName;
  }
  if (phoneNumber !== undefined && phoneNumber !== textField(formData, 'currentPhoneNumber')) {
    changes.phoneNumber = phoneNumber;
  }
  if (changes.displayName === undefined && changes.phoneNumber === undefined) {
    return { error: DETAILS_UNCHANGED };
  }

  const expectedVersionValue = formData.get('expectedVersion');
  const input = patientDetailsInputSchema.safeParse({
    expectedVersion:
      typeof expectedVersionValue === 'string' && expectedVersionValue.trim() !== ''
        ? Number(expectedVersionValue)
        : Number.NaN,
    ...changes,
  });
  if (!input.success) {
    const fields = new Set(input.error.issues.map((issue) => issue.path[0]));
    return {
      error: fields.has('phoneNumber')
        ? DETAILS_PHONE_INVALID
        : fields.has('displayName')
          ? DETAILS_NAME_TOO_LONG
          : DETAILS_FAILURE,
      ...echo,
    };
  }

  const idToken = (await cookies()).get(ID_TOKEN_COOKIE)?.value;
  if (!idToken) redirect('/api/auth/login');

  let response: Response;
  try {
    response = await fetch(
      `${dataApiUrl()}/api/patients/${encodeURIComponent(parsedId.data)}/details`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input.data),
        cache: 'no-store',
      },
    );
  } catch {
    return { error: DETAILS_FAILURE, ...echo };
  }

  if (response.status === 401) redirect('/api/auth/login');
  if (response.status === 409) {
    // Two very different 409s: a phone already held by another patient is the doctor's to fix here,
    // a stale version means the record moved and must be reloaded before editing again.
    let conflictBody: unknown;
    try {
      conflictBody = await response.json();
    } catch {
      conflictBody = undefined;
    }
    const conflictError =
      typeof conflictBody === 'object' && conflictBody !== null && 'error' in conflictBody
        ? String((conflictBody as { error: unknown }).error)
        : '';
    return {
      conflict: true,
      error: conflictError.includes('phone') ? DETAILS_PHONE_TAKEN : DETAILS_CONFLICT,
      ...echo,
    };
  }
  if (!response.ok) return { error: DETAILS_FAILURE, ...echo };

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    return { error: DETAILS_FAILURE, ...echo };
  }
  if (!patientDetailsResponseSchema.safeParse(responseBody).success) {
    return { error: DETAILS_FAILURE, ...echo };
  }

  revalidatePatientPaths(parsedId.data);
  redirect(`/patients/${parsedId.data}`);
}
