import { describe, expect, it } from 'vitest';
import {
  applyPreparedClinicalTurn,
  prepareClinicalTurn,
  reducePatientClinicalMemory,
  type ExtractedClaim,
  type PatientClinicalMemory,
  type PatientClinicalSnapshot,
  type PreparedClinicalTurn,
} from './index.js';

const HASH = '0'.repeat(64);
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
        localTime: '20:00',
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

function administration(
  slot: string,
  quote: string,
  medicationText: string,
  actionText: string,
): ExtractedClaim {
  return {
    slot,
    kind: 'administration',
    quote,
    ...eligible,
    medicationText,
    actionText,
  };
}

function severityAnswer(slot: string, quote: string, answerText = quote): ExtractedClaim {
  return {
    slot,
    kind: 'need_answer',
    quote,
    ...eligible,
    answerField: 'severity',
    answerText,
  };
}

function currentSymptom(
  id: string,
  bodySite: string,
  overrides: Partial<PatientClinicalMemory['events'][number]> = {},
): PatientClinicalMemory['events'][number] {
  return {
    id,
    version: 1,
    kind: 'symptom',
    operation: 'create',
    authoredBy: 'patient',
    reviewState: 'unreviewed',
    current: true,
    canonical: true,
    sourceMessageIds: ['prior-message'],
    sourceSpans: [sourceSpan('prior-message', `nausea in ${bodySite}`)],
    rawSymptom: 'nausea',
    symptomConcept: 'nausea',
    symptomStatus: 'resolved',
    bodySite,
    ...overrides,
  };
}

function expectRejectedBatch(
  turn: PreparedClinicalTurn,
  memory: PatientClinicalMemory,
  reason?: string | RegExp,
): void {
  expect(turn.responsePlan.kind).toBe('human_review');
  expect(turn.commands).toHaveLength(1);
  expect(turn.commands[0]?.kind).toBe('PreserveUnresolvedContent');
  if (reason !== undefined) {
    expect((turn.commands[0] as { reason: string }).reason).toEqual(expect.stringMatching(reason));
  }
  const reduced = reducePatientClinicalMemory(memory, turn.commands).memory;
  expect(reduced.events).toEqual(memory.events);
  expect(reduced.needs).toEqual(memory.needs);
  expect(reduced.unresolvedReports).toHaveLength(memory.unresolvedReports.length + 1);
}

describe('exact-source batch validation', () => {
  it('rejects the whole batch when one extracted field is outside its quote', () => {
    const state = snapshot({
      inboundMessage: {
        id: 'message-source-mismatch',
        sequence: 1,
        body: 'I took alpha, and beta was skipped.',
      },
    });
    const turn = prepareClinicalTurn(state, [
      administration('valid', 'took alpha', 'alpha', 'took'),
      administration('invalid', 'beta was skipped', 'beta', 'missed'),
    ]);

    expectRejectedBatch(turn, state.memory, 'source_field_mismatch');
  });

  it('rejects the whole batch when a claim carries an extra projected-state key', () => {
    const state = snapshot({
      inboundMessage: { id: 'message-extra-key', sequence: 1, body: 'I took alpha.' },
    });
    const claim = {
      ...administration('administration', 'took alpha', 'alpha', 'took'),
      projectedEvent: { canonical: true },
    } as unknown as ExtractedClaim;

    expectRejectedBatch(
      prepareClinicalTurn(state, [claim]),
      state.memory,
      'extraction_validation_failed',
    );
  });

  it('rejects semantically duplicate claims even when their request-local aliases differ', () => {
    const state = snapshot({
      inboundMessage: { id: 'message-duplicate', sequence: 1, body: 'I took alpha.' },
    });
    const turn = prepareClinicalTurn(state, [
      administration('first-alias', 'took alpha', 'alpha', 'took'),
      administration('second-alias', 'took alpha', 'alpha', 'took'),
    ]);

    expectRejectedBatch(turn, state.memory, 'claim_semantic_duplicate');
  });
});

describe('information-need relation batch validation', () => {
  const symptom = (id: string) =>
    currentSymptom(id, 'head', { symptomStatus: 'current', rawSymptom: 'headache' });
  const askedSeverityNeed = (id: string, targetEventId: string) => ({
    id,
    version: 1,
    originInboundMessageId: 'prior-message',
    originInboundSequence: 1,
    targetEventId,
    targetEventVersion: 1,
    field: 'severity' as const,
    candidateMedicationIds: [],
    candidateDoseIds: [],
    candidateSymptomEventIds: [targetEventId],
    candidateHistoricalEventIds: [],
    questionId: `question-${id}`,
    clarificationAttemptUsed: true,
    state: 'asked' as const,
    priority: 70,
  });
  const twoAskedSeverityState = (body: string) => {
    const firstEventId = 'event-first-headache';
    const secondEventId = 'event-second-headache';
    const firstNeedId = 'need-first-severity';
    const secondNeedId = 'need-second-severity';
    const memory: PatientClinicalMemory = {
      ...emptyMemory(),
      version: 3,
      events: [symptom(firstEventId), symptom(secondEventId)],
      needs: [
        askedSeverityNeed(firstNeedId, firstEventId),
        askedSeverityNeed(secondNeedId, secondEventId),
      ],
    };
    return {
      firstEventId,
      secondEventId,
      firstNeedId,
      secondNeedId,
      memory,
      state: snapshot({
        memory,
        inboundMessage: { id: 'message-two-asked-needs', sequence: 2, body },
      }),
    };
  };

  it('rejects multiple answers for one durable information need', () => {
    const eventId = 'event-headache';
    const needId = 'need-headache-severity';
    const memory: PatientClinicalMemory = {
      ...emptyMemory(),
      version: 2,
      events: [symptom(eventId)],
      needs: [askedSeverityNeed(needId, eventId)],
    };
    const state = snapshot({
      memory,
      inboundMessage: { id: 'message-two-answers', sequence: 2, body: '7 8' },
    });

    expectRejectedBatch(
      prepareClinicalTurn(state, [
        { claim: severityAnswer('first-answer', '7'), informationNeedId: needId },
        { claim: severityAnswer('second-answer', '8'), informationNeedId: needId },
      ]),
      memory,
      'claim_information_need_relationship_conflict',
    );
  });

  it('rejects one exact source answer targeting multiple durable information needs', () => {
    const { firstNeedId, secondNeedId, memory, state } = twoAskedSeverityState('7');

    expectRejectedBatch(
      prepareClinicalTurn(state, [
        { claim: severityAnswer('first-relation', '7'), informationNeedId: firstNeedId },
        { claim: severityAnswer('second-relation', '7'), informationNeedId: secondNeedId },
      ]),
      memory,
      'claim_information_need_relationship_conflict',
    );
  });

  it('rejects nested source answers targeting multiple durable information needs', () => {
    const { firstNeedId, secondNeedId, memory, state } = twoAskedSeverityState('7.');

    expectRejectedBatch(
      prepareClinicalTurn(state, [
        { claim: severityAnswer('nested-answer', '7'), informationNeedId: firstNeedId },
        { claim: severityAnswer('full-answer', '7.', '7'), informationNeedId: secondNeedId },
      ]),
      memory,
      'claim_information_need_relationship_conflict',
    );
  });

  it('rejects partially overlapping source answers targeting multiple durable information needs', () => {
    const { firstNeedId, secondNeedId, memory, state } = twoAskedSeverityState('7 and 8');

    expectRejectedBatch(
      prepareClinicalTurn(state, [
        { claim: severityAnswer('left-overlap', '7 and', '7'), informationNeedId: firstNeedId },
        { claim: severityAnswer('right-overlap', 'and 8', '8'), informationNeedId: secondNeedId },
      ]),
      memory,
      'claim_information_need_relationship_conflict',
    );
  });

  it('allows disjoint source answers to target distinct durable information needs', () => {
    const { firstNeedId, secondNeedId, state } = twoAskedSeverityState('7 8');
    const prepared = prepareClinicalTurn(state, [
      { claim: severityAnswer('first-answer', '7'), informationNeedId: firstNeedId },
      { claim: severityAnswer('second-answer', '8'), informationNeedId: secondNeedId },
    ]);

    expect(
      prepared.commands
        .filter(
          (command): command is Extract<typeof command, { kind: 'ResolveInformationNeed' }> =>
            command.kind === 'ResolveInformationNeed',
        )
        .map(({ needId }) => needId)
        .sort(),
    ).toEqual([firstNeedId, secondNeedId]);
    expect(prepared.commands.filter(({ kind }) => kind === 'RefineReport')).toHaveLength(2);
    expect(prepared.commands.filter(({ kind }) => kind === 'PreserveUnresolvedContent')).toEqual(
      [],
    );
  });

  it('allows one related answer to resolve only its exact durable information need', () => {
    const { firstNeedId, secondNeedId, secondEventId, state } = twoAskedSeverityState('7');
    const prepared = prepareClinicalTurn(state, [
      { claim: severityAnswer('single-answer', '7'), informationNeedId: secondNeedId },
    ]);

    expect(prepared.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'ResolveInformationNeed', needId: secondNeedId }),
        expect.objectContaining({ kind: 'RefineReport', targetEventId: secondEventId }),
      ]),
    );
    expect(
      prepared.commands.some(
        (command) => command.kind === 'ResolveInformationNeed' && command.needId === firstNeedId,
      ),
    ).toBe(false);
  });

  it('does not fall back when a related answer names a stale information need', () => {
    const { state } = twoAskedSeverityState('7');
    const prepared = prepareClinicalTurn(state, [
      { claim: severityAnswer('stale-answer', '7'), informationNeedId: 'need-stale' },
    ]);

    expect(prepared.commands).toEqual([
      expect.objectContaining({
        kind: 'PreserveUnresolvedContent',
        reason: 'pending_target_ambiguous',
      }),
    ]);
    expect(
      prepared.commands.some(
        ({ kind }) => kind === 'ResolveInformationNeed' || kind === 'RefineReport',
      ),
    ).toBe(false);
  });
});

describe('determinism at the public preparation boundary', () => {
  it('is byte-equivalent when request-local aliases are renamed', () => {
    const state = snapshot({
      inboundMessage: {
        id: 'message-aliases',
        sequence: 1,
        body: 'I took alpha. Correction: I missed alpha.',
      },
    });
    const claims = (primarySlot: string, correctionSlot: string): ExtractedClaim[] => [
      administration(primarySlot, 'took alpha', 'alpha', 'took'),
      {
        slot: correctionSlot,
        kind: 'correction',
        quote: 'missed alpha',
        ...eligible,
        medicationText: 'alpha',
        actionText: 'missed',
        targetClaimSlot: primarySlot,
      },
    ];

    expect(prepareClinicalTurn(state, claims('report-a', 'correction-a'))).toEqual(
      prepareClinicalTurn(state, claims('local-17', 'local-99')),
    );
  });

  it('is byte-equivalent when independent claim input order changes', () => {
    const state = snapshot({
      inboundMessage: {
        id: 'message-order',
        sequence: 1,
        body: 'I took alpha and I missed beta.',
      },
    });
    const alpha = administration('alpha-report', 'took alpha', 'alpha', 'took');
    const beta = administration('beta-report', 'missed beta', 'beta', 'missed');

    expect(prepareClinicalTurn(state, [alpha, beta])).toEqual(
      prepareClinicalTurn(state, [beta, alpha]),
    );
  });

  it('is byte-equivalent when the same invalid claim categories are reordered', () => {
    const state = snapshot({
      inboundMessage: {
        id: 'message-invalid-order',
        sequence: 1,
        body: 'I took alpha and I missed beta.',
      },
    });
    const badQuote = administration('bad-quote', 'took gamma', 'gamma', 'took');
    const badSource = administration('bad-source', 'missed beta', 'beta', 'took');
    const forward = prepareClinicalTurn(state, [badQuote, badSource]);
    const reversed = prepareClinicalTurn(state, [badSource, badQuote]);

    expect(forward.responsePlan.kind).toBe('human_review');
    expect(reversed).toEqual(forward);
  });
});

describe('eligible targeting only', () => {
  it('preserves an uncertain need answer instead of refining its target', () => {
    const memory: PatientClinicalMemory = {
      ...emptyMemory(),
      version: 2,
      events: [currentSymptom('event-nausea', 'stomach', { symptomStatus: 'current' })],
      needs: [
        {
          id: 'need-severity',
          version: 2,
          originInboundMessageId: 'prior-message',
          originInboundSequence: 1,
          targetEventId: 'event-nausea',
          targetEventVersion: 1,
          field: 'severity',
          candidateMedicationIds: [],
          candidateDoseIds: [],
          candidateSymptomEventIds: ['event-nausea'],
          candidateHistoricalEventIds: [],
          questionId: 'question-severity',
          clarificationAttemptUsed: true,
          state: 'asked',
          priority: 70,
        },
      ],
    };
    const state = snapshot({
      memory,
      inboundMessage: { id: 'message-uncertain-answer', sequence: 2, body: 'Maybe it is severe.' },
    });
    const turn = prepareClinicalTurn(state, [
      {
        slot: 'answer',
        kind: 'need_answer',
        quote: 'Maybe it is severe',
        ...eligible,
        certainty: 'uncertain',
        answerField: 'severity',
        answerText: 'severe',
      },
    ]);
    const reduced = reducePatientClinicalMemory(memory, turn.commands).memory;

    expect(turn.commands.map(({ kind }) => kind)).toEqual(['PreserveUnresolvedContent']);
    expect(reduced.events).toEqual(memory.events);
    expect(reduced.needs).toEqual(memory.needs);
    expect(reduced.unresolvedReports.map(({ reason }) => reason)).toEqual([
      'need_answer_ineligible',
    ]);
  });

  it('preserves a third-person symptom detail instead of refining the patient report', () => {
    const memory: PatientClinicalMemory = {
      ...emptyMemory(),
      version: 1,
      events: [currentSymptom('event-nausea', 'stomach', { symptomStatus: 'current' })],
    };
    const state = snapshot({
      memory,
      inboundMessage: {
        id: 'message-third-person-detail',
        sequence: 2,
        body: 'My sister says nausea is mild.',
      },
    });
    const turn = prepareClinicalTurn(state, [
      {
        slot: 'detail',
        kind: 'symptom_detail',
        quote: 'sister says nausea is mild',
        ...eligible,
        experiencer: 'other',
        targetText: 'nausea',
        detailField: 'severity',
        detailText: 'mild',
      },
    ]);
    const reduced = reducePatientClinicalMemory(memory, turn.commands).memory;

    expect(turn.commands.filter(({ kind }) => kind === 'RefineReport')).toEqual([]);
    expect(reduced.events).toEqual(memory.events);
    expect(reduced.unresolvedReports.map(({ reason }) => reason)).toEqual([
      'symptom_detail_ineligible',
    ]);
  });
});

describe('historical and same-message targeting', () => {
  it('uses an explicit body site to select one unique resolved episode for recurrence', () => {
    const memory: PatientClinicalMemory = {
      ...emptyMemory(),
      version: 3,
      events: [
        currentSymptom('event-left', 'left arm'),
        currentSymptom('event-right', 'right arm'),
      ],
    };
    const state = snapshot({
      memory,
      inboundMessage: {
        id: 'message-recurrence-left',
        sequence: 4,
        body: 'The nausea returned in my left arm.',
      },
    });
    const turn = prepareClinicalTurn(state, [
      {
        slot: 'recurrence',
        kind: 'recurrence',
        quote: 'nausea returned in my left arm',
        ...eligible,
        symptomText: 'nausea',
        bodySiteText: 'left arm',
      },
    ]);

    expect(
      turn.commands
        .filter(
          (command): command is Extract<typeof command, { kind: 'RecordRecurrence' }> =>
            command.kind === 'RecordRecurrence',
        )
        .map(({ targetEventId }) => targetEventId),
    ).toEqual(['event-left']);
    expect(turn.commands.filter(({ kind }) => kind === 'PreserveUnresolvedContent')).toEqual([]);
  });

  it('preserves a recurrence when two resolved episodes remain plausible', () => {
    const memory: PatientClinicalMemory = {
      ...emptyMemory(),
      version: 3,
      events: [
        currentSymptom('event-left', 'left arm'),
        currentSymptom('event-right', 'right arm'),
      ],
    };
    const state = snapshot({
      memory,
      inboundMessage: {
        id: 'message-recurrence-ambiguous',
        sequence: 4,
        body: 'The nausea returned.',
      },
    });
    const turn = prepareClinicalTurn(state, [
      {
        slot: 'recurrence',
        kind: 'recurrence',
        quote: 'nausea returned',
        ...eligible,
        symptomText: 'nausea',
      },
    ]);
    const need = turn.commands.find(
      (command): command is Extract<typeof command, { kind: 'OpenInformationNeed' }> =>
        command.kind === 'OpenInformationNeed' && command.field === 'event_identity',
    );

    expect(need?.candidateHistoricalEvents).toEqual([
      { eventId: 'event-left', eventVersion: 1 },
      { eventId: 'event-right', eventVersion: 1 },
    ]);
    expect(turn.commands.filter(({ kind }) => kind === 'RecordRecurrence')).toEqual([]);
  });

  it('targets and corrects the report created earlier in the same message', () => {
    const state = snapshot({
      inboundMessage: {
        id: 'message-same-message-correction',
        sequence: 1,
        body: 'I took alpha. Correction: I missed alpha.',
      },
    });
    const turn = prepareClinicalTurn(state, [
      administration('original', 'took alpha', 'alpha', 'took'),
      {
        slot: 'correction',
        kind: 'correction',
        quote: 'missed alpha',
        ...eligible,
        medicationText: 'alpha',
        actionText: 'missed',
        targetClaimSlot: 'original',
      },
    ]);
    const reduced = reducePatientClinicalMemory(state.memory, turn.commands).memory;
    const created = turn.commands.find(
      (command): command is Extract<typeof command, { kind: 'CreateReport' }> =>
        command.kind === 'CreateReport',
    );
    const correction = turn.commands.find(
      (command): command is Extract<typeof command, { kind: 'CorrectReport' }> =>
        command.kind === 'CorrectReport',
    );

    expect(created).toBeDefined();
    expect(correction).toBeDefined();
    expect(reduced.events).toHaveLength(2);
    expect(reduced.events.filter(({ current }) => current)).toHaveLength(1);
    expect(reduced.events.find(({ current }) => current)?.adherence).toBe('missed');
    expect(reduced.events.find(({ current }) => current)?.operation).toBe('correct');
  });

  it('records a contradiction without changing a clinician-reviewed report', () => {
    const accepted: PatientClinicalMemory['events'][number] = {
      id: 'event-reviewed',
      version: 2,
      kind: 'administration',
      operation: 'create',
      authoredBy: 'clinician',
      reviewState: 'confirmed',
      current: true,
      canonical: true,
      sourceMessageIds: ['clinician-message'],
      sourceSpans: [],
      medicationId: 'med-alpha',
      medicationVersion: 1,
      doseId: 'dose-alpha',
      doseVersion: 1,
      adherence: 'taken',
    };
    const memory: PatientClinicalMemory = { ...emptyMemory(), version: 4, events: [accepted] };
    const state = snapshot({
      memory,
      inboundMessage: {
        id: 'message-protected-correction',
        sequence: 5,
        body: 'Correction: alpha was missed.',
      },
    });
    const turn = prepareClinicalTurn(state, [
      {
        slot: 'correction',
        kind: 'correction',
        quote: 'alpha was missed',
        ...eligible,
        targetText: 'alpha',
        actionText: 'missed',
      },
    ]);
    const reduced = reducePatientClinicalMemory(memory, turn.commands).memory;

    expect(turn.commands.map(({ kind }) => kind)).toContain('RecordContradiction');
    expect(reduced.events.find(({ id }) => id === accepted.id)).toEqual(accepted);
    expect(
      reduced.events.find(({ contradictionOfEventId }) => contradictionOfEventId === accepted.id),
    ).toMatchObject({
      kind: 'contradiction',
      canonical: false,
      adherence: 'missed',
    });
    expect(reduced.reviewItems).toEqual([
      expect.objectContaining({
        kind: 'contradiction',
        targetEventId: accepted.id,
        status: 'open',
      }),
    ]);
  });
});

describe('prepared-batch integrity and immutability', () => {
  it.each([
    [
      'response plan',
      (prepared: PreparedClinicalTurn): PreparedClinicalTurn => ({
        ...prepared,
        responsePlan: { ...prepared.responsePlan, reviewReasons: ['tampered-plan'] },
      }),
    ],
    [
      'command identity',
      (prepared: PreparedClinicalTurn): PreparedClinicalTurn => ({
        ...prepared,
        commands: prepared.commands.map((command, index) =>
          index === 0 ? { ...command, id: 'command-tampered' } : command,
        ),
      }),
    ],
    [
      'batch hash',
      (prepared: PreparedClinicalTurn): PreparedClinicalTurn => ({
        ...prepared,
        commandHash: 'f'.repeat(64),
      }),
    ],
  ] as const)('rejects a tampered %s before mutating memory', (_label, tamper) => {
    const memory = emptyMemory();
    const state = snapshot({
      memory,
      inboundMessage: { id: 'message-integrity', sequence: 1, body: 'I took alpha.' },
    });
    const prepared = prepareClinicalTurn(state, [
      administration('report', 'took alpha', 'alpha', 'took'),
    ]);
    const before = structuredClone(memory);

    expect(() => applyPreparedClinicalTurn(memory, tamper(prepared))).toThrow(
      'prepared_batch_integrity_error',
    );
    expect(memory).toEqual(before);
  });

  it('does not mutate snapshot, claim, command, prepared-turn, or memory inputs', () => {
    const state = snapshot({
      inboundMessage: { id: 'message-immutable', sequence: 1, body: 'I took alpha.' },
    });
    const claims = [administration('report', 'took alpha', 'alpha', 'took')];
    const stateBefore = structuredClone(state);
    const claimsBefore = structuredClone(claims);
    const prepared = prepareClinicalTurn(state, claims);

    expect(state).toEqual(stateBefore);
    expect(claims).toEqual(claimsBefore);

    const memoryBeforeReduction = structuredClone(state.memory);
    const commandsBefore = structuredClone(prepared.commands);
    reducePatientClinicalMemory(state.memory, prepared.commands);
    expect(state.memory).toEqual(memoryBeforeReduction);
    expect(prepared.commands).toEqual(commandsBefore);

    const memoryBeforeCommit = structuredClone(state.memory);
    const preparedBefore = structuredClone(prepared);
    applyPreparedClinicalTurn(state.memory, prepared);
    expect(state.memory).toEqual(memoryBeforeCommit);
    expect(prepared).toEqual(preparedBefore);
  });
});
