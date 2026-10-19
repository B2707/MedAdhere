import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationTurnResult } from '@medadhere/shared';
import { buildConversationRunnerScenarios } from './lib/conversation-input.js';
import {
  freezeConversationReviewBundle as freezeConversationReviewBundleWithProvenance,
  writeConversationReviewBundle,
  type ConversationReviewCapture,
} from './lib/conversation-review-bundle.js';
import { loadConversationScenarioCorpus } from './lib/conversation-scenarios.js';
import {
  SEMANTIC_REVIEW_CODEBOOK_HASH,
  SEMANTIC_REVIEW_CODEBOOK_VERSION,
} from './lib/conversation-semantic-review.js';
import semanticReviewCodebook from './conversation/semantic-review-codebook.v2.json';
import {
  buildPhoenixConversationDataset,
  runPhoenixConversationCli,
  uploadPhoenixConversationExperiment,
} from './conversation-phoenix.js';

const temporaryDirectories: string[] = [];
const DEV_V2_PROVENANCE = {
  evalSetVersion: 'v2',
  partition: 'dev',
  corpusSha256: 'afdfbff857e8452e0c80f65a9c73fa936579cf43777d292027f5309848be798a',
} as const;

function freezeConversationReviewBundle(
  captures: readonly ConversationReviewCapture[],
  expiresAtUtc: string,
) {
  return freezeConversationReviewBundleWithProvenance(captures, expiresAtUtc, DEV_V2_PROVENANCE);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function turnResult(sourceMessageId: string): ConversationTurnResult {
  return {
    detectedLanguage: 'en',
    languageConfidence: 0.99,
    mixedLanguage: false,
    translationUncertain: false,
    normalizedEnglishMeaning: 'The patient says they took the medication.',
    adherenceClassification: {
      adherence_state: 'taken',
      reason_code: 'none',
      safety_flag: 'none',
    },
    observations: [],
    temporalCandidateIds: [],
    action: { type: 'complete_turn' },
    socialAcknowledgement: 'Thanks for letting me know.',
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

function capture(): ConversationReviewCapture {
  const corpus = loadConversationScenarioCorpus();
  const scenario = buildConversationRunnerScenarios(corpus.dev.scenarios.slice(0, 1))[0]!;
  const turn = scenario.turns.find(({ eligibleForProvider }) => eligibleForProvider)!;
  return {
    scenarioId: scenario.scenarioId,
    turnId: turn.turnId,
    preparedTurnInput: turn.payload.turnInput,
    turnResult: turnResult(turn.payload.turnInput.currentMessage.id),
    expectation: turn.payload.expectation,
  };
}

function scenarioCaptures(index = 0): readonly ConversationReviewCapture[] {
  const corpus = loadConversationScenarioCorpus();
  const scenario = buildConversationRunnerScenarios(
    corpus.dev.scenarios.slice(index, index + 1),
  )[0]!;
  return scenario.turns
    .filter(({ eligibleForProvider }) => eligibleForProvider)
    .map((turn) => ({
      scenarioId: scenario.scenarioId,
      turnId: turn.turnId,
      preparedTurnInput: turn.payload.turnInput,
      turnResult: turnResult(turn.payload.turnInput.currentMessage.id),
      expectation: turn.payload.expectation,
    }));
}

function bundlePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'medadhere-phoenix-'));
  temporaryDirectories.push(directory);
  return writeConversationReviewBundle(
    directory,
    'phoenix-test',
    freezeConversationReviewBundle([capture()], '2026-08-11T02:49:16.321Z'),
  );
}

describe('Phoenix conversation evaluation export', () => {
  it('maps a canonical dev-only bundle to a stable Phoenix reference dataset', () => {
    const frozen = freezeConversationReviewBundle([capture()], '2026-08-11T02:49:16.321Z');

    const dataset = buildPhoenixConversationDataset(frozen);

    expect(dataset.name).toBe('medadhere-conversation-dev-v2');
    expect(dataset.action).toBe('update');
    expect(dataset.inputs).toEqual([
      {
        conversationScenarioInput: {
          initialContext: {
            currentDayMessages: frozen.bundle.items[0]!.preparedTurnInput.currentDayMessages,
            pendingClarification: frozen.bundle.items[0]!.preparedTurnInput.pendingClarification,
            pendingClarificationTopic:
              frozen.bundle.items[0]!.preparedTurnInput.pendingClarificationTopic,
            recentObservations: frozen.bundle.items[0]!.preparedTurnInput.recentObservations,
          },
          turns: [
            expect.objectContaining({
              turnId: frozen.bundle.items[0]!.turnId,
              currentMessage: frozen.bundle.items[0]!.preparedTurnInput.currentMessage,
            }),
          ],
        },
      },
    ]);
    expect(dataset.outputs).toEqual([
      {
        conversationScenarioReference: {
          turns: [
            {
              turnId: frozen.bundle.items[0]!.turnId,
              expectation: frozen.bundle.items[0]!.expectation,
            },
          ],
        },
      },
    ]);
    expect(dataset.metadata[0]).toMatchObject({
      synthetic: true,
      evalSetVersion: 'v2',
      corpusSha256: DEV_V2_PROVENANCE.corpusSha256,
      scenarioId: frozen.bundle.items[0]!.scenarioId,
      turnIds: [frozen.bundle.items[0]!.turnId],
      languages: [frozen.bundle.items[0]!.expectation.language],
      safetySlices: frozen.bundle.items[0]!.expectation.safetySlices,
      temporalSlices: frozen.bundle.items[0]!.expectation.temporalSlices,
      retrievalSlices: frozen.bundle.items[0]!.expectation.retrievalSlices,
      semanticMetricIds: frozen.bundle.items[0]!.semanticMetricIds,
    });
    expect(dataset.metadata[0]).not.toHaveProperty('outputHash');
    expect(dataset.metadata[0]).not.toHaveProperty('promptVersion');
    expect(dataset.splits).toEqual(['dev']);
    expect(dataset.example_ids).toEqual([frozen.bundle.items[0]!.scenarioId]);

    const changedOutput = freezeConversationReviewBundle(
      [
        {
          ...capture(),
          turnResult: {
            ...turnResult(capture().turnId),
            socialAcknowledgement: 'A different candidate response.',
          },
          preparedTurnInput: {
            ...capture().preparedTurnInput,
            promptVersion: 'conversation-v99',
          },
        },
      ],
      '2026-08-11T02:49:16.321Z',
    );
    expect(buildPhoenixConversationDataset(changedOutput).name).toBe(dataset.name);
  });

  it('keeps a multi-turn patient conversation in one Phoenix dataset example', () => {
    const captures = scenarioCaptures();
    const frozen = freezeConversationReviewBundle(captures, '2026-08-11T02:49:16.321Z');

    const dataset = buildPhoenixConversationDataset(frozen);

    expect(frozen.bundle.items).toHaveLength(3);
    expect(dataset.inputs).toHaveLength(1);
    expect(dataset.outputs).toHaveLength(1);
    expect(dataset.metadata).toHaveLength(1);
    expect(dataset.splits).toEqual(['dev']);
    expect(dataset.inputs[0]).toMatchObject({
      conversationScenarioInput: { turns: frozen.bundle.items.map(({ turnId }) => ({ turnId })) },
    });

    const changedHistory = freezeConversationReviewBundle(
      captures.map((item, index) =>
        index === 1
          ? {
              ...item,
              preparedTurnInput: {
                ...item.preparedTurnInput,
                currentDayMessages: [
                  ...item.preparedTurnInput.currentDayMessages,
                  {
                    id: '11111111-1111-4111-8111-111111111111',
                    direction: 'outbound' as const,
                    body: 'A different candidate history.',
                    occurredAtUtc: '2026-08-09T12:59:00.000Z',
                    language: 'en',
                  },
                ],
              },
            }
          : item,
      ),
      '2026-08-11T02:49:16.321Z',
    );
    expect(buildPhoenixConversationDataset(changedHistory).name).toBe(dataset.name);
  });

  it('retains patient memory that existed before the evaluated conversation', () => {
    const captures = scenarioCaptures(6);
    const frozen = freezeConversationReviewBundle(captures, '2026-08-11T02:49:16.321Z');
    const dataset = buildPhoenixConversationDataset(frozen);

    expect(dataset.inputs[0]).toMatchObject({
      conversationScenarioInput: {
        initialContext: {
          recentObservations: frozen.bundle.items[0]!.preparedTurnInput.recentObservations,
        },
      },
    });
    expect(frozen.bundle.items[0]!.preparedTurnInput.recentObservations.length).toBeGreaterThan(0);

    const changedInitialMemory = freezeConversationReviewBundle(
      captures.map((item, index) =>
        index === 0
          ? {
              ...item,
              preparedTurnInput: { ...item.preparedTurnInput, recentObservations: [] },
            }
          : item,
      ),
      '2026-08-11T02:49:16.321Z',
    );
    expect(buildPhoenixConversationDataset(changedInitialMemory).name).toBe(dataset.name);
    expect(buildPhoenixConversationDataset(changedInitialMemory).description).not.toBe(
      dataset.description,
    );
  });

  it('uploads a reference dataset and records candidate output as a Phoenix experiment', async () => {
    const captures = scenarioCaptures();
    const frozen = freezeConversationReviewBundle(
      captures.map((captured, index) =>
        index === 0
          ? {
              ...captured,
              turnResult: {
                ...captured.turnResult,
                socialAcknowledgement: 'Thanks. Did anything change?',
              },
            }
          : captured,
      ),
      '2026-08-11T02:49:16.321Z',
    );
    const items = frozen.bundle.items;
    let uploadAttempts = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/datasets/upload?sync=true')) {
        uploadAttempts += 1;
        if (uploadAttempts === 1) {
          return new Response('Invalid dataset action', { status: 422 });
        }
        return Response.json({ data: { dataset_id: 'phoenix-dataset-id' } });
      }
      if (url.endsWith('/v1/datasets/phoenix-dataset-id/examples')) {
        return Response.json({
          data: {
            dataset_id: 'phoenix-dataset-id',
            version_id: 'phoenix-version-id',
            examples: [
              {
                id: 'phoenix-example-id',
                node_id: 'phoenix-example-node-id',
                metadata: { scenarioId: items[0]!.scenarioId },
              },
            ],
          },
        });
      }
      if (url.endsWith('/v1/datasets/phoenix-dataset-id/experiments')) {
        return Response.json({ data: { id: 'phoenix-experiment-id' } });
      }
      if (url.endsWith('/v1/experiments/phoenix-experiment-id/runs')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          dataset_example_id: 'phoenix-example-node-id',
          output: {
            conversationTurns: items.map(
              ({ turnId, preparedTurnInput, turnResult, outputHash }) => ({
                turnId,
                preparedTurnInput,
                turnResult,
                outputHash,
              }),
            ),
          },
          repetition_number: 1,
        });
        return Response.json({ data: { id: 'phoenix-run-id' } });
      }
      if (url.endsWith('/v1/experiment_evaluations')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          experiment_run_id: 'phoenix-run-id',
          annotator_kind: 'CODE',
          result: { label: expect.stringMatching(/^(pass|fail)$/u), score: expect.any(Number) },
          metadata: {
            scorerVersion: 'conversation-scorer-v10',
            numerator: expect.any(Number),
            denominator: expect.any(Number),
          },
        });
        return Response.json({ data: { id: 'phoenix-evaluation-id' } });
      }
      return new Response('unexpected request', { status: 500 });
    });

    await expect(
      uploadPhoenixConversationExperiment(frozen, {
        endpoint: 'http://127.0.0.1:6006',
        confirmSynthetic: true,
        candidateConfigId: 'thinking_disabled',
        fetcher,
      }),
    ).resolves.toEqual({
      datasetId: 'phoenix-dataset-id',
      experimentId: 'phoenix-experiment-id',
      scenarioCount: 1,
      turnCount: 3,
    });

    expect(fetcher).toHaveBeenCalledTimes(7);
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://127.0.0.1:6006/v1/datasets/upload?sync=true');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      action: 'update',
    });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
      action: 'create',
    });
    expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body))).toMatchObject({
      name: expect.stringContaining('thinking-disabled'),
      version_id: 'phoenix-version-id',
      metadata: {
        candidateConfigId: 'thinking_disabled',
        scorerVersion: 'conversation-scorer-v10',
      },
    });
    expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body)).name).toContain(
      'conversation-scorer-v10',
    );
    const evaluations = fetcher.mock.calls.filter(([url]) =>
      String(url).endsWith('/v1/experiment_evaluations'),
    );
    expect(evaluations).toHaveLength(2);
    expect(evaluations.map(([, init]) => JSON.parse(String(init?.body)).name).sort()).toEqual([
      'structured_output_validity',
      'unnecessary_question_rate',
    ]);
    // conv-dev-001 turn 1 now applies `unnecessary_question_rate` (its dose-time question went
    // away with the model-guessed dose candidate), and this fixture injects a hidden question
    // into that turn's acknowledgement, so the metric legitimately aggregates 2/3 and fails.
    expect(
      evaluations
        .map(([, init]) => JSON.parse(String(init?.body)))
        .map(({ name, result }) => [name, result.label])
        .sort(),
    ).toEqual([
      ['structured_output_validity', 'pass'],
      ['unnecessary_question_rate', 'fail'],
    ]);
  });

  it('rejects legacy review bundles instead of contaminating the v2 dataset', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'medadhere-phoenix-legacy-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'legacy.json');
    const frozen = freezeConversationReviewBundle([capture()], '2026-08-11T02:49:16.321Z');
    writeFileSync(
      path,
      `${JSON.stringify({
        schemaVersion: 1,
        expiresAtUtc: frozen.bundle.expiresAtUtc,
        codebook: {
          version: SEMANTIC_REVIEW_CODEBOOK_VERSION,
          hash: SEMANTIC_REVIEW_CODEBOOK_HASH,
          codes: semanticReviewCodebook.codes,
        },
        items: frozen.bundle.items,
      })}\n`,
      { mode: 0o600 },
    );
    const fetcher = vi.fn();

    await expect(
      runPhoenixConversationCli(
        ['--bundle', path, '--candidate=thinking_disabled', '--confirm-synthetic'],
        {
          fetcher,
          logCode: vi.fn(),
        },
      ),
    ).rejects.toThrow(/canonical/iu);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not create an experiment when Phoenix returns the wrong dataset examples', async () => {
    const frozen = freezeConversationReviewBundle([capture()], '2026-08-11T02:49:16.321Z');
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: { dataset_id: 'phoenix-dataset-id' } }))
      .mockResolvedValueOnce(
        Response.json({
          data: {
            dataset_id: 'phoenix-dataset-id',
            version_id: 'phoenix-version-id',
            examples: [],
          },
        }),
      );

    await expect(
      uploadPhoenixConversationExperiment(frozen, {
        confirmSynthetic: true,
        candidateConfigId: 'adaptive_high',
        fetcher,
      }),
    ).rejects.toThrow(/do not match/iu);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('fails closed for missing synthetic confirmation, remote endpoints, tampering, or non-0600 input', async () => {
    const path = bundlePath();
    const fetcher = vi.fn();

    await expect(
      runPhoenixConversationCli(['--bundle', path, '--candidate=unknown', '--confirm-synthetic'], {
        fetcher,
        logCode: vi.fn(),
      }),
    ).rejects.toThrow(/candidate/iu);
    await expect(
      runPhoenixConversationCli(['--bundle', path, '--candidate=thinking_disabled'], {
        fetcher,
        logCode: vi.fn(),
      }),
    ).rejects.toThrow(/confirm-synthetic/iu);
    await expect(
      runPhoenixConversationCli(
        [
          '--bundle',
          path,
          '--candidate=thinking_disabled',
          '--confirm-synthetic',
          '--endpoint=https://x',
        ],
        {
          fetcher,
          logCode: vi.fn(),
        },
      ),
    ).rejects.toThrow(/loopback/iu);

    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(/"outputHash":"[^"]+"/u, '"outputHash":"tampered"'),
    );
    await expect(
      runPhoenixConversationCli(
        ['--bundle', path, '--candidate=thinking_disabled', '--confirm-synthetic'],
        {
          fetcher,
          logCode: vi.fn(),
        },
      ),
    ).rejects.toThrow(/canonical/iu);

    const otherPath = bundlePath();
    chmodSync(otherPath, 0o644);
    expect(statSync(otherPath).mode & 0o777).toBe(0o644);
    await expect(
      runPhoenixConversationCli(
        ['--bundle', otherPath, '--candidate=thinking_disabled', '--confirm-synthetic'],
        {
          fetcher,
          logCode: vi.fn(),
        },
      ),
    ).rejects.toThrow(/0600/iu);
  });
});
