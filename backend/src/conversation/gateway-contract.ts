import { z } from 'zod';
import { needFieldSchema } from './clinical-memory/index.js';
import { boundedClaimExtractionSchema } from './clinical-memory/bounded-provider.js';
import { COMPOSER_MAX_CODE_POINTS } from './clinical-memory/composer-validators.js';

/**
 * COMPOSER ISOLATION KEYS (Wave 1b items 2 and 3) — re-exported from the composer module,
 * the single source of truth, so the gateway and worker lanes can never drift apart.
 */
export {
  COMPOSER_CIRCUIT_KEY as CLINICAL_COMPOSER_PROVIDER_KEY,
  composerBudgetBucketKeys as clinicalComposerBucketSubjectKeys,
} from './clinical-memory/composer.js';

const requestIdSchema = z.string().uuid();
const versionSchema = z.string().trim().min(1).max(64);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const gatewayUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict();

const gatewayMetadataSchema = z
  .object({
    modelId: z.string().trim().min(1).max(128),
    promptVersion: versionSchema,
    schemaSha256: sha256Schema,
    latencyMs: z.number().int().nonnegative(),
  })
  .strict();

const interpretationRequestSchema = z
  .object({
    requestId: requestIdSchema,
    stage: z.literal('interpretation'),
    input: z
      .object({
        currentMessage: z
          .object({
            id: z.string().trim().min(1).max(160),
            direction: z.literal('inbound'),
            body: z
              .string()
              .min(1)
              .max(2_000)
              .refine((body) => body.trim().length > 0),
          })
          .strict(),
        openInformationNeeds: z
          .array(
            z
              .object({
                id: z.string().trim().min(1).max(160),
                field: needFieldSchema,
              })
              .strict(),
          )
          .max(20),
        promptVersion: versionSchema,
        schemaVersion: versionSchema,
      })
      .strict(),
  })
  .strict();

/**
 * Composition stage (Wave 1b) — the AI-written outbound rewrite. Safety, STOP, review, and
 * failure replies are STRUCTURALLY uncomposable: their plan kinds are not representable here,
 * so those turns can only ever carry their fixed deterministic templates. Runtime-failure
 * turns never reach this stage either (they join the never-composed set at the caller).
 */
export const composableIntentKindSchema = z.enum(['greeting', 'acknowledgement', 'question']);

/** Single source of truth: the composer validators own the 320 code-point ceiling. */
export const COMPOSED_BODY_MAX_CODE_POINTS = COMPOSER_MAX_CODE_POINTS;

/**
 * The composed body ceiling counts UNICODE CODE POINTS post-trim — the DB column errors on
 * overflow rather than truncating, so the gateway enforces the exact same rule up front.
 */
export const composedBodySchema = z
  .string()
  .min(1)
  .max(2_000)
  .refine((body) => body === body.trim(), { message: 'composed body must be trimmed' })
  .refine((body) => [...body].length <= COMPOSED_BODY_MAX_CODE_POINTS, {
    message: `composed body exceeds ${COMPOSED_BODY_MAX_CODE_POINTS} code points`,
  });

const envelopeBodySchema = z.string().min(1).max(2_000);

const composerMedicationAliasSchema = z
  .object({
    alias: z.string().regex(/^med_\d+$/u),
    displayName: z.string().trim().min(1).max(200),
  })
  .strict();

/**
 * The FULL deterministic composer intent, assembled BY CODE ("code fetches, AI writes"):
 * this is exactly the `ComposerIntent` the Lane B validator set requires, so entity
 * grounding, coverage, question identity, the patient-drug-list advice checks, and
 * deterministic de-aliasing can all run behind this contract. Medication display names
 * cross only this internal Lambda boundary — the composer module aliases every
 * provider-bound field before the model sees it.
 */
export const composerIntentSchema = z
  .object({
    kind: composableIntentKindSchema,
    requiredTokens: z.array(z.string().trim().min(1).max(200)).max(8),
    allowedTerms: z.array(z.string().trim().min(1).max(200)).max(16),
    question: z
      .object({
        field: needFieldSchema,
        keyVocabulary: z.array(z.string().trim().min(1).max(64)).min(1).max(8),
        /** Wave 1e item 4 — see composer-validators.ts's ComposerIntent for the semantics. */
        allowAuthoredQuestion: z.boolean().optional(),
      })
      .strict()
      .optional(),
    medications: z.array(composerMedicationAliasSchema).max(20),
    patientFacts: z.array(z.string().trim().min(1).max(200)).max(8),
  })
  .strict()
  .superRefine((intent, context) => {
    if ((intent.kind === 'question') !== (intent.question !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'question_payload_invalid' });
    }
  });

/**
 * The composer day context: job.input.currentDayMessages VERBATIM (the loader's four-line
 * delivery-status filter already excludes replies the patient never received) plus the
 * current inbound body. This is the validator grounding corpus, so it must round-trip
 * losslessly through the contract — the composer envelope builder trims and aliases it
 * before anything reaches the provider.
 */
export const composerDayContextSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(160),
            direction: z.enum(['inbound', 'outbound']),
            body: envelopeBodySchema,
            occurredAtUtc: z.string().trim().min(1).max(64),
          })
          .strict(),
      )
      .max(64),
    latestPatientMessage: envelopeBodySchema,
  })
  .strict();

const compositionRequestSchema = z
  .object({
    requestId: requestIdSchema,
    stage: z.literal('composition'),
    input: z
      .object({
        intent: composerIntentSchema,
        dayContext: composerDayContextSchema,
        promptVersion: versionSchema,
      })
      .strict(),
  })
  .strict();

export const conversationGatewayRequestSchema = z.union([
  interpretationRequestSchema,
  compositionRequestSchema,
]);

export type ConversationGatewayRequest = z.infer<typeof conversationGatewayRequestSchema>;

export type ConversationCompositionInput = Extract<
  ConversationGatewayRequest,
  { readonly stage: 'composition' }
>['input'];

const interpretationSuccessSchema = z
  .object({
    ok: z.literal(true),
    requestId: requestIdSchema,
    stage: z.literal('interpretation'),
    result: boundedClaimExtractionSchema,
    usage: gatewayUsageSchema,
    metadata: gatewayMetadataSchema,
  })
  .strict();

const compositionMetadataSchema = z
  .object({
    modelId: z.string().trim().min(1).max(128),
    promptVersion: versionSchema,
    promptSha256: sha256Schema,
    latencyMs: z.number().int().nonnegative(),
  })
  .strict();

/** Per-attempt audit record: raw model output plus the validator verdict that judged it. */
const composerAttemptSchema = z
  .object({
    rawOutput: z.string().max(20_000),
    verdict: z.union([
      z
        .object({
          ok: z.literal(true),
          sms: z.string().max(2_000),
          /** Wave 1e item 4 — flags a composer-authored (non-bank) context-battery question. */
          authored: z.boolean().optional(),
        })
        .strict(),
      z
        .object({
          ok: z.literal(false),
          reason: z.string().trim().min(1).max(64),
          detail: z.string().max(200).optional(),
          overBy: z.number().int().optional(),
        })
        .strict(),
    ]),
  })
  .strict();

const compositionSuccessSchema = z
  .object({
    ok: z.literal(true),
    requestId: requestIdSchema,
    stage: z.literal('composition'),
    result: z
      .object({
        composedBody: composedBodySchema,
        /** composerInputHash — prompt version/hash + intent + trimmed envelope. */
        inputHash: sha256Schema,
        attempts: z.array(composerAttemptSchema).min(1).max(2),
      })
      .strict(),
    usage: gatewayUsageSchema,
    metadata: compositionMetadataSchema,
  })
  .strict();

const gatewayFailureKindSchema = z.enum([
  'auth',
  'rate_limited',
  'transient',
  'refused',
  'truncated',
  'malformed',
  'input_too_large',
  'internal',
]);

const interpretationFailureSchema = z
  .object({
    ok: z.literal(false),
    requestId: requestIdSchema,
    stage: z.literal('interpretation'),
    failureKind: gatewayFailureKindSchema,
    usage: gatewayUsageSchema.nullable(),
    metadata: gatewayMetadataSchema,
  })
  .strict();

const compositionFailureSchema = z
  .object({
    ok: z.literal(false),
    requestId: requestIdSchema,
    stage: z.literal('composition'),
    failureKind: gatewayFailureKindSchema,
    /**
     * The composer-level fallback reason (validator class, timeout, overflow) — the channel
     * the pre-registered per-reason >30% abort metric consumes. Null when the failure
     * happened before the composer module ran (bad request, version mismatch).
     */
    fallbackReason: z.string().trim().min(1).max(64).nullable(),
    inputHash: sha256Schema.nullable(),
    attempts: z.array(composerAttemptSchema).max(2),
    usage: gatewayUsageSchema.nullable(),
    metadata: compositionMetadataSchema,
  })
  .strict();

export const conversationGatewayResponseSchema = z.union([
  interpretationSuccessSchema,
  compositionSuccessSchema,
  interpretationFailureSchema,
  compositionFailureSchema,
]);

export type ConversationGatewayResponse = z.infer<typeof conversationGatewayResponseSchema>;
