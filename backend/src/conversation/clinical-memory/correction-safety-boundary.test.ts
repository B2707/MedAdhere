import { describe, expect, it } from 'vitest';
import {
  applyPreparedClinicalTurn,
  clinicalResponsePlanSchema,
  patientClinicalMemorySchema,
  prepareClinicalTurn,
  reducePatientClinicalMemory,
  type ClinicalEvent,
  type ClinicalIntentCommand,
  type ExtractedClaim,
  type PatientClinicalMemory,
  type PatientClinicalSnapshot,
} from './index.js';

const HASH = '0'.repeat(64);
const ELIGIBLE = {
  polarity: 'positive',
  experiencer: 'patient',
  status: 'current',
  certainty: 'certain',
} as const;

function sourceSpan(messageId: string, quote: string) {
  return { messageId, start: 0, end: quote.length, quote };
}

function memory(
  events: readonly ClinicalEvent[] = [],
  overrides: Partial<PatientClinicalMemory> = {},
): PatientClinicalMemory {
  return {
    patientId: 'patient-correction-safety',
    version: events.length === 0 ? 0 : 1,
    events: [...events],
    needs: [],
    unresolvedReports: [],
    reviewItems: [],
    routineClarificationsPaused: false,
    processedBatches: [],
    ...overrides,
  };
}

function snapshotForMemory(
  currentMemory: PatientClinicalMemory,
  messageId: string,
  sequence: number,
  body: string,
  overrides: Partial<PatientClinicalSnapshot> = {},
): PatientClinicalSnapshot {
  return {
    memory: currentMemory,
    inboundMessage: { id: messageId, sequence, body },
    consentEpoch: 1,
    expectedConsentEpoch: 1,
    medications: [{ id: 'med-alpha', version: 1, names: ['alpha'], aliases: [], active: true }],
    doses: [
      {
        id: 'dose-alpha',
        version: 1,
        medicationId: 'med-alpha',
        label: 'alpha dose',
        localDate: '2026-08-13',
        localTime: '08:00',
      },
    ],
    symptomConcepts: ['nausea', 'headache'],
    languageDisposition: 'english',
    emergencyPrefilter: false,
    contextHash: HASH,
    pipelineVersions: {
      extractor: 'extractor-v1',
      resolver: 'resolver-v1',
      reducer: 'reducer-v1',
      renderer: 'renderer-v1',
    },
    ...overrides,
  };
}

function snapshot(event: ClinicalEvent, messageId: string, body: string): PatientClinicalSnapshot {
  return snapshotForMemory(memory([event]), messageId, 2, body);
}

function administration(
  adherence: 'taken' | 'missed',
  overrides: Partial<ClinicalEvent> = {},
): ClinicalEvent {
  const quote = adherence === 'taken' ? 'I took alpha.' : 'I missed alpha.';
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
    sourceSpans: [sourceSpan('message-prior', quote)],
    medicationId: 'med-alpha',
    medicationVersion: 1,
    doseId: 'dose-alpha',
    doseVersion: 1,
    adherence,
    localDate: '2026-08-13',
    localTime: '08:00',
    ...overrides,
  };
}

function symptom(overrides: Partial<ClinicalEvent> = {}): ClinicalEvent {
  return {
    id: 'event-nausea',
    version: 1,
    kind: 'symptom',
    operation: 'create',
    authoredBy: 'patient',
    reviewState: 'unreviewed',
    current: true,
    canonical: true,
    sourceMessageIds: ['message-prior'],
    sourceSpans: [sourceSpan('message-prior', 'I have nausea.')],
    rawSymptom: 'nausea',
    symptomConcept: 'nausea',
    symptomStatus: 'current',
    ...overrides,
  };
}

function commit(state: PatientClinicalSnapshot, claims: readonly ExtractedClaim[]) {
  const prepared = prepareClinicalTurn(state, claims);
  return applyPreparedClinicalTurn(state.memory, prepared);
}

describe('correction safety at the public boundary', () => {
  it('keeps an unknown-medication correction unresolved without superseding or inheriting the old fact', () => {
    const accepted = administration('taken');
    const state = snapshot(
      accepted,
      'message-unknown-medication',
      'Correction: it was omega, not alpha.',
    );
    const committed = commit(state, [
      {
        slot: 'correction',
        kind: 'correction',
        quote: 'it was omega, not alpha',
        ...ELIGIBLE,
        medicationText: 'omega',
        targetText: 'alpha',
      },
    ]);

    expect(committed.prepared.commands.filter(({ kind }) => kind === 'CorrectReport')).toEqual([]);
    expect(committed.memory.events).toEqual([accepted]);
    expect(committed.memory.events.filter(({ supersedesEventId }) => supersedesEventId)).toEqual(
      [],
    );
    expect(committed.memory.unresolvedReports).toContainEqual(
      expect.objectContaining({
        sourceMessageId: state.inboundMessage.id,
        reason: 'correction_medication_unresolved',
      }),
    );
  });

  it('does not turn a partial-dose correction into a taken administration', () => {
    const accepted = administration('missed');
    const state = snapshot(
      accepted,
      'message-partial-correction',
      'Correction: I partially took alpha.',
    );
    const committed = commit(state, [
      {
        slot: 'correction',
        kind: 'correction',
        quote: 'partially took alpha',
        ...ELIGIBLE,
        targetText: 'alpha',
        actionText: 'partially took',
      },
    ]);

    expect(committed.prepared.commands.filter(({ kind }) => kind === 'CorrectReport')).toEqual([]);
    expect(committed.memory.events).toEqual([accepted]);
    expect(committed.memory.unresolvedReports).toContainEqual(
      expect.objectContaining({ reason: 'correction_action_noncounting' }),
    );
  });

  it('records a resolved symptom as a contradiction without replacing the clinician-confirmed event', () => {
    const accepted = symptom({ authoredBy: 'clinician', reviewState: 'confirmed' });
    const state = snapshot(accepted, 'message-protected-resolution', 'The nausea has resolved.');
    const committed = commit(state, [
      {
        slot: 'symptom-resolution',
        kind: 'symptom',
        quote: 'nausea has resolved',
        ...ELIGIBLE,
        status: 'resolved',
        symptomText: 'nausea',
      },
    ]);

    expect(committed.memory.events.find(({ id }) => id === accepted.id)).toEqual(accepted);
    expect(committed.memory.events).toContainEqual(
      expect.objectContaining({
        kind: 'contradiction',
        canonical: false,
        contradictionOfEventId: accepted.id,
        symptomStatus: 'resolved',
      }),
    );
    expect(committed.memory.reviewItems).toContainEqual(
      expect.objectContaining({
        kind: 'contradiction',
        targetEventId: accepted.id,
        status: 'open',
      }),
    );
  });

  it('fails closed instead of partially applying a same-message correction and detail to one event', () => {
    const accepted = symptom();
    const state = snapshot(
      accepted,
      'message-correction-and-detail',
      'Correction: it was headache, not nausea. The nausea was severe.',
    );
    const before = structuredClone(state.memory);
    const committed = commit(state, [
      {
        slot: 'correction',
        kind: 'correction',
        quote: 'it was headache, not nausea',
        ...ELIGIBLE,
        symptomText: 'headache',
        targetText: 'nausea',
      },
      {
        slot: 'detail',
        kind: 'symptom_detail',
        quote: 'nausea was severe',
        ...ELIGIBLE,
        targetText: 'nausea',
        detailField: 'severity',
        detailText: 'severe',
      },
    ]);

    expect(
      committed.prepared.commands.filter(
        ({ kind }) => kind === 'CorrectReport' || kind === 'RefineReport',
      ),
    ).toEqual([]);
    expect(committed.memory.events).toEqual([accepted]);
    expect(committed.memory.unresolvedReports).toContainEqual(
      expect.objectContaining({
        sourceMessageId: state.inboundMessage.id,
        candidateEventIds: [accepted.id],
      }),
    );
    expect(state.memory).toEqual(before);
  });
});

describe('adjacent clinical-memory invariants at the public boundary', () => {
  it('does not create two canonical administrations for duplicate same-dose claims in one message', () => {
    const state = snapshotForMemory(
      memory(),
      'message-same-turn-duplicate',
      1,
      'I took alpha, and alpha was taken.',
    );
    const committed = commit(state, [
      {
        slot: 'first-administration',
        kind: 'administration',
        quote: 'took alpha',
        ...ELIGIBLE,
        medicationText: 'alpha',
        actionText: 'took',
      },
      {
        slot: 'duplicate-administration',
        kind: 'administration',
        quote: 'alpha was taken',
        ...ELIGIBLE,
        medicationText: 'alpha',
        actionText: 'taken',
      },
    ]);

    expect(
      committed.memory.events.filter(
        ({ kind, canonical, current, doseId }) =>
          kind === 'administration' && current && canonical && doseId === 'dose-alpha',
      ),
    ).toHaveLength(1);
  });

  it('does not create a second canonical administration when the same dose is repeated next turn', () => {
    const first = commit(
      snapshotForMemory(memory(), 'message-first-administration', 1, 'I took alpha.'),
      [
        {
          slot: 'first-administration',
          kind: 'administration',
          quote: 'took alpha',
          ...ELIGIBLE,
          medicationText: 'alpha',
          actionText: 'took',
        },
      ],
    );
    const second = commit(
      snapshotForMemory(first.memory, 'message-repeated-administration', 2, 'Yes, I took alpha.'),
      [
        {
          slot: 'repeated-administration',
          kind: 'administration',
          quote: 'took alpha',
          ...ELIGIBLE,
          medicationText: 'alpha',
          actionText: 'took',
        },
      ],
    );

    expect(
      second.memory.events.filter(
        ({ kind, canonical, current, doseId }) =>
          kind === 'administration' && current && canonical && doseId === 'dose-alpha',
      ),
    ).toHaveLength(1);
  });

  it('does not move a correction to a dose from a different local date', () => {
    const accepted = administration('missed', {
      id: 'event-alpha-august-12',
      doseId: 'dose-alpha-august-12',
      localDate: '2026-08-12',
    });
    const state = snapshotForMemory(
      memory([accepted]),
      'message-cross-date-correction',
      2,
      'Correction: it was the evening dose of alpha.',
      {
        doses: [
          {
            id: 'dose-alpha-august-12',
            version: 1,
            medicationId: 'med-alpha',
            label: 'morning dose',
            localDate: '2026-08-12',
            localTime: '08:00',
          },
          {
            id: 'dose-alpha-august-13',
            version: 1,
            medicationId: 'med-alpha',
            label: 'evening dose',
            localDate: '2026-08-13',
            localTime: '20:00',
          },
        ],
      },
    );
    const committed = commit(state, [
      {
        slot: 'correction',
        kind: 'correction',
        quote: 'it was the evening dose of alpha',
        ...ELIGIBLE,
        medicationText: 'alpha',
        doseText: 'evening dose',
        targetText: 'alpha',
      },
    ]);

    expect(committed.prepared.commands.filter(({ kind }) => kind === 'CorrectReport')).toEqual([]);
    expect(committed.memory.events).toEqual([accepted]);
    expect(committed.memory.unresolvedReports).toHaveLength(1);
  });

  it('uses the selected historical episode concept for a delayed recurrence answer', () => {
    const left = symptom({
      id: 'event-left-tingling',
      rawSymptom: 'tingling',
      symptomConcept: 'paresthesia',
      symptomStatus: 'resolved',
      bodySite: 'left arm',
    });
    const right = symptom({
      id: 'event-right-tingling',
      rawSymptom: 'tingling',
      symptomConcept: 'neuropathy',
      symptomStatus: 'resolved',
      bodySite: 'right arm',
    });
    const opened = commit(
      snapshotForMemory(
        memory([left, right]),
        'message-ambiguous-recurrence',
        2,
        'The tingling returned.',
      ),
      [
        {
          slot: 'recurrence',
          kind: 'recurrence',
          quote: 'tingling returned',
          ...ELIGIBLE,
          symptomText: 'tingling',
        },
      ],
    );
    const answered = commit(
      snapshotForMemory(opened.memory, 'message-recurrence-target', 3, 'Right arm.', {
        symptomConcepts: ['nausea', 'headache', 'paresthesia', 'neuropathy'],
      }),
      [
        {
          slot: 'event-answer',
          kind: 'need_answer',
          quote: 'Right arm',
          ...ELIGIBLE,
          answerField: 'event_identity',
          answerText: 'Right arm',
        },
      ],
    );
    const recurrence = answered.memory.events.find(
      ({ recurrenceOfEventId }) => recurrenceOfEventId === right.id,
    );

    expect(recurrence).toMatchObject({
      rawSymptom: 'tingling',
      symptomConcept: 'neuropathy',
      recurrenceOfEventId: right.id,
    });
  });

  it('rejects a RefineReport command against a clinician-confirmed event without mutation', () => {
    const accepted = symptom({ authoredBy: 'clinician', reviewState: 'confirmed' });
    const state = memory([accepted]);
    const before = structuredClone(state);
    const quote = 'nausea was severe';
    const command: ClinicalIntentCommand = {
      id: 'command-protected-refinement',
      kind: 'RefineReport',
      sourceMessageId: 'message-protected-refinement',
      sourceSpans: [
        {
          messageId: 'message-protected-refinement',
          start: 0,
          end: quote.length,
          quote,
        },
      ],
      targetEventId: accepted.id,
      targetEventVersion: accepted.version,
      targetKind: 'symptom',
      severity: 'severe',
    };

    expect(() => reducePatientClinicalMemory(state, [command])).toThrow();
    expect(state).toEqual(before);
  });

  it('rejects aggregate state with an open emergency review but no routine-clarification pause', () => {
    const emergency: ClinicalEvent = {
      id: 'event-emergency',
      version: 1,
      kind: 'safety',
      operation: 'raise_safety',
      authoredBy: 'patient',
      reviewState: 'unreviewed',
      current: true,
      canonical: true,
      sourceMessageIds: ['message-emergency'],
      sourceSpans: [sourceSpan('message-emergency', "I can't breathe.")],
      safetyTier: 'emergency',
    };
    const inconsistent = memory([emergency], {
      routineClarificationsPaused: false,
      reviewItems: [
        {
          id: 'review-emergency',
          kind: 'safety',
          sourceMessageId: 'message-emergency',
          reason: 'emergency review remains open',
          status: 'open',
        },
      ],
    });

    expect(patientClinicalMemorySchema.safeParse(inconsistent).success).toBe(false);
  });

  it('requires the response kind and question payload to agree', () => {
    const question = {
      needId: 'need-severity',
      eventId: 'event-nausea',
      field: 'severity' as const,
      questionId: 'question-severity',
    };

    expect([
      clinicalResponsePlanSchema.safeParse({
        kind: 'routine',
        acknowledgementId: 'acknowledgement-recorded',
        question,
        reviewReasons: [],
      }).success,
      clinicalResponsePlanSchema.safeParse({
        kind: 'question',
        acknowledgementId: 'acknowledgement-recorded',
        reviewReasons: [],
      }).success,
    ]).toEqual([false, false]);
  });
});
