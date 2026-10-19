/**
 * Edge `jose` JWT gate for protected dashboard routes (`/patients/*` and
 * `/reviews/*`).
 *
 * This is a UX gate (redirect-to-login) — the REAL security boundary is the
 * API Gateway native JWT authorizer in front of the data API (T-02-16,
 * defense-in-depth). The middleware reads the `id_token` httpOnly cookie and:
 *   - verifies it with `verifyIdToken` (jose, RS256-pinned — M6);
 *   - when that token is PRESENT but does not verify (expired or otherwise
 *     invalid), tries the `refresh_token` cookie against Cognito's
 *     refresh_token grant (Slice A — SIGNIN-DIAGNOSIS.md §3) and verifies the
 *     result with the same pin before accepting it;
 *   - only when there is no usable session does it fall back to the
 *     unauthenticated response, which is METHOD-AWARE (§2.C): a Next-Action /
 *     RSC request gets a same-origin 401 the client surface can render,
 *     never a redirect a `fetch` cannot complete cross-origin to Cognito; a
 *     plain document navigation gets an explicit 302 to `/api/auth/login`.
 *
 * Edge-safe: only `jose` (via `lib/auth`) + `next/server` are imported here —
 * never the Node-only Cognito/JWT verify libs or a DB client (Pitfall 1, D-14).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { ID_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, refreshIdToken, verifyIdToken } from './lib/auth';
import { sessionCookieOptions } from './lib/cookies';

// Gate BOTH each bare dashboard route and its sub-paths. A `/:path*` matcher
// alone does not match the exact bare route under path-to-regexp.
export const config = {
  matcher: ['/patients', '/patients/:path*', '/reviews', '/reviews/:path*'],
};

/**
 * §2.C fix: a Server Action (`Next-Action` header) or an RSC fetch (`RSC: 1`
 * header — e.g. `AutoRefresh`'s `router.refresh()` poller) can never complete
 * a cross-origin OAuth redirect. `NextResponse.redirect` with no explicit
 * status also defaults to 307, which is method-preserving — a POST Server
 * Action re-issued as a POST to the GET-only `/api/auth/login` route 405s.
 * Neither case may get a redirect at all; the surface treats a 401 as
 * "session expired, sign in again".
 */
function isActionOrRscRequest(req: NextRequest): boolean {
  return req.headers.has('next-action') || req.headers.get('rsc') === '1';
}

/** `verifyIdToken` as a boolean — the same RS256/iss/aud/token_use pin, no throw. */
async function isVerifiable(token: string): Promise<boolean> {
  try {
    await verifyIdToken(token);
    return true;
  } catch {
    return false;
  }
}

/** No usable session (no token, or refresh unavailable/rejected). */
function unauthenticatedResponse(req: NextRequest): NextResponse {
  if (isActionOrRscRequest(req)) {
    return new NextResponse(null, { status: 401 });
  }
  const loginUrl = new URL('/api/auth/login', req.url);
  return NextResponse.redirect(loginUrl, { status: 302 });
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  // Local development only; the real boundary is the API Gateway JWT authorizer.
  if (process.env.DEV_AUTH_BYPASS === '1' && process.env.NODE_ENV !== 'production') {
    req.cookies.set(ID_TOKEN_COOKIE, 'dev');
    return NextResponse.next({ request: req });
  }

  const token = req.cookies.get(ID_TOKEN_COOKIE)?.value;
  if (token) {
    try {
      await verifyIdToken(token);
      return NextResponse.next();
    } catch {
      // Missing/expired/invalid — fall through to the refresh attempt below.
      // (Any failure: bad signature, expired, wrong iss/aud, wrong
      // token_use, wrong alg — all treated identically.)
    }
  }

  // An id_token was present but did not verify. Try to mint a fresh one from the
  // refresh_token before giving up — this is the fix for the missing refresh path
  // (§0): a valid session should never force a full re-authorization at the
  // 60-minute id_token TTL. Safe to call concurrently across tabs — see the
  // concurrency note on refreshIdToken (no RefreshTokenRotation).
  //
  // `token &&` is load-bearing: `id_token` and `refresh_token` are written and
  // dropped together as session cookies (cookies.ts `sessionCookieOptions`,
  // callback/route.ts), so a legitimate browser NEVER holds one without the
  // other. Without this guard any anonymous request carrying only a forged
  // `refresh_token=…` header forces a server-side Cognito token exchange —
  // unauthenticated amplification into the pool's token-endpoint quota, which
  // starves the real sign-in code→token exchange once throttled.
  const refreshToken = req.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
  if (token && refreshToken) {
    const newIdToken = await refreshIdToken(refreshToken);
    // The refreshed token is verified with the SAME pin as the cookie path
    // (RS256 / iss / aud / token_use). `refreshIdToken` only checks that the
    // field is a non-empty string, so skipping this both authorizes an
    // unverified token and — when verification fails for a NON-token reason
    // (JWKS unreachable, aud drift, clock skew) — re-mints on every single
    // request forever, with no cap and no backoff.
    if (newIdToken && (await isVerifiable(newIdToken))) {
      req.cookies.set(ID_TOKEN_COOKIE, newIdToken);
      const res = NextResponse.next({ request: req });
      res.cookies.set(ID_TOKEN_COOKIE, newIdToken, sessionCookieOptions());
      return res;
    }
  }

  return unauthenticatedResponse(req);
}
