/**
 * GET /api/auth/logout — revoke the refresh token, clear the session, and end
 * the Cognito session.
 *
 * M5: Cognito `/logout` REQUIRES `client_id` + an allow-listed `logout_uri` or
 * it errors and the session survives. We:
 *   1. revoke the `refresh_token` at Cognito's `/oauth2/revoke` (Slice B), then
 *   2. clear the `id_token` AND `refresh_token` cookies, then
 *   3. 302 to `${COGNITO_DOMAIN}/logout?client_id=...&logout_uri=...`
 * where `logout_uri` is derived from the redirect URI's origin so it always
 * matches the allow-list pre-seeded on the Cognito client (plan 01). We never
 * redirect to a non-allow-listed `logout_uri`.
 *
 * Slice B (SIGNIN-DIAGNOSIS.md §3): after Slice A's refresh flow, the
 * `refresh_token` cookie is a live 30-day credential — sign-out that leaves it
 * valid is a real regression. The revoke call is best-effort: any failure
 * (network error, non-2xx from Cognito) is swallowed so it never blocks
 * sign-out — and it is HARD-BOUNDED by `REVOKE_TIMEOUT_MS`, because a *stall*
 * (the common IdP degradation mode) is not a rejection: without the timeout a
 * slow Cognito runs out the platform function budget, the response carrying the
 * two cookie deletions is never produced, and the clinician's session survives a
 * sign-out they believe succeeded.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { cognitoClientId, cognitoLogoutUrl, cognitoRevokeUrl, signOutUrl } from '@/lib/cognito';
import { ID_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from '@/lib/auth';
import { deleteCookie } from '@/lib/cookies';

/** Hard bound on the best-effort revoke. Clearing the session must never wait on Cognito. */
const REVOKE_TIMEOUT_MS = 2000;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const refreshToken = req.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
  if (refreshToken) {
    try {
      await fetch(cognitoRevokeUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
        body: new URLSearchParams({
          token: refreshToken,
          client_id: cognitoClientId(),
        }),
      });
    } catch {
      // Best-effort: a revoke failure must never block sign-out.
    }
  }

  const logout = new URL(cognitoLogoutUrl());
  logout.searchParams.set('client_id', cognitoClientId());
  logout.searchParams.set('logout_uri', signOutUrl());

  const res = NextResponse.redirect(logout, { status: 302 });
  // Clear both session cookies (M5). H1/CR-01 — delete at Path=/ (the path
  // they were written with) or the Set-Cookie does not match and is a NO-OP.
  deleteCookie(res, ID_TOKEN_COOKIE);
  deleteCookie(res, REFRESH_TOKEN_COOKIE);
  return res;
}
