import { z } from 'zod';

export const inboundReplyWakeSchema = z
  .object({
    inboundMessageId: z.string().uuid(),
  })
  .strict();

export type InboundReplyWake = z.infer<typeof inboundReplyWakeSchema>;

const sendMessageInputSchema = z
  .object({
    QueueUrl: z.string().url(),
    MessageBody: z.string().min(1),
    MessageGroupId: z.string().uuid(),
    MessageDeduplicationId: z.string().min(1).max(128),
  })
  .strict();

export type InboundReplyWakeSendMessageInput = z.infer<typeof sendMessageInputSchema>;

const initialWakeInputSchema = z
  .object({
    queueUrl: z.string().url(),
    patientId: z.string().uuid(),
    inboundMessageId: z.string().uuid(),
    messageSid: z.string().min(1),
  })
  .strict();

const continuationWakeInputSchema = z
  .object({
    queueUrl: z.string().url(),
    patientId: z.string().uuid(),
    inboundMessageId: z.string().uuid(),
    currentMessageId: z.string().min(1),
    inboundSequence: z.string().regex(/^[1-9]\d*$/),
  })
  .strict();

export type InitialInboundReplyWakeInput = z.infer<typeof initialWakeInputSchema>;
export type ContinuationInboundReplyWakeInput = z.infer<typeof continuationWakeInputSchema>;

export function serializeInboundReplyWake(wake: InboundReplyWake): string {
  return JSON.stringify(inboundReplyWakeSchema.parse(wake));
}

export function parseInboundReplyWake(body: string): InboundReplyWake {
  return inboundReplyWakeSchema.parse(JSON.parse(body) as unknown);
}

export function buildInitialInboundReplyWake(
  input: InitialInboundReplyWakeInput,
): InboundReplyWakeSendMessageInput {
  const parsed = initialWakeInputSchema.parse(input);
  return sendMessageInputSchema.parse({
    QueueUrl: parsed.queueUrl,
    MessageBody: serializeInboundReplyWake({ inboundMessageId: parsed.inboundMessageId }),
    MessageGroupId: parsed.patientId,
    MessageDeduplicationId: `sid:${parsed.messageSid}`,
  });
}

export function buildContinuationInboundReplyWake(
  input: ContinuationInboundReplyWakeInput,
): InboundReplyWakeSendMessageInput {
  const parsed = continuationWakeInputSchema.parse(input);
  return sendMessageInputSchema.parse({
    QueueUrl: parsed.queueUrl,
    MessageBody: serializeInboundReplyWake({ inboundMessageId: parsed.inboundMessageId }),
    MessageGroupId: parsed.patientId,
    MessageDeduplicationId: `wake:${parsed.currentMessageId}:${parsed.inboundSequence}`,
  });
}
