import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Canonical adherence classification schema — the SINGLE SOURCE OF TRUTH for the
 * two-axis ({@link adherence_state} + {@link reason_code}) plus {@link safety_flag}
 * 4-value-enum contract (REQUIREMENTS PIPE-04 / 04-AI-SPEC §3).
 *
 * Consumed downstream by:
 *  - Plan 02 schema.sql (the three classifier enums must encode these exact members)
 *  - Plan 03 in-VPC anthropic-smoke Lambda (imports this schema as the forced-tool `input_schema`)
 *  - Phase 4 classifier (reuses this schema verbatim)
 *
 * `safety_flag` is a 4-value enum (none | acute_physical | crisis | medical_question),
 * NOT a boolean — encoding it as a boolean is a blocking anti-pattern.
 */
export const AdherenceClassification = z
  .object({
    adherence_state: z.enum(['taken', 'delayed', 'skipped', 'stopped', 'question', 'unknown']),
    reason_code: z.enum(['none', 'side_effect', 'ran_out', 'forgot', 'other']),
    safety_flag: z.enum(['none', 'acute_physical', 'crisis', 'medical_question']),
  })
  // IN-02 — `.strict()` makes `.parse()` THROW on any unexpected key rather than silently dropping it.
  // The whole point of the D-16 gate is to FAIL LOUD when the classifier's output drifts from the
  // contract; a model emitting an extra field (e.g. a stray `confidence` or a camelCase `safetyFlag`
  // alongside the snake_case one) is exactly the kind of drift that must surface, not be masked. This
  // does NOT change the contract: the field set and the three enums are byte-for-byte identical — it
  // only tightens the rejection of UNKNOWN fields.
  .strict();

/** Inferred TypeScript type for a parsed adherence classification. */
export type AdherenceClassification = z.infer<typeof AdherenceClassification>;

/**
 * Self-contained JSON Schema for the classification, used as the Anthropic Messages API forced-tool
 * `tools[].input_schema` (D-ANTHROPIC; 04-AI-SPEC §3 / RESEARCH Pattern 3). `$refStrategy: 'none'`
 * inlines every definition so the API receives a single self-contained object with no
 * `$ref`/`definitions`.
 */
export const adherenceClassificationJsonSchema = zodToJsonSchema(AdherenceClassification, {
  target: 'jsonSchema7',
  $refStrategy: 'none',
});
