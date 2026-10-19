import { describe, expect, it } from 'vitest';
import {
  applyPreparedClinicalTurn,
  prepareClinicalTurn,
  reducePatientClinicalMemory,
  type ClinicalIntentCommand,
  type ExtractedClaim,
  type PatientClinicalMemory,
  type PatientClinicalSnapshot,
} from './index.js';

const HASH = '0'.repeat(64);
const pipelineVersions = {
  extractor: 'extractor-v1',
  resolver: 'resolver-v1',
  reducer: 'reducer-v1',
  renderer: 'renderer-v1',
} as const;
const eligible = {
  polarity: 'positive',
  experiencer: 'patient',
  status: 'current',
  certainty: 'certain',
} as const;

const medications: PatientClinicalSnapshot['medications'] = [
  { id: 'med-alpha', version: 1, names: ['alpha'], aliases: ['morning pill'], active: true },
  { id: 'med-beta', version: 1, names: ['beta'], aliases: ['morning pill'], active: true },
  { id: 'med-gamma', version: 1, names: ['gamma'], aliases: [], active: true },
];
const doses: PatientClinicalSnapshot['doses'] = [
  {
    id: 'dose-alpha',
    version: 1,
    medicationId: 'med-alpha',
    label: 'alpha dose',
    localDate: '2026-08-13',
    localTime: '08:00',
  },
  {
    id: 'dose-beta',
    version: 1,
    medicationId: 'med-beta',
    label: 'beta dose',
    localDate: '2026-08-13',
    localTime: '09:00',
  },
  {
    id: 'dose-gamma',
    version: 1,
    medicationId: 'med-gamma',
    label: 'gamma dose',
    localDate: '2026-08-13',
    localTime: '10:00',
  },
];

function emptyMemory(): PatientClinicalMemory {
  return {
    patientId: 'patient-sequence',
    version: 0,
    events: [],
    needs: [],
    unresolvedReports: [],
    reviewItems: [],
    routineClarificationsPaused: false,
    processedBatches: [],
  };
}

function snapshot(
  memory: PatientClinicalMemory,
  id: string,
  sequence: number,
  body: string,
  overrides: Partial<PatientClinicalSnapshot> = {},
): PatientClinicalSnapshot {
  return {
    memory,
    inboundMessage: { id, sequence, body },
    consentEpoch: 1,
    expectedConsentEpoch: 1,
    medications,
    doses,
    symptomConcepts: ['nausea', 'tingling'],
    languageDisposition: 'english',
    emergencyPrefilter: false,
    contextHash: HASH,
    pipelineVersions,
    ...overrides,
  };
}

function administration(
  slot: string,
  quote: string,
  medicationText: string,
  actionText: 'took' | 'missed',
  extra: Partial<Extract<ExtractedClaim, { kind: 'administration' }>> = {},
): Extract<ExtractedClaim, { kind: 'administration' }> {
  return {
    slot,
    kind: 'administration',
    quote,
    ...eligible,
    medicationText,
    actionText,
    ...extra,
  };
}

function social(slot: string, quote: string): Extract<ExtractedClaim, { kind: 'social' }> {
  return { slot, kind: 'social', quote, ...eligible };
}

function commit(
  memory: PatientClinicalMemory,
  id: string,
  sequence: number,
  body: string,
  claims: readonly ExtractedClaim[],
  overrides: Partial<PatientClinicalSnapshot> = {},
): PatientClinicalMemory {
  const prepared = prepareClinicalTurn(snapshot(memory, id, sequence, body, overrides), claims);
  return applyPreparedClinicalTurn(memory, prepared).memory;
}

function currentClinicalState(memory: PatientClinicalMemory): string {
  return JSON.stringify({
    events: memory.events.filter(({ current }) => current),
    needs: memory.needs,
    unresolvedReports: memory.unresolvedReports,
    reviewItems: memory.reviewItems,
    routineClarificationsPaused: memory.routineClarificationsPaused,
  });
}

describe('frozen sequence invariants', () => {
  it('clarification answers do not create duplicate administrations or symptom occurrences', () => {
    const first = commit(emptyMemory(), 'message-late', 1, 'I took alpha late.', [
      administration('late-administration', 'took alpha late', 'alpha', 'took', {
        timeText: 'late',
      }),
    ]);
    const administrationId = first.events.find(({ kind }) => kind === 'administration')?.id;
    expect(first.needs.find(({ field }) => field === 'actual_time')?.state).toBe('asked');

    const second = commit(first, 'message-symptom', 2, 'I feel nausea.', [
      {
        slot: 'nausea',
        kind: 'symptom',
        quote: 'feel nausea',
        ...eligible,
        symptomText: 'nausea',
      },
    ]);
    const third = commit(second, 'message-time-answer', 3, 'It was 9:15.', [
      {
        slot: 'actual-time',
        kind: 'need_answer',
        quote: '9:15',
        ...eligible,
        answerField: 'actual_time',
        answerText: '9:15',
      },
    ]);

    const currentAdministrations = third.events.filter(
      ({ current, kind }) => current && kind === 'administration',
    );
    expect(currentAdministrations).toHaveLength(1);
    expect(currentAdministrations[0]).toMatchObject({
      operation: 'refine',
      supersedesEventId: administrationId,
      exactTime: '9:15',
    });
    expect(third.events.filter(({ current, kind }) => current && kind === 'symptom')).toHaveLength(
      1,
    );
    expect(third.events.filter(({ operation }) => operation === 'create')).toHaveLength(2);
  });

  it('candidate sets never widen without explicit patient support', () => {
    const ambiguous = commit(emptyMemory(), 'message-ambiguous', 1, 'I took my morning pill.', [
      administration('ambiguous-administration', 'took my morning pill', 'morning pill', 'took'),
    ]);
    const need = ambiguous.needs.find(({ field }) => field === 'medication_identity');
    expect(need?.candidateMedicationIds).toEqual(['med-alpha', 'med-beta']);

    const answered = commit(ambiguous, 'message-outside-candidates', 2, 'It was gamma.', [
      {
        slot: 'medication-answer',
        kind: 'need_answer',
        quote: 'gamma',
        ...eligible,
        answerField: 'medication_identity',
        answerText: 'gamma',
      },
    ]);

    expect(answered.needs.find(({ id }) => id === need?.id)?.candidateMedicationIds).toEqual([
      'med-alpha',
      'med-beta',
    ]);
    expect(answered.events.filter(({ current }) => current)).toEqual(
      ambiguous.events.filter(({ current }) => current),
    );
    expect(answered.unresolvedReports.at(-1)).toMatchObject({
      reason: 'candidate_widening_forbidden',
      candidateMedicationIds: ['med-alpha', 'med-beta'],
    });
  });

  it('input claim order does not change commands or current state', () => {
    const turnSnapshot = snapshot(
      emptyMemory(),
      'message-claim-order',
      1,
      'I took alpha. I missed beta.',
    );
    const alpha = administration('alpha-administration', 'took alpha', 'alpha', 'took');
    const beta = administration('beta-administration', 'missed beta', 'beta', 'missed');
    const forward = prepareClinicalTurn(turnSnapshot, [alpha, beta]);
    const reversed = prepareClinicalTurn(turnSnapshot, [beta, alpha]);

    expect(reversed.commands).toEqual(forward.commands);
    expect(
      currentClinicalState(reducePatientClinicalMemory(emptyMemory(), reversed.commands).memory),
    ).toBe(
      currentClinicalState(reducePatientClinicalMemory(emptyMemory(), forward.commands).memory),
    );
  });

  it('request-local claim-slot renaming does not change commands or current state', () => {
    const turnSnapshot = snapshot(
      emptyMemory(),
      'message-slot-aliases',
      1,
      'I took alpha. Correction: I took beta.',
    );
    const claims = (primarySlot: string, correctionSlot: string): ExtractedClaim[] => [
      administration(primarySlot, 'took alpha', 'alpha', 'took'),
      {
        slot: correctionSlot,
        kind: 'correction',
        quote: 'Correction: I took beta',
        ...eligible,
        medicationText: 'beta',
        actionText: 'took',
        targetClaimSlot: primarySlot,
      },
    ];
    const original = prepareClinicalTurn(turnSnapshot, claims('primary', 'correction'));
    const renamed = prepareClinicalTurn(turnSnapshot, claims('local-a', 'local-b'));
    const originalState = reducePatientClinicalMemory(emptyMemory(), original.commands).memory;
    const renamedState = reducePatientClinicalMemory(emptyMemory(), renamed.commands).memory;

    expect(renamed.commands).toEqual(original.commands);
    expect(original.commands.filter(({ kind }) => kind === 'CorrectReport')).toHaveLength(1);
    expect(originalState.events.find(({ current }) => current)).toMatchObject({
      medicationId: 'med-beta',
      operation: 'correct',
    });
    expect(currentClinicalState(renamedState)).toBe(currentClinicalState(originalState));
  });

  it('replaying an already applied command set does not append duplicate events', () => {
    const initial = emptyMemory();
    const turnSnapshot = snapshot(initial, 'message-command-replay', 1, 'I took alpha.');
    const claims = [administration('administration', 'took alpha', 'alpha', 'took')];
    const firstPrepared = prepareClinicalTurn(turnSnapshot, claims);
    const sameCommandsPreparedAgain = prepareClinicalTurn(turnSnapshot, claims);
    const first = applyPreparedClinicalTurn(initial, firstPrepared);
    const replay = applyPreparedClinicalTurn(first.memory, sameCommandsPreparedAgain);

    expect(sameCommandsPreparedAgain.commands).toEqual(firstPrepared.commands);
    expect(replay.memory).toEqual(first.memory);
    expect(replay.createdEventIds).toEqual(first.createdEventIds);
    expect(replay.memory.events).toHaveLength(1);
  });

  it('full replay and incremental application produce byte-equivalent current state', () => {
    const initial = emptyMemory();
    const prepared = prepareClinicalTurn(
      snapshot(initial, 'message-full-incremental', 1, 'I took alpha late.'),
      [
        administration('late-administration', 'took alpha late', 'alpha', 'took', {
          timeText: 'late',
        }),
      ],
    );
    const full = reducePatientClinicalMemory(initial, prepared.commands).memory;
    const incremental = prepared.commands.reduce(
      (memory, command) => reducePatientClinicalMemory(memory, [command]).memory,
      initial,
    );

    expect(currentClinicalState(incremental)).toBe(currentClinicalState(full));
  });

  it('current correction leaves are single and lineage is acyclic', () => {
    const created = commit(emptyMemory(), 'message-original', 1, 'I took alpha.', [
      administration('original', 'took alpha', 'alpha', 'took'),
    ]);
    const corrected = commit(
      created,
      'message-first-correction',
      2,
      'Correction: alpha was wrong; I took beta.',
      [
        {
          slot: 'first-correction',
          kind: 'correction',
          quote: 'Correction: alpha was wrong; I took beta',
          ...eligible,
          targetText: 'alpha',
          medicationText: 'beta',
          actionText: 'took',
        },
      ],
    );
    const twiceCorrected = commit(
      corrected,
      'message-second-correction',
      3,
      'Correction: beta was wrong; I took gamma.',
      [
        {
          slot: 'second-correction',
          kind: 'correction',
          quote: 'Correction: beta was wrong; I took gamma',
          ...eligible,
          targetText: 'beta',
          medicationText: 'gamma',
          actionText: 'took',
        },
      ],
    );

    const current = twiceCorrected.events.filter(
      ({ current: isCurrent, kind }) => isCurrent && kind === 'administration',
    );
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      medicationId: 'med-gamma',
      operation: 'correct',
      version: 3,
    });

    const byId = new Map(twiceCorrected.events.map((event) => [event.id, event]));
    const visited = new Set<string>();
    let cursor = current[0];
    while (cursor !== undefined) {
      expect(visited.has(cursor.id)).toBe(false);
      visited.add(cursor.id);
      cursor =
        cursor.supersedesEventId === undefined ? undefined : byId.get(cursor.supersedesEventId);
    }
    expect(visited.size).toBe(3);
    expect(twiceCorrected.events.filter(({ current: isCurrent }) => isCurrent)).toHaveLength(1);
  });

  it('routine information needs remain paused until clinician-owned emergency closure', () => {
    const withNeed = commit(emptyMemory(), 'message-needs-severity', 1, 'I feel nausea.', [
      {
        slot: 'nausea',
        kind: 'symptom',
        quote: 'feel nausea',
        ...eligible,
        symptomText: 'nausea',
      },
    ]);
    const emergency = commit(
      withNeed,
      'message-emergency',
      2,
      'I cannot breathe.',
      [social('emergency-text', 'I cannot breathe')],
      { emergencyPrefilter: true },
    );
    const safetyReview = emergency.reviewItems.find(({ kind }) => kind === 'safety');
    expect(emergency.routineClarificationsPaused).toBe(true);
    expect(safetyReview?.status).toBe('open');

    const stillPausedPrepared = prepareClinicalTurn(
      snapshot(emergency, 'message-while-paused', 3, 'Thanks.'),
      [social('thanks', 'Thanks')],
    );
    expect(stillPausedPrepared.responsePlan.kind).toBe('emergency');
    expect(stillPausedPrepared.commands.some(({ kind }) => kind === 'AskInformationNeed')).toBe(
      false,
    );

    const closureText = 'Emergency reviewed.';
    const resume: ClinicalIntentCommand = {
      id: 'command-resume-after-clinician-review',
      kind: 'ResumeRoutineClarification',
      sourceMessageId: 'clinician-review-message',
      sourceSpans: [
        {
          messageId: 'clinician-review-message',
          start: 0,
          end: closureText.length,
          quote: closureText,
        },
      ],
      reviewItemId: safetyReview?.id ?? 'missing-safety-review',
    };
    const beforeFailedResume = structuredClone(emergency);
    expect(() => reducePatientClinicalMemory(emergency, [resume])).toThrow(
      'safety_review_not_closed',
    );
    expect(emergency).toEqual(beforeFailedResume);

    const clinicianClosed: PatientClinicalMemory = {
      ...emergency,
      reviewItems: emergency.reviewItems.map((item) =>
        item.id === safetyReview?.id ? { ...item, status: 'confirmed' as const } : item,
      ),
    };
    const resumed = reducePatientClinicalMemory(clinicianClosed, [resume]).memory;
    expect(resumed.routineClarificationsPaused).toBe(false);
  });

  it('failure after extraction and before commit leaves durable clinical state unchanged', () => {
    const initial = emptyMemory();
    const before = structuredClone(initial);
    const prepared = prepareClinicalTurn(
      snapshot(initial, 'message-failed-commit', 1, 'I took alpha.'),
      [administration('administration', 'took alpha', 'alpha', 'took')],
    );
    expect(initial).toEqual(before);

    expect(() =>
      applyPreparedClinicalTurn(initial, { ...prepared, commandHash: 'f'.repeat(64) }),
    ).toThrow('prepared_batch_integrity_error');
    expect(initial).toEqual(before);
  });

  it('crash after commit reuses idempotent commands and does not duplicate events', () => {
    const initial = emptyMemory();
    const prepared = prepareClinicalTurn(
      snapshot(initial, 'message-crash-replay', 1, 'I took alpha.'),
      [administration('administration', 'took alpha', 'alpha', 'took')],
    );
    const committedBeforeCrash = applyPreparedClinicalTurn(initial, prepared);
    const recoveredMemory = JSON.parse(
      JSON.stringify(committedBeforeCrash.memory),
    ) as PatientClinicalMemory;
    const recoveredPrepared = JSON.parse(JSON.stringify(prepared)) as typeof prepared;
    const replayed = applyPreparedClinicalTurn(recoveredMemory, recoveredPrepared);

    expect(replayed).toEqual(committedBeforeCrash);
    expect(replayed.memory.events).toHaveLength(1);
    expect(replayed.memory.processedBatches).toHaveLength(1);
    expect(replayed.prepared.responseText).toBe(replayed.memory.processedBatches[0]?.responseText);
  });
});
