import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context, SQSEvent } from 'aws-lambda';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Stub ONLY the job processor; spread the rest so a new queue-worker import from this module (e.g.
// CONVERSATION_LAMBDA_CLIENT_CONFIG) cannot break collection again.
vi.mock('./turn-processor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./turn-processor.js')>()),
  processConversationJob: vi.fn(),
}));

import { processQueueEvent } from './queue-worker.js';

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema-init', 'schema.sql'), 'utf8');
const CONTAINER_TIMEOUT_MS = 180_000;
const PATIENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OWNER_ID = 'e95752b9-dad4-4b76-8e8a-28d19b3c0437';
const INBOUND_IDS = [
  '7c9e6679-7425-40de-963d-02d4f4a986e1',
  '7c9e6679-7425-40de-963d-02d4f4a986e2',
] as const;
const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/turns.fifo';

let container: StartedPostgreSqlContainer | undefined;
let pool: Pool;

function event(inboundMessageId = INBOUND_IDS[1], groupId = PATIENT_ID): SQSEvent {
  return {
    Records: [
      {
        messageId: 'f1205f68-6b40-4bfb-9717-bd08c862b447',
        receiptHandle: 'receipt',
        body: JSON.stringify({ inboundMessageId }),
        attributes: {
          ApproximateReceiveCount: '1',
          SentTimestamp: '1',
          SenderId: 'sender',
          ApproximateFirstReceiveTimestamp: '1',
          MessageGroupId: groupId,
          MessageDeduplicationId: 'sid:SM-test',
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

describe('conversation FIFO worker against PostgreSQL 16', () => {
  it('processes the oldest incomplete patient job first, marks success, and skips replay', async () => {
    await pool.query(
      `INSERT INTO patient (id, phone, medication_name, owner_clinician_sub)
       VALUES ($1, '+15005550199', 'test medication', $2)`,
      [PATIENT_ID, OWNER_ID],
    );
    for (const [index, inboundMessageId] of INBOUND_IDS.entries()) {
      const sequence = index + 1;
      await pool.query(
        `INSERT INTO inbound_reply
           (id, patient_id, raw_body, received_at, inbound_sequence, enqueued_at)
         VALUES ($1, $2, 'test reply', now(), $3, now())`,
        [inboundMessageId, PATIENT_ID, sequence],
      );
      await pool.query(
        `INSERT INTO turn_job (patient_id, inbound_message_id, inbound_sequence)
         VALUES ($1, $2, $3)`,
        [PATIENT_ID, inboundMessageId, sequence],
      );
    }

    const processConversationJob = vi.fn().mockResolvedValue(undefined);
    const dependencies = {
      getPool: vi.fn().mockResolvedValue(pool),
      processConversationJob,
      sendContinuation: vi.fn().mockResolvedValue(undefined),
      triggerDeferredReminder: vi.fn().mockResolvedValue(undefined),
      queueUrl: QUEUE_URL,
    };

    await pool.query(
      `UPDATE turn_job SET failure_kind = 'provider_error' WHERE inbound_message_id = $1`,
      [INBOUND_IDS[0]],
    );

    await processQueueEvent(event(), context, dependencies);
    expect(processConversationJob.mock.calls.map(([id]) => id)).toEqual([INBOUND_IDS[0]]);
    expect(dependencies.sendContinuation).toHaveBeenCalledOnce();
    expect(
      (
        await pool.query<{ failure_kind: string | null }>(
          `SELECT failure_kind FROM turn_job WHERE inbound_message_id = $1`,
          [INBOUND_IDS[0]],
        )
      ).rows[0]?.failure_kind,
    ).toBe('provider_error');

    await processQueueEvent(event(INBOUND_IDS[1]), context, dependencies);
    expect(processConversationJob.mock.calls.map(([id]) => id)).toEqual(INBOUND_IDS);
    expect(
      (
        await pool.query<{ inbound_message_id: string }>(
          `SELECT inbound_message_id::text
             FROM turn_job
            WHERE completed_at IS NOT NULL
            ORDER BY inbound_sequence`,
        )
      ).rows.map(({ inbound_message_id }) => inbound_message_id),
    ).toEqual(INBOUND_IDS);

    processConversationJob.mockClear();
    await processQueueEvent(event(), context, dependencies);
    expect(processConversationJob).not.toHaveBeenCalled();
    expect(dependencies.sendContinuation).toHaveBeenCalledOnce();

    await pool.query('DELETE FROM patient WHERE id = $1', [PATIENT_ID]);
  });
});
