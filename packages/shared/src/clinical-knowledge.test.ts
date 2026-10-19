import { describe, expect, it } from 'vitest';
import {
  clinicalFactRevisionInputSchema,
  conversationDrugInteractionSchema,
  interactionCoverageResultSchema,
  medicationRevisionInputSchema,
} from './clinical-knowledge.js';

const MEDICATION_ID = '11111111-1111-4111-8111-111111111111';
const SCHEDULE_A = '22222222-2222-4222-8222-222222222222';
const SCHEDULE_B = '33333333-3333-4333-8333-333333333333';

function medicationInput() {
  return {
    enteredName: 'Amoxicillin / clavulanate',
    identity: { system: 'din', code: '02415322' },
    doseText: '875 mg / 125 mg',
    form: 'tablet',
    route: 'oral',
    validFrom: '2026-08-11',
    validTo: null,
    status: 'active',
    supersedesId: null,
    scheduleIds: [SCHEDULE_A, SCHEDULE_B],
    ingredients: [
      { name: 'amoxicillin', ccddIngredientCode: 'TM-AMOX', rxcui: '723' },
      { name: 'clavulanate', ccddIngredientCode: 'TM-CLAV', rxcui: '21212' },
    ],
  };
}

describe('medicationRevisionInputSchema', () => {
  it('preserves every ordered ingredient in a combination product', () => {
    const parsed = medicationRevisionInputSchema.parse(medicationInput());
    expect(parsed.ingredients.map((ingredient) => ingredient.name)).toEqual([
      'amoxicillin',
      'clavulanate',
    ]);
  });

  it('requires identity system/code together and rejects invalid date ranges', () => {
    const base = medicationInput();
    expect(
      medicationRevisionInputSchema.safeParse({
        ...base,
        identity: { system: 'din', code: '' },
      }).success,
    ).toBe(false);
    expect(
      medicationRevisionInputSchema.safeParse({
        ...base,
        validFrom: '2026-08-12',
        validTo: '2026-08-11',
      }).success,
    ).toBe(false);
  });

  it('is strict, bounded, and requires at least one ingredient', () => {
    const base = medicationInput();
    expect(medicationRevisionInputSchema.safeParse({ ...base, surprise: 'ignored' }).success).toBe(
      false,
    );
    expect(
      medicationRevisionInputSchema.safeParse({ ...base, enteredName: 'x'.repeat(321) }).success,
    ).toBe(false);
    expect(medicationRevisionInputSchema.safeParse({ ...base, ingredients: [] }).success).toBe(
      false,
    );
  });

  it('accepts an append-only correction target', () => {
    expect(
      medicationRevisionInputSchema.parse({ ...medicationInput(), supersedesId: MEDICATION_ID })
        .supersedesId,
    ).toBe(MEDICATION_ID);
  });

  it('requires one explicit, unique full schedule selection', () => {
    expect(medicationRevisionInputSchema.parse(medicationInput()).scheduleIds).toEqual([
      SCHEDULE_A,
      SCHEDULE_B,
    ]);
    expect(
      medicationRevisionInputSchema.safeParse({
        ...medicationInput(),
        scheduleIds: [SCHEDULE_A, SCHEDULE_A],
      }).success,
    ).toBe(false);
    expect(
      medicationRevisionInputSchema.safeParse({ ...medicationInput(), scheduleIds: ['not-a-uuid'] })
        .success,
    ).toBe(false);
    const { scheduleIds, ...withoutScheduleSelection } = medicationInput();
    expect(scheduleIds).toEqual([SCHEDULE_A, SCHEDULE_B]);
    expect(medicationRevisionInputSchema.safeParse(withoutScheduleSelection).success).toBe(false);
  });
});

describe('clinicalFactRevisionInputSchema', () => {
  it('accepts a bounded doctor-authored fact revision and rejects extras', () => {
    const fact = {
      factType: 'condition',
      factCode: 'sleep-apnea',
      statementText: 'Sleep apnea diagnosed by the treating clinician.',
      status: 'current',
      supersedesId: null,
    };
    expect(clinicalFactRevisionInputSchema.parse(fact)).toEqual(fact);
    expect(
      clinicalFactRevisionInputSchema.safeParse({ ...fact, agentAuthored: true }).success,
    ).toBe(false);
  });
});

describe('interactionCoverageResultSchema', () => {
  const release = {
    id: '22222222-2222-4222-8222-222222222222',
    version: 'DDInter-2026-08',
    checksumSha256: 'a'.repeat(64),
  };
  const pair = { lowDrugId: 'DDInter1', highDrugId: 'DDInter2' };

  it('distinguishes a found interaction from a complete-release no-record result', () => {
    expect(
      interactionCoverageResultSchema.parse({
        state: 'interaction_found',
        interactionKind: 'drug_drug',
        pair,
        release,
        level: 'major',
      }).state,
    ).toBe('interaction_found');
    expect(
      interactionCoverageResultSchema.parse({
        state: 'checked_no_interaction_record',
        interactionKind: 'drug_drug',
        pair,
        release,
      }).state,
    ).toBe('checked_no_interaction_record');
  });

  it('makes uncovered states explicit and has no safe/no-interaction claim field', () => {
    const parsed = interactionCoverageResultSchema.parse({
      state: 'coverage_unknown',
      interactionKind: 'drug_food',
      reason: 'interaction_kind_unavailable',
      pair: null,
      release: null,
    });
    expect(parsed.state).toBe('coverage_unknown');
    expect('safe' in parsed).toBe(false);
    expect(interactionCoverageResultSchema.safeParse({ ...parsed, safe: true }).success).toBe(
      false,
    );
    expect(
      interactionCoverageResultSchema.parse({
        ...parsed,
        interactionKind: 'drug_drug',
        reason: 'stale_release',
        release,
      }),
    ).toMatchObject({ state: 'coverage_unknown', reason: 'stale_release' });
  });
});

describe('conversationDrugInteractionSchema', () => {
  const release = {
    id: '22222222-2222-4222-8222-222222222222',
    version: 'DDInter-2026-08',
    checksumSha256: 'a'.repeat(64),
  };

  it('keeps only a release-scoped found interaction or explicit unknown coverage', () => {
    expect(
      conversationDrugInteractionSchema.parse({
        state: 'interaction_found',
        source: 'ddinter',
        displayNames: ['Amoxicillin', 'Warfarin'],
        pair: { lowDrugId: 'DD-AMOX', highDrugId: 'DD-WARF' },
        level: 'major',
        release,
      }),
    ).toMatchObject({ state: 'interaction_found', displayNames: ['Amoxicillin', 'Warfarin'] });
    expect(
      conversationDrugInteractionSchema.parse({
        state: 'coverage_unknown',
        source: 'ddinter',
        displayNames: [],
        reason: 'stale_release',
        release,
      }),
    ).toMatchObject({ state: 'coverage_unknown', reason: 'stale_release' });
  });

  it('cannot carry a no-record reassurance or incomplete found provenance', () => {
    expect(
      conversationDrugInteractionSchema.safeParse({
        state: 'checked_no_interaction_record',
        source: 'ddinter',
        displayNames: ['Amoxicillin', 'Clavulanate'],
        pair: { lowDrugId: 'DD-AMOX', highDrugId: 'DD-CLAV' },
        release,
      }).success,
    ).toBe(false);
    expect(
      conversationDrugInteractionSchema.safeParse({
        state: 'interaction_found',
        source: 'ddinter',
        displayNames: ['Amoxicillin'],
        pair: { lowDrugId: 'DD-AMOX', highDrugId: 'DD-WARF' },
        level: 'major',
        release: null,
      }).success,
    ).toBe(false);
  });
});
