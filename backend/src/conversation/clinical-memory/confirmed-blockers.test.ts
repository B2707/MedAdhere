import { expect, it } from 'vitest';
import {
  applyPreparedClinicalTurn,
  prepareClinicalTurn,
  reducePatientClinicalMemory,
  renderClinicalResponse,
  type ExtractedClaim,
  type PatientClinicalMemory,
  type PatientClinicalSnapshot,
} from './index.js';

const HASH = '0'.repeat(64);
const versions = {
  extractor: 'extractor-v1',
  resolver: 'resolver-v1',
  reducer: 'reducer-v1',
  renderer: 'renderer-v1',
} as const;
const medication = (id: string) => ({
  id: `med-${id}`,
  version: 1,
  names: [id],
  aliases: [],
  active: true,
});
const dose = (id: string, medicationId: string) => ({
  id: `dose-${id}`,
  version: 1,
  medicationId,
  label: id,
  localDate: '2026-08-12',
  localTime: '08:00',
});
const emptyMemory = (): PatientClinicalMemory => ({
  patientId: 'patient-1',
  version: 0,
  events: [],
  needs: [],
  unresolvedReports: [],
  reviewItems: [],
  routineClarificationsPaused: false,
  processedBatches: [],
});
const snapshot = (overrides: Partial<PatientClinicalSnapshot> = {}): PatientClinicalSnapshot => ({
  memory: emptyMemory(),
  inboundMessage: { id: 'message-1', sequence: 1, body: 'Thanks.' },
  consentEpoch: 1,
  expectedConsentEpoch: 1,
  medications: [medication('alpha'), medication('beta'), medication('gamma')],
  doses: [dose('alpha', 'med-alpha'), dose('beta', 'med-beta'), dose('gamma', 'med-gamma')],
  symptomConcepts: ['nausea', 'tingling'],
  languageDisposition: 'english',
  emergencyPrefilter: false,
  contextHash: HASH,
  pipelineVersions: versions,
  ...overrides,
});
const eligible = {
  polarity: 'positive',
  experiencer: 'patient',
  status: 'current',
  certainty: 'certain',
} as const;

function sourceSpan(messageId: string, quote: string) {
  return { messageId, start: 0, end: quote.length, quote };
}

it('keeps an information need candidate scope authoritative and never widens it', () => {
  const memory: PatientClinicalMemory = {
    ...emptyMemory(),
    version: 2,
    events: [
      {
        id: 'event-pending',
        version: 1,
        kind: 'administration',
        operation: 'create',
        authoredBy: 'patient',
        reviewState: 'unreviewed',
        current: true,
        canonical: false,
        sourceMessageIds: ['prior-message'],
        sourceSpans: [sourceSpan('prior-message', 'I took it.')],
      },
    ],
    needs: [
      {
        id: 'need-pending',
        version: 1,
        originInboundMessageId: 'prior-message',
        originInboundSequence: 1,
        targetEventId: 'event-pending',
        targetEventVersion: 1,
        field: 'medication_identity',
        candidateMedicationIds: ['med-alpha', 'med-beta'],
        candidateDoseIds: [],
        candidateSymptomEventIds: [],
        candidateHistoricalEventIds: [],
        questionId: 'question-medication-identity',
        clarificationAttemptUsed: true,
        state: 'asked',
        priority: 100,
      },
    ],
  };
  const turn = prepareClinicalTurn(
    snapshot({
      memory,
      inboundMessage: { id: 'message-answer', sequence: 2, body: 'It was gamma.' },
    }),
    [
      {
        slot: 'answer',
        kind: 'need_answer',
        quote: 'gamma',
        ...eligible,
        answerField: 'medication_identity',
        answerText: 'gamma',
      },
    ],
  );
  const result = reducePatientClinicalMemory(memory, turn.commands);

  expect(result.memory.events).toEqual(memory.events);
  expect(result.memory.needs).toEqual([
    expect.objectContaining({
      ...memory.needs[0],
      version: 2,
      state: 'superseded',
      clarificationAttemptUsed: true,
      candidateMedicationIds: ['med-alpha', 'med-beta'],
    }),
  ]);
  expect(result.memory.unresolvedReports.map(({ reason }) => reason)).toEqual([
    'candidate_widening_forbidden',
  ]);
});

it('does not bind an explicit medication to a prompted dose owned by another medication', () => {
  const turn = prepareClinicalTurn(
    snapshot({
      inboundMessage: { id: 'message-mismatch', sequence: 1, body: 'I took alpha.' },
      promptedDoseId: 'dose-beta',
    }),
    [
      {
        slot: 'administration',
        kind: 'administration',
        quote: 'took alpha',
        ...eligible,
        medicationText: 'alpha',
        actionText: 'took',
      },
    ],
  );
  const result = reducePatientClinicalMemory(emptyMemory(), turn.commands);

  expect(result.memory.events).toEqual([]);
  expect(result.memory.unresolvedReports.map(({ reason }) => reason)).toEqual([
    'prompted_dose_medication_mismatch',
  ]);
});

it('keeps uncertain adherence and an untargeted resolved symptom noncanonical', () => {
  const turn = prepareClinicalTurn(
    snapshot({
      inboundMessage: {
        id: 'message-noncanonical',
        sequence: 1,
        body: 'I maybe took alpha and the tingling stopped.',
      },
    }),
    [
      {
        slot: 'administration',
        kind: 'administration',
        quote: 'maybe took alpha',
        ...eligible,
        certainty: 'uncertain',
        medicationText: 'alpha',
        actionText: 'took',
      },
      {
        slot: 'symptom',
        kind: 'symptom',
        quote: 'tingling stopped',
        ...eligible,
        status: 'resolved',
        symptomText: 'tingling',
      },
    ],
  );
  const result = reducePatientClinicalMemory(emptyMemory(), turn.commands);

  expect(result.memory.events).toEqual([]);
  expect(result.memory.unresolvedReports.map(({ reason }) => reason).sort()).toEqual([
    'resolved_symptom_target_unresolved',
    'uncertain_administration',
  ]);
});

it('refines once, supersedes stale needs, and retargets applicable needs to the successor', () => {
  const memory: PatientClinicalMemory = {
    ...emptyMemory(),
    version: 2,
    events: [
      {
        id: 'event-nausea',
        version: 1,
        kind: 'symptom',
        operation: 'create',
        authoredBy: 'patient',
        reviewState: 'unreviewed',
        current: true,
        canonical: true,
        sourceMessageIds: ['prior-message'],
        sourceSpans: [sourceSpan('prior-message', 'I have nausea.')],
        rawSymptom: 'nausea',
        symptomConcept: 'nausea',
        symptomStatus: 'current',
      },
    ],
    needs: [
      {
        id: 'need-severity',
        version: 1,
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
  const turn = prepareClinicalTurn(
    snapshot({
      memory,
      inboundMessage: { id: 'message-duration', sequence: 2, body: 'The nausea lasted an hour.' },
    }),
    [
      {
        slot: 'duration',
        kind: 'symptom_detail',
        quote: 'nausea lasted an hour',
        ...eligible,
        targetText: 'nausea',
        detailField: 'duration',
        detailText: 'an hour',
      },
    ],
  );
  const result = reducePatientClinicalMemory(memory, turn.commands);
  const successor = result.memory.events.find(
    ({ supersedesEventId }) => supersedesEventId === 'event-nausea',
  );

  expect(turn.commands.filter(({ kind }) => kind === 'RefineReport')).toHaveLength(1);
  expect(result.memory.events.find(({ id }) => id === 'event-nausea')?.current).toBe(false);
  expect(result.memory.needs.find(({ id }) => id === 'need-severity')?.state).toBe('superseded');
  expect(
    result.memory.needs.filter(
      ({ targetEventId, state }) =>
        targetEventId === successor?.id && (state === 'open' || state === 'asked'),
    ),
  ).toHaveLength(1);
});

it('accepts only an exact complete prepared-batch replay', () => {
  const initial = emptyMemory();
  const prepared = prepareClinicalTurn(
    snapshot({ inboundMessage: { id: 'message-replay', sequence: 1, body: 'I took alpha.' } }),
    [
      {
        slot: 'administration',
        kind: 'administration',
        quote: 'took alpha',
        ...eligible,
        medicationText: 'alpha',
        actionText: 'took',
      },
    ],
  );
  const first = applyPreparedClinicalTurn(initial, prepared);

  expect(applyPreparedClinicalTurn(first.memory, prepared)).toEqual(first);
  expect(() =>
    applyPreparedClinicalTurn(first.memory, { ...prepared, commandHash: 'f'.repeat(64) }),
  ).toThrow('prepared_batch_integrity_error');
  expect(first.memory.events).toHaveLength(1);
});

it('makes the reducer own asked state and keeps rendering referentially transparent', () => {
  const memory: PatientClinicalMemory = {
    ...emptyMemory(),
    version: 2,
    events: [
      {
        id: 'event-nausea',
        version: 1,
        kind: 'symptom',
        operation: 'create',
        authoredBy: 'patient',
        reviewState: 'unreviewed',
        current: true,
        canonical: true,
        sourceMessageIds: ['prior-message'],
        sourceSpans: [sourceSpan('prior-message', 'I have nausea.')],
        rawSymptom: 'nausea',
        symptomConcept: 'nausea',
        symptomStatus: 'current',
      },
    ],
    needs: [
      {
        id: 'need-severity',
        version: 1,
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
        clarificationAttemptUsed: false,
        state: 'open',
        priority: 70,
      },
    ],
  };
  const prepared = prepareClinicalTurn(
    snapshot({ memory, inboundMessage: { id: 'message-social', sequence: 2, body: 'Thanks.' } }),
    [{ slot: 'social', kind: 'social', quote: 'Thanks', ...eligible } as ExtractedClaim],
  );
  const before = structuredClone(memory);
  const reduced = reducePatientClinicalMemory(memory, prepared.commands);
  const first = renderClinicalResponse(prepared.responsePlan);
  const second = renderClinicalResponse(prepared.responsePlan);

  expect(
    prepared.commands
      .filter(
        (command): command is Extract<typeof command, { kind: 'AskInformationNeed' }> =>
          command.kind === 'AskInformationNeed',
      )
      .map(({ needId }) => needId),
  ).toEqual(['need-severity']);
  expect(reduced.memory.needs.find(({ id }) => id === 'need-severity')?.state).toBe('asked');
  expect(first).toBe(second);
  expect(memory).toEqual(before);
});
