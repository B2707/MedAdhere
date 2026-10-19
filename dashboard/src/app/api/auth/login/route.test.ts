// @vitest-environment node
//
// M6 / L1 / D-05 — the login route was UNTESTED (one of the two most
// security-coupled endpoints). Asserts the authorize URL carries the public-PKCE
// shape (response_type=code, code_challenge_method=S256, a base64url
// code_challenge, the full openid email profile scope), sets the pkce_verifier +
// oauth_state cookies httpOnly + SameSite=lax, and leaks NO client secret (D-05 —
// public client, PKCE only).

import { describe, it, expect, beforeEach } from 'vitest';
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

// RFC 7636 base64url: 43-128 chars of [A-Za-z0-9-_], no padding.
const BASE64URL = /^[A-Za-z0-9\-_]+$/;

beforeEach(() => {
  setEnv();
});

describe('login — public-PKCE authorize URL + cookie contract (M6/L1/D-05)', () => {
  it('builds the /oauth2/authorize URL with the public-PKCE S256 shape + full scope', async () => {
    const res = await GET();
    expect(res.status).toBe(302);

    const url = new URL(res.headers.get('location')!);
    expect(url.origin).toBe('https://medadhere.auth.us-east-1.amazoncognito.com');
    expect(url.pathname).toBe('/oauth2/authorize');

    const q = url.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe('test-client-id');
    expect(q.get('redirect_uri')).toBe('http://localhost:3000/api/auth/callback');
    expect(q.get('code_challenge_method')).toBe('S256');
    // M3 — request the full scope the Cognito client is provisioned with.
    expect(q.get('scope')).toBe('openid email profile');
    // state present (CSRF binding, H3).
    expect(q.get('state')).toBeTruthy();

    // L1 — the code_challenge is a base64url SHA-256 digest: 43 chars, no padding.
    const challenge = q.get('code_challenge')!;
    expect(challenge).toBeTruthy();
    expect(challenge).toMatch(BASE64URL);
    expect(challenge.length).toBe(43); // base64url of a 32-byte SHA-256 digest
    expect(challenge).not.toContain('='); // no padding
  });

  it('sets pkce_verifier + oauth_state cookies httpOnly + SameSite=lax', async () => {
    const res = await GET();
    for (const name of ['pkce_verifier', 'oauth_state']) {
      const c = setCookieFor(res, name)!;
      expect(c, `${name} Set-Cookie present`).toBeDefined();
      expect(c.toLowerCase(), `${name} HttpOnly`).toContain('httponly');
      expect(c.toLowerCase(), `${name} SameSite=lax`).toContain('samesite=lax');
      expect(c).toContain('Path=/');
    }
  });

  it('D-05 — leaks NO client secret anywhere (public client, PKCE only)', async () => {
    const res = await GET();
    const location = res.headers.get('location') ?? '';
    const cookies = (res.headers as unknown as { getSetCookie: () => string[] })
      .getSetCookie()
      .join(' ');
    const blob = `${location} ${cookies}`.toLowerCase();
    expect(blob).not.toContain('client_secret');
    expect(blob).not.toContain('clientsecret');
  });
});
