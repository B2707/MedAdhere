/**
 * scheduler-deactivate.test.ts — the relocated, prefix-parameterized schedule deactivation
 * helper (04-01 item 3). Hermetic: `@aws-sdk/client-scheduler` fully mocked (vi.hoisted +
 * vi.mock factory — same posture as enroll/handler.test.ts).
 *
 * Contract under test (OPS-01 / STUDY-05 / Phase-5 timeout sweep):
 *   - NamePrefix is `${prefix}-${patientId}-` — 42 chars for `dose-` (5 + 36 + 1), 45 for
 *     `timeout-`. Schedule names are truncated to EventBridge's 64-char cap (Phase-3 live
 *     Fix 2), and 64 > 45, so the truncated names ALWAYS retain the full prefix — the sweep
 *     catches truncated names by construction.
 *   - Paginates ListSchedules over NextToken; DeleteSchedule per returned name; returns count.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEDULE_GROUP_NAME } from '@medadhere/shared';

const { schedulerSend } = vi.hoisted(() => ({ schedulerSend: vi.fn() }));

vi.mock('@aws-sdk/client-scheduler', () => ({
  SchedulerClient: class {
    send = schedulerSend;
  },
  ListSchedulesCommand: class {
    readonly kind = 'list';
    constructor(readonly input: Record<string, unknown>) {}
  },
  DeleteScheduleCommand: class {
    readonly kind = 'delete';
    constructor(readonly input: Record<string, unknown>) {}
  },
}));

import { deactivateSchedules } from './scheduler-deactivate';

type SchedulerCommand = { kind: 'list' | 'delete'; input: Record<string, unknown> };

const PATIENT_ID = '3f1b3fbe-8e5f-4bd2-9d3a-1c2e4a5b6c7d'; // real 36-char UUID shape

function callsOf(kind: 'list' | 'delete'): SchedulerCommand[] {
  return (schedulerSend.mock.calls as Array<[SchedulerCommand]>)
    .map(([cmd]) => cmd)
    .filter((cmd) => cmd.kind === kind);
}

beforeEach(() => {
  schedulerSend.mockReset();
  schedulerSend.mockResolvedValue({ Schedules: [] });
});

describe('deactivateSchedules — prefix-parameterized NamePrefix sweep', () => {
  it("defaults to the 'dose' prefix with the 42-char NamePrefix (trailing dash included) and the shared group name", async () => {
    await deactivateSchedules(PATIENT_ID);
    const lists = callsOf('list');
    expect(lists).toHaveLength(1);
    const prefix = lists[0]?.input.NamePrefix as string;
    expect(prefix).toBe(`dose-${PATIENT_ID}-`);
    expect(prefix).toHaveLength(42);
    expect(lists[0]?.input.GroupName).toBe(SCHEDULE_GROUP_NAME);
  });

  it("sweeps the Phase-5 'timeout' prefix with the 45-char NamePrefix", async () => {
    await deactivateSchedules(PATIENT_ID, 'timeout');
    const prefix = callsOf('list')[0]?.input.NamePrefix as string;
    expect(prefix).toBe(`timeout-${PATIENT_ID}-`);
    expect(prefix).toHaveLength(45);
  });

  it("sweeps the Phase-8 'reminder' prefix so STOP removes every pending reminder", async () => {
    await deactivateSchedules(PATIENT_ID, 'reminder');
    const prefix = callsOf('list')[0]?.input.NamePrefix as string;
    expect(prefix).toBe(`reminder-${PATIENT_ID}-`);
    expect(prefix).toHaveLength(46);
  });

  it('paginates over NextToken and deletes every returned schedule (incl. 64-char truncated names)', async () => {
    const truncated = `dose-${PATIENT_ID}-abcdefabcdefabcdefabcd`.slice(0, 64); // truncated name shape
    schedulerSend.mockImplementation(async (cmd: SchedulerCommand) => {
      if (cmd.kind !== 'list') return {};
      return cmd.input.NextToken === undefined
        ? { Schedules: [{ Name: `dose-${PATIENT_ID}-full` }, { Name: truncated }], NextToken: 't1' }
        : { Schedules: [{ Name: `dose-${PATIENT_ID}-last` }] };
    });

    const deleted = await deactivateSchedules(PATIENT_ID);
    expect(deleted).toBe(3);

    const lists = callsOf('list');
    expect(lists).toHaveLength(2);
    expect(lists[1]?.input.NextToken).toBe('t1');

    const deletes = callsOf('delete');
    expect(deletes.map((d) => d.input.Name)).toEqual([
      `dose-${PATIENT_ID}-full`,
      truncated,
      `dose-${PATIENT_ID}-last`,
    ]);
    for (const d of deletes) expect(d.input.GroupName).toBe(SCHEDULE_GROUP_NAME);
  });

  it('skips nameless entries and returns 0 on an empty sweep', async () => {
    schedulerSend.mockResolvedValueOnce({ Schedules: [{ Name: undefined }, {}] });
    await expect(deactivateSchedules(PATIENT_ID)).resolves.toBe(0);
    expect(callsOf('delete')).toHaveLength(0);

    schedulerSend.mockReset();
    schedulerSend.mockResolvedValueOnce({});
    await expect(deactivateSchedules(PATIENT_ID, 'reminder')).resolves.toBe(0);
    expect(callsOf('delete')).toHaveLength(0);
  });
});
