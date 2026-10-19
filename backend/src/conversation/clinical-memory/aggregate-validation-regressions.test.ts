import { describe, expect, it } from 'vitest';

import {
  clinicalIntentCommandSchema,
  informationNeedSchema,
  patientClinicalMemorySchema,
  prepareClinicalTurn,
  reducePatientClinicalMemory,
  validatedClaimSchema,
  type ClinicalEvent,
  type ClinicalIntentCommand,
  type InformationNeed,
  type NeedField,
  type PatientClinicalMemory,
  type PatientClinicalSnapshot,
  type SourceSpan,
} from './index.js';

const HASH = '0'.repeat(64);
const MESSAGE_ID = 'message-aggregate-validation';
const QUOTE = 'I took alpha.';

function sourceSpan(messageId = MESSAGE_ID, quote = QUOTE): SourceSpan {
  return { messageId, start: 0, end: quote.length, quote };
}

function emptyMemory(overrides: Partial<PatientClinicalMemory> = {}): PatientClinicalMemory {
  return {
    patientId: 'patient-aggregate-validation',
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

function snapshot(body: string): PatientClinicalSnapshot {
  return {
    memory: emptyMemory(),
    inboundMessage: { id: MESSAGE_ID, sequence: 1, body },
    consentEpoch: 1,
    expectedConsentEpoch: 1,
    medications: [],
    doses: [],
    symptomConcepts: [],
    languageDisposition: 'english',
    emergencyPrefilter: true,
    contextHash: HASH,
    pipelineVersions: {
      extractor: 'extractor-v1',
      resolver: 'resolver-v1',
      reducer: 'reducer-v1',
      renderer: 'renderer-v1',
    },
  };
}

function administrationEvent(
  id = 'event-administration',
  overrides: Partial<ClinicalEvent> = {},
): ClinicalEvent {
  const messageId = `message-${id}`;
  return {
    id,
    version: 1,
    kind: 'administration',
    operation: 'create',
    authoredBy: 'patient',
    reviewState: 'unreviewed',
    current: true,
    canonical: true,
    sourceMessageIds: [messageId],
    sourceSpans: [sourceSpan(messageId)],
    medicationId: 'med-alpha',
    medicationVersion: 1,
    doseId: 'dose-alpha',
    doseVersion: 1,
    adherence: 'taken',
    ...overrides,
  };
}

function pendingAdministrationEvent(id: string, medicationId?: string): ClinicalEvent {
  const messageId = `message-${id}`;
  return {
    id,
    version: 1,
    kind: 'administration',
    operation: 'create',
    authoredBy: 'patient',
    reviewState: 'unreviewed',
    current: true,
    canonical: false,
    sourceMessageIds: [messageId],
    sourceSpans: [sourceSpan(messageId)],
    adherence: 'taken',
    ...(medicationId === undefined ? {} : { medicationId, medicationVersion: 1 }),
  };
}

function symptomEvent(id: string, overrides: Partial<ClinicalEvent> = {}): ClinicalEvent {
  const messageId = `message-${id}`;
  return {
    id,
    version: 1,
    kind: 'symptom',
    operation: 'create',
    authoredBy: 'patient',
    reviewState: 'unreviewed',
    current: true,
    canonical: true,
    sourceMessageIds: [messageId],
    sourceSpans: [sourceSpan(messageId, 'nausea')],
    rawSymptom: 'nausea',
    symptomConcept: 'nausea',
    symptomStatus: 'resolved',
    ...overrides,
  };
}

function safetyEvent(id: string): ClinicalEvent {
  const messageId = `message-${id}`;
  return {
    id,
    version: 1,
    kind: 'safety',
    operation: 'raise_safety',
    authoredBy: 'patient',
    reviewState: 'unreviewed',
    current: true,
    canonical: true,
    sourceMessageIds: [messageId],
    sourceSpans: [sourceSpan(messageId, "I can't breathe")],
    safetyTier: 'emergency',
  };
}

function contradictionEvent(id: string, targetEventId: string): ClinicalEvent {
  const messageId = `message-${id}`;
  return {
    id,
    version: 1,
    kind: 'contradiction',
    operation: 'contradict',
    authoredBy: 'patient',
    reviewState: 'unreviewed',
    current: true,
    canonical: false,
    sourceMessageIds: [messageId],
    sourceSpans: [sourceSpan(messageId, 'I missed it')],
    contradictionOfEventId: targetEventId,
  };
}

function informationNeed(
  target: ClinicalEvent,
  field: NeedField,
  overrides: Partial<InformationNeed> = {},
): InformationNeed {
  return {
    id: `need-${target.id}-${field}`,
    version: 1,
    originInboundMessageId: target.sourceMessageIds[0]!,
    originInboundSequence: 1,
    targetEventId: target.id,
    targetEventVersion: target.version,
    field,
    candidateMedicationIds: [],
    candidateDoseIds: [],
    candidateSymptomEventIds: [],
    candidateHistoricalEventIds: [],
    questionId: `question-${target.id}-${field}`,
    clarificationAttemptUsed: false,
    state: 'open',
    priority: 1,
    ...overrides,
  };
}

function mutatingCommands(): ClinicalIntentCommand[] {
  const base = (id: string) => ({
    id: `command-${id}`,
    sourceMessageId: MESSAGE_ID,
    sourceSpans: [sourceSpan()],
  });
  const needTarget = { needId: 'need-1', expectedNeedVersion: 1 };

  return [
    {
      ...base('create'),
      kind: 'CreateReport',
      eventKind: 'administration',
      medicationId: 'med-alpha',
      medicationVersion: 1,
      doseId: 'dose-alpha',
      doseVersion: 1,
      adherence: 'taken',
    },
    {
      ...base('refine'),
      kind: 'RefineReport',
      targetEventId: 'event-1',
      targetEventVersion: 1,
      targetKind: 'administration',
      exactTime: '08:15',
    },
    {
      ...base('correct'),
      kind: 'CorrectReport',
      targetEventId: 'event-1',
      targetEventVersion: 1,
      targetKind: 'administration',
      adherence: 'missed',
    },
    {
      ...base('recur'),
      kind: 'RecordRecurrence',
      targetEventId: 'event-symptom',
      targetEventVersion: 1,
      rawSymptom: 'nausea',
    },
    {
      ...base('contradict'),
      kind: 'RecordContradiction',
      targetEventId: 'event-1',
      targetEventVersion: 1,
      targetKind: 'administration',
      reason: 'patient_report_conflicts',
      adherence: 'missed',
    },
    {
      ...base('open-need'),
      kind: 'OpenInformationNeed',
      needId: 'need-1',
      originInboundSequence: 1,
      targetEventId: 'event-1',
      targetEventVersion: 1,
      field: 'actual_time',
      candidateMedicationIds: [],
      candidateDoseIds: [],
      candidateSymptomEventIds: [],
      candidateHistoricalEventIds: [],
      questionId: 'question-1',
      priority: 1,
    },
    { ...base('resolve-need'), kind: 'ResolveInformationNeed', ...needTarget },
    {
      ...base('decline-need'),
      kind: 'DeclineInformationNeed',
      ...needTarget,
      outcome: 'declined',
    },
    { ...base('expire-need'), kind: 'ExpireInformationNeed', ...needTarget },
    {
      ...base('supersede-need'),
      kind: 'SupersedeInformationNeed',
      ...needTarget,
      successorNeedId: 'need-2',
    },
    { ...base('pause'), kind: 'PauseRoutineClarification', reason: 'safety_pause' },
    {
      ...base('raise-safety'),
      kind: 'RaiseSafetySignal',
      safetyTier: 'emergency',
      reason: 'deterministic_prefilter',
    },
    {
      ...base('preserve'),
      kind: 'PreserveUnresolvedContent',
      reason: 'unresolved',
      candidateMedicationIds: [],
      candidateDoseIds: [],
      candidateEventIds: [],
    },
  ];
}

describe('clinical-memory aggregate validation regressions', () => {
  it('exposes the patient memory graph as deeply readonly', () => {
    const currentMemory = emptyMemory();
    if (currentMemory.version < 0) {
      // @ts-expect-error The public aggregate version is immutable.
      currentMemory.version = 1;
      // @ts-expect-error The public aggregate collections are immutable.
      currentMemory.events.push(administrationEvent());
    }
    expect(currentMemory.version).toBe(0);
  });

  it('rejects asking another need while preserving already-durable asked needs', () => {
    const nausea = symptomEvent('event-nausea-asked');
    const headache = symptomEvent('event-headache-open', { rawSymptom: 'headache' });
    const first = informationNeed(nausea, 'severity', {
      id: 'need-nausea-asked',
      state: 'asked',
      clarificationAttemptUsed: true,
    });
    const second = informationNeed(headache, 'duration', {
      id: 'need-headache-open',
      questionId: 'question-headache-open',
    });
    const hydrated = emptyMemory({ events: [nausea, headache], needs: [first, second] });
    const command: ClinicalIntentCommand = {
      id: 'command-ask-second-need',
      kind: 'AskInformationNeed',
      sourceMessageId: MESSAGE_ID,
      sourceSpans: [],
      needId: second.id,
      expectedNeedVersion: second.version,
    };

    expect(() => reducePatientClinicalMemory(hydrated, [command])).toThrow(
      'information_need_already_asked',
    );
    expect(
      patientClinicalMemorySchema.safeParse({
        ...hydrated,
        needs: [first, { ...second, state: 'asked', clarificationAttemptUsed: true }],
      }).success,
    ).toBe(true);
  });

  it('accepts the public validated-claim contract with semantic provenance attached', () => {
    expect(
      validatedClaimSchema.safeParse({
        slot: 'social-claim',
        kind: 'social',
        quote: 'Thanks',
        polarity: 'positive',
        experiencer: 'patient',
        status: 'current',
        certainty: 'certain',
        semanticId: 'claim-social',
        sourceSpan: sourceSpan(MESSAGE_ID, 'Thanks'),
      }).success,
    ).toBe(true);
  });

  it.each([
    ['asked without using the clarification attempt', 'asked', false],
    ['open after using the clarification attempt', 'open', true],
  ] as const)('rejects a need that is %s', (_label, state, clarificationAttemptUsed) => {
    const target = symptomEvent('event-impossible-need-state');
    expect(
      informationNeedSchema.safeParse(
        informationNeed(target, 'severity', { state, clarificationAttemptUsed }),
      ).success,
    ).toBe(false);
  });

  it('rejects orphaned, cyclic, branching, and duplicate-active need lineage', () => {
    const target = symptomEvent('event-need-lineage');
    const parent = informationNeed(target, 'severity', {
      id: 'need-parent',
      state: 'superseded',
    });
    const successor = informationNeed(target, 'severity', {
      id: 'need-successor',
      supersedesNeedId: parent.id,
    });
    const sibling = informationNeed(target, 'severity', {
      id: 'need-sibling',
      state: 'superseded',
      supersedesNeedId: parent.id,
    });
    const orphan = informationNeed(target, 'duration', {
      id: 'need-orphan',
      supersedesNeedId: 'need-missing',
    });
    const cycleLeft = informationNeed(target, 'body_site', {
      id: 'need-cycle-left',
      state: 'superseded',
      supersedesNeedId: 'need-cycle-right',
    });
    const cycleRight = informationNeed(target, 'frequency', {
      id: 'need-cycle-right',
      state: 'superseded',
      supersedesNeedId: 'need-cycle-left',
    });
    const activeOriginal = informationNeed(target, 'severity', { id: 'need-active-original' });
    const duplicateActive = informationNeed(target, 'severity', { id: 'need-duplicate-active' });

    const invalidNeedSets = [
      [orphan],
      [cycleLeft, cycleRight],
      [parent, successor, sibling],
      [activeOriginal, duplicateActive],
    ];
    for (const needs of invalidNeedSets) {
      expect(
        patientClinicalMemorySchema.safeParse(emptyMemory({ events: [target], needs })).success,
      ).toBe(false);
    }

    expect(
      patientClinicalMemorySchema.safeParse(
        emptyMemory({ events: [target], needs: [parent, successor] }),
      ).success,
    ).toBe(true);
  });

  it('prepares a deterministic emergency response for an exact 4000-character body', () => {
    const body = "I can't breathe.".padEnd(4_000, 'x');
    const prepared = prepareClinicalTurn(snapshot(body), []);

    expect(body).toHaveLength(4_000);
    expect(prepared.responsePlan.kind).toBe('emergency');
    expect(prepared.commands.map(({ kind }) => kind)).toEqual([
      'RaiseSafetySignal',
      'PauseRoutineClarification',
      'PreserveUnresolvedContent',
    ]);
    for (const command of prepared.commands) {
      expect(command.sourceSpans.length).toBeGreaterThan(0);
      for (const span of command.sourceSpans) {
        expect(body.slice(span.start, span.end)).toBe(span.quote);
      }
    }
  });

  it.each(
    mutatingCommands().map((command) => [command.kind, { ...command, sourceSpans: [] }] as const),
  )('rejects %s without an exact source span', (_kind, command) => {
    expect(clinicalIntentCommandSchema.safeParse(command).success).toBe(false);
  });

  it('rejects a sourced command whose primary message is absent from its evidence spans', () => {
    expect(
      clinicalIntentCommandSchema.safeParse({
        id: 'command-source-mismatch',
        kind: 'CreateReport',
        sourceMessageId: 'message-primary',
        sourceSpans: [sourceSpan('message-different')],
        eventKind: 'administration',
        adherence: 'taken',
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      id: 'command-ask',
      kind: 'AskInformationNeed',
      sourceMessageId: MESSAGE_ID,
      sourceSpans: [],
      needId: 'need-1',
      expectedNeedVersion: 1,
    },
    {
      id: 'command-resume',
      kind: 'ResumeRoutineClarification',
      sourceMessageId: 'clinician-action',
      sourceSpans: [],
      reviewItemId: 'review-safety',
    },
  ] satisfies ClinicalIntentCommand[])('allows $kind without a source span', (command) => {
    expect(clinicalIntentCommandSchema.safeParse(command).success).toBe(true);
  });

  it('rejects duplicate event IDs in one patient aggregate', () => {
    const event = administrationEvent();
    const aggregate = emptyMemory({ events: [event, { ...event }] });

    expect(patientClinicalMemorySchema.safeParse(aggregate).success).toBe(false);
  });

  it.each([
    [
      'a recurrence with a missing target',
      [
        symptomEvent('event-recurrence', {
          operation: 'recur',
          symptomStatus: 'current',
          recurrenceOfEventId: 'event-missing',
        }),
      ],
    ],
    [
      'a recurrence targeting a different event kind',
      [
        administrationEvent('event-administration-target'),
        symptomEvent('event-recurrence', {
          operation: 'recur',
          symptomStatus: 'current',
          recurrenceOfEventId: 'event-administration-target',
        }),
      ],
    ],
    [
      'a recurrence cycle',
      [
        symptomEvent('event-recurrence-a', {
          operation: 'recur',
          symptomStatus: 'resolved',
          recurrenceOfEventId: 'event-recurrence-b',
        }),
        symptomEvent('event-recurrence-b', {
          operation: 'recur',
          symptomStatus: 'resolved',
          recurrenceOfEventId: 'event-recurrence-a',
        }),
      ],
    ],
    ['a contradiction with a missing target', [contradictionEvent('event-conflict', 'missing')]],
    [
      'a contradiction targeting a safety event',
      [safetyEvent('event-safety'), contradictionEvent('event-conflict', 'event-safety')],
    ],
    [
      'a contradiction targeting another contradiction',
      [
        contradictionEvent('event-conflict-a', 'event-conflict-b'),
        contradictionEvent('event-conflict-b', 'event-conflict-a'),
      ],
    ],
    [
      'a contradiction targeting an unprotected patient report',
      [
        administrationEvent('event-patient-report'),
        contradictionEvent('event-conflict', 'event-patient-report'),
      ],
    ],
  ] satisfies Array<readonly [string, ClinicalEvent[]]>)('rejects %s', (_label, events) => {
    expect(patientClinicalMemorySchema.safeParse(emptyMemory({ events })).success).toBe(false);
  });

  it('accepts appropriate acyclic recurrence and contradiction links', () => {
    const resolved = symptomEvent('event-resolved');
    const protectedAdministration = administrationEvent('event-protected', {
      authoredBy: 'clinician',
      reviewState: 'confirmed',
    });
    const events = [
      resolved,
      symptomEvent('event-recurrence', {
        operation: 'recur',
        symptomStatus: 'current',
        recurrenceOfEventId: resolved.id,
      }),
      protectedAdministration,
      contradictionEvent('event-conflict', protectedAdministration.id),
    ];

    expect(patientClinicalMemorySchema.safeParse(emptyMemory({ events })).success).toBe(true);
  });

  it('accepts a refined recurrence only when its direct recurrence link is unchanged', () => {
    const resolved = symptomEvent('event-resolved-refinement');
    const otherResolved = symptomEvent('event-other-resolved-refinement');
    const recurrence = symptomEvent('event-recurrence-refinement', {
      operation: 'recur',
      current: false,
      symptomStatus: 'current',
      recurrenceOfEventId: resolved.id,
    });
    const refined = symptomEvent('event-refined-recurrence', {
      version: 2,
      operation: 'refine',
      symptomStatus: 'current',
      supersedesEventId: recurrence.id,
      recurrenceOfEventId: resolved.id,
      severity: '2',
    });

    expect(
      patientClinicalMemorySchema.safeParse(
        emptyMemory({ events: [resolved, otherResolved, recurrence, refined] }),
      ).success,
    ).toBe(true);
    expect(
      patientClinicalMemorySchema.safeParse(
        emptyMemory({
          events: [
            resolved,
            otherResolved,
            recurrence,
            { ...refined, recurrenceOfEventId: otherResolved.id },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it.each([
    ['dose identity on a symptom', symptomEvent('event-symptom'), 'dose_identity'],
    ['severity on an administration', administrationEvent(), 'severity'],
    ['actual time on a safety signal', safetyEvent('event-safety'), 'actual_time'],
  ] satisfies Array<readonly [string, ClinicalEvent, NeedField]>)(
    'rejects an incompatible need field: %s',
    (_label, target, field) => {
      const aggregate = emptyMemory({ events: [target], needs: [informationNeed(target, field)] });

      expect(patientClinicalMemorySchema.safeParse(aggregate).success).toBe(false);
    },
  );

  it('rejects a dose-identity medication scope that widens beyond the target medication', () => {
    const target = pendingAdministrationEvent('event-pending-dose', 'med-alpha');
    const need = informationNeed(target, 'dose_identity', {
      candidateMedicationIds: ['med-alpha', 'med-beta'],
      candidateDoseIds: ['dose-alpha'],
    });

    expect(
      patientClinicalMemorySchema.safeParse(emptyMemory({ events: [target], needs: [need] }))
        .success,
    ).toBe(false);
  });

  it('keeps a canonical administration explicitly patient-authored and source-linked', () => {
    const span = sourceSpan();
    const result = reducePatientClinicalMemory(emptyMemory(), [
      {
        id: 'command-patient-administration',
        kind: 'CreateReport',
        sourceMessageId: MESSAGE_ID,
        sourceSpans: [span],
        eventKind: 'administration',
        medicationId: 'med-alpha',
        medicationVersion: 1,
        doseId: 'dose-alpha',
        doseVersion: 1,
        adherence: 'taken',
      },
    ]);

    expect(result.memory.events).toEqual([
      expect.objectContaining({
        kind: 'administration',
        operation: 'create',
        canonical: true,
        authoredBy: 'patient',
        reviewState: 'unreviewed',
        sourceMessageIds: [MESSAGE_ID],
        sourceSpans: [span],
      }),
    ]);
  });

  it.each([
    [
      'an administration event with symptom state',
      administrationEvent('event-mixed-administration', {
        rawSymptom: 'nausea',
        symptomConcept: 'nausea',
      }),
    ],
    [
      'a symptom event with adherence state',
      symptomEvent('event-mixed-symptom', { adherence: 'taken' }),
    ],
    [
      'a recurrence operation without a recurrence link',
      symptomEvent('event-unlinked-recurrence', { operation: 'recur' }),
    ],
  ] satisfies Array<readonly [string, ClinicalEvent]>)('rejects %s', (_label, event) => {
    expect(patientClinicalMemorySchema.safeParse(emptyMemory({ events: [event] })).success).toBe(
      false,
    );
  });

  it.each([
    {
      id: 'command-symptom-with-adherence',
      kind: 'CreateReport',
      sourceMessageId: MESSAGE_ID,
      sourceSpans: [sourceSpan()],
      eventKind: 'symptom',
      adherence: 'taken',
    },
    {
      id: 'command-administration-with-symptom',
      kind: 'CreateReport',
      sourceMessageId: MESSAGE_ID,
      sourceSpans: [sourceSpan()],
      eventKind: 'administration',
      rawSymptom: 'nausea',
      symptomConcept: 'nausea',
    },
    {
      id: 'command-symptom-with-medication-identity',
      kind: 'CreateReport',
      sourceMessageId: MESSAGE_ID,
      sourceSpans: [sourceSpan()],
      eventKind: 'symptom',
      rawSymptom: 'nausea',
      symptomConcept: 'nausea',
      symptomStatus: 'current',
      medicationId: 'med-alpha',
      medicationVersion: 1,
      doseId: 'dose-alpha',
      doseVersion: 1,
      localDate: '2026-08-13',
      localTime: '08:00',
    },
    {
      id: 'command-recurrence-with-medication-identity',
      kind: 'RecordRecurrence',
      sourceMessageId: MESSAGE_ID,
      sourceSpans: [sourceSpan()],
      targetEventId: 'event-resolved-symptom',
      targetEventVersion: 1,
      rawSymptom: 'nausea',
      symptomConcept: 'nausea',
      symptomStatus: 'current',
      medicationId: 'med-alpha',
      medicationVersion: 1,
      doseId: 'dose-alpha',
      doseVersion: 1,
      localDate: '2026-08-13',
      localTime: '08:00',
    },
  ])('rejects a cross-kind $kind intent', (command) => {
    expect(clinicalIntentCommandSchema.safeParse(command).success).toBe(false);
  });
});
