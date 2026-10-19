// backend/src/enroll-api/core.ts
//
// The PURE core of the enroll-api WRITE PATH (DASH-05 / D2 / D14 / U-15) — written against an injected
// `invokeEnroll` seam so it is fully unit-testable with no @aws-sdk, no AWS, and no network (the same DI
// posture as export-anon/core.ts). The Lambda entry (handler.ts) supplies the ONE real seam: a synchronous
// (RequestResponse) invoke of the in-VPC Enroll Lambda.
//
// Contract (D2 — ORDER + SECURITY matter):
//   (a) parse + zod-validate the request body → 400 FIRST on any failure (generic, NEVER echoing the
//       submitted phone / medication_name — the enroll-api sits behind the Cognito JWT authorizer but
//       still validates as a boundary, and the /patients/new action validates again for UX);
//   (b) map the validated body → an EnrollEvent (is_test carried end-to-end — D14; startDate defaulted to
//       today when the form omits it) and SYNC-invoke the Enroll Lambda;
//   (c) map the outcome:
//         success                     → 201 { patientId }
//         dup-active FunctionError     → the STATIC 409 string (D2), classified only by the Enroll
//                                        Lambda's stable non-PHI error type;
//         any other FunctionError /
//         invoke throw / bad result    → generic 502 (no internals leaked).
//   Logging is id-only / metric-only (never phone, medication_name, the prior UUID, or the SQL).

import { DateTime } from 'luxon';
import { z } from 'zod';

/** E.164 phone (U-15 — the SAME anchored pattern the Enroll Lambda mirrors so the seed path is covered too). */
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;
/** Patient-local wall-clock dose time 'HH:mm' (00:00–23:59). */
const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
/** 'YYYY-MM-DD' local calendar date. */
const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Cap on the number of daily dose times (D2 — a sane bound; tested). */
export const MAX_LOCAL_TIMES = 4;
/** Cap on the enrollment horizon (mirrored in the dashboard action; no shared hoist mid-gate). */
export const MAX_ENROLL_DAYS = 14;

/** Intl-backed timezone validation at the API boundary, including POSIX zones supported by the runtime. */
function isValidIanaZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * The enrollment request body schema (D2). `is_test` is REQUIRED (D14 — the form always sends it, checked
 * or not). `startDate` is optional (the form has no start-date field → the core defaults it to today).
 */
export const enrollApiBodySchema = z.object({
  phone: z.string().regex(E164_PATTERN),
  medication_name: z.string().min(1).max(120),
  display_name: z.string().min(1).max(80).optional(),
  timezone: z.string().min(1).max(64).refine(isValidIanaZone).optional(),
  startDate: z.string().regex(YMD_PATTERN).optional(),
  days: z.number().int().min(1).max(MAX_ENROLL_DAYS).optional(),
  localTimes: z.array(z.string().regex(HHMM_PATTERN)).min(1).max(MAX_LOCAL_TIMES).optional(),
  is_test: z.boolean(),
});

export type EnrollApiBody = z.infer<typeof enrollApiBodySchema>;

/** The EnrollEvent payload forwarded to the Enroll Lambda (mirrors backend/src/enroll EnrollEvent). */
export interface EnrollInvokePayload {
  owner_clinician_sub: string;
  phone: string;
  medication_name: string;
  display_name?: string;
  timezone?: string;
  startDate: string;
  days?: number;
  localTimes?: string[];
  is_test: boolean;
}

/**
 * The SDK-free outcome of invoking the Enroll Lambda (RequestResponse). `functionError` is true when the
 * Enroll Lambda THREW (API GW sets `FunctionError`), in which case `payloadText` is the AWS error object
 * `{ errorType, errorMessage, trace }` — matched ONLY to classify, never forwarded (D2).
 */
export interface EnrollInvokeOutcome {
  functionError: boolean;
  payloadText: string;
}

export type InvokeEnroll = (payload: EnrollInvokePayload) => Promise<EnrollInvokeOutcome>;

/** The API GW HTTP-integration response shape (mirrors deactivate/data-api). */
export interface HttpResult {
  statusCode: number;
  headers: { 'content-type': string };
  body: string;
}

/** The STATIC 409 body (D2) — reveals nothing about the prior patient row (no UUID, no SQL). */
export const DUP_ACTIVE_MESSAGE =
  'a patient with this phone may already be enrolled — check the list';

/** Stable custom Error.name emitted by the Enroll Lambda for a duplicate active phone. */
const ACTIVE_PATIENT_CONFLICT_ERROR_TYPE = 'ActivePatientConflictError';

/** A generic failure body — no internal detail, safe for the client + the /patients/new action to surface. */
const GENERIC_FAILURE = 'could not complete enrollment — please try again';

/** PII-safe structured metric line (metric name + counts ONLY — never phone / medication_name / UUID / SQL). */
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

/** Classify only the stable non-PHI error type; messages are opaque and never inspected or surfaced. */
function classifyFunctionError(payloadText: string): 'dup-active' | 'other' {
  try {
    const errorType = (JSON.parse(payloadText) as { errorType?: unknown }).errorType;
    return errorType === ACTIVE_PATIENT_CONFLICT_ERROR_TYPE ? 'dup-active' : 'other';
  } catch {
    // A non-JSON error payload is treated as an opaque 'other' failure — still never surfaced.
    return 'other';
  }
}

/**
 * The enroll-api core (D2). Validates the body (400-first, generic), maps it to an EnrollEvent (is_test +
 * defaulted startDate), invokes the Enroll Lambda via the injected seam, and maps the outcome to
 * 201 / static-409 / 502 — never leaking the Enroll throw's UUID + SQL.
 */
export async function runEnrollApi(args: {
  rawBody: string | undefined;
  ownerClinicianSub: string;
  invokeEnroll: InvokeEnroll;
  now?: () => Date;
}): Promise<HttpResult> {
  // (a) parse + validate the body FIRST (a bad body 400s before any invoke). Generic errors only.
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(args.rawBody ?? '');
  } catch {
    logMetric({ metric: 'enroll_api_bad_request' });
    return json(400, { error: 'invalid enrollment request' });
  }
  const parsed = enrollApiBodySchema.safeParse(parsedJson);
  if (!parsed.success) {
    logMetric({ metric: 'enroll_api_validation_failed' });
    return json(400, { error: 'invalid enrollment request' });
  }
  const body = parsed.data;

  // (b) map → EnrollEvent. "Today" is the submitted IANA zone's calendar day, matching the Enroll
  // Lambda's timezone fallback exactly; is_test + days are carried end-to-end.
  const zone = body.timezone ?? 'America/Toronto';
  const startDate =
    body.startDate ??
    DateTime.fromJSDate(args.now ? args.now() : new Date())
      .setZone(zone)
      .toISODate();
  if (startDate === null) {
    logMetric({ metric: 'enroll_api_validation_failed' });
    return json(400, { error: 'invalid enrollment request' });
  }
  const payload: EnrollInvokePayload = {
    owner_clinician_sub: args.ownerClinicianSub,
    phone: body.phone,
    medication_name: body.medication_name,
    display_name: body.display_name,
    timezone: body.timezone,
    startDate,
    days: body.days,
    localTimes: body.localTimes,
    is_test: body.is_test,
  };

  let outcome: EnrollInvokeOutcome;
  try {
    outcome = await args.invokeEnroll(payload);
  } catch {
    logMetric({ metric: 'enroll_api_invoke_failed' });
    return json(502, { error: GENERIC_FAILURE });
  }

  // (c) map the outcome. A FunctionError means the Enroll Lambda threw — classify WITHOUT forwarding.
  if (outcome.functionError) {
    if (classifyFunctionError(outcome.payloadText) === 'dup-active') {
      logMetric({ metric: 'enroll_api_dup_active' });
      return json(409, { error: DUP_ACTIVE_MESSAGE });
    }
    logMetric({ metric: 'enroll_api_enroll_error' });
    return json(502, { error: GENERIC_FAILURE });
  }

  // Success — parse the Enroll result and surface ONLY the new patientId.
  let result: { enrolled?: unknown; patientId?: unknown };
  try {
    result = JSON.parse(outcome.payloadText) as { enrolled?: unknown; patientId?: unknown };
  } catch {
    logMetric({ metric: 'enroll_api_bad_result' });
    return json(502, { error: GENERIC_FAILURE });
  }
  if (result.enrolled !== true || typeof result.patientId !== 'string') {
    logMetric({ metric: 'enroll_api_bad_result' });
    return json(502, { error: GENERIC_FAILURE });
  }
  logMetric({ metric: 'enroll_api_enrolled' });
  return json(201, { patientId: result.patientId });
}
