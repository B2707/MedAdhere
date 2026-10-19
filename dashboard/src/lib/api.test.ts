// @vitest-environment node
//
// Unit tests for the typed Bearer fetch wrapper (06-03a). It formalizes the RSC
// data-fetch pattern in patients/page.tsx:33-55 into one generic helper.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// `server-only` THROWS when imported outside a React Server context (it does under
// vitest/node). Stub it to an empty module so importing api.ts never throws here.
vi.mock('server-only', () => ({}));
// `next/headers` has no implementation outside a Next request scope — mock cookies().
vi.mock('next/headers', () => ({ cookies: vi.fn() }));

import { cookies } from 'next/headers';
import { apiFetch } from './api';

const mockedCookies = vi.mocked(cookies);
const patientsSchema = z.object({
  patients: z.array(z.object({ id: z.string() })),
});

// dataApiUrl() reads DATA_API_URL (throws if unset) — pin a stable base for fetch tests.
process.env.DATA_API_URL = 'https://data.example.test';

type CookieStore = Awaited<ReturnType<typeof cookies>>;

/** Point cookies() at a store whose id_token cookie is `token` (or absent). */
function setSessionToken(token: string | undefined): void {
  mockedCookies.mockResolvedValue({
    get: (name: string) =>
      name === 'id_token' && token !== undefined ? { value: token } : undefined,
  } as unknown as CookieStore);
}

/** Stub the global fetch with a single canned Response-shaped result. */
function stubFetch(response: { status: number; ok: boolean; json?: () => Promise<unknown> }) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('apiFetch — typed Bearer wrapper over the data API', () => {
  it('imports without throwing under the node test env (server-only mocked)', () => {
    expect(typeof apiFetch).toBe('function');
  });

  it('returns { status: "unauthenticated" } and never fetches when no id_token cookie', async () => {
    setSessionToken(undefined);
    const fetchMock = stubFetch({ status: 200, ok: true, json: async () => ({}) });

    const result = await apiFetch('/api/patients', patientsSchema);

    expect(result).toEqual({ status: 'unauthenticated' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards a Bearer id_token with cache:no-store and maps 200 → { status: "ok", data }', async () => {
    setSessionToken('tok-123');
    const payload = { patients: [{ id: 'p1' }] };
    const fetchMock = stubFetch({ status: 200, ok: true, json: async () => payload });

    const result = await apiFetch('/api/patients', patientsSchema);

    expect(result).toEqual({ status: 'ok', data: payload });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://data.example.test/api/patients');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok-123' });
    expect(init.cache).toBe('no-store');
  });

  it('maps a body missing a required field to { status: "error" } without throwing', async () => {
    setSessionToken('tok-123');
    stubFetch({ status: 200, ok: true, json: async () => ({}) });
    await expect(apiFetch('/api/patients', patientsSchema)).resolves.toEqual({
      status: 'error',
    });
  });

  it('maps a wrong-typed response field to { status: "error" } without throwing', async () => {
    setSessionToken('tok-123');
    stubFetch({
      status: 200,
      ok: true,
      json: async () => ({ patients: 'not-an-array' }),
    });
    await expect(apiFetch('/api/patients', patientsSchema)).resolves.toEqual({
      status: 'error',
    });
  });

  it('maps a 401 response to { status: "unauthenticated" }', async () => {
    setSessionToken('tok-123');
    stubFetch({ status: 401, ok: false });
    expect(await apiFetch('/api/patients', patientsSchema)).toEqual({
      status: 'unauthenticated',
    });
  });

  it('maps a 404 response to { status: "not_found" } when a detail reader opts in', async () => {
    setSessionToken('tok-123');
    stubFetch({ status: 404, ok: false });
    expect(
      await apiFetch('/api/patients/missing', patientsSchema, { includeNotFound: true }),
    ).toEqual({ status: 'not_found' });
  });

  it('keeps a 404 in the generic error arm when a collection reader does not opt in', async () => {
    setSessionToken('tok-123');
    stubFetch({ status: 404, ok: false });
    expect(await apiFetch('/api/patients', patientsSchema)).toEqual({ status: 'error' });
  });

  it('maps a 500 response to { status: "error" }', async () => {
    setSessionToken('tok-123');
    stubFetch({ status: 500, ok: false });
    expect(await apiFetch('/api/patients', patientsSchema)).toEqual({ status: 'error' });
  });

  it.each([400, 403])('keeps HTTP %i in the generic error arm', async (status) => {
    setSessionToken('tok-123');
    stubFetch({ status, ok: false });
    expect(await apiFetch('/api/patients', patientsSchema)).toEqual({ status: 'error' });
  });

  it('logs the failing path with issue paths and codes only — never received values', async () => {
    setSessionToken('tok-123');
    stubFetch({
      status: 200,
      ok: true,
      json: async () => ({ patients: [{ id: 'p1' }, { id: 4915550199 }] }),
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await apiFetch('/api/patients', patientsSchema)).toEqual({ status: 'error' });

    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = String(consoleError.mock.calls[0]?.[0]);
    expect(logged).toContain('/api/patients');
    expect(logged).toContain('patients.1.id invalid_type');
    // The zod MESSAGE quotes the received value; a phone-shaped body field must never be logged.
    expect(logged).not.toContain('4915550199');
    expect(logged).not.toMatch(/expected|received/i);
    consoleError.mockRestore();
  });

  it('maps a network throw to { status: "error" }', async () => {
    setSessionToken('tok-123');
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await apiFetch('/api/patients', patientsSchema)).toEqual({ status: 'error' });
  });
});
