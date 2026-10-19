import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cookieStore, fetchMock, redirectMock, revalidatePathMock } = vi.hoisted(() => ({
  cookieStore: new Map<string, string>(),
  fetchMock: vi.fn(),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  revalidatePathMock: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      cookieStore.has(name) ? { name, value: cookieStore.get(name)! } : undefined,
  })),
}));
vi.mock('next/cache', () => ({ revalidatePath: revalidatePathMock }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('@/lib/cognito', () => ({ dataApiUrl: () => 'https://data.example.com' }));

import { reviewDraftDecisionAction } from './review-actions';

const PATIENT_ID = '11111111-1111-4111-8111-111111111111';
const DRAFT_ID = '22222222-2222-4222-8222-222222222222';
const CORRECTION_ID = '33333333-3333-4333-8333-333333333333';
const ACTION_ID = '44444444-4444-4444-8444-444444444444';

function success(decision: 'confirm' | 'reject' = 'confirm') {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      decision,
      applied: true,
      actionId: ACTION_ID,
      createdFactIds: [],
    }),
  };
}

function form(entries: Array<[string, string]>): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

function decide(entries: Array<[string, string]>) {
  return reviewDraftDecisionAction(PATIENT_ID, DRAFT_ID, {}, form(entries));
}

function body(): unknown {
  return JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieStore.clear();
  cookieStore.set('id_token', 'ID.TOKEN.value');
  vi.stubGlobal('fetch', fetchMock);
});

describe('reviewDraftDecisionAction — the confirm path', () => {
  it('posts the decision with the expected version and the selected corrections', async () => {
    fetchMock.mockResolvedValue(success());

    await expect(
      decide([
        ['decision', 'confirm'],
        ['expectedVersion', '2'],
        ['correctionId', CORRECTION_ID],
      ]),
    ).resolves.toEqual({ confirmed: true });

    expect(fetchMock).toHaveBeenCalledWith(
      `https://data.example.com/api/patients/${PATIENT_ID}/drafts/${DRAFT_ID}/decision`,
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
      }),
    );
    expect(body()).toEqual({
      decision: 'confirm',
      expectedVersion: 2,
      selectedCorrectionIds: [CORRECTION_ID],
    });
    expect(revalidatePathMock).toHaveBeenCalledWith(`/patients/${PATIENT_ID}`);
  });

  it('forwards the session token and declares a JSON body', async () => {
    fetchMock.mockResolvedValue(success());

    await decide([
      ['decision', 'confirm'],
      ['expectedVersion', '1'],
    ]);

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: 'Bearer ID.TOKEN.value',
      'Content-Type': 'application/json',
    });
  });
});

describe('reviewDraftDecisionAction — the reject path', () => {
  it('drops every selected correction, because a rejection applies nothing', async () => {
    fetchMock.mockResolvedValue(success('reject'));

    await decide([
      ['decision', 'reject'],
      ['expectedVersion', '2'],
      ['correctionId', CORRECTION_ID],
    ]);

    expect(body()).toEqual({
      decision: 'reject',
      expectedVersion: 2,
      selectedCorrectionIds: [],
    });
  });
});

describe('reviewDraftDecisionAction — refusals', () => {
  it('reports a superseded draft as a conflict to reload, not a generic failure', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409 });

    const state = await decide([
      ['decision', 'confirm'],
      ['expectedVersion', '1'],
    ]);

    expect(state.conflict).toBe(true);
    expect(state.error).toMatch(/reload/i);
  });

  it.each([
    ['an unparseable body', [['decision', 'sideways'] as [string, string]]],
    ['a missing expected version', [['decision', 'confirm'] as [string, string]]],
    [
      'a non-uuid correction id',
      [
        ['decision', 'confirm'] as [string, string],
        ['expectedVersion', '1'] as [string, string],
        ['correctionId', 'not-a-uuid'] as [string, string],
      ],
    ],
  ])('refuses %s before any network call', async (_case, entries) => {
    const state = await decide(entries);

    expect(state.error).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid patient or draft id before any network call', async () => {
    const state = await reviewDraftDecisionAction(
      'not-an-id',
      DRAFT_ID,
      {},
      form([
        ['decision', 'confirm'],
        ['expectedVersion', '1'],
      ]),
    );

    expect(state.error).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redirects an expired session to login before any network call', async () => {
    cookieStore.clear();

    await expect(
      decide([
        ['decision', 'confirm'],
        ['expectedVersion', '1'],
      ]),
    ).rejects.toThrow('NEXT_REDIRECT:/api/auth/login');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a calm failure when the data API is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const state = await decide([
      ['decision', 'confirm'],
      ['expectedVersion', '1'],
    ]);

    expect(state.error).toBeDefined();
    expect(state.error).not.toMatch(/ECONNREFUSED/);
  });

  it('fails closed on a malformed success response', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({}) });

    const state = await decide([
      ['decision', 'confirm'],
      ['expectedVersion', '1'],
    ]);

    expect(state.error).toBeDefined();
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
