import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationTurnInput, ConversationTurnResult } from '@medadhere/shared';
import {
  CLINICAL_EXTRACTOR_PROMPT_SHA256,
  CLINICAL_EXTRACTOR_PROMPT_VERSION,
  CLINICAL_EXTRACTOR_SCHEMA_SHA256,
} from '../src/conversation/clinical-memory/anthropic-extractor.js';
import type { ConversationEvalCheckpoint } from './lib/conversation-checkpoint.js';
import type { FrozenConversationReviewBundle } from './lib/conversation-review-bundle.js';
import type { ConversationEvalProviderPayload } from './lib/conversation-provider.js';
import { buildConversationRunnerScenarios } from './lib/conversation-input.js';
import { buildAnthropicClinicalMemoryTurnPreflight } from './lib/conversation-clinical-memory-provider.js';
import {
  ConversationProviderTransportError,
  ConversationRunnerFatalError,
  SONNET_CANDIDATE_CONFIGS,
  type ConversationProvider,
  type ConversationProviderResponse,
} from './lib/conversation-runner.js';
import {
  loadConversationScenarioCorpus,
  type ConversationPatientExpectation,
} from './lib/conversation-scenarios.js';
import {
  parseAnthropicSecret,
  parseConversationEvalArgs,
  runConversationEvalCli,
  writeConversationEvalArtifactAtomic,
  type ConversationEvalArtifact,
  type ConversationEvalDeps,
} from './run-conversation-eval.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const pilotArgs = [
  '--live',
  '--clinical-memory',
  '--partition=dev',
  '--candidate=thinking_disabled',
  '--scenario-limit=1',
  '--max-calls=3',
  '--max-input-tokens=51000',
  '--max-output-tokens=12288',
  '--max-cost-usd=0.23',
] as const;

function passingProvider(
  calls: string[],
): ConversationProvider<ConversationEvalProviderPayload<ConversationPatientExpectation>> {
  return async (request) => {
    calls.push(`${request.scenarioId}:${request.turnId}`);
    const metricSuccesses = Object.fromEntries(
      request.payload.expectation.applicableMetrics.map((metric) => [metric, true]),
    );
    return {
      outcome: 'completed',
      turnResult: validTurnResult(request.payload.turnInput.currentMessage.id),
      metricSuccesses,
      latencyMs: 5,
      inputTokens: 100,
      outputTokens: 10,
      modelText: 'provider-prose-must-not-persist-zzqx',
    } as unknown as ConversationProviderResponse;
  };
}

function validTurnResult(sourceMessageId: string): ConversationTurnResult {
  return {
    detectedLanguage: 'en',
    languageConfidence: 1,
    mixedLanguage: false,
    translationUncertain: false,
    normalizedEnglishMeaning: 'The patient provided a synthetic medication update.',
    adherenceClassification: null,
    observations: [],
    temporalCandidateIds: [],
    action: { type: 'complete_turn' },
    socialAcknowledgement: 'Thanks for the update.',
    clinicalClaim: null,
    clinicianReviewDraft: {
      patientStatements: [{ sourceMessageId, text: 'Synthetic patient statement.' }],
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

function clinicalMemoryPreflight(
  candidate: (typeof SONNET_CANDIDATE_CONFIGS)[number],
  turnInput: ConversationTurnInput,
) {
  return buildAnthropicClinicalMemoryTurnPreflight(
    {
      model: candidate.model,
      thinking: candidate.thinking,
      effort: candidate.effort,
      interpretationMaxTokens: candidate.maxTokens,
    },
    turnInput,
  );
}

function harness(overrides: Partial<ConversationEvalDeps> = {}): {
  readonly deps: ConversationEvalDeps;
  readonly artifacts: ConversationEvalArtifact[];
  readonly reviewBundles: FrozenConversationReviewBundle[];
  readonly events: string[];
  readonly calls: string[];
} {
  const artifacts: ConversationEvalArtifact[] = [];
  const reviewBundles: FrozenConversationReviewBundle[] = [];
  const events: string[] = [];
  const calls: string[] = [];
  const deps: ConversationEvalDeps = {
    loadCorpus: () => {
      events.push('corpus');
      return loadConversationScenarioCorpus();
    },
    loadApiKey: async () => {
      events.push('secret');
      return 'sk-ant-test-secret-zzqx';
    },
    createClinicalMemoryProvider: (apiKey) => {
      events.push(`provider:${apiKey}`);
      return passingProvider(calls);
    },
    writeArtifact: (artifact) => {
      artifacts.push(artifact);
      return '/ignored/eval.json';
    },
    writeReviewBundle: (runId, bundle) => {
      void runId;
      events.push('review-bundle-write');
      reviewBundles.push(bundle);
      return '/ignored/review-bundle.json';
    },
    cleanupStaleReviewBundles: () => undefined,
    sleep: async () => undefined,
    writeCheckpoint: () => '/ignored/checkpoint.json',
    readCheckpoint: () => {
      throw new Error('no checkpoint configured');
    },
    deleteCheckpoint: () => undefined,
    now: () => new Date('2026-08-09T20:00:00.000Z'),
    randomId: () => '00000000-0000-4000-8000-000000000099',
    logCode: (code) => events.push(`log:${code}`),
    ...overrides,
  };
  return { deps, artifacts, reviewBundles, events, calls };
}

describe('parseConversationEvalArgs', () => {
  it('requires an explicit live mode and every numeric ceiling', () => {
    expect(() => parseConversationEvalArgs(pilotArgs.slice(1))).toThrow(/--live/);
    expect(() =>
      parseConversationEvalArgs(
        pilotArgs.filter((argument) => !argument.startsWith('--max-calls')),
      ),
    ).toThrow(/max-calls/);
    expect(() =>
      parseConversationEvalArgs(
        pilotArgs.map((argument) =>
          argument === '--max-cost-usd=0.23' ? '--max-cost-usd=NaN' : argument,
        ),
      ),
    ).toThrow(/max-cost-usd/);
  });

  it('parses one bounded dev pilot configuration', () => {
    expect(parseConversationEvalArgs(pilotArgs)).toEqual({
      live: true,
      partition: 'dev',
      candidateConfigId: 'thinking_disabled',
      clinicalMemory: true,
      scenarioLimit: 1,
      maxCalls: 3,
      maxInputTokens: 51_000,
      maxOutputTokens: 12_288,
      maxCostUsd: 0.23,
    });
  });

  it('requires the explicit clinical-memory architecture', () => {
    expect(parseConversationEvalArgs(pilotArgs)).toMatchObject({
      partition: 'dev',
      clinicalMemory: true,
    });
    expect(() =>
      parseConversationEvalArgs(pilotArgs.filter((argument) => argument !== '--clinical-memory')),
    ).toThrow(/clinical-memory/iu);
  });

  it('parses resume only for a full clinical-memory development run', () => {
    const full = pilotArgs.filter((argument) => !argument.startsWith('--scenario-limit'));
    expect(parseConversationEvalArgs([...full, '--resume=checkpoint_01'])).toMatchObject({
      clinicalMemory: true,
      resumeCheckpointId: 'checkpoint_01',
    });
    expect(() => parseConversationEvalArgs([...pilotArgs, '--resume=checkpoint_01'])).toThrow(
      /resume.*full clinical-memory development/iu,
    );
  });

  it('allows a positive recovery allowance only when resuming', () => {
    const full = pilotArgs.filter((argument) => !argument.startsWith('--scenario-limit'));
    expect(
      parseConversationEvalArgs([
        ...full,
        '--resume=checkpoint_01',
        '--recovery-extra-turns=2',
        '--recovery-turn-delay-ms=20000',
      ]),
    ).toMatchObject({
      resumeCheckpointId: 'checkpoint_01',
      recoveryExtraTurns: 2,
      recoveryTurnDelayMs: 20_000,
    });
    expect(() => parseConversationEvalArgs([...full, '--recovery-extra-turns=2'])).toThrow(
      /recovery-extra-turns.*resume/iu,
    );
    expect(() =>
      parseConversationEvalArgs([...full, '--resume=checkpoint_01', '--recovery-extra-turns=0']),
    ).toThrow(/recovery-extra-turns/iu);
    expect(() => parseConversationEvalArgs([...full, '--recovery-turn-delay-ms=20000'])).toThrow(
      /recovery-turn-delay-ms.*resume/iu,
    );
    expect(() =>
      parseConversationEvalArgs([
        ...full,
        '--resume=checkpoint_01',
        '--recovery-turn-delay-ms=300001',
      ]),
    ).toThrow(/recovery-turn-delay-ms.*300000/iu);
  });

  it('parses one exact development scenario without changing corpus order', () => {
    const args = [
      ...pilotArgs.filter((argument) => !argument.startsWith('--scenario-limit')),
      '--scenario-id=conv-dev-031',
    ];

    expect(parseConversationEvalArgs(args)).toMatchObject({
      partition: 'dev',
      scenarioId: 'conv-dev-031',
    });
  });

  it('rejects the removed automated semantic-review flag', () => {
    const full = pilotArgs.filter((argument) => !argument.startsWith('--scenario-limit'));
    expect(() => parseConversationEvalArgs([...full, '--semantic-review=auto'])).toThrow();
  });

  it('rejects unknown flags, nonpositive integers, and a holdout pilot', () => {
    expect(() => parseConversationEvalArgs([...pilotArgs, '--surprise'])).toThrow(/unknown/i);
    expect(() => parseConversationEvalArgs([...pilotArgs, '--live'])).toThrow(/duplicate --live/i);
    expect(() => parseConversationEvalArgs([...pilotArgs, '--max-calls=4'])).toThrow(
      /duplicate --max-calls/i,
    );
    expect(() =>
      parseConversationEvalArgs(
        pilotArgs.map((argument) => (argument === '--max-calls=3' ? '--max-calls=0' : argument)),
      ),
    ).toThrow(/max-calls/);
    expect(() =>
      parseConversationEvalArgs(
        pilotArgs.map((argument) =>
          argument === '--partition=dev' ? '--partition=holdout' : argument,
        ),
      ),
    ).toThrow(/holdout.*scenario-limit/i);
    expect(() => parseConversationEvalArgs([...pilotArgs, '--scenario-id=conv-dev-031'])).toThrow(
      /scenario-limit.*scenario-id/i,
    );
    expect(() =>
      parseConversationEvalArgs(
        pilotArgs.flatMap((argument) =>
          argument === '--partition=dev' ? ['--partition', 'dev'] : [argument],
        ),
      ),
    ).toThrow(/partition.*inline value/i);
  });
});

describe('parseAnthropicSecret', () => {
  it('accepts only the exact non-empty apiKey JSON shape', () => {
    expect(parseAnthropicSecret('{"apiKey":"sk-ant-test"}')).toBe('sk-ant-test');
    expect(() => parseAnthropicSecret('{"apiKey":""}')).toThrow(/invalid/i);
    expect(() => parseAnthropicSecret('{"apiKey":"sk-ant-test","extra":true}')).toThrow(/invalid/i);
    expect(() => parseAnthropicSecret('sk-ant-raw')).toThrow(/invalid/i);
  });
});

describe('runConversationEvalCli', () => {
  it('uses the clinical-memory provider and records current extractor metadata', async () => {
    const corpus = loadConversationScenarioCorpus();
    const clinicalMemoryCalls: string[] = [];
    const clinicalMemoryProvider = vi.fn(
      (): ConversationProvider<ConversationEvalProviderPayload<ConversationPatientExpectation>> =>
        async (request) => ({
          ...(await passingProvider(clinicalMemoryCalls)(request)),
          inputTokens: 10,
          cacheCreationInputTokens: 70,
          cacheReadInputTokens: 20,
          modelCalls: 1,
        }),
    );
    const h = harness({
      loadCorpus: () => corpus,
      createClinicalMemoryProvider: clinicalMemoryProvider,
    } as Partial<ConversationEvalDeps>);

    await expect(runConversationEvalCli(pilotArgs, h.deps)).resolves.toBe(0);
    expect(clinicalMemoryProvider).toHaveBeenCalledOnce();
    expect(h.artifacts[0]).toMatchObject({
      config: {
        architecture: 'clinical_memory',
        promptVersion: CLINICAL_EXTRACTOR_PROMPT_VERSION,
        promptSha256: CLINICAL_EXTRACTOR_PROMPT_SHA256,
        outputSchemaSha256: CLINICAL_EXTRACTOR_SCHEMA_SHA256,
      },
      pricesUsdPerMillionTokens: {
        input: 2,
        cacheCreationInput: 2.5,
        cacheReadInput: 0.2,
        output: 10,
      },
      execution: {
        attemptedCalls: 3,
        inputTokens: 30,
        cacheCreationInputTokens: 210,
        cacheReadInputTokens: 60,
        outputTokens: 30,
        costUsd: 0.000897,
      },
    });
  });

  it('checkpoints usage at an incomplete clinical-memory scenario boundary', async () => {
    const corpus = structuredClone(loadConversationScenarioCorpus());
    Object.assign(corpus.dev, { scenarios: corpus.dev.scenarios.slice(0, 1) });
    const checkpoints: ConversationEvalCheckpoint[] = [];
    const h = harness({
      loadCorpus: () => corpus,
      createClinicalMemoryProvider: () => async () => ({
        outcome: 'malformed',
        modelStage: 'interpretation',
        modelCalls: 1,
        inputTokens: 120,
        outputTokens: 20,
        metricSuccesses: {},
      }),
      writeCheckpoint: (checkpoint) => {
        checkpoints.push(checkpoint);
        return '/ignored/checkpoint.json';
      },
    } as Partial<ConversationEvalDeps>);
    const args = pilotArgs.filter((argument) => !argument.startsWith('--scenario-limit'));

    await expect(runConversationEvalCli(args, h.deps)).resolves.toBe(1);

    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[1]).toMatchObject({
      completedScenarioIds: [],
      results: [],
      reviewCaptures: [],
      usage: { attemptedCalls: 1, inputTokens: 120, outputTokens: 20 },
    });
  });

  it('keeps recovery allowance out of the checkpoint binding', async () => {
    const corpus = structuredClone(loadConversationScenarioCorpus());
    Object.assign(corpus.dev, { scenarios: corpus.dev.scenarios.slice(0, 1) });
    const checkpoints: ConversationEvalCheckpoint[] = [];
    const baseArgs = [
      '--live',
      '--clinical-memory',
      '--partition=dev',
      '--candidate=thinking_disabled',
      '--max-calls=3',
      '--max-input-tokens=51000',
      '--max-output-tokens=12288',
      '--max-cost-usd=0.50',
    ];
    const first = harness({
      loadCorpus: () => corpus,
      createClinicalMemoryProvider: () => async () => ({
        outcome: 'malformed',
        modelStage: 'interpretation',
        modelCalls: 1,
        inputTokens: 120,
        outputTokens: 20,
        metricSuccesses: {},
      }),
      writeCheckpoint: (checkpoint) => {
        checkpoints.push(checkpoint);
        return '/ignored/checkpoint.json';
      },
    } as Partial<ConversationEvalDeps>);

    await expect(runConversationEvalCli(baseArgs, first.deps)).resolves.toBe(1);
    const saved = checkpoints.at(-1)!;
    const second = harness({
      loadCorpus: () => corpus,
      createClinicalMemoryProvider: () => async (request) => ({
        ...(await passingProvider([])(request)),
        modelCalls: 1,
      }),
      readCheckpoint: (checkpointId, bindingSha256) => {
        expect(bindingSha256).toBe(saved.bindingSha256);
        return { ...saved, checkpointId, bindingSha256 };
      },
    } as Partial<ConversationEvalDeps>);

    await expect(
      runConversationEvalCli(
        [...baseArgs, '--resume=checkpoint_01', '--recovery-extra-turns=1'],
        second.deps,
      ),
    ).resolves.toBe(0);
  });

  it('rejects resume recovery over the unchanged cost cap before loading the secret', async () => {
    const corpus = structuredClone(loadConversationScenarioCorpus());
    Object.assign(corpus.dev, { scenarios: corpus.dev.scenarios.slice(0, 1) });
    const secret = vi.fn(async () => 'sk-ant-never');
    const h = harness({
      loadCorpus: () => corpus,
      loadApiKey: secret,
      readCheckpoint: (checkpointId, bindingSha256) => ({
        schemaVersion: 1,
        checkpointId,
        bindingSha256,
        completedScenarioIds: [],
        results: [],
        reviewCaptures: [],
        usage: {
          attemptedCalls: 1,
          reservedInputTokens: 60_000,
          reservedOutputTokens: 20_000,
          inputTokens: 100,
          outputTokens: 10,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          thinkingTokens: 0,
        },
      }),
    } as Partial<ConversationEvalDeps>);

    await expect(
      runConversationEvalCli(
        [
          '--live',
          '--clinical-memory',
          '--partition=dev',
          '--candidate=thinking_disabled',
          '--resume=checkpoint_01',
          '--recovery-extra-turns=1',
          '--max-calls=6',
          '--max-input-tokens=300000',
          '--max-output-tokens=40000',
          '--max-cost-usd=0.50',
        ],
        h.deps,
      ),
    ).resolves.toBe(1);

    expect(secret).not.toHaveBeenCalled();
    expect(h.events).toContain('log:CONVERSATION_EVAL_BUDGET_PREFLIGHT_FAILED');
  });

  it('resumes a clinical-memory run without calling completed scenarios again', async () => {
    const corpus = structuredClone(loadConversationScenarioCorpus());
    Object.assign(corpus.dev, {
      scenarios: corpus.dev.scenarios
        .filter(
          ({ primaryLanguage, additionalLanguages }) =>
            primaryLanguage === 'en' && additionalLanguages.length === 0,
        )
        .slice(0, 2),
    });
    const scenarios = buildConversationRunnerScenarios(corpus.dev.scenarios);
    const completedScenario = scenarios[0]!;
    const pendingScenario = scenarios[1]!;
    const candidate = SONNET_CANDIDATE_CONFIGS[0];
    const priorResults = completedScenario.turns
      .filter(({ eligibleForProvider }) => eligibleForProvider)
      .map(({ turnId, payload }) => ({
        scenarioId: completedScenario.scenarioId,
        turnId,
        outcome: 'completed' as const,
        metricSuccesses: Object.fromEntries(
          payload.expectation.applicableMetrics.map((metric) => [metric, true]),
        ),
        inputTokens: 100,
        outputTokens: 10,
        modelCalls: 1,
        actionType: 'complete_turn' as const,
      }));
    const priorCaptures = completedScenario.turns
      .filter(({ eligibleForProvider }) => eligibleForProvider)
      .map(({ turnId, payload }) => ({
        scenarioId: completedScenario.scenarioId,
        turnId,
        preparedTurnInput: buildAnthropicClinicalMemoryTurnPreflight(
          {
            model: candidate.model,
            thinking: candidate.thinking,
            effort: candidate.effort,
            interpretationMaxTokens: candidate.maxTokens,
          },
          payload.turnInput,
        ).preparedTurnInput,
        turnResult: validTurnResult(payload.turnInput.currentMessage.id),
        expectation: payload.expectation,
      }));
    const pendingCalls: string[] = [];
    const sleep = vi.fn(async () => undefined);
    const deleteCheckpoint = vi.fn();
    const writeCheckpoint = vi.fn(() => '/ignored/checkpoint.json');
    const h = harness({
      loadCorpus: () => corpus,
      createClinicalMemoryProvider: () => async (request) => ({
        ...(await passingProvider(pendingCalls)(request)),
        modelCalls: 1,
      }),
      readCheckpoint: (checkpointId, bindingSha256) => ({
        schemaVersion: 1,
        checkpointId,
        bindingSha256,
        completedScenarioIds: [completedScenario.scenarioId],
        results: priorResults,
        reviewCaptures: priorCaptures,
        usage: {
          attemptedCalls: 4,
          reservedInputTokens: 42_000,
          reservedOutputTokens: 9_216,
          inputTokens: 300,
          outputTokens: 30,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          thinkingTokens: 0,
        },
      }),
      writeCheckpoint,
      deleteCheckpoint,
      sleep,
    } as Partial<ConversationEvalDeps>);
    const args = [
      '--live',
      '--clinical-memory',
      '--partition=dev',
      '--candidate=thinking_disabled',
      '--resume=checkpoint_01',
      '--recovery-extra-turns=2',
      '--recovery-turn-delay-ms=20000',
      '--max-calls=10',
      '--max-input-tokens=172000',
      '--max-output-tokens=25784',
      '--max-cost-usd=1',
    ];

    await expect(runConversationEvalCli(args, h.deps)).resolves.toBe(0);

    expect(pendingCalls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 20_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 20_000);
    expect(pendingCalls.every((call) => call.startsWith(`${pendingScenario.scenarioId}:`))).toBe(
      true,
    );
    expect(h.artifacts[0]!.results.filter(({ source }) => source === 'provider')).toHaveLength(6);
    expect(h.artifacts[0]!.execution).toMatchObject({
      attemptedCalls: 7,
      costUsd: null,
      costUpperBoundUsd: expect.any(Number),
    });
    expect(h.artifacts[0]!.caps).toMatchObject({
      calls: 12,
      inputTokens: 196_000,
      outputTokens: 33_976,
      costUsd: 1,
      recoveryExtraTurns: 2,
      recoveryTurnDelayMs: 20_000,
    });
    expect(h.artifacts[0]!.execution.costUpperBoundUsd).toBeLessThanOrEqual(
      h.artifacts[0]!.caps.projectedWorstCaseCostUsd,
    );
    expect(writeCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        completedScenarioIds: [completedScenario.scenarioId, pendingScenario.scenarioId],
      }),
    );
    expect(deleteCheckpoint).toHaveBeenCalledWith('checkpoint_01');
  });

  it('uses verified per-turn request bounds for aggregate input projection before the secret', async () => {
    const corpus = loadConversationScenarioCorpus();
    const scenarios = buildConversationRunnerScenarios(corpus.dev.scenarios.slice(0, 1));
    const candidate = SONNET_CANDIDATE_CONFIGS[0];
    const inputTokenUpperBound = scenarios
      .flatMap((scenario) => scenario.turns)
      .filter((turn) => turn.eligibleForProvider)
      .reduce(
        (total, turn) =>
          total + clinicalMemoryPreflight(candidate, turn.payload.turnInput).reservedInputTokens,
        0,
      );
    const secret = vi.fn(async () => 'sk-ant-never');
    const h = harness({ loadCorpus: () => corpus, loadApiKey: secret });

    await expect(
      runConversationEvalCli(
        pilotArgs.map((argument) =>
          argument === '--max-input-tokens=51000'
            ? `--max-input-tokens=${inputTokenUpperBound - 1}`
            : argument,
        ),
        h.deps,
      ),
    ).resolves.toBe(1);
    expect(secret).not.toHaveBeenCalled();
  });

  it('rejects an oversized message before secret lookup or provider creation', async () => {
    const corpus = structuredClone(loadConversationScenarioCorpus());
    for (const message of corpus.dev.scenarios[0]!.transcript) {
      Object.assign(message, {
        text: 'ض'.repeat(message.role === 'patient' ? 2_001 : 800),
      });
    }
    const oversizedScenarios = buildConversationRunnerScenarios(corpus.dev.scenarios.slice(0, 1));
    expect(() =>
      clinicalMemoryPreflight(
        SONNET_CANDIDATE_CONFIGS[0],
        oversizedScenarios[0]!.turns.find(({ eligibleForProvider }) => eligibleForProvider)!.payload
          .turnInput,
      ),
    ).toThrow(/2000/iu);
    const secret = vi.fn(async () => 'sk-ant-never');
    const createClinicalMemoryProvider = vi.fn();
    const h = harness({
      loadCorpus: () => corpus,
      loadApiKey: secret,
      createClinicalMemoryProvider,
    });

    await expect(runConversationEvalCli(pilotArgs, h.deps)).resolves.toBe(1);
    expect(secret).not.toHaveBeenCalled();
    expect(createClinicalMemoryProvider).not.toHaveBeenCalled();
    expect(h.events).toContain('log:CONVERSATION_EVAL_REQUEST_SIZE_PREFLIGHT_FAILED');
  });

  it('fails closed at the Sonnet introductory-pricing expiry boundary before secret lookup', async () => {
    const before = harness({ now: () => new Date('2026-08-31T23:59:59.999Z') });
    await expect(runConversationEvalCli(pilotArgs, before.deps)).resolves.toBe(0);
    expect(before.events).toContain('secret');

    const secret = vi.fn(async () => 'sk-ant-never');
    const atBoundary = harness({
      now: () => new Date('2026-09-01T00:00:00.000Z'),
      loadApiKey: secret,
    });
    await expect(runConversationEvalCli(pilotArgs, atBoundary.deps)).resolves.toBe(1);
    expect(secret).not.toHaveBeenCalled();
    expect(atBoundary.events).toContain('log:CONVERSATION_EVAL_PRICING_EXPIRED');
  });

  it('loads and checksum-validates the corpus before secret retrieval', async () => {
    const artifacts: ConversationEvalArtifact[] = [];
    const events: string[] = [];
    const calls: string[] = [];
    const deps: ConversationEvalDeps = {
      loadCorpus: () => {
        events.push('corpus');
        return loadConversationScenarioCorpus();
      },
      loadApiKey: async () => {
        events.push('secret');
        return 'sk-ant-test-secret-zzqx';
      },
      createClinicalMemoryProvider: () => passingProvider(calls),
      writeArtifact: (artifact) => {
        artifacts.push(artifact);
        return '/ignored/eval.json';
      },
      writeReviewBundle: vi.fn(),
      cleanupStaleReviewBundles: () => events.push('cleanup'),
      writeCheckpoint: () => '/ignored/checkpoint.json',
      readCheckpoint: () => {
        throw new Error('no checkpoint configured');
      },
      deleteCheckpoint: () => undefined,
      now: () => new Date('2026-08-09T20:00:00.000Z'),
      randomId: () => '00000000-0000-4000-8000-000000000099',
      logCode: vi.fn(),
    };

    await expect(runConversationEvalCli(pilotArgs, deps)).resolves.toBe(0);
    expect(events).toEqual(['cleanup', 'corpus', 'secret']);
    expect(calls).toHaveLength(3);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.execution).toMatchObject({
      status: 'pilot_completed',
      reasonCode: 'PILOT_ONLY',
      acceptanceEligible: false,
    });
  });

  it('fails closed on stale-bundle cleanup failure before corpus or secret access', async () => {
    const corpus = vi.fn(loadConversationScenarioCorpus);
    const secret = vi.fn(async () => 'sk-ant-never');
    const h = harness({
      loadCorpus: corpus,
      loadApiKey: secret,
      cleanupStaleReviewBundles: () => {
        throw new Error('expired bundle could not be deleted');
      },
    });

    await expect(runConversationEvalCli(pilotArgs, h.deps)).resolves.toBe(1);
    expect(corpus).not.toHaveBeenCalled();
    expect(secret).not.toHaveBeenCalled();
    expect(h.events).toContain('log:CONVERSATION_EVAL_STALE_BUNDLE_CLEANUP_FAILED');
  });

  it('marks a limited dev pilot as transport-only and never as an acceptance pass', async () => {
    const h = harness({ loadCorpus: loadConversationScenarioCorpus });

    await expect(runConversationEvalCli(pilotArgs, h.deps)).resolves.toBe(0);
    expect(h.artifacts[0]!.execution).toMatchObject({
      status: 'pilot_completed',
      reasonCode: 'PILOT_ONLY',
      acceptanceEligible: false,
    });
    expect(h.events).toContain('log:CONVERSATION_EVAL_PILOT_COMPLETED');
    expect(h.events.filter((event) => event.includes('CONVERSATION_EVAL_PROGRESS'))).toEqual([
      'log:CONVERSATION_EVAL_PROGRESS:1:3',
      'log:CONVERSATION_EVAL_PROGRESS:2:3',
      'log:CONVERSATION_EVAL_PROGRESS:3:3',
    ]);
    expect(h.events).not.toContain('log:CONVERSATION_EVAL_COMPLETED');
  });

  it('allows a transport pilot to complete while semantic review remains pending', async () => {
    const h = harness({
      loadCorpus: loadConversationScenarioCorpus,
      createClinicalMemoryProvider: () => async () => ({
        outcome: 'completed',
        metricSuccesses: { structured_output_validity: true },
        inputTokens: 100,
        outputTokens: 10,
      }),
    });

    await expect(runConversationEvalCli(pilotArgs, h.deps)).resolves.toBe(0);
    expect(h.artifacts[0]!.metrics.complete).toBe(false);
    expect(h.events).toContain('log:CONVERSATION_EVAL_PILOT_COMPLETED');
  });

  it('completes a full provider run pending review and retains one frozen bundle', async () => {
    const corpus = structuredClone(loadConversationScenarioCorpus());
    Object.assign(corpus.dev, { scenarios: corpus.dev.scenarios.slice(0, 1) });
    const h = harness({ loadCorpus: () => corpus });
    const fullArgs = pilotArgs.filter((argument) => !argument.startsWith('--scenario-limit'));

    await expect(runConversationEvalCli(fullArgs, h.deps)).resolves.toBe(0);

    expect(h.reviewBundles).toHaveLength(1);
    expect(h.reviewBundles[0]!.bundle.items).toHaveLength(3);
    expect(h.reviewBundles[0]!.serialized).toContain(
      corpus.dev.scenarios[0]!.transcript.find(({ role }) => role === 'patient')!.text,
    );
    expect(h.reviewBundles[0]!.serialized).not.toContain('reviewerModel');
    expect(h.reviewBundles[0]!.serialized).not.toContain('metricResults');
    expect(
      h.reviewBundles[0]!.bundle.items.every(({ outputHash }) =>
        /^sha256:[a-f0-9]{64}$/u.test(outputHash),
      ),
    ).toBe(true);
    const artifact = h.artifacts[0]!;
    expect(artifact.execution).toMatchObject({
      status: 'provider_completed_pending_review',
      reasonCode: 'provider_completed_pending_review',
      acceptanceEligible: false,
      attemptedCalls: 3,
    });
    expect(artifact).not.toHaveProperty('semanticReview');
    expect(artifact).not.toHaveProperty('semanticReviewFailure');
    expect(artifact.metrics.complete).toBe(false);
    expect(JSON.stringify(artifact)).not.toContain('Synthetic patient statement.');
    expect(h.events).toContain('review-bundle-write');
    expect(h.events).toContain('log:CONVERSATION_EVAL_PROVIDER_COMPLETED_PENDING_REVIEW');
  });

  it('fails a complete full run when any required mechanical metric fails', async () => {
    const corpus = structuredClone(loadConversationScenarioCorpus());
    Object.assign(corpus.dev, { scenarios: corpus.dev.scenarios.slice(0, 1) });
    const h = harness({
      loadCorpus: () => corpus,
      createClinicalMemoryProvider: () => async (request) => {
        const result = await passingProvider([])(request);
        return {
          ...result,
          metricSuccesses: {
            ...result.metricSuccesses,
            structured_output_validity: false,
          },
        };
      },
    });
    const fullArgs = pilotArgs.filter((argument) => !argument.startsWith('--scenario-limit'));

    await expect(runConversationEvalCli(fullArgs, h.deps)).resolves.toBe(1);

    expect(h.artifacts[0]!.execution).toMatchObject({
      status: 'aborted',
      reasonCode: 'MECHANICAL_EVALUATION_FAILED',
      acceptanceEligible: false,
    });
    expect(h.reviewBundles).toHaveLength(1);
  });

  it('fails closed with a sanitized artifact and no bundle when provider output is incomplete', async () => {
    const corpus = structuredClone(loadConversationScenarioCorpus());
    Object.assign(corpus.dev, { scenarios: corpus.dev.scenarios.slice(0, 1) });
    const writeBundle = vi.fn();
    const h = harness({
      loadCorpus: () => corpus,
      createClinicalMemoryProvider: () => async () => ({
        outcome: 'timeout',
        metricSuccesses: {},
      }),
      writeReviewBundle: writeBundle,
    });
    const fullArgs = pilotArgs.filter((argument) => !argument.startsWith('--scenario-limit'));

    await expect(runConversationEvalCli(fullArgs, h.deps)).resolves.toBe(1);

    expect(writeBundle).not.toHaveBeenCalled();
    expect(h.artifacts).toHaveLength(1);
    expect(h.artifacts[0]!.execution).toMatchObject({
      status: 'aborted',
      reasonCode: 'PROVIDER_INCOMPLETE',
      attemptedCalls: 1,
      costUsd: null,
    });
    expect(h.artifacts[0]!.results).toEqual([expect.objectContaining({ outcome: 'timeout' })]);
    expect(h.artifacts[0]!.metrics.complete).toBe(false);
    expect(JSON.stringify(h.artifacts[0])).not.toContain(
      corpus.dev.scenarios[0]!.transcript.find(({ role }) => role === 'patient')!.text,
    );
  });

  it('writes a sanitized failure artifact when the pending review bundle cannot be written', async () => {
    const corpus = structuredClone(loadConversationScenarioCorpus());
    Object.assign(corpus.dev, { scenarios: corpus.dev.scenarios.slice(0, 1) });
    const h = harness({
      loadCorpus: () => corpus,
      writeReviewBundle: () => {
        throw new Error('disk details must not persist');
      },
    });
    const fullArgs = pilotArgs.filter((argument) => !argument.startsWith('--scenario-limit'));

    await expect(runConversationEvalCli(fullArgs, h.deps)).resolves.toBe(1);

    expect(h.artifacts).toHaveLength(1);
    expect(h.artifacts[0]!.execution).toMatchObject({
      status: 'aborted',
      reasonCode: 'REVIEW_BUNDLE_WRITE_FAILED',
    });
    expect(JSON.stringify(h.artifacts[0])).not.toContain('disk details must not persist');
    expect(h.events).toContain('log:CONVERSATION_EVAL_REVIEW_BUNDLE_WRITE_FAILED');
  });

  it('retains the pending bundle when sanitized artifact writing fails', async () => {
    const corpus = structuredClone(loadConversationScenarioCorpus());
    Object.assign(corpus.dev, { scenarios: corpus.dev.scenarios.slice(0, 1) });
    const h = harness({
      loadCorpus: () => corpus,
      writeArtifact: () => {
        throw new Error('artifact disk failed');
      },
    });
    const fullArgs = pilotArgs.filter((argument) => !argument.startsWith('--scenario-limit'));

    await expect(runConversationEvalCli(fullArgs, h.deps)).resolves.toBe(1);

    expect(h.reviewBundles).toHaveLength(1);
    expect(h.events).toContain('review-bundle-write');
    expect(h.events).toContain('log:CONVERSATION_EVAL_ARTIFACT_WRITE_FAILED');
  });
  it('refuses call/output/cost projections before loading the secret', async () => {
    const secret = vi.fn(async () => 'sk-ant-never');
    const base = harness({ loadCorpus: loadConversationScenarioCorpus, loadApiKey: secret });

    await expect(
      runConversationEvalCli(
        pilotArgs.map((argument) => (argument === '--max-calls=3' ? '--max-calls=2' : argument)),
        base.deps,
      ),
    ).resolves.toBe(1);
    await expect(
      runConversationEvalCli(
        pilotArgs.map((argument) =>
          argument === '--max-input-tokens=51000' ? '--max-input-tokens=1' : argument,
        ),
        base.deps,
      ),
    ).resolves.toBe(1);
    await expect(
      runConversationEvalCli(
        pilotArgs.map((argument) =>
          argument === '--max-output-tokens=12288' ? '--max-output-tokens=12287' : argument,
        ),
        base.deps,
      ),
    ).resolves.toBe(1);
    await expect(
      runConversationEvalCli(
        pilotArgs.map((argument) =>
          argument === '--max-cost-usd=0.23' ? '--max-cost-usd=0.01' : argument,
        ),
        base.deps,
      ),
    ).resolves.toBe(1);

    expect(secret).not.toHaveBeenCalled();
    expect(base.artifacts).toEqual([]);
  });

  it('aborts and persists only a sanitized partial report when measured usage exceeds a cap', async () => {
    const h = harness({
      loadCorpus: loadConversationScenarioCorpus,
      createClinicalMemoryProvider: () => async () => ({
        outcome: 'completed',
        metricSuccesses: {},
        inputTokens: 12_001,
        outputTokens: 1,
      }),
    });

    await expect(runConversationEvalCli(pilotArgs, h.deps)).resolves.toBe(1);
    expect(h.artifacts).toHaveLength(1);
    expect(h.artifacts[0]!.execution).toMatchObject({
      status: 'aborted',
      reasonCode: 'BUDGET_EXCEEDED',
      attemptedCalls: 1,
      inputTokens: 12_001,
    });
    expect(h.artifacts[0]!.metrics.complete).toBe(false);
    expect(JSON.stringify(h.artifacts[0])).not.toContain('sk-ant-test-secret-zzqx');
  });

  it('records an ordinary timeout and continues to the next turn', async () => {
    let calls = 0;
    const h = harness({
      loadCorpus: loadConversationScenarioCorpus,
      createClinicalMemoryProvider: () => async (request) => {
        calls += 1;
        if (calls === 1) {
          const timeout = new Error('provider prose must not persist');
          timeout.name = 'TimeoutError';
          throw timeout;
        }
        return passingProvider([])(request);
      },
    });

    await expect(runConversationEvalCli(pilotArgs, h.deps)).resolves.toBe(1);
    expect(calls).toBe(1);
    expect(h.artifacts[0]!.execution).toMatchObject({
      status: 'aborted',
      reasonCode: 'PROVIDER_INCOMPLETE',
      acceptanceEligible: false,
      attemptedCalls: 1,
      costUsd: null,
    });
    expect(h.artifacts[0]!.execution.costUpperBoundUsd).toBeGreaterThan(0);
    expect(h.artifacts[0]!.execution.costUpperBoundUsd).toBeLessThanOrEqual(
      h.artifacts[0]!.caps.projectedWorstCaseCostUsd,
    );
    expect(h.artifacts[0]!.results.map(({ outcome }) => outcome)).toEqual(['timeout']);
    expect(JSON.stringify(h.artifacts[0])).not.toContain('provider prose must not persist');
  });

  it('persists only sanitized malformed-stage diagnostics in the artifact', async () => {
    const sentinel = 'raw-zod-diagnostic-zzqx';
    const h = harness({
      loadCorpus: loadConversationScenarioCorpus,
      createClinicalMemoryProvider: () => async () =>
        ({
          outcome: 'malformed',
          metricSuccesses: {},
          malformedStage: 'zod_validation',
          malformedIssues: [
            { path: 'clinicalClaim.type', code: 'invalid_union_discriminator' },
            { path: 'clinicalClaim.type', code: 'invalid_union_discriminator' },
            { path: sentinel, code: sentinel, message: sentinel },
          ],
          modelText: sentinel,
          inputTokens: 100,
          outputTokens: 10,
        }) as never,
    });

    await expect(runConversationEvalCli(pilotArgs, h.deps)).resolves.toBe(1);
    expect(h.artifacts[0]!.results[0]).toMatchObject({
      outcome: 'malformed',
      malformedStage: 'zod_validation',
      malformedIssues: [{ path: 'clinicalClaim.type', code: 'invalid_union_discriminator' }],
    });
    expect(JSON.stringify(h.artifacts[0])).not.toContain(sentinel);
  });

  it('marks provider-error attempt cost unknown while retaining a conservative upper bound', async () => {
    let calls = 0;
    const h = harness({
      loadCorpus: loadConversationScenarioCorpus,
      createClinicalMemoryProvider: () => async (request) => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error('ambiguous provider prose must not persist'), {
            status: 429,
            headers: new Headers({ 'retry-after': '12' }),
          });
        }
        return passingProvider([])(request);
      },
    });

    await expect(runConversationEvalCli(pilotArgs, h.deps)).resolves.toBe(1);
    expect(calls).toBe(1);
    expect(h.artifacts[0]!.results[0]).toMatchObject({ outcome: 'provider_error' });
    expect(h.artifacts[0]!.execution.costUsd).toBeNull();
    expect(h.artifacts[0]!.execution.costUpperBoundUsd).toBeGreaterThan(0);
    expect(h.events).toContain('log:CONVERSATION_EVAL_PROVIDER_FAILURE');
    expect(JSON.stringify({ artifact: h.artifacts[0], events: h.events })).not.toContain(
      'ambiguous provider prose must not persist',
    );
  });

  it.each([
    { operation: 'count_tokens' as const, expectedAttemptedCalls: 0 },
    { operation: 'messages_create' as const, expectedAttemptedCalls: 1 },
  ])(
    'persists and logs only allowlisted $operation diagnostics with ambiguous cost',
    async ({ operation, expectedAttemptedCalls }) => {
      const sentinel = 'raw-provider-transport-sentinel-zzqx';
      const h = harness({
        loadCorpus: loadConversationScenarioCorpus,
        createClinicalMemoryProvider: () => async () =>
          Promise.reject(
            Object.assign(
              new ConversationProviderTransportError({
                modelStage: 'interpretation',
                operation,
                errorClass: 'api_connection',
                causeCode: 'ECONNRESET',
              }),
              { privateDetail: sentinel },
            ),
          ),
      });
      await expect(runConversationEvalCli(pilotArgs, h.deps)).resolves.toBe(1);

      expect(h.artifacts[0]!.results[0]).toMatchObject({
        outcome: 'provider_error',
        modelStage: 'interpretation',
        transportDiagnostic: {
          operation,
          errorClass: 'api_connection',
          causeCode: 'ECONNRESET',
        },
      });
      expect(h.artifacts[0]!.execution.costUsd).toBeNull();
      expect(h.artifacts[0]!.execution.attemptedCalls).toBe(expectedAttemptedCalls);
      expect(h.events).toContain(
        `log:CONVERSATION_EVAL_PROVIDER_FAILURE:interpretation:${operation}:api_connection:ECONNRESET`,
      );
      expect(JSON.stringify({ artifact: h.artifacts[0], events: h.events })).not.toContain(
        sentinel,
      );
    },
  );

  it('aborts immediately when the provider raises an explicit fatal error', async () => {
    let calls = 0;
    const h = harness({
      loadCorpus: loadConversationScenarioCorpus,
      createClinicalMemoryProvider: () => async () => {
        calls += 1;
        throw new ConversationRunnerFatalError('fatal prose must not persist');
      },
    });

    await expect(runConversationEvalCli(pilotArgs, h.deps)).resolves.toBe(1);
    expect(calls).toBe(1);
    expect(h.artifacts[0]!.execution).toMatchObject({
      status: 'aborted',
      reasonCode: 'PROVIDER_ABORTED',
      providerAbortCode: 'UNKNOWN',
      attemptedCalls: 1,
      costUsd: null,
    });
    expect(h.artifacts[0]!.execution.costUpperBoundUsd).toBeGreaterThan(0);
    expect(JSON.stringify(h.artifacts[0])).not.toContain('fatal prose must not persist');
  });

  it('persists an allowlisted provider-abort stage without provider prose', async () => {
    const h = harness({
      loadCorpus: loadConversationScenarioCorpus,
      createClinicalMemoryProvider: () => async () => {
        throw new ConversationRunnerFatalError('token count request rejected');
      },
    });

    await expect(runConversationEvalCli(pilotArgs, h.deps)).resolves.toBe(1);
    expect(h.artifacts[0]!.execution.providerAbortCode).toBe('TOKEN_COUNT_REJECTED');
  });

  it('runs only an explicitly selected development scenario', async () => {
    const calls: string[] = [];
    const h = harness({
      loadCorpus: loadConversationScenarioCorpus,
      createClinicalMemoryProvider: () => passingProvider(calls),
    });
    const args = [
      ...pilotArgs.filter((argument) => !argument.startsWith('--scenario-limit')),
      '--scenario-id=conv-dev-033',
    ];

    await expect(runConversationEvalCli(args, h.deps)).resolves.toBe(0);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.startsWith('conv-dev-033:'))).toBe(true);
    expect(h.artifacts[0]!.corpus).toMatchObject({
      scenarios: 1,
      scenarioLimit: null,
      scenarioId: 'conv-dev-033',
    });
  });

  it('selects only English non-mixed scenarios for a full development run', async () => {
    const corpus = loadConversationScenarioCorpus();
    const activeScenarioIds = new Set(
      corpus.dev.scenarios
        .filter(
          ({ primaryLanguage, additionalLanguages }) =>
            primaryLanguage === 'en' && additionalLanguages.length === 0,
        )
        .map(({ id }) => id),
    );
    const h = harness({ loadCorpus: () => corpus });
    const args = [
      '--live',
      '--clinical-memory',
      '--partition=dev',
      '--candidate=thinking_disabled',
      '--max-calls=1000',
      '--max-input-tokens=2808000',
      '--max-output-tokens=479232',
      '--max-cost-usd=15',
    ];

    await expect(runConversationEvalCli(args, h.deps)).resolves.toBe(0);
    const selectedScenarioIds = new Set(
      h.artifacts[0]!.results.map(({ scenarioId }) => scenarioId),
    );
    expect(selectedScenarioIds).toEqual(activeScenarioIds);
    expect(h.artifacts[0]!.corpus.scenarios).toBe(activeScenarioIds.size);
  });

  it('rejects an archived non-English scenario before provider setup', async () => {
    const secret = vi.fn(async () => 'sk-ant-never');
    const createClinicalMemoryProvider = vi.fn(() => passingProvider([]));
    const h = harness({
      loadCorpus: loadConversationScenarioCorpus,
      loadApiKey: secret,
      createClinicalMemoryProvider,
    });
    const args = [
      ...pilotArgs.filter((argument) => !argument.startsWith('--scenario-limit')),
      '--scenario-id=conv-dev-002',
    ];

    await expect(runConversationEvalCli(args, h.deps)).resolves.toBe(1);
    expect(secret).not.toHaveBeenCalled();
    expect(createClinicalMemoryProvider).not.toHaveBeenCalled();
    expect(h.events).toContain('log:CONVERSATION_EVAL_PREFLIGHT_FAILED');
  });

  it('refuses the locked holdout for the non-pinned candidate configuration', async () => {
    const secret = vi.fn(async () => 'sk-ant-never');
    const args = pilotArgs
      .filter((argument) => !argument.startsWith('--scenario-limit'))
      .map((argument) => {
        if (argument === '--partition=dev') return '--partition=holdout';
        if (argument === '--candidate=thinking_disabled') return '--candidate=adaptive_high';
        return argument;
      });
    const h = harness({ loadCorpus: loadConversationScenarioCorpus, loadApiKey: secret });

    await expect(runConversationEvalCli(args, h.deps)).resolves.toBe(1);
    expect(secret).not.toHaveBeenCalled();
    expect(h.artifacts).toEqual([]);
    expect(h.events).toContain('log:CONVERSATION_EVAL_HOLDOUT_LOCKED');
  });

  it('writes only sanitized IDs, booleans, numerics, and fixed enums', async () => {
    const corpus = loadConversationScenarioCorpus();
    const patientText = corpus.dev.scenarios[0]!.transcript.find(
      (message) => message.role === 'patient',
    )!.text;
    const h = harness({ loadCorpus: () => corpus });

    await expect(runConversationEvalCli(pilotArgs, h.deps)).resolves.toBe(0);
    const artifact = h.artifacts[0]!;
    const serialized = JSON.stringify(artifact);

    expect(artifact.execution).toMatchObject({
      status: 'pilot_completed',
      reasonCode: 'PILOT_ONLY',
      acceptanceEligible: false,
      expectedTurns: 3,
      providerEligibleTurns: 3,
      deterministicTurns: 0,
      attemptedCalls: 3,
      inputTokens: 300,
      outputTokens: 30,
      costUsd: 0.0009,
      costUpperBoundUsd: 0.0009,
    });
    expect(artifact.config).toMatchObject({
      architecture: 'clinical_memory',
      promptVersion: CLINICAL_EXTRACTOR_PROMPT_VERSION,
      scorerVersion: 'conversation-scorer-v10',
      promptSha256: CLINICAL_EXTRACTOR_PROMPT_SHA256,
      outputSchemaSha256: CLINICAL_EXTRACTOR_SCHEMA_SHA256,
    });
    expect(artifact.results).toHaveLength(3);
    expect(artifact.metrics.overall.expectedTurns).toBe(3);
    expect(serialized).not.toContain(patientText);
    expect(serialized).not.toContain('sk-ant-test-secret-zzqx');
    expect(serialized).not.toContain('provider-prose-must-not-persist-zzqx');
    expect(serialized).not.toContain('patientMessage');
    expect(serialized).not.toContain('modelText');
  });

  it('includes explicit fixture-contract observations so every selected dev turn is represented', async () => {
    const h = harness({ loadCorpus: loadConversationScenarioCorpus });
    const args = [
      '--live',
      '--clinical-memory',
      '--partition=dev',
      '--candidate=thinking_disabled',
      '--max-calls=1000',
      '--max-input-tokens=2808000',
      '--max-output-tokens=479232',
      '--max-cost-usd=15',
    ];

    await expect(runConversationEvalCli(args, h.deps)).resolves.toBe(0);
    const artifact = h.artifacts[0]!;
    expect(artifact.execution).toMatchObject({
      status: 'provider_completed_pending_review',
      reasonCode: 'provider_completed_pending_review',
      acceptanceEligible: false,
      expectedTurns: 33,
      providerEligibleTurns: 27,
      deterministicTurns: 6,
      attemptedCalls: 27,
    });
    expect(artifact.results).toHaveLength(33);
    expect(artifact.results.filter(({ source }) => source === 'provider')).toHaveLength(27);
    expect(artifact.results.filter(({ source }) => source === 'fixture_contract')).toHaveLength(6);
    expect(h.reviewBundles).toHaveLength(1);
    expect(h.reviewBundles[0]!.bundle.items).toHaveLength(27);
    expect(Buffer.byteLength(h.reviewBundles[0]!.serialized, 'utf8')).toBeLessThan(1_000_000);
    expect(artifact).not.toHaveProperty('semanticReview');
    expect(artifact).not.toHaveProperty('semanticReviewFailure');
    expect(
      artifact.results
        .filter(({ source }) => source === 'fixture_contract')
        .every(({ metricSuccesses }) => Object.keys(metricSuccesses).length === 0),
    ).toBe(true);
    expect(artifact.deterministicFixtureCoverage).toEqual({
      expectedTurns: 6,
      representedTurns: 6,
      source: 'fixture_contract',
    });
    expect(artifact.metrics.overall.expectedTurns).toBe(27);
    expect(artifact.metrics.overall.metrics.critical_emergency_safety_recall).toMatchObject({
      status: 'not_applicable',
      denominator: 0,
      pass: null,
    });
    expect(artifact.metrics.overall.metrics.stop_state_correctness).toMatchObject({
      status: 'not_applicable',
      denominator: 0,
      pass: null,
    });
    expect(artifact.metrics.complete).toBe(false);
  });
});

describe('writeConversationEvalArtifactAtomic', () => {
  it('creates unique mode-0600 JSON artifacts without overwriting', async () => {
    const h = harness({ loadCorpus: loadConversationScenarioCorpus });
    await runConversationEvalCli(pilotArgs, h.deps);
    const artifact = h.artifacts[0]!;
    const directory = mkdtempSync(join(tmpdir(), 'medadhere-conversation-eval-'));
    temporaryDirectories.push(directory);

    const first = writeConversationEvalArtifactAtomic(directory, artifact);
    const second = writeConversationEvalArtifactAtomic(directory, {
      ...artifact,
      runId: '00000000-0000-4000-8000-000000000100',
    });

    expect(first).not.toBe(second);
    expect(statSync(first).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(first, 'utf8'))).toEqual(artifact);
  });
});
