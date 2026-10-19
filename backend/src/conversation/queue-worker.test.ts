import type { Context, SQSEvent } from 'aws-lambda';
import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { productionProcessConversationJob, productionQuery, sqsSend, lambdaSend } = vi.hoisted(
  () => ({
    productionProcessConversationJob: vi.fn(),
    productionQuery: vi.fn(),
    sqsSend: vi.fn(),
    lambdaSend: vi.fn(),
  }),
);

vi.mock('./turn-processor.js', () => ({
  processConversationJob: productionProcessConversationJob,
  CONVERSATION_LAMBDA_CLIENT_CONFIG: { maxAttempts: 1 },
}));
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn(function () {
    return { send: lambdaSend };
  }),
  InvokeCommand: vi.fn(function (input: unknown) {
    return { input };
  }),
}));
vi.mock('../shared/db-pool.js', () => ({
  createDbPoolProvider: () => async () => ({ query: productionQuery }),
}));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn(function () {
    return { send: sqsSend };
  }),
  SendMessageCommand: vi.fn(function (input: unknown) {
    return { input };
  }),
}));

import { findDeferredReminders, handler, processQueueEvent } from './queue-worker.js';

const PATIENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const DOSE_ID = '9b2e6679-4f89-42de-963d-02d4f4a986aa';
const SECOND_DOSE_ID = 'ac2e6679-4f89-42de-963d-02d4f4a986bb';
const INBOUND_IDS = [
  '7c9e6679-7425-40de-963d-02d4f4a986e1',
  '7c9e6679-7425-40de-963d-02d4f4a986e2',
  '7c9e6679-7425-40de-963d-02d4f4a986e3',
  '7c9e6679-7425-40de-963d-02d4f4a986e4',
] as const;
const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/turns.fifo';

function event(
  inboundMessageId: string = INBOUND_IDS[0],
  groupId: string = PATIENT_ID,
  messageId: string = 'f1205f68-6b40-4bfb-9717-bd08c862b447',
): SQSEvent {
  return {
    Records: [
      {
        messageId,
        receiptHandle: 'receipt',
        body: JSON.stringify({ inboundMessageId }),
        attributes: {
          ApproximateReceiveCount: '1',
          SentTimestamp: '1',
          SenderId: 'sender',
          ApproximateFirstReceiveTimestamp: '1',
          MessageGroupId: groupId,
          MessageDeduplicationId: `sid:${messageId}`,
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

beforeEach(() => {
  productionProcessConversationJob.mockReset();
  productionQuery.mockReset();
  sqsSend.mockReset();
  lambdaSend.mockReset();
  process.env.QUEUE_URL = QUEUE_URL;
  process.env.OUTBOUND_FN_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:medadhere-outbound';
});

function fakePool(options: {
  patientId?: string;
  jobs?: Array<{ inbound_message_id: string; inbound_sequence: string }>;
  markRowCount?: number;
}) {
  const jobs = [...(options.jobs ?? [])];
  const query = vi.fn(async (sql: string) => {
    if (/FROM inbound_reply/i.test(sql)) {
      return { rows: [{ patient_id: options.patientId ?? PATIENT_ID }], rowCount: 1 };
    }
    if (/FROM turn_job/i.test(sql)) {
      const nextJob = jobs[0];
      return {
        rows: nextJob === undefined ? [] : [nextJob],
        rowCount: nextJob === undefined ? 0 : 1,
      };
    }
    if (/UPDATE turn_job/i.test(sql)) {
      if ((options.markRowCount ?? 1) === 1) jobs.shift();
      return { rows: [], rowCount: options.markRowCount ?? 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return { pool: { query } as unknown as Pool, query };
}

describe('conversation FIFO queue worker', () => {
  it.each([
    ['missing', {}],
    ['empty', { MessageId: '' }],
    ['blank', { MessageId: '   ' }],
  ])(
    'does not acknowledge the handler invocation when SQS resolves with a %s MessageId',
    async (_case, response) => {
      productionQuery.mockImplementation(async (sql: string) => {
        if (/FROM inbound_reply/i.test(sql)) {
          return { rows: [{ patient_id: PATIENT_ID }], rowCount: 1 };
        }
        if (/FROM turn_job/i.test(sql)) {
          return {
            rows: [{ inbound_message_id: INBOUND_IDS[0], inbound_sequence: '1' }],
            rowCount: 1,
          };
        }
        if (/FROM outbound_message/i.test(sql)) return { rows: [], rowCount: 0 };
        throw new Error(`unexpected SQL: ${sql}`);
      });
      sqsSend.mockResolvedValue(response);

      await expect(
        handler(event(), {
          getRemainingTimeInMillis: () => 20_000,
        } as Context),
      ).rejects.toThrow(/MessageId/);
      expect(sqsSend).toHaveBeenCalledOnce();
      expect(productionProcessConversationJob).not.toHaveBeenCalled();
    },
  );

  it('rejects every batch except one record and validates the FIFO group against the stored patient', async () => {
    const { pool } = fakePool({ patientId: PATIENT_ID });
    const deps = {
      getPool: vi.fn().mockResolvedValue(pool),
      processConversationJob: vi.fn(),
      sendContinuation: vi.fn(),
      triggerDeferredReminder: vi.fn(),
      queueUrl: QUEUE_URL,
    };

    await expect(processQueueEvent({ Records: [] }, context, deps)).rejects.toThrow(/one record/i);
    await expect(
      processQueueEvent(
        event(INBOUND_IDS[0], '55a5390d-5b90-40f5-a185-96173de5b27b'),
        context,
        deps,
      ),
    ).rejects.toThrow(/message group/i);
    expect(deps.processConversationJob).not.toHaveBeenCalled();
  });

  it('processes only the oldest pending job and wakes the next one', async () => {
    const jobs = INBOUND_IDS.map((inbound_message_id, index) => ({
      inbound_message_id,
      inbound_sequence: String(index + 1),
    }));
    const { pool, query } = fakePool({ jobs });
    const processConversationJob = vi.fn().mockResolvedValue(undefined);
    const sendContinuation = vi.fn().mockResolvedValue(undefined);

    await processQueueEvent(event(), context, {
      getPool: vi.fn().mockResolvedValue(pool),
      processConversationJob,
      sendContinuation,
      triggerDeferredReminder: vi.fn(),
      queueUrl: QUEUE_URL,
    });

    expect(processConversationJob.mock.calls.map(([id]) => id)).toEqual(INBOUND_IDS.slice(0, 1));
    expect(query.mock.calls.filter(([sql]) => /UPDATE turn_job/i.test(sql))).toHaveLength(1);
    expect(sendContinuation).toHaveBeenCalledWith({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({ inboundMessageId: INBOUND_IDS[1] }),
      MessageGroupId: PATIENT_ID,
      MessageDeduplicationId: 'wake:f1205f68-6b40-4bfb-9717-bd08c862b447:2',
    });
  });

  it('leaves the job pending and does not enqueue a continuation when processing fails', async () => {
    const { pool, query } = fakePool({
      jobs: [{ inbound_message_id: INBOUND_IDS[0], inbound_sequence: '1' }],
    });
    const error = new Error('classifier failed');
    const sendContinuation = vi.fn();

    await expect(
      processQueueEvent(event(), context, {
        getPool: vi.fn().mockResolvedValue(pool),
        processConversationJob: vi.fn().mockRejectedValue(error),
        sendContinuation,
        triggerDeferredReminder: vi.fn(),
        queueUrl: QUEUE_URL,
      }),
    ).rejects.toBe(error);

    expect(query.mock.calls.some(([sql]) => /UPDATE turn_job/i.test(sql))).toBe(false);
    expect(sendContinuation).not.toHaveBeenCalled();
  });

  it('fails closed when the pending job disappears before its completion mark', async () => {
    const { pool } = fakePool({
      jobs: [{ inbound_message_id: INBOUND_IDS[0], inbound_sequence: '1' }],
      markRowCount: 0,
    });
    const triggerDeferredReminder = vi.fn();

    await expect(
      processQueueEvent(event(), context, {
        getPool: vi.fn().mockResolvedValue(pool),
        processConversationJob: vi.fn().mockResolvedValue(undefined),
        sendContinuation: vi.fn(),
        triggerDeferredReminder,
        queueUrl: QUEUE_URL,
      }),
    ).rejects.toThrow(/disappeared/i);
    expect(triggerDeferredReminder).not.toHaveBeenCalled();
  });

  it('skips a replay when no incomplete job remains', async () => {
    const { pool } = fakePool({ jobs: [] });
    const processConversationJob = vi.fn();
    const sendContinuation = vi.fn();

    await expect(
      processQueueEvent(event(), context, {
        getPool: vi.fn().mockResolvedValue(pool),
        processConversationJob,
        sendContinuation,
        triggerDeferredReminder: vi.fn(),
        queueUrl: QUEUE_URL,
      }),
    ).resolves.toBeUndefined();
    expect(processConversationJob).not.toHaveBeenCalled();
    expect(sendContinuation).not.toHaveBeenCalled();
  });

  it('throws when the unique replacement wake cannot be enqueued', async () => {
    const jobs = INBOUND_IDS.map((inbound_message_id, index) => ({
      inbound_message_id,
      inbound_sequence: String(index + 1),
    }));
    const { pool } = fakePool({ jobs });
    const error = new Error('SQS unavailable');

    await expect(
      processQueueEvent(event(), context, {
        getPool: vi.fn().mockResolvedValue(pool),
        processConversationJob: vi.fn().mockResolvedValue(undefined),
        sendContinuation: vi.fn().mockRejectedValue(error),
        triggerDeferredReminder: vi.fn(),
        queueUrl: QUEUE_URL,
      }),
    ).rejects.toBe(error);
  });

  it('processes each pending turn once when a continuation was accepted but its response was lost', async () => {
    const jobs = INBOUND_IDS.slice(0, 2).map((inbound_message_id, index) => ({
      inbound_message_id,
      inbound_sequence: String(index + 1),
    }));
    const { pool } = fakePool({ jobs });
    const processConversationJob = vi.fn().mockResolvedValue(undefined);
    const acceptedThenLost = new Error('SQS response lost after acceptance');
    const sendContinuation = vi.fn().mockRejectedValueOnce(acceptedThenLost);
    const dependencies = {
      getPool: vi.fn().mockResolvedValue(pool),
      processConversationJob,
      sendContinuation,
      triggerDeferredReminder: vi.fn(),
      queueUrl: QUEUE_URL,
    };

    await expect(processQueueEvent(event(), context, dependencies)).rejects.toBe(acceptedThenLost);
    await expect(processQueueEvent(event(), context, dependencies)).resolves.toBeUndefined();
    await expect(
      processQueueEvent(
        event(INBOUND_IDS[1], PATIENT_ID, 'stale-continuation'),
        context,
        dependencies,
      ),
    ).resolves.toBeUndefined();

    expect(processConversationJob.mock.calls.map(([id]) => id)).toEqual(INBOUND_IDS.slice(0, 2));
    expect(sendContinuation).toHaveBeenCalledOnce();
  });
});

describe('conversation FIFO queue worker — H-04: re-evaluates the held reminder on turn completion', () => {
  function deps(overrides: Record<string, unknown> = {}) {
    const { pool, query } = fakePool({
      jobs: [{ inbound_message_id: INBOUND_IDS[0], inbound_sequence: '1' }],
    });
    return {
      query,
      getPool: vi.fn().mockResolvedValue(pool),
      processConversationJob: vi.fn().mockResolvedValue(undefined),
      sendContinuation: vi.fn(),
      triggerDeferredReminder: vi.fn().mockResolvedValue(undefined),
      queueUrl: QUEUE_URL,
      ...overrides,
    };
  }

  it('re-evaluates exactly once per completed turn, AFTER the job is marked complete', async () => {
    const dependencies = deps();
    await processQueueEvent(event(), context, dependencies);

    expect(dependencies.processConversationJob).toHaveBeenCalledOnce();
    expect(dependencies.triggerDeferredReminder).toHaveBeenCalledExactlyOnceWith(PATIENT_ID);

    // Order matters: the suppression predicate keys on `turn_job.completed_at IS NULL`, so evaluating
    // before the mark would re-suppress the very attempt this re-check exists to release.
    const markCall = dependencies.query.mock.calls.findIndex(([sql]) =>
      /UPDATE turn_job/i.test(String(sql)),
    );
    expect(markCall).toBeGreaterThanOrEqual(0);
    expect(dependencies.query.mock.invocationCallOrder[markCall]).toBeLessThan(
      dependencies.triggerDeferredReminder.mock.invocationCallOrder[0] as number,
    );
  });

  it('redrives a failed release after completion, including when replay has no pending job', async () => {
    const releaseFailure = new Error('outbound invoke response lost');
    const triggerDeferredReminder = vi
      .fn()
      .mockRejectedValueOnce(releaseFailure)
      .mockResolvedValueOnce(undefined);
    const dependencies = deps({
      triggerDeferredReminder,
    });

    await expect(processQueueEvent(event(), context, dependencies)).rejects.toBe(releaseFailure);
    await expect(processQueueEvent(event(), context, dependencies)).resolves.toBeUndefined();

    expect(dependencies.processConversationJob).toHaveBeenCalledOnce();
    expect(triggerDeferredReminder).toHaveBeenCalledTimes(2);
  });

  it('continues the patient FIFO after a durable reminder release fails while another turn is pending', async () => {
    const jobs = INBOUND_IDS.slice(0, 2).map((inbound_message_id, index) => ({
      inbound_message_id,
      inbound_sequence: String(index + 1),
    }));
    const { pool } = fakePool({ jobs });
    const releaseFailure = new Error('outbound invoke response lost');
    const triggerDeferredReminder = vi
      .fn()
      .mockRejectedValueOnce(releaseFailure)
      .mockResolvedValueOnce(undefined);
    const sendContinuation = vi.fn().mockResolvedValue(undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dependencies = {
      getPool: vi.fn().mockResolvedValue(pool),
      processConversationJob: vi.fn().mockResolvedValue(undefined),
      sendContinuation,
      triggerDeferredReminder,
      queueUrl: QUEUE_URL,
    };

    try {
      await expect(processQueueEvent(event(), context, dependencies)).resolves.toBeUndefined();
      await expect(
        processQueueEvent(
          event(INBOUND_IDS[1], PATIENT_ID, 'continued-turn'),
          context,
          dependencies,
        ),
      ).resolves.toBeUndefined();
      const serializedMetric = String(errorSpy.mock.calls[0]?.[0]);
      expect(JSON.parse(serializedMetric)).toEqual({
        metric: 'deferred_reminder_release_failed',
        errorName: 'Error',
      });
      expect(serializedMetric).not.toContain(PATIENT_ID);
      expect(serializedMetric).not.toContain(INBOUND_IDS[0]!);
      expect(serializedMetric).not.toContain(releaseFailure.message);
    } finally {
      errorSpy.mockRestore();
    }

    expect(dependencies.processConversationJob.mock.calls.map(([id]) => id)).toEqual(
      INBOUND_IDS.slice(0, 2),
    );
    expect(sendContinuation).toHaveBeenCalledOnce();
    expect(triggerDeferredReminder).toHaveBeenCalledTimes(2);
  });

  it('checks for a prepared release even when no turn completed in this invocation', async () => {
    const { pool } = fakePool({ jobs: [] }); // nothing pending
    const dependencies = deps({ getPool: vi.fn().mockResolvedValue(pool) });

    await processQueueEvent(event(), context, dependencies);
    expect(dependencies.triggerDeferredReminder).toHaveBeenCalledExactlyOnceWith(PATIENT_ID);
  });

  it('production wiring invokes Outbound with the exact prepared attempt after completion', async () => {
    let pending = true;
    productionProcessConversationJob.mockResolvedValue(undefined);
    lambdaSend.mockResolvedValue({});
    productionQuery.mockImplementation(async (sql: string) => {
      if (/FROM inbound_reply/i.test(sql) && !/dose_id/i.test(sql)) {
        return { rows: [{ patient_id: PATIENT_ID }], rowCount: 1 };
      }
      if (/FROM turn_job/i.test(sql)) {
        return pending
          ? {
              rows: [{ inbound_message_id: INBOUND_IDS[0], inbound_sequence: '1' }],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }
      if (/UPDATE turn_job/i.test(sql)) {
        pending = false;
        return { rows: [], rowCount: 1 };
      }
      if (/FROM outbound_message/i.test(sql)) {
        return { rows: [{ dose_id: DOSE_ID, reminder_attempt: 1 }], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await handler(event(), context as Context);

    expect(lambdaSend).toHaveBeenCalledOnce();
    const command = lambdaSend.mock.calls[0]?.[0] as {
      input: { FunctionName: string; InvocationType: string; Payload: Uint8Array };
    };
    expect(command.input.FunctionName).toBe(process.env.OUTBOUND_FN_ARN);
    expect(command.input.InvocationType).toBe('RequestResponse');
    expect(JSON.parse(new TextDecoder().decode(command.input.Payload))).toEqual({
      patientId: PATIENT_ID,
      doseId: DOSE_ID,
      reminderAttempt: 1,
    });
  });

  it('production wiring releases one latest prepared attempt for each distinct held dose', async () => {
    productionQuery.mockImplementation(async (sql: string) => {
      if (/FROM inbound_reply/i.test(sql) && !/dose_id/i.test(sql)) {
        return { rows: [{ patient_id: PATIENT_ID }], rowCount: 1 };
      }
      if (/FROM turn_job/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM outbound_message/i.test(sql)) {
        return {
          rows: [
            { dose_id: DOSE_ID, reminder_attempt: 2 },
            { dose_id: SECOND_DOSE_ID, reminder_attempt: 1 },
          ],
          rowCount: 2,
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    lambdaSend.mockResolvedValue({});

    await handler(event(), context as Context);

    expect(lambdaSend).toHaveBeenCalledTimes(2);
    const payloads = lambdaSend.mock.calls.map(([command]) =>
      JSON.parse(
        new TextDecoder().decode((command as { input: { Payload: Uint8Array } }).input.Payload),
      ),
    );
    expect(payloads).toEqual([
      { patientId: PATIENT_ID, doseId: DOSE_ID, reminderAttempt: 2 },
      { patientId: PATIENT_ID, doseId: SECOND_DOSE_ID, reminderAttempt: 1 },
    ]);
  });

  it('uses one bounded snapshot so a no-progress Outbound response cannot re-invoke a held dose', async () => {
    productionQuery.mockImplementation(async (sql: string) => {
      if (/FROM inbound_reply/i.test(sql) && !/dose_id/i.test(sql)) {
        return { rows: [{ patient_id: PATIENT_ID }], rowCount: 1 };
      }
      if (/FROM turn_job/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM outbound_message/i.test(sql)) {
        return { rows: [{ dose_id: DOSE_ID, reminder_attempt: 1 }], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    lambdaSend.mockResolvedValue({}); // Models Outbound standing down without advancing the held row.

    await handler(event(), context as Context);

    const reminderQueries = productionQuery.mock.calls.filter(([sql]) =>
      /FROM outbound_message/i.test(String(sql)),
    );
    expect(reminderQueries).toHaveLength(1);
    expect(reminderQueries[0]?.[0]).toMatch(/DISTINCT ON\s*\(dose_id\)/i);
    expect(reminderQueries[0]?.[0]).toMatch(/LIMIT\s+\$2/i);
    expect(reminderQueries[0]?.[1]).toEqual([PATIENT_ID, expect.any(Number)]);
    expect(lambdaSend).toHaveBeenCalledOnce();
  });

  it('fails for redrive after a bounded batch instead of silently stranding snapshot overflow', async () => {
    const preparedRows = Array.from({ length: 26 }, (_, index) => ({
      dose_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      reminder_attempt: 1,
    }));
    productionQuery.mockImplementation(async (sql: string) => {
      if (/FROM inbound_reply/i.test(sql) && !/dose_id/i.test(sql)) {
        return { rows: [{ patient_id: PATIENT_ID }], rowCount: 1 };
      }
      if (/FROM turn_job/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM outbound_message/i.test(sql)) {
        return { rows: preparedRows, rowCount: preparedRows.length };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    lambdaSend.mockResolvedValue({});

    await expect(handler(event(), context as Context)).rejects.toThrow(/batch limit/i);
    expect(lambdaSend).toHaveBeenCalledTimes(25);
    expect(
      productionQuery.mock.calls.filter(([sql]) => /FROM outbound_message/i.test(String(sql))),
    ).toHaveLength(1);
  });

  it('does not invoke Outbound twice when its accepted response is lost and replay finds the row advanced', async () => {
    let pending = true;
    let prepared = true;
    productionProcessConversationJob.mockResolvedValue(undefined);
    lambdaSend.mockImplementation(async () => {
      prepared = false; // Outbound atomically advanced prepared -> sending before the response was lost.
      throw new Error('Lambda response lost after acceptance');
    });
    productionQuery.mockImplementation(async (sql: string) => {
      if (/FROM inbound_reply/i.test(sql) && !/dose_id/i.test(sql)) {
        return { rows: [{ patient_id: PATIENT_ID }], rowCount: 1 };
      }
      if (/FROM turn_job/i.test(sql)) {
        return pending
          ? {
              rows: [{ inbound_message_id: INBOUND_IDS[0], inbound_sequence: '1' }],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }
      if (/UPDATE turn_job/i.test(sql)) {
        pending = false;
        return { rows: [], rowCount: 1 };
      }
      if (/FROM outbound_message/i.test(sql)) {
        return prepared
          ? { rows: [{ dose_id: DOSE_ID, reminder_attempt: 1 }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(handler(event(), context as Context)).rejects.toThrow(/response lost/i);
    await expect(handler(event(), context as Context)).resolves.toBeUndefined();

    expect(productionProcessConversationJob).toHaveBeenCalledOnce();
    expect(lambdaSend).toHaveBeenCalledOnce();
  });
});

describe('findDeferredReminders — releases only Scheduler-created held attempts (H-04)', () => {
  it('returns the latest exact prepared attempt per dose instead of synthesizing later attempts', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { dose_id: DOSE_ID, reminder_attempt: 2 },
        { dose_id: SECOND_DOSE_ID, reminder_attempt: 1 },
      ],
      rowCount: 2,
    });

    await expect(findDeferredReminders({ query } as unknown as Pool, PATIENT_ID)).resolves.toEqual([
      { patientId: PATIENT_ID, doseId: DOSE_ID, reminderAttempt: 2 },
      { patientId: PATIENT_ID, doseId: SECOND_DOSE_ID, reminderAttempt: 1 },
    ]);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([PATIENT_ID, expect.any(Number)]);
    expect(sql).toMatch(/message_kind\s*=\s*'reminder'/i);
    expect(sql).toMatch(/status\s*=\s*'prepared'/i);
    expect(sql).toMatch(/reminder_attempt/i);
    expect(sql).toMatch(/DISTINCT ON\s*\(dose_id\)/i);
    expect(sql).toMatch(/ORDER BY dose_id, reminder_attempt DESC/i);
    expect(sql).toMatch(/LIMIT\s+\$2/i);
    expect(sql).not.toMatch(/count\s*\(/i);
    expect(sql).not.toMatch(/RESPONSE_WINDOW_MINUTES/i);
  });

  it('returns an empty snapshot when a turn completes before its Scheduler attempt exists', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(findDeferredReminders({ query } as unknown as Pool, PATIENT_ID)).resolves.toEqual(
      [],
    );
  });
});
