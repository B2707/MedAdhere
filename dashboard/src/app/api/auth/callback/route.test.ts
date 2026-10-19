// @vitest-environment node
//
// H3 / M9 — the owning hermetic test for SC1's id_token-issuance path + the
// state/CSRF control (T-02-14). Mocks the `/oauth2/token` fetch entirely — no
// live Cognito. Asserts:
//   (a) state-match → token POST is called with code_verifier +
//       grant_type=authorization_code, NO client_secret / NO Basic header, then
//       id_token/refresh_token cookies set + 302 to /patients;
//   (b) state-absent → redirect, token-exchange fetch NEVER called;
//   (c) state-mismatch → redirect, token-exchange fetch NEVER called.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { GET } from './route';

const TOKEN_URL = 'https://medadhere.auth.us-east-1.amazoncognito.com/oauth2/token';

/** Return the individual Set-Cookie directive string for a given cookie name. */
function setCookieFor(res: { headers: Headers }, name: string): string | undefined {
  const all = (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie();
  return all.find((c) => c.toLowerCase().startsWith(`${name.toLowerCase()}=`));
}

function setEnv(): void {
  process.env.COGNITO_REGION = 'us-east-1';
  process.env.COGNITO_USER_POOL_ID = 'us-east-1_TESTPOOL';
  process.env.COGNITO_CLIENT_ID = 'test-client-id';
  process.env.COGNITO_DOMAIN = 'https://medadhere.auth.us-east-1.amazoncognito.com';
  process.env.COGNITO_REDIRECT_URI = 'http://localhost:3000/api/auth/callback';
  process.env.DATA_API_URL = 'https://data.example.com';
}

// Build a NextRequest-like object the route handler reads (url + cookies).
function makeReq(opts: {
  code?: string;
  queryState?: string;
  cookieState?: string;
  verifier?: string;
}) {
  const url = new URL('http://localhost:3000/api/auth/callback');
  if (opts.code) url.searchParams.set('code', opts.code);
  if (opts.queryState) url.searchParams.set('state', opts.queryState);
  const cookies = new Map<string, string>();
  if (opts.cookieState) cookies.set('oauth_state', opts.cookieState);
  if (opts.verifier) cookies.set('pkce_verifier', opts.verifier);
  return {
    url: url.toString(),
    cookies: {
      get: (name: string) =>
        cookies.has(name) ? { name, value: cookies.get(name)! } : undefined,
    },
  } as unknown as Parameters<typeof GET>[0];
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setEnv();
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ id_token: 'ID.TOKEN.X', refresh_token: 'REFRESH.X' }),
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('callback — H3/M9 state/CSRF + public-PKCE token exchange', () => {
  it('(a) state-match: POSTs the public-client token exchange and sets cookies + 302 to /patients', async () => {
    const res = await GET(
      makeReq({ code: 'AUTHCODE', queryState: 's1', cookieState: 's1', verifier: 'VER123' }),
    );

    // The token exchange WAS called, exactly once, at the token URL.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(calledUrl).toBe(TOKEN_URL);
    expect((init as RequestInit).method).toBe('POST');

    // M9 — body contains code_verifier + grant_type, NO client_secret.
    const body = (init as RequestInit).body as URLSearchParams;
    const bodyStr = body.toString();
    expect(bodyStr).toContain('code_verifier=VER123');
    expect(bodyStr).toContain('grant_type=authorization_code');
    expect(bodyStr).not.toContain('client_secret');

    // M9 — NO Authorization: Basic header (public client).
    const headers = ((init as RequestInit).headers ?? {}) as Record<string, string>;
    const headerValues = Object.values(headers).join(' ').toLowerCase();
    expect(headerValues).not.toContain('basic');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');

    // Redirect to /patients with the session cookies set.
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/patients');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('id_token=');
    expect(setCookie).toContain('refresh_token=');

    // M4 — BOTH session cookies MUST be HttpOnly + SameSite=lax (XSS theft block,
    // T-02-13 / CSRF defense, T-02-14). Assert per-cookie so a dropped flag on one
    // cookie cannot hide behind the other (case-insensitive — header casing varies).
    for (const name of ['id_token', 'refresh_token']) {
      const c = setCookieFor(res, name)!;
      expect(c, `${name} Set-Cookie present`).toBeDefined();
      expect(c.toLowerCase(), `${name} HttpOnly`).toContain('httponly');
      expect(c.toLowerCase(), `${name} SameSite=lax`).toContain('samesite=lax');
    }

    // H1 regression — the short-lived pkce_verifier/oauth_state cookies are CLEARED
    // on a successful callback, at Path=/ (the path they were written with) and with
    // an epoch expiry (the RFC 6265 deletion form ResponseCookies.delete emits). A
    // no-path delete would be a no-op and these would linger their full 10-min maxAge.
    for (const name of ['pkce_verifier', 'oauth_state']) {
      const c = setCookieFor(res, name)!;
      expect(c, `${name} cleared`).toBeDefined();
      expect(c).toMatch(new RegExp(`^${name}=;`)); // empty value
      expect(c).toContain('Path=/'); // H1 — cleared at the same path it was written
      expect(c).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT'); // epoch expiry == Max-Age 0 deletion
    }
  });

  it('(b) state-absent: NO token exchange, redirects to login', async () => {
    const res = await GET(makeReq({ code: 'AUTHCODE', queryState: 's1', verifier: 'VER123' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/api/auth/login');
  });

  it('(c) state-mismatch: NO token exchange, redirects to login', async () => {
    const res = await GET(
      makeReq({ code: 'AUTHCODE', queryState: 'attacker', cookieState: 's1', verifier: 'VER123' }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/api/auth/login');
  });
});

describe('callback — token-exchange FAILURE branches (a failed exchange sets NO session cookie)', () => {
  // The happy/CSRF rows above never exercise a failed exchange, so a regression that
  // set the id_token cookie BEFORE checking tokenRes.ok would pass the whole suite.
  // These rows pin: every failure branch redirects to login and issues no id_token.

  it('(d) token endpoint !ok (e.g. 400 invalid_grant): redirect to login, NO id_token cookie', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'invalid_grant' }) });
    const res = await GET(
      makeReq({ code: 'AUTHCODE', queryState: 's1', cookieState: 's1', verifier: 'VER123' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1); // the exchange WAS attempted
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/api/auth/login');
    expect(setCookieFor(res, 'id_token')).toBeUndefined();
  });

  it('(e) token response ok but missing id_token: redirect to login, NO id_token cookie', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ error: 'no_id_token' }) });
    const res = await GET(
      makeReq({ code: 'AUTHCODE', queryState: 's1', cookieState: 's1', verifier: 'VER123' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/api/auth/login');
    expect(setCookieFor(res, 'id_token')).toBeUndefined();
  });

  it('(f) state valid but authorization code missing: NO token exchange, redirect to login', async () => {
    const res = await GET(makeReq({ queryState: 's1', cookieState: 's1', verifier: 'VER123' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/api/auth/login');
    expect(setCookieFor(res, 'id_token')).toBeUndefined();
  });

  it('(g) state valid but PKCE verifier missing: NO token exchange, redirect to login', async () => {
    const res = await GET(makeReq({ code: 'AUTHCODE', queryState: 's1', cookieState: 's1' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/api/auth/login');
    expect(setCookieFor(res, 'id_token')).toBeUndefined();
  });
});
