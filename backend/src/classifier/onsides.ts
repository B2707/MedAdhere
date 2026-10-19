/**
 * onsides.ts — loader for the vendored OnSIDES adverse-effect index (Plan
 * 04-06, DRUG-02). The index is a KB-scale JSON built at vendoring time by
 * scripts/vendor-onsides.mjs from OnSIDES v3.1.1 (gate fix U-27) — the matcher
 * NEVER parses the 400 MB source CSV, and this module NEVER hits a third-party
 * API (all label data frozen at build/enrollment).
 *
 * The parsed index is memoized at module scope: the first call parses the
 * bundled JSON once; every later call returns the cached object (U-27: no
 * per-invoke reparse). Missing data → an empty effect list, never a throw
 * (the matcher abstains silently — SC11).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ONSIDES_SOURCE_VERSION = 'v3.1.1';
export const ONSIDES_ASSET_FILE = 'assets/onsides-labels.v3.1.1.json';

export type HintLevel = 'info' | 'elevated';

export interface OnsidesEffect {
  readonly meddra_id: string;
  readonly pt: string;
  readonly hint_level: HintLevel;
}

interface OnsidesLabelEntry {
  readonly ingredient: string | null;
  readonly effects: OnsidesEffect[];
}

export interface OnsidesIndex {
  readonly meta: {
    readonly source: string;
    readonly citation: string;
    readonly rxcui_count: number;
  };
  readonly labels: Readonly<Record<string, OnsidesLabelEntry>>;
}

let cached: OnsidesIndex | null = null;

export function loadOnsidesIndex(): OnsidesIndex {
  if (cached) return cached;
  // __dirname + join is the repo's CommonJS bundled-asset pattern (same as the
  // classifier handler's rds-global-bundle.pem); import.meta is rejected by the
  // CommonJS tsc target.
  const path = join(__dirname, ONSIDES_ASSET_FILE);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    _meta: OnsidesIndex['meta'];
    labels: Record<string, OnsidesLabelEntry>;
  };
  cached = { meta: raw._meta, labels: raw.labels };
  return cached;
}

/**
 * The vendored OnSIDES adverse-effect PTs for a drug's frozen ingredient RxCUI.
 * Empty array when the RxCUI has no vendored label data — the caller abstains
 * (and, per U-20, distinguishes "checked, no match" from "no label data" using
 * whether the RxCUI key exists at all: see `onsidesHasLabelData`).
 */
export function onsidesEffectsForRxcui(rxcui: string): readonly OnsidesEffect[] {
  if (!rxcui) return [];
  return loadOnsidesIndex().labels[rxcui]?.effects ?? [];
}

/** U-20 coverage indicator: does the vendored asset carry ANY label data for this RxCUI? */
export function onsidesHasLabelData(rxcui: string): boolean {
  return Boolean(rxcui) && Object.hasOwn(loadOnsidesIndex().labels, rxcui);
}
