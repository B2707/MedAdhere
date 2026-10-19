import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INTERPRETATION_RESERVED_INPUT_TOKENS,
  INTERPRETATION_RESERVED_OUTPUT_TOKENS,
  MAX_INTERPRETATION_TURN_INPUT_TOKENS,
  MAX_INTERPRETATION_TURN_OUTPUT_TOKENS,
  PATIENT_DAILY_INPUT_TOKEN_LIMIT,
  PATIENT_DAILY_OUTPUT_TOKEN_LIMIT,
  persistConversationStageResult,
  releaseConversationStageReservation,
  reserveComposerStage,
  reserveConversationStage,
  RuntimeConflictError,
} from './runtime-stage-repository.js';

/**
 * Live-fault fix (2026-08-17): the usage_bucket ensure-insert used to be ON CONFLICT DO NOTHING,
 * so a bucket row created under an older, lower limit_units constant stayed frozen at that limit
 * forever — a constant raise required manual SQL against the live row. This file pins the fixed
 * behavior directly against the SQL (not just the module constants, which are already generous
 * enough that the public API alone can never observe a real lower-to-higher transition): a bucket
 * row is seeded with an artificially low limit_units, then a fresh reservation in the SAME window
 * must raise it to the module's current constant, and a bucket seeded ABOVE the constant must
 * never be clawed back down.
 */
const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema-init', 'schema.sql'), 'utf8');
const CONTAINER_TIMEOUT_MS = 180_000;
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let container: StartedPostgreSqlContainer | undefined;
let pool: Pool;
let phoneCounter = 0;

async function seedPatient(): Promise<string> {
  phoneCounter += 1;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO patient
       (phone, medication_name, owner_clinician_sub, timezone, is_active)
     VALUES ($1, 'legacy medication', $2, 'America/Toronto', true)
     RETURNING id::text`,
    [`+1500778${String(phoneCounter).padStart(4, '0')}`, OWNER_ID],
  );
  return inserted.rows[0]!.id;
}

/** A fresh turn_job for the SAME patient and calendar day (offset by minutes only), so every
 * turn maps to the SAME usage_bucket window_start/window_end. */
async function appendTurn(patientId: string, sequence: number): Promise<string> {
  const inbound = await pool.query<{ id: string }>(
    `INSERT INTO inbound_reply
       (patient_id, raw_body, received_at, inbound_sequence)
     VALUES ($1, 'I took it after lunch.',
             '2026-08-11T16:00:00Z'::timestamptz + ($2 * interval '1 minute'), $2)
     RETURNING id::text`,
    [patientId, sequence],
  );
  const job = await pool.query<{ id: string }>(
    `INSERT INTO turn_job
       (patient_id, inbound_message_id, inbound_sequence, messaging_state_version)
     SELECT $1, $2, $3, messaging_state_version FROM patient WHERE id = $1
     RETURNING id::text`,
    [patientId, inbound.rows[0]!.id, sequence],
  );
  return job.rows[0]!.id;
}

/** FIFO guard: reserveConversationStage/reserveComposerStage refuse a turn while an earlier,
 * lower-sequence turn_job for the same patient is still unfinished. */
async function completeTurn(turnJobId: string): Promise<void> {
  const completed = await pool.query(
    `UPDATE turn_job SET completed_at = now() WHERE id = $1 AND completed_at IS NULL`,
    [turnJobId],
  );
  if (completed.rowCount !== 1) throw new Error('expected exactly one turn_job to complete');
}

async function bucketLimit(patientId: string, subjectKey: string): Promise<number> {
  const result = await pool.query<{ limit_units: number }>(
    `SELECT limit_units FROM usage_bucket
      WHERE bucket_scope = 'patient_tokens' AND patient_id = $1 AND subject_key = $2`,
    [patientId, subjectKey],
  );
  if (result.rows.length !== 1) throw new Error('expected exactly one usage_bucket row');
  return result.rows[0]!.limit_units;
}

async function setBucketLimit(
  patientId: string,
  subjectKey: string,
  limitUnits: number,
): Promise<void> {
  const updated = await pool.query(
    `UPDATE usage_bucket SET limit_units = $3
      WHERE bucket_scope = 'patient_tokens' AND patient_id = $1 AND subject_key = $2`,
    [patientId, subjectKey, limitUnits],
  );
  if (updated.rowCount !== 1) throw new Error('expected exactly one usage_bucket row to update');
}

/** Spends a bucket down. Unlike limit_units, consumed_units is never rewritten by the
 * ensure-insert's GREATEST auto-raise, so it is the only lever that can pin a real ceiling. */
async function setBucketConsumed(
  patientId: string,
  subjectKey: string,
  consumedUnits: number,
): Promise<void> {
  const updated = await pool.query(
    `UPDATE usage_bucket SET consumed_units = $3
      WHERE bucket_scope = 'patient_tokens' AND patient_id = $1 AND subject_key = $2`,
    [patientId, subjectKey, consumedUnits],
  );
  if (updated.rowCount !== 1) throw new Error('expected exactly one usage_bucket row to update');
}

async function bucketUnits(
  patientId: string,
  subjectKey: string,
): Promise<{ readonly reserved: number; readonly consumed: number }> {
  const result = await pool.query<{ reserved_units: number; consumed_units: number }>(
    `SELECT reserved_units, consumed_units FROM usage_bucket
      WHERE bucket_scope = 'patient_tokens' AND patient_id = $1 AND subject_key = $2`,
    [patientId, subjectKey],
  );
  if (result.rows.length !== 1) throw new Error('expected exactly one usage_bucket row');
  return { reserved: result.rows[0]!.reserved_units, consumed: result.rows[0]!.consumed_units };
}

async function interpretationJobRow(turnJobId: string): Promise<{
  readonly interpretation_attempted_at: Date | null;
  readonly interpretation_result: unknown | null;
  readonly interpretation_reserved_input: number;
  readonly interpretation_reserved_output: number;
}> {
  const result = await pool.query<{
    interpretation_attempted_at: Date | null;
    interpretation_result: unknown | null;
    interpretation_reserved_input: number;
    interpretation_reserved_output: number;
  }>(
    `SELECT interpretation_attempted_at, interpretation_result,
            interpretation_reserved_input, interpretation_reserved_output
       FROM turn_job WHERE id = $1`,
    [turnJobId],
  );
  return result.rows[0]!;
}

function stageRecord(usage: { readonly inputTokens: number; readonly outputTokens: number }) {
  return {
    stage: 'interpretation' as const,
    output: { claims: [] },
    modelId: 'claude-sonnet-5',
    promptVersion: 'clinical-extractor-vtest',
    schemaVersion: 'clinical-extractor-schema-vtest',
    schemaSha256: 'b'.repeat(64),
    contextHash: 'c'.repeat(64),
    latencyMs: 5,
    ...usage,
  };
}

beforeAll(async () => {
  const ciUrl = process.env.TEST_DATABASE_URL;
  if (ciUrl) {
    pool = new Pool({ connectionString: ciUrl });
  } else {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
  }
  await pool.query(SCHEMA_SQL);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('usage_bucket ensure-insert against PostgreSQL 16', () => {
  it('raises a stale interpretation bucket limit mid-window but never lowers one above the constant', async () => {
    const patientId = await seedPatient();
    const inputKey = `${patientId}:input`;

    const firstTurn = await appendTurn(patientId, 1);
    expect(
      await reserveConversationStage(pool, {
        turnJobId: firstTurn,
        patientId,
        stage: 'interpretation',
        reservedInputTokens: 100,
        reservedOutputTokens: 50,
      }),
    ).toMatchObject({ kind: 'reserved' });
    await completeTurn(firstTurn);
    const currentConstant = await bucketLimit(patientId, inputKey);

    // Simulate a bucket row created under an older, lower constant.
    await setBucketLimit(patientId, inputKey, 100);
    expect(await bucketLimit(patientId, inputKey)).toBe(100);

    const secondTurn = await appendTurn(patientId, 2);
    expect(
      await reserveConversationStage(pool, {
        turnJobId: secondTurn,
        patientId,
        stage: 'interpretation',
        reservedInputTokens: 100,
        reservedOutputTokens: 50,
      }),
    ).toMatchObject({ kind: 'reserved' });
    await completeTurn(secondTurn);
    expect(await bucketLimit(patientId, inputKey)).toBe(currentConstant);

    // Simulate an operator-set limit ABOVE the current constant — a later reservation must
    // never claw it back down to the (lower) code constant.
    const raisedAboveConstant = currentConstant + 1_000_000;
    await setBucketLimit(patientId, inputKey, raisedAboveConstant);

    const thirdTurn = await appendTurn(patientId, 3);
    expect(
      await reserveConversationStage(pool, {
        turnJobId: thirdTurn,
        patientId,
        stage: 'interpretation',
        reservedInputTokens: 100,
        reservedOutputTokens: 50,
      }),
    ).toMatchObject({ kind: 'reserved' });
    expect(await bucketLimit(patientId, inputKey)).toBe(raisedAboveConstant);
  });

  it('applies the same raise-only semantics to the composer writer bucket', async () => {
    const patientId = await seedPatient();
    const writerInputKey = `${patientId}:writer-input`;

    const firstTurn = await appendTurn(patientId, 1);
    expect(
      await reserveComposerStage(pool, {
        turnJobId: firstTurn,
        patientId,
        reservedInputTokens: 100,
        reservedOutputTokens: 50,
      }),
    ).toMatchObject({ kind: 'reserved' });
    await completeTurn(firstTurn);
    const currentConstant = await bucketLimit(patientId, writerInputKey);

    await setBucketLimit(patientId, writerInputKey, 100);
    const secondTurn = await appendTurn(patientId, 2);
    expect(
      await reserveComposerStage(pool, {
        turnJobId: secondTurn,
        patientId,
        reservedInputTokens: 100,
        reservedOutputTokens: 50,
      }),
    ).toMatchObject({ kind: 'reserved' });
    expect(await bucketLimit(patientId, writerInputKey)).toBe(currentConstant);
  });
});

/**
 * Live incident (2026-08-17): a turn whose extraction terminally failed (gateway ok:false
 * malformed_output) LEAKED its whole token reservation — units were released ONLY on the
 * success path (persistConversationStageResult). With the old 72,000/24,576 worst-case hold
 * against a 32,000/day output ceiling, ONE leaked turn pushed every later turn of the day into
 * budget_exhausted, so the agent answered a direct patient question with the human-review
 * template and stayed dead for the rest of the day.
 */
describe('interpretation reservation release — a failed turn must not hold the day', () => {
  it('returns the units, consumes the honest actual usage, and keeps the one-shot attempt marker', async () => {
    const patientId = await seedPatient();
    const turnJobId = await appendTurn(patientId, 1);
    expect(
      await reserveConversationStage(pool, {
        turnJobId,
        patientId,
        stage: 'interpretation',
        reservedInputTokens: INTERPRETATION_RESERVED_INPUT_TOKENS,
        reservedOutputTokens: INTERPRETATION_RESERVED_OUTPUT_TOKENS,
      }),
    ).toMatchObject({ kind: 'reserved' });
    expect(await bucketUnits(patientId, `${patientId}:input`)).toEqual({
      reserved: INTERPRETATION_RESERVED_INPUT_TOKENS,
      consumed: 0,
    });

    await releaseConversationStageReservation(pool, {
      turnJobId,
      patientId,
      inputTokens: 40,
      outputTokens: 15,
    });

    expect(await bucketUnits(patientId, `${patientId}:input`)).toEqual({
      reserved: 0,
      consumed: 40,
    });
    expect(await bucketUnits(patientId, `${patientId}:output`)).toEqual({
      reserved: 0,
      consumed: 15,
    });
    // The reservation row is ALSO the at-most-once attempt marker: releasing the UNITS must
    // never resurrect the turn for a second provider call on redrive.
    const job = await interpretationJobRow(turnJobId);
    expect(job.interpretation_attempted_at).not.toBeNull();
    expect(job.interpretation_result).toBeNull();
    expect(job.interpretation_reserved_input).toBe(0);
    expect(job.interpretation_reserved_output).toBe(0);
    expect(
      await reserveConversationStage(pool, {
        turnJobId,
        patientId,
        stage: 'interpretation',
        reservedInputTokens: INTERPRETATION_RESERVED_INPUT_TOKENS,
        reservedOutputTokens: INTERPRETATION_RESERVED_OUTPUT_TOKENS,
      }),
    ).toEqual({ kind: 'already_attempted' });
  });

  it('is idempotent — a redriven release never double-credits the bucket', async () => {
    const patientId = await seedPatient();
    const turnJobId = await appendTurn(patientId, 1);
    await reserveConversationStage(pool, {
      turnJobId,
      patientId,
      stage: 'interpretation',
      reservedInputTokens: 1_000,
      reservedOutputTokens: 500,
    });
    const release = () =>
      releaseConversationStageReservation(pool, {
        turnJobId,
        patientId,
        inputTokens: 100,
        outputTokens: 20,
      });
    await release();
    await release();
    expect(await bucketUnits(patientId, `${patientId}:input`)).toEqual({
      reserved: 0,
      consumed: 100,
    });
    expect(await bucketUnits(patientId, `${patientId}:output`)).toEqual({
      reserved: 0,
      consumed: 20,
    });
  });

  it('never re-credits a reservation persist already reconciled', async () => {
    const patientId = await seedPatient();
    const turnJobId = await appendTurn(patientId, 1);
    await reserveConversationStage(pool, {
      turnJobId,
      patientId,
      stage: 'interpretation',
      reservedInputTokens: INTERPRETATION_RESERVED_INPUT_TOKENS,
      reservedOutputTokens: INTERPRETATION_RESERVED_OUTPUT_TOKENS,
    });
    expect(
      await persistConversationStageResult(pool, {
        turnJobId,
        patientId,
        record: stageRecord({ inputTokens: 900, outputTokens: 120 }),
      }),
    ).toEqual({ kind: 'stored' });
    const settled = await bucketUnits(patientId, `${patientId}:input`);

    await releaseConversationStageReservation(pool, {
      turnJobId,
      patientId,
      inputTokens: 900,
      outputTokens: 120,
    });
    expect(await bucketUnits(patientId, `${patientId}:input`)).toEqual(settled);
  });

  it('reproduces the incident: a leaked failed turn used to starve every later turn of the day', async () => {
    const patientId = await seedPatient();
    const outputKey = `${patientId}:output`;

    const failedTurn = await appendTurn(patientId, 1);
    await reserveConversationStage(pool, {
      turnJobId: failedTurn,
      patientId,
      stage: 'interpretation',
      reservedInputTokens: INTERPRETATION_RESERVED_INPUT_TOKENS,
      reservedOutputTokens: INTERPRETATION_RESERVED_OUTPUT_TOKENS,
    });
    // Spend the day down to EXACTLY one remaining reservation. Consumed units are the only
    // lever that bites here: a lowered limit_units would just be raised back by the bucket's
    // own GREATEST auto-raise on the next reservation. With the leak, the next turn sees
    // 4,096 (leaked) + 123,903 (spent) + 4,096 (wanted) = 132,095 > 128,000 -> budget_exhausted,
    // which is exactly what killed the live conversation for the rest of the day.
    await setBucketConsumed(
      patientId,
      outputKey,
      PATIENT_DAILY_OUTPUT_TOKEN_LIMIT - INTERPRETATION_RESERVED_OUTPUT_TOKENS - 1,
    );
    await releaseConversationStageReservation(pool, {
      turnJobId: failedTurn,
      patientId,
      inputTokens: 0,
      outputTokens: 0,
    });
    await completeTurn(failedTurn);

    const nextTurn = await appendTurn(patientId, 2);
    expect(
      await reserveConversationStage(pool, {
        turnJobId: nextTurn,
        patientId,
        stage: 'interpretation',
        reservedInputTokens: INTERPRETATION_RESERVED_INPUT_TOKENS,
        reservedOutputTokens: INTERPRETATION_RESERVED_OUTPUT_TOKENS,
      }),
    ).toMatchObject({ kind: 'reserved' });
  });
});

/**
 * Right-sizing (2026-08-17): the turn now reserves ONE provider call's worst case instead of
 * the whole six-call retry ceiling. The extractor's bounded retry loop may still spend more
 * than that, so persist tops the reservation up to the honest actual before the
 * reserved -> consumed move — the `consumed <= reserved` honesty guard holds exactly, and the
 * per-turn total stays hard-capped at MAX_INTERPRETATION_TURN_*_TOKENS.
 */
describe('persistConversationStageResult — capped-total reconciliation', () => {
  it('tops a one-call reservation up to the summed retry usage and consumes exactly that', async () => {
    const patientId = await seedPatient();
    const turnJobId = await appendTurn(patientId, 1);
    await reserveConversationStage(pool, {
      turnJobId,
      patientId,
      stage: 'interpretation',
      reservedInputTokens: INTERPRETATION_RESERVED_INPUT_TOKENS,
      reservedOutputTokens: INTERPRETATION_RESERVED_OUTPUT_TOKENS,
    });
    const summed = {
      inputTokens: INTERPRETATION_RESERVED_INPUT_TOKENS * 3,
      outputTokens: INTERPRETATION_RESERVED_OUTPUT_TOKENS * 3,
    };
    expect(
      await persistConversationStageResult(pool, {
        turnJobId,
        patientId,
        record: stageRecord(summed),
      }),
    ).toEqual({ kind: 'stored' });
    expect(await bucketUnits(patientId, `${patientId}:input`)).toEqual({
      reserved: 0,
      consumed: summed.inputTokens,
    });
    expect(await bucketUnits(patientId, `${patientId}:output`)).toEqual({
      reserved: 0,
      consumed: summed.outputTokens,
    });
  });

  it('refuses usage above the hard per-turn ceiling and leaves the reservation intact', async () => {
    const patientId = await seedPatient();
    const turnJobId = await appendTurn(patientId, 1);
    await reserveConversationStage(pool, {
      turnJobId,
      patientId,
      stage: 'interpretation',
      reservedInputTokens: INTERPRETATION_RESERVED_INPUT_TOKENS,
      reservedOutputTokens: INTERPRETATION_RESERVED_OUTPUT_TOKENS,
    });
    await expect(
      persistConversationStageResult(pool, {
        turnJobId,
        patientId,
        record: stageRecord({
          inputTokens: MAX_INTERPRETATION_TURN_INPUT_TOKENS + 1,
          outputTokens: 10,
        }),
      }),
    ).rejects.toBeInstanceOf(RuntimeConflictError);
    await expect(
      persistConversationStageResult(pool, {
        turnJobId,
        patientId,
        record: stageRecord({
          inputTokens: 10,
          outputTokens: MAX_INTERPRETATION_TURN_OUTPUT_TOKENS + 1,
        }),
      }),
    ).rejects.toBeInstanceOf(RuntimeConflictError);
    expect(await bucketUnits(patientId, `${patientId}:input`)).toEqual({
      reserved: INTERPRETATION_RESERVED_INPUT_TOKENS,
      consumed: 0,
    });
  });
});

describe('daily patient token ceiling', () => {
  it('seeds the raised output ceiling so one message can never hold most of a day', async () => {
    const patientId = await seedPatient();
    const turnJobId = await appendTurn(patientId, 1);
    await reserveConversationStage(pool, {
      turnJobId,
      patientId,
      stage: 'interpretation',
      reservedInputTokens: INTERPRETATION_RESERVED_INPUT_TOKENS,
      reservedOutputTokens: INTERPRETATION_RESERVED_OUTPUT_TOKENS,
    });
    expect(PATIENT_DAILY_OUTPUT_TOKEN_LIMIT).toBe(128_000);
    expect(PATIENT_DAILY_INPUT_TOKEN_LIMIT).toBe(400_000);
    expect(await bucketLimit(patientId, `${patientId}:output`)).toBe(
      PATIENT_DAILY_OUTPUT_TOKEN_LIMIT,
    );
    expect(await bucketLimit(patientId, `${patientId}:input`)).toBe(
      PATIENT_DAILY_INPUT_TOKEN_LIMIT,
    );
    // A single in-flight turn may hold at most one provider call's worth of the day.
    expect(INTERPRETATION_RESERVED_OUTPUT_TOKENS * 20).toBeLessThanOrEqual(
      PATIENT_DAILY_OUTPUT_TOKEN_LIMIT,
    );
  });
});
