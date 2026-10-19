// Wave 1b Lane C — compose plumbing.
//
// The composer MODULE (prompt, Anthropic call, validator set) is Lane B and the gateway
// composition stage is Lane A. This file owns everything AROUND them:
//   - the never-composed eligibility set (pure code, call-spy-tested from the core),
//   - the recency-gated insertion seam orchestration (timeout then template, never throws
//     for composer-quality failures — the template floor always ships),
//   - composed_body checkpoint orchestration (the one-shot UPDATE lives in
//     clinical-memory/repository.ts; the append-only template `body` is never touched),
//   - the auto-disable config flag with the pre-registered >30% rolling-fallback abort,
//   - the send-time integrity re-check (composed_body ?? body; tamper -> template),
//   - identifier-free fallback metrics (metric/reason/count fields only, never an id).

import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { PreparedClinicalTurn } from './clinical-memory/index.js';
import { checkpointComposedOutbound } from './clinical-memory/repository.js';
import {
  claimProviderCircuit,
  recordProviderCircuitFailure,
  recordProviderCircuitSuccess,
  releaseProviderCircuitClaim,
  reserveComposerStage,
  persistComposerStageUsage,
} from './runtime-repository.js';
import {
  COMPOSER_CIRCUIT_KEY,
  COMPOSER_FALLBACK_DISABLE_THRESHOLD,
  COMPOSER_PROMPT_VERSION,
  COMPOSER_SEAM_TIMEOUT_MS,
  isNeverComposed,
  resolveComposerModel,
  type ComposerAttempt,
  type ComposerGateInput,
} from './clinical-memory/composer.js';
import {
  aliasText,
  buildMedicationAliases,
  trimComposerDayContext,
} from './clinical-memory/composer-envelope.js';
import {
  COMPOSER_MAX_CODE_POINTS,
  DEFAULT_QUESTION_KEY_VOCABULARY,
  validateStoredComposedSms,
  type ComposerIntent,
} from './clinical-memory/composer-validators.js';
import { CONTEXT_BATTERY_FIELDS } from './clinical-memory/contracts.js';
import type { ComposerDayContext } from './clinical-memory/composer-envelope.js';
import { ACKNOWLEDGEMENT_ORIENTATION, EXPLAINERS } from './clinical-memory/response.js';
import {
  composerDayContextSchema,
  composerIntentSchema,
  type ConversationGatewayRequest,
  type ConversationGatewayResponse,
} from './gateway-contract.js';

// The composer module (Lane B) is the single source of truth for the shared composer
// constants; the plumbing re-exports them under its integration names so the two lanes can
// never drift apart.
export {
  /** W4b.2 pulled forward: per-attempt provider budget inside the gateway. */
  COMPOSER_TIMEOUT_MS,
  /** Client-side WHOLE-seam budget, strictly above the gateway's own composition budget. */
  COMPOSER_SEAM_TIMEOUT_MS,
  /** The one env var name both the worker and the gateway resolve identically. */
  COMPOSER_MODEL_ENV,
  /** Owner decision #2: the composer model, env-swappable (e.g. to Sonnet) without a deploy. */
  DEFAULT_COMPOSER_MODEL as COMPOSER_DEFAULT_MODEL_ID,
  /** Compose-plumbing isolation (3): the composer NEVER shares the extractor circuit. */
  COMPOSER_CIRCUIT_KEY as COMPOSER_PROVIDER_CIRCUIT_KEY,
  /** Pre-registered abort rate: rolling fallback share above this disables composing. */
  COMPOSER_FALLBACK_DISABLE_THRESHOLD as COMPOSER_FALLBACK_ABORT_RATE,
  /** Compose-plumbing isolation (2): separate buckets so chat can never starve extraction. */
  composerBudgetBucketKeys,
} from './clinical-memory/composer.js';

/** Operator kill switch; the DB `composer_control.disabled` flag is the auto-disable. */
export const COMPOSER_DISABLE_ENV = 'CLINICAL_COMPOSER_DISABLED';
/** Suffix views of composerBudgetBucketKeys — pinned equal by the plumbing unit tests. */
export const COMPOSER_INPUT_BUCKET_SUFFIX = ':writer-input';
export const COMPOSER_OUTPUT_BUCKET_SUFFIX = ':writer-output';
/** Counted in Unicode code points post-trim — single source: the composer validators. */
export const COMPOSED_SMS_MAX_CODE_POINTS = COMPOSER_MAX_CODE_POINTS;
export const COMPOSER_FALLBACK_WINDOW_MINUTES = 60;
export const COMPOSER_FALLBACK_MIN_SAMPLES = 10;

/**
 * outbound_message.message_kind values whose rows may EVER carry composed text: routine
 * acknowledgements and question clarifications. 'safety' (emergency/important), 'fallback'
 * (human review), and every scheduled kind structurally refuse composed text at the DB
 * CHECK, the checkpoint UPDATE, and the sender — three layers under the worker-side gate.
 */
export const COMPOSABLE_MESSAGE_KINDS: ReadonlySet<string> = new Set([
  'acknowledgement',
  'clarification',
]);

const FALLBACK_REASON_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function composerModelId(): string {
  return resolveComposerModel(process.env);
}

export type MetricEntry = Readonly<Record<string, string | number | boolean | null>>;
export type MetricEmitter = (entry: MetricEntry) => void;

/** De-identified structured metric line (metric/reason/count fields only — U-16). */
const consoleMetric: MetricEmitter = (entry) => {
  console.log(JSON.stringify(entry));
};

export interface ComposedReplyDraft {
  /** The candidate SMS text — already validated by the Lane B validator set. */
  readonly sms: string;
  /** The exact ComposerIntent that was composed — persisted for the send-time re-check. */
  readonly intent: ComposerIntent;
  /** The exact day context validated against — persisted for the send-time re-check. */
  readonly dayContext: ComposerDayContext;
  /** composerInputHash — covers prompt version/hash, intent, and the trimmed envelope. */
  readonly inputHash: string;
  /** Per-attempt audit trail: raw model output + validator verdict. */
  readonly attempts: readonly ComposerAttempt[];
  /** Lane B provenance (model/prompt hashes, audit linkage) — stored verbatim. */
  readonly provenance: Readonly<Record<string, unknown>>;
}

export type ComposeSeamOutcome =
  | { readonly kind: 'composed'; readonly draft: ComposedReplyDraft }
  | {
      readonly kind: 'fallback';
      readonly reason: string;
      readonly inputHash: string | null;
      readonly attempts: readonly ComposerAttempt[];
    };

export interface ComposeSeamRequest {
  readonly outboundMessageId: string;
  readonly patientId: string;
  readonly agentTurnId: string;
  /** The turn job whose writer stage reservation/audit this attempt belongs to. */
  readonly turnJobId: string;
  readonly prepared: PreparedClinicalTurn;
  /**
   * ACTIVATION: every active medication's names already loaded on the turn (one inner array
   * per medication, primary display name first) — never a new query. ALL of a medication's
   * names share its med_N alias, so a patient's brand-name wording never crosses to the
   * provider un-aliased.
   */
  readonly medicationNames: readonly (readonly string[])[];
  /** ACTIVATION: job.input.currentDayMessages + the current inbound, reused verbatim (item 8). */
  readonly dayContext: ComposerDayContext;
}

/** Lane B integration seam: one bounded compose attempt (validators + bounded retry inside). */
export interface ClinicalComposerSeam {
  readonly compose: (request: ComposeSeamRequest) => Promise<ComposeSeamOutcome>;
}

type ComposablePlan = Pick<PreparedClinicalTurn, 'responsePlan' | 'commands'>;

/** Wire caps from gateway-contract's composerIntentSchema, enforced at assembly time. */
const MAX_INTENT_TERM_CHARS = 200;
const MAX_INTENT_MEDICATIONS = 20;
const MAX_INTENT_REQUIRED_TOKENS = 8;

/**
 * The ONLY dose-state sentences the composer is ever told — and, because patient facts are
 * part of the validator's grounding corpus, the only dose states it may assert. A turn that
 * recorded nothing gets no fact, so "I noted it as taken" cannot survive a bare "No".
 */
const DOSE_TAKEN_FACT = 'the dose is recorded as taken';
const DOSE_MISSED_FACT = 'the dose is recorded as skipped or missed';
/**
 * Live-fault fix (2026-08-17): the composer used to write "noted your headache" on a turn where
 * NOTHING was actually committed (e.g. an extraction that fell through to human_review, or a
 * clean turn whose only commands manage information needs rather than record a clinical event) —
 * entity grounding let it through because the patient's own words were still visible in context,
 * even though nothing about them was ever saved. These two facts close that gap: every composable
 * turn now says PLAINLY whether a symptom/observation was recorded, or that nothing new was.
 * owner-gate-pending: these two fact strings are new prompt-facing wording (never sent verbatim
 * to the patient, but they shape what the composer may claim) — draft pending owner review.
 */
const SYMPTOM_RECORDED_FACT = 'a symptom or observation was recorded this turn';
const NOTHING_RECORDED_FACT = 'nothing new was recorded this turn';

/** Commands that create or mutate a durable clinical event row (administration or symptom). */
const CLINICAL_EVENT_COMMAND_KINDS: ReadonlySet<string> = new Set([
  'CreateReport',
  'RefineReport',
  'CorrectReport',
  'RecordContradiction',
  'RecordRecurrence',
]);

function isClinicalEventCommand(command: unknown): boolean {
  const kind = (command as { readonly kind?: unknown }).kind;
  return typeof kind === 'string' && CLINICAL_EVENT_COMMAND_KINDS.has(kind);
}

function isSymptomEventCommand(command: unknown): boolean {
  const typed = command as {
    readonly kind?: unknown;
    readonly eventKind?: unknown;
    readonly targetKind?: unknown;
  };
  return (
    typed.kind === 'RecordRecurrence' ||
    typed.eventKind === 'symptom' ||
    typed.targetKind === 'symptom'
  );
}

/**
 * Mirrors response.ts's own defensive read of the optional cross-lane `reask` flag: a missing
 * field means a first ask, which adds no explainer and so grants zero new authority.
 */
function isReaskQuestion(question: { readonly reask?: unknown }): boolean {
  return question.reask === true;
}

/** "Code fetches, AI writes": deterministic status facts read off this turn's own commands. */
function composerPatientFacts(prepared: ComposablePlan, questionTarget: string): readonly string[] {
  const facts: string[] = [];
  let clinicalEventCommitted = false;
  for (const command of prepared.commands) {
    const adherence = (command as { readonly adherence?: unknown }).adherence;
    if (adherence === 'taken' && !facts.includes(DOSE_TAKEN_FACT)) facts.push(DOSE_TAKEN_FACT);
    if (adherence === 'missed' && !facts.includes(DOSE_MISSED_FACT)) facts.push(DOSE_MISSED_FACT);
    if (isClinicalEventCommand(command)) {
      clinicalEventCommitted = true;
      if (isSymptomEventCommand(command) && !facts.includes(SYMPTOM_RECORDED_FACT)) {
        facts.push(SYMPTOM_RECORDED_FACT);
      }
    }
  }
  if (!clinicalEventCommitted) facts.push(NOTHING_RECORDED_FACT);
  const targetFact = `this question is about ${questionTarget}`;
  if (questionTarget.length > 0 && targetFact.length <= MAX_INTENT_TERM_CHARS)
    facts.push(targetFact);
  return facts;
}

/**
 * ACTIVATION — the sole intent-assembly seam ("code fetches, AI writes"): a pure deterministic
 * mapping from an already-eligible prepared turn's response plan plus the patient's
 * already-loaded medications to the gateway ComposerIntent.
 *
 * Coverage (validator 3) binds the reply to its intent slots where the match can be EXACT: the
 * medication aliases named by a question's target label, which the model reproduces verbatim
 * as med_N and the validator dealiases for the final pass. A free-text symptom target is
 * carried as a patient fact plus an allowed term instead — requiring a multi-word label
 * verbatim would ship a template for every natural rephrasing. The outcome slot is enforced by
 * the validators' outcome-assertion grounding (an unrecorded outcome fails), not by forcing a
 * specific word into the text. The question's keyVocabulary comes from the single-source
 * per-field default (DEFAULT_QUESTION_KEY_VOCABULARY). Only 'routine' and 'question' plans are
 * composable (isComposeEligibleTurn gates every other kind before this is ever called);
 * anything else — including medications that would breach the wire contract's caps — returns
 * undefined, and the deterministic template floor ships.
 */
export function composerIntentFromPrepared(
  prepared: ComposablePlan,
  medicationNames: readonly (readonly string[])[],
): ComposerIntent | undefined {
  const groups = medicationNames.filter((names) => names.length > 0);
  const primaryNames = groups.map((names) => names[0]!);
  // A name past the wire caps would throw INSIDE the seam's try (recorded as a provider-circuit
  // failure on every turn for that patient); fail to the template floor here instead.
  if (
    groups.length > MAX_INTENT_MEDICATIONS ||
    primaryNames.some((name) => name.trim().length === 0 || name.length > MAX_INTENT_TERM_CHARS)
  )
    return undefined;
  const medications = buildMedicationAliases(
    primaryNames,
    groups.map((names) =>
      names
        .slice(1)
        .filter((name) => name.trim().length > 0 && name.length <= MAX_INTENT_TERM_CHARS),
    ),
  ).slice(0, MAX_INTENT_MEDICATIONS);
  const plan = prepared.responsePlan;
  if (plan.kind === 'question' && plan.question !== undefined) {
    const target = plan.question.targetLabel?.trim() ?? '';
    // Measured AFTER aliasing (a short display name becomes a longer med_N), so a long label
    // is dropped here instead of breaching the wire cap inside the seam.
    const aliased = target.length === 0 ? '' : aliasText(target, medications);
    const aliasedTarget = aliased.length > MAX_INTENT_TERM_CHARS ? '' : aliased;
    const targetAliases = [
      ...new Set([...aliasedTarget.matchAll(/\bmed_\d+\b/gu)].map((m) => m[0])),
    ].slice(0, MAX_INTENT_REQUIRED_TOKENS);
    // A re-ask is a `question` plan with EMPTY reviewReasons, so it is compose-eligible — and
    // the composed body replaced the template that carried the explainer, so the plain-language
    // help only ever reached the patient on the minority fallback path. Carrying it as a
    // REQUIRED token means a rephrased question must still include it verbatim (and the coverage
    // check fails to the template floor, which carries it, if the model drops it). Also grounds
    // its own numerals: groundingCorpus reads requiredTokens.
    const explainer = isReaskQuestion(plan.question) ? EXPLAINERS[plan.question.field] : undefined;
    const requiredTokens =
      explainer === undefined || explainer.length > MAX_INTENT_TERM_CHARS
        ? targetAliases
        : [...targetAliases, explainer].slice(0, MAX_INTENT_REQUIRED_TOKENS);
    return {
      kind: 'question',
      requiredTokens,
      allowedTerms: aliasedTarget.length === 0 ? [] : [aliasedTarget],
      question: {
        field: plan.question.field,
        keyVocabulary: DEFAULT_QUESTION_KEY_VOCABULARY[plan.question.field],
        // Wave 1e item 4: only the closed context-battery field set may ever author its own
        // question text — every pre-existing field keeps the strict bank-anchor pin.
        ...(CONTEXT_BATTERY_FIELDS.includes(plan.question.field)
          ? { allowAuthoredQuestion: true as const }
          : {}),
      },
      medications,
      patientFacts: composerPatientFacts(prepared, aliasedTarget),
    };
  }
  if (plan.kind === 'routine') {
    return {
      kind: plan.acknowledgementId === ACKNOWLEDGEMENT_ORIENTATION ? 'greeting' : 'acknowledgement',
      requiredTokens: [],
      allowedTerms: [],
      medications,
      patientFacts: composerPatientFacts(prepared, ''),
    };
  }
  return undefined;
}

export interface ComposerGatewayDependencies {
  readonly database: Pool;
  /** The SAME Lambda-invoke transport the interpretation stage uses (invokeConversationGateway). */
  readonly invokeGateway: (
    request: ConversationGatewayRequest,
  ) => Promise<ConversationGatewayResponse>;
}

/** Per-call worst-case reservation, matching the gateway's own composer ceiling (Lane A). */
const COMPOSER_RESERVED_INPUT_TOKENS = 8_000;
const COMPOSER_RESERVED_OUTPUT_TOKENS = 1_024;

/**
 * Only PROVIDER-HEALTH failures may open the composer circuit. A 'malformed' composition is
 * the model writing text our validators rejected — quality, not health: counting five of those
 * in five minutes opened the circuit and then reported 'circuit_open' instead of the real
 * per-validator reason, both to the operator and to the >30% auto-disable window.
 */
function composerCircuitFailureKind(
  failureKind: Extract<ConversationGatewayResponse, { readonly ok: false }>['failureKind'],
): 'auth' | 'transient' | undefined {
  if (failureKind === 'auth') return 'auth';
  return failureKind === 'rate_limited' || failureKind === 'transient' ? 'transient' : undefined;
}

/**
 * ACTIVATION — the real composer seam: invokes the SAME gateway Lambda transport the
 * interpretation stage uses, behind the composer's OWN durable one-shot reservation
 * (reserveComposerStage — writer_attempted_at, never interpretation_attempted_at or
 * failure_kind) and OWN provider circuit (COMPOSER_CIRCUIT_KEY, isolation items 2-3). The
 * kill switch and auto-disable flag are enforced by the caller (composeAndCheckpointPreparedReply
 * checks isComposerEnabled BEFORE this seam is ever invoked).
 */
export function productionComposerSeam(
  dependencies: ComposerGatewayDependencies,
): ClinicalComposerSeam {
  return {
    compose: async (request) => {
      const intent = composerIntentFromPrepared(request.prepared, request.medicationNames);
      if (intent === undefined) {
        return { kind: 'fallback', reason: 'never_composed', inputHash: null, attempts: [] };
      }
      // Isolation item 6: trim to the composer's OWN ceiling BEFORE the wire, so a heavy day
      // can never reach the shared 96k-byte transport throw (a bare Error the catch below
      // would have to record as a provider failure) and the persisted provenance stays far
      // under its own size ceiling. Same context is used for the wire, the validators, and
      // the stored record — one corpus, no drift.
      const dayContext = trimComposerDayContext(request.dayContext);

      const leaseId = randomUUID();
      const circuit = await claimProviderCircuit(dependencies.database, {
        providerKey: COMPOSER_CIRCUIT_KEY,
        leaseId,
      });
      if (circuit.kind === 'open') {
        return { kind: 'fallback', reason: 'circuit_open', inputHash: null, attempts: [] };
      }

      const reservation = await reserveComposerStage(dependencies.database, {
        turnJobId: request.turnJobId,
        patientId: request.patientId,
        reservedInputTokens: COMPOSER_RESERVED_INPUT_TOKENS,
        reservedOutputTokens: COMPOSER_RESERVED_OUTPUT_TOKENS,
      });
      if (reservation.kind !== 'reserved') {
        if (circuit.kind === 'half_open') {
          await releaseProviderCircuitClaim(dependencies.database, {
            providerKey: COMPOSER_CIRCUIT_KEY,
            leaseId,
          });
        }
        return { kind: 'fallback', reason: reservation.kind, inputHash: null, attempts: [] };
      }

      /**
       * Live incident (2026-08-17): the writer stage leaked its reservation exactly like the
       * interpretation stage — units came back ONLY on the success path, so a stuck 8,000/1,024
       * writer pair sat on the patient's day next to the interpretation leak. Every exit from
       * here on settles: persistComposerStageUsage moves the honest actual usage to consumed and
       * returns the rest, and it is idempotent (the reserved columns zero out), so a doubled call
       * can never double-credit. `writer_attempted_at` is deliberately untouched — this returns
       * budget, it never makes an attempted composition attemptable again.
       */
      const settle = (
        usage: { readonly inputTokens: number; readonly outputTokens: number } | null,
      ) =>
        persistComposerStageUsage(dependencies.database, {
          turnJobId: request.turnJobId,
          patientId: request.patientId,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
        });

      let response: ConversationGatewayResponse;
      try {
        response = await dependencies.invokeGateway({
          requestId: randomUUID(),
          stage: 'composition',
          input: {
            // Fresh mutable copies: ComposerIntent/ComposerDayContext are readonly, the wire
            // schema's inferred type is not — no semantic change, just array variance.
            intent: {
              kind: intent.kind,
              requiredTokens: [...intent.requiredTokens],
              allowedTerms: [...intent.allowedTerms],
              medications: intent.medications.map(({ alias, displayName }) => ({
                alias,
                displayName,
              })),
              patientFacts: [...intent.patientFacts],
              ...(intent.question === undefined
                ? {}
                : {
                    question: {
                      field: intent.question.field,
                      keyVocabulary: [...intent.question.keyVocabulary],
                      ...(intent.question.allowAuthoredQuestion === true
                        ? { allowAuthoredQuestion: true as const }
                        : {}),
                    },
                  }),
            },
            dayContext: {
              messages: dayContext.messages.map((message) => ({ ...message })),
              latestPatientMessage: dayContext.latestPatientMessage,
            },
            promptVersion: COMPOSER_PROMPT_VERSION,
          },
        });
      } catch {
        await settle(null);
        await recordProviderCircuitFailure(dependencies.database, {
          providerKey: COMPOSER_CIRCUIT_KEY,
          leaseId,
          failureKind: 'transient',
        });
        return { kind: 'fallback', reason: 'transient', inputHash: null, attempts: [] };
      }
      if (response.stage !== 'composition') {
        // Defensive: invokeConversationGateway already guarantees this by requestId+stage; a
        // mismatch here would be a transport bug, not a composer-quality failure — the outer
        // catch in composeAndCheckpointPreparedReply records it as 'composer_error'.
        await settle(response.usage);
        throw new Error('Composition gateway response has an unexpected stage');
      }

      if (!response.ok) {
        const circuitFailureKind = composerCircuitFailureKind(response.failureKind);
        if (circuitFailureKind === undefined) {
          // Oversize input and rejected compositions both mean the provider answered fine.
          await recordProviderCircuitSuccess(dependencies.database, {
            providerKey: COMPOSER_CIRCUIT_KEY,
            leaseId,
          });
        } else {
          await recordProviderCircuitFailure(dependencies.database, {
            providerKey: COMPOSER_CIRCUIT_KEY,
            leaseId,
            failureKind: circuitFailureKind,
          });
        }
        await settle(response.usage);
        return {
          kind: 'fallback',
          reason: response.fallbackReason ?? response.failureKind,
          inputHash: response.inputHash,
          // The wire schema types `verdict.reason` as a general string (a Lambda JSON
          // boundary); the value always originates from Lane B's ComposedReplyVerdict.
          attempts: response.attempts as readonly ComposerAttempt[],
        };
      }

      await recordProviderCircuitSuccess(dependencies.database, {
        providerKey: COMPOSER_CIRCUIT_KEY,
        leaseId,
      });
      await settle(response.usage);

      return {
        kind: 'composed',
        draft: {
          sms: response.result.composedBody,
          intent,
          dayContext,
          inputHash: response.result.inputHash,
          attempts: response.result.attempts as readonly ComposerAttempt[],
          provenance: { modelId: response.metadata.modelId },
        },
      };
    },
  };
}

type ComposeEligibilityInput = Pick<
  PreparedClinicalTurn,
  'responsePlan' | 'commands' | 'runtimeFailure' | 'recordOnly'
>;

/**
 * The ONE adapter from a prepared turn to the composer gate input — the never-composed set
 * has a single source of truth (isNeverComposed in clinical-memory/composer.ts); this
 * mapping is the only place command kinds become gate booleans.
 */
export function composerGateInputFromPrepared(
  prepared: ComposeEligibilityInput,
  routineClarificationsPaused: boolean,
): ComposerGateInput {
  const hasCommand = (kind: string): boolean =>
    prepared.commands.some((command) => command.kind === kind);
  return {
    planKind: prepared.responsePlan.kind,
    hasSafetyEvent: hasCommand('RaiseSafetySignal'),
    hasUnresolvedReportDelta: hasCommand('PreserveUnresolvedContent'),
    reviewReasonCount: prepared.responsePlan.reviewReasons.length,
    routineClarificationsPaused:
      routineClarificationsPaused || hasCommand('PauseRoutineClarification'),
    runtimeFailure: prepared.runtimeFailure !== undefined,
    recordOnly: prepared.recordOnly === true,
    hasPendingReask: prepared.responsePlan.pendingReask !== undefined,
  };
}

/**
 * The never-composed set. Only clean routine/question replies may be composed; emergency,
 * STOP, important, human-review, unsupported-language, safety-event, unresolved-report,
 * review-reason, runtime-failure, record-only, and clarifications-paused turns always ship
 * their exact template. INVIOLABLE: this list may only ever grow — and it lives in ONE
 * place (isNeverComposed); this is a thin adapter over it.
 */
export function isComposeEligibleTurn(
  prepared: ComposeEligibilityInput,
  routineClarificationsPaused: boolean,
): boolean {
  return !isNeverComposed(composerGateInputFromPrepared(prepared, routineClarificationsPaused));
}

export function codePointLength(value: string): number {
  return [...value].length;
}

export function sha256Utf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const compositionProvenanceSchema = z
  .object({ composedBodySha256: z.string().regex(SHA256_PATTERN) })
  .passthrough();

/**
 * Send-time tamper/bit-rot defense for composed rows (the analogue of render-equality for
 * template rows): the stored composed body must hash to the provenance-recorded digest, be
 * trimmed, and respect the code-point ceiling.
 */
export function verifyComposedBodyIntegrity(composedBody: string, composition: unknown): boolean {
  const provenance = compositionProvenanceSchema.safeParse(composition);
  if (!provenance.success) return false;
  const length = codePointLength(composedBody);
  return (
    composedBody === composedBody.trim() &&
    length >= 1 &&
    length <= COMPOSED_SMS_MAX_CODE_POINTS &&
    sha256Utf8(composedBody) === provenance.data.composedBodySha256
  );
}

/** The validation context every composed row must durably carry for the send-time re-run. */
const storedCompositionContextSchema = z
  .object({
    intent: composerIntentSchema,
    dayContext: composerDayContextSchema,
  })
  .passthrough();

/**
 * SEND-TIME VALIDATOR RE-RUN (binding spec): re-runs the full Lane B validator set on the
 * stored composed body using the intent + day context persisted in the composition record.
 * A row without a parseable stored context fails CLOSED to the template — the co-located
 * sha256 alone is bit-rot defense, not tamper defense.
 */
export function validateStoredCompositionRecord(sms: string, composition: unknown): boolean {
  const parsed = storedCompositionContextSchema.safeParse(composition);
  if (!parsed.success) return false;
  return validateStoredComposedSms(sms, parsed.data.intent, parsed.data.dayContext).ok;
}

export interface StoredOutboundSendRow {
  /** The append-only template body — always present, never overwritten. */
  readonly body: string;
  readonly composedBody: string | null;
  readonly composition: unknown;
  /** outbound_message.message_kind — composed text is honored ONLY on composable kinds. */
  readonly messageKind: string;
}

export interface ResolvedSendBody {
  readonly body: string;
  readonly usedComposedBody: boolean;
}

/**
 * The sender transmits composed_body ?? body. A composed body on a never-composed message
 * kind, or one that fails the send-time re-check (integrity hash, ceiling, or the wired
 * validator), falls back to the template body with an identifier-free metric — the send
 * itself always proceeds.
 */
export function resolveOutboundSendBody(
  row: StoredOutboundSendRow,
  options: { readonly emit?: MetricEmitter; readonly validate?: (sms: string) => boolean } = {},
): ResolvedSendBody {
  const emit = options.emit ?? consoleMetric;
  if (row.composedBody === null) return { body: row.body, usedComposedBody: false };
  if (!COMPOSABLE_MESSAGE_KINDS.has(row.messageKind)) {
    // Structural backstop for the inviolable template invariant: safety/STOP/fallback rows
    // NEVER transmit composed text, no matter what was written to the row.
    emit({ metric: 'composed_body_on_never_composed_kind' });
    return { body: row.body, usedComposedBody: false };
  }
  const intact =
    verifyComposedBodyIntegrity(row.composedBody, row.composition) &&
    (options.validate === undefined || options.validate(row.composedBody));
  if (!intact) {
    emit({ metric: 'composed_body_send_check_failed' });
    return { body: row.body, usedComposedBody: false };
  }
  return { body: row.composedBody, usedComposedBody: true };
}

export interface ComposerControlState {
  readonly enabled: boolean;
  readonly reason: 'env_disabled' | 'auto_disabled' | null;
}

export interface ComposeCheckpointRequest {
  readonly outboundMessageId: string;
  readonly patientId: string;
  readonly agentTurnId: string;
  readonly composedBody: string;
  readonly composition: Readonly<Record<string, unknown>>;
}

/**
 * The full per-composition audit record (binding spec): intent JSON, hashes, raw output,
 * per-attempt verdicts, fallback reason, and the composed text. Persisted durably into
 * turn_job.writer_result — the schema's designed home for the writer stage.
 */
export interface ComposerOutcomeRecord {
  readonly fallbackReason: string | null;
  readonly turnJobId: string;
  readonly patientId: string;
  readonly inputHash: string | null;
  readonly intent: ComposerIntent | null;
  readonly attempts: readonly ComposerAttempt[];
  readonly sms: string | null;
}

export interface ComposePersistence {
  readonly isEnabled: () => Promise<ComposerControlState>;
  readonly checkpoint: (request: ComposeCheckpointRequest) => Promise<boolean>;
  readonly recordOutcome: (
    outcome: ComposerOutcomeRecord,
  ) => Promise<{ readonly autoDisabled: boolean }>;
}

type Queryable = Pick<Pool, 'query'>;

/** Spellings that keep the composer ON. Anything else fails SAFE: templates ship. */
const COMPOSER_ENABLE_SPELLINGS: ReadonlySet<string> = new Set(['', 'false', '0', 'no', 'off']);

/**
 * Reads the operator kill switch, then the durable auto-disable flag. The kill switch fails
 * toward the templates: ANY set value other than an explicit enable spelling (including
 * 'TRUE', '1', 'yes', typos) disables composing — a misconfigured safety flag must never
 * silently leave the composer running.
 */
export async function isComposerEnabled(pool: Queryable): Promise<ComposerControlState> {
  const disableValue = (process.env[COMPOSER_DISABLE_ENV] ?? '').trim().toLowerCase();
  if (!COMPOSER_ENABLE_SPELLINGS.has(disableValue)) {
    return { enabled: false, reason: 'env_disabled' };
  }
  const result = await pool.query<{ disabled: boolean }>(
    'SELECT disabled FROM composer_control WHERE singleton',
  );
  return result.rows[0]?.disabled === true
    ? { enabled: false, reason: 'auto_disabled' }
    : { enabled: true, reason: null };
}

/**
 * Rolls the fallback window and applies the pre-registered abort: once the rolling fallback
 * share exceeds COMPOSER_FALLBACK_ABORT_RATE with at least COMPOSER_FALLBACK_MIN_SAMPLES
 * compositions in the window, the composer is durably disabled, templates ship, and the
 * identifier-free metric line says so.
 */
/** Writes the one-shot writer-stage audit record; never touches turn_job.failure_kind. */
async function persistComposerAudit(
  client: PoolClient,
  outcome: ComposerOutcomeRecord,
): Promise<void> {
  const record = {
    promptVersion: COMPOSER_PROMPT_VERSION,
    inputHash: outcome.inputHash,
    intent: outcome.intent,
    attempts: outcome.attempts,
    fallbackReason: outcome.fallbackReason,
    sms: outcome.sms,
  };
  await client.query(
    `UPDATE turn_job
        SET writer_attempted_at = now(), writer_result = $3::jsonb
      WHERE id = $1 AND patient_id = $2 AND writer_result IS NULL`,
    [outcome.turnJobId, outcome.patientId, JSON.stringify(record)],
  );
}

export async function recordCompositionOutcome(
  database: Pick<Pool, 'connect'>,
  outcome: ComposerOutcomeRecord,
  emit: MetricEmitter = consoleMetric,
): Promise<{ readonly autoDisabled: boolean }> {
  const isFallback = outcome.fallbackReason !== null;
  if (isFallback) {
    emit({ metric: 'composer_fallback', reason: outcome.fallbackReason });
  }
  const client = await database.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await persistComposerAudit(client, outcome);
    await client.query(
      `INSERT INTO composer_control (singleton) VALUES (true)
       ON CONFLICT (singleton) DO NOTHING`,
    );
    const locked = await client.query<{
      disabled: boolean;
      window_started_at: Date | null;
      compose_count: number;
      fallback_count: number;
      now_at: Date;
    }>(
      `SELECT disabled, window_started_at, compose_count, fallback_count,
              CURRENT_TIMESTAMP AS now_at
         FROM composer_control WHERE singleton FOR UPDATE`,
    );
    const row = locked.rows[0];
    if (row === undefined) throw new Error('composer_control_missing');
    const windowExpired =
      row.window_started_at === null ||
      new Date(row.now_at).getTime() - new Date(row.window_started_at).getTime() >
        COMPOSER_FALLBACK_WINDOW_MINUTES * 60_000;
    const composeCount = (windowExpired ? 0 : row.compose_count) + 1;
    const fallbackCount = (windowExpired ? 0 : row.fallback_count) + (isFallback ? 1 : 0);
    const autoDisabled =
      !row.disabled &&
      isFallback &&
      composeCount >= COMPOSER_FALLBACK_MIN_SAMPLES &&
      fallbackCount > composeCount * COMPOSER_FALLBACK_DISABLE_THRESHOLD;
    await client.query(
      `UPDATE composer_control
          SET compose_count = $1,
              fallback_count = $2,
              window_started_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP
                                       ELSE window_started_at END,
              disabled = disabled OR $4,
              disabled_reason = CASE WHEN $4 THEN 'fallback_rate' ELSE disabled_reason END,
              updated_at = CURRENT_TIMESTAMP
        WHERE singleton`,
      [composeCount, fallbackCount, windowExpired, autoDisabled],
    );
    await client.query('COMMIT');
    transactionOpen = false;
    if (autoDisabled) {
      emit({
        metric: 'composer_auto_disabled',
        windowComposeCount: composeCount,
        windowFallbackCount: fallbackCount,
      });
    }
    return { autoDisabled };
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Production persistence bundle for composeAndCheckpointPreparedReply. */
export function createComposePersistence(
  database: Pool,
  emit: MetricEmitter = consoleMetric,
): ComposePersistence {
  return {
    isEnabled: () => isComposerEnabled(database),
    checkpoint: (request) => checkpointComposedOutbound(database, request),
    recordOutcome: (outcome) => recordCompositionOutcome(database, outcome, emit),
  };
}

class ComposeTimeoutError extends Error {
  override readonly name = 'ComposeTimeoutError';

  constructor() {
    super('Composer exceeded its client-side time budget');
  }
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  // A late rejection of the losing compose promise must never become an unhandled rejection
  // (Node 24 default terminates the process, crashing the worker Lambda mid-batch).
  work.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ComposeTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sanitizedFallbackReason(reason: string): string {
  return FALLBACK_REASON_PATTERN.test(reason) ? reason : 'invalid_reason';
}

export interface ComposeTargetOutbound {
  readonly outboundMessageId: string;
  readonly patientId: string;
  readonly agentTurnId: string;
  /** The turn job whose writer_result column receives the composition audit record. */
  readonly turnJobId: string;
  /** ACTIVATION: every active medication's names already loaded on the turn (primary first). */
  readonly medicationNames: readonly (readonly string[])[];
  /** ACTIVATION: job.input.currentDayMessages + the current inbound, reused verbatim (item 8). */
  readonly dayContext: ComposerDayContext;
}

/**
 * One best-effort composition for an eligible prepared reply. Every composer-quality failure
 * (timeout, error, seam fallback, ceiling breach, checkpoint re-validation) records an
 * identifier-free fallback metric PLUS the durable audit record and ships the template; only
 * infrastructure failures (the checkpoint/counter writes) propagate, where the SQS redrive
 * replays WITHOUT composing and the template still sends.
 */
export async function composeAndCheckpointPreparedReply(
  persistence: ComposePersistence,
  composer: ClinicalComposerSeam | undefined,
  outbound: ComposeTargetOutbound,
  prepared: PreparedClinicalTurn,
  options: { readonly emit?: MetricEmitter; readonly timeoutMs?: number } = {},
): Promise<void> {
  if (composer === undefined) return;
  const emit = options.emit ?? consoleMetric;
  const control = await persistence.isEnabled();
  if (!control.enabled) {
    emit({ metric: 'composer_disabled_template_shipped', reason: control.reason });
    return;
  }

  const audit = (partial: Omit<ComposerOutcomeRecord, 'turnJobId' | 'patientId'>) => ({
    turnJobId: outbound.turnJobId,
    patientId: outbound.patientId,
    ...partial,
  });

  let outcome: ComposeSeamOutcome;
  try {
    outcome = await withTimeout(
      composer.compose({ ...outbound, prepared }),
      options.timeoutMs ?? COMPOSER_SEAM_TIMEOUT_MS,
    );
  } catch (error) {
    const reason = error instanceof ComposeTimeoutError ? 'timeout' : 'composer_error';
    await persistence.recordOutcome(
      audit({ fallbackReason: reason, inputHash: null, intent: null, attempts: [], sms: null }),
    );
    return;
  }
  if (outcome.kind === 'fallback') {
    await persistence.recordOutcome(
      audit({
        fallbackReason: sanitizedFallbackReason(outcome.reason),
        inputHash: outcome.inputHash,
        intent: null,
        attempts: outcome.attempts,
        sms: null,
      }),
    );
    return;
  }

  const { sms, intent, dayContext, inputHash, attempts } = outcome.draft;
  const draftAudit = (fallbackReason: string) =>
    audit({ fallbackReason, inputHash, intent, attempts, sms: null });
  if (sms !== sms.trim() || codePointLength(sms) < 1) {
    await persistence.recordOutcome(draftAudit('invalid_output'));
    return;
  }
  if (codePointLength(sms) > COMPOSED_SMS_MAX_CODE_POINTS) {
    await persistence.recordOutcome(draftAudit('length_exceeded'));
    return;
  }
  // Checkpoint-time enforcement: the seam's claim of validity is NEVER trusted — the full
  // validator set re-runs here on exactly the context that will be persisted for send time.
  const recheck = validateStoredComposedSms(sms, intent, dayContext);
  if (!recheck.ok) {
    await persistence.recordOutcome(draftAudit(sanitizedFallbackReason(recheck.reason)));
    return;
  }

  // The checkpoint runs AFTER the turn has committed and BEFORE the outbound invoke, so a
  // throw here (e.g. an oversize provenance blob rejected by the mirrored size ceiling) would
  // kill the worker mid-turn: the template would ship only after an SQS redrive, and no
  // fallback sample would ever reach the abort window. Composition is best-effort by design —
  // a failed checkpoint is one more template, recorded like every other fallback.
  let checkpointed: boolean;
  try {
    checkpointed = await persistence.checkpoint({
      outboundMessageId: outbound.outboundMessageId,
      patientId: outbound.patientId,
      agentTurnId: outbound.agentTurnId,
      composedBody: sms,
      composition: {
        ...outcome.draft.provenance,
        intent,
        dayContext,
        inputHash,
        attempts,
        composedBodySha256: sha256Utf8(sms),
      },
    });
  } catch {
    emit({ metric: 'composer_checkpoint_failed' });
    await persistence.recordOutcome(draftAudit('checkpoint_error'));
    return;
  }
  if (!checkpointed) {
    // Metric honesty: a lost checkpoint race (row already claimed/composed/superseded) never
    // ships composed text, so it must not count as a compose success in the pre-registered
    // >30% abort window — record it under its own fallback reason instead.
    emit({ metric: 'composer_checkpoint_skipped' });
    await persistence.recordOutcome(draftAudit('checkpoint_conflict'));
    return;
  }
  await persistence.recordOutcome(
    audit({ fallbackReason: null, inputHash, intent, attempts, sms }),
  );
}
