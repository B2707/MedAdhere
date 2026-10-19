import { describe, expect, it } from 'vitest';
import { conversationTurnInputSchema } from '@medadhere/shared';
import { buildConversationRunnerScenarios } from './conversation-input.js';
import {
  buildAnthropicClinicalMemoryTurnPreflight,
  CLINICAL_MEMORY_MAX_SERIALIZED_REQUEST_BYTES,
} from './conversation-clinical-memory-provider.js';
import { SONNET_CANDIDATE_CONFIGS } from './conversation-runner.js';
import { loadConversationScenarioCorpus } from './conversation-scenarios.js';

describe('buildConversationRunnerScenarios', () => {
  const corpus = loadConversationScenarioCorpus();

  it('builds every development and holdout patient turn into the strict shared input', () => {
    for (const document of [corpus.dev, corpus.holdout]) {
      for (const scenario of buildConversationRunnerScenarios(document.scenarios)) {
        for (const turn of scenario.turns) {
          expect(conversationTurnInputSchema.safeParse(turn.payload.turnInput).success).toBe(true);
          expect(turn.payload.turnInput.promptVersion).toBe('conversation-v24');
          expect(turn.payload.turnInput.schemaVersion).toBe('conversation-v2');
          expect(turn.payload.turnInput.promptedDoseId).toBeNull();
          expect(turn.payload.turnInput.drugInteractions).toEqual([]);
          expect(turn.payload.turnInput.currentMessage.id).toBe(turn.turnId);
          expect(turn.payload.turnInput.currentMessage.direction).toBe('inbound');
          expect(JSON.stringify(turn.payload.turnInput)).not.toContain('expectedAction');
          expect(JSON.stringify(turn.payload.turnInput)).not.toContain('requiredConcepts');
        }
      }
    }
  });

  it('includes only messages before the current turn and preserves their directions', () => {
    const scenario = buildConversationRunnerScenarios([corpus.dev.scenarios[0]!])[0]!;
    expect(scenario.turns[0]!.payload.turnInput.currentDayMessages).toEqual([]);
    expect(
      scenario.turns[1]!.payload.turnInput.currentDayMessages.map(({ direction }) => direction),
    ).toEqual(['inbound', 'outbound']);
  });

  it('labels prior reference replies with the scenario language', () => {
    const french = corpus.dev.scenarios.find((scenario) => scenario.primaryLanguage === 'fr')!;
    const scenario = buildConversationRunnerScenarios([french])[0]!;
    expect(scenario.turns[1]!.payload.turnInput.currentDayMessages[1]).toEqual(
      expect.objectContaining({ direction: 'outbound', language: 'fr' }),
    );
  });

  it('preserves reviewed symptom identities for recurrence memory', () => {
    const expected = new Map([
      ['conv-dev-007', 'headache'],
      ['conv-dev-008', 'nausea'],
      ['conv-dev-009', 'dizziness'],
      ['conv-dev-010', 'headache'],
      ['conv-dev-011', 'nausea'],
      ['conv-dev-012', 'dizziness'],
    ]);

    for (const [scenarioId, normalizedValue] of expected) {
      const fixture = corpus.dev.scenarios.find(({ id }) => id === scenarioId)!;
      const scenario = buildConversationRunnerScenarios([fixture])[0]!;
      expect(scenario.turns[0]!.payload.turnInput.recentObservations[0]?.normalizedValue).toBe(
        normalizedValue,
      );
    }
  });

  it('makes evidence unavailable on the first one-call turn and available on the next turn', () => {
    const fixture = corpus.dev.scenarios.find((scenario) =>
      scenario.hardGates.includes('one_call_next_turn_retrieval'),
    )!;
    const scenario = buildConversationRunnerScenarios([fixture])[0]!;
    expect(scenario.turns[0]!.payload.turnInput.evidence).toEqual([]);
    expect(
      scenario.turns[1]!.payload.turnInput.evidence.map(({ evidenceId }) => evidenceId),
    ).toEqual(['medlineplus-dizziness-v1']);
  });

  it('retains deterministic emergency and STOP turns but marks them provider-ineligible', () => {
    const fixed = corpus.holdout.scenarios.filter((scenario) =>
      scenario.categories.some((category) => category === 'emergency' || category === 'stop'),
    );
    const turns = buildConversationRunnerScenarios(fixed).flatMap((scenario) => scenario.turns);
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.every((turn) => turn.eligibleForProvider === false)).toBe(true);
  });

  it('keeps every eligible corpus request under the clinical-memory byte preflight', () => {
    const candidate = SONNET_CANDIDATE_CONFIGS[0]!;
    let largestRequest = 0;

    for (const document of [corpus.dev, corpus.holdout]) {
      for (const scenario of buildConversationRunnerScenarios(document.scenarios)) {
        for (const turn of scenario.turns.filter(
          ({ eligibleForProvider }) => eligibleForProvider,
        )) {
          const request = buildAnthropicClinicalMemoryTurnPreflight(
            {
              model: candidate.model,
              thinking: candidate.thinking,
              effort: candidate.effort,
              interpretationMaxTokens: candidate.maxTokens,
            },
            turn.payload.turnInput,
          );
          expect(request.interpretationSerializedUtf8Bytes).toBeLessThanOrEqual(
            CLINICAL_MEMORY_MAX_SERIALIZED_REQUEST_BYTES,
          );
          largestRequest = Math.max(largestRequest, request.interpretationSerializedUtf8Bytes);
        }
      }
    }

    expect(largestRequest).toBeLessThanOrEqual(CLINICAL_MEMORY_MAX_SERIALIZED_REQUEST_BYTES);
  });
});
