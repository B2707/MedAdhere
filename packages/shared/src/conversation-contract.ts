import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AdherenceClassification } from './adherence-schema.js';
import { conversationDrugInteractionSchema } from './clinical-knowledge.js';

const MAX_CURRENT_MESSAGE_CHARS = 2_000;
const MAX_PATIENT_WORDING_CHARS = 320;
const MAX_CONTEXT_MESSAGES = 60;
const MAX_RECENT_OBSERVATIONS = 30;
const MAX_ACTIVE_MEDICATIONS = 20;
const MAX_CLINICAL_FACTS = 50;
const MAX_TURN_REFERENCES = 20;

const uuidSchema = z.string().uuid();
const isoDateSchema = z.string().date();
const isoDateTimeSchema = z.string().datetime({ offset: true });
const localTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const languageTagSchema = z
  .string()
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
  .max(35);
const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9._+-]+)+)$/);
const opaqueIdSchema = z.string().trim().min(1).max(128);
const versionSchema = z.string().trim().min(1).max(64);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const CONVERSATION_SCHEMA_VERSION = 'conversation-v3';
const conversationSchemaVersionSchema = versionSchema.refine(
  (version): boolean =>
    version === 'conversation-v1' ||
    version === 'conversation-v2' ||
    version === CONVERSATION_SCHEMA_VERSION,
  'Unsupported conversation schema version',
);

export const CONVERSATION_CLARIFICATION_TOPICS = [
  'medication_identity',
  'medication_taking',
  'dose_time',
  'dose_day',
  'dose_meridiem',
  'dose_identity',
  'event_identity',
  'symptom',
  'symptom_identity',
  'severity',
  'actual_time',
  'body_site',
  'recurrence_comparison',
  'frequency',
  'duration',
  'sleep',
  'context',
  'interaction_item_identity',
  'clinical_history',
  // Wave 1c: a missed OR pending administration report's pinned "will you take it later
  // today?" question — never labeled with a medication/dose (see NeedField late_intent).
  'late_intent',
  // Wave 1e symptom context battery. EVERY NeedField must be listed here: repository.ts writes
  // the raw NeedField into outbound_message.clarification_topic and runtime-repository.ts parses
  // that column unconditionally on every turn load, so a writable-but-unparseable value throws
  // inside the queue worker and wedges the patient's FIFO queue behind an infinite retry. Pinned
  // by the NeedField-parity test in backend/src/conversation/runtime-repository.test.ts.
  'onset',
  'quality',
  'triggers',
  'associated_symptoms',
  'recurrence_history',
  'other',
] as const;

export const conversationClarificationTopicSchema = z.enum(CONVERSATION_CLARIFICATION_TOPICS);
export type ConversationClarificationTopic = z.infer<typeof conversationClarificationTopicSchema>;

function boundedText(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, 'Text must contain a non-whitespace character');
}

export const conversationMessageSchema = z
  .object({
    id: uuidSchema,
    direction: z.enum(['inbound', 'outbound']),
    body: boundedText(MAX_CURRENT_MESSAGE_CHARS),
    occurredAtUtc: isoDateTimeSchema,
    language: languageTagSchema,
  })
  .strict();

export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const localeMetadataSchema = z
  .object({
    expectedLanguage: languageTagSchema,
    patientTimeZone: timeZoneSchema,
    currentUtc: isoDateTimeSchema,
    currentLocalDate: isoDateSchema,
  })
  .strict();

export type LocaleMetadata = z.infer<typeof localeMetadataSchema>;

export const activeMedicationContextSchema = z
  .object({
    patientMedicationId: uuidSchema,
    enteredName: boundedText(320),
    ingredientNames: z.array(boundedText(120)).max(10),
    dose: boundedText(120).nullable(),
    form: boundedText(80).nullable(),
    route: boundedText(80).nullable(),
    effectiveFrom: isoDateSchema,
    effectiveTo: isoDateSchema.nullable(),
  })
  .strict();

export type ActiveMedicationContext = z.infer<typeof activeMedicationContextSchema>;

export const clinicalFactReferenceSchema = z
  .object({
    factId: uuidSchema,
    kind: z.enum(['condition', 'allergy', 'note']),
    statement: boundedText(1_000),
    confirmedAtUtc: isoDateTimeSchema,
  })
  .strict();

export type ClinicalFactReference = z.infer<typeof clinicalFactReferenceSchema>;

export const temporalCandidateSchema = z
  .object({
    candidateId: uuidSchema,
    patientMedicationId: uuidSchema.nullable(),
    doseId: uuidSchema.nullable(),
    occurredAtUtc: isoDateTimeSchema,
    localDate: isoDateSchema,
    localTime: localTimeSchema,
    patientTimeZone: timeZoneSchema,
    source: z.enum(['explicit_time', 'relative_time', 'scheduled_dose', 'pending_clarification']),
    ambiguous: z.boolean(),
  })
  .strict();

export type TemporalCandidate = z.infer<typeof temporalCandidateSchema>;

export const evidenceReferenceSchema = z
  .object({
    evidenceId: opaqueIdSchema,
    source: z.enum(['ccdd', 'ddinter', 'openfda', 'health_canada', 'onsides', 'medlineplus']),
    sourceReleaseId: uuidSchema,
    sourceVersion: boundedText(128),
    title: boundedText(200),
    passage: boundedText(MAX_CURRENT_MESSAGE_CHARS),
    url: z.string().url().max(2_048),
    language: languageTagSchema,
    coverageState: z.enum([
      'direct_evidence',
      'interaction_found',
      'checked_no_interaction_record',
      'candidate_only',
      'coverage_unknown',
    ]),
    allowedTemplateIds: z.array(opaqueIdSchema).max(MAX_TURN_REFERENCES),
  })
  .strict();

export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;

export const conversationObservationSchema = z
  .object({
    kind: z.enum([
      'symptom',
      'severity',
      'frequency',
      'duration',
      'sleep',
      'context',
      'medication_taking',
      'correction',
    ]),
    statement: boundedText(1_000),
    sourceMessageId: uuidSchema.nullable().optional(),
    normalizedValue: boundedText(200).nullable(),
    severity: z.number().int().min(1).max(10).nullable(),
    temporalCandidateIds: z.array(uuidSchema).max(MAX_TURN_REFERENCES),
    patientMedicationIds: z.array(uuidSchema).max(MAX_TURN_REFERENCES),
    evidenceIds: z.array(opaqueIdSchema).max(MAX_TURN_REFERENCES),
    clinicalEventId: uuidSchema.nullable(),
    supersedesClinicalEventId: uuidSchema.nullable(),
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.kind !== 'correction' && observation.supersedesClinicalEventId !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supersedesClinicalEventId'],
        message: 'Only correction observations can supersede a clinical event',
      });
    }
  });

export type ConversationObservation = z.infer<typeof conversationObservationSchema>;

const acknowledgeActionSchema = z.object({ type: z.literal('acknowledge') }).strict();
const askClarificationActionSchema = z
  .object({
    type: z.literal('ask_clarification'),
    clarification: boundedText(MAX_PATIENT_WORDING_CHARS),
    clarificationTopic: conversationClarificationTopicSchema,
  })
  .strict();
const completeTurnActionSchema = z.object({ type: z.literal('complete_turn') }).strict();

export const conversationActionSchema = z.discriminatedUnion('type', [
  acknowledgeActionSchema,
  askClarificationActionSchema,
  completeTurnActionSchema,
]);

export type ConversationAction = z.infer<typeof conversationActionSchema>;

const proposedCorrectionSchema = z
  .object({
    correctionId: uuidSchema,
    factId: uuidSchema.nullable(),
    proposedText: boundedText(1_000),
    rationale: boundedText(1_000),
    sourceMessageIds: z.array(uuidSchema).min(1).max(MAX_TURN_REFERENCES),
  })
  .strict();

const patientStatementSchema = z
  .object({
    sourceMessageId: uuidSchema,
    text: boundedText(1_000),
  })
  .strict();

export const clinicianReviewDraftSchema = z
  .object({
    patientStatements: z.array(patientStatementSchema).max(MAX_TURN_REFERENCES),
    establishedFactIds: z.array(uuidSchema).max(MAX_TURN_REFERENCES),
    inferences: z.array(boundedText(1_000)).max(MAX_TURN_REFERENCES),
    uncertainties: z.array(boundedText(1_000)).max(MAX_TURN_REFERENCES),
    evidenceIds: z.array(opaqueIdSchema).max(MAX_TURN_REFERENCES),
    proposedCorrections: z.array(proposedCorrectionSchema).max(10),
  })
  .strict();

export type ClinicianReviewDraft = z.infer<typeof clinicianReviewDraftSchema>;

const clinicalClaimSchema = z
  .object({
    templateId: opaqueIdSchema,
    evidenceId: opaqueIdSchema,
  })
  .strict()
  .nullable();

const conversationTurnInputObjectSchema = z
  .object({
    requestId: uuidSchema,
    patientId: uuidSchema,
    inboundMessageId: uuidSchema,
    currentMessage: conversationMessageSchema,
    locale: localeMetadataSchema,
    currentDayMessages: z.array(conversationMessageSchema).max(MAX_CONTEXT_MESSAGES),
    pendingClarification: boundedText(MAX_PATIENT_WORDING_CHARS).nullable(),
    pendingClarificationTopic: conversationClarificationTopicSchema.nullable(),
    pendingClarificationSourceMessageId: uuidSchema.nullable().optional(),
    // Dose of the most recent unanswered check-in at message receipt (2026-08-11
    // fork decision R2): a reply arriving against a just-sent check-in binds to
    // that dose deterministically. Defaulted so recorded pre-R2 inputs still
    // parse; excluded from the model-visible projection by the pick() allowlist.
    promptedDoseId: uuidSchema.nullable().default(null),
    recentObservations: z.array(conversationObservationSchema).max(MAX_RECENT_OBSERVATIONS),
    activeMedications: z.array(activeMedicationContextSchema).max(MAX_ACTIVE_MEDICATIONS),
    clinicalFacts: z.array(clinicalFactReferenceSchema).max(MAX_CLINICAL_FACTS),
    drugInteractions: z
      .array(conversationDrugInteractionSchema)
      .max(MAX_TURN_REFERENCES)
      .default([]),
    temporalCandidates: z.array(temporalCandidateSchema).max(MAX_TURN_REFERENCES),
    evidence: z.array(evidenceReferenceSchema).max(MAX_TURN_REFERENCES),
    promptVersion: versionSchema,
    schemaVersion: conversationSchemaVersionSchema,
  })
  .strict();

const currentMessageIsInbound = (input: { currentMessage: { direction: string } }): boolean =>
  input.currentMessage.direction === 'inbound';

const INBOUND_CURRENT_MESSAGE_ISSUE = {
  path: ['currentMessage', 'direction'],
  message: 'The current turn message must be inbound',
};

export const conversationTurnInputSchema = conversationTurnInputObjectSchema.refine(
  currentMessageIsInbound,
  INBOUND_CURRENT_MESSAGE_ISSUE,
);

export type ConversationTurnInput = z.infer<typeof conversationTurnInputSchema>;

export const conversationTurnResultSchema = z
  .object({
    detectedLanguage: languageTagSchema,
    languageConfidence: z.number().min(0).max(1),
    mixedLanguage: z.boolean(),
    translationUncertain: z.boolean(),
    normalizedEnglishMeaning: boundedText(MAX_CURRENT_MESSAGE_CHARS),
    adherenceClassification: AdherenceClassification.nullable(),
    observations: z.array(conversationObservationSchema).max(MAX_RECENT_OBSERVATIONS),
    temporalCandidateIds: z.array(uuidSchema).max(MAX_TURN_REFERENCES),
    action: conversationActionSchema,
    socialAcknowledgement: boundedText(MAX_PATIENT_WORDING_CHARS),
    clinicalClaim: clinicalClaimSchema,
    clinicianReviewDraft: clinicianReviewDraftSchema,
    selectedEvidenceIds: z.array(opaqueIdSchema).max(MAX_TURN_REFERENCES),
    safetyCandidate: z.enum(['none', 'routine', 'important', 'emergency']),
  })
  .strict()
  .superRefine(({ observations }, context) => {
    observations.forEach((observation, index) => {
      if (observation.clinicalEventId !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['observations', index, 'clinicalEventId'],
          message: 'A new turn result cannot claim a persisted clinical event id',
        });
      }
    });
  });

export type ConversationTurnResult = z.infer<typeof conversationTurnResultSchema>;

export const conversationTurnResultJsonSchema = zodToJsonSchema(conversationTurnResultSchema, {
  $refStrategy: 'none',
  target: 'jsonSchema7',
});

const adherenceCountsSchema = z
  .object({
    taken: z.number().int().nonnegative(),
    delayed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    stopped: z.number().int().nonnegative(),
    question: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  })
  .strict();

export const dailySummarySchema = z
  .object({
    summaryId: uuidSchema,
    version: z.number().int().positive(),
    inputHash: sha256Schema,
    localDate: isoDateSchema,
    patientTimeZone: timeZoneSchema,
    windowStartUtc: isoDateTimeSchema,
    windowEndUtc: isoDateTimeSchema,
    summaryText: boundedText(MAX_CURRENT_MESSAGE_CHARS),
    eventIds: z.array(uuidSchema).max(100),
    highestPriority: z.enum(['none', 'routine', 'important', 'emergency']),
    symptomCount: z.number().int().nonnegative().max(100),
    adherenceCounts: adherenceCountsSchema,
  })
  .strict()
  .refine((summary) => summary.windowEndUtc > summary.windowStartUtc, {
    path: ['windowEndUtc'],
    message: 'Summary window must end after it starts',
  });

export type DailySummary = z.infer<typeof dailySummarySchema>;

export const clinicianReviewActionSchema = z
  .object({
    draftId: uuidSchema,
    expectedVersion: z.number().int().positive(),
    decision: z.enum(['confirm', 'reject']),
    selectedProposedCorrectionIds: z.array(uuidSchema).max(10),
  })
  .strict()
  .refine(
    (action) => action.decision === 'confirm' || action.selectedProposedCorrectionIds.length === 0,
    {
      path: ['selectedProposedCorrectionIds'],
      message: 'Rejected drafts cannot apply proposed corrections',
    },
  );

export type ClinicianReviewAction = z.infer<typeof clinicianReviewActionSchema>;
