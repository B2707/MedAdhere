import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  reviewDecisionInputSchema,
  reviewDecisionResponseSchema,
  type ReviewDecisionInput,
} from '@medadhere/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ClinicianClaimsError, requireClinicianClaims } from '../shared/clinician-claims';
import { createDbPoolProvider } from '../shared/db-pool';

const getPool = createDbPoolProvider(new SecretsManagerClient({}));
const uuidSchema = z.string().uuid();
const MAX_BODY_BYTES = 8_192;

interface ReviewDecisionEvent {
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

const storedCorrectionSchema = z
  .object({
    correctionId: uuidSchema,
    factId: uuidSchema.nullable(),
    proposedText: z.string().trim().min(1).max(1_000),
    rationale: z.string().trim().min(1).max(1_000),
    sourceMessageIds: z.array(uuidSchema).min(1).max(30),
  })
  .strict();

export class ReviewDecisionNotFoundError extends Error {
  constructor() {
    super('Review draft not found');
    this.name = 'ReviewDecisionNotFoundError';
  }
}

export class ReviewDecisionConflictError extends Error {
  constructor(readonly reason: 'stale_version' | 'superseded_draft' | 'different_decision') {
    super('Review draft decision conflict');
    this.name = 'ReviewDecisionConflictError';
  }
}

export class ReviewDecisionInvalidError extends Error {
  constructor() {
    super('Invalid review decision');
    this.name = 'ReviewDecisionInvalidError';
  }
}

export const LOCK_OWNED_PATIENT_SQL = `SELECT id
       FROM patient
      WHERE id = $1
        AND owner_clinician_sub = $2
        FOR UPDATE`;

export const SELECT_REVIEW_DRAFT_SQL = `SELECT version, proposed_corrections
       FROM clinician_review_draft
      WHERE patient_id = $1
        AND id = $2`;

export const SELECT_SUPERSEDING_DRAFT_SQL = `SELECT 1
       FROM clinician_review_draft
      WHERE patient_id = $1
        AND supersedes_id = $2
      LIMIT 1`;

export const INSERT_REVIEW_ACTION_SQL = `INSERT INTO clinician_review_action
       (patient_id, clinician_review_draft_id, clinician_sub, decision, expected_version,
        selected_correction_ids)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[])
     ON CONFLICT ON CONSTRAINT clinician_review_action_draft_version_key DO NOTHING
     RETURNING id`;

export const SELECT_EXISTING_ACTION_SQL = `SELECT id, decision, selected_correction_ids
       FROM clinician_review_action
      WHERE patient_id = $1
        AND clinician_review_draft_id = $2
        AND expected_version = $3`;

export const SELECT_TARGET_FACT_SQL = `SELECT fact_type, fact_code
       FROM clinical_fact
      WHERE patient_id = $1
        AND id = $2`;

export const SELECT_FACT_ALREADY_REVISED_SQL = `SELECT 1
       FROM clinical_fact
      WHERE patient_id = $1
        AND supersedes_id = $2
      LIMIT 1`;

export const INSERT_CLINICAL_FACT_SQL = `INSERT INTO clinical_fact
       (patient_id, fact_type, fact_code, statement_text, status, authored_by_clinician_sub,
        supersedes_id)
     VALUES ($1, $2, $3, $4, 'current', $5, $6)
     RETURNING id`;

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

function parseBody(event: ReviewDecisionEvent): ReviewDecisionInput {
  if (
    event.isBase64Encoded === true ||
    typeof event.body !== 'string' ||
    Buffer.byteLength(event.body, 'utf8') > MAX_BODY_BYTES
  ) {
    throw new z.ZodError([]);
  }
  try {
    return reviewDecisionInputSchema.parse(JSON.parse(event.body) as unknown);
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    throw new z.ZodError([]);
  }
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().join() === [...right].sort().join();
}

export interface ReviewDecisionResult {
  applied: boolean;
  actionId: string;
  createdFactIds: string[];
}

export async function applyReviewDecision(
  client: PoolClient,
  request: {
    patientId: string;
    draftId: string;
    clinicianSub: string;
    input: ReviewDecisionInput;
  },
): Promise<ReviewDecisionResult> {
  const { patientId, draftId, clinicianSub, input } = request;
  const owned = await client.query(LOCK_OWNED_PATIENT_SQL, [patientId, clinicianSub]);
  if (owned.rowCount !== 1) throw new ReviewDecisionNotFoundError();

  const draft = await client.query<{ version: number; proposed_corrections: unknown }>(
    SELECT_REVIEW_DRAFT_SQL,
    [patientId, draftId],
  );
  const draftRow = draft.rows[0];
  if (!draftRow) throw new ReviewDecisionNotFoundError();
  if (draftRow.version !== input.expectedVersion) {
    throw new ReviewDecisionConflictError('stale_version');
  }

  const supersedingDraft = await client.query(SELECT_SUPERSEDING_DRAFT_SQL, [patientId, draftId]);
  if ((supersedingDraft.rowCount ?? 0) > 0) {
    throw new ReviewDecisionConflictError('superseded_draft');
  }

  const corrections = z.array(storedCorrectionSchema).max(10).parse(draftRow.proposed_corrections);
  const correctionsById = new Map(
    corrections.map((correction) => [correction.correctionId, correction]),
  );
  if (input.selectedCorrectionIds.some((id) => !correctionsById.has(id))) {
    throw new ReviewDecisionInvalidError();
  }

  const inserted = await client.query<{ id: string }>(INSERT_REVIEW_ACTION_SQL, [
    patientId,
    draftId,
    clinicianSub,
    input.decision,
    input.expectedVersion,
    input.selectedCorrectionIds,
  ]);
  if (inserted.rows.length === 0) {
    const existing = await client.query<{
      id: string;
      decision: string;
      selected_correction_ids: string[];
    }>(SELECT_EXISTING_ACTION_SQL, [patientId, draftId, input.expectedVersion]);
    const prior = existing.rows[0];
    if (
      !prior ||
      prior.decision !== input.decision ||
      !sameIdSet(prior.selected_correction_ids, input.selectedCorrectionIds)
    ) {
      throw new ReviewDecisionConflictError('different_decision');
    }
    return { applied: false, actionId: prior.id, createdFactIds: [] };
  }

  const actionId = inserted.rows[0]!.id;
  if (input.decision === 'reject') return { applied: true, actionId, createdFactIds: [] };

  const createdFactIds: string[] = [];
  for (const correctionId of input.selectedCorrectionIds) {
    const correction = correctionsById.get(correctionId)!;
    let factType = 'note';
    let factCode: string | null = null;
    if (correction.factId !== null) {
      const target = await client.query<{ fact_type: string; fact_code: string | null }>(
        SELECT_TARGET_FACT_SQL,
        [patientId, correction.factId],
      );
      const targetRow = target.rows[0];
      if (!targetRow) throw new ReviewDecisionNotFoundError();
      const revision = await client.query(SELECT_FACT_ALREADY_REVISED_SQL, [
        patientId,
        correction.factId,
      ]);
      if ((revision.rowCount ?? 0) > 0) throw new ReviewDecisionConflictError('stale_version');
      factType = targetRow.fact_type;
      factCode = targetRow.fact_code;
    }
    const fact = await client.query<{ id: string }>(INSERT_CLINICAL_FACT_SQL, [
      patientId,
      factType,
      factCode,
      correction.proposedText,
      clinicianSub,
      correction.factId,
    ]);
    createdFactIds.push(fact.rows[0]!.id);
  }
  return { applied: true, actionId, createdFactIds };
}

export async function handler(event: ReviewDecisionEvent): Promise<HttpResult> {
  let clinicianSub: string;
  try {
    clinicianSub = requireClinicianClaims(event).sub;
  } catch (error) {
    if (!(error instanceof ClinicianClaimsError)) throw error;
    logMetric('review_decision_unauthorized');
    return json(401, { error: 'unauthorized' });
  }

  let patientId: string;
  let draftId: string;
  let input: ReviewDecisionInput;
  try {
    patientId = uuidSchema.parse(event.pathParameters?.id);
    draftId = uuidSchema.parse(event.pathParameters?.draftId);
    input = parseBody(event);
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    logMetric('review_decision_bad_request');
    return json(400, { error: 'invalid request' });
  }

  const client = await (await getPool()).connect();
  try {
    await client.query('BEGIN');
    const result = await applyReviewDecision(client, { patientId, draftId, clinicianSub, input });
    const response = reviewDecisionResponseSchema.parse({ decision: input.decision, ...result });
    await client.query('COMMIT');
    logMetric('review_decision_recorded', {
      decision: input.decision,
      applied: result.applied,
      factsWritten: result.createdFactIds.length,
    });
    return json(200, response);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error instanceof ReviewDecisionNotFoundError) {
      logMetric('review_decision_not_found');
      return json(404, { error: 'review draft not found' });
    }
    if (error instanceof ReviewDecisionConflictError) {
      logMetric('review_decision_conflict', { reason: error.reason });
      return json(409, { error: 'review draft decision conflict', reason: error.reason });
    }
    if (error instanceof ReviewDecisionInvalidError || error instanceof z.ZodError) {
      logMetric('review_decision_bad_request');
      return json(400, { error: 'invalid request' });
    }
    throw error;
  } finally {
    client.release();
  }
}
