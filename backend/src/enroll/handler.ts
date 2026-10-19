// backend/src/enroll/handler.ts
//
// The in-VPC Enroll Lambda (PIPE-01 / PIPE-08 / PIPE-09 / SC2) — the ENROLL half of the Phase-3
// pipeline. Given an enrollment payload it, in one logical flow:
//
//   1. INSERT one patient row (with medication_name set — PIPE-08, parameterized).
//   2. Compute the dose list for the configured horizon (the Plan-01 generateDoseSchedule helper).
//   3. INSERT one dose_schedule row per dose (parameterized): scheduled_at = the Plan-01 luxon UTC
//      computation (the DST-correct instant, STORAGE-only — PIPE-09 / Pitfall 3), plus
//      schedule_timezone, dose_date, local_dose_time.
//   4. Create one EventBridge Scheduler ONE-SHOT per dose: Name='dose-{patientId}-{doseId}',
//      GroupName='medadhere-prod', ScheduleExpression = the Plan-01 OFFSET-LESS at(...) builder,
//      ScheduleExpressionTimezone = patient.timezone (AWS owns DST — never a hand-computed offset),
//      FlexibleTimeWindow Mode 'OFF', ActionAfterCompletion 'DELETE', Target {Arn: OUTBOUND_FN_ARN,
//      RoleArn: SCHEDULER_TARGET_ROLE_ARN, Input: JSON {patientId, doseId}}.
//
// MED-6 partial-failure compensation. The patient + dose_schedule INSERTs run inside ONE pg
// transaction (BEGIN before the inserts). The schedules are created AFTER the inserts but BEFORE the
// COMMIT. If ANY CreateSchedule rejects partway through:
//   (a) the schedules already created for THIS patient are deleted (via the relocated deactivation
//       helper — a paginated ListSchedules(NamePrefix='dose-{patientId}-') + DeleteSchedule, so it
//       catches exactly the just-created ones), and
//   (b) the transaction is ROLLBACKed (the patient + dose rows never persist),
// then the failure is re-thrown. The handler NEVER returns success on a partial failure — the DB never
// holds unscheduled doses and no orphan schedule remains.
//
// The re-exported deactivateSchedules(patientId, prefix?) is the OPS-01/STUDY-05 deletion mechanism
// (reused by Phases 4/5 for STOP/admin deactivation — both 'dose-' and 'timeout-' prefixes — by the
// MED-6 compensation path above, and by the LOW-8 drain script). It lives in
// backend/src/lib/scheduler-deactivate.ts since Phase 4 (04-01 item 3).
//
// Module mode: CommonJS (F11) — `__dirname` + `readFileSync` resolve natively under NodeNext, so the
// bundled CA PEM (copied alongside this handler by the CDK afterBundling cp) is read directly.
//
// Single-source TLS (F28) + CA pinning (M-2): the shared db-pool provider supplies the explicit pg
// `ssl` object ({ ca: <pinned RDS global bundle>, rejectUnauthorized: true }) as the ONE
// TLS source. NEVER rejectUnauthorized:false, NEVER a PGSSLMODE env. The DB credential is fetched from
// Secrets Manager (D-06 — never an env var). No runtime third-party (RxNorm/OpenFDA/DPD) call ever runs
// in this hot path — the Enroll Lambda only writes medication_name; the label freeze is the offline
// Plan-04 script.

import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { PoolClient } from 'pg';
import { SchedulerClient, CreateScheduleCommand } from '@aws-sdk/client-scheduler';
import {
  buildScheduleExpression,
  computeScheduledAtUtc,
  generateDoseSchedule,
  SCHEDULE_GROUP_NAME,
} from '@medadhere/shared';
import { createDbPoolProvider } from '../shared/db-pool';

/** Reuse the AWS SDK clients across warm invocations (module scope → fewer TLS handshakes). */
const sm = new SecretsManagerClient({});
/** Module-scoped SchedulerClient — reused across warm invokes (Pattern 1). */
const scheduler = new SchedulerClient({});

const getPool = createDbPoolProvider(sm);

/** The enrollment payload (operator-controlled in Phase 3 — the seed/invoke path; no public surface). */
export interface EnrollEvent {
  /** Verified Cognito ID-token subject of the clinician who owns this patient. */
  owner_clinician_sub: string;
  /** Patient phone in E.164 (e.g. '+15145550123'). */
  phone: string;
  /** The medication the patient is being monitored for (PIPE-08). */
  medication_name: string;
  /** Optional patient display name. */
  display_name?: string;
  /** IANA timezone (e.g. 'America/Toronto'). Defaults to 'America/Toronto'. */
  timezone?: string;
  /** First local calendar date of the horizon, 'YYYY-MM-DD'. Defaults to today (operator-supplied). */
  startDate: string;
  /**
   * Number of consecutive local days to schedule (>= 1). Real callers now thread this explicitly;
   * 2 remains the legacy fallback for direct unit payloads and the existing resolved cadence.
   */
  days?: number;
  /** Patient-local wall-clock dose times, 'HH:mm' (one or more). Defaults to ['09:00']. */
  localTimes?: readonly string[];
  /**
   * D14 — mark this patient as a test/validation-cohort row (STUDY-04 `is_test`). Threaded end-to-end from
   * the enroll-api zod / the seed `--is-test` flag into the patient INSERT; the reads BADGE it, never filter
   * on it. Optional here so existing invokers (unit payloads) stay valid; resolves to `false` when omitted
   * (matching the schema DEFAULT false).
   */
  is_test?: boolean;
}

/**
 * E.164 phone (U-15). The enroll-api zod validates this at the HTTP boundary, but the SEED path invokes the
 * Enroll Lambda directly (bypassing that zod), so the check is MIRRORED here — throw-based, like the
 * existing `{ phone, medication_name }` guard — so a malformed phone never reaches the patient INSERT.
 */
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;
const CLINICIAN_SUB_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

/** The Enroll handler result. */
export interface EnrollResult {
  enrolled: boolean;
  patientId: string;
  doseCount: number;
}

export const ACTIVE_PATIENT_CONFLICT_CODE = 'ENROLL_ACTIVE_PATIENT_CONFLICT';

/** Stable non-PHI conflict propagated through Lambda FunctionError as `errorType`. */
export class ActivePatientConflictError extends Error {
  constructor() {
    super(ACTIVE_PATIENT_CONFLICT_CODE);
    this.name = 'ActivePatientConflictError';
  }
}

/**
 * Build (or return the cached) module-scoped pg.Pool. Cloned VERBATIM from data-api/handler.ts: the DB
 * credential is fetched from Secrets Manager (D-06 — never an env var) ONCE per cold container; the
 * connection env vars are guarded with actionable errors; TLS is single-sourced (F28) via the explicit
 * `ssl` object with the pinned RDS global CA bundle + rejectUnauthorized:true (M-2 / T-03-08).
 */

// Phase-4 (04-01 item 3): deactivateSchedules is RELOCATED to backend/src/lib/scheduler-deactivate.ts,
// prefix-parameterized ('dose' | 'timeout') with the trailing-dash 42/45-char NamePrefix ratified by the
// Phase-4 plan. Imported for the MED-6 compensation path below and re-exported so existing consumers
// (the LOW-8 drain script, Phase-4/5 STOP/admin deactivation) keep their import path.
import { deactivateSchedules } from '../lib/scheduler-deactivate';
export { deactivateSchedules };

/**
 * Enroll Lambda entrypoint. Writes the patient + dose_schedule rows and creates the per-dose EventBridge
 * Scheduler one-shots (timezone-correct, name-conventioned, auto-deleting), MED-6 compensated.
 */
export async function handler(event: EnrollEvent): Promise<EnrollResult> {
  const ownerClinicianSub = event?.owner_clinician_sub;
  const phone = event?.phone;
  const medicationName = event?.medication_name;
  if (!ownerClinicianSub || !CLINICIAN_SUB_PATTERN.test(ownerClinicianSub)) {
    throw new Error('Enroll event must carry a UUID owner_clinician_sub');
  }
  if (!phone || !medicationName) {
    throw new Error('Enroll event must carry { phone, medication_name }');
  }
  // U-15 — mirror the enroll-api E.164 zod (the seed path bypasses it). Throw before any DB reach.
  if (!E164_PATTERN.test(phone)) {
    throw new Error('Enroll event phone must be E.164 (^\\+[1-9]\\d{1,14}$)');
  }
  const timezone = event.timezone ?? 'America/Toronto';
  if (!isValidTimezone(timezone)) {
    throw new Error('Enroll event timezone must be supported by Intl.DateTimeFormat');
  }
  const days = event.days ?? 2; // resolved default cadence (SC4 uses 1)
  const localTimes = event.localTimes ?? ['09:00'];
  const isTest = event.is_test ?? false; // D14 — resolves to false when omitted (schema DEFAULT false)
  const startDate = event.startDate;
  if (!startDate) {
    throw new Error('Enroll event must carry a startDate (YYYY-MM-DD)');
  }

  const outboundFnArn = process.env.OUTBOUND_FN_ARN;
  const schedulerTargetRoleArn = process.env.SCHEDULER_TARGET_ROLE_ARN;
  if (!outboundFnArn || !schedulerTargetRoleArn) {
    throw new Error('OUTBOUND_FN_ARN / SCHEDULER_TARGET_ROLE_ARN env vars must both be set');
  }

  // The dose list for the configured horizon (Plan-01 pure helper — DST-safe calendar arithmetic).
  const slots = generateDoseSchedule({ startDate, days, localTimes, timezone });

  const db = await getPool();
  const client: PoolClient = await db.connect();

  // patientId is set once the patient row is inserted; the MED-6 compensation keys its schedule cleanup
  // off it — a paginated ListSchedules(NamePrefix='dose-{patientId}') + DeleteSchedule sweeps every
  // schedule created for this patient. No local tracking array (MED-4): a schedule created server-side
  // whose CreateSchedule response was lost has no local record but is still swept by the NamePrefix scan.
  let patientId = '';

  try {
    await client.query('BEGIN');

    // 0. One ACTIVE patient per phone (Plan 04-02 companion, gate fix REV-H4): reject with a stable,
    //    non-PHI conflict. Runs INSIDE the transaction; the
    //    uq_patient_active_phone partial unique index is the DB-level race backstop (a concurrent
    //    enroll that slips past this read surfaces as 23505 and is MED-6-compensated below).
    //    Deactivated rows (is_active=false) never block re-enrollment.
    const activeDup = await client.query(
      `SELECT 1 FROM patient WHERE phone = $1 AND is_active = true`,
      [phone],
    );
    if ((activeDup.rowCount ?? 0) > 0) {
      throw new ActivePatientConflictError();
    }

    // 1. INSERT the patient (parameterized; medication_name set — PIPE-08).
    const patientRes = await client.query(
      `INSERT INTO patient
         (owner_clinician_sub, phone, display_name, timezone, medication_name, is_test)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
      [ownerClinicianSub, phone, event.display_name ?? null, timezone, medicationName, isTest],
    );
    patientId = (patientRes.rows[0] as { id: string }).id;

    // 2. INSERT each dose_schedule row (parameterized) with the DST-correct stored instant (PIPE-09).
    const doseIds: string[] = [];
    for (const slot of slots) {
      const scheduledAtUtc = computeScheduledAtUtc({
        doseDate: slot.doseDate,
        localDoseTime: slot.localDoseTime,
        timezone,
      });
      const doseRes = await client.query(
        `INSERT INTO dose_schedule
           (patient_id, scheduled_at, local_dose_time, schedule_timezone, dose_date)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
        [patientId, scheduledAtUtc, slot.localDoseTime, timezone, slot.doseDate],
      );
      doseIds.push((doseRes.rows[0] as { id: string }).id);
    }

    // 3. Create one EventBridge Scheduler one-shot per dose. Offset-less at() + tz param (AWS owns DST).
    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i]!;
      const doseId = doseIds[i]!;
      // EventBridge Scheduler caps schedule Name at 64 chars; `dose-{patientId}-{doseId}` with two
      // UUIDs is 78, so truncate to fit. The full `dose-${patientId}` prefix (42 chars) is preserved
      // for NamePrefix-based deactivation/compensation; the full doseId still travels in Target Input.
      const name = `dose-${patientId}-${doseId}`.slice(0, 64);
      await scheduler.send(
        new CreateScheduleCommand({
          Name: name,
          GroupName: SCHEDULE_GROUP_NAME,
          ScheduleExpression: buildScheduleExpression({
            doseDate: slot.doseDate,
            localDoseTime: slot.localDoseTime,
          }),
          ScheduleExpressionTimezone: timezone, // PIPE-09 — AWS owns DST resolution
          FlexibleTimeWindow: { Mode: 'OFF' },
          ActionAfterCompletion: 'DELETE',
          Target: {
            Arn: outboundFnArn,
            RoleArn: schedulerTargetRoleArn,
            Input: JSON.stringify({ patientId, doseId }),
          },
        }),
      );
    }

    // All schedules created → commit the patient + dose rows.
    await client.query('COMMIT');
    return { enrolled: true, patientId, doseCount: doseIds.length };
  } catch (err: unknown) {
    // MED-6 — compensate before surfacing the failure: roll back the rows AND delete any schedules that
    // were already created for this patient, so the DB holds no unscheduled doses and no orphan schedule
    // remains. ROLLBACK first (cheap, local), then the remote cleanup.
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors — the throw below surfaces the original failure
    }
    // MED-4 — run the cleanup whenever a patient row was inserted, NOT only when a name was locally
    // tracked: if the FIRST CreateSchedule created its schedule server-side but the response was lost
    // (network drop), no name is tracked yet, so a length-gated cleanup would orphan it. The paginated
    // deactivation helper lists by NamePrefix='dose-{patientId}' and deletes every match — exactly the
    // schedules created for this patient (zero or more), so it is always safe to call.
    if (patientId) {
      try {
        await deactivateSchedules(patientId);
      } catch {
        // ignore cleanup errors — surface the original failure below; an orphan is far less likely than
        // leaving the original error unreported.
      }
    }
    if (err instanceof ActivePatientConflictError) throw err;
    const message = err instanceof Error ? err.message : 'unknown enroll error';
    throw new Error(
      `Enroll failed (compensated — rows rolled back, schedules deleted): ${message}`,
    );
  } finally {
    client.release();
  }
}
