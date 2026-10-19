import type { ConversationObservation } from '@medadhere/shared';

/**
 * Central identity defaults for conversation observations built by the eval
 * tests. Spread this first in an observation literal and override only the
 * fields a case actually exercises.
 *
 * Both identity fields default to `null` because these fixtures stand in for
 * model-produced observations: `conversationTurnResultSchema` rejects a turn
 * result whose observation already claims a persisted `clinicalEventId`, and
 * only `correction` observations may set `supersedesClinicalEventId`.
 *
 * Persisted prior-day context is different — `buildConversationRunnerScenarios`
 * carries the corpus id through as `clinicalEventId` so a later correction can
 * supersede it.
 *
 * When `conversationObservationSchema` gains a field, add it here once rather
 * than in each test literal.
 */
export const CONVERSATION_OBSERVATION_DEFAULTS = {
  clinicalEventId: null,
  supersedesClinicalEventId: null,
} as const satisfies Partial<ConversationObservation>;
