import { describe, expect, it } from 'vitest';

import {
  applyPreparedClinicalTurn,
  patientClinicalMemorySchema,
  patientClinicalSnapshotSchema,
  prepareClinicalTurn,
  type ClinicalEvent,
  type ExtractedClaim,
  type PatientClinicalMemory,
  type PatientClinicalSnapshot,
  type PreparedClinicalTurn,
} from './index.js';

const HASH = '0'.repeat(64);
const PIPELINE_VERSIONS = {
  extractor: 'extractor-v1',
  resolver: 'resolver-v1',
  reducer: 'reducer-v1',
  renderer: 'renderer-v1',
} as const;
const ELIGIBLE = {
  polarity: 'positive',
  experiencer: 'patient',
  status: 'current',
  certainty: 'certain',
} as const;
const MEDICATIONS: PatientClinicalSnapshot['medications'] = [
  { id: 'med-alpha', version: 7, names: ['alpha'], aliases: [], active: true },
];
const DOSES: PatientClinicalSnapshot['doses'] = [
  {
    id: 'dose-alpha',
    version: 11,
    medicationId: 'med-alpha',
    label: 'alpha morning dose',
    localDate: '2026-08-13',
    localTime: '08:00',
  },
];

function emptyMemory(patientId = 'patient-alpha'): PatientClinicalMemory {
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
  memory = emptyMemory(),
  overrides: Partial<PatientClinicalSnapshot> = {},
): PatientClinicalSnapshot {
  return {
    memory,
    inboundMessage: { id: 'message-alpha', sequence: 1, body: 'I took alpha.' },
    consentEpoch: 1,
    expectedConsentEpoch: 1,
    medications: MEDICATIONS,
    doses: DOSES,
    symptomConcepts: [],
    languageDisposition: 'english',
    emergencyPrefilter: false,
    contextHash: HASH,
    pipelineVersions: PIPELINE_VERSIONS,
    ...overrides,
  };
}

function administrationClaim(quote = 'took alpha'): ExtractedClaim {
  return {
    slot: 'administration',
    kind: 'administration',
    quote,
    ...ELIGIBLE,
    medicationText: 'alpha',
    actionText: 'took',
  };
}

function prepareAdministration(memory = emptyMemory()): PreparedClinicalTurn {
  return prepareClinicalTurn(snapshot(memory), [administrationClaim()]);
}

function canonicalAdministration(overrides: Partial<ClinicalEvent> = {}): ClinicalEvent {
  const quote = 'took alpha';
  return {
    id: 'event-alpha',
    version: 1,
    kind: 'administration',
    operation: 'create',
    authoredBy: 'patient',
    reviewState: 'unreviewed',
    current: true,
    canonical: true,
    sourceMessageIds: ['message-alpha'],
    sourceSpans: [{ messageId: 'message-alpha', start: 0, end: quote.length, quote }],
    medicationId: 'med-alpha',
    medicationVersion: 7,
    doseId: 'dose-alpha',
    doseVersion: 11,
    adherence: 'taken',
    localDate: '2026-08-13',
    localTime: '08:00',
    ...overrides,
  };
}

describe('frozen clinical-memory integrity regressions', () => {
  it('rejects applying a patient-bound prepared batch to another patient aggregate', () => {
    const patientA = emptyMemory('patient-a');
    const preparedForA = prepareAdministration(patientA);

    expect(() => applyPreparedClinicalTurn(emptyMemory('patient-b'), preparedForA)).toThrow();
  });

  it('pins canonical administration identities to doctor-context versions and rejects omissions', () => {
    const committed = applyPreparedClinicalTurn(emptyMemory(), prepareAdministration());
    expect(committed.memory.events).toEqual([
      expect.objectContaining({
        canonical: true,
        medicationId: 'med-alpha',
        medicationVersion: 7,
        doseId: 'dose-alpha',
        doseVersion: 11,
      }),
    ]);

    const incompleteEvents = [
      canonicalAdministration({ medicationId: undefined }),
      canonicalAdministration({ medicationVersion: undefined }),
      canonicalAdministration({ doseId: undefined }),
      canonicalAdministration({ doseVersion: undefined }),
    ];
    for (const event of incompleteEvents) {
      expect(
        patientClinicalMemorySchema.safeParse({ ...emptyMemory(), events: [event] }).success,
      ).toBe(false);
    }
  });

  it('requires exact source-message and source-span set equality for patient-authored canonical events', () => {
    const mismatchedEvents = [
      canonicalAdministration({ sourceMessageIds: [] }),
      canonicalAdministration({ sourceSpans: [] }),
      canonicalAdministration({
        sourceSpans: [
          { messageId: 'message-other', start: 0, end: 'took alpha'.length, quote: 'took alpha' },
        ],
      }),
      canonicalAdministration({ sourceMessageIds: ['message-alpha', 'message-phantom'] }),
    ];

    for (const event of mismatchedEvents) {
      expect(
        patientClinicalMemorySchema.safeParse({ ...emptyMemory(), events: [event] }).success,
      ).toBe(false);
    }
  });

  it('rejects a phantom replay receipt whose recorded outputs are absent', () => {
    const prepared = prepareAdministration();
    const committed = applyPreparedClinicalTurn(emptyMemory(), prepared);
    const phantom: PatientClinicalMemory = { ...committed.memory, events: [] };

    expect(() => applyPreparedClinicalTurn(phantom, prepared)).toThrow();
  });

  it('rejects a phantom replay receipt whose unresolved report effect is absent', () => {
    const prepared = prepareClinicalTurn(snapshot(), [
      { ...administrationClaim(), certainty: 'uncertain' },
    ]);
    const committed = applyPreparedClinicalTurn(emptyMemory(), prepared);
    const unresolvedId = committed.memory.unresolvedReports[0]?.id;
    const phantom: PatientClinicalMemory = { ...committed.memory, unresolvedReports: [] };

    expect(unresolvedId).toBeDefined();
    expect(committed.memory.processedBatches[0]?.unresolvedReportIds).toEqual([unresolvedId]);
    expect(() => applyPreparedClinicalTurn(phantom, prepared)).toThrow();
  });

  it('rejects duplicate replay receipts for one idempotency key', () => {
    const prepared = prepareAdministration();
    const committed = applyPreparedClinicalTurn(emptyMemory(), prepared);
    const receipt = committed.memory.processedBatches[0]!;
    const duplicated: PatientClinicalMemory = {
      ...committed.memory,
      processedBatches: [receipt, { ...receipt }],
    };

    expect(() => applyPreparedClinicalTurn(duplicated, prepared)).toThrow();
  });

  it('accepts turn 1001 and still exactly replays the newest turn', () => {
    let memory = emptyMemory();
    let newestPrepared: PreparedClinicalTurn | undefined;
    for (let turn = 1; turn <= 1_001; turn += 1) {
      newestPrepared = prepareClinicalTurn(
        snapshot(memory, {
          inboundMessage: { id: `message-${turn}`, sequence: turn, body: 'Thanks.' },
        }),
        [],
      );
      memory = applyPreparedClinicalTurn(memory, newestPrepared).memory;
    }

    expect(memory.version).toBe(1_001);
    expect(memory.processedBatches.length).toBeLessThanOrEqual(128);
    expect(applyPreparedClinicalTurn(memory, newestPrepared!).memory).toEqual(memory);
  }, 30_000);

  it('rejects a raw extracted quote whose whitespace does not exactly occur in the message', () => {
    const prepared = prepareClinicalTurn(snapshot(), [administrationClaim('  took alpha')]);

    expect(prepared.responsePlan.kind).toBe('human_review');
    expect(prepared.commands).toEqual([
      expect.objectContaining({
        kind: 'PreserveUnresolvedContent',
        reason: 'quote_not_exact',
      }),
    ]);
  });

  it('maps huge malicious validation text to one bounded allowlisted fallback reason', () => {
    const maliciousKey = `attacker-${'x'.repeat(10_000)}`;
    const malformedClaim = {
      ...administrationClaim(),
      [maliciousKey]: 'untrusted',
    } as unknown as ExtractedClaim;

    const prepared = prepareClinicalTurn(snapshot(), [malformedClaim]);
    expect(prepared.responsePlan).toEqual({
      kind: 'human_review',
      reviewReasons: ['extraction_validation_failed'],
    });
    expect(prepared.commands).toEqual([
      expect.objectContaining({
        kind: 'PreserveUnresolvedContent',
        reason: 'extraction_validation_failed',
      }),
    ]);
    expect(prepared.responsePlan.reviewReasons[0]!.length).toBeLessThanOrEqual(1_000);
  });

  it.each([
    [
      'duplicate medication stable IDs',
      snapshot(emptyMemory(), {
        medications: [MEDICATIONS[0]!, { ...MEDICATIONS[0]!, version: 8 }],
      }),
    ],
    [
      'duplicate dose stable IDs including the prompted dose',
      snapshot(emptyMemory(), {
        doses: [DOSES[0]!, { ...DOSES[0]!, version: 12 }],
        promptedDoseId: 'dose-alpha',
      }),
    ],
    [
      'a dose whose medication ID is absent',
      snapshot(emptyMemory(), {
        doses: [{ ...DOSES[0]!, medicationId: 'med-missing' }],
      }),
    ],
    [
      'a prompted dose ID that is absent',
      snapshot(emptyMemory(), { promptedDoseId: 'dose-missing' }),
    ],
  ])('rejects doctor context with %s', (_label, invalidSnapshot) => {
    expect(patientClinicalSnapshotSchema.safeParse(invalidSnapshot).success).toBe(false);
  });
});
