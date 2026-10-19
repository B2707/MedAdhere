import { z } from 'zod';

const MAX_ITEMS = 128;
export const MAX_RECENT_COMMAND_BATCHES = 128;
const idSchema = z.string().trim().min(1).max(160);
const textSchema = z.string().trim().min(1).max(1_000);
const sourceQuoteSchema = z
  .string()
  .min(1)
  .max(4_000)
  .refine((value) => value.trim().length > 0, 'Source quote must contain non-whitespace text');
const idsSchema = z
  .array(idSchema)
  .max(MAX_ITEMS)
  .refine((values) => new Set(values).size === values.length, 'IDs must be unique');

export const needFieldSchema = z.enum([
  'medication_identity',
  'dose_identity',
  'event_identity',
  'symptom_identity',
  'severity',
  'actual_time',
  'duration',
  'body_site',
  'frequency',
  /**
   * Wave 1c: opened on a missed OR pending ("not yet") administration report. The pinned
   * question is strictly informational ("Do you plan to take it later today?") and renders
   * unlabeled — see QUESTIONS in response.ts — so it deliberately sits outside
   * LABEL_REQUIRED_NEED_FIELDS below.
   */
  'late_intent',
  /**
   * Wave 1e — AI-led symptom context gathering. The closed question bank per context category:
   * onset (this field), quality/description, better/worse triggers, associated symptoms, and
   * happened-before/recurrence-history round out the bank alongside the REUSED existing fields
   * severity (strength), duration, and body_site (location). See CONTEXT_BATTERY_FIELDS below —
   * the closed set of just these five NEW fields the AI-selection/authored-question machinery
   * is scoped to.
   */
  'onset',
  'quality',
  'triggers',
  'associated_symptoms',
  'recurrence_history',
]);
export const needStateSchema = z.enum([
  'open',
  'asked',
  'resolved',
  'patient_does_not_know',
  'declined',
  'superseded',
  'expired',
]);

export const sourceSpanSchema = z
  .object({
    messageId: idSchema,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quote: sourceQuoteSchema,
  })
  .strict()
  .refine(({ start, end, quote }) => end === start + quote.length, 'Invalid source span');

const claimBase = {
  slot: idSchema,
  quote: sourceQuoteSchema,
  polarity: z.enum(['positive', 'negative']),
  experiencer: z.enum(['patient', 'other', 'unknown']),
  status: z.enum(['current', 'resolved', 'historical', 'hypothetical', 'habitual', 'future']),
  certainty: z.enum(['certain', 'uncertain']),
};

export const extractedClaimSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...claimBase,
      kind: z.literal('administration'),
      medicationText: textSchema.optional(),
      doseText: textSchema.optional(),
      timeText: textSchema.optional(),
      actionText: textSchema,
    })
    .strict(),
  z
    .object({
      ...claimBase,
      kind: z.literal('correction'),
      medicationText: textSchema.optional(),
      doseText: textSchema.optional(),
      timeText: textSchema.optional(),
      actionText: textSchema.optional(),
      symptomText: textSchema.optional(),
      targetText: textSchema.optional(),
      targetClaimSlot: idSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...claimBase,
      kind: z.literal('symptom'),
      symptomText: textSchema,
      bodySiteText: textSchema.optional(),
      timeText: textSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...claimBase,
      kind: z.literal('symptom_detail'),
      targetText: textSchema.optional(),
      targetClaimSlot: idSchema.optional(),
      detailField: z.enum(['severity', 'duration', 'body_site', 'status', 'frequency']),
      detailText: textSchema,
    })
    .strict(),
  z
    .object({
      ...claimBase,
      kind: z.literal('recurrence'),
      symptomText: textSchema,
      bodySiteText: textSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...claimBase,
      kind: z.literal('need_answer'),
      answerField: needFieldSchema,
      answerText: textSchema,
      timeText: textSchema.optional(),
    })
    .strict(),
  z.object({ ...claimBase, kind: z.literal('social') }).strict(),
]);

export const relatedExtractedClaimSchema = z
  .object({
    claim: extractedClaimSchema,
    informationNeedId: idSchema.nullable(),
  })
  .strict();

const validatedClaimEnvelopeSchema = z
  .object({
    semanticId: idSchema,
    targetSemanticId: idSchema.optional(),
    informationNeedId: idSchema.optional(),
    sourceSpan: sourceSpanSchema,
  })
  .passthrough();

type ValidatedClaimValue = z.infer<typeof extractedClaimSchema> & {
  semanticId: string;
  targetSemanticId?: string;
  informationNeedId?: string;
  sourceSpan: z.infer<typeof sourceSpanSchema>;
};

export const validatedClaimSchema = validatedClaimEnvelopeSchema.transform<ValidatedClaimValue>(
  (envelope, context) => {
    const { semanticId, targetSemanticId, informationNeedId, sourceSpan, ...untrustedClaim } =
      envelope;
    const claim = extractedClaimSchema.safeParse(untrustedClaim);
    if (!claim.success) {
      for (const issue of claim.error.issues) context.addIssue(issue);
      return z.NEVER;
    }
    return {
      ...claim.data,
      semanticId,
      ...(targetSemanticId === undefined ? {} : { targetSemanticId }),
      ...(informationNeedId === undefined ? {} : { informationNeedId }),
      sourceSpan,
    };
  },
);

export const medicationSnapshotSchema = z
  .object({
    id: idSchema,
    version: z.number().int().positive().default(1),
    names: z.array(textSchema).min(1).max(32),
    aliases: z.array(textSchema).max(32),
    active: z.boolean(),
  })
  .strict();

export const doseSnapshotSchema = z
  .object({
    id: idSchema,
    version: z.number().int().positive().default(1),
    medicationId: idSchema,
    label: textSchema,
    localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
  })
  .strict();

const pipelineVersionsSchema = z
  .object({ extractor: idSchema, resolver: idSchema, reducer: idSchema, renderer: idSchema })
  .strict();

export const CURRENT_CLINICAL_PIPELINE_VERSIONS = {
  extractor: 'extractor-v1',
  resolver: 'resolver-v1',
  reducer: 'reducer-v1',
  // Wave 1a: must stay equal to CLINICAL_RENDERER_VERSION in response.ts (importing it here
  // would create a module cycle); the wave1a-planner test pins the equality. NOTE (2026-08-17,
  // Lane Q): left at v2 for the RE-ASK ROUTE's additive template branches — bumping it breaks
  // repository.db.test.ts's own hardcoded pipelineVersions fixture (outside this lane's
  // ownership) via commitPreparedClinicalTurn's pipeline_version_changed guard; a real bump
  // needs a coordinated update across every hardcoded pipelineVersions fixture, not just here.
  renderer: 'renderer-v2',
} as const;

const ADMINISTRATION_ONLY_FIELDS = [
  'medicationId',
  'medicationVersion',
  'doseId',
  'doseVersion',
  'adherence',
  'timing',
  'exactTime',
] as const;
const SYMPTOM_ONLY_FIELDS = [
  'rawSymptom',
  'symptomConcept',
  'symptomStatus',
  'severity',
  'duration',
  'bodySite',
  'frequency',
  // Wave 1e context-battery fields.
  'onset',
  'quality',
  'triggers',
  'associatedSymptoms',
  'recurrenceHistory',
] as const;
const EVENT_VALUE_FIELDS = [
  'medicationId',
  'medicationVersion',
  'doseId',
  'doseVersion',
  ...ADMINISTRATION_ONLY_FIELDS,
  'timeText',
  'localDate',
  'localTime',
  ...SYMPTOM_ONLY_FIELDS,
] as const;

function hasDefinedField(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): boolean {
  return fields.some((field) => value[field] !== undefined);
}

export const clinicalEventSchema = z
  .object({
    id: idSchema,
    version: z.number().int().positive(),
    kind: z.enum(['administration', 'symptom', 'safety', 'contradiction']),
    operation: z.enum(['create', 'refine', 'correct', 'recur', 'contradict', 'raise_safety']),
    authoredBy: z.enum(['patient', 'clinician']),
    reviewState: z.enum(['unreviewed', 'confirmed', 'rejected']),
    current: z.boolean(),
    canonical: z.boolean(),
    sourceMessageIds: idsSchema,
    sourceSpans: z.array(sourceSpanSchema).max(MAX_ITEMS),
    medicationId: idSchema.optional(),
    medicationVersion: z.number().int().positive().optional(),
    doseId: idSchema.optional(),
    doseVersion: z.number().int().positive().optional(),
    adherence: z.enum(['taken', 'missed', 'partial']).optional(),
    timing: z.enum(['on_time', 'late', 'unknown']).optional(),
    timeText: textSchema.optional(),
    exactTime: textSchema.optional(),
    localDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .optional(),
    localTime: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u)
      .optional(),
    rawSymptom: textSchema.optional(),
    symptomConcept: textSchema.nullable().optional(),
    symptomStatus: z.enum(['current', 'resolved', 'historical']).optional(),
    severity: textSchema.optional(),
    duration: textSchema.optional(),
    bodySite: textSchema.optional(),
    frequency: textSchema.optional(),
    // Wave 1e context-battery fields — free-text answers, same shape as the fields above.
    onset: textSchema.optional(),
    quality: textSchema.optional(),
    triggers: textSchema.optional(),
    associatedSymptoms: textSchema.optional(),
    recurrenceHistory: textSchema.optional(),
    safetyTier: z.enum(['important', 'emergency']).optional(),
    supersedesEventId: idSchema.optional(),
    recurrenceOfEventId: idSchema.optional(),
    contradictionOfEventId: idSchema.optional(),
  })
  .strict()
  .superRefine((event, context) => {
    const hasAdministrationState = hasDefinedField(event, ADMINISTRATION_ONLY_FIELDS);
    const hasSymptomState = hasDefinedField(event, SYMPTOM_ONLY_FIELDS);
    if (
      (event.kind === 'administration' && (hasSymptomState || event.safetyTier !== undefined)) ||
      (event.kind === 'symptom' && (hasAdministrationState || event.safetyTier !== undefined)) ||
      (event.kind === 'safety' &&
        (hasDefinedField(event, EVENT_VALUE_FIELDS) || event.safetyTier === undefined)) ||
      (event.kind === 'contradiction' && event.safetyTier !== undefined)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'clinical_event_kind_invalid' });
    }

    const superseding = event.operation === 'refine' || event.operation === 'correct';
    const operationValid =
      (event.operation === 'create' &&
        (event.kind === 'administration' || event.kind === 'symptom') &&
        event.supersedesEventId === undefined &&
        event.recurrenceOfEventId === undefined &&
        event.contradictionOfEventId === undefined) ||
      (superseding &&
        (event.kind === 'administration' || event.kind === 'symptom') &&
        event.supersedesEventId !== undefined &&
        (event.recurrenceOfEventId === undefined || event.kind === 'symptom') &&
        event.contradictionOfEventId === undefined) ||
      (event.operation === 'recur' &&
        event.kind === 'symptom' &&
        event.supersedesEventId === undefined &&
        event.recurrenceOfEventId !== undefined &&
        event.contradictionOfEventId === undefined) ||
      (event.operation === 'contradict' &&
        event.kind === 'contradiction' &&
        event.supersedesEventId === undefined &&
        event.recurrenceOfEventId === undefined &&
        event.contradictionOfEventId !== undefined &&
        !event.canonical) ||
      (event.operation === 'raise_safety' &&
        event.kind === 'safety' &&
        event.supersedesEventId === undefined &&
        event.recurrenceOfEventId === undefined &&
        event.contradictionOfEventId === undefined);
    if (!operationValid)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'clinical_event_operation_invalid',
      });

    const medicationPairValid =
      (event.medicationId === undefined) === (event.medicationVersion === undefined);
    const dosePairValid = (event.doseId === undefined) === (event.doseVersion === undefined);
    if (
      !medicationPairValid ||
      !dosePairValid ||
      (event.doseId !== undefined && event.medicationId === undefined)
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'clinical_event_identity_invalid' });

    if (
      event.canonical &&
      event.kind === 'administration' &&
      (event.medicationId === undefined ||
        event.medicationVersion === undefined ||
        event.doseId === undefined ||
        event.doseVersion === undefined ||
        event.adherence === undefined)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'canonical_administration_incomplete',
      });
    if (
      event.canonical &&
      event.kind === 'symptom' &&
      (event.rawSymptom === undefined || event.symptomStatus === undefined)
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'canonical_symptom_incomplete' });

    if (event.authoredBy === 'patient') {
      const spanMessages = [...new Set(event.sourceSpans.map(({ messageId }) => messageId))].sort();
      const declaredMessages = [...event.sourceMessageIds].sort();
      if (
        event.sourceSpans.length === 0 ||
        spanMessages.length !== declaredMessages.length ||
        spanMessages.some((messageId, index) => messageId !== declaredMessages[index])
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'clinical_event_provenance_invalid',
        });
    }
  });

const eventTargetCandidateSchema = z
  .object({ eventId: idSchema, eventVersion: z.number().int().positive() })
  .strict();

const correctionChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('set_adherence'), value: z.enum(['taken', 'missed']) }).strict(),
  z
    .object({
      kind: z.literal('set_medication_dose'),
      medicationId: idSchema,
      medicationVersion: z.number().int().positive(),
      doseId: idSchema,
      doseVersion: z.number().int().positive(),
      localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
      localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
    })
    .strict(),
  z
    .object({
      kind: z.literal('set_symptom_identity'),
      rawSymptom: textSchema,
      symptomConcept: textSchema.nullable(),
    })
    .strict(),
]);

export const deferredClinicalOperationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('correct'),
      sourceMessageId: idSchema,
      sourceSpans: z.array(sourceSpanSchema).min(1).max(MAX_ITEMS),
      changes: z
        .array(correctionChangeSchema)
        .min(1)
        .max(3)
        .refine(
          (changes) => new Set(changes.map(({ kind }) => kind)).size === changes.length,
          'Correction changes must be unique',
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal('recur'),
      sourceMessageId: idSchema,
      sourceSpans: z.array(sourceSpanSchema).min(1).max(MAX_ITEMS),
      rawSymptom: textSchema,
      bodySite: textSchema.optional(),
    })
    .strict(),
]);

export const informationNeedSchema = z
  .object({
    id: idSchema,
    version: z.number().int().positive(),
    originInboundMessageId: idSchema,
    originInboundSequence: z.number().int().positive(),
    targetEventId: idSchema.optional(),
    targetEventVersion: z.number().int().positive().optional(),
    field: needFieldSchema,
    candidateMedicationIds: idsSchema,
    candidateDoseIds: idsSchema,
    candidateSymptomEventIds: idsSchema,
    candidateHistoricalEventIds: idsSchema,
    candidateHistoricalEvents: z.array(eventTargetCandidateSchema).max(MAX_ITEMS).optional(),
    questionId: idSchema,
    clarificationAttemptUsed: z.boolean(),
    state: needStateSchema,
    priority: z.number().int().nonnegative().max(1_000),
    supersedesNeedId: idSchema.optional(),
    pendingOperation: deferredClinicalOperationSchema.optional(),
    /**
     * Wave 1a deadlock expiry: the inbound message whose turn expired this need. Set by the
     * reducer on ExpireInformationNeed and kept as history afterwards — it anchors the short
     * answer-grace window (a late clear answer within the grace still resolves the need).
     */
    expiredAtInboundMessageId: idSchema.optional(),
  })
  .strict()
  .superRefine((need, context) => {
    if (
      (need.state === 'open' && need.clarificationAttemptUsed) ||
      (need.state === 'asked' && !need.clarificationAttemptUsed)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'need_attempt_state_invalid' });
    }
    if (need.field === 'event_identity') {
      if (
        need.targetEventId !== undefined ||
        need.targetEventVersion !== undefined ||
        need.pendingOperation === undefined ||
        need.candidateHistoricalEvents === undefined ||
        need.candidateHistoricalEvents.length === 0 ||
        need.candidateHistoricalEventIds.length !== 0
      )
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'event_identity_scope_invalid' });
      return;
    }
    if (
      need.targetEventId === undefined ||
      need.targetEventVersion === undefined ||
      need.pendingOperation !== undefined ||
      (need.candidateHistoricalEvents?.length ?? 0) !== 0
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'targeted_need_scope_invalid' });
  });

export const unresolvedReportSchema = z
  .object({
    id: idSchema,
    reason: textSchema,
    sourceMessageId: idSchema,
    sourceSpans: z.array(sourceSpanSchema).min(1).max(MAX_ITEMS),
    candidateMedicationIds: idsSchema,
    candidateDoseIds: idsSchema,
    candidateEventIds: idsSchema,
  })
  .strict();

export const clinicianReviewItemSchema = z
  .object({
    id: idSchema,
    kind: z.enum(['unresolved_report', 'contradiction', 'safety', 'unsupported_language']),
    sourceMessageId: idSchema,
    targetEventId: idSchema.optional(),
    reason: textSchema,
    status: z.enum(['open', 'confirmed', 'rejected']),
  })
  .strict();

export const processedCommandBatchSchema = z
  .object({
    idempotencyKey: idSchema,
    sourceMessageId: idSchema,
    commandHash: z.string().regex(/^[a-f0-9]{64}$/u),
    preparedHash: z.string().regex(/^[a-f0-9]{64}$/u),
    baseVersion: z.number().int().nonnegative(),
    resultVersion: z.number().int().positive(),
    eventIds: idsSchema,
    needIds: idsSchema,
    unresolvedReportIds: idsSchema,
    reviewItemIds: idsSchema,
    responseText: z.string().min(1).max(320),
    /**
     * Lane Q: the pending question this committed reply restated (need id or dose id). Optional
     * — receipts written before Lane Q, and every turn that restated nothing, have none.
     */
    pendingReaskKey: idSchema.optional(),
  })
  .strict();

function addAggregateIssue(
  context: z.RefinementCtx,
  message: string,
  path: readonly (string | number)[],
): void {
  context.addIssue({ code: z.ZodIssueCode.custom, message, path: [...path] });
}

function hasLinkCycle(
  eventsById: ReadonlyMap<string, z.infer<typeof clinicalEventSchema>>,
  link: 'recurrenceOfEventId' | 'contradictionOfEventId',
): boolean {
  for (const event of eventsById.values()) {
    const visited = new Set<string>();
    let cursor: z.infer<typeof clinicalEventSchema> | undefined = event;
    while (cursor?.[link] !== undefined) {
      if (visited.has(cursor.id)) return true;
      visited.add(cursor.id);
      cursor = eventsById.get(cursor[link]);
    }
  }
  return false;
}

function uniqueIds(
  values: readonly { readonly id: string }[],
  context: z.RefinementCtx,
  path: string,
): void {
  if (new Set(values.map(({ id }) => id)).size !== values.length)
    addAggregateIssue(context, `${path}_id_duplicate`, [path]);
}

export const patientClinicalMemorySchema = z
  .object({
    patientId: idSchema,
    version: z.number().int().nonnegative(),
    events: z.array(clinicalEventSchema).max(1_000),
    needs: z.array(informationNeedSchema).max(1_000),
    unresolvedReports: z.array(unresolvedReportSchema).max(1_000),
    reviewItems: z.array(clinicianReviewItemSchema).max(1_000),
    routineClarificationsPaused: z.boolean(),
    processedBatches: z.array(processedCommandBatchSchema).max(MAX_RECENT_COMMAND_BATCHES),
  })
  .strict()
  .superRefine((memory, context) => {
    uniqueIds(memory.events, context, 'events');
    uniqueIds(memory.needs, context, 'needs');
    uniqueIds(memory.unresolvedReports, context, 'unresolvedReports');
    uniqueIds(memory.reviewItems, context, 'reviewItems');

    const batchKeys = memory.processedBatches.map(({ idempotencyKey }) => idempotencyKey);
    if (new Set(batchKeys).size !== batchKeys.length)
      addAggregateIssue(context, 'processed_batch_duplicate', ['processedBatches']);

    const eventsById = new Map(memory.events.map((event) => [event.id, event]));
    const needsById = new Map(memory.needs.map((need) => [need.id, need]));
    const unresolvedReportsById = new Map(
      memory.unresolvedReports.map((report) => [report.id, report]),
    );
    const reviewItemsById = new Map(memory.reviewItems.map((item) => [item.id, item]));
    for (const [index, receipt] of memory.processedBatches.entries()) {
      if (
        receipt.sourceMessageId !== receipt.idempotencyKey ||
        receipt.resultVersion !== receipt.baseVersion + 1 ||
        receipt.eventIds.some((id) => !eventsById.has(id)) ||
        receipt.needIds.some((id) => !needsById.has(id)) ||
        receipt.unresolvedReportIds.some((id) => !unresolvedReportsById.has(id)) ||
        receipt.reviewItemIds.some((id) => !reviewItemsById.has(id))
      )
        addAggregateIssue(context, 'processed_batch_receipt_invalid', ['processedBatches', index]);
    }

    const needSuccessorCounts = new Map<string, number>();
    const activeNeedKeys = new Set<string>();
    for (const [index, need] of memory.needs.entries()) {
      if (need.supersedesNeedId !== undefined) {
        const parent = needsById.get(need.supersedesNeedId);
        if (parent === undefined || parent.id === need.id || parent.state !== 'superseded') {
          addAggregateIssue(context, 'information_need_lineage_invalid', ['needs', index]);
        } else {
          needSuccessorCounts.set(parent.id, (needSuccessorCounts.get(parent.id) ?? 0) + 1);
        }
      }
      if (
        (need.state === 'open' || need.state === 'asked') &&
        need.targetEventId !== undefined &&
        need.targetEventVersion !== undefined
      ) {
        const key = `${need.targetEventId}:${need.targetEventVersion}:${need.field}`;
        if (activeNeedKeys.has(key))
          addAggregateIssue(context, 'information_need_active_duplicate', ['needs', index]);
        activeNeedKeys.add(key);
      }
    }
    if ([...needSuccessorCounts.values()].some((count) => count > 1))
      addAggregateIssue(context, 'information_need_lineage_invalid', ['needs']);
    for (const need of memory.needs) {
      const visited = new Set<string>();
      let cursor: z.infer<typeof informationNeedSchema> | undefined = need;
      while (cursor?.supersedesNeedId !== undefined) {
        if (visited.has(cursor.id)) {
          addAggregateIssue(context, 'information_need_lineage_cycle', ['needs']);
          break;
        }
        visited.add(cursor.id);
        cursor = needsById.get(cursor.supersedesNeedId);
      }
    }
    const successorCounts = new Map<string, number>();
    for (const [index, event] of memory.events.entries()) {
      if (event.supersedesEventId !== undefined) {
        const parent = eventsById.get(event.supersedesEventId);
        if (
          parent === undefined ||
          parent.id === event.id ||
          parent.kind !== event.kind ||
          parent.version + 1 !== event.version ||
          parent.recurrenceOfEventId !== event.recurrenceOfEventId
        ) {
          addAggregateIssue(context, 'clinical_lineage_invalid', ['events', index]);
        } else {
          successorCounts.set(parent.id, (successorCounts.get(parent.id) ?? 0) + 1);
        }
      }

      if (event.recurrenceOfEventId !== undefined) {
        const target = eventsById.get(event.recurrenceOfEventId);
        if (
          target === undefined ||
          target.kind !== 'symptom' ||
          target.symptomStatus !== 'resolved' ||
          event.kind !== 'symptom'
        )
          addAggregateIssue(context, 'recurrence_target_invalid', ['events', index]);
      }

      if (event.contradictionOfEventId !== undefined) {
        const target = eventsById.get(event.contradictionOfEventId);
        if (
          event.kind !== 'contradiction' ||
          target === undefined ||
          (target.kind !== 'administration' && target.kind !== 'symptom') ||
          (target.authoredBy === 'patient' && target.reviewState === 'unreviewed')
        )
          addAggregateIssue(context, 'contradiction_target_invalid', ['events', index]);
      }
    }

    for (const [index, event] of memory.events.entries()) {
      const successorCount = successorCounts.get(event.id) ?? 0;
      if (successorCount > 1 || event.current !== (successorCount === 0))
        addAggregateIssue(context, 'clinical_lineage_invalid', ['events', index]);
    }
    if (hasLinkCycle(eventsById, 'recurrenceOfEventId'))
      addAggregateIssue(context, 'recurrence_cycle', ['events']);
    if (hasLinkCycle(eventsById, 'contradictionOfEventId'))
      addAggregateIssue(context, 'contradiction_cycle', ['events']);

    const currentAdministrationKeys = memory.events.flatMap((event) =>
      event.current &&
      event.canonical &&
      event.kind === 'administration' &&
      event.doseId !== undefined
        ? [`${event.doseId}:${event.localDate ?? ''}`]
        : [],
    );
    if (new Set(currentAdministrationKeys).size !== currentAdministrationKeys.length)
      addAggregateIssue(context, 'current_administration_duplicate', ['events']);

    const openSafetySources = new Set(
      memory.reviewItems
        .filter(({ kind, status }) => kind === 'safety' && status === 'open')
        .map(({ sourceMessageId }) => sourceMessageId),
    );
    if (
      !memory.routineClarificationsPaused &&
      memory.events.some(
        ({ kind, safetyTier, sourceMessageIds }) =>
          kind === 'safety' &&
          safetyTier === 'emergency' &&
          sourceMessageIds.some((id) => openSafetySources.has(id)),
      )
    ) {
      addAggregateIssue(context, 'emergency_clarification_pause_required', [
        'routineClarificationsPaused',
      ]);
    }

    const administrationFields = new Set<z.infer<typeof needFieldSchema>>([
      'medication_identity',
      'dose_identity',
      'actual_time',
      'late_intent',
    ]);
    const symptomFields = new Set<z.infer<typeof needFieldSchema>>([
      'symptom_identity',
      'severity',
      'duration',
      'body_site',
      'frequency',
      ...CONTEXT_BATTERY_FIELDS,
    ]);
    for (const [index, need] of memory.needs.entries()) {
      if (need.field === 'event_identity') {
        if (
          (need.state === 'open' || need.state === 'asked') &&
          (need.candidateHistoricalEvents ?? []).some(({ eventId, eventVersion }) => {
            const candidate = eventsById.get(eventId);
            return (
              candidate === undefined || !candidate.current || candidate.version !== eventVersion
            );
          })
        )
          addAggregateIssue(context, 'information_need_candidate_scope_invalid', ['needs', index]);
        continue;
      }
      if (need.targetEventId === undefined || need.targetEventVersion === undefined) {
        addAggregateIssue(context, 'information_need_target_invalid', ['needs', index]);
        continue;
      }
      const target = eventsById.get(need.targetEventId);
      const targetStateCompatible =
        target !== undefined &&
        target.version === need.targetEventVersion &&
        ((need.state !== 'open' && need.state !== 'asked') || target.current);
      const compatible =
        targetStateCompatible &&
        ((need.state !== 'open' && need.state !== 'asked') ||
          (target.authoredBy === 'patient' && target.reviewState === 'unreviewed')) &&
        ((target.kind === 'administration' && administrationFields.has(need.field)) ||
          (target.kind === 'symptom' && symptomFields.has(need.field)));
      if (!compatible)
        addAggregateIssue(context, 'information_need_target_invalid', ['needs', index]);

      if (
        (need.state === 'open' || need.state === 'asked') &&
        target?.kind === 'administration' &&
        target.medicationId !== undefined &&
        need.candidateMedicationIds.some((id) => id !== target.medicationId)
      )
        addAggregateIssue(context, 'information_need_medication_scope_invalid', ['needs', index]);
      if (
        need.candidateSymptomEventIds.some((id) => eventsById.get(id)?.kind !== 'symptom') ||
        need.candidateHistoricalEventIds.some((id) => !eventsById.has(id))
      )
        addAggregateIssue(context, 'information_need_candidate_scope_invalid', ['needs', index]);
    }
  });

export const patientClinicalSnapshotSchema = z
  .object({
    memory: patientClinicalMemorySchema,
    inboundMessage: z
      .object({
        id: idSchema,
        sequence: z.number().int().positive(),
        body: z.string().min(1).max(4_000),
      })
      .strict(),
    consentEpoch: z.number().int().positive(),
    expectedConsentEpoch: z.number().int().positive(),
    expectedMemoryVersion: z.number().int().nonnegative().optional(),
    medications: z.array(medicationSnapshotSchema).max(MAX_ITEMS),
    doses: z.array(doseSnapshotSchema).max(MAX_ITEMS),
    symptomConcepts: z.array(textSchema).max(MAX_ITEMS),
    promptedDoseId: idSchema.optional(),
    exactControl: z.literal('STOP').optional(),
    temporalProvenanceIssue: z.literal('scheduled_dose_timezone_mismatch').optional(),
    languageDisposition: z.enum(['english', 'unsupported', 'uncertain']).default('english'),
    emergencyPrefilter: z.boolean().default(false),
    /**
     * Wave 1a chat-style batching: true when a newer inbound message already exists at turn
     * start. The turn then prepares in RECORD-ONLY mode (claims recorded, no question asked,
     * outbound terminal from birth). Deliberately EXCLUDED from the runtime context hash so a
     * message arriving between prepare and commit never fails the commit — the invoke-time
     * backstop suppresses the send instead.
     */
    newerInboundExists: z.boolean().optional(),
    /** Asked needs whose origin inbound message is from a prior local day (expire overnight). */
    overnightAskedNeedIds: idsSchema.optional(),
    /**
     * Inbound message ids of this burst's suppressed record-only turns (today, not yet covered
     * by any sent reply). The surviving turn derives its aggregate intent from these turns'
     * committed processedBatches receipts.
     */
    suppressedBurstInboundMessageIds: idsSchema.optional(),
    /**
     * Wave 1e rollout lever: the context-battery need machinery (CONTEXT_BATTERY_FIELDS) only
     * ever opens needs when this is explicitly true — default OFF, so every existing snapshot
     * (and every caller that has not been updated) sees zero behavior change. Mirrors the
     * composer's ship-OFF-then-activate deploy pattern.
     */
    contextBatteryEnabled: z.boolean().optional(),
    /**
     * Wave 1e AI-selection wire point: an upstream (untrusted) model's preference for WHICH
     * eligible context-battery question to ask next. Deterministically validated in
     * selectQuestion — honored only when the field names an eligible open need that is also in
     * CONTEXT_BATTERY_FIELDS; any other value (a non-eligible field, a non-context field, a
     * field the AI has no authority over) is silently ignored and the deterministic priority
     * order (NEED_PRIORITY) picks instead. Populating this from a live provider call is
     * explicitly out of scope for this change — see the Wave 1e summary for the deviation.
     */
    contextQuestionPreference: needFieldSchema.optional(),
    contextHash: z.string().regex(/^[a-f0-9]{64}$/u),
    pipelineVersions: pipelineVersionsSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const medicationIds = snapshot.medications.map(({ id }) => id);
    const doseIds = snapshot.doses.map(({ id }) => id);
    if (new Set(medicationIds).size !== medicationIds.length)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'snapshot_medication_duplicate' });
    if (new Set(doseIds).size !== doseIds.length)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'snapshot_dose_duplicate' });
    if (snapshot.doses.some(({ medicationId }) => !medicationIds.includes(medicationId)))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'snapshot_dose_medication_missing',
      });
    if (snapshot.promptedDoseId !== undefined && !doseIds.includes(snapshot.promptedDoseId))
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'snapshot_prompted_dose_missing' });
  });

const sourcedCommandBase = {
  id: idSchema,
  sourceMessageId: idSchema,
  sourceSpans: z.array(sourceSpanSchema).min(1).max(MAX_ITEMS),
};
const administrativeCommandBase = {
  id: idSchema,
  sourceMessageId: idSchema,
  sourceSpans: z.array(sourceSpanSchema).max(MAX_ITEMS),
};
const administrationIntent = {
  medicationId: idSchema.optional(),
  medicationVersion: z.number().int().positive().optional(),
  doseId: idSchema.optional(),
  doseVersion: z.number().int().positive().optional(),
  adherence: z.enum(['taken', 'missed']).optional(),
  timing: z.enum(['on_time', 'late', 'unknown']).optional(),
  timeText: textSchema.optional(),
  exactTime: textSchema.optional(),
  localDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional(),
  localTime: z
    .string()
    .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u)
    .optional(),
};
const symptomIntent = {
  timeText: textSchema.optional(),
  rawSymptom: textSchema.optional(),
  symptomConcept: textSchema.nullable().optional(),
  symptomStatus: z.enum(['current', 'resolved', 'historical']).optional(),
  severity: textSchema.optional(),
  duration: textSchema.optional(),
  bodySite: textSchema.optional(),
  frequency: textSchema.optional(),
  // Wave 1e context-battery fields.
  onset: textSchema.optional(),
  quality: textSchema.optional(),
  triggers: textSchema.optional(),
  associatedSymptoms: textSchema.optional(),
  recurrenceHistory: textSchema.optional(),
};
const noAdministrationIntent = {
  medicationId: z.never().optional(),
  medicationVersion: z.never().optional(),
  doseId: z.never().optional(),
  doseVersion: z.never().optional(),
  adherence: z.never().optional(),
  timing: z.never().optional(),
  exactTime: z.never().optional(),
  localDate: z.never().optional(),
  localTime: z.never().optional(),
};
const noSymptomIntent = {
  rawSymptom: z.never().optional(),
  symptomConcept: z.never().optional(),
  symptomStatus: z.never().optional(),
  severity: z.never().optional(),
  duration: z.never().optional(),
  bodySite: z.never().optional(),
  frequency: z.never().optional(),
  // Wave 1e context-battery fields — administration commands never carry these.
  onset: z.never().optional(),
  quality: z.never().optional(),
  triggers: z.never().optional(),
  associatedSymptoms: z.never().optional(),
  recurrenceHistory: z.never().optional(),
};
const ADMINISTRATION_INTENT_FIELDS = Object.keys(administrationIntent);
const SYMPTOM_INTENT_FIELDS = Object.keys(symptomIntent);
const targetCommandBase = {
  ...sourcedCommandBase,
  targetEventId: idSchema,
  targetEventVersion: z.number().int().positive(),
};

function administrationIntentIsValid(value: Readonly<Record<string, unknown>>): boolean {
  return (
    (value.medicationId === undefined) === (value.medicationVersion === undefined) &&
    (value.doseId === undefined) === (value.doseVersion === undefined) &&
    (value.doseId === undefined || value.medicationId !== undefined)
  );
}

function nonEmptyIntent(fields: readonly string[]) {
  return (value: Readonly<Record<string, unknown>>): boolean => hasDefinedField(value, fields);
}

const createAdministrationReportSchema = z
  .object({
    ...sourcedCommandBase,
    kind: z.literal('CreateReport'),
    eventKind: z.literal('administration'),
    ...administrationIntent,
    ...noSymptomIntent,
    adherence: z.enum(['taken', 'missed']).optional(),
  })
  .strict()
  .refine(administrationIntentIsValid, 'administration_intent_invalid')
  // W0.3: adherence may be omitted ONLY for the pending ("not yet") shape — a fully
  // identified prompted dose whose event stays non-canonical until resolved.
  .refine(
    (command) =>
      command.adherence !== undefined ||
      (command.medicationId !== undefined && command.doseId !== undefined),
    'administration_pending_requires_identified_dose',
  );

const createSymptomReportSchema = z
  .object({
    ...sourcedCommandBase,
    kind: z.literal('CreateReport'),
    eventKind: z.literal('symptom'),
    ...noAdministrationIntent,
    ...symptomIntent,
    rawSymptom: textSchema,
    symptomStatus: z.enum(['current', 'resolved', 'historical']),
    timeText: textSchema.optional(),
  })
  .strict();

function administrationMutationSchema<const Kind extends 'RefineReport' | 'CorrectReport'>(
  kind: Kind,
) {
  return z
    .object({
      ...targetCommandBase,
      kind: z.literal(kind),
      targetKind: z.literal('administration'),
      ...administrationIntent,
      ...noSymptomIntent,
    })
    .strict()
    .refine(nonEmptyIntent(ADMINISTRATION_INTENT_FIELDS), 'clinical_intent_empty')
    .refine(administrationIntentIsValid, 'administration_intent_invalid');
}

function symptomMutationSchema<const Kind extends 'RefineReport' | 'CorrectReport'>(kind: Kind) {
  return z
    .object({
      ...targetCommandBase,
      kind: z.literal(kind),
      targetKind: z.literal('symptom'),
      ...noAdministrationIntent,
      ...symptomIntent,
    })
    .strict()
    .refine(nonEmptyIntent(SYMPTOM_INTENT_FIELDS), 'clinical_intent_empty');
}

const administrationContradictionSchema = z
  .object({
    ...targetCommandBase,
    kind: z.literal('RecordContradiction'),
    targetKind: z.literal('administration'),
    reason: textSchema,
    ...administrationIntent,
    ...noSymptomIntent,
  })
  .strict()
  .refine(nonEmptyIntent(ADMINISTRATION_INTENT_FIELDS), 'clinical_intent_empty')
  .refine(administrationIntentIsValid, 'administration_intent_invalid');

const symptomContradictionSchema = z
  .object({
    ...targetCommandBase,
    kind: z.literal('RecordContradiction'),
    targetKind: z.literal('symptom'),
    reason: textSchema,
    ...noAdministrationIntent,
    ...symptomIntent,
  })
  .strict()
  .refine(nonEmptyIntent(SYMPTOM_INTENT_FIELDS), 'clinical_intent_empty');

const recordRecurrenceSchema = z
  .object({
    ...targetCommandBase,
    kind: z.literal('RecordRecurrence'),
    ...noAdministrationIntent,
    timeText: z.never().optional(),
    symptomConcept: z.never().optional(),
    symptomStatus: z.never().optional(),
    severity: z.never().optional(),
    duration: z.never().optional(),
    rawSymptom: textSchema,
    bodySite: textSchema.optional(),
    frequency: z.never().optional(),
  })
  .strict();
const needIntent = {
  needId: idSchema,
  originInboundSequence: z.number().int().positive(),
  targetEventId: idSchema.optional(),
  targetEventVersion: z.number().int().positive().optional(),
  field: needFieldSchema,
  candidateMedicationIds: idsSchema,
  candidateDoseIds: idsSchema,
  candidateSymptomEventIds: idsSchema,
  candidateHistoricalEventIds: idsSchema,
  candidateHistoricalEvents: z.array(eventTargetCandidateSchema).max(MAX_ITEMS).optional(),
  questionId: idSchema,
  priority: z.number().int().nonnegative().max(1_000),
  pendingOperation: deferredClinicalOperationSchema.optional(),
};

export const clinicalIntentCommandSchema = z
  .union([
    createAdministrationReportSchema,
    createSymptomReportSchema,
    administrationMutationSchema('RefineReport'),
    symptomMutationSchema('RefineReport'),
    administrationMutationSchema('CorrectReport'),
    symptomMutationSchema('CorrectReport'),
    recordRecurrenceSchema,
    administrationContradictionSchema,
    symptomContradictionSchema,
    z
      .object({ ...sourcedCommandBase, kind: z.literal('OpenInformationNeed'), ...needIntent })
      .strict(),
    z
      .object({
        ...administrativeCommandBase,
        kind: z.literal('AskInformationNeed'),
        needId: idSchema,
        expectedNeedVersion: z.number().int().positive(),
      })
      .strict(),
    z
      .object({
        ...sourcedCommandBase,
        kind: z.literal('ResolveInformationNeed'),
        needId: idSchema,
        expectedNeedVersion: z.number().int().positive(),
      })
      .strict(),
    z
      .object({
        ...sourcedCommandBase,
        kind: z.literal('DeclineInformationNeed'),
        needId: idSchema,
        expectedNeedVersion: z.number().int().positive(),
        outcome: z.enum(['patient_does_not_know', 'declined']),
      })
      .strict(),
    z
      .object({
        ...sourcedCommandBase,
        kind: z.literal('ExpireInformationNeed'),
        needId: idSchema,
        expectedNeedVersion: z.number().int().positive(),
        /**
         * Wave 1a: true ONLY for deadlock expiry of a stale asked question. The reducer stamps
         * the answer-grace anchor for these; an expiry consumed by a failed clarification
         * attempt stays terminal (frozen one-attempt policy) and never becomes grace-answerable.
         */
        staleQuestion: z.literal(true).optional(),
      })
      .strict(),
    z
      .object({
        ...sourcedCommandBase,
        kind: z.literal('SupersedeInformationNeed'),
        needId: idSchema,
        expectedNeedVersion: z.number().int().positive(),
        successorNeedId: idSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...sourcedCommandBase,
        kind: z.literal('PauseRoutineClarification'),
        reason: textSchema,
      })
      .strict(),
    z
      .object({
        ...administrativeCommandBase,
        kind: z.literal('ResumeRoutineClarification'),
        reviewItemId: idSchema,
      })
      .strict(),
    z
      .object({
        ...sourcedCommandBase,
        kind: z.literal('RaiseSafetySignal'),
        safetyTier: z.enum(['important', 'emergency']),
        reason: textSchema,
      })
      .strict(),
    z
      .object({
        ...sourcedCommandBase,
        kind: z.literal('PreserveUnresolvedContent'),
        reason: textSchema,
        candidateMedicationIds: idsSchema,
        candidateDoseIds: idsSchema,
        candidateEventIds: idsSchema,
      })
      .strict(),
  ])
  .superRefine((command, context) => {
    if (
      command.sourceSpans.length > 0 &&
      !command.sourceSpans.some(({ messageId }) => messageId === command.sourceMessageId)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'source_message_span_mismatch' });
    }

    if (command.kind !== 'OpenInformationNeed') return;
    if (command.field === 'event_identity') {
      if (
        command.targetEventId !== undefined ||
        command.targetEventVersion !== undefined ||
        command.pendingOperation === undefined ||
        command.candidateHistoricalEvents === undefined ||
        command.candidateHistoricalEvents.length === 0 ||
        command.candidateHistoricalEventIds.length !== 0
      )
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'event_identity_scope_invalid' });
      return;
    }
    if (
      command.targetEventId === undefined ||
      command.targetEventVersion === undefined ||
      command.pendingOperation !== undefined ||
      (command.candidateHistoricalEvents?.length ?? 0) !== 0
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'targeted_need_scope_invalid' });
  });

export const clinicalResponsePlanSchema = z
  .object({
    kind: z.enum([
      'routine',
      'question',
      'important',
      'emergency',
      'stop',
      'unsupported_language',
      'human_review',
      'stale_snapshot',
    ]),
    acknowledgementId: idSchema.optional(),
    question: z
      .object({
        needId: idSchema,
        eventId: idSchema.optional(),
        field: needFieldSchema,
        questionId: idSchema,
        targetLabel: textSchema.optional(),
        /** Wave 1a: true when the plan repeats an already-asked question (no reducer command). */
        reask: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /**
     * Lane Q (2026-08-17) — RE-ASK ROUTE: the pending question a `human_review` (or, for the
     * 'prompted_dose' flavor only, a content-free `routine`) plan should restate instead of a
     * dead-end reply. Two flavors: 'need' restates an already-asked information need (reuses
     * the pinned QUESTIONS/EXPLAINERS bank via `field`/`targetLabel`, identical text to
     * `question.reask=true`); 'prompted_dose' restates an unanswered scheduled dose check-in
     * when no information need is pending — a prompted check-in is never an InformationNeed
     * record, so it cannot use the needId-keyed `question` shape above. Mutually exclusive with
     * `question` (never both on one plan).
     *
     * `needId`/`doseId` are the EPISODE IDENTITY, never rendered: the committed receipt stores
     * it as `pendingReaskKey`, which is what bounds the restate to once per pending question
     * (a text comparison cannot tell tomorrow's check-in from today's — same words).
     */
    pendingReask: z
      .discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('need'),
            needId: idSchema,
            field: needFieldSchema,
            targetLabel: textSchema.optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal('prompted_dose'),
            doseId: idSchema,
            medicationLabel: textSchema,
          })
          .strict(),
      ])
      .optional(),
    reviewReasons: z.array(textSchema).max(MAX_ITEMS),
  })
  .strict()
  .superRefine((plan, context) => {
    if ((plan.kind === 'question') !== (plan.question !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'question_payload_invalid' });
      return;
    }
    if (plan.question !== undefined) {
      if ((plan.question.field === 'event_identity') !== (plan.question.eventId === undefined))
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'question_event_scope_invalid' });
      if (
        (LABEL_REQUIRED_NEED_FIELDS as readonly string[]).includes(plan.question.field) &&
        plan.question.targetLabel === undefined
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'question_target_label_required',
        });
    }
    if (plan.pendingReask === undefined) return;
    if (plan.question !== undefined)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'pending_reask_conflicts_with_question',
      });
    if (plan.kind !== 'human_review' && plan.kind !== 'routine')
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'pending_reask_scope_invalid' });
    if (plan.kind === 'routine' && plan.pendingReask.kind === 'need')
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'pending_reask_need_flavor_requires_human_review',
      });
  });

/**
 * Wave 1c: single source for the label-required question fields — previously duplicated between
 * this file's clinicalResponsePlanSchema refinement and index.ts's questionPayload builder.
 * late_intent deliberately stays out: its pinned wording ("Do you plan to take it later today?")
 * never interpolates a targetLabel.
 */
export const LABEL_REQUIRED_NEED_FIELDS: readonly NeedField[] = [
  'actual_time',
  'severity',
  'duration',
  'body_site',
  'frequency',
  'onset',
  'quality',
  'triggers',
  'associated_symptoms',
  'recurrence_history',
];

/**
 * Wave 1e — the closed set of NEW symptom context-gathering fields (the AI-LED context
 * battery). severity/duration/body_site are REUSED bank categories (strength/duration/
 * location) and deliberately excluded here — their need-opening, priority, and stop
 * behavior are the pre-existing Wave 1c mechanism, untouched by this wave. Every field in
 * this set is: (a) gated behind snapshot.contextBatteryEnabled before any need ever opens
 * for it (a safe, explicit rollout lever — mirrors the composer's ship-OFF-then-activate
 * pattern), (b) capped at CONTEXT_BATTERY_MAX_QUESTIONS per symptom episode, (c) the only
 * fields selectQuestion will ever honor an external contextQuestionPreference for, and
 * (d) the only fields the composer may author a free-form question for.
 */
export const CONTEXT_BATTERY_FIELDS: readonly NeedField[] = [
  'onset',
  'quality',
  'triggers',
  'associated_symptoms',
  'recurrence_history',
];

export const clinicalRuntimeFailureSchema = z.enum([
  'provider_error',
  'malformed_output',
  'budget_exhausted',
  'circuit_open',
  'ambiguous_outcome',
  'internal_error',
]);

export const preparedClinicalTurnSchema = z
  .object({
    patientId: idSchema,
    idempotencyKey: idSchema,
    sourceMessageId: idSchema,
    sourceSequence: z.number().int().positive(),
    baseMemoryVersion: z.number().int().nonnegative(),
    consentEpoch: z.number().int().positive(),
    contextHash: z.string().regex(/^[a-f0-9]{64}$/u),
    pipelineVersions: pipelineVersionsSchema,
    commands: z.array(clinicalIntentCommandSchema).max(MAX_ITEMS),
    commandHash: z.string().regex(/^[a-f0-9]{64}$/u),
    responsePlan: clinicalResponsePlanSchema,
    responseText: z.string().min(1).max(320),
    runtimeFailure: clinicalRuntimeFailureSchema.optional(),
    /**
     * Wave 1a: true when this turn was prepared in record-only mode (newer inbound already
     * waiting) — commit writes its outbound row terminal from birth and never sends it.
     */
    recordOnly: z.literal(true).optional(),
    preparedHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

type DeepReadonly<Value> = Value extends (...arguments_: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

export type NeedField = z.infer<typeof needFieldSchema>;
export type SourceSpan = DeepReadonly<z.infer<typeof sourceSpanSchema>>;
export type ExtractedClaim = DeepReadonly<z.infer<typeof extractedClaimSchema>>;
export type RelatedExtractedClaim = DeepReadonly<z.infer<typeof relatedExtractedClaimSchema>>;
export type ClinicalClaimInput = ExtractedClaim | RelatedExtractedClaim;
export type ValidatedClaim = DeepReadonly<z.infer<typeof validatedClaimSchema>>;
export type ClinicalEvent = DeepReadonly<z.infer<typeof clinicalEventSchema>>;
export type InformationNeed = DeepReadonly<z.infer<typeof informationNeedSchema>>;
export type DeferredClinicalOperation = DeepReadonly<
  z.infer<typeof deferredClinicalOperationSchema>
>;
export type PatientClinicalMemory = DeepReadonly<z.infer<typeof patientClinicalMemorySchema>>;
export type PatientClinicalSnapshot = DeepReadonly<z.infer<typeof patientClinicalSnapshotSchema>>;
export type ClinicalIntentCommand = DeepReadonly<z.infer<typeof clinicalIntentCommandSchema>>;
export type ClinicalResponsePlan = DeepReadonly<z.infer<typeof clinicalResponsePlanSchema>>;
export type ClinicalRuntimeFailure = z.infer<typeof clinicalRuntimeFailureSchema>;
export type PreparedClinicalTurn = DeepReadonly<z.infer<typeof preparedClinicalTurnSchema>>;
