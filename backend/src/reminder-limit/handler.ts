import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  reminderLimitInputSchema,
  reminderLimitResponseSchema,
  type ReminderLimitInput,
} from '@medadhere/shared';
import { z } from 'zod';
import { ClinicianClaimsError, requireClinicianClaims } from '../shared/clinician-claims';
import { createDbPoolProvider } from '../shared/db-pool';

const getPool = createDbPoolProvider(new SecretsManagerClient({}));
const patientIdSchema = z.string().uuid();
const MAX_BODY_BYTES = 4_096;

interface ReminderLimitEvent {
  pathParameters?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { authorizer?: { jwt?: { claims?: Record<string, unknown> } } };
}

interface HttpResult {
  statusCode: number;
  headers: { 'content-type': string };
  body: string;
}

export const SET_REMINDER_LIMIT_SQL = `UPDATE patient
      SET reminder_limit = $3,
          messaging_state_version = messaging_state_version + 1
    WHERE id = $1
      AND owner_clinician_sub = $2
      AND messaging_state_version = $4
RETURNING reminder_limit, messaging_state_version`;

export const SELECT_MESSAGING_STATE_SQL = `SELECT messaging_state_version
       FROM patient
      WHERE id = $1
        AND owner_clinician_sub = $2`;

function logMetric(metric: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ metric, ...details }));
}

function json(statusCode: number, body: Record<string, unknown>): HttpResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

function parseBody(event: ReminderLimitEvent): ReminderLimitInput {
  if (
    event.isBase64Encoded === true ||
    typeof event.body !== 'string' ||
    Buffer.byteLength(event.body, 'utf8') > MAX_BODY_BYTES
  ) {
    throw new z.ZodError([]);
  }
  try {
    return reminderLimitInputSchema.parse(JSON.parse(event.body) as unknown);
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    throw new z.ZodError([]);
  }
}

export async function handler(event: ReminderLimitEvent): Promise<HttpResult> {
  let clinicianSub: string;
  try {
    clinicianSub = requireClinicianClaims(event).sub;
  } catch (error) {
    if (!(error instanceof ClinicianClaimsError)) throw error;
    logMetric('reminder_limit_unauthorized');
    return json(401, { error: 'unauthorized' });
  }

  let patientId: string;
  let input: ReminderLimitInput;
  try {
    patientId = patientIdSchema.parse(event.pathParameters?.id);
    input = parseBody(event);
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    logMetric('reminder_limit_bad_request');
    return json(400, { error: 'invalid request' });
  }

  const db = await getPool();
  const updated = await db.query<{
    reminder_limit: number;
    messaging_state_version: number;
  }>(SET_REMINDER_LIMIT_SQL, [patientId, clinicianSub, input.reminderLimit, input.expectedVersion]);

  if ((updated.rowCount ?? 0) === 0) {
    const existing = await db.query<{ messaging_state_version: number }>(
      SELECT_MESSAGING_STATE_SQL,
      [patientId, clinicianSub],
    );
    if (existing.rows.length === 0) {
      logMetric('reminder_limit_not_found');
      return json(404, { error: 'patient not found' });
    }
    const messagingStateVersion = existing.rows[0]!.messaging_state_version;
    logMetric('reminder_limit_version_conflict');
    return json(409, { error: 'messaging state version conflict', messagingStateVersion });
  }

  const row = updated.rows[0]!;
  const response = reminderLimitResponseSchema.parse({
    reminderLimit: row.reminder_limit,
    messagingStateVersion: row.messaging_state_version,
  });
  logMetric('reminder_limit_recorded', { reminderLimit: response.reminderLimit });
  return json(200, response);
}
