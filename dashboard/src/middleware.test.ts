// @vitest-environment node
//
// SC2 — the single most important security test in Phase 2.
//
// Table-driven NEGATIVE-path verification of the Edge `jose` JWT gate. Tokens
// are minted HERMETICALLY with `jose`'s generateKeyPair('RS256') + SignJWT
// against a LOCAL in-memory JWKS — no live Cognito (RESEARCH Wave 0 Gaps).
//
// The verifier (`verifyIdToken`) accepts an injectable JWKS so the suite runs
// with no network. Each row asserts ACCEPT (NextResponse.next, no redirect) or
// REJECT (302 → /api/auth/login).
//
// M6: an `alg:none` / HS256-confusion token is included as an explicit reject
// row — the `algorithms: ['RS256']` constraint is PROVEN, not just claimed.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, type JWK, type CryptoKey } from 'jose';
import { NextRequest } from 'next/server';
import { verifyIdToken, __setJwksForTest } from './lib/auth';
import { config, middleware } from './middleware';

// Hermetic issuer/audience used for the whole suite.
const ISS = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL';
const AUD = 'test-client-id-abc123';
const KID = 'test-key-1';

let privateKey: CryptoKey;
let publicJwk: JWK;
// A local JWKS resolver: returns our public key for the matching kid.
let localJwks: (header: { kid?: string; alg?: string }) => Promise<CryptoKey>;

// Build the env the cognito helpers read (the middleware path uses them).
function setCognitoEnv(): void {
  process.env.COGNITO_REGION = 'us-east-1';
  process.env.COGNITO_USER_POOL_ID = 'us-east-1_TESTPOOL';
  process.env.COGNITO_CLIENT_ID = AUD;
  process.env.COGNITO_DOMAIN = 'https://medadhere.auth.us-east-1.amazoncognito.com';
  process.env.COGNITO_REDIRECT_URI = 'http://localhost:3000/api/auth/callback';
  process.env.DATA_API_URL = 'https://data.example.com';
}

beforeAll(async () => {
  setCognitoEnv();
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  const importedPublic = kp.publicKey;
  publicJwk = await exportJWK(importedPublic);
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  localJwks = async () => importedPublic;
});

// Mint a valid RS256 id_token, overriding claims/headers per the test row.
async function mintToken(opts: {
  iss?: string;
  aud?: string;
  tokenUse?: string;
  expiresIn?: string; // jose time string, e.g. '1h' or '-1h'
  tamper?: boolean;
}): Promise<string> {
  const jwt = await new SignJWT({ token_use: opts.tokenUse ?? 'id' })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuedAt()
    .setIssuer(opts.iss ?? ISS)
    .setAudience(opts.aud ?? AUD)
    .setExpirationTime(opts.expiresIn ?? '1h')
    .sign(privateKey);
  if (opts.tamper) {
    // Corrupt a byte deep in the signature so the RS256 check reliably fails.
    // Flipping a trailing base64url char is unreliable (padding bits can decode
    // to the same signature bytes), so decode → flip a middle byte → re-encode.
    const parts = jwt.split('.');
    const sig = parts[2]!;
    const raw = Buffer.from(sig, 'base64url');
    const mid = Math.floor(raw.length / 2);
    raw[mid] = raw[mid]! ^ 0xff; // guaranteed different signature byte
    const tampered = raw.toString('base64url');
    return `${parts[0]}.${parts[1]}.${tampered}`;
  }
  return jwt;
}

describe('verifyIdToken — SC2 hermetic accept/reject matrix (M6 RS256 alg-pin)', () => {
  it('ACCEPTS a valid RS256 id_token (correct iss, aud, token_use=id)', async () => {
    const token = await mintToken({});
    const payload = await verifyIdToken(token, localJwks, { issuer: ISS, audience: AUD });
    expect(payload.token_use).toBe('id');
  });

  it('REJECTS a token with a tampered signature', async () => {
    const token = await mintToken({ tamper: true });
    await expect(verifyIdToken(token, localJwks, { issuer: ISS, audience: AUD })).rejects.toThrow();
  });

  it('REJECTS an expired token (exp in the past)', async () => {
    const token = await mintToken({ expiresIn: '-1h' });
    await expect(verifyIdToken(token, localJwks, { issuer: ISS, audience: AUD })).rejects.toThrow();
  });

  it('REJECTS a token with the wrong issuer', async () => {
    const token = await mintToken({ iss: 'https://evil.example.com/pool' });
    await expect(verifyIdToken(token, localJwks, { issuer: ISS, audience: AUD })).rejects.toThrow();
  });

  it('REJECTS a token with the wrong audience', async () => {
    const token = await mintToken({ aud: 'some-other-client' });
    await expect(verifyIdToken(token, localJwks, { issuer: ISS, audience: AUD })).rejects.toThrow();
  });

  it('REJECTS a token whose token_use is not "id" (e.g. an access_token)', async () => {
    const token = await mintToken({ tokenUse: 'access' });
    await expect(verifyIdToken(token, localJwks, { issuer: ISS, audience: AUD })).rejects.toThrow();
  });

  it('M6: REJECTS an alg-confusion token (HS256 instead of RS256)', async () => {
    // Mint an HS256-signed token (symmetric) — alg-confusion attack shape.
    const secret = new TextEncoder().encode('a'.repeat(32));
    const hsToken = await new SignJWT({ token_use: 'id' })
      .setProtectedHeader({ alg: 'HS256', kid: KID })
      .setIssuedAt()
      .setIssuer(ISS)
      .setAudience(AUD)
      .setExpirationTime('1h')
      .sign(secret);
    // Even if the resolver returned a key, algorithms:['RS256'] must reject HS256.
    await expect(
      verifyIdToken(hsToken, localJwks, { issuer: ISS, audience: AUD }),
    ).rejects.toThrow();
  });

  it('M6: REJECTS an alg:none unsigned token', async () => {
    // Build an unsigned alg:none token by hand (jose will not sign alg:none).
    const enc = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj))
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    const header = enc({ alg: 'none', kid: KID });
    const body = enc({
      iss: ISS,
      aud: AUD,
      token_use: 'id',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const noneToken = `${header}.${body}.`;
    await expect(
      verifyIdToken(noneToken, localJwks, { issuer: ISS, audience: AUD }),
    ).rejects.toThrow();
  });
});

describe('middleware — SC2 redirect behavior', () => {
  // Point the middleware's module-scoped JWKS at our local key (hermetic).
  beforeAll(() => {
    __setJwksForTest(localJwks);
  });

  // M2 — reset the module-global JWKS so the hermetic test key does NOT leak to
  // any later suite in the same Vitest worker (which would silently verify against
  // the leftover test key instead of the real createRemoteJWKSet).
  afterAll(() => {
    __setJwksForTest(undefined);
  });

  // Minimal NextRequest-like stub: middleware only reads cookies + url + headers.
  // `headers` is a real `Headers` (Slice A reads it for the Next-Action/RSC
  // method-aware check on the unauthenticated path — see the dedicated
  // refresh-flow describe block below for the cases that exercise it).
  function makeReq(idToken?: string) {
    return {
      url: 'http://localhost:3000/patients',
      nextUrl: new URL('http://localhost:3000/patients'),
      headers: new Headers(),
      cookies: {
        get: (name: string) =>
          name === 'id_token' && idToken ? { name, value: idToken } : undefined,
      },
    } as unknown as Parameters<typeof middleware>[0];
  }

  it('REDIRECTS (302 → /api/auth/login) when the id_token cookie is missing', async () => {
    const res = await middleware(makeReq(undefined));
    // Slice A item 4 (§2.C fix): document navigations get an EXPLICIT 302, not
    // NextResponse.redirect's method-preserving 307 default — a 307 on a POST
    // gets re-issued as a POST to the GET-only /api/auth/login route → 405.
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/api/auth/login');
  });

  it('REDIRECTS when the id_token cookie holds an invalid token', async () => {
    const res = await middleware(makeReq('not-a-valid-jwt'));
    expect(res.status).toBe(302); // Slice A item 4 — explicit 302, no refresh_token cookie present
    expect(res.headers.get('location')).toContain('/api/auth/login');
  });

  it('ALLOWS the request (no redirect) for a valid id_token', async () => {
    const token = await mintToken({});
    const res = await middleware(makeReq(token));
    // NextResponse.next() has no location header and a 200 status.
    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBe(200); // L3 — assert the pass-through status, not just the absent redirect
  });
});

describe('middleware — DEV_AUTH_BYPASS is local-only', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Minimal NextRequest-like stub: the production path never reaches cookies.set().
  function makeReq() {
    return {
      url: 'http://localhost:3000/patients',
      nextUrl: new URL('http://localhost:3000/patients'),
      headers: new Headers(),
      cookies: { get: () => undefined },
    } as unknown as Parameters<typeof middleware>[0];
  }

  it('is inert in production — an unauthenticated request still redirects to login', async () => {
    vi.stubEnv('DEV_AUTH_BYPASS', '1');
    vi.stubEnv('NODE_ENV', 'production');

    const res = await middleware(makeReq());

    expect(res.headers.get('location')).toContain('/api/auth/login');
  });
});

describe('middleware — Slice A refresh flow (SIGNIN-DIAGNOSIS.md §3 Slice A item 6)', () => {
  // Point the middleware's module-scoped JWKS at our local key (hermetic) —
  // same seam the SC2 redirect-behavior block above uses.
  beforeAll(() => {
    __setJwksForTest(localJwks);
  });

  afterAll(() => {
    __setJwksForTest(undefined);
  });

  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // A real NextRequest (not the hand-rolled stub above) — the refresh-success
  // path calls `NextResponse.next({ request: req })`, which requires
  // `req.headers` to be a genuine `Headers` instance (Next throws otherwise).
  function makeReq(cookieHeader: string, extraHeaders: Record<string, string> = {}): NextRequest {
    return new NextRequest('http://localhost:3000/patients', {
      headers: { cookie: cookieHeader, ...extraHeaders },
    });
  }

  it('expired id_token + valid refresh_token → next() with a refreshed id_token cookie, no redirect', async () => {
    const expired = await mintToken({ expiresIn: '-1h' });
    // The refreshed token must survive the SAME verification pin as the cookie path, so the
    // mock returns a genuinely valid RS256 id_token rather than an opaque string.
    const refreshed = await mintToken({});
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id_token: refreshed }), { status: 200 }),
      ) as unknown as typeof fetch;

    const res = await middleware(
      makeReq(`id_token=${expired}; refresh_token=a-valid-refresh-token`),
    );

    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('set-cookie')).toContain(`id_token=${refreshed}`);
    // The SAME request's downstream RSC render/apiFetch must see the new token too.
    expect(res.headers.get('x-middleware-request-cookie')).toContain(`id_token=${refreshed}`);
  });

  it('a refreshed token that does NOT verify is rejected, not authorized (no unbounded re-mint loop)', async () => {
    const expired = await mintToken({ expiresIn: '-1h' });
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id_token: 'not-a-verifiable-jwt' }), { status: 200 }),
      ) as unknown as typeof fetch;

    const res = await middleware(
      makeReq(`id_token=${expired}; refresh_token=a-valid-refresh-token`),
    );

    // Never set as the session cookie, never granted access.
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/api/auth/login');
    expect(res.headers.get('set-cookie') ?? '').not.toContain('not-a-verifiable-jwt');
  });

  it('refresh_token WITHOUT any id_token cookie never reaches Cognito (anonymous amplification guard)', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    // id_token and refresh_token are written and dropped together as session cookies, so a
    // legitimate browser cannot produce this shape — only a crafted request can.
    const res = await middleware(makeReq('refresh_token=forged-or-replayed'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/api/auth/login');
  });

  it('expired id_token + no refresh_token cookie → 302 to /api/auth/login', async () => {
    const expired = await mintToken({ expiresIn: '-1h' });

    const res = await middleware(makeReq(`id_token=${expired}`));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/api/auth/login');
  });

  it('expired id_token + refresh rejected by Cognito → 302 to /api/auth/login', async () => {
    const expired = await mintToken({ expiresIn: '-1h' });
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
      ) as unknown as typeof fetch;

    const res = await middleware(
      makeReq(`id_token=${expired}; refresh_token=a-revoked-refresh-token`),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/api/auth/login');
  });

  it('a Next-Action request on an expired, unrefreshable session never gets a cross-origin-bound redirect (§2.C)', async () => {
    const expired = await mintToken({ expiresIn: '-1h' });

    const res = await middleware(makeReq(`id_token=${expired}`, { 'next-action': 'deadbeef' }));

    // Not a redirect at all (so never a 307 that a POST re-issues to the
    // GET-only /api/auth/login route, and never a 302 a fetch can't follow
    // cross-origin to Cognito) — a same-origin response the action surface renders.
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('middleware config.matcher — SC2 regression guard for the live-surfaced auth bypass', () => {
  // The matcher decides whether the gate runs AT ALL. The redirect tests above call
  // middleware() directly and bypass Next's matcher entirely, so they would stay green
  // even if the matcher regressed. Dropping the bare `/patients` (leaving only
  // `/patients/:path*`, which does NOT match the exact `/patients` under path-to-regexp)
  // was the live-surfaced SC2 bypass — the page rendered un-gated. This is the ONLY
  // guard against that re-regression.
  it('gates BOTH the bare /patients and any sub-path', () => {
    expect(Array.isArray(config.matcher)).toBe(true);
    const matcher = config.matcher as string[];
    expect(matcher).toContain('/patients'); // bare path — dropping this was the live bug
    expect(matcher).toContain('/patients/:path*'); // sub-paths
  });

  it('U-35: gates BOTH the bare /reviews route and every review sub-path', () => {
    expect(config.matcher).toEqual([
      '/patients',
      '/patients/:path*',
      '/reviews',
      '/reviews/:path*',
    ]);
  });

  it('sec-L1: compiled matchers gate protected route shapes and exclude public routes', () => {
    const compileNextMatcher = (pattern: string): RegExp => {
      const catchAllSuffix = '/:path*';
      const isCatchAll = pattern.endsWith(catchAllSuffix);
      const literal = isCatchAll ? pattern.slice(0, -catchAllSuffix.length) : pattern;
      const escapedLiteral = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(isCatchAll ? `^${escapedLiteral}/.+$` : `^${escapedLiteral}$`);
    };
    const matchers = (config.matcher as string[]).map(compileNextMatcher);
    const isProtected = (pathname: string) => matchers.some((matcher) => matcher.test(pathname));

    for (const pathname of [
      '/patients',
      '/patients/new',
      '/patients/3d594650-6aef-49bc-aad4-02876707efbf',
      '/reviews',
      '/reviews/safety',
      '/reviews/unknown',
    ]) {
      expect(isProtected(pathname), `${pathname} should match a middleware pattern`).toBe(true);
    }

    for (const pathname of ['/', '/api/auth/login']) {
      expect(isProtected(pathname), `${pathname} should remain outside middleware`).toBe(false);
    }
  });
});
