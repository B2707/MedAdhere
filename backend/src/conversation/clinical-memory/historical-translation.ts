import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  persistCanonicalProjections,
  semanticEventKind,
  storedEventType,
} from './canonical-projections.js';
import {
  clinicalEventSchema,
  sourceSpanSchema,
  type ClinicalEvent,
  type PatientClinicalMemory,
} from './contracts.js';
import { canonicalJson, sha256 } from './hash.js';
import { loadPatientClinicalMemory } from './repository.js';

const uuidSchema = z.string().uuid();
const symptomStatusSchema = z.enum(['current', 'resolved', 'historical']);
const reviewStateSchema = z.enum(['unreviewed', 'confirmed', 'rejected']);

export type HistoricalTranslationBlockReason =
  | 'missing_patient_source'
  | 'missing_symptom_status'
  | 'invalid_patient_source'
  | 'unsupported_legacy_shape'
  | 'translation_conflict';

export type HistoricalTranslationResult =
  | {
      readonly kind: 'blocked';
      readonly patientId: string;
      readonly blockers: readonly {
        readonly legacyEventId: string;
        readonly reasons: readonly HistoricalTranslationBlockReason[];
      }[];
    }
  | {
      readonly kind: 'translated';
      readonly patientId: string;
      readonly translations: readonly {
        readonly legacyEventId: string;
        readonly semanticEventId: string;
      }[];
    };

type LegacyClinicalEvent = Readonly<{
  id: string;
  source_inbound_id: string | null;
  source_body: string | null;
  event_type: string;
  event_code: string | null;
  supersedes_id: string | null;
  occurred_at: Date | null;
  local_date: string | null;
  local_time: string | null;
  patient_timezone: string | null;
  severity: number | null;
  authored_by: string | null;
  review_state: string | null;
  clinical_operation: string | null;
  is_canonical_patient_report: boolean | null;
  source_spans: unknown;
  clinical_values: Readonly<Record<string, unknown>> | null;
  patient_medication_id: string | null;
  dose_id: string | null;
}>;

type ReadyTranslation = Readonly<{
  legacyEventId: string;
  semanticEventId: string;
  event: ClinicalEvent;
  occurredAt: Date;
  localDate: string;
  localTime: string;
  patientTimeZone: string;
  sourceInboundId: string;
  clinicalValues: Readonly<Record<string, unknown>>;
  patientMedicationId: string | null;
  doseId: string | null;
}>;

export type HistoricalTranslationPlan =
  | Extract<HistoricalTranslationResult, { kind: 'blocked' }>
  | {
      readonly kind: 'ready';
      readonly patientId: string;
      readonly translations: readonly ReadyTranslation[];
    };

type HistoricalTranslationBlocker = Extract<
  HistoricalTranslationResult,
  { kind: 'blocked' }
>['blockers'][number];

function sourceSpans(row: LegacyClinicalEvent): ClinicalEvent['sourceSpans'] | null {
  const parsed = z.array(sourceSpanSchema).min(1).safeParse(row.source_spans);
  if (!parsed.success || row.source_inbound_id === null || row.source_body === null) return null;
  return parsed.data.every(
    ({ messageId, start, end, quote }) =>
      messageId === row.source_inbound_id && row.source_body?.slice(start, end) === quote,
  )
    ? parsed.data
    : null;
}

type PlanningContext = Readonly<{
  semanticIdByLegacyId: ReadonlyMap<string, string>;
  versionByLegacyId: ReadonlyMap<string, number>;
  supersededLegacyIds: ReadonlySet<string>;
}>;

function readyBase(row: LegacyClinicalEvent) {
  const reviewState = reviewStateSchema.safeParse(row.review_state);
  const spans = sourceSpans(row);
  if (
    row.source_inbound_id === null ||
    row.occurred_at === null ||
    row.local_date === null ||
    row.local_time === null ||
    row.patient_timezone === null ||
    row.authored_by !== 'patient' ||
    !reviewState.success ||
    row.is_canonical_patient_report !== true ||
    spans === null
  )
    return null;
  return {
    sourceInboundId: row.source_inbound_id,
    occurredAt: row.occurred_at,
    localDate: row.local_date,
    localTime: row.local_time,
    patientTimeZone: row.patient_timezone,
    reviewState: reviewState.data,
    sourceSpans: spans,
  } as const;
}

function readySymptom(row: LegacyClinicalEvent, context: PlanningContext): ReadyTranslation | null {
  const base = readyBase(row);
  const operation = z.enum(['create', 'correct']).safeParse(row.clinical_operation);
  const rawSymptom = row.clinical_values?.rawSymptom;
  const symptomStatus = symptomStatusSchema.safeParse(row.clinical_values?.symptomStatus);
  const symptomConcept = row.clinical_values?.symptomConcept;
  if (
    base === null ||
    !operation.success ||
    typeof rawSymptom !== 'string' ||
    !symptomStatus.success ||
    (symptomConcept !== null && typeof symptomConcept !== 'string') ||
    (operation.data === 'create' && row.supersedes_id !== null) ||
    (operation.data === 'correct' && row.supersedes_id === null)
  )
    return null;

  const semanticEventId = context.semanticIdByLegacyId.get(row.id);
  const version = context.versionByLegacyId.get(row.id);
  const supersedesEventId =
    row.supersedes_id === null ? undefined : context.semanticIdByLegacyId.get(row.supersedes_id);
  if (
    semanticEventId === undefined ||
    version === undefined ||
    (row.supersedes_id !== null && supersedesEventId === undefined)
  )
    return null;
  const clinicalValues = {
    localDate: base.localDate,
    localTime: base.localTime,
    rawSymptom,
    symptomConcept,
    symptomStatus: symptomStatus.data,
    ...(row.severity === null ? {} : { severity: String(row.severity) }),
  };
  const parsed = clinicalEventSchema.safeParse({
    id: semanticEventId,
    version,
    kind: 'symptom',
    operation: operation.data,
    authoredBy: 'patient',
    reviewState: base.reviewState,
    current: !context.supersededLegacyIds.has(row.id),
    canonical: true,
    sourceMessageIds: [base.sourceInboundId],
    sourceSpans: base.sourceSpans,
    ...(supersedesEventId === undefined ? {} : { supersedesEventId }),
    ...clinicalValues,
  });
  if (!parsed.success) return null;
  return {
    legacyEventId: row.id,
    semanticEventId,
    event: parsed.data,
    occurredAt: base.occurredAt,
    localDate: base.localDate,
    localTime: base.localTime,
    patientTimeZone: base.patientTimeZone,
    sourceInboundId: base.sourceInboundId,
    clinicalValues,
    patientMedicationId: null,
    doseId: null,
  };
}

function readyAdministration(row: LegacyClinicalEvent): ReadyTranslation | null {
  const base = readyBase(row);
  const values = row.clinical_values;
  if (
    base === null ||
    row.event_type !== 'adherence' ||
    row.event_code !== 'taken:none' ||
    row.clinical_operation !== 'create' ||
    row.supersedes_id !== null ||
    row.patient_medication_id === null ||
    row.dose_id === null ||
    values?.medicationId !== row.patient_medication_id ||
    values.doseId !== row.dose_id ||
    values.adherence !== 'taken' ||
    values.timing !== 'on_time' ||
    values.localDate !== base.localDate ||
    values.localTime !== base.localTime
  )
    return null;
  const semanticEventId = `event-${sha256({ kind: 'legacy-clinical-event-v1', legacyEventId: row.id }).slice(0, 24)}`;
  const clinicalValues = {
    medicationId: row.patient_medication_id,
    medicationVersion: values.medicationVersion,
    doseId: row.dose_id,
    doseVersion: values.doseVersion,
    adherence: 'taken' as const,
    timing: 'on_time' as const,
    localDate: base.localDate,
    localTime: base.localTime,
  };
  const parsed = clinicalEventSchema.safeParse({
    id: semanticEventId,
    version: 1,
    kind: 'administration',
    operation: 'create',
    authoredBy: 'patient',
    reviewState: base.reviewState,
    current: true,
    canonical: true,
    sourceMessageIds: [base.sourceInboundId],
    sourceSpans: base.sourceSpans,
    ...clinicalValues,
  });
  if (!parsed.success) return null;
  return {
    legacyEventId: row.id,
    semanticEventId,
    event: parsed.data,
    occurredAt: base.occurredAt,
    localDate: base.localDate,
    localTime: base.localTime,
    patientTimeZone: base.patientTimeZone,
    sourceInboundId: base.sourceInboundId,
    clinicalValues,
    patientMedicationId: row.patient_medication_id,
    doseId: row.dose_id,
  };
}

function planningContext(rows: readonly LegacyClinicalEvent[]): PlanningContext | null {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const semanticIdByLegacyId = new Map(
    rows.map((row) => [
      row.id,
      `event-${sha256({ kind: 'legacy-clinical-event-v1', legacyEventId: row.id }).slice(0, 24)}`,
    ]),
  );
  const successorCount = new Map<string, number>();
  for (const row of rows) {
    if (row.supersedes_id === null) continue;
    if (!byId.has(row.supersedes_id)) return null;
    successorCount.set(row.supersedes_id, (successorCount.get(row.supersedes_id) ?? 0) + 1);
  }
  if ([...successorCount.values()].some((count) => count > 1)) return null;

  const versionByLegacyId = new Map<string, number>();
  const visiting = new Set<string>();
  const versionFor = (id: string): number | null => {
    const existing = versionByLegacyId.get(id);
    if (existing !== undefined) return existing;
    if (visiting.has(id)) return null;
    visiting.add(id);
    const parentId = byId.get(id)?.supersedes_id ?? null;
    const parentVersion = parentId === null ? 0 : versionFor(parentId);
    visiting.delete(id);
    if (parentVersion === null) return null;
    const version = parentVersion + 1;
    versionByLegacyId.set(id, version);
    return version;
  };
  if (rows.some((row) => versionFor(row.id) === null)) return null;
  return {
    semanticIdByLegacyId,
    versionByLegacyId,
    supersededLegacyIds: new Set(successorCount.keys()),
  };
}

export function planLegacyClinicalMemoryTranslation(
  patientId: string,
  rows: readonly LegacyClinicalEvent[],
): HistoricalTranslationPlan {
  const ordered = [...rows].sort((left, right) => left.id.localeCompare(right.id));
  const context = planningContext(ordered);
  const blockers = ordered.flatMap<HistoricalTranslationBlocker>((row) => {
    const symptomLike =
      row.event_type === 'observation' &&
      (row.event_code === 'severity' ||
        row.event_code === 'symptom' ||
        row.event_code === 'correction');
    const required: HistoricalTranslationBlockReason[] = [
      ...(row.source_inbound_id === null ? (['missing_patient_source'] as const) : []),
      ...(symptomLike && typeof row.clinical_values?.symptomStatus !== 'string'
        ? (['missing_symptom_status'] as const)
        : []),
    ];
    if (required.length > 0) return [{ legacyEventId: row.id, reasons: required }];
    if (!symptomLike && row.event_type !== 'adherence') {
      return [{ legacyEventId: row.id, reasons: ['unsupported_legacy_shape'] }];
    }
    if (sourceSpans(row) === null) {
      return [{ legacyEventId: row.id, reasons: ['invalid_patient_source'] }];
    }
    if (context === null) {
      return [{ legacyEventId: row.id, reasons: ['unsupported_legacy_shape'] }];
    }
    const ready = symptomLike ? readySymptom(row, context) : readyAdministration(row);
    return ready === null ? [{ legacyEventId: row.id, reasons: ['unsupported_legacy_shape'] }] : [];
  });
  if (blockers.length > 0) return { kind: 'blocked', patientId, blockers };
  if (context === null) throw new Error('historical_translation_plan_invalid');
  const translations = ordered.map((row) =>
    row.event_type === 'adherence' ? readyAdministration(row)! : readySymptom(row, context)!,
  );
  const translationByLegacyId = new Map(
    translations.map((translation) => [translation.legacyEventId, translation]),
  );
  if (
    ordered.some((row) => {
      if (row.supersedes_id === null) return false;
      const event = translationByLegacyId.get(row.id)?.event;
      const parent = translationByLegacyId.get(row.supersedes_id)?.event;
      return event === undefined || parent === undefined || event.kind !== parent.kind;
    })
  )
    return {
      kind: 'blocked',
      patientId,
      blockers: ordered.map(({ id }) => ({
        legacyEventId: id,
        reasons: ['unsupported_legacy_shape'],
      })),
    };
  return {
    kind: 'ready',
    patientId,
    translations,
  };
}

function translationResult(
  patientId: string,
  translations: readonly ReadyTranslation[],
): Extract<HistoricalTranslationResult, { kind: 'translated' }> {
  return {
    kind: 'translated',
    patientId,
    translations: translations.map(({ legacyEventId, semanticEventId }) => ({
      legacyEventId,
      semanticEventId,
    })),
  };
}

async function exactExistingTranslation(
  client: PoolClient,
  patientId: string,
  before: PatientClinicalMemory,
  translation: ReadyTranslation,
): Promise<'absent' | 'exact' | 'conflict'> {
  const existingEvent = before.events.find(({ id }) => id === translation.semanticEventId);
  if (existingEvent === undefined) return 'absent';
  if (canonicalJson(existingEvent) !== canonicalJson(translation.event)) return 'conflict';
  const physical = await client.query<{
    agent_turn_id: string | null;
    source_inbound_id: string;
    event_type: ClinicalEvent['kind'] | 'patient_statement';
    occurred_at: Date;
    local_date: string;
    local_time: string;
    patient_timezone: string;
    semantic_event_version: number;
    authored_by: string;
    review_state: string;
    clinical_operation: string;
    is_canonical_patient_report: boolean;
    patient_medication_id: string | null;
    dose_id: string | null;
    supersedes_event_id: string | null;
    source_spans: unknown;
    clinical_values: unknown;
  }>(
    `SELECT event.agent_turn_id::text, event.source_inbound_id::text, event.event_type,
            event.occurred_at, event.local_date::text, event.local_time,
            event.patient_timezone, event.semantic_event_version, event.authored_by,
            event.review_state, event.clinical_operation,
            event.is_canonical_patient_report, event.patient_medication_id::text,
            event.dose_id::text, parent.semantic_event_id AS supersedes_event_id,
            event.source_spans, event.clinical_values
       FROM clinical_event AS event
       LEFT JOIN clinical_event AS parent
         ON parent.patient_id = event.patient_id AND parent.id = event.supersedes_id
      WHERE event.patient_id = $1 AND event.semantic_event_id = $2`,
    [patientId, translation.semanticEventId],
  );
  const row = physical.rows[0];
  return row !== undefined &&
    physical.rows.length === 1 &&
    canonicalJson({
      agentTurnId: row.agent_turn_id,
      sourceInboundId: row.source_inbound_id,
      // Compared as the SEMANTIC kind, so an already-translated row matches whether it was
      // stored under the Lane W projection ('patient_statement') or the pre-projection spelling
      // ('symptom') — a re-run must stay an exact, write-free replay across that boundary.
      eventType: semanticEventKind(row.event_type),
      occurredAt: row.occurred_at.toISOString(),
      localDate: row.local_date,
      localTime: row.local_time,
      patientTimeZone: row.patient_timezone,
      semanticEventVersion: row.semantic_event_version,
      authoredBy: row.authored_by,
      reviewState: row.review_state,
      clinicalOperation: row.clinical_operation,
      canonical: row.is_canonical_patient_report,
      patientMedicationId: row.patient_medication_id,
      doseId: row.dose_id,
      supersedesEventId: row.supersedes_event_id,
      sourceSpans: row.source_spans,
      clinicalValues: row.clinical_values,
    }) ===
      canonicalJson({
        agentTurnId: null,
        sourceInboundId: translation.sourceInboundId,
        eventType: translation.event.kind,
        occurredAt: translation.occurredAt.toISOString(),
        localDate: translation.localDate,
        localTime: translation.localTime,
        patientTimeZone: translation.patientTimeZone,
        semanticEventVersion: translation.event.version,
        authoredBy: translation.event.authoredBy,
        reviewState: translation.event.reviewState,
        clinicalOperation: translation.event.operation,
        canonical: translation.event.canonical,
        patientMedicationId: translation.patientMedicationId,
        doseId: translation.doseId,
        supersedesEventId: translation.event.supersedesEventId ?? null,
        sourceSpans: translation.event.sourceSpans,
        clinicalValues: translation.clinicalValues,
      })
    ? 'exact'
    : 'conflict';
}

async function insertTranslation(
  client: PoolClient,
  patientId: string,
  translation: ReadyTranslation,
): Promise<void> {
  const supersedes =
    translation.event.supersedesEventId === undefined
      ? null
      : (
          await client.query<{ id: string }>(
            `SELECT id::text FROM clinical_event
              WHERE patient_id = $1 AND semantic_event_id = $2`,
            [patientId, translation.event.supersedesEventId],
          )
        ).rows[0]?.id;
  if (translation.event.supersedesEventId !== undefined && supersedes === undefined)
    throw new Error('historical_translation_predecessor_missing');
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO clinical_event
       (patient_id, agent_turn_id, source_inbound_id, event_type, event_code,
        statement_text, occurred_at, local_date, severity, supersedes_id,
        normalized_value, patient_medication_id, dose_id, local_time,
        patient_timezone, semantic_event_id, semantic_event_version, authored_by,
        review_state, clinical_operation, is_canonical_patient_report,
        recurrence_of_event_id, contradiction_of_event_id, source_spans, clinical_values)
     VALUES ($1, NULL, $2, $3, NULL, NULL, $4, $5::date, NULL, $6::uuid, NULL,
             $7::uuid, $8::uuid, $9, $10, $11, $12, $13, $14, $15, $16,
             NULL, NULL, $17::jsonb, $18::jsonb)
     RETURNING id::text`,
    [
      patientId,
      translation.sourceInboundId,
      storedEventType(translation.event.kind),
      translation.occurredAt,
      translation.localDate,
      supersedes ?? null,
      translation.patientMedicationId,
      translation.doseId,
      translation.localTime,
      translation.patientTimeZone,
      translation.semanticEventId,
      translation.event.version,
      translation.event.authoredBy,
      translation.event.reviewState,
      translation.event.operation,
      translation.event.canonical,
      JSON.stringify(translation.event.sourceSpans),
      JSON.stringify(translation.clinicalValues),
    ],
  );
  const physicalId = inserted.rows[0]?.id;
  if (physicalId === undefined) throw new Error('historical_translation_insert_failed');
  await client.query(
    `INSERT INTO clinical_event_source
       (patient_id, clinical_event_id, source_inbound_id, source_order)
     VALUES ($1, $2, $3, 0)`,
    [patientId, physicalId, translation.sourceInboundId],
  );
}

export async function translateHistoricalClinicalMemory(
  database: Pick<Pool, 'connect'>,
  patientIdValue: string,
): Promise<HistoricalTranslationResult> {
  const patientId = uuidSchema.parse(patientIdValue);
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const patient = await client.query<{ clinical_memory_version: string | number }>(
      'SELECT clinical_memory_version FROM patient WHERE id = $1 FOR UPDATE',
      [patientId],
    );
    if (patient.rows[0] === undefined) throw new Error('patient_not_found');
    if (Number(patient.rows[0].clinical_memory_version) !== 0)
      throw new Error('historical_translation_requires_empty_memory');

    const legacy = await client.query<LegacyClinicalEvent>(
      `SELECT event.id::text, event.source_inbound_id::text, inbound.raw_body AS source_body,
              event.event_type, event.event_code, event.supersedes_id::text,
              event.occurred_at,
              event.local_date::text, event.local_time, event.patient_timezone,
              event.severity, event.authored_by, event.review_state,
              event.clinical_operation, event.is_canonical_patient_report,
              event.source_spans, event.clinical_values,
              event.patient_medication_id::text, event.dose_id::text
         FROM clinical_event AS event
         LEFT JOIN inbound_reply AS inbound
           ON inbound.patient_id = event.patient_id AND inbound.id = event.source_inbound_id
        WHERE event.patient_id = $1 AND event.semantic_event_id IS NULL
        ORDER BY event.created_at, event.id`,
      [patientId],
    );
    const plan = planLegacyClinicalMemoryTranslation(patientId, legacy.rows);
    if (plan.kind === 'blocked') {
      await client.query('COMMIT');
      return plan;
    }
    if (plan.translations.length === 0) {
      await client.query('COMMIT');
      return translationResult(patientId, []);
    }

    const before = await loadPatientClinicalMemory(client, patientId);
    let existing: ('absent' | 'exact' | 'conflict')[] = [];
    for (const translation of plan.translations) {
      const state = await exactExistingTranslation(client, patientId, before, translation);
      existing = [...existing, state];
    }
    if (existing.every((state) => state === 'exact')) {
      await client.query('COMMIT');
      return translationResult(patientId, plan.translations);
    }
    if (existing.some((state) => state !== 'absent')) {
      await client.query('COMMIT');
      return {
        kind: 'blocked',
        patientId,
        blockers: plan.translations
          .filter((_, index) => existing[index] !== 'exact')
          .map(({ legacyEventId }) => ({
            legacyEventId,
            reasons: ['translation_conflict'] as const,
          })),
      };
    }

    for (const translation of [...plan.translations].sort(
      (left, right) =>
        left.event.version - right.event.version ||
        left.legacyEventId.localeCompare(right.legacyEventId),
    ))
      await insertTranslation(client, patientId, translation);
    const memory = await loadPatientClinicalMemory(client, patientId);
    await persistCanonicalProjections(client, { patientId, before, memory });
    await client.query('COMMIT');
    return translationResult(patientId, plan.translations);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
