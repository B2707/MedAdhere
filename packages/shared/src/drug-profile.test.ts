/**
 * drug-profile.test.ts — H6 (04-06 pre-exec): the matcher's frozen-rxcui source.
 * `drug_profile_json` is DRUG-01-written jsonb (ResolvedProfile | UnresolvedProfile,
 * shape mirrored from scripts/freeze-drug-profiles.ts). The matcher reads it as an
 * UNKNOWN db value and must abstain (null) on anything not cleanly resolved+enabled,
 * so a wiring/shape mismatch can never masquerade as a legitimate match.
 */
import { describe, expect, it } from 'vitest';
import {
  DRUG_PROFILE_SOURCE,
  drugProfileSchema,
  drugProfileSourceSchema,
  rxcuiFromDrugProfile,
  drugProfileWriteSchema,
} from './drug-profile.js';

const resolved = {
  label_features_enabled: true as const,
  rxcui: '860975',
  boxed_warning_present: false,
  boxed_warning: null,
  warnings_and_cautions: null,
  adverse_reactions: null,
  dpd: { din: null, atc: null },
  source: 'test',
};

describe('rxcuiFromDrugProfile — abstain unless resolved AND label features enabled', () => {
  it('returns the rxcui for a resolved, features-enabled profile', () => {
    expect(rxcuiFromDrugProfile(resolved)).toBe('860975');
  });

  it('returns null when the column is null/undefined (DRUG-01 has not run — the common case today)', () => {
    expect(rxcuiFromDrugProfile(null)).toBeNull();
    expect(rxcuiFromDrugProfile(undefined)).toBeNull();
  });

  it('returns null for an unresolved (warn-and-disabled) profile even if a stale rxcui is present', () => {
    expect(rxcuiFromDrugProfile({ label_features_enabled: false, reason: 'unresolved', rxcui: null })).toBeNull();
    expect(rxcuiFromDrugProfile({ label_features_enabled: false, rxcui: '860975' })).toBeNull();
  });

  it('returns null when label features are enabled but the rxcui is empty/blank', () => {
    expect(rxcuiFromDrugProfile({ ...resolved, rxcui: '' })).toBeNull();
    expect(rxcuiFromDrugProfile({ ...resolved, rxcui: '   ' })).toBeNull();
  });

  it('returns null for malformed / non-object inputs (never throws)', () => {
    expect(rxcuiFromDrugProfile('860975')).toBeNull();
    expect(rxcuiFromDrugProfile(42)).toBeNull();
    expect(rxcuiFromDrugProfile({})).toBeNull();
    expect(rxcuiFromDrugProfile({ label_features_enabled: true })).toBeNull();
    expect(rxcuiFromDrugProfile({ rxcui: '860975' })).toBeNull();
  });
});

// The WRITER-SIDE contract (04-07 D2, item J). The read contract above stays narrow; this pins the FULL
// shape DRUG-01 freezes (ingredient rxcui + candidate provenance + multi-ingredient fields), so the
// freeze writer and the matcher's read schema cannot drift on the ingredient-rxcui fix.
const resolvedWrite = {
  label_features_enabled: true as const,
  rxcui: '11289', // ingredient (TTY=IN)
  resolved_from_rxcui: '855332', // raw candidate (OpenFDA key)
  multi_ingredient: false,
  ingredient_rxcuis: ['11289'],
  boxed_warning_present: true,
  boxed_warning: ['WARNING: bleeding risk'],
  warnings_and_cautions: null,
  adverse_reactions: null,
  dpd: { din: null, atc: null },
  source: DRUG_PROFILE_SOURCE.FDA_LABEL,
  multi_ingredient_limitation: null,
};

describe('drugProfileWriteSchema — the writer-side drug_profile_json union (DRUG-01 freeze contract)', () => {
  it('accepts a resolved single-ingredient profile', () => {
    expect(drugProfileWriteSchema.safeParse(resolvedWrite).success).toBe(true);
  });

  it('accepts a resolved multi-ingredient profile (primary stored + full list + limitation)', () => {
    const multi = {
      ...resolvedWrite,
      rxcui: '723',
      resolved_from_rxcui: '617296',
      multi_ingredient: true,
      ingredient_rxcuis: ['723', '48937'],
      multi_ingredient_limitation: 'OnSIDES is single-ingredient-keyed; primary stored.',
    };
    expect(drugProfileWriteSchema.safeParse(multi).success).toBe(true);
  });

  it('accepts both warn-and-disable reasons (unresolved, unresolved_ingredient)', () => {
    expect(
      drugProfileWriteSchema.safeParse({
        label_features_enabled: false,
        reason: 'unresolved',
        rxcui: null,
        resolved_from_rxcui: null,
      }).success,
    ).toBe(true);
    expect(
      drugProfileWriteSchema.safeParse({
        label_features_enabled: false,
        reason: 'unresolved_ingredient',
        rxcui: null,
        resolved_from_rxcui: '855332',
      }).success,
    ).toBe(true);
  });

  it('rejects a resolved profile missing the candidate-provenance field', () => {
    const { resolved_from_rxcui: _omit, ...missing } = resolvedWrite;
    void _omit;
    expect(drugProfileWriteSchema.safeParse(missing).success).toBe(false);
  });

  it('rejects a resolved profile with an empty ingredient list or a blank ingredient rxcui', () => {
    expect(drugProfileWriteSchema.safeParse({ ...resolvedWrite, ingredient_rxcuis: [] }).success).toBe(
      false,
    );
    expect(drugProfileWriteSchema.safeParse({ ...resolvedWrite, rxcui: '   ' }).success).toBe(false);
  });

  it('rejects an unknown warn-and-disable reason', () => {
    expect(
      drugProfileWriteSchema.safeParse({
        label_features_enabled: false,
        reason: 'bogus',
        rxcui: null,
        resolved_from_rxcui: null,
      }).success,
    ).toBe(false);
  });

  it('rejects an arbitrary resolved-profile source outside the closed source enum', () => {
    expect(drugProfileWriteSchema.safeParse({ ...resolvedWrite, source: 'test' }).success).toBe(
      false,
    );
  });
});

describe('drugProfileSourceSchema — closed provenance set for the three-state FDA badge', () => {
  it('accepts exactly the FDA-label and ingredient-only source literals', () => {
    expect(drugProfileSourceSchema.options).toEqual([
      DRUG_PROFILE_SOURCE.FDA_LABEL,
      DRUG_PROFILE_SOURCE.INGREDIENT_ONLY,
    ]);
    expect(drugProfileSourceSchema.safeParse(DRUG_PROFILE_SOURCE.FDA_LABEL).success).toBe(true);
    expect(drugProfileSourceSchema.safeParse(DRUG_PROFILE_SOURCE.INGREDIENT_ONLY).success).toBe(
      true,
    );
    expect(drugProfileSourceSchema.safeParse('openFDA-ish').success).toBe(false);
  });
});

describe('drugProfileSchema — safe dashboard parser with normalized warning arrays', () => {
  it('normalizes nullable warning collections to string arrays', () => {
    const parsed = drugProfileSchema.safeParse({
      ...resolvedWrite,
      boxed_warning: null,
      warnings_and_cautions: null,
      adverse_reactions: null,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.label_features_enabled === false) return;
    expect(parsed.data.boxed_warning).toEqual([]);
    expect(parsed.data.warnings_and_cautions).toEqual([]);
    expect(parsed.data.adverse_reactions).toEqual([]);
  });

  it('preserves string warning collections without widening their members', () => {
    const parsed = drugProfileSchema.safeParse({
      ...resolvedWrite,
      boxed_warning: ['Boxed warning line'],
      warnings_and_cautions: ['Warning line 1', 'Warning line 2'],
      adverse_reactions: ['Nausea'],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.label_features_enabled === false) return;
    expect(parsed.data.boxed_warning).toEqual(['Boxed warning line']);
    expect(parsed.data.warnings_and_cautions).toEqual(['Warning line 1', 'Warning line 2']);
    expect(parsed.data.adverse_reactions).toEqual(['Nausea']);
  });

  it('accepts the ingredient-only source', () => {
    expect(
      drugProfileSchema.safeParse({
        ...resolvedWrite,
        source: DRUG_PROFILE_SOURCE.INGREDIENT_ONLY,
        boxed_warning_present: false,
        boxed_warning: null,
      }).success,
    ).toBe(true);
  });

  it.each([
    ['object', [{ text: 'not a string' }]],
    ['number', [42]],
  ])('degrades a warning array containing a %s without collapsing sibling fields', (_, value) => {
    const parsed = drugProfileSchema.safeParse({
      ...resolvedWrite,
      warnings_and_cautions: value,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.label_features_enabled === false) return;
    expect(parsed.data.warnings_and_cautions).toEqual([]);
    expect(parsed.data.boxed_warning_present).toBe(true);
    expect(parsed.data.dpd).toEqual(resolvedWrite.dpd);
    expect(parsed.data.source).toBe(DRUG_PROFILE_SOURCE.FDA_LABEL);
  });

  it('normalizes a missing warning collection to an empty array', () => {
    const { adverse_reactions: _omitted, ...withoutAdverseReactions } = resolvedWrite;
    void _omitted;
    const parsed = drugProfileSchema.safeParse(withoutAdverseReactions);
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.label_features_enabled === false) return;
    expect(parsed.data.adverse_reactions).toEqual([]);
    expect(parsed.data.boxed_warning_present).toBe(true);
  });

  it('accepts unresolved profiles and fails safely on malformed resolved profiles', () => {
    expect(
      drugProfileSchema.safeParse({
        label_features_enabled: false,
        reason: 'unresolved',
        rxcui: null,
        resolved_from_rxcui: null,
      }).success,
    ).toBe(true);
    expect(
      drugProfileSchema.safeParse({
        label_features_enabled: true,
        source: DRUG_PROFILE_SOURCE.FDA_LABEL,
      }).success,
    ).toBe(false);
  });
});
