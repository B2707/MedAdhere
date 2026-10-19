import {
  activeMedicationContextSchema,
  clinicalFactRevisionInputSchema,
  clinicalFactReferenceSchema,
  conversationDrugInteractionSchema,
  evidenceReferenceSchema,
  interactionCoverageResultSchema,
  medicationRevisionInputSchema,
  type ActiveMedicationContext,
  type ClinicalFactReference,
  type ClinicalFactRevisionInput,
  type ConversationDrugInteraction,
  type EvidenceReference,
  type InteractionCoverageResult,
  type MedicationRevisionInput,
} from '@medadhere/shared';
import type { Client } from 'pg';
import { z } from 'zod';

type SqlClient = Pick<Client, 'query'>;

const lookupInputSchema = z
  .object({
    patientId: z.string().uuid(),
    clinicianSub: z.string().uuid(),
    occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    interactionKind: z.enum(['drug_drug', 'drug_food', 'drug_disease', 'therapeutic_duplication']),
  })
  .strict();

const recordIdentitySchema = z.object({
  patientId: z.string().uuid(),
  clinicianSub: z.string().uuid(),
});

const evidenceLookupInputSchema = recordIdentitySchema
  .extend({
    occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    language: z.string().trim().min(2).max(35),
    limit: z.number().int().min(1).max(20),
  })
  .strict();

const currentContextInputSchema = evidenceLookupInputSchema.omit({ limit: true });

export const CLINICAL_HISTORY_LIMITS = { medications: 100, facts: 200 } as const;

export class ClinicalRecordNotFoundError extends Error {
  constructor() {
    super('Clinical record not found');
    this.name = 'ClinicalRecordNotFoundError';
  }
}

export class ClinicalRecordConflictError extends Error {
  constructor() {
    super('Clinical record revision conflict');
    this.name = 'ClinicalRecordConflictError';
  }
}

export class CurrentClinicalContextOverflowError extends Error {
  constructor(readonly collection: 'medications' | 'ingredients' | 'facts' | 'interactions') {
    super('Current clinical context exceeds its configured bound');
    this.name = 'CurrentClinicalContextOverflowError';
  }
}

async function requireOwnedPatient(
  client: SqlClient,
  patientId: string,
  clinicianSub: string,
  forUpdate = false,
): Promise<void> {
  const owned = await client.query(
    `SELECT 1
       FROM patient
      WHERE id = $1 AND owner_clinician_sub = $2
      ${forUpdate ? 'FOR UPDATE' : 'FOR SHARE'}`,
    [patientId, clinicianSub],
  );
  if (owned.rowCount !== 1) throw new ClinicalRecordNotFoundError();
}

async function requireUnrevisedTarget(
  client: SqlClient,
  table: 'patient_medication' | 'clinical_fact',
  patientId: string,
  supersedesId: string | null,
): Promise<void> {
  if (supersedesId === null) return;
  const target = await client.query(`SELECT id FROM ${table} WHERE patient_id = $1 AND id = $2`, [
    patientId,
    supersedesId,
  ]);
  if (target.rowCount !== 1) throw new ClinicalRecordNotFoundError();
  const child = await client.query(
    `SELECT 1 FROM ${table} WHERE patient_id = $1 AND supersedes_id = $2 LIMIT 1`,
    [patientId, supersedesId],
  );
  if (child.rowCount !== 0) throw new ClinicalRecordConflictError();
}

async function lockAffectedSchedules(
  client: SqlClient,
  patientId: string,
  scheduleIds: readonly string[],
  supersedesId: string | null,
  validFrom: string,
  validTo: string | null,
): Promise<void> {
  if (scheduleIds.length === 0 && supersedesId === null) return;
  const schedules = await client.query<{ id: string; dose_date: string }>(
    `SELECT ds.id,
            COALESCE(ds.dose_date, (ds.scheduled_at AT TIME ZONE p.timezone)::date)::text AS dose_date
       FROM dose_schedule ds
       JOIN patient p ON p.id = ds.patient_id
      WHERE ds.patient_id = $1
        AND (
          ds.id = ANY($2::uuid[])
          OR ($3::uuid IS NOT NULL AND ds.patient_medication_id = $3::uuid)
        )
      FOR UPDATE OF ds`,
    [patientId, scheduleIds, supersedesId],
  );
  const ownedIds = new Set(schedules.rows.map((row) => row.id));
  if (scheduleIds.some((scheduleId) => !ownedIds.has(scheduleId))) {
    throw new ClinicalRecordNotFoundError();
  }
  if (
    schedules.rows.some(
      (row) =>
        ownedIds.has(row.id) &&
        scheduleIds.includes(row.id) &&
        (row.dose_date < validFrom || (validTo !== null && row.dose_date > validTo)),
    )
  ) {
    throw new ClinicalRecordConflictError();
  }
}

interface ReviewedIngredient {
  ingredient_order: number;
  ingredient_name: string;
  ccdd_ingredient_code: string;
  rxcui: string;
}

async function resolveReviewedIngredients(
  client: SqlClient,
  input: MedicationRevisionInput,
): Promise<readonly MedicationRevisionInput['ingredients'][number][]> {
  const identity = input.identity;
  const suppliedCodes = input.ingredients.some(
    (ingredient) => ingredient.ccddIngredientCode !== null || ingredient.rxcui !== null,
  );
  if (identity === null || identity.system === 'local') {
    if (suppliedCodes) throw new ClinicalRecordConflictError();
    return input.ingredients;
  }
  if (identity.system === 'rxnorm') {
    if (suppliedCodes) throw new ClinicalRecordConflictError();
    return input.ingredients;
  }
  const result = await client.query<ReviewedIngredient>(
    `SELECT mib.ingredient_order, mib.ingredient_name, mib.ccdd_ingredient_code, mib.rxcui
       FROM medication_identity_bridge mib
       JOIN source_release sr ON sr.id = mib.source_release_id
      WHERE sr.source_name = 'ccdd'
        AND sr.state = 'active'
        AND sr.is_complete = true
        AND sr.fresh_until > CURRENT_TIMESTAMP
        AND (($1 = 'din' AND mib.din = $2) OR ($1 = 'ccdd' AND mib.ccdd_product_code = $2))
      ORDER BY mib.ingredient_order`,
    [identity.system, identity.code],
  );
  if (result.rows.length === 0) {
    if (suppliedCodes) throw new ClinicalRecordConflictError();
    return input.ingredients;
  }
  if (
    result.rows.length !== input.ingredients.length ||
    result.rows.some((reviewed, index) => {
      const supplied = input.ingredients[index]!;
      return (
        reviewed.ingredient_name.toLocaleLowerCase('en') !==
          supplied.name.toLocaleLowerCase('en') ||
        (supplied.ccddIngredientCode !== null &&
          supplied.ccddIngredientCode !== reviewed.ccdd_ingredient_code) ||
        (supplied.rxcui !== null && supplied.rxcui !== reviewed.rxcui)
      );
    })
  ) {
    throw new ClinicalRecordConflictError();
  }
  return result.rows.map((reviewed, index) => ({
    name: input.ingredients[index]!.name,
    ccddIngredientCode: reviewed.ccdd_ingredient_code,
    rxcui: reviewed.rxcui,
  }));
}

async function inTransaction<T>(client: SqlClient, operation: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await operation();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export async function appendMedicationRevision(
  client: SqlClient,
  request: {
    patientId: string;
    clinicianSub: string;
    input: MedicationRevisionInput;
  },
): Promise<string> {
  const { patientId, clinicianSub } = recordIdentitySchema.parse(request);
  const input = medicationRevisionInputSchema.parse(request.input);
  return inTransaction(client, async () => {
    await requireOwnedPatient(client, patientId, clinicianSub, true);
    await requireUnrevisedTarget(client, 'patient_medication', patientId, input.supersedesId);
    await lockAffectedSchedules(
      client,
      patientId,
      input.scheduleIds,
      input.supersedesId,
      input.validFrom,
      input.validTo,
    );
    const ingredients = await resolveReviewedIngredients(client, input);
    const medication = await client.query<{ id: string }>(
      `INSERT INTO patient_medication
         (patient_id, entered_name, identity_system, identity_code, dose_text, form, route,
          valid_from, valid_to, status, confirmed_by_clinician_sub, confirmed_at, supersedes_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10, $11, now(), $12)
       RETURNING id`,
      [
        patientId,
        input.enteredName,
        input.identity?.system ?? null,
        input.identity?.code ?? null,
        input.doseText,
        input.form,
        input.route,
        input.validFrom,
        input.validTo,
        input.status,
        clinicianSub,
        input.supersedesId,
      ],
    );
    const medicationId = medication.rows[0]!.id;
    for (const [index, ingredient] of ingredients.entries()) {
      await client.query(
        `INSERT INTO patient_medication_ingredient
           (patient_id, patient_medication_id, ingredient_order, ingredient_name,
            ccdd_ingredient_code, rxcui)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          patientId,
          medicationId,
          index + 1,
          ingredient.name,
          ingredient.ccddIngredientCode,
          ingredient.rxcui,
        ],
      );
    }
    await client.query(
      `UPDATE dose_schedule
          SET patient_medication_id = CASE
                WHEN id = ANY($2::uuid[]) THEN $3::uuid
                ELSE NULL
              END
        WHERE patient_id = $1
          AND (
            id = ANY($2::uuid[])
            OR ($4::uuid IS NOT NULL AND patient_medication_id = $4::uuid)
          )`,
      [patientId, input.scheduleIds, medicationId, input.supersedesId],
    );
    return medicationId;
  });
}

export async function appendClinicalFactRevision(
  client: SqlClient,
  request: {
    patientId: string;
    clinicianSub: string;
    input: ClinicalFactRevisionInput;
  },
): Promise<string> {
  const { patientId, clinicianSub } = recordIdentitySchema.parse(request);
  const input = clinicalFactRevisionInputSchema.parse(request.input);
  return inTransaction(client, async () => {
    await requireOwnedPatient(client, patientId, clinicianSub, true);
    await requireUnrevisedTarget(client, 'clinical_fact', patientId, input.supersedesId);
    const fact = await client.query<{ id: string }>(
      `INSERT INTO clinical_fact
         (patient_id, fact_type, fact_code, statement_text, status,
          authored_by_clinician_sub, supersedes_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        patientId,
        input.factType,
        input.factCode,
        input.statementText,
        input.status,
        clinicianSub,
        input.supersedesId,
      ],
    );
    return fact.rows[0]!.id;
  });
}

interface MedicationHistoryRow {
  id: string;
  entered_name: string;
  identity_system: string | null;
  identity_code: string | null;
  dose_text: string | null;
  form: string | null;
  route: string | null;
  valid_from: string;
  valid_to: string | null;
  status: string;
  supersedes_id: string | null;
  ingredients: Array<{
    name: string;
    ccddIngredientCode: string | null;
    rxcui: string | null;
  }>;
}

interface ClinicalFactHistoryRow {
  id: string;
  fact_type: string;
  fact_code: string | null;
  statement_text: string;
  status: string;
  supersedes_id: string | null;
}

export async function listClinicalHistory(
  client: SqlClient,
  patientIdValue: string,
  clinicianSubValue: string,
) {
  const { patientId, clinicianSub } = recordIdentitySchema.parse({
    patientId: patientIdValue,
    clinicianSub: clinicianSubValue,
  });
  const owned = await client.query(
    'SELECT 1 FROM patient WHERE id = $1 AND owner_clinician_sub = $2',
    [patientId, clinicianSub],
  );
  if (owned.rowCount !== 1) return null;

  const medications = await client.query<MedicationHistoryRow>(
    `WITH bounded_medications AS (
       SELECT pm.*
         FROM patient_medication pm
         JOIN patient p ON p.id = pm.patient_id AND p.owner_clinician_sub = $2
        WHERE pm.patient_id = $1
        ORDER BY pm.created_at DESC, pm.id DESC
        LIMIT $3::int
     )
     SELECT pm.id, pm.entered_name, pm.identity_system, pm.identity_code, pm.dose_text,
            pm.form, pm.route, pm.valid_from::text, pm.valid_to::text, pm.status,
            pm.supersedes_id,
            COALESCE(
              ingredient_rows.ingredients,
              '[]'::json
            ) AS ingredients
       FROM bounded_medications pm
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
                  'name', pmi.ingredient_name,
                  'ccddIngredientCode', pmi.ccdd_ingredient_code,
                  'rxcui', pmi.rxcui
                ) ORDER BY pmi.ingredient_order) AS ingredients
           FROM patient_medication_ingredient pmi
          WHERE pmi.patient_id = pm.patient_id
            AND pmi.patient_medication_id = pm.id
       ) ingredient_rows ON true
      ORDER BY pm.created_at, pm.id`,
    [patientId, clinicianSub, CLINICAL_HISTORY_LIMITS.medications],
  );
  const facts = await client.query<ClinicalFactHistoryRow>(
    `WITH bounded_facts AS (
       SELECT cf.*
         FROM clinical_fact cf
         JOIN patient p ON p.id = cf.patient_id AND p.owner_clinician_sub = $2
        WHERE cf.patient_id = $1
        ORDER BY cf.created_at DESC, cf.id DESC
        LIMIT $3::int
     )
     SELECT cf.id, cf.fact_type, cf.fact_code, cf.statement_text, cf.status, cf.supersedes_id
       FROM bounded_facts cf
      ORDER BY cf.created_at, cf.id`,
    [patientId, clinicianSub, CLINICAL_HISTORY_LIMITS.facts],
  );

  return {
    medications: medications.rows.map((row) => ({
      id: row.id,
      enteredName: row.entered_name,
      identity:
        row.identity_system === null || row.identity_code === null
          ? null
          : { system: row.identity_system, code: row.identity_code },
      doseText: row.dose_text,
      form: row.form,
      route: row.route,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      status: row.status,
      supersedesId: row.supersedes_id,
      ingredients: row.ingredients,
    })),
    facts: facts.rows.map((row) => ({
      id: row.id,
      factType: row.fact_type,
      factCode: row.fact_code,
      statementText: row.statement_text,
      status: row.status,
      supersedesId: row.supersedes_id,
    })),
  };
}

interface EvidenceRow {
  id: string;
  source_name: EvidenceReference['source'];
  source_release_id: string;
  release_version: string;
  checksum_sha256: string;
  evidence_code: string;
  evidence_kind: 'label' | 'medlineplus' | 'monograph' | 'adverse_event_index';
  passage: string;
  source_url: string;
  language: string;
  coverage_state: EvidenceReference['coverageState'];
}

function allowedTemplates(row: EvidenceRow): string[] {
  if (row.coverage_state !== 'direct_evidence') return [];
  if (row.source_name === 'medlineplus' && row.evidence_kind === 'medlineplus') {
    return ['medlineplus-summary-v1'];
  }
  if (
    (row.source_name === 'openfda' || row.source_name === 'health_canada') &&
    (row.evidence_kind === 'label' || row.evidence_kind === 'monograph')
  ) {
    return ['direct-label-evidence-v1'];
  }
  return [];
}

/** Retrieve only evidence exactly tagged to owned current records; no fuzzy or external search. */
export async function retrievePatientEvidence(
  client: SqlClient,
  request: z.input<typeof evidenceLookupInputSchema>,
): Promise<Array<{ reference: EvidenceReference; sourceChecksumSha256: string }>> {
  const input = evidenceLookupInputSchema.parse(request);
  await requireOwnedPatient(client, input.patientId, input.clinicianSub);
  const result = await client.query<EvidenceRow>(
    `WITH owned_patient AS (
       SELECT id FROM patient WHERE id = $1 AND owner_clinician_sub = $2
     ), current_medication AS (
       SELECT pm.*
         FROM patient_medication pm
         JOIN owned_patient p ON p.id = pm.patient_id
        WHERE pm.status = 'active'
          AND pm.valid_from <= $3::date
          AND (pm.valid_to IS NULL OR pm.valid_to >= $3::date)
          AND NOT EXISTS (
            SELECT 1 FROM patient_medication newer
             WHERE newer.patient_id = pm.patient_id
               AND newer.supersedes_id = pm.id
               AND newer.valid_from <= $3::date
          )
     ), patient_tags AS (
       SELECT 'rxcui:' || pmi.rxcui AS tag
         FROM current_medication pm
         JOIN patient_medication_ingredient pmi
           ON pmi.patient_id = pm.patient_id AND pmi.patient_medication_id = pm.id
        WHERE pmi.rxcui IS NOT NULL
       UNION
       SELECT 'ccdd:' || lower(pmi.ccdd_ingredient_code)
         FROM current_medication pm
         JOIN patient_medication_ingredient pmi
           ON pmi.patient_id = pm.patient_id AND pmi.patient_medication_id = pm.id
        WHERE pmi.ccdd_ingredient_code IS NOT NULL
       UNION
       SELECT pm.identity_system || ':' || lower(pm.identity_code)
         FROM current_medication pm
        WHERE pm.identity_system IN ('ccdd', 'din')
          AND pm.identity_code IS NOT NULL
          AND EXISTS (
            SELECT 1
              FROM medication_identity_bridge mib
              JOIN source_release bridge_release ON bridge_release.id = mib.source_release_id
             WHERE bridge_release.source_name = 'ccdd'
               AND bridge_release.state = 'active'
               AND bridge_release.is_complete = true
               AND bridge_release.fresh_until > CURRENT_TIMESTAMP
               AND ((pm.identity_system = 'din' AND mib.din = pm.identity_code)
                 OR (pm.identity_system = 'ccdd' AND mib.ccdd_product_code = pm.identity_code))
          )
       UNION
       SELECT cf.fact_type || ':' || lower(cf.fact_code)
         FROM clinical_fact cf
         JOIN owned_patient p ON p.id = cf.patient_id
        WHERE cf.status = 'current' AND cf.fact_code IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM clinical_fact newer
             WHERE newer.patient_id = cf.patient_id AND newer.supersedes_id = cf.id
          )
     )
     SELECT er.id, sr.source_name, sr.id AS source_release_id, sr.release_version,
            sr.checksum_sha256, er.evidence_code, er.evidence_kind, er.passage, er.source_url,
            er.language, er.coverage_state
       FROM evidence_record er
       JOIN source_release sr ON sr.id = er.source_release_id
      WHERE sr.state = 'active' AND sr.is_complete = true
        AND sr.fresh_until > CURRENT_TIMESTAMP
        AND sr.source_name IN ('ccdd', 'ddinter', 'openfda', 'health_canada', 'medlineplus')
        AND er.language = $4
        AND EXISTS (SELECT 1 FROM patient_tags pt WHERE pt.tag = ANY(er.tags))
      ORDER BY CASE er.coverage_state
                 WHEN 'direct_evidence' THEN 0
                 WHEN 'candidate_only' THEN 1
                 ELSE 2
               END,
               er.evidence_code, er.id
      LIMIT $5`,
    [input.patientId, input.clinicianSub, input.occurredOn, input.language, input.limit],
  );
  return result.rows.map((row) => ({
    reference: evidenceReferenceSchema.parse({
      evidenceId: row.id,
      source: row.source_name,
      sourceReleaseId: row.source_release_id,
      sourceVersion: row.release_version,
      title: row.evidence_code,
      passage: row.passage,
      url: row.source_url,
      language: row.language,
      coverageState: row.coverage_state,
      allowedTemplateIds: allowedTemplates(row),
    }),
    sourceChecksumSha256: row.checksum_sha256,
  }));
}

const MAX_CONTEXT_MEDICATIONS = 20;
const MAX_CONTEXT_INGREDIENTS_PER_MEDICATION = 10;
const MAX_CONTEXT_FACTS = 50;
const MAX_CONTEXT_EVIDENCE = 20;
const MAX_CONTEXT_INTERACTIONS = 20;

type CurrentMedicationRow = {
  id: string;
  entered_name: string;
  ingredient_names: string[];
  ingredient_count: number;
  dose_text: string | null;
  form: string | null;
  route: string | null;
  valid_from: string;
  valid_to: string | null;
};

type CurrentFactRow = {
  id: string;
  fact_type: 'condition' | 'allergy' | 'note';
  statement_text: string;
  created_at: Date | string;
};

type InteractionDisplayNameRow = {
  source_release_id: string;
  ddinter_drug_id: string;
  display_name: string;
};

export type CurrentClinicalContext = {
  readonly activeMedications: readonly ActiveMedicationContext[];
  readonly clinicalFacts: readonly ClinicalFactReference[];
  readonly drugInteractions: readonly ConversationDrugInteraction[];
  readonly evidence: ReadonlyArray<{
    readonly reference: EvidenceReference;
    readonly sourceChecksumSha256: string;
  }>;
};

async function readConversationDrugInteractions(
  client: SqlClient,
  request: z.infer<typeof currentContextInputSchema>,
  medications: readonly CurrentMedicationRow[],
): Promise<readonly ConversationDrugInteraction[]> {
  const hasInteractionCandidates =
    medications.length > 1 ||
    medications.reduce((count, medication) => count + medication.ingredient_count, 0) > 1;
  if (!hasInteractionCandidates) return [];

  const coverage = await retrievePatientDrugInteractions(client, {
    patientId: request.patientId,
    clinicianSub: request.clinicianSub,
    occurredOn: request.occurredOn,
    interactionKind: 'drug_drug',
  });
  const visible = coverage.filter((result) => result.state !== 'checked_no_interaction_record');
  if (visible.length > MAX_CONTEXT_INTERACTIONS) {
    throw new CurrentClinicalContextOverflowError('interactions');
  }

  const found = visible.filter(
    (result): result is Extract<InteractionCoverageResult, { state: 'interaction_found' }> =>
      result.state === 'interaction_found',
  );
  const releaseIds = found.flatMap(({ release }) => [release.id, release.id]);
  const drugIds = found.flatMap(({ pair }) => [pair.lowDrugId, pair.highDrugId]);
  const names =
    found.length === 0
      ? []
      : (
          await client.query<InteractionDisplayNameRow>(
            `SELECT d.source_release_id::text, d.ddinter_drug_id, d.display_name
               FROM ddinter_drug d
               JOIN unnest($1::uuid[], $2::text[])
                 AS wanted(source_release_id, ddinter_drug_id)
                 ON wanted.source_release_id = d.source_release_id
                AND wanted.ddinter_drug_id = d.ddinter_drug_id`,
            [releaseIds, drugIds],
          )
        ).rows;
  const namesByReleaseAndDrug = new Map(
    names.map((row) => [`${row.source_release_id}\u0000${row.ddinter_drug_id}`, row.display_name]),
  );

  return visible.map((result) => {
    if (result.state === 'coverage_unknown') {
      return conversationDrugInteractionSchema.parse({
        state: 'coverage_unknown',
        source: 'ddinter',
        displayNames: [],
        reason: result.reason,
        release: result.release,
      });
    }
    const lowName = namesByReleaseAndDrug.get(`${result.release.id}\u0000${result.pair.lowDrugId}`);
    const highName = namesByReleaseAndDrug.get(
      `${result.release.id}\u0000${result.pair.highDrugId}`,
    );
    if (lowName === undefined || highName === undefined) {
      throw new ClinicalRecordConflictError();
    }
    return conversationDrugInteractionSchema.parse({
      state: 'interaction_found',
      source: 'ddinter',
      displayNames: [lowName, highName],
      pair: result.pair,
      level: result.level,
      release: result.release,
    });
  });
}

/** One bounded, owner-scoped snapshot used by the conversational runtime. */
export async function readCurrentClinicalContext(
  client: SqlClient,
  untrustedRequest: z.input<typeof currentContextInputSchema>,
): Promise<CurrentClinicalContext> {
  const request = currentContextInputSchema.parse(untrustedRequest);
  await requireOwnedPatient(client, request.patientId, request.clinicianSub);
  const medications = await client.query<CurrentMedicationRow>(
    `SELECT pm.id::text, pm.entered_name, pm.dose_text, pm.form, pm.route,
            pm.valid_from::text, pm.valid_to::text,
            COALESCE(ingredients.names, ARRAY[]::text[]) AS ingredient_names,
            COALESCE(ingredients.ingredient_count, 0)::int AS ingredient_count
       FROM patient_medication pm
       JOIN patient p ON p.id = pm.patient_id AND p.owner_clinician_sub = $2
       LEFT JOIN LATERAL (
         SELECT array_agg(selected.ingredient_name ORDER BY selected.ingredient_order) AS names,
                count(*)::int AS ingredient_count
           FROM (
             SELECT pmi.ingredient_name, pmi.ingredient_order
               FROM patient_medication_ingredient pmi
              WHERE pmi.patient_id = pm.patient_id
                AND pmi.patient_medication_id = pm.id
              ORDER BY pmi.ingredient_order
              LIMIT $4
           ) selected
       ) ingredients ON true
      WHERE pm.patient_id = $1
        AND pm.status = 'active'
        AND pm.valid_from <= $3::date
        AND (pm.valid_to IS NULL OR pm.valid_to >= $3::date)
        AND NOT EXISTS (
          SELECT 1 FROM patient_medication newer
           WHERE newer.patient_id = pm.patient_id
             AND newer.supersedes_id = pm.id
             AND newer.valid_from <= $3::date
        )
      ORDER BY pm.created_at, pm.id
      LIMIT $5`,
    [
      request.patientId,
      request.clinicianSub,
      request.occurredOn,
      MAX_CONTEXT_INGREDIENTS_PER_MEDICATION + 1,
      MAX_CONTEXT_MEDICATIONS + 1,
    ],
  );
  if (medications.rows.length > MAX_CONTEXT_MEDICATIONS) {
    throw new CurrentClinicalContextOverflowError('medications');
  }
  if (
    medications.rows.some(
      ({ ingredient_count }) => ingredient_count > MAX_CONTEXT_INGREDIENTS_PER_MEDICATION,
    )
  ) {
    throw new CurrentClinicalContextOverflowError('ingredients');
  }

  const facts = await client.query<CurrentFactRow>(
    `SELECT cf.id::text, cf.fact_type, cf.statement_text, cf.created_at
       FROM clinical_fact cf
       JOIN patient p ON p.id = cf.patient_id AND p.owner_clinician_sub = $2
      WHERE cf.patient_id = $1
        AND cf.status = 'current'
        AND NOT EXISTS (
          SELECT 1 FROM clinical_fact newer
           WHERE newer.patient_id = cf.patient_id AND newer.supersedes_id = cf.id
        )
      ORDER BY cf.created_at, cf.id
      LIMIT $3`,
    [request.patientId, request.clinicianSub, MAX_CONTEXT_FACTS + 1],
  );
  if (facts.rows.length > MAX_CONTEXT_FACTS) {
    throw new CurrentClinicalContextOverflowError('facts');
  }

  const drugInteractions = await readConversationDrugInteractions(
    client,
    request,
    medications.rows,
  );
  const evidence = await retrievePatientEvidence(client, {
    ...request,
    limit: MAX_CONTEXT_EVIDENCE,
  });
  return {
    activeMedications: medications.rows.map((medication) =>
      activeMedicationContextSchema.parse({
        patientMedicationId: medication.id,
        enteredName: medication.entered_name,
        ingredientNames: medication.ingredient_names,
        dose: medication.dose_text,
        form: medication.form,
        route: medication.route,
        effectiveFrom: medication.valid_from,
        effectiveTo: medication.valid_to,
      }),
    ),
    clinicalFacts: facts.rows.map((fact) =>
      clinicalFactReferenceSchema.parse({
        factId: fact.id,
        kind: fact.fact_type,
        statement: fact.statement_text,
        confirmedAtUtc: new Date(fact.created_at).toISOString(),
      }),
    ),
    drugInteractions,
    evidence,
  };
}

interface ReleaseRow {
  id: string;
  release_version: string;
  checksum_sha256: string;
  state: 'active' | 'superseded' | 'withdrawn';
  is_complete: boolean;
  is_fresh: boolean;
}

interface IngredientIdentityRow {
  rxcui: string | null;
  ccdd_ingredient_code: string | null;
}

interface MappingRow {
  identity_system: 'rxnorm' | 'ccdd';
  identity_code: string;
  mapping_status: 'mapped' | 'ambiguous' | 'unmapped';
  ddinter_drug_id: string | null;
}

function unknownResult(
  input: z.infer<typeof lookupInputSchema>,
  reason: Extract<InteractionCoverageResult, { state: 'coverage_unknown' }>['reason'],
  release: Extract<InteractionCoverageResult, { state: 'coverage_unknown' }>['release'] = null,
): InteractionCoverageResult {
  return interactionCoverageResultSchema.parse({
    state: 'coverage_unknown',
    interactionKind: input.interactionKind,
    reason,
    pair: null,
    release,
  });
}

export async function retrievePatientDrugInteractions(
  client: SqlClient,
  request: z.input<typeof lookupInputSchema>,
): Promise<InteractionCoverageResult[]> {
  const input = lookupInputSchema.parse(request);
  await requireOwnedPatient(client, input.patientId, input.clinicianSub);
  if (input.interactionKind !== 'drug_drug') {
    return [unknownResult(input, 'interaction_kind_unavailable')];
  }

  const activeRelease = await client.query<ReleaseRow>(
    `SELECT id, release_version, checksum_sha256, state, is_complete,
            fresh_until > CURRENT_TIMESTAMP AS is_fresh
       FROM source_release
      WHERE source_name = 'ddinter'
      ORDER BY created_at DESC
      LIMIT 1`,
  );
  const releaseRow = activeRelease.rows[0];
  if (!releaseRow) return [unknownResult(input, 'no_active_complete_release')];
  const release = {
    id: releaseRow.id,
    version: releaseRow.release_version,
    checksumSha256: releaseRow.checksum_sha256,
  };
  if (releaseRow.state === 'withdrawn') {
    return [unknownResult(input, 'withdrawn_release', release)];
  }
  if (releaseRow.state !== 'active') {
    return [unknownResult(input, 'no_active_complete_release')];
  }
  if (!releaseRow.is_complete) {
    return [unknownResult(input, 'incomplete_release', release)];
  }
  if (!releaseRow.is_fresh) {
    return [unknownResult(input, 'stale_release', release)];
  }

  const ingredientRows = await client.query<IngredientIdentityRow>(
    `SELECT pmi.rxcui, pmi.ccdd_ingredient_code
       FROM patient_medication pm
       JOIN patient p ON p.id = pm.patient_id AND p.owner_clinician_sub = $2
       JOIN patient_medication_ingredient pmi
         ON pmi.patient_id = pm.patient_id AND pmi.patient_medication_id = pm.id
      WHERE pm.patient_id = $1
        AND pm.status = 'active'
        AND pm.valid_from <= $3::date
        AND (pm.valid_to IS NULL OR pm.valid_to >= $3::date)
        AND NOT EXISTS (
          SELECT 1 FROM patient_medication newer
           WHERE newer.patient_id = pm.patient_id
             AND newer.supersedes_id = pm.id
             AND newer.valid_from <= $3::date
        )
      ORDER BY pm.created_at, pmi.ingredient_order`,
    [input.patientId, input.clinicianSub, input.occurredOn],
  );
  const identities = Array.from(
    new Map(
      ingredientRows.rows
        .map((row) =>
          row.rxcui
            ? { system: 'rxnorm' as const, code: row.rxcui }
            : row.ccdd_ingredient_code
              ? { system: 'ccdd' as const, code: row.ccdd_ingredient_code }
              : null,
        )
        .filter((identity) => identity !== null)
        .map((identity) => [`${identity.system}:${identity.code}`, identity]),
    ).values(),
  );
  const identityMissing = ingredientRows.rows.some(
    (row) => row.rxcui === null && row.ccdd_ingredient_code === null,
  );
  const mappingRows = await client.query<MappingRow>(
    `SELECT m.identity_system, m.identity_code, m.mapping_status, m.ddinter_drug_id
       FROM ingredient_ddinter_map m
       JOIN unnest($2::text[], $3::text[]) AS wanted(identity_system, identity_code)
         ON wanted.identity_system = m.identity_system
        AND wanted.identity_code = m.identity_code
      WHERE m.source_release_id = $1`,
    [
      release.id,
      identities.map((identity) => identity.system),
      identities.map((identity) => identity.code),
    ],
  );
  const mappingByIdentity = Object.fromEntries(
    mappingRows.rows.map((row) => [`${row.identity_system}:${row.identity_code}`, row]),
  );
  const mappings = identities.map((identity) => ({
    identity,
    mapping: mappingByIdentity[`${identity.system}:${identity.code}`] ?? null,
  }));
  const unknowns: InteractionCoverageResult[] = [
    ...(identityMissing ? [unknownResult(input, 'unmapped_ingredient', release)] : []),
    ...mappings.flatMap(({ mapping }) => {
      if (mapping === null) return [unknownResult(input, 'missing_mapping', release)];
      if (mapping.mapping_status === 'ambiguous') {
        return [unknownResult(input, 'ambiguous_mapping', release)];
      }
      if (mapping.mapping_status === 'unmapped') {
        return [unknownResult(input, 'unmapped_ingredient', release)];
      }
      return [];
    }),
  ];
  const drugIds = Array.from(
    new Set(
      mappings.flatMap(({ mapping }) =>
        mapping?.mapping_status === 'mapped' && mapping.ddinter_drug_id
          ? [mapping.ddinter_drug_id]
          : [],
      ),
    ),
  ).sort();
  if (drugIds.length < 2) {
    return unknowns.length > 0
      ? unknowns
      : [unknownResult(input, 'insufficient_distinct_ingredients', release)];
  }

  const pairs = drugIds.flatMap((lowDrugId, index) =>
    drugIds.slice(index + 1).map((highDrugId) => ({ lowDrugId, highDrugId })),
  );
  const interactionRows = await client.query<{
    low_ddinter_drug_id: string;
    high_ddinter_drug_id: string;
    interaction_level: string;
  }>(
    `SELECT low_ddinter_drug_id, high_ddinter_drug_id, interaction_level
       FROM medication_interaction
      WHERE source_release_id = $1
        AND low_ddinter_drug_id = ANY($2::text[])
        AND high_ddinter_drug_id = ANY($2::text[])`,
    [release.id, drugIds],
  );
  const interactionByPair = Object.fromEntries(
    interactionRows.rows.map((row) => [
      `${row.low_ddinter_drug_id}\u0000${row.high_ddinter_drug_id}`,
      row.interaction_level,
    ]),
  );
  const pairResults = pairs.map((pair) => {
    const level = interactionByPair[`${pair.lowDrugId}\u0000${pair.highDrugId}`];
    return interactionCoverageResultSchema.parse(
      level
        ? {
            state: 'interaction_found',
            interactionKind: 'drug_drug',
            pair,
            release,
            level,
          }
        : {
            state: 'checked_no_interaction_record',
            interactionKind: 'drug_drug',
            pair,
            release,
          },
    );
  });
  return [...unknowns, ...pairResults];
}
