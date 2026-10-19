import { describe, expect, it } from 'vitest';
import { conversationClarificationTopicSchema } from '@medadhere/shared';
import { needFieldSchema } from './clinical-memory/contracts.js';
import { boundedExtractionStageRecordSchema } from './runtime-repository.js';

const record = {
  modelId: 'claude-sonnet-5',
  promptVersion: 'clinical-extractor-v1',
  schemaVersion: 'clinical-extraction-v2',
  schemaSha256: 'a'.repeat(64),
  contextHash: '0'.repeat(64),
  inputTokens: 120,
  outputTokens: 40,
  latencyMs: 500,
  stage: 'interpretation',
  output: { claims: [] },
} as const;

describe('strict persisted bounded extraction checkpoint', () => {
  it('accepts the complete bounded wrapper and rejects unknown properties', () => {
    expect(boundedExtractionStageRecordSchema.parse(record)).toEqual(record);
    expect(() =>
      boundedExtractionStageRecordSchema.parse({ ...record, rawResponse: 'secret' }),
    ).toThrow();
  });

  it('rejects malformed usage, hashes, and legacy writer output', () => {
    expect(() =>
      boundedExtractionStageRecordSchema.parse({
        ...record,
        contextHash: 'not-a-hash',
        inputTokens: -1,
      }),
    ).toThrow();
    expect(() =>
      boundedExtractionStageRecordSchema.parse({
        ...record,
        stage: 'writer',
        output: { acknowledgementTemplateId: 'received-update' },
      }),
    ).toThrow();
  });
});

// repository.ts writes the RAW NeedField into outbound_message.clarification_topic, and
// runtime-repository.ts parses that column UNCONDITIONALLY on every turn load. A NeedField the
// DB CHECK accepts but the shared read enum does not wedges the patient's FIFO queue: the parse
// throws, processClinicalMemoryJobCore does not catch it, SQS retries the same message forever
// and every LATER message for that patient is blocked behind it. This pins the two vocabularies
// together so the next NeedField addition fails here instead of in production.
describe('clarification_topic read enum covers every NeedField that is written to it', () => {
  it('parses every NeedField as a conversation clarification topic', () => {
    for (const field of needFieldSchema.options) {
      expect(
        conversationClarificationTopicSchema.safeParse(field),
        `NeedField '${field}' is unparseable as a clarification topic`,
      ).toMatchObject({ success: true });
    }
  });
});
