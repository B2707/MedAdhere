import { describe, expect, it } from 'vitest';
import {
  applyPreparedClinicalTurn,
  needFieldSchema,
  prepareClinicalTurn,
  type ClinicalEvent,
  type ExtractedClaim,
  type InformationNeed,
  type NeedField,
  type PatientClinicalMemory,
  type PatientClinicalSnapshot,
} from './index.js';

const HASH = '0'.repeat(64);
// Compile-time RED: the public need contract cannot yet represent historical event identity.
const EVENT_IDENTITY_FIELD: NeedField = 'event_identity';
const HISTORICAL_CANDIDATE_IDS = ['event-alpha-august-12', 'event-alpha-august-13'] as const;
const HISTORICAL_CANDIDATES = HISTORICAL_CANDIDATE_IDS.map((eventId) => ({
  eventId,
  eventVersion: 1,
}));
const eligible = {
  polarity: 'positive',
  experiencer: 'patient',
  status: 'current',
  certainty: 'certain',
} as const;

const medications: PatientClinicalSnapshot['medications'] = [
  { id: 'med-alpha', version: 1, names: ['alpha'], aliases: [], active: true },
];
const doses: PatientClinicalSnapshot['doses'] = [
  {
    id: 'dose-alpha-august-11',
    version: 1,
    medicationId: 'med-alpha',
    label: 'August 11 alpha dose',
    localDate: '2026-08-11',
    localTime: '08:00',
  },
  {
    id: 'dose-alpha-august-12',
    version: 1,
    medicationId: 'med-alpha',
    label: 'August 12 alpha dose',
    localDate: '2026-08-12',
    localTime: '08:00',
  },
  {
    id: 'dose-alpha-august-13',
    version: 1,
    medicationId: 'med-alpha',
    label: 'August 13 alpha dose',
    localDate: '2026-08-13',
    localTime: '08:00',
  },
];

function emptyMemory(events: readonly ClinicalEvent[] = []): PatientClinicalMemory {
  return {
    patientId: 'patient-historical-clarification',
    version: 4,
    events: [...events],
    needs: [],
    unresolvedReports: [],
    reviewItems: [],
    routineClarificationsPaused: false,
    processedBatches: [],
  };
}

function administrationEvent(id: string, localDate: string): ClinicalEvent {
  const sourceMessageId = `source-${id}`;
  const sourceQuote = `I took alpha on ${localDate}.`;
  return {
    id,
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
    doseId: `dose-alpha-august-${localDate.slice(-2)}`,
    doseVersion: 1,
    adherence: 'taken',
    timing: 'on_time',
    localDate,
    localTime: '08:00',
  };
}

function resolvedSymptomEvent(id: string, bodySite: string): ClinicalEvent {
  const sourceMessageId = `source-${id}`;
  const sourceQuote = `My ${bodySite} nausea resolved.`;
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
      { messageId: sourceMessageId, start: 0, end: sourceQuote.length, quote: sourceQuote },
    ],
    rawSymptom: 'nausea',
    symptomConcept: 'nausea',
    symptomStatus: 'resolved',
    bodySite,
  };
}

function snapshot(
  memory: PatientClinicalMemory,
  id: string,
  sequence: number,
  body: string,
): PatientClinicalSnapshot {
  return {
    memory,
    inboundMessage: { id, sequence, body },
    consentEpoch: 1,
    expectedConsentEpoch: 1,
    medications,
    doses,
    symptomConcepts: ['nausea'],
    languageDisposition: 'english',
    emergencyPrefilter: false,
    contextHash: HASH,
    pipelineVersions: {
      extractor: 'extractor-v1',
      resolver: 'resolver-v1',
      reducer: 'reducer-v1',
      renderer: 'renderer-v1',
    },
  };
}

function commitTurn(
  memory: PatientClinicalMemory,
  id: string,
  sequence: number,
  body: string,
  claims: readonly ExtractedClaim[],
) {
  const prepared = prepareClinicalTurn(snapshot(memory, id, sequence, body), claims);
  return applyPreparedClinicalTurn(memory, prepared);
}

function correctionClaim(): Extract<ExtractedClaim, { kind: 'correction' }> {
  return {
    slot: 'correction',
    kind: 'correction',
    quote: 'alpha was missed',
    ...eligible,
    targetText: 'alpha',
    actionText: 'missed',
  };
}

function eventIdentityAnswer(answerText: string): ExtractedClaim {
  return {
    slot: 'event-identity-answer',
    kind: 'need_answer',
    quote: answerText,
    ...eligible,
    answerField: EVENT_IDENTITY_FIELD,
    answerText,
  };
}

function openCorrectionNeed() {
  const initial = emptyMemory([
    administrationEvent(HISTORICAL_CANDIDATE_IDS[0], '2026-08-12'),
    administrationEvent(HISTORICAL_CANDIDATE_IDS[1], '2026-08-13'),
  ]);
  return commitTurn(initial, 'message-ambiguous-correction', 5, 'Correction: alpha was missed.', [
    correctionClaim(),
  ]);
}

function openRecurrenceNeed() {
  const candidateIds = ['event-nausea-left', 'event-nausea-right'];
  const initial = emptyMemory([
    resolvedSymptomEvent(candidateIds[0]!, 'left arm'),
    resolvedSymptomEvent(candidateIds[1]!, 'right arm'),
  ]);
  return {
    candidateIds,
    opened: commitTurn(initial, 'message-ambiguous-recurrence', 5, 'The nausea came back.', [
      {
        slot: 'recurrence',
        kind: 'recurrence',
        quote: 'nausea came back',
        ...eligible,
        symptomText: 'nausea',
      },
    ]),
  };
}

function requireTargetNeed(memory: PatientClinicalMemory): InformationNeed {
  const need = memory.needs.find(({ field }) => field === EVENT_IDENTITY_FIELD);
  if (need === undefined) throw new Error('expected_event_identity_information_need');
  return need;
}

describe('bounded historical correction clarification', () => {
  it('opens one frozen event-identity need and asks it exactly once', () => {
    expect(needFieldSchema.safeParse(EVENT_IDENTITY_FIELD).success).toBe(true);

    const opened = openCorrectionNeed();
    const openCommands = opened.prepared.commands.filter(
      ({ kind }) => kind === 'OpenInformationNeed',
    );
    const askCommands = opened.prepared.commands.filter(
      ({ kind }) => kind === 'AskInformationNeed',
    );

    expect(openCommands).toEqual([
      expect.objectContaining({
        field: EVENT_IDENTITY_FIELD,
        candidateHistoricalEvents: HISTORICAL_CANDIDATES,
      }),
    ]);
    const need = requireTargetNeed(opened.memory);
    expect(askCommands).toEqual([expect.objectContaining({ needId: need.id })]);
    expect(need).toMatchObject({
      candidateHistoricalEvents: HISTORICAL_CANDIDATES,
      clarificationAttemptUsed: true,
      state: 'asked',
    });

    const later = prepareClinicalTurn(
      snapshot(opened.memory, 'message-before-answer', 6, 'Thanks.'),
      [{ slot: 'social', kind: 'social', quote: 'Thanks', ...eligible }],
    );
    expect(later.commands.filter(({ kind }) => kind === 'OpenInformationNeed')).toEqual([]);
    expect(later.commands.filter(({ kind }) => kind === 'AskInformationNeed')).toEqual([]);
  });

  it('narrows only within the frozen candidates and applies the eligible patient correction', () => {
    const opened = openCorrectionNeed();
    const need = requireTargetNeed(opened.memory);
    const corrected = commitTurn(opened.memory, 'message-correction-target', 6, 'August 12.', [
      eventIdentityAnswer('August 12'),
    ]);

    expect(corrected.prepared.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'CorrectReport',
          targetEventId: HISTORICAL_CANDIDATE_IDS[0],
          adherence: 'missed',
        }),
      ]),
    );
    expect(
      corrected.memory.events.find(
        ({ supersedesEventId }) => supersedesEventId === HISTORICAL_CANDIDATE_IDS[0],
      ),
    ).toMatchObject({ operation: 'correct', adherence: 'missed', current: true });
    expect(corrected.memory.events.find(({ id }) => id === HISTORICAL_CANDIDATE_IDS[1])).toEqual(
      opened.memory.events.find(({ id }) => id === HISTORICAL_CANDIDATE_IDS[1]),
    );
    expect(corrected.memory.needs.find(({ id }) => id === need.id)).toMatchObject({
      state: 'resolved',
      candidateHistoricalEvents: HISTORICAL_CANDIDATES,
    });
  });

  it.each([
    ['still ambiguous', 'alpha', false],
    ['outside the frozen scope', 'August 11', true],
  ])(
    'makes a %s answer terminal and preserves clinician review without changing reports',
    (_label, answerText, addOutOfScopeEvent) => {
      const opened = openCorrectionNeed();
      const need = requireTargetNeed(opened.memory);
      const answerMemory: PatientClinicalMemory = addOutOfScopeEvent
        ? {
            ...opened.memory,
            version: opened.memory.version + 1,
            events: [
              ...opened.memory.events,
              administrationEvent('event-alpha-august-11', '2026-08-11'),
            ],
          }
        : opened.memory;
      const beforeEvents = structuredClone(answerMemory.events);
      const terminal = commitTurn(
        answerMemory,
        `message-terminal-${answerText.replaceAll(' ', '-').toLocaleLowerCase('en-US')}`,
        6,
        `${answerText}.`,
        [eventIdentityAnswer(answerText)],
      );

      expect(terminal.prepared.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'ExpireInformationNeed', needId: need.id }),
          expect.objectContaining({
            kind: 'PreserveUnresolvedContent',
            candidateEventIds: [...HISTORICAL_CANDIDATE_IDS],
          }),
        ]),
      );
      expect(terminal.prepared.commands.filter(({ kind }) => kind === 'CorrectReport')).toEqual([]);
      expect(
        terminal.prepared.commands.filter(({ kind }) => kind === 'AskInformationNeed'),
      ).toEqual([]);
      expect(terminal.memory.events).toEqual(beforeEvents);
      expect(terminal.memory.needs.find(({ id }) => id === need.id)?.state).toBe('expired');
      expect(terminal.memory.unresolvedReports.at(-1)?.candidateEventIds).toEqual([
        ...HISTORICAL_CANDIDATE_IDS,
      ]);
      expect(terminal.memory.reviewItems.at(-1)).toMatchObject({
        kind: 'unresolved_report',
        sourceMessageId: terminal.prepared.sourceMessageId,
        status: 'open',
      });
    },
  );

  it('does not let a delayed answer revive a terminal historical-target need', () => {
    const opened = openCorrectionNeed();
    const need = requireTargetNeed(opened.memory);
    const terminal = commitTurn(opened.memory, 'message-terminal-answer', 6, 'alpha.', [
      eventIdentityAnswer('alpha'),
    ]);
    const beforeEvents = structuredClone(terminal.memory.events);
    const delayed = commitTurn(terminal.memory, 'message-delayed-answer', 7, 'August 12.', [
      eventIdentityAnswer('August 12'),
    ]);

    expect(
      delayed.prepared.commands.filter(
        ({ kind }) =>
          kind === 'CorrectReport' ||
          kind === 'ResolveInformationNeed' ||
          kind === 'OpenInformationNeed' ||
          kind === 'AskInformationNeed',
      ),
    ).toEqual([]);
    expect(delayed.memory.events).toEqual(beforeEvents);
    expect(delayed.memory.needs.find(({ id }) => id === need.id)?.state).toBe('expired');
  });
});

describe('bounded historical recurrence clarification', () => {
  it('uses the same one-attempt scope and records recurrence without superseding either episode', () => {
    const { candidateIds, opened } = openRecurrenceNeed();

    expect(opened.prepared.commands.filter(({ kind }) => kind === 'OpenInformationNeed')).toEqual([
      expect.objectContaining({
        field: EVENT_IDENTITY_FIELD,
        candidateHistoricalEvents: candidateIds.map((eventId) => ({ eventId, eventVersion: 1 })),
      }),
    ]);
    expect(
      opened.prepared.commands.filter(({ kind }) => kind === 'AskInformationNeed'),
    ).toHaveLength(1);
    const need = requireTargetNeed(opened.memory);
    expect(need).toMatchObject({
      clarificationAttemptUsed: true,
      state: 'asked',
      candidateHistoricalEvents: candidateIds.map((eventId) => ({ eventId, eventVersion: 1 })),
    });

    const candidatesBefore = structuredClone(
      opened.memory.events.filter(({ id }) => candidateIds.includes(id)),
    );
    const answered = commitTurn(opened.memory, 'message-recurrence-target', 6, 'left arm.', [
      eventIdentityAnswer('left arm'),
    ]);

    expect(answered.prepared.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'RecordRecurrence',
          targetEventId: candidateIds[0],
        }),
      ]),
    );
    expect(answered.memory.events.filter(({ id }) => candidateIds.includes(id))).toEqual(
      candidatesBefore,
    );
    const recurrence = answered.memory.events.find(
      ({ recurrenceOfEventId }) => recurrenceOfEventId === candidateIds[0],
    );
    expect(recurrence).toMatchObject({ operation: 'recur', current: true });
    expect(recurrence).not.toHaveProperty('supersedesEventId');
    expect(answered.memory.needs.find(({ id }) => id === need.id)?.state).toBe('resolved');
  });

  it.each([
    ['still ambiguous', 'nausea', false],
    ['outside the frozen scope', 'left leg', true],
  ])(
    'makes a %s recurrence answer terminal without mutating either episode',
    (_label, answerText, addOutOfScopeEvent) => {
      const { candidateIds, opened } = openRecurrenceNeed();
      const need = requireTargetNeed(opened.memory);
      const answerMemory: PatientClinicalMemory = addOutOfScopeEvent
        ? {
            ...opened.memory,
            version: opened.memory.version + 1,
            events: [
              ...opened.memory.events,
              resolvedSymptomEvent('event-nausea-left-leg', 'left leg'),
            ],
          }
        : opened.memory;
      const beforeEvents = structuredClone(answerMemory.events);
      const terminal = commitTurn(
        answerMemory,
        `message-terminal-recurrence-${answerText.replaceAll(' ', '-')}`,
        6,
        `${answerText}.`,
        [eventIdentityAnswer(answerText)],
      );

      expect(terminal.prepared.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'ExpireInformationNeed', needId: need.id }),
          expect.objectContaining({
            kind: 'PreserveUnresolvedContent',
            candidateEventIds: candidateIds,
          }),
        ]),
      );
      expect(terminal.prepared.commands.filter(({ kind }) => kind === 'RecordRecurrence')).toEqual(
        [],
      );
      expect(
        terminal.prepared.commands.filter(({ kind }) => kind === 'AskInformationNeed'),
      ).toEqual([]);
      expect(terminal.memory.events).toEqual(beforeEvents);
      expect(terminal.memory.needs.find(({ id }) => id === need.id)?.state).toBe('expired');
      expect(terminal.memory.reviewItems.at(-1)).toMatchObject({
        kind: 'unresolved_report',
        status: 'open',
      });
    },
  );

  it('does not let a delayed answer revive a terminal recurrence-target need', () => {
    const { opened } = openRecurrenceNeed();
    const need = requireTargetNeed(opened.memory);
    const terminal = commitTurn(opened.memory, 'message-terminal-recurrence', 6, 'nausea.', [
      eventIdentityAnswer('nausea'),
    ]);
    const beforeEvents = structuredClone(terminal.memory.events);
    const delayed = commitTurn(terminal.memory, 'message-delayed-recurrence', 7, 'left arm.', [
      eventIdentityAnswer('left arm'),
    ]);

    expect(
      delayed.prepared.commands.filter(
        ({ kind }) =>
          kind === 'RecordRecurrence' ||
          kind === 'ResolveInformationNeed' ||
          kind === 'OpenInformationNeed' ||
          kind === 'AskInformationNeed',
      ),
    ).toEqual([]);
    expect(delayed.memory.events).toEqual(beforeEvents);
    expect(delayed.memory.needs.find(({ id }) => id === need.id)?.state).toBe('expired');
  });
});
