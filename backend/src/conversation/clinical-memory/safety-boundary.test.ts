import { describe, expect, it } from 'vitest';

import {
  prepareClinicalTurn,
  reducePatientClinicalMemory,
  type ClinicalIntentCommand,
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

function memory(): PatientClinicalMemory {
  return {
    patientId: 'patient-safety',
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
    memory: memory(),
    inboundMessage: { id: 'message-safety', sequence: 1, body: "I can't breathe." },
    consentEpoch: 1,
    expectedConsentEpoch: 1,
    medications: [],
    doses: [],
    symptomConcepts: [],
    languageDisposition: 'english',
    emergencyPrefilter: true,
    contextHash: HASH,
    pipelineVersions: versions,
    ...overrides,
  };
}

describe('deterministic emergency interruption', () => {
  it('outranks unsupported language and malformed extracted claims', () => {
    const state = snapshot({ languageDisposition: 'unsupported' });
    const prepared = prepareClinicalTurn(state, [
      {
        slot: 'invalid',
        kind: 'symptom',
        quote: 'not in the message',
        polarity: 'positive',
        experiencer: 'patient',
        status: 'current',
        certainty: 'certain',
        symptomText: 'not in the message',
      },
    ]);
    const reduced = reducePatientClinicalMemory(state.memory, prepared.commands).memory;

    expect(prepared.responsePlan.kind).toBe('emergency');
    expect(prepared.commands.map(({ kind }) => kind)).toEqual([
      'RaiseSafetySignal',
      'PauseRoutineClarification',
      'PreserveUnresolvedContent',
    ]);
    expect(reduced.events).toEqual([
      expect.objectContaining({ kind: 'safety', safetyTier: 'emergency', canonical: true }),
    ]);
    expect(reduced.unresolvedReports).toEqual([
      expect.objectContaining({ reason: 'emergency_content_not_extracted' }),
    ]);
    expect(reduced.routineClarificationsPaused).toBe(true);
  });

  it('lets exact STOP outrank the emergency prefilter', () => {
    const state = snapshot({
      exactControl: 'STOP',
      inboundMessage: { id: 'message-stop', sequence: 1, body: 'STOP' },
    });
    const prepared = prepareClinicalTurn(state, []);

    expect(prepared.responsePlan.kind).toBe('stop');
    expect(prepared.commands).toEqual([]);
  });

  it('resumes routine questions after an owner-confirmed closure without changing safety severity', () => {
    const emergencyState = snapshot();
    const emergencyPrepared = prepareClinicalTurn(emergencyState, []);
    const emergencyMemory = reducePatientClinicalMemory(
      emergencyState.memory,
      emergencyPrepared.commands,
    ).memory;
    const review = emergencyMemory.reviewItems.find(({ kind }) => kind === 'safety');
    if (review === undefined) throw new Error('safety_review_missing');
    const clinicianClosed: PatientClinicalMemory = {
      ...emergencyMemory,
      events: [
        ...emergencyMemory.events,
        {
          id: 'event-headache',
          version: 1,
          kind: 'symptom',
          operation: 'create',
          authoredBy: 'patient',
          reviewState: 'unreviewed',
          current: true,
          canonical: true,
          sourceMessageIds: ['message-headache'],
          sourceSpans: [
            {
              messageId: 'message-headache',
              start: 0,
              end: 'I have a headache.'.length,
              quote: 'I have a headache.',
            },
          ],
          rawSymptom: 'headache',
          symptomConcept: 'headache',
          symptomStatus: 'current',
        },
      ],
      needs: [
        ...emergencyMemory.needs,
        {
          id: 'need-headache-severity',
          version: 1,
          originInboundMessageId: 'message-headache',
          originInboundSequence: 1,
          targetEventId: 'event-headache',
          targetEventVersion: 1,
          field: 'severity',
          candidateMedicationIds: [],
          candidateDoseIds: [],
          candidateSymptomEventIds: ['event-headache'],
          candidateHistoricalEventIds: [],
          questionId: 'question-headache-severity',
          clarificationAttemptUsed: false,
          state: 'open',
          priority: 70,
        },
      ],
      reviewItems: emergencyMemory.reviewItems.map((item) =>
        item.id === review.id ? { ...item, status: 'confirmed' as const } : item,
      ),
    };
    const resume: ClinicalIntentCommand = {
      id: 'command-owner-confirmed-resume',
      kind: 'ResumeRoutineClarification',
      sourceMessageId: 'clinician-action',
      sourceSpans: [],
      reviewItemId: review.id,
    };
    const resumed = reducePatientClinicalMemory(clinicianClosed, [resume]).memory;
    const prepared = prepareClinicalTurn(
      snapshot({
        memory: resumed,
        emergencyPrefilter: false,
        inboundMessage: { id: 'message-after-closure', sequence: 2, body: 'Thanks.' },
        symptomConcepts: ['headache'],
      }),
      [
        {
          slot: 'thanks',
          kind: 'social',
          quote: 'Thanks',
          polarity: 'positive',
          experiencer: 'patient',
          status: 'current',
          certainty: 'certain',
        },
      ],
    );

    expect(prepared.responsePlan).toMatchObject({
      kind: 'question',
      question: { needId: 'need-headache-severity', field: 'severity' },
    });
    expect(resumed.events.find(({ kind }) => kind === 'safety')?.safetyTier).toBe('emergency');
  });
});
