// Wave 1b Lane C — compose plumbing unit contract.
// The composer module itself (prompt + validators) is Lane B; the gateway stage is Lane A.
// These tests pin everything AROUND them: the never-composed eligibility set, the send-time
// integrity re-check (composed_body ?? body), the timeout-then-template orchestration, and
// identifier-free fallback metrics.

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PreparedClinicalTurn } from './clinical-memory/index.js';
import { CURRENT_CLINICAL_PIPELINE_VERSIONS } from './clinical-memory/index.js';
import { COMPOSER_TOTAL_TIMEOUT_MS } from './clinical-memory/composer.js';
import { EXPLAINERS } from './clinical-memory/response.js';
import type { ComposerIntent } from './clinical-memory/composer-validators.js';
import type { ComposerDayContext } from './clinical-memory/composer-envelope.js';
import {
  COMPOSABLE_MESSAGE_KINDS,
  COMPOSED_SMS_MAX_CODE_POINTS,
  COMPOSER_DEFAULT_MODEL_ID,
  COMPOSER_DISABLE_ENV,
  COMPOSER_INPUT_BUCKET_SUFFIX,
  COMPOSER_OUTPUT_BUCKET_SUFFIX,
  COMPOSER_PROVIDER_CIRCUIT_KEY,
  COMPOSER_SEAM_TIMEOUT_MS,
  COMPOSER_TIMEOUT_MS,
  composeAndCheckpointPreparedReply,
  composerBudgetBucketKeys,
  composerIntentFromPrepared,
  composerModelId,
  isComposerEnabled,
  isComposeEligibleTurn,
  resolveOutboundSendBody,
  validateStoredCompositionRecord,
  verifyComposedBodyIntegrity,
  type ComposePersistence,
  type ComposeSeamOutcome,
  type MetricEntry,
} from './compose-plumbing.js';

const PATIENT_ID = '00000000-0000-4000-8000-000000000003';
const INBOUND_ID = '00000000-0000-4000-8000-000000000001';
const AGENT_TURN_ID = '00000000-0000-4000-8000-000000000005';
const OUTBOUND_ID = '00000000-0000-4000-8000-000000000004';
const TURN_JOB_ID = '00000000-0000-4000-8000-000000000006';

/** A minimal intent + day context under which DRAFT_SMS passes the full validator set. */
const DRAFT_INTENT: ComposerIntent = {
  kind: 'acknowledgement',
  requiredTokens: [],
  allowedTerms: [],
  medications: [],
  patientFacts: [],
};
const DRAFT_DAY_CONTEXT: ComposerDayContext = {
  messages: [],
  latestPatientMessage: 'took it this morning',
};
const DRAFT_SMS = 'Got it, thanks for the update.';
const DRAFT_INPUT_HASH = 'c'.repeat(64);
const DRAFT_ATTEMPTS = [
  { rawOutput: JSON.stringify({ sms: DRAFT_SMS }), verdict: { ok: true as const, sms: DRAFT_SMS } },
];

function validDraft(sms = DRAFT_SMS) {
  return {
    sms,
    intent: DRAFT_INTENT,
    dayContext: DRAFT_DAY_CONTEXT,
    inputHash: DRAFT_INPUT_HASH,
    attempts: DRAFT_ATTEMPTS,
    provenance: { modelId: COMPOSER_DEFAULT_MODEL_ID },
  };
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fakePrepared(
  overrides: Partial<{
    responsePlanKind: PreparedClinicalTurn['responsePlan']['kind'];
    reviewReasons: readonly string[];
    commandKinds: readonly string[];
    commands: readonly unknown[];
    runtimeFailure: PreparedClinicalTurn['runtimeFailure'];
    recordOnly: true;
    acknowledgementId: string;
    question: PreparedClinicalTurn['responsePlan']['question'];
    pendingReask: PreparedClinicalTurn['responsePlan']['pendingReask'];
  }> = {},
): PreparedClinicalTurn {
  const commands = (overrides.commands ??
    (overrides.commandKinds ?? []).map((kind) => ({
      kind,
    }))) as unknown as PreparedClinicalTurn['commands'];
  return {
    patientId: PATIENT_ID,
    idempotencyKey: 'idem-1',
    sourceMessageId: INBOUND_ID,
    sourceSequence: 1,
    baseMemoryVersion: 0,
    consentEpoch: 1,
    contextHash: '0'.repeat(64),
    pipelineVersions: CURRENT_CLINICAL_PIPELINE_VERSIONS,
    commands,
    commandHash: 'a'.repeat(64),
    responsePlan: {
      kind: overrides.responsePlanKind ?? 'routine',
      reviewReasons: overrides.reviewReasons ?? [],
      ...(overrides.acknowledgementId === undefined
        ? {}
        : { acknowledgementId: overrides.acknowledgementId }),
      ...(overrides.question === undefined ? {} : { question: overrides.question }),
      ...(overrides.pendingReask === undefined ? {} : { pendingReask: overrides.pendingReask }),
    },
    responseText: 'Thanks, noted.',
    preparedHash: 'b'.repeat(64),
    ...(overrides.runtimeFailure === undefined ? {} : { runtimeFailure: overrides.runtimeFailure }),
    ...(overrides.recordOnly === undefined ? {} : { recordOnly: overrides.recordOnly }),
  } as unknown as PreparedClinicalTurn;
}

function fakePersistence(overrides: Partial<ComposePersistence> = {}): ComposePersistence {
  return {
    isEnabled: vi.fn(async () => ({ enabled: true as const, reason: null })),
    checkpoint: vi.fn(async () => true),
    recordOutcome: vi.fn(async () => ({ autoDisabled: false })),
    ...overrides,
  };
}

const composeTarget = {
  outboundMessageId: OUTBOUND_ID,
  patientId: PATIENT_ID,
  agentTurnId: AGENT_TURN_ID,
  turnJobId: TURN_JOB_ID,
  medicationNames: [],
  dayContext: DRAFT_DAY_CONTEXT,
} as const;

/** The turn-scoped audit linkage recordOutcome must always receive. */
const AUDIT_TARGET = { turnJobId: TURN_JOB_ID, patientId: PATIENT_ID } as const;

function composerReturning(outcome: ComposeSeamOutcome) {
  return { compose: vi.fn(async () => outcome) };
}

describe('composer configuration constants', () => {
  it('pins the owner-decision model, timeout, and isolation keys', () => {
    expect(COMPOSER_DEFAULT_MODEL_ID).toBe('claude-haiku-4-5-20251001');
    expect(composerModelId()).toBe(COMPOSER_DEFAULT_MODEL_ID);
    expect(COMPOSER_TIMEOUT_MS).toBeGreaterThanOrEqual(8_000);
    expect(COMPOSER_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    // The whole-seam budget must stay STRICTLY above the gateway's whole-composition budget,
    // which must stay strictly above one attempt — otherwise the bounded retry is unreachable
    // and every slow composition is mislabeled 'timeout' in the >30% abort window.
    expect(COMPOSER_SEAM_TIMEOUT_MS).toBeGreaterThan(COMPOSER_TOTAL_TIMEOUT_MS);
    expect(COMPOSER_TOTAL_TIMEOUT_MS).toBeGreaterThan(COMPOSER_TIMEOUT_MS * 2);
    // The composer must never share the extractor's circuit or budget buckets.
    expect(COMPOSER_PROVIDER_CIRCUIT_KEY).not.toBe('anthropic:claude-sonnet-5');
    expect(COMPOSER_INPUT_BUCKET_SUFFIX).toBe(':writer-input');
    expect(COMPOSER_OUTPUT_BUCKET_SUFFIX).toBe(':writer-output');
    // Drift pin: the plumbing suffix views must agree with the composer module's bucket keys.
    expect(composerBudgetBucketKeys('p')).toEqual({
      input: `p${COMPOSER_INPUT_BUCKET_SUFFIX}`,
      output: `p${COMPOSER_OUTPUT_BUCKET_SUFFIX}`,
    });
    expect(COMPOSED_SMS_MAX_CODE_POINTS).toBe(320);
  });

  it('is env-swappable to another model id', () => {
    process.env.CLINICAL_COMPOSER_MODEL = 'claude-sonnet-5';
    try {
      expect(composerModelId()).toBe('claude-sonnet-5');
    } finally {
      delete process.env.CLINICAL_COMPOSER_MODEL;
    }
  });
});

describe('isComposeEligibleTurn — the never-composed set', () => {
  it('accepts a clean routine turn and a clean question turn', () => {
    expect(isComposeEligibleTurn(fakePrepared(), false)).toBe(true);
    expect(isComposeEligibleTurn(fakePrepared({ responsePlanKind: 'question' }), false)).toBe(true);
  });

  it.each(['emergency', 'stop', 'important', 'human_review', 'unsupported_language'] as const)(
    'never composes a %s reply',
    (kind) => {
      expect(isComposeEligibleTurn(fakePrepared({ responsePlanKind: kind }), false)).toBe(false);
    },
  );

  it('never composes a turn carrying a safety event', () => {
    expect(
      isComposeEligibleTurn(fakePrepared({ commandKinds: ['RaiseSafetySignal'] }), false),
    ).toBe(false);
  });

  it('never composes a turn with unresolved-report deltas', () => {
    expect(
      isComposeEligibleTurn(fakePrepared({ commandKinds: ['PreserveUnresolvedContent'] }), false),
    ).toBe(false);
  });

  it('never composes a turn with non-empty reviewReasons', () => {
    expect(isComposeEligibleTurn(fakePrepared({ reviewReasons: ['odd input'] }), false)).toBe(
      false,
    );
  });

  it('never composes a runtime-failure turn', () => {
    expect(isComposeEligibleTurn(fakePrepared({ runtimeFailure: 'provider_error' }), false)).toBe(
      false,
    );
  });

  it('never composes a record-only turn', () => {
    expect(isComposeEligibleTurn(fakePrepared({ recordOnly: true }), false)).toBe(false);
  });

  it('never composes a plan whose only content is a pending re-ask (Lane Q route (a))', () => {
    // The deterministic core's decision on this turn IS the restated question, and it lives in
    // `pendingReask`, not in `question` — the intent builder has no slot for it, so composing
    // would ship a question-free acknowledgement of a recording that never happened.
    expect(
      isComposeEligibleTurn(
        fakePrepared({
          pendingReask: { kind: 'prompted_dose', doseId: 'dose-1', medicationLabel: 'metformin' },
        }),
        false,
      ),
    ).toBe(false);
  });

  it('never composes while routine clarifications are paused, including a same-turn pause', () => {
    expect(isComposeEligibleTurn(fakePrepared(), true)).toBe(false);
    expect(
      isComposeEligibleTurn(fakePrepared({ commandKinds: ['PauseRoutineClarification'] }), false),
    ).toBe(false);
  });
});

describe('verifyComposedBodyIntegrity + resolveOutboundSendBody — send-time re-check', () => {
  const sms = 'Glad the morning dose went down okay. How is the headache now?';
  const provenance = { composedBodySha256: sha256(sms), modelId: COMPOSER_DEFAULT_MODEL_ID };

  it('accepts an untampered composed body', () => {
    expect(verifyComposedBodyIntegrity(sms, provenance)).toBe(true);
  });

  it('rejects a tampered body, a missing provenance, and an oversize body', () => {
    expect(verifyComposedBodyIntegrity('tampered text', provenance)).toBe(false);
    expect(verifyComposedBodyIntegrity(sms, null)).toBe(false);
    expect(verifyComposedBodyIntegrity(sms, {})).toBe(false);
    const oversize = '💊'.repeat(COMPOSED_SMS_MAX_CODE_POINTS + 1);
    expect(verifyComposedBodyIntegrity(oversize, { composedBodySha256: sha256(oversize) })).toBe(
      false,
    );
  });

  it('counts the ceiling in code points, not UTF-16 units', () => {
    const exactly320 = '💊'.repeat(COMPOSED_SMS_MAX_CODE_POINTS);
    expect(exactly320.length).toBeGreaterThan(COMPOSED_SMS_MAX_CODE_POINTS);
    expect(
      verifyComposedBodyIntegrity(exactly320, { composedBodySha256: sha256(exactly320) }),
    ).toBe(true);
  });

  it('transmits the composed body when it verifies', () => {
    const resolved = resolveOutboundSendBody({
      body: 'Template.',
      composedBody: sms,
      composition: provenance,
      messageKind: 'acknowledgement',
    });
    expect(resolved).toEqual({ body: sms, usedComposedBody: true });
  });

  it('falls back to the template body on a tampered composed row and emits an identifier-free metric', () => {
    const emitted: MetricEntry[] = [];
    const resolved = resolveOutboundSendBody(
      {
        body: 'Template.',
        composedBody: 'tampered text',
        composition: provenance,
        messageKind: 'acknowledgement',
      },
      { emit: (entry) => emitted.push(entry) },
    );
    expect(resolved).toEqual({ body: 'Template.', usedComposedBody: false });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.metric).toBe('composed_body_send_check_failed');
    expect(JSON.stringify(emitted[0])).not.toMatch(UUID_PATTERN);
    expect(JSON.stringify(emitted[0])).not.toContain('tampered');
  });

  it('uses the template silently when no composed body exists', () => {
    const emitted: MetricEntry[] = [];
    const resolved = resolveOutboundSendBody(
      { body: 'Template.', composedBody: null, composition: null, messageKind: 'safety' },
      { emit: (entry) => emitted.push(entry) },
    );
    expect(resolved).toEqual({ body: 'Template.', usedComposedBody: false });
    expect(emitted).toHaveLength(0);
  });

  it.each(['safety', 'fallback', 'check_in', 'reminder'])(
    'NEVER transmits composed text on a %s row, even when the hash verifies',
    (messageKind) => {
      expect(COMPOSABLE_MESSAGE_KINDS.has(messageKind)).toBe(false);
      const emitted: MetricEntry[] = [];
      const resolved = resolveOutboundSendBody(
        { body: 'Template.', composedBody: sms, composition: provenance, messageKind },
        { emit: (entry) => emitted.push(entry), validate: () => true },
      );
      expect(resolved).toEqual({ body: 'Template.', usedComposedBody: false });
      expect(emitted[0]?.metric).toBe('composed_body_on_never_composed_kind');
    },
  );

  it('applies an integration validator on top of the integrity check', () => {
    const emitted: MetricEntry[] = [];
    const resolved = resolveOutboundSendBody(
      {
        body: 'Template.',
        composedBody: sms,
        composition: provenance,
        messageKind: 'acknowledgement',
      },
      { emit: (entry) => emitted.push(entry), validate: () => false },
    );
    expect(resolved).toEqual({ body: 'Template.', usedComposedBody: false });
    expect(emitted[0]?.metric).toBe('composed_body_send_check_failed');
  });
});

describe('validateStoredCompositionRecord — the send-time validator re-run', () => {
  const storedComposition = {
    composedBodySha256: sha256(DRAFT_SMS),
    intent: DRAFT_INTENT,
    dayContext: DRAFT_DAY_CONTEXT,
  };

  it('re-validates an intact composed body against its stored context', () => {
    expect(validateStoredCompositionRecord(DRAFT_SMS, storedComposition)).toBe(true);
  });

  it('fails CLOSED when the stored context is missing or malformed', () => {
    expect(validateStoredCompositionRecord(DRAFT_SMS, { composedBodySha256: 'x' })).toBe(false);
    expect(validateStoredCompositionRecord(DRAFT_SMS, null)).toBe(false);
    expect(validateStoredCompositionRecord(DRAFT_SMS, {})).toBe(false);
  });

  it('rejects a rewritten body that violates the validator set even with a fresh hash', () => {
    // An attacker who rewrites composed_body AND recomputes the co-located hash still loses:
    // the validator classes re-run on the stored context.
    expect(
      validateStoredCompositionRecord(
        "Don't worry, that's normal - it should pass.",
        storedComposition,
      ),
    ).toBe(false);
    expect(validateStoredCompositionRecord('Take your medication now.', storedComposition)).toBe(
      false,
    );
  });
});

describe('isComposerEnabled — fail-safe kill switch parsing', () => {
  function pool(disabled = false) {
    return {
      query: vi.fn(async () => ({ rows: [{ disabled }] })),
    } as unknown as Parameters<typeof isComposerEnabled>[0];
  }

  it.each(['true', 'TRUE', '1', 'yes', 'on', 'weird-typo'])(
    'disables composing for ANY set value that is not an explicit enable spelling: %s',
    async (value) => {
      process.env[COMPOSER_DISABLE_ENV] = value;
      try {
        await expect(isComposerEnabled(pool())).resolves.toEqual({
          enabled: false,
          reason: 'env_disabled',
        });
      } finally {
        delete process.env[COMPOSER_DISABLE_ENV];
      }
    },
  );

  it.each(['', 'false', '0', 'no', 'off'])(
    'stays enabled for the explicit enable spelling: %s',
    async (value) => {
      process.env[COMPOSER_DISABLE_ENV] = value;
      try {
        await expect(isComposerEnabled(pool())).resolves.toEqual({ enabled: true, reason: null });
      } finally {
        delete process.env[COMPOSER_DISABLE_ENV];
      }
    },
  );
});

describe('composeAndCheckpointPreparedReply — timeout-then-template orchestration', () => {
  const prepared = fakePrepared();

  it('does nothing until the Lane B composer is wired', async () => {
    const persistence = fakePersistence();
    await composeAndCheckpointPreparedReply(persistence, undefined, composeTarget, prepared);
    expect(persistence.isEnabled).not.toHaveBeenCalled();
    expect(persistence.checkpoint).not.toHaveBeenCalled();
    expect(persistence.recordOutcome).not.toHaveBeenCalled();
  });

  it('ships templates with a metric line when the composer is auto-disabled', async () => {
    const emitted: MetricEntry[] = [];
    const persistence = fakePersistence({
      isEnabled: vi.fn(async () => ({ enabled: false as const, reason: 'auto_disabled' as const })),
    });
    const composer = composerReturning({ kind: 'composed', draft: validDraft('never used') });
    await composeAndCheckpointPreparedReply(persistence, composer, composeTarget, prepared, {
      emit: (entry) => emitted.push(entry),
    });
    expect(composer.compose).not.toHaveBeenCalled();
    expect(persistence.checkpoint).not.toHaveBeenCalled();
    expect(emitted).toEqual([
      { metric: 'composer_disabled_template_shipped', reason: 'auto_disabled' },
    ]);
  });

  it('checkpoints a composed reply with the integrity hash, the stored validation context, and a full audit', async () => {
    const persistence = fakePersistence();
    const composer = composerReturning({ kind: 'composed', draft: validDraft() });
    await composeAndCheckpointPreparedReply(persistence, composer, composeTarget, prepared);
    expect(persistence.checkpoint).toHaveBeenCalledExactlyOnceWith({
      outboundMessageId: OUTBOUND_ID,
      patientId: PATIENT_ID,
      agentTurnId: AGENT_TURN_ID,
      composedBody: DRAFT_SMS,
      composition: {
        modelId: COMPOSER_DEFAULT_MODEL_ID,
        intent: DRAFT_INTENT,
        dayContext: DRAFT_DAY_CONTEXT,
        inputHash: DRAFT_INPUT_HASH,
        attempts: DRAFT_ATTEMPTS,
        composedBodySha256: sha256(DRAFT_SMS),
      },
    });
    expect(persistence.recordOutcome).toHaveBeenCalledExactlyOnceWith({
      ...AUDIT_TARGET,
      fallbackReason: null,
      inputHash: DRAFT_INPUT_HASH,
      intent: DRAFT_INTENT,
      attempts: DRAFT_ATTEMPTS,
      sms: DRAFT_SMS,
    });
  });

  it('re-runs the validator at the checkpoint and NEVER trusts the seam claim of validity', async () => {
    const persistence = fakePersistence();
    const composer = composerReturning({
      kind: 'composed',
      draft: validDraft("Don't worry, that's normal - it should pass."),
    });
    await composeAndCheckpointPreparedReply(persistence, composer, composeTarget, prepared);
    expect(persistence.checkpoint).not.toHaveBeenCalled();
    expect(persistence.recordOutcome).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ fallbackReason: 'reassurance_phrase' }),
    );
  });

  it('falls back to the template on a composer timeout with a durable audit record', async () => {
    const persistence = fakePersistence();
    const composer = { compose: vi.fn(() => new Promise<ComposeSeamOutcome>(() => undefined)) };
    await composeAndCheckpointPreparedReply(persistence, composer, composeTarget, prepared, {
      timeoutMs: 5,
    });
    expect(persistence.checkpoint).not.toHaveBeenCalled();
    expect(persistence.recordOutcome).toHaveBeenCalledExactlyOnceWith({
      ...AUDIT_TARGET,
      fallbackReason: 'timeout',
      inputHash: null,
      intent: null,
      attempts: [],
      sms: null,
    });
  });

  it('falls back on a composer error and on a seam-reported fallback, keeping the attempt trail', async () => {
    const failing = fakePersistence();
    await composeAndCheckpointPreparedReply(
      failing,
      {
        compose: vi.fn(async () => {
          throw new Error('provider exploded');
        }),
      },
      composeTarget,
      prepared,
    );
    expect(failing.recordOutcome).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ fallbackReason: 'composer_error' }),
    );

    const rejectedAttempts = [
      {
        rawOutput: '{"sms": "fabricated"}',
        verdict: { ok: false as const, reason: 'ungrounded_entity' as const },
      },
    ];
    const seamFallback = fakePersistence();
    await composeAndCheckpointPreparedReply(
      seamFallback,
      composerReturning({
        kind: 'fallback',
        reason: 'entity_grounding',
        inputHash: DRAFT_INPUT_HASH,
        attempts: rejectedAttempts,
      }),
      composeTarget,
      prepared,
    );
    expect(seamFallback.recordOutcome).toHaveBeenCalledExactlyOnceWith({
      ...AUDIT_TARGET,
      fallbackReason: 'entity_grounding',
      inputHash: DRAFT_INPUT_HASH,
      intent: null,
      attempts: rejectedAttempts,
      sms: null,
    });
  });

  it('sanitizes an unsafe seam fallback reason so metric lines stay identifier-free', async () => {
    const persistence = fakePersistence();
    await composeAndCheckpointPreparedReply(
      persistence,
      composerReturning({
        kind: 'fallback',
        reason: `patient ${PATIENT_ID} said no`,
        inputHash: null,
        attempts: [],
      }),
      composeTarget,
      prepared,
    );
    expect(persistence.recordOutcome).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ fallbackReason: 'invalid_reason' }),
    );
  });

  it('rejects an over-ceiling or untrimmed composed draft with a measured fallback, never truncating', async () => {
    const persistence = fakePersistence();
    await composeAndCheckpointPreparedReply(
      persistence,
      composerReturning({
        kind: 'composed',
        draft: validDraft('x'.repeat(COMPOSED_SMS_MAX_CODE_POINTS + 1)),
      }),
      composeTarget,
      prepared,
    );
    expect(persistence.checkpoint).not.toHaveBeenCalled();
    expect(persistence.recordOutcome).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ fallbackReason: 'length_exceeded' }),
    );

    const untrimmed = fakePersistence();
    await composeAndCheckpointPreparedReply(
      untrimmed,
      composerReturning({ kind: 'composed', draft: validDraft(' padded ') }),
      composeTarget,
      prepared,
    );
    expect(untrimmed.checkpoint).not.toHaveBeenCalled();
    expect(untrimmed.recordOutcome).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ fallbackReason: 'invalid_output' }),
    );
  });

  it('falls back to the template when the checkpoint THROWS, instead of crashing the committed turn', async () => {
    const emitted: MetricEntry[] = [];
    const persistence = fakePersistence({
      checkpoint: vi.fn(async () => {
        throw new Error('composition_size_ceiling');
      }),
    });
    await composeAndCheckpointPreparedReply(
      persistence,
      composerReturning({ kind: 'composed', draft: validDraft() }),
      composeTarget,
      prepared,
      { emit: (entry) => emitted.push(entry) },
    );
    expect(emitted).toEqual([{ metric: 'composer_checkpoint_failed' }]);
    expect(persistence.recordOutcome).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ fallbackReason: 'checkpoint_error' }),
    );
  });

  it('emits a skip metric AND records a non-success outcome when the one-shot checkpoint reports a conflict', async () => {
    const emitted: MetricEntry[] = [];
    const persistence = fakePersistence({ checkpoint: vi.fn(async () => false) });
    await composeAndCheckpointPreparedReply(
      persistence,
      composerReturning({ kind: 'composed', draft: validDraft() }),
      composeTarget,
      prepared,
      { emit: (entry) => emitted.push(entry) },
    );
    expect(emitted).toEqual([{ metric: 'composer_checkpoint_skipped' }]);
    // Metric honesty: a lost checkpoint race must NOT count as a compose success in the
    // pre-registered >30% abort window — patients who never received composed text must show
    // up as a fallback sample, not a success sample.
    expect(persistence.recordOutcome).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ fallbackReason: 'checkpoint_conflict' }),
    );
  });
});

describe('composerIntentFromPrepared — deterministic intent assembly ("code fetches, AI writes")', () => {
  const MEDICATION_NAMES = [['Metformin'], ['Lisinopril']];

  it('maps a plain routine acknowledgement to an acknowledgement intent with aliased medications', () => {
    const intent = composerIntentFromPrepared(
      fakePrepared({ acknowledgementId: 'acknowledgement-recorded' }),
      MEDICATION_NAMES,
    );
    expect(intent).toEqual({
      kind: 'acknowledgement',
      requiredTokens: [],
      allowedTerms: [],
      medications: [
        { alias: 'med_1', displayName: 'Metformin' },
        { alias: 'med_2', displayName: 'Lisinopril' },
      ],
      // Live-fault fix (2026-08-17): fakePrepared() commits no commands by default, so the
      // record-truthfulness fact fires — the composer must never sound like it recorded
      // something when nothing was committed this turn.
      patientFacts: ['nothing new was recorded this turn'],
    });
  });

  it('gives every one of a medication OWN names the same alias, so none crosses un-aliased', () => {
    const intent = composerIntentFromPrepared(fakePrepared(), [
      ['acetaminophen', 'Tylenol'],
      ['Lisinopril'],
    ]);
    expect(intent?.medications).toEqual([
      { alias: 'med_1', displayName: 'acetaminophen' },
      { alias: 'med_2', displayName: 'Lisinopril' },
      { alias: 'med_1', displayName: 'Tylenol' },
    ]);
  });

  it('carries the recorded dose outcome as a patient fact — and nothing when the turn recorded none', () => {
    const taken = composerIntentFromPrepared(
      fakePrepared({
        commands: [{ kind: 'CreateReport', eventKind: 'administration', adherence: 'taken' }],
      }),
      [],
    );
    expect(taken?.patientFacts).toEqual(['the dose is recorded as taken']);

    const missed = composerIntentFromPrepared(
      fakePrepared({
        commands: [{ kind: 'CreateReport', eventKind: 'administration', adherence: 'missed' }],
      }),
      [],
    );
    expect(missed?.patientFacts).toEqual(['the dose is recorded as skipped or missed']);

    // Live-fault fix (2026-08-17): a turn that recorded nothing gets an explicit fact saying
    // so, so the composer can never claim otherwise.
    expect(composerIntentFromPrepared(fakePrepared(), [])?.patientFacts).toEqual([
      'nothing new was recorded this turn',
    ]);
  });

  // A re-ask is a `question` plan with no review reasons, so it IS composed — and the composed
  // body replaced the template that carried the explainer. The patient who was confused enough
  // to need a re-ask received the rephrased question with none of the plain-language help.
  it('carries the re-ask explainer into the intent so a successful compose cannot drop it', () => {
    const intent = composerIntentFromPrepared(
      fakePrepared({
        responsePlanKind: 'question',
        question: {
          field: 'severity',
          targetLabel: 'nausea',
          questionId: 'question-severity-1',
          needId: 'need-severity-1',
          reask: true,
        },
      }),
      [],
    );
    expect(intent?.requiredTokens).toContain(EXPLAINERS.severity);
  });

  it('adds no explainer on a first ask', () => {
    const intent = composerIntentFromPrepared(
      fakePrepared({
        responsePlanKind: 'question',
        question: {
          field: 'severity',
          targetLabel: 'nausea',
          questionId: 'question-severity-1',
          needId: 'need-severity-1',
        },
      }),
      [],
    );
    expect(intent?.requiredTokens).not.toContain(EXPLAINERS.severity);
  });

  it('names a recorded symptom/observation, and stays silent about it when only an information need was managed', () => {
    const symptomRecorded = composerIntentFromPrepared(
      fakePrepared({
        commands: [{ kind: 'CreateReport', eventKind: 'symptom', rawSymptom: 'headache' }],
      }),
      [],
    );
    expect(symptomRecorded?.patientFacts).toEqual([
      'a symptom or observation was recorded this turn',
    ]);

    const symptomRefined = composerIntentFromPrepared(
      fakePrepared({
        commands: [{ kind: 'RefineReport', targetKind: 'symptom', severity: 6 }],
      }),
      [],
    );
    expect(symptomRefined?.patientFacts).toEqual([
      'a symptom or observation was recorded this turn',
    ]);

    const recurrence = composerIntentFromPrepared(
      fakePrepared({ commands: [{ kind: 'RecordRecurrence', rawSymptom: 'headache' }] }),
      [],
    );
    expect(recurrence?.patientFacts).toEqual(['a symptom or observation was recorded this turn']);

    // A need-management-only turn (nothing clinical actually committed) still says so.
    const needOnly = composerIntentFromPrepared(
      fakePrepared({ commands: [{ kind: 'AskInformationNeed' }] }),
      [],
    );
    expect(needOnly?.patientFacts).toEqual(['nothing new was recorded this turn']);
  });

  it('maps the orientation acknowledgement to a greeting intent', () => {
    const intent = composerIntentFromPrepared(
      fakePrepared({ acknowledgementId: 'acknowledgement-orientation' }),
      [],
    );
    expect(intent?.kind).toBe('greeting');
    expect(intent?.question).toBeUndefined();
  });

  it('maps a question plan to a question intent with the single-source key vocabulary', () => {
    const intent = composerIntentFromPrepared(
      fakePrepared({
        responsePlanKind: 'question',
        question: {
          needId: 'need-1',
          field: 'severity',
          questionId: 'question-1',
          targetLabel: 'Metformin morning dose',
        },
      }),
      MEDICATION_NAMES,
    );
    expect(intent).toMatchObject({
      kind: 'question',
      question: { field: 'severity', keyVocabulary: ['1 to 10', 'scale', 'number'] },
    });
  });

  it('binds a question to its target: the medication alias is a coverage token, the label a fact', () => {
    const intent = composerIntentFromPrepared(
      fakePrepared({
        responsePlanKind: 'question',
        question: {
          needId: 'need-1',
          field: 'actual_time',
          questionId: 'question-1',
          targetLabel: 'Metformin morning dose',
        },
      }),
      MEDICATION_NAMES,
    );
    // Coverage (validator 3) is no longer inert: the reply must name the medication asked about.
    expect(intent?.requiredTokens).toEqual(['med_1']);
    expect(intent?.allowedTerms).toEqual(['med_1 morning dose']);
    expect(intent?.patientFacts).toContain('this question is about med_1 morning dose');
  });

  it('carries a free-text symptom target as vocabulary only — never as a verbatim coverage token', () => {
    const intent = composerIntentFromPrepared(
      fakePrepared({
        responsePlanKind: 'question',
        question: {
          needId: 'need-1',
          field: 'duration',
          questionId: 'question-1',
          targetLabel: 'the headache you mentioned',
        },
      }),
      MEDICATION_NAMES,
    );
    expect(intent?.requiredTokens).toEqual([]);
    expect(intent?.allowedTerms).toEqual(['the headache you mentioned']);
  });

  it('falls to the template rather than throwing inside the seam on a medication past the wire caps', () => {
    expect(composerIntentFromPrepared(fakePrepared(), [['x'.repeat(201)]])).toBeUndefined();
    expect(
      composerIntentFromPrepared(
        fakePrepared(),
        Array.from({ length: 21 }, (_, index) => [`Med ${index}`]),
      ),
    ).toBeUndefined();
  });

  it('returns undefined for a never-composed plan kind (defensive — the caller already gates this)', () => {
    expect(
      composerIntentFromPrepared(fakePrepared({ responsePlanKind: 'emergency' }), []),
    ).toBeUndefined();
    expect(
      composerIntentFromPrepared(fakePrepared({ responsePlanKind: 'stop' }), []),
    ).toBeUndefined();
  });
});
