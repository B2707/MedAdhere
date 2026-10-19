import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  CLINICAL_HISTORY_LIMITS,
  ClinicalRecordConflictError,
  ClinicalRecordNotFoundError,
  appendClinicalFactRevision,
  appendMedicationRevision,
  listClinicalHistory,
  readCurrentClinicalContext,
  retrievePatientEvidence,
  retrievePatientDrugInteractions,
} from './repository.js';

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema-init', 'schema.sql'), 'utf8');
const CONTAINER_TIMEOUT_MS = 180_000;
const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let container: StartedPostgreSqlContainer | undefined;
let client: Client;
let connectionString: string;
let phoneCounter = 0;

async function applySchema(): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(SCHEMA_SQL);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function seedPatient(owner = OWNER_A): Promise<string> {
  phoneCounter += 1;
  const result = await client.query<{ id: string }>(
    `INSERT INTO patient (phone, medication_name, owner_clinician_sub)
     VALUES ($1, 'legacy medication', $2)
     RETURNING id`,
    [`+1500888${String(phoneCounter).padStart(4, '0')}`, owner],
  );
  return result.rows[0]!.id;
}

async function seedSchedules(
  patientId: string,
  count: number,
  firstDate = '2026-08-11',
): Promise<readonly string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO dose_schedule (patient_id, scheduled_at, local_dose_time, dose_date)
       VALUES ($1, $3::date::timestamp + interval '14 hours' + ($2::int * INTERVAL '1 day'), '09:00',
               $3::date + $2::int)
       RETURNING id`,
      [patientId, index, firstDate],
    );
    ids.push(inserted.rows[0]!.id);
  }
  return ids;
}

function combinationMedication(
  supersedesId: string | null = null,
  scheduleIds: readonly string[] = [],
) {
  return {
    enteredName: 'Amoxicillin / clavulanate',
    identity: { system: 'din' as const, code: '02415322' },
    doseText: '875 mg / 125 mg',
    form: 'tablet',
    route: 'oral',
    validFrom: '2026-08-11',
    validTo: null,
    status: 'active' as const,
    supersedesId,
    scheduleIds: [...scheduleIds],
    ingredients: [
      { name: 'amoxicillin', ccddIngredientCode: 'TM-AMOX', rxcui: '723' },
      { name: 'clavulanate', ccddIngredientCode: 'TM-CLAV', rxcui: '21212' },
    ],
  };
}

beforeAll(async () => {
  const ciUrl = process.env.TEST_DATABASE_URL;
  if (ciUrl) {
    connectionString = ciUrl;
    client = new Client({ connectionString });
    await client.connect();
  } else {
    container = await new PostgreSqlContainer('postgres:16').start();
    connectionString = container.getConnectionUri();
    client = new Client({ connectionString });
    await client.connect();
  }
  await applySchema();
  const release = await client.query<{ id: string }>(
    `INSERT INTO source_release
       (source_name, release_version, checksum_sha256, source_url, licence_id,
        state, is_complete, retrieved_at, fresh_until, activated_at)
     VALUES ('ccdd', 'test-identity-bridge', $1, 'https://example.invalid/ccdd',
             'OGL-Canada-2.0', 'active', true, now(), now() + interval '30 days', now())
     RETURNING id`,
    ['d'.repeat(64)],
  );
  await client.query(
    `INSERT INTO medication_identity_bridge
       (source_release_id, din, ccdd_product_code, ingredient_order,
        ingredient_name, ccdd_ingredient_code, rxcui, reviewed_by, reviewed_at)
     VALUES
       ($1, '02415322', '02415322', 1, 'amoxicillin', 'TM-AMOX', '723', 'reviewer', now()),
       ($1, '02415322', '02415322', 2, 'clavulanate', 'TM-CLAV', '21212', 'reviewer', now()),
       ($1, '00011289', 'WARFARIN-DIN', 1, 'warfarin', 'TM-WARF', '11289', 'reviewer', now())`,
    [release.rows[0]!.id],
  );
}, CONTAINER_TIMEOUT_MS);

async function expectPatientRevisionLock(
  patientId: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  const blocker = new Client({ connectionString });
  await blocker.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM patient WHERE id = $1 FOR SHARE', [patientId]);
    await client.query("SET lock_timeout = '100ms'");
    await expect(operation()).rejects.toMatchObject({ code: '55P03' });
  } finally {
    await client.query('RESET lock_timeout');
    await blocker.query('ROLLBACK').catch(() => undefined);
    await blocker.end();
  }
}

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

describe('doctor-owned append-only clinical records', () => {
  it('stores every combination-product ingredient in stable order', async () => {
    const patientId = await seedPatient();
    const medicationId = await appendMedicationRevision(client, {
      patientId,
      clinicianSub: OWNER_A,
      input: {
        ...combinationMedication(),
        ingredients: [
          { name: 'amoxicillin', ccddIngredientCode: null, rxcui: null },
          { name: 'clavulanate', ccddIngredientCode: null, rxcui: null },
        ],
      },
    });

    const rows = await client.query<{
      ingredient_order: number;
      ingredient_name: string;
      rxcui: string | null;
    }>(
      `SELECT ingredient_order, ingredient_name, rxcui
         FROM patient_medication_ingredient
        WHERE patient_medication_id = $1
        ORDER BY ingredient_order`,
      [medicationId],
    );
    expect(rows.rows).toEqual([
      { ingredient_order: 1, ingredient_name: 'amoxicillin', rxcui: '723' },
      { ingredient_order: 2, ingredient_name: 'clavulanate', rxcui: '21212' },
    ]);
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('rejects client-supplied codes that disagree with the reviewed identity bridge', async () => {
    const patientId = await seedPatient();
    await expect(
      appendMedicationRevision(client, {
        patientId,
        clinicianSub: OWNER_A,
        input: {
          ...combinationMedication(),
          ingredients: [
            { name: 'amoxicillin', ccddIngredientCode: 'TM-AMOX', rxcui: '999999' },
            { name: 'clavulanate', ccddIngredientCode: 'TM-CLAV', rxcui: '21212' },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(ClinicalRecordConflictError);
    expect(
      (await client.query('SELECT 1 FROM patient_medication WHERE patient_id = $1', [patientId]))
        .rowCount,
    ).toBe(0);
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('records an unreviewed local medication without trusting ingredient identity codes', async () => {
    const patientId = await seedPatient();
    const input = {
      ...combinationMedication(),
      identity: { system: 'local' as const, code: 'patient-entered-name' },
      ingredients: [{ name: 'unknown ingredient', ccddIngredientCode: null, rxcui: null }],
    };
    const medicationId = await appendMedicationRevision(client, {
      patientId,
      clinicianSub: OWNER_A,
      input,
    });
    const ingredients = await client.query<{ ccdd_ingredient_code: null; rxcui: null }>(
      `SELECT ccdd_ingredient_code, rxcui
         FROM patient_medication_ingredient
        WHERE patient_medication_id = $1`,
      [medicationId],
    );
    expect(ingredients.rows).toEqual([{ ccdd_ingredient_code: null, rxcui: null }]);
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('does not retrieve evidence for an unreviewed non-local identity', async () => {
    const patientId = await seedPatient();
    await appendMedicationRevision(client, {
      patientId,
      clinicianSub: OWNER_A,
      input: {
        ...combinationMedication(),
        identity: { system: 'din', code: '99999999' },
        ingredients: [{ name: 'unknown ingredient', ccddIngredientCode: null, rxcui: null }],
      },
    });
    const release = await client.query<{ id: string }>(
      `INSERT INTO source_release
         (source_name, release_version, checksum_sha256, source_url, licence_id,
          state, is_complete, fresh_until, activated_at)
       VALUES ('health_canada', 'unreviewed-identity-test', $1, 'https://example.invalid/hc',
               'test', 'active', true, now() + interval '30 days', now())
       RETURNING id`,
      ['e'.repeat(64)],
    );
    await client.query(
      `INSERT INTO evidence_record
         (source_release_id, evidence_code, evidence_kind, language, passage, source_url,
          coverage_state, tags)
       VALUES ($1, 'wrong-product', 'monograph', 'en', 'Wrong product evidence.',
               'https://example.invalid/evidence', 'direct_evidence', ARRAY['din:99999999'])`,
      [release.rows[0]!.id],
    );

    expect(
      await retrievePatientEvidence(client, {
        patientId,
        clinicianSub: OWNER_A,
        occurredOn: '2026-08-11',
        language: 'en',
        limit: 10,
      }),
    ).toEqual([]);
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
    await client.query('DELETE FROM source_release WHERE id = $1', [release.rows[0]!.id]);
  });

  it('rejects selected schedules outside the medication effective dates', async () => {
    const patientId = await seedPatient();
    const [before, start, end, after] = await seedSchedules(patientId, 4, '2026-08-10');
    await expect(
      appendMedicationRevision(client, {
        patientId,
        clinicianSub: OWNER_A,
        input: {
          ...combinationMedication(null, [before!, start!, end!, after!]),
          validFrom: '2026-08-11',
          validTo: '2026-08-12',
        },
      }),
    ).rejects.toBeInstanceOf(ClinicalRecordConflictError);
    expect(
      (await client.query('SELECT 1 FROM patient_medication WHERE patient_id = $1', [patientId]))
        .rowCount,
    ).toBe(0);

    await expect(
      appendMedicationRevision(client, {
        patientId,
        clinicianSub: OWNER_A,
        input: {
          ...combinationMedication(null, [start!, end!]),
          validFrom: '2026-08-11',
          validTo: '2026-08-12',
        },
      }),
    ).resolves.toEqual(expect.any(String));
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('fails closed for a foreign doctor before writing medication or fact rows', async () => {
    const patientId = await seedPatient(OWNER_A);
    const [scheduleId] = await seedSchedules(patientId, 1);
    await expect(
      appendMedicationRevision(client, {
        patientId,
        clinicianSub: OWNER_B,
        input: combinationMedication(null, [scheduleId!]),
      }),
    ).rejects.toBeInstanceOf(ClinicalRecordNotFoundError);
    await expect(
      appendClinicalFactRevision(client, {
        patientId,
        clinicianSub: OWNER_B,
        input: {
          factType: 'condition',
          factCode: null,
          statementText: 'Foreign write must not land.',
          status: 'current',
          supersedesId: null,
        },
      }),
    ).rejects.toBeInstanceOf(ClinicalRecordNotFoundError);
    const counts = await client.query<{ medications: string; facts: string }>(
      `SELECT
         (SELECT count(*) FROM patient_medication WHERE patient_id = $1)::text AS medications,
         (SELECT count(*) FROM clinical_fact WHERE patient_id = $1)::text AS facts`,
      [patientId],
    );
    expect(counts.rows[0]).toEqual({ medications: '0', facts: '0' });
    const schedule = await client.query<{ patient_medication_id: string | null }>(
      'SELECT patient_medication_id FROM dose_schedule WHERE id = $1',
      [scheduleId],
    );
    expect(schedule.rows[0]!.patient_medication_id).toBeNull();
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('serializes medication supersession on the owner-scoped patient row first', async () => {
    const patientId = await seedPatient();
    const original = await client.query<{ id: string }>(
      `INSERT INTO patient_medication
         (patient_id, entered_name, status, confirmed_by_clinician_sub, confirmed_at)
       VALUES ($1, 'Original medication', 'active', $2, now())
       RETURNING id`,
      [patientId, OWNER_A],
    );
    await expectPatientRevisionLock(patientId, () =>
      appendMedicationRevision(client, {
        patientId,
        clinicianSub: OWNER_A,
        input: {
          enteredName: 'Corrected medication',
          identity: null,
          doseText: null,
          form: null,
          route: null,
          validFrom: '2026-08-11',
          validTo: null,
          status: 'corrected',
          supersedesId: original.rows[0]!.id,
          scheduleIds: [],
          ingredients: [{ name: 'ingredient', ccddIngredientCode: null, rxcui: null }],
        },
      }),
    );
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('serializes fact supersession on the owner-scoped patient row first', async () => {
    const patientId = await seedPatient();
    const original = await client.query<{ id: string }>(
      `INSERT INTO clinical_fact
         (patient_id, fact_type, statement_text, status, authored_by_clinician_sub)
       VALUES ($1, 'note', 'Original fact', 'current', $2)
       RETURNING id`,
      [patientId, OWNER_A],
    );
    await expectPatientRevisionLock(patientId, () =>
      appendClinicalFactRevision(client, {
        patientId,
        clinicianSub: OWNER_A,
        input: {
          factType: 'note',
          factCode: null,
          statementText: 'Corrected fact',
          status: 'corrected',
          supersedesId: original.rows[0]!.id,
        },
      }),
    );
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('atomically rejects a cross-patient schedule selection without creating a medication', async () => {
    const patientId = await seedPatient(OWNER_A);
    const otherPatientId = await seedPatient(OWNER_A);
    const [foreignScheduleId] = await seedSchedules(otherPatientId, 1);

    await expect(
      appendMedicationRevision(client, {
        patientId,
        clinicianSub: OWNER_A,
        input: combinationMedication(null, [foreignScheduleId!]),
      }),
    ).rejects.toBeInstanceOf(ClinicalRecordNotFoundError);

    const state = await client.query<{
      medication_count: number;
      patient_medication_id: string | null;
    }>(
      `SELECT
         (SELECT count(*)::int FROM patient_medication WHERE patient_id = $1) AS medication_count,
         patient_medication_id
       FROM dose_schedule
       WHERE id = $2`,
      [patientId, foreignScheduleId],
    );
    expect(state.rows).toEqual([{ medication_count: 0, patient_medication_id: null }]);
    await client.query('DELETE FROM patient WHERE id = ANY($1::uuid[])', [
      [patientId, otherPatientId],
    ]);
  });

  it('appends corrections, preserves originals, and rejects a revision fork', async () => {
    const patientId = await seedPatient();
    const [scheduleA, scheduleB, scheduleC] = await seedSchedules(patientId, 3);
    const originalId = await appendMedicationRevision(client, {
      patientId,
      clinicianSub: OWNER_A,
      input: combinationMedication(null, [scheduleA!, scheduleB!]),
    });
    const originalLinks = await client.query<{ id: string; patient_medication_id: string | null }>(
      `SELECT id, patient_medication_id
         FROM dose_schedule
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[scheduleA, scheduleB]],
    );
    expect(originalLinks.rows.every((row) => row.patient_medication_id === originalId)).toBe(true);
    const correctedId = await appendMedicationRevision(client, {
      patientId,
      clinicianSub: OWNER_A,
      input: {
        ...combinationMedication(originalId, [scheduleB!, scheduleC!]),
        doseText: '500 mg / 125 mg',
      },
    });
    await expect(
      appendMedicationRevision(client, {
        patientId,
        clinicianSub: OWNER_A,
        input: { ...combinationMedication(originalId), doseText: '250 mg / 125 mg' },
      }),
    ).rejects.toBeInstanceOf(ClinicalRecordConflictError);

    const history = await listClinicalHistory(client, patientId, OWNER_A);
    expect(history?.medications.map((row) => row.id)).toEqual([originalId, correctedId]);
    expect(history?.medications[1]?.supersedesId).toBe(originalId);
    expect(history?.medications[0]?.doseText).toBe('875 mg / 125 mg');
    const links = await client.query<{ id: string; patient_medication_id: string | null }>(
      `SELECT id, patient_medication_id
         FROM dose_schedule
        WHERE patient_id = $1
        ORDER BY id`,
      [patientId],
    );
    expect(
      Object.fromEntries(links.rows.map((row) => [row.id, row.patient_medication_id])),
    ).toEqual({
      [scheduleA!]: null,
      [scheduleB!]: correctedId,
      [scheduleC!]: correctedId,
    });
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('returns null rather than leaking whether a foreign patient has history', async () => {
    const patientId = await seedPatient(OWNER_A);
    expect(await listClinicalHistory(client, patientId, OWNER_B)).toBeNull();
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('bounds the clinician history to the newest 100 medications and 200 facts in SQL', async () => {
    const patientId = await seedPatient(OWNER_A);
    await client.query(
      `INSERT INTO patient_medication
         (patient_id, entered_name, status, confirmed_by_clinician_sub, confirmed_at, created_at)
       SELECT $1, 'med-' || n::text, 'active', $2, now(),
              '2026-01-01'::timestamptz + n * interval '1 minute'
         FROM generate_series(1, 101) AS n`,
      [patientId, OWNER_A],
    );
    await client.query(
      `INSERT INTO clinical_fact
         (patient_id, fact_type, statement_text, status, authored_by_clinician_sub, created_at)
       SELECT $1, 'note', 'fact-' || n::text, 'current', $2,
              '2026-01-01'::timestamptz + n * interval '1 minute'
         FROM generate_series(1, 201) AS n`,
      [patientId, OWNER_A],
    );

    const history = await listClinicalHistory(client, patientId, OWNER_A);
    expect(history?.medications).toHaveLength(CLINICAL_HISTORY_LIMITS.medications);
    expect(history?.facts).toHaveLength(CLINICAL_HISTORY_LIMITS.facts);
    expect(history?.medications.some((row) => row.enteredName === 'med-1')).toBe(false);
    expect(history?.medications.some((row) => row.enteredName === 'med-101')).toBe(true);
    expect(history?.facts.some((row) => row.statementText === 'fact-1')).toBe(false);
    expect(history?.facts.some((row) => row.statementText === 'fact-201')).toBe(true);
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });
});

describe('doctor-owned exact evidence retrieval', () => {
  it('excludes OnSIDES rows from model-context evidence retrieval', async () => {
    const patientId = await seedPatient();
    await appendMedicationRevision(client, {
      patientId,
      clinicianSub: OWNER_A,
      input: combinationMedication(),
    });
    const release = await client.query<{ id: string }>(
      `INSERT INTO source_release
         (source_name, release_version, checksum_sha256, source_url, licence_id,
          state, is_complete, activated_at)
       VALUES ('onsides', 'v3.1.1', $1, 'https://onsidesdb.org/', 'CC-BY-NC-SA-4.0',
               'active', true, now())
       RETURNING id`,
      ['e'.repeat(64)],
    );
    const releaseId = release.rows[0]!.id;
    await client.query(
      `INSERT INTO evidence_record
         (source_release_id, evidence_code, evidence_kind, language, passage, source_url,
          coverage_state, tags)
       VALUES ($1, 'onsides-headache', 'adverse_event_index', 'en',
               'OnSIDES model-context sentinel.', 'https://onsidesdb.org/',
               'direct_evidence', ARRAY['rxcui:723'])`,
      [releaseId],
    );

    try {
      expect(
        await retrievePatientEvidence(client, {
          patientId,
          clinicianSub: OWNER_A,
          occurredOn: '2026-08-11',
          language: 'en',
          limit: 10,
        }),
      ).toEqual([]);
    } finally {
      await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
      await client.query('DELETE FROM source_release WHERE id = $1', [releaseId]);
    }
  });

  it('derives exact patient tags before ranking and returns complete source provenance', async () => {
    const patientId = await seedPatient();
    await appendMedicationRevision(client, {
      patientId,
      clinicianSub: OWNER_A,
      input: combinationMedication(),
    });
    const release = await client.query<{ id: string }>(
      `INSERT INTO source_release
         (source_name, release_version, checksum_sha256, source_url, licence_id, terms_url,
          state, is_complete, activated_at)
       VALUES ('openfda', 'evidence-v1', $1, 'https://open.fda.gov/', 'CC0-1.0',
               'https://open.fda.gov/terms/', 'active', true, now())
       RETURNING id`,
      ['b'.repeat(64)],
    );
    const releaseId = release.rows[0]!.id;
    await client.query(
      `INSERT INTO evidence_record
         (source_release_id, evidence_code, evidence_kind, language, passage, source_url,
          coverage_state, tags)
       VALUES ($1, 'headache-label', 'label', 'en',
               'Headache is listed as a possible adverse reaction.',
               'https://open.fda.gov/example', 'direct_evidence', ARRAY['rxcui:723']),
              ($1, 'unrelated-label', 'label', 'en', 'Unrelated passage.',
               'https://open.fda.gov/other', 'direct_evidence', ARRAY['rxcui:999999'])`,
      [releaseId],
    );

    const results = await retrievePatientEvidence(client, {
      patientId,
      clinicianSub: OWNER_A,
      occurredOn: '2026-08-11',
      language: 'en',
      limit: 10,
    });
    expect(results).toEqual([
      {
        reference: expect.objectContaining({
          evidenceId: expect.any(String),
          title: 'headache-label',
          source: 'openfda',
          sourceReleaseId: releaseId,
          sourceVersion: 'evidence-v1',
          coverageState: 'direct_evidence',
          allowedTemplateIds: ['direct-label-evidence-v1'],
        }),
        sourceChecksumSha256: 'b'.repeat(64),
      },
    ]);
    await client.query(
      "UPDATE source_release SET fresh_until = '2026-08-10T00:00:00Z' WHERE id = $1",
      [releaseId],
    );
    expect(
      await retrievePatientEvidence(client, {
        patientId,
        clinicianSub: OWNER_A,
        occurredOn: '2026-08-11',
        language: 'en',
        limit: 10,
      }),
    ).toEqual([]);
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
    await client.query('DELETE FROM source_release WHERE id = $1', [releaseId]);
  });

  it('rejects a foreign doctor before retrieving shared evidence', async () => {
    const patientId = await seedPatient();
    await expect(
      retrievePatientEvidence(client, {
        patientId,
        clinicianSub: OWNER_B,
        occurredOn: '2026-08-11',
        language: 'en',
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(ClinicalRecordNotFoundError);
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('retrieves an exact Health Canada monograph passage but does not allow metadata as a claim', async () => {
    const patientId = await seedPatient();
    await appendMedicationRevision(client, {
      patientId,
      clinicianSub: OWNER_A,
      input: combinationMedication(),
    });
    const release = await client.query<{ id: string }>(
      `INSERT INTO source_release
         (source_name, release_version, checksum_sha256, source_url, licence_id, terms_url,
          state, is_complete, activated_at)
       VALUES ('health_canada', 'monograph-v1', $1, 'https://health-products.canada.ca/',
               'rights-cleared-selection', 'https://open.canada.ca/en/open-government-licence-canada',
               'active', true, now())
       RETURNING id`,
      ['c'.repeat(64)],
    );
    const releaseId = release.rows[0]!.id;
    await client.query(
      `INSERT INTO evidence_record
         (source_release_id, evidence_code, evidence_kind, language, passage, source_url,
          coverage_state, tags)
       VALUES ($1, 'reviewed-warning', 'monograph', 'en', 'Reviewed warning passage.',
               'https://health-products.canada.ca/example', 'direct_evidence', ARRAY['rxcui:723']),
              ($1, 'product-metadata', 'adverse_event_index', 'en', 'DIN metadata.',
               'https://health-products.canada.ca/example', 'direct_evidence', ARRAY['rxcui:723'])`,
      [releaseId],
    );

    const results = await retrievePatientEvidence(client, {
      patientId,
      clinicianSub: OWNER_A,
      occurredOn: '2026-08-11',
      language: 'en',
      limit: 10,
    });
    expect(results.map(({ reference }) => [reference.title, reference.allowedTemplateIds])).toEqual(
      [
        ['product-metadata', []],
        ['reviewed-warning', ['direct-label-evidence-v1']],
      ],
    );
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
    await client.query('DELETE FROM source_release WHERE id = $1', [releaseId]);
  });
});

describe('deterministic DDInter coverage', () => {
  async function seedInteractionKnowledge(patientId: string, complete = true): Promise<string> {
    const release = await client.query<{ id: string }>(
      `INSERT INTO source_release
         (source_name, release_version, checksum_sha256, source_url, licence_id, terms_url,
          state, is_complete, activated_at)
       VALUES ('ddinter', $1, $2, 'https://ddinter2.scbdd.com/download/',
               'CC-BY-NC-SA-4.0', 'https://ddinter2.scbdd.com/terms/', 'active', $3, now())
       RETURNING id`,
      [`test-${patientId}`, 'a'.repeat(64), complete],
    );
    const releaseId = release.rows[0]!.id;
    await client.query(
      `INSERT INTO ddinter_drug (source_release_id, ddinter_drug_id, display_name)
       VALUES ($1, 'DD-AMOX', 'Amoxicillin'),
              ($1, 'DD-CLAV', 'Clavulanate'),
              ($1, 'DD-WARF', 'Warfarin')`,
      [releaseId],
    );
    await client.query(
      `INSERT INTO ingredient_ddinter_map
         (source_release_id, identity_system, identity_code, ddinter_drug_id,
          mapping_status, reviewed_by, reviewed_at)
       VALUES ($1, 'rxnorm', '723', 'DD-AMOX', 'mapped', 'reviewer', now()),
              ($1, 'rxnorm', '21212', 'DD-CLAV', 'mapped', 'reviewer', now()),
              ($1, 'rxnorm', '11289', 'DD-WARF', 'mapped', 'reviewer', now())`,
      [releaseId],
    );
    await client.query(
      `INSERT INTO medication_interaction
         (source_release_id, low_ddinter_drug_id, high_ddinter_drug_id, interaction_level)
       VALUES ($1, 'DD-AMOX', 'DD-WARF', 'major')`,
      [releaseId],
    );
    await appendMedicationRevision(client, {
      patientId,
      clinicianSub: OWNER_A,
      input: combinationMedication(),
    });
    await appendMedicationRevision(client, {
      patientId,
      clinicianSub: OWNER_A,
      input: {
        enteredName: 'Warfarin',
        identity: { system: 'din', code: '00011289' },
        doseText: null,
        form: 'tablet',
        route: 'oral',
        validFrom: '2026-08-11',
        validTo: null,
        status: 'active',
        supersedesId: null,
        scheduleIds: [],
        ingredients: [{ name: 'warfarin', ccddIngredientCode: 'TM-WARF', rxcui: '11289' }],
      },
    });
    return releaseId;
  }

  async function cleanup(patientId: string, releaseId: string): Promise<void> {
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
    await client.query('DELETE FROM source_release WHERE id = $1', [releaseId]);
  }

  it('returns one found canonical pair and complete-release no-record pairs', async () => {
    const patientId = await seedPatient();
    const releaseId = await seedInteractionKnowledge(patientId);
    const results = await retrievePatientDrugInteractions(client, {
      patientId,
      clinicianSub: OWNER_A,
      occurredOn: '2026-08-11',
      interactionKind: 'drug_drug',
    });
    expect(results).toHaveLength(3);
    expect(results.filter((result) => result.state === 'interaction_found')).toEqual([
      expect.objectContaining({
        level: 'major',
        pair: { lowDrugId: 'DD-AMOX', highDrugId: 'DD-WARF' },
      }),
    ]);
    expect(
      results.filter((result) => result.state === 'checked_no_interaction_record'),
    ).toHaveLength(2);
    await cleanup(patientId, releaseId);
  });

  it('keeps a medication revision until its successor becomes effective', async () => {
    const patientId = await seedPatient();
    const releaseId = await seedInteractionKnowledge(patientId);
    const original = await client.query<{ id: string }>(
      `SELECT id::text
         FROM patient_medication
        WHERE patient_id = $1 AND entered_name = 'Amoxicillin / clavulanate'`,
      [patientId],
    );
    await appendMedicationRevision(client, {
      patientId,
      clinicianSub: OWNER_A,
      input: {
        ...combinationMedication(original.rows[0]!.id),
        enteredName: 'Future replacement',
        validFrom: '2026-08-12',
      },
    });
    const evidenceRelease = await client.query<{ id: string }>(
      `INSERT INTO source_release
         (source_name, release_version, checksum_sha256, source_url, licence_id,
          state, is_complete, activated_at)
       VALUES ('openfda', $1, $2, 'https://open.fda.gov/', 'CC0-1.0', 'active', true, now())
       RETURNING id::text`,
      [`historical-${patientId}`, 'f'.repeat(64)],
    );
    await client.query(
      `INSERT INTO evidence_record
         (source_release_id, evidence_code, evidence_kind, language, passage, source_url,
          coverage_state, tags)
       VALUES ($1, 'historical-label', 'label', 'en', 'Historical medication evidence.',
               'https://open.fda.gov/historical', 'direct_evidence', ARRAY['rxcui:723'])`,
      [evidenceRelease.rows[0]!.id],
    );

    const context = await readCurrentClinicalContext(client, {
      patientId,
      clinicianSub: OWNER_A,
      occurredOn: '2026-08-11',
      language: 'en',
    });
    const evidence = await retrievePatientEvidence(client, {
      patientId,
      clinicianSub: OWNER_A,
      occurredOn: '2026-08-11',
      language: 'en',
      limit: 10,
    });
    const interactions = await retrievePatientDrugInteractions(client, {
      patientId,
      clinicianSub: OWNER_A,
      occurredOn: '2026-08-11',
      interactionKind: 'drug_drug',
    });
    await cleanup(patientId, releaseId);
    await client.query('DELETE FROM source_release WHERE id = $1', [evidenceRelease.rows[0]!.id]);

    expect(context.activeMedications.map(({ enteredName }) => enteredName)).toEqual([
      'Amoxicillin / clavulanate',
      'Warfarin',
    ]);
    expect(context.drugInteractions).toEqual([
      {
        state: 'interaction_found',
        source: 'ddinter',
        displayNames: ['Amoxicillin', 'Warfarin'],
        pair: { lowDrugId: 'DD-AMOX', highDrugId: 'DD-WARF' },
        level: 'major',
        release: {
          id: releaseId,
          version: `test-${patientId}`,
          checksumSha256: 'a'.repeat(64),
        },
      },
    ]);
    expect(evidence.map(({ reference }) => reference.title)).toEqual(['historical-label']);
    expect(interactions).toContainEqual(
      expect.objectContaining({
        state: 'interaction_found',
        pair: { lowDrugId: 'DD-AMOX', highDrugId: 'DD-WARF' },
      }),
    );
  });

  it('does not treat a repeated fully mapped ingredient as unmapped', async () => {
    const patientId = await seedPatient();
    const releaseId = await seedInteractionKnowledge(patientId);
    const medication = await client.query<{ id: string }>(
      `SELECT id FROM patient_medication
        WHERE patient_id = $1 AND entered_name = 'Warfarin'`,
      [patientId],
    );
    await client.query(
      `INSERT INTO patient_medication_ingredient
         (patient_id, patient_medication_id, ingredient_order, ingredient_name, rxcui)
       VALUES ($1, $2, 2, 'warfarin', '11289')`,
      [patientId, medication.rows[0]!.id],
    );

    const results = await retrievePatientDrugInteractions(client, {
      patientId,
      clinicianSub: OWNER_A,
      occurredOn: '2026-08-11',
      interactionKind: 'drug_drug',
    });
    expect(results).not.toContainEqual(
      expect.objectContaining({ state: 'coverage_unknown', reason: 'unmapped_ingredient' }),
    );
    await cleanup(patientId, releaseId);
  });

  it('returns coverage_unknown when mapping is ambiguous or the release is incomplete', async () => {
    const patientId = await seedPatient();
    const releaseId = await seedInteractionKnowledge(patientId);
    await client.query(
      `DELETE FROM ingredient_ddinter_map
        WHERE source_release_id = $1 AND identity_code = '21212'`,
      [releaseId],
    );
    await client.query(
      `INSERT INTO ingredient_ddinter_map
         (source_release_id, identity_system, identity_code, ddinter_drug_id,
          mapping_status, reviewed_by, reviewed_at)
       VALUES ($1, 'rxnorm', '21212', NULL, 'ambiguous', 'reviewer', now())`,
      [releaseId],
    );
    const ambiguous = await retrievePatientDrugInteractions(client, {
      patientId,
      clinicianSub: OWNER_A,
      occurredOn: '2026-08-11',
      interactionKind: 'drug_drug',
    });
    expect(ambiguous).toContainEqual(
      expect.objectContaining({ state: 'coverage_unknown', reason: 'ambiguous_mapping' }),
    );
    await cleanup(patientId, releaseId);

    const incompletePatient = await seedPatient();
    const incompleteRelease = await seedInteractionKnowledge(incompletePatient, false);
    const incomplete = await retrievePatientDrugInteractions(client, {
      patientId: incompletePatient,
      clinicianSub: OWNER_A,
      occurredOn: '2026-08-11',
      interactionKind: 'drug_drug',
    });
    expect(incomplete).toEqual([
      expect.objectContaining({
        state: 'coverage_unknown',
        reason: 'incomplete_release',
      }),
    ]);
    await cleanup(incompletePatient, incompleteRelease);
  });

  it('fails closed when the active DDInter snapshot is stale', async () => {
    const patientId = await seedPatient();
    const releaseId = await seedInteractionKnowledge(patientId);
    await client.query(
      "UPDATE source_release SET fresh_until = '2026-08-10T00:00:00Z' WHERE id = $1",
      [releaseId],
    );
    expect(
      await retrievePatientDrugInteractions(client, {
        patientId,
        clinicianSub: OWNER_A,
        occurredOn: '2026-08-11',
        interactionKind: 'drug_drug',
      }),
    ).toEqual([expect.objectContaining({ state: 'coverage_unknown', reason: 'stale_release' })]);
    expect(
      (
        await readCurrentClinicalContext(client, {
          patientId,
          clinicianSub: OWNER_A,
          occurredOn: '2026-08-11',
          language: 'en',
        })
      ).drugInteractions,
    ).toEqual([
      {
        state: 'coverage_unknown',
        source: 'ddinter',
        displayNames: [],
        reason: 'stale_release',
        release: {
          id: releaseId,
          version: `test-${patientId}`,
          checksumSha256: 'a'.repeat(64),
        },
      },
    ]);
    await client.query(
      "UPDATE source_release SET state = 'withdrawn', fresh_until = '2026-09-10T00:00:00Z' WHERE id = $1",
      [releaseId],
    );
    expect(
      await retrievePatientDrugInteractions(client, {
        patientId,
        clinicianSub: OWNER_A,
        occurredOn: '2026-08-11',
        interactionKind: 'drug_drug',
      }),
    ).toEqual([
      expect.objectContaining({ state: 'coverage_unknown', reason: 'withdrawn_release' }),
    ]);
    await cleanup(patientId, releaseId);
  });

  it('rejects a foreign patient and marks unsupported interaction kinds unavailable', async () => {
    const patientId = await seedPatient();
    await expect(
      retrievePatientDrugInteractions(client, {
        patientId,
        clinicianSub: OWNER_B,
        occurredOn: '2026-08-11',
        interactionKind: 'drug_drug',
      }),
    ).rejects.toBeInstanceOf(ClinicalRecordNotFoundError);
    expect(
      await retrievePatientDrugInteractions(client, {
        patientId,
        clinicianSub: OWNER_A,
        occurredOn: '2026-08-11',
        interactionKind: 'drug_food',
      }),
    ).toEqual([
      expect.objectContaining({
        state: 'coverage_unknown',
        reason: 'interaction_kind_unavailable',
      }),
    ]);
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });
});

describe('bounded conversational clinical context', () => {
  it('keeps the current context owner-scoped', async () => {
    const patientId = await seedPatient();
    await expect(
      readCurrentClinicalContext(client, {
        patientId,
        clinicianSub: OWNER_B,
        occurredOn: '2026-08-11',
        language: 'en',
      }),
    ).rejects.toBeInstanceOf(ClinicalRecordNotFoundError);
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('keeps an explicitly unmapped legacy medication with zero ingredients', async () => {
    const patientId = await seedPatient();
    const medication = await client.query<{ id: string }>(
      `INSERT INTO patient_medication
         (patient_id, entered_name, valid_from, status, confirmed_by_clinician_sub, confirmed_at)
       VALUES ($1, 'stored legacy medication', '2026-08-01', 'active', $2, now())
       RETURNING id::text`,
      [patientId, OWNER_A],
    );
    await client.query(
      `INSERT INTO clinical_fact
         (patient_id, fact_type, statement_text, status, authored_by_clinician_sub)
       VALUES ($1, 'allergy', 'Recorded allergy', 'current', $2)`,
      [patientId, OWNER_A],
    );

    const context = await readCurrentClinicalContext(client, {
      patientId,
      clinicianSub: OWNER_A,
      occurredOn: '2026-08-11',
      language: 'en',
    });
    expect(context.activeMedications).toEqual([
      expect.objectContaining({
        patientMedicationId: medication.rows[0]!.id,
        enteredName: 'stored legacy medication',
        ingredientNames: [],
      }),
    ]);
    expect(context.clinicalFacts).toEqual([
      expect.objectContaining({ kind: 'allergy', statement: 'Recorded allergy' }),
    ]);
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('fails closed when interaction candidates have no active DDInter release', async () => {
    const patientId = await seedPatient();
    const medication = await client.query<{ id: string }>(
      `INSERT INTO patient_medication
         (patient_id, entered_name, valid_from, status, confirmed_by_clinician_sub, confirmed_at)
       VALUES ($1, 'unmapped combination', '2026-08-01', 'active', $2, now())
       RETURNING id::text`,
      [patientId, OWNER_A],
    );
    await client.query(
      `INSERT INTO patient_medication_ingredient
         (patient_id, patient_medication_id, ingredient_order, ingredient_name, rxcui)
       VALUES ($1, $2, 1, 'ingredient one', 'RX-1'),
              ($1, $2, 2, 'ingredient two', 'RX-2')`,
      [patientId, medication.rows[0]!.id],
    );

    expect(
      (
        await readCurrentClinicalContext(client, {
          patientId,
          clinicianSub: OWNER_A,
          occurredOn: '2026-08-11',
          language: 'en',
        })
      ).drugInteractions,
    ).toEqual([
      {
        state: 'coverage_unknown',
        source: 'ddinter',
        displayNames: [],
        reason: 'no_active_complete_release',
        release: null,
      },
    ]);
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('marks multiple legacy medications unknown without escalating one simple medication', async () => {
    const simplePatientId = await seedPatient();
    const legacyPatientId = await seedPatient();
    const release = await client.query<{ id: string }>(
      `INSERT INTO source_release
         (source_name, release_version, checksum_sha256, source_url, licence_id, terms_url,
          state, is_complete, activated_at)
       VALUES ('ddinter', $1, $2, 'https://ddinter2.scbdd.com/download/',
               'CC-BY-NC-SA-4.0', 'https://ddinter2.scbdd.com/terms/', 'active', true, now())
       RETURNING id::text`,
      [`legacy-${legacyPatientId}`, 'd'.repeat(64)],
    );
    const simpleMedication = await client.query<{ id: string }>(
      `INSERT INTO patient_medication
         (patient_id, entered_name, valid_from, status, confirmed_by_clinician_sub, confirmed_at)
       VALUES ($1, 'simple medicine', '2026-08-01', 'active', $2, now())
       RETURNING id::text`,
      [simplePatientId, OWNER_A],
    );
    await client.query(
      `INSERT INTO patient_medication_ingredient
         (patient_id, patient_medication_id, ingredient_order, ingredient_name, rxcui)
       VALUES ($1, $2, 1, 'simple ingredient', 'RX-SIMPLE')`,
      [simplePatientId, simpleMedication.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO patient_medication
         (patient_id, entered_name, valid_from, status, confirmed_by_clinician_sub, confirmed_at)
       VALUES ($1, 'legacy medicine one', '2026-08-01', 'active', $2, now()),
              ($1, 'legacy medicine two', '2026-08-01', 'active', $2, now())`,
      [legacyPatientId, OWNER_A],
    );

    const simple = await readCurrentClinicalContext(client, {
      patientId: simplePatientId,
      clinicianSub: OWNER_A,
      occurredOn: '2026-08-11',
      language: 'en',
    });
    const legacy = await readCurrentClinicalContext(client, {
      patientId: legacyPatientId,
      clinicianSub: OWNER_A,
      occurredOn: '2026-08-11',
      language: 'en',
    });

    expect(simple.drugInteractions).toEqual([]);
    expect(legacy.drugInteractions).toEqual([
      expect.objectContaining({
        state: 'coverage_unknown',
        source: 'ddinter',
        reason: 'insufficient_distinct_ingredients',
        release: expect.objectContaining({ id: release.rows[0]!.id }),
      }),
    ]);
    await client.query('DELETE FROM patient WHERE id = ANY($1::uuid[])', [
      [simplePatientId, legacyPatientId],
    ]);
    await client.query('DELETE FROM source_release WHERE id = $1', [release.rows[0]!.id]);
  });

  it('fails closed when an active medication exceeds the ten-ingredient prompt cap', async () => {
    const patientId = await seedPatient();
    const medication = await client.query<{ id: string }>(
      `INSERT INTO patient_medication
         (patient_id, entered_name, valid_from, status, confirmed_by_clinician_sub, confirmed_at)
       VALUES ($1, 'oversized combination', '2026-08-01', 'active', $2, now())
       RETURNING id::text`,
      [patientId, OWNER_A],
    );
    await client.query(
      `INSERT INTO patient_medication_ingredient
         (patient_id, patient_medication_id, ingredient_order, ingredient_name)
       SELECT $1, $2, ordinal, 'ingredient-' || ordinal::text
         FROM generate_series(1, 11) AS ordinal`,
      [patientId, medication.rows[0]!.id],
    );
    await expect(
      readCurrentClinicalContext(client, {
        patientId,
        clinicianSub: OWNER_A,
        occurredOn: '2026-08-11',
        language: 'en',
      }),
    ).rejects.toMatchObject({
      name: 'CurrentClinicalContextOverflowError',
      collection: 'ingredients',
    });
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('uses limit-plus-one and fails closed above twenty active medications', async () => {
    const patientId = await seedPatient();
    await client.query(
      `INSERT INTO patient_medication
         (patient_id, entered_name, valid_from, status, confirmed_by_clinician_sub, confirmed_at)
       SELECT $1, 'medication-' || ordinal::text, '2026-08-01', 'active', $2, now()
         FROM generate_series(1, 21) AS ordinal`,
      [patientId, OWNER_A],
    );
    await expect(
      readCurrentClinicalContext(client, {
        patientId,
        clinicianSub: OWNER_A,
        occurredOn: '2026-08-11',
        language: 'en',
      }),
    ).rejects.toMatchObject({
      name: 'CurrentClinicalContextOverflowError',
      collection: 'medications',
    });
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('uses limit-plus-one and fails closed above fifty current clinical facts', async () => {
    const patientId = await seedPatient();
    await client.query(
      `INSERT INTO clinical_fact
         (patient_id, fact_type, statement_text, status, authored_by_clinician_sub)
       SELECT $1, 'note', 'fact-' || ordinal::text, 'current', $2
         FROM generate_series(1, 51) AS ordinal`,
      [patientId, OWNER_A],
    );
    await expect(
      readCurrentClinicalContext(client, {
        patientId,
        clinicianSub: OWNER_A,
        occurredOn: '2026-08-11',
        language: 'en',
      }),
    ).rejects.toMatchObject({
      name: 'CurrentClinicalContextOverflowError',
      collection: 'facts',
    });
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('fails closed above twenty model-visible interaction results', async () => {
    const patientId = await seedPatient();
    const medication = await client.query<{ id: string }>(
      `INSERT INTO patient_medication
         (patient_id, entered_name, valid_from, status, confirmed_by_clinician_sub, confirmed_at)
       VALUES ($1, 'seven ingredients', '2026-08-01', 'active', $2, now())
       RETURNING id::text`,
      [patientId, OWNER_A],
    );
    const release = await client.query<{ id: string }>(
      `INSERT INTO source_release
         (source_name, release_version, checksum_sha256, source_url, licence_id, terms_url,
          state, is_complete, activated_at)
       VALUES ('ddinter', $1, $2, 'https://ddinter2.scbdd.com/download/',
               'CC-BY-NC-SA-4.0', 'https://ddinter2.scbdd.com/terms/', 'active', true, now())
       RETURNING id::text`,
      [`overflow-${patientId}`, 'b'.repeat(64)],
    );
    await client.query(
      `INSERT INTO patient_medication_ingredient
         (patient_id, patient_medication_id, ingredient_order, ingredient_name, rxcui)
       SELECT $1, $2, n, 'ingredient-' || n::text, 'RX-' || n::text
         FROM generate_series(1, 7) n`,
      [patientId, medication.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO ddinter_drug (source_release_id, ddinter_drug_id, display_name)
       SELECT $1, 'DD-' || lpad(n::text, 2, '0'), 'Drug ' || n::text
         FROM generate_series(1, 7) n`,
      [release.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO ingredient_ddinter_map
         (source_release_id, identity_system, identity_code, ddinter_drug_id,
          mapping_status, reviewed_by, reviewed_at)
       SELECT $1, 'rxnorm', 'RX-' || n::text, 'DD-' || lpad(n::text, 2, '0'),
              'mapped', 'reviewer', now()
         FROM generate_series(1, 7) n`,
      [release.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO medication_interaction
         (source_release_id, low_ddinter_drug_id, high_ddinter_drug_id, interaction_level)
       SELECT $1, 'DD-' || lpad(low_n::text, 2, '0'),
              'DD-' || lpad(high_n::text, 2, '0'), 'major'
         FROM generate_series(1, 7) low_n
         CROSS JOIN generate_series(1, 7) high_n
        WHERE low_n < high_n`,
      [release.rows[0]!.id],
    );

    await expect(
      readCurrentClinicalContext(client, {
        patientId,
        clinicianSub: OWNER_A,
        occurredOn: '2026-08-11',
        language: 'en',
      }),
    ).rejects.toMatchObject({
      name: 'CurrentClinicalContextOverflowError',
      collection: 'interactions',
    });
    await client.query('DELETE FROM patient WHERE id = $1', [patientId]);
    await client.query('DELETE FROM source_release WHERE id = $1', [release.rows[0]!.id]);
  });
});
