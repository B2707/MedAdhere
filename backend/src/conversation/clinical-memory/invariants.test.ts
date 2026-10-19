import { expect, it } from 'vitest';
import {
  applyPreparedClinicalTurn,
  prepareClinicalTurn,
  reducePatientClinicalMemory,
  type ClinicalIntentCommand,
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
const snapshot = (body: string): PatientClinicalSnapshot => ({
  memory: emptyMemory(),
  inboundMessage: { id: 'message-invariant', sequence: 1, body },
  consentEpoch: 1,
  expectedConsentEpoch: 1,
  medications: [
    { id: 'med-alpha', version: 1, names: ['alpha'], aliases: [], active: true },
    { id: 'med-beta', version: 1, names: ['beta'], aliases: [], active: true },
  ],
  doses: [
    {
      id: 'dose-alpha',
      version: 1,
      medicationId: 'med-alpha',
      label: 'morning',
      localDate: '2026-08-12',
      localTime: '08:00',
    },
    {
      id: 'dose-beta',
      version: 1,
      medicationId: 'med-beta',
      label: 'morning',
      localDate: '2026-08-12',
      localTime: '08:00',
    },
  ],
  symptomConcepts: ['nausea'],
  languageDisposition: 'english',
  emergencyPrefilter: false,
  contextHash: HASH,
  pipelineVersions: versions,
});
const eligible = {
  polarity: 'positive',
  experiencer: 'patient',
  status: 'current',
  certainty: 'certain',
} as const;

function stripLocalIds(commands: readonly ClinicalIntentCommand[]): unknown {
  return commands.map((command) =>
    Object.fromEntries(Object.entries(command).filter(([key]) => key !== 'id')),
  );
}

it('returns byte-equivalent commands and response when independent input claims are reordered', () => {
  const claims: ExtractedClaim[] = [
    {
      slot: 'a',
      kind: 'administration',
      quote: 'took alpha',
      ...eligible,
      medicationText: 'alpha',
      actionText: 'took',
    },
    {
      slot: 'b',
      kind: 'administration',
      quote: 'missed beta',
      ...eligible,
      medicationText: 'beta',
      actionText: 'missed',
    },
  ];
  const first = prepareClinicalTurn(snapshot('I took alpha and missed beta.'), claims);
  const second = prepareClinicalTurn(
    snapshot('I took alpha and missed beta.'),
    [...claims].reverse(),
  );

  expect(first.commands).toEqual(second.commands);
  expect(first.responsePlan).toEqual(second.responsePlan);
});

it('does not let request-local claim slot names change clinical intent', () => {
  const body = 'I took alpha. Actually I missed alpha.';
  const original: ExtractedClaim[] = [
    {
      slot: 'first',
      kind: 'administration',
      quote: 'took alpha',
      ...eligible,
      medicationText: 'alpha',
      actionText: 'took',
    },
    {
      slot: 'second',
      kind: 'correction',
      quote: 'missed alpha',
      ...eligible,
      targetClaimSlot: 'first',
      medicationText: 'alpha',
      actionText: 'missed',
    },
  ];
  const renamed: ExtractedClaim[] = [
    {
      slot: 'x',
      kind: 'administration',
      quote: 'took alpha',
      ...eligible,
      medicationText: 'alpha',
      actionText: 'took',
    },
    {
      slot: 'y',
      kind: 'correction',
      quote: 'missed alpha',
      ...eligible,
      targetClaimSlot: 'x',
      medicationText: 'alpha',
      actionText: 'missed',
    },
  ];

  expect(stripLocalIds(prepareClinicalTurn(snapshot(body), original).commands)).toEqual(
    stripLocalIds(prepareClinicalTurn(snapshot(body), renamed).commands),
  );
});

it('rejects same idempotency key with a different prepared command batch', () => {
  const prepared = prepareClinicalTurn(snapshot('I took alpha and missed beta.'), [
    {
      slot: 'a',
      kind: 'administration',
      quote: 'took alpha',
      ...eligible,
      medicationText: 'alpha',
      actionText: 'took',
    },
    {
      slot: 'b',
      kind: 'administration',
      quote: 'missed beta',
      ...eligible,
      medicationText: 'beta',
      actionText: 'missed',
    },
  ]);
  const first = applyPreparedClinicalTurn(emptyMemory(), prepared);
  const partialIntegrity = {
    ...prepared,
    commands: prepared.commands.slice(0, 1),
  };
  const forged = {
    ...partialIntegrity,
    commandHash: HASH,
    preparedHash: HASH,
  };

  expect(applyPreparedClinicalTurn(first.memory, prepared)).toEqual(first);
  expect(() => applyPreparedClinicalTurn(first.memory, forged)).toThrow(
    'prepared_batch_integrity_error',
  );
});

it('keeps commands intent-only without projected aggregate objects', () => {
  const prepared = prepareClinicalTurn(snapshot('I took alpha.'), [
    {
      slot: 'a',
      kind: 'administration',
      quote: 'took alpha',
      ...eligible,
      medicationText: 'alpha',
      actionText: 'took',
    },
  ]);

  for (const command of prepared.commands) {
    expect(Object.keys(command)).not.toContain('event');
    expect(Object.keys(command)).not.toContain('need');
    expect(Object.keys(command)).not.toContain('patch');
  }
});

it('keeps frozen candidate scope off clinical events', () => {
  expect(() =>
    reducePatientClinicalMemory(emptyMemory(), [
      {
        id: 'command-candidate-scope',
        kind: 'CreateReport',
        sourceMessageId: 'message-invariant',
        sourceSpans: [],
        eventKind: 'administration',
        adherence: 'taken',
        candidateMedicationIds: ['med-alpha', 'med-beta'],
        candidateDoseIds: ['dose-alpha', 'dose-beta'],
      } as ClinicalIntentCommand,
    ]),
  ).toThrow();
});

it('rejects branching supersession lineage before reducing commands', () => {
  const root: PatientClinicalMemory['events'][number] = {
    id: 'event-root',
    version: 1,
    kind: 'symptom',
    operation: 'create',
    authoredBy: 'patient',
    reviewState: 'unreviewed',
    current: false,
    canonical: true,
    sourceMessageIds: ['message-root'],
    sourceSpans: [],
    rawSymptom: 'nausea',
    symptomConcept: 'nausea',
    symptomStatus: 'current',
  };
  const child = (id: string) => ({
    ...root,
    id,
    version: 2,
    operation: 'refine' as const,
    current: true,
    supersedesEventId: root.id,
  });
  const invalid = {
    ...emptyMemory(),
    events: [root, child('event-child-a'), child('event-child-b')],
  };

  expect(() => reducePatientClinicalMemory(invalid, [])).toThrow('clinical_lineage_invalid');
});

it('rejects a non-leaf marked current before reducing commands', () => {
  const root: PatientClinicalMemory['events'][number] = {
    id: 'event-root',
    version: 1,
    kind: 'symptom',
    operation: 'create',
    authoredBy: 'patient',
    reviewState: 'unreviewed',
    current: true,
    canonical: true,
    sourceMessageIds: ['message-root'],
    sourceSpans: [],
    rawSymptom: 'nausea',
    symptomConcept: 'nausea',
    symptomStatus: 'current',
  };
  const invalid = {
    ...emptyMemory(),
    events: [
      root,
      {
        ...root,
        id: 'event-child',
        version: 2,
        operation: 'refine' as const,
        supersedesEventId: root.id,
      },
    ],
  };

  expect(() => reducePatientClinicalMemory(invalid, [])).toThrow('clinical_lineage_invalid');
});
