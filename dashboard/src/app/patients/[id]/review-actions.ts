'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  reviewDecisionInputSchema,
  reviewDecisionResponseSchema,
} from '../../../../../packages/shared/src/clinical-review';
import { ID_TOKEN_COOKIE } from '@/lib/auth';
import { dataApiUrl } from '@/lib/cognito';

/*
 * review-actions.ts — the doctor's decision on one clinician review draft.
 *
 * The body is built and validated here against the FROZEN `reviewDecisionInputSchema` from
 * `@medadhere/shared`, the same schema the API validates on arrival, so a body the server
 * would reject never leaves the browser. Nothing identifies the clinician or the patient in
 * the body: the server derives the clinician from the verified Cognito subject and the
 * patient from the path (AUTH2-01 / SEC2-02).
 *
 * A rejection cannot carry corrections — applying a fact revision is exactly what "confirm"
 * means — so the reject path drops the checked boxes before validating rather than letting
 * the schema's refinement turn a stray checkbox into an unexplained failure.
 *
 * A 409 is NOT a generic failure: it means another version of this draft was written while
 * the doctor was reading, and the server refused to apply stale content. It gets its own
 * state so the UI can say "reload" instead of inviting a retry that would fail identically.
 */

export interface ReviewDecisionState {
  error?: string;
  conflict?: boolean;
  confirmed?: boolean;
}

const idSchema = z.string().uuid();
const GENERIC_FAILURE = "Couldn't record your decision. Please refresh and try again.";
const STALE_FAILURE =
  'This draft was updated while you were reading it. Reload the page to review the current version.';

export async function reviewDraftDecisionAction(
  patientId: string,
  draftId: string,
  _previousState: ReviewDecisionState,
  formData: FormData,
): Promise<ReviewDecisionState> {
  void _previousState;
  const parsedPatientId = idSchema.safeParse(patientId);
  const parsedDraftId = idSchema.safeParse(draftId);
  if (!parsedPatientId.success || !parsedDraftId.success) return { error: GENERIC_FAILURE };

  const decision = formData.get('decision');
  const selected =
    decision === 'reject' ? [] : formData.getAll('correctionId').map((value) => String(value));
  const input = reviewDecisionInputSchema.safeParse({
    decision,
    expectedVersion: Number(formData.get('expectedVersion')),
    selectedCorrectionIds: selected,
  });
  if (!input.success) return { error: GENERIC_FAILURE };

  const idToken = (await cookies()).get(ID_TOKEN_COOKIE)?.value;
  if (!idToken) redirect('/api/auth/login');

  let response: Response;
  try {
    response = await fetch(
      `${dataApiUrl()}/api/patients/${encodeURIComponent(parsedPatientId.data)}/drafts/${encodeURIComponent(parsedDraftId.data)}/decision`,
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
    // Network failure / data API unreachable — calm error, no internals.
    return { error: GENERIC_FAILURE };
  }

  if (response.status === 409) return { conflict: true, error: STALE_FAILURE };
  if (!response.ok) return { error: GENERIC_FAILURE };

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    return { error: GENERIC_FAILURE };
  }
  const result = reviewDecisionResponseSchema.safeParse(responseBody);
  if (!result.success || result.data.decision !== input.data.decision) {
    return { error: GENERIC_FAILURE };
  }

  revalidatePath(`/patients/${parsedPatientId.data}`);
  return { confirmed: true };
}
