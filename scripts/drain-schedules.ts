// scripts/drain-schedules.ts
//
// LOW-8 — the scripted medadhere-prod schedule-drain. A ONE-TIME, OFFLINE operator script run BEFORE
// `cdk destroy` so the medadhere-prod EventBridge Scheduler group is empty (a non-empty group can block
// group deletion / leave orphan one-shots — RESEARCH A2 / Pitfall 4). It paginates
// ListSchedules(GroupName='medadhere-prod') over NextToken and DeleteSchedule for every returned
// schedule — the same paginated-list-delete mechanism the Enroll handler's deactivateSchedules helper
// uses (there is NO prefix-delete API), but over the WHOLE group (no NamePrefix) so it drains every
// dose-* (and any other) schedule left in the group across deploy/smoke/destroy cycles.
//
// This is an OFFLINE operator script (tsx-runnable, like scripts/freeze-drug-profiles.ts) — NOT a
// Lambda. It uses @aws-sdk/client-scheduler directly with the operator's ambient AWS credentials/region
// (AWS_REGION / AWS_PROFILE). It performs NO DB access and reads no secrets.
//
// MED-7-style safety gate: DEFAULTS to --dry-run (LIST only, no deletes). The DeleteSchedule calls run
// ONLY when an explicit `--apply` flag is passed on argv, so an operator can preview exactly what would
// be drained before committing. Usage:
//   npx tsx scripts/drain-schedules.ts            # dry-run: list what WOULD be deleted
//   npx tsx scripts/drain-schedules.ts --apply    # delete every schedule in the medadhere-prod group
//   npx tsx scripts/drain-schedules.ts --group <name> [--prefix dose-]  # override group / scope by prefix
//
// Module mode: CommonJS-compatible (no `import.meta`); tsx/NodeNext resolve the deps natively.

import {
  SchedulerClient,
  ListSchedulesCommand,
  DeleteScheduleCommand,
} from '@aws-sdk/client-scheduler';
import { SCHEDULE_GROUP_NAME } from '@medadhere/shared';

// WR-02 — re-export the shared SSOT group-name const (kept exported for operator-API parity; the drain
// defaults its group to it below).
export { SCHEDULE_GROUP_NAME };

/** The minimal Scheduler seam the drain depends on (so a test can inject a fake client). */
export interface SchedulerSeam {
  send(command: unknown): Promise<{
    Schedules?: Array<{ Name?: string }>;
    NextToken?: string;
  }>;
}

export interface DrainOptions {
  /** The schedule group to drain (default medadhere-prod). */
  groupName?: string;
  /** Optional NamePrefix to scope the drain (e.g. 'dose-'); omitted = the whole group. */
  namePrefix?: string;
  /** When false (the default), LIST only and delete nothing (dry-run). */
  apply?: boolean;
}

/**
 * Paginate ListSchedules over NextToken and (when apply) DeleteSchedule each returned schedule. Returns
 * the names that were (or, in dry-run, would be) deleted. Pure of process/argv so it is unit-testable.
 */
export async function drainSchedules(
  scheduler: SchedulerSeam,
  opts: DrainOptions = {},
): Promise<string[]> {
  const groupName = opts.groupName ?? SCHEDULE_GROUP_NAME;
  const namePrefix = opts.namePrefix;
  const apply = opts.apply ?? false;

  const names: string[] = [];
  let token: string | undefined;
  do {
    const page = await scheduler.send(
      new ListSchedulesCommand({
        GroupName: groupName,
        ...(namePrefix ? { NamePrefix: namePrefix } : {}),
        NextToken: token,
      }),
    );
    for (const s of page.Schedules ?? []) {
      if (!s.Name) continue;
      names.push(s.Name);
      if (apply) {
        await scheduler.send(new DeleteScheduleCommand({ GroupName: groupName, Name: s.Name }));
      }
    }
    token = page.NextToken;
  } while (token);

  return names;
}

/** Parse a `--flag value` option from argv (returns undefined if absent). */
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** CLI entrypoint — defaults to --dry-run; deletes only with an explicit --apply. */
async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const groupName = argValue('--group') ?? SCHEDULE_GROUP_NAME;
  const namePrefix = argValue('--prefix');
  const mode = apply ? 'APPLY (DELETING schedules)' : 'DRY-RUN (list only — nothing deleted)';

  console.log('='.repeat(72));
  console.log(
    `LOW-8 drain-schedules — group: ${groupName}${namePrefix ? ` prefix: ${namePrefix}` : ''} — mode: ${mode}`,
  );
  if (!apply) {
    console.log('Pass --apply to DeleteSchedule every listed schedule (run before `cdk destroy`).');
  }
  console.log('='.repeat(72));

  const scheduler = new SchedulerClient({});
  const names = await drainSchedules(scheduler, { groupName, namePrefix, apply });

  if (names.length === 0) {
    console.log(`[drain] the ${groupName} group is already empty — nothing to drain.`);
    return;
  }
  for (const n of names) {
    console.log(apply ? `[drain] deleted ${n}` : `[drain] would delete ${n}`);
  }
  console.log(
    `[drain] done — ${names.length} schedule(s) ${apply ? 'deleted' : 'listed (dry-run)'}` +
      (apply ? '' : ' — pass --apply to delete'),
  );
}

// Run main() only when executed directly (tsx/node), not when imported by a test module.
// `require.main === module` is the CJS direct-invocation guard (no `import.meta` — matches CJS mode).
declare const require: { main?: unknown } | undefined;
declare const module: unknown;
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unexpected error';
    console.error(`[drain] fatal: ${message}`);
    process.exitCode = 1;
  });
}
