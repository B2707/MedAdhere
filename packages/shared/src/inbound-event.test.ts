import { describe, expect, it } from 'vitest';
import {
  buildContinuationInboundReplyWake,
  buildInitialInboundReplyWake,
  inboundReplyWakeSchema,
  parseInboundReplyWake,
  serializeInboundReplyWake,
} from './inbound-event.js';

const INBOUND_ID = '7c9e6679-7425-40de-963d-02d4f4a986e1';
const PATIENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/turns.fifo';

describe('inbound reply FIFO wake contract', () => {
  it('serializes and parses exactly one UUID-only inbound identifier', () => {
    const body = serializeInboundReplyWake({ inboundMessageId: INBOUND_ID });

    expect(body).toBe(JSON.stringify({ inboundMessageId: INBOUND_ID }));
    expect(parseInboundReplyWake(body)).toEqual({ inboundMessageId: INBOUND_ID });
    expect(Object.keys(JSON.parse(body) as Record<string, unknown>)).toEqual(['inboundMessageId']);
  });

  it('rejects malformed JSON, non-UUID identifiers, and every extra field', () => {
    expect(() => parseInboundReplyWake('{')).toThrow();
    expect(() =>
      parseInboundReplyWake(JSON.stringify({ inboundMessageId: 'not-a-uuid' })),
    ).toThrow();
    expect(() =>
      parseInboundReplyWake(
        JSON.stringify({ inboundMessageId: INBOUND_ID, rawBody: 'must never ride SQS' }),
      ),
    ).toThrow();
    expect(() =>
      inboundReplyWakeSchema.parse({ inboundMessageId: INBOUND_ID, patientId: PATIENT_ID }),
    ).toThrow();
  });
});

describe('inbound reply FIFO SendMessage input builders', () => {
  it('builds an initial SID-deduplicated wake in the patient message group', () => {
    expect(
      buildInitialInboundReplyWake({
        queueUrl: QUEUE_URL,
        patientId: PATIENT_ID,
        inboundMessageId: INBOUND_ID,
        messageSid: 'SM0123456789abcdef0123456789abcdef',
      }),
    ).toEqual({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({ inboundMessageId: INBOUND_ID }),
      MessageGroupId: PATIENT_ID,
      MessageDeduplicationId: 'sid:SM0123456789abcdef0123456789abcdef',
    });
  });

  it('builds a unique continuation wake from the consumed SQS message and next sequence', () => {
    expect(
      buildContinuationInboundReplyWake({
        queueUrl: QUEUE_URL,
        patientId: PATIENT_ID,
        inboundMessageId: INBOUND_ID,
        currentMessageId: 'c9f36ee5-5e55-4cc4-a81b-7617cb36e8fe',
        inboundSequence: '42',
      }),
    ).toEqual({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({ inboundMessageId: INBOUND_ID }),
      MessageGroupId: PATIENT_ID,
      MessageDeduplicationId: 'wake:c9f36ee5-5e55-4cc4-a81b-7617cb36e8fe:42',
    });
  });

  it('rejects invalid groups, sequences, URLs, and deduplication IDs over the SQS limit', () => {
    expect(() =>
      buildInitialInboundReplyWake({
        queueUrl: 'not-a-url',
        patientId: PATIENT_ID,
        inboundMessageId: INBOUND_ID,
        messageSid: 'SM-valid',
      }),
    ).toThrow();
    expect(() =>
      buildContinuationInboundReplyWake({
        queueUrl: QUEUE_URL,
        patientId: 'not-a-uuid',
        inboundMessageId: INBOUND_ID,
        currentMessageId: 'message-id',
        inboundSequence: '1',
      }),
    ).toThrow();
    expect(() =>
      buildContinuationInboundReplyWake({
        queueUrl: QUEUE_URL,
        patientId: PATIENT_ID,
        inboundMessageId: INBOUND_ID,
        currentMessageId: 'message-id',
        inboundSequence: '0',
      }),
    ).toThrow();
    expect(() =>
      buildInitialInboundReplyWake({
        queueUrl: QUEUE_URL,
        patientId: PATIENT_ID,
        inboundMessageId: INBOUND_ID,
        messageSid: `SM${'x'.repeat(125)}`,
      }),
    ).toThrow();
  });
});
