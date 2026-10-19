import { z } from 'zod';

const MAX_INT4 = 2_147_483_647;
const MAX_SELECTED_CORRECTIONS = 30;
const expectedVersionSchema = z.number().int().positive().max(MAX_INT4);
const correctionIdsSchema = z
  .array(z.string().uuid())
  .max(MAX_SELECTED_CORRECTIONS)
  .refine((ids) => new Set(ids).size === ids.length, 'correction IDs must be unique');

export const reviewDecisionInputSchema = z
  .object({
    decision: z.enum(['confirm', 'reject']),
    expectedVersion: expectedVersionSchema,
    selectedCorrectionIds: correctionIdsSchema,
  })
  .strict()
  .refine((input) => input.decision === 'confirm' || input.selectedCorrectionIds.length === 0, {
    path: ['selectedCorrectionIds'],
    message: 'A rejection cannot apply corrections',
  });

export const reviewDecisionResponseSchema = z
  .object({
    decision: z.enum(['confirm', 'reject']),
    applied: z.boolean(),
    actionId: z.string().uuid(),
    createdFactIds: correctionIdsSchema,
  })
  .strict()
  .refine((response) => response.decision === 'confirm' || response.createdFactIds.length === 0, {
    path: ['createdFactIds'],
    message: 'A rejection cannot create facts',
  });

export const reminderLimitInputSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    reminderLimit: z.number().int().min(0).max(5),
  })
  .strict();

export const reminderLimitResponseSchema = z
  .object({
    reminderLimit: z.number().int().min(0).max(5),
    messagingStateVersion: expectedVersionSchema,
  })
  .strict();

export const patientReactivationInputSchema = z
  .object({ expectedVersion: expectedVersionSchema })
  .strict();

export const patientReactivationResponseSchema = z
  .object({
    reactivated: z.literal(true),
    agentEnabled: z.boolean(),
    isActive: z.boolean(),
    messagingStateVersion: expectedVersionSchema,
  })
  .strict();

/** E.164 — the SAME anchored pattern the enrollment write path validates against (U-15). */
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

/**
 * Doctor-owned correction of the patient's contact details (people change numbers and names).
 * Both fields are optional so a doctor can change one without restating the other, but an empty
 * body is rejected — there is nothing to write. Bounds mirror the enrollment contract exactly.
 */
export const patientDetailsInputSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    displayName: z.string().min(1).max(80).optional(),
    phoneNumber: z.string().regex(E164_PATTERN).optional(),
  })
  .strict()
  .refine((input) => input.displayName !== undefined || input.phoneNumber !== undefined, {
    message: 'Provide a display name or a phone number to change',
  });

/** `changed:false` is the graceful unchanged-resubmit outcome, not a failure. */
export const patientDetailsResponseSchema = z
  .object({
    displayName: z.string().min(1).max(80).nullable(),
    phoneNumber: z.string().regex(E164_PATTERN),
    messagingStateVersion: expectedVersionSchema,
    changed: z.boolean(),
  })
  .strict();

export type ReviewDecisionInput = z.infer<typeof reviewDecisionInputSchema>;
export type ReviewDecisionResponse = z.infer<typeof reviewDecisionResponseSchema>;
export type ReminderLimitInput = z.infer<typeof reminderLimitInputSchema>;
export type ReminderLimitResponse = z.infer<typeof reminderLimitResponseSchema>;
export type PatientReactivationInput = z.infer<typeof patientReactivationInputSchema>;
export type PatientReactivationResponse = z.infer<typeof patientReactivationResponseSchema>;
export type PatientDetailsInput = z.infer<typeof patientDetailsInputSchema>;
export type PatientDetailsResponse = z.infer<typeof patientDetailsResponseSchema>;
