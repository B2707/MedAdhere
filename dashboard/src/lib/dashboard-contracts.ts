import { z } from 'zod';

export const recentDoseOutcomeSchema = z.object({
  dose_id: z.string(),
  scheduled_at: z.string().datetime({ offset: true }),
  status: z.enum(['recorded', 'missed']).nullable(),
  adherence_state: z
    .enum(['taken', 'delayed', 'skipped', 'stopped', 'unknown', 'question'])
    .nullable(),
  decided_by: z.enum(['classifier', 'timeout']).nullable(),
});

export const patientRowSchema = z.object({
  id: z.string(),
  display_name: z.string().nullable(),
  phone: z.string(),
  medication_name: z.string(),
  is_test: z.boolean(),
  is_active: z.boolean(),
  agent_enabled: z.boolean(),
  provider_opted_in: z.boolean(),
  opted_out_at: z.string().nullable(),
  created_at: z.string(),
  consecutive_missed: z.number().int().nonnegative(),
  alerting: z.boolean(),
  // The SEPARATE reported-miss streak (classifier 'skipped'). Defaulted so the dashboard deploys
  // FIRST and still accepts an old backend that does not send these fields yet.
  consecutive_reported_misses: z.number().int().nonnegative().default(0),
  reported_miss_alerting: z.boolean().default(false),
  adherence_rate: z.number().min(0).max(1).nullable(),
  last_reply_at: z.string().datetime({ offset: true }).nullable(),
  recent_doses: z.array(recentDoseOutcomeSchema),
});

export const patientsResponseSchema = z.object({
  patients: z.array(patientRowSchema),
  alertThreshold: z.number().int().nonnegative(),
});

export const cohortDaySchema = z.object({
  day: z.string(),
  delivered: z.number(),
  responded: z.number(),
  confirmed: z.number(),
  taken_delayed: z.number(),
  ambiguous: z.number(),
  non_response: z.number(),
  adherence_rate: z.number().nullable(),
  response_rate: z.number().nullable(),
});

export const cohortResponseSchema = z.object({
  series: z.array(cohortDaySchema),
});

export const timelineLabelMatchSchema = z.object({
  id: z.string(),
  matched_phrase: z.string(),
  meddra_pt: z.string(),
  hint_level: z.enum(['info', 'elevated']),
});

export const timelineRowSchema = z.object({
  dose_id: z.string(),
  scheduled_at: z.string(),
  dose_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  local_dose_time: z.string(),
  status: z.enum(['recorded', 'missed']).nullable(),
  adherence_state: z
    .enum(['taken', 'delayed', 'skipped', 'stopped', 'unknown', 'question'])
    .nullable(),
  reason_code: z.enum(['none', 'side_effect', 'ran_out', 'forgot', 'other']).nullable(),
  decided_by: z.enum(['classifier', 'timeout']).nullable(),
  is_late: z.boolean().nullable(),
  label_matches: z.array(timelineLabelMatchSchema),
});

export const patientDetailSchema = z.object({
  id: z.string(),
  display_name: z.string().nullable(),
  phone: z.string(),
  medication_name: z.string(),
  timezone: z.string(),
  is_test: z.boolean(),
  is_active: z.boolean(),
  opted_out_at: z.string().nullable(),
  created_at: z.string(),
  drug_profile_json: z.unknown(),
  drug_profile_fetched_at: z.string().nullable(),
  consecutive_missed: z.number().int().nonnegative(),
  alerting: z.boolean(),
  // Defaulted (not required) so the .strict() record patient tolerates an old backend — the
  // dashboard-first deploy order for additions to the strict record schema.
  consecutive_reported_misses: z.number().int().nonnegative().default(0),
  reported_miss_alerting: z.boolean().default(false),
});

export const patientDetailResponseSchema = z.object({
  patient: patientDetailSchema,
  timeline: z.array(timelineRowSchema),
  alertThreshold: z.number().int().nonnegative(),
  timelineWindowDays: z.number().int().positive(),
});

// Phase 8 (08-06) adds a separate selected-day record contract so the existing detail route remains
// compatible while the richer page moves to GET /api/patients/{id}/record.
export const PATIENT_RECORD_LIMITS = {
  timeline: 100,
  timelineLabelMatches: 5,
  timelineLabelText: 128,
  dayIndex: 90,
  messages: 50,
  events: 50,
  evidence: 25,
  versions: 100,
  alerts: 25,
  alertRequest: 100,
  drafts: 3,
  draftRequest: 10,
  trendPoints: 90,
  historyMedications: 100,
  historyFacts: 200,
  historyIngredients: 4,
  historyIngredientName: 128,
  historyFactText: 500,
  reviewQueue: 100,
} as const;

// Mirrors the backend's fixed contract: one MiB below Lambda's 6 MiB synchronous payload ceiling.
export const PATIENT_RECORD_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const MAX_INT4 = 2_147_483_647;
const MAX_SUMMARY_EVENTS = 100;
const MAX_DRAFT_ITEMS = 20;
const MAX_DRAFT_CORRECTIONS = 10;
const MAX_SELECTED_CORRECTIONS = 30;
const MAX_MEDICATION_INGREDIENTS = 32;
const uuidSchema = z.string().uuid();
const localDateSchema = z.string().date();
const timestampSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const languageTagSchema = z.string().min(2).max(35);
const localTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$/);
const pageCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/)
  .nullable();

export const CLINICAL_EVENT_TYPES = [
  'patient_statement',
  'observation',
  'adherence',
  'context',
  'alert',
] as const;
export const SUMMARY_TIERS = ['none', 'routine', 'important', 'emergency'] as const;
export const ALERT_TIERS = ['emergency', 'important', 'fallback'] as const;
export const OUTBOUND_MESSAGE_STATUSES = [
  'prepared',
  'queued',
  'sending',
  'sending_unknown',
  'sent',
  'delivered',
  'undelivered',
  'failed',
] as const;

const adherenceCountsSchema = z
  .object({
    taken: z.number().int().nonnegative(),
    delayed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    stopped: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
    question: z.number().int().nonnegative(),
  })
  .strict();

export const patientRecordPatientSchema = patientDetailSchema
  .extend({
    id: uuidSchema,
    display_name: z.string().max(320).nullable(),
    phone: z.string().min(1).max(32),
    medication_name: z.string().min(1).max(320),
    timezone: z.string().min(1).max(64),
    opted_out_at: timestampSchema.nullable(),
    created_at: timestampSchema,
    drug_profile_json: z.never().optional(),
    drug_profile_fetched_at: timestampSchema.nullable(),
    preferred_language: languageTagSchema,
    reminder_limit: z.number().int().min(0).max(5),
    agent_enabled: z.boolean(),
    provider_opted_in: z.boolean(),
    messaging_state_version: z.number().int().positive().max(MAX_INT4),
  })
  .strict();

export const patientRecordWindowSchema = z
  .object({
    days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
    selectedDay: localDateSchema,
  })
  .strict();

export const patientDayIndexRowSchema = z
  .object({
    local_date: localDateSchema,
    latest_summary_version: z.number().int().positive().max(MAX_INT4).nullable(),
    highest_tier: z.enum(SUMMARY_TIERS),
    message_count: z.number().int().nonnegative(),
    event_count: z.number().int().nonnegative(),
    alert_count: z.number().int().nonnegative(),
    has_draft: z.boolean(),
  })
  .strict();

export const daySummaryPayloadSchema = z
  .object({
    localDate: localDateSchema,
    patientTimeZone: z.string().min(1).max(64),
    eventCount: z.number().int().nonnegative(),
    detailedEventCount: z.number().int().nonnegative().max(MAX_SUMMARY_EVENTS),
    truncated: z.boolean(),
    eventIds: z.array(uuidSchema).max(MAX_SUMMARY_EVENTS),
    events: z
      .array(
        z
          .object({
            eventId: uuidSchema,
            eventType: z.enum(CLINICAL_EVENT_TYPES),
            eventCode: z.string().max(128).nullable(),
            occurredAtUtc: timestampSchema,
            severity: z.number().int().min(1).max(10).nullable(),
            priority: z.enum(SUMMARY_TIERS),
          })
          .strict(),
      )
      .max(MAX_SUMMARY_EVENTS),
    symptomCount: z.number().int().nonnegative(),
    adherenceCounts: adherenceCountsSchema,
    highestPriority: z.enum(SUMMARY_TIERS),
  })
  .strict();

export const daySummarySchema = z
  .object({
    id: uuidSchema,
    local_date: localDateSchema,
    version: z.number().int().positive().max(MAX_INT4),
    input_hash: sha256Schema,
    event_count: z.number().int().nonnegative(),
    highest_tier: z.enum(SUMMARY_TIERS),
    summary_text: z.string().max(4000),
    window_start: timestampSchema,
    window_end: timestampSchema,
    structured_payload: daySummaryPayloadSchema,
    supersedes_id: uuidSchema.nullable(),
    created_at: timestampSchema,
  })
  .strict();

export const conversationMessageRowSchema = z
  .object({
    id: uuidSchema,
    direction: z.enum(['inbound', 'outbound']),
    body: z.string().max(2000).nullable(),
    occurred_at: timestampSchema,
    language: languageTagSchema.nullable(),
    detected_language: languageTagSchema.nullable(),
    normalized_english_meaning: z.string().max(2000).nullable(),
    translated_text: z.string().max(2000).nullable(),
    message_kind: z
      .enum(['check_in', 'clarification', 'acknowledgement', 'reminder', 'safety', 'fallback'])
      .nullable(),
    status: z.enum(OUTBOUND_MESSAGE_STATUSES).nullable(),
    reminder_attempt: z.number().int().min(1).max(5).nullable(),
    // EVERY backend NeedField must appear below: the backend writes the raw NeedField into this
    // column (repository.ts, no translation), and one unlisted value fails this whole strict
    // envelope, dropping the clinician's entire day view (messages, summary, alerts, timeline) to
    // its error state. The dashboard deliberately does not depend on @medadhere/shared, so this
    // stays a hand-maintained copy of that vocabulary (packages/shared conversation-contract.ts
    // CONVERSATION_CLARIFICATION_TOPICS is the source of truth) — extend it here FIRST
    // (dashboard-first deploy) whenever a NeedField is added. Pinned by the NeedField list in
    // dashboard-contracts.test.ts.
    // Wave-3 (2026-08-17): this list was previously missing 'symptom_identity' — the ACTIVE,
    // ongoing NeedField the resolver asks with "What symptom are you experiencing?"
    // (resolver.ts:1632, response.ts:25), not a legacy pre-rename spelling. A parse-time
    // preprocess used to paper over the gap by rewriting it to 'symptom' (a value the current
    // resolver never actually produces); restored as its own literal instead, so every future
    // symptom-identity clarification parses without a substitution shim. Rows stored from before
    // the enum caught up need no conversion either — 'symptom_identity' is exactly what the
    // backend wrote, and it is a first-class literal here now. (The Wave-3 cleanup script that
    // would have rewritten them to 'symptom' was deleted: it had no reader to satisfy, and would
    // have destroyed which question was actually asked.)
    clarification_topic: z
      .enum([
        'medication_identity',
        'medication_taking',
        'dose_identity',
        'event_identity',
        'dose_time',
        'dose_day',
        'dose_meridiem',
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
        'late_intent',
        'onset',
        'quality',
        'triggers',
        'associated_symptoms',
        'recurrence_history',
        'other',
      ])
      .nullable(),
    is_late: z.boolean().nullable(),
    agent_turn_id: uuidSchema.nullable(),
    in_reply_to_inbound_id: uuidSchema.nullable(),
    // Provider send evidence: NULL marks a never-sent outbound row (suppressed record-only).
    // Optional so the dashboard tolerates an OLD backend that omits it (dashboard-first deploy).
    sent_at: timestampSchema.nullable().optional(),
  })
  .strict();

export const clinicalEventRowSchema = z
  .object({
    id: uuidSchema,
    // 'symptom' is not a value this reader accepts, and it is not rewritten at parse time. The
    // WRITER now projects a symptom-kind event onto 'patient_statement' at the storage seam
    // (backend/.../clinical-memory/canonical-projections.ts storedEventType), so no new row can
    // arrive in the old spelling. Rows written BEFORE that projection keep it permanently —
    // clinical_event is append-only, so no backfill can convert them (SQLSTATE 55000). They are
    // handled where they belong, at the data-api seam: the day-events read projects 'symptom' to
    // 'patient_statement' (backend/src/data-api/patient-record.ts READ_EVENT_TYPE_SQL), so the
    // API emits only this five-value vocabulary and this reader stays strict.
    event_type: z.enum(CLINICAL_EVENT_TYPES),
    event_code: z.string().max(128).nullable(),
    statement_text: z.string().max(2000).nullable(),
    normalized_value: z.string().max(200).nullable(),
    occurred_at: timestampSchema,
    local_date: localDateSchema,
    local_time: localTimeSchema.nullable(),
    patient_timezone: z.string().max(64).nullable(),
    severity: z.number().int().min(1).max(10).nullable(),
    patient_medication_id: uuidSchema.nullable(),
    dose_id: uuidSchema.nullable(),
    agent_turn_id: uuidSchema.nullable(),
    source_inbound_id: uuidSchema.nullable(),
    supersedes_id: uuidSchema.nullable(),
    created_at: timestampSchema,
  })
  .strict();

export const eventEvidenceSchema = z
  .object({
    clinical_event_id: uuidSchema,
    evidence_id: uuidSchema,
    template_id: z.string().max(128),
    source: z.enum(['ccdd', 'ddinter', 'openfda', 'health_canada', 'onsides', 'medlineplus']),
    source_version: z.string().max(128),
    evidence_code: z.string().max(128),
    passage: z.string().max(4000),
    url: z.string().max(2048),
    language: languageTagSchema,
    coverage_state: z.enum(['direct_evidence', 'candidate_only', 'coverage_unknown']),
  })
  .strict();

export const recordVersionSchema = z
  .object({
    record_kind: z.enum([
      'daily_summary',
      'clinician_review_draft',
      'clinical_event',
      'clinical_fact',
      'patient_medication',
    ]),
    id: uuidSchema,
    version: z.number().int().positive().max(MAX_INT4).nullable(),
    supersedes_id: uuidSchema.nullable(),
    created_at: timestampSchema,
  })
  .strict();

export const patientAlertSchema = z
  .object({
    id: uuidSchema,
    event_code: z.string().max(128),
    tier: z.enum(ALERT_TIERS),
    statement_text: z.string().max(2000).nullable(),
    occurred_at: timestampSchema,
    local_date: localDateSchema,
    source_inbound_id: uuidSchema.nullable(),
    agent_turn_id: uuidSchema.nullable(),
    final_policy_tier: z.enum(['routine', 'important', 'emergency', 'stop']).nullable(),
    created_at: timestampSchema,
  })
  .strict();

export const proposedCorrectionSchema = z
  .object({
    correctionId: uuidSchema,
    factId: uuidSchema.nullable(),
    proposedText: z.string().min(1).max(1000),
    rationale: z.string().min(1).max(1000),
    sourceMessageIds: z.array(uuidSchema).min(1).max(MAX_DRAFT_ITEMS),
  })
  .strict();

export const reviewActionSchema = z
  .object({
    id: uuidSchema,
    decision: z.enum(['confirm', 'reject']),
    expected_version: z.number().int().positive().max(MAX_INT4),
    selected_correction_ids: z.array(uuidSchema).max(MAX_SELECTED_CORRECTIONS),
    created_at: timestampSchema,
  })
  .strict();

export const reviewDraftSchema = z
  .object({
    id: uuidSchema,
    local_date: localDateSchema,
    version: z.number().int().positive().max(MAX_INT4),
    input_hash: sha256Schema,
    draft_text: z.string().max(8000),
    patient_statements: z
      .array(z.object({ sourceMessageId: uuidSchema, text: z.string().max(1000) }).strict())
      .max(MAX_DRAFT_ITEMS),
    confirmed_facts: z.array(uuidSchema).max(MAX_DRAFT_ITEMS),
    model_inferences: z.array(z.string().max(1000)).max(MAX_DRAFT_ITEMS),
    uncertainties: z.array(z.string().max(1000)).max(MAX_DRAFT_ITEMS),
    evidence_references: z.array(z.string().max(128)).max(MAX_DRAFT_ITEMS),
    proposed_corrections: z.array(proposedCorrectionSchema).max(MAX_DRAFT_CORRECTIONS),
    source_agent_turn_id: uuidSchema.nullable(),
    supersedes_id: uuidSchema.nullable(),
    created_at: timestampSchema,
    is_latest: z.boolean(),
    latest_action: reviewActionSchema.nullable(),
  })
  .strict();

export const clinicalHistorySchema = z
  .object({
    medications: z
      .array(
        z
          .object({
            id: uuidSchema,
            enteredName: z.string().max(320),
            identity: z
              .object({
                system: z.enum(['ccdd', 'din', 'rxnorm', 'local']),
                code: z.string().max(64),
              })
              .strict()
              .nullable(),
            doseText: z.string().max(160).nullable(),
            form: z.string().max(80).nullable(),
            route: z.string().max(80).nullable(),
            validFrom: localDateSchema,
            validTo: localDateSchema.nullable(),
            status: z.enum(['active', 'stopped', 'corrected']),
            supersedesId: uuidSchema.nullable(),
            ingredients: z
              .array(
                z
                  .object({
                    name: z.string().max(320),
                    ccddIngredientCode: z.string().max(64).nullable(),
                    rxcui: z.string().max(32).nullable(),
                  })
                  .strict(),
              )
              .max(MAX_MEDICATION_INGREDIENTS),
          })
          .strict(),
      )
      .max(PATIENT_RECORD_LIMITS.historyMedications),
    facts: z
      .array(
        z
          .object({
            id: uuidSchema,
            factType: z.enum(['condition', 'allergy', 'note']),
            factCode: z.string().max(128).nullable(),
            statementText: z.string().max(1000),
            status: z.enum(['current', 'corrected', 'retracted']),
            supersedesId: uuidSchema.nullable(),
          })
          .strict(),
      )
      .max(PATIENT_RECORD_LIMITS.historyFacts),
  })
  .strict();

const patientRecordMedicationHistorySchema = clinicalHistorySchema.shape.medications.element.extend(
  {
    ingredients: z
      .array(
        clinicalHistorySchema.shape.medications.element.shape.ingredients.element.extend({
          name: z.string().max(PATIENT_RECORD_LIMITS.historyIngredientName),
        }),
      )
      .max(PATIENT_RECORD_LIMITS.historyIngredients),
  },
);
const patientRecordClinicalHistorySchema = z
  .object({
    medications: z
      .array(patientRecordMedicationHistorySchema)
      .max(PATIENT_RECORD_LIMITS.historyMedications),
    facts: z
      .array(
        clinicalHistorySchema.shape.facts.element.extend({
          statementText: z.string().max(PATIENT_RECORD_LIMITS.historyFactText),
        }),
      )
      .max(PATIENT_RECORD_LIMITS.historyFacts),
  })
  .strict();

export const patientTrendsSchema = z
  .object({
    severity: z
      .array(
        z
          .object({
            local_date: localDateSchema,
            symptom: z.string().min(1).max(200),
            max_severity: z.number().int().min(1).max(10),
            observation_count: z.number().int().positive(),
          })
          .strict(),
      )
      .max(PATIENT_RECORD_LIMITS.trendPoints),
    adherence: z
      .array(adherenceCountsSchema.extend({ local_date: localDateSchema }).strict())
      .max(PATIENT_RECORD_LIMITS.trendPoints),
  })
  .strict();

const boundedPageSchema = <T extends z.ZodTypeAny>(
  itemSchema: T,
  maximum: number,
  maximumLimit = maximum,
) =>
  z
    .object({
      items: z.array(itemSchema).max(maximum),
      cursor: pageCursorSchema,
      nextCursor: pageCursorSchema,
      limit: z.number().int().min(1).max(maximumLimit),
    })
    .strict()
    .refine((page) => page.items.length <= page.limit, {
      path: ['items'],
      message: 'page cannot contain more items than its limit',
    });

export const patientAlertsPageSchema = boundedPageSchema(
  patientAlertSchema,
  PATIENT_RECORD_LIMITS.alerts,
  PATIENT_RECORD_LIMITS.alertRequest,
);
export const patientDraftsPageSchema = boundedPageSchema(
  reviewDraftSchema,
  PATIENT_RECORD_LIMITS.drafts,
  PATIENT_RECORD_LIMITS.draftRequest,
);

export const patientRecordResponseSchema = z
  .object({
    patient: patientRecordPatientSchema,
    timeline: z
      .array(
        timelineRowSchema
          .extend({
            label_matches: z
              .array(
                timelineLabelMatchSchema.extend({
                  matched_phrase: z.string().max(PATIENT_RECORD_LIMITS.timelineLabelText),
                  meddra_pt: z.string().max(PATIENT_RECORD_LIMITS.timelineLabelText),
                }),
              )
              .max(PATIENT_RECORD_LIMITS.timelineLabelMatches),
          })
          .strict(),
      )
      .max(PATIENT_RECORD_LIMITS.timeline),
    alertThreshold: z.number().int().nonnegative(),
    timelineWindowDays: z.number().int().positive(),
    window: patientRecordWindowSchema,
    dayIndex: z.array(patientDayIndexRowSchema).max(PATIENT_RECORD_LIMITS.dayIndex),
    daySummary: daySummarySchema.nullable(),
    messages: z.array(conversationMessageRowSchema).max(PATIENT_RECORD_LIMITS.messages),
    events: z.array(clinicalEventRowSchema).max(PATIENT_RECORD_LIMITS.events),
    evidence: z.array(eventEvidenceSchema).max(PATIENT_RECORD_LIMITS.evidence),
    versions: z.array(recordVersionSchema).max(PATIENT_RECORD_LIMITS.versions),
    alertsPage: patientAlertsPageSchema,
    draftsPage: patientDraftsPageSchema,
    history: patientRecordClinicalHistorySchema,
    trends: patientTrendsSchema,
  })
  .strict()
  .refine(
    (response) =>
      new TextEncoder().encode(JSON.stringify(response)).byteLength <=
      PATIENT_RECORD_MAX_RESPONSE_BYTES,
    { message: 'patient record response exceeds safe size' },
  );

export const alertQueueItemSchema = z
  .object({
    id: uuidSchema,
    patient_id: uuidSchema,
    display_name: z.string().max(320).nullable(),
    event_code: z.string().max(128),
    tier: z.enum(ALERT_TIERS),
    statement_text: z.string().max(2000).nullable(),
    occurred_at: timestampSchema,
    local_date: localDateSchema,
    source_inbound_id: uuidSchema.nullable(),
    raw_body: z.string().max(2000).nullable(),
    created_at: timestampSchema,
  })
  .strict();

export const draftQueueItemSchema = z
  .object({
    id: uuidSchema,
    patient_id: uuidSchema,
    display_name: z.string().max(320).nullable(),
    local_date: localDateSchema,
    version: z.number().int().positive().max(MAX_INT4),
    draft_text: z.string().max(8000),
    proposed_correction_count: z.number().int().min(0).max(MAX_DRAFT_CORRECTIONS),
    has_action: z.boolean(),
    created_at: timestampSchema,
  })
  .strict();

export const alertQueueResponseSchema = z
  .object({
    alertsPage: boundedPageSchema(alertQueueItemSchema, PATIENT_RECORD_LIMITS.reviewQueue),
  })
  .strict();
export const draftQueueResponseSchema = z
  .object({
    draftsPage: boundedPageSchema(draftQueueItemSchema, PATIENT_RECORD_LIMITS.reviewQueue),
  })
  .strict();

export type RecentDoseOutcome = z.infer<typeof recentDoseOutcomeSchema>;
export type PatientRow = z.infer<typeof patientRowSchema>;
export type PatientsResponse = z.infer<typeof patientsResponseSchema>;
export type CohortDay = z.infer<typeof cohortDaySchema>;
export type TimelineLabelMatch = z.infer<typeof timelineLabelMatchSchema>;
export type TimelineRow = z.infer<typeof timelineRowSchema>;
export type PatientDetailResponse = z.infer<typeof patientDetailResponseSchema>;
export type PatientRecordResponse = z.infer<typeof patientRecordResponseSchema>;
export type PatientAlert = z.infer<typeof patientAlertSchema>;
export type ReviewDraft = z.infer<typeof reviewDraftSchema>;
export type ClinicalHistory = z.infer<typeof clinicalHistorySchema>;
export type PatientTrends = z.infer<typeof patientTrendsSchema>;
export type AlertQueueResponse = z.infer<typeof alertQueueResponseSchema>;
export type DraftQueueResponse = z.infer<typeof draftQueueResponseSchema>;
