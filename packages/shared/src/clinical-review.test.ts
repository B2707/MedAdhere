import { describe, expect, it } from 'vitest';
import {
  patientReactivationInputSchema,
  patientReactivationResponseSchema,
  reminderLimitInputSchema,
  reminderLimitResponseSchema,
  reviewDecisionInputSchema,
  reviewDecisionResponseSchema,
} from './clinical-review.js';

const CORRECTION_A = '11111111-1111-4111-8111-111111111111';
const CORRECTION_B = '22222222-2222-4222-8222-222222222222';
const ACTION_ID = '33333333-3333-4333-8333-333333333333';

describe('review decision contracts', () => {
  it('accepts bounded confirmations and rejection-only actions', () => {
    expect(
      reviewDecisionInputSchema.parse({
        decision: 'confirm',
        expectedVersion: 3,
        selectedCorrectionIds: [CORRECTION_A, CORRECTION_B],
      }).selectedCorrectionIds,
    ).toEqual([CORRECTION_A, CORRECTION_B]);
    expect(
      reviewDecisionInputSchema.parse({
        decision: 'reject',
        expectedVersion: 1,
        selectedCorrectionIds: [],
      }).decision,
    ).toBe('reject');
  });

  it('rejects corrections on reject, duplicate IDs, and more than 30 corrections', () => {
    expect(() =>
      reviewDecisionInputSchema.parse({
        decision: 'reject',
        expectedVersion: 1,
        selectedCorrectionIds: [CORRECTION_A],
      }),
    ).toThrow();
    expect(() =>
      reviewDecisionInputSchema.parse({
        decision: 'confirm',
        expectedVersion: 1,
        selectedCorrectionIds: [CORRECTION_A, CORRECTION_A],
      }),
    ).toThrow();
    expect(() =>
      reviewDecisionInputSchema.parse({
        decision: 'confirm',
        expectedVersion: 1,
        selectedCorrectionIds: Array.from(
          { length: 31 },
          (_unused, index) => `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
        ),
      }),
    ).toThrow();
  });

  it('rejects invalid versions and unknown authority fields', () => {
    for (const expectedVersion of [0, -1, 1.5, 2_147_483_648]) {
      expect(() =>
        reviewDecisionInputSchema.parse({
          decision: 'reject',
          expectedVersion,
          selectedCorrectionIds: [],
        }),
      ).toThrow();
    }
    expect(() =>
      reviewDecisionInputSchema.parse({
        decision: 'reject',
        expectedVersion: 1,
        selectedCorrectionIds: [],
        clinicianSub: 'caller-controlled',
      }),
    ).toThrow();
  });

  it('strictly validates the success response', () => {
    expect(
      reviewDecisionResponseSchema.parse({
        decision: 'confirm',
        applied: true,
        actionId: ACTION_ID,
        createdFactIds: [CORRECTION_A],
      }),
    ).toMatchObject({ actionId: ACTION_ID, applied: true });
    expect(() =>
      reviewDecisionResponseSchema.parse({
        decision: 'confirm',
        applied: true,
        actionId: 'not-a-uuid',
        createdFactIds: [],
      }),
    ).toThrow();
    expect(() =>
      reviewDecisionResponseSchema.parse({
        decision: 'reject',
        applied: true,
        actionId: ACTION_ID,
        createdFactIds: [],
        owner: 'leaked',
      }),
    ).toThrow();
  });
});

describe('messaging control contracts', () => {
  it('accepts only reminder limits 0 through 5 with an optimistic version', () => {
    for (const reminderLimit of [0, 1, 2, 5]) {
      expect(
        reminderLimitInputSchema.parse({ expectedVersion: 1, reminderLimit }).reminderLimit,
      ).toBe(reminderLimit);
    }
    for (const reminderLimit of [-1, 6, 2.5]) {
      expect(() => reminderLimitInputSchema.parse({ expectedVersion: 1, reminderLimit })).toThrow();
    }
    expect(() => reminderLimitInputSchema.parse({ reminderLimit: 2 })).toThrow();
  });

  it('allows reactivation to carry only the optimistic version', () => {
    expect(patientReactivationInputSchema.parse({ expectedVersion: 4 }).expectedVersion).toBe(4);
    expect(() =>
      patientReactivationInputSchema.parse({ expectedVersion: 4, providerOptedIn: true }),
    ).toThrow();
  });

  it('strictly validates reminder and reactivation success responses', () => {
    expect(
      reminderLimitResponseSchema.parse({ reminderLimit: 5, messagingStateVersion: 2 }),
    ).toEqual({ reminderLimit: 5, messagingStateVersion: 2 });
    expect(
      patientReactivationResponseSchema.parse({
        reactivated: true,
        agentEnabled: true,
        isActive: false,
        messagingStateVersion: 2,
      }).isActive,
    ).toBe(false);
    expect(() =>
      reminderLimitResponseSchema.parse({
        reminderLimit: 6,
        messagingStateVersion: 2,
      }),
    ).toThrow();
    expect(() =>
      patientReactivationResponseSchema.parse({
        reactivated: false,
        agentEnabled: true,
        isActive: true,
        messagingStateVersion: 2,
      }),
    ).toThrow();
  });
});
