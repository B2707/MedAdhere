import {
  ADE_SYNONYM_MAP,
  RESPONSE_WINDOW_MINUTES,
  conversationClarificationTopicSchema,
  conversationTurnInputSchema,
  extractExplicitRecentLocalDates,
  generateScheduledDoseCandidates,
  isStopKeyword,
  resolveTemporalExpression,
  runSafetyPrefilter,
  temporalCandidateSchema,
  type ConversationTurnInput,
} from '@medadhere/shared';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  readCurrentClinicalContext,
  type CurrentClinicalContext,
} from '../clinical-knowledge/repository.js';
import {
  CURRENT_CLINICAL_PIPELINE_VERSIONS,
  type PatientClinicalSnapshot,
} from './clinical-memory/index.js';
import { loadPatientClinicalMemory } from './clinical-memory/repository.js';
import { sha256, uniqueSorted } from './clinical-memory/hash.js';
import {
  boundedExtractionStageRecordSchema,
  RuntimeConflictError,
  type BoundedExtractionStageRecord,
} from './runtime-stage-repository.js';

const MAX_CURRENT_DAY_MESSAGES = 60;
const MAX_RECENT_OBSERVATIONS = 30;
const CLINICAL_SOURCE_AUTHORITIES = [
  'ccdd',
  'ddinter',
  'health_canada',
  'medlineplus',
  'openfda',
] as const;
const SCHEDULED_DOSE_TIMEZONE_MISMATCH =
  'Scheduled dose timezone does not match the patient timezone';
const COMPLETED_CONVERSATIONAL_ANSWER_FROM_SQL = `SELECT 1
  FROM inbound_reply answered
  JOIN turn_job answered_job
    ON answered_job.patient_id = answered.patient_id
   AND answered_job.inbound_message_id = answered.id
   AND answered_job.completed_at IS NOT NULL
  JOIN agent_turn answered_turn
    ON answered_turn.patient_id = answered.patient_id
   AND answered_turn.inbound_message_id = answered.id
   AND answered_turn.failure_class IS NULL
   AND answered_turn.final_policy_tier IN ('routine', 'important')`;
const uuidSchema = z.string().uuid();
const languageSchema = z
  .string()
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
  .max(35);
const boundedVersionSchema = z.string().trim().min(1).max(64);

const loadJobRequestSchema = z
  .object({
    inboundMessageId: uuidSchema,
    requestId: uuidSchema,
    expectedLanguage: languageSchema,
    promptVersion: boundedVersionSchema,
    schemaVersion: boundedVersionSchema,
    includeClinicalSnapshot: z.boolean().default(false),
  })
  .strict();

export class RuntimeContextOverflowError extends Error {
  override readonly name = 'RuntimeContextOverflowError';

  constructor(readonly collection: 'messages' | 'observations') {
    super('Conversation context exceeds its configured bound');
  }
}

class ClinicalContextProvenanceError extends Error {
  override readonly name = 'ClinicalContextProvenanceError';

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Clinical context provenance is invalid', {
      cause,
    });
  }
}

async function inTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

const RECOVERY_SYMPTOM_CONCEPTS = uniqueSorted([
  'nausea',
  'headache',
  'dizziness',
  'tingling',
  ...ADE_SYNONYM_MAP.flatMap(({ pts }) => pts.map((term) => term.toLocaleLowerCase('en-US'))),
]);

/**
 * Operator kill switch for the Wave 1e symptom context battery, mirroring the composer's
 * CLINICAL_COMPOSER_DISABLED idiom. The battery ships ON (owner decision C, 2026-08-17); ANY
 * set value other than an explicit enable spelling turns it OFF, so a misconfigured safety
 * flag can never silently leave the extra patient questions running.
 */
export const CONTEXT_BATTERY_DISABLE_ENV = 'CLINICAL_CONTEXT_BATTERY_DISABLED';
const CONTEXT_BATTERY_ENABLE_SPELLINGS: ReadonlySet<string> = new Set([
  '',
  'false',
  '0',
  'no',
  'off',
]);

function isContextBatteryEnabled(): boolean {
  return CONTEXT_BATTERY_ENABLE_SPELLINGS.has(
    (process.env[CONTEXT_BATTERY_DISABLE_ENV] ?? '').trim().toLowerCase(),
  );
}

function contentVersion(value: unknown): number {
  return Number.parseInt(sha256(value).slice(0, 12), 16) + 1;
}

type CurrentInboundRow = {
  readonly patient_id: string;
  readonly owner_clinician_sub: string;
  readonly timezone: string;
  readonly preferred_language: string;
  readonly raw_body: string;
  readonly received_at: Date | string;
  readonly inbound_sequence: string | number;
  readonly current_local_date: string;
  readonly turn_job_id: string;
  readonly is_active: boolean;
  readonly agent_enabled: boolean;
  readonly provider_opted_in: boolean;
  readonly messaging_state_version: number | null;
  readonly current_messaging_state_version: number;
  readonly interpretation_result: unknown | null;
};

type MessageRow = {
  readonly id: string;
  readonly direction: 'inbound' | 'outbound';
  readonly body: string;
  readonly occurred_at: Date | string;
  readonly language: string;
  readonly inbound_sequence: string | number | null;
};

type ObservationRow = {
  readonly id: string;
  readonly source_message_id: string | null;
  readonly event_code:
    | 'symptom'
    | 'severity'
    | 'frequency'
    | 'duration'
    | 'sleep'
    | 'context'
    | 'medication_taking'
    | 'correction';
  readonly statement_text: string;
  readonly normalized_value: string | null;
  readonly severity: number | null;
  readonly patient_medication_id: string | null;
  readonly dose_id: string | null;
  readonly supersedes_id: string | null;
};

type PendingClarificationRow = {
  readonly body: string;
  readonly clarification_topic: string;
  readonly temporal_candidates: unknown;
  readonly source_message_id: string | null;
};

type ScheduledDoseRow = {
  readonly dose_id: string;
  readonly patient_medication_id: string | null;
  readonly scheduled_at: Date | string;
  readonly local_date: string;
  readonly local_time: string;
  readonly patient_timezone: string;
};

export type LoadedConversationJob = {
  readonly kind: 'ready';
  readonly turnJobId: string;
  readonly messagingStateVersion: number;
  readonly input: ConversationTurnInput;
  readonly boundedCheckpoint?: BoundedExtractionStageRecord;
  readonly clinicalSnapshot?: PatientClinicalSnapshot;
};

export type SuppressedConversationJob = {
  readonly kind: 'suppressed';
  readonly turnJobId: string;
  readonly patientId: string;
  readonly reason: 'inactive_patient' | 'messaging_state_changed';
};

export type ConversationJobLoadResult = LoadedConversationJob | SuppressedConversationJob;

function loadConversationJobOperation(
  request: z.output<typeof loadJobRequestSchema>,
  persistClinicalContextHash: boolean,
): (client: PoolClient) => Promise<ConversationJobLoadResult | null> {
  return async (client) => {
    const current = await client.query<CurrentInboundRow>(
      `SELECT ir.patient_id::text,
              p.owner_clinician_sub,
              p.timezone,
              p.preferred_language,
              ir.raw_body,
              ir.received_at,
              tj.inbound_sequence,
              (ir.received_at AT TIME ZONE p.timezone)::date::text AS current_local_date,
              tj.id::text AS turn_job_id,
              p.is_active,
              p.agent_enabled,
              p.provider_opted_in,
              tj.messaging_state_version,
              p.messaging_state_version AS current_messaging_state_version,
              tj.interpretation_result
         FROM inbound_reply ir
         JOIN patient p ON p.id = ir.patient_id
         JOIN turn_job tj
           ON tj.patient_id = ir.patient_id AND tj.inbound_message_id = ir.id
        WHERE ir.id = $1`,
      [request.inboundMessageId],
    );
    const row = current.rows[0];
    if (row === undefined) return null;
    if (
      row.messaging_state_version === null ||
      row.messaging_state_version !== row.current_messaging_state_version
    ) {
      return {
        kind: 'suppressed',
        turnJobId: row.turn_job_id,
        patientId: row.patient_id,
        reason: 'messaging_state_changed',
      };
    }
    if (!row.is_active || !row.agent_enabled || !row.provider_opted_in) {
      return {
        kind: 'suppressed',
        turnJobId: row.turn_job_id,
        patientId: row.patient_id,
        reason: 'inactive_patient',
      };
    }

    const pending = await client.query<PendingClarificationRow>(
      `SELECT COALESCE(om.composed_body, om.body) AS body,
              om.clarification_topic, om.temporal_candidates,
              COALESCE(
                (
                  SELECT source.id::text
                    FROM clinician_review_draft draft
                    CROSS JOIN LATERAL jsonb_array_elements(draft.patient_statements)
                      WITH ORDINALITY AS statement(value, position)
                    JOIN inbound_reply source
                      ON source.patient_id = draft.patient_id
                     AND source.id::text = statement.value ->> 'sourceMessageId'
                   WHERE draft.patient_id = om.patient_id
                     AND draft.source_agent_turn_id = om.agent_turn_id
                     AND source.id IS DISTINCT FROM om.in_reply_to_inbound_id
                   ORDER BY draft.version DESC, statement.position
                   LIMIT 1
                ),
                om.in_reply_to_inbound_id::text
              ) AS source_message_id
         FROM outbound_message om
        WHERE om.patient_id = $1
          AND om.message_kind = 'clarification'
          AND om.body IS NOT NULL
          AND om.clarification_topic IS NOT NULL
          AND om.temporal_candidates IS NOT NULL
          AND om.status IN ('queued', 'sent', 'delivered', 'sending_unknown')
          AND om.sent_at IS NOT NULL
          AND om.sent_at < $2::timestamptz
          AND NOT EXISTS (
            ${COMPLETED_CONVERSATIONAL_ANSWER_FROM_SQL}
            LEFT JOIN agent_turn prompt_turn
              ON prompt_turn.patient_id = om.patient_id
             AND prompt_turn.id = om.agent_turn_id
            LEFT JOIN inbound_reply prompt_inbound
              ON prompt_inbound.patient_id = prompt_turn.patient_id
             AND prompt_inbound.id = prompt_turn.inbound_message_id
            WHERE answered.patient_id = om.patient_id
              AND (
                (answered.inbound_sequence IS NOT NULL
                 AND prompt_inbound.inbound_sequence IS NOT NULL
                 AND answered.inbound_sequence > prompt_inbound.inbound_sequence
                 AND answered.inbound_sequence < $3::bigint)
                OR
                ((answered.inbound_sequence IS NULL
                  OR prompt_inbound.inbound_sequence IS NULL)
                 AND answered.received_at > om.sent_at
                 AND answered.received_at <= $2::timestamptz)
              )
          )
        ORDER BY om.sent_at DESC, om.id DESC
        LIMIT 1`,
      [row.patient_id, iso(row.received_at), row.inbound_sequence],
    );
    const pendingRow = pending.rows[0];
    // R2 (2026-08-11): the dose of the most recent unanswered check-in — a
    // reply arriving against it binds deterministically without a question.
    const promptedCheckIn = await client.query<{ dose_id: string }>(
      `SELECT om.dose_id::text
         FROM outbound_message om
        WHERE om.patient_id = $1
          AND om.message_kind = 'check_in'
          AND om.dose_id IS NOT NULL
          AND om.status IN ('queued', 'sent', 'delivered', 'sending_unknown')
          AND om.sent_at IS NOT NULL
          AND om.sent_at < $2::timestamptz
          AND $2::timestamptz <=
              om.sent_at + ($4::integer * interval '1 minute')
          AND NOT EXISTS (
            ${COMPLETED_CONVERSATIONAL_ANSWER_FROM_SQL}
            WHERE answered.patient_id = om.patient_id
              AND answered.received_at > om.sent_at
              AND (
                (answered.inbound_sequence IS NOT NULL
                 AND answered.inbound_sequence < $3::bigint)
                OR
                (answered.inbound_sequence IS NULL
                 AND answered.received_at <= $2::timestamptz)
              )
          )
        ORDER BY om.sent_at DESC, om.id DESC
        LIMIT 1`,
      [row.patient_id, iso(row.received_at), row.inbound_sequence, RESPONSE_WINDOW_MINUTES],
    );
    const pendingCandidates =
      pendingRow === undefined
        ? []
        : z.array(temporalCandidateSchema).max(20).parse(pendingRow.temporal_candidates);
    const pendingCandidateIds = pendingCandidates.map(({ candidateId }) => candidateId);
    const explicitRecentLocalDates = extractExplicitRecentLocalDates(
      row.raw_body,
      row.current_local_date,
      row.timezone,
    );
    const pendingLocalDates = Array.from(
      new Set(pendingCandidates.map(({ localDate }) => localDate)),
    );
    const clinicalContextDate =
      explicitRecentLocalDates.length === 1
        ? explicitRecentLocalDates[0]!
        : explicitRecentLocalDates.length === 0 && pendingLocalDates.length === 1
          ? pendingLocalDates[0]!
          : row.current_local_date;

    const scheduledDoses = await client.query<ScheduledDoseRow>(
      `SELECT ds.id::text AS dose_id,
              ds.patient_medication_id::text,
              ds.scheduled_at,
              ds.dose_date::text AS local_date,
              ds.local_dose_time AS local_time,
              COALESCE(ds.schedule_timezone, p.timezone) AS patient_timezone
         FROM dose_schedule ds
         JOIN patient p ON p.id = ds.patient_id
        WHERE ds.patient_id = $1
          AND ds.dose_date IS NOT NULL
          AND ds.scheduled_at <= $2::timestamptz
          AND (
            (cardinality($4::uuid[]) > 0 AND ds.id = ANY($4::uuid[]))
            OR (
              cardinality($4::uuid[]) = 0
              AND (
                ds.dose_date BETWEEN ($3::date - 1) AND $3::date
                OR ds.dose_date = ANY($5::date[])
              )
            )
          )
        ORDER BY ds.scheduled_at, ds.id
        LIMIT 21`,
      [
        row.patient_id,
        iso(row.received_at),
        row.current_local_date,
        pendingCandidateIds,
        explicitRecentLocalDates,
      ],
    );
    const scheduledDoseInputs = scheduledDoses.rows.map((dose) => ({
      doseId: dose.dose_id,
      patientMedicationId: dose.patient_medication_id,
      scheduledAtUtc: iso(dose.scheduled_at),
      localDate: dose.local_date,
      localTime: dose.local_time,
      patientTimeZone: dose.patient_timezone,
    }));
    let temporalProvenanceIssue: PatientClinicalSnapshot['temporalProvenanceIssue'];
    let temporalCandidates: ReturnType<typeof generateScheduledDoseCandidates>;
    try {
      temporalCandidates = generateScheduledDoseCandidates({
        currentUtc: iso(row.received_at),
        currentLocalDate: row.current_local_date,
        patientTimeZone: row.timezone,
        explicitRecentLocalDates,
        pendingCandidateIds,
        expression: resolveTemporalExpression(row.raw_body, iso(row.received_at), row.timezone),
        scheduledDoses: scheduledDoseInputs,
      });
    } catch (error) {
      if (error instanceof Error && error.message === SCHEDULED_DOSE_TIMEZONE_MISMATCH) {
        temporalProvenanceIssue = 'scheduled_dose_timezone_mismatch';
        temporalCandidates = [];
      } else {
        throw new ClinicalContextProvenanceError(error);
      }
    }

    const messages = await client.query<MessageRow>(
      `WITH bounds AS (
         SELECT ($2::date::timestamp AT TIME ZONE $3) AS starts_at,
                (($2::date + 1)::timestamp AT TIME ZONE $3) AS ends_at
       )
       SELECT history.id::text, history.direction, history.body, history.occurred_at,
              history.language, history.inbound_sequence
         FROM (
           SELECT ir.id, 'inbound'::text AS direction, ir.raw_body AS body,
                  ir.received_at AS occurred_at,
                  $4::text AS language,
                  ir.inbound_sequence
             FROM inbound_reply ir
             CROSS JOIN bounds b
             LEFT JOIN agent_turn prior_turn
               ON prior_turn.patient_id = ir.patient_id
              AND prior_turn.inbound_message_id = ir.id
            WHERE ir.patient_id = $1
              AND ir.id <> $5
              AND ir.received_at >= b.starts_at
              AND ir.received_at < b.ends_at
              AND (
                (ir.inbound_sequence IS NOT NULL
                 AND ir.inbound_sequence < $7::bigint)
                OR
                (ir.inbound_sequence IS NULL
                 AND ir.received_at < $6::timestamptz)
              )
           UNION ALL
           -- Wave 1b: the model-visible transcript must be what the patient RECEIVED
           -- (composed_body ?? body) — otherwise the composer quotes wording that was never
           -- sent, the same failure class the delivery-status filter below exists to prevent.
           SELECT om.id, 'outbound'::text AS direction,
                  COALESCE(om.composed_body, om.body) AS body,
                  om.sent_at AS occurred_at,
                  $4::text AS language,
                  NULL::bigint AS inbound_sequence
            FROM outbound_message om, bounds b
           WHERE om.patient_id = $1
              AND om.body IS NOT NULL
              AND om.status IN ('queued', 'sent', 'delivered', 'sending_unknown')
              AND om.sent_at IS NOT NULL
              AND om.sent_at >= b.starts_at
              AND om.sent_at < LEAST(b.ends_at, $6::timestamptz)
         ) history
        -- Sequenced patient messages own FIFO order. Visible outbound and legacy rows stay in
        -- wall-clock order inside the slot after the latest sequenced message visible by then.
        ORDER BY
          COALESCE(
            history.inbound_sequence,
            (
              SELECT max(slot.inbound_sequence)
                FROM inbound_reply slot
               WHERE slot.patient_id = $1
                 AND slot.inbound_sequence IS NOT NULL
                 AND slot.inbound_sequence < $7::bigint
                 AND slot.received_at <= history.occurred_at
            ),
            0
          ),
          history.inbound_sequence IS NULL,
          history.occurred_at,
          history.id
        LIMIT $8`,
      [
        row.patient_id,
        row.current_local_date,
        row.timezone,
        request.expectedLanguage,
        request.inboundMessageId,
        iso(row.received_at),
        row.inbound_sequence,
        MAX_CURRENT_DAY_MESSAGES + 1,
      ],
    );
    if (messages.rows.length > MAX_CURRENT_DAY_MESSAGES) {
      throw new RuntimeContextOverflowError('messages');
    }

    const observations = await client.query<ObservationRow>(
      `SELECT ce.id::text, ce.source_inbound_id::text AS source_message_id,
              ce.event_code, ce.statement_text, ce.normalized_value, ce.severity,
              ce.patient_medication_id::text, ce.dose_id::text, ce.supersedes_id::text
         FROM clinical_event ce
         LEFT JOIN inbound_reply source
           ON source.patient_id = ce.patient_id
          AND source.id = ce.source_inbound_id
        WHERE ce.patient_id = $1
          AND (
            (source.inbound_sequence IS NOT NULL
             AND source.inbound_sequence < $2::bigint)
            OR
            (source.inbound_sequence IS NULL
             AND ce.created_at < $3::timestamptz)
          )
          AND ce.statement_text IS NOT NULL
          AND btrim(ce.statement_text) <> ''
          AND ce.event_code IN
              ('symptom', 'severity', 'frequency', 'duration', 'sleep', 'context',
               'medication_taking', 'correction')
          AND NOT EXISTS (
            SELECT 1
              FROM clinical_event replacement
             WHERE replacement.patient_id = ce.patient_id
               AND replacement.supersedes_id = ce.id
          )
        ORDER BY ce.occurred_at DESC, ce.id DESC
        LIMIT $4`,
      [row.patient_id, row.inbound_sequence, iso(row.received_at), MAX_RECENT_OBSERVATIONS + 1],
    );
    if (observations.rows.length > MAX_RECENT_OBSERVATIONS) {
      throw new RuntimeContextOverflowError('observations');
    }

    const clinical: CurrentClinicalContext = await readCurrentClinicalContext(client, {
      patientId: row.patient_id,
      clinicianSub: row.owner_clinician_sub,
      occurredOn: clinicalContextDate,
      language: request.expectedLanguage,
    });
    const currentMessage = {
      id: request.inboundMessageId,
      direction: 'inbound' as const,
      body: row.raw_body,
      occurredAtUtc: iso(row.received_at),
      language: request.expectedLanguage,
    };
    const input = conversationTurnInputSchema.parse({
      requestId: request.requestId,
      patientId: row.patient_id,
      inboundMessageId: request.inboundMessageId,
      currentMessage,
      locale: {
        expectedLanguage: request.expectedLanguage,
        patientTimeZone: row.timezone,
        currentUtc: iso(row.received_at),
        currentLocalDate: row.current_local_date,
      },
      currentDayMessages: messages.rows.map((message) => ({
        id: message.id,
        direction: message.direction,
        body: message.body,
        occurredAtUtc: iso(message.occurred_at),
        language: message.language,
      })),
      promptedDoseId: promptedCheckIn.rows[0]?.dose_id ?? null,
      pendingClarification: pendingRow?.body ?? null,
      pendingClarificationTopic:
        pendingRow === undefined
          ? null
          : conversationClarificationTopicSchema.parse(pendingRow.clarification_topic),
      pendingClarificationSourceMessageId: pendingRow?.source_message_id ?? null,
      recentObservations: observations.rows.reverse().map((observation) => ({
        kind: observation.event_code,
        statement: observation.statement_text,
        sourceMessageId: observation.source_message_id,
        normalizedValue: observation.normalized_value,
        severity: observation.severity,
        temporalCandidateIds: observation.dose_id === null ? [] : [observation.dose_id],
        patientMedicationIds:
          observation.patient_medication_id === null ? [] : [observation.patient_medication_id],
        evidenceIds: [],
        clinicalEventId: observation.id,
        supersedesClinicalEventId: observation.supersedes_id,
      })),
      activeMedications: clinical.activeMedications,
      clinicalFacts: clinical.clinicalFacts,
      drugInteractions: clinical.drugInteractions,
      temporalCandidates,
      evidence: clinical.evidence.map(({ reference }) => reference),
      promptVersion: request.promptVersion,
      schemaVersion: request.schemaVersion,
    });
    let clinicalSnapshot: PatientClinicalSnapshot | undefined;
    if (request.includeClinicalSnapshot) {
      const memory = await loadPatientClinicalMemory(client, row.patient_id);
      // Wave 1a turn-start recency gate: a newer inbound already stored (the inbound Lambda
      // persists the row + sequence BEFORE enqueueing) flips this turn into record-only mode.
      const newerInbound = await client.query<{ newer_exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM inbound_reply newer
            WHERE newer.patient_id = $1
              AND newer.inbound_sequence IS NOT NULL
              AND newer.inbound_sequence > $2::bigint
         ) AS newer_exists`,
        [row.patient_id, row.inbound_sequence],
      );
      // Wave 1a day boundary: an asked need whose origin inbound is not among today's
      // messages was asked on a prior local day — no question survives overnight.
      const todayInboundIds = new Set(
        messages.rows.filter(({ direction }) => direction === 'inbound').map(({ id }) => id),
      );
      const overnightAskedNeedIds = uniqueSorted(
        memory.needs
          .filter(
            (need) => need.state === 'asked' && !todayInboundIds.has(need.originInboundMessageId),
          )
          .map(({ id }) => id),
      );
      // Wave 1a batch coherence: today's burst-suppressed turns (record-only birth or the
      // invoke-time race backstop — stamped suppressed_by_newer_inbound; consent-stale and
      // provider-failed rows never join) not yet covered by a later SENT conversational reply
      // form the burst the surviving turn aggregates. Reminders/check-ins are not replies and
      // must not count as covering.
      const suppressedBurst = await client.query<{ id: string }>(
        `SELECT suppressed.id::text
           FROM inbound_reply suppressed
           JOIN agent_turn turn_record
             ON turn_record.patient_id = suppressed.patient_id
            AND turn_record.inbound_message_id = suppressed.id
           JOIN outbound_message om
             ON om.patient_id = suppressed.patient_id
            AND om.agent_turn_id = turn_record.id
          WHERE suppressed.patient_id = $1
            AND suppressed.id <> $4
            AND suppressed.received_at >= ($2::date::timestamp AT TIME ZONE $3)
            AND suppressed.received_at < (($2::date + 1)::timestamp AT TIME ZONE $3)
            AND suppressed.inbound_sequence IS NOT NULL
            AND suppressed.inbound_sequence < $5::bigint
            AND om.status = 'failed'
            AND om.sent_at IS NULL
            AND om.suppressed_by_newer_inbound
            AND NOT EXISTS (
              SELECT 1 FROM outbound_message covering
               WHERE covering.patient_id = suppressed.patient_id
                 AND covering.in_reply_to_inbound_id IS NOT NULL
                 AND covering.sent_at IS NOT NULL
                 AND covering.sent_at >= suppressed.received_at
            )
          ORDER BY suppressed.inbound_sequence`,
        [
          row.patient_id,
          row.current_local_date,
          row.timezone,
          request.inboundMessageId,
          row.inbound_sequence,
        ],
      );
      const suppressedBurstInboundMessageIds = suppressedBurst.rows.map(({ id }) => id);
      const medications = input.activeMedications
        .map((medication) => ({
          id: medication.patientMedicationId,
          version: contentVersion(medication),
          names: uniqueSorted([medication.enteredName, ...medication.ingredientNames]),
          aliases: [],
          active: true,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
      const medicationById = new Map(medications.map((medication) => [medication.id, medication]));
      const doseById = new Map<string, PatientClinicalSnapshot['doses'][number]>();
      for (const candidate of [...input.temporalCandidates].sort((left, right) =>
        (left.doseId ?? left.candidateId).localeCompare(right.doseId ?? right.candidateId),
      )) {
        if (
          candidate.doseId === null ||
          candidate.patientMedicationId === null ||
          !medicationById.has(candidate.patientMedicationId) ||
          doseById.has(candidate.doseId)
        ) {
          continue;
        }
        const medication = medicationById.get(candidate.patientMedicationId)!;
        doseById.set(candidate.doseId, {
          id: candidate.doseId,
          version: contentVersion(candidate),
          medicationId: candidate.patientMedicationId,
          label: `${medication.names[0]} ${candidate.localTime}`,
          localDate: candidate.localDate,
          localTime: candidate.localTime,
        });
      }
      const doses = [...doseById.values()];
      const contextHash = sha256({
        inboundMessage: {
          id: request.inboundMessageId,
          sequence: row.inbound_sequence,
          body: row.raw_body,
        },
        consentEpoch: row.messaging_state_version,
        memory,
        medications,
        doses,
        promptedDoseId: input.promptedDoseId,
        patientTimeZone: input.locale.patientTimeZone,
        clinicalFacts: input.clinicalFacts,
        drugInteractions: input.drugInteractions,
        evidence: clinical.evidence,
        pipelineVersions: CURRENT_CLINICAL_PIPELINE_VERSIONS,
        // Wave 1a: hashed so an overnight flip or burst-membership drift between prepare and
        // commit fails closed. newerInboundExists is deliberately NOT hashed — the invoke-time
        // backstop owns post-prepare arrivals.
        overnightAskedNeedIds,
        suppressedBurstInboundMessageIds,
        ...(temporalProvenanceIssue === undefined
          ? {}
          : { temporalProvenanceIssue, scheduledDoseInputs }),
      });
      clinicalSnapshot = {
        memory,
        inboundMessage: {
          id: request.inboundMessageId,
          sequence: z.coerce.number().int().positive().parse(row.inbound_sequence),
          body: row.raw_body,
        },
        consentEpoch: z.number().int().positive().parse(row.messaging_state_version),
        expectedConsentEpoch: z.number().int().positive().parse(row.messaging_state_version),
        expectedMemoryVersion: memory.version,
        medications,
        doses,
        symptomConcepts: RECOVERY_SYMPTOM_CONCEPTS,
        contextBatteryEnabled: isContextBatteryEnabled(),
        ...(input.promptedDoseId !== null && doseById.has(input.promptedDoseId)
          ? { promptedDoseId: input.promptedDoseId }
          : {}),
        ...(isStopKeyword(row.raw_body) ? { exactControl: 'STOP' as const } : {}),
        languageDisposition: input.currentMessage.language
          .toLocaleLowerCase('en-US')
          .startsWith('en')
          ? 'english'
          : 'unsupported',
        emergencyPrefilter: runSafetyPrefilter(row.raw_body, input.locale.expectedLanguage).hit,
        newerInboundExists: newerInbound.rows[0]?.newer_exists === true,
        overnightAskedNeedIds,
        suppressedBurstInboundMessageIds,
        ...(temporalProvenanceIssue === undefined ? {} : { temporalProvenanceIssue }),
        contextHash,
        pipelineVersions: CURRENT_CLINICAL_PIPELINE_VERSIONS,
      };
      if (persistClinicalContextHash) {
        const savedContext = await client.query(
          `UPDATE turn_job
              SET clinical_context_hash = $3
            WHERE id = $1 AND patient_id = $2 AND completed_at IS NULL
              AND messaging_state_version = $4`,
          [row.turn_job_id, row.patient_id, contextHash, row.messaging_state_version],
        );
        if (savedContext.rowCount !== 1) throw new RuntimeConflictError();
      }
    }
    return {
      kind: 'ready',
      turnJobId: row.turn_job_id,
      messagingStateVersion: z.number().int().positive().parse(row.messaging_state_version),
      input,
      ...(row.interpretation_result === null
        ? {}
        : {
            boundedCheckpoint: boundedExtractionStageRecordSchema.parse(row.interpretation_result),
          }),
      ...(clinicalSnapshot === undefined ? {} : { clinicalSnapshot }),
    };
  };
}

/** Builds one repeatable-read snapshot; raw history never crosses the current local-day bound. */
export async function loadConversationJob(
  pool: Pool,
  untrustedRequest: z.input<typeof loadJobRequestSchema>,
): Promise<ConversationJobLoadResult | null> {
  const request = loadJobRequestSchema.parse(untrustedRequest);
  return inTransaction(pool, async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    return loadConversationJobOperation(request, true)(client);
  });
}

/** Recomputes final authority without opening a nested transaction or updating its cached hash. */
export async function loadClinicalContextHashInTransaction(
  client: PoolClient,
  untrustedRequest: z.input<typeof loadJobRequestSchema>,
): Promise<string | null> {
  const request = loadJobRequestSchema.parse({
    ...untrustedRequest,
    includeClinicalSnapshot: true,
  });
  try {
    await client.query(
      `SELECT pg_advisory_xact_lock_shared(hashtext('source-release:' || authority.source_name))
         FROM unnest($1::text[]) AS authority(source_name)
        ORDER BY authority.source_name`,
      [CLINICAL_SOURCE_AUTHORITIES],
    );
    const loaded = await loadConversationJobOperation(request, false)(client);
    return loaded?.kind === 'ready' ? (loaded.clinicalSnapshot?.contextHash ?? null) : null;
  } catch (error) {
    if (error instanceof ClinicalContextProvenanceError) return null;
    throw error;
  }
}

/** Wave 1a race backstop: true when any stored inbound is newer than the given message. */
export async function hasNewerInboundReply(
  pool: Pool,
  inboundMessageIdValue: string,
): Promise<boolean> {
  const inboundMessageId = uuidSchema.parse(inboundMessageIdValue);
  const result = await pool.query<{ newer_exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM inbound_reply current_row
         JOIN inbound_reply newer
           ON newer.patient_id = current_row.patient_id
          AND newer.inbound_sequence IS NOT NULL
          AND current_row.inbound_sequence IS NOT NULL
          AND newer.inbound_sequence > current_row.inbound_sequence
        WHERE current_row.id = $1
     ) AS newer_exists`,
    [inboundMessageId],
  );
  return result.rows[0]?.newer_exists === true;
}

export * from './runtime-stage-repository.js';
export * from './runtime-consent.js';
