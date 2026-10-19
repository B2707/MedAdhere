// scripts/freeze-drug-profiles.ts
//
// DRUG-01 — enrollment drug resolution & freeze. A ONE-TIME, OFFLINE, hand-reviewed script.
//
// HARD INVARIANT (DRUG-01 / Pitfall 5): this script is run OFFLINE on the operator machine / bastion.
// It calls three public REST APIs (RxNorm → OpenFDA → Health Canada DPD) to resolve each enrolled
// patient's `medication_name` into a frozen `drug_profile_json` blob, which it writes onto the patient
// row. The RxNorm/OpenFDA/DPD client logic MUST NEVER be imported into any backend/src/**/handler.ts —
// NO runtime third-party label fetch ever runs inside a Lambda. All label data is frozen at enrollment
// so the downstream DRUG-02 annotation (Phase 4) and DRUG-04 dashboard panel (Phase 6) read only the
// frozen blob. (Two-sided grep gate in the plan: hosts PRESENT in scripts/, ABSENT from backend/src.)
//
// MED-7 (dry-run/apply gate): the script DEFAULTS to --dry-run. It resolves each patient's drug,
// ASSEMBLES the drug_profile_json, and PRINTS it for hand review, but performs NO DB write. The
// `UPDATE patient SET drug_profile_json=$1, drug_profile_fetched_at=now() WHERE id=$2` runs ONLY when
// an explicit `--apply` flag is passed on argv. The dry-run output IS the DRUG-01 hand-review artifact.
//
// Warn-and-disable (Pitfall 6): an unresolvable drug (no RxNorm candidate, no OpenFDA label, or any
// upstream network/HTTP error) NEVER throws and NEVER blocks enrollment. It produces the
// {label_features_enabled:false, reason:'unresolved'} shape and the run continues to the next patient.
//
// Transport: Node 24 GLOBAL fetch ONLY — NO axios / node-fetch dependency. DB access reuses the
// data-api/handler.ts idiom (Secrets Manager DB-credential fetch + pg over the pinned RDS CA bundle,
// CA-pinned TLS, parameterized SQL). Run with: `npx tsx scripts/freeze-drug-profiles.ts [--apply]`.
//
// Module mode: CommonJS-compatible (no `import.meta`); tsx/NodeNext resolve the `node:*` + workspace
// deps natively. Mirrors the backend handlers' CJS convention.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';
import { DRUG_PROFILE_SOURCE } from '@medadhere/shared';
// The writer-side drug_profile_json contract (04-07 D2, item J). The freeze script conforms to this
// shared discriminated union so writer/reader can never drift on the ingredient-rxcui + provenance
// fields; the matcher's narrow READ contract (rxcuiFromDrugProfile) is unchanged.
import type {
  DrugProfileWrite,
  ResolvedDrugProfileWrite,
  UnresolvedDrugProfileWrite,
} from '@medadhere/shared';
// OnSIDES coverage indicator (item F). onsides.ts is a PURE, offline, memoized asset loader — it hits
// NO third-party API — so importing it here (scripts → backend, the allowed direction) adds no network
// host to backend/src and never violates the DRUG-01 host-separation invariant below. It is loaded
// lazily (first checkOnsidesCoverage call), so non-coverage code paths never touch the asset.
import { ONSIDES_SOURCE_VERSION, onsidesHasLabelData } from '../backend/src/classifier/onsides.js';
// The D2→D1 coverage handoff contract (review HIGH, 04-07). A PURE zod-schema module (no network host)
// under backend/eval — importing it here is the same allowed scripts → backend direction as onsides.
// The freeze CLI WRITES this artifact; run-eval --ablation READS it (writer/reader can't drift).
import {
  buildCoverageArtifact,
  COVERAGE_ARTIFACT_FILENAME,
  type OnsidesCoverageArtifact,
} from '../backend/eval/lib/coverage-artifact.js';

// ---------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------

/** A patient row's freeze-relevant fields (the resolution input + the UPDATE target id). */
export interface Patient {
  id: string;
  medication_name: string;
}

// The drug_profile_json shapes are the SHARED writer-side contract (04-07 D2, item J) — re-exported
// here under the script's historical names so writer and reader can never drift. `ResolvedProfile`
// carries the ingredient (TTY=IN) `rxcui` + `resolved_from_rxcui` (candidate) + `multi_ingredient` +
// the full `ingredient_rxcuis` list; `UnresolvedProfile.reason` is 'unresolved' | 'unresolved_ingredient'.
export type ResolvedProfile = ResolvedDrugProfileWrite;
export type UnresolvedProfile = UnresolvedDrugProfileWrite;
export type DrugProfile = DrugProfileWrite;

/** The minimal pg-style query seam the script depends on (so tests can inject a fake client). */
export interface QueryClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Per-patient freeze options. `apply` gates the DB write (MED-7). */
export interface FreezeOptions {
  apply: boolean;
}

/** The result of freezing one patient (used by the orchestrator + the hand-review log). */
export interface FreezeResult {
  patientId: string;
  medicationName: string;
  profile: DrugProfile;
  /** True ONLY when apply:true AND the parameterized UPDATE resolved (04-07 freeze correctness). */
  wasWritten: boolean;
  /** Sanitized error NAME when the --apply UPDATE threw (H4 — name only, never message/values). */
  writeError?: string;
}

/** The outcome of freezing one patient — the resolved profile PLUS whether its DB write succeeded. */
export interface FreezeOutcome {
  readonly profile: DrugProfile;
  /** True ONLY when apply:true AND the parameterized UPDATE resolved. False on dry-run or write failure. */
  readonly wasWritten: boolean;
  /** Sanitized error NAME when the --apply UPDATE threw (never the message/values — H4). */
  readonly writeError?: string;
}

// ---------------------------------------------------------------------------------------------------
// REST hosts (these literals are the DRUG-01 invariant markers — present in scripts/, absent in src/).
// ---------------------------------------------------------------------------------------------------

const RXNORM_BASE = 'https://rxnav.nlm.nih.gov/REST';
const OPENFDA_BASE = 'https://api.fda.gov';
const DPD_BASE = 'https://health-products.canada.ca/api/drug';

// Documented limitation recorded on combination (>1 ingredient) profiles (04-07 D2). OnSIDES is
// single-ingredient-keyed, so only the PRIMARY ingredient (ingredient_rxcuis[0]) is stored as `rxcui`
// and matched; per-ingredient ADE fan-out over the full list is a future item (YAGNI for the ≤5
// informal cohort). The full ingredient list is still persisted for the hand-review artifact.
const MULTI_INGREDIENT_LIMITATION =
  'OnSIDES is single-ingredient-keyed; only the primary ingredient (ingredient_rxcuis[0]) is stored as ' +
  'rxcui and matched. Per-ingredient ADE fan-out over the full ingredient list is a future item ' +
  '(YAGNI for the ≤5 informal cohort).';

/** A fetch-shaped function — injectable so tests can mock global fetch without a live network. */
export type FetchFn = typeof fetch;

// ---------------------------------------------------------------------------------------------------
// Resolution helpers — each wraps its own errors so the caller can decide warn-and-disable.
// ---------------------------------------------------------------------------------------------------

/** RxNorm approximateTerm (typo-tolerant, no key). Returns the rank-1 candidate rxcui, or null. */
async function resolveRxcui(name: string, fetchFn: FetchFn): Promise<string | null> {
  const url = `${RXNORM_BASE}/approximateTerm.json?term=${encodeURIComponent(
    name,
  )}&maxEntries=4&option=1`;
  const res = await fetchFn(url);
  if (!res.ok) return null;
  const body = (await res.json()) as {
    approximateGroup?: { candidate?: Array<{ rxcui?: string }> };
  };
  const rxcui = body?.approximateGroup?.candidate?.[0]?.rxcui;
  return rxcui ?? null;
}

// The RxNorm getRelatedByType (`/rxcui/{rxcui}/related.json?tty=IN`) response shape.
// NOTE (04-07 D2): the `relatedGroup.conceptGroup[].tty` / `.conceptProperties[].rxcui` key casing is
// from the documented RxNav schema — VERIFY against a live RxNorm response at first run on the cohort
// (same RESEARCH convention as the DPD note below); if the live keys differ, adjust the reads here.
interface RxNormConceptProperty {
  rxcui?: string;
  tty?: string;
  name?: string;
}
interface RxNormConceptGroup {
  tty?: string;
  conceptProperties?: RxNormConceptProperty[];
}
interface RxNormRelatedResponse {
  relatedGroup?: { conceptGroup?: RxNormConceptGroup[] };
}

/**
 * Normalize a candidate rxcui to its INGREDIENT (RxNorm TTY=IN) rxcui(s) — the 04-06 BLOCKING fix.
 *
 * The OnSIDES asset (and the D1 term-block) are keyed by ingredient RxCUIs, so a product / clinical-drug
 * / brand candidate rxcui yields ZERO matches. This GETs `/rxcui/{candidate}/related.json?tty=IN`:
 *   - candidate already an ingredient → returns itself,
 *   - product / clinical-drug / brand candidate → returns its ingredient rxcui(s),
 *   - zero ingredients → `[]` (the caller then warn-and-disables with reason 'unresolved_ingredient';
 *     it NEVER stores the product rxcui the matcher would abstain on forever).
 * Returns a de-duplicated, order-preserving list; `[]` on a non-OK response (the caller degrades).
 */
export async function normalizeToIngredientRxcui(
  candidateRxcui: string,
  fetchFn: FetchFn,
): Promise<string[]> {
  const url = `${RXNORM_BASE}/rxcui/${encodeURIComponent(candidateRxcui)}/related.json?tty=IN`;
  const res = await fetchFn(url);
  if (!res.ok) return [];
  const body = (await res.json()) as RxNormRelatedResponse;
  const groups = body?.relatedGroup?.conceptGroup ?? [];
  const seen = new Set<string>();
  const ingredients: string[] = [];
  for (const group of groups) {
    if (group?.tty !== 'IN') continue;
    for (const prop of group?.conceptProperties ?? []) {
      const rxcui = prop?.rxcui;
      if (rxcui && !seen.has(rxcui)) {
        seen.add(rxcui);
        ingredients.push(rxcui);
      }
    }
  }
  return ingredients;
}

/** Fetch one OpenFDA label result for a given search expression, or null on 404 / empty. */
async function fetchOpenFdaLabel(
  searchExpr: string,
  fetchFn: FetchFn,
): Promise<Record<string, unknown> | null> {
  const url = `${OPENFDA_BASE}/drug/label.json?search=${searchExpr}&limit=1`;
  const res = await fetchFn(url);
  if (!res.ok) return null; // 404 => no match for this search
  const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
  return body?.results?.[0] ?? null;
}

/**
 * OpenFDA label by rxcui, with the A4 fallback: when the rxcui-indexed search misses (404 / empty),
 * fall back to a generic_name / brand_name search on the drug name before declaring no label.
 */
async function resolveOpenFdaLabel(
  rxcui: string,
  name: string,
  fetchFn: FetchFn,
): Promise<Record<string, unknown> | null> {
  // 1) Primary: by rxcui.
  const byRxcui = await fetchOpenFdaLabel(`openfda.rxcui:${encodeURIComponent(rxcui)}`, fetchFn);
  if (byRxcui) return byRxcui;

  // 2) A4 fallback: the rxcui index can be sparse — try a name-based search.
  const quoted = `"${encodeURIComponent(name)}"`;
  const byName = await fetchOpenFdaLabel(
    `openfda.generic_name:${quoted}+openfda.brand_name:${quoted}`,
    fetchFn,
  );
  return byName;
}

/**
 * Health Canada DPD two-step existence check: drugproduct (→ drug_code + DIN), then therapeuticclass
 * by drug_code (→ ATC). Best-effort: any miss yields nulls (DIN/ATC are supplementary context).
 *
 * NOTE (A3): the DPD response key casing (drug_code / drug_identification_number / tc_atc_number) is
 * from the documented schema — VERIFY against a live DPD response when first running on the cohort's
 * medication_names; if the live keys differ, adjust the field reads here (offline, hand-reviewed).
 */
async function resolveDpd(
  name: string,
  fetchFn: FetchFn,
): Promise<{ din: string | null; atc: string | null }> {
  const productUrl = `${DPD_BASE}/drugproduct/?brandname=${encodeURIComponent(
    name,
  )}&type=json&lang=en`;
  const productRes = await fetchFn(productUrl);
  if (!productRes.ok) return { din: null, atc: null };
  const products = (await productRes.json()) as Array<{
    drug_code?: number | string;
    drug_identification_number?: string;
  }>;
  const first = Array.isArray(products) ? products[0] : undefined;
  const drugCode = first?.drug_code ?? null;
  const din = first?.drug_identification_number ?? null;

  let atc: string | null = null;
  if (drugCode !== null && drugCode !== undefined) {
    const tcUrl = `${DPD_BASE}/therapeuticclass/?id=${encodeURIComponent(
      String(drugCode),
    )}&type=json&lang=en`;
    const tcRes = await fetchFn(tcUrl);
    if (tcRes.ok) {
      const tc = (await tcRes.json()) as Array<{ tc_atc_number?: string }>;
      atc = (Array.isArray(tc) ? tc[0]?.tc_atc_number : null) ?? null;
    }
  }
  return { din, atc };
}

// ---------------------------------------------------------------------------------------------------
// Public: resolve one drug name → drug_profile_json (never throws — warn-and-disable on any failure).
// ---------------------------------------------------------------------------------------------------

/**
 * Resolve a medication name into a drug_profile_json blob via RxNorm → OpenFDA → DPD (RESEARCH Code §5).
 *
 * Warn-and-disable contract (Pitfall 6): this function NEVER throws. Any upstream failure (no RxNorm
 * candidate, no OpenFDA label, or a network/HTTP error from any of the three APIs) degrades to the
 * {label_features_enabled:false, reason:'unresolved'} shape so a single bad name can never block
 * enrollment or abort the run.
 */
export async function resolveDrugProfile(name: string, fetchFn: FetchFn): Promise<DrugProfile> {
  try {
    // 1) Typo-tolerant candidate (raw approximateTerm rank-1) — the OpenFDA lookup key (item L).
    const candidateRxcui = await resolveRxcui(name, fetchFn);
    if (!candidateRxcui) {
      return {
        label_features_enabled: false,
        reason: 'unresolved',
        rxcui: null,
        resolved_from_rxcui: null,
      };
    }

    // 2) Normalize the candidate to its ingredient (TTY=IN) rxcui(s) — the OnSIDES / D1 key space
    //    (the 04-06 BLOCKING fix). Zero ingredients → warn-and-disable; NEVER store a product rxcui.
    const ingredientRxcuis = await normalizeToIngredientRxcui(candidateRxcui, fetchFn);
    const primaryIngredient = ingredientRxcuis[0];
    if (!primaryIngredient) {
      return {
        label_features_enabled: false,
        reason: 'unresolved_ingredient',
        rxcui: null,
        resolved_from_rxcui: candidateRxcui,
      };
    }
    const multiIngredient = ingredientRxcuis.length > 1;

    // 3) OpenFDA primary label lookup stays on the CANDIDATE rxcui (item L): switching to the
    //    ingredient rxcui could REDUCE label resolution; the name-based fallback is unchanged. A MISS
    //    here does NOT disable the profile (04-07 freeze correctness, ULTRA MED :289): DRUG-02 OnSIDES
    //    ADE matching is keyed by the INGREDIENT rxcui and is a source INDEPENDENT of the OpenFDA label
    //    (keyed by the candidate), so a failed OpenFDA label must NOT kill OnSIDES. We keep the
    //    ingredient rxcui and emit a RESOLVED (OnSIDES-matchable) profile with null FDA-label context.
    const label = await resolveOpenFdaLabel(candidateRxcui, name, fetchFn);

    // DPD is supplementary (DIN/ATC) and INDEPENDENT of OpenFDA; attempt it regardless of the label
    // outcome (coupling it to an OpenFDA success would repeat the very defect this fix removes).
    let dpd: { din: string | null; atc: string | null } = { din: null, atc: null };
    try {
      dpd = await resolveDpd(name, fetchFn);
    } catch {
      dpd = { din: null, atc: null };
    }

    const boxedWarning =
      label && Array.isArray(label.boxed_warning) ? (label.boxed_warning as unknown[]) : null;
    const warningsAndCautions =
      label && Array.isArray(label.warnings_and_cautions)
        ? (label.warnings_and_cautions as unknown[])
        : null;
    const adverseReactions =
      label && Array.isArray(label.adverse_reactions)
        ? (label.adverse_reactions as unknown[])
        : null;

    return {
      label_features_enabled: true,
      // Frozen rxcui is the INGREDIENT (TTY=IN) primary — the OnSIDES matcher / D1 term-block key.
      rxcui: primaryIngredient,
      // The raw candidate this resolved from — the OpenFDA lookup key (persist BOTH; item L).
      resolved_from_rxcui: candidateRxcui,
      multi_ingredient: multiIngredient,
      ingredient_rxcuis: ingredientRxcuis,
      boxed_warning_present: boxedWarning !== null && boxedWarning.length > 0,
      boxed_warning: boxedWarning,
      warnings_and_cautions: warningsAndCautions,
      adverse_reactions: adverseReactions,
      dpd,
      // Provenance distinguishes an FDA-label-backed profile from an OnSIDES-only (no OpenFDA) one.
      // The latter stays label_features_enabled:true so DRUG-02 OnSIDES ADE matching still works;
      // FDA-label context fields remain null (04-07 freeze correctness, ULTRA MED :289).
      source: label
        ? DRUG_PROFILE_SOURCE.FDA_LABEL
        : DRUG_PROFILE_SOURCE.INGREDIENT_ONLY,
      multi_ingredient_limitation: multiIngredient ? MULTI_INGREDIENT_LIMITATION : null,
    };
  } catch {
    // Any unexpected error → warn-and-disable (never throw; Pitfall 6).
    return {
      label_features_enabled: false,
      reason: 'unresolved',
      rxcui: null,
      resolved_from_rxcui: null,
    };
  }
}

// ---------------------------------------------------------------------------------------------------
// Public: freeze one patient (resolve + optionally UPDATE under --apply only — MED-7).
// ---------------------------------------------------------------------------------------------------

/** The parameterized freeze UPDATE (drug_profile_fetched_at=now() is the freeze instant). */
const FREEZE_UPDATE_SQL =
  'UPDATE patient SET drug_profile_json = $1, drug_profile_fetched_at = now() WHERE id = $2';

/**
 * Resolve one patient's drug and, ONLY under `apply:true`, write the frozen drug_profile_json via the
 * parameterized UPDATE (MED-7). In the default dry-run (`apply:false`) NO query is issued — the
 * returned profile is the hand-review artifact.
 *
 * Never throws: `resolveDrugProfile` is total, and a DB-write failure is CAUGHT and reported as
 * `wasWritten:false` + a sanitized `writeError` (04-07 freeze correctness, ULTRA MED :396). Crucially,
 * a write failure keeps the REAL resolved profile — it must NOT masquerade as an unresolved drug — so
 * the caller can log `[WRITE FAILED]` (not `[written]`) and exit non-zero without losing the resolution.
 */
export async function freezePatient(
  patient: Patient,
  client: QueryClient,
  fetchFn: FetchFn,
  options: FreezeOptions,
): Promise<FreezeOutcome> {
  const profile = await resolveDrugProfile(patient.medication_name, fetchFn);

  if (!options.apply) return { profile, wasWritten: false };

  try {
    // Parameterized $1,$2 — never interpolate drug data or ids (T-03-18 SQL-injection mitigation).
    // jsonb param is passed as a JSON string; node-postgres binds it to the jsonb column.
    await client.query(FREEZE_UPDATE_SQL, [JSON.stringify(profile), patient.id]);
    return { profile, wasWritten: true };
  } catch (error: unknown) {
    // Real DB-write failure (transient blip / failover / constraint). Keep the resolved profile;
    // report the failure by NAME only (H4) so the caller drives an honest [WRITE FAILED] + non-zero exit.
    return {
      profile,
      wasWritten: false,
      writeError: error instanceof Error ? error.name : 'unknown',
    };
  }
}

// ---------------------------------------------------------------------------------------------------
// Public: orchestrate the whole run (per-patient try/catch keeps the run going — Pitfall 6).
// ---------------------------------------------------------------------------------------------------

/**
 * Freeze every patient in order. A failure on one patient degrades to warn-and-disable for THAT patient
 * and the run continues — one bad drug never aborts the whole freeze (Pitfall 6 / T-03-17).
 */
export async function runFreeze(
  patients: Patient[],
  client: QueryClient,
  fetchFn: FetchFn,
  options: FreezeOptions,
): Promise<FreezeResult[]> {
  const results: FreezeResult[] = [];
  for (const patient of patients) {
    let outcome: FreezeOutcome;
    try {
      outcome = await freezePatient(patient, client, fetchFn, options);
    } catch (error: unknown) {
      // Defensive last resort: `resolveDrugProfile` is total and `freezePatient` now swallows write
      // errors, so this only guards a pathological throw (e.g. JSON.stringify on a cyclic value).
      // Degrade THIS patient to warn-and-disable and keep the run going (Pitfall 6 / T-03-17).
      const message = error instanceof Error ? error.message : 'unexpected error';
      console.error(
        `[freeze] patient ${patient.id} (${patient.medication_name}) failed: ${message}`,
      );
      outcome = {
        profile: {
          label_features_enabled: false,
          reason: 'unresolved',
          rxcui: null,
          resolved_from_rxcui: null,
        },
        wasWritten: false,
        writeError: error instanceof Error ? error.name : 'unknown',
      };
    }

    results.push({
      patientId: patient.id,
      medicationName: patient.medication_name,
      profile: outcome.profile,
      wasWritten: outcome.wasWritten,
      ...(outcome.writeError !== undefined ? { writeError: outcome.writeError } : {}),
    });

    const status = outcome.profile.label_features_enabled
      ? 'RESOLVED'
      : 'WARN-AND-DISABLE (unresolved)';
    // The write tag is driven off ACTUAL write success, never off options.apply (04-07 freeze
    // correctness): a real DB-write failure logs [WRITE FAILED], not [written].
    const writeTag = !options.apply
      ? ' [dry-run: NOT written]'
      : outcome.wasWritten
        ? ' [written]'
        : ` [WRITE FAILED${outcome.writeError ? `: ${outcome.writeError}` : ''}]`;
    console.log(`[freeze] ${patient.id} "${patient.medication_name}" → ${status}${writeTag}`);
    console.log(JSON.stringify(outcome.profile, null, 2));
  }
  return results;
}

// ---------------------------------------------------------------------------------------------------
// OnSIDES coverage gate (04-07 D2, item F) — a HARD exit criterion + the input to D1's block generation.
// TTY=IN normalization fixes the KEY SHAPE, but the vendored asset is a 15-ingredient REPRESENTATIVE set
// (not the cohort's), so `onsidesHasLabelData` (pure key membership) can still miss real cohort rxcuis.
// After the dry-run resolves the cohort's ingredient rxcuis, require EVERY one to have vendored label
// data — ELSE re-vendor the asset (vendor-onsides.mjs) OR record a deliberate no_onsides_label_data
// limitation and EXCLUDE that ingredient from the D1 block with a visible provenance note.
// ---------------------------------------------------------------------------------------------------

/** Per-ingredient OnSIDES coverage outcome. `reason` is present only when there is NO vendored data. */
export interface OnsidesCoverageEntry {
  ingredientRxcui: string;
  hasLabelData: boolean;
  reason?: 'no_onsides_label_data';
}

/** The cohort-level OnSIDES coverage result. `allCovered` is the hard exit criterion (item F). */
export interface OnsidesCoverageReport {
  entries: OnsidesCoverageEntry[];
  covered: string[];
  uncovered: string[];
  allCovered: boolean;
}

/**
 * Check OnSIDES coverage for the RESOLVED-cohort ingredient rxcuis. For every ingredient, record either
 * `hasLabelData: true` (the vendored asset carries label data) or an explicit
 * `{ hasLabelData: false, reason: 'no_onsides_label_data' }` — never a silent drop. `allCovered` is the
 * hard exit criterion. `hasLabelData` defaults to the REAL `onsidesHasLabelData` (real vendored asset),
 * injectable only for unit isolation.
 */
export function checkOnsidesCoverage(
  ingredientRxcuis: string[],
  hasLabelData: (rxcui: string) => boolean = onsidesHasLabelData,
): OnsidesCoverageReport {
  const entries: OnsidesCoverageEntry[] = ingredientRxcuis.map((ingredientRxcui) =>
    hasLabelData(ingredientRxcui)
      ? { ingredientRxcui, hasLabelData: true }
      : { ingredientRxcui, hasLabelData: false, reason: 'no_onsides_label_data' },
  );
  const covered = entries.filter((e) => e.hasLabelData).map((e) => e.ingredientRxcui);
  const uncovered = entries.filter((e) => !e.hasLabelData).map((e) => e.ingredientRxcui);
  return { entries, covered, uncovered, allCovered: uncovered.length === 0 };
}

/**
 * The de-duplicated set of ingredient (TTY=IN) rxcuis across every RESOLVED profile in a freeze run —
 * the input to `checkOnsidesCoverage`. Includes the full `ingredient_rxcuis` of each resolved profile
 * (multi-ingredient profiles contribute all of their ingredients, not just the primary).
 */
export function collectResolvedIngredientRxcuis(results: FreezeResult[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const result of results) {
    if (!result.profile.label_features_enabled) continue;
    for (const rxcui of result.profile.ingredient_rxcuis) {
      if (!seen.has(rxcui)) {
        seen.add(rxcui);
        out.push(rxcui);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Import-testable CLI seam (review HIGH, 04-07) — ENFORCE + CONSUME the OnSIDES coverage gate.
// ---------------------------------------------------------------------------------------------------

/** `apply` gates the DB write (MED-7); `coverageOverride` downgrades an uncovered gate to exclusions. */
export interface FreezeCliOptions {
  readonly apply: boolean;
  readonly coverageOverride: boolean;
}

/** Injectable deps for `runFreezeCli` — all I/O seams so the offline unit test drives it at $0. */
export interface FreezeCliDeps {
  readonly patients: Patient[];
  readonly client: QueryClient;
  readonly fetchFn: FetchFn;
  readonly options: FreezeCliOptions;
  /** Persist the coverage artifact (the real CLI passes writeFileSync; tests pass a spy). */
  readonly writeFile: (path: string, data: string) => void;
  readonly coverageArtifactPath: string;
  readonly now: () => Date;
  /** OnSIDES coverage indicator — defaults to the REAL vendored-asset check; injectable for tests. */
  readonly hasLabelData?: (rxcui: string) => boolean;
  readonly onsidesSourceVersion?: string;
}

/** Structured result of a whole freeze run — exitCode aggregates write + coverage failures. */
export interface FreezeCliResult {
  readonly exitCode: number;
  readonly results: FreezeResult[];
  readonly coverage: OnsidesCoverageReport;
  readonly artifact: OnsidesCoverageArtifact;
  /** Patient ids whose --apply UPDATE threw — the failedWrites summary. */
  readonly failedWrites: string[];
}

/**
 * Run the whole freeze behind an import-testable seam that ENFORCES and CONSUMES the OnSIDES coverage
 * gate (review HIGH, 04-07). It freezes every patient, then PERSISTS a machine-readable, DATA-01-clean
 * coverage artifact (the D2→D1 handoff `run-eval --ablation` loads) and returns a NON-ZERO `exitCode`
 * when EITHER a real --apply DB write failed OR a resolved cohort ingredient has no OnSIDES label data
 * and no reviewed override was supplied. The gate is therefore no longer a bare `console.warn`.
 */
export async function runFreezeCli(deps: FreezeCliDeps): Promise<FreezeCliResult> {
  const results = await runFreeze(deps.patients, deps.client, deps.fetchFn, {
    apply: deps.options.apply,
  });
  const failedWrites = results.filter((r) => r.writeError !== undefined).map((r) => r.patientId);

  const ingredientRxcuis = collectResolvedIngredientRxcuis(results);
  const coverage = checkOnsidesCoverage(ingredientRxcuis, deps.hasLabelData ?? onsidesHasLabelData);

  const artifact = buildCoverageArtifact({
    entries: coverage.entries.map((e) => ({
      ingredientRxcui: e.ingredientRxcui,
      hasLabelData: e.hasLabelData,
      ...(e.reason !== undefined ? { reason: e.reason } : {}),
    })),
    covered: coverage.covered,
    uncovered: coverage.uncovered,
    allCovered: coverage.allCovered,
    reviewedOverride: deps.options.coverageOverride,
    onsidesSourceVersion: deps.onsidesSourceVersion ?? ONSIDES_SOURCE_VERSION,
    generatedAt: deps.now().toISOString(),
  });
  deps.writeFile(deps.coverageArtifactPath, JSON.stringify(artifact, null, 2));

  // Hard exit criterion: a real DB write failure OR an un-reviewed uncovered ingredient is a non-zero
  // exit. A reviewed override downgrades the coverage failure to a deliberate no_onsides exclusion.
  const coverageFail = !coverage.allCovered && !deps.options.coverageOverride;
  const exitCode = failedWrites.length > 0 || coverageFail ? 1 : 0;

  return { exitCode, results, coverage, artifact, failedWrites };
}

// ---------------------------------------------------------------------------------------------------
// DB connection (data-api idiom) + CLI entrypoint — only runs when invoked directly, not under test.
// ---------------------------------------------------------------------------------------------------

/** Shape of the CDK-generated DB credential secret (D-06). */
interface DbSecret {
  username: string;
  password: string;
}

/**
 * Build a pg.Pool over the pinned RDS CA bundle, reusing the data-api/handler.ts posture: the DB
 * credential comes from Secrets Manager (D-06 — never an env var), and TLS is configured by ONE
 * explicit `ssl` object that pins the AWS RDS global CA bundle (M-2: rejectUnauthorized:true, never
 * false). Bundle path resolves alongside this script when run offline (operator must place the PEM
 * next to the script, or set DB_CA_BUNDLE_PATH).
 */
async function buildPool(): Promise<Pool> {
  const dbSecretArn = process.env.DB_SECRET_ARN;
  if (!dbSecretArn) throw new Error('DB_SECRET_ARN env var is not set');

  const { DB_HOST, DB_PORT, DB_NAME } = process.env;
  if (!DB_HOST || !DB_PORT || !DB_NAME) {
    throw new Error('DB_HOST / DB_PORT / DB_NAME env vars must all be set');
  }
  const port = Number(DB_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`DB_PORT is not a valid TCP port (1-65535): ${DB_PORT}`);
  }

  const sm = new SecretsManagerClient({});
  const secretValue = await sm.send(new GetSecretValueCommand({ SecretId: dbSecretArn }));
  if (!secretValue.SecretString) {
    throw new Error('DB secret has no SecretString — secret not populated');
  }
  const { username, password } = JSON.parse(secretValue.SecretString) as DbSecret;

  // M-2 — pin the AWS RDS global CA bundle and VERIFY the server cert. Single-source TLS (F28).
  const caBundlePath = process.env.DB_CA_BUNDLE_PATH ?? join(__dirname, 'rds-global-bundle.pem');
  const rdsCaBundle = readFileSync(caBundlePath, 'utf8');

  return new Pool({
    host: DB_HOST,
    port,
    database: DB_NAME,
    user: username,
    password,
    max: 2,
    ssl: { ca: rdsCaBundle, rejectUnauthorized: true },
  });
}

/** Load every patient that needs freezing (medication_name + id). */
async function loadPatients(client: QueryClient): Promise<Patient[]> {
  const { rows } = await client.query(
    'SELECT id, medication_name FROM patient WHERE is_active = true ORDER BY created_at',
  );
  return rows as Patient[];
}

/** CLI entrypoint — MED-7: default --dry-run; the UPDATE runs ONLY with an explicit --apply. */
async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  // `--coverage-override` records uncovered ingredients as reviewed no_onsides_label_data exclusions
  // (a deliberate disposition) instead of failing the gate — the ONLY way an uncovered gate exits 0.
  const coverageOverride = process.argv.includes('--coverage-override');
  // `--dry-run` is accepted as an explicit no-op for operator clarity; it is the default regardless.
  const mode = apply ? 'APPLY (DB WRITES ENABLED)' : 'DRY-RUN (no DB writes — hand-review only)';
  console.log('='.repeat(72));
  console.log(`DRUG-01 freeze-drug-profiles — mode: ${mode}`);
  if (!apply) {
    console.log('Pass --apply to write drug_profile_json + drug_profile_fetched_at (MED-7 gate).');
  }
  console.log('='.repeat(72));

  const pool = await buildPool();
  try {
    const patients = await loadPatients(pool);
    console.log(`[freeze] resolving ${patients.length} active patient(s)…`);
    // The coverage artifact is the D2→D1 handoff run-eval --ablation consumes; write it next to the
    // eval harness (backend/eval/<COVERAGE_ARTIFACT_FILENAME>) so the reader path resolves.
    const coverageArtifactPath = join(
      __dirname,
      '..',
      'backend',
      'eval',
      COVERAGE_ARTIFACT_FILENAME,
    );
    const result = await runFreezeCli({
      patients,
      client: pool,
      fetchFn: fetch,
      options: { apply, coverageOverride },
      writeFile: (path, data) => writeFileSync(path, data),
      coverageArtifactPath,
      now: () => new Date(),
    });

    const resolved = result.results.filter((r) => r.profile.label_features_enabled).length;
    const disabled = result.results.length - resolved;
    console.log(
      `[freeze] done — ${resolved} resolved, ${disabled} warn-and-disable` +
        (apply
          ? ` (${result.failedWrites.length} write failure(s))`
          : ' (dry-run — nothing written)'),
    );
    if (result.failedWrites.length > 0) {
      console.error(
        `[freeze] WRITE FAILURES for patient id(s): ${result.failedWrites.join(', ')} — ` +
          're-run --apply for these once the DB is reachable.',
      );
    }

    const { coverage } = result;
    const totalIngredients = coverage.covered.length + coverage.uncovered.length;
    console.log(
      `[coverage] OnSIDES label data: ${coverage.covered.length}/${totalIngredients} ` +
        `resolved ingredient(s) covered${coverage.allCovered ? ' — gate PASS' : ' — gate FAIL'}`,
    );
    console.log(`[coverage] artifact written: ${coverageArtifactPath}`);
    if (!coverage.allCovered) {
      console.warn(
        `[coverage] NO OnSIDES label data for ingredient rxcui(s): ${coverage.uncovered.join(', ')}. ` +
          'Re-vendor the asset for the cohort rxcuis (vendor-onsides.mjs) and re-run, OR re-run with ' +
          '--coverage-override to record these as deliberate no_onsides_label_data exclusions.' +
          (coverageOverride ? ' [--coverage-override supplied → recorded as exclusions]' : ''),
      );
    }

    // ENFORCE the gate (review HIGH): a real DB write failure OR an un-reviewed uncovered ingredient
    // is a non-zero exit — no longer a bare warning that reaches `finally` and exits successfully.
    process.exitCode = result.exitCode;
  } finally {
    await pool.end();
  }
}

// Run main() only when executed directly (tsx/node), not when imported by the test module.
// `require.main === module` is the CJS direct-invocation guard (no `import.meta` — matches CJS mode).
declare const require: { main?: unknown } | undefined;
declare const module: unknown;
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unexpected error';
    console.error(`[freeze] fatal: ${message}`);
    process.exitCode = 1;
  });
}
