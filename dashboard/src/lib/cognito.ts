/**
 * Cognito URL + env helpers (pure; Edge-safe — no Node-only imports).
 *
 * D-05 (public client): NO `COGNITO_CLIENT_SECRET` is read anywhere. The OAuth
 * flow is PKCE-only (public client) — there is no secret to stash in Amplify's
 * SSR env.
 *
 * H2 (reserved env prefix): the region is read from `COGNITO_REGION`, NEVER the
 * Amplify-reserved AWS-prefixed region var. Amplify Hosting bans the `AWS_*`
 * prefix on user-supplied env vars, so the reserved region var is empty on the
 * deployed SSR host → a malformed issuer/JWKS URL → `jwtVerify` fails for EVERY
 * token. This MUST stay in lockstep with plan 04's Amplify `environmentVariables`
 * (which sets `COGNITO_REGION`, never the reserved AWS-prefixed name).
 */

/** Read a required env var, throwing a clear error if it is absent/empty. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** The Cognito region — `COGNITO_REGION` only (H2: never the reserved AWS-prefixed var). */
export function cognitoRegion(): string {
  return requireEnv('COGNITO_REGION');
}

/** The Cognito user pool id. */
export function cognitoUserPoolId(): string {
  return requireEnv('COGNITO_USER_POOL_ID');
}

/** The public app client id (id_token `aud`). */
export function cognitoClientId(): string {
  return requireEnv('COGNITO_CLIENT_ID');
}

/** The managed-login domain base URL, e.g. https://medadhere.auth.us-east-1.amazoncognito.com */
export function cognitoDomain(): string {
  return requireEnv('COGNITO_DOMAIN').replace(/\/$/, '');
}

/** The full OAuth redirect/callback URI registered on the Cognito client. */
export function cognitoRedirectUri(): string {
  return requireEnv('COGNITO_REDIRECT_URI');
}

/** The base URL of the internal data API (server-to-server target, D-10). */
export function dataApiUrl(): string {
  return requireEnv('DATA_API_URL').replace(/\/$/, '');
}

/**
 * The Cognito issuer URL — the `iss` claim and the JWKS base.
 * `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}`
 */
export function cognitoIssuer(): string {
  return `https://cognito-idp.${cognitoRegion()}.amazonaws.com/${cognitoUserPoolId()}`;
}

/** The Cognito JWKS URL (issuer + the well-known JWKS path). */
export function cognitoJwksUrl(): string {
  return `${cognitoIssuer()}/.well-known/jwks.json`;
}

/** The managed-login `/oauth2/authorize` endpoint. */
export function cognitoAuthorizeUrl(): string {
  return `${cognitoDomain()}/oauth2/authorize`;
}

/** The `/oauth2/token` endpoint (public-client code→token exchange). */
export function cognitoTokenUrl(): string {
  return `${cognitoDomain()}/oauth2/token`;
}

/** The Cognito `/logout` endpoint. */
export function cognitoLogoutUrl(): string {
  return `${cognitoDomain()}/logout`;
}

/** The `/oauth2/revoke` endpoint (Slice B — logout revokes the refresh token). */
export function cognitoRevokeUrl(): string {
  return `${cognitoDomain()}/oauth2/revoke`;
}

/** The Cognito auth domain's origin, e.g. https://medadhere-auth.auth.us-east-1.amazoncognito.com
 *  (Slice C — CSP `form-action` / `connect-src` need the bare origin, not the full domain URL). */
export function cognitoOrigin(): string {
  return new URL(cognitoDomain()).origin;
}

/**
 * Derive the allow-listed sign-out URL from the redirect URI's origin (M5).
 * The Cognito client pre-seeds sign-out URLs as `<origin>/` (plan 01); deriving
 * from the redirect URI origin guarantees we only ever pass an allow-listed
 * `logout_uri` and never trigger a Cognito `redirect_mismatch`.
 */
export function signOutUrl(): string {
  return `${new URL(cognitoRedirectUri()).origin}/`;
}
