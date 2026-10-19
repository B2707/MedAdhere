// Wave 1b Lane C — compose persistence against PostgreSQL 16 (testcontainers).
// Pins: the one-shot compose checkpoint (idempotent under replay, template body never
// overwritten), the DB code-point ceiling that ERRORS instead of truncating, the widened
// writer_result dependency CHECK, the composer_control pre-registered abort (>30% rolling
// fallback flips the flag off), and the sender path (composed_body ?? body with the
// send-time tamper re-check falling back to the template body).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMPOSER_DISABLE_ENV,
  isComposerEnabled,
  productionComposerSeam,
  recordCompositionOutcome,
  resolveOutboundSendBody,
  sha256Utf8,
  validateStoredCompositionRecord,
  type ComposerOutcomeRecord,
  type MetricEntry,
} from './compose-plumbing.js';
import { checkpointComposedOutbound } from './clinical-memory/repository.js';
import type { ComposerIntent } from './clinical-memory/composer-validators.js';
import type { ComposerDayContext } from './clinical-memory/composer-envelope.js';
import {
  claimPreparedAgentSend,
  sendClaimedOutboundUnderConsent,
} from '../outbound/send-repository.js';
import { persistComposerStageUsage, reserveComposerStage } from './runtime-repository.js';
import { composerBudgetBucketKeys } from './clinical-memory/composer.js';
import type { PreparedClinicalTurn } from './clinical-memory/index.js';
import type { ConversationGatewayResponse } from './gateway-contract.js';

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema-init', 'schema.sql'), 'utf8');
const CONTAINER_TIMEOUT_MS = 180_000;
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTEXT_HASH = 'a'.repeat(64);
const TEMPLATE_BODY = 'Hey, thanks for the update.';
const COMPOSED_BODY = 'Glad the morning dose went down fine. How is the headache now?';
let sidCounter = 0;

/** uq_outbound_message_twilio_sid is UNIQUE — every accepted send needs a fresh SID. */
function nextTwilioSid(): string {
  sidCounter += 1;
  return `SM${String(sidCounter).padStart(32, '0')}`;
}
const CALLBACK_CONFIG = { baseUrl: 'https://callbacks.example.test/status', retryFragment: '' };
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

let container: StartedPostgreSqlContainer | undefined;
let pool: Pool;
let phoneCounter = 0;

type SeededOutbound = {
  readonly patientId: string;
  readonly messagingStateVersion: number;
  readonly inboundMessageId: string;
  readonly turnJobId: string;
  readonly agentTurnId: string;
  readonly outboundMessageId: string;
};

async function seedPreparedAgentOutbound(sequence = 1): Promise<SeededOutbound> {
  phoneCounter += 1;
  const patient = await pool.query<{ id: string; messaging_state_version: number }>(
    `INSERT INTO patient (phone, medication_name, owner_clinician_sub, timezone, is_test)
     VALUES ($1, 'test medication', $2, 'America/Toronto', true)
     RETURNING id::text, messaging_state_version`,
    [`+1500888${String(phoneCounter).padStart(4, '0')}`, OWNER_ID],
  );
  const patientId = patient.rows[0]!.id;
  const messagingStateVersion = patient.rows[0]!.messaging_state_version;
  const inbound = await pool.query<{ id: string }>(
    `INSERT INTO inbound_reply (patient_id, raw_body, received_at, inbound_sequence, enqueued_at)
     VALUES ($1, 'Took it, thanks.', now(), $2, now())
     RETURNING id::text`,
    [patientId, sequence],
  );
  const inboundMessageId = inbound.rows[0]!.id;
  const job = await pool.query<{ id: string }>(
    `INSERT INTO turn_job
       (patient_id, inbound_message_id, inbound_sequence, messaging_state_version,
        clinical_context_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id::text`,
    [patientId, inboundMessageId, sequence, messagingStateVersion, CONTEXT_HASH],
  );
  const turnJobId = job.rows[0]!.id;
  const turn = await pool.query<{ id: string }>(
    `INSERT INTO agent_turn
       (patient_id, inbound_message_id, turn_job_id, model_id, prompt_version, schema_version,
        context_hash, input_tokens, output_tokens, latency_ms, final_policy_tier)
     VALUES ($1, $2, $3, 'bounded-extractor', 'test-v1', 'clinical-memory-v1', $4, 0, 0, 0,
             'routine')
     RETURNING id::text`,
    [patientId, inboundMessageId, turnJobId, CONTEXT_HASH],
  );
  const agentTurnId = turn.rows[0]!.id;
  const outbound = await pool.query<{ id: string }>(
    `INSERT INTO outbound_message
       (patient_id, status, body, message_kind, in_reply_to_inbound_id, agent_turn_id,
        language, messaging_consent_epoch)
     VALUES ($1, 'prepared', $2, 'acknowledgement', $3, $4, 'en', $5)
     RETURNING id::text`,
    [patientId, TEMPLATE_BODY, inboundMessageId, agentTurnId, messagingStateVersion],
  );
  return {
    patientId,
    messagingStateVersion,
    inboundMessageId,
    turnJobId,
    agentTurnId,
    outboundMessageId: outbound.rows[0]!.id,
  };
}

/** Validation context under which COMPOSED_BODY passes the stored-composition re-check. */
const STORED_INTENT: ComposerIntent = {
  kind: 'question',
  requiredTokens: [],
  allowedTerms: ['headache'],
  question: { field: 'severity', keyVocabulary: ['how is'] },
  medications: [],
  patientFacts: [],
};
const STORED_DAY_CONTEXT: ComposerDayContext = {
  messages: [],
  latestPatientMessage: 'took the morning dose fine but the headache is back',
};

function checkpointInput(seeded: SeededOutbound, composedBody = COMPOSED_BODY) {
  return {
    outboundMessageId: seeded.outboundMessageId,
    patientId: seeded.patientId,
    agentTurnId: seeded.agentTurnId,
    composedBody,
    composition: {
      composedBodySha256: sha256Utf8(composedBody),
      modelId: 'test-model',
      intent: STORED_INTENT,
      dayContext: STORED_DAY_CONTEXT,
    },
  };
}

/** recordCompositionOutcome audit fields for a seeded (or absent) turn job. */
function outcomeRecord(
  fallbackReason: string | null,
  seeded?: SeededOutbound,
): ComposerOutcomeRecord {
  return {
    fallbackReason,
    turnJobId: seeded?.turnJobId ?? 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    patientId: seeded?.patientId ?? 'ffffffff-ffff-4fff-8fff-fffffffffffe',
    inputHash: 'd'.repeat(64),
    intent: seeded === undefined ? null : STORED_INTENT,
    attempts: [],
    sms: null,
  };
}

async function outboundRow(outboundMessageId: string) {
  const result = await pool.query<{
    body: string;
    composed_body: string | null;
    composition: Record<string, unknown> | null;
    status: string;
  }>(`SELECT body, composed_body, composition, status FROM outbound_message WHERE id = $1`, [
    outboundMessageId,
  ]);
  return result.rows[0]!;
}

async function resetComposerControl(): Promise<void> {
  await pool.query('DELETE FROM composer_control');
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

describe('compose checkpoint — guarded one-shot UPDATE', () => {
  it('checkpoints exactly once, never overwrites, and leaves the template body untouched', async () => {
    const seeded = await seedPreparedAgentOutbound();
    await expect(checkpointComposedOutbound(pool, checkpointInput(seeded))).resolves.toBe(true);
    const afterFirst = await outboundRow(seeded.outboundMessageId);
    expect(afterFirst.body).toBe(TEMPLATE_BODY);
    expect(afterFirst.composed_body).toBe(COMPOSED_BODY);
    expect(afterFirst.composition?.composedBodySha256).toBe(sha256Utf8(COMPOSED_BODY));

    // Replay: the one-shot guard (composition IS NULL) refuses a second write.
    await expect(
      checkpointComposedOutbound(pool, checkpointInput(seeded, 'A different reply.')),
    ).resolves.toBe(false);
    const afterSecond = await outboundRow(seeded.outboundMessageId);
    expect(afterSecond.body).toBe(TEMPLATE_BODY);
    expect(afterSecond.composed_body).toBe(COMPOSED_BODY);
  });

  it('refuses to checkpoint once the row has left prepared', async () => {
    const seeded = await seedPreparedAgentOutbound();
    await pool.query(
      `UPDATE outbound_message SET status = 'failed', status_updated_at = now() WHERE id = $1`,
      [seeded.outboundMessageId],
    );
    await expect(checkpointComposedOutbound(pool, checkpointInput(seeded))).resolves.toBe(false);
    expect((await outboundRow(seeded.outboundMessageId)).composed_body).toBeNull();
  });

  it('the DB ceiling errors on an over-320-code-point composed body — it never truncates', async () => {
    const seeded = await seedPreparedAgentOutbound();
    const oversize = 'x'.repeat(321);
    await expect(
      pool.query(
        `UPDATE outbound_message SET composed_body = $2, composition = '{}'::jsonb WHERE id = $1`,
        [seeded.outboundMessageId, oversize],
      ),
    ).rejects.toThrow(/outbound_message_composed_body_check/);
    expect((await outboundRow(seeded.outboundMessageId)).composed_body).toBeNull();

    const exactly320 = 'x'.repeat(320);
    await expect(
      checkpointComposedOutbound(pool, checkpointInput(seeded, exactly320)),
    ).resolves.toBe(true);
    expect((await outboundRow(seeded.outboundMessageId)).composed_body).toBe(exactly320);
  });

  it('rejects a composed body without provenance at the column level', async () => {
    const seeded = await seedPreparedAgentOutbound();
    await expect(
      pool.query(`UPDATE outbound_message SET composed_body = 'orphan text' WHERE id = $1`, [
        seeded.outboundMessageId,
      ]),
    ).rejects.toThrow(/outbound_message_composed_body_check/);
  });

  it('structurally refuses composed text on a safety-kind row at BOTH the checkpoint and the CHECK', async () => {
    const seeded = await seedPreparedAgentOutbound();
    await pool.query(
      `UPDATE outbound_message SET message_kind = 'safety', clarification_topic = NULL WHERE id = $1`,
      [seeded.outboundMessageId],
    );
    // Layer 1: the guarded one-shot UPDATE refuses the row.
    await expect(checkpointComposedOutbound(pool, checkpointInput(seeded))).resolves.toBe(false);
    expect((await outboundRow(seeded.outboundMessageId)).composed_body).toBeNull();
    // Layer 2: even a direct write is rejected by the column CHECK.
    const input = checkpointInput(seeded);
    await expect(
      pool.query(
        `UPDATE outbound_message SET composed_body = $2, composition = $3::jsonb WHERE id = $1`,
        [seeded.outboundMessageId, input.composedBody, JSON.stringify(input.composition)],
      ),
    ).rejects.toThrow(/outbound_message_composed_body_check/);
  });
});

describe('composition audit — durable writer_result record', () => {
  it('persists the one-shot audit record on the turn job without touching failure_kind', async () => {
    const seeded = await seedPreparedAgentOutbound();
    await recordCompositionOutcome(pool, {
      ...outcomeRecord('ungrounded_entity', seeded),
      attempts: [
        { rawOutput: '{"sms": "fabricated"}', verdict: { ok: false, reason: 'ungrounded_entity' } },
      ],
    });
    const row = await pool.query<{
      writer_result: {
        fallbackReason: string;
        inputHash: string;
        intent: unknown;
        attempts: readonly unknown[];
      } | null;
      writer_attempted_at: Date | null;
      failure_kind: string | null;
    }>(`SELECT writer_result, writer_attempted_at, failure_kind FROM turn_job WHERE id = $1`, [
      seeded.turnJobId,
    ]);
    expect(row.rows[0]?.writer_attempted_at).not.toBeNull();
    expect(row.rows[0]?.failure_kind).toBeNull();
    expect(row.rows[0]?.writer_result).toMatchObject({
      fallbackReason: 'ungrounded_entity',
      inputHash: 'd'.repeat(64),
      intent: STORED_INTENT,
    });
    expect(row.rows[0]?.writer_result?.attempts).toHaveLength(1);

    // One-shot: a second outcome never overwrites the recorded audit.
    await recordCompositionOutcome(pool, outcomeRecord(null, seeded));
    const after = await pool.query<{ writer_result: { fallbackReason: string | null } | null }>(
      `SELECT writer_result FROM turn_job WHERE id = $1`,
      [seeded.turnJobId],
    );
    expect(after.rows[0]?.writer_result?.fallbackReason).toBe('ungrounded_entity');
  });
});

describe('widened writer_result dependency CHECK', () => {
  it('allows a writer result on a turn that never attempted interpretation (bare yes/no)', async () => {
    const seeded = await seedPreparedAgentOutbound();
    await expect(
      pool.query(
        `UPDATE turn_job SET writer_attempted_at = now(), writer_result = '{"ok":true}'::jsonb
          WHERE id = $1`,
        [seeded.turnJobId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it('still rejects a writer result on an attempted-but-failed interpretation (runtime-failure turn)', async () => {
    const seeded = await seedPreparedAgentOutbound();
    await pool.query(`UPDATE turn_job SET interpretation_attempted_at = now() WHERE id = $1`, [
      seeded.turnJobId,
    ]);
    await expect(
      pool.query(
        `UPDATE turn_job SET writer_attempted_at = now(), writer_result = '{"ok":true}'::jsonb
          WHERE id = $1`,
        [seeded.turnJobId],
      ),
    ).rejects.toThrow(/turn_job_writer_result_dependency_check/);
  });
});

describe('composer_control — pre-registered abort', () => {
  it('stays enabled below the sample floor and at exactly 30%', async () => {
    await resetComposerControl();
    const emitted: MetricEntry[] = [];
    const emit = (entry: MetricEntry) => emitted.push(entry);
    // 50% fallback but only 2 samples: below the minimum, never aborts.
    await recordCompositionOutcome(pool, outcomeRecord('timeout'), emit);
    await recordCompositionOutcome(pool, outcomeRecord(null), emit);
    await expect(isComposerEnabled(pool)).resolves.toEqual({ enabled: true, reason: null });

    // Fill to 10 samples at exactly 3/10 = 30% — NOT above the threshold.
    for (let index = 0; index < 7; index += 1) {
      await recordCompositionOutcome(pool, outcomeRecord(null), emit);
    }
    await recordCompositionOutcome(pool, outcomeRecord('entity_grounding'), emit);
    await expect(isComposerEnabled(pool)).resolves.toEqual({ enabled: true, reason: null });
    expect(emitted.every((entry) => !JSON.stringify(entry).match(UUID_PATTERN))).toBe(true);
  });

  it('flips the flag off once the rolling fallback share exceeds 30% and says so identifier-free', async () => {
    await resetComposerControl();
    const emitted: MetricEntry[] = [];
    const emit = (entry: MetricEntry) => emitted.push(entry);
    for (let index = 0; index < 7; index += 1) {
      await recordCompositionOutcome(pool, outcomeRecord(null), emit);
    }
    for (let index = 0; index < 3; index += 1) {
      await recordCompositionOutcome(pool, outcomeRecord('timeout'), emit);
    }
    // 11th sample, 4/11 ≈ 36% > 30% — the abort fires exactly here.
    const crossing = await recordCompositionOutcome(pool, outcomeRecord('timeout'), emit);
    expect(crossing.autoDisabled).toBe(true);
    await expect(isComposerEnabled(pool)).resolves.toEqual({
      enabled: false,
      reason: 'auto_disabled',
    });
    const abortLine = emitted.find((entry) => entry.metric === 'composer_auto_disabled');
    expect(abortLine).toEqual({
      metric: 'composer_auto_disabled',
      windowComposeCount: 11,
      windowFallbackCount: 4,
    });
    for (const entry of emitted) {
      expect(JSON.stringify(entry)).not.toMatch(UUID_PATTERN);
    }
    // Already disabled: later outcomes never re-fire the abort.
    const after = await recordCompositionOutcome(pool, outcomeRecord('timeout'), emit);
    expect(after.autoDisabled).toBe(false);
  });

  it('honors the operator env kill switch', async () => {
    await resetComposerControl();
    process.env[COMPOSER_DISABLE_ENV] = 'true';
    try {
      await expect(isComposerEnabled(pool)).resolves.toEqual({
        enabled: false,
        reason: 'env_disabled',
      });
    } finally {
      delete process.env[COMPOSER_DISABLE_ENV];
    }
  });
});

describe('sender — composed_body ?? body with the send-time re-check', () => {
  it('claims composed fields and transmits the composed body while the stored template survives', async () => {
    const seeded = await seedPreparedAgentOutbound();
    await checkpointComposedOutbound(pool, checkpointInput(seeded));

    const claim = await claimPreparedAgentSend(pool, {
      patientId: seeded.patientId,
      agentTurnId: seeded.agentTurnId,
      expectedMessagingStateVersion: seeded.messagingStateVersion,
    });
    expect(claim.claimed).not.toBeNull();
    const claimed = claim.claimed!;
    expect(claimed.body).toBe(TEMPLATE_BODY);
    expect(claimed.composedBody).toBe(COMPOSED_BODY);

    const resolved = resolveOutboundSendBody({
      body: claimed.body ?? '',
      composedBody: claimed.composedBody,
      composition: claimed.composition,
      messageKind: claimed.messageKind,
    });
    expect(resolved).toEqual({ body: COMPOSED_BODY, usedComposedBody: true });

    const transmitted: string[] = [];
    const result = await sendClaimedOutboundUnderConsent(
      pool,
      {
        patientId: seeded.patientId,
        outboundMessageId: claimed.id,
        callbackToken: claimed.callbackToken,
        callbackConfig: CALLBACK_CONFIG,
        fromNumber: '+15005550006',
        body: resolved.body,
        expectedMessagingStateVersion: claimed.expectedMessagingStateVersion,
      },
      async (message) => {
        transmitted.push(message.body);
        return { sid: nextTwilioSid() };
      },
    );
    expect(result.sent).toBe(true);
    expect(transmitted).toEqual([COMPOSED_BODY]);

    // Column-level template survival: the append-only body is untouched after the send.
    const row = await outboundRow(seeded.outboundMessageId);
    expect(row.body).toBe(TEMPLATE_BODY);
    expect(row.composed_body).toBe(COMPOSED_BODY);
    expect(row.status).toBe('queued');
  });

  it('rejects a tampered composed row at send time and transmits the template body instead', async () => {
    const seeded = await seedPreparedAgentOutbound();
    await checkpointComposedOutbound(pool, checkpointInput(seeded));
    // Simulate tamper/bit-rot: the stored text no longer matches its provenance hash.
    await pool.query(
      `UPDATE outbound_message SET composed_body = 'tampered composed text' WHERE id = $1`,
      [seeded.outboundMessageId],
    );

    const claim = await claimPreparedAgentSend(pool, {
      patientId: seeded.patientId,
      agentTurnId: seeded.agentTurnId,
      expectedMessagingStateVersion: seeded.messagingStateVersion,
    });
    const claimed = claim.claimed!;
    const emitted: MetricEntry[] = [];
    const resolved = resolveOutboundSendBody(
      {
        body: claimed.body ?? '',
        composedBody: claimed.composedBody,
        composition: claimed.composition,
        messageKind: claimed.messageKind,
      },
      { emit: (entry) => emitted.push(entry) },
    );
    expect(resolved).toEqual({ body: TEMPLATE_BODY, usedComposedBody: false });
    expect(emitted).toEqual([{ metric: 'composed_body_send_check_failed' }]);

    const transmitted: string[] = [];
    const result = await sendClaimedOutboundUnderConsent(
      pool,
      {
        patientId: seeded.patientId,
        outboundMessageId: claimed.id,
        callbackToken: claimed.callbackToken,
        callbackConfig: CALLBACK_CONFIG,
        fromNumber: '+15005550006',
        body: resolved.body,
        expectedMessagingStateVersion: claimed.expectedMessagingStateVersion,
      },
      async (message) => {
        transmitted.push(message.body);
        return { sid: nextTwilioSid() };
      },
    );
    expect(result.sent).toBe(true);
    expect(transmitted).toEqual([TEMPLATE_BODY]);
  });

  it('claims a never-composed row with null composed fields and sends the template', async () => {
    const seeded = await seedPreparedAgentOutbound();
    const claim = await claimPreparedAgentSend(pool, {
      patientId: seeded.patientId,
      agentTurnId: seeded.agentTurnId,
      expectedMessagingStateVersion: seeded.messagingStateVersion,
    });
    const claimed = claim.claimed!;
    expect(claimed.composedBody).toBeNull();
    const resolved = resolveOutboundSendBody({
      body: claimed.body ?? '',
      composedBody: claimed.composedBody,
      composition: claimed.composition,
      messageKind: claimed.messageKind,
    });
    expect(resolved).toEqual({ body: TEMPLATE_BODY, usedComposedBody: false });
  });
});

describe('send-time validator re-run against the persisted composition context', () => {
  it('accepts the untampered composed body via its stored intent + day context', async () => {
    const seeded = await seedPreparedAgentOutbound();
    await checkpointComposedOutbound(pool, checkpointInput(seeded));
    const claim = await claimPreparedAgentSend(pool, {
      patientId: seeded.patientId,
      agentTurnId: seeded.agentTurnId,
      expectedMessagingStateVersion: seeded.messagingStateVersion,
    });
    const claimed = claim.claimed!;
    const resolved = resolveOutboundSendBody(
      {
        body: claimed.body ?? '',
        composedBody: claimed.composedBody,
        composition: claimed.composition,
        messageKind: claimed.messageKind,
      },
      { validate: (sms) => validateStoredCompositionRecord(sms, claimed.composition) },
    );
    expect(resolved).toEqual({ body: COMPOSED_BODY, usedComposedBody: true });
  });

  it('ships the template when a rewritten body carries a freshly recomputed hash', async () => {
    const seeded = await seedPreparedAgentOutbound();
    await checkpointComposedOutbound(pool, checkpointInput(seeded));
    // Attacker rewrites composed_body AND recomputes the co-located digest — the validator
    // re-run on the stored context still refuses the advice text.
    const hostile = 'Take your medication dose again now.';
    const input = checkpointInput(seeded);
    await pool.query(
      `UPDATE outbound_message SET composed_body = $2, composition = $3::jsonb WHERE id = $1`,
      [
        seeded.outboundMessageId,
        hostile,
        JSON.stringify({ ...input.composition, composedBodySha256: sha256Utf8(hostile) }),
      ],
    );
    const claim = await claimPreparedAgentSend(pool, {
      patientId: seeded.patientId,
      agentTurnId: seeded.agentTurnId,
      expectedMessagingStateVersion: seeded.messagingStateVersion,
    });
    const claimed = claim.claimed!;
    const emitted: MetricEntry[] = [];
    const resolved = resolveOutboundSendBody(
      {
        body: claimed.body ?? '',
        composedBody: claimed.composedBody,
        composition: claimed.composition,
        messageKind: claimed.messageKind,
      },
      {
        emit: (entry) => emitted.push(entry),
        validate: (sms) => validateStoredCompositionRecord(sms, claimed.composition),
      },
    );
    expect(resolved).toEqual({ body: TEMPLATE_BODY, usedComposedBody: false });
    expect(emitted).toEqual([{ metric: 'composed_body_send_check_failed' }]);
  });
});

describe("reserveComposerStage — the writer stage's OWN durable one-shot reservation", () => {
  it('reserves once, sets writer_attempted_at + reserved amounts, and never touches interpretation_attempted_at or failure_kind', async () => {
    const seeded = await seedPreparedAgentOutbound();
    const result = await reserveComposerStage(pool, {
      turnJobId: seeded.turnJobId,
      patientId: seeded.patientId,
      reservedInputTokens: 1000,
      reservedOutputTokens: 200,
    });
    expect(result).toEqual({ kind: 'reserved' });
    const row = await pool.query<{
      writer_attempted_at: Date | null;
      writer_reserved_input: number;
      writer_reserved_output: number;
      interpretation_attempted_at: Date | null;
      failure_kind: string | null;
    }>(
      `SELECT writer_attempted_at, writer_reserved_input, writer_reserved_output,
              interpretation_attempted_at, failure_kind
         FROM turn_job WHERE id = $1`,
      [seeded.turnJobId],
    );
    expect(row.rows[0]?.writer_attempted_at).not.toBeNull();
    expect(row.rows[0]?.writer_reserved_input).toBe(1000);
    expect(row.rows[0]?.writer_reserved_output).toBe(200);
    expect(row.rows[0]?.interpretation_attempted_at).toBeNull();
    expect(row.rows[0]?.failure_kind).toBeNull();
  });

  it('is one-shot: a second reservation on the same turn returns already_attempted', async () => {
    const seeded = await seedPreparedAgentOutbound();
    await reserveComposerStage(pool, {
      turnJobId: seeded.turnJobId,
      patientId: seeded.patientId,
      reservedInputTokens: 1000,
      reservedOutputTokens: 200,
    });
    const second = await reserveComposerStage(pool, {
      turnJobId: seeded.turnJobId,
      patientId: seeded.patientId,
      reservedInputTokens: 1000,
      reservedOutputTokens: 200,
    });
    expect(second).toEqual({ kind: 'already_attempted' });
  });

  it("NEVER clobbers a pre-existing failure_kind — the interpretation stage's one-shot evidence trail", async () => {
    const seeded = await seedPreparedAgentOutbound();
    await pool.query(
      `UPDATE turn_job SET interpretation_attempted_at = now(), failure_kind = 'provider_error'
        WHERE id = $1`,
      [seeded.turnJobId],
    );
    const result = await reserveComposerStage(pool, {
      turnJobId: seeded.turnJobId,
      patientId: seeded.patientId,
      reservedInputTokens: 1000,
      reservedOutputTokens: 200,
    });
    expect(result).toEqual({ kind: 'reserved' });
    const row = await pool.query<{
      interpretation_attempted_at: Date | null;
      failure_kind: string | null;
    }>(`SELECT interpretation_attempted_at, failure_kind FROM turn_job WHERE id = $1`, [
      seeded.turnJobId,
    ]);
    expect(row.rows[0]?.failure_kind).toBe('provider_error');
    expect(row.rows[0]?.interpretation_attempted_at).not.toBeNull();
  });

  it("spends the composer's OWN {patientId}:writer-input/-output buckets, never the extractor's", async () => {
    const seeded = await seedPreparedAgentOutbound();
    await reserveComposerStage(pool, {
      turnJobId: seeded.turnJobId,
      patientId: seeded.patientId,
      reservedInputTokens: 1000,
      reservedOutputTokens: 200,
    });
    const bucketKeys = composerBudgetBucketKeys(seeded.patientId);
    const buckets = await pool.query<{ subject_key: string; reserved_units: number }>(
      `SELECT subject_key, reserved_units FROM usage_bucket
        WHERE bucket_scope = 'patient_tokens' AND patient_id = $1
        ORDER BY subject_key`,
      [seeded.patientId],
    );
    const byKey = new Map(buckets.rows.map((row) => [row.subject_key, row.reserved_units]));
    expect(byKey.get(bucketKeys.input)).toBe(1000);
    expect(byKey.get(bucketKeys.output)).toBe(200);
    expect(byKey.has(`${seeded.patientId}:input`)).toBe(false);
    expect(byKey.has(`${seeded.patientId}:output`)).toBe(false);
  });

  it('fails toward budget_exhausted without reserving once the bucket limit would be exceeded', async () => {
    const seeded = await seedPreparedAgentOutbound();
    const result = await reserveComposerStage(pool, {
      turnJobId: seeded.turnJobId,
      patientId: seeded.patientId,
      reservedInputTokens: 999_999,
      reservedOutputTokens: 200,
    });
    expect(result).toEqual({ kind: 'budget_exhausted' });
    const row = await pool.query<{ writer_attempted_at: Date | null }>(
      `SELECT writer_attempted_at FROM turn_job WHERE id = $1`,
      [seeded.turnJobId],
    );
    expect(row.rows[0]?.writer_attempted_at).toBeNull();
  });
});

describe('persistComposerStageUsage — reconciles the reservation down to actual usage', () => {
  it('moves reserved units to consumed and clears the reservation on the turn job', async () => {
    const seeded = await seedPreparedAgentOutbound();
    await reserveComposerStage(pool, {
      turnJobId: seeded.turnJobId,
      patientId: seeded.patientId,
      reservedInputTokens: 1000,
      reservedOutputTokens: 200,
    });
    await persistComposerStageUsage(pool, {
      turnJobId: seeded.turnJobId,
      patientId: seeded.patientId,
      inputTokens: 400,
      outputTokens: 50,
    });
    const bucketKeys = composerBudgetBucketKeys(seeded.patientId);
    const buckets = await pool.query<{
      subject_key: string;
      reserved_units: number;
      consumed_units: number;
    }>(
      `SELECT subject_key, reserved_units, consumed_units FROM usage_bucket
        WHERE bucket_scope = 'patient_tokens' AND patient_id = $1
        ORDER BY subject_key`,
      [seeded.patientId],
    );
    const byKey = new Map(buckets.rows.map((row) => [row.subject_key, row]));
    expect(byKey.get(bucketKeys.input)).toMatchObject({ reserved_units: 0, consumed_units: 400 });
    expect(byKey.get(bucketKeys.output)).toMatchObject({ reserved_units: 0, consumed_units: 50 });
    const jobRow = await pool.query<{
      writer_reserved_input: number;
      writer_reserved_output: number;
    }>(`SELECT writer_reserved_input, writer_reserved_output FROM turn_job WHERE id = $1`, [
      seeded.turnJobId,
    ]);
    expect(jobRow.rows[0]).toEqual({ writer_reserved_input: 0, writer_reserved_output: 0 });
  });
});

describe('productionComposerSeam — the real seam (gateway invoke stubbed, DB-backed reservation/circuit)', () => {
  function fakePreparedRoutine(): PreparedClinicalTurn {
    return {
      commands: [],
      responsePlan: {
        kind: 'routine',
        acknowledgementId: 'acknowledgement-recorded',
        reviewReasons: [],
      },
    } as unknown as PreparedClinicalTurn;
  }

  it('composes successfully: reserves budget, invokes the composition stage, and settles usage', async () => {
    const seeded = await seedPreparedAgentOutbound();
    const seam = productionComposerSeam({
      database: pool,
      invokeGateway: async (request): Promise<ConversationGatewayResponse> => {
        expect(request.stage).toBe('composition');
        return {
          ok: true,
          requestId: request.requestId,
          stage: 'composition',
          result: {
            composedBody: 'Got it, thanks for the update.',
            inputHash: 'd'.repeat(64),
            attempts: [],
          },
          usage: { inputTokens: 120, outputTokens: 30 },
          metadata: {
            modelId: 'stub-model',
            promptVersion: 'clinical-composer-v1',
            promptSha256: 'e'.repeat(64),
            latencyMs: 5,
          },
        };
      },
    });
    const outcome = await seam.compose({
      outboundMessageId: seeded.outboundMessageId,
      patientId: seeded.patientId,
      agentTurnId: seeded.agentTurnId,
      turnJobId: seeded.turnJobId,
      prepared: fakePreparedRoutine(),
      medicationNames: [['Metformin']],
      dayContext: STORED_DAY_CONTEXT,
    });
    expect(outcome.kind).toBe('composed');
    if (outcome.kind !== 'composed') throw new Error('expected a composed outcome');
    expect(outcome.draft.sms).toBe('Got it, thanks for the update.');

    const jobRow = await pool.query<{
      writer_attempted_at: Date | null;
      writer_reserved_input: number;
    }>(`SELECT writer_attempted_at, writer_reserved_input FROM turn_job WHERE id = $1`, [
      seeded.turnJobId,
    ]);
    expect(jobRow.rows[0]?.writer_attempted_at).not.toBeNull();
    // Settled to 0 once persistComposerStageUsage reconciled the actual reported usage.
    expect(jobRow.rows[0]?.writer_reserved_input).toBe(0);
  });

  it('falls back on a gateway failure and never touches failure_kind', async () => {
    const seeded = await seedPreparedAgentOutbound();
    const seam = productionComposerSeam({
      database: pool,
      invokeGateway: async (request): Promise<ConversationGatewayResponse> => ({
        ok: false,
        requestId: request.requestId,
        stage: 'composition',
        failureKind: 'malformed',
        fallbackReason: 'ungrounded_entity',
        inputHash: 'd'.repeat(64),
        attempts: [],
        usage: null,
        metadata: {
          modelId: 'stub-model',
          promptVersion: 'clinical-composer-v1',
          promptSha256: 'e'.repeat(64),
          latencyMs: 5,
        },
      }),
    });
    const outcome = await seam.compose({
      outboundMessageId: seeded.outboundMessageId,
      patientId: seeded.patientId,
      agentTurnId: seeded.agentTurnId,
      turnJobId: seeded.turnJobId,
      prepared: fakePreparedRoutine(),
      medicationNames: [],
      dayContext: STORED_DAY_CONTEXT,
    });
    expect(outcome).toEqual({
      kind: 'fallback',
      reason: 'ungrounded_entity',
      inputHash: 'd'.repeat(64),
      attempts: [],
    });
    const jobRow = await pool.query<{ failure_kind: string | null }>(
      `SELECT failure_kind FROM turn_job WHERE id = $1`,
      [seeded.turnJobId],
    );
    expect(jobRow.rows[0]?.failure_kind).toBeNull();
  });
});

/**
 * Live incident (2026-08-17): the composition stage leaked its reservation exactly like the
 * interpretation stage — units came back ONLY via persistComposerStageUsage on the success
 * path, so a stuck 8,000/1,024 writer pair was observed alongside the interpretation leak.
 * Every post-reserve exit must settle.
 */
describe('composition reservation — every post-reserve failure settles', () => {
  function fakeRoutine(): PreparedClinicalTurn {
    return {
      commands: [],
      responsePlan: {
        kind: 'routine',
        acknowledgementId: 'acknowledgement-recorded',
        reviewReasons: [],
      },
    } as unknown as PreparedClinicalTurn;
  }

  const composeRequest = (seeded: SeededOutbound) => ({
    outboundMessageId: seeded.outboundMessageId,
    patientId: seeded.patientId,
    agentTurnId: seeded.agentTurnId,
    turnJobId: seeded.turnJobId,
    prepared: fakeRoutine(),
    medicationNames: [],
    dayContext: STORED_DAY_CONTEXT,
  });

  async function writerUnits(patientId: string) {
    const keys = composerBudgetBucketKeys(patientId);
    const rows = await pool.query<{
      subject_key: string;
      reserved_units: number;
      consumed_units: number;
    }>(
      `SELECT subject_key, reserved_units, consumed_units FROM usage_bucket
        WHERE bucket_scope = 'patient_tokens' AND patient_id = $1
          AND subject_key = ANY($2::text[])`,
      [patientId, [keys.input, keys.output]],
    );
    const byKey = new Map(rows.rows.map((row) => [row.subject_key, row]));
    return { input: byKey.get(keys.input)!, output: byKey.get(keys.output)! };
  }

  async function writerJobRow(turnJobId: string) {
    const row = await pool.query<{
      writer_attempted_at: Date | null;
      writer_reserved_input: number;
      writer_reserved_output: number;
    }>(
      `SELECT writer_attempted_at, writer_reserved_input, writer_reserved_output
         FROM turn_job WHERE id = $1`,
      [turnJobId],
    );
    return row.rows[0]!;
  }

  it('settles the reservation against the reported usage when the composition is rejected', async () => {
    const seeded = await seedPreparedAgentOutbound();
    const seam = productionComposerSeam({
      database: pool,
      invokeGateway: async (request): Promise<ConversationGatewayResponse> => ({
        ok: false,
        requestId: request.requestId,
        stage: 'composition',
        failureKind: 'malformed',
        fallbackReason: 'ungrounded_entity',
        inputHash: 'd'.repeat(64),
        attempts: [],
        usage: { inputTokens: 700, outputTokens: 90 },
        metadata: {
          modelId: 'stub-model',
          promptVersion: 'clinical-composer-v1',
          promptSha256: 'e'.repeat(64),
          latencyMs: 5,
        },
      }),
    });
    expect((await seam.compose(composeRequest(seeded))).kind).toBe('fallback');

    const units = await writerUnits(seeded.patientId);
    expect(units.input).toMatchObject({ reserved_units: 0, consumed_units: 700 });
    expect(units.output).toMatchObject({ reserved_units: 0, consumed_units: 90 });
    // The one-shot writer attempt marker survives the credit-back.
    const job = await writerJobRow(seeded.turnJobId);
    expect(job.writer_attempted_at).not.toBeNull();
    expect(job.writer_reserved_input).toBe(0);
    expect(job.writer_reserved_output).toBe(0);
  });

  it('settles the whole reservation when the composition transport throws', async () => {
    const seeded = await seedPreparedAgentOutbound();
    const seam = productionComposerSeam({
      database: pool,
      invokeGateway: async () => {
        throw new Error('composition transport lost');
      },
    });
    expect(await seam.compose(composeRequest(seeded))).toMatchObject({
      kind: 'fallback',
      reason: 'transient',
    });
    const units = await writerUnits(seeded.patientId);
    expect(units.input).toMatchObject({ reserved_units: 0, consumed_units: 0 });
    expect(units.output).toMatchObject({ reserved_units: 0, consumed_units: 0 });
    expect((await writerJobRow(seeded.turnJobId)).writer_attempted_at).not.toBeNull();
  });

  it('settles the reservation before a stage-contract breach propagates', async () => {
    const seeded = await seedPreparedAgentOutbound();
    const seam = productionComposerSeam({
      database: pool,
      invokeGateway: async (request): Promise<ConversationGatewayResponse> => ({
        ok: false,
        requestId: request.requestId,
        stage: 'interpretation',
        failureKind: 'malformed',
        usage: null,
        metadata: {
          modelId: 'stub-model',
          promptVersion: 'clinical-extractor-v1',
          schemaSha256: 'e'.repeat(64),
          latencyMs: 5,
        },
      }),
    });
    await expect(seam.compose(composeRequest(seeded))).rejects.toThrow();
    const units = await writerUnits(seeded.patientId);
    expect(units.input).toMatchObject({ reserved_units: 0 });
    expect(units.output).toMatchObject({ reserved_units: 0 });
  });

  it('leaves a settled turn replay-safe: a second compose is already_attempted, never re-invoked', async () => {
    const seeded = await seedPreparedAgentOutbound();
    let invocations = 0;
    const seam = productionComposerSeam({
      database: pool,
      invokeGateway: async (request): Promise<ConversationGatewayResponse> => {
        invocations += 1;
        return {
          ok: false,
          requestId: request.requestId,
          stage: 'composition',
          failureKind: 'malformed',
          fallbackReason: 'ungrounded_entity',
          inputHash: 'd'.repeat(64),
          attempts: [],
          usage: null,
          metadata: {
            modelId: 'stub-model',
            promptVersion: 'clinical-composer-v1',
            promptSha256: 'e'.repeat(64),
            latencyMs: 5,
          },
        };
      },
    });
    await seam.compose(composeRequest(seeded));
    expect(await seam.compose(composeRequest(seeded))).toMatchObject({
      kind: 'fallback',
      reason: 'already_attempted',
    });
    expect(invocations).toBe(1);
  });
});
