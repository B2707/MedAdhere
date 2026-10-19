/**
 * ade-hint.ts — the shared associative ADE (adverse-event) hint builder.
 *
 * When a patient-reported symptom term matches a term listed on the drug label, the
 * dashboard surfaces a HINT. MedFlow discipline (ported): the hint is strictly
 * ASSOCIATIVE — it states that the reported term co-occurs with a label-listed
 * adverse event, and explicitly disclaims causation/diagnosis. It must be
 * deterministic (derived only from the evidence passed in) and must NEVER contain a
 * causal verb (causes/caused/due to/resulted in/leads to/induced).
 *
 * Shared so W3's 06-04 (drug-label panel, `info`) and 06-05 (review queues,
 * `elevated`) both consume ONE builder rather than each re-authoring the wording.
 */
import { z } from 'zod';

/**
 * Prominence of the label match:
 *  - `info`     — the term appears in the label's adverse-reactions/warnings.
 *  - `elevated` — the term appears with boxed-warning / elevated prominence.
 */
export const adeHintInputSchema = z
  .object({
    /** The verbatim patient-reply fragment stored by label_match. */
    matched_phrase: z.string().min(1),
    /** The mapped MedDRA preferred term stored by label_match. */
    meddra_pt: z.string().min(1),
    /** The database CHECK contract from schema.sql. */
    hint_level: z.enum(['info', 'elevated']),
  })
  .strict();

export type AdeHintInput = z.infer<typeof adeHintInputSchema>;
export type AdeHintLevel = AdeHintInput['hint_level'];

/** Prominence clause per level — deterministic, no causal verbs. */
const PROMINENCE: Record<AdeHintLevel, string> = {
  info: 'listed as an adverse reaction in OnSIDES-extracted FDA labeling for this ingredient',
  elevated: "listed in the FDA label's boxed warning or warnings-and-precautions section",
};

/**
 * Build the associative hint string for a label match. Pure + deterministic: the
 * same input always yields the same output, and the output never asserts causation.
 */
export function buildAdeHint({ matched_phrase, meddra_pt, hint_level }: AdeHintInput): string {
  const prominence = PROMINENCE[hint_level];
  return (
    `Patient-reported phrase "${matched_phrase}" matches an adverse event ${prominence} ` +
    `("${meddra_pt}"); ` +
    'associative only, not a causal or diagnostic finding. Consider reviewing.'
  );
}
