/**
 * Shared `jose` JWT verifier + PKCE helpers + cookie-name constants.
 *
 * Edge-safe: `jose` is Web-Crypto-based (D-07). NEVER import a Node-only Cognito
 * or JWT verify library here — they break on the Edge runtime (Pitfall 1).
 *
 * M6 — the explicit `algorithms: ['RS256']` constraint is load-bearing: it makes
 * `jwtVerify` reject `alg:none` and HS256-confusion tokens at the jose layer.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { cognitoClientId, cognitoIssuer, cognitoJwksUrl, cognitoTokenUrl } from './cognito';

// ── Cookie names ────────────────────────────────────────────────────────────
/** httpOnly cookie holding the Cognito id_token (the verified session token). */
export const ID_TOKEN_COOKIE = 'id_token';
/** httpOnly cookie holding the Cognito refresh_token, consumed by `refreshIdToken` (Slice A). */
export const REFRESH_TOKEN_COOKIE = 'refresh_token';
/** Short-lived httpOnly cookie holding the PKCE code_verifier across the redirect. */
export const PKCE_VERIFIER_COOKIE = 'pkce_verifier';
/** Short-lived httpOnly cookie holding the OAuth `state` (CSRF binding, H3). */
export const OAUTH_STATE_COOKIE = 'oauth_state';

// ── JWKS (module-scoped: jose caches keys + handles rotation per isolate) ─────
let cachedJwks: JWTVerifyGetKey | undefined;

function getRemoteJwks(): JWTVerifyGetKey {
  if (!cachedJwks) {
    cachedJwks = createRemoteJWKSet(new URL(cognitoJwksUrl()));
  }
  return cachedJwks;
}

/**
 * TEST SEAM ONLY — inject a local JWKS so the middleware path verifies against
 * a hermetically-minted key with no live Cognito network call. Pass `undefined`
 * to reset to the real remote JWKS. Never called in production code.
 */
export function __setJwksForTest(jwks: JWTVerifyGetKey | undefined): void {
  cachedJwks = jwks;
}

/**
 * Verify a Cognito id_token.
 *
 * Asserts (D-07 + M6):
 *  - signature against the Cognito JWKS,
 *  - `algorithms: ['RS256']`  → rejects alg:none / HS256-confusion (M6),
 *  - `issuer` === this pool's issuer URL,
 *  - `audience` === the app client id,
 *  - `exp` (with a small clock tolerance),
 *  - `token_use === 'id'` (an access_token would otherwise pass signature checks).
 *
 * @param token  the raw JWT string
 * @param jwks   optional injectable key set — tests pass a local JWKS so the
 *               suite runs hermetically with no live Cognito (RESEARCH Wave 0).
 * @param options optional issuer/audience overrides for hermetic tests.
 * @throws if any assertion fails (the caller treats a throw as "redirect to login").
 */
export async function verifyIdToken(
  token: string,
  jwks?: JWTVerifyGetKey,
  options?: { issuer?: string; audience?: string },
): Promise<JWTPayload> {
  const keySet = jwks ?? getRemoteJwks();
  const { payload } = await jwtVerify(token, keySet, {
    issuer: options?.issuer ?? cognitoIssuer(),
    audience: options?.audience ?? cognitoClientId(),
    algorithms: ['RS256'],
    clockTolerance: 5,
  });
  if (payload.token_use !== 'id') {
    throw new Error(`unexpected token_use: ${String(payload.token_use)}`);
  }
  return payload;
}

/**
 * Exchange a refresh_token for a new id_token (Slice A item 2 — the missing
 * refresh path, SIGNIN-DIAGNOSIS.md §0/§3).
 *
 * Edge-safe: plain `fetch`, no Node-only imports — this file is imported by
 * `middleware.ts` and the "never import a Node-only lib here" rule above is
 * binding.
 *
 * Concurrency note: the Cognito app client has no `RefreshTokenRotation`
 * enabled (confirmed absent from the synthesized CDK template), so the
 * refresh_token is reusable across calls — concurrent/overlapping refreshes
 * (e.g. the 10-second `AutoRefresh` poller firing across multiple tabs at
 * once) are safe and idempotent, each independently exchanging the same
 * refresh_token for a fresh id_token. If rotation is ever enabled on the
 * client, this becomes a race (only the first exchange succeeds) and needs a
 * single-flight guard — not needed today.
 *
 * Hard-bounded by `REFRESH_TIMEOUT_MS`: this now sits on the EDGE HOT PATH for
 * every protected request whose id_token fails verification, so an unbounded
 * call would turn Cognito *latency* into total dashboard *unavailability* (the
 * 10-second `AutoRefresh` poller multiplies the stalled invocations per tab).
 * The abort lands in the catch below → `undefined` → the middleware's existing
 * "refresh unavailable" path, i.e. degraded-but-navigable, as before.
 *
 * @returns the new id_token on a 2xx response with a non-empty `id_token`
 *          field; `undefined` on any other outcome (non-2xx, malformed body,
 *          timeout, or a network/fetch failure) — the caller treats `undefined`
 *          as "refresh unavailable" and falls back to the redirect path.
 */
const REFRESH_TIMEOUT_MS = 2000;

export async function refreshIdToken(refreshToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(cognitoTokenUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: cognitoClientId(),
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { id_token?: unknown };
    return typeof body.id_token === 'string' && body.id_token.length > 0
      ? body.id_token
      : undefined;
  } catch {
    return undefined;
  }
}

// ── PKCE helpers (Web Crypto — Edge-safe) ─────────────────────────────────────

/** base64url-encode raw bytes without padding (RFC 7636 §A). */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generate a high-entropy PKCE code_verifier (43–128 chars, base64url). */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** Compute the S256 code_challenge for a given verifier (Web Crypto SHA-256). */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

/** Generate a random opaque `state` value (CSRF binding, H3). */
export function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}
