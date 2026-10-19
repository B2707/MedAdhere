import type { Context, SQSEvent } from 'aws-lambda';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import {
  buildContinuationInboundReplyWake,
  parseInboundReplyWake,
  type InboundReplyWakeSendMessageInput,
} from '@medadhere/shared';
import type { Pool } from 'pg';
import { createDbPoolProvider } from '../shared/db-pool.js';
import { CONVERSATION_LAMBDA_CLIENT_CONFIG, processConversationJob } from './turn-processor.js';

const MAX_TURNS_PER_INVOCATION = 1;
const MAX_DEFERRED_REMINDERS_PER_INVOCATION = 25;
const MIN_REMAINING_TIME_MS = 165_000;

const secrets = new SecretsManagerClient({});
const sqs = new SQSClient({});
/** Same no-retry transport the turn processor uses for its Outbound invoke (never a duplicate SMS). */
const lambda = new LambdaClient(CONVERSATION_LAMBDA_CLIENT_CONFIG);
const getPool = createDbPoolProvider(secrets);

interface QueueWorkerDependencies {
  readonly getPool: () => Promise<Pool>;
  readonly processConversationJob: (inboundMessageId: string, database: Pool) => Promise<void>;
  readonly sendContinuation: (input: InboundReplyWakeSendMessageInput) => Promise<void>;
  /** H-04 — re-evaluate reminder attempts this patient's just-completed turn may have been holding. */
  readonly triggerDeferredReminder: (patientId: string) => Promise<void>;
  readonly queueUrl: string;
}

/** One reminder attempt a completed turn releases — the exact payload the Outbound Lambda expects. */
export interface DeferredReminder {
  readonly patientId: string;
  readonly doseId: string;
  readonly reminderAttempt: number;
}

interface PendingJob {
  readonly inbound_message_id: string;
  readonly inbound_sequence: string;
}

async function findPatientId(database: Pool, inboundMessageId: string): Promise<string | null> {
  const result = await database.query('SELECT patient_id::text FROM inbound_reply WHERE id = $1', [
    inboundMessageId,
  ]);
  return (result.rows[0] as { patient_id?: string } | undefined)?.patient_id ?? null;
}

async function findNextPendingJob(database: Pool, patientId: string): Promise<PendingJob | null> {
  const result = await database.query(
    `SELECT inbound_message_id::text, inbound_sequence::text
       FROM turn_job
      WHERE patient_id = $1
        AND completed_at IS NULL
      ORDER BY inbound_sequence ASC
      LIMIT 1`,
    [patientId],
  );
  return (result.rows[0] as PendingJob | undefined) ?? null;
}

async function markJobComplete(
  database: Pool,
  patientId: string,
  inboundMessageId: string,
): Promise<void> {
  const result = await database.query(
    `UPDATE turn_job
        SET completed_at = now()
      WHERE patient_id = $1
        AND inbound_message_id = $2
        AND completed_at IS NULL`,
    [patientId, inboundMessageId],
  );
  if (result.rowCount !== 1) {
    throw new Error('Pending turn job disappeared before completion');
  }
}

/**
 * H-04 — a bounded snapshot of reminder attempts a just-completed turn may release.
 *
 * The Scheduler invocation durably records its exact due attempt as `prepared` before checking whether
 * an incomplete turn holds it. A completed turn may release only the latest existing row per dose; it
 * must never infer a new attempt from counts or wall-clock time. The stable snapshot prevents a no-op
 * Outbound response from re-selecting the same held dose forever. Each Outbound claim re-validates
 * eligibility atomically.
 */
export async function findDeferredReminders(
  database: Pick<Pool, 'query'>,
  patientId: string,
): Promise<readonly DeferredReminder[]> {
  const result = await database.query(
    `SELECT dose_id::text, reminder_attempt::int
       FROM (
         SELECT DISTINCT ON (dose_id) dose_id, reminder_attempt, created_at
           FROM outbound_message
          WHERE patient_id = $1
            AND message_kind = 'reminder'
            AND status = 'prepared'
            AND dose_id IS NOT NULL
            AND reminder_attempt IS NOT NULL
          ORDER BY dose_id, reminder_attempt DESC, created_at DESC
       ) AS latest_per_dose
      ORDER BY created_at ASC, dose_id ASC
      LIMIT $2`,
    [patientId, MAX_DEFERRED_REMINDERS_PER_INVOCATION + 1],
  );
  return (result.rows as Array<{ dose_id: string; reminder_attempt: number }>).map((row) => ({
    patientId,
    doseId: row.dose_id,
    reminderAttempt: row.reminder_attempt,
  }));
}

export async function processQueueEvent(
  event: SQSEvent,
  context: Pick<Context, 'getRemainingTimeInMillis'>,
  dependencies: QueueWorkerDependencies,
): Promise<void> {
  const [record] = event.Records;
  if (event.Records.length !== 1 || record === undefined) {
    throw new Error('Conversation FIFO worker requires exactly one record');
  }

  const { inboundMessageId } = parseInboundReplyWake(record.body);
  const database = await dependencies.getPool();
  const patientId = await findPatientId(database, inboundMessageId);
  if (patientId === null) return;

  if (record.attributes.MessageGroupId !== patientId) {
    throw new Error('SQS message group does not match the stored patient');
  }

  let nextJob = await findNextPendingJob(database, patientId);
  let completedCount = 0;

  while (
    nextJob !== null &&
    completedCount < MAX_TURNS_PER_INVOCATION &&
    context.getRemainingTimeInMillis() > MIN_REMAINING_TIME_MS
  ) {
    await dependencies.processConversationJob(nextJob.inbound_message_id, database);
    await markJobComplete(database, patientId, nextJob.inbound_message_id);
    completedCount += 1;
    nextJob = await findNextPendingJob(database, patientId);
  }

  // Always re-check after the drain, including on a redrive where the turn is already complete. With
  // no next turn, a failed Outbound invoke redrives this record. With another pending turn, its unique
  // continuation is the retry path, so logging the durable failure avoids poisoning the patient FIFO.
  // If an invoke was accepted and only its response was lost, its atomic claim already advanced the
  // row and the later snapshot skips it, preserving send-once behavior.
  try {
    await dependencies.triggerDeferredReminder(patientId);
  } catch (error) {
    if (nextJob === null) throw error;
    // The exact attempt is still durable as `prepared`. Do not poison this patient's FIFO: the
    // continuation below makes the next turn retry the snapshot after it completes.
    console.error(
      JSON.stringify({
        metric: 'deferred_reminder_release_failed',
        errorName: error instanceof Error ? error.constructor.name.slice(0, 64) : 'unknown',
      }),
    );
  }

  if (nextJob !== null) {
    await dependencies.sendContinuation(
      buildContinuationInboundReplyWake({
        queueUrl: dependencies.queueUrl,
        patientId,
        inboundMessageId: nextJob.inbound_message_id,
        currentMessageId: record.messageId,
        inboundSequence: nextJob.inbound_sequence,
      }),
    );
  }
}

export async function handler(event: SQSEvent, context: Context): Promise<void> {
  const queueUrl = process.env.QUEUE_URL;
  if (!queueUrl) throw new Error('QUEUE_URL env var is not set');

  await processQueueEvent(event, context, {
    getPool,
    processConversationJob,
    queueUrl,
    // Released attempts go through the SAME Outbound reminder path the one-shot uses, so the
    // atomic claim (consent, activity, budget, unanswered, dose+attempt uniqueness) still owns the
    // send. This only offers one latest prepared attempt per dose from one bounded snapshot.
    triggerDeferredReminder: async (patientId) => {
      const dueReminders = await findDeferredReminders(await getPool(), patientId);
      if (dueReminders.length === 0) return;
      const outboundFnArn = process.env.OUTBOUND_FN_ARN;
      if (!outboundFnArn) throw new Error('OUTBOUND_FN_ARN env var is not set');
      const releaseBatch = dueReminders.slice(0, MAX_DEFERRED_REMINDERS_PER_INVOCATION);
      for (const due of releaseBatch) {
        const response = await lambda.send(
          new InvokeCommand({
            FunctionName: outboundFnArn,
            InvocationType: 'RequestResponse',
            Payload: new TextEncoder().encode(JSON.stringify(due)),
          }),
        );
        if (response.FunctionError) throw new Error('Outbound reminder invocation failed');
      }
      if (dueReminders.length > MAX_DEFERRED_REMINDERS_PER_INVOCATION) {
        // The completed turn record must redrive so the next bounded snapshot can release the rest.
        throw new Error('Deferred reminder release batch limit reached');
      }
    },
    sendContinuation: async (input) => {
      const { MessageId } = await sqs.send(new SendMessageCommand(input));
      if (typeof MessageId !== 'string' || MessageId.trim() === '') {
        throw new Error('SQS continuation response did not include a MessageId');
      }
    },
  });
}
