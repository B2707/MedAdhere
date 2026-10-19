/**
 * fda-disclaimer.ts — the verbatim openFDA disclaimer (U-27, DRUG-04).
 *
 * DRUG-04's label-context panel (06-04) and any surface that shows openFDA-derived
 * label data MUST display this disclaimer word-for-word. Reproduced exactly from the
 * official source (see FDA_DISCLAIMER_SOURCE); never paraphrase, trim, or reword it —
 * that is the whole point of pinning it as a single cited constant.
 *
 * Exported via the `@medadhere/shared` index and consumed by W3's 06-04 drug-label panel.
 */

/**
 * The openFDA disclaimer, verbatim. Declared as a single string literal with
 * `as const` so its TYPE is the exact literal — a downstream reader (or the test)
 * cannot silently substitute a widened/paraphrased string. Kept on one line
 * deliberately: concatenation would widen the type back to `string`.
 */
export const FDA_LABEL_DISCLAIMER =
  'Do not rely on openFDA to make decisions regarding medical care. Always speak to your health provider about the risks and benefits of FDA-regulated products.' as const;

/** Source attribution for the disclaimer above. */
export const FDA_DISCLAIMER_SOURCE = 'https://open.fda.gov/apis/drug/label/' as const;

/** Date the pinned text above was verified against the official source. */
export const FDA_DISCLAIMER_RETRIEVED_DATE = '2026-07-29' as const;
