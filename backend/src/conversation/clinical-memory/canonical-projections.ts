import { DateTime } from 'luxon';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { buildDailySummary, type DailySummaryBuildInput } from '../daily-summary.js';
import {
  adherenceProjection,
  deriveAdministrationTiming,
  type AdherenceProjection,
  type DerivedAdministrationTiming,
} from './adherence-mapping.js';
import type { ClinicalEvent, PatientClinicalMemory } from './contracts.js';

const uuidSchema = z.string().uuid();
const ADHERENCE_STATES = ['taken', 'delayed', 'skipped', 'stopped', 'question', 'unknown'] as const;
const PRIORITY_RANK = { none: 0, routine: 1, important: 2, emergency: 3 } as const;

/**
 * Lane W (2026-08-17) — the storage projection of the semantic event kind.
 *
 * The semantic layer keeps its own vocabulary ('administration' | 'symptom' | 'safety' |
 * 'contradiction'). `clinical_event.event_type` is the CLINICAL RECORD's vocabulary: the
 * schema.sql base CHECK, the dashboard's strict five-value read contract and daily-summary's
 * structured payload all spell a patient-reported symptom 'patient_statement'. Only that one
 * kind differs, so this is a rename at the storage seam, not a translation table — and it is the
 * only place the two vocabularies are allowed to meet.
 */
export function storedEventType(kind: ClinicalEvent['kind']): string {
  return kind === 'symptom' ? 'patient_statement' : kind;
}

/**
 * Inverse of {@link storedEventType}. The legacy 'symptom' spelling is still accepted — and
 * PERMANENTLY so, since clinical_event is append-only and no backfill can convert those rows — so
 * a row written before this projection loads as the SAME semantic event it was committed as
 * (the data API projects the same rows on read). Replay safety depends on it: a FIFO
 * redrive of an already-committed turn reloads memory first, and a kind that changed under the
 * event would change the clinical context hash and re-persist the event under a new identity.
 */
export function semanticEventKind(
  eventType: ClinicalEvent['kind'] | 'patient_statement',
): ClinicalEvent['kind'] {
  return eventType === 'patient_statement' ? 'symptom' : eventType;
}

type ProjectionInput = {
  readonly patientId: string;
  readonly before: PatientClinicalMemory;
  readonly memory: PatientClinicalMemory;
};

type EventOccurrence = {
  readonly event: ClinicalEvent;
  readonly localDate: string;
  readonly occurredAtUtc: string;
  readonly physicalId: string;
  readonly recordedAt: Date;
  /** W0.4: derived on-window/late timing, set for every current canonical administration with a recorded outcome on an affected summary date. */
  readonly derivedTiming?: DerivedAdministrationTiming;
};

type PersistedEvent = {
  readonly id: string;
  readonly semantic_event_id: string;
  readonly occurred_at: Date | null;
  readonly local_date: string | null;
  readonly local_time: string | null;
  readonly patient_timezone: string | null;
  readonly created_at: Date;
};

type ScheduledDose = {
  readonly id: string;
  readonly patient_medication_id: string | null;
  readonly scheduled_at: Date;
  readonly local_date: string | null;
  readonly local_time: string | null;
  readonly schedule_timezone: string;
};

type ExistingAdherence = {
  readonly id: string;
  readonly dose_id: string;
  readonly inbound_message_id: string | null;
  readonly decided_by: string;
};

type ProjectionTransition = {
  readonly event: ClinicalEvent;
  readonly prior?: ClinicalEvent;
};

type SummaryEvent = DailySummaryBuildInput['events'][number];

/**
 * W0.7: contradictions are non-canonical by contract (they never rewrite the
 * clinical record) but still surface in the clinician's daily summary as
 * routine patient statements, so they participate in summary projections.
 */
function projectsToSummary(event: ClinicalEvent): boolean {
  return event.current && (event.canonical || event.kind === 'contradiction');
}

function projectionTransitions(input: ProjectionInput): readonly ProjectionTransition[] {
  const beforeById = new Map(input.before.events.map((event) => [event.id, event]));
  const memoryById = new Map(input.memory.events.map((event) => [event.id, event]));
  return input.memory.events
    .filter((event) => projectsToSummary(event) && !beforeById.has(event.id))
    .map((event) => {
      const visited = new Set([event.id]);
      let cursor = event;
      while (cursor.supersedesEventId !== undefined) {
        if (visited.has(cursor.supersedesEventId))
          throw new Error('clinical_projection_event_missing');
        visited.add(cursor.supersedesEventId);
        const prior = beforeById.get(cursor.supersedesEventId);
        if (prior !== undefined) {
          if (prior.kind !== event.kind) throw new Error('clinical_projection_event_missing');
          return { event, ...(prior.canonical ? { prior } : {}) };
        }
        const sameBatchPrior = memoryById.get(cursor.supersedesEventId);
        if (sameBatchPrior === undefined || sameBatchPrior.kind !== event.kind)
          throw new Error('clinical_projection_event_missing');
        cursor = sameBatchPrior;
      }
      return { event };
    });
}

function sourceMessageId(event: ClinicalEvent): string {
  const id = event.sourceSpans.at(-1)?.messageId ?? event.sourceMessageIds.at(-1);
  if (id === undefined) throw new Error('clinical_projection_source_missing');
  return uuidSchema.parse(id);
}

/**
 * W0.1: identity/time completeness gate only. The adherence OUTCOME is owned by the
 * shared mapping table (`adherence-mapping.ts`) and the W0.4 derived timing — the
 * event's own `timing` claim is never required to be 'on_time' (the live pipeline
 * can never produce it).
 */
function safeAdministration(event: ClinicalEvent): boolean {
  return (
    event.kind === 'administration' &&
    event.current &&
    event.canonical &&
    event.doseId !== undefined &&
    event.localDate !== undefined &&
    event.localTime !== undefined
  );
}

function administrationTransitions(
  transitions: readonly ProjectionTransition[],
): readonly ProjectionTransition[] {
  return transitions.flatMap(({ event, prior }) => {
    if (event.kind !== 'administration') return [];
    if (prior !== undefined && prior.kind !== 'administration')
      throw new Error('clinical_projection_adherence_conflict');
    return [{ event, ...(prior?.canonical === true ? { prior } : {}) }];
  });
}

async function loadReceivedAt(
  client: PoolClient,
  patientId: string,
  messageIds: readonly string[],
): Promise<ReadonlyMap<string, Date>> {
  if (messageIds.length === 0) return new Map();
  const rows = await client.query<{ id: string; received_at: Date }>(
    `SELECT id::text, received_at
       FROM inbound_reply
      WHERE patient_id = $1 AND id = ANY($2::uuid[])`,
    [patientId, messageIds],
  );
  return new Map(rows.rows.map(({ id, received_at }) => [id, received_at]));
}

function exactPrior(existing: ExistingAdherence | undefined, prior: ClinicalEvent): boolean {
  return (
    existing !== undefined &&
    existing.decided_by === 'classifier' &&
    existing.inbound_message_id === sourceMessageId(prior)
  );
}

async function persistAdherence(
  client: PoolClient,
  patientId: string,
  transitions: readonly ProjectionTransition[],
  derivedTimingByEventId: ReadonlyMap<string, DerivedAdministrationTiming>,
): Promise<void> {
  // W0.3: the pending ("not yet") record is non-canonical (contracts.ts
  // `canonical_administration_incomplete`) and never enters the canonical-filtered
  // transitions, so every administration here carries an adherence outcome.
  if (transitions.length === 0) return;
  if (transitions.some(({ event }) => !safeAdministration(event)))
    throw new Error('clinical_projection_policy_unresolved');
  const projectionFor = (event: ClinicalEvent): AdherenceProjection => {
    const timing = derivedTimingByEventId.get(event.id);
    if (timing === undefined) throw new Error('clinical_projection_time_invalid');
    const projection = adherenceProjection(event.adherence, timing);
    if (projection === null) throw new Error('clinical_projection_policy_unresolved');
    return projection;
  };
  const targetDoseIds = transitions.map(({ event }) => uuidSchema.parse(event.doseId!));
  const priorDoseIds = transitions.flatMap(({ prior }) =>
    prior?.doseId === undefined ? [] : [uuidSchema.parse(prior.doseId)],
  );
  if (new Set(targetDoseIds).size !== targetDoseIds.length)
    throw new Error('clinical_projection_adherence_conflict');
  const affectedDoseIds = [...new Set([...targetDoseIds, ...priorDoseIds])].sort();
  const locked = await client.query<ExistingAdherence>(
    `SELECT id::text, dose_id::text, inbound_message_id::text, decided_by::text
       FROM adherence_record
      WHERE patient_id = $1 AND dose_id = ANY($2::uuid[])
      ORDER BY dose_id
      FOR UPDATE`,
    [patientId, affectedDoseIds],
  );
  const existingByDose = new Map(locked.rows.map((row) => [row.dose_id, row]));
  const priorDoseSet = new Set<string>();
  const moves: {
    readonly event: ClinicalEvent;
    readonly prior: ClinicalEvent;
    readonly predecessor: ExistingAdherence;
  }[] = [];
  for (const { event, prior } of transitions) {
    if (prior === undefined) continue;
    if (prior.doseId === undefined || priorDoseSet.has(prior.doseId))
      throw new Error('clinical_projection_adherence_conflict');
    priorDoseSet.add(prior.doseId);
    const predecessor = existingByDose.get(prior.doseId);
    if (predecessor === undefined || !exactPrior(predecessor, prior))
      throw new Error('clinical_projection_adherence_conflict');
    moves.push({ event, prior, predecessor });
  }
  const movingRowIds = new Set(moves.map(({ predecessor }) => predecessor.id));
  for (const { event, prior } of transitions) {
    const target = existingByDose.get(event.doseId!);
    if (target === undefined || movingRowIds.has(target.id)) continue;
    // W0.5 arbiter: a timeout-decided row on a fresh insert target is superseded
    // below instead of failing the turn; any other occupant is a genuine
    // double-write and stays a loud conflict.
    if (prior === undefined && target.decided_by === 'timeout') continue;
    throw new Error('clinical_projection_adherence_conflict');
  }

  try {
    for (const { prior, predecessor } of [...moves].sort((left, right) =>
      left.predecessor.id.localeCompare(right.predecessor.id),
    )) {
      const staged = await client.query(
        `UPDATE adherence_record
            SET dose_id = NULL
          WHERE id = $1::uuid
            AND patient_id = $2
            AND dose_id = $3::uuid
            AND decided_by = 'classifier'
            AND inbound_message_id = $4::uuid
        RETURNING id`,
        [predecessor.id, patientId, prior.doseId, sourceMessageId(prior)],
      );
      if (staged.rowCount !== 1) throw new Error('clinical_projection_adherence_conflict');
    }

    for (const { event, prior, predecessor } of [...moves].sort((left, right) =>
      left.event.doseId!.localeCompare(right.event.doseId!),
    )) {
      const projection = projectionFor(event);
      const moved = await client.query(
        `UPDATE adherence_record
            SET dose_id = $1,
                inbound_message_id = $2,
                adherence_state = $3,
                reason_code = $4,
                safety_flag = $5,
                decided_by = 'classifier',
                status = $6
          WHERE id = $7::uuid
            AND patient_id = $8
            AND dose_id IS NULL
            AND decided_by = 'classifier'
            AND inbound_message_id = $9::uuid
        RETURNING id`,
        [
          uuidSchema.parse(event.doseId!),
          sourceMessageId(event),
          projection.adherenceState,
          projection.reasonCode,
          projection.safetyFlag,
          projection.status,
          predecessor.id,
          patientId,
          sourceMessageId(prior),
        ],
      );
      if (moved.rowCount !== 1) throw new Error('clinical_projection_adherence_conflict');
    }

    for (const { event } of [...transitions]
      .filter(({ prior }) => prior === undefined)
      .sort((left, right) => left.event.doseId!.localeCompare(right.event.doseId!))) {
      const projection = projectionFor(event);
      const occupant = existingByDose.get(event.doseId!);
      if (occupant !== undefined && occupant.decided_by === 'timeout') {
        // W0.5 late-reply-after-timeout arbiter: the patient's own report
        // supersedes the timeout row (locked above) in place.
        const superseded = await client.query(
          `UPDATE adherence_record
              SET inbound_message_id = $1,
                  adherence_state = $2,
                  reason_code = $3,
                  safety_flag = $4,
                  decided_by = 'classifier',
                  status = $5
            WHERE patient_id = $6
              AND dose_id = $7::uuid
              AND decided_by = 'timeout'
          RETURNING id`,
          [
            sourceMessageId(event),
            projection.adherenceState,
            projection.reasonCode,
            projection.safetyFlag,
            projection.status,
            patientId,
            uuidSchema.parse(event.doseId!),
          ],
        );
        if (superseded.rowCount !== 1) throw new Error('clinical_projection_adherence_conflict');
        continue;
      }
      const inserted = await client.query(
        `INSERT INTO adherence_record
             (patient_id, dose_id, inbound_message_id, adherence_state,
              reason_code, safety_flag, decided_by, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'classifier', $7)
           ON CONFLICT (dose_id) DO NOTHING
           RETURNING id`,
        [
          patientId,
          uuidSchema.parse(event.doseId!),
          sourceMessageId(event),
          projection.adherenceState,
          projection.reasonCode,
          projection.safetyFlag,
          projection.status,
        ],
      );
      if (inserted.rowCount !== 1) throw new Error('clinical_projection_adherence_conflict');
    }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505')
      throw new Error('clinical_projection_adherence_conflict');
    throw error;
  }
}

function eventOccurrence(
  event: ClinicalEvent,
  persisted: PersistedEvent,
  patientTimeZone: string,
  scheduledDoses: ReadonlyMap<string, ScheduledDose>,
): EventOccurrence | null {
  if (event.kind === 'administration') {
    const dose = event.doseId === undefined ? undefined : scheduledDoses.get(event.doseId);
    if (dose !== undefined) {
      if (event.medicationId !== dose.patient_medication_id)
        throw new Error('clinical_projection_adherence_conflict');
      const scheduled = DateTime.fromJSDate(dose.scheduled_at, { zone: 'utc' }).setZone(
        dose.schedule_timezone,
      );
      if (
        event.localDate !== dose.local_date ||
        event.localTime !== dose.local_time ||
        dose.schedule_timezone !== patientTimeZone ||
        !scheduled.isValid ||
        scheduled.toISODate() !== dose.local_date ||
        scheduled.toFormat('HH:mm') !== dose.local_time ||
        persisted.occurred_at?.getTime() !== dose.scheduled_at.getTime() ||
        persisted.local_date !== dose.local_date ||
        persisted.local_time !== dose.local_time ||
        persisted.patient_timezone !== dose.schedule_timezone
      )
        throw new Error('clinical_projection_time_invalid');
    }
  }

  // Historical symptoms are undated by design; contradiction rows persisted
  // before W0.7 carry no occurrence — both stay off the summary instead of
  // failing the turn.
  if (
    (event.kind === 'contradiction' ||
      (event.kind === 'symptom' && event.symptomStatus === 'historical')) &&
    persisted.occurred_at === null &&
    persisted.local_date === null &&
    persisted.local_time === null
  ) {
    if (persisted.patient_timezone === null) throw new Error('clinical_projection_time_invalid');
    return null;
  }
  if (
    persisted.occurred_at === null ||
    persisted.local_date === null ||
    persisted.local_time === null ||
    persisted.patient_timezone === null
  )
    throw new Error('clinical_projection_time_invalid');
  const occurredAt = DateTime.fromJSDate(persisted.occurred_at, { zone: 'utc' }).setZone(
    persisted.patient_timezone,
  );
  if (
    !occurredAt.isValid ||
    occurredAt.toISODate() !== persisted.local_date ||
    occurredAt.toFormat('HH:mm') !== persisted.local_time
  )
    throw new Error('clinical_projection_time_invalid');
  return {
    event,
    localDate: persisted.local_date,
    occurredAtUtc: persisted.occurred_at.toISOString(),
    physicalId: persisted.id,
    recordedAt: persisted.created_at,
  };
}

/**
 * W0.4: the timing anchor is the event that established the current adherence
 * value — the earliest event in the contiguous same-adherence supersession run.
 * A refine/correct that restates the same outcome (duplicate "Yes", a
 * medication/dose correction) inherits its predecessor's anchor so an on-time
 * report is never re-derived late against the correcting message; timing is
 * re-derived only when the adherence value itself transitions.
 */
function timingAnchor(
  event: ClinicalEvent,
  eventsById: ReadonlyMap<string, ClinicalEvent>,
): ClinicalEvent {
  const visited = new Set([event.id]);
  let anchor = event;
  while (anchor.supersedesEventId !== undefined && !visited.has(anchor.supersedesEventId)) {
    const predecessor = eventsById.get(anchor.supersedesEventId);
    if (
      predecessor === undefined ||
      predecessor.kind !== 'administration' ||
      predecessor.adherence !== event.adherence
    )
      break;
    visited.add(predecessor.id);
    anchor = predecessor;
  }
  return anchor;
}

function summaryEvent(occurrence: EventOccurrence): SummaryEvent | null {
  const { event, occurredAtUtc } = occurrence;
  if (event.kind === 'administration') {
    // W0.3: the pending ("not yet") record is non-canonical and filtered out
    // upstream — an administration here always carries an adherence outcome.
    if (!safeAdministration(event)) throw new Error('clinical_projection_policy_unresolved');
    if (occurrence.derivedTiming === undefined) throw new Error('clinical_projection_time_invalid');
    const projection = adherenceProjection(event.adherence, occurrence.derivedTiming);
    if (projection === null) throw new Error('clinical_projection_policy_unresolved');
    return {
      eventId: occurrence.physicalId,
      eventType: 'adherence' as const,
      eventCode: projection.adherenceState,
      occurredAtUtc,
      severity: null,
      priority: 'routine' as const,
    };
  }
  if (event.kind === 'symptom') {
    const severity = /^(?:10|[1-9])$/u.test(event.severity ?? '') ? Number(event.severity) : null;
    // Lane S (2026-08-17): symptomConcept is the normalized clinical term when the extractor
    // mapped one; rawSymptom (required on every canonical symptom event) is the verbatim
    // fallback. onset is likewise a stored clinical_values field, not raw inbound text.
    const symptomName = event.symptomConcept ?? event.rawSymptom;
    return {
      eventId: occurrence.physicalId,
      eventType: 'patient_statement' as const,
      eventCode: 'symptom',
      occurredAtUtc,
      severity,
      priority: 'routine' as const,
      ...(symptomName === undefined ? {} : { symptomName }),
      ...(event.onset === undefined ? {} : { onset: event.onset }),
    };
  }
  if (event.kind === 'safety' && event.safetyTier !== undefined) {
    return {
      eventId: occurrence.physicalId,
      eventType: 'alert' as const,
      eventCode: 'safety',
      occurredAtUtc,
      severity: null,
      priority: event.safetyTier,
    };
  }
  if (event.kind === 'contradiction') {
    // W0.7: a contradiction surfaces as a routine patient statement in the summary;
    // its clinical_event row keeps event_type='contradiction'.
    return {
      eventId: occurrence.physicalId,
      eventType: 'patient_statement' as const,
      eventCode: 'contradiction',
      occurredAtUtc,
      severity: null,
      priority: 'routine' as const,
    };
  }
  throw new Error('clinical_projection_policy_unresolved');
}

function summaryTotals(events: readonly SummaryEvent[]) {
  const adherenceCounts = Object.fromEntries(
    ADHERENCE_STATES.map((state) => [
      state,
      events.filter(
        ({ eventType, eventCode }) =>
          eventType === 'adherence' && eventCode?.split(':', 1)[0] === state,
      ).length,
    ]),
  ) as Record<(typeof ADHERENCE_STATES)[number], number>;
  const highestPriority = events.reduce<keyof typeof PRIORITY_RANK>(
    (highest, event) =>
      PRIORITY_RANK[event.priority] > PRIORITY_RANK[highest] ? event.priority : highest,
    'none',
  );
  return {
    eventCount: events.length,
    symptomCount: events.filter(({ eventCode }) => eventCode === 'symptom').length,
    adherenceCounts,
    highestPriority,
  };
}

async function appendDailySummary(
  client: PoolClient,
  patientId: string,
  localDate: string,
  patientTimeZone: string,
  occurrences: readonly EventOccurrence[],
): Promise<void> {
  const withoutSkipped = (occurrence: EventOccurrence): SummaryEvent[] => {
    const event = summaryEvent(occurrence);
    return event === null ? [] : [event];
  };
  const allEvents = occurrences.flatMap(withoutSkipped);
  const retainedEvents = [...occurrences]
    .sort(
      (left, right) =>
        right.recordedAt.getTime() - left.recordedAt.getTime() ||
        right.physicalId.localeCompare(left.physicalId),
    )
    .slice(0, 100)
    .flatMap(withoutSkipped);
  const summary = buildDailySummary({
    localDate,
    patientTimeZone,
    events: retainedEvents,
    totals: summaryTotals(allEvents),
  });
  const prior = await client.query<{ id: string; version: number; input_hash: string }>(
    `SELECT id::text, version, input_hash
       FROM daily_summary
      WHERE patient_id = $1 AND local_date = $2::date
      ORDER BY version DESC
      LIMIT 1`,
    [patientId, localDate],
  );
  if (prior.rows[0]?.input_hash === summary.inputHash) return;
  await client.query(
    `INSERT INTO daily_summary
       (patient_id, local_date, version, window_start, window_end, input_hash,
        event_count, highest_tier, structured_payload, summary_text, supersedes_id)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
    [
      patientId,
      localDate,
      (prior.rows[0]?.version ?? 0) + 1,
      summary.windowStartUtc,
      summary.windowEndUtc,
      summary.inputHash,
      summary.eventCount,
      summary.highestPriority,
      JSON.stringify(summary.structuredPayload),
      summary.summaryText,
      prior.rows[0]?.id ?? null,
    ],
  );
}

export async function persistCanonicalProjections(
  client: PoolClient,
  input: ProjectionInput,
): Promise<void> {
  const transitions = projectionTransitions(input);
  if (transitions.length === 0) return;
  const changed = transitions.map(({ event }) => event);
  const predecessors = transitions.flatMap(({ prior }) => (prior === undefined ? [] : [prior]));
  const current = input.memory.events.filter(projectsToSummary);
  const relevant = [
    ...new Map([...current, ...predecessors].map((event) => [event.id, event])).values(),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const patient = await client.query<{ timezone: string }>(
    'SELECT timezone FROM patient WHERE id = $1',
    [input.patientId],
  );
  const patientTimeZone = patient.rows[0]?.timezone;
  if (patientTimeZone === undefined) throw new Error('clinical_projection_patient_missing');
  const doseIds = [
    ...new Set(
      changed.flatMap(({ kind, doseId }) =>
        kind === 'administration' && doseId !== undefined ? [uuidSchema.parse(doseId)] : [],
      ),
    ),
  ].sort();
  const scheduledDoses =
    doseIds.length === 0
      ? []
      : (
          await client.query<ScheduledDose>(
            `SELECT id::text,
                    patient_medication_id::text,
                    scheduled_at,
                    dose_date::text AS local_date,
                    local_dose_time AS local_time,
                    COALESCE(schedule_timezone, $3::text) AS schedule_timezone
               FROM dose_schedule
              WHERE patient_id = $1 AND id = ANY($2::uuid[])
              ORDER BY id
              FOR SHARE`,
            [input.patientId, doseIds, patientTimeZone],
          )
        ).rows;
  if (scheduledDoses.length !== doseIds.length) throw new Error('clinical_projection_time_invalid');
  const scheduledDoseById = new Map(scheduledDoses.map((dose) => [dose.id, dose]));
  const physical = await client.query<PersistedEvent>(
    `SELECT ce.id::text, ce.semantic_event_id, ce.occurred_at,
            ce.local_date::text, ce.local_time, ce.patient_timezone, ce.created_at
       FROM clinical_event AS ce
      WHERE ce.patient_id = $1 AND ce.semantic_event_id = ANY($2::varchar[])`,
    [input.patientId, relevant.map(({ id }) => id)],
  );
  const persistedById = new Map(physical.rows.map((row) => [row.semantic_event_id, row]));
  if (persistedById.size !== relevant.length) throw new Error('clinical_projection_event_missing');
  const occurrences = new Map(
    relevant.map((event) => {
      const persisted = persistedById.get(event.id);
      if (persisted === undefined) throw new Error('clinical_projection_event_missing');
      return [
        event.id,
        eventOccurrence(event, persisted, patientTimeZone, scheduledDoseById),
      ] as const;
    }),
  );
  const affectedDates = [
    ...new Set(
      [...changed, ...predecessors].flatMap((event) => {
        if (!occurrences.has(event.id)) throw new Error('clinical_projection_event_missing');
        const occurrence = occurrences.get(event.id);
        return occurrence === null || occurrence === undefined ? [] : [occurrence.localDate];
      }),
    ),
  ].sort();
  const affectedDateSet = new Set(affectedDates);
  const currentOccurrences = current.flatMap((event) => {
    if (!occurrences.has(event.id)) throw new Error('clinical_projection_event_missing');
    const occurrence = occurrences.get(event.id);
    return occurrence === null || occurrence === undefined ? [] : [occurrence];
  });
  // W0.4: timing is derived, never asserted — the anchor message's
  // inbound_reply.received_at vs the dose's scheduled_at (persisted as the
  // administration occurrence) + window + grace. Scope: only the current
  // canonical administrations on the affected summary dates (a superset of the
  // administration transitions being persisted) — never the patient's whole
  // history, so one unresolvable historical source cannot fail unrelated turns.
  const eventsById = new Map(input.memory.events.map((event) => [event.id, event]));
  const timedProjections = currentOccurrences
    .filter(
      ({ event, localDate }) =>
        event.kind === 'administration' &&
        event.adherence !== undefined &&
        affectedDateSet.has(localDate),
    )
    .map((occurrence) => ({ occurrence, anchor: timingAnchor(occurrence.event, eventsById) }));
  const receivedAtByMessageId = await loadReceivedAt(
    client,
    input.patientId,
    [...new Set(timedProjections.map(({ anchor }) => sourceMessageId(anchor)))].sort(),
  );
  // A dose-identity correction keeps the anchor's derived timing: the report is
  // measured against the dose it was originally made for, so the anchor's own
  // dose schedule is loaded when it differs from the corrected target's.
  const anchorDoseIds = [
    ...new Set(
      timedProjections.flatMap(({ occurrence, anchor }) =>
        anchor.doseId !== undefined && anchor.doseId !== occurrence.event.doseId
          ? [uuidSchema.parse(anchor.doseId)]
          : [],
      ),
    ),
  ].sort();
  const anchorScheduledAtByDoseId = new Map<string, Date>(
    anchorDoseIds.length === 0
      ? []
      : (
          await client.query<{ id: string; scheduled_at: Date }>(
            `SELECT id::text, scheduled_at
               FROM dose_schedule
              WHERE patient_id = $1 AND id = ANY($2::uuid[])
              ORDER BY id
              FOR SHARE`,
            [input.patientId, anchorDoseIds],
          )
        ).rows.map(({ id, scheduled_at }) => [id, scheduled_at]),
  );
  const derivedTimingByEventId = new Map<string, DerivedAdministrationTiming>();
  for (const { occurrence, anchor } of timedProjections) {
    const receivedAt = receivedAtByMessageId.get(sourceMessageId(anchor));
    if (receivedAt === undefined) throw new Error('clinical_projection_source_missing');
    const scheduledAt =
      anchor.doseId === undefined || anchor.doseId === occurrence.event.doseId
        ? new Date(occurrence.occurredAtUtc)
        : anchorScheduledAtByDoseId.get(anchor.doseId);
    if (scheduledAt === undefined) throw new Error('clinical_projection_time_invalid');
    derivedTimingByEventId.set(
      occurrence.event.id,
      deriveAdministrationTiming({
        claimedTiming: occurrence.event.timing,
        receivedAt,
        scheduledAt,
      }),
    );
  }
  const summaryOccurrences = currentOccurrences.map((occurrence) => {
    const derivedTiming = derivedTimingByEventId.get(occurrence.event.id);
    return derivedTiming === undefined ? occurrence : { ...occurrence, derivedTiming };
  });
  await persistAdherence(
    client,
    input.patientId,
    administrationTransitions(transitions),
    derivedTimingByEventId,
  );
  for (const localDate of affectedDates) {
    await appendDailySummary(
      client,
      input.patientId,
      localDate,
      patientTimeZone,
      summaryOccurrences.filter((occurrence) => occurrence.localDate === localDate),
    );
  }
}
