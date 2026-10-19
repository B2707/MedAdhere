import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const turnProcessorSource = readFileSync(join(__dirname, 'turn-processor.ts'), 'utf8');
const queueWorkerSource = readFileSync(join(__dirname, 'queue-worker.ts'), 'utf8');
const runtimeRepositorySource = readFileSync(join(__dirname, 'runtime-repository.ts'), 'utf8');
const gatewayHandlerSource = readFileSync(join(__dirname, 'gateway-handler.ts'), 'utf8');
const gatewayContractSource = readFileSync(join(__dirname, 'gateway-contract.ts'), 'utf8');
const runtimeStageRepositorySource = readFileSync(
  join(__dirname, 'runtime-stage-repository.ts'),
  'utf8',
);
const runtimeConsentSource = readFileSync(join(__dirname, 'runtime-consent.ts'), 'utf8');
const evalCliSource = readFileSync(join(__dirname, '../../eval/run-conversation-eval.ts'), 'utf8');
const evalProviderSource = readFileSync(
  join(__dirname, '../../eval/lib/conversation-provider.ts'),
  'utf8',
);
const sharedIndexSource = readFileSync(
  join(__dirname, '../../../packages/shared/src/index.ts'),
  'utf8',
);

describe('production conversation ownership', () => {
  it('routes the deployed worker through only the clinical-memory semantic owner', () => {
    expect(queueWorkerSource).toContain('processConversationJob');
    expect(turnProcessorSource).toContain('await processClinicalMemoryJobCore');

    for (const legacyEdge of [
      'processConversationJobCore',
      "from './final-policy.js'",
      "from './turn-engine.js'",
    ]) {
      expect(turnProcessorSource).not.toContain(legacyEdge);
    }
  });

  it('does not expose the retired final persistence and projection owners', () => {
    expect(runtimeRepositorySource).not.toContain("export * from './runtime-final-repository.js'");

    for (const retiredModule of [
      'final-policy.ts',
      'runtime-final-repository.ts',
      'runtime-clinical-projection.ts',
      'runtime-clinical-projection-temporal.ts',
    ]) {
      expect(existsSync(join(__dirname, retiredModule))).toBe(false);
    }
  });

  it('keeps bounded extraction under the clinical-memory owner', () => {
    expect(existsSync(join(__dirname, 'clinical-memory/bounded-provider.ts'))).toBe(true);
    expect(existsSync(join(__dirname, 'clinical-memory/anthropic-extractor.ts'))).toBe(true);

    for (const source of [
      turnProcessorSource,
      gatewayHandlerSource,
      gatewayContractSource,
      runtimeStageRepositorySource,
    ]) {
      expect(source).not.toContain("from './anthropic-stage-model.js'");
      expect(source).not.toContain("from './interpretation-provider-boundary.js'");
    }
  });

  it('keeps only bounded checkpoint and short consent-lock stage behavior', () => {
    for (const retiredStageOwner of [
      'conversationInterpretationSchema',
      'conversationWriterResultSchema',
      'interpretationStageRecordSchema',
      'writerStageRecordSchema',
      'loadConversationStageResults',
    ]) {
      expect(runtimeStageRepositorySource).not.toContain(retiredStageOwner);
    }
    expect(runtimeConsentSource).not.toContain('messagingConsentContextHash');
    expect(runtimeConsentSource).not.toContain('withMessagingConsent');
    expect(existsSync(join(__dirname, 'runtime-consent.db.test.ts'))).toBe(false);
  });

  it('runs evaluation through only the clinical-memory provider', () => {
    expect(evalCliSource).toContain('createAnthropicClinicalMemoryConversationProvider');
    expect(evalCliSource).toContain("architecture: 'clinical_memory'");

    for (const retiredEvalOwner of [
      'buildAnthropicConversationRequest',
      'createAnthropicConversationProvider',
      'buildAnthropicStagedTurnPreflight',
      'createAnthropicStagedConversationProvider',
      'createStagedProvider',
      'CONVERSATION_STAGED_',
      "staged: { type: 'boolean' }",
    ]) {
      expect(evalCliSource).not.toContain(retiredEvalOwner);
    }
  });

  it('removes the zero-caller legacy conversation engine and shared semantic owners', () => {
    for (const retiredModule of [
      'turn-engine.ts',
      'turn-engine.test.ts',
      'anthropic-stage-model.ts',
      'anthropic-stage-model.test.ts',
      'interpretation-provider-boundary.ts',
      'interpretation-provider-boundary.test.ts',
      '../../eval/lib/conversation-staged-provider.ts',
      '../../eval/lib/conversation-staged-provider.test.ts',
      '../../../packages/shared/src/conversation-workflow.ts',
      '../../../packages/shared/src/conversation-workflow.test.ts',
      '../../../packages/shared/src/conversation-provider.ts',
      '../../../packages/shared/src/conversation-provider.test.ts',
      '../../../packages/shared/src/conversation-wording.ts',
      '../../../packages/shared/src/conversation-wording.test.ts',
    ]) {
      expect(existsSync(join(__dirname, retiredModule))).toBe(false);
    }

    for (const retiredEvalOwner of [
      'buildAnthropicConversationRequest',
      'createAnthropicConversationProvider',
      'prepareConversationTurnInput',
      'CONVERSATION_EVAL_PROMPT_',
    ]) {
      expect(evalProviderSource).not.toContain(retiredEvalOwner);
    }

    for (const retiredSharedExport of [
      "from './conversation-wording.js'",
      "from './conversation-workflow.js'",
      "from './conversation-provider.js'",
    ]) {
      expect(sharedIndexSource).not.toContain(retiredSharedExport);
    }
  });
});
