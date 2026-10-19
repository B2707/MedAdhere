// backend/src/deactivate/handler.ts
//
// The in-VPC clinician Deactivation Lambda (Plan 05-03 / STUDY-05 / SC4) — the DEDICATED least-privilege
// write fn behind the SAME DataApi HTTP API + Cognito JWT defaultAuthorizer as the read-only SELECT-1
// health route. Q4: the SELECT-1 health fn must NEVER carry scheduler IAM, so clinician deactivation gets
// its own fn (this one) rather than a router on the health handler:
//
//   Bearer id_token → API GW HTTP API (native Cognito JWT authorizer + handler claims gate)
//     → POST /api/patients/{id}/deactivate → THIS Lambda → is_active=false + the dose-/timeout- sweep → 200
//
// Handler contract (M1 — ORDER MATTERS):
//   (a) require valid ID-token clinician claims → generic 401 BEFORE path, DB, or scheduler reach;
//   (b) z.string().uuid().parse(id) → 400 on a non-UUID before DB or scheduler reach;
//   (c) owner-scoped UPDATE patient SET is_active=false WHERE id=$1 AND owner_clinician_sub=$2. The
//       clinician path does NOT set opted_out_at (that is the patient-STOP semantic); an already-inactive
//       owned patient still matches → idempotent clean 200;
//   (d) 404 if the UPDATE affected 0 rows (unknown, foreign-owned, or ownerless patient);
//   (e) then deactivateSchedules(id,'dose') + (id,'timeout') — sweep BOTH prefixes (the 45-char
//       `timeout-{patientId}-` NamePrefix survives the 64-char truncation, so the sweep still matches the
//       truncated one-shot names). The helper (scheduler-deactivate.ts) is imported AS-IS.
//
// Partial-sweep failure semantics (mirror the inbound STOP path, inbound/handler.ts:451-465): the
// compliance-critical is_active=false write commits FIRST, THEN the schedules are swept. deactivateSchedules
// throws on the first AWS error and that throw PROPAGATES (a 5xx) — never swallowed into a false-success
// 200. Rationale: the committed is_active=false plus the Outbound/Timeout is_active re-check (05-01 H1) make
// any un-swept schedule that fires a clean skip, and the whole route is idempotent (a client retry re-runs
// the UPDATE — still rowCount 1 — and re-sweeps), so surfacing the error (the OPS-02 Lambda-Errors signal +
// the operator/dashboard 5xx) is strictly safer than hiding an orphaned-schedule leak behind a 200.
//
// Authorization is fail-closed in the write itself: the authenticated clinician sub must equal the
// patient's owner_clinician_sub. The same 404 covers unknown and unowned records, and no schedule sweep
// occurs unless that owner-scoped UPDATE matched.
//
// Logging (healthcare-phi-compliance / U-16): `deactivate_recorded` /
// `deactivate_not_found` / `deactivate_bad_request` carry no patient or clinician identifiers.
//
// Module mode: CommonJS (F11); the shared db-pool provider supplies F28 single-source TLS,
// M-2 pinned CA, D-11 max 2, and per-cold-start secret loading. No Twilio, no SSM, no LLM — the write + the scheduler
// sweep are the only side effects.

import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import { deactivateSchedules } from '../lib/scheduler-deactivate';
import { ClinicianClaimsError, requireClinicianClaims } from '../shared/clinician-claims';
import { createDbPoolProvider } from '../shared/db-pool';

/** Reuse the AWS SDK client across warm invocations (module scope → fewer TLS handshakes). */
const sm = new SecretsManagerClient({});

const getPool = createDbPoolProvider(sm);

/** The API GW v2 HTTP-proxy event shape this handler consumes. */
interface ApiGatewayProxyEventV2 {
  pathParameters?: Record<string, string | undefined>;
  requestContext?: {
    authorizer?: {
      jwt?: { claims?: Record<string, unknown> };
    };
  };
}

/** The API GW HTTP-integration response shape (the data-api/handler.ts shape). */
interface HttpResult {
  statusCode: number;
  headers: { 'content-type': string };
  body: string;
}

/** The path-parameter validator — the zod .parse() D-16 gate (M1: a non-UUID 400s before any side effect). */
const patientIdSchema = z.string().uuid();

/**
 * The clinician-deactivation UPDATE (STUDY-05). Exported so its real-PG write-contract test drives the
 * EXACT handler SQL (no drift between the handler and the semantic proof). $1 = patientId and $2 = the
 * authenticated clinician sub. This path sets ONLY is_active=false — NOT opted_out_at (that is the
 * patient-STOP semantic). An already-inactive row owned by that clinician still matches (rowCount 1 →
 * idempotent clean 200); unknown, foreign-owned, and ownerless rows all match nothing (rowCount 0 → 404).
 */
export const DEACTIVATE_PATIENT_SQL = `UPDATE patient SET is_active = false WHERE id = $1 AND owner_clinician_sub = $2`;

/** Identifier-free structured metric line (counts only — U-16). */
function logMetric(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

/** Build the API GW HTTP-integration response envelope. */
function json(statusCode: number, body: Record<string, unknown>): HttpResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * Build (or return the cached) module-scoped pg.Pool. Cloned VERBATIM from timeout/handler.ts: the DB
 * credential is fetched from Secrets Manager (D-06 — never an env var) ONCE per cold container; the
 * connection env vars are guarded with actionable errors; TLS is single-sourced (F28) via the explicit
 * `ssl` object with the pinned RDS global CA bundle + rejectUnauthorized:true (M-2 / T-03-08).
 */

/**
 * Clinician Deactivation Lambda entrypoint. Verify ID-token claims before parsing caller-controlled path
 * input, then perform an owner-scoped UPDATE and sweep schedules only after a matched row. Unknown,
 * foreign-owned, and ownerless rows share the same 404 response, preventing patient-enumeration leaks.
 */
export async function handler(event: ApiGatewayProxyEventV2): Promise<HttpResult> {
  let clinicianSub: string;
  try {
    clinicianSub = requireClinicianClaims(event).sub;
  } catch (error) {
    if (!(error instanceof ClinicianClaimsError)) throw error;
    logMetric({ metric: 'deactivate_unauthorized' });
    return json(401, { error: 'unauthorized' });
  }

  // Validate the path only after authentication. A non-UUID (or missing id) still 400s before DB/scheduler.
  let patientId: string;
  try {
    patientId = patientIdSchema.parse(event?.pathParameters?.id);
  } catch {
    logMetric({ metric: 'deactivate_bad_request' });
    return json(400, { error: 'invalid patient id' });
  }

  const db = await getPool();

  // Owner scope is part of the atomic write predicate. Zero rows intentionally conflates unknown,
  // foreign-owned, and legacy ownerless records; no scheduler side effect occurs in any of those cases.
  const updated = await db.query(DEACTIVATE_PATIENT_SQL, [patientId, clinicianSub]);
  if ((updated.rowCount ?? 0) === 0) {
    logMetric({ metric: 'deactivate_not_found' });
    return json(404, { error: 'patient not found' });
  }

  // Sweep every patient schedule prefix, mirroring the inbound STOP path. The is_active=false write
  // has ALREADY committed above; a partial sweep SURFACES — deactivateSchedules
  // throws on the first AWS error and that throw propagates (a 5xx), never a false-success 200 (see the header).
  const doseDeleted = await deactivateSchedules(patientId, 'dose');
  const reminderDeleted = await deactivateSchedules(patientId, 'reminder');
  const timeoutDeleted = await deactivateSchedules(patientId, 'timeout');

  logMetric({
    metric: 'deactivate_recorded',
    schedulesDeleted: doseDeleted + reminderDeleted + timeoutDeleted,
  });
  return json(200, { deactivated: true });
}
