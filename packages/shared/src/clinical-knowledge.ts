import { z } from 'zod';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[a-f0-9]{64}$/;

const isoDateSchema = z
  .string()
  .regex(ISO_DATE)
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year!, month! - 1, day!));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() + 1 === month &&
      parsed.getUTCDate() === day
    );
  }, 'expected a real YYYY-MM-DD date');

const medicationIdentitySchema = z
  .object({
    system: z.enum(['ccdd', 'din', 'rxnorm', 'local']),
    code: z.string().trim().min(1).max(64),
  })
  .strict();

const medicationIngredientInputSchema = z
  .object({
    name: z.string().trim().min(1).max(320),
    ccddIngredientCode: z.string().trim().min(1).max(64).nullable(),
    rxcui: z.string().trim().min(1).max(32).nullable(),
  })
  .strict();

export const medicationRevisionInputSchema = z
  .object({
    enteredName: z.string().trim().min(1).max(320),
    identity: medicationIdentitySchema.nullable(),
    doseText: z.string().trim().min(1).max(160).nullable(),
    form: z.string().trim().min(1).max(80).nullable(),
    route: z.string().trim().min(1).max(80).nullable(),
    validFrom: isoDateSchema,
    validTo: isoDateSchema.nullable(),
    status: z.enum(['active', 'stopped', 'corrected']),
    supersedesId: z.string().uuid().nullable(),
    scheduleIds: z
      .array(z.string().uuid())
      .max(512)
      .refine((ids) => new Set(ids).size === ids.length, 'schedule IDs must be unique'),
    ingredients: z.array(medicationIngredientInputSchema).min(1).max(32),
  })
  .strict()
  .refine((value) => value.validTo === null || value.validTo >= value.validFrom, {
    message: 'validTo must not precede validFrom',
    path: ['validTo'],
  });

export const clinicalFactRevisionInputSchema = z
  .object({
    factType: z.enum(['condition', 'allergy', 'note']),
    factCode: z.string().trim().min(1).max(128).nullable(),
    statementText: z.string().trim().min(1).max(1000),
    status: z.enum(['current', 'corrected', 'retracted']),
    supersedesId: z.string().uuid().nullable(),
  })
  .strict();

const interactionKindSchema = z.enum([
  'drug_drug',
  'drug_food',
  'drug_disease',
  'therapeutic_duplication',
]);

const interactionCoverageReasonSchema = z.enum([
  'interaction_kind_unavailable',
  'no_active_complete_release',
  'incomplete_release',
  'stale_release',
  'withdrawn_release',
  'missing_mapping',
  'ambiguous_mapping',
  'unmapped_ingredient',
  'insufficient_distinct_ingredients',
]);

const interactionPairSchema = z
  .object({
    lowDrugId: z.string().trim().min(1).max(64),
    highDrugId: z.string().trim().min(1).max(64),
  })
  .strict()
  .refine((pair) => pair.lowDrugId < pair.highDrugId, {
    message: 'interaction pair must be in canonical order',
  });

const sourceReleaseReferenceSchema = z
  .object({
    id: z.string().uuid(),
    version: z.string().trim().min(1).max(128),
    checksumSha256: z.string().regex(SHA256),
  })
  .strict();

export const interactionCoverageResultSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('interaction_found'),
      interactionKind: z.literal('drug_drug'),
      pair: interactionPairSchema,
      release: sourceReleaseReferenceSchema,
      level: z.enum(['contraindicated', 'major', 'moderate', 'minor', 'unknown']),
    })
    .strict(),
  z
    .object({
      state: z.literal('checked_no_interaction_record'),
      interactionKind: z.literal('drug_drug'),
      pair: interactionPairSchema,
      release: sourceReleaseReferenceSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal('coverage_unknown'),
      interactionKind: interactionKindSchema,
      reason: interactionCoverageReasonSchema,
      pair: interactionPairSchema.nullable(),
      release: sourceReleaseReferenceSchema.nullable(),
    })
    .strict(),
]);

const interactionDisplayNameSchema = z.string().trim().min(1).max(320);

export const conversationDrugInteractionSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('interaction_found'),
      source: z.literal('ddinter'),
      displayNames: z.tuple([interactionDisplayNameSchema, interactionDisplayNameSchema]),
      pair: interactionPairSchema,
      level: z.enum(['contraindicated', 'major', 'moderate', 'minor', 'unknown']),
      release: sourceReleaseReferenceSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal('coverage_unknown'),
      source: z.literal('ddinter'),
      displayNames: z.array(interactionDisplayNameSchema).max(2),
      reason: interactionCoverageReasonSchema,
      release: sourceReleaseReferenceSchema.nullable(),
    })
    .strict(),
]);

export type MedicationRevisionInput = z.infer<typeof medicationRevisionInputSchema>;
export type ClinicalFactRevisionInput = z.infer<typeof clinicalFactRevisionInputSchema>;
export type InteractionCoverageResult = z.infer<typeof interactionCoverageResultSchema>;
export type ConversationDrugInteraction = z.infer<typeof conversationDrugInteractionSchema>;
