// Wave 1b Lane C — the compose insertion point in processClinicalMemoryJobCore.
// Call-spy contract: compose runs AFTER commitPreparedClinicalTurn and BEFORE
// invokePreparedOutbound, on the FRESH path only, gated by the never-composed set and by the
// pre-compose newest-inbound recency check. The invoke-time newer-inbound backstop is
// unchanged and independent.

import { describe, expect, it, vi } from 'vitest';
import type { ConversationTurnInput } from '@medadhere/shared';
import {
  CURRENT_CLINICAL_PIPELINE_VERSIONS,
  type PatientClinicalSnapshot,
  type PreparedClinicalTurn,
} from './clinical-memory/index.js';
import {
  processClinicalMemoryJobCore,
  type ClinicalMemoryJobDependencies,
} from './turn-processor.js';

const INBOUND_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_ID = '00000000-0000-4000-8000-000000000003';
const AGENT_TURN_ID = '00000000-0000-4000-8000-000000000005';
const TURN_JOB_ID = '00000000-0000-4000-8000-000000000006';

const input: ConversationTurnInput = {
  requestId: '00000000-0000-4000-8000-000000000002',
  patientId: PATIENT_ID,
  inboundMessageId: INBOUND_ID,
  currentMessage: {
    id: INBOUND_ID,
    direction: 'inbound',
    body: 'Took it, thanks.',
    occurredAtUtc: '2026-08-16T13:00:00.000Z',
    language: 'en',
  },
  locale: {
    expectedLanguage: 'en',
    patientTimeZone: 'America/Toronto',
    currentUtc: '2026-08-16T13:01:00.000Z',
    currentLocalDate: '2026-08-16',
  },
  currentDayMessages: [
    {
      id: '00000000-0000-4000-8000-000000000009',
      direction: 'outbound',
      body: 'How are you feeling today?',
      occurredAtUtc: '2026-08-16T12:00:00.000Z',
      language: 'en',
    },
  ],
  pendingClarification: null,
  pendingClarificationTopic: null,
  promptedDoseId: null,
  recentObservations: [],
  activeMedications: [],
  clinicalFacts: [],
  drugInteractions: [],
  temporalCandidates: [],
  evidence: [],
  promptVersion: 'conversation-v45-single-stage',
  schemaVersion: 'conversation-v3',
};

const PREPARED_OUTBOUND = Object.freeze({
  outboundMessageId: '00000000-0000-4000-8000-000000000004',
  patientId: PATIENT_ID,
  agentTurnId: AGENT_TURN_ID,
  status: 'prepared',
  messagingConsentEpoch: 1,
});

function snapshot(
  routineClarificationsPaused = false,
  medications: PatientClinicalSnapshot['medications'] = [],
): PatientClinicalSnapshot {
  return {
    memory: {
      patientId: PATIENT_ID,
      version: 0,
      events: [],
      needs: [],
      unresolvedReports: [],
      reviewItems: [],
      routineClarificationsPaused,
      processedBatches: [],
    },
    inboundMessage: { id: INBOUND_ID, sequence: 1, body: input.currentMessage.body },
    consentEpoch: 1,
    expectedConsentEpoch: 1,
    expectedMemoryVersion: 0,
    medications,
    doses: [],
    symptomConcepts: [],
    languageDisposition: 'english',
    emergencyPrefilter: false,
    contextHash: '0'.repeat(64),
    pipelineVersions: CURRENT_CLINICAL_PIPELINE_VERSIONS,
  };
}

function fakePrepared(
  overrides: Partial<{
    responsePlanKind: PreparedClinicalTurn['responsePlan']['kind'];
    reviewReasons: readonly string[];
    commandKinds: readonly string[];
    runtimeFailure: PreparedClinicalTurn['runtimeFailure'];
  }> = {},
): PreparedClinicalTurn {
  return {
    patientId: PATIENT_ID,
    idempotencyKey: 'idem-1',
    sourceMessageId: INBOUND_ID,
    sourceSequence: 1,
    baseMemoryVersion: 0,
    consentEpoch: 1,
    contextHash: '0'.repeat(64),
    pipelineVersions: CURRENT_CLINICAL_PIPELINE_VERSIONS,
    commands: (overrides.commandKinds ?? []).map((kind) => ({ kind })),
    commandHash: 'a'.repeat(64),
    responsePlan: {
      kind: overrides.responsePlanKind ?? 'routine',
      reviewReasons: overrides.reviewReasons ?? [],
    },
    responseText: 'Thanks, noted.',
    preparedHash: 'b'.repeat(64),
    ...(overrides.runtimeFailure === undefined ? {} : { runtimeFailure: overrides.runtimeFailure }),
  } as unknown as PreparedClinicalTurn;
}

function dependencies(
  prepared: PreparedClinicalTurn,
  overrides: Partial<ClinicalMemoryJobDependencies> = {},
): ClinicalMemoryJobDependencies {
  return {
    findFinalizedOutbound: vi.fn(async () => null),
    loadJob: vi.fn(async () => ({
      kind: 'ready' as const,
      turnJobId: TURN_JOB_ID,
      messagingStateVersion: 1,
      input,
    })),
    loadBoundedClaims: vi.fn(async () => ({ claims: [] })),
    loadClinicalSnapshot: vi.fn(async () => snapshot()),
    prepareClinicalTurn: vi.fn(() => prepared),
    prepareClinicalFailureTurn: vi.fn(() => prepared),
    commitPreparedClinicalTurn: vi.fn(async () => PREPARED_OUTBOUND),
    terminalizePreparedOutbound: vi.fn(async () => undefined),
    invokeOutbound: vi.fn(async () => undefined),
    hasNewerInbound: vi.fn(async () => false),
    composePreparedOutbound: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('processClinicalMemoryJobCore — compose insertion', () => {
  it('composes an eligible routine reply after commit and before the outbound invoke, with the day context + active medications already loaded on the turn', async () => {
    const order: string[] = [];
    const prepared = fakePrepared();
    const deps = dependencies(prepared, {
      loadClinicalSnapshot: vi.fn(async () =>
        snapshot(false, [
          { id: 'med-1', version: 1, names: ['Metformin'], aliases: [], active: true },
          { id: 'med-2', version: 1, names: ['Old Med'], aliases: [], active: false },
        ]),
      ),
      commitPreparedClinicalTurn: vi.fn(async () => {
        order.push('commit');
        return PREPARED_OUTBOUND;
      }),
      hasNewerInbound: vi.fn(async () => {
        order.push('recency');
        return false;
      }),
      composePreparedOutbound: vi.fn(async () => {
        order.push('compose');
      }),
      invokeOutbound: vi.fn(async () => {
        order.push('invoke');
      }),
    });
    await processClinicalMemoryJobCore(INBOUND_ID, deps);
    expect(order).toEqual(['commit', 'recency', 'compose', 'invoke']);
    expect(deps.composePreparedOutbound).toHaveBeenCalledExactlyOnceWith(
      PREPARED_OUTBOUND,
      prepared,
      {
        turnJobId: TURN_JOB_ID,
        // Isolation item 8: reused verbatim from job.input.currentDayMessages, transport-only
        // `language` stripped.
        dayContext: {
          messages: [
            {
              id: '00000000-0000-4000-8000-000000000009',
              direction: 'outbound',
              body: 'How are you feeling today?',
              occurredAtUtc: '2026-08-16T12:00:00.000Z',
            },
          ],
          latestPatientMessage: 'Took it, thanks.',
        },
        // Only the active medication, with ALL of its names so every one is aliased — and
        // never a new query.
        medicationNames: [['Metformin']],
      },
    );
  });

  it('skips the compose call entirely when the pre-compose recency check finds a newer inbound', async () => {
    const deps = dependencies(fakePrepared(), { hasNewerInbound: vi.fn(async () => true) });
    await processClinicalMemoryJobCore(INBOUND_ID, deps);
    expect(deps.composePreparedOutbound).not.toHaveBeenCalled();
    // The outbound row carries no responsePlanKind here, so the invoke backstop fails toward
    // sending — proving the compose gate is independent of the send backstop.
    expect(deps.invokeOutbound).toHaveBeenCalledOnce();
  });

  it.each([
    ['an emergency reply', fakePrepared({ responsePlanKind: 'emergency' })],
    ['a STOP reply', fakePrepared({ responsePlanKind: 'stop' })],
    ['a safety-event turn', fakePrepared({ commandKinds: ['RaiseSafetySignal'] })],
    ['an unresolved-report turn', fakePrepared({ commandKinds: ['PreserveUnresolvedContent'] })],
    ['a review-reasons turn', fakePrepared({ reviewReasons: ['ambiguous'] })],
  ])('never composes %s', async (_label, prepared) => {
    const deps = dependencies(prepared);
    await processClinicalMemoryJobCore(INBOUND_ID, deps);
    expect(deps.composePreparedOutbound).not.toHaveBeenCalled();
    expect(deps.invokeOutbound).toHaveBeenCalledOnce();
  });

  it('never composes a runtime-failure turn', async () => {
    const failurePrepared = fakePrepared({ runtimeFailure: 'provider_error' });
    const deps = dependencies(failurePrepared, {
      prepareClinicalTurn: vi.fn(() => failurePrepared),
    });
    await processClinicalMemoryJobCore(INBOUND_ID, deps);
    expect(deps.composePreparedOutbound).not.toHaveBeenCalled();
    expect(deps.invokeOutbound).toHaveBeenCalledOnce();
  });

  it('never composes while routine clarifications are paused', async () => {
    const deps = dependencies(fakePrepared(), {
      loadClinicalSnapshot: vi.fn(async () => snapshot(true)),
    });
    await processClinicalMemoryJobCore(INBOUND_ID, deps);
    expect(deps.composePreparedOutbound).not.toHaveBeenCalled();
    expect(deps.invokeOutbound).toHaveBeenCalledOnce();
  });

  it('never composes on the replay path — a redrive must not loop through the composer', async () => {
    const replay = { ...PREPARED_OUTBOUND, responsePlanKind: 'routine' };
    const deps = dependencies(fakePrepared(), {
      findFinalizedOutbound: vi.fn(async () => replay),
    });
    await processClinicalMemoryJobCore(INBOUND_ID, deps);
    expect(deps.composePreparedOutbound).not.toHaveBeenCalled();
    expect(deps.commitPreparedClinicalTurn).not.toHaveBeenCalled();
    expect(deps.invokeOutbound).toHaveBeenCalledExactlyOnceWith(replay, 1);
  });

  it('runs unchanged when no composer is wired', async () => {
    const deps = dependencies(fakePrepared(), { composePreparedOutbound: undefined });
    await processClinicalMemoryJobCore(INBOUND_ID, deps);
    expect(deps.invokeOutbound).toHaveBeenCalledOnce();
  });
});
