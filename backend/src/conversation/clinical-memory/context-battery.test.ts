// Wave 1e — AI-led symptom context gathering. Covers the deterministic-core machinery: the
// question bank's need-opening (rollout-gated by contextBatteryEnabled), the 4-question cap
// per symptom episode, the "any non-answer/idk/topic-change stops the battery permanently"
// rule, and the deterministic selectQuestion fallback for an (out-of-scope-wired) upstream AI
// preference. Composer-side (bank vocabulary + AI-authored questions) is covered in
// composer-validators.test.ts; the bank text/EXPLAINERS map is covered generically in
// response.test.ts.

import { describe, expect, it } from 'vitest';

import {
  applyPreparedClinicalTurn,
  prepareClinicalTurn,
  type ClinicalEvent,
  type ExtractedClaim,
  type InformationNeed,
  type NeedField,
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

const CONTEXT_BATTERY_FIELDS_ORDERED: readonly NeedField[] = [
  'onset',
  'quality',
  'triggers',
  'associated_symptoms',
  'recurrence_history',
];

function memory(overrides: Partial<PatientClinicalMemory> = {}): PatientClinicalMemory {
  return {
    patientId: 'patient-context-battery',
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
    medications: [{ id: 'med-alpha', version: 1, names: ['alpha'], aliases: [], active: true }],
    doses: [
      {
        id: 'dose-alpha-morning',
        version: 1,
        medicationId: 'med-alpha',
        label: 'alpha morning',
        localDate: '2026-08-13',
        localTime: '08:00',
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

function symptomClaim(
  slot: string,
  overrides: Partial<Extract<ExtractedClaim, { kind: 'symptom' }>> = {},
): ExtractedClaim {
  return {
    slot,
    kind: 'symptom',
    quote: 'nausea',
    ...ELIGIBLE,
    symptomText: 'nausea',
    ...overrides,
  };
}

function needAnswerClaim(
  slot: string,
  quote: string,
  answerField: NeedField,
  overrides: Partial<Extract<ExtractedClaim, { kind: 'need_answer' }>> = {},
): ExtractedClaim {
  return {
    slot,
    kind: 'need_answer',
    quote,
    ...ELIGIBLE,
    answerField,
    answerText: quote,
    ...overrides,
  };
}

function symptomEvent(id: string, overrides: Partial<ClinicalEvent> = {}): ClinicalEvent {
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
    sourceSpans: [{ messageId: sourceMessageId, start: 0, end: 6, quote: 'nausea' }],
    rawSymptom: 'nausea',
    symptomConcept: 'nausea',
    symptomStatus: 'current',
    severity: '5',
    ...overrides,
  };
}

function openNeed(
  target: ClinicalEvent,
  field: NeedField,
  priority: number,
  state: InformationNeed['state'] = 'open',
): InformationNeed {
  return {
    id: `need-${field}-${target.id}`,
    version: 1,
    originInboundMessageId: target.sourceMessageIds[0]!,
    originInboundSequence: 1,
    targetEventId: target.id,
    targetEventVersion: target.version,
    field,
    candidateMedicationIds: [],
    candidateDoseIds: [],
    candidateSymptomEventIds: [target.id],
    candidateHistoricalEventIds: [],
    questionId: `question-${field}-${target.id}`,
    clarificationAttemptUsed: state === 'asked',
    state,
    priority,
  };
}

function commit(
  state: PatientClinicalSnapshot,
  claims: readonly ExtractedClaim[],
): ReturnType<typeof applyPreparedClinicalTurn> {
  return applyPreparedClinicalTurn(state.memory, prepareClinicalTurn(state, claims));
}

describe('Wave 1e — context battery rollout gate', () => {
  it('opens only the pre-existing severity need when contextBatteryEnabled is unset (default OFF)', () => {
    const result = commit(snapshot(memory(), 'message-create', 1, 'I have nausea'), [
      symptomClaim('nausea-report'),
    ]);
    const opened = result.memory.needs.filter(
      (need) => need.targetEventId !== undefined && result.createdNeedIds.includes(need.id),
    );
    expect(opened.map(({ field }) => field).sort()).toEqual(['severity']);
  });

  it('opens only severity when contextBatteryEnabled is explicitly false', () => {
    const result = commit(
      snapshot(memory(), 'message-create', 1, 'I have nausea', { contextBatteryEnabled: false }),
      [symptomClaim('nausea-report')],
    );
    const opened = result.memory.needs.filter((need) => result.createdNeedIds.includes(need.id));
    expect(opened.map(({ field }) => field).sort()).toEqual(['severity']);
  });
});

describe('Wave 1e — context battery need machinery + cap', () => {
  // The cap is 4 questions for the whole symptom bank, severity included (it is the bank's
  // highest-priority field and is the one actually asked first), so a single burst opens
  // severity plus the top THREE context fields — not severity plus four.
  it('opens severity plus context-battery fields capped at 4 total, in priority order', () => {
    const result = commit(
      snapshot(memory(), 'message-create', 1, 'I have nausea', { contextBatteryEnabled: true }),
      [symptomClaim('nausea-report')],
    );
    const opened = result.memory.needs.filter((need) => result.createdNeedIds.includes(need.id));
    expect(opened.map(({ field }) => field).sort()).toEqual(
      ['onset', 'quality', 'severity', 'triggers'].sort(),
    );
    const contextFields = opened
      .map(({ field }) => field)
      .filter((field) => CONTEXT_BATTERY_FIELDS_ORDERED.includes(field));
    expect(contextFields).toHaveLength(3);
    expect(contextFields).not.toContain('associated_symptoms');
    expect(contextFields).not.toContain('recurrence_history');
  });

  it('asks severity first (outranks the whole context battery), then the battery in priority order across turns', () => {
    const created = commit(
      snapshot(memory(), 'message-create', 1, 'I have nausea', { contextBatteryEnabled: true }),
      [symptomClaim('nausea-report')],
    );
    expect(created.prepared.responsePlan).toMatchObject({
      kind: 'question',
      question: { field: 'severity' },
    });

    // Answering severity immediately surfaces the next-highest-priority battery field (onset)
    // on the SAME turn — "the battery is a sequence of needs consumed across turns".
    const answeredSeverity = commit(
      snapshot(created.memory, 'message-severity-answer', 2, '7', {
        contextBatteryEnabled: true,
      }),
      [needAnswerClaim('severity-answer', '7', 'severity')],
    );
    expect(answeredSeverity.prepared.responsePlan).toMatchObject({
      kind: 'question',
      question: { field: 'onset' },
    });
  });
});

describe('Wave 1e — AI-selection preference (deterministic-core side)', () => {
  it('honors an eligible, in-battery contextQuestionPreference over the priority order', () => {
    const nausea = symptomEvent('event-nausea-battery');
    const needs = [
      openNeed(nausea, 'onset', 69),
      openNeed(nausea, 'quality', 68),
      openNeed(nausea, 'triggers', 67),
      openNeed(nausea, 'associated_symptoms', 66),
    ];
    const initial = memory({ version: 1, events: [nausea], needs });
    const result = commit(
      snapshot(initial, 'message-social', 2, 'Thanks.', {
        contextBatteryEnabled: true,
        contextQuestionPreference: 'triggers',
      }),
      [{ slot: 'social', kind: 'social', quote: 'Thanks', ...ELIGIBLE }],
    );
    expect(result.prepared.responsePlan).toMatchObject({
      kind: 'question',
      question: { field: 'triggers' },
    });
  });

  it('falls back to deterministic priority order when the preference names a non-context field', () => {
    const nausea = symptomEvent('event-nausea-battery');
    const needs = [
      openNeed(nausea, 'onset', 69),
      openNeed(nausea, 'quality', 68),
      openNeed(nausea, 'triggers', 67),
      openNeed(nausea, 'associated_symptoms', 66),
    ];
    const initial = memory({ version: 1, events: [nausea], needs });
    const result = commit(
      snapshot(initial, 'message-social', 2, 'Thanks.', {
        contextBatteryEnabled: true,
        // medication_identity has no authority here — the AI cannot hijack a non-battery field.
        contextQuestionPreference: 'medication_identity',
      }),
      [{ slot: 'social', kind: 'social', quote: 'Thanks', ...ELIGIBLE }],
    );
    expect(result.prepared.responsePlan).toMatchObject({
      kind: 'question',
      question: { field: 'onset' },
    });
  });

  it('falls back to deterministic priority order when the preferred field is not currently eligible', () => {
    const nausea = symptomEvent('event-nausea-battery');
    const needs = [
      openNeed(nausea, 'onset', 69),
      openNeed(nausea, 'quality', 68),
      openNeed(nausea, 'triggers', 67),
      openNeed(nausea, 'associated_symptoms', 66),
    ];
    const initial = memory({ version: 1, events: [nausea], needs });
    const result = commit(
      snapshot(initial, 'message-social', 2, 'Thanks.', {
        contextBatteryEnabled: true,
        // recurrence_history is a context-battery field, but it was never opened here.
        contextQuestionPreference: 'recurrence_history',
      }),
      [{ slot: 'social', kind: 'social', quote: 'Thanks', ...ELIGIBLE }],
    );
    expect(result.prepared.responsePlan).toMatchObject({
      kind: 'question',
      question: { field: 'onset' },
    });
  });
});

describe('Wave 1e — stop rule: idk/non-answer/topic change ends the battery permanently', () => {
  it('never asks a sibling context-battery question again once one is declined as "I don\'t know"', () => {
    const nausea = symptomEvent('event-nausea-battery');
    const needs = [
      openNeed(nausea, 'onset', 69, 'asked'),
      openNeed(nausea, 'quality', 68),
      openNeed(nausea, 'triggers', 67),
      openNeed(nausea, 'associated_symptoms', 66),
    ];
    const initial = memory({ version: 1, events: [nausea], needs });

    const declined = commit(
      snapshot(initial, 'message-idk', 2, "I don't know", { contextBatteryEnabled: true }),
      [needAnswerClaim('onset-idk', "I don't know", 'onset')],
    );
    expect(
      declined.memory.needs.find(({ id }) => id === 'need-onset-event-nausea-battery')?.state,
    ).toBe('patient_does_not_know');

    // A later, unrelated turn must never surface quality/triggers/associated_symptoms even
    // though they remain 'open' — the whole battery is permanently stopped for this episode.
    const later = commit(
      snapshot(declined.memory, 'message-later', 3, 'ok thanks', {
        contextBatteryEnabled: true,
      }),
      [{ slot: 'social-later', kind: 'social', quote: 'ok thanks', ...ELIGIBLE }],
    );
    expect(later.prepared.responsePlan.kind).not.toBe('question');
    for (const field of ['quality', 'triggers', 'associated_symptoms'] as const) {
      expect(
        later.memory.needs.find((need) => need.targetEventId === nausea.id && need.field === field)
          ?.state,
      ).toBe('open');
    }
  });
});

describe('Wave 1e — stop rule + cap span the whole symptom bank, severity included', () => {
  // severity has the HIGHEST priority of the whole bank (70, above every new field), so it is
  // the question actually asked FIRST. Excluding it from the stop set meant the one question
  // the patient answers first could never stop the battery, and excluding it from the cap made
  // the real per-episode ceiling 5 questions instead of the planned 4.
  it('stops the whole battery when severity is answered "I don\'t know"', () => {
    const nausea = symptomEvent('event-nausea-severity-idk', { severity: undefined });
    const needs = [
      openNeed(nausea, 'severity', 70, 'asked'),
      openNeed(nausea, 'onset', 69),
      openNeed(nausea, 'quality', 68),
      openNeed(nausea, 'triggers', 67),
      openNeed(nausea, 'associated_symptoms', 66),
    ];
    const initial = memory({ version: 1, events: [nausea], needs });

    const declined = commit(
      snapshot(initial, 'message-severity-idk', 2, "I don't know", {
        contextBatteryEnabled: true,
      }),
      [needAnswerClaim('severity-idk', "I don't know", 'severity')],
    );
    expect(
      declined.memory.needs.find(({ id }) => id === 'need-severity-event-nausea-severity-idk')
        ?.state,
    ).toBe('patient_does_not_know');

    const later = commit(
      snapshot(declined.memory, 'message-later', 3, 'ok thanks', { contextBatteryEnabled: true }),
      [{ slot: 'social-later', kind: 'social', quote: 'ok thanks', ...ELIGIBLE }],
    );
    expect(later.prepared.responsePlan.kind).not.toBe('question');
  });

  it('counts severity against the 4-question episode cap', () => {
    const result = commit(
      snapshot(memory(), 'message-create', 1, 'I have nausea', { contextBatteryEnabled: true }),
      [symptomClaim('nausea-report')],
    );
    const opened = result.memory.needs
      .filter((need) => result.createdNeedIds.includes(need.id))
      .map(({ field }) => field);
    expect(opened).toHaveLength(4);
    expect(opened).toContain('severity');
    expect(opened.filter((field) => CONTEXT_BATTERY_FIELDS_ORDERED.includes(field))).toHaveLength(
      3,
    );
  });
});

describe('Wave 1c — a late_intent answer that reports the dose was taken', () => {
  const administrationEvent: ClinicalEvent = {
    id: 'event-missed-dose',
    version: 1,
    kind: 'administration',
    operation: 'create',
    authoredBy: 'patient',
    reviewState: 'unreviewed',
    current: true,
    canonical: true,
    sourceMessageIds: ['message-missed'],
    sourceSpans: [{ messageId: 'message-missed', start: 0, end: 6, quote: 'missed' }],
    adherence: 'missed',
    medicationId: 'med-alpha',
    medicationVersion: 1,
    doseId: 'dose-alpha-morning',
    doseVersion: 1,
    localDate: '2026-08-13',
  };

  function lateIntentMemory(): PatientClinicalMemory {
    return memory({
      version: 1,
      events: [administrationEvent],
      needs: [
        {
          ...openNeed(administrationEvent, 'late_intent', 50, 'asked'),
          candidateSymptomEventIds: [],
        },
      ],
    });
  }

  // The dose stayed 'missed' and the patient was told "Thanks for letting me know" — a false
  // miss that feeds the reported-miss streak alert with nobody ever seeing it.
  it('never silently retires the question while leaving the dose recorded as missed', () => {
    const result = commit(
      snapshot(lateIntentMemory(), 'message-took-it', 2, 'yes I took it just now'),
      [needAnswerClaim('late-answer', 'yes I took it just now', 'late_intent')],
    );
    expect(result.memory.unresolvedReports.map(({ reason }) => reason)).toContain(
      'late_intent_outcome_unresolved',
    );
    expect(result.memory.needs.find((need) => need.field === 'late_intent')?.state).not.toBe(
      'open',
    );
  });

  it('still resolves a plain forward-intent answer without review', () => {
    const result = commit(snapshot(lateIntentMemory(), 'message-later', 2, 'yes later tonight'), [
      needAnswerClaim('late-answer', 'yes later tonight', 'late_intent'),
    ]);
    expect(result.memory.unresolvedReports).toEqual([]);
    expect(result.memory.needs.find((need) => need.field === 'late_intent')?.state).toBe(
      'resolved',
    );
  });
});
