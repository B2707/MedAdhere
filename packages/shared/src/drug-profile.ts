/**
 * drug-profile.ts — the shared `drug_profile_json` contract (H6, 04-06 pre-exec).
 *
 * DRUG-01 (scripts/freeze-drug-profiles.ts) freezes a patient's resolved drug label
 * context into `patient.drug_profile_json` at enrollment. The 04-06 ADE matcher reads
 * the FROZEN rxcui from there. This module is the single shared definition of that shape
 * + a safe extractor so 04-06 and DRUG-01 can never disagree on it (previously the type
 * was script-local, so a shape drift would make the matcher silently abstain forever).
 *
 * 04-07 BLOCKING REQUIREMENT (post-exec review, review MEDIUM): the frozen `rxcui` MUST be
 * an INGREDIENT-level RxNorm concept (TTY=IN). The OnSIDES asset is keyed by ingredient
 * RxCUIs, so a product/clinical-drug rxcui here yields ZERO matches (the matcher abstains
 * `no_label_data` forever, silently). DRUG-01 must normalize its RxNorm resolution to
 * TTY=IN before storing, with a product/clinical-drug→ingredient test. This extractor
 * cannot enforce that (it has no RxNorm access); it is a 04-07 gate, tracked in the plan.
 */
import { z } from 'zod';

/** Resolved profile — label features enabled; the rxcui is a real RxNorm ingredient id. */
export interface ResolvedDrugProfile {
  readonly label_features_enabled: true;
  readonly rxcui: string;
}

/** Warn-and-disable profile — RxNorm resolution failed at freeze time; features off. */
export interface UnresolvedDrugProfile {
  readonly label_features_enabled: false;
  readonly rxcui: string | null;
}

export type DrugProfile = ResolvedDrugProfile | UnresolvedDrugProfile;

// Narrow schema: we only need the two fields that gate a live match. Extra fields on the
// stored jsonb (boxed_warning, dpd, source, …) are ignored — this is a read contract, not
// the freeze writer's schema.
const resolvedSchema = z.object({
  label_features_enabled: z.literal(true),
  rxcui: z.string().trim().min(1),
});

/**
 * The frozen RxNorm ingredient rxcui for a patient, or `null` to abstain.
 *
 * Returns the rxcui ONLY when the stored profile is resolved AND label features are
 * enabled AND the rxcui is a non-blank string. Everything else — null/undefined column
 * (DRUG-01 not run, the common case today), an unresolved/disabled profile, a blank or
 * missing rxcui, or any malformed value — yields `null`. Never throws: the input is an
 * untrusted jsonb value from the DB.
 */
export function rxcuiFromDrugProfile(raw: unknown): string | null {
  const parsed = resolvedSchema.safeParse(raw);
  return parsed.success ? parsed.data.rxcui.trim() : null;
}

// ---------------------------------------------------------------------------------------------------
// WRITER-SIDE contract (04-07 D2, review MEDIUM item J) — the FULL `drug_profile_json` shape that
// DRUG-01 (scripts/freeze-drug-profiles.ts) freezes. Importing `ResolvedDrugProfile` alone did NOT
// stop writer/reader drift on the new provenance fields (the narrow read schema above ignores extras),
// so the freeze writer conforms to THIS discriminated union instead. The narrow READ contract
// (`resolvedSchema` + `rxcuiFromDrugProfile`) is deliberately UNCHANGED — the matcher still only needs
// `rxcui` — but the writer is now pinned end-to-end.
//
// Key invariant (the 04-06 BLOCKING fix): on a resolved profile `rxcui` is the INGREDIENT (RxNorm
// TTY=IN) concept — the OnSIDES/D1 key — while `resolved_from_rxcui` is the raw approximateTerm rank-1
// candidate (the OpenFDA lookup key). Product/clinical-drug candidates are NEVER stored as `rxcui`; a
// candidate that resolves to zero ingredients degrades to `reason: 'unresolved_ingredient'` (never a
// product rxcui the matcher would abstain on forever).

const dpdSchema = z.object({
  din: z.string().nullable(),
  atc: z.string().nullable(),
});

/** Closed stored-provenance literals used to distinguish checked vs missing FDA labels. */
export const DRUG_PROFILE_SOURCE = {
  FDA_LABEL: 'US FDA label (openFDA)',
  INGREDIENT_ONLY: 'RxNorm ingredient (OnSIDES-matchable; no OpenFDA label)',
} as const;

/** C-9: a closed source enum, never an unrestricted stored string. */
export const drugProfileSourceSchema = z.enum([
  DRUG_PROFILE_SOURCE.FDA_LABEL,
  DRUG_PROFILE_SOURCE.INGREDIENT_ONLY,
]);

/** Resolved writer profile — label features enabled; the FULL provenance the freeze script persists. */
export const resolvedDrugProfileWriteSchema = z.object({
  label_features_enabled: z.literal(true),
  // Ingredient (RxNorm TTY=IN) rxcui — the OnSIDES matching key + the D1 term-block key.
  rxcui: z.string().trim().min(1),
  // The raw approximateTerm rank-1 candidate this profile resolved from — the OpenFDA lookup key.
  resolved_from_rxcui: z.string().trim().min(1),
  // True when the candidate resolved to >1 ingredient; the primary (ingredient_rxcuis[0]) is stored.
  multi_ingredient: z.boolean(),
  // The FULL ingredient (TTY=IN) list; ingredient_rxcuis[0] === rxcui (the primary/matched ingredient).
  ingredient_rxcuis: z.array(z.string().trim().min(1)).min(1),
  boxed_warning_present: z.boolean(),
  boxed_warning: z.array(z.unknown()).nullable(),
  warnings_and_cautions: z.array(z.unknown()).nullable(),
  adverse_reactions: z.array(z.unknown()).nullable(),
  dpd: dpdSchema,
  source: drugProfileSourceSchema,
  // Documented limitation text when multi_ingredient (OnSIDES is single-ingredient-keyed); null otherwise.
  multi_ingredient_limitation: z.string().nullable(),
});

/** Warn-and-disable writer profile — RxNorm/ingredient/label resolution failed at freeze time. */
export const unresolvedDrugProfileWriteSchema = z.object({
  label_features_enabled: z.literal(false),
  // 'unresolved' = no candidate / no label; 'unresolved_ingredient' = candidate had no TTY=IN ingredient.
  reason: z.enum(['unresolved', 'unresolved_ingredient']),
  // Always null in practice (never store a product rxcui the matcher would abstain on forever).
  rxcui: z.string().nullable(),
  // The candidate that could not be normalized to an ingredient (provenance for the hand-review), or null.
  resolved_from_rxcui: z.string().nullable(),
});

/** The writer-side `drug_profile_json` union the freeze script conforms to (H6 / item J). */
export const drugProfileWriteSchema = z.discriminatedUnion('label_features_enabled', [
  resolvedDrugProfileWriteSchema,
  unresolvedDrugProfileWriteSchema,
]);

export type ResolvedDrugProfileWrite = z.infer<typeof resolvedDrugProfileWriteSchema>;
export type UnresolvedDrugProfileWrite = z.infer<typeof unresolvedDrugProfileWriteSchema>;
export type DrugProfileWrite = z.infer<typeof drugProfileWriteSchema>;

// Dashboard read contract (C-9). The offline freeze writer keeps its tolerant
// unknown-array input contract above. Each display collection degrades independently:
// null, missing, or a malformed member becomes an empty array without collapsing the
// valid profile metadata and provenance around it.
const normalizedStringArraySchema = z
  .array(z.string())
  .nullable()
  .transform((values) => values ?? [])
  .catch([]);

export const resolvedDrugProfileSchema = resolvedDrugProfileWriteSchema.extend({
  boxed_warning: normalizedStringArraySchema,
  warnings_and_cautions: normalizedStringArraySchema,
  adverse_reactions: normalizedStringArraySchema,
  source: drugProfileSourceSchema,
});

/** Full dashboard parser, preserving the resolved/unresolved discriminant. */
export const drugProfileSchema = z.discriminatedUnion('label_features_enabled', [
  resolvedDrugProfileSchema,
  unresolvedDrugProfileWriteSchema,
]);

export type DrugProfileSource = z.infer<typeof drugProfileSourceSchema>;
export type DrugProfileData = z.infer<typeof drugProfileSchema>;
