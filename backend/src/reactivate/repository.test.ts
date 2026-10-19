import { describe, expect, it, vi } from 'vitest';
import { reactivatePatient, type DoseScheduleRestorer } from './repository.js';

const PATIENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const DOSE_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const CLINICIAN_SUB = '97b4a172-e055-4c37-9d95-2a00664dfe64';

describe('reactivatePatient ambiguous commit compensation', () => {
  it('does not delete restored schedules after COMMIT starts because the enablement may have committed', async () => {
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (/SELECT is_active, agent_enabled/i.test(sql)) {
        return {
          rows: [
            {
              is_active: true,
              agent_enabled: false,
              provider_opted_in: true,
              messaging_state_version: 7,
            },
          ],
          rowCount: 1,
        };
      }
      if (/SELECT ds\.id::text/i.test(sql)) {
        return {
          rows: [
            {
              id: DOSE_ID,
              scheduled_at: new Date('2099-08-15T13:15:00.000Z'),
              dose_date: '2099-08-15',
              local_dose_time: '09:15',
              schedule_timezone: 'America/Toronto',
            },
          ],
          rowCount: 1,
        };
      }
      if (/UPDATE patient/i.test(sql)) {
        return {
          rows: [{ is_active: true, agent_enabled: true, messaging_state_version: 8 }],
          rowCount: 1,
        };
      }
      if (/COMMIT/i.test(sql)) throw new Error('connection lost after commit write');
      return { rows: [], rowCount: 0 };
    });
    const reset = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue(undefined);
    const schedules: DoseScheduleRestorer = { reset, create };

    await expect(
      reactivatePatient(
        { connect: vi.fn().mockResolvedValue({ query, release }) } as never,
        {
          patientId: PATIENT_ID,
          clinicianSub: CLINICIAN_SUB,
          expectedVersion: 7,
        },
        schedules,
      ),
    ).rejects.toThrow(/connection lost after commit write/);

    expect(reset).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
