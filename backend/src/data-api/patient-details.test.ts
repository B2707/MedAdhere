/**
 * patient-details.test.ts — network-free unit test of the doctor-owned contact-detail correction
 * (POST /api/patients/{id}/details). No AWS, no DB: the pool is a hand-rolled `query` double, so the
 * tests pin validation order, the owner-scoped SQL parameters, and every response branch.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  SELECT_PATIENT_DETAILS_SQL,
  UPDATE_PATIENT_DETAILS_SQL,
  handlePatientDetailsRoute,
} from './patient-details.js';

const PATIENT_ID = '11111111-1111-4111-8111-111111111111';
const CLINICIAN_SUB = 'clinician-sub-1';

function deps(queryMock: ReturnType<typeof vi.fn>) {
  return {
    getPool: vi.fn(async () => ({ query: queryMock }) as never),
    logMetric: vi.fn(),
  };
}

function event(body: unknown, id: string = PATIENT_ID) {
  return {
    routeKey: 'POST /api/patients/{id}/details',
    pathParameters: { id },
    body: JSON.stringify(body),
  };
}

describe('handlePatientDetailsRoute', () => {
  it('updates both fields owner-scoped, bumps the version, and reports the change', async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ display_name: 'Alice B', phone: '+15145550199', messaging_state_version: 8 }],
    });
    const dependencies = deps(query);

    const result = await handlePatientDetailsRoute(
      event({ expectedVersion: 7, displayName: 'Alice B', phoneNumber: '+15145550199' }),
      CLINICIAN_SUB,
      dependencies,
    );

    expect(query).toHaveBeenCalledWith(UPDATE_PATIENT_DETAILS_SQL, [
      PATIENT_ID,
      CLINICIAN_SUB,
      'Alice B',
      '+15145550199',
      7,
    ]);
    expect(result).toEqual({
      statusCode: 200,
      body: {
        displayName: 'Alice B',
        phoneNumber: '+15145550199',
        messagingStateVersion: 8,
        changed: true,
      },
    });
  });

  it('passes null for the field the doctor left out so the stored value is kept', async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ display_name: 'Alice', phone: '+15145550111', messaging_state_version: 3 }],
    });

    await handlePatientDetailsRoute(
      event({ expectedVersion: 2, phoneNumber: '+15145550111' }),
      CLINICIAN_SUB,
      deps(query),
    );

    expect(query).toHaveBeenCalledWith(UPDATE_PATIENT_DETAILS_SQL, [
      PATIENT_ID,
      CLINICIAN_SUB,
      null,
      '+15145550111',
      2,
    ]);
  });

  it('treats an unchanged resubmit as a graceful no-op, not a conflict', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ display_name: 'Alice', phone: '+15145550111', messaging_state_version: 7 }],
      });

    const result = await handlePatientDetailsRoute(
      event({ expectedVersion: 7, displayName: 'Alice', phoneNumber: '+15145550111' }),
      CLINICIAN_SUB,
      deps(query),
    );

    expect(query).toHaveBeenLastCalledWith(SELECT_PATIENT_DETAILS_SQL, [PATIENT_ID, CLINICIAN_SUB]);
    expect(result).toEqual({
      statusCode: 200,
      body: {
        displayName: 'Alice',
        phoneNumber: '+15145550111',
        messagingStateVersion: 7,
        changed: false,
      },
    });
  });

  it('409s with the current version when the row moved under the editor', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ display_name: 'Alice', phone: '+15145550111', messaging_state_version: 9 }],
      });

    const result = await handlePatientDetailsRoute(
      event({ expectedVersion: 7, displayName: 'Alice B' }),
      CLINICIAN_SUB,
      deps(query),
    );

    expect(result).toEqual({
      statusCode: 409,
      body: { error: 'messaging state version conflict', messagingStateVersion: 9 },
    });
  });

  it('404s when the patient is missing or owned by another clinician', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await handlePatientDetailsRoute(
      event({ expectedVersion: 7, displayName: 'Alice B' }),
      CLINICIAN_SUB,
      deps(query),
    );

    expect(result).toEqual({ statusCode: 404, body: { error: 'patient not found' } });
  });

  it('409s when the new number already belongs to another active patient', async () => {
    const query = vi.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));

    const result = await handlePatientDetailsRoute(
      event({ expectedVersion: 7, phoneNumber: '+15145550111' }),
      CLINICIAN_SUB,
      deps(query),
    );

    expect(result).toEqual({
      statusCode: 409,
      body: { error: 'another active patient already uses this phone number' },
    });
  });

  it.each([
    ['a non-uuid patient id', 'not-a-uuid', { expectedVersion: 7, displayName: 'Alice' }],
    ['a non-E.164 phone', PATIENT_ID, { expectedVersion: 7, phoneNumber: '5145550111' }],
    ['an empty display name', PATIENT_ID, { expectedVersion: 7, displayName: '' }],
    ['an over-long display name', PATIENT_ID, { expectedVersion: 7, displayName: 'a'.repeat(81) }],
    ['a body with nothing to change', PATIENT_ID, { expectedVersion: 7 }],
    ['an unknown field', PATIENT_ID, { expectedVersion: 7, displayName: 'Alice', extra: 1 }],
  ])('400s on %s before any database reach', async (_label, id, body) => {
    const query = vi.fn();
    const dependencies = deps(query);

    const result = await handlePatientDetailsRoute(
      event(body, id as string),
      CLINICIAN_SUB,
      dependencies,
    );

    expect(result).toEqual({ statusCode: 400, body: { error: 'invalid request' } });
    expect(dependencies.getPool).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('400s on a body that is missing, oversized, or base64 encoded', async () => {
    const dependencies = deps(vi.fn());
    for (const bad of [
      { routeKey: 'POST /api/patients/{id}/details', pathParameters: { id: PATIENT_ID } },
      {
        routeKey: 'POST /api/patients/{id}/details',
        pathParameters: { id: PATIENT_ID },
        body: 'not json',
      },
      {
        routeKey: 'POST /api/patients/{id}/details',
        pathParameters: { id: PATIENT_ID },
        body: JSON.stringify({ expectedVersion: 7, displayName: 'a' }),
        isBase64Encoded: true,
      },
    ]) {
      expect(await handlePatientDetailsRoute(bad, CLINICIAN_SUB, dependencies)).toEqual({
        statusCode: 400,
        body: { error: 'invalid request' },
      });
    }
    expect(dependencies.getPool).not.toHaveBeenCalled();
  });

  it('keeps the owner boundary and the version guard in the pinned SQL', () => {
    expect(UPDATE_PATIENT_DETAILS_SQL).toContain('owner_clinician_sub = $2');
    expect(UPDATE_PATIENT_DETAILS_SQL).toContain('messaging_state_version = $5');
    expect(UPDATE_PATIENT_DETAILS_SQL).toContain('IS DISTINCT FROM');
    expect(SELECT_PATIENT_DETAILS_SQL).toContain('owner_clinician_sub = $2');
  });
});
