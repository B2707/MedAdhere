import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  activeMedicationContextSchema,
  clinicalFactReferenceSchema,
  clinicianReviewActionSchema,
  clinicianReviewDraftSchema,
  conversationActionSchema,
  conversationMessageSchema,
  conversationObservationSchema,
  conversationTurnInputSchema,
  conversationTurnResultJsonSchema,
  conversationTurnResultSchema,
  dailySummarySchema,
  evidenceReferenceSchema,
  localeMetadataSchema,
  temporalCandidateSchema,
  type ActiveMedicationContext,
  type ClinicalFactReference,
  type ClinicianReviewAction,
  type ClinicianReviewDraft,
  type ConversationAction,
  type ConversationMessage,
  type ConversationObservation,
  type ConversationTurnInput,
  type ConversationTurnResult,
  type DailySummary,
  type EvidenceReference,
  type LocaleMetadata,
  type TemporalCandidate,
} from '@medadhere/shared';

const IDS = {
  patient: '00000000-0000-4000-8000-000000000001',
  inbound: '00000000-0000-4000-8000-000000000002',
  message: '00000000-0000-4000-8000-000000000003',
  medication: '00000000-0000-4000-8000-000000000004',
  fact: '00000000-0000-4000-8000-000000000005',
  candidate: '00000000-0000-4000-8000-000000000006',
  dose: '00000000-0000-4000-8000-000000000007',
  release: '00000000-0000-4000-8000-000000000008',
  draft: '00000000-0000-4000-8000-000000000009',
  correction: '00000000-0000-4000-8000-000000000010',
} as const;

const message = {
  id: IDS.message,
  direction: 'inbound',
  body: 'I took it this morning, but I feel dizzy.',
  occurredAtUtc: '2026-08-09T13:15:00.000Z',
  language: 'en-CA',
} as const;

const locale = {
  expectedLanguage: 'en-CA',
  patientTimeZone: 'America/Toronto',
  currentUtc: '2026-08-09T13:15:00.000Z',
  currentLocalDate: '2026-08-09',
} as const;

const medication = {
  patientMedicationId: IDS.medication,
  enteredName: 'Metformin 500 mg tablet',
  ingredientNames: ['metformin'],
  dose: '500 mg',
  form: 'tablet',
  route: 'oral',
  effectiveFrom: '2026-08-01',
  effectiveTo: null,
} as const;

const fact = {
  factId: IDS.fact,
  kind: 'allergy',
  statement: 'Penicillin allergy recorded by the clinician.',
  confirmedAtUtc: '2026-08-01T14:00:00.000Z',
} as const;

const candidate = {
  candidateId: IDS.candidate,
  patientMedicationId: IDS.medication,
  doseId: IDS.dose,
  occurredAtUtc: '2026-08-09T12:00:00.000Z',
  localDate: '2026-08-09',
  localTime: '08:00',
  patientTimeZone: 'America/Toronto',
  source: 'relative_time',
  ambiguous: false,
} as const;

const evidence = {
  evidenceId: 'evidence-label-metformin-1',
  source: 'openfda',
  sourceReleaseId: IDS.release,
  sourceVersion: '2026-08-01',
  title: 'Metformin label',
  passage: 'Dizziness is listed in the frozen label passage.',
  url: 'https://example.test/metformin-label',
  language: 'en',
  coverageState: 'direct_evidence',
  allowedTemplateIds: ['clinical-side-effect-possibility-v1'],
} as const;

const drugInteraction = {
  state: 'interaction_found',
  source: 'ddinter',
  displayNames: ['Amoxicillin', 'Warfarin'],
  pair: { lowDrugId: 'DD-AMOX', highDrugId: 'DD-WARF' },
  level: 'major',
  release: {
    id: IDS.release,
    version: 'DDInter-2026-08',
    checksumSha256: 'a'.repeat(64),
  },
} as const;

const observation = {
  kind: 'symptom',
  statement: 'The patient reports dizziness.',
  normalizedValue: 'dizziness',
  severity: null,
  temporalCandidateIds: [IDS.candidate],
  patientMedicationIds: [IDS.medication],
  evidenceIds: [evidence.evidenceId],
  clinicalEventId: null,
  supersedesClinicalEventId: null,
} as const;

const persistedObservation = { ...observation, clinicalEventId: IDS.fact } as const;

const draft = {
  patientStatements: [
    {
      sourceMessageId: IDS.inbound,
      text: 'The patient reports dizziness after the morning dose.',
    },
  ],
  establishedFactIds: [IDS.fact],
  inferences: ['Timing may be relevant, but causation is not established.'],
  uncertainties: ['Severity was not reported.'],
  evidenceIds: [evidence.evidenceId],
  proposedCorrections: [
    {
      correctionId: IDS.correction,
      factId: IDS.fact,
      proposedText: 'The recorded allergy wording may need clarification.',
      rationale: 'The patient supplied a correction during this turn.',
      sourceMessageIds: [IDS.inbound],
    },
  ],
} as const;

const turnInput = {
  requestId: '00000000-0000-4000-8000-000000000011',
  patientId: IDS.patient,
  inboundMessageId: IDS.inbound,
  currentMessage: message,
  locale,
  currentDayMessages: [message],
  pendingClarification: null,
  pendingClarificationTopic: null,
  promptedDoseId: null,
  recentObservations: [persistedObservation],
  activeMedications: [medication],
  clinicalFacts: [fact],
  drugInteractions: [drugInteraction],
  temporalCandidates: [candidate],
  evidence: [evidence],
  promptVersion: 'conversation-v1',
  schemaVersion: 'conversation-v3',
} as const;

const turnResult = {
  detectedLanguage: 'en-CA',
  languageConfidence: 0.98,
  mixedLanguage: false,
  translationUncertain: false,
  normalizedEnglishMeaning: 'I took my medication this morning and feel dizzy.',
  adherenceClassification: {
    adherence_state: 'taken',
    reason_code: 'side_effect',
    safety_flag: 'none',
  },
  observations: [observation],
  temporalCandidateIds: [IDS.candidate],
  action: {
    type: 'ask_clarification',
    clarification: 'How severe is the dizziness from 0 to 10?',
    clarificationTopic: 'severity',
  },
  socialAcknowledgement: 'Thanks for telling me. I recorded the dizziness for your doctor.',
  clinicalClaim: null,
  clinicianReviewDraft: draft,
  selectedEvidenceIds: [evidence.evidenceId],
  safetyCandidate: 'routine',
} as const;

function expectStrict(schema: { safeParse(value: unknown): { success: boolean } }, value: object) {
  expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(false);
}

describe('Phase 8 conversation leaf contracts', () => {
  it('accepts every representative strict leaf contract and exports its inferred type', () => {
    expect(conversationMessageSchema.parse(message)).toEqual(message);
    expect(localeMetadataSchema.parse(locale)).toEqual(locale);
    expect(activeMedicationContextSchema.parse(medication)).toEqual(medication);
    expect(clinicalFactReferenceSchema.parse(fact)).toEqual(fact);
    expect(temporalCandidateSchema.parse(candidate)).toEqual(candidate);
    expect(evidenceReferenceSchema.parse(evidence)).toEqual(evidence);
    expect(conversationObservationSchema.parse(observation)).toEqual(observation);
    expect(conversationObservationSchema.parse(persistedObservation)).toEqual(persistedObservation);
    expect(clinicianReviewDraftSchema.parse(draft)).toEqual(draft);

    expectTypeOf(conversationMessageSchema.parse(message)).toEqualTypeOf<ConversationMessage>();
    expectTypeOf(localeMetadataSchema.parse(locale)).toEqualTypeOf<LocaleMetadata>();
    expectTypeOf(
      activeMedicationContextSchema.parse(medication),
    ).toEqualTypeOf<ActiveMedicationContext>();
    expectTypeOf(clinicalFactReferenceSchema.parse(fact)).toEqualTypeOf<ClinicalFactReference>();
    expectTypeOf(temporalCandidateSchema.parse(candidate)).toEqualTypeOf<TemporalCandidate>();
    expectTypeOf(evidenceReferenceSchema.parse(evidence)).toEqualTypeOf<EvidenceReference>();
    expectTypeOf(
      conversationObservationSchema.parse(observation),
    ).toEqualTypeOf<ConversationObservation>();
    expectTypeOf(clinicianReviewDraftSchema.parse(draft)).toEqualTypeOf<ClinicianReviewDraft>();
  });

  it('rejects unknown keys on every leaf object', () => {
    expectStrict(conversationMessageSchema, message);
    expectStrict(localeMetadataSchema, locale);
    expectStrict(activeMedicationContextSchema, medication);
    expectStrict(clinicalFactReferenceSchema, fact);
    expectStrict(temporalCandidateSchema, candidate);
    expectStrict(evidenceReferenceSchema, evidence);
    expectStrict(conversationObservationSchema, observation);
    expectStrict(clinicianReviewDraftSchema, draft);
  });

  it('allows a reviewed medication identity with no inferred ingredient mapping', () => {
    expect(
      activeMedicationContextSchema.parse({ ...medication, ingredientNames: [] }).ingredientNames,
    ).toEqual([]);
  });

  it('preserves the full stored legacy medication-name boundary', () => {
    expect(
      activeMedicationContextSchema.parse({ ...medication, enteredName: 'x'.repeat(320) })
        .enteredName,
    ).toHaveLength(320);
    expect(
      activeMedicationContextSchema.safeParse({ ...medication, enteredName: 'x'.repeat(321) })
        .success,
    ).toBe(false);
  });

  it('enforces message, evidence, and structured collection bounds', () => {
    expect(
      conversationMessageSchema.safeParse({ ...message, body: 'x'.repeat(2_001) }).success,
    ).toBe(false);
    expect(
      evidenceReferenceSchema.safeParse({ ...evidence, passage: 'x'.repeat(2_001) }).success,
    ).toBe(false);
    expect(
      activeMedicationContextSchema.safeParse({
        ...medication,
        ingredientNames: Array.from({ length: 11 }, (_, index) => `ingredient-${index}`),
      }).success,
    ).toBe(false);
    expect(
      conversationObservationSchema.safeParse({
        ...observation,
        temporalCandidateIds: Array.from({ length: 21 }, () => IDS.candidate),
      }).success,
    ).toBe(false);
  });

  it('rejects malformed dates, times, identifiers, locales, and severity', () => {
    expect(
      localeMetadataSchema.safeParse({ ...locale, currentLocalDate: '2026-02-31' }).success,
    ).toBe(false);
    expect(temporalCandidateSchema.safeParse({ ...candidate, localTime: '25:00' }).success).toBe(
      false,
    );
    expect(clinicalFactReferenceSchema.safeParse({ ...fact, factId: 'fact-1' }).success).toBe(
      false,
    );
    expect(
      conversationMessageSchema.safeParse({ ...message, language: 'not a locale' }).success,
    ).toBe(false);
    expect(conversationObservationSchema.safeParse({ ...observation, severity: 11 }).success).toBe(
      false,
    );
    expect(conversationObservationSchema.safeParse({ ...observation, severity: 0 }).success).toBe(
      false,
    );
    expect(conversationObservationSchema.safeParse({ ...observation, severity: 1 }).success).toBe(
      true,
    );
  });

  it('requires persisted observation identity fields and keeps them nullable', () => {
    expect(
      conversationObservationSchema.safeParse({
        ...observation,
        clinicalEventId: null,
        supersedesClinicalEventId: null,
      }).success,
    ).toBe(true);
    expect(
      conversationObservationSchema.safeParse({
        ...observation,
        clinicalEventId: undefined,
      }).success,
    ).toBe(false);
    expect(
      conversationObservationSchema.safeParse({
        ...observation,
        supersedesClinicalEventId: IDS.draft,
      }).success,
    ).toBe(false);
    expect(
      conversationObservationSchema.safeParse({
        ...observation,
        kind: 'correction',
        supersedesClinicalEventId: IDS.draft,
      }).success,
    ).toBe(true);
  });

  it('requires evidence coverage and bounds its template allowlist', () => {
    expect(
      evidenceReferenceSchema.safeParse({ ...evidence, coverageState: undefined }).success,
    ).toBe(false);
    expect(evidenceReferenceSchema.safeParse({ ...evidence, coverageState: 'safe' }).success).toBe(
      false,
    );
    expect(
      evidenceReferenceSchema.safeParse({
        ...evidence,
        allowedTemplateIds: Array.from({ length: 21 }, (_, index) => `template-${index}`),
      }).success,
    ).toBe(false);
  });
});

describe('conversationActionSchema', () => {
  it('requires clarification only for ask_clarification', () => {
    const ask = {
      type: 'ask_clarification',
      clarification: 'Was that 8 AM or 8 PM?',
      clarificationTopic: 'dose_meridiem',
    } as const;
    const acknowledge = { type: 'acknowledge' } as const;
    const complete = { type: 'complete_turn' } as const;

    expect(conversationActionSchema.parse(ask)).toEqual(ask);
    expect(
      conversationActionSchema.safeParse({
        ...ask,
        clarification: 'Is it the same, better, or worse than last time?',
        clarificationTopic: 'recurrence_comparison',
      }).success,
    ).toBe(true);
    expect(conversationActionSchema.parse(acknowledge)).toEqual(acknowledge);
    expect(conversationActionSchema.parse(complete)).toEqual(complete);
    expectTypeOf(conversationActionSchema.parse(ask)).toEqualTypeOf<ConversationAction>();

    expect(conversationActionSchema.safeParse({ type: 'ask_clarification' }).success).toBe(false);
    expect(
      conversationActionSchema.safeParse({
        type: 'ask_clarification',
        clarification: 'Was that 8 AM or 8 PM?',
      }).success,
    ).toBe(false);
    expect(
      conversationActionSchema.safeParse({ type: 'acknowledge', clarification: 'extra' }).success,
    ).toBe(false);
    expect(
      conversationActionSchema.safeParse({ type: 'complete_turn', clarification: 'extra' }).success,
    ).toBe(false);
    expect(
      conversationActionSchema.safeParse({
        type: 'ask_clarification',
        clarification: 'x'.repeat(321),
        clarificationTopic: 'dose_meridiem',
      }).success,
    ).toBe(false);
  });

  // Wave 1c: dose_identity/event_identity/body_site were already NeedFields with no
  // representable ConversationClarificationTopic; late_intent is new (the missed/pending-dose
  // "will you take it later today?" question). All four must round-trip.
  it.each(['dose_identity', 'event_identity', 'body_site', 'late_intent'] as const)(
    'accepts %s as a clarification topic',
    (clarificationTopic) => {
      expect(
        conversationActionSchema.safeParse({
          type: 'ask_clarification',
          clarification: 'Which one did you mean?',
          clarificationTopic,
        }).success,
      ).toBe(true);
    },
  );
});

describe('conversationTurnInputSchema', () => {
  it('accepts the bounded patient-scoped turn input and exports its inferred type', () => {
    expect(conversationTurnInputSchema.parse(turnInput)).toEqual(turnInput);
    expectTypeOf(
      conversationTurnInputSchema.parse(turnInput),
    ).toEqualTypeOf<ConversationTurnInput>();
  });

  it('accepts server-owned inbound source links for pending questions and observations', () => {
    const parsed = conversationTurnInputSchema.parse({
      ...turnInput,
      pendingClarification: 'How strong is it from 1 to 10?',
      pendingClarificationTopic: 'severity',
      pendingClarificationSourceMessageId: IDS.inbound,
      recentObservations: [
        {
          ...persistedObservation,
          sourceMessageId: IDS.inbound,
        },
      ],
    });

    expect(parsed.pendingClarificationSourceMessageId).toBe(IDS.inbound);
    expect(parsed.recentObservations[0]?.sourceMessageId).toBe(IDS.inbound);
  });

  it('requires the current message to be inbound and rejects unknown nested keys', () => {
    expect(
      conversationTurnInputSchema.safeParse({
        ...turnInput,
        currentMessage: { ...message, direction: 'outbound' },
      }).success,
    ).toBe(false);
    expect(
      conversationTurnInputSchema.safeParse({
        ...turnInput,
        locale: { ...locale, unexpected: true },
      }).success,
    ).toBe(false);
  });

  it('accepts supported schema history but rejects arbitrary schema labels', () => {
    for (const schemaVersion of ['conversation-v1', 'conversation-v2', 'conversation-v3']) {
      expect(conversationTurnInputSchema.safeParse({ ...turnInput, schemaVersion }).success).toBe(
        true,
      );
    }
    expect(
      conversationTurnInputSchema.safeParse({
        ...turnInput,
        schemaVersion: 'patient-controlled-schema',
      }).success,
    ).toBe(false);
  });

  it('bounds the current-day conversation and every supplied context collection', () => {
    expect(
      conversationTurnInputSchema.safeParse({
        ...turnInput,
        currentDayMessages: Array.from({ length: 61 }, () => message),
      }).success,
    ).toBe(false);
    expect(
      conversationTurnInputSchema.safeParse({
        ...turnInput,
        recentObservations: Array.from({ length: 31 }, () => observation),
      }).success,
    ).toBe(false);
    expect(
      conversationTurnInputSchema.safeParse({
        ...turnInput,
        activeMedications: Array.from({ length: 21 }, () => medication),
      }).success,
    ).toBe(false);
    expect(
      conversationTurnInputSchema.safeParse({
        ...turnInput,
        clinicalFacts: Array.from({ length: 51 }, () => fact),
      }).success,
    ).toBe(false);
    expect(
      conversationTurnInputSchema.safeParse({
        ...turnInput,
        drugInteractions: Array.from({ length: 21 }, () => drugInteraction),
      }).success,
    ).toBe(false);
    expect(
      conversationTurnInputSchema.safeParse({
        ...turnInput,
        temporalCandidates: Array.from({ length: 21 }, () => candidate),
      }).success,
    ).toBe(false);
    expect(
      conversationTurnInputSchema.safeParse({
        ...turnInput,
        evidence: Array.from({ length: 21 }, () => evidence),
      }).success,
    ).toBe(false);
  });
});

describe('conversationTurnResultSchema', () => {
  it('exports a paired clinical-claim object or null in JSON Schema for provider grammar', () => {
    expect(conversationTurnResultJsonSchema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        detectedLanguage: expect.any(Object),
        action: expect.any(Object),
        clinicianReviewDraft: expect.any(Object),
        clinicalClaim: {
          anyOf: [
            {
              type: 'object',
              properties: {
                templateId: expect.any(Object),
                evidenceId: expect.any(Object),
              },
              required: ['templateId', 'evidenceId'],
              additionalProperties: false,
            },
            { type: 'null' },
          ],
        },
      }),
    });
    expect(
      (
        conversationTurnResultJsonSchema as {
          properties: { observations: { items: { required: string[] } } };
        }
      ).properties.observations.items.required,
    ).toEqual(expect.arrayContaining(['clinicalEventId', 'supersedesClinicalEventId']));
  });

  it('accepts a strict result with the existing adherence contract nested intact', () => {
    expect(conversationTurnResultSchema.parse(turnResult)).toEqual(turnResult);
    expectTypeOf(
      conversationTurnResultSchema.parse(turnResult),
    ).toEqualTypeOf<ConversationTurnResult>();

    expect(
      conversationTurnResultSchema.safeParse({
        ...turnResult,
        adherenceClassification: {
          ...turnResult.adherenceClassification,
          confidence: 0.9,
        },
      }).success,
    ).toBe(false);
    expect(
      conversationTurnResultSchema.safeParse({
        ...turnResult,
        observations: [persistedObservation],
      }).success,
    ).toBe(false);
  });

  it('accepts a nullable adherence classification and bounds patient-facing wording', () => {
    expect(
      conversationTurnResultSchema.safeParse({ ...turnResult, adherenceClassification: null })
        .success,
    ).toBe(true);
    expect(
      conversationTurnResultSchema.safeParse({
        ...turnResult,
        socialAcknowledgement: 'x'.repeat(321),
      }).success,
    ).toBe(false);
  });

  it('requires mixed-language and translation-uncertainty state', () => {
    expect(
      conversationTurnResultSchema.safeParse({ ...turnResult, mixedLanguage: undefined }).success,
    ).toBe(false);
    expect(
      conversationTurnResultSchema.safeParse({
        ...turnResult,
        translationUncertain: undefined,
      }).success,
    ).toBe(false);
    expect(
      conversationTurnResultSchema.safeParse({
        ...turnResult,
        mixedLanguage: true,
        translationUncertain: true,
      }).success,
    ).toBe(true);
  });

  it('makes half-populated clinical claims unrepresentable', () => {
    expect(
      conversationTurnResultSchema.safeParse({
        ...turnResult,
        clinicalClaim: {
          templateId: 'clinical-side-effect-possibility-v1',
          evidenceId: evidence.evidenceId,
        },
      }).success,
    ).toBe(true);
    expect(
      conversationTurnResultSchema.safeParse({
        ...turnResult,
        clinicalClaim: {
          templateId: 'clinical-side-effect-possibility-v1',
        },
      }).success,
    ).toBe(false);
    expect(
      conversationTurnResultSchema.safeParse({
        ...turnResult,
        clinicalClaim: {
          evidenceId: evidence.evidenceId,
        },
      }).success,
    ).toBe(false);
    expect(
      conversationTurnResultSchema.safeParse({
        ...turnResult,
        clinicalClaim: { templateId: 'template', evidenceId: evidence.evidenceId, extra: true },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown keys on the result and nested draft/action objects', () => {
    expectStrict(conversationTurnResultSchema, turnResult);
    expect(
      conversationTurnResultSchema.safeParse({
        ...turnResult,
        action: { ...turnResult.action, unexpected: true },
      }).success,
    ).toBe(false);
    expect(
      conversationTurnResultSchema.safeParse({
        ...turnResult,
        clinicianReviewDraft: { ...draft, unexpected: true },
      }).success,
    ).toBe(false);
  });

  it('requires source-message provenance on draft statements and proposed corrections', () => {
    expect(
      clinicianReviewDraftSchema.safeParse({
        ...draft,
        patientStatements: [{ text: 'A statement without its source.' }],
      }).success,
    ).toBe(false);
    expect(
      clinicianReviewDraftSchema.safeParse({
        ...draft,
        proposedCorrections: draft.proposedCorrections.map((correction) => ({
          correctionId: correction.correctionId,
          factId: correction.factId,
          proposedText: correction.proposedText,
          rationale: correction.rationale,
        })),
      }).success,
    ).toBe(false);
  });
});

describe('stored summary and clinician action contracts', () => {
  const summary = {
    summaryId: '00000000-0000-4000-8000-000000000012',
    version: 1,
    inputHash: 'a'.repeat(64),
    localDate: '2026-08-09',
    patientTimeZone: 'America/Toronto',
    windowStartUtc: '2026-08-09T04:00:00.000Z',
    windowEndUtc: '2026-08-10T04:00:00.000Z',
    summaryText: 'The patient reported taking the morning dose and later feeling dizzy.',
    eventIds: [IDS.inbound],
    highestPriority: 'routine',
    symptomCount: 1,
    adherenceCounts: {
      taken: 1,
      delayed: 0,
      skipped: 0,
      stopped: 0,
      question: 0,
      unknown: 0,
    },
  } as const;

  const action = {
    draftId: IDS.draft,
    expectedVersion: 1,
    decision: 'confirm',
    selectedProposedCorrectionIds: [IDS.correction],
  } as const;

  it('accepts strict bounded summary and doctor-action payloads', () => {
    expect(dailySummarySchema.parse(summary)).toEqual(summary);
    expect(clinicianReviewActionSchema.parse(action)).toEqual(action);
    expectTypeOf(dailySummarySchema.parse(summary)).toEqualTypeOf<DailySummary>();
    expectTypeOf(clinicianReviewActionSchema.parse(action)).toEqualTypeOf<ClinicianReviewAction>();
  });

  it('rejects nested summary drift and invalid doctor-action versions', () => {
    expect(
      dailySummarySchema.safeParse({
        ...summary,
        adherenceCounts: { ...summary.adherenceCounts, unexpected: 1 },
      }).success,
    ).toBe(false);
    expect(clinicianReviewActionSchema.safeParse({ ...action, expectedVersion: 0 }).success).toBe(
      false,
    );
    expect(dailySummarySchema.safeParse({ ...summary, inputHash: 'not-a-sha256' }).success).toBe(
      false,
    );
    expect(
      clinicianReviewActionSchema.safeParse({
        ...action,
        decision: 'reject',
        selectedProposedCorrectionIds: [IDS.correction],
      }).success,
    ).toBe(false);
    expectStrict(clinicianReviewActionSchema, action);
  });
});
