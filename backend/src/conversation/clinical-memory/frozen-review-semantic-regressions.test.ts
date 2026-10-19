import { describe, expect, it } from 'vitest';

import {
  applyPreparedClinicalTurn,
  prepareClinicalTurn,
  type ClinicalEvent,
  type ExtractedClaim,
  type InformationNeed,
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

type AdministrationClaim = Extract<ExtractedClaim, { kind: 'administration' }>;
type NeedAnswerClaim = Extract<ExtractedClaim, { kind: 'need_answer' }>;

function memory(overrides: Partial<PatientClinicalMemory> = {}): PatientClinicalMemory {
  return {
    patientId: 'patient-frozen-semantic-review',
    version: 0,
    events: [],
    needs: [],
    unresolvedReports: [],
    reviewItems: [],
    routineClarificationsPaused: false,
    processedBatches: [],
    ...overrides,
  };
}

function snapshot(
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
    medications: [
      {
        id: 'med-alpha',
        version: 1,
        names: ['alpha'],
        aliases: ['blue pill'],
        active: true,
      },
      { id: 'med-beta', version: 1, names: ['beta'], aliases: [], active: true },
    ],
    doses: [
      {
        id: 'dose-alpha-morning',
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

function administrationClaim(
  slot: string,
  quote: string,
  overrides: Partial<AdministrationClaim> = {},
): AdministrationClaim {
  return {
    slot,
    kind: 'administration',
    quote,
    ...ELIGIBLE,
    medicationText: 'alpha',
    actionText: 'took',
    ...overrides,
  };
}

function needAnswerClaim(
  slot: string,
  quote: string,
  answerField: NeedAnswerClaim['answerField'],
): NeedAnswerClaim {
  return {
    slot,
    kind: 'need_answer',
    quote,
    ...ELIGIBLE,
    answerField,
    answerText: quote,
  };
}

function administrationEvent(overrides: Partial<ClinicalEvent> = {}): ClinicalEvent {
  const sourceMessageId = 'message-prior-administration';
  const sourceQuote = 'took alpha';
  return {
    id: 'event-alpha-morning',
    version: 1,
    kind: 'administration',
    operation: 'create',
    authoredBy: 'patient',
    reviewState: 'unreviewed',
    current: true,
    canonical: true,
    sourceMessageIds: [sourceMessageId],
    sourceSpans: [
      { messageId: sourceMessageId, start: 0, end: sourceQuote.length, quote: sourceQuote },
    ],
    medicationId: 'med-alpha',
    medicationVersion: 1,
    doseId: 'dose-alpha-morning',
    doseVersion: 1,
    adherence: 'taken',
    localDate: '2026-08-13',
    localTime: '08:00',
    ...overrides,
  };
}

function symptomEvent(
  id: string,
  symptomConcept: string,
  overrides: Partial<ClinicalEvent> = {},
): ClinicalEvent {
  const sourceMessageId = `message-${id}`;
  return {
    id,
    version: 1,
    kind: 'symptom',
    operation: 'create',
    authoredBy: 'patient',
    reviewState: 'unreviewed',
    current: true,
    canonical: true,
    sourceMessageIds: [sourceMessageId],
    sourceSpans: [
      {
        messageId: sourceMessageId,
        start: 0,
        end: symptomConcept.length,
        quote: symptomConcept,
      },
    ],
    rawSymptom: symptomConcept,
    symptomConcept,
    symptomStatus: 'current',
    ...overrides,
  };
}

function severityNeed(target: ClinicalEvent, state: 'open' | 'asked'): InformationNeed {
  return {
    id: `need-severity-${target.id}`,
    version: 1,
    originInboundMessageId: target.sourceMessageIds[0]!,
    originInboundSequence: 1,
    targetEventId: target.id,
    targetEventVersion: target.version,
    field: 'severity',
    candidateMedicationIds: [],
    candidateDoseIds: [],
    candidateSymptomEventIds: [target.id],
    candidateHistoricalEventIds: [],
    questionId: `question-severity-${target.id}`,
    clarificationAttemptUsed: state === 'asked',
    state,
    priority: 70,
  };
}

function commit(
  state: PatientClinicalSnapshot,
  claims: readonly ExtractedClaim[],
): ReturnType<typeof applyPreparedClinicalTurn> {
  return applyPreparedClinicalTurn(state.memory, prepareClinicalTurn(state, claims));
}

function lateAdministration(
  currentMemory: PatientClinicalMemory,
  messageId: string,
  body = 'I took the blue pill late.',
): ReturnType<typeof applyPreparedClinicalTurn> {
  return commit(snapshot(currentMemory, messageId, currentMemory.version + 1, body), [
    administrationClaim('late-administration', 'took the blue pill late', {
      medicationText: 'blue pill',
      timeText: 'late',
    }),
  ]);
}

describe('frozen public-boundary semantic review regressions', () => {
  it('does not create a missed administration from negated not-missed wording', () => {
    const body = 'I have not missed alpha.';
    const result = commit(snapshot(memory(), 'message-not-missed', 1, body), [
      administrationClaim('not-missed', 'not missed alpha', {
        polarity: 'negative',
        actionText: 'missed',
      }),
    ]);

    expect(
      result.memory.events.filter(
        ({ current, canonical, kind, adherence }) =>
          current && canonical && kind === 'administration' && adherence === 'missed',
      ),
    ).toEqual([]);
  });

  it('freezes date-compatible dose scope before medication clarification and cannot widen it', () => {
    const medications: PatientClinicalSnapshot['medications'] = [
      { id: 'med-alpha', version: 1, names: ['alpha'], aliases: ['my pill'], active: true },
      { id: 'med-beta', version: 1, names: ['beta'], aliases: ['my pill'], active: true },
    ];
    const doses: PatientClinicalSnapshot['doses'] = [
      {
        id: 'dose-alpha-2026-08-13',
        version: 1,
        medicationId: 'med-alpha',
        label: 'alpha August 13',
        localDate: '2026-08-13',
        localTime: '08:00',
      },
      {
        id: 'dose-beta-2026-08-13',
        version: 1,
        medicationId: 'med-beta',
        label: 'beta August 13',
        localDate: '2026-08-13',
        localTime: '09:00',
      },
      {
        id: 'dose-beta-2026-08-14',
        version: 1,
        medicationId: 'med-beta',
        label: 'beta August 14',
        localDate: '2026-08-14',
        localTime: '09:00',
      },
    ];
    const first = commit(
      snapshot(memory(), 'message-ambiguous-medication', 1, 'I took my pill on 2026-08-13.', {
        medications,
        doses,
      }),
      [
        administrationClaim('ambiguous-medication', 'took my pill on 2026-08-13', {
          medicationText: 'my pill',
          timeText: '2026-08-13',
        }),
      ],
    );
    const frozenNeed = first.memory.needs.find(({ field }) => field === 'medication_identity');
    const answered = commit(
      snapshot(first.memory, 'message-medication-answer', 2, 'It was beta.', {
        medications,
        doses,
      }),
      [needAnswerClaim('medication-answer', 'beta', 'medication_identity')],
    );
    const current = answered.memory.events.find(
      ({ current: isCurrent, kind }) => isCurrent && kind === 'administration',
    );
    const activeDoseCandidates = answered.memory.needs
      .filter(
        ({ field, state }) => field === 'dose_identity' && (state === 'open' || state === 'asked'),
      )
      .flatMap(({ candidateDoseIds }) => candidateDoseIds);

    expect({
      frozenDoseIds: frozenNeed?.candidateDoseIds,
      resolvedDoseId: current?.doseId,
      resolvedLocalDate: current?.localDate,
      activeDoseCandidates,
    }).toEqual({
      frozenDoseIds: ['dose-alpha-2026-08-13', 'dose-beta-2026-08-13'],
      resolvedDoseId: 'dose-beta-2026-08-13',
      resolvedLocalDate: '2026-08-13',
      activeDoseCandidates: [],
    });
  });

  it('does not ground actionText took inside the unrelated word mistook', () => {
    const body = 'I mistook alpha for beta.';
    const result = commit(snapshot(memory(), 'message-mistook', 1, body), [
      administrationClaim('mistook', 'mistook alpha for beta', { actionText: 'took' }),
    ]);

    expect(
      result.prepared.commands.filter(
        (command) =>
          command.kind === 'CreateReport' &&
          command.eventKind === 'administration' &&
          command.adherence === 'taken',
      ),
    ).toEqual([]);
  });

  it('fails closed for conflicting time claims about the same scheduled dose', () => {
    const body = 'I took alpha at 08:15 and took alpha at 09:15.';
    const result = commit(snapshot(memory(), 'message-conflicting-times', 1, body), [
      administrationClaim('time-one', 'took alpha at 08:15', { timeText: '08:15' }),
      administrationClaim('time-two', 'took alpha at 09:15', { timeText: '09:15' }),
    ]);

    expect({
      createsCanonicalReport: result.prepared.commands.some(({ kind }) => kind === 'CreateReport'),
      preservesConflict: result.prepared.commands.some(
        ({ kind }) => kind === 'PreserveUnresolvedContent',
      ),
    }).toEqual({ createsCanonicalReport: false, preservesConflict: true });
  });

  it('identifies the allowlisted scheduled dose in an actual-time question', () => {
    const result = lateAdministration(memory(), 'message-targeted-time-question');
    const responseText = result.prepared.responseText.toLocaleLowerCase('en-US');

    expect({
      responseKind: result.prepared.responsePlan.kind,
      identifiesAllowlistedDose: responseText.includes('alpha morning'),
      leaksPatientPhrase: responseText.includes('blue pill'),
      leaksInternalId: responseText.includes('dose-alpha-morning'),
    }).toEqual({
      responseKind: 'question',
      identifiesAllowlistedDose: true,
      leaksPatientPhrase: false,
      leaksInternalId: false,
    });
  });

  it('fails closed for an arbitrary answer to an actual-time question', () => {
    const target = administrationEvent({ timing: 'late', timeText: 'late' });
    const actualTimeNeed: InformationNeed = {
      id: 'need-actual-time',
      version: 1,
      originInboundMessageId: 'message-ask-actual-time',
      originInboundSequence: 1,
      targetEventId: target.id,
      targetEventVersion: target.version,
      field: 'actual_time',
      candidateMedicationIds: ['med-alpha'],
      candidateDoseIds: ['dose-alpha-morning'],
      candidateSymptomEventIds: [],
      candidateHistoricalEventIds: [],
      questionId: 'question-actual-time',
      clarificationAttemptUsed: true,
      state: 'asked',
      priority: 60,
    };
    const asked = memory({ version: 1, events: [target], needs: [actualTimeNeed] });
    const answered = commit(snapshot(asked, 'message-arbitrary-time-answer', 2, 'Banana.'), [
      needAnswerClaim('arbitrary-time-answer', 'Banana', 'actual_time'),
    ]);
    const current = answered.memory.events.find(
      ({ current: isCurrent, kind }) => isCurrent && kind === 'administration',
    );
    const needState = answered.memory.needs.find(({ id }) => id === actualTimeNeed.id)?.state;

    expect({
      exactTime: current?.exactTime,
      mutatesTarget: answered.prepared.commands.some(({ kind }) => kind === 'RefineReport'),
      leavesNeedActiveOrResolved: ['open', 'asked', 'resolved'].includes(needState ?? ''),
      preservesForReview: answered.prepared.commands.some(
        ({ kind }) => kind === 'PreserveUnresolvedContent',
      ),
    }).toEqual({
      exactTime: undefined,
      mutatesTarget: false,
      leavesNeedActiveOrResolved: false,
      preservesForReview: true,
    });
  });

  it('does not silently duplicate an explicit continuation of a current symptom episode', () => {
    const existing = symptomEvent('event-nausea-current', 'nausea');
    const initial = memory({ version: 1, events: [existing] });
    const result = commit(
      snapshot(initial, 'message-symptom-continuation', 2, 'The nausea is still ongoing.'),
      [
        {
          slot: 'symptom-continuation',
          kind: 'symptom',
          quote: 'nausea is still ongoing',
          ...ELIGIBLE,
          symptomText: 'nausea',
        },
      ],
    );

    expect(
      result.memory.events.filter(
        ({ current, kind, symptomConcept }) =>
          current && kind === 'symptom' && symptomConcept === 'nausea',
      ),
    ).toHaveLength(1);
  });

  it('keeps same-field open needs queued while one unresolved need is already asked', () => {
    const nausea = symptomEvent('event-nausea-question', 'nausea');
    const headache = symptomEvent('event-headache-question', 'headache');
    const askedNeed = severityNeed(nausea, 'asked');
    const queuedNeed = severityNeed(headache, 'open');
    const initial = memory({
      version: 1,
      events: [nausea, headache],
      needs: [askedNeed, queuedNeed],
    });
    const result = commit(snapshot(initial, 'message-social-while-asked', 3, 'Thanks.'), [
      { slot: 'social', kind: 'social', quote: 'Thanks', ...ELIGIBLE },
    ]);

    expect({
      asksAnotherNeed: result.prepared.commands.some(({ kind }) => kind === 'AskInformationNeed'),
      queuedState: result.memory.needs.find(({ id }) => id === queuedNeed.id)?.state,
      existingAskedState: result.memory.needs.find(({ id }) => id === askedNeed.id)?.state,
    }).toEqual({
      asksAnotherNeed: false,
      queuedState: 'open',
      existingAskedState: 'asked',
    });
  });

  it('identifies the exact symptom episode before accepting a severity answer', () => {
    const first = commit(
      snapshot(memory(), 'message-two-symptoms', 1, 'I have nausea and headache.'),
      [
        {
          slot: 'nausea',
          kind: 'symptom',
          quote: 'nausea',
          ...ELIGIBLE,
          symptomText: 'nausea',
        },
        {
          slot: 'headache',
          kind: 'symptom',
          quote: 'headache',
          ...ELIGIBLE,
          symptomText: 'headache',
        },
      ],
    );
    const question = first.prepared.responsePlan.question;
    const askedNeed = first.memory.needs.find(({ id }) => id === question?.needId);
    const target = first.memory.events.find(({ id }) => id === askedNeed?.targetEventId);

    expect({
      field: question?.field,
      targetLabel: question?.targetLabel,
      targetConcept: target?.symptomConcept,
      responseNamesTarget: first.prepared.responseText
        .toLocaleLowerCase('en-US')
        .includes(target?.symptomConcept ?? '__missing__'),
    }).toEqual({
      field: 'severity',
      targetLabel: target?.symptomConcept,
      targetConcept: target?.symptomConcept,
      responseNamesTarget: true,
    });

    const answered = commit(snapshot(first.memory, 'message-severity-answer', 2, '7.'), [
      needAnswerClaim('severity-answer', '7', 'severity'),
    ]);
    const currentTarget = answered.memory.events.find(
      ({ current, supersedesEventId }) => current && supersedesEventId === target?.id,
    );
    const otherCurrent = answered.memory.events.find(
      ({ current, kind, id }) => current && kind === 'symptom' && id !== currentTarget?.id,
    );
    expect({
      targetSeverity: currentTarget?.severity,
      otherSeverity: otherCurrent?.severity,
    }).toEqual({
      targetSeverity: '7',
      otherSeverity: undefined,
    });
  });

  it('never renders a stored symptom concept outside the frozen response allowlist', () => {
    const privateSymptom = symptomEvent('event-private-concept', 'Private value');
    const privateNeed = severityNeed(privateSymptom, 'open');
    const initial = memory({ version: 1, events: [privateSymptom], needs: [privateNeed] });
    const result = commit(
      snapshot(initial, 'message-private-concept-social', 2, 'Thanks.', {
        symptomConcepts: ['nausea'],
      }),
      [{ slot: 'social-private-concept', kind: 'social', quote: 'Thanks', ...ELIGIBLE }],
    );

    expect({
      kind: result.prepared.responsePlan.kind,
      echoedPrivateConcept: result.prepared.responseText.includes('Private value'),
      asked: result.prepared.commands.some(({ kind }) => kind === 'AskInformationNeed'),
    }).toEqual({ kind: 'human_review', echoedPrivateConcept: false, asked: false });
  });

  it('does not ask a different-field question while any prior question remains unanswered', () => {
    const nausea = symptomEvent('event-nausea-asked', 'nausea');
    const headache = symptomEvent('event-headache-queued', 'headache');
    const askedNeed = severityNeed(nausea, 'asked');
    const queuedNeed: InformationNeed = {
      ...severityNeed(headache, 'open'),
      id: 'need-duration-headache',
      field: 'duration',
      questionId: 'question-duration-headache',
    };
    const initial = memory({
      version: 1,
      events: [nausea, headache],
      needs: [askedNeed, queuedNeed],
    });
    const result = commit(snapshot(initial, 'message-social-different-field', 3, 'Thanks.'), [
      { slot: 'social-different-field', kind: 'social', quote: 'Thanks', ...ELIGIBLE },
    ]);

    expect({
      asksAnotherNeed: result.prepared.commands.some(({ kind }) => kind === 'AskInformationNeed'),
      queuedState: result.memory.needs.find(({ id }) => id === queuedNeed.id)?.state,
    }).toEqual({ asksAnotherNeed: false, queuedState: 'open' });
  });

  it('corrects only the explicit time without re-resolving an already-bound dose', () => {
    const accepted = administrationEvent({ exactTime: '08:15', timeText: '08:15' });
    const result = commit(
      snapshot(
        memory({ version: 1, events: [accepted] }),
        'message-time-only-correction',
        2,
        'Correction: alpha was at 09:15.',
        {
          doses: [
            {
              id: 'dose-alpha-morning',
              version: 1,
              medicationId: 'med-alpha',
              label: 'alpha morning',
              localDate: '2026-08-13',
              localTime: '08:00',
            },
            {
              id: 'dose-alpha-evening',
              version: 1,
              medicationId: 'med-alpha',
              label: 'alpha evening',
              localDate: '2026-08-13',
              localTime: '20:00',
            },
          ],
        },
      ),
      [
        {
          slot: 'time-only-correction',
          kind: 'correction',
          quote: 'alpha was at 09:15',
          ...ELIGIBLE,
          targetText: 'alpha',
          timeText: '09:15',
        },
      ],
    );
    const current = result.memory.events.find(
      ({ current: isCurrent, kind }) => isCurrent && kind === 'administration',
    );

    expect({
      operation: current?.operation,
      exactTime: current?.exactTime,
      doseId: current?.doseId,
      unresolved: result.memory.unresolvedReports.length,
    }).toEqual({
      operation: 'correct',
      exactTime: '09:15',
      doseId: 'dose-alpha-morning',
      unresolved: 0,
    });
  });

  it('applies a time-only correction to its exact same-message administration target', () => {
    const body = 'I took alpha at 08:15; correction, at 09:15.';
    const result = commit(snapshot(memory(), 'message-same-turn-time-correction', 1, body), [
      administrationClaim('administration', 'took alpha at 08:15', { timeText: '08:15' }),
      {
        slot: 'time-correction',
        kind: 'correction',
        quote: 'correction, at 09:15',
        ...ELIGIBLE,
        targetClaimSlot: 'administration',
        timeText: '09:15',
      },
    ]);
    const current = result.memory.events.find(
      ({ current: isCurrent, kind }) => isCurrent && kind === 'administration',
    );

    expect({
      operation: current?.operation,
      exactTime: current?.exactTime,
      unresolved: result.memory.unresolvedReports.length,
    }).toEqual({ operation: 'correct', exactTime: '09:15', unresolved: 0 });
  });

  it('does not ask for an actual time that is already explicit in a late report', () => {
    const body = 'I took alpha late at 09:15.';
    const result = commit(snapshot(memory(), 'message-late-with-time', 1, body), [
      administrationClaim('late-with-time', 'took alpha late at 09:15', {
        timeText: 'late at 09:15',
      }),
    ]);
    const current = result.memory.events.find(
      ({ current: isCurrent, kind }) => isCurrent && kind === 'administration',
    );

    expect({
      timing: current?.timing,
      exactTime: current?.exactTime,
      asksActualTime: result.memory.needs.some(
        ({ field, state }) => field === 'actual_time' && (state === 'open' || state === 'asked'),
      ),
    }).toEqual({ timing: 'late', exactTime: '09:15', asksActualTime: false });
  });

  it('corrects adherence without re-resolving or moving the already-bound dose', () => {
    const accepted = administrationEvent();
    const initial = memory({ version: 1, events: [accepted] });
    const result = commit(
      snapshot(initial, 'message-adherence-only-correction', 2, 'Correction: I missed alpha.', {
        doses: [
          {
            id: 'dose-alpha-morning',
            version: 1,
            medicationId: 'med-alpha',
            label: 'alpha morning',
            localDate: '2026-08-13',
            localTime: '08:00',
          },
          {
            id: 'dose-alpha-evening',
            version: 1,
            medicationId: 'med-alpha',
            label: 'alpha evening',
            localDate: '2026-08-13',
            localTime: '20:00',
          },
        ],
      }),
      [
        {
          slot: 'adherence-only-correction',
          kind: 'correction',
          quote: 'missed alpha',
          ...ELIGIBLE,
          targetText: 'alpha',
          actionText: 'missed',
        },
      ],
    );
    const current = result.memory.events.find(
      ({ current: isCurrent, kind }) => isCurrent && kind === 'administration',
    );

    expect({
      operation: current?.operation,
      adherence: current?.adherence,
      doseId: current?.doseId,
      localDate: current?.localDate,
      localTime: current?.localTime,
      unresolved: result.memory.unresolvedReports.length,
    }).toEqual({
      operation: 'correct',
      adherence: 'missed',
      doseId: 'dose-alpha-morning',
      localDate: '2026-08-13',
      localTime: '08:00',
      unresolved: 0,
    });
  });
});
