// backend/src/lib/scheduler-deactivate.ts
//
// Prefix-parameterized EventBridge Scheduler deactivation sweep (Phase-4 04-01 item 3 —
// relocated from enroll/handler.ts, where it lived since Phase 3, so AWS-SDK-touching code
// stays out of `packages/shared`, which is pure contracts).
//
// The OPS-01/STUDY-05 deletion mechanism: there is NO prefix-delete API, so paginate
// ListSchedules(GroupName='medadhere-prod', NamePrefix=`${prefix}-${patientId}-`) over
// NextToken and DeleteSchedule each returned schedule. Consumers: the enroll MED-6
// compensation path, the Phase-4 STOP self-deactivation (`dose-`, `timeout-`, and `reminder-`
// prefixes), Phase-5 admin deactivation, and the LOW-8 drain script.
//
// NamePrefix carries a TRAILING DASH (42 chars for `dose-`: 5 + 36-char patientId + 1;
// 45 for `timeout-`, 46 for `reminder-`). Schedule names are truncated to EventBridge's
// 64-char cap, and 64 > 46, so every
// truncated name still retains the full prefix: the sweep catches truncated names by
// construction, for all three prefixes.

import {
  SchedulerClient,
  DeleteScheduleCommand,
  ListSchedulesCommand,
} from '@aws-sdk/client-scheduler';
import { SCHEDULE_GROUP_NAME } from '@medadhere/shared';

export type SchedulePrefix = 'dose' | 'timeout' | 'reminder';

const scheduler = new SchedulerClient({});

/**
 * Delete every schedule for a patient under the given name prefix. Returns the number of
 * schedules deleted. Throws on the first AWS error — callers (MED-6 compensation, STOP
 * path) treat a partial sweep as a failure to surface, never a success.
 */
export async function deactivateSchedules(
  patientId: string,
  prefix: SchedulePrefix = 'dose',
): Promise<number> {
  const namePrefix = `${prefix}-${patientId}-`;
  let token: string | undefined;
  let deleted = 0;
  do {
    const page = await scheduler.send(
      new ListSchedulesCommand({
        GroupName: SCHEDULE_GROUP_NAME,
        NamePrefix: namePrefix,
        NextToken: token,
      }),
    );
    for (const s of page.Schedules ?? []) {
      if (!s.Name) continue;
      await scheduler.send(
        new DeleteScheduleCommand({
          GroupName: SCHEDULE_GROUP_NAME,
          Name: s.Name,
        }),
      );
      deleted += 1;
    }
    token = page.NextToken;
  } while (token);
  return deleted;
}
