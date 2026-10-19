const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ApiGatewayJwtEvent {
  requestContext?: {
    authorizer?: {
      jwt?: {
        claims?: Record<string, unknown>;
      };
    };
  };
}

export class ClinicianClaimsError extends Error {
  constructor() {
    super('Valid clinician ID-token claims are required');
    this.name = 'ClinicianClaimsError';
  }
}

export function requireClinicianClaims(event: unknown): { sub: string } {
  const claims = (event as ApiGatewayJwtEvent | null | undefined)?.requestContext?.authorizer?.jwt
    ?.claims;
  const sub = claims?.sub;

  if (claims?.token_use !== 'id' || typeof sub !== 'string' || !UUID_PATTERN.test(sub)) {
    throw new ClinicianClaimsError();
  }

  return { sub };
}
