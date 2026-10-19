import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConversationGatewayRequest } from './gateway-contract.js';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** These transports only ever see the interpretation stage of the gateway request union. */
type InterpretationGatewayRequest = Extract<
  ConversationGatewayRequest,
  { readonly stage: 'interpretation' }
>;

const { lambdaSend } = vi.hoisted(() => ({ lambdaSend: vi.fn() }));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn(function () {
    return { send: lambdaSend };
  }),
  InvokeCommand: vi.fn(function (input: unknown) {
    return { input };
  }),
}));

import { CLINICAL_EXTRACTOR_SCHEMA_SHA256 } from './clinical-memory/anthropic-extractor.js';
import { translateHistoricalClinicalMemory } from './clinical-memory/historical-translation.js';
import { COMPOSER_DISABLE_ENV } from './compose-plumbing.js';
import { processConversationJob } from './turn-processor.js';

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema-init', 'schema.sql'), 'utf8');
const CONTAINER_TIMEOUT_MS = 180_000;
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GATEWAY_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:gateway';
const OUTBOUND_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:outbound';

let container: StartedPostgreSqlContainer | undefined;
let pool: Pool;
let phoneCounter = 0;

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type SeededTurn = { readonly patientId: string; readonly inboundMessageId: string };

async function appendTurn(
  patientId: string,
  inboundSequence: number,
  rawBody = 'My headache is back.',
): Promise<SeededTurn> {
  const inbound = await pool.query<{ id: string }>(
    `INSERT INTO inbound_reply
       (patient_id, raw_body, received_at, inbound_sequence, enqueued_at)
     VALUES ($1, $2, '2026-08-11T13:00:00Z', $3, now())
     RETURNING id::text`,
    [patientId, rawBody, inboundSequence],
  );
  const inboundMessageId = inbound.rows[0]!.id;
  await pool.query(
    `INSERT INTO turn_job
       (patient_id, inbound_message_id, inbound_sequence, messaging_state_version)
     SELECT $1, $2, $3, messaging_state_version FROM patient WHERE id = $1`,
    [patientId, inboundMessageId, inboundSequence],
  );
  return { patientId, inboundMessageId };
}

async function seedTurn(
  options: { readonly inboundSequence?: number; readonly rawBody?: string } = {},
): Promise<SeededTurn> {
  phoneCounter += 1;
  const patient = await pool.query<{ id: string }>(
    `INSERT INTO patient (phone, medication_name, owner_clinician_sub, timezone)
     VALUES ($1, 'test medication', $2, 'America/Toronto') RETURNING id::text`,
    [`+1500888${String(phoneCounter).padStart(4, '0')}`, OWNER_ID],
  );
  return appendTurn(
    patient.rows[0]!.id,
    options.inboundSequence ?? 1,
    options.rawBody ?? 'My headache is back.',
  );
}

function commandInput(command: unknown): {
  readonly FunctionName: string;
  readonly Payload: Uint8Array;
} {
  return (command as { input: { FunctionName: string; Payload: Uint8Array } }).input;
}

function boundedGatewayResponse(request: InterpretationGatewayRequest) {
  return {
    ok: true,
    requestId: request.requestId,
    stage: 'interpretation',
    result: {
      claims: [
        {
          sourceMessageId: request.input.currentMessage.id,
          informationNeedId: null,
          claim: {
            slot: 'claim_1',
            kind: 'symptom',
            quote: 'headache',
            polarity: 'positive',
            experiencer: 'patient',
            status: 'current',
            certainty: 'certain',
            symptomText: 'headache',
          },
        },
      ],
    },
    usage: { inputTokens: 40, outputTokens: 15 },
    metadata: {
      modelId: 'claude-sonnet-5',
      promptVersion: request.input.promptVersion,
      schemaSha256: CLINICAL_EXTRACTOR_SCHEMA_SHA256,
      latencyMs: 10,
    },
  };
}

function installLambdaTransport(
  options: {
    readonly loseGatewayResponse?: boolean;
    /** The gateway answered cleanly with a typed failure — the live 2026-08-17 shape. */
    readonly gatewayFailure?: {
      readonly failureKind: 'malformed' | 'transient';
      readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
    };
    readonly loseOutboundResponse?: boolean;
    readonly rejectOutboundBeforeAcceptance?: boolean;
  } = {},
): void {
  lambdaSend.mockImplementation(async (command: unknown) => {
    const input = commandInput(command);
    if (input.FunctionName === GATEWAY_ARN) {
      const request = JSON.parse(
        new TextDecoder().decode(input.Payload),
      ) as InterpretationGatewayRequest;
      if (options.loseGatewayResponse) throw new Error('gateway response lost after dispatch');
      const response =
        options.gatewayFailure === undefined
          ? boundedGatewayResponse(request)
          : {
              ok: false,
              requestId: request.requestId,
              stage: 'interpretation',
              failureKind: options.gatewayFailure.failureKind,
              usage: options.gatewayFailure.usage,
              metadata: {
                modelId: 'claude-sonnet-5',
                promptVersion: request.input.promptVersion,
                schemaSha256: CLINICAL_EXTRACTOR_SCHEMA_SHA256,
                latencyMs: 10,
              },
            };
      return { Payload: new TextEncoder().encode(JSON.stringify(response)) };
    }
    const outbound = JSON.parse(new TextDecoder().decode(input.Payload)) as {
      patientId: string;
      agentTurnId: string;
      expectedMessagingStateVersion: number;
    };
    expect(outbound.expectedMessagingStateVersion).toBeGreaterThan(0);
    if (options.rejectOutboundBeforeAcceptance) throw new Error('outbound dispatch failed');
    const fakeSid = `SM${outbound.agentTurnId.replaceAll('-', '')}`;
    await pool.query(
      `UPDATE outbound_message
          SET status = $3, twilio_sid = $4
        WHERE patient_id = $1 AND agent_turn_id = $2`,
      [
        outbound.patientId,
        outbound.agentTurnId,
        options.loseOutboundResponse ? 'sending_unknown' : 'queued',
        fakeSid,
      ],
    );
    if (options.loseOutboundResponse) throw new Error('outbound response lost after acceptance');
    return {
      Payload: new TextEncoder().encode(JSON.stringify({ sent: true, sid: fakeSid })),
    };
  });
}

function callsFor(functionArn: string): number {
  return lambdaSend.mock.calls.filter(
    ([command]) => commandInput(command).FunctionName === functionArn,
  ).length;
}

async function loadFifoState(patientId: string, inboundMessageId: string) {
  const state = await pool.query<{
    clinical_memory_version: number;
    interpretation_attempted: boolean;
    interpretation_result: unknown | null;
    interpretation_reserved_input: number;
    interpretation_reserved_output: number;
    failure_kind: string | null;
    completed_at: Date | null;
    usage_count: number;
    clinical_event_count: number;
    review_item_count: number;
    agent_turn_count: number;
    outbound_count: number;
  }>(
    `SELECT p.clinical_memory_version::int,
            (tj.interpretation_attempted_at IS NOT NULL) AS interpretation_attempted,
            tj.interpretation_result,
            tj.interpretation_reserved_input,
            tj.interpretation_reserved_output,
            tj.failure_kind,
            tj.completed_at,
            (SELECT count(*)::int FROM usage_bucket item
              WHERE item.patient_id = p.id) AS usage_count,
            (SELECT count(*)::int FROM clinical_event item
              WHERE item.patient_id = p.id) AS clinical_event_count,
            (SELECT count(*)::int FROM clinical_review_item item
              WHERE item.patient_id = p.id) AS review_item_count,
            (SELECT count(*)::int FROM agent_turn item
              WHERE item.patient_id = p.id) AS agent_turn_count,
            (SELECT count(*)::int FROM outbound_message item
              WHERE item.patient_id = p.id) AS outbound_count
       FROM patient p
       JOIN turn_job tj
         ON tj.patient_id = p.id AND tj.inbound_message_id = $2
      WHERE p.id = $1`,
    [patientId, inboundMessageId],
  );
  return state.rows[0]!;
}

async function waitUntilBlocking(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_stat_activity activity
          WHERE $1 = ANY(pg_blocking_pids(activity.pid))
       ) AS blocked`,
      [pid],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('expected the provider circuit lock to pause the processor');
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
  process.env.LLM_GATEWAY_FN_ARN = GATEWAY_ARN;
  process.env.OUTBOUND_FN_ARN = OUTBOUND_ARN;
  // ACTIVATION: this suite exercises the interpretation stage's durability (checkpointing,
  // circuit breaker, FIFO ordering) — the composer is a separately-tested concern
  // (compose-plumbing.db.test.ts, turn-processor.compose.test.ts) and its kill switch is the
  // documented opt-out, so disable it here rather than teaching this fake Lambda transport
  // about the composition stage too.
  process.env[COMPOSER_DISABLE_ENV] = 'true';
}, CONTAINER_TIMEOUT_MS);

beforeEach(() => {
  lambdaSend.mockReset();
});

afterAll(async () => {
  delete process.env[COMPOSER_DISABLE_ENV];
  await pool?.end();
  await container?.stop();
});

describe('production conversation processor against PostgreSQL 16', () => {
  it('blocks a later eligible job before reservation until the lower unfinished job completes', async () => {
    const first = await seedTurn();
    const later = await appendTurn(first.patientId, 2);
    installLambdaTransport();
    try {
      const outcome = await processConversationJob(later.inboundMessageId, pool).then(
        () => 'resolved',
        (error: unknown) => String(error),
      );
      expect({
        outcome,
        gateway_calls: callsFor(GATEWAY_ARN),
        outbound_calls: callsFor(OUTBOUND_ARN),
        ...(await loadFifoState(later.patientId, later.inboundMessageId)),
      }).toEqual({
        outcome: 'Error: conversation_job_not_lowest_unfinished',
        gateway_calls: 0,
        outbound_calls: 0,
        clinical_memory_version: 0,
        interpretation_attempted: false,
        interpretation_result: null,
        interpretation_reserved_input: 0,
        interpretation_reserved_output: 0,
        failure_kind: null,
        completed_at: null,
        usage_count: 0,
        clinical_event_count: 0,
        review_item_count: 0,
        agent_turn_count: 0,
        outbound_count: 0,
      });

      await processConversationJob(first.inboundMessageId, pool);
      await pool.query(
        `UPDATE turn_job
            SET completed_at = now()
          WHERE patient_id = $1 AND inbound_message_id = $2`,
        [first.patientId, first.inboundMessageId],
      );
      await processConversationJob(later.inboundMessageId, pool);

      expect(callsFor(GATEWAY_ARN)).toBe(2);
      // Wave 1a chat-style batching: the lower job saw the newer inbound at turn start, so it
      // committed record-only (reply terminal from birth) — only the surviving turn sends.
      expect(callsFor(OUTBOUND_ARN)).toBe(1);
      expect(await loadFifoState(later.patientId, later.inboundMessageId)).toMatchObject({
        clinical_memory_version: 2,
        interpretation_attempted: true,
        interpretation_result: expect.any(Object),
        completed_at: null,
        agent_turn_count: 2,
        outbound_count: 2,
      });
    } finally {
      await pool.query('DELETE FROM patient WHERE id = $1', [first.patientId]);
    }
  });

  it('blocks a later deterministic emergency from committing while a lower job is unfinished', async () => {
    const first = await seedTurn();
    const later = await appendTurn(first.patientId, 2, "I can't breathe.");
    installLambdaTransport();
    try {
      const outcome = await processConversationJob(later.inboundMessageId, pool).then(
        () => 'resolved',
        (error: unknown) => String(error),
      );
      expect({
        outcome,
        gateway_calls: callsFor(GATEWAY_ARN),
        outbound_calls: callsFor(OUTBOUND_ARN),
        ...(await loadFifoState(later.patientId, later.inboundMessageId)),
      }).toEqual({
        outcome: 'Error: conversation_job_not_lowest_unfinished',
        gateway_calls: 0,
        outbound_calls: 0,
        clinical_memory_version: 0,
        interpretation_attempted: false,
        interpretation_result: null,
        interpretation_reserved_input: 0,
        interpretation_reserved_output: 0,
        failure_kind: null,
        completed_at: null,
        usage_count: 0,
        clinical_event_count: 0,
        review_item_count: 0,
        agent_turn_count: 0,
        outbound_count: 0,
      });
    } finally {
      await pool.query('DELETE FROM patient WHERE id = $1', [first.patientId]);
    }
  });

  it('allows the lowest stored unfinished job when earlier sequence numbers are absent', async () => {
    const turn = await seedTurn({ inboundSequence: 7 });
    installLambdaTransport();
    try {
      await processConversationJob(turn.inboundMessageId, pool);

      expect(callsFor(GATEWAY_ARN)).toBe(1);
      expect(callsFor(OUTBOUND_ARN)).toBe(1);
      expect(await loadFifoState(turn.patientId, turn.inboundMessageId)).toMatchObject({
        clinical_memory_version: 1,
        interpretation_attempted: true,
        interpretation_result: expect.any(Object),
        completed_at: null,
        agent_turn_count: 1,
        outbound_count: 1,
      });
    } finally {
      await pool.query('DELETE FROM patient WHERE id = $1', [turn.patientId]);
    }
  });

  it('persists a bounded extraction through one prepared clinical batch before outbound', async () => {
    const turn = await seedTurn();
    installLambdaTransport();

    await processConversationJob(turn.inboundMessageId, pool);

    expect(callsFor(GATEWAY_ARN)).toBe(1);
    expect(callsFor(OUTBOUND_ARN)).toBe(1);
    const state = await pool.query<{
      interpretation_result: {
        readonly output?: { readonly claims?: readonly unknown[] };
      } | null;
      prepared_command_batch: readonly unknown[] | null;
      prepared_batch_hash: string | null;
      body: string;
      status: string;
    }>(
      `SELECT tj.interpretation_result, at.prepared_command_batch,
              at.prepared_batch_hash, om.body, om.status
         FROM turn_job tj
         JOIN agent_turn at
           ON at.patient_id = tj.patient_id AND at.inbound_message_id = tj.inbound_message_id
         JOIN outbound_message om
           ON om.patient_id = at.patient_id AND om.agent_turn_id = at.id
        WHERE tj.patient_id = $1 AND tj.inbound_message_id = $2`,
      [turn.patientId, turn.inboundMessageId],
    );
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.interpretation_result?.output?.claims).toHaveLength(1);
    expect(state.rows[0]?.prepared_command_batch).toEqual(expect.any(Array));
    expect(state.rows[0]?.prepared_batch_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(state.rows[0]).toMatchObject({
      body: 'I’ve noted your update. For headache, what number from 1 to 10 best describes the symptom’s intensity?',
      status: 'queued',
    });
    await pool.query('DELETE FROM patient WHERE id = $1', [turn.patientId]);
  });

  it('persists only interpretation and sends one deterministic outbound, then replays without another call', async () => {
    const turn = await seedTurn();
    installLambdaTransport();

    await processConversationJob(turn.inboundMessageId, pool);
    await processConversationJob(turn.inboundMessageId, pool);

    expect(callsFor(GATEWAY_ARN)).toBe(1);
    expect(callsFor(OUTBOUND_ARN)).toBe(1);
    const state = await pool.query<{
      interpretation_result: unknown;
      writer_result: unknown | null;
      failure_kind: string | null;
      message_kind: string;
      outbound_status: string;
      turns: number;
    }>(
      `SELECT tj.interpretation_result, tj.writer_result, tj.failure_kind,
              om.message_kind, om.status AS outbound_status,
              (SELECT count(*)::int FROM agent_turn WHERE inbound_message_id = $2) AS turns
         FROM turn_job tj
         JOIN outbound_message om ON om.in_reply_to_inbound_id = tj.inbound_message_id
        WHERE tj.inbound_message_id = $2 AND tj.patient_id = $1`,
      [turn.patientId, turn.inboundMessageId],
    );
    expect(state.rows[0]).toMatchObject({
      interpretation_result: expect.any(Object),
      writer_result: null,
      failure_kind: null,
      message_kind: 'clarification',
      outbound_status: 'queued',
      turns: 1,
    });
    await pool.query('DELETE FROM patient WHERE id = $1', [turn.patientId]);
  });

  it('reuses the checkpoint and prepared hash after a crash before the first clinical write', async () => {
    const turn = await seedTurn();
    installLambdaTransport();
    await pool.query(`CREATE OR REPLACE FUNCTION test_crash_after_checkpoint()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'crash_after_checkpoint:%', NEW.prepared_batch_hash;
      END;
    $$`);
    await pool.query(`CREATE TRIGGER test_crash_after_checkpoint
      BEFORE INSERT ON agent_turn
      FOR EACH ROW EXECUTE FUNCTION test_crash_after_checkpoint()`);

    try {
      const firstError = await processConversationJob(turn.inboundMessageId, pool).then(
        () => null,
        (error: unknown) => error,
      );
      const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
      const firstHash = /crash_after_checkpoint:([a-f0-9]{64})/u.exec(firstMessage)?.[1];
      expect(firstHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(callsFor(GATEWAY_ARN)).toBe(1);
      expect(callsFor(OUTBOUND_ARN)).toBe(0);
      const afterCrash = await pool.query<{
        clinical_memory_version: number;
        interpretation_attempted: boolean;
        interpretation_result: unknown;
        interpretation_reserved_input: number;
        interpretation_reserved_output: number;
        completed_at: Date | null;
        usage_count: number;
        agent_turn_count: number;
        clinical_event_count: number;
        information_need_count: number;
        review_item_count: number;
        outbound_count: number;
      }>(
        `SELECT p.clinical_memory_version::int,
                (tj.interpretation_attempted_at IS NOT NULL) AS interpretation_attempted,
                tj.interpretation_result,
                tj.interpretation_reserved_input,
                tj.interpretation_reserved_output,
                tj.completed_at,
                (SELECT count(*)::int FROM usage_bucket item
                  WHERE item.patient_id = p.id) AS usage_count,
                (SELECT count(*)::int FROM agent_turn item
                  WHERE item.patient_id = p.id) AS agent_turn_count,
                (SELECT count(*)::int FROM clinical_event item
                  WHERE item.patient_id = p.id) AS clinical_event_count,
                (SELECT count(*)::int FROM information_need item
                  WHERE item.patient_id = p.id) AS information_need_count,
                (SELECT count(*)::int FROM clinical_review_item item
                  WHERE item.patient_id = p.id) AS review_item_count,
                (SELECT count(*)::int FROM outbound_message item
                  WHERE item.patient_id = p.id) AS outbound_count
           FROM patient p
           JOIN turn_job tj
             ON tj.patient_id = p.id AND tj.inbound_message_id = $2
          WHERE p.id = $1`,
        [turn.patientId, turn.inboundMessageId],
      );
      const checkpoint = afterCrash.rows[0]!.interpretation_result;
      const checkpointJson = JSON.stringify(checkpoint);
      expect(afterCrash.rows).toEqual([
        {
          clinical_memory_version: 0,
          interpretation_attempted: true,
          interpretation_result: expect.any(Object),
          // Right-sized (2026-08-17): one provider call's worth, not the six-call retry ceiling.
          interpretation_reserved_input: 12_000,
          interpretation_reserved_output: 4_096,
          completed_at: null,
          usage_count: 2,
          agent_turn_count: 0,
          clinical_event_count: 0,
          information_need_count: 0,
          review_item_count: 0,
          outbound_count: 0,
        },
      ]);

      await pool.query('DROP TRIGGER test_crash_after_checkpoint ON agent_turn');
      await processConversationJob(turn.inboundMessageId, pool);

      expect(callsFor(GATEWAY_ARN)).toBe(1);
      expect(callsFor(OUTBOUND_ARN)).toBe(1);
      const afterRetry = await pool.query<{
        clinical_memory_version: number;
        interpretation_result: unknown;
        completed_at: Date | null;
        usage_count: number;
        agent_turn_count: number;
        clinical_event_count: number;
        information_need_count: number;
        review_item_count: number;
        outbound_count: number;
        prepared_batch_hash: string;
      }>(
        `SELECT p.clinical_memory_version::int,
                tj.interpretation_result,
                tj.completed_at,
                (SELECT count(*)::int FROM usage_bucket item
                  WHERE item.patient_id = p.id) AS usage_count,
                (SELECT count(*)::int FROM agent_turn item
                  WHERE item.patient_id = p.id) AS agent_turn_count,
                (SELECT count(*)::int FROM clinical_event item
                  WHERE item.patient_id = p.id) AS clinical_event_count,
                (SELECT count(*)::int FROM information_need item
                  WHERE item.patient_id = p.id) AS information_need_count,
                (SELECT count(*)::int FROM clinical_review_item item
                  WHERE item.patient_id = p.id) AS review_item_count,
                (SELECT count(*)::int FROM outbound_message item
                  WHERE item.patient_id = p.id) AS outbound_count,
                turn_record.prepared_batch_hash
           FROM patient p
           JOIN turn_job tj
             ON tj.patient_id = p.id AND tj.inbound_message_id = $2
           JOIN agent_turn turn_record
             ON turn_record.patient_id = p.id AND turn_record.inbound_message_id = $2
          WHERE p.id = $1`,
        [turn.patientId, turn.inboundMessageId],
      );
      expect(afterRetry.rows).toEqual([
        {
          clinical_memory_version: 1,
          interpretation_result: checkpoint,
          completed_at: null,
          usage_count: 2,
          agent_turn_count: 1,
          clinical_event_count: 1,
          // Owner decision C: the context battery ships ON, so one identified symptom event
          // opens severity plus the top three context fields — the 4-per-episode cap exactly.
          information_need_count: 4,
          review_item_count: 0,
          outbound_count: 1,
          prepared_batch_hash: firstHash,
        },
      ]);
      expect(JSON.stringify(afterRetry.rows[0]!.interpretation_result)).toBe(checkpointJson);
    } finally {
      await pool
        .query('DROP TRIGGER IF EXISTS test_crash_after_checkpoint ON agent_turn')
        .catch(() => undefined);
      await pool.query('DROP FUNCTION IF EXISTS test_crash_after_checkpoint()');
      await pool.query('DELETE FROM patient WHERE id = $1', [turn.patientId]);
    }
  });

  it('does not recall the model after a gateway response is lost', async () => {
    const turn = await seedTurn();
    installLambdaTransport({ loseGatewayResponse: true });

    await processConversationJob(turn.inboundMessageId, pool);
    await processConversationJob(turn.inboundMessageId, pool);

    expect(callsFor(GATEWAY_ARN)).toBe(1);
    expect(callsFor(OUTBOUND_ARN)).toBe(1);
    const state = await pool.query<{
      failure_kind: string;
      interpretation_result: unknown | null;
      completed_at: Date | null;
      failure_class: string;
      prepared_command_batch: readonly unknown[];
      prepared_response_plan: unknown;
      body: string;
      status: string;
      agent_turn_count: number;
      clinical_event_count: number;
      review_item_count: number;
      outbound_count: number;
    }>(
      `SELECT tj.failure_kind, tj.interpretation_result, tj.completed_at,
              at.failure_class, at.prepared_command_batch, at.prepared_response_plan,
              om.body, om.status,
              (SELECT count(*)::int FROM agent_turn item
                WHERE item.patient_id = tj.patient_id) AS agent_turn_count,
              (SELECT count(*)::int FROM clinical_event item
                WHERE item.patient_id = tj.patient_id) AS clinical_event_count,
              (SELECT count(*)::int FROM clinical_review_item item
                WHERE item.patient_id = tj.patient_id) AS review_item_count,
              (SELECT count(*)::int FROM outbound_message item
                WHERE item.patient_id = tj.patient_id) AS outbound_count
         FROM turn_job tj
         JOIN agent_turn at
           ON at.patient_id = tj.patient_id AND at.inbound_message_id = tj.inbound_message_id
         JOIN outbound_message om ON om.in_reply_to_inbound_id = tj.inbound_message_id
        WHERE tj.inbound_message_id = $1`,
      [turn.inboundMessageId],
    );
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({
      failure_kind: 'ambiguous_outcome',
      interpretation_result: null,
      completed_at: null,
      failure_class: 'ambiguous_outcome',
      prepared_response_plan: {
        kind: 'human_review',
        reviewReasons: ['ambiguous_outcome'],
      },
      body: 'Thanks. I saved this update for your doctor to review.',
      status: 'queued',
      agent_turn_count: 1,
      clinical_event_count: 0,
      review_item_count: 1,
      outbound_count: 1,
    });
    expect(state.rows[0]?.prepared_command_batch).toEqual([
      expect.objectContaining({
        kind: 'PreserveUnresolvedContent',
        reason: 'ambiguous_outcome',
        sourceMessageId: turn.inboundMessageId,
        sourceSpans: [
          {
            messageId: turn.inboundMessageId,
            start: 0,
            end: 'My headache is back.'.length,
            quote: 'My headache is back.',
          },
        ],
      }),
    ]);
    await pool.query('DELETE FROM patient WHERE id = $1', [turn.patientId]);
  });

  /**
   * THE 2026-08-17 LIVE INCIDENT, end to end. A patient turn whose extraction terminally failed
   * (gateway ok:false malformed_output) leaked its whole token reservation, so every later turn
   * that day went budget_exhausted: the agent answered a direct patient question ("What do you
   * want to know what was your question") with "Thanks. I saved this update for your doctor to
   * review." and stayed dead until midnight.
   */
  it('returns a terminally failed turn reservation so the next message is still answered', async () => {
    const turn = await seedTurn();
    installLambdaTransport({
      gatewayFailure: {
        failureKind: 'malformed',
        usage: { inputTokens: 3_100, outputTokens: 620 },
      },
    });
    await processConversationJob(turn.inboundMessageId, pool);

    const failed = await loadFifoState(turn.patientId, turn.inboundMessageId);
    expect(failed).toMatchObject({
      failure_kind: 'malformed_output',
      interpretation_attempted: true,
      interpretation_result: null,
      // The units are back; the one-shot attempt marker above is untouched.
      interpretation_reserved_input: 0,
      interpretation_reserved_output: 0,
    });
    const outputKey = `${turn.patientId}:output`;
    const settled = await pool.query<{ reserved_units: number; consumed_units: number }>(
      `SELECT reserved_units, consumed_units FROM usage_bucket
        WHERE bucket_scope = 'patient_tokens' AND patient_id = $1 AND subject_key = $2`,
      [turn.patientId, outputKey],
    );
    expect(settled.rows[0]).toMatchObject({ reserved_units: 0, consumed_units: 620 });

    // Spend the day down to exactly one remaining reservation. With the leak the second turn
    // could not reserve at all and shipped the human-review template instead of a real reply.
    await pool.query(
      `UPDATE usage_bucket SET consumed_units = limit_units - 4096 - 1
        WHERE bucket_scope = 'patient_tokens' AND patient_id = $1 AND subject_key = $2`,
      [turn.patientId, outputKey],
    );
    // The FIFO worker completes a failed turn before draining the next one.
    await pool.query(`UPDATE turn_job SET completed_at = now() WHERE inbound_message_id = $1`, [
      turn.inboundMessageId,
    ]);

    const next = await appendTurn(turn.patientId, 2, 'It is much better now, thanks.');
    installLambdaTransport();
    await processConversationJob(next.inboundMessageId, pool);

    // The discriminator: with the leak this turn never reached the model at all — it recorded
    // failure_kind 'budget_exhausted' with a null result. (Its reply is still the review
    // template here, but for an unrelated reason: the failed turn above left unresolved content
    // the doctor owes a look at. What matters is that the message was actually interpreted.)
    const answered = await loadFifoState(turn.patientId, next.inboundMessageId);
    expect(answered.failure_kind).toBeNull();
    expect(answered.interpretation_result).not.toBeNull();
    // One dispatch for the failed turn, one for the turn it used to starve.
    expect(callsFor(GATEWAY_ARN)).toBe(2);
    await pool.query('DELETE FROM patient WHERE id = $1', [turn.patientId]);
  });

  it('does not invoke outbound twice after acceptance when its response is lost', async () => {
    const turn = await seedTurn();
    installLambdaTransport({ loseOutboundResponse: true });

    await expect(processConversationJob(turn.inboundMessageId, pool)).rejects.toThrow(
      /outbound response lost/,
    );
    await processConversationJob(turn.inboundMessageId, pool);

    expect(callsFor(GATEWAY_ARN)).toBe(1);
    expect(callsFor(OUTBOUND_ARN)).toBe(1);
    const outbound = await pool.query<{ status: string }>(
      `SELECT status FROM outbound_message WHERE in_reply_to_inbound_id = $1`,
      [turn.inboundMessageId],
    );
    expect(outbound.rows[0]?.status).toBe('sending_unknown');
    await pool.query('DELETE FROM patient WHERE id = $1', [turn.patientId]);
  });

  it('terminalizes a prepared retry after STOP changes both flags and the consent epoch', async () => {
    const turn = await seedTurn();
    installLambdaTransport({ rejectOutboundBeforeAcceptance: true });

    await expect(processConversationJob(turn.inboundMessageId, pool)).rejects.toThrow(
      /outbound dispatch failed/,
    );
    await pool.query(
      `UPDATE patient
          SET provider_opted_in = false,
              agent_enabled = false,
              messaging_state_version = messaging_state_version + 1
        WHERE id = $1`,
      [turn.patientId],
    );
    await processConversationJob(turn.inboundMessageId, pool);

    expect(callsFor(GATEWAY_ARN)).toBe(1);
    expect(callsFor(OUTBOUND_ARN)).toBe(1);
    const outbound = await pool.query<{ status: string }>(
      `SELECT status FROM outbound_message WHERE in_reply_to_inbound_id = $1`,
      [turn.inboundMessageId],
    );
    expect(outbound.rows).toEqual([{ status: 'failed' }]);
    await pool.query('DELETE FROM patient WHERE id = $1', [turn.patientId]);
  });

  it('suppresses provider reservation after STOP and START change the consent epoch', async () => {
    const turn = await seedTurn();
    installLambdaTransport();
    await pool.query(
      `INSERT INTO provider_circuit (provider_key, state)
       VALUES ('anthropic:claude-sonnet-5', 'closed')
       ON CONFLICT (provider_key) DO NOTHING`,
    );
    const circuitLock = await pool.connect();
    let processing: Promise<void> | undefined;
    try {
      await circuitLock.query('BEGIN');
      const lockPid = await circuitLock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await circuitLock.query(
        `SELECT provider_key
           FROM provider_circuit
          WHERE provider_key = 'anthropic:claude-sonnet-5'
          FOR UPDATE`,
      );

      processing = processConversationJob(turn.inboundMessageId, pool);
      void processing.catch(() => undefined);
      await waitUntilBlocking(lockPid.rows[0]!.pid);
      await pool.query(
        `UPDATE patient
            SET provider_opted_in = false,
                agent_enabled = false,
                opted_out_at = now(),
                messaging_state_version = messaging_state_version + 1
          WHERE id = $1`,
        [turn.patientId],
      );
      await pool.query(
        `UPDATE patient
            SET provider_opted_in = true,
                agent_enabled = true,
                opted_out_at = NULL,
                messaging_state_version = messaging_state_version + 1
          WHERE id = $1`,
        [turn.patientId],
      );
      await circuitLock.query('COMMIT');

      const outcome = await processing.then(
        () => 'resolved',
        (error: unknown) => String(error),
      );
      const state = await pool.query<{
        provider_opted_in: boolean;
        agent_enabled: boolean;
        messaging_state_version: number;
        interpretation_attempted_at: Date | null;
        interpretation_result: unknown | null;
        interpretation_reserved_input: number;
        interpretation_reserved_output: number;
        failure_kind: string | null;
        usage_count: number;
        clinical_event_count: number;
        agent_turn_count: number;
        outbound_count: number;
      }>(
        `SELECT p.provider_opted_in, p.agent_enabled, p.messaging_state_version,
                tj.interpretation_attempted_at, tj.interpretation_result,
                tj.interpretation_reserved_input, tj.interpretation_reserved_output,
                tj.failure_kind,
                (SELECT count(*)::int FROM usage_bucket item
                  WHERE item.patient_id = p.id) AS usage_count,
                (SELECT count(*)::int FROM clinical_event item
                  WHERE item.patient_id = p.id) AS clinical_event_count,
                (SELECT count(*)::int FROM agent_turn item
                  WHERE item.patient_id = p.id) AS agent_turn_count,
                (SELECT count(*)::int FROM outbound_message item
                  WHERE item.patient_id = p.id) AS outbound_count
           FROM patient p
           JOIN turn_job tj
             ON tj.patient_id = p.id AND tj.inbound_message_id = $2
          WHERE p.id = $1`,
        [turn.patientId, turn.inboundMessageId],
      );
      const row = state.rows[0]!;
      expect({
        outcome,
        gatewayCalls: callsFor(GATEWAY_ARN),
        outboundCalls: callsFor(OUTBOUND_ARN),
        providerOptedIn: row.provider_opted_in,
        agentEnabled: row.agent_enabled,
        messagingStateVersion: row.messaging_state_version,
        interpretationAttempted: row.interpretation_attempted_at !== null,
        interpretationResultStored: row.interpretation_result !== null,
        interpretationReservedInput: row.interpretation_reserved_input,
        interpretationReservedOutput: row.interpretation_reserved_output,
        failureKind: row.failure_kind,
        usageCount: row.usage_count,
        clinicalEventCount: row.clinical_event_count,
        agentTurnCount: row.agent_turn_count,
        outboundCount: row.outbound_count,
      }).toEqual({
        outcome: 'resolved',
        gatewayCalls: 0,
        outboundCalls: 0,
        providerOptedIn: true,
        agentEnabled: true,
        messagingStateVersion: 3,
        interpretationAttempted: false,
        interpretationResultStored: false,
        interpretationReservedInput: 0,
        interpretationReservedOutput: 0,
        failureKind: null,
        usageCount: 0,
        clinicalEventCount: 0,
        agentTurnCount: 0,
        outboundCount: 0,
      });
    } finally {
      await circuitLock.query('ROLLBACK').catch(() => undefined);
      circuitLock.release();
      await processing?.catch(() => undefined);
      await pool.query('DELETE FROM patient WHERE id = $1', [turn.patientId]);
    }
  }, 10_000);

  it('releases the patient lock before a reserved provider call and suppresses final writes', async () => {
    const turn = await seedTurn();
    const gatewayStarted = deferred();
    const gatewayMayFinish = deferred();
    lambdaSend.mockImplementation(async (command: unknown) => {
      const input = commandInput(command);
      if (input.FunctionName !== GATEWAY_ARN) throw new Error('outbound must stay suppressed');
      const request = JSON.parse(
        new TextDecoder().decode(input.Payload),
      ) as InterpretationGatewayRequest;
      gatewayStarted.resolve();
      await gatewayMayFinish.promise;
      return {
        Payload: new TextEncoder().encode(JSON.stringify(boundedGatewayResponse(request))),
      };
    });

    const processing = processConversationJob(turn.inboundMessageId, pool);
    void processing.catch(() => undefined);
    await gatewayStarted.promise;
    const stopClient = await pool.connect();
    try {
      await stopClient.query(`SET statement_timeout = '1500ms'`);
      await expect(
        stopClient.query(
          `UPDATE patient
              SET provider_opted_in = false,
                  agent_enabled = false,
                  opted_out_at = now(),
                  messaging_state_version = messaging_state_version + 1
            WHERE id = $1`,
          [turn.patientId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await stopClient.query('RESET statement_timeout').catch(() => undefined);
      stopClient.release();
    }
    gatewayMayFinish.resolve();

    await expect(processing).rejects.toThrow('messaging_state_changed');
    await expect(processConversationJob(turn.inboundMessageId, pool)).resolves.toBeUndefined();
    expect(callsFor(GATEWAY_ARN)).toBe(1);
    expect(callsFor(OUTBOUND_ARN)).toBe(0);
    const state = await pool.query<{
      provider_opted_in: boolean;
      interpretation_result: unknown | null;
      agent_turn_count: number;
      outbound_count: number;
    }>(
      `SELECT p.provider_opted_in, tj.interpretation_result,
              (SELECT count(*)::int FROM agent_turn item
                WHERE item.patient_id = p.id) AS agent_turn_count,
              (SELECT count(*)::int FROM outbound_message item
                WHERE item.patient_id = p.id) AS outbound_count
         FROM patient p
         JOIN turn_job tj
           ON tj.patient_id = p.id AND tj.inbound_message_id = $2
        WHERE p.id = $1`,
      [turn.patientId, turn.inboundMessageId],
    );
    expect(state.rows).toEqual([
      {
        provider_opted_in: false,
        interpretation_result: expect.any(Object),
        agent_turn_count: 0,
        outbound_count: 0,
      },
    ]);
    await pool.query('DELETE FROM patient WHERE id = $1', [turn.patientId]);
  }, 10_000);
});

describe('M-09: stored severity memory through the production composition', () => {
  function installRecurrenceTransport(): void {
    lambdaSend.mockImplementation(async (command: unknown) => {
      const input = commandInput(command);
      if (input.FunctionName === GATEWAY_ARN) {
        const request = JSON.parse(
          new TextDecoder().decode(input.Payload),
        ) as InterpretationGatewayRequest;
        const result =
          request.input.currentMessage.body === 'My headache is back.'
            ? {
                claims: [
                  {
                    sourceMessageId: request.input.currentMessage.id,
                    informationNeedId: null,
                    claim: {
                      slot: 'recurrence',
                      kind: 'recurrence',
                      quote: 'headache is back',
                      polarity: 'positive',
                      experiencer: 'patient',
                      status: 'current',
                      certainty: 'certain',
                      symptomText: 'headache',
                    },
                  },
                ],
              }
            : (() => {
                expect(request.input.currentMessage.body).toBe('Same as before.');
                const need = request.input.openInformationNeeds.find(
                  ({ field }) => field === 'severity',
                );
                expect(need).toBeDefined();
                return {
                  claims: [
                    {
                      sourceMessageId: request.input.currentMessage.id,
                      informationNeedId: need!.id,
                      claim: {
                        slot: 'same-severity',
                        kind: 'need_answer',
                        quote: 'Same as before.',
                        polarity: 'positive',
                        experiencer: 'patient',
                        status: 'current',
                        certainty: 'certain',
                        answerField: 'severity',
                        answerText: 'Same as before.',
                      },
                    },
                  ],
                };
              })();
        return {
          Payload: new TextEncoder().encode(
            JSON.stringify({
              ok: true,
              requestId: request.requestId,
              stage: request.stage,
              result,
              usage: { inputTokens: 100, outputTokens: 20 },
              metadata: {
                modelId: 'claude-sonnet-5',
                promptVersion: request.input.promptVersion,
                schemaSha256: CLINICAL_EXTRACTOR_SCHEMA_SHA256,
                latencyMs: 10,
              },
            }),
          ),
        };
      }
      const outbound = JSON.parse(new TextDecoder().decode(input.Payload)) as {
        patientId: string;
        agentTurnId: string;
        expectedMessagingStateVersion: number;
      };
      expect(outbound.expectedMessagingStateVersion).toBeGreaterThan(0);
      await pool.query(
        `UPDATE outbound_message SET status = 'queued', twilio_sid = $3, sent_at = now()
          WHERE patient_id = $1 AND agent_turn_id = $2`,
        [outbound.patientId, outbound.agentTurnId, `SM-m09-${outbound.agentTurnId}`],
      );
      return { Payload: new TextEncoder().encode(JSON.stringify({ sent: true, sid: 'SM-m09' })) };
    });
  }

  async function appendInbound(patientId: string, sequence: number, body: string): Promise<string> {
    // Anchored to now(): a turn only sees clinical rows created before it, and
    // the rows this test writes are stamped with the container's own clock.
    const inbound = await pool.query<{ id: string }>(
      `INSERT INTO inbound_reply
         (patient_id, raw_body, received_at, inbound_sequence, enqueued_at)
       VALUES ($1, $2, now(), $3, now())
       RETURNING id::text`,
      [patientId, body, sequence],
    );
    await pool.query(
      `INSERT INTO turn_job
         (patient_id, inbound_message_id, inbound_sequence, messaging_state_version)
       SELECT $1, $2, $3, messaging_state_version FROM patient WHERE id = $1`,
      [patientId, inbound.rows[0]!.id, sequence],
    );
    return inbound.rows[0]!.id;
  }

  it('carries a translated prior 2/10 after an explicit "same as before" answer and asks severity once', async () => {
    phoneCounter += 1;
    const patient = await pool.query<{ id: string }>(
      `INSERT INTO patient (phone, medication_name, owner_clinician_sub, timezone)
       VALUES ($1, 'test medication', $2, 'America/Toronto') RETURNING id::text`,
      [`+1500889${String(phoneCounter).padStart(4, '0')}`, OWNER_ID],
    );
    const patientId = patient.rows[0]!.id;
    const historical = await appendInbound(patientId, 1, 'Headache was 2/10.');
    const historicalSpans = [
      {
        messageId: historical,
        start: 0,
        end: 'Headache was 2/10.'.length,
        quote: 'Headache was 2/10.',
      },
    ];
    await pool.query(
      `INSERT INTO clinical_event
         (patient_id, source_inbound_id, event_type, event_code, statement_text,
          normalized_value, occurred_at, local_date, local_time, patient_timezone,
          severity, authored_by, review_state, clinical_operation,
          is_canonical_patient_report, source_spans, clinical_values)
       VALUES ($1, $2, 'observation', 'symptom', 'Headache was 2/10.', 'headache',
               date_trunc('minute', now() - interval '2 hours'),
               (date_trunc('minute', now() - interval '2 hours') AT TIME ZONE 'America/Toronto')::date,
               to_char(date_trunc('minute', now() - interval '2 hours') AT TIME ZONE 'America/Toronto', 'HH24:MI'),
               'America/Toronto', 2, 'patient', 'unreviewed', 'create', true,
               $3::jsonb, $4::jsonb)`,
      [
        patientId,
        historical,
        JSON.stringify(historicalSpans),
        JSON.stringify({
          rawSymptom: 'headache',
          symptomConcept: 'headache',
          symptomStatus: 'resolved',
          severity: '2',
        }),
      ],
    );
    await expect(translateHistoricalClinicalMemory(pool, patientId)).resolves.toMatchObject({
      kind: 'translated',
      patientId,
    });
    await pool.query(
      `UPDATE turn_job SET completed_at = now()
        WHERE patient_id = $1 AND inbound_message_id = $2`,
      [patientId, historical],
    );
    installRecurrenceTransport();

    const first = await appendInbound(patientId, 2, 'My headache is back.');
    await processConversationJob(first, pool);
    await pool.query(
      `UPDATE turn_job
          SET completed_at = now()
        WHERE patient_id = $1 AND inbound_message_id = $2`,
      [patientId, first],
    );
    const second = await appendInbound(patientId, 3, 'Same as before.');
    await processConversationJob(second, pool);

    const stored = await pool.query<{ severity: string | null; clinical_operation: string }>(
      `SELECT ce.clinical_values->>'severity' AS severity, ce.clinical_operation
         FROM clinical_event ce
         JOIN agent_turn at ON at.id = ce.agent_turn_id
        WHERE at.inbound_message_id = $1 AND ce.event_type = 'patient_statement'`,
      [second],
    );
    expect(stored.rows).toEqual([{ severity: '2', clinical_operation: 'refine' }]);

    const questions = await pool.query<{ clarification_topic: string | null }>(
      `SELECT om.clarification_topic
         FROM outbound_message om
         JOIN agent_turn at ON at.id = om.agent_turn_id
        WHERE om.patient_id = $1
        ORDER BY at.created_at, om.id`,
      [patientId],
    );
    // Severity is still asked exactly once. Owner decision C: with the context battery ON the
    // second turn consumes the next need in the battery sequence (onset) — one question per
    // turn, deterministic priority order.
    expect(questions.rows.map(({ clarification_topic }) => clarification_topic)).toEqual([
      'severity',
      'onset',
    ]);
    await pool.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });
});
