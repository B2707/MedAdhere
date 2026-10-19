import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context, SQSEvent } from 'aws-lambda';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationGatewayRequest } from './gateway-contract.js';

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
import { COMPOSER_DISABLE_ENV } from './compose-plumbing.js';
import { processQueueEvent } from './queue-worker.js';
import { processConversationJob } from './turn-processor.js';

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema-init', 'schema.sql'), 'utf8');
const CONTAINER_TIMEOUT_MS = 180_000;
const OWNER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GATEWAY_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:gateway';
const OUTBOUND_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:outbound';
const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/turns.fifo';

interface TurnState {
  readonly clinical_memory_version: number;
  readonly interpretation_attempted_at: Date | null;
  readonly interpretation_reserved_input: number;
  readonly interpretation_reserved_output: number;
  readonly interpretation_result: unknown;
  readonly writer_result: unknown | null;
  readonly failure_kind: string | null;
  readonly completed_at: Date | null;
  readonly agent_turn_id: string;
  readonly failure_class: string | null;
  readonly prepared_command_batch: readonly unknown[];
  readonly prepared_response_plan: unknown;
  readonly prepared_command_hash: string;
  readonly prepared_batch_hash: string;
  readonly prepared_result_receipt: unknown;
  readonly outbound_message_id: string;
  readonly outbound_body: string;
  readonly outbound_message_kind: string;
  readonly outbound_status: string;
  readonly agent_turn_count: number;
  readonly clinical_event_count: number;
  readonly information_need_count: number;
  readonly review_item_count: number;
  readonly outbound_count: number;
  readonly usage_bucket_count: number;
}

interface PendingTurnState {
  readonly clinical_memory_version: number;
  readonly interpretation_result: unknown | null;
  readonly failure_kind: string | null;
  readonly completed_at: Date | null;
  readonly agent_turn_count: number;
  readonly clinical_event_count: number;
  readonly information_need_count: number;
  readonly review_item_count: number;
  readonly outbound_count: number;
  readonly usage_bucket_count: number;
}

let container: StartedPostgreSqlContainer | undefined;
let pool: Pool;
let phoneCounter = 0;
const patientIds = new Set<string>();

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function seedTurn(
  options: { readonly rawBody?: string; readonly safetyFlagged?: boolean } = {},
): Promise<{ patientId: string; inboundMessageId: string }> {
  phoneCounter += 1;
  const patient = await pool.query<{ id: string }>(
    `INSERT INTO patient (phone, medication_name, owner_clinician_sub, timezone)
     VALUES ($1, 'test medication', $2, 'America/Toronto') RETURNING id::text`,
    [`+1500777${String(phoneCounter).padStart(4, '0')}`, OWNER_ID],
  );
  const patientId = patient.rows[0]!.id;
  patientIds.add(patientId);
  const inbound = await pool.query<{ id: string }>(
    `INSERT INTO inbound_reply
       (patient_id, raw_body, received_at, inbound_sequence, enqueued_at, safety_flagged)
     VALUES ($1, $2, '2026-08-11T13:00:00Z', 1, now(), $3)
     RETURNING id::text`,
    [patientId, options.rawBody ?? 'My headache is back.', options.safetyFlagged ?? false],
  );
  const inboundMessageId = inbound.rows[0]!.id;
  await pool.query(
    `INSERT INTO turn_job
       (patient_id, inbound_message_id, inbound_sequence, messaging_state_version)
     SELECT $1, $2, 1, messaging_state_version FROM patient WHERE id = $1`,
    [patientId, inboundMessageId],
  );
  return { patientId, inboundMessageId };
}

function queueEvent(patientId: string, inboundMessageId: string): SQSEvent {
  return {
    Records: [
      {
        messageId: 'a1205f68-6b40-4bfb-9717-bd08c862b447',
        receiptHandle: 'receipt',
        body: JSON.stringify({ inboundMessageId }),
        attributes: {
          ApproximateReceiveCount: '1',
          SentTimestamp: '1',
          SenderId: 'sender',
          ApproximateFirstReceiveTimestamp: '1',
          MessageGroupId: patientId,
          MessageDeduplicationId: `inbound:${inboundMessageId}`,
          SequenceNumber: '1',
        },
        messageAttributes: {},
        md5OfBody: 'md5',
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:turns.fifo',
        awsRegion: 'us-east-1',
      },
    ],
  };
}

const context = {
  getRemainingTimeInMillis: () => 180_000,
} as Pick<Context, 'getRemainingTimeInMillis'>;

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

function callsFor(functionArn: string): number {
  return lambdaSend.mock.calls.filter(
    ([command]) => commandInput(command).FunctionName === functionArn,
  ).length;
}

async function seedScheduledMedication(patientId: string): Promise<void> {
  const medication = await pool.query<{ id: string }>(
    `INSERT INTO patient_medication
       (patient_id, entered_name, identity_system, identity_code, dose_text, valid_from,
        status, confirmed_by_clinician_sub, confirmed_at)
     VALUES ($1, 'Metformin', 'rxnorm', '6809', '500 mg', '2026-08-01',
             'active', $2, '2026-08-01T12:00:00Z')
     RETURNING id::text`,
    [patientId, OWNER_ID],
  );
  await pool.query(
    `INSERT INTO patient_medication_ingredient
       (patient_id, patient_medication_id, ingredient_order, ingredient_name, rxcui)
     VALUES ($1, $2, 1, 'metformin', '6809')`,
    [patientId, medication.rows[0]!.id],
  );
  await pool.query(
    `INSERT INTO dose_schedule
       (patient_id, patient_medication_id, scheduled_at, local_dose_time,
        dose_date, schedule_timezone)
     VALUES ($1, $2, '2026-08-11T13:00:00Z', '09:00',
             '2026-08-11', 'America/Toronto')`,
    [patientId, medication.rows[0]!.id],
  );
}

async function loadPendingTurnState(
  patientId: string,
  inboundMessageId: string,
): Promise<PendingTurnState> {
  const result = await pool.query<PendingTurnState>(
    `SELECT patient.clinical_memory_version::int,
            turn_job.interpretation_result,
            turn_job.failure_kind,
            turn_job.completed_at,
            (SELECT count(*)::int FROM agent_turn item
              WHERE item.patient_id = patient.id) AS agent_turn_count,
            (SELECT count(*)::int FROM clinical_event item
              WHERE item.patient_id = patient.id) AS clinical_event_count,
            (SELECT count(*)::int FROM information_need item
              WHERE item.patient_id = patient.id) AS information_need_count,
            (SELECT count(*)::int FROM clinical_review_item item
              WHERE item.patient_id = patient.id) AS review_item_count,
            (SELECT count(*)::int FROM outbound_message item
              WHERE item.patient_id = patient.id) AS outbound_count,
            (SELECT count(*)::int FROM usage_bucket item
              WHERE item.patient_id = patient.id) AS usage_bucket_count
       FROM patient
       JOIN turn_job
         ON turn_job.patient_id = patient.id
        AND turn_job.inbound_message_id = $2
      WHERE patient.id = $1`,
    [patientId, inboundMessageId],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

async function waitForCheckpoint(
  patientId: string,
  inboundMessageId: string,
): Promise<PendingTurnState> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const state = await loadPendingTurnState(patientId, inboundMessageId);
    if (state.interpretation_result !== null) return state;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for the durable interpretation checkpoint');
}

async function loadTurnState(patientId: string, inboundMessageId: string): Promise<TurnState> {
  const result = await pool.query<TurnState>(
    `SELECT patient.clinical_memory_version::int,
            turn_job.interpretation_attempted_at,
            turn_job.interpretation_reserved_input,
            turn_job.interpretation_reserved_output,
            turn_job.interpretation_result,
            turn_job.writer_result,
            turn_job.failure_kind,
            turn_job.completed_at,
            agent_turn.id::text AS agent_turn_id,
            agent_turn.failure_class,
            agent_turn.prepared_command_batch,
            agent_turn.prepared_response_plan,
            agent_turn.prepared_command_hash,
            agent_turn.prepared_batch_hash,
            agent_turn.prepared_result_receipt,
            outbound.id::text AS outbound_message_id,
            outbound.body AS outbound_body,
            outbound.message_kind AS outbound_message_kind,
            outbound.status AS outbound_status,
            (SELECT count(*)::int FROM agent_turn item
              WHERE item.patient_id = patient.id) AS agent_turn_count,
            (SELECT count(*)::int FROM clinical_event item
              WHERE item.patient_id = patient.id) AS clinical_event_count,
            (SELECT count(*)::int FROM information_need item
              WHERE item.patient_id = patient.id) AS information_need_count,
            (SELECT count(*)::int FROM clinical_review_item item
              WHERE item.patient_id = patient.id) AS review_item_count,
            (SELECT count(*)::int FROM outbound_message item
              WHERE item.patient_id = patient.id) AS outbound_count,
            (SELECT count(*)::int FROM usage_bucket item
              WHERE item.patient_id = patient.id) AS usage_bucket_count
       FROM patient
       JOIN turn_job
         ON turn_job.patient_id = patient.id
        AND turn_job.inbound_message_id = $2
       JOIN agent_turn
         ON agent_turn.patient_id = patient.id
        AND agent_turn.inbound_message_id = turn_job.inbound_message_id
       JOIN outbound_message outbound
         ON outbound.patient_id = patient.id
        AND outbound.agent_turn_id = agent_turn.id
      WHERE patient.id = $1`,
    [patientId, inboundMessageId],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

function dependencies() {
  return {
    getPool: vi.fn().mockResolvedValue(pool),
    processConversationJob,
    sendContinuation: vi.fn().mockResolvedValue(undefined),
    triggerDeferredReminder: vi.fn().mockResolvedValue(undefined),
    queueUrl: QUEUE_URL,
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
  process.env.LLM_GATEWAY_FN_ARN = GATEWAY_ARN;
  process.env.OUTBOUND_FN_ARN = OUTBOUND_ARN;
  // ACTIVATION: this suite exercises the queue/FIFO lifecycle around the interpretation
  // stage — the composer is a separately-tested concern (compose-plumbing.db.test.ts,
  // turn-processor.compose.test.ts) and its kill switch is the documented opt-out, so
  // disable it here rather than teaching this fake Lambda transport the composition stage.
  process.env[COMPOSER_DISABLE_ENV] = 'true';
}, CONTAINER_TIMEOUT_MS);

beforeEach(() => {
  lambdaSend.mockReset();
});

afterEach(async () => {
  for (const patientId of patientIds)
    await pool.query('DELETE FROM patient WHERE id = $1', [patientId]);
  patientIds.clear();
});

afterAll(async () => {
  delete process.env[COMPOSER_DISABLE_ENV];
  await pool?.end();
  await container?.stop();
});

describe('production conversation queue against PostgreSQL 16', () => {
  it.each([
    {
      label: 'exact STOP',
      rawBody: 'STOP',
      safetyFlagged: false,
      responseKind: 'stop',
      eventKinds: [],
      reviewCount: 0,
    },
    {
      label: 'deterministic emergency',
      rawBody: "I can't breathe.",
      safetyFlagged: false,
      responseKind: 'emergency',
      eventKinds: ['safety'],
      reviewCount: 2,
    },
  ] as const)(
    'applies $label before provider reservation or invocation',
    async ({ rawBody, safetyFlagged, responseKind, eventKinds, reviewCount }) => {
      const turn = await seedTurn({ rawBody, safetyFlagged });
      lambdaSend.mockImplementation(async (command: unknown) => {
        const input = commandInput(command);
        if (input.FunctionName === GATEWAY_ARN) {
          const request = JSON.parse(
            new TextDecoder().decode(input.Payload),
          ) as InterpretationGatewayRequest;
          return {
            Payload: new TextEncoder().encode(
              JSON.stringify({ ...boundedGatewayResponse(request), result: { claims: [] } }),
            ),
          };
        }
        if (input.FunctionName !== OUTBOUND_ARN) throw new Error('Unexpected Lambda target');
        const outbound = JSON.parse(new TextDecoder().decode(input.Payload)) as {
          patientId: string;
          agentTurnId: string;
        };
        const accepted = await pool.query(
          `UPDATE outbound_message
              SET status = 'queued', twilio_sid = 'SM-eligibility-test', sent_at = now()
            WHERE patient_id = $1 AND agent_turn_id = $2 AND status = 'prepared'
            RETURNING id`,
          [outbound.patientId, outbound.agentTurnId],
        );
        expect(accepted.rows).toHaveLength(1);
        return {
          Payload: new TextEncoder().encode(
            JSON.stringify({ sent: true, sid: 'SM-eligibility-test' }),
          ),
        };
      });

      await processQueueEvent(
        queueEvent(turn.patientId, turn.inboundMessageId),
        context,
        dependencies(),
      );

      const state = await loadTurnState(turn.patientId, turn.inboundMessageId);
      const events = await pool.query<{ kind: string }>(
        `SELECT event_type AS kind
           FROM clinical_event
          WHERE patient_id = $1 AND semantic_event_id IS NOT NULL
          ORDER BY event_type`,
        [turn.patientId],
      );
      expect(state.prepared_response_plan).toMatchObject({ kind: responseKind });
      expect(events.rows.map(({ kind }) => kind)).toEqual(eventKinds);
      expect(state).toMatchObject({
        interpretation_attempted_at: null,
        interpretation_reserved_input: 0,
        interpretation_reserved_output: 0,
        interpretation_result: null,
        review_item_count: reviewCount,
        usage_bucket_count: 0,
        outbound_status: 'queued',
      });
      expect(state.completed_at).toBeInstanceOf(Date);
      expect(callsFor(GATEWAY_ARN)).toBe(0);
      expect(callsFor(OUTBOUND_ARN)).toBe(1);
    },
  );

  it('replays one atomically committed clinical turn through FIFO without recalling the gateway and lets the queue own completion', async () => {
    const turn = await seedTurn();
    const event = queueEvent(turn.patientId, turn.inboundMessageId);
    const workerDependencies = dependencies();
    let firstOutboundState: TurnState | undefined;
    let outboundAttempts = 0;

    lambdaSend.mockImplementation(async (command: unknown) => {
      const input = commandInput(command);
      if (input.FunctionName === GATEWAY_ARN) {
        const request = JSON.parse(
          new TextDecoder().decode(input.Payload),
        ) as InterpretationGatewayRequest;
        return {
          Payload: new TextEncoder().encode(JSON.stringify(boundedGatewayResponse(request))),
        };
      }
      if (input.FunctionName !== OUTBOUND_ARN) throw new Error('Unexpected Lambda target');
      outboundAttempts += 1;
      if (firstOutboundState === undefined) {
        firstOutboundState = await loadTurnState(turn.patientId, turn.inboundMessageId);
      }
      if (outboundAttempts === 1) throw new Error('outbound dispatch failed before acceptance');
      const outbound = JSON.parse(new TextDecoder().decode(input.Payload)) as {
        patientId: string;
        agentTurnId: string;
      };
      const accepted = await pool.query<{ id: string }>(
        `UPDATE outbound_message
            SET status = 'queued', twilio_sid = 'SM-queue-production-test', sent_at = now()
          WHERE patient_id = $1 AND agent_turn_id = $2 AND status = 'prepared'
          RETURNING id::text`,
        [outbound.patientId, outbound.agentTurnId],
      );
      expect(accepted.rows).toEqual([{ id: firstOutboundState.outbound_message_id }]);
      return {
        Payload: new TextEncoder().encode(
          JSON.stringify({ sent: true, sid: 'SM-queue-production-test' }),
        ),
      };
    });

    await expect(processQueueEvent(event, context, workerDependencies)).rejects.toThrow(
      'outbound dispatch failed before acceptance',
    );

    if (firstOutboundState === undefined)
      throw new Error('Outbound did not observe committed state');
    expect(firstOutboundState).toMatchObject({
      clinical_memory_version: 1,
      interpretation_result: expect.any(Object),
      writer_result: null,
      completed_at: null,
      prepared_command_batch: expect.any(Array),
      outbound_status: 'prepared',
      agent_turn_count: 1,
      outbound_count: 1,
    });
    expect(firstOutboundState?.prepared_command_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(firstOutboundState?.prepared_batch_hash).toMatch(/^[a-f0-9]{64}$/u);

    await processQueueEvent(event, context, workerDependencies);

    const completedState = await loadTurnState(turn.patientId, turn.inboundMessageId);
    expect(callsFor(GATEWAY_ARN)).toBe(1);
    expect(callsFor(OUTBOUND_ARN)).toBe(2);
    expect(completedState.clinical_memory_version).toBe(firstOutboundState.clinical_memory_version);
    expect(completedState.interpretation_result).toEqual(firstOutboundState.interpretation_result);
    expect(completedState.prepared_command_batch).toEqual(
      firstOutboundState.prepared_command_batch,
    );
    expect(completedState.prepared_result_receipt).toEqual(
      firstOutboundState.prepared_result_receipt,
    );
    expect(completedState).toMatchObject({
      writer_result: null,
      agent_turn_id: firstOutboundState.agent_turn_id,
      prepared_command_hash: firstOutboundState.prepared_command_hash,
      prepared_batch_hash: firstOutboundState.prepared_batch_hash,
      outbound_message_id: firstOutboundState.outbound_message_id,
      outbound_body: firstOutboundState.outbound_body,
      outbound_status: 'queued',
      agent_turn_count: firstOutboundState.agent_turn_count,
      clinical_event_count: firstOutboundState.clinical_event_count,
      information_need_count: firstOutboundState.information_need_count,
      review_item_count: firstOutboundState.review_item_count,
      outbound_count: firstOutboundState.outbound_count,
    });
    expect(completedState.completed_at).toBeInstanceOf(Date);
    expect(workerDependencies.sendContinuation).not.toHaveBeenCalled();
  });

  it('reuses a checkpoint and terminalizes incoherent timezone drift as review on queue redrive', async () => {
    const turn = await seedTurn();
    await seedScheduledMedication(turn.patientId);
    const event = queueEvent(turn.patientId, turn.inboundMessageId);
    const workerDependencies = dependencies();
    const gatewayStarted = deferred();
    const gatewayMayFinish = deferred();
    lambdaSend.mockImplementation(async (command: unknown) => {
      const input = commandInput(command);
      if (input.FunctionName === GATEWAY_ARN) {
        const request = JSON.parse(
          new TextDecoder().decode(input.Payload),
        ) as InterpretationGatewayRequest;
        gatewayStarted.resolve();
        await gatewayMayFinish.promise;
        return {
          Payload: new TextEncoder().encode(JSON.stringify(boundedGatewayResponse(request))),
        };
      }
      if (input.FunctionName !== OUTBOUND_ARN) throw new Error('Unexpected Lambda target');
      const outbound = JSON.parse(new TextDecoder().decode(input.Payload)) as {
        patientId: string;
        agentTurnId: string;
      };
      const accepted = await pool.query<{ id: string }>(
        `UPDATE outbound_message
            SET status = 'queued', twilio_sid = 'SM-timezone-review', sent_at = now()
          WHERE patient_id = $1 AND agent_turn_id = $2 AND status = 'prepared'
          RETURNING id::text`,
        [outbound.patientId, outbound.agentTurnId],
      );
      expect(accepted.rows).toHaveLength(1);
      return {
        Payload: new TextEncoder().encode(
          JSON.stringify({ sent: true, sid: 'SM-timezone-review' }),
        ),
      };
    });

    const updater = await pool.connect();
    let firstAttempt: Promise<void> | undefined;
    try {
      firstAttempt = processQueueEvent(event, context, workerDependencies);
      void firstAttempt.catch(() => undefined);
      await gatewayStarted.promise;
      await updater.query('BEGIN');
      await updater.query(`UPDATE patient SET timezone = 'America/Vancouver' WHERE id = $1`, [
        turn.patientId,
      ]);
      gatewayMayFinish.resolve();
      const checkpointState = await waitForCheckpoint(turn.patientId, turn.inboundMessageId);
      const checkpointJson = JSON.stringify(checkpointState.interpretation_result);
      await updater.query('COMMIT');

      const firstError = await firstAttempt.then(
        () => null,
        (error: unknown) => error,
      );
      expect(firstError).toBeInstanceOf(Error);
      expect((firstError as Error).message).toMatch(
        /clinical_context_changed|Conversation runtime state conflict|could not serialize access/u,
      );
      expect(callsFor(GATEWAY_ARN)).toBe(1);
      expect(callsFor(OUTBOUND_ARN)).toBe(0);
      expect(checkpointState).toEqual({
        clinical_memory_version: 0,
        interpretation_result: expect.any(Object),
        failure_kind: null,
        completed_at: null,
        agent_turn_count: 0,
        clinical_event_count: 0,
        information_need_count: 0,
        review_item_count: 0,
        outbound_count: 0,
        usage_bucket_count: 2,
      });

      await expect(processQueueEvent(event, context, workerDependencies)).resolves.toBeUndefined();

      expect(callsFor(GATEWAY_ARN)).toBe(1);
      expect(callsFor(OUTBOUND_ARN)).toBe(1);
      const completedState = await loadTurnState(turn.patientId, turn.inboundMessageId);
      expect(JSON.stringify(completedState.interpretation_result)).toBe(checkpointJson);
      expect(completedState).toMatchObject({
        clinical_memory_version: 1,
        failure_kind: null,
        failure_class: null,
        prepared_command_batch: [
          expect.objectContaining({
            kind: 'PreserveUnresolvedContent',
            reason: 'clinical_context_changed',
          }),
        ],
        prepared_response_plan: {
          kind: 'human_review',
          reviewReasons: ['clinical_context_changed'],
        },
        outbound_body: 'Thanks. I saved this update for your doctor to review.',
        outbound_message_kind: 'fallback',
        outbound_status: 'queued',
        agent_turn_count: 1,
        clinical_event_count: 0,
        information_need_count: 0,
        review_item_count: 1,
        outbound_count: 1,
        usage_bucket_count: 2,
      });
      expect(completedState.completed_at).toBeInstanceOf(Date);
      const review = await pool.query<{
        item_kind: string;
        semantic_unresolved_report_id: string | null;
        reason: string;
        to_status: string;
      }>(
        `SELECT item.item_kind, item.semantic_unresolved_report_id, item.reason,
                transition.to_status
           FROM clinical_review_item item
           JOIN clinical_review_item_transition transition
             ON transition.patient_id = item.patient_id
            AND transition.clinical_review_item_id = item.id
          WHERE item.patient_id = $1
            AND item.created_by_agent_turn_id = $2`,
        [turn.patientId, completedState.agent_turn_id],
      );
      expect(review.rows).toEqual([
        {
          item_kind: 'unresolved_report',
          semantic_unresolved_report_id: expect.any(String),
          reason: 'clinical_context_changed',
          to_status: 'open',
        },
      ]);
    } finally {
      gatewayMayFinish.resolve();
      await updater.query('ROLLBACK').catch(() => undefined);
      updater.release();
      await firstAttempt?.catch(() => undefined);
    }
  }, 10_000);

  it('completes a successful clinical turn once without a second completion error', async () => {
    const turn = await seedTurn();
    const workerDependencies = dependencies();
    lambdaSend.mockImplementation(async (command: unknown) => {
      const input = commandInput(command);
      if (input.FunctionName === GATEWAY_ARN) {
        const request = JSON.parse(
          new TextDecoder().decode(input.Payload),
        ) as InterpretationGatewayRequest;
        return {
          Payload: new TextEncoder().encode(JSON.stringify(boundedGatewayResponse(request))),
        };
      }
      if (input.FunctionName !== OUTBOUND_ARN) throw new Error('Unexpected Lambda target');
      const outbound = JSON.parse(new TextDecoder().decode(input.Payload)) as {
        patientId: string;
        agentTurnId: string;
      };
      const accepted = await pool.query<{ id: string }>(
        `UPDATE outbound_message
            SET status = 'queued', twilio_sid = 'SM-queue-success-test', sent_at = now()
          WHERE patient_id = $1 AND agent_turn_id = $2 AND status = 'prepared'
          RETURNING id::text`,
        [outbound.patientId, outbound.agentTurnId],
      );
      expect(accepted.rows).toHaveLength(1);
      return {
        Payload: new TextEncoder().encode(
          JSON.stringify({ sent: true, sid: 'SM-queue-success-test' }),
        ),
      };
    });

    await processQueueEvent(
      queueEvent(turn.patientId, turn.inboundMessageId),
      context,
      workerDependencies,
    );

    const completedState = await loadTurnState(turn.patientId, turn.inboundMessageId);
    expect(completedState.completed_at).toBeInstanceOf(Date);
    expect(callsFor(GATEWAY_ARN)).toBe(1);
    expect(callsFor(OUTBOUND_ARN)).toBe(1);
  });
});
