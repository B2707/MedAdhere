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

import {
  deactivatePatientAction,
  reactivatePatientAction,
  setReminderLimitAction,
  updatePatientDetailsAction,
} from './actions';

const PATIENT_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  cookieStore.clear();
  cookieStore.set('id_token', 'ID.TOKEN.value');
  vi.stubGlobal('fetch', fetchMock);
});

describe('deactivatePatientAction', () => {
  it('posts to the existing authenticated deactivation endpoint and refreshes patient views', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await expect(deactivatePatientAction(PATIENT_ID, {}, new FormData())).rejects.toThrow(
      `NEXT_REDIRECT:/patients/${PATIENT_ID}`,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `https://data.example.com/api/patients/${PATIENT_ID}/deactivate`,
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer ID.TOKEN.value' },
        cache: 'no-store',
      }),
    );
    expect(revalidatePathMock).toHaveBeenCalledWith('/patients');
    expect(revalidatePathMock).toHaveBeenCalledWith(`/patients/${PATIENT_ID}`);
  });

  it('rejects an invalid id before any network call', async () => {
    await expect(deactivatePatientAction('not-an-id', {}, new FormData())).resolves.toEqual({
      error: "Couldn't pause monitoring. Please refresh and try again.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redirects an expired session to login before any network call', async () => {
    cookieStore.clear();
    await expect(deactivatePatientAction(PATIENT_ID, {}, new FormData())).rejects.toThrow(
      'NEXT_REDIRECT:/api/auth/login',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('setReminderLimitAction', () => {
  it('posts the bounded limit and expected messaging version, then refreshes patient views', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ reminderLimit: 4, messagingStateVersion: 8 }),
    });
    const form = new FormData();
    form.set('reminderLimit', '4');
    form.set('expectedVersion', '7');

    await expect(setReminderLimitAction(PATIENT_ID, {}, form)).rejects.toThrow(
      `NEXT_REDIRECT:/patients/${PATIENT_ID}`,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `https://data.example.com/api/patients/${PATIENT_ID}/reminder-limit`,
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer ID.TOKEN.value',
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      reminderLimit: 4,
      expectedVersion: 7,
    });
    expect(revalidatePathMock).toHaveBeenCalledWith('/patients');
    expect(revalidatePathMock).toHaveBeenCalledWith(`/patients/${PATIENT_ID}`);
  });

  it('preserves the selected limit and explains stale-version conflicts', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409 });
    const form = new FormData();
    form.set('reminderLimit', '5');
    form.set('expectedVersion', '7');

    await expect(setReminderLimitAction(PATIENT_ID, {}, form)).resolves.toEqual({
      conflict: true,
      error: expect.stringMatching(/changed.*reload/i),
      reminderLimit: 5,
    });
  });

  it('rejects a malformed success payload and preserves the selected limit', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ reminderLimit: 4 }),
    });
    const form = new FormData();
    form.set('reminderLimit', '4');
    form.set('expectedVersion', '7');

    await expect(setReminderLimitAction(PATIENT_ID, {}, form)).resolves.toEqual({
      error: expect.stringMatching(/couldn.t update/i),
      reminderLimit: 4,
    });
  });

  it.each(['-1', '6', '1.5', 'not-a-number'])(
    'rejects reminderLimit=%s before any network call',
    async (reminderLimit) => {
      const form = new FormData();
      form.set('reminderLimit', reminderLimit);
      form.set('expectedVersion', '7');
      await expect(setReminderLimitAction(PATIENT_ID, {}, form)).resolves.toMatchObject({
        error: expect.stringMatching(/0 to 5/i),
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe('reactivatePatientAction', () => {
  it('posts the expected messaging version to the existing reactivation endpoint', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        reactivated: true,
        agentEnabled: true,
        isActive: true,
        messagingStateVersion: 8,
      }),
    });
    const form = new FormData();
    form.set('expectedVersion', '7');

    await expect(reactivatePatientAction(PATIENT_ID, {}, form)).rejects.toThrow(
      `NEXT_REDIRECT:/patients/${PATIENT_ID}`,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `https://data.example.com/api/patients/${PATIENT_ID}/reactivate`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ expectedVersion: 7 }),
      }),
    );
  });

  it('returns a clear conflict without retrying stale state', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409 });
    const form = new FormData();
    form.set('expectedVersion', '7');
    await expect(reactivatePatientAction(PATIENT_ID, {}, form)).resolves.toEqual({
      conflict: true,
      error: expect.stringMatching(/changed.*reload/i),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed success payload', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ reactivated: false }),
    });
    const form = new FormData();
    form.set('expectedVersion', '7');
    await expect(reactivatePatientAction(PATIENT_ID, {}, form)).resolves.toEqual({
      error: expect.stringMatching(/couldn.t reactivate/i),
    });
  });
});

describe('updatePatientDetailsAction', () => {
  function detailsForm(fields: Record<string, string>): FormData {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    return form;
  }

  it('posts only the fields the doctor actually changed, then refreshes patient views', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        displayName: 'Alice B',
        phoneNumber: '+15145550111',
        messagingStateVersion: 8,
        changed: true,
      }),
    });

    await expect(
      updatePatientDetailsAction(
        PATIENT_ID,
        {},
        detailsForm({
          expectedVersion: '7',
          displayName: 'Alice B',
          phoneNumber: '+15145550111',
          currentDisplayName: 'Alice',
          currentPhoneNumber: '+15145550111',
        }),
      ),
    ).rejects.toThrow(`NEXT_REDIRECT:/patients/${PATIENT_ID}`);

    expect(fetchMock).toHaveBeenCalledWith(
      `https://data.example.com/api/patients/${PATIENT_ID}/details`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ expectedVersion: 7, displayName: 'Alice B' }),
      }),
    );
    expect(revalidatePathMock).toHaveBeenCalledWith('/patients');
    expect(revalidatePathMock).toHaveBeenCalledWith(`/patients/${PATIENT_ID}`);
  });

  it('treats an untouched form as a no-op instead of burning a messaging version', async () => {
    await expect(
      updatePatientDetailsAction(
        PATIENT_ID,
        {},
        detailsForm({
          expectedVersion: '7',
          displayName: 'Alice',
          phoneNumber: '+15145550111',
          currentDisplayName: 'Alice',
          currentPhoneNumber: '+15145550111',
        }),
      ),
    ).resolves.toEqual({ error: expect.stringMatching(/nothing to save/i) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a non-E.164 phone number before any network call', async () => {
    await expect(
      updatePatientDetailsAction(
        PATIENT_ID,
        {},
        detailsForm({
          expectedVersion: '7',
          phoneNumber: '5145550111',
          currentPhoneNumber: '+15145550111',
        }),
      ),
    ).resolves.toEqual({
      error: expect.stringMatching(/\+15145550123/),
      displayName: undefined,
      phoneNumber: '5145550111',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an over-long display name before any network call', async () => {
    await expect(
      updatePatientDetailsAction(
        PATIENT_ID,
        {},
        detailsForm({ expectedVersion: '7', displayName: 'a'.repeat(81) }),
      ),
    ).resolves.toEqual({
      error: expect.stringMatching(/80 characters/i),
      displayName: 'a'.repeat(81),
      phoneNumber: undefined,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid id before any network call', async () => {
    await expect(
      updatePatientDetailsAction(
        'not-an-id',
        {},
        detailsForm({ expectedVersion: '7', displayName: 'Alice B' }),
      ),
    ).resolves.toEqual(expect.objectContaining({ error: expect.any(String) }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redirects an expired session to login before any network call', async () => {
    cookieStore.clear();
    await expect(
      updatePatientDetailsAction(
        PATIENT_ID,
        {},
        detailsForm({ expectedVersion: '7', displayName: 'Alice B' }),
      ),
    ).rejects.toThrow('NEXT_REDIRECT:/api/auth/login');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a taken phone number distinctly from a stale-version conflict', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'another active patient already uses this phone number' }),
    });

    await expect(
      updatePatientDetailsAction(
        PATIENT_ID,
        {},
        detailsForm({ expectedVersion: '7', phoneNumber: '+15145550999' }),
      ),
    ).resolves.toEqual({
      conflict: true,
      error: expect.stringMatching(/already.*another patient/i),
      phoneNumber: '+15145550999',
      displayName: undefined,
    });
  });

  it('returns a reload-first conflict when the row moved under the editor', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'messaging state version conflict', messagingStateVersion: 9 }),
    });

    await expect(
      updatePatientDetailsAction(
        PATIENT_ID,
        {},
        detailsForm({ expectedVersion: '7', displayName: 'Alice B' }),
      ),
    ).resolves.toEqual({
      conflict: true,
      error: expect.stringMatching(/changed.*reload/i),
      displayName: 'Alice B',
      phoneNumber: undefined,
    });
  });

  it('rejects a malformed success payload', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ displayName: 'Alice B' }),
    });

    await expect(
      updatePatientDetailsAction(
        PATIENT_ID,
        {},
        detailsForm({ expectedVersion: '7', displayName: 'Alice B' }),
      ),
    ).resolves.toEqual(expect.objectContaining({ error: expect.stringMatching(/couldn.t save/i) }));
  });

  it('redirects a 401 to login', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    await expect(
      updatePatientDetailsAction(
        PATIENT_ID,
        {},
        detailsForm({ expectedVersion: '7', displayName: 'Alice B' }),
      ),
    ).rejects.toThrow('NEXT_REDIRECT:/api/auth/login');
  });
});
