import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  ReviewDecisionInvalidError,
  ReviewDecisionNotFoundError,
  applyReviewDecision,
} from './handler.js';

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema-init', 'schema.sql'), 'utf8');
const CONTAINER_TIMEOUT_MS = 180_000;
const OWNER_A = '97b4a172-e055-4c37-9d95-2a00664dfe64';
const OWNER_B = 'a6e4e0c8-32a0-4514-a6b6-67c504bf80b4';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const CORRECTION_ONE = '11111111-1111-4111-8111-111111111111';
const CORRECTION_TWO = '22222222-2222-4222-8222-222222222222';

let container: StartedPostgreSqlContainer | undefined;
let pool: Pool;
let client: PoolClient;

beforeAll(async () => {
  const ciUrl = process.env.TEST_DATABASE_URL;
  if (ciUrl) {
    pool = new Pool({ connectionString: ciUrl });
  } else {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
  }
  client = await pool.connect();
  await client.query(SCHEMA_SQL);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  client?.release();
  await pool?.end();
  await container?.stop();
});

let phoneCounter = 0;
function nextPhone(): string {
  phoneCounter += 1;
  return `+1500883${String(phoneCounter).padStart(4, '0')}`;
}

async function seedPatient(ownerClinicianSub: string | null = OWNER_A): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO patient (phone, medication_name, owner_clinician_sub)
     VALUES ($1, 'metformin', $2) RETURNING id`,
    [nextPhone(), ownerClinicianSub],
  );
  return result.rows[0]!.id;
}

async function seedDraft(options: {
  patientId: string;
  version?: number;
  corrections?: unknown[];
  supersedesId?: string | null;
  localDate?: string;
}): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO clinician_review_draft
       (patient_id, local_date, version, input_hash, draft_text, proposed_corrections, supersedes_id)
     VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, repeat('c', 64), 'draft', $4::jsonb, $5)
     RETURNING id`,
    [
      options.patientId,
      options.localDate ?? null,
      options.version ?? 1,
      JSON.stringify(options.corrections ?? []),
      options.supersedesId ?? null,
    ],
  );
  return result.rows[0]!.id;
}

async function seedFact(patientId: string, statementText = 'Original note'): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO clinical_fact
       (patient_id, fact_type, fact_code, statement_text, status, authored_by_clinician_sub)
     VALUES ($1, 'condition', 'MIGRAINE', $2, 'current', $3)
     RETURNING id`,
    [patientId, statementText, OWNER_A],
  );
  return result.rows[0]!.id;
}

function correction(correctionId: string, factId: string | null, proposedText: string) {
  return {
    correctionId,
    factId,
    proposedText,
    rationale: 'Patient supplied a correction',
    sourceMessageIds: [UNKNOWN_ID],
  };
}

async function facts(patientId: string) {
  const { rows } = await client.query<{
    id: string;
    fact_type: string;
    fact_code: string | null;
    statement_text: string;
    supersedes_id: string | null;
    authored_by_clinician_sub: string;
  }>(
    `SELECT id, fact_type, fact_code, statement_text, supersedes_id, authored_by_clinician_sub
       FROM clinical_fact WHERE patient_id = $1 ORDER BY id`,
    [patientId],
  );
  return rows;
}

async function actionCount(draftId: string): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM clinician_review_action WHERE clinician_review_draft_id = $1`,
    [draftId],
  );
  return Number(rows[0]!.count);
}

async function inRollback<T>(work: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    return await work();
  } finally {
    await client.query('ROLLBACK');
  }
}

describe('doctor review decision (real PG16)', () => {
  it('serializes concurrent decisions on the owned patient lock', async () => {
    const patientId = await seedPatient();
    const draftId = await seedDraft({ patientId });
    const firstClient = await pool.connect();
    const secondClient = await pool.connect();
    try {
      await firstClient.query('BEGIN');
      await secondClient.query('BEGIN');
      const first = await applyReviewDecision(firstClient, {
        patientId,
        draftId,
        clinicianSub: OWNER_A,
        input: { decision: 'reject', expectedVersion: 1, selectedCorrectionIds: [] },
      });

      await secondClient.query("SET LOCAL lock_timeout = '100ms'");
      await expect(
        applyReviewDecision(secondClient, {
          patientId,
          draftId,
          clinicianSub: OWNER_A,
          input: { decision: 'reject', expectedVersion: 1, selectedCorrectionIds: [] },
        }),
      ).rejects.toMatchObject({ code: '55P03' });

      await secondClient.query('ROLLBACK');
      await firstClient.query('COMMIT');
      await secondClient.query('BEGIN');
      const replay = await applyReviewDecision(secondClient, {
        patientId,
        draftId,
        clinicianSub: OWNER_A,
        input: { decision: 'reject', expectedVersion: 1, selectedCorrectionIds: [] },
      });
      await secondClient.query('COMMIT');
      expect(replay).toEqual({ applied: false, actionId: first.actionId, createdFactIds: [] });
    } finally {
      await firstClient.query('ROLLBACK').catch(() => undefined);
      await secondClient.query('ROLLBACK').catch(() => undefined);
      firstClient.release();
      secondClient.release();
      await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
    }
  });

  it('atomically applies only selected corrections as clinician-authored append-only revisions', async () => {
    await inRollback(async () => {
      const patientId = await seedPatient();
      const originalFactId = await seedFact(patientId, 'Migraine, monthly');
      const draftId = await seedDraft({
        patientId,
        corrections: [
          correction(CORRECTION_ONE, originalFactId, 'Migraine, now weekly'),
          correction(CORRECTION_TWO, null, 'Not selected'),
        ],
      });

      const result = await applyReviewDecision(client, {
        patientId,
        draftId,
        clinicianSub: OWNER_A,
        input: {
          decision: 'confirm',
          expectedVersion: 1,
          selectedCorrectionIds: [CORRECTION_ONE],
        },
      });

      expect(result).toMatchObject({ applied: true });
      expect(result.createdFactIds).toHaveLength(1);
      const stored = await facts(patientId);
      expect(stored).toHaveLength(2);
      expect(stored.find(({ id }) => id === originalFactId)).toMatchObject({
        statement_text: 'Migraine, monthly',
        supersedes_id: null,
      });
      expect(stored.find(({ supersedes_id }) => supersedes_id === originalFactId)).toMatchObject({
        fact_type: 'condition',
        fact_code: 'MIGRAINE',
        statement_text: 'Migraine, now weekly',
        authored_by_clinician_sub: OWNER_A,
      });
    });
  });

  it('creates a clinician note for a selected correction without a target fact', async () => {
    await inRollback(async () => {
      const patientId = await seedPatient();
      const draftId = await seedDraft({
        patientId,
        corrections: [correction(CORRECTION_ONE, null, 'Reports recurring headaches')],
      });
      await applyReviewDecision(client, {
        patientId,
        draftId,
        clinicianSub: OWNER_A,
        input: {
          decision: 'confirm',
          expectedVersion: 1,
          selectedCorrectionIds: [CORRECTION_ONE],
        },
      });
      expect(await facts(patientId)).toEqual([
        expect.objectContaining({
          fact_type: 'note',
          fact_code: null,
          statement_text: 'Reports recurring headaches',
          authored_by_clinician_sub: OWNER_A,
        }),
      ]);
    });
  });

  it('reject appends only the action', async () => {
    await inRollback(async () => {
      const patientId = await seedPatient();
      const draftId = await seedDraft({
        patientId,
        corrections: [correction(CORRECTION_ONE, null, 'Never applied')],
      });
      const result = await applyReviewDecision(client, {
        patientId,
        draftId,
        clinicianSub: OWNER_A,
        input: { decision: 'reject', expectedVersion: 1, selectedCorrectionIds: [] },
      });
      expect(result).toMatchObject({ applied: true, createdFactIds: [] });
      expect(await actionCount(draftId)).toBe(1);
      expect(await facts(patientId)).toEqual([]);
    });
  });

  it('identical replay is idempotent; a different decision for that version is 409', async () => {
    await inRollback(async () => {
      const patientId = await seedPatient();
      const draftId = await seedDraft({
        patientId,
        corrections: [correction(CORRECTION_ONE, null, 'Selected')],
      });
      const request = {
        patientId,
        draftId,
        clinicianSub: OWNER_A,
        input: {
          decision: 'confirm' as const,
          expectedVersion: 1,
          selectedCorrectionIds: [CORRECTION_ONE],
        },
      };
      const first = await applyReviewDecision(client, request);
      const replay = await applyReviewDecision(client, request);
      expect(replay).toEqual({ applied: false, actionId: first.actionId, createdFactIds: [] });
      expect(await actionCount(draftId)).toBe(1);
      expect(await facts(patientId)).toHaveLength(1);
      await expect(
        applyReviewDecision(client, {
          ...request,
          input: { decision: 'reject', expectedVersion: 1, selectedCorrectionIds: [] },
        }),
      ).rejects.toMatchObject({ reason: 'different_decision' });
    });
  });

  it('rejects stale version and an explicitly superseded draft without writing', async () => {
    await inRollback(async () => {
      const patientId = await seedPatient();
      const staleDraftId = await seedDraft({ patientId, localDate: '2026-08-10' });
      await seedDraft({
        patientId,
        version: 2,
        supersedesId: staleDraftId,
        localDate: '2026-08-11',
      });
      await expect(
        applyReviewDecision(client, {
          patientId,
          draftId: staleDraftId,
          clinicianSub: OWNER_A,
          input: { decision: 'reject', expectedVersion: 1, selectedCorrectionIds: [] },
        }),
      ).rejects.toMatchObject({ reason: 'superseded_draft' });
      expect(await actionCount(staleDraftId)).toBe(0);

      const currentDraftId = await seedDraft({ patientId, localDate: '2026-08-12' });
      await expect(
        applyReviewDecision(client, {
          patientId,
          draftId: currentDraftId,
          clinicianSub: OWNER_A,
          input: { decision: 'reject', expectedVersion: 2, selectedCorrectionIds: [] },
        }),
      ).rejects.toMatchObject({ reason: 'stale_version' });
    });
  });

  it('rejects an arbitrary correction id before retaining the action', async () => {
    await inRollback(async () => {
      const patientId = await seedPatient();
      const draftId = await seedDraft({ patientId, corrections: [] });
      await expect(
        applyReviewDecision(client, {
          patientId,
          draftId,
          clinicianSub: OWNER_A,
          input: {
            decision: 'confirm',
            expectedVersion: 1,
            selectedCorrectionIds: [CORRECTION_ONE],
          },
        }),
      ).rejects.toBeInstanceOf(ReviewDecisionInvalidError);
      expect(await actionCount(draftId)).toBe(0);
    });
  });

  it('rolls back the action when a selected target fact is missing', async () => {
    await inRollback(async () => {
      const patientId = await seedPatient();
      const draftId = await seedDraft({
        patientId,
        corrections: [correction(CORRECTION_ONE, UNKNOWN_ID, 'Cannot be applied')],
      });
      await client.query('SAVEPOINT decision_attempt');
      await expect(
        applyReviewDecision(client, {
          patientId,
          draftId,
          clinicianSub: OWNER_A,
          input: {
            decision: 'confirm',
            expectedVersion: 1,
            selectedCorrectionIds: [CORRECTION_ONE],
          },
        }),
      ).rejects.toBeInstanceOf(ReviewDecisionNotFoundError);
      await client.query('ROLLBACK TO SAVEPOINT decision_attempt');
      expect(await actionCount(draftId)).toBe(0);
      expect(await facts(patientId)).toEqual([]);
    });
  });

  it('makes unknown, foreign-owned, and ownerless patients indistinguishable', async () => {
    await inRollback(async () => {
      const foreignId = await seedPatient(OWNER_B);
      await client.query(
        'ALTER TABLE patient DROP CONSTRAINT patient_owner_clinician_sub_not_null',
      );
      const ownerlessId = await seedPatient(null);
      await client.query(
        `ALTER TABLE patient ADD CONSTRAINT patient_owner_clinician_sub_not_null
         CHECK (owner_clinician_sub IS NOT NULL) NOT VALID`,
      );
      for (const patientId of [UNKNOWN_ID, foreignId, ownerlessId]) {
        await expect(
          applyReviewDecision(client, {
            patientId,
            draftId: UNKNOWN_ID,
            clinicianSub: OWNER_A,
            input: { decision: 'reject', expectedVersion: 1, selectedCorrectionIds: [] },
          }),
        ).rejects.toBeInstanceOf(ReviewDecisionNotFoundError);
      }
    });
  });
});
