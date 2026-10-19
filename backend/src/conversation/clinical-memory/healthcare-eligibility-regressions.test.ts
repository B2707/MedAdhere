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

function memory(overrides: Partial<PatientClinicalMemory> = {}): PatientClinicalMemory {
  return {
    patientId: 'patient-healthcare-eligibility',
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
  state: PatientClinicalMemory,
  messageId: string,
  sequence: number,
  body: string,
  overrides: Partial<PatientClinicalSnapshot> = {},
): PatientClinicalSnapshot {
  return {
    memory: state,
    inboundMessage: { id: messageId, sequence, body },
    consentEpoch: 1,
    expectedConsentEpoch: 1,
    medications: [
      { id: 'med-alpha', version: 1, names: ['alpha'], aliases: [], active: true },
      { id: 'med-beta', version: 1, names: ['beta'], aliases: [], active: true },
      { id: 'med-gamma', version: 1, names: ['gamma'], aliases: [], active: true },
    ],
    doses: [
      {
        id: 'dose-alpha-today',
        version: 1,
        medicationId: 'med-alpha',
        label: 'alpha morning',
        localDate: '2026-08-13',
        localTime: '08:00',
      },
      {
        id: 'dose-beta-frozen',
        version: 1,
        medicationId: 'med-beta',
        label: 'beta morning',
        localDate: '2026-08-13',
        localTime: '09:00',
      },
      {
        id: 'dose-gamma-today',
        version: 1,
        medicationId: 'med-gamma',
        label: 'gamma morning',
        localDate: '2026-08-13',
        localTime: '10:00',
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

function administrationEvent(overrides: Partial<ClinicalEvent> = {}): ClinicalEvent {
  const sourceMessageId = 'message-prior';
  const sourceQuote = 'I took alpha.';
  return {
    id: 'event-administration',
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
    doseId: 'dose-alpha-today',
    doseVersion: 1,
    adherence: 'taken',
    localDate: '2026-08-13',
    localTime: '08:00',
    ...overrides,
  };
}

function symptomEvent(overrides: Partial<ClinicalEvent> = {}): ClinicalEvent {
  const sourceMessageId = 'message-prior';
  const sourceQuote = 'I have nausea.';
  return {
    id: 'event-symptom',
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
    symptomStatus: 'current',
    ...overrides,
  };
}

function informationNeed(
  event: ClinicalEvent,
  field: InformationNeed['field'],
  overrides: Partial<InformationNeed> = {},
): InformationNeed {
  return {
    id: `need-${field}`,
    version: 1,
    originInboundMessageId: 'message-prior',
    originInboundSequence: 1,
    targetEventId: event.id,
    targetEventVersion: event.version,
    field,
    candidateMedicationIds: [],
    candidateDoseIds: [],
    candidateSymptomEventIds: [],
    candidateHistoricalEventIds: [],
    questionId: `question-${field}`,
    clarificationAttemptUsed: true,
    state: 'asked',
    priority: 100,
    ...overrides,
  };
}

function apply(
  state: PatientClinicalSnapshot,
  claims: readonly ExtractedClaim[],
): {
  readonly prepared: ReturnType<typeof prepareClinicalTurn>;
  readonly memory: PatientClinicalMemory;
} {
  const prepared = prepareClinicalTurn(state, claims);
  return { prepared, memory: applyPreparedClinicalTurn(state.memory, prepared).memory };
}

describe('healthcare eligibility at the public clinical-memory boundary', () => {
  it.each([
    {
      label: 'third-person',
      body: 'My sister says alpha was missed.',
      quote: 'sister says alpha was missed',
      override: { experiencer: 'other' as const },
    },
    {
      label: 'uncertain',
      body: 'Maybe alpha was missed.',
      quote: 'Maybe alpha was missed',
      override: { certainty: 'uncertain' as const },
    },
    {
      label: 'hypothetical',
      body: 'What if alpha was missed?',
      quote: 'alpha was missed',
      override: { status: 'hypothetical' as const },
    },
  ])(
    'preserves an ineligible $label correction without changing its target',
    ({ body, quote, override }) => {
      const original = administrationEvent();
      const initial = memory({ version: 1, events: [original] });
      const result = apply(
        snapshot(
          initial,
          `message-${override.experiencer ?? override.certainty ?? override.status}`,
          2,
          body,
        ),
        [
          {
            slot: 'correction',
            kind: 'correction',
            quote,
            ...ELIGIBLE,
            ...override,
            targetText: 'alpha',
            actionText: 'missed',
          },
        ],
      );

      expect(
        result.prepared.commands.filter(({ kind }) =>
          ['CorrectReport', 'RefineReport', 'RecordContradiction'].includes(kind),
        ),
      ).toEqual([]);
      expect(result.memory.events).toEqual([original]);
      expect(result.memory.unresolvedReports).toEqual([
        expect.objectContaining({ sourceMessageId: result.prepared.sourceMessageId }),
      ]);
      expect(result.memory.reviewItems).toEqual([
        expect.objectContaining({ kind: 'unresolved_report', status: 'open' }),
      ]);
    },
  );

  it.each([
    ['clinician-authored', 'clinician', 'unreviewed'],
    ['clinician-reviewed', 'patient', 'confirmed'],
  ] as const)(
    'never refines a %s symptom event from patient detail',
    (_label, authoredBy, reviewState) => {
      const protectedEvent = symptomEvent({ authoredBy, reviewState });
      const initial = memory({ version: 1, events: [protectedEvent] });
      const result = apply(
        snapshot(
          initial,
          `message-detail-${authoredBy}-${reviewState}`,
          2,
          'The nausea is severe.',
        ),
        [
          {
            slot: 'severity-detail',
            kind: 'symptom_detail',
            quote: 'nausea is severe',
            ...ELIGIBLE,
            targetText: 'nausea',
            detailField: 'severity',
            detailText: 'severe',
          },
        ],
      );

      expect(result.prepared.commands.some(({ kind }) => kind === 'RefineReport')).toBe(false);
      expect(result.memory.events.find(({ id }) => id === protectedEvent.id)).toEqual(
        protectedEvent,
      );
      expect(
        result.memory.events.some(
          ({ supersedesEventId }) => supersedesEventId === protectedEvent.id,
        ),
      ).toBe(false);

      const contradiction = result.memory.events.some(
        ({ contradictionOfEventId }) => contradictionOfEventId === protectedEvent.id,
      );
      const contradictionReview = result.memory.reviewItems.some(
        ({ kind, targetEventId, status }) =>
          kind === 'contradiction' && targetEventId === protectedEvent.id && status === 'open',
      );
      const preservedForReview =
        result.memory.unresolvedReports.some(
          ({ sourceMessageId }) => sourceMessageId === result.prepared.sourceMessageId,
        ) &&
        result.memory.reviewItems.some(
          ({ kind, status }) => kind === 'unresolved_report' && status === 'open',
        );
      expect((contradiction && contradictionReview) || preservedForReview).toBe(true);
    },
  );

  it('does not auto-bind an omitted medication without a prompted dose', () => {
    const initial = memory();
    const result = apply(
      snapshot(initial, 'message-omitted-medication', 1, 'I took it.', {
        medications: [{ id: 'med-alpha', version: 1, names: ['alpha'], aliases: [], active: true }],
        doses: [
          {
            id: 'dose-alpha-today',
            version: 1,
            medicationId: 'med-alpha',
            label: 'alpha morning',
            localDate: '2026-08-13',
            localTime: '08:00',
          },
        ],
      }),
      [
        {
          slot: 'administration',
          kind: 'administration',
          quote: 'took it',
          ...ELIGIBLE,
          actionText: 'took',
        },
      ],
    );

    expect(
      result.prepared.commands.some(
        (command) =>
          command.kind === 'CreateReport' &&
          (command.medicationId !== undefined || command.doseId !== undefined),
      ),
    ).toBe(false);
    expect(
      result.memory.events.filter(({ kind, canonical }) => kind === 'administration' && canonical),
    ).toEqual([]);
    expect(
      result.memory.events.every(
        ({ medicationId, doseId }) => medicationId === undefined && doseId === undefined,
      ),
    ).toBe(true);
    expect(result.memory.unresolvedReports).toHaveLength(1);
  });

  it('does not widen a medication clarification to a dose introduced after the need was frozen', () => {
    const pending = administrationEvent({
      id: 'event-pending-medication',
      canonical: false,
      medicationId: undefined,
      medicationVersion: undefined,
      doseId: undefined,
      doseVersion: undefined,
      localDate: undefined,
      localTime: undefined,
    });
    const need = informationNeed(pending, 'medication_identity', {
      candidateMedicationIds: ['med-beta'],
      candidateDoseIds: ['dose-beta-frozen'],
    });
    const initial = memory({ version: 1, events: [pending], needs: [need] });
    const introducedDoseId = 'dose-beta-introduced';
    const result = apply(
      snapshot(initial, 'message-medication-clarification', 2, 'It was beta.', {
        medications: [{ id: 'med-beta', version: 1, names: ['beta'], aliases: [], active: true }],
        doses: [
          {
            id: 'dose-beta-frozen',
            version: 1,
            medicationId: 'med-beta',
            label: 'beta morning',
            localDate: '2026-08-13',
            localTime: '09:00',
          },
          {
            id: introducedDoseId,
            version: 1,
            medicationId: 'med-beta',
            label: 'beta evening',
            localDate: '2026-08-13',
            localTime: '21:00',
          },
        ],
      }),
      [
        {
          slot: 'medication-answer',
          kind: 'need_answer',
          quote: 'beta',
          ...ELIGIBLE,
          answerField: 'medication_identity',
          answerText: 'beta',
        },
      ],
    );

    const referencedDoseIds = result.prepared.commands.flatMap((command) => [
      ...('doseId' in command && command.doseId !== undefined ? [command.doseId] : []),
      ...('candidateDoseIds' in command ? command.candidateDoseIds : []),
    ]);
    expect(referencedDoseIds).not.toContain(introducedDoseId);
    expect(result.memory.events.find(({ current }) => current)?.doseId).not.toBe(introducedDoseId);
    expect(result.memory.needs.flatMap(({ candidateDoseIds }) => candidateDoseIds)).not.toContain(
      introducedDoseId,
    );
  });

  it('does not consume an unrelated asked symptom-identity need for a new recognized symptom', () => {
    const unresolvedSymptom = symptomEvent({
      id: 'event-unresolved-symptom',
      rawSymptom: 'strange feeling',
      symptomConcept: null,
    });
    const need = informationNeed(unresolvedSymptom, 'symptom_identity', {
      candidateSymptomEventIds: ['event-unresolved-symptom'],
    });
    const initial = memory({ version: 1, events: [unresolvedSymptom], needs: [need] });
    const result = apply(
      snapshot(initial, 'message-independent-symptom', 2, 'Now I have nausea.'),
      [
        {
          slot: 'new-symptom',
          kind: 'symptom',
          quote: 'have nausea',
          ...ELIGIBLE,
          symptomText: 'nausea',
        },
      ],
    );

    expect(
      result.prepared.commands.some(
        (command) => command.kind === 'ResolveInformationNeed' && command.needId === need.id,
      ),
    ).toBe(false);
    expect(
      result.prepared.commands.some(
        (command) =>
          command.kind === 'RefineReport' && command.targetEventId === unresolvedSymptom.id,
      ),
    ).toBe(false);
    expect(result.memory.events.find(({ id }) => id === unresolvedSymptom.id)).toEqual(
      unresolvedSymptom,
    );
    expect(result.memory.needs.find(({ id }) => id === need.id)).toEqual(need);
    expect(result.memory.events).toContainEqual(
      expect.objectContaining({
        id: expect.not.stringMatching(/^event-unresolved-symptom$/u),
        operation: 'create',
        symptomConcept: 'nausea',
        symptomStatus: 'current',
      }),
    );
  });

  it('does not accept a need answer for a need that has not been asked', () => {
    const symptom = symptomEvent();
    const openNeed = informationNeed(symptom, 'severity', {
      clarificationAttemptUsed: false,
      state: 'open',
      candidateSymptomEventIds: [symptom.id],
    });
    const initial = memory({ version: 1, events: [symptom], needs: [openNeed] });
    const result = apply(snapshot(initial, 'message-unprompted-answer', 2, 'It is severe.'), [
      {
        slot: 'unprompted-severity',
        kind: 'need_answer',
        quote: 'severe',
        ...ELIGIBLE,
        answerField: 'severity',
        answerText: 'severe',
      },
    ]);

    expect(
      result.prepared.commands.some(
        ({ kind }) => kind === 'ResolveInformationNeed' || kind === 'RefineReport',
      ),
    ).toBe(false);
    expect(result.memory.events).toEqual([symptom]);
    expect(result.memory.needs.find(({ id }) => id === openNeed.id)?.state).not.toBe('resolved');
    expect(result.memory.unresolvedReports).toEqual([
      expect.objectContaining({ sourceMessageId: 'message-unprompted-answer' }),
    ]);
  });

  it('makes one failed used clarification terminal so a later answer cannot mutate', () => {
    const pending = administrationEvent({
      id: 'event-failed-clarification',
      canonical: false,
      medicationId: undefined,
      medicationVersion: undefined,
      doseId: undefined,
      doseVersion: undefined,
      localDate: undefined,
      localTime: undefined,
    });
    const need = informationNeed(pending, 'medication_identity', {
      candidateMedicationIds: ['med-alpha', 'med-beta'],
    });
    const initial = memory({ version: 1, events: [pending], needs: [need] });
    const failed = apply(snapshot(initial, 'message-failed-answer', 2, 'It was gamma.'), [
      {
        slot: 'outside-candidate-answer',
        kind: 'need_answer',
        quote: 'gamma',
        ...ELIGIBLE,
        answerField: 'medication_identity',
        answerText: 'gamma',
      },
    ]);
    const terminalNeed = failed.memory.needs.find(({ id }) => id === need.id);

    expect(['open', 'asked']).not.toContain(terminalNeed?.state);
    expect(failed.memory.events).toEqual([pending]);

    const later = apply(
      snapshot(failed.memory, 'message-late-answer', 3, 'Actually, it was alpha.'),
      [
        {
          slot: 'late-valid-answer',
          kind: 'need_answer',
          quote: 'alpha',
          ...ELIGIBLE,
          answerField: 'medication_identity',
          answerText: 'alpha',
        },
      ],
    );

    expect(
      later.prepared.commands.some(
        ({ kind }) => kind === 'ResolveInformationNeed' || kind === 'RefineReport',
      ),
    ).toBe(false);
    expect(later.memory.events).toEqual([pending]);
    expect(later.memory.needs.find(({ id }) => id === need.id)?.state).toBe(terminalNeed?.state);
  });

  it('does not bind a historical administration to today without a unique event date', () => {
    const initial = memory();
    const result = apply(
      snapshot(
        initial,
        'message-undated-historical-administration',
        1,
        'I took alpha some time before.',
        {
          medications: [
            { id: 'med-alpha', version: 1, names: ['alpha'], aliases: [], active: true },
          ],
          doses: [
            {
              id: 'dose-alpha-today',
              version: 1,
              medicationId: 'med-alpha',
              label: 'alpha morning',
              localDate: '2026-08-13',
              localTime: '08:00',
            },
          ],
        },
      ),
      [
        {
          slot: 'historical-administration',
          kind: 'administration',
          quote: 'took alpha some time before',
          ...ELIGIBLE,
          status: 'historical',
          medicationText: 'alpha',
          timeText: 'some time before',
          actionText: 'took',
        },
      ],
    );

    expect(
      result.prepared.commands.some(
        (command) => command.kind === 'CreateReport' && command.doseId === 'dose-alpha-today',
      ),
    ).toBe(false);
    expect(
      result.memory.events.filter(({ kind, canonical }) => kind === 'administration' && canonical),
    ).toEqual([]);
    expect(result.memory.events.some(({ doseId }) => doseId === 'dose-alpha-today')).toBe(false);
    expect(result.memory.unresolvedReports).toHaveLength(1);
  });
});
