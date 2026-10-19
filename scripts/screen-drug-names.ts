// scripts/screen-drug-names.ts
//
// Phase-7 DRUG-03 D2 screening glue. This operator CLI resolves one or more candidate medication names
// through the SAME DB-free freeze-time RxNorm → TTY=IN ingredient normalization path, then checks the
// normalized ingredient RxCUI(s) against the vendored OnSIDES JSON. It performs no enrollment and no
// RDS access. The only network calls are the existing offline drug-profile resolver's public API seams.
//
// Usage:
//   npx tsx scripts/screen-drug-names.ts "Warfarin" "Amoxicillin Clavulanate"
//
// A genuine no-coverage result is a valid D2 outcome and exits zero. An indeterminate upstream
// resolution or a usage/internal error exits non-zero so transport failures cannot masquerade as
// reviewed no-coverage.

import { onsidesHasLabelData } from '../backend/src/classifier/onsides.js';
import { resolveDrugProfile } from './freeze-drug-profiles.js';

export type ScreenDrugProfile =
  | {
      readonly label_features_enabled: true;
      readonly ingredient_rxcuis: readonly string[];
    }
  | {
      readonly label_features_enabled: false;
      readonly reason?: string;
      readonly rxcui?: null;
      readonly resolved_from_rxcui?: string | null;
    };

export interface DrugNameScreenEntry {
  readonly name: string;
  readonly ingredientRxcuis: readonly string[];
  readonly onsidesCoveragePasses: boolean;
  readonly status: 'covered' | 'uncovered' | 'indeterminate';
  readonly reason?: string;
}

export interface DrugNameScreenResult {
  readonly exitCode: 0 | 1;
  readonly entries: readonly DrugNameScreenEntry[];
  readonly atLeastOnePasses: boolean;
}

export interface DrugNameScreenDeps {
  readonly fetchFn: typeof fetch;
  readonly resolveProfile?: (name: string, fetchFn: typeof fetch) => Promise<ScreenDrugProfile>;
  readonly hasLabelData?: (ingredientRxcui: string) => boolean;
  readonly writeLine?: (line: string) => void;
}

export interface DrugNameScreenCliDeps extends DrugNameScreenDeps {
  readonly writeError: (line: string) => void;
}

const USAGE = 'usage: npx tsx scripts/screen-drug-names.ts <drug-name> [<drug-name> ...]';

/** Treat each argv entry as one candidate name; multi-word names must be shell-quoted. */
export function parseDrugNames(argv: readonly string[]): string[] {
  const names = argv.map((name) => name.trim());
  if (names.length === 0 || names.some((name) => name.length === 0)) {
    throw new Error(USAGE);
  }
  return names;
}

/**
 * Resolve and screen every name. `resolveDrugProfile` owns the canonical freeze-time
 * `normalizeToIngredientRxcui` call, so this glue cannot bypass the RxNorm TTY=IN path.
 */
export async function runDrugNameScreening(
  argv: readonly string[],
  deps: DrugNameScreenDeps,
): Promise<DrugNameScreenResult> {
  const names = parseDrugNames(argv);
  const resolveProfile = deps.resolveProfile ?? resolveDrugProfile;
  const hasLabelData = deps.hasLabelData ?? onsidesHasLabelData;
  const writeLine = deps.writeLine ?? console.log;

  const entries = await Promise.all(
    names.map(async (name): Promise<DrugNameScreenEntry> => {
      const profile = await resolveProfile(name, deps.fetchFn);
      if (!profile.label_features_enabled) {
        return {
          name,
          ingredientRxcuis: [],
          onsidesCoveragePasses: false,
          status: 'indeterminate',
          reason: profile.reason ?? 'unresolved',
        };
      }
      const ingredientRxcuis = [...profile.ingredient_rxcuis];
      if (ingredientRxcuis.length === 0) {
        return {
          name,
          ingredientRxcuis,
          onsidesCoveragePasses: false,
          status: 'indeterminate',
          reason: 'resolved_profile_missing_ingredients',
        };
      }
      const onsidesCoveragePasses = ingredientRxcuis.every((ingredientRxcui) =>
        hasLabelData(ingredientRxcui),
      );
      return {
        name,
        ingredientRxcuis,
        onsidesCoveragePasses,
        status: onsidesCoveragePasses ? 'covered' : 'uncovered',
      };
    }),
  );

  for (const entry of entries) {
    const ingredients =
      entry.ingredientRxcuis.length > 0 ? entry.ingredientRxcuis.join(', ') : 'none';
    const reason =
      entry.status === 'indeterminate' ? ` (reason: ${entry.reason ?? 'unknown'})` : '';
    writeLine(
      `${entry.name}: ingredient RxCUI(s): ${ingredients}; ` +
        `OnSIDES coverage: ${entry.status.toUpperCase()}${reason}`,
    );
  }

  const atLeastOnePasses = entries.some((entry) => entry.onsidesCoveragePasses);
  const coveredCount = entries.filter((entry) => entry.status === 'covered').length;
  const uncoveredCount = entries.filter((entry) => entry.status === 'uncovered').length;
  const indeterminateCount = entries.filter((entry) => entry.status === 'indeterminate').length;
  writeLine(
    `SUMMARY: covered: ${coveredCount}; uncovered: ${uncoveredCount}; ` +
      `indeterminate: ${indeterminateCount}; at least one screened name passes OnSIDES coverage: ${
        atLeastOnePasses ? 'YES' : 'NO'
      }`,
  );

  return {
    exitCode: indeterminateCount > 0 ? 1 : 0,
    entries,
    atLeastOnePasses,
  };
}

/** Thin CLI boundary: genuine no-coverage remains zero; indeterminate/usage/internal errors return one. */
export async function runDrugNameScreeningCli(
  argv: readonly string[],
  deps: DrugNameScreenCliDeps,
): Promise<0 | 1> {
  try {
    const result = await runDrugNameScreening(argv, deps);
    return result.exitCode;
  } catch (error: unknown) {
    deps.writeError(
      error instanceof Error
        ? `screen-drug-names: ${error.message}`
        : 'screen-drug-names: internal error',
    );
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runDrugNameScreeningCli(process.argv.slice(2), {
    fetchFn: fetch,
    writeError: console.error,
  });
}

// Run main() only when executed directly (tsx/node), not when imported by a test module.
declare const require: { main?: unknown } | undefined;
declare const module: unknown;
if (typeof require !== 'undefined' && require.main === module) {
  void main();
}
