/**
 * coverage-artifact.ts — the D2→D1 OnSIDES coverage handoff contract (review HIGH, Plan 04-07).
 *
 * The DRUG-01 freeze script (scripts/freeze-drug-profiles.ts) is the WRITER: after it resolves the
 * cohort's ingredient (TTY=IN) rxcuis and checks OnSIDES coverage, it persists THIS machine-readable
 * artifact. The `--ablation` eval (backend/eval/run-eval.ts) is the READER: it builds arm B's term
 * block ONLY from the coverage-passed cohort ingredients here — never from `Object.keys(
 * loadOnsidesIndex().labels)` (the 15-ingredient REPRESENTATIVE vendored asset, which is NOT the
 * cohort). A shared zod schema so writer and reader can never drift; an artifact version + an
 * OnSIDES-source-version stamp so a STALE artifact is REFUSED, not silently consumed.
 *
 * Disposition model (review HIGH): a resolved cohort ingredient with no OnSIDES label data is a HARD
 * failure UNLESS the operator supplies an explicit reviewed override (`reviewedOverride:true`), in
 * which case the uncovered ingredients are recorded as deliberate `no_onsides_label_data` EXCLUSIONS
 * and the D1 block is built from the covered set only.
 *
 * DATA-01: ingredient rxcuis + coverage booleans + version/timestamp ONLY — NO patient ids, NO reply
 * text, NO PHI.
 */
import { z } from 'zod';

/** Bump when the artifact shape changes — a mismatch makes an older artifact STALE (refused). */
export const COVERAGE_ARTIFACT_VERSION = 1;

/** Basename the freeze writer + eval reader agree on (repo-relative under backend/eval/). */
export const COVERAGE_ARTIFACT_FILENAME = 'onsides-coverage.json';

const coverageEntrySchema = z.object({
  rxcui: z.string().trim().min(1),
  hasLabelData: z.boolean(),
  // Present ONLY on an uncovered ingredient (hasLabelData:false) — never a silent drop.
  reason: z.literal('no_onsides_label_data').optional(),
});

export const coverageArtifactSchema = z.object({
  kind: z.literal('onsides-coverage'),
  artifactVersion: z.number().int(),
  onsidesSourceVersion: z.string().min(1),
  generatedAt: z.string().min(1),
  entries: z.array(coverageEntrySchema),
  /** Coverage-passed ingredient rxcuis — the SOLE source of the D1 arm-B term block. */
  covered: z.array(z.string().trim().min(1)),
  /** Ingredients with no OnSIDES label data — the explicit exclusions (empty when allCovered). */
  uncovered: z.array(z.string().trim().min(1)),
  allCovered: z.boolean(),
  /** Operator explicitly accepted the uncovered set as reviewed no_onsides_label_data exclusions. */
  reviewedOverride: z.boolean(),
});

export type CoverageArtifactEntry = z.infer<typeof coverageEntrySchema>;
export type OnsidesCoverageArtifact = z.infer<typeof coverageArtifactSchema>;

/** One resolved-cohort ingredient's coverage outcome (freeze writer input to the builder). */
export interface CoverageBuilderEntry {
  readonly ingredientRxcui: string;
  readonly hasLabelData: boolean;
  readonly reason?: 'no_onsides_label_data';
}

export interface CoverageBuilderInput {
  readonly entries: readonly CoverageBuilderEntry[];
  readonly covered: readonly string[];
  readonly uncovered: readonly string[];
  readonly allCovered: boolean;
  readonly reviewedOverride: boolean;
  readonly onsidesSourceVersion: string;
  readonly generatedAt: string;
}

/** Pure builder: freeze's coverage report → the serializable, DATA-01-clean artifact. */
export function buildCoverageArtifact(input: CoverageBuilderInput): OnsidesCoverageArtifact {
  return {
    kind: 'onsides-coverage',
    artifactVersion: COVERAGE_ARTIFACT_VERSION,
    onsidesSourceVersion: input.onsidesSourceVersion,
    generatedAt: input.generatedAt,
    entries: input.entries.map((e) => ({
      rxcui: e.ingredientRxcui,
      hasLabelData: e.hasLabelData,
      ...(e.reason !== undefined ? { reason: e.reason } : {}),
    })),
    covered: [...input.covered].sort(),
    uncovered: [...input.uncovered].sort(),
    allCovered: input.allCovered,
    reviewedOverride: input.reviewedOverride,
  };
}

/** Thrown when a loaded coverage artifact is missing/malformed/stale — the reader fails CLOSED. */
export class CoverageArtifactError extends Error {
  override readonly name = 'CoverageArtifactError';
}

/**
 * Validate + version-check a loaded coverage artifact. THROWS CoverageArtifactError when the raw
 * value is malformed (missing/failed shape), the artifact version is unknown (stale schema), or the
 * OnSIDES source version does not match the eval's vendored asset (the coverage was computed against
 * a DIFFERENT OnSIDES asset than the one the block is built from — stale). Callers decide how to act
 * on `allCovered` / `reviewedOverride`.
 */
export function parseCoverageArtifact(
  raw: unknown,
  expectedOnsidesSourceVersion: string,
): OnsidesCoverageArtifact {
  const parsed = coverageArtifactSchema.safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => i.path.join('.') || '<root>').join(', ');
    throw new CoverageArtifactError(`coverage artifact is malformed (${where})`);
  }
  const artifact = parsed.data;
  if (artifact.artifactVersion !== COVERAGE_ARTIFACT_VERSION) {
    throw new CoverageArtifactError(
      `coverage artifact version ${artifact.artifactVersion} != expected ${COVERAGE_ARTIFACT_VERSION} ` +
        '(stale — re-run the DRUG-01 freeze)',
    );
  }
  if (artifact.onsidesSourceVersion !== expectedOnsidesSourceVersion) {
    throw new CoverageArtifactError(
      `coverage artifact OnSIDES ${artifact.onsidesSourceVersion} != vendored ${expectedOnsidesSourceVersion} ` +
        '(stale — re-vendor OnSIDES + re-run the freeze)',
    );
  }
  return artifact;
}

/** The D2→D1 provenance persisted into the ablation report so SC12's cohort source is auditable. */
export interface CoverageHandoffProvenance {
  readonly onsidesSourceVersion: string;
  readonly generatedAt: string;
  readonly reviewedOverride: boolean;
  /** The coverage-passed cohort ingredient rxcuis the arm-B block was built from. */
  readonly covered: readonly string[];
  /** Ingredients with no OnSIDES data — EXPLICIT exclusions from the D1 block (never silent). */
  readonly excluded: readonly string[];
}

/** Project a validated artifact down to the provenance the ablation report persists. */
export function coverageHandoffFromArtifact(
  artifact: OnsidesCoverageArtifact,
): CoverageHandoffProvenance {
  return {
    onsidesSourceVersion: artifact.onsidesSourceVersion,
    generatedAt: artifact.generatedAt,
    reviewedOverride: artifact.reviewedOverride,
    covered: artifact.covered,
    excluded: artifact.uncovered,
  };
}
