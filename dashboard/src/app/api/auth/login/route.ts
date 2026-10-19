/**
 * GET /api/auth/login — start the public-PKCE OAuth2 authorization-code flow.
 *
 * D-04/D-05/D-08: hand-rolled, public client (NO secret), managed login. We
 * build the `/oauth2/authorize` URL with PKCE (S256) + a random `state`, stash
 * the `code_verifier` and `state` in short-lived httpOnly cookies, and 302 to
 * Cognito managed login. We ALWAYS send our own `code_verifier` (Pitfall 2).
 */
import { NextResponse } from 'next/server';
import {
  cognitoAuthorizeUrl,
  cognitoClientId,
  cognitoRedirectUri,
} from '@/lib/cognito';
import {
  OAUTH_STATE_COOKIE,
  PKCE_VERIFIER_COOKIE,
  codeChallengeS256,
  generateCodeVerifier,
  generateState,
} from '@/lib/auth';
import { shortLivedCookieOptions } from '@/lib/cookies';

export async function GET(): Promise<NextResponse> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await codeChallengeS256(codeVerifier);
  const state = generateState();

  const authorize = new URL(cognitoAuthorizeUrl());
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', cognitoClientId());
  authorize.searchParams.set('redirect_uri', cognitoRedirectUri());
  // M3 — request the FULL scope the Cognito client is provisioned with
  // (openid email profile, auth.ts/auth.test.ts) so the id_token carries the
  // clinician's email/profile claims. Requesting only `openid` silently dropped
  // them, leaving any claim-reading feature with `undefined`.
  authorize.searchParams.set('scope', 'openid email profile');
  authorize.searchParams.set('code_challenge', codeChallenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('state', state);

  const res = NextResponse.redirect(authorize, { status: 302 });
  res.cookies.set(PKCE_VERIFIER_COOKIE, codeVerifier, shortLivedCookieOptions());
  res.cookies.set(OAUTH_STATE_COOKIE, state, shortLivedCookieOptions());
  return res;
}
