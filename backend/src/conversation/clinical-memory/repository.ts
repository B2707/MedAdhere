import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { assertLowestUnfinishedConversationJob } from '../runtime-fifo.js';
import {
  persistCanonicalProjections,
  semanticEventKind,
  storedEventType,
} from './canonical-projections.js';
import {
  applyPreparedClinicalTurn,
  CURRENT_CLINICAL_PIPELINE_VERSIONS,
  MAX_RECENT_COMMAND_BATCHES,
  processedCommandBatchSchema,
  validatePreparedClinicalTurn,
  type ClinicalEvent,
  type ClinicalIntentCommand,
  type CommittedClinicalTurn,
  type InformationNeed,
  type PatientClinicalMemory,
  type PreparedClinicalTurn,
} from './index.js';

type Queryable = Pick<PoolClient, 'query'>;

const uuidSchema = z.string().uuid();
const MAX_ENTITY_ORDERING_RECEIPTS = 4_000;

export interface ClinicalMemoryOutbound {
  readonly outboundMessageId: string;
  readonly patientId: string;
  readonly agentTurnId: string;
  readonly status: string;
  readonly messagingConsentEpoch: number;
  /** Wave 1a: response-plan kind of the turn — gates the newer-inbound send backstop. */
  readonly responsePlanKind?: string | null;
}

function asNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

export async function findClinicalMemoryOutbound(
  client: Queryable,
  inboundMessageId: string,
): Promise<ClinicalMemoryOutbound | null> {
  const result = await client.query<{
    outbound_message_id: string;
    patient_id: string;
    agent_turn_id: string;
    status: string;
    messaging_consent_epoch: number;
    response_plan_kind: string | null;
  }>(
    `SELECT outbound.id::text AS outbound_message_id,
            outbound.patient_id::text,
            outbound.agent_turn_id::text,
            outbound.status,
            outbound.messaging_consent_epoch,
            turn_record.prepared_response_plan ->> 'kind' AS response_plan_kind
       FROM agent_turn turn_record
       JOIN outbound_message outbound
         ON outbound.patient_id = turn_record.patient_id
        AND outbound.agent_turn_id = turn_record.id
      WHERE turn_record.inbound_message_id = $1
        AND turn_record.prepared_batch_hash IS NOT NULL`,
    [uuidSchema.parse(inboundMessageId)],
  );
  if (result.rows.length > 1) throw new Error('clinical_outbound_duplicate');
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        outboundMessageId: row.outbound_message_id,
        patientId: row.patient_id,
        agentTurnId: row.agent_turn_id,
        status: row.status,
        messagingConsentEpoch: z.number().int().positive().parse(row.messaging_consent_epoch),
        responsePlanKind: row.response_plan_kind,
      };
}

type ReceiptListKey = 'eventIds' | 'needIds' | 'unresolvedReportIds' | 'reviewItemIds';

function inReducerOrder<T extends { readonly id: string }>(
  values: readonly T[],
  receipts: PatientClinicalMemory['processedBatches'],
  key: ReceiptListKey,
): T[] {
  const ids = receipts.flatMap((receipt) => receipt[key]);
  if (new Set(ids).size !== ids.length) throw new Error('processed_batch_receipt_invalid');
  const valueIds = new Set(values.map(({ id }) => id));
  if (ids.some((id) => !valueIds.has(id))) throw new Error('processed_batch_receipt_invalid');
  const order = new Map(ids.map((id, index) => [id, index]));
  const originalOrder = new Map(values.map(({ id }, index) => [id, index]));
  return [...values].sort((left, right) => {
    const leftOrder = order.get(left.id);
    const rightOrder = order.get(right.id);
    if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder;
    if (leftOrder !== undefined) return 1;
    if (rightOrder !== undefined) return -1;
    return originalOrder.get(left.id)! - originalOrder.get(right.id)!;
  });
}

async function physicalId(
  client: Queryable,
  table: 'clinical_event' | 'information_need' | 'clinical_review_item',
  patientId: string,
  semanticColumn: 'semantic_event_id' | 'semantic_need_id' | 'semantic_review_item_id',
  semanticId: string | undefined,
): Promise<string | null> {
  if (semanticId === undefined) return null;
  const result = await client.query<{ id: string }>(
    `SELECT id::text FROM ${table} WHERE patient_id = $1 AND ${semanticColumn} = $2`,
    [patientId, semanticId],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('clinical_memory_reference_missing');
  return id;
}

function eventClinicalValues(event: ClinicalEvent): Record<string, unknown> {
  const omitted = new Set([
    'id',
    'version',
    'kind',
    'operation',
    'authoredBy',
    'reviewState',
    'current',
    'canonical',
    'sourceMessageIds',
    'sourceSpans',
    'supersedesEventId',
    'recurrenceOfEventId',
    'contradictionOfEventId',
  ]);
  return Object.fromEntries(Object.entries(event).filter(([key]) => !omitted.has(key)));
}

function responseMessageKind(prepared: PreparedClinicalTurn): string {
  if (prepared.responsePlan.kind === 'question') return 'clarification';
  if (prepared.responsePlan.kind === 'emergency' || prepared.responsePlan.kind === 'important')
    return 'safety';
  // 'acknowledgement' is a COMPOSABLE kind at the DB CHECK, the checkpoint UPDATE, and the
  // sender. Carrier-compliance and unsupported-language replies are byte-exact templates, so
  // they must not land on it — the three structural layers of the never-composed invariant
  // have to hold for them too, not just the worker-side plan-kind gate.
  if (
    prepared.responsePlan.kind === 'human_review' ||
    prepared.responsePlan.kind === 'stop' ||
    prepared.responsePlan.kind === 'unsupported_language'
  )
    return 'fallback';
  return 'acknowledgement';
}

function responsePolicyTier(prepared: PreparedClinicalTurn): 'routine' | 'important' | 'emergency' {
  if (prepared.responsePlan.kind === 'emergency') return 'emergency';
  if (prepared.responsePlan.kind === 'important' || prepared.responsePlan.kind === 'human_review')
    return 'important';
  return 'routine';
}

function commandForNeed(
  commands: readonly ClinicalIntentCommand[],
  needId: string,
): ClinicalIntentCommand | undefined {
  return commands.find((command) => 'needId' in command && command.needId === needId);
}

async function loadEvents(
  client: Queryable,
  patientId: string,
  atVersion: number | null,
): Promise<ClinicalEvent[]> {
  const rows = await client.query<{
    semantic_event_id: string;
    semantic_event_version: number;
    event_type: ClinicalEvent['kind'] | 'patient_statement';
    clinical_operation: ClinicalEvent['operation'];
    authored_by: ClinicalEvent['authoredBy'];
    review_state: ClinicalEvent['reviewState'];
    is_canonical_patient_report: boolean;
    source_spans: ClinicalEvent['sourceSpans'];
    clinical_values: Record<string, unknown>;
    supersedes_event_id: string | null;
    recurrence_event_id: string | null;
    contradiction_event_id: string | null;
    current: boolean;
  }>(
    `SELECT event.semantic_event_id,
            event.semantic_event_version,
            event.event_type,
            event.clinical_operation,
            event.authored_by,
            event.review_state,
            event.is_canonical_patient_report,
            event.source_spans,
            event.clinical_values,
            superseded.semantic_event_id AS supersedes_event_id,
            recurrent.semantic_event_id AS recurrence_event_id,
            contradicted.semantic_event_id AS contradiction_event_id,
            NOT EXISTS (
              SELECT 1 FROM clinical_event successor
              LEFT JOIN agent_turn successor_turn
                ON successor_turn.patient_id = successor.patient_id
               AND successor_turn.id = successor.agent_turn_id
               WHERE successor.patient_id = event.patient_id
                 AND successor.supersedes_id = event.id
                 AND (
                   $2::bigint IS NULL
                   OR successor.agent_turn_id IS NULL
                   OR successor_turn.result_clinical_memory_version <= $2
                 )
            ) AS current
       FROM clinical_event event
       LEFT JOIN agent_turn created_turn
         ON created_turn.patient_id = event.patient_id
        AND created_turn.id = event.agent_turn_id
       LEFT JOIN clinical_event superseded ON superseded.id = event.supersedes_id
       LEFT JOIN clinical_event recurrent ON recurrent.id = event.recurrence_of_event_id
       LEFT JOIN clinical_event contradicted ON contradicted.id = event.contradiction_of_event_id
      WHERE event.patient_id = $1 AND event.semantic_event_id IS NOT NULL
        AND (
          $2::bigint IS NULL
          OR event.agent_turn_id IS NULL
          OR created_turn.result_clinical_memory_version <= $2
        )
      ORDER BY event.created_at, event.semantic_event_id`,
    [patientId, atVersion],
  );
  const sources = await client.query<{
    semantic_event_id: string;
    source_message_ids: string[];
  }>(
    `SELECT event.semantic_event_id,
            array_agg(source.source_inbound_id::text ORDER BY source.source_order) AS source_message_ids
       FROM clinical_event event
       LEFT JOIN agent_turn created_turn
         ON created_turn.patient_id = event.patient_id
        AND created_turn.id = event.agent_turn_id
       JOIN clinical_event_source source ON source.clinical_event_id = event.id
      WHERE event.patient_id = $1 AND event.semantic_event_id IS NOT NULL
        AND (
          $2::bigint IS NULL
          OR event.agent_turn_id IS NULL
          OR created_turn.result_clinical_memory_version <= $2
        )
      GROUP BY event.id, event.semantic_event_id`,
    [patientId, atVersion],
  );
  const sourceByEvent = new Map(
    sources.rows.map(({ semantic_event_id, source_message_ids }) => [
      semantic_event_id,
      source_message_ids,
    ]),
  );
  return rows.rows.map((row) => ({
    id: row.semantic_event_id,
    version: row.semantic_event_version,
    kind: semanticEventKind(row.event_type),
    operation: row.clinical_operation,
    authoredBy: row.authored_by,
    reviewState: row.review_state,
    current: row.current,
    canonical: row.is_canonical_patient_report,
    sourceMessageIds: sourceByEvent.get(row.semantic_event_id) ?? [],
    sourceSpans: row.source_spans,
    ...(row.supersedes_event_id === null ? {} : { supersedesEventId: row.supersedes_event_id }),
    ...(row.recurrence_event_id === null ? {} : { recurrenceOfEventId: row.recurrence_event_id }),
    ...(row.contradiction_event_id === null
      ? {}
      : { contradictionOfEventId: row.contradiction_event_id }),
    ...row.clinical_values,
  })) as ClinicalEvent[];
}

async function loadNeeds(
  client: Queryable,
  patientId: string,
  atVersion: number | null,
): Promise<InformationNeed[]> {
  const rows = await client.query<{
    need_id: string;
    semantic_need_id: string;
    origin_inbound_id: string;
    origin_inbound_sequence: number | string;
    target_event_id: string | null;
    target_event_version: number | null;
    requested_field: InformationNeed['field'];
    question_id: string;
    priority: number;
    supersedes_need_id: string | null;
    scope_payload: Pick<
      InformationNeed,
      | 'candidateMedicationIds'
      | 'candidateDoseIds'
      | 'candidateSymptomEventIds'
      | 'candidateHistoricalEventIds'
    > & {
      candidateHistoricalEvents?: InformationNeed['candidateHistoricalEvents'];
      pendingOperation?: InformationNeed['pendingOperation'] | null;
    };
    transition_version: number;
    to_state: InformationNeed['state'];
    clarification_attempt_used: boolean;
    expired_at_inbound_id: string | null;
  }>(
    `SELECT need.id::text AS need_id,
            need.semantic_need_id,
            need.origin_inbound_id::text,
            need.origin_inbound_sequence,
            target.semantic_event_id AS target_event_id,
            need.target_event_version,
            need.requested_field,
            need.question_id,
            need.priority,
            previous.semantic_need_id AS supersedes_need_id,
            scope.scope_payload,
            latest.transition_version,
            latest.to_state,
            latest.clarification_attempt_used,
            expiry.source_inbound_id::text AS expired_at_inbound_id
       FROM information_need need
       JOIN agent_turn created_turn
         ON created_turn.patient_id = need.patient_id
        AND created_turn.id = need.created_by_agent_turn_id
       LEFT JOIN clinical_event target ON target.id = need.target_clinical_event_id
       JOIN information_need_scope scope ON scope.information_need_id = need.id
       JOIN LATERAL (
         SELECT transition_version, to_state, clarification_attempt_used
           FROM information_need_transition transition
           JOIN agent_turn transition_turn
             ON transition_turn.patient_id = transition.patient_id
            AND transition_turn.id = transition.agent_turn_id
          WHERE transition.information_need_id = need.id
            AND (
              $2::bigint IS NULL
              OR transition_turn.result_clinical_memory_version <= $2
            )
          ORDER BY transition_version DESC LIMIT 1
       ) latest ON true
       -- Wave 1a: the stale-question expiry transition anchors the answer-grace window; the
       -- reducer marks it by stamping expiredAtInboundMessageId, persisted via the transition's
       -- stale_question_expiry flag.
       LEFT JOIN LATERAL (
         SELECT transition.source_inbound_id
           FROM information_need_transition transition
           JOIN agent_turn transition_turn
             ON transition_turn.patient_id = transition.patient_id
            AND transition_turn.id = transition.agent_turn_id
          WHERE transition.information_need_id = need.id
            AND transition.to_state = 'expired'
            AND transition.stale_question_expiry
            AND (
              $2::bigint IS NULL
              OR transition_turn.result_clinical_memory_version <= $2
            )
          ORDER BY transition.transition_version DESC LIMIT 1
       ) expiry ON true
       LEFT JOIN information_need previous ON previous.id = need.supersedes_information_need_id
      WHERE need.patient_id = $1
        AND ($2::bigint IS NULL OR created_turn.result_clinical_memory_version <= $2)
      ORDER BY need.created_at, need.semantic_need_id`,
    [patientId, atVersion],
  );
  const candidates = await client.query<{
    information_need_id: string;
    candidate_event_semantic_id: string;
    candidate_event_version: number;
  }>(
    `SELECT information_need_id::text,
            candidate_event_semantic_id,
            candidate_event_version
       FROM information_need_event_candidate
       JOIN information_need need ON need.id = information_need_id
       JOIN agent_turn created_turn
         ON created_turn.patient_id = need.patient_id
        AND created_turn.id = need.created_by_agent_turn_id
      WHERE information_need_event_candidate.patient_id = $1
        AND ($2::bigint IS NULL OR created_turn.result_clinical_memory_version <= $2)
      ORDER BY information_need_id, candidate_order`,
    [patientId, atVersion],
  );
  const candidatesByNeed = new Map<string, typeof candidates.rows>();
  for (const candidate of candidates.rows) {
    candidatesByNeed.set(candidate.information_need_id, [
      ...(candidatesByNeed.get(candidate.information_need_id) ?? []),
      candidate,
    ]);
  }
  return rows.rows.map((row) => {
    const candidateHistoricalEvents = (candidatesByNeed.get(row.need_id) ?? []).map(
      ({ candidate_event_semantic_id, candidate_event_version }) => ({
        eventId: candidate_event_semantic_id,
        eventVersion: candidate_event_version,
      }),
    );
    return {
      id: row.semantic_need_id,
      version: row.transition_version,
      originInboundMessageId: row.origin_inbound_id,
      originInboundSequence: asNumber(row.origin_inbound_sequence),
      ...(row.target_event_id === null ? {} : { targetEventId: row.target_event_id }),
      ...(row.target_event_version === null
        ? {}
        : { targetEventVersion: row.target_event_version }),
      field: row.requested_field,
      candidateMedicationIds: row.scope_payload.candidateMedicationIds,
      candidateDoseIds: row.scope_payload.candidateDoseIds,
      candidateSymptomEventIds: row.scope_payload.candidateSymptomEventIds,
      candidateHistoricalEventIds: row.scope_payload.candidateHistoricalEventIds,
      ...(candidateHistoricalEvents.length === 0 ? {} : { candidateHistoricalEvents }),
      ...(row.scope_payload.pendingOperation == null
        ? {}
        : { pendingOperation: row.scope_payload.pendingOperation }),
      questionId: row.question_id,
      clarificationAttemptUsed: row.clarification_attempt_used,
      state: row.to_state,
      priority: row.priority,
      ...(row.supersedes_need_id === null ? {} : { supersedesNeedId: row.supersedes_need_id }),
      ...(row.expired_at_inbound_id === null
        ? {}
        : { expiredAtInboundMessageId: row.expired_at_inbound_id }),
    };
  });
}

export async function loadPatientClinicalMemory(
  client: Queryable,
  patientIdValue: string,
  atVersionValue?: number,
): Promise<PatientClinicalMemory> {
  const patientId = uuidSchema.parse(patientIdValue);
  const atVersion =
    atVersionValue === undefined ? null : z.number().int().nonnegative().parse(atVersionValue);
  const patient = await client.query<{
    clinical_memory_version: number | string;
    routine_clarifications_paused: boolean;
  }>(
    `SELECT clinical_memory_version, routine_clarifications_paused
       FROM patient WHERE id = $1`,
    [patientId],
  );
  const patientRow = patient.rows[0];
  if (patientRow === undefined) throw new Error('patient_not_found');
  const currentVersion = asNumber(patientRow.clinical_memory_version);
  if (atVersion !== null && atVersion > currentVersion)
    throw new Error('clinical_memory_version_missing');
  const events = await loadEvents(client, patientId, atVersion);
  const needs = await loadNeeds(client, patientId, atVersion);
  const reviews = await client.query<{
    semantic_review_item_id: string;
    semantic_unresolved_report_id: string | null;
    item_kind: 'unresolved_report' | 'contradiction' | 'safety' | 'unsupported_language';
    source_inbound_id: string;
    target_event_id: string | null;
    reason: string;
    source_spans: PatientClinicalMemory['unresolvedReports'][number]['sourceSpans'];
    candidate_scope: {
      candidateMedicationIds: string[];
      candidateDoseIds: string[];
      candidateEventIds: string[];
    };
    to_status: 'open' | 'confirmed' | 'rejected';
  }>(
    `SELECT item.semantic_review_item_id,
              item.semantic_unresolved_report_id,
              item.item_kind,
              item.source_inbound_id::text,
              target.semantic_event_id AS target_event_id,
              item.reason,
              item.source_spans,
              item.candidate_scope,
              latest.to_status
         FROM clinical_review_item item
         JOIN agent_turn created_turn
           ON created_turn.patient_id = item.patient_id
          AND created_turn.id = item.created_by_agent_turn_id
         JOIN LATERAL (
           SELECT to_status
             FROM clinical_review_item_transition transition
             JOIN agent_turn transition_turn
               ON transition_turn.patient_id = transition.patient_id
              AND transition_turn.id = transition.agent_turn_id
            WHERE transition.clinical_review_item_id = item.id
              AND (
                $2::bigint IS NULL
                OR transition_turn.result_clinical_memory_version <= $2
              )
            ORDER BY transition_version DESC LIMIT 1
         ) latest ON true
         LEFT JOIN clinical_event target ON target.id = item.target_clinical_event_id
        WHERE item.patient_id = $1
          AND ($2::bigint IS NULL OR created_turn.result_clinical_memory_version <= $2)
        ORDER BY item.created_at, item.semantic_review_item_id`,
    [patientId, atVersion],
  );
  const batches = await client.query<{ receipt: unknown }>(
    `SELECT recent.receipt
       FROM (
         SELECT prepared_result_receipt AS receipt, result_clinical_memory_version, id
           FROM agent_turn
          WHERE patient_id = $1 AND prepared_result_receipt IS NOT NULL
            AND ($3::bigint IS NULL OR result_clinical_memory_version <= $3)
          ORDER BY result_clinical_memory_version DESC, id DESC
          LIMIT $2
       ) recent
      ORDER BY recent.result_clinical_memory_version, recent.id`,
    [patientId, MAX_RECENT_COMMAND_BATCHES, atVersion],
  );
  const processedBatches = batches.rows.map(({ receipt }) =>
    processedCommandBatchSchema.parse(receipt),
  );
  const orderingBatches = await client.query<{ receipt: unknown }>(
    `SELECT prepared_result_receipt AS receipt
       FROM agent_turn
      WHERE patient_id = $1
        AND prepared_result_receipt IS NOT NULL
        AND ($2::bigint IS NULL OR result_clinical_memory_version <= $2)
        AND (
          COALESCE(jsonb_array_length(prepared_result_receipt -> 'eventIds'), 0) > 0
          OR COALESCE(jsonb_array_length(prepared_result_receipt -> 'needIds'), 0) > 0
          OR COALESCE(jsonb_array_length(prepared_result_receipt -> 'unresolvedReportIds'), 0) > 0
          OR COALESCE(jsonb_array_length(prepared_result_receipt -> 'reviewItemIds'), 0) > 0
        )
      ORDER BY result_clinical_memory_version, id
      LIMIT $3`,
    [patientId, atVersion, MAX_ENTITY_ORDERING_RECEIPTS + 1],
  );
  if (orderingBatches.rows.length > MAX_ENTITY_ORDERING_RECEIPTS)
    throw new Error('clinical_memory_order_receipts_exceeded');
  const orderingReceipts = orderingBatches.rows.map(({ receipt }) =>
    processedCommandBatchSchema.parse(receipt),
  );
  const orderedReviewRows = inReducerOrder(
    reviews.rows.map((row) => ({ id: row.semantic_review_item_id, row })),
    orderingReceipts,
    'reviewItemIds',
  ).map(({ row }) => row);
  const unresolvedReports = orderedReviewRows.flatMap((row) =>
    row.semantic_unresolved_report_id === null
      ? []
      : [
          {
            id: row.semantic_unresolved_report_id,
            reason: row.reason,
            sourceMessageId: row.source_inbound_id,
            sourceSpans: row.source_spans,
            ...row.candidate_scope,
          },
        ],
  );
  const reviewItems = orderedReviewRows.map((row) => ({
    id: row.semantic_review_item_id,
    kind: row.item_kind,
    sourceMessageId: row.source_inbound_id,
    ...(row.target_event_id === null ? {} : { targetEventId: row.target_event_id }),
    reason: row.reason,
    status: row.to_status,
  }));
  const openSafetySources = new Set(
    reviewItems
      .filter(({ kind, status }) => kind === 'safety' && status === 'open')
      .map(({ sourceMessageId }) => sourceMessageId),
  );
  return {
    patientId,
    version: atVersion ?? currentVersion,
    events: inReducerOrder(events, orderingReceipts, 'eventIds'),
    needs: inReducerOrder(needs, orderingReceipts, 'needIds'),
    unresolvedReports: inReducerOrder(unresolvedReports, orderingReceipts, 'unresolvedReportIds'),
    reviewItems,
    routineClarificationsPaused:
      atVersion === null
        ? patientRow.routine_clarifications_paused
        : events.some(
            ({ kind, safetyTier, sourceMessageIds }) =>
              kind === 'safety' &&
              safetyTier === 'emergency' &&
              sourceMessageIds.some((id) => openSafetySources.has(id)),
          ),
    processedBatches,
  };
}

type EventOccurrence = {
  readonly occurred_at: Date | null;
  readonly local_date: string | null;
  readonly local_time: string | null;
  readonly patient_timezone: string | null;
};

async function eventOccurrence(
  client: Queryable,
  patientId: string,
  event: ClinicalEvent,
  supersedesId: string | null,
): Promise<EventOccurrence> {
  if (event.kind === 'administration' && event.doseId !== undefined) {
    const dose = await client.query<EventOccurrence>(
      `SELECT dose.scheduled_at AS occurred_at,
              dose.dose_date::text AS local_date,
              dose.local_dose_time AS local_time,
              COALESCE(dose.schedule_timezone, patient.timezone) AS patient_timezone
         FROM dose_schedule AS dose
         JOIN patient ON patient.id = dose.patient_id
        WHERE dose.id = $1 AND dose.patient_id = $2`,
      [uuidSchema.parse(event.doseId), patientId],
    );
    const occurrence = dose.rows[0];
    if (occurrence === undefined) throw new Error('clinical_projection_time_invalid');
    return occurrence;
  }

  if (supersedesId !== null) {
    const predecessor = await client.query<EventOccurrence>(
      `SELECT occurred_at, local_date::text, local_time, patient_timezone
         FROM clinical_event
        WHERE id = $1 AND patient_id = $2`,
      [supersedesId, patientId],
    );
    const occurrence = predecessor.rows[0];
    if (occurrence === undefined) throw new Error('clinical_event_predecessor_missing');
    return occurrence;
  }

  const patient = await client.query<{ timezone: string }>(
    'SELECT timezone FROM patient WHERE id = $1',
    [patientId],
  );
  const patientTimeZone = patient.rows[0]?.timezone;
  if (patientTimeZone === undefined) throw new Error('clinical_projection_patient_missing');
  // W0.7: contradictions fall through to the source-inbound branch below — they
  // are dated by the contradicting message so they land on that day's summary.
  if (
    (event.kind === 'symptom' &&
      event.symptomStatus === 'historical' &&
      event.operation !== 'recur') ||
    (event.kind === 'administration' && event.doseId === undefined)
  ) {
    return {
      occurred_at: null,
      local_date: null,
      local_time: null,
      patient_timezone: patientTimeZone,
    };
  }

  const sourceInboundId = event.sourceSpans.at(-1)?.messageId ?? event.sourceMessageIds.at(-1);
  if (sourceInboundId === undefined) throw new Error('clinical_projection_source_missing');
  const source = await client.query<EventOccurrence>(
    `SELECT inbound.received_at AS occurred_at,
            (inbound.received_at AT TIME ZONE patient.timezone)::date::text AS local_date,
            to_char(inbound.received_at AT TIME ZONE patient.timezone, 'HH24:MI') AS local_time,
            patient.timezone AS patient_timezone
       FROM inbound_reply AS inbound
       JOIN patient ON patient.id = inbound.patient_id
      WHERE inbound.id = $1 AND inbound.patient_id = $2`,
    [uuidSchema.parse(sourceInboundId), patientId],
  );
  const occurrence = source.rows[0];
  if (occurrence === undefined) throw new Error('clinical_projection_source_missing');
  return occurrence;
}

async function persistEvent(
  client: Queryable,
  patientId: string,
  agentTurnId: string,
  event: ClinicalEvent,
): Promise<void> {
  const supersedesId = await physicalId(
    client,
    'clinical_event',
    patientId,
    'semantic_event_id',
    event.supersedesEventId,
  );
  const recurrenceId = await physicalId(
    client,
    'clinical_event',
    patientId,
    'semantic_event_id',
    event.recurrenceOfEventId,
  );
  const contradictionId = await physicalId(
    client,
    'clinical_event',
    patientId,
    'semantic_event_id',
    event.contradictionOfEventId,
  );
  const occurrence = await eventOccurrence(client, patientId, event, supersedesId);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO clinical_event
       (patient_id, agent_turn_id, source_inbound_id, event_type, event_code, statement_text,
        occurred_at, local_date, severity, supersedes_id, normalized_value,
        patient_medication_id, dose_id, local_time, patient_timezone, semantic_event_id,
        semantic_event_version, authored_by, review_state, clinical_operation,
        is_canonical_patient_report, recurrence_of_event_id, contradiction_of_event_id,
        source_spans, clinical_values)
     VALUES ($1, $2, $3, $4, NULL, NULL, $5, $6::date, NULL, $7, NULL,
             $8::uuid, $9::uuid, $10, $11, $12, $13, $14, $15, $16, $17,
             $18, $19, $20::jsonb, $21::jsonb)
     RETURNING id::text`,
    [
      patientId,
      agentTurnId,
      event.sourceSpans.at(-1)?.messageId ?? event.sourceMessageIds.at(-1),
      storedEventType(event.kind),
      occurrence.occurred_at,
      occurrence.local_date,
      supersedesId,
      event.medicationId && uuidSchema.safeParse(event.medicationId).success
        ? event.medicationId
        : null,
      event.doseId && uuidSchema.safeParse(event.doseId).success ? event.doseId : null,
      occurrence.local_time,
      occurrence.patient_timezone,
      event.id,
      event.version,
      event.authoredBy,
      event.reviewState,
      event.operation,
      event.canonical,
      recurrenceId,
      contradictionId,
      JSON.stringify(event.sourceSpans),
      JSON.stringify(eventClinicalValues(event)),
    ],
  );
  const eventId = inserted.rows[0]?.id;
  if (eventId === undefined) throw new Error('clinical_event_insert_failed');
  for (const [sourceOrder, sourceMessageId] of event.sourceMessageIds.entries()) {
    await client.query(
      `INSERT INTO clinical_event_source
         (patient_id, clinical_event_id, source_inbound_id, source_order)
       VALUES ($1, $2, $3, $4)`,
      [patientId, eventId, sourceMessageId, sourceOrder],
    );
  }
}

async function persistNeed(
  client: Queryable,
  patientId: string,
  agentTurnId: string,
  need: InformationNeed,
  prepared: PreparedClinicalTurn,
): Promise<void> {
  const targetEventId = await physicalId(
    client,
    'clinical_event',
    patientId,
    'semantic_event_id',
    need.targetEventId,
  );
  const supersedesNeedId = await physicalId(
    client,
    'information_need',
    patientId,
    'semantic_need_id',
    need.supersedesNeedId,
  );
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO information_need
       (patient_id, semantic_need_id, origin_inbound_id, origin_inbound_sequence,
        target_clinical_event_id, target_event_semantic_id, target_event_version,
        requested_field, question_id, priority, supersedes_information_need_id,
        created_by_agent_turn_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id::text`,
    [
      patientId,
      need.id,
      need.originInboundMessageId,
      need.originInboundSequence,
      targetEventId,
      need.targetEventId ?? null,
      need.targetEventVersion ?? null,
      need.field,
      need.questionId,
      need.priority,
      supersedesNeedId,
      agentTurnId,
    ],
  );
  const needId = inserted.rows[0]?.id;
  if (needId === undefined) throw new Error('information_need_insert_failed');
  for (const [candidateOrder, candidate] of (need.candidateHistoricalEvents ?? []).entries()) {
    const candidateEventId = await physicalId(
      client,
      'clinical_event',
      patientId,
      'semantic_event_id',
      candidate.eventId,
    );
    await client.query(
      `INSERT INTO information_need_event_candidate
         (patient_id, information_need_id, candidate_order, clinical_event_id,
          candidate_event_semantic_id, candidate_event_version)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        patientId,
        needId,
        candidateOrder,
        candidateEventId,
        candidate.eventId,
        candidate.eventVersion,
      ],
    );
  }
  await client.query(
    `INSERT INTO information_need_scope (patient_id, information_need_id, scope_payload)
     VALUES ($1, $2, $3::jsonb)`,
    [
      patientId,
      needId,
      JSON.stringify({
        candidateMedicationIds: need.candidateMedicationIds,
        candidateDoseIds: need.candidateDoseIds,
        candidateSymptomEventIds: need.candidateSymptomEventIds,
        candidateHistoricalEventIds: need.candidateHistoricalEventIds,
        candidateHistoricalEvents: need.candidateHistoricalEvents ?? [],
        pendingOperation: need.pendingOperation ?? null,
      }),
    ],
  );
  const openCommand = prepared.commands.find(
    (command) => command.kind === 'OpenInformationNeed' && command.needId === need.id,
  );
  const states = need.version === 2 && need.state === 'asked' ? ['open', 'asked'] : [need.state];
  for (const [index, state] of states.entries()) {
    const command =
      state === 'open'
        ? openCommand
        : prepared.commands.find(
            (candidate) => candidate.kind === 'AskInformationNeed' && candidate.needId === need.id,
          );
    await client.query(
      `INSERT INTO information_need_transition
         (patient_id, information_need_id, command_semantic_id, source_inbound_id,
          agent_turn_id, transition_version, from_state, to_state,
          clarification_attempt_used)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        patientId,
        needId,
        command?.id ?? `reducer-${need.id}`,
        command?.sourceMessageId ?? prepared.sourceMessageId,
        agentTurnId,
        index + 1,
        index === 0 ? null : states[index - 1],
        state,
        state === 'asked' ? true : need.clarificationAttemptUsed,
      ],
    );
  }
}

async function persistNeedTransition(
  client: Queryable,
  patientId: string,
  agentTurnId: string,
  before: InformationNeed,
  after: InformationNeed,
  prepared: PreparedClinicalTurn,
): Promise<void> {
  const needId = await physicalId(
    client,
    'information_need',
    patientId,
    'semantic_need_id',
    after.id,
  );
  const command = commandForNeed(prepared.commands, after.id);
  const staleQuestionExpiry =
    command?.kind === 'ExpireInformationNeed' && command.staleQuestion === true;
  await client.query(
    `INSERT INTO information_need_transition
       (patient_id, information_need_id, command_semantic_id, source_inbound_id,
        agent_turn_id, transition_version, from_state, to_state,
        clarification_attempt_used, stale_question_expiry)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      patientId,
      needId,
      command?.id ?? `reducer-${after.id}-${after.version}`,
      command?.sourceMessageId ?? prepared.sourceMessageId,
      agentTurnId,
      after.version,
      before.state,
      after.state,
      after.clarificationAttemptUsed,
      staleQuestionExpiry,
    ],
  );
}

async function persistReviewItem(
  client: Queryable,
  patientId: string,
  agentTurnId: string,
  item: PatientClinicalMemory['reviewItems'][number],
  memory: PatientClinicalMemory,
): Promise<void> {
  const unresolved =
    item.kind === 'unresolved_report' || item.kind === 'unsupported_language'
      ? memory.unresolvedReports.find(
          ({ id }) => id === item.id.replace(/^review-/u, 'unresolved-'),
        )
      : undefined;
  if (
    (item.kind === 'unresolved_report' || item.kind === 'unsupported_language') &&
    unresolved === undefined
  )
    throw new Error('clinical_review_unresolved_link_missing');
  const targetEventId = await physicalId(
    client,
    'clinical_event',
    patientId,
    'semantic_event_id',
    item.targetEventId,
  );
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO clinical_review_item
       (patient_id, semantic_review_item_id, semantic_unresolved_report_id, item_kind,
        source_inbound_id, target_clinical_event_id, reason, source_spans,
        candidate_scope, created_by_agent_turn_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)
     RETURNING id::text`,
    [
      patientId,
      item.id,
      unresolved?.id ?? null,
      item.kind,
      item.sourceMessageId,
      targetEventId,
      item.reason,
      JSON.stringify(unresolved?.sourceSpans ?? []),
      JSON.stringify({
        candidateMedicationIds: unresolved?.candidateMedicationIds ?? [],
        candidateDoseIds: unresolved?.candidateDoseIds ?? [],
        candidateEventIds: unresolved?.candidateEventIds ?? [],
      }),
      agentTurnId,
    ],
  );
  const reviewItemId = inserted.rows[0]?.id;
  if (reviewItemId === undefined) throw new Error('clinical_review_item_insert_failed');
  await client.query(
    `INSERT INTO clinical_review_item_transition
       (patient_id, clinical_review_item_id, agent_turn_id, transition_version,
        from_status, to_status)
     VALUES ($1, $2, $3, 1, NULL, $4)`,
    [patientId, reviewItemId, agentTurnId, item.status],
  );
}

async function persistCommittedTurn(
  client: PoolClient,
  patientId: string,
  turnJobId: string,
  before: PatientClinicalMemory,
  committed: CommittedClinicalTurn,
): Promise<void> {
  const { prepared, memory } = committed;
  const receipt = memory.processedBatches.at(-1);
  if (receipt === undefined) throw new Error('prepared_receipt_missing');
  const insertedTurn = await client.query<{ id: string }>(
    `INSERT INTO agent_turn
       (patient_id, inbound_message_id, turn_job_id, model_id, prompt_version,
        schema_version, context_hash, input_tokens, output_tokens, latency_ms,
        final_policy_tier, prepared_command_batch, prepared_command_hash,
        prepared_batch_hash, prepared_command_count, prepared_response_plan,
        prepared_result_receipt, base_clinical_memory_version,
        result_clinical_memory_version, clinical_context_hash, extractor_version,
        resolver_version, reducer_version, renderer_version, failure_class)
     VALUES ($1, $2, $3, 'bounded-extractor', $4, 'clinical-memory-v1', $5,
             0, 0, 0, $6, $7::jsonb, $8, $9, $10, $11::jsonb, $12::jsonb,
             $13, $14, $15, $16, $17, $18, $19, $20)
     RETURNING id::text`,
    [
      patientId,
      prepared.sourceMessageId,
      turnJobId,
      prepared.pipelineVersions.extractor,
      prepared.contextHash,
      responsePolicyTier(prepared),
      JSON.stringify(prepared.commands),
      prepared.commandHash,
      prepared.preparedHash,
      prepared.commands.length,
      JSON.stringify(prepared.responsePlan),
      JSON.stringify(receipt),
      prepared.baseMemoryVersion,
      memory.version,
      prepared.contextHash,
      prepared.pipelineVersions.extractor,
      prepared.pipelineVersions.resolver,
      prepared.pipelineVersions.reducer,
      prepared.pipelineVersions.renderer,
      prepared.runtimeFailure ?? null,
    ],
  );
  const agentTurnId = insertedTurn.rows[0]?.id;
  if (agentTurnId === undefined) throw new Error('agent_turn_insert_failed');

  const beforeEventIds = new Set(before.events.map(({ id }) => id));
  for (const event of memory.events.filter(({ id }) => !beforeEventIds.has(id)))
    await persistEvent(client, patientId, agentTurnId, event);

  // Wave 2: stamp the source inbound with ANSWERED semantics — only when this turn produced
  // a dose-resolved administration event. The reminder claim reads inbound_reply.dose_id as
  // "this reply answered that dose"; stamping any in-window message (e.g. "Hello?") would
  // silently disable the reminder for a dose the patient never addressed. Joins this
  // patient-locked commit transaction so the stamp and the events land atomically.
  const answeredDoseId = memory.events.find(
    (event) =>
      !beforeEventIds.has(event.id) &&
      event.kind === 'administration' &&
      event.doseId !== undefined &&
      uuidSchema.safeParse(event.doseId).success,
  )?.doseId;
  if (answeredDoseId !== undefined) {
    await client.query(
      `UPDATE inbound_reply
          SET dose_id = $3
        WHERE id = $1 AND patient_id = $2 AND dose_id IS NULL`,
      [prepared.sourceMessageId, patientId, answeredDoseId],
    );
  }

  const beforeNeedById = new Map(before.needs.map((need) => [need.id, need]));
  for (const need of memory.needs) {
    const prior = beforeNeedById.get(need.id);
    if (prior === undefined) await persistNeed(client, patientId, agentTurnId, need, prepared);
    else if (prior.version !== need.version)
      await persistNeedTransition(client, patientId, agentTurnId, prior, need, prepared);
  }

  const priorReviewIds = new Set(before.reviewItems.map(({ id }) => id));
  for (const item of memory.reviewItems.filter(({ id }) => !priorReviewIds.has(id)))
    await persistReviewItem(client, patientId, agentTurnId, item, memory);

  await persistCanonicalProjections(client, { patientId, before, memory });

  // A re-ask is response-plan-only (needs stay one-shot): its row must NOT carry
  // asked_information_need_id, or the un-sent-question backstop would mistake it for a first
  // ask and silently return the consumed clarification attempt (asked->open, attempt re-armed).
  const askedNeedId = await physicalId(
    client,
    'information_need',
    patientId,
    'semantic_need_id',
    prepared.responsePlan.question?.reask === true
      ? undefined
      : prepared.responsePlan.question?.needId,
  );
  const kind = responseMessageKind(prepared);
  // Wave 1a record-only turns (newer inbound already waiting): the outbound row is terminal
  // from birth — same terminal status the invoke-time backstop writes — so it can never send
  // and the surviving turn's one reply covers the burst.
  const recordOnly = prepared.recordOnly === true;
  await client.query(
    `INSERT INTO outbound_message
       (patient_id, dose_id, status, body, message_kind, in_reply_to_inbound_id,
        agent_turn_id, language, clarification_topic, temporal_candidates,
        asked_information_need_id, messaging_consent_epoch, status_updated_at,
        suppressed_by_newer_inbound)
     VALUES ($1, NULL, $10, $2, $3, $4, $5, 'en', $6, $7::jsonb, $8, $9,
             CASE WHEN $10 = 'failed' THEN now() END, $11)`,
    [
      patientId,
      prepared.responseText,
      kind,
      prepared.sourceMessageId,
      agentTurnId,
      prepared.responsePlan.question?.field ?? null,
      kind === 'clarification' ? '[]' : null,
      askedNeedId,
      prepared.consentEpoch,
      recordOnly ? 'failed' : 'prepared',
      recordOnly,
    ],
  );
  const recordedFailure = await client.query(
    `UPDATE turn_job
        SET failure_kind = $3
      WHERE id = $1 AND patient_id = $2 AND completed_at IS NULL`,
    [turnJobId, patientId, prepared.runtimeFailure ?? null],
  );
  if (recordedFailure.rowCount !== 1) throw new Error('turn_job_failure_write_conflict');
  const advanced = await client.query(
    `UPDATE patient
        SET clinical_memory_version = $2,
            routine_clarifications_paused = $3
      WHERE id = $1 AND clinical_memory_version = $4`,
    [patientId, memory.version, memory.routineClarificationsPaused, before.version],
  );
  if (advanced.rowCount !== 1) throw new Error('stale_memory_version');
}

/**
 * Wave 1a backstop reconciliation: when an un-sent question turn is terminalized (its reply
 * suppressed by a newer inbound or a consent change), the patient never received the question,
 * so its need must not stay stranded in 'asked'. Appends one asked->open transition (append-only,
 * attached to the asking turn, clarification attempt returned) so the surviving turn can ask it
 * again. Idempotent: a need whose latest transition is not 'asked' is left untouched. Returns
 * true when a need was reopened.
 */
export async function reconcileUnsentAskedNeed(
  pool: Pool,
  input: Pick<ClinicalMemoryOutbound, 'patientId' | 'agentTurnId'>,
): Promise<boolean> {
  const patientId = uuidSchema.parse(input.patientId);
  const agentTurnId = uuidSchema.parse(input.agentTurnId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The patient row lock serializes this reopen against concurrent turn commits.
    const locked = await client.query('SELECT id FROM patient WHERE id = $1 FOR UPDATE', [
      patientId,
    ]);
    if (locked.rowCount !== 1) throw new Error('patient_not_found');
    const reopened = await client.query(
      `INSERT INTO information_need_transition
         (patient_id, information_need_id, command_semantic_id, source_inbound_id,
          agent_turn_id, transition_version, from_state, to_state,
          clarification_attempt_used, stale_question_expiry)
       SELECT latest.patient_id,
              latest.information_need_id,
              'backstop-reopen-' || need.semantic_need_id,
              latest.source_inbound_id,
              latest.agent_turn_id,
              latest.transition_version + 1,
              'asked',
              'open',
              false,
              false
         FROM outbound_message om
         JOIN information_need need ON need.id = om.asked_information_need_id
         JOIN LATERAL (
           SELECT transition.*
             FROM information_need_transition transition
            WHERE transition.information_need_id = need.id
            ORDER BY transition.transition_version DESC LIMIT 1
         ) latest ON latest.to_state = 'asked'
        WHERE om.patient_id = $1
          AND om.agent_turn_id = $2
          AND om.asked_information_need_id IS NOT NULL
          AND om.status = 'failed'
          AND om.sent_at IS NULL`,
      [patientId, agentTurnId],
    );
    await client.query('COMMIT');
    return (reopened.rowCount ?? 0) === 1;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Mirrors schema.sql's outbound_message_composition_check octet_length(...) <= 100000 CHECK. */
const COMPOSITION_MAX_BYTES = 100_000;

/**
 * Exported so the size-ceiling boundary is unit-testable without a database: an oversize
 * provenance blob must fail HERE, before the checkpoint UPDATE, so the caller sees a normal
 * zod validation error instead of a post-commit CHECK-constraint crash from Postgres.
 */
export const composeCheckpointSchema = z
  .object({
    outboundMessageId: uuidSchema,
    patientId: uuidSchema,
    agentTurnId: uuidSchema,
    composedBody: z
      .string()
      .refine((value) => value === value.trim(), 'composed_body_untrimmed')
      .refine((value) => {
        const codePoints = [...value].length;
        return codePoints >= 1 && codePoints <= 320;
      }, 'composed_body_ceiling'),
    composition: z
      .record(z.string(), z.unknown())
      .refine(
        (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= COMPOSITION_MAX_BYTES,
        'composition_size_ceiling',
      ),
  })
  .strict();

export type ComposeCheckpointInput = z.input<typeof composeCheckpointSchema>;

/**
 * Wave 1b compose checkpoint — the guarded one-shot UPDATE. Writes composed_body plus its
 * composition provenance exactly once while the reply is still 'prepared'; the append-only
 * template `body` column is NEVER touched (column-level template-survival invariant).
 * The message_kind guard is a structural layer of the never-composed invariant: 'safety'
 * (emergency/important), 'fallback' (human review), and scheduled kinds can never accept
 * composed text here even if a caller bug reaches this far. Idempotent under replay: any
 * second call, post-claim state, or already-composed row affects 0 rows and reports false.
 */
export async function checkpointComposedOutbound(
  pool: Queryable,
  untrustedInput: ComposeCheckpointInput,
): Promise<boolean> {
  const input = composeCheckpointSchema.parse(untrustedInput);
  const result = await pool.query(
    `UPDATE outbound_message
        SET composed_body = $4, composition = $5::jsonb
      WHERE id = $1 AND patient_id = $2 AND agent_turn_id = $3
        AND status = 'prepared' AND composition IS NULL
        AND message_kind IN ('acknowledgement', 'clarification')`,
    [
      input.outboundMessageId,
      input.patientId,
      input.agentTurnId,
      input.composedBody,
      JSON.stringify(input.composition),
    ],
  );
  return result.rowCount === 1;
}

export async function commitPreparedClinicalTurn(
  pool: Pool,
  untrustedPrepared: PreparedClinicalTurn,
  loadCurrentContextHash: (client: PoolClient) => Promise<string | null>,
): Promise<CommittedClinicalTurn> {
  const prepared = validatePreparedClinicalTurn(untrustedPrepared);
  if (prepared.responsePlan.kind === 'stale_snapshot') throw new Error('stale_prepared_turn');
  if (
    Object.entries(CURRENT_CLINICAL_PIPELINE_VERSIONS).some(
      ([stage, version]) =>
        prepared.pipelineVersions[stage as keyof typeof prepared.pipelineVersions] !== version,
    )
  )
    throw new Error('pipeline_version_changed');
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const locked = await client.query<{
      patient_id: string;
      turn_job_id: string;
      clinical_memory_version: number | string;
      messaging_state_version: number;
      active: boolean;
      agent_enabled: boolean;
      provider_opted_in: boolean;
      job_messaging_state_version: number | null;
      clinical_context_hash: string | null;
      inbound_sequence: number | string;
    }>(
      `SELECT patient.id::text AS patient_id,
              job.id::text AS turn_job_id,
              patient.clinical_memory_version,
              patient.messaging_state_version,
              patient.is_active AS active,
              patient.agent_enabled,
              patient.provider_opted_in,
              job.messaging_state_version AS job_messaging_state_version,
              job.clinical_context_hash,
              reply.inbound_sequence
         FROM inbound_reply reply
         JOIN patient ON patient.id = reply.patient_id
         JOIN turn_job job
           ON job.patient_id = reply.patient_id AND job.inbound_message_id = reply.id
        WHERE reply.id = $1
        FOR UPDATE OF patient`,
      [uuidSchema.parse(prepared.sourceMessageId)],
    );
    const row = locked.rows[0];
    if (row === undefined) throw new Error('clinical_turn_not_found');
    if (row.patient_id !== prepared.patientId) throw new Error('prepared_patient_mismatch');
    await assertLowestUnfinishedConversationJob(client, row.patient_id, row.inbound_sequence);

    const replay = await client.query<{
      prepared_command_hash: string;
      prepared_batch_hash: string;
      prepared_result_receipt: unknown;
      result_clinical_memory_version: number | string;
    }>(
      `SELECT prepared_command_hash, prepared_batch_hash, prepared_result_receipt,
              result_clinical_memory_version
         FROM agent_turn
        WHERE patient_id = $1 AND inbound_message_id = $2`,
      [row.patient_id, prepared.sourceMessageId],
    );
    const existing = replay.rows[0];
    if (existing !== undefined) {
      if (
        existing.prepared_command_hash !== prepared.commandHash ||
        existing.prepared_batch_hash !== prepared.preparedHash
      ) {
        throw new Error('prepared_batch_integrity_error');
      }
      const receipt = processedCommandBatchSchema.parse(existing.prepared_result_receipt);
      if (asNumber(existing.result_clinical_memory_version) !== receipt.resultVersion)
        throw new Error('processed_batch_receipt_invalid');
      const memory = await loadPatientClinicalMemory(client, row.patient_id, receipt.resultVersion);
      const eventIds = new Set(memory.events.map(({ id }) => id));
      const needIds = new Set(memory.needs.map(({ id }) => id));
      const unresolvedReportIds = new Set(memory.unresolvedReports.map(({ id }) => id));
      const reviewItemIds = new Set(memory.reviewItems.map(({ id }) => id));
      if (
        receipt.sourceMessageId !== prepared.sourceMessageId ||
        receipt.commandHash !== prepared.commandHash ||
        receipt.preparedHash !== prepared.preparedHash ||
        receipt.eventIds.some((id) => !eventIds.has(id)) ||
        receipt.needIds.some((id) => !needIds.has(id)) ||
        receipt.unresolvedReportIds.some((id) => !unresolvedReportIds.has(id)) ||
        receipt.reviewItemIds.some((id) => !reviewItemIds.has(id))
      )
        throw new Error('processed_batch_receipt_invalid');
      const committed: CommittedClinicalTurn = {
        memory,
        createdEventIds: receipt.eventIds,
        createdNeedIds: receipt.needIds,
        createdUnresolvedReportIds: receipt.unresolvedReportIds,
        createdReviewItemIds: receipt.reviewItemIds,
        prepared,
      };
      await client.query('COMMIT');
      return committed;
    }

    if (
      row.messaging_state_version !== prepared.consentEpoch ||
      row.job_messaging_state_version !== prepared.consentEpoch ||
      !row.active ||
      !row.agent_enabled ||
      !row.provider_opted_in
    ) {
      throw new Error('messaging_state_changed');
    }
    if (asNumber(row.clinical_memory_version) !== prepared.baseMemoryVersion)
      throw new Error('stale_memory_version');
    if (asNumber(row.inbound_sequence) !== prepared.sourceSequence)
      throw new Error('source_sequence_changed');
    if (row.clinical_context_hash !== prepared.contextHash)
      throw new Error('clinical_context_changed');
    if ((await loadCurrentContextHash(client)) !== prepared.contextHash)
      throw new Error('clinical_context_changed');

    const memory = await loadPatientClinicalMemory(client, row.patient_id);
    const committed = applyPreparedClinicalTurn(memory, prepared);
    await persistCommittedTurn(client, row.patient_id, row.turn_job_id, memory, committed);
    await client.query('COMMIT');
    return committed;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
