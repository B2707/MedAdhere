/**
 * Strict loader for the Phase 08-01 conversation-evaluation corpus.
 *
 * Gold data describes reviewable behavior rubrics. It deliberately does not contain fabricated
 * model outputs or provider failure labels. The locked holdout is verified from raw bytes before
 * parsing, so even whitespace-only changes require an explicit manifest update.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdherenceClassification, conversationClarificationTopicSchema } from '@medadhere/shared';
import { z } from 'zod';
import {
  CONVERSATION_METRIC_IDS,
  type ConversationTurnExpectation,
} from './conversation-metrics.js';

export const CONVERSATION_DEV_PATH = fileURLToPath(
  new URL('../conversation/dev.v12.json', import.meta.url),
);
export const CONVERSATION_HOLDOUT_PATH = fileURLToPath(
  new URL('../conversation/holdout.v2.json', import.meta.url),
);
export const CONVERSATION_MANIFEST_PATH = fileURLToPath(
  new URL('../conversation/manifest.v2.json', import.meta.url),
);

const EVAL2_CATEGORIES = [
  'normal_check_in',
  'missing_information',
  'recurrence',
  'changing_symptoms',
  'paired_symptoms',
  'multiple_medications',
  'temporal_correction',
  'next_day_attribution',
  'am_pm_ambiguity',
  'multilingual',
  'uncovered_knowledge',
  'emergency',
  'stop',
  'spam',
  'jailbreak',
  'cross_doctor_access',
] as const;

const CRITICAL_HARD_GATES = [
  'emergency_safety',
  'stop_provider_app_state',
  'cross_doctor_isolation',
  'structured_output',
  'patient_claim_faithfulness',
  'evidence_template_integrity',
  'prohibited_medication_change',
  'critical_temporal',
  'one_call_next_turn_retrieval',
] as const;

const languageSchema = z.enum(['en', 'fr', 'es', 'ar']);
const categorySchema = z.enum(EVAL2_CATEGORIES);
const hardGateSchema = z.enum(CRITICAL_HARD_GATES);
const metricSchema = z.enum(CONVERSATION_METRIC_IDS);
const safetySliceSchema = z.enum([
  'routine',
  'important',
  'emergency',
  'stop',
  'abuse',
  'cross_doctor',
]);
const temporalSliceSchema = z.enum([
  'explicit_time',
  'relative_day',
  'correction',
  'next_day',
  'ambiguous_ampm',
  'recurrence',
  'multi_medication',
]);
const retrievalSliceSchema = z.enum([
  'no_retrieval',
  'one_call_first_turn',
  'one_call_next_turn',
  'direct_evidence',
  'coverage_unknown',
  'cross_doctor_filtered',
]);
const expectedActionSchema = z.enum([
  'acknowledge',
  'ask_clarification',
  'complete_turn',
  'fixed_emergency',
  'fixed_stop',
  'fixed_opted_out',
  'fixed_start',
  'discard_spam',
]);
const clarificationRubricSchema = z
  .object({
    required: z.boolean(),
    highestPriorityTopic: conversationClarificationTopicSchema.nullable(),
    previouslyAnsweredTopics: z
      .array(conversationClarificationTopicSchema)
      .max(20)
      .refine(uniqueValues, 'duplicate answered topic'),
  })
  .strict()
  .superRefine((rubric, context) => {
    if (rubric.required !== (rubric.highestPriorityTopic !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['highestPriorityTopic'],
        message: 'required clarification needs exactly one highest-priority topic',
      });
    }
  });
const structuredFieldSchema = z.enum([
  'detectedLanguage',
  'mixedLanguage',
  'translationUncertain',
  'normalizedEnglishMeaning',
  'adherenceClassification',
  'observations',
  'temporalCandidateIds',
  'action',
  'socialAcknowledgement',
  'clinicianReviewDraft',
  'selectedEvidenceIds',
  'safetyCandidate',
]);
const observationKindSchema = z.enum([
  'symptom',
  'severity',
  'frequency',
  'duration',
  'sleep',
  'context',
  'medication_taking',
  'correction',
]);
const uuidSchema = z.string().uuid();
const forbiddenActionSchema = z.enum([
  'ask_clarification',
  'provider_call',
  'diagnose',
  'change_medication',
  'invent_evidence',
  'expose_foreign_patient',
  'reactivate_application',
]);

const REQUIRED_CLARIFICATION_METRICS = [
  'useful_clarification_rate',
  'clarification_priority_rate',
  'single_question_rate',
  'clarification_non_repetition_rate',
] as const;

const scenarioContextSchema = z
  .object({
    activeMedications: z
      .array(
        z
          .object({
            id: uuidSchema,
            name: z.string().trim().min(1).max(160),
            ingredients: z.array(z.string().trim().min(1).max(120)).min(1).max(10),
            scheduleLocalTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
          })
          .strict(),
      )
      .max(10),
    clinicalFacts: z
      .array(
        z
          .object({
            id: uuidSchema,
            statement: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .max(20),
    recentObservations: z
      .array(
        z
          .object({
            id: uuidSchema,
            kind: z.enum(['symptom', 'severity', 'medication_taking', 'correction']),
            statement: z.string().trim().min(1).max(500),
            normalizedValue: z.string().trim().min(1).max(200).nullable().optional(),
            severity: z.number().int().min(1).max(10).nullable(),
          })
          .strict(),
      )
      .max(20),
    doseTimeFacts: z
      .array(
        z
          .object({
            id: uuidSchema,
            medicationId: uuidSchema,
            localDate: z.string().date(),
            localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
            status: z.enum(['scheduled', 'taken', 'missed', 'unknown']),
          })
          .strict(),
      )
      .max(30),
    evidence: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(128),
            allowedTemplateIds: z.array(z.string().trim().min(1).max(128)).min(1).max(10),
            summary: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

function uniqueValues<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

const patientExpectationSchema = z
  .object({
    eligibleForProvider: z.boolean(),
    applicableMetrics: z.array(metricSchema).min(1).refine(uniqueValues, 'duplicate metric'),
    language: languageSchema,
    expectedMixedLanguage: z.boolean(),
    expectedTranslationUncertain: z.boolean(),
    safetySlices: z.array(safetySliceSchema).refine(uniqueValues, 'duplicate safety slice'),
    temporalSlices: z.array(temporalSliceSchema).refine(uniqueValues, 'duplicate temporal slice'),
    retrievalSlices: z
      .array(retrievalSliceSchema)
      .min(1)
      .refine(uniqueValues, 'duplicate retrieval slice'),
    expectedAction: expectedActionSchema,
    expectedSafetyTier: z.enum(['none', 'routine', 'important', 'emergency']),
    requiredStructuredFields: z
      .array(structuredFieldSchema)
      .refine(uniqueValues, 'duplicate required field'),
    requiredConcepts: z
      .array(z.string().trim().min(1).max(240))
      .min(1)
      .max(10)
      .describe('Human review notes; never score these by substring matching'),
    expectedObservationKinds: z.array(observationKindSchema).max(30),
    expectedSeverity: z.number().int().min(1).max(10).nullable(),
    expectedTemporalCandidateIds: z
      .array(uuidSchema)
      .max(20)
      .refine(uniqueValues, 'duplicate expected temporal candidate ID'),
    expectedAdherenceClassification: AdherenceClassification.nullable(),
    expectedDraftSourceMessageIds: z
      .array(uuidSchema)
      .max(20)
      .refine(uniqueValues, 'duplicate expected draft source message ID'),
    forbiddenClaims: z.array(z.string().trim().min(1).max(240)).max(10),
    forbiddenActions: z
      .array(forbiddenActionSchema)
      .refine(uniqueValues, 'duplicate forbidden action'),
    availableEvidenceIds: z
      .array(z.string().trim().min(1).max(128))
      .max(20)
      .refine(uniqueValues, 'duplicate available evidence ID'),
    expectedEvidenceId: z.string().trim().min(1).max(128).nullable(),
    expectedTemplateId: z.string().trim().min(1).max(128).nullable(),
    clarificationRubric: clarificationRubricSchema.optional(),
  })
  .strict()
  .superRefine((expectation, context) => {
    if ((expectation.expectedEvidenceId === null) !== (expectation.expectedTemplateId === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedEvidenceId'],
        message: 'evidence and template IDs must be both present or both null',
      });
    }
    if (!expectation.eligibleForProvider && expectation.requiredStructuredFields.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiredStructuredFields'],
        message: 'deterministic paths cannot require provider output fields',
      });
    }
    if (!expectation.eligibleForProvider && expectation.expectedDraftSourceMessageIds.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedDraftSourceMessageIds'],
        message: 'deterministic paths cannot require a provider-authored clinician draft',
      });
    }
    if (
      expectation.eligibleForProvider &&
      expectation.expectedAction !== 'acknowledge' &&
      expectation.expectedAction !== 'ask_clarification' &&
      expectation.expectedAction !== 'complete_turn'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedAction'],
        message: 'provider-eligible action must match the shared conversation action contract',
      });
    }
    if (expectation.eligibleForProvider && expectation.clarificationRubric === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clarificationRubric'],
        message: 'provider-eligible turns require a versioned clarification rubric',
      });
    }
    if (expectation.eligibleForProvider && expectation.clarificationRubric !== undefined) {
      const requiresClarification = expectation.expectedAction === 'ask_clarification';
      if (expectation.clarificationRubric.required !== requiresClarification) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['clarificationRubric', 'required'],
          message: 'clarification rubric must match the expected action',
        });
      }
      const applicable = new Set(expectation.applicableMetrics);
      const hasRequiredMetrics = REQUIRED_CLARIFICATION_METRICS.every((metricId) =>
        applicable.has(metricId),
      );
      const hasAnyRequiredMetric = REQUIRED_CLARIFICATION_METRICS.some((metricId) =>
        applicable.has(metricId),
      );
      if (
        requiresClarification
          ? !hasRequiredMetrics || applicable.has('unnecessary_question_rate')
          : hasAnyRequiredMetric || !applicable.has('unnecessary_question_rate')
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['applicableMetrics'],
          message: 'clarification metrics must match whether a question is required',
        });
      }
    }
  });

const patientMessageSchema = z
  .object({
    id: uuidSchema,
    role: z.literal('patient'),
    text: z.string().trim().min(1).max(2_000),
    expectation: patientExpectationSchema,
  })
  .strict();

const referenceAgentMessageSchema = z
  .object({
    id: uuidSchema,
    role: z.literal('reference_agent'),
    text: z.string().trim().min(1).max(800),
  })
  .strict();

const transcriptMessageSchema = z.discriminatedUnion('role', [
  patientMessageSchema,
  referenceAgentMessageSchema,
]);

const scenarioSchema = z
  .object({
    id: z.string().regex(/^conv-(?:dev|holdout-v2)-\d{3}$/),
    title: z.string().trim().min(1).max(120),
    primaryLanguage: languageSchema,
    additionalLanguages: z.array(languageSchema).max(3).refine(uniqueValues, 'duplicate language'),
    categories: z.array(categorySchema).min(1).refine(uniqueValues, 'duplicate category'),
    hardGates: z.array(hardGateSchema).refine(uniqueValues, 'duplicate hard gate'),
    scenarioContext: scenarioContextSchema,
    transcript: z.array(transcriptMessageSchema).min(3),
  })
  .strict()
  .superRefine((scenario, context) => {
    if (scenario.additionalLanguages.includes(scenario.primaryLanguage)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['additionalLanguages'],
        message: 'additional language duplicates primary language',
      });
    }

    const ids = new Set<string>();
    const medicationIds = new Set(
      scenario.scenarioContext.activeMedications.map((item) => item.id),
    );
    const doseIds = new Set(scenario.scenarioContext.doseTimeFacts.map((item) => item.id));
    const contextEvidenceIds = new Set(scenario.scenarioContext.evidence.map((item) => item.id));
    const contextEvidenceById = new Map(
      scenario.scenarioContext.evidence.map((item) => [item.id, item] as const),
    );

    for (const [index, dose] of scenario.scenarioContext.doseTimeFacts.entries()) {
      if (!medicationIds.has(dose.medicationId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scenarioContext', 'doseTimeFacts', index, 'medicationId'],
          message: 'dose medication must exist in active medications',
        });
      }
    }
    for (const [index, message] of scenario.transcript.entries()) {
      if (ids.has(message.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['transcript', index, 'id'],
          message: `duplicate message id ${message.id}`,
        });
      }
      ids.add(message.id);

      const expectedRole = index % 2 === 0 ? 'patient' : 'reference_agent';
      if (message.role !== expectedRole) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['transcript', index, 'role'],
          message: 'transcript messages must alternate patient and reference_agent roles',
        });
      }

      if (message.role === 'patient') {
        for (const candidateId of message.expectation.expectedTemporalCandidateIds) {
          if (!doseIds.has(candidateId)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['transcript', index, 'expectation', 'expectedTemporalCandidateIds'],
              message: `expected temporal candidate ${candidateId} is absent from scenario context`,
            });
          }
        }
        if (
          message.expectation.eligibleForProvider &&
          !message.expectation.expectedDraftSourceMessageIds.includes(message.id)
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['transcript', index, 'expectation', 'expectedDraftSourceMessageIds'],
            message: 'provider-eligible turn must explicitly source its current patient message',
          });
        }
        for (const evidenceId of message.expectation.availableEvidenceIds) {
          if (!contextEvidenceIds.has(evidenceId)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['transcript', index, 'expectation', 'availableEvidenceIds'],
              message: `turn evidence ${evidenceId} is absent from scenario context`,
            });
          }
        }
        const expectedEvidenceId = message.expectation.expectedEvidenceId;
        if (
          expectedEvidenceId !== null &&
          !message.expectation.availableEvidenceIds.includes(expectedEvidenceId)
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['transcript', index, 'expectation', 'expectedEvidenceId'],
            message: 'expected evidence must be available on that exact turn',
          });
        }
        if (expectedEvidenceId !== null && message.expectation.expectedTemplateId !== null) {
          const evidence = contextEvidenceById.get(expectedEvidenceId);
          if (!evidence?.allowedTemplateIds.includes(message.expectation.expectedTemplateId)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['transcript', index, 'expectation', 'expectedTemplateId'],
              message: 'expected template is not allowed by the expected evidence',
            });
          }
        }
      }
    }

    if (scenario.categories.includes('emergency')) {
      for (const [index, message] of scenario.transcript.entries()) {
        if (message.role !== 'patient') continue;
        const valid =
          !message.expectation.eligibleForProvider &&
          message.expectation.expectedAction === 'fixed_emergency' &&
          message.expectation.expectedSafetyTier === 'emergency' &&
          message.expectation.forbiddenActions.includes('ask_clarification');
        if (!valid) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['transcript', index, 'expectation'],
            message: 'emergency turns must use the fixed, provider-free, question-free path',
          });
        }
      }
    }

    if (scenario.categories.includes('stop')) {
      for (const [index, message] of scenario.transcript.entries()) {
        if (message.role !== 'patient') continue;
        if (
          message.expectation.eligibleForProvider ||
          !message.expectation.applicableMetrics.includes('stop_state_correctness')
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['transcript', index, 'expectation'],
            message: 'STOP/provider-state turns must use the deterministic state path',
          });
        }
      }
    }
  });

const scenarioDocumentSchema = z
  .object({
    kind: z.literal('conversation-scenarios'),
    version: z.enum(['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10', 'v11', 'v12']),
    partition: z.enum(['dev', 'holdout']),
    scenarios: z.array(scenarioSchema),
  })
  .strict();

const manifestSchema = z
  .object({
    kind: z.literal('conversation-scenario-manifest'),
    schemaVersion: z.literal(1),
    evalSetVersion: z.literal('v2'),
    devVersion: z.literal('v12'),
    holdoutVersion: z.literal('v2'),
    devFile: z.literal('dev.v12.json'),
    holdoutFile: z.literal('holdout.v2.json'),
    devSha256: z.string().regex(/^[0-9a-f]{64}$/),
    holdoutSha256: z.string().regex(/^[0-9a-f]{64}$/),
    lockedAtUtc: z.string().datetime(),
  })
  .strict();

export type ConversationPatientExpectation = z.infer<typeof patientExpectationSchema>;
export type ConversationTranscriptMessage = z.infer<typeof transcriptMessageSchema>;
export type ConversationScenarioDocument = z.infer<typeof scenarioDocumentSchema>;
export type ConversationScenario = z.infer<typeof scenarioSchema>;
export type ConversationScenarioManifest = z.infer<typeof manifestSchema>;

export interface ConversationScenarioCorpus {
  readonly manifest: ConversationScenarioManifest;
  readonly dev: ConversationScenarioDocument & { readonly partition: 'dev' };
  readonly holdout: ConversationScenarioDocument & { readonly partition: 'holdout' };
}

export function sha256Hex(value: string | NodeJS.ArrayBufferView): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label}: invalid JSON`, { cause: error });
  }
}

export function parseConversationScenarioDocument(
  raw: string,
  expectedPartition: 'dev' | 'holdout',
): ConversationScenarioDocument {
  const parsed = scenarioDocumentSchema.parse(parseJson(raw, expectedPartition));
  if (parsed.partition !== expectedPartition) {
    throw new Error(
      `conversation scenarios: expected ${expectedPartition} partition, got ${parsed.partition}`,
    );
  }
  const expectedVersion = expectedPartition === 'dev' ? 'v12' : 'v2';
  if (parsed.version !== expectedVersion) {
    throw new Error(
      `conversation scenarios: expected ${expectedPartition} ${expectedVersion}, got ${parsed.version}`,
    );
  }
  return parsed;
}

function requireUniqueScenarioIds(scenarios: readonly ConversationScenario[]): void {
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) {
      throw new Error(`conversation scenarios: duplicate scenario id ${scenario.id}`);
    }
    ids.add(scenario.id);
  }
}

function requireOneCallFixtures(
  scenarios: readonly ConversationScenario[],
  partition: string,
): void {
  const fixtures = scenarios.filter((scenario) =>
    scenario.hardGates.includes('one_call_next_turn_retrieval'),
  );
  if (fixtures.length === 0) {
    throw new Error(`conversation scenarios: ${partition} missing one-call/next-turn fixture`);
  }
  for (const fixture of fixtures) {
    const patientTurns = fixture.transcript.filter((message) => message.role === 'patient');
    const first = patientTurns[0]?.expectation;
    const next = patientTurns[1]?.expectation;
    const validFirst =
      first?.expectedAction === 'ask_clarification' &&
      first.availableEvidenceIds.length === 0 &&
      first.expectedEvidenceId === null &&
      first.expectedTemplateId === null &&
      first.retrievalSlices.includes('one_call_first_turn');
    const validNext =
      next?.eligibleForProvider === true &&
      next.availableEvidenceIds.includes('medlineplus-dizziness-v1') &&
      next.expectedEvidenceId !== null &&
      next.expectedTemplateId !== null &&
      next.retrievalSlices.includes('one_call_next_turn');
    if (!validFirst || !validNext) {
      throw new Error(`conversation scenarios: invalid one-call fixture ${fixture.id}`);
    }
  }
}

function requireCorpusContract(
  dev: ConversationScenarioDocument,
  holdout: ConversationScenarioDocument,
): void {
  if (dev.scenarios.length !== 48 || holdout.scenarios.length !== 24) {
    throw new Error(
      `conversation scenarios: expected 48 dev + 24 holdout, got ${dev.scenarios.length} + ${holdout.scenarios.length}`,
    );
  }

  const all = [...dev.scenarios, ...holdout.scenarios];
  requireUniqueScenarioIds(all);
  const messageCount = all.reduce((sum, scenario) => sum + scenario.transcript.length, 0);
  if (messageCount < 300) {
    throw new Error(
      `conversation scenarios: expected at least 300 transcript messages, got ${messageCount}`,
    );
  }

  const categories = new Set(all.flatMap((scenario) => scenario.categories));
  const missingCategories = EVAL2_CATEGORIES.filter((category) => !categories.has(category));
  if (missingCategories.length > 0) {
    throw new Error(`conversation scenarios: missing categories ${missingCategories.join(', ')}`);
  }

  const holdoutGates = new Set(holdout.scenarios.flatMap((scenario) => scenario.hardGates));
  const missingGates = CRITICAL_HARD_GATES.filter((gate) => !holdoutGates.has(gate));
  if (missingGates.length > 0) {
    throw new Error(
      `conversation scenarios: holdout missing hard gates ${missingGates.join(', ')}`,
    );
  }

  for (const language of languageSchema.options) {
    const count = holdout.scenarios.filter(
      (scenario) => scenario.primaryLanguage === language,
    ).length;
    if (count < 4) {
      throw new Error(
        `conversation scenarios: holdout language ${language} has ${count}, expected >=4`,
      );
    }
  }

  const mixed = holdout.scenarios.filter((scenario) => scenario.additionalLanguages.length > 0);
  if (
    mixed.length < 4 ||
    !mixed.every((scenario) => scenario.categories.includes('multilingual'))
  ) {
    throw new Error('conversation scenarios: holdout requires explicit mixed-language coverage');
  }

  requireOneCallFixtures(dev.scenarios, 'dev');
  requireOneCallFixtures(holdout.scenarios, 'holdout');
}

export function loadConversationScenarioCorpus(
  manifestPath: string = CONVERSATION_MANIFEST_PATH,
): ConversationScenarioCorpus {
  const manifest = manifestSchema.parse(
    parseJson(readFileSync(manifestPath, 'utf8'), 'conversation scenario manifest'),
  );
  const fixtureDirectory = dirname(manifestPath);
  const devRaw = readFileSync(join(fixtureDirectory, manifest.devFile));
  const holdoutRaw = readFileSync(join(fixtureDirectory, manifest.holdoutFile));

  const devHash = sha256Hex(devRaw);
  if (devHash !== manifest.devSha256) {
    throw new Error(`conversation scenarios: dev SHA-256 mismatch (${devHash})`);
  }
  const holdoutHash = sha256Hex(holdoutRaw);
  if (holdoutHash !== manifest.holdoutSha256) {
    throw new Error(`conversation scenarios: locked holdout SHA-256 mismatch (${holdoutHash})`);
  }

  const dev = parseConversationScenarioDocument(devRaw.toString('utf8'), 'dev');
  const holdout = parseConversationScenarioDocument(holdoutRaw.toString('utf8'), 'holdout');
  requireCorpusContract(dev, holdout);

  return {
    manifest,
    dev: { ...dev, partition: 'dev' },
    holdout: { ...holdout, partition: 'holdout' },
  };
}

export function toConversationTurnExpectations(
  corpus: ConversationScenarioCorpus,
): ConversationTurnExpectation[] {
  return [...corpus.dev.scenarios, ...corpus.holdout.scenarios].flatMap((scenario) =>
    scenario.transcript.flatMap((message) => {
      if (message.role !== 'patient') return [];
      return [
        {
          scenarioId: scenario.id,
          turnId: message.id,
          language: message.expectation.language,
          safetySlices: message.expectation.safetySlices,
          temporalSlices: message.expectation.temporalSlices,
          retrievalSlices: message.expectation.retrievalSlices,
          applicableMetrics: message.expectation.applicableMetrics,
        },
      ];
    }),
  );
}
