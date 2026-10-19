// @vitest-environment node
//
// L1 — PKCE primitive unit tests. The verifyIdToken accept/reject matrix lives in
// dashboard/middleware.test.ts (SC2); this file pins the PKCE helpers that were
// untested: the S256 code_challenge derivation (against the RFC 7636 vector) and
// the code_verifier entropy/charset shape (RFC 7636 §4.1).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { codeChallengeS256, generateCodeVerifier, generateState, refreshIdToken } from './auth';

// RFC 7636 §4.1: verifier = 43-128 chars of unreserved [A-Za-z0-9-._~]; our
// generator emits base64url (a subset: [A-Za-z0-9-_]), no padding.
const BASE64URL = /^[A-Za-z0-9\-_]+$/;

describe('codeChallengeS256 — RFC 7636 Appendix B test vector', () => {
  it('derives the canonical S256 challenge for the RFC verifier', async () => {
    // RFC 7636 Appendix B worked example.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const expected = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    await expect(codeChallengeS256(verifier)).resolves.toBe(expected);
  });

  it('produces a 43-char, padding-free base64url digest for an arbitrary verifier', async () => {
    const challenge = await codeChallengeS256('some-other-verifier-value');
    expect(challenge).toMatch(BASE64URL);
    expect(challenge.length).toBe(43); // base64url of a 32-byte SHA-256 digest
    expect(challenge).not.toContain('=');
  });
});

describe('generateCodeVerifier — RFC 7636 §4.1 entropy/charset', () => {
  it('returns a 43-128 char base64url string', () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(BASE64URL);
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(v).not.toContain('='); // no padding
  });

  it('is non-deterministic across calls (high entropy)', () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });
});

describe('generateState — opaque CSRF binding value (H3)', () => {
  it('returns a non-empty base64url string and is non-deterministic', () => {
    const a = generateState();
    const b = generateState();
    expect(a).toMatch(BASE64URL);
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});

// Slice A item 2 — refreshIdToken. The Cognito client has no
// RefreshTokenRotation, so the refresh token is reusable and concurrent
// refreshes are safe (see the comment on refreshIdToken itself).
describe('refreshIdToken — public-client refresh_token grant', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.COGNITO_REGION = 'us-east-1';
    process.env.COGNITO_USER_POOL_ID = 'us-east-1_TESTPOOL';
    process.env.COGNITO_CLIENT_ID = 'test-client-id-abc123';
    process.env.COGNITO_DOMAIN = 'https://medadhere.auth.us-east-1.amazoncognito.com';
    process.env.COGNITO_REDIRECT_URI = 'http://localhost:3000/api/auth/callback';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('POSTs the refresh_token grant to /oauth2/token and returns the new id_token on 2xx', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id_token: 'new-id-token-value' }), { status: 200 }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshIdToken('the-refresh-token');

    expect(result).toBe('new-id-token-value');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://medadhere.auth.us-east-1.amazoncognito.com/oauth2/token');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded',
    );
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe('test-client-id-abc123');
    expect(body.get('refresh_token')).toBe('the-refresh-token');
  });

  it('returns undefined on a non-2xx response', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
      ) as unknown as typeof fetch;

    await expect(refreshIdToken('a-revoked-refresh-token')).resolves.toBeUndefined();
  });

  it('returns undefined when the 2xx body has no id_token', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'x' }), { status: 200 }),
      ) as unknown as typeof fetch;

    await expect(refreshIdToken('some-refresh-token')).resolves.toBeUndefined();
  });

  it('returns undefined instead of throwing on a network error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    await expect(refreshIdToken('some-refresh-token')).resolves.toBeUndefined();
  });

  it('bounds the request with an abort signal — this call sits on the edge hot path', async () => {
    // Reached from middleware on EVERY protected request whose id_token fails verification.
    // Unbounded, a slow Cognito turns IdP latency into total dashboard unavailability instead
    // of the pre-existing degraded-but-navigable redirect.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id_token: 'x' }), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await refreshIdToken('the-refresh-token');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it('returns undefined when the request is aborted by the timeout', async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      ) as unknown as typeof fetch;

    await expect(refreshIdToken('some-refresh-token')).resolves.toBeUndefined();
  });
});
