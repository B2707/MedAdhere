'use server';

/*
 * /patients/new enrollment server action (DASH-05 / D3 / L4 / D14).
 *
 * The browser-facing half of the write path. Next 15 enforces same-origin Origin/Host on server actions
 * automatically, and the auth cookies are httpOnly + SameSite=lax — but this action ALSO:
 *   (1) re-checks auth IN THE ACTION (reads the id_token cookie; redirects to login if absent — the
 *       API-GW Cognito JWT authorizer is the REAL boundary, this is defence-in-depth + a UX redirect);
 *   (2) shape-validates the FormData itself with zod (generic errors, retaining only non-sensitive fields);
 *   (3) POSTs to the data-API /api/patients route with the Bearer id_token (server-to-server, D-10);
 *   (4) on 201 revalidatePath('/patients') BEFORE redirect('/patients') so the force-dynamic list reflects
 *       the new row immediately (also the committed-but-504 remedy — the list is the source of truth);
 *   (5) on any failure returns a generic error state (useActionState-compatible) — the 409 surfaces a
 *       generic "already enrolled" message; nothing leaks internal detail.
 *
 * D14 — enrollment through this research dashboard is test-only. The server action enforces is_test=true
 * regardless of crafted FormData, and the enroll API validates the boundary again.
 */

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { ID_TOKEN_COOKIE } from '@/lib/auth';
import { dataApiUrl } from '@/lib/cognito';

/**
 * Every form field the action can attach a per-field error to (F3). A 'use server' file may
 * only export async functions — this is a TYPE (erased at compile time, not a runtime export)
 * so it is safe to share with the client form; the client derives its own field order from
 * `Object.keys()` on its own label map rather than importing a value from here.
 */
export type EnrollFieldKey =
  | 'phone'
  | 'medication_name'
  | 'display_name'
  | 'timezone'
  | 'days'
  | 'localTimes';

/** The action's return shape (useActionState-compatible). Not exported (Next 'use server' allows only async fn exports). */
interface EnrollFormState {
  error?: string;
  fieldErrors?: Partial<Record<EnrollFieldKey, string>>;
  values?: {
    medication_name: string;
    display_name: string;
    timezone: string;
    days: string;
    localTimes: string[];
  };
}

/** E.164 phone. */
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;
/** Patient-local wall-clock dose time 'HH:mm'. */
const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
/**
 * Bounds mirrored from the enroll-api core. The zone check deliberately uses Intl here while the
 * backend uses its server-side date library: the dashboard must stay zero-dependency.
 */
const MAX_LOCAL_TIMES = 4;
const MAX_ENROLL_DAYS = 14;

function isValidIanaZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Generic messages — deliberately value-free (never echo submitted data in copy). */
const GENERIC_INVALID = 'Please check the form and try again.';
const GENERIC_FAILURE = "Couldn't enroll the patient. Please try again.";
const DUPLICATE_MESSAGE =
  'A patient with this phone may already be enrolled — check the patient list.';

/**
 * F3 — every field can carry its own error now, not just timezone. Messages stay generic and
 * value-free (never echo what was submitted) so they are safe to show verbatim.
 */
const FIELD_MESSAGES: Record<EnrollFieldKey, string> = {
  phone: 'Enter a valid phone number in E.164 format, e.g. +15145550123.',
  medication_name: 'Enter a medication name (1–120 characters).',
  display_name: 'Display name must be 80 characters or fewer.',
  timezone: 'Unrecognized timezone.',
  days: 'Enter a number of days between 1 and 14.',
  localTimes: 'Enter each dose time in 24-hour HH:mm format.',
};

/** The form field schema (D3 — the action's own validation; the enroll-api validates again as the boundary). */
const enrollFormSchema = z.object({
  phone: z.string().regex(E164_PATTERN),
  medication_name: z.string().min(1).max(120),
  display_name: z.string().min(1).max(80).optional(),
  timezone: z.string().min(1).max(64).refine(isValidIanaZone).optional(),
  days: z.coerce.number().int().min(1).max(MAX_ENROLL_DAYS),
  localTimes: z.array(z.string().regex(HHMM_PATTERN)).min(1).max(MAX_LOCAL_TIMES),
});

/** Coerce a FormData entry to a trimmed string ('' for File/null). */
function field(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function enrollAction(
  _prevState: EnrollFormState,
  formData: FormData,
): Promise<EnrollFormState> {
  // (1) re-check auth in the action — no session token ⇒ redirect to login (the real gate is API-GW JWT).
  const idToken = (await cookies()).get(ID_TOKEN_COOKIE)?.value;
  if (!idToken) {
    redirect('/api/auth/login');
  }

  // (2) shape-validate the FormData ourselves (generic errors only — never echo the submitted values).
  const localTimes = formData
    .getAll('localTimes')
    .map(field)
    .filter((t) => t !== '');
  const displayName = field(formData.get('display_name'));
  const timezone = field(formData.get('timezone'));
  const medicationName = field(formData.get('medication_name'));
  const days = field(formData.get('days'));
  const values = {
    medication_name: medicationName,
    display_name: displayName,
    timezone,
    days,
    localTimes,
  };
  const parsed = enrollFormSchema.safeParse({
    phone: field(formData.get('phone')),
    medication_name: medicationName,
    display_name: displayName || undefined,
    timezone: timezone || undefined,
    days,
    localTimes,
  });
  if (!parsed.success) {
    const fieldErrors: EnrollFormState['fieldErrors'] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && key in FIELD_MESSAGES && !(key in fieldErrors)) {
        fieldErrors[key as EnrollFieldKey] = FIELD_MESSAGES[key as EnrollFieldKey];
      }
    }
    return {
      error: GENERIC_INVALID,
      values,
      ...(Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
    };
  }
  // (3) POST to the data-API with the Bearer id_token (server-to-server, D-10).
  let res: Response;
  try {
    res = await fetch(`${dataApiUrl()}/api/patients`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ ...parsed.data, is_test: true }),
      cache: 'no-store',
    });
  } catch {
    // Network failure / data-API unreachable — generic, no internals.
    return { error: GENERIC_FAILURE, values };
  }

  // (4) map the response. Success revalidates BEFORE redirecting (both OUTSIDE any try/catch so the
  // redirect's control-flow throw is never swallowed).
  if (res.status === 201) {
    revalidatePath('/patients');
    redirect('/patients');
  }
  // (5) failures surface as a generic state. The 409 dup message is a fixed, value-free string.
  if (res.status === 409) {
    return { error: DUPLICATE_MESSAGE, values };
  }
  return { error: GENERIC_FAILURE, values };
}
