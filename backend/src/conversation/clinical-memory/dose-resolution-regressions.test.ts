import { describe, expect, it } from 'vitest';
import {
  applyPreparedClinicalTurn,
  prepareClinicalTurn,
  reducePatientClinicalMemory,
  type ExtractedClaim,
  type PatientClinicalMemory,
  type PatientClinicalSnapshot,
} from './index.js';

const ZERO_HASH = '0'.repeat(64);
const eligible = {
  polarity: 'positive',
  experiencer: 'patient',
  status: 'current',
  certainty: 'certain',
} as const;

function sourceSpan(messageId: string, quote: string) {
  return { messageId, start: 0, end: quote.length, quote };
}

function emptyMemory(): PatientClinicalMemory {
  return {
    patientId: 'patient-1',
    version: 0,
    events: [],
    needs: [],
    unresolvedReports: [],
    reviewItems: [],
    routineClarificationsPaused: false,
    processedBatches: [],
  };
}

function snapshot(overrides: Partial<PatientClinicalSnapshot> = {}): PatientClinicalSnapshot {
  return {
    memory: emptyMemory(),
    inboundMessage: { id: 'message-1', sequence: 1, body: 'Thanks.' },
    consentEpoch: 1,
    expectedConsentEpoch: 1,
    medications: [
      { id: 'med-alpha', version: 1, names: ['alpha'], aliases: [], active: true },
      { id: 'med-beta', version: 1, names: ['beta'], aliases: [], active: true },
    ],
    doses: [
      {
        id: 'dose-alpha',
        version: 1,
        medicationId: 'med-alpha',
        label: 'alpha morning',
        localDate: '2026-08-13',
        localTime: '08:00',
      },
      {
        id: 'dose-beta-morning',
        version: 1,
        medicationId: 'med-beta',
        label: 'beta morning',
        localDate: '2026-08-13',
        localTime: '09:00',
      },
    ],
    symptomConcepts: [],
    languageDisposition: 'english',
    emergencyPrefilter: false,
    contextHash: ZERO_HASH,
    pipelineVersions: {
      extractor: 'extractor-v1',
      resolver: 'resolver-v1',
      reducer: 'reducer-v1',
      renderer: 'renderer-v1',
    },
    ...overrides,
  };
}

function reportedAdministration(): PatientClinicalMemory['events'][number] {
  return {
    id: 'event-alpha',
    version: 1,
    kind: 'administration',
    operation: 'create',
    authoredBy: 'patient',
    reviewState: 'unreviewed',
    current: true,
    canonical: true,
    sourceMessageIds: ['message-prior'],
    sourceSpans: [sourceSpan('message-prior', 'I took alpha.')],
    medicationId: 'med-alpha',
    medicationVersion: 1,
    doseId: 'dose-alpha',
    doseVersion: 1,
    adherence: 'taken',
    localDate: '2026-08-13',
    localTime: '08:00',
  };
}

function pendingMedicationMemory(
  candidateDoseIds: readonly string[] = ['dose-alpha', 'dose-beta-morning'],
): PatientClinicalMemory {
  return {
    ...emptyMemory(),
    version: 1,
    events: [
      {
        id: 'event-pending',
        version: 1,
        kind: 'administration',
        operation: 'create',
        authoredBy: 'patient',
        reviewState: 'unreviewed',
        current: true,
        canonical: false,
        sourceMessageIds: ['message-prior'],
        sourceSpans: [sourceSpan('message-prior', 'I took it.')],
        adherence: 'taken',
      },
    ],
    needs: [
      {
        id: 'need-medication',
        version: 1,
        originInboundMessageId: 'message-prior',
        originInboundSequence: 1,
        targetEventId: 'event-pending',
        targetEventVersion: 1,
        field: 'medication_identity',
        candidateMedicationIds: ['med-alpha', 'med-beta'],
        candidateDoseIds: [...candidateDoseIds],
        candidateSymptomEventIds: [],
        candidateHistoricalEventIds: [],
        questionId: 'question-medication',
        clarificationAttemptUsed: true,
        state: 'asked',
        priority: 100,
      },
    ],
  };
}

function medicationAnswer(): ExtractedClaim {
  return {
    slot: 'answer',
    kind: 'need_answer',
    quote: 'beta',
    ...eligible,
    answerField: 'medication_identity',
    answerText: 'beta',
  };
}

describe('medication and dose compatibility regressions', () => {
  it('preserves a medication-changing correction when no unique compatible dose exists', () => {
    const accepted = reportedAdministration();
    const memory: PatientClinicalMemory = { ...emptyMemory(), version: 1, events: [accepted] };
    const state = snapshot({
      memory,
      inboundMessage: {
        id: 'message-correction',
        sequence: 2,
        body: 'Correction: it was beta, not alpha.',
      },
      doses: [
        ...snapshot().doses,
        {
          id: 'dose-beta-evening',
          version: 1,
          medicationId: 'med-beta',
          label: 'beta evening',
          localDate: '2026-08-13',
          localTime: '21:00',
        },
      ],
    });
    const prepared = prepareClinicalTurn(state, [
      {
        slot: 'correction',
        kind: 'correction',
        quote: 'it was beta, not alpha',
        ...eligible,
        medicationText: 'beta',
        targetText: 'alpha',
      },
    ]);
    const reduced = reducePatientClinicalMemory(memory, prepared.commands).memory;

    expect(prepared.commands.some(({ kind }) => kind === 'CorrectReport')).toBe(false);
    expect(reduced.events).toEqual([accepted]);
    expect(reduced.unresolvedReports).toEqual([
      expect.objectContaining({
        reason: 'correction_dose_unresolved',
        candidateMedicationIds: ['med-beta'],
        candidateDoseIds: ['dose-beta-evening', 'dose-beta-morning'],
      }),
    ]);
  });

  it('binds the only compatible dose when a medication clarification is answered', () => {
    const memory = pendingMedicationMemory();
    const prepared = prepareClinicalTurn(
      snapshot({
        memory,
        inboundMessage: { id: 'message-answer', sequence: 2, body: 'It was beta.' },
      }),
      [medicationAnswer()],
    );
    const reduced = reducePatientClinicalMemory(memory, prepared.commands).memory;
    const successor = reduced.events.find(({ current }) => current);

    expect(reduced.needs.find(({ id }) => id === 'need-medication')?.state).toBe('resolved');
    expect(successor).toMatchObject({
      medicationId: 'med-beta',
      medicationVersion: 1,
      doseId: 'dose-beta-morning',
      doseVersion: 1,
      localDate: '2026-08-13',
      localTime: '09:00',
      canonical: true,
    });
    expect(
      reduced.needs.filter(
        ({ targetEventId, field, state }) =>
          targetEventId === successor?.id &&
          field === 'dose_identity' &&
          (state === 'open' || state === 'asked'),
      ),
    ).toEqual([]);
  });

  it('freezes a successor dose need when a medication answer has multiple compatible doses', () => {
    const memory = pendingMedicationMemory([
      'dose-alpha',
      'dose-beta-morning',
      'dose-beta-evening',
    ]);
    const prepared = prepareClinicalTurn(
      snapshot({
        memory,
        inboundMessage: { id: 'message-answer', sequence: 2, body: 'It was beta.' },
        doses: [
          ...snapshot().doses,
          {
            id: 'dose-beta-evening',
            version: 1,
            medicationId: 'med-beta',
            label: 'beta evening',
            localDate: '2026-08-13',
            localTime: '21:00',
          },
        ],
      }),
      [medicationAnswer()],
    );
    const reduced = reducePatientClinicalMemory(memory, prepared.commands).memory;
    const successor = reduced.events.find(({ current }) => current);
    const doseNeed = reduced.needs.find(
      ({ targetEventId, field }) => targetEventId === successor?.id && field === 'dose_identity',
    );

    expect(reduced.needs.find(({ id }) => id === 'need-medication')?.state).toBe('resolved');
    expect(successor).toMatchObject({ medicationId: 'med-beta', canonical: false });
    expect(successor?.doseId).toBeUndefined();
    expect(doseNeed).toMatchObject({
      candidateMedicationIds: ['med-beta'],
      candidateDoseIds: ['dose-beta-evening', 'dose-beta-morning'],
      targetEventId: successor?.id,
      targetEventVersion: successor?.version,
    });
    expect(['open', 'asked']).toContain(doseNeed?.state);
  });

  it('preserves an exact medication report when no compatible dose exists', () => {
    const prepared = prepareClinicalTurn(
      snapshot({
        inboundMessage: { id: 'message-no-dose', sequence: 1, body: 'I took alpha.' },
        doses: snapshot().doses.filter(({ medicationId }) => medicationId !== 'med-alpha'),
      }),
      [
        {
          slot: 'administration',
          kind: 'administration',
          quote: 'took alpha',
          ...eligible,
          medicationText: 'alpha',
          actionText: 'took',
        },
      ],
    );
    const reduced = reducePatientClinicalMemory(emptyMemory(), prepared.commands).memory;

    expect(
      reduced.events.filter(({ kind, canonical }) => kind === 'administration' && canonical),
    ).toEqual([]);
    expect(reduced.unresolvedReports).toEqual([
      expect.objectContaining({ reason: 'dose_unresolved', candidateMedicationIds: ['med-alpha'] }),
    ]);
  });
});

it('rejects a valid replay whose full prepared payload differs despite the same command hash', () => {
  const state = snapshot({
    inboundMessage: { id: 'message-replay', sequence: 1, body: 'I took alpha.' },
  });
  const claims: ExtractedClaim[] = [
    {
      slot: 'administration',
      kind: 'administration',
      quote: 'took alpha',
      ...eligible,
      medicationText: 'alpha',
      actionText: 'took',
    },
  ];
  const firstPrepared = prepareClinicalTurn(state, claims);
  const differentPrepared = prepareClinicalTurn({ ...state, contextHash: '1'.repeat(64) }, claims);
  const first = applyPreparedClinicalTurn(state.memory, firstPrepared);

  expect(differentPrepared.commandHash).toBe(firstPrepared.commandHash);
  expect(differentPrepared.preparedHash).not.toBe(firstPrepared.preparedHash);
  expect(() => applyPreparedClinicalTurn(first.memory, differentPrepared)).toThrow(
    'prepared_batch_integrity_error',
  );
});
