import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  clinicalEventSchema,
  applyPreparedClinicalTurn,
  doseSnapshotSchema,
  extractedClaimSchema,
  informationNeedSchema,
  medicationSnapshotSchema,
  patientClinicalMemorySchema,
  patientClinicalSnapshotSchema,
  prepareClinicalTurn,
  reducePatientClinicalMemory,
  type ClinicalEvent,
  type InformationNeed,
  type PatientClinicalMemory,
  type PatientClinicalSnapshot,
} from './index.js';

const HASH = '0'.repeat(64);
const PIPELINE_VERSIONS = {
  extractor: 'extractor-v1',
  resolver: 'resolver-v1',
  reducer: 'reducer-v1',
  renderer: 'renderer-v1',
} as const;

const fixtureEventSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['administration', 'symptom', 'safety']),
    current: z.boolean(),
    canonical: z.boolean(),
    sourceMessageIds: z.array(z.string().min(1)),
    medicationId: z.string().min(1).optional(),
    doseId: z.string().min(1).optional(),
    adherence: z.enum(['taken', 'missed', 'partial']).optional(),
    timing: z.enum(['on_time', 'late', 'unknown']).optional(),
    timeText: z.string().min(1).optional(),
    exactTime: z.string().min(1).optional(),
    rawSymptom: z.string().min(1).optional(),
    symptomConcept: z.string().min(1).nullable().optional(),
    symptomStatus: z.enum(['current', 'resolved', 'historical']).optional(),
    severity: z.string().min(1).optional(),
    duration: z.string().min(1).optional(),
    bodySite: z.string().min(1).optional(),
    frequency: z.string().min(1).optional(),
    safetyTier: z.string().min(1).optional(),
    candidateMedicationIds: z.array(z.string().min(1)).optional(),
    candidateDoseIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

const fixtureNeedSchema = z
  .object({
    id: z.string().min(1),
    eventId: z.string().min(1),
    field: z.enum([
      'medication_identity',
      'dose_identity',
      'symptom_identity',
      'severity',
      'actual_time',
      'duration',
      'body_site',
      'frequency',
    ]),
    state: z.enum(['open', 'asked']),
    priority: z.number().int().nonnegative(),
    candidateMedicationIds: z.array(z.string().min(1)).optional(),
    candidateDoseIds: z.array(z.string().min(1)).optional(),
    candidateSymptomEventIds: z.array(z.string().min(1)).optional(),
    candidateHistoricalEventIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

const profileSchema = z
  .object({
    medications: z.array(medicationSnapshotSchema),
    doses: z.array(doseSnapshotSchema),
    symptomConcepts: z.array(z.string().min(1)),
  })
  .strict();

const fixtureCaseSchema = z
  .object({
    id: z.string().min(1),
    families: z.array(z.string().min(1)),
    profile: z.string().min(1),
    message: z.object({ id: z.string().min(1), body: z.string().min(1) }).strict(),
    initialEvents: z.array(fixtureEventSchema).nullish(),
    initialNeeds: z.array(fixtureNeedSchema).nullish(),
    claims: z.array(extractedClaimSchema),
    promptedDoseId: z.string().min(1).nullish(),
    exactControl: z.literal('STOP').nullish(),
    languageDisposition: z.enum(['english', 'unsupported', 'uncertain']).nullish(),
    emergencyPrefilter: z.boolean().nullish(),
    emergencyOpen: z.boolean().nullish(),
    snapshotVersion: z.number().int().nonnegative().nullish(),
    expectedSnapshotVersion: z.number().int().nonnegative().nullish(),
    consentEpoch: z.number().int().positive().nullish(),
    expectedConsentEpoch: z.number().int().positive().nullish(),
    expected: z.record(z.string(), z.unknown()),
  })
  .strict();

const matrixSchema = z
  .object({
    profiles: z.record(z.string(), profileSchema),
    cases: z.array(fixtureCaseSchema).length(35),
    sequenceInvariants: z.array(z.string().min(1)).length(10),
  })
  .passthrough();

const matrix = matrixSchema.parse(
  JSON.parse(readFileSync(join(__dirname, 'fixtures/retained-matrix.v1.json'), 'utf8')),
);
type FixtureCase = (typeof matrix.cases)[number];
type FixtureProfile = z.infer<typeof profileSchema>;

// Test-adapter sentinel only: this is neither patient text nor translation evidence.
const LEGACY_SOURCE_UNAVAILABLE = 'legacy-source-unavailable:';

const EXPECTED_FIELDS = [
  'adherenceCount',
  'administrations',
  'bodySite',
  'candidateDoseIds',
  'candidateMedicationIds',
  'canonicalEventCount',
  'commandCount',
  'currentSourceMessageIds',
  'currentSymptomConcepts',
  'currentSymptomSeverities',
  'currentSymptomStatuses',
  'diagnosis',
  'duration',
  'exactTime',
  'humanReview',
  'needStates',
  'positiveSymptomCount',
  'questionDoseId',
  'questionEventId',
  'questionField',
  'recurrenceOfEventId',
  'resolvedNeedIds',
  'responseKind',
  'safetyEventCount',
  'socialAcknowledgement',
  'supersededEventIds',
  'timeText',
  'unresolvedReasons',
  'validationErrors',
] as const;

const INCOMPATIBILITIES = {
  'v45-conv-dev-005-white-pill-stays-unbound':
    'candidate_scope_is_stored_on_legacy_event_not_information_need',
  'clinician-emergency-closure-resumes-routine-need':
    'safetyTier_closed_conflates_clinician_workflow_state_with_safety_severity',
  'recurrence-with-two-prior-episodes-stays-unresolved':
    'legacy_fixture_predates_one_attempt_historical_target_clarification',
} as const satisfies Readonly<Record<string, string>>;

function incompatibilityFor(testCase: FixtureCase): string | undefined {
  return INCOMPATIBILITIES[testCase.id as keyof typeof INCOMPATIBILITIES];
}

/**
 * Wave 1c behavior drift, declared here rather than in the fixture: a missed OR still-pending
 * administration report now opens the pinned late_intent question ("Do you plan to take it later
 * today?"), so a turn whose only outcome is a missed dose answers with a question where the
 * pre-Wave-1c system answered routinely. The fixture stays byte-exact (fixture-integrity.test.ts
 * pins its sha256, and the frozen oracle's job is to record what the earlier system did), so the
 * drift is stated per case — and stated STRONGER than the flipped kind alone: the question's
 * field and its target dose are pinned too, so a question opened on the wrong dose still fails.
 */
const WAVE_1C_LATE_INTENT_EXPECTATIONS = {
  'multi-medication-adherence-is-per-administration': {
    responseKind: 'question',
    questionField: 'late_intent',
    questionDoseId: 'dose-lisinopril-morning',
  },
  'explicit-correction-supersedes-one-current-leaf': {
    responseKind: 'question',
    questionField: 'late_intent',
    questionDoseId: 'dose-metformin-evening',
  },
  'same-message-explicit-correction-has-one-current-result': {
    responseKind: 'question',
    questionField: 'late_intent',
    questionDoseId: 'dose-metformin-morning',
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, string>>>>;

function expectationsFor(testCase: FixtureCase): Readonly<Record<string, unknown>> {
  return {
    ...testCase.expected,
    ...WAVE_1C_LATE_INTENT_EXPECTATIONS[
      testCase.id as keyof typeof WAVE_1C_LATE_INTENT_EXPECTATIONS
    ],
  };
}

const compatibleCases = matrix.cases.filter(
  (testCase) => incompatibilityFor(testCase) === undefined,
);

function profileFor(testCase: FixtureCase): FixtureProfile {
  const profile = matrix.profiles[testCase.profile];
  if (profile === undefined) throw new Error(`fixture_profile_missing:${testCase.profile}`);
  return profile;
}

function exactSnapshot<T extends { readonly id: string; readonly version: number }>(
  snapshots: readonly T[],
  id: string | undefined,
  kind: 'medication' | 'dose',
): T | undefined {
  if (id === undefined) return undefined;
  const matches = snapshots.filter((candidate) => candidate.id === id);
  if (matches.length === 0) throw new Error(`fixture_${kind}_missing:${id}`);
  if (matches.length !== 1) throw new Error(`fixture_${kind}_not_unique:${id}`);
  return matches[0];
}

function adaptEvent(
  input: z.infer<typeof fixtureEventSchema>,
  profile: FixtureProfile,
): ClinicalEvent {
  const medication = exactSnapshot(
    profile.medications,
    input.kind === 'administration' ? input.medicationId : undefined,
    'medication',
  );
  const dose = exactSnapshot(
    profile.doses,
    input.kind === 'administration' ? input.doseId : undefined,
    'dose',
  );
  if (dose !== undefined && medication === undefined)
    throw new Error(`fixture_dose_without_medication:${dose.id}`);
  if (dose !== undefined && dose.medicationId !== medication?.id)
    throw new Error(`fixture_dose_medication_mismatch:${dose.id}:${medication?.id}`);

  const values = Object.fromEntries(
    Object.entries(input).filter(
      ([field]) =>
        field !== 'candidateMedicationIds' &&
        field !== 'candidateDoseIds' &&
        !(input.kind === 'symptom' && field === 'doseId'),
    ),
  );
  return clinicalEventSchema.parse({
    ...values,
    version: 1,
    operation: input.kind === 'safety' ? 'raise_safety' : 'create',
    authoredBy: 'patient',
    reviewState: 'unreviewed',
    sourceSpans: input.sourceMessageIds.map((messageId) => {
      const quote = `${LEGACY_SOURCE_UNAVAILABLE}${messageId}`;
      return { messageId, start: 0, end: quote.length, quote };
    }),
    medicationVersion: medication?.version,
    doseVersion: dose?.version,
  });
}

function adaptNeed(
  input: z.infer<typeof fixtureNeedSchema>,
  events: readonly ClinicalEvent[],
): InformationNeed {
  const target = events.find(({ id }) => id === input.eventId);
  if (target === undefined) throw new Error(`fixture_need_target_missing:${input.id}`);
  return informationNeedSchema.parse({
    id: input.id,
    version: 1,
    originInboundMessageId: target.sourceMessageIds[0],
    originInboundSequence: 1,
    targetEventId: target.id,
    targetEventVersion: target.version,
    field: input.field,
    candidateMedicationIds: input.candidateMedicationIds ?? [],
    candidateDoseIds: input.candidateDoseIds ?? [],
    candidateSymptomEventIds: input.candidateSymptomEventIds ?? [],
    candidateHistoricalEventIds: input.candidateHistoricalEventIds ?? [],
    questionId: `question-${input.id}`,
    clarificationAttemptUsed: input.state === 'asked',
    state: input.state,
    priority: input.priority,
  });
}

function memoryFor(testCase: FixtureCase): PatientClinicalMemory {
  const profile = profileFor(testCase);
  const events = (testCase.initialEvents ?? []).map((input) => adaptEvent(input, profile));
  const needs = (testCase.initialNeeds ?? []).map((input) => adaptNeed(input, events));
  return patientClinicalMemorySchema.parse({
    patientId: 'patient-fixture',
    version: testCase.snapshotVersion ?? 0,
    events,
    needs,
    unresolvedReports: [],
    reviewItems: [],
    routineClarificationsPaused: testCase.emergencyOpen === true,
    processedBatches: [],
  });
}

function snapshotFor(testCase: FixtureCase): PatientClinicalSnapshot {
  const profile = profileFor(testCase);
  const memory = memoryFor(testCase);
  return patientClinicalSnapshotSchema.parse({
    memory,
    inboundMessage: {
      id: testCase.message.id,
      sequence: memory.events.length === 0 ? 1 : 2,
      body: testCase.message.body,
    },
    consentEpoch: testCase.consentEpoch ?? 1,
    expectedConsentEpoch: testCase.expectedConsentEpoch ?? testCase.consentEpoch ?? 1,
    medications: profile.medications,
    doses: profile.doses,
    symptomConcepts: profile.symptomConcepts,
    ...(testCase.promptedDoseId === null || testCase.promptedDoseId === undefined
      ? {}
      : { promptedDoseId: testCase.promptedDoseId }),
    ...(testCase.exactControl === null || testCase.exactControl === undefined
      ? {}
      : { exactControl: testCase.exactControl }),
    languageDisposition: testCase.languageDisposition ?? 'english',
    emergencyPrefilter: testCase.emergencyPrefilter ?? false,
    ...(testCase.expectedSnapshotVersion === null || testCase.expectedSnapshotVersion === undefined
      ? {}
      : { expectedMemoryVersion: testCase.expectedSnapshotVersion }),
    contextHash: HASH,
    pipelineVersions: PIPELINE_VERSIONS,
  });
}

function currentCanonical(memory: PatientClinicalMemory): ClinicalEvent[] {
  return memory.events.filter(({ canonical, current }) => canonical && current);
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function currentSymptoms(memory: PatientClinicalMemory): ClinicalEvent[] {
  return currentCanonical(memory).filter(({ kind }) => kind === 'symptom');
}

function symptomValues(
  memory: PatientClinicalMemory,
  field: 'severity' | 'symptomStatus',
): Readonly<Record<string, string | null>> {
  return Object.fromEntries(
    currentSymptoms(memory).map((event) => [
      event.symptomConcept ?? event.rawSymptom ?? event.id,
      event[field] ?? null,
    ]),
  );
}

function runCase(testCase: FixtureCase): {
  readonly prepared: ReturnType<typeof prepareClinicalTurn>;
  readonly memory: PatientClinicalMemory;
} {
  const snapshot = snapshotFor(testCase);
  const prepared = prepareClinicalTurn(snapshot, testCase.claims);
  const memory = reducePatientClinicalMemory(snapshot.memory, prepared.commands).memory;
  return { prepared, memory };
}

function assertExpected(testCase: FixtureCase, result: ReturnType<typeof runCase>): void {
  const { prepared, memory } = result;
  const current = currentCanonical(memory);
  const symptoms = currentSymptoms(memory);
  const administrations = current.filter(
    (event) => event.kind === 'administration' && event.adherence !== undefined,
  );

  const expectations = expectationsFor(testCase);
  expect(Object.keys(expectations).sort()).toEqual(
    Object.keys(expectations)
      .filter((field) => EXPECTED_FIELDS.includes(field as (typeof EXPECTED_FIELDS)[number]))
      .sort(),
  );

  for (const [field, expected] of Object.entries(expectations)) {
    switch (field) {
      case 'responseKind':
        expect(prepared.responsePlan.kind, field).toBe(expected);
        break;
      case 'canonicalEventCount':
        expect(current, field).toHaveLength(Number(expected));
        break;
      case 'commandCount':
        expect(prepared.commands, field).toHaveLength(Number(expected));
        break;
      case 'adherenceCount':
        expect(administrations, field).toHaveLength(Number(expected));
        break;
      case 'administrations':
        expect(
          administrations
            .map(({ medicationId, doseId, adherence }) => ({
              medicationId,
              ...(doseId === undefined ? {} : { doseId }),
              adherence,
            }))
            .sort((left, right) =>
              String(left.medicationId).localeCompare(String(right.medicationId)),
            ),
          field,
        ).toEqual(
          [...z.array(z.record(z.string(), z.unknown())).parse(expected)].sort((left, right) =>
            String(left.medicationId).localeCompare(String(right.medicationId)),
          ),
        );
        break;
      case 'questionField':
        expect(prepared.responsePlan.question?.field ?? null, field).toBe(expected);
        break;
      case 'questionEventId':
        expect(prepared.responsePlan.question?.eventId ?? null, field).toBe(expected);
        break;
      case 'questionDoseId': {
        const questionEvent = memory.events.find(
          ({ id }) => id === prepared.responsePlan.question?.eventId,
        );
        expect(questionEvent?.doseId ?? null, field).toBe(expected);
        break;
      }
      case 'unresolvedReasons':
        expect(sortedStrings(memory.unresolvedReports.map(({ reason }) => reason)), field).toEqual(
          sortedStrings(z.array(z.string()).parse(expected)),
        );
        break;
      case 'candidateMedicationIds':
        expect(
          sortedStrings(
            memory.needs.flatMap(({ candidateMedicationIds }) => candidateMedicationIds),
          ),
          field,
        ).toEqual(sortedStrings(z.array(z.string()).parse(expected)));
        break;
      case 'candidateDoseIds':
        expect(
          sortedStrings(memory.needs.flatMap(({ candidateDoseIds }) => candidateDoseIds)),
          field,
        ).toEqual(sortedStrings(z.array(z.string()).parse(expected)));
        break;
      case 'resolvedNeedIds':
        expect(
          sortedStrings(
            memory.needs.filter(({ state }) => state === 'resolved').map(({ id }) => id),
          ),
          field,
        ).toEqual(sortedStrings(z.array(z.string()).parse(expected)));
        break;
      case 'needStates': {
        const states = z.record(z.string(), z.string()).parse(expected);
        expect(
          Object.fromEntries(
            Object.keys(states).map((id) => [
              id,
              memory.needs.find((need) => need.id === id)?.state,
            ]),
          ),
          field,
        ).toEqual(states);
        break;
      }
      case 'currentSymptomConcepts':
        expect(
          sortedStrings(
            symptoms.flatMap(({ symptomConcept }) =>
              symptomConcept === undefined || symptomConcept === null ? [] : [symptomConcept],
            ),
          ),
          field,
        ).toEqual(sortedStrings(z.array(z.string()).parse(expected)));
        break;
      case 'currentSymptomSeverities':
        expect(symptomValues(memory, 'severity'), field).toEqual(expected);
        break;
      case 'currentSymptomStatuses':
        expect(symptomValues(memory, 'symptomStatus'), field).toEqual(expected);
        break;
      case 'supersededEventIds':
        expect(
          sortedStrings(memory.events.filter(({ current: leaf }) => !leaf).map(({ id }) => id)),
          field,
        ).toEqual(sortedStrings(z.array(z.string()).parse(expected)));
        break;
      case 'currentSourceMessageIds':
        expect(sortedStrings(symptoms.at(-1)?.sourceMessageIds ?? []), field).toEqual(
          sortedStrings(z.array(z.string()).parse(expected)),
        );
        break;
      case 'duration':
        expect(symptoms.at(-1)?.duration ?? null, field).toBe(expected);
        break;
      case 'bodySite':
        expect(symptoms.at(-1)?.bodySite ?? null, field).toBe(expected);
        break;
      case 'diagnosis':
        expect(
          symptoms.some((event) => Object.hasOwn(event, 'diagnosis')) ? 'present' : null,
          field,
        ).toBe(expected);
        break;
      case 'timeText':
        expect(administrations.at(-1)?.timeText ?? null, field).toBe(expected);
        break;
      case 'exactTime':
        expect(administrations.at(-1)?.exactTime ?? null, field).toBe(expected);
        break;
      case 'recurrenceOfEventId':
        expect(
          symptoms.find(({ recurrenceOfEventId }) => recurrenceOfEventId !== undefined)
            ?.recurrenceOfEventId ?? null,
          field,
        ).toBe(expected);
        break;
      case 'safetyEventCount':
        expect(
          current.filter(({ kind }) => kind === 'safety'),
          field,
        ).toHaveLength(Number(expected));
        break;
      case 'validationErrors':
        expect(prepared.responsePlan.reviewReasons, field).toEqual(expected);
        break;
      case 'humanReview':
        expect(
          memory.reviewItems.some(({ status }) => status === 'open'),
          field,
        ).toBe(expected);
        break;
      case 'socialAcknowledgement':
        expect(Boolean(prepared.responsePlan.acknowledgementId), field).toBe(expected);
        break;
      case 'positiveSymptomCount':
        expect(symptoms, field).toHaveLength(Number(expected));
        break;
      default:
        throw new Error(`fixture_expected_field_unhandled:${testCase.id}:${field}`);
    }
  }
}

describe('retained clinical-memory matrix adapter', () => {
  it('isolates exactly three frozen fixture incompatibilities', () => {
    const detected = Object.fromEntries(
      matrix.cases.flatMap((testCase) => {
        const reason = incompatibilityFor(testCase);
        return reason === undefined ? [] : [[testCase.id, reason]];
      }),
    );
    expect(detected).toEqual(INCOMPATIBILITIES);
  });

  it('rejects the legacy event-owned medication candidate scope', () => {
    const testCase = matrix.cases.find(
      ({ id }) => id === 'v45-conv-dev-005-white-pill-stays-unbound',
    );
    if (testCase === undefined) throw new Error('fixture_case_missing');
    const scopedEvent = testCase.initialEvents?.find(
      ({ candidateMedicationIds }) => candidateMedicationIds !== undefined,
    );
    const correspondingNeed = testCase.initialNeeds?.find(
      ({ eventId }) => eventId === scopedEvent?.id,
    );

    expect(incompatibilityFor(testCase)).toBe(
      'candidate_scope_is_stored_on_legacy_event_not_information_need',
    );
    expect(scopedEvent?.candidateMedicationIds).toEqual(['med-lisinopril', 'med-metformin']);
    expect(correspondingNeed?.candidateMedicationIds).toBeUndefined();
  });

  it('rejects closed as a safety severity value', () => {
    const testCase = matrix.cases.find(
      ({ id }) => id === 'clinician-emergency-closure-resumes-routine-need',
    );
    if (testCase === undefined) throw new Error('fixture_case_missing');
    const closedSafety = testCase.initialEvents?.find(({ kind }) => kind === 'safety');

    expect(incompatibilityFor(testCase)).toBe(
      'safetyTier_closed_conflates_clinician_workflow_state_with_safety_severity',
    );
    expect(closedSafety?.safetyTier).toBe('closed');
    expect(() => adaptEvent(closedSafety!, profileFor(testCase))).toThrow();
  });

  it('marks unavailable legacy source text without claiming exact provenance', () => {
    const legacyEvents = compatibleCases.flatMap((testCase) =>
      (testCase.initialEvents ?? []).map((input) => ({ input, profile: profileFor(testCase) })),
    );

    expect(legacyEvents.length).toBeGreaterThan(0);
    for (const { input, profile } of legacyEvents) {
      expect(input).not.toHaveProperty('sourceSpans');
      expect(adaptEvent(input, profile).sourceSpans).toEqual(
        input.sourceMessageIds.map((messageId) => {
          const quote = `${LEGACY_SOURCE_UNAVAILABLE}${messageId}`;
          return { messageId, start: 0, end: quote.length, quote };
        }),
      );
    }
  });

  it('derives canonical administration versions by exact parsed-profile identity', () => {
    const administrations = compatibleCases.flatMap((testCase) => {
      const profile = profileFor(testCase);
      return (testCase.initialEvents ?? []).flatMap((input) =>
        input.kind === 'administration' && input.canonical ? [{ input, profile }] : [],
      );
    });

    expect(administrations).toHaveLength(4);
    for (const { input, profile } of administrations) {
      const adapted = adaptEvent(input, profile);
      const medication = profile.medications.find(({ id }) => id === input.medicationId);
      const dose = profile.doses.find(({ id }) => id === input.doseId);
      expect(medication).toBeDefined();
      expect(dose).toBeDefined();
      expect(adapted).toMatchObject({
        medicationId: medication!.id,
        medicationVersion: medication!.version,
        doseId: dose!.id,
        doseVersion: dose!.version,
      });
      expect(clinicalEventSchema.safeParse(adapted).success).toBe(true);
    }

    const { input, profile } = administrations[0]!;
    expect(() =>
      adaptEvent({ ...input, medicationId: 'medication-not-in-profile' }, profile),
    ).toThrow('fixture_medication_missing:medication-not-in-profile');

    const medication = profile.medications.find(({ id }) => id === input.medicationId)!;
    expect(() =>
      adaptEvent(input, {
        ...profile,
        medications: [...profile.medications, { ...medication, version: medication.version + 1 }],
      }),
    ).toThrow(`fixture_medication_not_unique:${medication.id}`);

    const dose = profile.doses.find(({ id }) => id === input.doseId)!;
    const otherMedication = profile.medications.find(({ id }) => id !== medication.id);
    if (otherMedication !== undefined) {
      expect(() =>
        adaptEvent(input, {
          ...profile,
          doses: profile.doses.map((candidate) =>
            candidate.id === dose.id
              ? { ...candidate, medicationId: otherMedication.id }
              : candidate,
          ),
        }),
      ).toThrow(`fixture_dose_medication_mismatch:${dose.id}:${medication.id}`);
    }
  });

  it('records the legacy ambiguous-recurrence expectation as superseded evidence', () => {
    const testCase = matrix.cases.find(
      ({ id }) => id === 'recurrence-with-two-prior-episodes-stays-unresolved',
    );
    if (testCase === undefined) throw new Error('fixture_case_missing');

    expect(incompatibilityFor(testCase)).toBe(
      'legacy_fixture_predates_one_attempt_historical_target_clarification',
    );
    expect(testCase.expected).toMatchObject({
      responseKind: 'routine',
      unresolvedReasons: ['recurrence_target_ambiguous'],
    });
  });

  it('keeps every declared Wave 1c expectation bound to a live fixture case', () => {
    // A stale override would silently apply to nothing and pass forever.
    for (const id of Object.keys(WAVE_1C_LATE_INTENT_EXPECTATIONS)) {
      expect(compatibleCases.map((testCase) => testCase.id)).toContain(id);
    }
  });

  it.each(compatibleCases)('$id', (testCase) => {
    const before = structuredClone(testCase);
    assertExpected(testCase, runCase(testCase));
    expect(testCase).toEqual(before);
  });

  it('replays a complete committed batch without appending duplicates', () => {
    const testCase = matrix.cases.find(
      ({ id }) => id === 'multi-medication-adherence-is-per-administration',
    );
    if (testCase === undefined) throw new Error('fixture_case_missing');
    const snapshot = snapshotFor(testCase);
    const prepared = prepareClinicalTurn(snapshot, testCase.claims);
    const first = applyPreparedClinicalTurn(snapshot.memory, prepared);

    expect(applyPreparedClinicalTurn(first.memory, prepared)).toEqual(first);
  });
});
