import { describe, expect, it } from 'vitest';

import {
  applyPreparedClinicalTurn,
  patientClinicalMemorySchema,
  prepareClinicalTurn,
  reducePatientClinicalMemory,
  type ClinicalEvent,
  type ClinicalIntentCommand,
  type ExtractedClaim,
  type InformationNeed,
  type PatientClinicalMemory,
  type PatientClinicalSnapshot,
  type SourceSpan,
} from './index.js';

const HASH = '0'.repeat(64);
const ELIGIBLE = {
  polarity: 'positive',
  experiencer: 'patient',
  status: 'current',
  certainty: 'certain',
} as const;

function memory(
  events: readonly ClinicalEvent[] = [],
  needs: readonly InformationNeed[] = [],
): PatientClinicalMemory {
  return {
    patientId: 'patient-residual-core',
    version: events.length + needs.length,
    events: [...events],
    needs: [...needs],
    unresolvedReports: [],
    reviewItems: [],
    routineClarificationsPaused: false,
    processedBatches: [],
  };
}

function symptom(id: string, overrides: Partial<ClinicalEvent> = {}): ClinicalEvent {
  const sourceMessageId = `source-${id}`;
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
    sourceSpans: [sourceSpan(sourceMessageId, 'nausea')],
    rawSymptom: 'nausea',
    symptomConcept: 'nausea',
    symptomStatus: 'current',
    bodySite: 'left arm',
    ...overrides,
  };
}

function pendingAdministration(id: string, medicationId: string): ClinicalEvent {
  const sourceMessageId = `source-${id}`;
  return {
    id,
    version: 1,
    kind: 'administration',
    operation: 'create',
    authoredBy: 'patient',
    reviewState: 'unreviewed',
    current: true,
    canonical: false,
    sourceMessageIds: [sourceMessageId],
    sourceSpans: [sourceSpan(sourceMessageId, 'I took it.')],
    medicationId,
    medicationVersion: 1,
    adherence: 'taken',
  };
}

function doseNeed(target: ClinicalEvent, doseId: string): InformationNeed {
  return {
    id: `need-${target.id}`,
    version: 2,
    originInboundMessageId: target.sourceMessageIds[0]!,
    originInboundSequence: 1,
    targetEventId: target.id,
    targetEventVersion: target.version,
    field: 'dose_identity',
    candidateMedicationIds: [target.medicationId!],
    candidateDoseIds: [doseId],
    candidateSymptomEventIds: [],
    candidateHistoricalEventIds: [],
    questionId: `question-${target.id}`,
    clarificationAttemptUsed: true,
    state: 'asked',
    priority: 90,
  };
}

function snapshot(
  currentMemory: PatientClinicalMemory,
  messageId: string,
  body: string,
  overrides: Partial<PatientClinicalSnapshot> = {},
): PatientClinicalSnapshot {
  return {
    memory: currentMemory,
    inboundMessage: { id: messageId, sequence: currentMemory.version + 1, body },
    consentEpoch: 1,
    expectedConsentEpoch: 1,
    medications: [
      { id: 'med-alpha', version: 1, names: ['alpha'], aliases: [], active: true },
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
        id: 'dose-beta-evening',
        version: 1,
        medicationId: 'med-beta',
        label: 'beta evening',
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

function commit(
  currentMemory: PatientClinicalMemory,
  messageId: string,
  body: string,
  claims: readonly ExtractedClaim[],
  overrides: Partial<PatientClinicalSnapshot> = {},
) {
  const prepared = prepareClinicalTurn(snapshot(currentMemory, messageId, body, overrides), claims);
  return applyPreparedClinicalTurn(currentMemory, prepared);
}

function sourceSpan(messageId: string, quote: string): SourceSpan {
  return { messageId, start: 0, end: quote.length, quote };
}

describe('residual symptom boundaries', () => {
  it('does not apply historical symptom detail to a current episode', () => {
    const current = symptom('event-current-nausea');
    const result = commit(
      memory([current]),
      'message-historical-detail',
      'Yesterday, nausea was severe.',
      [
        {
          slot: 'historical-detail',
          kind: 'symptom_detail',
          quote: 'nausea was severe',
          ...ELIGIBLE,
          status: 'historical',
          targetText: 'nausea',
          detailField: 'severity',
          detailText: 'severe',
        },
      ],
    );

    expect(
      result.prepared.commands.filter(
        ({ kind }) => kind === 'RefineReport' || kind === 'CorrectReport',
      ),
    ).toEqual([]);
    expect(result.memory.events).toEqual([current]);
  });

  it('does not resolve an episode when the explicit body site does not match', () => {
    const current = symptom('event-left-arm-nausea');
    const result = commit(
      memory([current]),
      'message-mismatched-site-resolution',
      'The nausea in my right arm resolved.',
      [
        {
          slot: 'resolution',
          kind: 'symptom',
          quote: 'nausea in my right arm resolved',
          ...ELIGIBLE,
          status: 'resolved',
          symptomText: 'nausea',
          bodySiteText: 'right arm',
        },
      ],
    );

    expect(
      result.prepared.commands.filter(
        ({ kind }) => kind === 'RefineReport' || kind === 'RecordContradiction',
      ),
    ).toEqual([]);
    expect(result.memory.events).toEqual([current]);
  });

  it('rejects RecordRecurrence when the target episode is still unresolved', () => {
    const current = symptom('event-unresolved-nausea');
    const currentMemory = memory([current]);
    const quote = 'The nausea came back.';
    const command: ClinicalIntentCommand = {
      id: 'command-recur-unresolved',
      kind: 'RecordRecurrence',
      sourceMessageId: 'message-recur-unresolved',
      sourceSpans: [sourceSpan('message-recur-unresolved', quote)],
      targetEventId: current.id,
      targetEventVersion: current.version,
      rawSymptom: 'nausea',
    };

    expect(() => reducePatientClinicalMemory(currentMemory, [command])).toThrow();
  });

  it('creates an unknown-symptom correction successor and asks for its identity', () => {
    const current = symptom('event-known-symptom');
    const result = commit(
      memory([current]),
      'message-unknown-symptom-correction',
      'Correction: it was buzzing, not nausea.',
      [
        {
          slot: 'correction',
          kind: 'correction',
          quote: 'it was buzzing, not nausea',
          ...ELIGIBLE,
          symptomText: 'buzzing',
          targetText: 'nausea',
        },
      ],
    );
    const successor = result.memory.events.find(
      ({ supersedesEventId }) => supersedesEventId === current.id,
    );

    expect(successor).toMatchObject({
      operation: 'correct',
      rawSymptom: 'buzzing',
      symptomConcept: null,
      current: true,
    });
    expect(result.memory.needs).toContainEqual(
      expect.objectContaining({
        targetEventId: successor?.id,
        targetEventVersion: successor?.version,
        field: 'symptom_identity',
        state: 'asked',
      }),
    );
  });
});

describe('residual information-need boundaries', () => {
  it('does not reopen an information need that a successor already satisfies', () => {
    const target = symptom('event-unknown-symptom', {
      rawSymptom: 'queasy',
      symptomConcept: null,
    });
    const need: InformationNeed = {
      id: 'need-unknown-symptom-identity',
      version: 1,
      originInboundMessageId: target.sourceMessageIds[0]!,
      originInboundSequence: 1,
      targetEventId: target.id,
      targetEventVersion: target.version,
      field: 'symptom_identity',
      candidateMedicationIds: [],
      candidateDoseIds: [],
      candidateSymptomEventIds: [target.id],
      candidateHistoricalEventIds: [],
      questionId: 'question-unknown-symptom-identity',
      clarificationAttemptUsed: false,
      state: 'open',
      priority: 80,
    };
    const result = reducePatientClinicalMemory(memory([target], [need]), [
      {
        id: 'command-identify-symptom',
        kind: 'RefineReport',
        sourceMessageId: 'message-identify-symptom',
        sourceSpans: [sourceSpan('message-identify-symptom', 'It was nausea.')],
        targetEventId: target.id,
        targetEventVersion: target.version,
        targetKind: 'symptom',
        rawSymptom: 'nausea',
        symptomConcept: 'nausea',
      },
    ]);

    expect(result.memory.needs.find(({ id }) => id === need.id)?.state).toBe('superseded');
    expect(
      result.memory.needs.filter(
        ({ field, state }) =>
          field === 'symptom_identity' && (state === 'open' || state === 'asked'),
      ),
    ).toEqual([]);
  });

  it('terminally rejects severity answers outside the asked 1-10 range', () => {
    const target = symptom('event-severity-question');
    const need: InformationNeed = {
      id: 'need-severity-question',
      version: 2,
      originInboundMessageId: target.sourceMessageIds[0]!,
      originInboundSequence: 1,
      targetEventId: target.id,
      targetEventVersion: target.version,
      field: 'severity',
      candidateMedicationIds: [],
      candidateDoseIds: [],
      candidateSymptomEventIds: [target.id],
      candidateHistoricalEventIds: [],
      questionId: 'question-severity-question',
      clarificationAttemptUsed: true,
      state: 'asked',
      priority: 70,
    };
    const result = commit(memory([target], [need]), 'message-severity-99', '99', [
      {
        slot: 'severity-answer',
        kind: 'need_answer',
        quote: '99',
        ...ELIGIBLE,
        answerField: 'severity',
        answerText: '99',
      },
    ]);

    expect(result.memory.events).toEqual([target]);
    expect(result.memory.needs.find(({ id }) => id === need.id)?.state).toBe('superseded');
    expect(result.memory.unresolvedReports).toContainEqual(
      expect.objectContaining({ reason: 'severity_unresolved' }),
    );
  });

  it.each([
    ['open', false],
    ['asked', true],
  ] as const)('rejects a %s routine need on a clinician-confirmed event', (state, attempted) => {
    const target = symptom('event-clinician-symptom', {
      authoredBy: 'clinician',
      reviewState: 'confirmed',
    });
    const need: InformationNeed = {
      id: `need-clinician-${state}`,
      version: 1,
      originInboundMessageId: 'message-clinician-symptom',
      originInboundSequence: 1,
      targetEventId: target.id,
      targetEventVersion: target.version,
      field: 'severity',
      candidateMedicationIds: [],
      candidateDoseIds: [],
      candidateSymptomEventIds: [target.id],
      candidateHistoricalEventIds: [],
      questionId: `question-clinician-${state}`,
      clarificationAttemptUsed: attempted,
      state,
      priority: 70,
    };

    expect(patientClinicalMemorySchema.safeParse(memory([target], [need])).success).toBe(false);
  });

  it('uses the only asked same-field need whose frozen scope matches the answer', () => {
    const alpha = pendingAdministration('event-alpha-pending', 'med-alpha');
    const beta = pendingAdministration('event-beta-pending', 'med-beta');
    const alphaNeed = doseNeed(alpha, 'dose-alpha-morning');
    const betaNeed = doseNeed(beta, 'dose-beta-evening');
    const initial = memory([alpha, beta], [alphaNeed, betaNeed]);
    const result = commit(initial, 'message-dose-answer', 'alpha morning', [
      {
        slot: 'dose-answer',
        kind: 'need_answer',
        quote: 'alpha morning',
        ...ELIGIBLE,
        answerField: 'dose_identity',
        answerText: 'alpha morning',
      },
    ]);
    const reversed = commit(
      memory([alpha, beta], [betaNeed, alphaNeed]),
      'message-dose-answer',
      'alpha morning',
      [
        {
          slot: 'dose-answer',
          kind: 'need_answer',
          quote: 'alpha morning',
          ...ELIGIBLE,
          answerField: 'dose_identity',
          answerText: 'alpha morning',
        },
      ],
    );

    expect(result.prepared.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'ResolveInformationNeed', needId: alphaNeed.id }),
        expect.objectContaining({ kind: 'RefineReport', targetEventId: alpha.id }),
      ]),
    );
    expect(
      result.prepared.commands.filter(({ kind }) => kind === 'PreserveUnresolvedContent'),
    ).toEqual([]);
    expect(result.memory.needs.find(({ id }) => id === alphaNeed.id)?.state).toBe('resolved');
    expect(result.memory.needs.find(({ id }) => id === betaNeed.id)?.state).toBe('asked');
    expect(
      result.memory.events.find(({ supersedesEventId }) => supersedesEventId === alpha.id),
    ).toMatchObject({ doseId: 'dose-alpha-morning', canonical: true });
    expect(result.memory.events.find(({ id }) => id === beta.id)).toEqual(beta);
    expect(reversed.prepared).toEqual(result.prepared);
    expect(reversed.memory.needs.find(({ id }) => id === alphaNeed.id)?.state).toBe('resolved');
    expect(reversed.memory.needs.find(({ id }) => id === betaNeed.id)?.state).toBe('asked');
  });
});

it('does not bind a prompted dose whose date conflicts with an explicit historical date', () => {
  const initial = memory();
  const promptedDose: PatientClinicalSnapshot['doses'][number] = {
    id: 'dose-alpha-current',
    version: 1,
    medicationId: 'med-alpha',
    label: 'alpha current dose',
    localDate: '2026-08-13',
    localTime: '08:00',
  };
  const result = commit(
    initial,
    'message-explicit-historical-date',
    'I took alpha on 2026-08-12.',
    [
      {
        slot: 'dated-administration',
        kind: 'administration',
        quote: 'took alpha on 2026-08-12',
        ...ELIGIBLE,
        medicationText: 'alpha',
        timeText: '2026-08-12',
        actionText: 'took',
      },
    ],
    { promptedDoseId: promptedDose.id, doses: [promptedDose] },
  );

  expect(
    result.prepared.commands.filter(
      (command) => command.kind === 'CreateReport' && command.doseId === promptedDose.id,
    ),
  ).toEqual([]);
  expect(result.memory.events).toEqual([]);
});
