import type { ConversationTurnInput, ConversationTurnResult } from '@medadhere/shared';
import type { ConversationMetricId } from './conversation-metrics.js';

export const CONVERSATION_MAX_INPUT_TOKENS_PER_CALL = 12_000;

export interface ConversationEvalProviderPayload<TExpectation> {
  readonly turnInput: ConversationTurnInput;
  readonly expectation: TExpectation;
}

export type ConversationResultScorer<TExpectation> = (
  expectation: TExpectation,
  result: ConversationTurnResult,
) => Partial<Record<ConversationMetricId, boolean>>;
