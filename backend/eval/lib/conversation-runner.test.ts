import { describe, expect, it } from 'vitest';
import type { ConversationTurnResult } from '@medadhere/shared';
import {
  ConversationProviderTransportError,
  ConversationRunnerFatalError,
  PINNED_SONNET_CONFIG_ID,
  SONNET_CANDIDATE_CONFIGS,
  runConversationScenarios,
  type ConversationProvider,
  type ConversationRunnerScenario,
  type ConversationScenarioBoundary,
} from './conversation-runner.js';

interface TestPayload {
  readonly body: string;
}

function turnResult(meaning: string): ConversationTurnResult {
  return {
    detectedLanguage: 'en',
    languageConfidence: 1,
    mixedLanguage: false,
    translationUncertain: false,
    normalizedEnglishMeaning: meaning,
    adherenceClassification: null,
    observations: [],
    temporalCandidateIds: [],
    action: { type: 'complete_turn' },
    socialAcknowledgement: 'Thanks, I noted that.',
    clinicalClaim: null,
    clinicianReviewDraft: {
      patientStatements: [],
      establishedFactIds: [],
      inferences: [],
      uncertainties: [],
      evidenceIds: [],
      proposedCorrections: [],
    },
    selectedEvidenceIds: [],
    safetyCandidate: 'routine',
  };
}

function scenario(
  scenarioId: string,
  turns: ReadonlyArray<{
    readonly turnId: string;
    readonly body: string;
    readonly eligibleForProvider?: boolean;
  }>,
): ConversationRunnerScenario<TestPayload> {
  return {
    scenarioId,
    turns: turns.map((turn) => ({
      turnId: turn.turnId,
      eligibleForProvider: turn.eligibleForProvider ?? true,
      payload: { body: turn.body },
    })),
  };
}

describe('Sonnet conversation-eval candidates', () => {
  it('declares exactly the disabled and explicit adaptive-effort candidates without a v2 pin', () => {
    expect(SONNET_CANDIDATE_CONFIGS).toEqual([
      {
        id: 'thinking_disabled',
        model: 'claude-sonnet-5',
        thinking: { type: 'disabled' },
        effort: null,
        maxTokens: 4096,
      },
      {
        id: 'adaptive_high',
        model: 'claude-sonnet-5',
        thinking: { type: 'adaptive' },
        effort: 'high',
        maxTokens: 8192,
      },
    ]);
    expect(PINNED_SONNET_CONFIG_ID).toBeNull();
  });
});

describe('runConversationScenarios', () => {
  it('aborts immediately on a fatal configuration or provider error', async () => {
    const calls: string[] = [];
    const provider: ConversationProvider<TestPayload> = async (request) => {
      calls.push(request.turnId);
      throw new ConversationRunnerFatalError('invalid live configuration');
    };

    await expect(
      runConversationScenarios(
        [
          scenario('s1', [
            { turnId: 't1', body: 'one' },
            { turnId: 't2', body: 'two' },
          ]),
        ],
        provider,
        { candidateConfigId: 'thinking_disabled' },
      ),
    ).rejects.toBeInstanceOf(ConversationRunnerFatalError);
    expect(calls).toEqual(['t1']);
  });

  it('processes every scenario and eligible turn sequentially and calls each exactly once', async () => {
    const events: string[] = [];
    const calls = new Map<string, number>();
    const provider: ConversationProvider<TestPayload> = async (request) => {
      const key = `${request.scenarioId}:${request.turnId}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);
      events.push(`${key}:start`);
      await new Promise((resolve) => setTimeout(resolve, 2));
      events.push(`${key}:end`);
      return { outcome: 'completed', metricSuccesses: {} };
    };

    await runConversationScenarios(
      [
        scenario('s1', [
          { turnId: 't1', body: 'one' },
          { turnId: 't2', body: 'two' },
          { turnId: 't3', body: 'three', eligibleForProvider: false },
        ]),
        scenario('s2', [{ turnId: 't1', body: 'four' }]),
      ],
      provider,
      { candidateConfigId: 'thinking_disabled' },
    );

    expect(events).toEqual([
      's1:t1:start',
      's1:t1:end',
      's1:t2:start',
      's1:t2:end',
      's2:t1:start',
      's2:t1:end',
    ]);
    expect(Object.fromEntries(calls)).toEqual({ 's1:t1': 1, 's1:t2': 1, 's2:t1': 1 });
  });

  it('reports an immutable boundary after each scenario for durable checkpointing', async () => {
    const boundaries: Array<{ scenarioId: string; completed: boolean; resultCount: number }> = [];
    const provider: ConversationProvider<TestPayload> = async (request) =>
      request.scenarioId === 'failed'
        ? { outcome: 'malformed', metricSuccesses: {} }
        : {
            outcome: 'completed',
            metricSuccesses: {},
            turnResult: turnResult(request.turnId),
          };

    await runConversationScenarios(
      [
        scenario('complete', [{ turnId: 't1', body: 'one' }]),
        scenario('failed', [
          { turnId: 't2', body: 'two' },
          { turnId: 't3', body: 'three' },
        ]),
      ],
      provider,
      {
        candidateConfigId: 'thinking_disabled',
        onScenarioComplete: ({ scenarioId, completed, results }: ConversationScenarioBoundary) => {
          boundaries.push({ scenarioId, completed, resultCount: results.length });
          expect(Object.isFrozen(results)).toBe(true);
        },
      } as never,
    );

    expect(boundaries).toEqual([
      { scenarioId: 'complete', completed: true, resultCount: 1 },
      { scenarioId: 'failed', completed: false, resultCount: 1 },
    ]);
  });

  it('passes immutable completed turn results to later turns in chronological order', async () => {
    const first = turnResult('first');
    const second = turnResult('second');
    const snapshots: Array<readonly ConversationTurnResult[]> = [];
    const provider: ConversationProvider<TestPayload> = async (request) => {
      snapshots.push(request.priorTurnResults);
      if (request.turnId === 't1') {
        return { outcome: 'completed', metricSuccesses: {}, turnResult: first };
      }
      if (request.turnId === 't2') {
        return { outcome: 'completed', metricSuccesses: {}, turnResult: second };
      }
      return { outcome: 'completed', metricSuccesses: {} };
    };

    const output = await runConversationScenarios(
      [
        scenario('s1', [
          { turnId: 't1', body: 'first' },
          { turnId: 't2', body: 'second' },
          { turnId: 't3', body: 'completed without result' },
        ]),
        scenario('s2', [{ turnId: 't4', body: 'new scenario' }]),
      ],
      provider,
      {
        candidateConfigId: 'adaptive_high',
      },
    );

    expect(snapshots).toEqual([[], [first], [first, second], []]);
    expect(snapshots[0]).toEqual([]);
    expect(output.results.map(({ outcome }) => outcome)).toEqual(Array(4).fill('completed'));
    expect(JSON.stringify(output)).not.toContain('normalizedEnglishMeaning');
    expect(JSON.stringify(output)).not.toContain('second');
  });

  it.each(['refused', 'truncated', 'malformed'] as const)(
    'stops a scenario after a %s result without invoking its downstream gold turn',
    async (outcome) => {
      const calls: string[] = [];
      const snapshots: Array<readonly ConversationTurnResult[]> = [];
      const provider: ConversationProvider<TestPayload> = async (request) => {
        calls.push(`${request.scenarioId}:${request.turnId}:${request.payload.body}`);
        snapshots.push(request.priorTurnResults);
        if (request.scenarioId === 's1') return { outcome, metricSuccesses: {} };
        return { outcome: 'completed', metricSuccesses: {} };
      };

      const output = await runConversationScenarios(
        [
          scenario('s1', [
            { turnId: 'failed', body: 'first patient turn' },
            { turnId: 'gold', body: 'GOLD DOWNSTREAM TURN MUST NOT RUN' },
          ]),
          scenario('s2', [{ turnId: 'fresh', body: 'independent scenario' }]),
        ],
        provider,
        { candidateConfigId: 'thinking_disabled' },
      );

      expect(calls).toEqual(['s1:failed:first patient turn', 's2:fresh:independent scenario']);
      expect(snapshots).toEqual([[], []]);
      expect(
        output.results.map(({ turnId, outcome: resultOutcome }) => [turnId, resultOutcome]),
      ).toEqual([
        ['failed', outcome],
        ['fresh', 'completed'],
      ]);
      expect(JSON.stringify(output)).not.toContain('GOLD DOWNSTREAM TURN MUST NOT RUN');
    },
  );

  it.each([
    ['timeout', 'TimeoutError', 'timeout'],
    ['provider error', 'Error', 'provider_error'],
  ] as const)(
    'stops a scenario after a %s exception and starts the next scenario with clean history',
    async (_label, errorName, expectedOutcome) => {
      const calls: string[] = [];
      const snapshots: Array<readonly ConversationTurnResult[]> = [];
      const provider: ConversationProvider<TestPayload> = async (request) => {
        calls.push(`${request.scenarioId}:${request.turnId}`);
        snapshots.push(request.priorTurnResults);
        if (request.scenarioId === 's1') {
          const error = new Error('private provider failure');
          error.name = errorName;
          throw error;
        }
        return { outcome: 'completed', metricSuccesses: {} };
      };

      const output = await runConversationScenarios(
        [
          scenario('s1', [
            { turnId: 'failed', body: 'first patient turn' },
            { turnId: 'gold', body: 'GOLD DOWNSTREAM TURN MUST NOT RUN' },
          ]),
          scenario('s2', [{ turnId: 'fresh', body: 'independent scenario' }]),
        ],
        provider,
        { candidateConfigId: 'thinking_disabled' },
      );

      expect(calls).toEqual(['s1:failed', 's2:fresh']);
      expect(snapshots).toEqual([[], []]);
      expect(output.results.map(({ turnId, outcome }) => [turnId, outcome])).toEqual([
        ['failed', expectedOutcome],
        ['fresh', 'completed'],
      ]);
      expect(JSON.stringify(output)).not.toContain('GOLD DOWNSTREAM TURN MUST NOT RUN');
      expect(JSON.stringify(output)).not.toContain('private provider failure');
    },
  );

  it('returns only allowlisted IDs, outcomes, metric booleans, and numeric telemetry', async () => {
    const sentinel = 'private-patient-message-zzqx';
    const provider = (async () => ({
      outcome: 'completed',
      metricSuccesses: {
        structured_output_validity: true,
        invented_metric: true,
        malformed_value: 'yes',
      },
      latencyMs: 12,
      inputTokens: 40,
      outputTokens: 8,
      cacheCreationInputTokens: 7,
      cacheReadInputTokens: 6,
      thinkingTokens: 5,
      modelCalls: 1.5,
      modelText: `model-prose-${sentinel}`,
      message: sentinel,
      malformedStage: 'zod_validation',
      malformedIssues: [{ path: sentinel, code: sentinel }],
    })) as unknown as ConversationProvider<TestPayload>;

    const output = await runConversationScenarios(
      [scenario('s1', [{ turnId: 't1', body: sentinel }])],
      provider,
      { candidateConfigId: 'thinking_disabled' },
    );
    const serialized = JSON.stringify(output);

    expect(output.results).toEqual([
      {
        scenarioId: 's1',
        turnId: 't1',
        outcome: 'completed',
        metricSuccesses: { structured_output_validity: true },
        latencyMs: 12,
        inputTokens: 40,
        outputTokens: 8,
        cacheCreationInputTokens: 7,
        cacheReadInputTokens: 6,
        thinkingTokens: 5,
      },
    ]);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain('modelText');
    expect(serialized).not.toContain('invented_metric');
    expect(serialized).not.toContain('malformed_value');
  });

  it('keeps only typed action and model-stage diagnostics', async () => {
    const provider: ConversationProvider<TestPayload> = async (request) =>
      request.turnId === 'completed'
        ? {
            outcome: 'completed',
            metricSuccesses: {},
            turnResult: {
              ...turnResult('needs a time'),
              action: {
                type: 'ask_clarification',
                clarification: 'About what time?',
                clarificationTopic: 'dose_time',
              },
            },
          }
        : {
            outcome: 'malformed',
            metricSuccesses: {},
            modelStage: 'writer',
          };

    const output = await runConversationScenarios(
      [
        scenario('s1', [{ turnId: 'completed', body: 'first' }]),
        scenario('s2', [{ turnId: 'malformed', body: 'second' }]),
      ],
      provider,
      { candidateConfigId: 'thinking_disabled' },
    );

    expect(output.results).toEqual([
      expect.objectContaining({
        actionType: 'ask_clarification',
        clarificationTopic: 'dose_time',
      }),
      expect.objectContaining({ outcome: 'malformed', modelStage: 'writer' }),
    ]);
  });

  it('bounds, deduplicates, and allowlists malformed Zod diagnostics', async () => {
    const sentinel = 'private-zod-message-zzqx';
    const issues = [
      {
        path: 'clinicalClaim.type',
        code: 'invalid_union_discriminator',
        message: sentinel,
        receivedValue: sentinel,
      },
      { path: 'clinicalClaim.type', code: 'invalid_union_discriminator' },
      ...Array.from({ length: 30 }, (_, index) => ({
        path: `observations.${index}.severity`,
        code: 'invalid_type',
      })),
      { path: sentinel, code: sentinel },
    ];
    const provider = (async () => ({
      outcome: 'malformed',
      metricSuccesses: {},
      malformedStage: 'zod_validation',
      malformedIssues: issues,
      modelText: sentinel,
    })) as unknown as ConversationProvider<TestPayload>;

    const output = await runConversationScenarios(
      [scenario('s1', [{ turnId: 't1', body: sentinel }])],
      provider,
      { candidateConfigId: 'thinking_disabled' },
    );

    expect(output.results[0]).toMatchObject({
      outcome: 'malformed',
      malformedStage: 'zod_validation',
    });
    expect(output.results[0]!.malformedIssues![0]).toEqual({
      path: 'clinicalClaim.type',
      code: 'invalid_union_discriminator',
    });
    expect(output.results[0]!.malformedIssues).toHaveLength(20);
    expect(JSON.stringify(output)).not.toContain(sentinel);
    expect(Object.keys(output.results[0]!.malformedIssues![0]!)).toEqual(['path', 'code']);
  });

  it('maps timeout and provider exceptions without prose and continues with later scenarios', async () => {
    const provider: ConversationProvider<TestPayload> = async (request) => {
      if (request.turnId === 'timeout') {
        const error = new Error('echoed patient sentinel timeout-zzqx');
        error.name = 'TimeoutError';
        throw error;
      }
      if (request.turnId === 'provider') {
        throw new Error('echoed patient sentinel provider-zzqx');
      }
      return { outcome: 'completed', metricSuccesses: {} };
    };

    const output = await runConversationScenarios(
      [
        scenario('s1', [{ turnId: 'timeout', body: 'first private message' }]),
        scenario('s2', [{ turnId: 'provider', body: 'second private message' }]),
        scenario('s3', [{ turnId: 'completed', body: 'third private message' }]),
      ],
      provider,
      { candidateConfigId: 'thinking_disabled' },
    );

    expect(output.results.map(({ turnId, outcome }) => ({ turnId, outcome }))).toEqual([
      { turnId: 'timeout', outcome: 'timeout' },
      { turnId: 'provider', outcome: 'provider_error' },
      { turnId: 'completed', outcome: 'completed' },
    ]);
    expect(JSON.stringify(output)).not.toContain('zzqx');
    expect(JSON.stringify(output)).not.toContain('Error');
  });

  it('preserves only allowlisted transport diagnostics and continues with later scenarios', async () => {
    const provider: ConversationProvider<TestPayload> = async (request) => {
      if (request.scenarioId === 's1') {
        throw new ConversationProviderTransportError({
          modelStage: 'writer',
          operation: 'messages_create',
          errorClass: 'api_connection',
          causeCode: 'UND_ERR_SOCKET',
        });
      }
      return { outcome: 'completed', metricSuccesses: {} };
    };

    const output = await runConversationScenarios(
      [
        scenario('s1', [{ turnId: 'failed', body: 'private first message' }]),
        scenario('s2', [{ turnId: 'fresh', body: 'private second message' }]),
      ],
      provider,
      { candidateConfigId: 'thinking_disabled' },
    );

    expect(output.results).toEqual([
      {
        scenarioId: 's1',
        turnId: 'failed',
        outcome: 'provider_error',
        metricSuccesses: {},
        modelStage: 'writer',
        transportDiagnostic: {
          operation: 'messages_create',
          errorClass: 'api_connection',
          causeCode: 'UND_ERR_SOCKET',
        },
      },
      {
        scenarioId: 's2',
        turnId: 'fresh',
        outcome: 'completed',
        metricSuccesses: {},
      },
    ]);
  });

  it.each(['refused', 'truncated', 'malformed'] as const)(
    'preserves the provider %s outcome without parsing model prose',
    async (outcome) => {
      const provider: ConversationProvider<TestPayload> = async () => ({
        outcome,
        metricSuccesses: { structured_output_validity: true },
      });

      const output = await runConversationScenarios(
        [scenario('s1', [{ turnId: 't1', body: 'private' }])],
        provider,
        { candidateConfigId: 'thinking_disabled' },
      );

      expect(output.results[0]).toEqual({
        scenarioId: 's1',
        turnId: 't1',
        outcome,
        metricSuccesses: { structured_output_validity: true },
      });
    },
  );

  it('maps an invalid provider outcome to malformed', async () => {
    const provider = (async () => ({
      outcome: 'surprise',
      metricSuccesses: { structured_output_validity: true },
    })) as unknown as ConversationProvider<TestPayload>;

    const output = await runConversationScenarios(
      [scenario('s1', [{ turnId: 't1', body: 'private' }])],
      provider,
      { candidateConfigId: 'thinking_disabled' },
    );

    expect(output.results).toEqual([
      {
        scenarioId: 's1',
        turnId: 't1',
        outcome: 'malformed',
        metricSuccesses: {},
      },
    ]);
  });

  it('rejects duplicate IDs before making a provider call', async () => {
    let calls = 0;
    const provider: ConversationProvider<TestPayload> = async () => {
      calls += 1;
      return { outcome: 'completed', metricSuccesses: {} };
    };
    const duplicatedScenario = scenario('s1', [
      { turnId: 't1', body: 'one' },
      { turnId: 't1', body: 'two' },
    ]);

    await expect(
      runConversationScenarios([duplicatedScenario], provider, {
        candidateConfigId: 'thinking_disabled',
      }),
    ).rejects.toThrow(/duplicate.*s1:t1/i);
    expect(calls).toBe(0);
  });

  it('rejects an unknown candidate configuration before provider work', async () => {
    let calls = 0;
    const provider: ConversationProvider<TestPayload> = async () => {
      calls += 1;
      return { outcome: 'completed', metricSuccesses: {} };
    };

    await expect(
      runConversationScenarios(
        [scenario('s1', [{ turnId: 't1', body: 'one' }])],
        provider,
        // @ts-expect-error deliberate runtime-boundary violation
        { candidateConfigId: 'unknown_candidate' },
      ),
    ).rejects.toThrow(/candidate/i);
    expect(calls).toBe(0);
  });
});
