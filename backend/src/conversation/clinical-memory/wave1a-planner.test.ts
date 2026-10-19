import { describe, expect, it } from 'vitest';
import {
  applyPreparedClinicalTurn,
  ASKED_NEED_EXPIRY_SUBSTANTIVE_TURNS,
  CURRENT_CLINICAL_PIPELINE_VERSIONS,
  EXPIRED_NEED_ANSWER_GRACE_TURNS,
  prepareClinicalTurn,
  reducePatientClinicalMemory,
  type ClinicalIntentCommand,
  type ExtractedClaim,
  type PatientClinicalMemory,
  type PatientClinicalSnapshot,
} from './index.js';
import { CLINICAL_RENDERER_VERSION } from './response.js';
import { sha256 } from './hash.js';

const HASH = '0'.repeat(64);
const eligible = {
  polarity: 'positive',
  experiencer: 'patient',
  status: 'current',
  certainty: 'certain',
} as const;

const medications: PatientClinicalSnapshot['medications'] = [
  { id: 'med-alpha', version: 1, names: ['alpha'], aliases: ['morning pill'], active: true },
  { id: 'med-beta', version: 1, names: ['beta'], aliases: ['morning pill'], active: true },
  { id: 'med-gamma', version: 1, names: ['gamma'], aliases: [], active: true },
];
const doses: PatientClinicalSnapshot['doses'] = [
  {
    id: 'dose-alpha',
    version: 1,
    medicationId: 'med-alpha',
    label: 'alpha dose',
    localDate: '2026-08-13',
    localTime: '08:00',
  },
  {
    id: 'dose-beta',
    version: 1,
    medicationId: 'med-beta',
    label: 'beta dose',
    localDate: '2026-08-13',
    localTime: '09:00',
  },
  {
    id: 'dose-gamma',
    version: 1,
    medicationId: 'med-gamma',
    label: 'gamma dose',
    localDate: '2026-08-13',
    localTime: '10:00',
  },
];

function emptyMemory(): PatientClinicalMemory {
  return {
    patientId: 'patient-wave1a',
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
    medications,
    doses,
    symptomConcepts: ['nausea', 'tingling'],
    languageDisposition: 'english',
    emergencyPrefilter: false,
    contextHash: HASH,
    pipelineVersions: CURRENT_CLINICAL_PIPELINE_VERSIONS,
    ...overrides,
  };
}

function administration(
  slot: string,
  body: string,
  quote: string,
  medicationText: string,
  actionText: string,
): Extract<ExtractedClaim, { kind: 'administration' }> {
  if (!body.includes(quote)) throw new Error('test_quote_missing');
  return { slot, kind: 'administration', quote, ...eligible, medicationText, actionText };
}

function symptom(
  slot: string,
  body: string,
  quote: string,
  symptomText: string,
): Extract<ExtractedClaim, { kind: 'symptom' }> {
  if (!body.includes(quote)) throw new Error('test_quote_missing');
  return { slot, kind: 'symptom', quote, ...eligible, symptomText };
}

function needAnswer(
  slot: string,
  body: string,
  quote: string,
  answerField: 'medication_identity' | 'severity',
  answerText: string,
): Extract<ExtractedClaim, { kind: 'need_answer' }> {
  if (!body.includes(quote)) throw new Error('test_quote_missing');
  return { slot, kind: 'need_answer', quote, ...eligible, answerField, answerText };
}

function social(slot: string, quote: string): Extract<ExtractedClaim, { kind: 'social' }> {
  return { slot, kind: 'social', quote, ...eligible };
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

/** m1 asks the medication-identity question that nothing later answers (the deadlock seed). */
function askAmbiguousAdministration(memory: PatientClinicalMemory): {
  memory: PatientClinicalMemory;
  askedNeedId: string;
} {
  const body = 'I took my morning pill.';
  const result = turn(memory, 'message-1', 1, body, [
    administration('slot-ambiguous', body, 'took my morning pill', 'morning pill', 'took'),
  ]);
  const asked = result.memory.needs.find(({ state }) => state === 'asked');
  if (asked?.field !== 'medication_identity') throw new Error('expected_asked_medication_need');
  return { memory: result.memory, askedNeedId: asked.id };
}

/** One substantive turn: records a gamma administration (create, then refines on repeats). */
function substantiveTurn(
  memory: PatientClinicalMemory,
  id: string,
  sequence: number,
): PatientClinicalMemory {
  const body = 'I took gamma.';
  const result = turn(memory, id, sequence, body, [
    administration(`slot-${id}`, body, 'took gamma', 'gamma', 'took'),
  ]);
  const receipt = result.memory.processedBatches.at(-1);
  if ((receipt?.eventIds.length ?? 0) === 0) throw new Error('expected_substantive_receipt');
  return result.memory;
}

describe('wave 1a — asked-need deadlock expiry', () => {
  it('pins the substantive-turn expiry and grace constants', () => {
    expect(ASKED_NEED_EXPIRY_SUBSTANTIVE_TURNS).toBe(3);
    expect(EXPIRED_NEED_ANSWER_GRACE_TURNS).toBe(1);
  });

  it('keeps the renderer pipeline version aligned with the renderer lane', () => {
    expect(CURRENT_CLINICAL_PIPELINE_VERSIONS.renderer).toBe(CLINICAL_RENDERER_VERSION);
  });

  it('expires an unanswered asked need after N substantive turns and asks the next question', () => {
    const seeded = askAmbiguousAdministration(emptyMemory());
    const { askedNeedId } = seeded;
    let memory = seeded.memory;
    memory = substantiveTurn(memory, 'message-2', 2);
    const nauseaBody = 'Nausea today.';
    ({ memory } = turn(memory, 'message-3', 3, nauseaBody, [
      symptom('slot-nausea', nauseaBody, 'Nausea', 'nausea'),
    ]));
    memory = substantiveTurn(memory, 'message-4', 4);
    expect(memory.needs.find(({ id }) => id === askedNeedId)?.state).toBe('asked');

    const { memory: after, prepared } = turn(memory, 'message-5', 5, 'ok', [social('s5', 'ok')]);
    expect(
      prepared.commands.some(
        (command) => command.kind === 'ExpireInformationNeed' && command.needId === askedNeedId,
      ),
    ).toBe(true);
    const expired = after.needs.find(({ id }) => id === askedNeedId);
    expect(expired?.state).toBe('expired');
    expect(expired?.expiredAtInboundMessageId).toBe('message-5');
    // The next open question (the nausea severity need) becomes askable in the SAME turn.
    const nowAsked = after.needs.find(({ state }) => state === 'asked');
    expect(nowAsked?.field).toBe('severity');
    expect(prepared.responsePlan.question?.needId).toBe(nowAsked?.id);
  });

  it('does not expire while fewer than N substantive turns have passed (fragments do not count)', () => {
    const seeded = askAmbiguousAdministration(emptyMemory());
    const { askedNeedId } = seeded;
    let memory = seeded.memory;
    memory = substantiveTurn(memory, 'message-2', 2);
    // Two fragment turns: zero commands, empty receipts.
    ({ memory } = turn(memory, 'message-3', 3, 'ok', [social('s3', 'ok')]));
    ({ memory } = turn(memory, 'message-4', 4, 'thanks', [social('s4', 'thanks')]));
    const { memory: after, prepared } = turn(memory, 'message-5', 5, 'ok again', [
      social('s5', 'ok again'),
    ]);
    expect(prepared.commands.some(({ kind }) => kind === 'ExpireInformationNeed')).toBe(false);
    expect(after.needs.find(({ id }) => id === askedNeedId)?.state).toBe('asked');
  });

  it('expires an asked need at the day boundary regardless of turn distance', () => {
    const { memory, askedNeedId } = askAmbiguousAdministration(emptyMemory());
    const { memory: after, prepared } = turn(memory, 'message-2', 2, 'ok', [social('s2', 'ok')], {
      overnightAskedNeedIds: [askedNeedId],
    });
    expect(
      prepared.commands.some(
        (command) => command.kind === 'ExpireInformationNeed' && command.needId === askedNeedId,
      ),
    ).toBe(true);
    expect(after.needs.find(({ id }) => id === askedNeedId)?.state).toBe('expired');
    expect(prepared.responsePlan).toMatchObject({
      kind: 'routine',
      acknowledgementId: 'acknowledgement-recorded',
    });
  });

  it('still resolves an expired need from a late clear answer within the grace window', () => {
    const seeded = askAmbiguousAdministration(emptyMemory());
    const { askedNeedId } = seeded;
    let memory = seeded.memory;
    memory = substantiveTurn(memory, 'message-2', 2);
    memory = substantiveTurn(memory, 'message-3', 3);
    const nauseaBody = 'Nausea today.';
    ({ memory } = turn(memory, 'message-4', 4, nauseaBody, [
      symptom('slot-nausea', nauseaBody, 'Nausea', 'nausea'),
    ]));
    ({ memory } = turn(memory, 'message-5', 5, 'ok', [social('s5', 'ok')]));
    expect(memory.needs.find(({ id }) => id === askedNeedId)?.state).toBe('expired');
    const targetEventId = memory.needs.find(({ id }) => id === askedNeedId)?.targetEventId;

    const { memory: after, prepared } = turn(memory, 'message-6', 6, 'alpha', [
      needAnswer('slot-answer', 'alpha', 'alpha', 'medication_identity', 'alpha'),
    ]);
    expect(
      prepared.commands.some(
        (command) => command.kind === 'ResolveInformationNeed' && command.needId === askedNeedId,
      ),
    ).toBe(true);
    expect(after.needs.find(({ id }) => id === askedNeedId)?.state).toBe('resolved');
    const refined = after.events.find(
      (event) => event.current && event.supersedesEventId === targetEventId,
    );
    expect(refined).toMatchObject({ medicationId: 'med-alpha', doseId: 'dose-alpha' });
  });

  it('leaves an expired need inert once the grace window has passed', () => {
    const seeded = askAmbiguousAdministration(emptyMemory());
    const { askedNeedId } = seeded;
    let memory = seeded.memory;
    memory = substantiveTurn(memory, 'message-2', 2);
    memory = substantiveTurn(memory, 'message-3', 3);
    const nauseaBody = 'Nausea today.';
    ({ memory } = turn(memory, 'message-4', 4, nauseaBody, [
      symptom('slot-nausea', nauseaBody, 'Nausea', 'nausea'),
    ]));
    ({ memory } = turn(memory, 'message-5', 5, 'ok', [social('s5', 'ok')]));
    // One substantive turn AFTER the expiry closes the grace window.
    memory = substantiveTurn(memory, 'message-6', 6);

    const { memory: after, prepared } = turn(memory, 'message-7', 7, 'alpha', [
      needAnswer('slot-late', 'alpha', 'alpha', 'medication_identity', 'alpha'),
    ]);
    expect(prepared.commands.some(({ kind }) => kind === 'ResolveInformationNeed')).toBe(false);
    expect(after.needs.find(({ id }) => id === askedNeedId)?.state).toBe('expired');
    expect(
      after.unresolvedReports.some(({ reason }) => reason === 'pending_target_ambiguous'),
    ).toBe(true);
  });

  it('reducer refuses to resolve an expired need beyond the grace window (fail closed)', () => {
    const seeded = askAmbiguousAdministration(emptyMemory());
    const { askedNeedId } = seeded;
    let memory = seeded.memory;
    memory = substantiveTurn(memory, 'message-2', 2);
    memory = substantiveTurn(memory, 'message-3', 3);
    memory = substantiveTurn(memory, 'message-4', 4);
    ({ memory } = turn(memory, 'message-5', 5, 'ok', [social('s5', 'ok')]));
    memory = substantiveTurn(memory, 'message-6', 6);
    const need = memory.needs.find(({ id }) => id === askedNeedId);
    if (need === undefined) throw new Error('expected_expired_need');
    const intent = {
      kind: 'ResolveInformationNeed' as const,
      sourceMessageId: 'message-7',
      sourceSpans: [{ messageId: 'message-7', start: 0, end: 5, quote: 'alpha' }],
      needId: need.id,
      expectedNeedVersion: need.version,
    };
    const command: ClinicalIntentCommand = {
      ...intent,
      id: `command-${sha256(intent).slice(0, 24)}`,
    } as ClinicalIntentCommand;
    expect(() => reducePatientClinicalMemory(memory, [command])).toThrow('stale_information_need');
  });
});

describe('wave 1a — turn-start record-only suppression (chat-style batching)', () => {
  it('records claims without asking, marks the turn record-only, and leaves needs open', () => {
    const body = 'I took my morning pill.';
    const prepared = prepareClinicalTurn(
      snapshot(emptyMemory(), 'message-1', 1, body, { newerInboundExists: true }),
      [administration('slot-ambiguous', body, 'took my morning pill', 'morning pill', 'took')],
    );
    expect(prepared.recordOnly).toBe(true);
    expect(prepared.commands.some(({ kind }) => kind === 'OpenInformationNeed')).toBe(true);
    expect(prepared.commands.some(({ kind }) => kind === 'AskInformationNeed')).toBe(false);
    expect(prepared.responsePlan.kind).toBe('routine');
    const after = applyPreparedClinicalTurn(emptyMemory(), prepared).memory;
    expect(after.needs.map(({ state }) => state)).toEqual(['open']);
  });

  it('never marks a deterministic STOP or emergency turn record-only', () => {
    const stop = prepareClinicalTurn(
      snapshot(emptyMemory(), 'message-1', 1, 'STOP', {
        newerInboundExists: true,
        exactControl: 'STOP',
      }),
      [],
    );
    expect(stop.responsePlan.kind).toBe('stop');
    expect(stop.recordOnly).toBeUndefined();
    const emergency = prepareClinicalTurn(
      snapshot(emptyMemory(), 'message-1', 1, 'I cannot breathe', {
        newerInboundExists: true,
        emergencyPrefilter: true,
      }),
      [],
    );
    expect(emergency.responsePlan.kind).toBe('emergency');
    expect(emergency.recordOnly).toBeUndefined();
  });

  it('lets the surviving turn aggregate the suppressed burst: one reply covers all recordings', () => {
    // Burst message 1 (suppressed): ambiguous administration -> event + open need + review reason.
    const body1 = 'I took my morning pill.';
    const first = prepareClinicalTurn(
      snapshot(emptyMemory(), 'message-1', 1, body1, { newerInboundExists: true }),
      [administration('slot-1', body1, 'took my morning pill', 'morning pill', 'took')],
    );
    const memory1 = applyPreparedClinicalTurn(emptyMemory(), first).memory;
    // Burst message 2 (suppressed): plain gamma administration recording.
    const body2 = 'I took gamma.';
    const second = prepareClinicalTurn(
      snapshot(memory1, 'message-2', 2, body2, { newerInboundExists: true }),
      [administration('slot-2', body2, 'took gamma', 'gamma', 'took')],
    );
    const memory2 = applyPreparedClinicalTurn(memory1, second).memory;
    expect(second.recordOnly).toBe(true);

    // Survivor: aggregates the whole burst — the open question and the recorded review reasons.
    const openNeed = memory2.needs.find(({ state }) => state === 'open');
    if (openNeed === undefined) throw new Error('expected_open_burst_need');
    const body3 = 'ok';
    const survivor = prepareClinicalTurn(
      snapshot(memory2, 'message-3', 3, body3, {
        suppressedBurstInboundMessageIds: ['message-1', 'message-2'],
      }),
      [social('slot-3', 'ok')],
    );
    expect(survivor.recordOnly).toBeUndefined();
    expect(survivor.responsePlan.kind).toBe('question');
    expect(survivor.responsePlan.question?.needId).toBe(openNeed.id);
    expect(survivor.responsePlan.reviewReasons).toContain('medication_ambiguous');
    const memory3 = applyPreparedClinicalTurn(memory2, survivor).memory;
    expect(memory3.needs.filter(({ state }) => state === 'asked')).toHaveLength(1);
  });
});

describe('wave 1a — planner-side orientation and re-ask', () => {
  it('sets the orientation acknowledgement for a zero-command, no-question, no-reason turn', () => {
    const prepared = prepareClinicalTurn(snapshot(emptyMemory(), 'message-1', 1, 'hello'), []);
    expect(prepared.commands).toHaveLength(0);
    expect(prepared.responsePlan).toMatchObject({
      kind: 'routine',
      acknowledgementId: 'acknowledgement-orientation',
    });
  });

  it('keeps the recorded acknowledgement when a suppressed burst recorded clinical content', () => {
    // Burst: two clean gamma recordings, both suppressed (record-only). Neither opens a need.
    const body1 = 'I took gamma.';
    const first = prepareClinicalTurn(
      snapshot(emptyMemory(), 'message-1', 1, body1, { newerInboundExists: true }),
      [administration('slot-1', body1, 'took gamma', 'gamma', 'took')],
    );
    const memory1 = applyPreparedClinicalTurn(emptyMemory(), first).memory;
    const body2 = 'I took gamma.';
    const second = prepareClinicalTurn(
      snapshot(memory1, 'message-2', 2, body2, { newerInboundExists: true }),
      [administration('slot-2', body2, 'took gamma', 'gamma', 'took')],
    );
    const memory2 = applyPreparedClinicalTurn(memory1, second).memory;
    expect(memory2.needs).toHaveLength(0);

    // Survivor is content-free, but its ONE reply covers the burst: the patient just reported
    // doses, so the acknowledgement must say "recorded", never the orientation blurb.
    const survivor = prepareClinicalTurn(
      snapshot(memory2, 'message-3', 3, 'ok', {
        suppressedBurstInboundMessageIds: ['message-1', 'message-2'],
      }),
      [social('slot-3', 'ok')],
    );
    expect(survivor.commands).toHaveLength(0);
    expect(survivor.responsePlan).toMatchObject({
      kind: 'routine',
      acknowledgementId: 'acknowledgement-recorded',
    });
  });

  it('keeps the orientation acknowledgement when the whole burst was content-free', () => {
    // Burst of fragments: receipts exist but commit nothing substantive.
    const first = prepareClinicalTurn(
      snapshot(emptyMemory(), 'message-1', 1, 'hi', { newerInboundExists: true }),
      [social('slot-1', 'hi')],
    );
    const memory1 = applyPreparedClinicalTurn(emptyMemory(), first).memory;
    const survivor = prepareClinicalTurn(
      snapshot(memory1, 'message-2', 2, 'hello', {
        suppressedBurstInboundMessageIds: ['message-1'],
      }),
      [social('slot-2', 'hello')],
    );
    expect(survivor.responsePlan).toMatchObject({
      kind: 'routine',
      acknowledgementId: 'acknowledgement-orientation',
    });
  });

  it('keeps the recorded acknowledgement whenever the turn produced commands', () => {
    const body = 'I took gamma.';
    const prepared = prepareClinicalTurn(snapshot(emptyMemory(), 'message-1', 1, body), [
      administration('slot-1', body, 'took gamma', 'gamma', 'took'),
    ]);
    expect(prepared.responsePlan).toMatchObject({
      kind: 'routine',
      acknowledgementId: 'acknowledgement-recorded',
    });
  });

  it('re-asks a pending question as a response-plan-only branch without a reducer command', () => {
    const { memory, askedNeedId } = askAmbiguousAdministration(emptyMemory());
    const body = 'I took gamma.';
    const prepared = prepareClinicalTurn(snapshot(memory, 'message-2', 2, body), [
      administration('slot-2', body, 'took gamma', 'gamma', 'took'),
    ]);
    expect(prepared.responsePlan.kind).toBe('question');
    expect(prepared.responsePlan.question).toMatchObject({
      needId: askedNeedId,
      field: 'medication_identity',
      reask: true,
    });
    expect(prepared.commands.some(({ kind }) => kind === 'AskInformationNeed')).toBe(false);
    // The re-ask commits cleanly: the need stays asked at its existing version.
    const after = applyPreparedClinicalTurn(memory, prepared).memory;
    expect(after.needs.find(({ id }) => id === askedNeedId)?.state).toBe('asked');
  });

  it('falls back to a plain acknowledgement when a re-ask would need a missing target label', () => {
    // Ask a severity question (label-required field) whose concept later disappears.
    const nauseaBody = 'Nausea today.';
    const { memory } = turn(emptyMemory(), 'message-1', 1, nauseaBody, [
      symptom('slot-nausea', nauseaBody, 'Nausea', 'nausea'),
    ]);
    expect(memory.needs.find(({ state }) => state === 'asked')?.field).toBe('severity');
    const body = 'I took gamma.';
    const prepared = prepareClinicalTurn(
      snapshot(memory, 'message-2', 2, body, { symptomConcepts: ['tingling'] }),
      [administration('slot-2', body, 'took gamma', 'gamma', 'took')],
    );
    expect(prepared.responsePlan.kind).toBe('routine');
    expect(prepared.responsePlan.acknowledgementId).toBe('acknowledgement-recorded');
    expect(prepared.responsePlan.reviewReasons).not.toContain('question_target_label_missing');
  });

  it('does not re-ask on a record-only turn', () => {
    const { memory, askedNeedId } = askAmbiguousAdministration(emptyMemory());
    const prepared = prepareClinicalTurn(
      snapshot(memory, 'message-2', 2, 'ok', { newerInboundExists: true }),
      [social('slot-2', 'ok')],
    );
    expect(prepared.recordOnly).toBe(true);
    expect(prepared.responsePlan.kind).toBe('routine');
    const after = applyPreparedClinicalTurn(memory, prepared).memory;
    expect(after.needs.find(({ id }) => id === askedNeedId)?.state).toBe('asked');
  });
});
