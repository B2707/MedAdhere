// @vitest-environment node
//
// Network-free unit test of the /patients/new enrollment server action (DASH-05 / D3 / L4). The action is
// the browser-facing half of the write path: it re-checks auth IN THE ACTION (the API-GW JWT boundary is
// the real gate; this is defence-in-depth + a redirect for UX), shape-validates the FormData itself
// (generic errors, never echoing submitted values), POSTs to the data-API /api/patients route with the
// Bearer id_token, and on success revalidates BEFORE redirecting.
//
// next/headers, next/cache, next/navigation and global fetch are all mocked — no Next runtime, no network.
// `redirect` is mocked to THROW (as the real next/navigation redirect does) so the control-flow contract
// (redirect halts the action) is exercised faithfully.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { cookieStore, redirectMock, revalidateMock, fetchMock } = vi.hoisted(() => ({
  cookieStore: new Map<string, string>(),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  revalidateMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      cookieStore.has(name) ? { name, value: cookieStore.get(name)! } : undefined,
  })),
}));
vi.mock('next/cache', () => ({ revalidatePath: revalidateMock }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

import { enrollAction } from './actions';

const ID_TOKEN = 'ID.TOKEN.value';
const PHONE = '+15145550123';

/** Build a valid enrollment FormData (the /patients/new form field names). */
function validForm(overrides: Record<string, string | undefined> = {}): FormData {
  const fields: Record<string, string | undefined> = {
    phone: PHONE,
    medication_name: 'Metformin',
    display_name: 'Alex',
    timezone: 'America/Toronto',
    days: '3',
    localTimes: '09:00',
    is_test: 'true',
    ...overrides,
  };
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) fd.append(k, v);
  }
  return fd;
}

/** A canned fetch Response-like object. */
function fetchResult(status: number, body: Record<string, unknown> = {}) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

beforeEach(() => {
  cookieStore.clear();
  cookieStore.set('id_token', ID_TOKEN);
  vi.clearAllMocks();
  process.env.DATA_API_URL = 'https://data.example.com';
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue(fetchResult(201, { patientId: 'pt-1' }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('enrollAction — auth re-check (D3/L4)', () => {
  it('redirects to login when there is no id_token cookie — the API is never called', async () => {
    cookieStore.clear(); // no id_token
    await expect(enrollAction({}, validForm())).rejects.toThrow('NEXT_REDIRECT:/api/auth/login');
    expect(redirectMock).toHaveBeenCalledWith('/api/auth/login');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('enrollAction — shape validation (generic, no submitted-value echo)', () => {
  it('returns a generic error for a bad phone and NEVER calls the API (no value echo)', async () => {
    const state = await enrollAction({}, validForm({ phone: '514-555-0123' }));
    expect(state.error).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    // The generic error must NOT echo the submitted phone value.
    expect(JSON.stringify(state)).not.toContain('514-555-0123');
    expect(state.values).toEqual({
      medication_name: 'Metformin',
      display_name: 'Alex',
      timezone: 'America/Toronto',
      days: '3',
      localTimes: ['09:00'],
    });
    expect(state).not.toHaveProperty('phone');
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('returns a generic error for an empty medication_name (no API call)', async () => {
    const state = await enrollAction({}, validForm({ medication_name: '' }));
    expect(state.error).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a generic error for a non-HH:mm dose time (no API call)', async () => {
    const state = await enrollAction({}, validForm({ localTimes: '9am' }));
    expect(state.error).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a generic error for out-of-range days and retains the submitted value', async () => {
    const state = await enrollAction({}, validForm({ days: '15' }));
    expect(state.error).toBe('Please check the form and try again.');
    expect(state.values?.days).toBe('15');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a value-free per-field error for phone, not just the top-level alert (F3)', async () => {
    const state = await enrollAction({}, validForm({ phone: '514-555-0123' }));
    expect(state.fieldErrors?.phone).toBe(
      'Enter a valid phone number in E.164 format, e.g. +15145550123.',
    );
    expect(state.fieldErrors?.phone).not.toContain('514-555-0123');
  });

  it('returns a per-field error for an out-of-range day count (F3)', async () => {
    const state = await enrollAction({}, validForm({ days: '15' }));
    expect(state.fieldErrors?.days).toBe('Enter a number of days between 1 and 14.');
  });

  it('returns a per-field error for a malformed dose time (F3)', async () => {
    const state = await enrollAction({}, validForm({ localTimes: '9am' }));
    expect(state.fieldErrors?.localTimes).toBe('Enter each dose time in 24-hour HH:mm format.');
  });

  it('reports every invalid field at once instead of only the first (F3)', async () => {
    const state = await enrollAction(
      {},
      validForm({ phone: '514-555-0123', days: '99', timezone: 'Nowhere/Fake' }),
    );
    expect(Object.keys(state.fieldErrors ?? {}).sort()).toEqual(['days', 'phone', 'timezone']);
  });

  it('returns a value-free timezone field error and never calls the API', async () => {
    const submittedTimezone = 'America/Torono';
    const state = await enrollAction({}, validForm({ timezone: submittedTimezone }));
    expect(state.error).toBeTruthy();
    expect(state.fieldErrors?.timezone).toBe('Unrecognized timezone.');
    expect(state.fieldErrors?.timezone).not.toContain(submittedTimezone);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an over-long medication name without calling the API', async () => {
    const state = await enrollAction({}, validForm({ medication_name: 'm'.repeat(121) }));
    expect(state.error).toBe('Please check the form and try again.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an over-long display name without calling the API', async () => {
    const state = await enrollAction({}, validForm({ display_name: 'd'.repeat(81) }));
    expect(state.error).toBe('Please check the form and try again.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('enrollAction — success (201): revalidate BEFORE redirect (D3)', () => {
  it('POSTs the Bearer id_token to /api/patients then revalidatePath(/patients) BEFORE redirect(/patients)', async () => {
    await expect(enrollAction({}, validForm())).rejects.toThrow('NEXT_REDIRECT:/patients');

    // POST with the Bearer id_token + JSON body carrying is_test (D14).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://data.example.com/api/patients');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${ID_TOKEN}`);
    const sent = JSON.parse(String((init as RequestInit).body)) as {
      days?: unknown;
      is_test?: unknown;
      phone?: unknown;
    };
    expect(sent.days).toBe(3);
    expect(sent.is_test).toBe(true);
    expect(sent.phone).toBe(PHONE);

    // Ordering: revalidatePath('/patients') runs BEFORE redirect('/patients') (D3).
    expect(revalidateMock).toHaveBeenCalledWith('/patients');
    expect(redirectMock).toHaveBeenCalledWith('/patients');
    expect(revalidateMock.mock.invocationCallOrder[0]!).toBeLessThan(
      redirectMock.mock.invocationCallOrder[0]!,
    );
  });

  it('enforces is_test=true even when a crafted request omits the form marker', async () => {
    await expect(enrollAction({}, validForm({ is_test: undefined }))).rejects.toThrow(
      'NEXT_REDIRECT:/patients',
    );
    const sent = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as {
      is_test?: unknown;
    };
    expect(sent.is_test).toBe(true);
  });
});

describe('enrollAction — API failures surface as generic state (no redirect)', () => {
  it('409 → surfaces the generic duplicate message, does NOT redirect', async () => {
    fetchMock.mockResolvedValue(
      fetchResult(409, {
        error: 'a patient with this phone may already be enrolled — check the list',
      }),
    );
    const state = await enrollAction({}, validForm());
    expect(state.error).toBeTruthy();
    expect(state.error?.toLowerCase()).toContain('already');
    expect(state.values?.medication_name).toBe('Metformin');
    expect(state.values?.days).toBe('3');
    expect(JSON.stringify(state)).not.toContain(PHONE);
    expect(redirectMock).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it('500 → generic error, no redirect, no value echo', async () => {
    fetchMock.mockResolvedValue(fetchResult(500, { error: 'internal db.internal detail' }));
    const state = await enrollAction({}, validForm());
    expect(state.error).toBeTruthy();
    expect(JSON.stringify(state)).not.toContain('db.internal');
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('network throw → generic error, no redirect', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED 10.0.0.5:443'));
    const state = await enrollAction({}, validForm());
    expect(state.error).toBeTruthy();
    expect(JSON.stringify(state)).not.toContain('10.0.0.5');
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
