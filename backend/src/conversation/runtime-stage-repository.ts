import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { boundedClaimExtractionSchema } from './clinical-memory/bounded-provider.js';
import { composerBudgetBucketKeys } from './clinical-memory/composer.js';
import { lockMessagingConsent, MessagingConsentSuppressedError } from './runtime-consent.js';
import { assertLowestUnfinishedConversationJob } from './runtime-fifo.js';

// Raised 50k/8k -> 400k/32k (2026-08-17, owner live testing): the original sizing allowed
// ~11 interpretation turns/day and went budget_exhausted mid-conversation — every later
// message diverted to human_review unread. 400k input ~ 90 turns/day, worst case ~$1.20/day
// Sonnet input for the single-patient deployment; still a hard runaway ceiling.
export const PATIENT_DAILY_INPUT_TOKEN_LIMIT = 400_000;
/**
 * Output raised again 32k -> 128k (2026-08-17, live incident): the old ceiling was small enough
 * that a SINGLE turn's worst-case reservation (24,576 under the pre-right-sizing sizing) held
 * three quarters of the day, so one leaked reservation locked the patient out until midnight.
 * The ensure-bucket GREATEST auto-raise deploys this to existing rows from their next
 * reservation on. Output is the expensive side ($5/Mtok) — 128k is still a hard runaway
 * ceiling, worth ~$0.64/day at absolute maximum for the single-patient deployment.
 */
export const PATIENT_DAILY_OUTPUT_TOKEN_LIMIT = 128_000;
const INPUT_TOKEN_LIMIT = PATIENT_DAILY_INPUT_TOKEN_LIMIT;
const OUTPUT_TOKEN_LIMIT = PATIENT_DAILY_OUTPUT_TOKEN_LIMIT;

/**
 * RIGHT-SIZING (2026-08-17, live incident): a turn reserves ONE provider call's worst case —
 * the gateway's own 12,000-token context gate and its 4,096 interpretationMaxTokens — not the
 * whole six-call retry ceiling. Holding 72,000/24,576 up front meant one in-flight message
 * owned most of a day's budget and every concurrent/later turn saw budget_exhausted.
 */
export const INTERPRETATION_RESERVED_INPUT_TOKENS = 12_000;
export const INTERPRETATION_RESERVED_OUTPUT_TOKENS = 4_096;
/**
 * The capped total. The extractor's bounded retry loop bills at most
 * MAX_EXTRACTION_ATTEMPTS (3 malformed retries) x 2 passes (the corrective grounding retry)
 * provider calls, and the interpretation stage reports SUMMED usage across all of them, so a
 * retried turn legitimately spends more than it reserved. persistConversationStageResult tops
 * the reservation up to the honest actual (keeping `consumed <= reserved` exact) and refuses
 * anything above this hard per-turn ceiling.
 */
const MAX_INTERPRETATION_PROVIDER_CALLS = 6;
export const MAX_INTERPRETATION_TURN_INPUT_TOKENS =
  INTERPRETATION_RESERVED_INPUT_TOKENS * MAX_INTERPRETATION_PROVIDER_CALLS;
export const MAX_INTERPRETATION_TURN_OUTPUT_TOKENS =
  INTERPRETATION_RESERVED_OUTPUT_TOKENS * MAX_INTERPRETATION_PROVIDER_CALLS;
/** Composer isolation (item 2): its OWN bucket limits — separate from the extractor's above. */
const WRITER_INPUT_TOKEN_LIMIT = 400_000;
const WRITER_OUTPUT_TOKEN_LIMIT = 32_000;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_WINDOW_MINUTES = 5;
const CIRCUIT_COOLDOWN_MINUTES = 5;
const HALF_OPEN_LEASE_SECONDS = 90;

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const boundedVersionSchema = z.string().trim().min(1).max(64);

const stageMetadataSchema = z
  .object({
    modelId: z.string().trim().min(1).max(128),
    promptVersion: boundedVersionSchema,
    schemaVersion: boundedVersionSchema,
    contextHash: sha256Schema,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    latencyMs: z.number().int().nonnegative(),
  })
  .strict();

export const boundedExtractionStageRecordSchema = stageMetadataSchema
  .extend({
    stage: z.literal('interpretation'),
    schemaSha256: sha256Schema,
    output: boundedClaimExtractionSchema,
  })
  .strict();

export type BoundedExtractionStageRecord = z.infer<typeof boundedExtractionStageRecordSchema>;
export type ConversationStage = BoundedExtractionStageRecord['stage'];

const stageReservationRequestSchema = z
  .object({
    turnJobId: uuidSchema,
    patientId: uuidSchema,
    stage: z.literal('interpretation'),
    reservedInputTokens: z.number().int().positive(),
    reservedOutputTokens: z.number().int().positive(),
  })
  .strict();

const persistStageRequestSchema = z
  .object({
    turnJobId: uuidSchema,
    patientId: uuidSchema,
    record: boundedExtractionStageRecordSchema,
  })
  .strict();

type SqlExecutor = Pick<PoolClient, 'query'>;

export class RuntimeRecordNotFoundError extends Error {
  override readonly name = 'RuntimeRecordNotFoundError';

  constructor() {
    super('Conversation runtime record not found');
  }
}

export class RuntimeConflictError extends Error {
  override readonly name = 'RuntimeConflictError';

  constructor() {
    super('Conversation runtime state conflict');
  }
}

async function inTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

type StageJobRow = {
  readonly id: string;
  readonly patient_id: string;
  readonly messaging_state_version: number | null;
  readonly inbound_sequence: number | string;
  readonly interpretation_attempted_at: Date | null;
  readonly interpretation_result: unknown | null;
  readonly window_start: Date | string;
  readonly window_end: Date | string;
};

export type StageReservationResult =
  | { readonly kind: 'reserved'; readonly windowStart: string; readonly windowEnd: string }
  | { readonly kind: 'already_attempted' }
  | { readonly kind: 'budget_exhausted' }
  | { readonly kind: 'suppressed' };

/** Commits both patient-local token reservations and the one-shot stage marker before dispatch. */
export async function reserveConversationStage(
  pool: Pool,
  untrustedRequest: z.input<typeof stageReservationRequestSchema>,
): Promise<StageReservationResult> {
  const request = stageReservationRequestSchema.parse(untrustedRequest);
  return inTransaction(pool, async (client) => {
    const identity = await client.query<{ messaging_state_version: number | null }>(
      `SELECT messaging_state_version
         FROM turn_job
        WHERE id = $1 AND patient_id = $2`,
      [request.turnJobId, request.patientId],
    );
    const expectedMessagingStateVersion = identity.rows[0]?.messaging_state_version;
    if (expectedMessagingStateVersion === undefined) throw new RuntimeRecordNotFoundError();
    if (expectedMessagingStateVersion === null) return { kind: 'suppressed' };
    try {
      await lockMessagingConsent(client, {
        patientId: request.patientId,
        expectedMessagingStateVersion,
      });
    } catch (error) {
      if (error instanceof MessagingConsentSuppressedError) return { kind: 'suppressed' };
      throw error;
    }
    const job = await client.query<StageJobRow>(
      `SELECT tj.id::text, tj.patient_id::text, tj.messaging_state_version,
              tj.inbound_sequence,
              tj.interpretation_attempted_at, tj.interpretation_result,
              (date_trunc('day', ir.received_at AT TIME ZONE p.timezone)
                AT TIME ZONE p.timezone) AS window_start,
              ((date_trunc('day', ir.received_at AT TIME ZONE p.timezone) + interval '1 day')
                AT TIME ZONE p.timezone) AS window_end
         FROM turn_job tj
         JOIN inbound_reply ir
           ON ir.patient_id = tj.patient_id AND ir.id = tj.inbound_message_id
         JOIN patient p ON p.id = tj.patient_id
        WHERE tj.id = $1 AND tj.patient_id = $2
        FOR UPDATE OF tj`,
      [request.turnJobId, request.patientId],
    );
    const row = job.rows[0];
    if (row === undefined) throw new RuntimeRecordNotFoundError();
    if (row.messaging_state_version !== expectedMessagingStateVersion) {
      return { kind: 'suppressed' };
    }
    await assertLowestUnfinishedConversationJob(client, row.patient_id, row.inbound_sequence);
    if (row.interpretation_attempted_at !== null) return { kind: 'already_attempted' };

    const bucketSpecs = [
      { subjectKey: `${request.patientId}:input`, limit: INPUT_TOKEN_LIMIT },
      { subjectKey: `${request.patientId}:output`, limit: OUTPUT_TOKEN_LIMIT },
    ] as const;
    // Live-fault fix (2026-08-17): the bucket row used to freeze limit_units at creation (DO
    // NOTHING left an already-existing row's limit untouched), so raising the daily ceiling
    // mid-incident required manual SQL against the live row. DO UPDATE with GREATEST applies a
    // raised constant to every bucket from its next reservation on, in the SAME window, while a
    // lower constant (a rollback, or an older deploy racing a newer one) can never claw back a
    // limit a patient's bucket is already relying on.
    for (const bucket of bucketSpecs) {
      await client.query(
        `INSERT INTO usage_bucket
           (bucket_scope, subject_key, patient_id, window_start, window_end, limit_units)
         VALUES ('patient_tokens', $1, $2, $3, $4, $5)
         ON CONFLICT (bucket_scope, subject_key, window_start)
         DO UPDATE SET limit_units = GREATEST(usage_bucket.limit_units, EXCLUDED.limit_units)`,
        [bucket.subjectKey, request.patientId, row.window_start, row.window_end, bucket.limit],
      );
    }
    const buckets = await client.query<{
      subject_key: string;
      reserved_units: number;
      consumed_units: number;
      limit_units: number;
    }>(
      `SELECT subject_key, reserved_units, consumed_units, limit_units
         FROM usage_bucket
        WHERE bucket_scope = 'patient_tokens'
          AND patient_id = $1
          AND window_start = $2
          AND subject_key = ANY($3::text[])
        ORDER BY subject_key
        FOR UPDATE`,
      [request.patientId, row.window_start, bucketSpecs.map(({ subjectKey }) => subjectKey)],
    );
    const byKey = new Map(buckets.rows.map((bucket) => [bucket.subject_key, bucket]));
    const inputBucket = byKey.get(`${request.patientId}:input`);
    const outputBucket = byKey.get(`${request.patientId}:output`);
    if (inputBucket === undefined || outputBucket === undefined) throw new RuntimeConflictError();
    if (
      inputBucket.reserved_units + inputBucket.consumed_units + request.reservedInputTokens >
        inputBucket.limit_units ||
      outputBucket.reserved_units + outputBucket.consumed_units + request.reservedOutputTokens >
        outputBucket.limit_units
    ) {
      await client.query(
        `UPDATE turn_job SET failure_kind = 'budget_exhausted'
          WHERE id = $1 AND patient_id = $2`,
        [request.turnJobId, request.patientId],
      );
      return { kind: 'budget_exhausted' };
    }
    await client.query(
      `UPDATE usage_bucket
          SET reserved_units = reserved_units +
                CASE subject_key WHEN $3 THEN $5::integer ELSE $6::integer END,
              updated_at = now()
        WHERE bucket_scope = 'patient_tokens'
          AND patient_id = $1
          AND window_start = $2
          AND subject_key = ANY($4::text[])`,
      [
        request.patientId,
        row.window_start,
        `${request.patientId}:input`,
        bucketSpecs.map(({ subjectKey }) => subjectKey),
        request.reservedInputTokens,
        request.reservedOutputTokens,
      ],
    );
    await client.query(
      `UPDATE turn_job
          SET interpretation_attempted_at = now(),
              interpretation_reserved_input = $3,
              interpretation_reserved_output = $4,
              failure_kind = NULL
        WHERE id = $1 AND patient_id = $2`,
      [
        request.turnJobId,
        request.patientId,
        request.reservedInputTokens,
        request.reservedOutputTokens,
      ],
    );
    return { kind: 'reserved', windowStart: iso(row.window_start), windowEnd: iso(row.window_end) };
  });
}

const composerStageReservationRequestSchema = z
  .object({
    turnJobId: uuidSchema,
    patientId: uuidSchema,
    reservedInputTokens: z.number().int().positive(),
    reservedOutputTokens: z.number().int().positive(),
  })
  .strict();

export type ComposerStageReservationResult =
  | { readonly kind: 'reserved' }
  | { readonly kind: 'already_attempted' }
  | { readonly kind: 'budget_exhausted' };

/**
 * Wave 1b ACTIVATION — the writer (composer) stage's OWN durable one-shot reservation.
 * Isolation items 2-4: guarded on `writer_attempted_at` (never `interpretation_attempted_at`),
 * spends the composer's OWN `{patientId}:writer-input/-output` buckets (never the extractor's),
 * and NEVER writes `failure_kind` — that column is the interpretation stage's evidence trail,
 * and a composer-quality failure always falls back to the template floor rather than entering
 * runtime-failure/human-review. Deliberately does not call reserveConversationStage.
 */
export async function reserveComposerStage(
  pool: Pool,
  untrustedRequest: z.input<typeof composerStageReservationRequestSchema>,
): Promise<ComposerStageReservationResult> {
  const request = composerStageReservationRequestSchema.parse(untrustedRequest);
  return inTransaction(pool, async (client) => {
    const job = await client.query<{
      writer_attempted_at: Date | null;
      window_start: Date | string;
      window_end: Date | string;
    }>(
      `SELECT tj.writer_attempted_at,
              (date_trunc('day', ir.received_at AT TIME ZONE p.timezone)
                AT TIME ZONE p.timezone) AS window_start,
              ((date_trunc('day', ir.received_at AT TIME ZONE p.timezone) + interval '1 day')
                AT TIME ZONE p.timezone) AS window_end
         FROM turn_job tj
         JOIN inbound_reply ir
           ON ir.patient_id = tj.patient_id AND ir.id = tj.inbound_message_id
         JOIN patient p ON p.id = tj.patient_id
        WHERE tj.id = $1 AND tj.patient_id = $2
        FOR UPDATE OF tj`,
      [request.turnJobId, request.patientId],
    );
    const row = job.rows[0];
    if (row === undefined) throw new RuntimeRecordNotFoundError();
    if (row.writer_attempted_at !== null) return { kind: 'already_attempted' };

    const bucketKeys = composerBudgetBucketKeys(request.patientId);
    const bucketSpecs = [
      { subjectKey: bucketKeys.input, limit: WRITER_INPUT_TOKEN_LIMIT },
      { subjectKey: bucketKeys.output, limit: WRITER_OUTPUT_TOKEN_LIMIT },
    ] as const;
    // Live-fault fix (2026-08-17): same GREATEST-on-conflict raise as the interpretation
    // bucket above — see that comment. A raised limit applies mid-window; a lower one never
    // claws back a limit a patient's bucket already relies on.
    for (const bucket of bucketSpecs) {
      await client.query(
        `INSERT INTO usage_bucket
           (bucket_scope, subject_key, patient_id, window_start, window_end, limit_units)
         VALUES ('patient_tokens', $1, $2, $3, $4, $5)
         ON CONFLICT (bucket_scope, subject_key, window_start)
         DO UPDATE SET limit_units = GREATEST(usage_bucket.limit_units, EXCLUDED.limit_units)`,
        [bucket.subjectKey, request.patientId, row.window_start, row.window_end, bucket.limit],
      );
    }
    const buckets = await client.query<{
      subject_key: string;
      reserved_units: number;
      consumed_units: number;
      limit_units: number;
    }>(
      `SELECT subject_key, reserved_units, consumed_units, limit_units
         FROM usage_bucket
        WHERE bucket_scope = 'patient_tokens'
          AND patient_id = $1
          AND window_start = $2
          AND subject_key = ANY($3::text[])
        ORDER BY subject_key
        FOR UPDATE`,
      [request.patientId, row.window_start, bucketSpecs.map(({ subjectKey }) => subjectKey)],
    );
    const byKey = new Map(buckets.rows.map((bucket) => [bucket.subject_key, bucket]));
    const inputBucket = byKey.get(bucketKeys.input);
    const outputBucket = byKey.get(bucketKeys.output);
    if (inputBucket === undefined || outputBucket === undefined) throw new RuntimeConflictError();
    if (
      inputBucket.reserved_units + inputBucket.consumed_units + request.reservedInputTokens >
        inputBucket.limit_units ||
      outputBucket.reserved_units + outputBucket.consumed_units + request.reservedOutputTokens >
        outputBucket.limit_units
    ) {
      return { kind: 'budget_exhausted' };
    }
    await client.query(
      `UPDATE usage_bucket
          SET reserved_units = reserved_units +
                CASE subject_key WHEN $3 THEN $5::integer ELSE $6::integer END,
              updated_at = now()
        WHERE bucket_scope = 'patient_tokens'
          AND patient_id = $1
          AND window_start = $2
          AND subject_key = ANY($4::text[])`,
      [
        request.patientId,
        row.window_start,
        bucketKeys.input,
        bucketSpecs.map(({ subjectKey }) => subjectKey),
        request.reservedInputTokens,
        request.reservedOutputTokens,
      ],
    );
    const reserved = await client.query(
      `UPDATE turn_job
          SET writer_attempted_at = now(),
              writer_reserved_input = $3,
              writer_reserved_output = $4
        WHERE id = $1 AND patient_id = $2 AND writer_attempted_at IS NULL`,
      [
        request.turnJobId,
        request.patientId,
        request.reservedInputTokens,
        request.reservedOutputTokens,
      ],
    );
    // Defense in depth: the row lock above already serializes concurrent reservers, so this
    // never actually loses the race, but a guarded UPDATE never trusts the read alone.
    if (reserved.rowCount !== 1) return { kind: 'already_attempted' };
    return { kind: 'reserved' };
  });
}

const composerStageUsageSchema = z
  .object({
    turnJobId: uuidSchema,
    patientId: uuidSchema,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Reconciles a composition's worst-case reservation down to its actual usage (mirrors
 * persistConversationStageResult's reserved -> consumed move for the writer's own buckets).
 *
 * Live incident (2026-08-17): this used to run on the SUCCESS path only, so every failed
 * composition held its full 8,000/1,024 reservation for the rest of the patient's day — the
 * same leak that killed the interpretation stage. EVERY post-reserve exit now calls it, passing
 * whatever the provider actually billed (zero when the call never landed). It is idempotent: the
 * reserved columns are zeroed, so a second call finds nothing to release. `writer_attempted_at`
 * is untouched — releasing units must never make an attempted composition attemptable again.
 */
export async function persistComposerStageUsage(
  pool: Pool,
  untrustedRequest: z.input<typeof composerStageUsageSchema>,
): Promise<void> {
  const request = composerStageUsageSchema.parse(untrustedRequest);
  await inTransaction(pool, async (client) => {
    const job = await client.query<{
      writer_reserved_input: number;
      writer_reserved_output: number;
      window_start: Date | string;
    }>(
      `SELECT tj.writer_reserved_input, tj.writer_reserved_output,
              (date_trunc('day', ir.received_at AT TIME ZONE p.timezone)
                AT TIME ZONE p.timezone) AS window_start
         FROM turn_job tj
         JOIN inbound_reply ir
           ON ir.patient_id = tj.patient_id AND ir.id = tj.inbound_message_id
         JOIN patient p ON p.id = tj.patient_id
        WHERE tj.id = $1 AND tj.patient_id = $2
        FOR UPDATE OF tj`,
      [request.turnJobId, request.patientId],
    );
    const row = job.rows[0];
    if (row === undefined) throw new RuntimeRecordNotFoundError();
    // Never reserved (defensive — the caller always reserves before invoking): nothing to do.
    if (row.writer_reserved_input === 0 && row.writer_reserved_output === 0) return;

    const bucketKeys = composerBudgetBucketKeys(request.patientId);
    const releaseInput = row.writer_reserved_input;
    const releaseOutput = row.writer_reserved_output;
    const consumedInput = Math.min(request.inputTokens, releaseInput);
    const consumedOutput = Math.min(request.outputTokens, releaseOutput);
    await client.query(
      `UPDATE usage_bucket
          SET reserved_units = GREATEST(0, reserved_units -
                CASE subject_key WHEN $3 THEN $5::integer ELSE $6::integer END),
              consumed_units = consumed_units +
                CASE subject_key WHEN $3 THEN $7::integer ELSE $8::integer END,
              updated_at = now()
        WHERE bucket_scope = 'patient_tokens'
          AND patient_id = $1
          AND window_start = $2
          AND subject_key = ANY($4::text[])`,
      [
        request.patientId,
        row.window_start,
        bucketKeys.input,
        [bucketKeys.input, bucketKeys.output],
        releaseInput,
        releaseOutput,
        consumedInput,
        consumedOutput,
      ],
    );
    await client.query(
      `UPDATE turn_job SET writer_reserved_input = 0, writer_reserved_output = 0
        WHERE id = $1 AND patient_id = $2`,
      [request.turnJobId, request.patientId],
    );
  });
}

const stageReleaseRequestSchema = z
  .object({
    turnJobId: uuidSchema,
    patientId: uuidSchema,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Live incident (2026-08-17): reserved units were returned ONLY on the success path, so every
 * post-reserve failure (gateway ok:false, transport throw, contract mismatch) leaked the whole
 * reservation for the rest of the patient's day — one terminally failed turn pushed every later
 * message into budget_exhausted and the agent answered a direct patient question with the
 * human-review template.
 *
 * This releases the UNITS while deliberately LEAVING `interpretation_attempted_at` set: that
 * column is the at-most-once attempt marker, and resurrecting it would let a redrive re-invoke
 * the provider for a turn that already dispatched. Whatever the provider actually billed (the
 * failure response's own usage, or zero when the call never landed) is moved to consumed, so
 * metering stays honest; the rest is returned. Idempotent — the reserved columns are zeroed, and
 * a turn whose result persist already reconciled is a no-op.
 */
export async function releaseConversationStageReservation(
  pool: Pool,
  untrustedRequest: z.input<typeof stageReleaseRequestSchema>,
): Promise<void> {
  const request = stageReleaseRequestSchema.parse(untrustedRequest);
  await inTransaction(pool, async (client) => {
    const job = await client.query<{
      interpretation_result: unknown | null;
      interpretation_reserved_input: number;
      interpretation_reserved_output: number;
      window_start: Date | string;
    }>(
      `SELECT tj.interpretation_result,
              tj.interpretation_reserved_input, tj.interpretation_reserved_output,
              (date_trunc('day', ir.received_at AT TIME ZONE p.timezone)
                AT TIME ZONE p.timezone) AS window_start
         FROM turn_job tj
         JOIN inbound_reply ir
           ON ir.patient_id = tj.patient_id AND ir.id = tj.inbound_message_id
         JOIN patient p ON p.id = tj.patient_id
        WHERE tj.id = $1 AND tj.patient_id = $2
        FOR UPDATE OF tj`,
      [request.turnJobId, request.patientId],
    );
    const row = job.rows[0];
    if (row === undefined) throw new RuntimeRecordNotFoundError();
    // persistConversationStageResult already moved reserved -> consumed for this turn.
    if (row.interpretation_result !== null) return;
    const releaseInput = row.interpretation_reserved_input;
    const releaseOutput = row.interpretation_reserved_output;
    // Never reserved, or already released by an earlier redrive of this same failure.
    if (releaseInput <= 0 && releaseOutput <= 0) return;

    await client.query(
      `UPDATE usage_bucket
          SET reserved_units = GREATEST(0, reserved_units -
                CASE subject_key WHEN $3 THEN $5::integer ELSE $6::integer END),
              consumed_units = consumed_units +
                CASE subject_key WHEN $3 THEN $7::integer ELSE $8::integer END,
              updated_at = now()
        WHERE bucket_scope = 'patient_tokens'
          AND patient_id = $1
          AND window_start = $2
          AND subject_key = ANY($4::text[])`,
      [
        request.patientId,
        row.window_start,
        `${request.patientId}:input`,
        [`${request.patientId}:input`, `${request.patientId}:output`],
        releaseInput,
        releaseOutput,
        // Same capped-total accounting persistConversationStageResult uses: a turn that burned
        // its retry budget before failing legitimately spent more than the one call it reserved,
        // and under-reporting that would blind the daily runaway ceiling to the real spend.
        Math.min(request.inputTokens, MAX_INTERPRETATION_TURN_INPUT_TOKENS),
        Math.min(request.outputTokens, MAX_INTERPRETATION_TURN_OUTPUT_TOKENS),
      ],
    );
    await client.query(
      `UPDATE turn_job
          SET interpretation_reserved_input = 0, interpretation_reserved_output = 0
        WHERE id = $1 AND patient_id = $2`,
      [request.turnJobId, request.patientId],
    );
  });
}

type PersistJobRow = {
  readonly interpretation_result: unknown | null;
  readonly interpretation_reserved_input: number;
  readonly interpretation_reserved_output: number;
  readonly window_start: Date | string;
};

export type StagePersistenceResult = { readonly kind: 'stored' | 'replay' };

/** Stores validated output and reconciles the worst-case reservation in the same transaction. */
export async function persistConversationStageResult(
  pool: Pool,
  untrustedRequest: z.input<typeof persistStageRequestSchema>,
): Promise<StagePersistenceResult> {
  const request = persistStageRequestSchema.parse(untrustedRequest);
  const record = request.record;
  return inTransaction(pool, async (client) => {
    const job = await client.query<PersistJobRow>(
      `SELECT tj.interpretation_result,
              tj.interpretation_reserved_input, tj.interpretation_reserved_output,
              (date_trunc('day', ir.received_at AT TIME ZONE p.timezone)
                AT TIME ZONE p.timezone) AS window_start
         FROM turn_job tj
         JOIN inbound_reply ir
           ON ir.patient_id = tj.patient_id AND ir.id = tj.inbound_message_id
         JOIN patient p ON p.id = tj.patient_id
        WHERE tj.id = $1 AND tj.patient_id = $2
        FOR UPDATE OF tj`,
      [request.turnJobId, request.patientId],
    );
    const row = job.rows[0];
    if (row === undefined) throw new RuntimeRecordNotFoundError();
    if (row.interpretation_result !== null) {
      boundedExtractionStageRecordSchema.parse(row.interpretation_result);
      return { kind: 'replay' };
    }
    const reservedInput = row.interpretation_reserved_input;
    const reservedOutput = row.interpretation_reserved_output;
    // CAPPED TOTAL (2026-08-17 right-sizing): the turn reserved ONE provider call's worth, but
    // the interpretation stage reports SUMMED usage across the extractor's bounded retry loop,
    // so a retried turn honestly spends more than it held. The reservation is treated as topped
    // up to the declared per-turn maximum — arithmetically identical to reserving the delta and
    // releasing it in this same transaction — so `consumed <= reserved` still holds and the
    // per-turn spend stays hard-capped. A figure above the cap cannot be honest: fail closed.
    if (
      reservedInput <= 0 ||
      reservedOutput <= 0 ||
      record.inputTokens > MAX_INTERPRETATION_TURN_INPUT_TOKENS ||
      record.outputTokens > MAX_INTERPRETATION_TURN_OUTPUT_TOKENS
    ) {
      throw new RuntimeConflictError();
    }
    const updated = await client.query(
      `UPDATE usage_bucket
          SET reserved_units = reserved_units -
                CASE subject_key WHEN $3 THEN $5::integer ELSE $6::integer END,
              consumed_units = consumed_units +
                CASE subject_key WHEN $3 THEN $7::integer ELSE $8::integer END,
              updated_at = now()
        WHERE bucket_scope = 'patient_tokens'
          AND patient_id = $1
          AND window_start = $2
          AND subject_key = ANY($4::text[])
          AND reserved_units >=
                CASE subject_key WHEN $3 THEN $5::integer ELSE $6::integer END`,
      [
        request.patientId,
        row.window_start,
        `${request.patientId}:input`,
        [`${request.patientId}:input`, `${request.patientId}:output`],
        reservedInput,
        reservedOutput,
        record.inputTokens,
        record.outputTokens,
      ],
    );
    if (updated.rowCount !== 2) throw new RuntimeConflictError();
    const stored = await client.query(
      `UPDATE turn_job SET interpretation_result = $3::jsonb
        WHERE id = $1 AND patient_id = $2 AND interpretation_attempted_at IS NOT NULL
          AND interpretation_result IS NULL`,
      [request.turnJobId, request.patientId, JSON.stringify(record)],
    );
    if (stored.rowCount !== 1) throw new RuntimeConflictError();
    return { kind: 'stored' };
  });
}

/** Loads only the recovered bounded extractor checkpoint; legacy checkpoints fail closed. */
export async function loadBoundedExtractionStageResult(
  client: SqlExecutor,
  request: { readonly turnJobId: string; readonly patientId: string },
): Promise<BoundedExtractionStageRecord | null> {
  const identity = z
    .object({ turnJobId: uuidSchema, patientId: uuidSchema })
    .strict()
    .parse(request);
  const result = await client.query<{ interpretation_result: unknown | null }>(
    `SELECT interpretation_result
       FROM turn_job
      WHERE id = $1 AND patient_id = $2`,
    [identity.turnJobId, identity.patientId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new RuntimeRecordNotFoundError();
  return row.interpretation_result === null
    ? null
    : boundedExtractionStageRecordSchema.parse(row.interpretation_result);
}

const circuitIdentitySchema = z
  .object({
    providerKey: z.string().trim().min(1).max(64),
    leaseId: uuidSchema,
  })
  .strict();

type CircuitRow = {
  readonly state: 'closed' | 'open' | 'half_open';
  readonly consecutive_failures: number;
  readonly last_failure_kind: 'auth' | 'transient' | 'contract' | null;
  readonly failure_window_started_at: Date | string | null;
  readonly cooldown_until: Date | string | null;
  readonly half_open_lease_id: string | null;
  readonly half_open_lease_expires_at: Date | string | null;
  readonly now_at: Date | string;
};

export type ProviderCircuitClaim =
  | { readonly kind: 'closed' }
  | { readonly kind: 'half_open'; readonly leaseId: string; readonly leaseExpiresAt: string }
  | { readonly kind: 'open'; readonly retryAt: string };

/** Atomically grants at most one half-open probe after the cooldown. */
export async function claimProviderCircuit(
  pool: Pool,
  untrustedRequest: z.input<typeof circuitIdentitySchema>,
): Promise<ProviderCircuitClaim> {
  const request = circuitIdentitySchema.parse(untrustedRequest);
  return inTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO provider_circuit (provider_key, state)
       VALUES ($1, 'closed') ON CONFLICT (provider_key) DO NOTHING`,
      [request.providerKey],
    );
    const selected = await client.query<CircuitRow>(
      `SELECT pc.*, CURRENT_TIMESTAMP AS now_at
         FROM provider_circuit pc WHERE provider_key = $1 FOR UPDATE`,
      [request.providerKey],
    );
    const row = selected.rows[0]!;
    const now = new Date(row.now_at);
    if (row.state === 'closed') return { kind: 'closed' };
    if (
      row.state === 'half_open' &&
      row.half_open_lease_expires_at !== null &&
      new Date(row.half_open_lease_expires_at) > now
    ) {
      return { kind: 'open', retryAt: iso(row.half_open_lease_expires_at) };
    }
    if (row.state === 'open' && row.cooldown_until !== null && new Date(row.cooldown_until) > now) {
      return { kind: 'open', retryAt: iso(row.cooldown_until) };
    }
    const claimed = await client.query<{ half_open_lease_expires_at: Date | string }>(
      `UPDATE provider_circuit
          SET state = 'half_open', half_open_lease_id = $2,
              half_open_lease_expires_at = CURRENT_TIMESTAMP + ($3 * interval '1 second'),
              updated_at = CURRENT_TIMESTAMP
        WHERE provider_key = $1
        RETURNING half_open_lease_expires_at`,
      [request.providerKey, request.leaseId, HALF_OPEN_LEASE_SECONDS],
    );
    return {
      kind: 'half_open',
      leaseId: request.leaseId,
      leaseExpiresAt: iso(claimed.rows[0]!.half_open_lease_expires_at),
    };
  });
}

/** Gives up a half-open probe when local guards prevent any provider dispatch. */
export async function releaseProviderCircuitClaim(
  pool: Pool,
  untrustedRequest: z.input<typeof circuitIdentitySchema>,
): Promise<void> {
  const request = circuitIdentitySchema.parse(untrustedRequest);
  await inTransaction(pool, async (client) => {
    const selected = await client.query<CircuitRow>(
      `SELECT pc.*, CURRENT_TIMESTAMP AS now_at
         FROM provider_circuit pc WHERE provider_key = $1 FOR UPDATE`,
      [request.providerKey],
    );
    const row = selected.rows[0];
    if (row === undefined) throw new RuntimeRecordNotFoundError();
    if (row.state !== 'half_open') return;
    if (row.half_open_lease_id !== request.leaseId) throw new RuntimeConflictError();
    await client.query(
      `UPDATE provider_circuit
          SET state = 'open', cooldown_until = CURRENT_TIMESTAMP,
              half_open_lease_id = NULL, half_open_lease_expires_at = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE provider_key = $1`,
      [request.providerKey],
    );
  });
}

export async function recordProviderCircuitSuccess(
  pool: Pool,
  untrustedRequest: z.input<typeof circuitIdentitySchema>,
): Promise<void> {
  const request = circuitIdentitySchema.parse(untrustedRequest);
  await inTransaction(pool, async (client) => {
    const selected = await client.query<CircuitRow>(
      `SELECT pc.*, CURRENT_TIMESTAMP AS now_at
         FROM provider_circuit pc WHERE provider_key = $1 FOR UPDATE`,
      [request.providerKey],
    );
    const row = selected.rows[0];
    if (row === undefined) throw new RuntimeRecordNotFoundError();
    if (row.state === 'open') return;
    if (row.state === 'half_open' && row.half_open_lease_id !== request.leaseId) {
      throw new RuntimeConflictError();
    }
    await client.query(
      `UPDATE provider_circuit
          SET state = 'closed', consecutive_failures = 0, last_failure_kind = NULL,
              failure_window_started_at = NULL, opened_at = NULL, cooldown_until = NULL,
              half_open_lease_id = NULL, half_open_lease_expires_at = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE provider_key = $1`,
      [request.providerKey],
    );
  });
}

const circuitFailureSchema = circuitIdentitySchema.extend({
  failureKind: z.enum(['auth', 'transient', 'contract']),
});

/** Applies the immediate-auth and five-within-five-minutes circuit rules under a row lock. */
export async function recordProviderCircuitFailure(
  pool: Pool,
  untrustedRequest: z.input<typeof circuitFailureSchema>,
): Promise<void> {
  const request = circuitFailureSchema.parse(untrustedRequest);
  await inTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO provider_circuit (provider_key, state)
       VALUES ($1, 'closed') ON CONFLICT (provider_key) DO NOTHING`,
      [request.providerKey],
    );
    const selected = await client.query<CircuitRow>(
      `SELECT pc.*, CURRENT_TIMESTAMP AS now_at
         FROM provider_circuit pc WHERE provider_key = $1 FOR UPDATE`,
      [request.providerKey],
    );
    const row = selected.rows[0]!;
    if (row.state === 'half_open' && row.half_open_lease_id !== request.leaseId) {
      throw new RuntimeConflictError();
    }
    const outsideWindow =
      row.failure_window_started_at === null ||
      new Date(row.failure_window_started_at).getTime() <
        new Date(row.now_at).getTime() - CIRCUIT_WINDOW_MINUTES * 60_000;
    const failures = outsideWindow ? 1 : row.consecutive_failures + 1;
    const opens =
      request.failureKind === 'auth' ||
      row.state === 'open' ||
      row.state === 'half_open' ||
      failures >= CIRCUIT_FAILURE_THRESHOLD;
    await client.query(
      `UPDATE provider_circuit
          SET state = CASE WHEN $3 THEN 'open' ELSE 'closed' END,
              consecutive_failures = $2,
              last_failure_kind = $4,
              failure_window_started_at = CASE
                WHEN $5 THEN CURRENT_TIMESTAMP ELSE failure_window_started_at END,
              opened_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE NULL END,
              cooldown_until = CASE WHEN $3
                THEN CURRENT_TIMESTAMP + ($6 * interval '1 minute') ELSE NULL END,
              half_open_lease_id = NULL, half_open_lease_expires_at = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE provider_key = $1`,
      [
        request.providerKey,
        failures,
        opens,
        request.failureKind,
        outsideWindow,
        CIRCUIT_COOLDOWN_MINUTES,
      ],
    );
  });
}
