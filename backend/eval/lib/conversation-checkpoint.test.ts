import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationTurnResult } from '@medadhere/shared';
import { buildConversationRunnerScenarios } from './conversation-input.js';
import {
  deleteConversationEvalCheckpoint,
  readConversationEvalCheckpoint,
  writeConversationEvalCheckpointAtomic,
  type ConversationEvalCheckpoint,
} from './conversation-checkpoint.js';
import type { ConversationReviewCapture } from './conversation-review-bundle.js';
import { loadConversationScenarioCorpus } from './conversation-scenarios.js';

const temporaryDirectories: string[] = [];
const BINDING = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'medadhere-conversation-checkpoint-'));
  temporaryDirectories.push(directory);
  return directory;
}

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

function capture(scenarioIndex = 0): ConversationReviewCapture {
  const corpus = loadConversationScenarioCorpus();
  const scenario = buildConversationRunnerScenarios(corpus.dev.scenarios.slice(scenarioIndex))[0]!;
  const turn = scenario.turns.find(({ eligibleForProvider }) => eligibleForProvider)!;
  return {
    scenarioId: scenario.scenarioId,
    turnId: turn.turnId,
    preparedTurnInput: turn.payload.turnInput,
    turnResult: turnResult(turn.payload.turnInput.currentMessage.id),
    expectation: turn.payload.expectation,
  };
}

function checkpoint(
  overrides: Partial<ConversationEvalCheckpoint> = {},
): ConversationEvalCheckpoint {
  const baseCapture = capture();
  return {
    schemaVersion: 1,
    checkpointId: 'checkpoint_01',
    bindingSha256: BINDING,
    completedScenarioIds: ['conv-dev-001'],
    results: [
      {
        scenarioId: baseCapture.scenarioId,
        turnId: baseCapture.turnId,
        outcome: 'completed',
        metricSuccesses: {
          structured_output_validity: true,
          unnecessary_question_rate: false,
        },
        latencyMs: 12.5,
        inputTokens: 100,
        outputTokens: 30,
        modelCalls: 2,
        actionType: 'complete_turn',
      },
    ],
    reviewCaptures: [baseCapture],
    usage: {
      attemptedCalls: 2,
      reservedInputTokens: 1_000,
      reservedOutputTokens: 512,
      inputTokens: 100,
      outputTokens: 30,
      cacheCreationInputTokens: 4,
      cacheReadInputTokens: 8,
      thinkingTokens: 0,
    },
    ...overrides,
  };
}

describe('conversation eval checkpoint store', () => {
  it('writes and reads an immutable mode-0600 checkpoint bound to an exact SHA-256 string', () => {
    const directory = temporaryDirectory();
    const original = checkpoint();

    const path = writeConversationEvalCheckpointAtomic(directory, original);
    const read = readConversationEvalCheckpoint(directory, original.checkpointId, BINDING);

    expect(basename(path)).toBe('conversation-checkpoint-checkpoint_01.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(read).toMatchObject(original);
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read.results)).toBe(true);
    expect(Object.isFrozen(read.reviewCaptures[0]?.turnResult)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(read)}\n`);
  });

  it('atomically replaces the same checkpoint after later scenarios complete', () => {
    const directory = temporaryDirectory();
    const original = checkpoint();
    const path = writeConversationEvalCheckpointAtomic(directory, original);
    const updated = checkpoint({
      completedScenarioIds: ['conv-dev-001', 'conv-dev-002'],
      usage: { ...original.usage, attemptedCalls: 4 },
    });

    expect(writeConversationEvalCheckpointAtomic(directory, updated)).toBe(path);
    expect(readConversationEvalCheckpoint(directory, updated.checkpointId, BINDING)).toMatchObject(
      updated,
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('deletes a checkpoint by resolving the filename from the opaque checkpoint ID only', () => {
    const directory = temporaryDirectory();
    const original = checkpoint({ checkpointId: 'checkpoint-delete' });
    const path = writeConversationEvalCheckpointAtomic(directory, original);

    deleteConversationEvalCheckpoint(directory, original.checkpointId);

    expect(existsSync(path)).toBe(false);
    expect(() => deleteConversationEvalCheckpoint(directory, '../escape')).toThrow(
      /invalid conversation eval checkpoint ID/iu,
    );
  });

  it('rejects traversal IDs, binding mismatches, symlinks, and non-0600 files', () => {
    const directory = temporaryDirectory();
    const original = checkpoint();
    const path = writeConversationEvalCheckpointAtomic(directory, original);

    expect(() => readConversationEvalCheckpoint(directory, '../escape', BINDING)).toThrow(
      /invalid conversation eval checkpoint ID/iu,
    );
    expect(() =>
      readConversationEvalCheckpoint(directory, original.checkpointId, `sha256:${'b'.repeat(64)}`),
    ).toThrow(/binding mismatch/iu);

    const linkId = 'checkpoint_link';
    const linkPath = join(directory, 'conversation-checkpoint-checkpoint_link.json');
    symlinkSync(path, linkPath);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(() => readConversationEvalCheckpoint(directory, linkId, BINDING)).toThrow(
      /not a regular checkpoint file/iu,
    );

    chmodSync(path, 0o644);
    expect(() => readConversationEvalCheckpoint(directory, original.checkpointId, BINDING)).toThrow(
      /insecure checkpoint file mode/iu,
    );
  });

  it('rejects duplicate completed scenario IDs and mismatched stored IDs', () => {
    const directory = temporaryDirectory();
    const duplicate = checkpoint({
      completedScenarioIds: ['conv-dev-001', 'conv-dev-001'],
      checkpointId: 'checkpoint-duplicate',
    });
    expect(() => writeConversationEvalCheckpointAtomic(directory, duplicate)).toThrow(
      /duplicate completed scenario ID/iu,
    );

    const path = join(directory, 'conversation-checkpoint-checkpoint_wrong.json');
    writeFileSync(
      path,
      `${JSON.stringify({ ...checkpoint({ checkpointId: 'stored-other' }) })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    chmodSync(path, 0o600);
    expect(() => readConversationEvalCheckpoint(directory, 'checkpoint_wrong', BINDING)).toThrow(
      /checkpoint ID mismatch/iu,
    );
  });

  it('rejects duplicate result and review-capture turn IDs', () => {
    const directory = temporaryDirectory();
    const duplicateResult = checkpoint({
      checkpointId: 'checkpoint-duplicate-result',
      results: [checkpoint().results[0]!, checkpoint().results[0]!],
    });
    expect(() => writeConversationEvalCheckpointAtomic(directory, duplicateResult)).toThrow(
      /duplicate checkpoint result turn ID/iu,
    );

    const duplicateCapture = checkpoint({
      checkpointId: 'checkpoint-duplicate-capture',
      reviewCaptures: [capture(), capture()],
    });
    expect(() => writeConversationEvalCheckpointAtomic(directory, duplicateCapture)).toThrow(
      /duplicate checkpoint review capture turn ID/iu,
    );
  });

  it('rejects invalid sanitized run results and invalid review captures', () => {
    const directory = temporaryDirectory();
    expect(() =>
      writeConversationEvalCheckpointAtomic(
        directory,
        checkpoint({
          checkpointId: 'checkpoint-bad-result',
          results: [
            {
              ...checkpoint().results[0]!,
              outcome: 'not-real',
            } as never,
          ],
        }),
      ),
    ).toThrow(/invalid conversation eval checkpoint/iu);

    expect(() =>
      writeConversationEvalCheckpointAtomic(
        directory,
        checkpoint({
          checkpointId: 'checkpoint-bad-capture',
          reviewCaptures: [
            {
              ...capture(),
              turnResult: { action: { type: 'complete_turn' } },
            } as never,
          ],
        }),
      ),
    ).toThrow(/invalid conversation review capture/iu);
  });
});
