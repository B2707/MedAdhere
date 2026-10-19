// Lane Q — RE-ASK ROUTE driving tests (2026-08-17 live incident).
//
// Observed live failure: a turn whose extraction terminally failed (gateway ok:false,
// malformed_output) leaked its token reservation; the leak later drove every subsequent turn to
// budget_exhausted. The agent replied "Thanks. I saved this update for your doctor to review."
// to a direct patient question ("What do you want to know what was your question") while a
// scheduled dose check-in was still unanswered, and stayed silent for the rest of the day.
//
// These tests drive prepareClinicalTurn / prepareClinicalFailureTurn end-to-end (planner
// selection, not just the renderer — see response.test.ts's "Lane Q" describe block for the pure
// rendering/degradation coverage) through the exact scenario and its neighbors.

import { describe, expect, it } from 'vitest';
import {
  applyPreparedClinicalTurn,
  CURRENT_CLINICAL_PIPELINE_VERSIONS,
  prepareClinicalFailureTurn,
  prepareClinicalTurn,
  type ExtractedClaim,
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

const MEDICATIONS: PatientClinicalSnapshot['medications'] = [
  { id: 'med-metformin', version: 1, names: ['metformin'], aliases: [], active: true },
];
const DOSES: PatientClinicalSnapshot['doses'] = [
  {
    id: 'dose-metformin',
    version: 1,
    medicationId: 'med-metformin',
    label: 'metformin 8:00 dose',
    localDate: '2026-08-17',
    localTime: '08:00',
  },
];

function emptyMemory(patientId = 'patient-lane-q'): PatientClinicalMemory {
  return {
    patientId,
    version: 0,
    events: [],
    needs: [],
    unresolvedReports: [],
    reviewItems: [],
    routineClarificationsPaused: false,
    processedBatches: [],
  };
}

function snapshot(
  memory: PatientClinicalMemory,
  id: string,
  sequence: number,
  body: string,
  overrides: Partial<PatientClinicalSnapshot> = {},
): PatientClinicalSnapshot {
  return {
    memory,
    inboundMessage: { id, sequence, body },
    consentEpoch: 1,
    expectedConsentEpoch: 1,
    medications: MEDICATIONS,
    doses: DOSES,
    symptomConcepts: ['nausea'],
    languageDisposition: 'english',
    emergencyPrefilter: false,
    contextHash: HASH,
    pipelineVersions: CURRENT_CLINICAL_PIPELINE_VERSIONS,
    ...overrides,
  };
}

function symptomClaim(
  quote: string,
  symptomText: string,
): Extract<ExtractedClaim, { kind: 'symptom' }> {
  return { slot: 'symptom-seed', kind: 'symptom', quote, ...eligible, symptomText };
}

function turn(
  memory: PatientClinicalMemory,
  id: string,
  sequence: number,
  body: string,
  claims: readonly ExtractedClaim[],
  overrides: Partial<PatientClinicalSnapshot> = {},
): { memory: PatientClinicalMemory; prepared: ReturnType<typeof prepareClinicalTurn> } {
  const prepared = prepareClinicalTurn(snapshot(memory, id, sequence, body, overrides), claims);
  return { memory: applyPreparedClinicalTurn(memory, prepared).memory, prepared };
}

/** Seeds a single open->asked severity need via a clean symptom report (the ONLY need, so
 * selectQuestion asks it immediately). */
function askSeverityNeed(): { memory: PatientClinicalMemory; askedNeedId: string } {
  const body = 'Nausea today.';
  const result = turn(emptyMemory(), 'seed-1', 1, body, [symptomClaim('Nausea', 'nausea')]);
  const asked = result.memory.needs.find(({ state }) => state === 'asked');
  if (asked?.field !== 'severity') throw new Error('expected_asked_severity_need');
  return { memory: result.memory, askedNeedId: asked.id };
}

const METAQUESTION_BODY = 'What do you want to know what was your question';
const PROMPTED_DOSE_RESTATE =
  'Just following up on my earlier question. Have you taken your metformin yet? ' +
  'A quick yes or no works, or tell me more.';
const SAVED_FOR_DOCTOR = 'Thanks. I saved this update for your doctor to review.';

describe('Lane Q — RE-ASK ROUTE (2026-08-17 live incident)', () => {
  it('restates the pending prompted-dose check-in appended to a budget_exhausted human_review reply — the exact live transcript case', () => {
    const failureSnapshot = snapshot(emptyMemory(), 'message-1', 1, METAQUESTION_BODY, {
      promptedDoseId: 'dose-metformin',
    });

    const prepared = prepareClinicalFailureTurn(failureSnapshot, 'budget_exhausted');

    expect(prepared.responsePlan.kind).toBe('human_review');
    expect(prepared.responsePlan.pendingReask).toEqual({
      kind: 'prompted_dose',
      doseId: 'dose-metformin',
      medicationLabel: 'metformin',
    });
    expect(prepared.responseText).toBe(`${SAVED_FOR_DOCTOR} ${PROMPTED_DOSE_RESTATE}`);
  });

  it('also restates on the malformed_output terminal-extraction-failure path (not only budget_exhausted)', () => {
    const failureSnapshot = snapshot(emptyMemory(), 'message-1', 1, METAQUESTION_BODY, {
      promptedDoseId: 'dose-metformin',
    });

    const prepared = prepareClinicalFailureTurn(failureSnapshot, 'malformed_output');

    expect(prepared.responseText).toBe(`${SAVED_FOR_DOCTOR} ${PROMPTED_DOSE_RESTATE}`);
  });

  it('rule (a) — clean-empty turn with an asked need restates it via the pre-existing question.reask branch, unaffected', () => {
    const seeded = askSeverityNeed();

    const { prepared } = turn(seeded.memory, 'message-2', 2, METAQUESTION_BODY, []);

    expect(prepared.responsePlan.kind).toBe('question');
    expect(prepared.responsePlan.question).toMatchObject({
      needId: seeded.askedNeedId,
      field: 'severity',
      reask: true,
    });
    expect(prepared.responsePlan.pendingReask).toBeUndefined();
  });

  it('rule (a) — clean-empty turn with NO asked need restates an unanswered prompted dose check-in instead of the orientation reply', () => {
    const prepared = prepareClinicalTurn(
      snapshot(emptyMemory(), 'message-1', 1, METAQUESTION_BODY, {
        promptedDoseId: 'dose-metformin',
      }),
      [],
    );

    expect(prepared.responsePlan).toMatchObject({
      kind: 'routine',
      pendingReask: { kind: 'prompted_dose', medicationLabel: 'metformin' },
    });
    expect(prepared.responsePlan.acknowledgementId).toBeUndefined();
    expect(prepared.responseText).toBe(PROMPTED_DOSE_RESTATE);
  });

  it('rule (b) — human_review append restates an asked need (not only the prompted-dose fallback)', () => {
    const seeded = askSeverityNeed();
    // Deliberately mismatched leading whitespace: the quote never occurs verbatim in the body,
    // so validateExtractedClaims throws quote_not_exact and the catch block takes over.
    const badClaim = symptomClaim('  Nausea', 'nausea');

    const prepared = prepareClinicalTurn(snapshot(seeded.memory, 'message-2', 2, 'x'), [badClaim]);

    expect(prepared.responsePlan.kind).toBe('human_review');
    expect(prepared.responsePlan.reviewReasons).toEqual(['quote_not_exact']);
    expect(prepared.responsePlan.pendingReask).toMatchObject({ kind: 'need', field: 'severity' });
    expect(prepared.responseText.startsWith(SAVED_FOR_DOCTOR)).toBe(true);
    expect(prepared.responseText).toContain('Just following up on my earlier question.');
    expect(prepared.responseText).toContain('what number from 1 to 10');
  });

  it('rule (c) — never restates on the deterministic emergency/STOP/unsupported_language/stale_snapshot paths, even with an asked need and a pending dose', () => {
    const seeded = askSeverityNeed();
    const overrides = { promptedDoseId: 'dose-metformin' } as const;

    const emergency = prepareClinicalTurn(
      snapshot(seeded.memory, 'message-e', 2, 'help', { ...overrides, emergencyPrefilter: true }),
      [],
    );
    expect(emergency.responsePlan.kind).toBe('emergency');
    expect(emergency.responsePlan.pendingReask).toBeUndefined();

    const stop = prepareClinicalTurn(
      snapshot(seeded.memory, 'message-s', 2, 'STOP', { ...overrides, exactControl: 'STOP' }),
      [],
    );
    expect(stop.responsePlan.kind).toBe('stop');
    expect(stop.responsePlan.pendingReask).toBeUndefined();

    const unsupported = prepareClinicalTurn(
      snapshot(seeded.memory, 'message-u', 2, 'bonjour', {
        ...overrides,
        languageDisposition: 'unsupported',
      }),
      [],
    );
    expect(unsupported.responsePlan.kind).toBe('unsupported_language');
    expect(unsupported.responsePlan.pendingReask).toBeUndefined();

    const stale = prepareClinicalTurn(
      snapshot(seeded.memory, 'message-st', 2, 'x', { ...overrides, expectedConsentEpoch: 2 }),
      [],
    );
    expect(stale.responsePlan.kind).toBe('stale_snapshot');
    expect(stale.responsePlan.pendingReask).toBeUndefined();

    const bypassedFailure = prepareClinicalFailureTurn(
      snapshot(seeded.memory, 'message-rf', 2, 'x', { ...overrides, exactControl: 'STOP' }),
      'malformed_output',
    );
    expect(bypassedFailure.responsePlan.kind).toBe('stop');
    expect(bypassedFailure.responsePlan.pendingReask).toBeUndefined();
  });

  it('bounded badgering — restates the prompted-dose check-in at most once across back-to-back failure turns', () => {
    const first = prepareClinicalFailureTurn(
      snapshot(emptyMemory(), 'message-1', 1, METAQUESTION_BODY, {
        promptedDoseId: 'dose-metformin',
      }),
      'budget_exhausted',
    );
    expect(first.responsePlan.pendingReask).toEqual({
      kind: 'prompted_dose',
      doseId: 'dose-metformin',
      medicationLabel: 'metformin',
    });
    const memoryAfterFirst = applyPreparedClinicalTurn(emptyMemory(), first).memory;

    const second = prepareClinicalFailureTurn(
      snapshot(memoryAfterFirst, 'message-2', 2, 'still nothing', {
        promptedDoseId: 'dose-metformin',
      }),
      'budget_exhausted',
    );

    expect(second.responsePlan.pendingReask).toBeUndefined();
    expect(second.responseText).toBe(SAVED_FOR_DOCTOR);
  });

  it('never restates while an unresolved emergency safety pause is active — need flavor, failure path', () => {
    const seeded = askSeverityNeed();
    const paused = turn(seeded.memory, 'message-e', 2, 'help', [], {
      emergencyPrefilter: true,
    }).memory;
    expect(paused.routineClarificationsPaused).toBe(true);

    const prepared = prepareClinicalFailureTurn(
      snapshot(paused, 'message-3', 3, METAQUESTION_BODY, { promptedDoseId: 'dose-metformin' }),
      'budget_exhausted',
    );

    expect(prepared.responsePlan.pendingReask).toBeUndefined();
    expect(prepared.responseText).toBe(SAVED_FOR_DOCTOR);
  });

  it('never restates while an unresolved emergency safety pause is active — prompted-dose flavor, extraction-failure path', () => {
    const paused = turn(emptyMemory(), 'message-e', 1, 'help', [], {
      emergencyPrefilter: true,
    }).memory;

    const prepared = prepareClinicalTurn(
      snapshot(paused, 'message-2', 2, 'x', { promptedDoseId: 'dose-metformin' }),
      // Mismatched quote: validateExtractedClaims throws quote_not_exact into the catch block.
      [symptomClaim('  Nausea', 'nausea')],
    );

    expect(prepared.responsePlan.kind).toBe('human_review');
    expect(prepared.responsePlan.pendingReask).toBeUndefined();
    expect(prepared.responseText).toBe(SAVED_FOR_DOCTOR);
  });

  it('restates a pending check-in ONCE per check-in, not every other turn, across a run of failures', () => {
    let memory = emptyMemory();
    const texts: string[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const prepared = prepareClinicalFailureTurn(
        snapshot(memory, `message-${index}`, index, METAQUESTION_BODY, {
          promptedDoseId: 'dose-metformin',
        }),
        'budget_exhausted',
      );
      texts.push(prepared.responseText);
      memory = applyPreparedClinicalTurn(memory, prepared).memory;
    }

    expect(texts.filter((text) => text.includes('Just following up'))).toHaveLength(1);
    expect(texts[0]).toBe(`${SAVED_FOR_DOCTOR} ${PROMPTED_DOSE_RESTATE}`);
    expect(texts.slice(1)).toEqual([
      SAVED_FOR_DOCTOR,
      SAVED_FOR_DOCTOR,
      SAVED_FOR_DOCTOR,
      SAVED_FOR_DOCTOR,
    ]);
  });

  it('restates again for the NEXT check-in — the once-only bound is per pending question, not forever', () => {
    const first = prepareClinicalFailureTurn(
      snapshot(emptyMemory(), 'message-1', 1, METAQUESTION_BODY, {
        promptedDoseId: 'dose-metformin',
      }),
      'budget_exhausted',
    );
    const memory = applyPreparedClinicalTurn(emptyMemory(), first).memory;
    const nextDayDose = {
      ...DOSES[0]!,
      id: 'dose-metformin-next',
      localDate: '2026-08-18',
    };

    const second = prepareClinicalFailureTurn(
      snapshot(memory, 'message-2', 2, METAQUESTION_BODY, {
        doses: [...DOSES, nextDayDose],
        promptedDoseId: nextDayDose.id,
      }),
      'budget_exhausted',
    );

    expect(second.responsePlan.pendingReask).toMatchObject({ kind: 'prompted_dose' });
    expect(second.responseText).toBe(`${SAVED_FOR_DOCTOR} ${PROMPTED_DOSE_RESTATE}`);
  });

  it('a suppressed record-only turn never consumes the restate — the surviving turn still asks', () => {
    const suppressed = turn(emptyMemory(), 'message-1', 1, 'ok', [], {
      promptedDoseId: 'dose-metformin',
      newerInboundExists: true,
    });

    expect(suppressed.prepared.responsePlan.pendingReask).toBeUndefined();

    const surviving = prepareClinicalTurn(
      snapshot(suppressed.memory, 'message-2', 2, METAQUESTION_BODY, {
        promptedDoseId: 'dose-metformin',
      }),
      [],
    );

    expect(surviving.responsePlan.pendingReask).toMatchObject({ kind: 'prompted_dose' });
    expect(surviving.responseText).toBe(PROMPTED_DOSE_RESTATE);
  });

  it('never restates on a record-only turn (a newer inbound is already waiting)', () => {
    const failureSnapshot = snapshot(emptyMemory(), 'message-1', 1, METAQUESTION_BODY, {
      promptedDoseId: 'dose-metformin',
      newerInboundExists: true,
    });

    const prepared = prepareClinicalFailureTurn(failureSnapshot, 'budget_exhausted');

    expect(prepared.responsePlan.pendingReask).toBeUndefined();
    expect(prepared.responseText).toBe(SAVED_FOR_DOCTOR);
  });
});
