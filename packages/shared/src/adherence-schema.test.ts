import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  AdherenceClassification,
  adherenceClassificationJsonSchema,
} from '@medadhere/shared';

// Bedrock-free unit test (D-16 contract shape, VALIDATION Wave-0 requirement):
// imports only @medadhere/shared, calls no AWS SDK, needs no credentials.
describe('AdherenceClassification (canonical SSOT schema)', () => {
  it('parses the trivial fully-adherent shape', () => {
    const parsed = AdherenceClassification.parse({
      adherence_state: 'taken',
      reason_code: 'none',
      safety_flag: 'none',
    });
    expect(parsed).toEqual({
      adherence_state: 'taken',
      reason_code: 'none',
      safety_flag: 'none',
    });
  });

  it('parses a non-trivial value on all three axes', () => {
    const parsed = AdherenceClassification.parse({
      adherence_state: 'delayed',
      reason_code: 'side_effect',
      safety_flag: 'acute_physical',
    });
    expect(parsed.adherence_state).toBe('delayed');
    expect(parsed.reason_code).toBe('side_effect');
    expect(parsed.safety_flag).toBe('acute_physical');
  });

  it('IN-02: rejects an UNEXPECTED extra key — .strict() is the contract-drift gate (must throw, not silently drop)', () => {
    // The whole point of the D-16 gate is to FAIL LOUD when the classifier output drifts from the
    // contract. A model emitting a stray field (e.g. a `confidence`, or a camelCase `safetyFlag`
    // alongside the snake_case one) must surface — `.strict()` makes `.parse()` THROW on any unknown
    // key. A regression to a non-strict object (silently dropping excess keys) fails this test.
    expect(() =>
      AdherenceClassification.parse({
        adherence_state: 'taken',
        reason_code: 'none',
        safety_flag: 'none',
        EXTRA: 'x', // the excess key .strict() must reject
      }),
    ).toThrow(ZodError);
  });

  it('rejects an out-of-enum adherence_state (the enum is a hard gate)', () => {
    expect(() =>
      AdherenceClassification.parse({
        adherence_state: 'partial', // not a member
        reason_code: 'none',
        safety_flag: 'none',
      }),
    ).toThrow(ZodError);
  });

  it('accepts exactly the four safety_flag enum values and rejects booleans', () => {
    for (const flag of ['none', 'acute_physical', 'crisis', 'medical_question']) {
      expect(
        AdherenceClassification.parse({
          adherence_state: 'taken',
          reason_code: 'none',
          safety_flag: flag,
        }).safety_flag,
      ).toBe(flag);
    }
    // safety_flag is a 4-value enum, NOT a boolean — booleans must be rejected.
    for (const bad of [true, false]) {
      expect(() =>
        AdherenceClassification.parse({
          adherence_state: 'taken',
          reason_code: 'none',
          safety_flag: bad,
        }),
      ).toThrow(ZodError);
    }
  });

  it('generates a self-contained JSON Schema (no $ref/definitions) with all three properties', () => {
    const schema = adherenceClassificationJsonSchema as Record<string, unknown>;
    const serialized = JSON.stringify(schema);
    expect(serialized).not.toContain('$ref');
    expect(serialized).not.toContain('definitions');
    expect(schema.type).toBe('object');
    const properties = schema.properties as Record<string, unknown>;
    expect(properties).toHaveProperty('adherence_state');
    expect(properties).toHaveProperty('reason_code');
    expect(properties).toHaveProperty('safety_flag');
  });
});
