import { createHash, randomUUID } from 'node:crypto';
import { CONVERSATION_SCHEMA_VERSION } from '@medadhere/shared';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { Pool } from 'pg';
import { z } from 'zod';
import { terminalizePreparedAgentSend } from '../outbound/send-repository.js';
import {
  CLINICAL_EXTRACTOR_PROMPT_VERSION,
  CLINICAL_EXTRACTOR_SCHEMA_SHA256,
  CLINICAL_EXTRACTOR_SCHEMA_VERSION,
  type BoundedClaimStageModel,
} from './clinical-memory/anthropic-extractor.js';
import {
  prepareClinicalFailureTurn,
  prepareClinicalTurn,
  clinicalClaimsFromBoundedExtraction,
  isExpiredNeedWithinAnswerGrace,
  requiresBoundedClinicalExtraction,
  syntheticPromptedConfirmationClaims,
  type ClinicalClaimInput,
  type ClinicalRuntimeFailure,
  type InformationNeed,
  type NeedField,
  type PatientClinicalSnapshot,
  type PreparedClinicalTurn,
} from './clinical-memory/index.js';
import {
  commitPreparedClinicalTurn,
  findClinicalMemoryOutbound,
  loadPatientClinicalMemory,
  reconcileUnsentAskedNeed,
} from './clinical-memory/repository.js';
import {
  composeAndCheckpointPreparedReply,
  createComposePersistence,
  isComposeEligibleTurn,
  productionComposerSeam,
} from './compose-plumbing.js';
import type { ComposerDayContext } from './clinical-memory/composer-envelope.js';
import {
  conversationGatewayRequestSchema,
  conversationGatewayResponseSchema,
  type ConversationGatewayRequest,
  type ConversationGatewayResponse,
} from './gateway-contract.js';
import type { BoundedClaimExtraction } from './clinical-memory/bounded-provider.js';
import {
  claimProviderCircuit,
  hasNewerInboundReply,
  INTERPRETATION_RESERVED_INPUT_TOKENS,
  INTERPRETATION_RESERVED_OUTPUT_TOKENS,
  loadClinicalContextHashInTransaction,
  loadBoundedExtractionStageResult,
  loadConversationJob,
  MessagingConsentSuppressedError,
  persistConversationStageResult,
  releaseConversationStageReservation,
  recordProviderCircuitFailure,
  recordProviderCircuitSuccess,
  releaseProviderCircuitClaim,
  reserveConversationStage,
  RuntimeConflictError,
  type ConversationJobLoadResult,
  type BoundedExtractionStageRecord,
  type LoadedConversationJob,
  type ProviderCircuitClaim,
  type StagePersistenceResult,
  type StageReservationResult,
} from './runtime-repository.js';

const PROVIDER_KEY = 'anthropic:claude-sonnet-5';
const MODEL_ID = 'claude-sonnet-5';
const MAX_GATEWAY_REQUEST_BYTES = 96_000;

const outboundResultSchema = z
  .object({
    sent: z.boolean(),
    reason: z.string().trim().min(1).max(64).optional(),
    sid: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export const CONVERSATION_LAMBDA_CLIENT_CONFIG = Object.freeze({
  maxAttempts: 1,
  requestHandler: Object.freeze({ connectionTimeout: 2_000, socketTimeout: 65_000 }),
});

const lambda = new LambdaClient(CONVERSATION_LAMBDA_CLIENT_CONFIG);

export class ConversationStageFailure extends Error {
  override readonly name = 'ConversationStageFailure';

  constructor(readonly failureKind: ClinicalRuntimeFailure) {
    super('Conversation model stage could not complete');
  }
}

export interface ClinicalMemoryOutbound {
  readonly outboundMessageId: string;
  readonly patientId: string;
  readonly agentTurnId: string;
  readonly status: string;
  readonly messagingConsentEpoch: number;
  /**
   * Wave 1a: the prepared turn's response-plan kind. Only 'routine' and 'question' replies may
   * be suppressed by the newer-inbound backstop — safety, STOP, and review replies always send.
   * Unknown/missing kinds fail toward sending.
   */
  readonly responsePlanKind?: string | null;
}

export interface ClinicalMemoryJobDependencies {
  readonly findFinalizedOutbound: (
    inboundMessageId: string,
  ) => Promise<ClinicalMemoryOutbound | null>;
  readonly loadJob: (inboundMessageId: string) => Promise<ConversationJobLoadResult | null>;
  readonly loadBoundedClaims: (
    job: LoadedConversationJob,
    checkpoint?: BoundedExtractionStageRecord,
  ) => Promise<BoundedClaimExtraction>;
  readonly loadClinicalSnapshot: (job: LoadedConversationJob) => Promise<PatientClinicalSnapshot>;
  readonly prepareClinicalTurn: (
    snapshot: PatientClinicalSnapshot,
    claims: readonly ClinicalClaimInput[],
  ) => PreparedClinicalTurn;
  readonly prepareClinicalFailureTurn: (
    snapshot: PatientClinicalSnapshot,
    failure: ClinicalRuntimeFailure,
  ) => PreparedClinicalTurn;
  readonly commitPreparedClinicalTurn: (
    prepared: PreparedClinicalTurn,
  ) => Promise<ClinicalMemoryOutbound>;
  /**
   * Terminalizes a stale prepared reply. `supersededByNewerInbound` is true ONLY for the
   * newer-inbound (burst) cause — it stamps the row so batch coherence never aggregates
   * consent-stale or otherwise-failed turns into a later reply.
   */
  readonly terminalizePreparedOutbound: (
    outbound: ClinicalMemoryOutbound,
    supersededByNewerInbound: boolean,
  ) => Promise<void>;
  readonly invokeOutbound: (
    outbound: ClinicalMemoryOutbound,
    expectedMessagingStateVersion: number,
  ) => Promise<void>;
  /** Wave 1a race backstop: true when an inbound newer than this turn's message exists. */
  readonly hasNewerInbound: (inboundMessageId: string) => Promise<boolean>;
  /**
   * Wave 1b: composes a natural-language body for an eligible prepared reply and checkpoints
   * it as composed_body (the template `body` is never overwritten). Optional — absent means
   * templates ship. The core calls it on the FRESH path only, AFTER commit and BEFORE the
   * outbound invoke, gated by the never-composed set and the pre-compose recency check.
   */
  readonly composePreparedOutbound?: (
    outbound: ClinicalMemoryOutbound,
    prepared: PreparedClinicalTurn,
    context: ComposeInsertionContext,
  ) => Promise<void>;
}

/**
 * ACTIVATION — everything the compose seam needs that is already loaded on this turn (the
 * owner rule "code fetches, AI writes" — never a new provider or DB query at compose time).
 */
export interface ComposeInsertionContext {
  readonly turnJobId: string;
  /** job.input.currentDayMessages + the current inbound, reused verbatim (isolation item 8). */
  readonly dayContext: ComposerDayContext;
  /** Every active medication's names (primary display name first) — all share one med_N alias. */
  readonly medicationNames: readonly (readonly string[])[];
}

export interface DurableStageDependencies {
  readonly loadCheckpoint: () => Promise<BoundedExtractionStageRecord | null>;
  readonly reserve: (
    stage: 'interpretation',
    inputTokens: number,
    outputTokens: number,
  ) => Promise<StageReservationResult>;
  /**
   * Returns the reserved units after a post-reserve failure, consuming whatever the provider
   * actually billed. The one-shot attempt marker deliberately survives — this credits budget
   * back, it never makes a dispatched turn dispatchable again.
   */
  readonly releaseReservation: (inputTokens: number, outputTokens: number) => Promise<void>;
  readonly claimCircuit: (leaseId: string) => Promise<ProviderCircuitClaim>;
  readonly releaseCircuit: (leaseId: string) => Promise<void>;
  readonly persist: (record: BoundedExtractionStageRecord) => Promise<StagePersistenceResult>;
  readonly recordCircuitSuccess: (leaseId: string) => Promise<void>;
  readonly recordCircuitFailure: (
    leaseId: string,
    failureKind: 'auth' | 'transient' | 'contract',
  ) => Promise<void>;
  readonly invokeGateway: (
    request: ConversationGatewayRequest,
  ) => Promise<ConversationGatewayResponse>;
  readonly createLeaseId: () => string;
  readonly expectedSchemaSha256: string;
}

export interface ConversationLambdaInvokeOutput {
  readonly FunctionError?: string;
  readonly Payload?: Uint8Array;
}

export interface ConversationGatewayInvokeDependencies {
  readonly functionArn: string;
  readonly send: (command: InvokeCommand) => Promise<ConversationLambdaInvokeOutput>;
}

/** One synchronous Lambda transport attempt; callers own the durable stage marker. */
export async function invokeConversationGateway(
  untrustedRequest: ConversationGatewayRequest,
  dependencies: ConversationGatewayInvokeDependencies,
): Promise<ConversationGatewayResponse> {
  const request = conversationGatewayRequestSchema.parse(untrustedRequest);
  const payload = new TextEncoder().encode(JSON.stringify(request));
  if (payload.byteLength > MAX_GATEWAY_REQUEST_BYTES) {
    throw new Error('Conversation gateway request exceeds the transport ceiling');
  }
  const response = await dependencies.send(
    new InvokeCommand({
      FunctionName: dependencies.functionArn,
      InvocationType: 'RequestResponse',
      Payload: payload,
    }),
  );
  if (response.FunctionError || response.Payload === undefined) {
    throw new Error('Conversation gateway invocation failed');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(response.Payload));
  } catch {
    throw new Error('Conversation gateway response is invalid');
  }
  const parsed = conversationGatewayResponseSchema.safeParse(decoded);
  if (
    !parsed.success ||
    parsed.data.requestId !== request.requestId ||
    parsed.data.stage !== request.stage
  ) {
    throw new Error('Conversation gateway response is invalid');
  }
  return parsed.data;
}

function gatewayRequestHash(request: ConversationGatewayRequest): string {
  const serialized = JSON.stringify(request);
  if (new TextEncoder().encode(serialized).byteLength > MAX_GATEWAY_REQUEST_BYTES) {
    throw new ConversationStageFailure('internal_error');
  }
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

function runtimeFailure(
  kind: Extract<ConversationGatewayResponse, { readonly ok: false }>['failureKind'],
): ClinicalRuntimeFailure {
  if (kind === 'malformed' || kind === 'refused' || kind === 'truncated') {
    return 'malformed_output';
  }
  if (kind === 'input_too_large') return 'budget_exhausted';
  return kind === 'internal' ? 'internal_error' : 'provider_error';
}

function circuitFailure(
  kind: Extract<ConversationGatewayResponse, { readonly ok: false }>['failureKind'],
): 'auth' | 'transient' | 'contract' {
  if (kind === 'auth') return 'auth';
  return kind === 'rate_limited' || kind === 'transient' ? 'transient' : 'contract';
}

function validateCheckpoint(
  checkpoint: BoundedExtractionStageRecord,
  request: Extract<ConversationGatewayRequest, { readonly stage: 'interpretation' }>,
  contextHash: string,
  expectedSchemaSha256: string,
): BoundedClaimExtraction {
  if (
    checkpoint.stage !== request.stage ||
    checkpoint.modelId !== MODEL_ID ||
    request.input.promptVersion !== CLINICAL_EXTRACTOR_PROMPT_VERSION ||
    request.input.schemaVersion !== CLINICAL_EXTRACTOR_SCHEMA_VERSION ||
    checkpoint.promptVersion !== request.input.promptVersion ||
    checkpoint.schemaVersion !== request.input.schemaVersion ||
    checkpoint.schemaSha256 !== expectedSchemaSha256 ||
    checkpoint.contextHash !== contextHash
  ) {
    throw new ConversationStageFailure('internal_error');
  }
  return checkpoint.output;
}

async function executeDurableInterpretationStage(
  request: Extract<ConversationGatewayRequest, { readonly stage: 'interpretation' }>,
  dependencies: DurableStageDependencies,
): Promise<BoundedClaimExtraction> {
  if (
    request.input.promptVersion !== CLINICAL_EXTRACTOR_PROMPT_VERSION ||
    request.input.schemaVersion !== CLINICAL_EXTRACTOR_SCHEMA_VERSION
  ) {
    throw new ConversationStageFailure('internal_error');
  }
  const contextHash = gatewayRequestHash(request);
  const existing = await dependencies.loadCheckpoint();
  if (existing !== null) {
    return validateCheckpoint(existing, request, contextHash, dependencies.expectedSchemaSha256);
  }

  const leaseId = dependencies.createLeaseId();
  const circuit = await dependencies.claimCircuit(leaseId);
  if (circuit.kind === 'open') throw new ConversationStageFailure('circuit_open');

  let reservation: StageReservationResult;
  try {
    reservation = await dependencies.reserve(
      'interpretation',
      INTERPRETATION_RESERVED_INPUT_TOKENS,
      INTERPRETATION_RESERVED_OUTPUT_TOKENS,
    );
  } catch (error) {
    if (circuit.kind === 'half_open') await dependencies.releaseCircuit(leaseId);
    throw error;
  }
  if (reservation.kind === 'budget_exhausted') {
    if (circuit.kind === 'half_open') await dependencies.releaseCircuit(leaseId);
    throw new ConversationStageFailure('budget_exhausted');
  }
  if (reservation.kind === 'suppressed') {
    if (circuit.kind === 'half_open') await dependencies.releaseCircuit(leaseId);
    throw new MessagingConsentSuppressedError();
  }
  if (reservation.kind === 'already_attempted') {
    if (circuit.kind === 'half_open') await dependencies.releaseCircuit(leaseId);
    const replay = await dependencies.loadCheckpoint();
    if (replay === null) throw new ConversationStageFailure('ambiguous_outcome');
    return validateCheckpoint(replay, request, contextHash, dependencies.expectedSchemaSha256);
  }

  // Live incident (2026-08-17): from here on the turn holds real budget, and it used to be
  // returned ONLY by a successful persist — so a terminally failed extraction leaked its whole
  // reservation and starved every later turn of the patient's day into budget_exhausted. Every
  // exit below now settles the reservation exactly once, charging whatever the provider
  // actually billed; the one-shot attempt marker is untouched, so a redrive still cannot
  // re-invoke the provider.
  let billedUsage: { readonly inputTokens: number; readonly outputTokens: number } | null = null;
  let settled = false;
  try {
    let response: ConversationGatewayResponse;
    try {
      response = await dependencies.invokeGateway(request);
    } catch {
      await dependencies.recordCircuitFailure(leaseId, 'transient');
      throw new ConversationStageFailure('ambiguous_outcome');
    }
    billedUsage = response.usage;
    if (!response.ok) {
      if (response.failureKind === 'input_too_large') {
        await dependencies.recordCircuitSuccess(leaseId);
        throw new ConversationStageFailure(runtimeFailure(response.failureKind));
      }
      await dependencies.recordCircuitFailure(leaseId, circuitFailure(response.failureKind));
      throw new ConversationStageFailure(runtimeFailure(response.failureKind));
    }
    if (
      response.stage !== 'interpretation' ||
      response.metadata.modelId !== MODEL_ID ||
      response.metadata.promptVersion !== CLINICAL_EXTRACTOR_PROMPT_VERSION ||
      response.metadata.schemaSha256 !== dependencies.expectedSchemaSha256
    ) {
      await dependencies.recordCircuitFailure(leaseId, 'contract');
      throw new ConversationStageFailure('internal_error');
    }
    const record: BoundedExtractionStageRecord = {
      stage: response.stage,
      output: response.result,
      modelId: response.metadata.modelId,
      promptVersion: response.metadata.promptVersion,
      schemaVersion: request.input.schemaVersion,
      schemaSha256: response.metadata.schemaSha256,
      contextHash,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      latencyMs: response.metadata.latencyMs,
    };
    await dependencies.persist(record);
    // persist moved reserved -> consumed in its own transaction; nothing left to settle.
    settled = true;
    await dependencies.recordCircuitSuccess(leaseId);
    return record.output;
  } catch (error) {
    if (!settled) {
      await dependencies.releaseReservation(
        billedUsage?.inputTokens ?? 0,
        billedUsage?.outputTokens ?? 0,
      );
    }
    throw error;
  }
}

/** Resumes the bounded extraction checkpoint and dispatches it at most once. */
export function createDurableBoundedClaimExtractor(
  job: LoadedConversationJob,
  openInformationNeeds: readonly {
    readonly id: string;
    readonly field: NeedField;
    readonly state: InformationNeed['state'];
  }[],
  dependencies: DurableStageDependencies,
): BoundedClaimStageModel {
  // Asked needs are answerable, and so are expired ones the CALLER pre-filtered to the
  // answer-grace window (isExpiredNeedWithinAnswerGrace) — omitting those makes the grace
  // path unreachable: the prompt forbids need_answer claims for unlisted needs, so a late
  // clear answer would be misrouted as a new topic. Open needs stay model-invisible.
  const answerableInformationNeeds = openInformationNeeds
    .filter(({ state }) => state === 'asked' || state === 'expired')
    .map(({ id, field }) => ({ id, field }))
    .sort(
      (left, right) => left.field.localeCompare(right.field) || left.id.localeCompare(right.id),
    );
  if (answerableInformationNeeds.length > 20) throw new ConversationStageFailure('internal_error');
  return {
    extract: async () =>
      executeDurableInterpretationStage(
        {
          requestId: job.input.requestId,
          stage: 'interpretation',
          input: {
            currentMessage: {
              id: job.input.currentMessage.id,
              direction: 'inbound',
              body: job.input.currentMessage.body,
            },
            openInformationNeeds: answerableInformationNeeds,
            promptVersion: CLINICAL_EXTRACTOR_PROMPT_VERSION,
            schemaVersion: CLINICAL_EXTRACTOR_SCHEMA_VERSION,
          },
        },
        dependencies,
      ),
  };
}

/** Runs the recovered clinical-memory pipeline without invoking a legacy semantic owner. */
export async function processClinicalMemoryJobCore(
  inboundMessageId: string,
  dependencies: ClinicalMemoryJobDependencies,
): Promise<void> {
  const job = await dependencies.loadJob(inboundMessageId);
  if (job === null) throw new Error('Conversation job context is unavailable');
  const replay = await dependencies.findFinalizedOutbound(inboundMessageId);
  if (job.kind === 'suppressed') {
    if (replay?.status === 'prepared') {
      await dependencies.terminalizePreparedOutbound(replay, false);
    }
    return;
  }

  const invokePreparedOutbound = async (outbound: ClinicalMemoryOutbound): Promise<void> => {
    if (outbound.status !== 'prepared') return;
    if (outbound.messagingConsentEpoch !== job.messagingStateVersion) {
      await dependencies.terminalizePreparedOutbound(outbound, false);
      return;
    }
    // Wave 1a race backstop: a message that arrived after this turn prepared makes its
    // routine/question reply stale — terminalize it so the surviving turn answers the whole
    // burst (the production terminalizer also reconciles an un-sent asked question back to
    // open). Safety, STOP, and review replies always send.
    if (
      (outbound.responsePlanKind === 'routine' || outbound.responsePlanKind === 'question') &&
      (await dependencies.hasNewerInbound(inboundMessageId))
    ) {
      await dependencies.terminalizePreparedOutbound(outbound, true);
      return;
    }
    await dependencies.invokeOutbound(outbound, job.messagingStateVersion);
  };
  if (replay !== null) {
    await invokePreparedOutbound(replay);
    return;
  }

  const checkpointExtraction =
    job.boundedCheckpoint === undefined
      ? undefined
      : await dependencies.loadBoundedClaims(job, job.boundedCheckpoint);
  const snapshot = await dependencies.loadClinicalSnapshot(job);
  let prepared: PreparedClinicalTurn;
  if (!requiresBoundedClinicalExtraction(snapshot)) {
    prepared = dependencies.prepareClinicalTurn(snapshot, []);
  } else {
    try {
      const synthetic = syntheticPromptedConfirmationClaims(snapshot);
      if (synthetic !== null) {
        prepared = dependencies.prepareClinicalTurn(snapshot, synthetic);
      } else {
        const extraction = checkpointExtraction ?? (await dependencies.loadBoundedClaims(job));
        const claims = clinicalClaimsFromBoundedExtraction(snapshot, extraction);
        prepared = dependencies.prepareClinicalTurn(snapshot, claims);
      }
    } catch (error) {
      if (error instanceof MessagingConsentSuppressedError) return;
      if (!(error instanceof ConversationStageFailure) || error.failureKind === 'internal_error') {
        throw error;
      }
      prepared = dependencies.prepareClinicalFailureTurn(snapshot, error.failureKind);
    }
  }
  const outbound = await dependencies.commitPreparedClinicalTurn(prepared);
  // Wave 1b compose insertion: FRESH path only (a replay above never reaches here, so a
  // redrive cannot loop through the composer). The never-composed set is checked first, then
  // the pre-compose recency check — a superseded turn skips the compose call entirely; the
  // invoke-time newer-inbound check below remains the independent race backstop.
  if (
    dependencies.composePreparedOutbound !== undefined &&
    outbound.status === 'prepared' &&
    isComposeEligibleTurn(prepared, snapshot.memory.routineClarificationsPaused) &&
    !(await dependencies.hasNewerInbound(inboundMessageId))
  ) {
    await dependencies.composePreparedOutbound(outbound, prepared, {
      turnJobId: job.turnJobId,
      // Isolation item 8: job.input.currentDayMessages already carries the delivery-status
      // filter that stops the composer referencing replies the patient never received — reused
      // verbatim, only the transport-only `language` field is stripped.
      dayContext: {
        messages: job.input.currentDayMessages.map(({ id, direction, body, occurredAtUtc }) => ({
          id,
          direction,
          body,
          occurredAtUtc,
        })),
        latestPatientMessage: job.input.currentMessage.body,
      },
      // "code fetches, AI writes": medications already loaded on this turn — never a new query.
      // ALL of a medication's names travel together so every one of them is aliased before the
      // provider sees the day context (a patient's brand-name wording included).
      medicationNames: snapshot.medications
        .filter((medication) => medication.active)
        .flatMap((medication) => (medication.names[0] === undefined ? [] : [medication.names])),
    });
  }
  await invokePreparedOutbound(outbound);
}

function requiredArn(name: 'LLM_GATEWAY_FN_ARN' | 'OUTBOUND_FN_ARN'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} env var is not set`);
  return value;
}

async function invokeOutboundLambda(
  outbound: Pick<ClinicalMemoryOutbound, 'patientId' | 'agentTurnId'>,
  expectedMessagingStateVersion: number,
  functionArn: string,
): Promise<void> {
  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: functionArn,
      InvocationType: 'RequestResponse',
      Payload: new TextEncoder().encode(
        JSON.stringify({
          patientId: outbound.patientId,
          agentTurnId: outbound.agentTurnId,
          expectedMessagingStateVersion,
        }),
      ),
    }),
  );
  if (response.FunctionError || response.Payload === undefined) {
    throw new Error('Outbound Lambda invocation failed');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(response.Payload));
  } catch {
    throw new Error('Outbound Lambda response is invalid');
  }
  if (!outboundResultSchema.safeParse(parsed).success) {
    throw new Error('Outbound Lambda response is invalid');
  }
}

/** Production composition for the existing FIFO worker; no provider or Twilio secret crosses it. */
export async function processConversationJob(
  inboundMessageId: string,
  database: Pool,
): Promise<void> {
  const gatewayArn = requiredArn('LLM_GATEWAY_FN_ARN');
  const outboundArn = requiredArn('OUTBOUND_FN_ARN');
  const loadJobRequest = (id: string, includeClinicalSnapshot = false) => ({
    inboundMessageId: id,
    requestId: id,
    expectedLanguage: 'en',
    promptVersion: CLINICAL_EXTRACTOR_PROMPT_VERSION,
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    includeClinicalSnapshot,
  });
  const loadJob = (id: string, includeClinicalSnapshot = false) =>
    loadConversationJob(database, loadJobRequest(id, includeClinicalSnapshot));
  await processClinicalMemoryJobCore(inboundMessageId, {
    findFinalizedOutbound: (id) => findClinicalMemoryOutbound(database, id),
    loadJob: (id) => loadJob(id),
    loadBoundedClaims: async (job, checkpoint) => {
      const memory = await loadPatientClinicalMemory(database, job.input.patientId);
      // Expired needs still inside the answer grace stay claimable (Wave 1a): the extractor
      // factory projects them to the model alongside asked needs; the resolver re-checks the
      // grace deterministically before resolving.
      const openInformationNeeds = memory.needs
        .filter(
          (need) =>
            need.state === 'open' ||
            need.state === 'asked' ||
            isExpiredNeedWithinAnswerGrace(memory, need),
        )
        .map(({ id, field, state }) => ({ id, field, state }));
      return createDurableBoundedClaimExtractor(job, openInformationNeeds, {
        loadCheckpoint: () =>
          checkpoint === undefined
            ? loadBoundedExtractionStageResult(database, {
                turnJobId: job.turnJobId,
                patientId: job.input.patientId,
              })
            : Promise.resolve(checkpoint),
        reserve: (stage, reservedInputTokens, reservedOutputTokens) =>
          reserveConversationStage(database, {
            turnJobId: job.turnJobId,
            patientId: job.input.patientId,
            stage,
            reservedInputTokens,
            reservedOutputTokens,
          }),
        releaseReservation: (inputTokens, outputTokens) =>
          releaseConversationStageReservation(database, {
            turnJobId: job.turnJobId,
            patientId: job.input.patientId,
            inputTokens,
            outputTokens,
          }),
        claimCircuit: (leaseId) =>
          claimProviderCircuit(database, { providerKey: PROVIDER_KEY, leaseId }),
        releaseCircuit: (leaseId) =>
          releaseProviderCircuitClaim(database, { providerKey: PROVIDER_KEY, leaseId }),
        persist: (record) =>
          persistConversationStageResult(database, {
            turnJobId: job.turnJobId,
            patientId: job.input.patientId,
            record,
          }),
        recordCircuitSuccess: (leaseId) =>
          recordProviderCircuitSuccess(database, { providerKey: PROVIDER_KEY, leaseId }),
        recordCircuitFailure: (leaseId, failureKind) =>
          recordProviderCircuitFailure(database, {
            providerKey: PROVIDER_KEY,
            leaseId,
            failureKind,
          }),
        invokeGateway: (request) =>
          invokeConversationGateway(request, {
            functionArn: gatewayArn,
            send: (command) => lambda.send(command),
          }),
        createLeaseId: randomUUID,
        expectedSchemaSha256: CLINICAL_EXTRACTOR_SCHEMA_SHA256,
      }).extract({
        currentMessage: {
          id: job.input.currentMessage.id,
          direction: 'inbound',
          body: job.input.currentMessage.body,
        },
        openInformationNeeds,
      });
    },
    loadClinicalSnapshot: async (job) => {
      const fresh = await loadJob(job.input.inboundMessageId, true);
      if (fresh === null) throw new Error('Conversation job context is unavailable');
      if (fresh.kind === 'suppressed') throw new MessagingConsentSuppressedError();
      if (
        fresh.turnJobId !== job.turnJobId ||
        fresh.input.patientId !== job.input.patientId ||
        fresh.clinicalSnapshot === undefined
      ) {
        throw new RuntimeConflictError();
      }
      return fresh.clinicalSnapshot;
    },
    prepareClinicalTurn,
    prepareClinicalFailureTurn,
    commitPreparedClinicalTurn: async (prepared) => {
      await commitPreparedClinicalTurn(database, prepared, (client) =>
        loadClinicalContextHashInTransaction(
          client,
          loadJobRequest(prepared.sourceMessageId, true),
        ),
      );
      const outbound = await findClinicalMemoryOutbound(database, prepared.sourceMessageId);
      if (outbound === null) throw new Error('Committed clinical outbound is unavailable');
      return outbound;
    },
    terminalizePreparedOutbound: async (outbound, supersededByNewerInbound) => {
      await terminalizePreparedAgentSend(database, { ...outbound, supersededByNewerInbound });
      // Wave 1a: an un-sent question turn must not strand its need in 'asked' — the patient
      // never received the question, so the need reopens for the surviving turn. Idempotent;
      // a crash between the two calls is covered by asked-need expiry.
      await reconcileUnsentAskedNeed(database, outbound);
    },
    invokeOutbound: (outbound, expectedMessagingStateVersion) =>
      invokeOutboundLambda(outbound, expectedMessagingStateVersion, outboundArn),
    hasNewerInbound: (id) => hasNewerInboundReply(database, id),
    composePreparedOutbound: (outbound, prepared, context) =>
      composeAndCheckpointPreparedReply(
        createComposePersistence(database),
        productionComposerSeam({
          database,
          // Wave 1b ACTIVATION: the SAME Lambda-invoke transport the interpretation stage
          // uses (invokeConversationGateway is stage-agnostic — it already validates against
          // conversationGatewayRequestSchema's full union).
          invokeGateway: (request) =>
            invokeConversationGateway(request, {
              functionArn: gatewayArn,
              send: (command) => lambda.send(command),
            }),
        }),
        { ...outbound, ...context },
        prepared,
      ),
  });
}
