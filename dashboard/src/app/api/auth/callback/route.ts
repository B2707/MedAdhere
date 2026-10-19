/**
 * GET /api/auth/callback — finish the public-PKCE OAuth2 flow.
 *
 * H3 / T-02-14 (the SOLE CSRF / auth-code-injection control in a hand-rolled
 * public-PKCE flow): read the `state` query param AND the `state` cookie. If the
 * cookie is ABSENT or the query `state` does NOT match it, ABORT with a redirect
 * and DO NOT call `/oauth2/token` (no token exchange on a missing/mismatched
 * state).
 *
 * D-05 (public client): the code→token exchange sends `code_verifier` ONLY —
 * no client credential and no HTTP Basic authorization header.
 *
 * L5: the session cookies set `secure` host-conditionally —
 * `secure: process.env.NODE_ENV === 'production'` (HTTPS in prod, off on
 * localhost/HTTP) so local login persists. All cookies are httpOnly + lax.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { cognitoClientId, cognitoRedirectUri, cognitoTokenUrl } from '@/lib/cognito';
import {
  ID_TOKEN_COOKIE,
  OAUTH_STATE_COOKIE,
  PKCE_VERIFIER_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from '@/lib/auth';
import { deleteCookie } from '@/lib/cookies';

interface CognitoTokenResponse {
  id_token?: string;
  refresh_token?: string;
  error?: string;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const queryState = url.searchParams.get('state');
  const cookieState = req.cookies.get(OAUTH_STATE_COOKIE)?.value;
  const codeVerifier = req.cookies.get(PKCE_VERIFIER_COOKIE)?.value;

  const loginUrl = new URL('/api/auth/login', req.url);

  // H3 — CSRF/state gate. Absent or mismatched state ⇒ NO token exchange.
  if (!queryState || !cookieState || queryState !== cookieState) {
    return NextResponse.redirect(loginUrl, { status: 302 });
  }

  // Missing the authorization code or the PKCE verifier ⇒ cannot exchange.
  if (!code || !codeVerifier) {
    return NextResponse.redirect(loginUrl, { status: 302 });
  }

  // Public-client code→token exchange: code_verifier ONLY, no credential header.
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cognitoClientId(),
    code,
    redirect_uri: cognitoRedirectUri(),
    code_verifier: codeVerifier,
  });

  const tokenRes = await fetch(cognitoTokenUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!tokenRes.ok) {
    return NextResponse.redirect(loginUrl, { status: 302 });
  }

  const tokens = (await tokenRes.json()) as CognitoTokenResponse;
  if (!tokens.id_token) {
    return NextResponse.redirect(loginUrl, { status: 302 });
  }

  // L5: Secure is host-conditional so localhost (HTTP) login persists.
  const secure = process.env.NODE_ENV === 'production';
  const res = NextResponse.redirect(new URL('/patients', req.url), { status: 302 });

  res.cookies.set(ID_TOKEN_COOKIE, tokens.id_token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
  });
  if (tokens.refresh_token) {
    // L6: consumed by the middleware refresh path (`refreshIdToken`, SIGNIN-DIAGNOSIS.md
    // §3 Slice A) and revoked at sign-out (Slice B) — no longer inert.
    res.cookies.set(REFRESH_TOKEN_COOKIE, tokens.refresh_token, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
    });
  }

  // Clear the short-lived PKCE/state cookies now that the exchange succeeded.
  // H1/CR-01 — delete at Path=/ (the path they were written with) so the
  // verifier/state are actually burned on use, not left to their 10-min maxAge.
  deleteCookie(res, PKCE_VERIFIER_COOKIE);
  deleteCookie(res, OAUTH_STATE_COOKIE);

  return res;
}
