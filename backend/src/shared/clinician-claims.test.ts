import { describe, expect, it } from 'vitest';
import { ClinicianClaimsError, requireClinicianClaims } from './clinician-claims';

const CLINICIAN_SUB = '9d2c9a43-1f08-4fac-b1dd-b41fd85bcdd4';

function eventWithClaims(claims: Record<string, unknown>): unknown {
  return {
    requestContext: {
      authorizer: {
        jwt: { claims },
      },
    },
  };
}

describe('requireClinicianClaims', () => {
  it('returns the verified clinician UUID from an API Gateway v2 ID-token authorizer', () => {
    expect(
      requireClinicianClaims(eventWithClaims({ sub: CLINICIAN_SUB, token_use: 'id' })),
    ).toEqual({ sub: CLINICIAN_SUB });
  });

  it.each([
    undefined,
    {},
    eventWithClaims({ sub: CLINICIAN_SUB, token_use: 'access' }),
    eventWithClaims({ sub: '', token_use: 'id' }),
    eventWithClaims({ sub: 'not-a-uuid', token_use: 'id' }),
    eventWithClaims({ sub: 42, token_use: 'id' }),
  ])('rejects missing or invalid verified clinician claims', (event) => {
    expect(() => requireClinicianClaims(event)).toThrow(ClinicianClaimsError);
  });
});
