import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  clinicalFactRevisionInputSchema,
  medicationRevisionInputSchema,
  type ClinicalFactRevisionInput,
  type MedicationRevisionInput,
} from '@medadhere/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ClinicianClaimsError, requireClinicianClaims } from '../shared/clinician-claims';
import { createDbPoolProvider } from '../shared/db-pool';
import {
  ClinicalRecordConflictError,
  ClinicalRecordNotFoundError,
  appendClinicalFactRevision,
  appendMedicationRevision,
  listClinicalHistory,
} from '../clinical-knowledge/repository';

interface ClinicalHistoryEvent {
  routeKey?: string;
  pathParameters?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    authorizer?: { jwt?: { claims?: Record<string, unknown> } };
  };
}

interface HttpResult {
  statusCode: number;
  headers: { 'content-type': string };
  body: string;
}

const patientIdSchema = z.string().uuid();
const MAX_BODY_BYTES = 65_536;
const getPool = createDbPoolProvider(new SecretsManagerClient({}));

function json(statusCode: number, body: Record<string, unknown>): HttpResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

function parseBody<T>(event: ClinicalHistoryEvent, schema: z.ZodType<T>): T {
  if (
    event.isBase64Encoded === true ||
    typeof event.body !== 'string' ||
    Buffer.byteLength(event.body, 'utf8') > MAX_BODY_BYTES
  ) {
    throw new z.ZodError([]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.body) as unknown;
  } catch {
    throw new z.ZodError([]);
  }
  return schema.parse(parsed);
}

type ParsedRoute =
  | { type: 'read' }
  | { type: 'medication'; input: MedicationRevisionInput }
  | { type: 'fact'; input: ClinicalFactRevisionInput };

function parseRoute(event: ClinicalHistoryEvent): ParsedRoute | null {
  if (event.routeKey === 'GET /api/patients/{id}/clinical-history') return { type: 'read' };
  if (event.routeKey === 'POST /api/patients/{id}/medications') {
    return { type: 'medication', input: parseBody(event, medicationRevisionInputSchema) };
  }
  if (event.routeKey === 'POST /api/patients/{id}/clinical-facts') {
    return { type: 'fact', input: parseBody(event, clinicalFactRevisionInputSchema) };
  }
  return null;
}

/** Doctor-only append/read surface. The agent never receives a write route. */
export async function handler(event: ClinicalHistoryEvent): Promise<HttpResult> {
  let clinicianSub: string;
  try {
    clinicianSub = requireClinicianClaims(event).sub;
  } catch (error) {
    if (!(error instanceof ClinicianClaimsError)) throw error;
    return json(401, { error: 'unauthorized' });
  }

  let patientId: string;
  let route: ParsedRoute | null;
  try {
    patientId = patientIdSchema.parse(event.pathParameters?.id);
    route = parseRoute(event);
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    return json(400, { error: 'invalid request' });
  }
  if (route === null) return json(404, { error: 'route not found' });

  let client: PoolClient | undefined;
  try {
    const pool = await getPool();
    client = await pool.connect();
    if (route.type === 'read') {
      const history = await listClinicalHistory(client, patientId, clinicianSub);
      return history === null ? json(404, { error: 'patient not found' }) : json(200, { history });
    }
    const id =
      route.type === 'medication'
        ? await appendMedicationRevision(client, {
            patientId,
            clinicianSub,
            input: route.input,
          })
        : await appendClinicalFactRevision(client, {
            patientId,
            clinicianSub,
            input: route.input,
          });
    return json(201, { id });
  } catch (error) {
    if (error instanceof ClinicalRecordNotFoundError) {
      return json(404, { error: 'patient not found' });
    }
    if (error instanceof ClinicalRecordConflictError) {
      return json(409, { error: 'revision conflict' });
    }
    return json(500, { error: 'internal error' });
  } finally {
    client?.release();
  }
}
