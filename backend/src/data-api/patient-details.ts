// backend/src/data-api/patient-details.ts
//
// POST /api/patients/{id}/details — the doctor-owned correction of a patient's contact details
// (people change numbers and names). It rides the SAME in-VPC data-API fn as the doctor-only
// clinical-history writes (zero IAM delta, zero new Lambda), behind the SAME Cognito JWT authorizer.
//
// Posture mirrors the reminder-limit write exactly: zod `.parse()` 400-FIRST before any DB reach
// (D-16), owner_clinician_sub bound into the statement so another clinician's row is invisible,
// and messaging_state_version as the optimistic-concurrency guard — the phone IS messaging state,
// so a change to it must invalidate a concurrently-edited messaging control.
//
// The UPDATE carries its own IS-DISTINCT-FROM guard so a resubmit of unchanged values affects zero
// rows instead of burning a version. Zero rows is therefore ambiguous, and the follow-up SELECT
// disambiguates: no row → 404; same version → nothing changed (200, changed:false); different
// version → a real 409 conflict.
//
// Phone uniqueness is enforced by the database (uq_patient_active_phone, partial on is_active), so
// a collision surfaces as PG 23505 and maps to a 409 that names no other patient.

import type { Pool } from 'pg';
import { patientDetailsInputSchema, patientDetailsResponseSchema } from '@medadhere/shared';
import { z } from 'zod';

export const PATIENT_DETAILS_ROUTE_KEY = 'POST /api/patients/{id}/details';

/** PG unique-violation code — uq_patient_active_phone (one ACTIVE patient per phone). */
const PG_UNIQUE_VIOLATION = '23505';
const MAX_BODY_BYTES = 4_096;
const patientIdSchema = z.string().uuid();

export const UPDATE_PATIENT_DETAILS_SQL = `UPDATE patient
      SET display_name = COALESCE($3, display_name),
          phone = COALESCE($4, phone),
          messaging_state_version = messaging_state_version + 1
    WHERE id = $1
      AND owner_clinician_sub = $2
      AND messaging_state_version = $5
      AND (display_name IS DISTINCT FROM COALESCE($3, display_name)
           OR phone IS DISTINCT FROM COALESCE($4, phone))
RETURNING display_name, phone, messaging_state_version`;

export const SELECT_PATIENT_DETAILS_SQL = `SELECT display_name, phone, messaging_state_version
       FROM patient
      WHERE id = $1
        AND owner_clinician_sub = $2`;

interface PatientDetailsEvent {
  routeKey?: string;
  pathParameters?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
}

interface PatientDetailsDependencies {
  getPool: () => Promise<Pool>;
  logMetric: (entry: Record<string, unknown>) => void;
}

export interface PatientDetailsResult {
  statusCode: number;
  body: Record<string, unknown>;
}

interface PatientDetailsRow {
  display_name: string | null;
  phone: string;
  messaging_state_version: number;
}

function parseBody(event: PatientDetailsEvent): z.infer<typeof patientDetailsInputSchema> {
  if (
    event.isBase64Encoded === true ||
    typeof event.body !== 'string' ||
    Buffer.byteLength(event.body, 'utf8') > MAX_BODY_BYTES
  ) {
    throw new z.ZodError([]);
  }
  try {
    return patientDetailsInputSchema.parse(JSON.parse(event.body) as unknown);
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    throw new z.ZodError([]);
  }
}

function success(row: PatientDetailsRow, changed: boolean): PatientDetailsResult {
  return {
    statusCode: 200,
    body: patientDetailsResponseSchema.parse({
      displayName: row.display_name,
      phoneNumber: row.phone,
      messagingStateVersion: row.messaging_state_version,
      changed,
    }),
  };
}

/** Doctor-only contact-detail correction. The agent never receives this route. */
export async function handlePatientDetailsRoute(
  event: PatientDetailsEvent,
  clinicianSub: string,
  dependencies: PatientDetailsDependencies,
): Promise<PatientDetailsResult> {
  let patientId: string;
  let input: z.infer<typeof patientDetailsInputSchema>;
  try {
    patientId = patientIdSchema.parse(event.pathParameters?.id);
    input = parseBody(event);
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    dependencies.logMetric({ metric: 'patient_details_bad_request' });
    return { statusCode: 400, body: { error: 'invalid request' } };
  }

  const db = await dependencies.getPool();
  const parameters = [
    patientId,
    clinicianSub,
    input.displayName ?? null,
    input.phoneNumber ?? null,
    input.expectedVersion,
  ];

  let updated;
  try {
    updated = await db.query<PatientDetailsRow>(UPDATE_PATIENT_DETAILS_SQL, parameters);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === PG_UNIQUE_VIOLATION
    ) {
      dependencies.logMetric({ metric: 'patient_details_phone_taken' });
      return {
        statusCode: 409,
        body: { error: 'another active patient already uses this phone number' },
      };
    }
    throw error;
  }

  const row = updated.rows[0];
  if (row) {
    dependencies.logMetric({ metric: 'patient_details_recorded' });
    return success(row, true);
  }

  // Zero rows: missing/foreign patient, an unchanged resubmit, or a genuine version conflict.
  const existing = await db.query<PatientDetailsRow>(SELECT_PATIENT_DETAILS_SQL, [
    patientId,
    clinicianSub,
  ]);
  const current = existing.rows[0];
  if (!current) {
    dependencies.logMetric({ metric: 'patient_details_not_found' });
    return { statusCode: 404, body: { error: 'patient not found' } };
  }
  if (current.messaging_state_version === input.expectedVersion) {
    dependencies.logMetric({ metric: 'patient_details_unchanged' });
    return success(current, false);
  }
  dependencies.logMetric({ metric: 'patient_details_version_conflict' });
  return {
    statusCode: 409,
    body: {
      error: 'messaging state version conflict',
      messagingStateVersion: current.messaging_state_version,
    },
  };
}
