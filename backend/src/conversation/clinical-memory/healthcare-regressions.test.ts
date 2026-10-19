import { describe, expect, it } from 'vitest';
import {
  prepareClinicalTurn,
  syntheticPromptedConfirmationClaims,
  reducePatientClinicalMemory,
  type ClinicalClaimInput,
  type ClinicalEvent,
  type ClinicalIntentCommand,
  type PatientClinicalMemory,
  type PatientClinicalSnapshot,
} from './index.js';

const HASH = '0'.repeat(64);
const eligible = {
  polarity: 'positive',
  experiencer: 'patient',
  status: 'current',
  certainty: 'certain',
} as const;

function emptyMemory(overrides: Partial<PatientClinicalMemory> = {}): PatientClinicalMemory {
  return {
    patientId: 'patient-healthcare-regressions',
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
  body: string,
  overrides: Partial<PatientClinicalSnapshot> = {},
): PatientClinicalSnapshot {
  return {
    memory: emptyMemory(),
    inboundMessage: { id: 'message-current', sequence: 2, body },
    consentEpoch: 1,
    expectedConsentEpoch: 1,
    medications: [{ id: 'med-alpha', version: 1, names: ['alpha'], aliases: [], active: true }],
    doses: [
      {
        id: 'dose-alpha-morning',
        version: 1,
        medicationId: 'med-alpha',
        label: 'morning dose',
        localDate: '2026-08-13',
        localTime: '08:00',
      },
      {
        id: 'dose-alpha-evening',
        version: 1,
        medicationId: 'med-alpha',
        label: 'evening dose',
        localDate: '2026-08-13',
        localTime: '20:00',
      },
    ],
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
    ...overrides,
  };
}

function sourceSpan(messageId: string, quote: string) {
  return { messageId, start: 0, end: quote.length, quote };
}

function resolvedSymptom(overrides: Partial<ClinicalEvent> = {}): ClinicalEvent {
  const quote = 'Severe nausea lasted three days in my left arm.';
  return {
    id: 'event-resolved-nausea',
    version: 1,
    kind: 'symptom',
    operation: 'create',
    authoredBy: 'patient',
    reviewState: 'unreviewed',
    current: true,
    canonical: true,
    sourceMessageIds: ['message-prior'],
    sourceSpans: [sourceSpan('message-prior', quote)],
    rawSymptom: 'nausea',
    symptomConcept: 'nausea',
    symptomStatus: 'resolved',
    severity: 'severe',
    duration: 'three days',
    bodySite: 'left arm',
    frequency: 'constant',
    ...overrides,
  };
}

function currentSymptom(): ClinicalEvent {
  return {
    ...resolvedSymptom({
      id: 'event-current-nausea',
      symptomStatus: 'current',
      severity: undefined,
      duration: undefined,
      frequency: undefined,
    }),
  };
}

function run(state: PatientClinicalSnapshot, claims: readonly ClinicalClaimInput[]) {
  const prepared = prepareClinicalTurn(state, claims);
  const memory = reducePatientClinicalMemory(state.memory, prepared.commands).memory;
  return { prepared, memory };
}

describe('recurrence healthcare regressions', () => {
  it.each([
    [
      'uncertain',
      'Maybe the nausea returned.',
      'nausea returned',
      { certainty: 'uncertain' as const },
    ],
    [
      'third-person',
      "My sister's nausea returned.",
      'nausea returned',
      { experiencer: 'other' as const },
    ],
    [
      'hypothetical',
      'What if the nausea returned?',
      'nausea returned',
      { status: 'hypothetical' as const },
    ],
    ['future', 'The nausea will return.', 'nausea will return', { status: 'future' as const }],
  ])('keeps %s recurrence wording noncanonical', (_label, body, quote, override) => {
    const prior = resolvedSymptom();
    const state = snapshot(body, {
      memory: emptyMemory({ version: 1, events: [prior] }),
    });
    const { prepared, memory } = run(state, [
      {
        slot: 'recurrence',
        kind: 'recurrence',
        quote,
        ...eligible,
        ...override,
        symptomText: 'nausea',
      },
    ]);

    expect(prepared.commands.filter(({ kind }) => kind === 'RecordRecurrence')).toEqual([]);
    expect(memory.events).toEqual([prior]);
    expect(memory.unresolvedReports).toEqual([
      expect.objectContaining({
        reason: 'recurrence_ineligible',
        sourceMessageId: state.inboundMessage.id,
      }),
    ]);
  });

  it('starts a recurrence with only current-message detail and provenance', () => {
    const prior = resolvedSymptom();
    const body = 'The nausea returned.';
    const quote = 'nausea returned';
    const state = snapshot(body, {
      memory: emptyMemory({ version: 1, events: [prior] }),
    });
    const { memory } = run(state, [
      {
        slot: 'recurrence',
        kind: 'recurrence',
        quote,
        ...eligible,
        symptomText: 'nausea',
      },
    ]);
    const recurrence = memory.events.find(
      ({ recurrenceOfEventId }) => recurrenceOfEventId === prior.id,
    );

    expect(recurrence).toMatchObject({
      operation: 'recur',
      symptomConcept: 'nausea',
      symptomStatus: 'current',
      sourceMessageIds: [state.inboundMessage.id],
      sourceSpans: [
        {
          messageId: state.inboundMessage.id,
          start: body.indexOf(quote),
          end: body.indexOf(quote) + quote.length,
          quote,
        },
      ],
    });
    expect(recurrence).not.toHaveProperty('severity');
    expect(recurrence).not.toHaveProperty('duration');
    expect(recurrence).not.toHaveProperty('bodySite');
    expect(recurrence).not.toHaveProperty('frequency');
    expect(memory.events.find(({ id }) => id === prior.id)).toEqual(prior);
  });

  it('uses an explicit prior numeric severity only after the recurrence asks and the patient says same as before', () => {
    const prior = resolvedSymptom({ severity: '2' });
    const recurrenceTurn = snapshot('The nausea returned.', {
      memory: emptyMemory({ version: 1, events: [prior] }),
    });
    const opened = run(recurrenceTurn, [
      {
        slot: 'recurrence',
        kind: 'recurrence',
        quote: 'nausea returned',
        ...eligible,
        symptomText: 'nausea',
      },
    ]);
    const recurrence = opened.memory.events.find(
      ({ recurrenceOfEventId }) => recurrenceOfEventId === prior.id,
    )!;
    const need = opened.memory.needs.find(
      ({ field, targetEventId, state }) =>
        field === 'severity' && targetEventId === recurrence.id && state === 'asked',
    )!;

    expect(recurrence).not.toHaveProperty('severity');
    const answerTurn = snapshot('Same as before.', {
      memory: opened.memory,
      inboundMessage: { id: 'message-same-severity', sequence: 3, body: 'Same as before.' },
    });
    const answered = run(answerTurn, [
      {
        claim: {
          slot: 'same-severity',
          kind: 'need_answer',
          quote: 'Same as before.',
          ...eligible,
          answerField: 'severity',
          answerText: 'Same as before.',
        },
        informationNeedId: need.id,
      },
    ]);

    expect(
      answered.memory.events.find(({ supersedesEventId }) => supersedesEventId === recurrence.id),
    ).toMatchObject({
      operation: 'refine',
      supersedesEventId: recurrence.id,
      recurrenceOfEventId: prior.id,
      severity: '2',
    });
  });

  it('fails closed when same as before has no prior numeric severity', () => {
    const prior = resolvedSymptom();
    const unrelated = resolvedSymptom({
      id: 'event-unrelated-headache',
      rawSymptom: 'headache',
      symptomConcept: 'headache',
      severity: '9',
    });
    const opened = run(
      snapshot('The nausea returned.', {
        memory: emptyMemory({ version: 2, events: [prior, unrelated] }),
      }),
      [
        {
          slot: 'recurrence',
          kind: 'recurrence',
          quote: 'nausea returned',
          ...eligible,
          symptomText: 'nausea',
        },
      ],
    );
    const recurrence = opened.memory.events.find(
      ({ recurrenceOfEventId }) => recurrenceOfEventId === prior.id,
    )!;
    const need = opened.memory.needs.find(
      ({ field, targetEventId }) => field === 'severity' && targetEventId === recurrence.id,
    )!;
    const answerTurn = snapshot('Same as before.', {
      memory: opened.memory,
      inboundMessage: {
        id: 'message-invalid-prior-severity',
        sequence: 3,
        body: 'Same as before.',
      },
    });
    const answered = run(answerTurn, [
      {
        claim: {
          slot: 'same-severity',
          kind: 'need_answer',
          quote: 'Same as before.',
          ...eligible,
          answerField: 'severity',
          answerText: 'Same as before.',
        },
        informationNeedId: need.id,
      },
    ]);

    expect(answered.memory.events.find(({ id }) => id === recurrence.id)).toEqual(recurrence);
    expect(answered.memory.unresolvedReports.at(-1)).toMatchObject({
      reason: 'severity_unresolved',
    });
  });
});

it('keeps routine clarification paused while any safety review remains open', () => {
  const state = emptyMemory({
    version: 3,
    routineClarificationsPaused: true,
    reviewItems: [
      {
        id: 'review-confirmed-safety',
        kind: 'safety',
        sourceMessageId: 'message-emergency-1',
        reason: 'first emergency',
        status: 'confirmed',
      },
      {
        id: 'review-open-safety',
        kind: 'safety',
        sourceMessageId: 'message-emergency-2',
        reason: 'second emergency',
        status: 'open',
      },
    ],
  });
  const command: ClinicalIntentCommand = {
    id: 'command-resume-routine-clarification',
    kind: 'ResumeRoutineClarification',
    sourceMessageId: 'message-clinician-review',
    sourceSpans: [],
    reviewItemId: 'review-confirmed-safety',
  };
  const before = structuredClone(state);

  expect(() => reducePatientClinicalMemory(state, [command])).toThrow('safety_review_not_closed');
  expect(state).toEqual(before);
});

it('resumes routine clarification after all safety reviews are closed', () => {
  const state = emptyMemory({
    version: 3,
    routineClarificationsPaused: true,
    reviewItems: [
      {
        id: 'review-confirmed-safety',
        kind: 'safety',
        sourceMessageId: 'message-emergency',
        reason: 'reviewed emergency',
        status: 'confirmed',
      },
    ],
  });
  const command: ClinicalIntentCommand = {
    id: 'command-resume-after-all-safety-closed',
    kind: 'ResumeRoutineClarification',
    sourceMessageId: 'message-clinician-review',
    sourceSpans: [],
    reviewItemId: 'review-confirmed-safety',
  };

  expect(reducePatientClinicalMemory(state, [command]).memory.routineClarificationsPaused).toBe(
    false,
  );
});

it('lets explicit dose text outrank the compatible prompted dose', () => {
  const body = 'I took alpha evening dose.';
  const state = snapshot(body, { promptedDoseId: 'dose-alpha-morning' });
  const { memory } = run(state, [
    {
      slot: 'administration',
      kind: 'administration',
      quote: 'took alpha evening dose',
      ...eligible,
      medicationText: 'alpha',
      doseText: 'evening dose',
      actionText: 'took',
    },
  ]);

  expect(memory.events.filter(({ current }) => current)).toEqual([
    expect.objectContaining({
      kind: 'administration',
      medicationId: 'med-alpha',
      doseId: 'dose-alpha-evening',
      adherence: 'taken',
    }),
  ]);
});

describe('symptom status detail healthcare regressions', () => {
  it.each([
    [
      'ongoing',
      'The nausea is still ongoing.',
      'nausea is still ongoing',
      'current',
      'still ongoing',
    ],
    ['resolved', 'The nausea has resolved.', 'nausea has resolved', 'resolved', 'resolved'],
  ] as const)(
    'maps an explicit %s status detail without conflating it with the opposite state',
    (_label, body, quote, status, detailText) => {
      const prior = currentSymptom();
      const state = snapshot(body, {
        memory: emptyMemory({ version: 1, events: [prior] }),
      });
      const { memory } = run(state, [
        {
          slot: 'status-detail',
          kind: 'symptom_detail',
          quote,
          ...eligible,
          status,
          targetText: 'nausea',
          detailField: 'status',
          detailText,
        },
      ]);

      expect(memory.events.find(({ current }) => current)?.symptomStatus).toBe(status);
    },
  );

  it.each([
    ['hypothetical', 'If the nausea resolved, I would rest.', 'nausea resolved', 'resolved'],
    ['future', 'The nausea will resolve tomorrow.', 'nausea will resolve', 'will resolve'],
  ] as const)('keeps %s symptom status detail noncanonical', (status, body, quote, detailText) => {
    const prior = currentSymptom();
    const state = snapshot(body, {
      memory: emptyMemory({ version: 1, events: [prior] }),
    });
    const { prepared, memory } = run(state, [
      {
        slot: 'status-detail',
        kind: 'symptom_detail',
        quote,
        ...eligible,
        status,
        targetText: 'nausea',
        detailField: 'status',
        detailText,
      },
    ]);

    expect(prepared.commands.filter(({ kind }) => kind === 'RefineReport')).toEqual([]);
    expect(memory.events).toEqual([prior]);
    expect(memory.unresolvedReports).toEqual([
      expect.objectContaining({ reason: 'symptom_detail_ineligible' }),
    ]);
  });
});

describe('information-need lineage healthcare regressions', () => {
  it('does not discover missing needs on an unrelated prior event', () => {
    const prior = currentSymptom();
    const state = snapshot('Thanks.', {
      memory: emptyMemory({ version: 1, events: [prior] }),
    });
    const { prepared, memory } = run(state, [
      {
        slot: 'social',
        kind: 'social',
        quote: 'Thanks',
        ...eligible,
      },
    ]);

    expect(
      prepared.commands.filter(
        ({ kind }) => kind === 'OpenInformationNeed' || kind === 'AskInformationNeed',
      ),
    ).toEqual([]);
    expect(memory.needs).toEqual([]);
  });

  it('does not ask for an actual time for a missed dose described as late', () => {
    const body = 'I missed alpha morning dose because I was late.';
    const state = snapshot(body);
    const { prepared, memory } = run(state, [
      {
        slot: 'missed-administration',
        kind: 'administration',
        quote: 'missed alpha morning dose because I was late',
        ...eligible,
        medicationText: 'alpha',
        doseText: 'morning dose',
        timeText: 'late',
        actionText: 'missed',
      },
    ]);

    expect(memory.needs.filter(({ field }) => field === 'actual_time')).toEqual([]);
    expect(prepared.responsePlan.question?.field).not.toBe('actual_time');
  });

  it('ties a historical symptom severity question to the newly reported episode', () => {
    const body = 'I had nausea yesterday.';
    const state = snapshot(body);
    const { prepared, memory } = run(state, [
      {
        slot: 'historical-symptom',
        kind: 'symptom',
        quote: 'nausea yesterday',
        ...eligible,
        status: 'historical',
        symptomText: 'nausea',
        timeText: 'yesterday',
      },
    ]);

    const historical = memory.events.find(
      ({ kind, symptomStatus }) => kind === 'symptom' && symptomStatus === 'historical',
    );
    expect(historical).toBeDefined();
    expect(memory.needs.filter(({ field }) => field === 'severity')).toEqual([
      expect.objectContaining({
        targetEventId: historical?.id,
        originInboundMessageId: state.inboundMessage.id,
        originInboundSequence: state.inboundMessage.sequence,
      }),
    ]);
    expect(prepared.responsePlan.question).toMatchObject({
      field: 'severity',
      eventId: historical?.id,
    });
  });
});

describe('prompted check-in bare confirmation (2026-08-14 live-demo regression)', () => {
  it('synthesizes and resolves a bare "No" into a missed administration bound to the prompted dose', () => {
    const state = snapshot('No', { promptedDoseId: 'dose-alpha-morning' });
    const synthetic = syntheticPromptedConfirmationClaims(state);
    expect(synthetic).not.toBeNull();
    const { memory } = run(state, synthetic ?? []);
    expect(memory.events.filter(({ current }) => current)).toEqual([
      expect.objectContaining({
        kind: 'administration',
        medicationId: 'med-alpha',
        doseId: 'dose-alpha-morning',
        adherence: 'missed',
      }),
    ]);
  });

  it('synthesizes and resolves a bare "Yes" into a taken administration bound to the prompted dose', () => {
    const state = snapshot('Yes', { promptedDoseId: 'dose-alpha-morning' });
    const synthetic = syntheticPromptedConfirmationClaims(state);
    expect(synthetic).not.toBeNull();
    const { memory } = run(state, synthetic ?? []);
    expect(memory.events.filter(({ current }) => current)).toEqual([
      expect.objectContaining({
        kind: 'administration',
        medicationId: 'med-alpha',
        doseId: 'dose-alpha-morning',
        adherence: 'taken',
      }),
    ]);
  });

  it('returns null for anything richer than a bare confirmation and for unprompted messages', () => {
    expect(
      syntheticPromptedConfirmationClaims(
        snapshot('No, but my head hurts', { promptedDoseId: 'dose-alpha-morning' }),
      ),
    ).toBeNull();
    expect(syntheticPromptedConfirmationClaims(snapshot('No'))).toBeNull();
  });
});
