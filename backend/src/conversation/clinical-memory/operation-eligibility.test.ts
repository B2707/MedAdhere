import { describe, expect, it } from 'vitest';
import {
  prepareClinicalTurn,
  reducePatientClinicalMemory,
  type ClinicalEvent,
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

function memory(events: readonly ClinicalEvent[] = []): PatientClinicalMemory {
  return {
    patientId: 'patient-eligibility',
    version: events.length === 0 ? 0 : 1,
    events: [...events],
    needs: [],
    unresolvedReports: [],
    reviewItems: [],
    routineClarificationsPaused: false,
    processedBatches: [],
  };
}

function snapshot(
  body: string,
  options: {
    readonly memory?: PatientClinicalMemory;
    readonly doses?: PatientClinicalSnapshot['doses'];
  } = {},
): PatientClinicalSnapshot {
  return {
    memory: options.memory ?? memory(),
    inboundMessage: { id: `message-${body.length}`, sequence: 2, body },
    consentEpoch: 1,
    expectedConsentEpoch: 1,
    medications: [{ id: 'med-alpha', version: 1, names: ['alpha'], aliases: [], active: true }],
    doses: options.doses ?? [
      {
        id: 'dose-alpha',
        version: 1,
        medicationId: 'med-alpha',
        label: 'alpha dose',
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
  };
}

function administration(
  quote: string,
  actionText: string,
  overrides: Partial<Extract<ExtractedClaim, { kind: 'administration' }>> = {},
): ExtractedClaim {
  return {
    slot: 'administration',
    kind: 'administration',
    quote,
    ...ELIGIBLE,
    medicationText: 'alpha',
    actionText,
    ...overrides,
  };
}

function symptom(
  quote: string,
  overrides: Partial<Extract<ExtractedClaim, { kind: 'symptom' }>> = {},
): ExtractedClaim {
  return {
    slot: 'symptom',
    kind: 'symptom',
    quote,
    ...ELIGIBLE,
    symptomText: 'nausea',
    ...overrides,
  };
}

function run(state: PatientClinicalSnapshot, claims: readonly ExtractedClaim[]) {
  const prepared = prepareClinicalTurn(state, claims);
  return {
    prepared,
    result: reducePatientClinicalMemory(state.memory, prepared.commands).memory,
  };
}

function priorSymptom(id: string): ClinicalEvent {
  return {
    id,
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
  };
}

describe('administration operation eligibility', () => {
  it('records linguistically negative did-not-take wording as a missed assertion', () => {
    const body = 'I did not take alpha.';
    const state = snapshot(body);
    const { result } = run(state, [administration(body, 'did not take', { polarity: 'negative' })]);

    expect(result.events).toEqual([
      expect.objectContaining({
        kind: 'administration',
        canonical: true,
        medicationId: 'med-alpha',
        doseId: 'dose-alpha',
        adherence: 'missed',
      }),
    ]);
    expect(result.unresolvedReports).toEqual([]);
  });

  it.each([
    ['future', 'I will take alpha.', 'will take'],
    ['habitual', 'I usually take alpha.', 'usually take'],
    ['hypothetical', 'If needed, I would take alpha.', 'would take'],
  ] as const)('keeps %s administration wording noncanonical', (status, body, actionText) => {
    const state = snapshot(body);
    const { prepared, result } = run(state, [administration(body, actionText, { status })]);

    expect(prepared.commands.map(({ kind }) => kind)).toEqual(['PreserveUnresolvedContent']);
    expect(result.events).toEqual([]);
    expect(result.unresolvedReports).toEqual([
      expect.objectContaining({ reason: 'non_completed_administration' }),
    ]);
  });

  it('keeps uncertain completed-administration wording noncanonical', () => {
    const body = 'I might have taken alpha.';
    const state = snapshot(body);
    const { result } = run(state, [administration(body, 'taken', { certainty: 'uncertain' })]);

    expect(result.events).toEqual([]);
    expect(result.unresolvedReports).toEqual([
      expect.objectContaining({ reason: 'uncertain_administration' }),
    ]);
  });

  it('keeps third-person administration wording noncanonical', () => {
    const body = 'My sister took alpha.';
    const state = snapshot(body);
    const { result } = run(state, [administration(body, 'took', { experiencer: 'other' })]);

    expect(result.events).toEqual([]);
    expect(result.unresolvedReports).toEqual([
      expect.objectContaining({ reason: 'non_patient_experiencer' }),
    ]);
  });

  it('allows a certain historical completed administration to bind', () => {
    const body = 'I took alpha on 2026-08-13.';
    const state = snapshot(body);
    const { result } = run(state, [
      administration(body, 'took', { status: 'historical', timeText: '2026-08-13' }),
    ]);

    expect(result.events).toEqual([
      expect.objectContaining({
        kind: 'administration',
        canonical: true,
        medicationId: 'med-alpha',
        doseId: 'dose-alpha',
        adherence: 'taken',
        timeText: '2026-08-13',
      }),
    ]);
  });
});

describe('symptom operation eligibility', () => {
  it('does not create a positive symptom from negative current wording', () => {
    const body = 'I do not have nausea.';
    const state = snapshot(body);
    const { result } = run(state, [symptom(body, { polarity: 'negative' })]);

    expect(result.events).toEqual([]);
    expect(result.unresolvedReports).toEqual([
      expect.objectContaining({ reason: 'non_positive_symptom' }),
    ]);
  });

  it('may create a historical symptom occurrence while preserving its status', () => {
    const body = 'I had nausea yesterday.';
    const state = snapshot(body);
    const { result } = run(state, [symptom(body, { status: 'historical', timeText: 'yesterday' })]);

    expect(result.events).toContainEqual(
      expect.objectContaining({
        kind: 'symptom',
        canonical: true,
        symptomConcept: 'nausea',
        symptomStatus: 'historical',
        timeText: 'yesterday',
      }),
    );
  });

  it('resolves one unique current occurrence by refinement', () => {
    const original = priorSymptom('event-nausea');
    const state = snapshot('The nausea stopped.', { memory: memory([original]) });
    const { prepared, result } = run(state, [
      symptom('The nausea stopped.', { status: 'resolved' }),
    ]);

    expect(prepared.commands.filter(({ kind }) => kind === 'RefineReport')).toHaveLength(1);
    expect(result.events.find(({ id }) => id === original.id)).toEqual({
      ...original,
      current: false,
    });
    expect(result.events.filter(({ current }) => current)).toEqual([
      expect.objectContaining({
        operation: 'refine',
        symptomStatus: 'resolved',
        supersedesEventId: original.id,
      }),
    ]);
  });

  it('preserves resolved wording when multiple current occurrences match', () => {
    const original = [priorSymptom('event-nausea-1'), priorSymptom('event-nausea-2')];
    const state = snapshot('The nausea stopped.', { memory: memory(original) });
    const { prepared, result } = run(state, [
      symptom('The nausea stopped.', { status: 'resolved' }),
    ]);

    expect(prepared.commands.filter(({ kind }) => kind === 'RefineReport')).toEqual([]);
    expect(result.events).toEqual(original);
    expect(result.unresolvedReports).toEqual([
      expect.objectContaining({
        reason: 'resolved_symptom_target_unresolved',
        candidateEventIds: ['event-nausea-1', 'event-nausea-2'],
      }),
    ]);
  });
});

describe('protected-record correction eligibility', () => {
  it.each([
    ['clinician-reviewed', 'patient', 'confirmed'],
    ['doctor-owned', 'clinician', 'unreviewed'],
  ] as const)(
    'records a contradiction for a %s report without replacing it',
    (_label, authoredBy, reviewState) => {
      const accepted: ClinicalEvent = {
        id: `event-${authoredBy}-${reviewState}`,
        version: 1,
        kind: 'administration',
        operation: 'create',
        authoredBy,
        reviewState,
        current: true,
        canonical: true,
        sourceMessageIds: ['message-prior'],
        sourceSpans: authoredBy === 'patient' ? [sourceSpan('message-prior', 'I took alpha.')] : [],
        medicationId: 'med-alpha',
        medicationVersion: 1,
        doseId: 'dose-alpha',
        doseVersion: 1,
        adherence: 'taken',
      };
      const state = snapshot('Correction: alpha was missed.', { memory: memory([accepted]) });
      const { prepared, result } = run(state, [
        {
          slot: 'correction',
          kind: 'correction',
          quote: 'alpha was missed',
          ...ELIGIBLE,
          targetText: 'alpha',
          actionText: 'missed',
        },
      ]);

      expect(prepared.commands.map(({ kind }) => kind)).toContain('RecordContradiction');
      expect(result.events.find(({ id }) => id === accepted.id)).toEqual(accepted);
      expect(result.events).toContainEqual(
        expect.objectContaining({
          kind: 'contradiction',
          canonical: false,
          contradictionOfEventId: accepted.id,
          adherence: 'missed',
        }),
      );
      expect(result.reviewItems).toContainEqual(
        expect.objectContaining({
          kind: 'contradiction',
          targetEventId: accepted.id,
          status: 'open',
        }),
      );
    },
  );
});

describe('non-counting medication-change reports', () => {
  it.each([
    ['partial dose', 'I only took half of alpha.', 'took half'],
    ['refusal', 'I refuse to start alpha.', 'refuse to start'],
    ['patient-reported cessation', 'I stopped taking alpha.', 'stopped taking'],
  ] as const)(
    'preserves %s for review without an adherence count or doctor-owned mutation',
    (_label, body, actionText) => {
      const state = snapshot(body);
      const before = structuredClone(state);
      const { prepared, result } = run(state, [administration(body, actionText)]);

      expect(prepared.commands.map(({ kind }) => kind)).toContain('PreserveUnresolvedContent');
      expect(
        result.events.filter(({ kind, canonical }) => kind === 'administration' && canonical),
      ).toEqual([]);
      expect(result.unresolvedReports).toEqual([
        expect.objectContaining({
          sourceMessageId: state.inboundMessage.id,
          sourceSpans: [expect.objectContaining({ quote: body })],
        }),
      ]);
      expect(result.reviewItems).toEqual([
        expect.objectContaining({ kind: 'unresolved_report', status: 'open' }),
      ]);
      expect(state.medications).toEqual(before.medications);
      expect(state.doses).toEqual(before.doses);
    },
  );
});
