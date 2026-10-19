// @vitest-environment node
//
// M6 / H1 regression — the logout route was UNTESTED, which is exactly why H1
// (the no-op cookie delete) shipped. Asserts:
//   (a) the redirect targets the Cognito /logout endpoint with client_id + an
//       allow-listed logout_uri derived from the redirect URI origin (M5), and
//   (b) BOTH session cookies (id_token, refresh_token) are CLEARED at Path=/ with
//       an epoch expiry (the H1 regression gate — a no-path delete is a no-op).
//
// Slice B (SIGNIN-DIAGNOSIS.md §3) — after Slice A's refresh flow, the
// refresh_token is a live 30-day credential, so logout must revoke it at
// Cognito's /oauth2/revoke BEFORE redirecting. A revoke failure must never
// block sign-out (fire-and-await inside try/catch).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

function setEnv(): void {
  process.env.COGNITO_REGION = 'us-east-1';
  process.env.COGNITO_USER_POOL_ID = 'us-east-1_TESTPOOL';
  process.env.COGNITO_CLIENT_ID = 'test-client-id';
  process.env.COGNITO_DOMAIN = 'https://medadhere.auth.us-east-1.amazoncognito.com';
  process.env.COGNITO_REDIRECT_URI = 'http://localhost:3000/api/auth/callback';
  process.env.DATA_API_URL = 'https://data.example.com';
}

/** Return the individual Set-Cookie directive string for a given cookie name. */
function setCookieFor(res: { headers: Headers }, name: string): string | undefined {
  const all = (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie();
  return all.find((c) => c.toLowerCase().startsWith(`${name.toLowerCase()}=`));
}

function makeReq(cookieHeader = ''): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/logout', {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
}

beforeEach(() => {
  setEnv();
});

describe('logout — M5 redirect contract + H1 cookie-clear regression', () => {
  it('(a) redirects to the Cognito /logout with client_id + an allow-listed logout_uri', async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(302);

    const location = res.headers.get('location')!;
    expect(location).toBeDefined();
    const url = new URL(location);
    // The Cognito /logout endpoint (managed-login domain).
    expect(url.origin).toBe('https://medadhere.auth.us-east-1.amazoncognito.com');
    expect(url.pathname).toBe('/logout');
    // M5 — client_id is required or Cognito errors and the session survives.
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    // M5 — logout_uri is derived from the redirect URI origin (the allow-listed
    // sign-out URL pre-seeded on the Cognito client), so it can never drift.
    expect(url.searchParams.get('logout_uri')).toBe('http://localhost:3000/');
  });

  it('(b) H1 — clears id_token AND refresh_token at Path=/ with an epoch expiry', async () => {
    const res = await GET(makeReq());
    // The H1 regression gate: a no-path delete is a NO-OP on Path=/ cookies, so the
    // session would survive logout. Each session cookie MUST be cleared at Path=/.
    for (const name of ['id_token', 'refresh_token']) {
      const c = setCookieFor(res, name)!;
      expect(c, `${name} cleared`).toBeDefined();
      expect(c).toMatch(new RegExp(`^${name}=;`)); // empty value
      expect(c).toContain('Path=/'); // H1 — same path it was written with
      expect(c).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT'); // epoch expiry == Max-Age 0 deletion
    }
  });
});

describe('logout — Slice B revoke-before-redirect', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('revoke-success: POSTs token+client_id to /oauth2/revoke before redirecting, and still clears cookies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await GET(makeReq('refresh_token=a-live-refresh-token; id_token=whatever'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://medadhere.auth.us-east-1.amazoncognito.com/oauth2/revoke');
    expect(init.method).toBe('POST');
    const body = init.body as URLSearchParams;
    expect(body.get('token')).toBe('a-live-refresh-token');
    expect(body.get('client_id')).toBe('test-client-id');

    // Still a clean sign-out afterward.
    expect(res.status).toBe(302);
    expect(setCookieFor(res, 'refresh_token')).toBeDefined();
    expect(setCookieFor(res, 'id_token')).toBeDefined();
  });

  it('bounds the revoke with an abort signal so a STALLED Cognito cannot swallow the sign-out response', async () => {
    // A stall is not a rejection: the try/catch below only covers rejections, so without a
    // time bound a slow /oauth2/revoke runs out the platform function budget and the response
    // carrying the two cookie deletions is never produced — a live session after "Sign out".
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await GET(makeReq('refresh_token=a-live-refresh-token'));

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it('revoke-failure-still-signs-out: a throwing/rejected revoke call never blocks sign-out', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await GET(makeReq('refresh_token=a-live-refresh-token'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // No throw propagated — the redirect + cookie clear still happened.
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/logout');
    expect(setCookieFor(res, 'refresh_token')).toBeDefined();
    expect(setCookieFor(res, 'id_token')).toBeDefined();
  });

  it('no-cookie: no refresh_token cookie present → no revoke call is made, sign-out proceeds', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await GET(makeReq());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(302);
    expect(setCookieFor(res, 'refresh_token')).toBeDefined();
    expect(setCookieFor(res, 'id_token')).toBeDefined();
  });
});
