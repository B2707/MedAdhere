import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  applyPreparedClinicalTurn,
  clinicalIntentCommandSchema,
  prepareClinicalFailureTurn,
  prepareClinicalTurn,
  renderClinicalResponse,
  type ClinicalIntentCommand,
  type ExtractedClaim,
  type PatientClinicalMemory,
  type PatientClinicalSnapshot,
  type PreparedClinicalTurn,
} from './index.js';
import { sha256 } from './hash.js';
import { translateHistoricalClinicalMemory } from './historical-translation.js';
import { eventIdForCommand } from './reducer.js';
import { commitPreparedClinicalTurn, loadPatientClinicalMemory } from './repository.js';
import { appendClinicalFactRevision } from '../../clinical-knowledge/repository.js';
import {
  CONTEXT_BATTERY_DISABLE_ENV,
  loadClinicalContextHashInTransaction,
  loadConversationJob,
} from '../runtime-repository.js';

const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'schema-init', 'schema.sql'), 'utf8');
const CONTAINER_TIMEOUT_MS = 180_000;
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTEXT_HASH = 'a'.repeat(64);
const PIPELINE_VERSIONS = {
  extractor: 'extractor-v1',
  resolver: 'resolver-v1',
  reducer: 'reducer-v1',
  renderer: 'renderer-v2',
} as const;
const ELIGIBLE = {
  polarity: 'positive',
  experiencer: 'patient',
  status: 'current',
  certainty: 'certain',
} as const;

function withPipelineVersions(
  prepared: PreparedClinicalTurn,
  pipelineVersions: PreparedClinicalTurn['pipelineVersions'],
): PreparedClinicalTurn {
  const currentIntegrity = Object.fromEntries(
    Object.entries(prepared).filter(([key]) => key !== 'preparedHash'),
  ) as Omit<PreparedClinicalTurn, 'preparedHash'>;
  const integrity = { ...currentIntegrity, pipelineVersions };
  return { ...integrity, preparedHash: sha256(integrity) };
}

type SeededPatient = {
  readonly id: string;
  readonly messagingStateVersion: number;
};

type SeededTurn = {
  readonly patientId: string;
  readonly inboundMessageId: string;
  readonly turnJobId: string;
  readonly sequence: number;
  readonly body: string;
  readonly messagingStateVersion: number;
};

type LiveAuthorityFixture = {
  readonly patient: SeededPatient;
  readonly turn: SeededTurn;
  readonly prepared: PreparedClinicalTurn;
  readonly medicationId: string;
  readonly doseId: string;
  readonly factId: string;
  readonly releaseId: string;
};

let container: StartedPostgreSqlContainer | undefined;
let databaseUrl: string;
let pool: Pool;
let phoneCounter = 0;
const patientsToDelete = new Set<string>();
const sourceReleasesToDelete = new Set<string>();

async function seedPatient(): Promise<SeededPatient> {
  phoneCounter += 1;
  const result = await pool.query<{ id: string; messaging_state_version: number }>(
    `INSERT INTO patient
       (phone, medication_name, owner_clinician_sub, timezone, is_test)
     VALUES ($1, 'test medication', $2, 'America/Toronto', true)
     RETURNING id::text, messaging_state_version`,
    [`+1500666${String(phoneCounter).padStart(4, '0')}`, OWNER_ID],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('patient_seed_failed');
  patientsToDelete.add(row.id);
  return { id: row.id, messagingStateVersion: row.messaging_state_version };
}

// W0.4: adherence timing is now DERIVED from inbound_reply.received_at vs the dose's
// scheduled_at (13:00Z) + RESPONSE_WINDOW_MINUTES + grace (boundary 15:15Z). Tests whose
// intent is an on-window 'taken' administration seed their turns from this base; the
// default 16:00Z base (kept for the symptom-occurrence pins) derives 'late'.
const ON_WINDOW_RECEIVED_BASE = '2026-08-13T13:30:00Z';

async function seedTurn(
  patient: SeededPatient,
  sequence: number,
  body: string,
  inboundId?: string,
  receivedBase = '2026-08-13T16:00:00Z',
): Promise<SeededTurn> {
  const inbound = await pool.query<{ id: string }>(
    `INSERT INTO inbound_reply
       (id, patient_id, raw_body, received_at, inbound_sequence)
     VALUES (COALESCE($4::uuid, gen_random_uuid()), $1, $2,
             $5::timestamptz + ($3 * interval '1 minute'), $3)
     RETURNING id::text`,
    [patient.id, body, sequence, inboundId ?? null, receivedBase],
  );
  const inboundMessageId = inbound.rows[0]?.id;
  if (inboundMessageId === undefined) throw new Error('inbound_seed_failed');
  const job = await pool.query<{ id: string }>(
    `INSERT INTO turn_job
       (patient_id, inbound_message_id, inbound_sequence, messaging_state_version,
        clinical_context_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id::text`,
    [patient.id, inboundMessageId, sequence, patient.messagingStateVersion, CONTEXT_HASH],
  );
  const turnJobId = job.rows[0]?.id;
  if (turnJobId === undefined) throw new Error('turn_job_seed_failed');
  return {
    patientId: patient.id,
    inboundMessageId,
    turnJobId,
    sequence,
    body,
    messagingStateVersion: patient.messagingStateVersion,
  };
}

function snapshot(
  memory: PatientClinicalMemory,
  turn: SeededTurn,
  overrides: Partial<PatientClinicalSnapshot> = {},
): PatientClinicalSnapshot {
  return {
    memory,
    inboundMessage: {
      id: turn.inboundMessageId,
      sequence: turn.sequence,
      body: turn.body,
    },
    consentEpoch: turn.messagingStateVersion,
    expectedConsentEpoch: turn.messagingStateVersion,
    expectedMemoryVersion: memory.version,
    medications: [],
    doses: [],
    symptomConcepts: ['headache', 'nausea'],
    languageDisposition: 'english',
    emergencyPrefilter: false,
    contextHash: CONTEXT_HASH,
    pipelineVersions: PIPELINE_VERSIONS,
    ...overrides,
  };
}

function symptomClaim(symptom: 'headache' | 'nausea'): ExtractedClaim {
  return {
    slot: `symptom-${symptom}`,
    kind: 'symptom',
    quote: symptom,
    ...ELIGIBLE,
    symptomText: symptom,
  };
}

function sourceSpan(turn: SeededTurn, quote: string) {
  const start = turn.body.indexOf(quote);
  if (start < 0) throw new Error('test_source_quote_missing');
  return {
    messageId: turn.inboundMessageId,
    start,
    end: start + quote.length,
    quote,
  };
}

function parseCommand(intent: Readonly<Record<string, unknown>>): ClinicalIntentCommand {
  return clinicalIntentCommandSchema.parse({
    ...intent,
    id: `command-${sha256(intent).slice(0, 24)}`,
  });
}

async function prepare(
  turn: SeededTurn,
  claims: readonly ExtractedClaim[],
  overrides: Partial<PatientClinicalSnapshot> = {},
): Promise<{
  readonly memory: PatientClinicalMemory;
  readonly prepared: PreparedClinicalTurn;
}> {
  const memory = await loadPatientClinicalMemory(pool, turn.patientId);
  return {
    memory,
    prepared: prepareClinicalTurn(snapshot(memory, turn, overrides), claims),
  };
}

async function prepareFromLiveAuthority(): Promise<LiveAuthorityFixture> {
  const patient = await seedPatient();
  const turn = await seedTurn(patient, 1, 'My headache started.');
  const medication = await pool.query<{ id: string }>(
    `INSERT INTO patient_medication
       (patient_id, entered_name, identity_system, identity_code, dose_text, valid_from,
        status, confirmed_by_clinician_sub, confirmed_at)
     VALUES ($1, 'Metformin', 'rxnorm', '6809', '500 mg', '2026-08-01',
             'active', $2, '2026-08-01T12:00:00Z')
     RETURNING id::text`,
    [patient.id, OWNER_ID],
  );
  const medicationId = medication.rows[0]!.id;
  await pool.query(
    `INSERT INTO patient_medication_ingredient
       (patient_id, patient_medication_id, ingredient_order, ingredient_name, rxcui)
     VALUES ($1, $2, 1, 'metformin', '6809')`,
    [patient.id, medicationId],
  );
  const dose = await pool.query<{ id: string }>(
    `INSERT INTO dose_schedule
       (patient_id, patient_medication_id, scheduled_at, local_dose_time,
        dose_date, schedule_timezone)
     VALUES ($1, $2, '2026-08-13T13:00:00Z', '09:00', '2026-08-13', 'America/Toronto')
     RETURNING id::text`,
    [patient.id, medicationId],
  );
  const fact = await pool.query<{ id: string }>(
    `INSERT INTO clinical_fact
       (patient_id, fact_type, fact_code, statement_text, status,
        authored_by_clinician_sub, created_at)
     VALUES ($1, 'condition', 'diabetes', 'Type 2 diabetes', 'current', $2,
             '2026-08-01T12:00:00Z')
     RETURNING id::text`,
    [patient.id, OWNER_ID],
  );
  const release = await pool.query<{ id: string }>(
    `INSERT INTO source_release
       (source_name, release_version, checksum_sha256, source_url, licence_id,
        state, is_complete, fresh_until, activated_at)
     VALUES ('openfda', $1, $2, 'https://open.fda.gov/', 'CC0-1.0',
             'active', true, '2099-01-01T00:00:00Z', now())
     RETURNING id::text`,
    [`cut-red-07-${phoneCounter}`, 'd'.repeat(64)],
  );
  const releaseId = release.rows[0]!.id;
  sourceReleasesToDelete.add(releaseId);
  await pool.query(
    `INSERT INTO evidence_record
       (source_release_id, evidence_code, evidence_kind, language, passage,
        source_url, coverage_state, tags)
     VALUES ($1, 'metformin-headache', 'label', 'en', 'Headache is listed.',
             'https://open.fda.gov/example', 'direct_evidence', ARRAY['rxcui:6809'])`,
    [releaseId],
  );
  const loaded = await loadConversationJob(pool, {
    inboundMessageId: turn.inboundMessageId,
    requestId: turn.inboundMessageId,
    expectedLanguage: 'en',
    promptVersion: PIPELINE_VERSIONS.extractor,
    schemaVersion: 'conversation-v3',
    includeClinicalSnapshot: true,
  });
  if (loaded?.kind !== 'ready' || loaded.clinicalSnapshot === undefined) {
    throw new Error('live_clinical_snapshot_missing');
  }
  expect(loaded.clinicalSnapshot.medications).toHaveLength(1);
  expect(loaded.clinicalSnapshot.doses).toHaveLength(1);
  expect(loaded.input.clinicalFacts).toHaveLength(1);
  expect(loaded.input.evidence).toHaveLength(1);
  return {
    patient,
    turn,
    prepared: prepareClinicalTurn(loaded.clinicalSnapshot, [symptomClaim('headache')]),
    medicationId,
    doseId: dose.rows[0]!.id,
    factId: fact.rows[0]!.id,
    releaseId,
  };
}

async function loadLiveContextHash(
  client: PoolClient,
  prepared: PreparedClinicalTurn,
): Promise<string | null> {
  return loadClinicalContextHashInTransaction(client, {
    inboundMessageId: prepared.sourceMessageId,
    requestId: prepared.sourceMessageId,
    expectedLanguage: 'en',
    promptVersion: PIPELINE_VERSIONS.extractor,
    schemaVersion: 'conversation-v3',
    includeClinicalSnapshot: true,
  });
}

async function commit(
  database: Pool,
  prepared: PreparedClinicalTurn,
  loadCurrentContextHash: (client: PoolClient) => Promise<string | null> = async () =>
    prepared.contextHash,
) {
  return commitPreparedClinicalTurn(database, prepared, loadCurrentContextHash);
}

async function completeQueueJob(turn: SeededTurn): Promise<void> {
  const completed = await pool.query(
    `UPDATE turn_job SET completed_at = now() WHERE id = $1 AND completed_at IS NULL`,
    [turn.turnJobId],
  );
  expect(completed.rowCount).toBe(1);
}

function prepareResolvedSymptoms(
  memory: PatientClinicalMemory,
  turn: SeededTurn,
): PreparedClinicalTurn {
  const quotes = [
    { quote: 'Nausea left', bodySite: 'left arm' },
    { quote: 'Nausea right', bodySite: 'right arm' },
  ] as const;
  const commands = quotes.map(({ quote, bodySite }, index) => {
    const intent = {
      kind: 'CreateReport' as const,
      sourceMessageId: turn.inboundMessageId,
      sourceSpans: [
        {
          messageId: turn.inboundMessageId,
          start: turn.body.indexOf(quote),
          end: turn.body.indexOf(quote) + quote.length,
          quote,
        },
      ],
      eventKind: 'symptom' as const,
      rawSymptom: 'nausea',
      symptomConcept: 'nausea',
      symptomStatus: 'resolved' as const,
      bodySite,
      frequency: String(index + 1),
    };
    return clinicalIntentCommandSchema.parse({
      ...intent,
      id: `command-${sha256(intent).slice(0, 24)}`,
    });
  });
  const reducerOrderedCommands =
    eventIdForCommand(commands[0]!.id).localeCompare(eventIdForCommand(commands[1]!.id)) < 0
      ? [...commands].reverse()
      : commands;
  return prepareCommands(memory, turn, reducerOrderedCommands);
}

function prepareCommands(
  memory: PatientClinicalMemory,
  turn: SeededTurn,
  commands: readonly ClinicalIntentCommand[],
  responsePlan: PreparedClinicalTurn['responsePlan'] = {
    kind: 'routine',
    acknowledgementId: 'acknowledgement-recorded',
    reviewReasons: [],
  },
): PreparedClinicalTurn {
  const integrity = {
    patientId: turn.patientId,
    idempotencyKey: turn.inboundMessageId,
    sourceMessageId: turn.inboundMessageId,
    sourceSequence: turn.sequence,
    baseMemoryVersion: memory.version,
    consentEpoch: turn.messagingStateVersion,
    contextHash: CONTEXT_HASH,
    pipelineVersions: PIPELINE_VERSIONS,
    commands,
    commandHash: sha256(commands),
    responsePlan,
    responseText: renderClinicalResponse(responsePlan),
  };
  return { ...integrity, preparedHash: sha256(integrity) };
}

async function seedProjectionDoses(patientId: string): Promise<{
  readonly medicationId: string;
  readonly doseAId: string;
  readonly doseBId: string;
}> {
  const medication = await pool.query<{ id: string }>(
    `INSERT INTO patient_medication
       (patient_id, entered_name, identity_system, identity_code, dose_text, valid_from,
        status, confirmed_by_clinician_sub, confirmed_at)
     VALUES ($1, 'Metformin', 'rxnorm', '6809', '500 mg', '2026-08-01',
             'active', $2, '2026-08-01T12:00:00Z')
     RETURNING id::text`,
    [patientId, OWNER_ID],
  );
  const medicationId = medication.rows[0]?.id;
  if (medicationId === undefined) throw new Error('medication_seed_failed');
  const doses = await pool.query<{ id: string; dose_date: string }>(
    `INSERT INTO dose_schedule
       (patient_id, patient_medication_id, scheduled_at, local_dose_time,
        dose_date, schedule_timezone)
     VALUES
       ($1, $2, '2026-08-13T13:00:00Z', '09:00', '2026-08-13', 'America/Toronto'),
       ($1, $2, '2026-08-14T13:00:00Z', '09:00', '2026-08-14', 'America/Toronto')
     RETURNING id::text, dose_date::text`,
    [patientId, medicationId],
  );
  const byDate = new Map(doses.rows.map(({ dose_date, id }) => [dose_date, id]));
  const doseAId = byDate.get('2026-08-13');
  const doseBId = byDate.get('2026-08-14');
  if (doseAId === undefined || doseBId === undefined) throw new Error('dose_seed_failed');
  return { medicationId, doseAId, doseBId };
}

async function seedEventIdentityNeed(): Promise<{
  readonly patient: SeededPatient;
  readonly prepared: PreparedClinicalTurn;
  readonly expected: ReturnType<typeof applyPreparedClinicalTurn>;
}> {
  const patient = await seedPatient();
  const historyTurn = await seedTurn(patient, 1, 'Nausea left. Nausea right.');
  const emptyMemory = await loadPatientClinicalMemory(pool, patient.id);
  await commit(pool, prepareResolvedSymptoms(emptyMemory, historyTurn));
  await completeQueueJob(historyTurn);

  const recurrenceTurn = await seedTurn(patient, 2, 'The nausea came back.');
  const memory = await loadPatientClinicalMemory(pool, patient.id);
  const prepared = prepareClinicalTurn(snapshot(memory, recurrenceTurn), [
    {
      slot: 'recurrence',
      kind: 'recurrence',
      quote: 'nausea came back',
      ...ELIGIBLE,
      symptomText: 'nausea',
    },
  ]);
  return { patient, prepared, expected: applyPreparedClinicalTurn(memory, prepared) };
}

async function patientFingerprint(
  patientId: string,
  database: Pool | PoolClient = pool,
): Promise<unknown> {
  const patient = await database.query<{ row: unknown }>(
    'SELECT to_jsonb(p) AS row FROM patient p WHERE id = $1',
    [patientId],
  );
  const tableNames = await database.query<{ table_name: string }>(
    `SELECT DISTINCT table_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'patient_id'
      ORDER BY table_name`,
  );
  const children: Record<string, unknown[]> = {};
  for (const { table_name: tableName } of tableNames.rows) {
    if (!/^[a-z][a-z0-9_]*$/u.test(tableName)) throw new Error('unsafe_table_name');
    const rows = await database.query<{ row: unknown }>(
      `SELECT to_jsonb(t) AS row
         FROM ${tableName} t
        WHERE patient_id = $1
        ORDER BY to_jsonb(t)::text`,
      [patientId],
    );
    children[tableName] = rows.rows.map(({ row }) => row);
  }
  return { patient: patient.rows[0]?.row, children };
}

async function clinicalVersion(patientId: string): Promise<number> {
  const result = await pool.query<{ clinical_memory_version: string }>(
    'SELECT clinical_memory_version::text FROM patient WHERE id = $1',
    [patientId],
  );
  return Number(result.rows[0]?.clinical_memory_version);
}

async function waitForBlockedApplication(applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_stat_activity
          WHERE application_name = $1 AND wait_event_type = 'Lock'
       ) AS blocked`,
      [applicationName],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected ${applicationName} to wait on a lock`);
}

beforeAll(async () => {
  const ciUrl = process.env.TEST_DATABASE_URL;
  if (ciUrl) {
    databaseUrl = ciUrl;
  } else {
    container = await new PostgreSqlContainer('postgres:16').start();
    databaseUrl = container.getConnectionUri();
  }
  pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const version = await pool.query<{ server_version: string }>('SHOW server_version');
  expect(Number.parseInt(version.rows[0]?.server_version ?? '', 10)).toBe(16);
  await pool.query(SCHEMA_SQL);
}, CONTAINER_TIMEOUT_MS);

afterEach(async () => {
  const ids = [...patientsToDelete];
  patientsToDelete.clear();
  if (ids.length > 0) await pool.query('DELETE FROM patient WHERE id = ANY($1::uuid[])', [ids]);
  const releaseIds = [...sourceReleasesToDelete];
  sourceReleasesToDelete.clear();
  if (releaseIds.length > 0) {
    await pool.query('DELETE FROM source_release WHERE id = ANY($1::uuid[])', [releaseIds]);
  }
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('patient clinical memory repository against PostgreSQL 16', () => {
  it('round-trips a targetless event-identity need in reducer order with durable scope', async () => {
    const { patient, prepared, expected } = await seedEventIdentityNeed();
    const eventIdentityNeed = expected.memory.needs.find(({ field }) => field === 'event_identity');
    if (eventIdentityNeed === undefined) throw new Error('expected_event_identity_need');

    await commit(pool, prepared);
    const loaded = await loadPatientClinicalMemory(pool, patient.id);

    expect(loaded).toEqual(expected.memory);
    expect(loaded.events.map(({ id }) => id)).toEqual(expected.memory.events.map(({ id }) => id));
    expect(eventIdentityNeed).toMatchObject({
      state: 'asked',
      candidateHistoricalEvents: expect.arrayContaining([
        expect.objectContaining({ eventVersion: 1 }),
        expect.objectContaining({ eventVersion: 1 }),
      ]),
      pendingOperation: expect.objectContaining({ kind: 'recur' }),
    });
    expect(eventIdentityNeed).not.toHaveProperty('targetEventId');
    expect(eventIdentityNeed).not.toHaveProperty('targetEventVersion');

    const stored = await pool.query<{
      target_clinical_event_id: string | null;
      target_event_semantic_id: string | null;
      target_event_version: number | null;
      requested_field: string;
      scope_payload: unknown;
      candidates: unknown;
    }>(
      `SELECT need.target_clinical_event_id::text,
              need.target_event_semantic_id,
              need.target_event_version,
              need.requested_field,
              scope.scope_payload,
              jsonb_agg(
                jsonb_build_object(
                  'eventId', candidate.candidate_event_semantic_id,
                  'eventVersion', candidate.candidate_event_version
                ) ORDER BY candidate.candidate_order
              ) AS candidates
         FROM information_need need
         JOIN information_need_scope scope ON scope.information_need_id = need.id
         JOIN information_need_event_candidate candidate ON candidate.information_need_id = need.id
        WHERE need.patient_id = $1 AND need.semantic_need_id = $2
        GROUP BY need.id, scope.scope_payload`,
      [patient.id, eventIdentityNeed.id],
    );
    expect(stored.rows).toEqual([
      {
        target_clinical_event_id: null,
        target_event_semantic_id: null,
        target_event_version: null,
        requested_field: 'event_identity',
        scope_payload: expect.objectContaining({
          candidateHistoricalEvents: eventIdentityNeed.candidateHistoricalEvents,
          pendingOperation: eventIdentityNeed.pendingOperation,
        }),
        candidates: eventIdentityNeed.candidateHistoricalEvents,
      },
    ]);
  });

  it('rejects stale-version and cross-patient event candidates in PostgreSQL', async () => {
    const { patient, prepared, expected } = await seedEventIdentityNeed();
    await commit(pool, prepared);
    const need = expected.memory.needs.find(({ field }) => field === 'event_identity');
    if (need === undefined) throw new Error('expected_event_identity_need');
    const otherPatient = await seedPatient();
    const otherTurn = await seedTurn(otherPatient, 1, 'Nausea left. Nausea right.');
    const otherMemory = await loadPatientClinicalMemory(pool, otherPatient.id);
    await commit(pool, prepareResolvedSymptoms(otherMemory, otherTurn));

    const candidateInsert = `INSERT INTO information_need_event_candidate
       (patient_id, information_need_id, candidate_order, clinical_event_id,
        candidate_event_semantic_id, candidate_event_version)
     SELECT $1, need.id, 127, event.id, event.semantic_event_id, $4
       FROM information_need need
       JOIN clinical_event event ON event.patient_id = $2 AND event.semantic_event_id = $3
      WHERE need.patient_id = $1 AND need.semantic_need_id = $5`;
    const firstCandidate = need.candidateHistoricalEvents?.[0];
    if (firstCandidate === undefined) throw new Error('expected_event_candidate');

    await expect(
      pool.query(candidateInsert, [
        patient.id,
        patient.id,
        firstCandidate.eventId,
        firstCandidate.eventVersion + 1,
        need.id,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
    const otherEvent = await pool.query<{
      semantic_event_id: string;
      semantic_event_version: number;
    }>(
      `SELECT semantic_event_id, semantic_event_version
         FROM clinical_event
        WHERE patient_id = $1 AND semantic_event_id IS NOT NULL
        ORDER BY semantic_event_id LIMIT 1`,
      [otherPatient.id],
    );
    const otherCandidate = otherEvent.rows[0];
    if (otherCandidate === undefined) throw new Error('expected_other_event');
    await expect(
      pool.query(candidateInsert, [
        patient.id,
        otherPatient.id,
        otherCandidate.semantic_event_id,
        otherCandidate.semantic_event_version,
        need.id,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('atomically persists and reloads events, needs, unresolved review, batch, and outbox', async () => {
    const patient = await seedPatient();
    const turn = await seedTurn(patient, 1, 'My headache started. I maybe took the tablet.');
    const claims: ExtractedClaim[] = [
      symptomClaim('headache'),
      {
        slot: 'uncertain-administration',
        kind: 'administration',
        quote: 'maybe took',
        ...ELIGIBLE,
        certainty: 'uncertain',
        actionText: 'took',
      },
    ];
    const { memory, prepared } = await prepare(turn, claims);
    const expected = applyPreparedClinicalTurn(memory, prepared);
    const questionNeedId = prepared.responsePlan.question?.needId;
    if (questionNeedId === undefined) throw new Error('expected_question_response');

    const committed = await commit(pool, prepared);
    const loaded = await loadPatientClinicalMemory(pool, patient.id);

    expect(committed).toEqual(expected);
    expect(loaded).toEqual(expected.memory);
    expect(loaded).toMatchObject({
      version: 1,
      routineClarificationsPaused: false,
      events: [expect.objectContaining({ kind: 'symptom', canonical: true })],
      needs: [
        expect.objectContaining({
          field: 'severity',
          state: 'asked',
          clarificationAttemptUsed: true,
          candidateSymptomEventIds: [expected.memory.events[0]!.id],
        }),
      ],
      unresolvedReports: [expect.objectContaining({ reason: 'uncertain_administration' })],
      reviewItems: [
        expect.objectContaining({ kind: 'unresolved_report', reason: 'uncertain_administration' }),
      ],
      processedBatches: [
        expect.objectContaining({
          idempotencyKey: turn.inboundMessageId,
          commandHash: prepared.commandHash,
          preparedHash: prepared.preparedHash,
          baseVersion: 0,
          resultVersion: 1,
        }),
      ],
    });

    const storedTurn = await pool.query<{
      prepared_command_batch: unknown;
      prepared_batch_hash: string;
      prepared_command_count: number;
      base_version: string;
      result_version: string;
      context_hash: string;
      extractor_version: string;
      resolver_version: string;
      reducer_version: string;
      renderer_version: string;
      completed_at: Date | null;
    }>(
      `SELECT at.prepared_command_batch,
              at.prepared_batch_hash,
              at.prepared_command_count,
              at.base_clinical_memory_version::text AS base_version,
              at.result_clinical_memory_version::text AS result_version,
              at.clinical_context_hash AS context_hash,
              at.extractor_version,
              at.resolver_version,
              at.reducer_version,
              at.renderer_version,
              tj.completed_at
         FROM agent_turn at
         JOIN turn_job tj ON tj.id = at.turn_job_id
        WHERE at.patient_id = $1`,
      [patient.id],
    );
    expect(storedTurn.rows).toEqual([
      {
        prepared_command_batch: prepared.commands,
        prepared_batch_hash: prepared.preparedHash,
        prepared_command_count: prepared.commands.length,
        base_version: '0',
        result_version: '1',
        context_hash: prepared.contextHash,
        extractor_version: PIPELINE_VERSIONS.extractor,
        resolver_version: PIPELINE_VERSIONS.resolver,
        reducer_version: PIPELINE_VERSIONS.reducer,
        renderer_version: PIPELINE_VERSIONS.renderer,
        completed_at: null,
      },
    ]);

    const eventRows = await pool.query<{
      semantic_event_id: string;
      semantic_event_version: number;
      authored_by: string;
      review_state: string;
      clinical_operation: string;
      source_spans: unknown;
    }>(
      `SELECT semantic_event_id, semantic_event_version, authored_by, review_state,
              clinical_operation, source_spans
         FROM clinical_event
        WHERE patient_id = $1`,
      [patient.id],
    );
    expect(eventRows.rows).toEqual([
      expect.objectContaining({
        semantic_event_id: expected.memory.events[0]!.id,
        semantic_event_version: 1,
        authored_by: 'patient',
        review_state: 'unreviewed',
        clinical_operation: 'create',
        source_spans: expected.memory.events[0]!.sourceSpans,
      }),
    ]);

    const needRows = await pool.query<{
      semantic_need_id: string;
      target_event_semantic_id: string;
      scope_payload: unknown;
      states: string[];
    }>(
      `SELECT n.semantic_need_id,
              n.target_event_semantic_id,
              s.scope_payload,
              array_agg(t.to_state ORDER BY t.transition_version) AS states
         FROM information_need n
         JOIN information_need_scope s ON s.information_need_id = n.id
         JOIN information_need_transition t ON t.information_need_id = n.id
        WHERE n.patient_id = $1
        GROUP BY n.id, s.scope_payload`,
      [patient.id],
    );
    expect(needRows.rows).toEqual([
      {
        semantic_need_id: expected.memory.needs[0]!.id,
        target_event_semantic_id: expected.memory.events[0]!.id,
        scope_payload: {
          candidateMedicationIds: [],
          candidateDoseIds: [],
          candidateSymptomEventIds: [expected.memory.events[0]!.id],
          candidateHistoricalEventIds: [],
          candidateHistoricalEvents: [],
          pendingOperation: null,
        },
        states: ['open', 'asked'],
      },
    ]);

    const outbound = await pool.query<{
      body: string;
      status: string;
      message_kind: string;
      in_reply_to_inbound_id: string;
      semantic_need_id: string | null;
      consent_epoch: string;
    }>(
      `SELECT om.body,
              om.status,
              om.message_kind,
              om.in_reply_to_inbound_id::text,
              n.semantic_need_id,
              om.messaging_consent_epoch::text AS consent_epoch
         FROM outbound_message om
         LEFT JOIN information_need n ON n.id = om.asked_information_need_id
        WHERE om.patient_id = $1`,
      [patient.id],
    );
    expect(outbound.rows).toEqual([
      {
        body: prepared.responseText,
        status: 'prepared',
        message_kind: 'clarification',
        in_reply_to_inbound_id: turn.inboundMessageId,
        semantic_need_id: questionNeedId,
        consent_epoch: String(turn.messagingStateVersion),
      },
    ]);
  });

  it('round-trips two unresolved reports with the same reason without conflating review links', async () => {
    const patient = await seedPatient();
    const turn = await seedTurn(patient, 1, 'I maybe took alpha. I maybe took beta.');
    const claims: ExtractedClaim[] = ['alpha', 'beta'].map((medication) => ({
      slot: `uncertain-${medication}`,
      kind: 'administration' as const,
      quote: `maybe took ${medication}`,
      ...ELIGIBLE,
      certainty: 'uncertain' as const,
      medicationText: medication,
      actionText: 'took',
    }));
    const { memory, prepared } = await prepare(turn, claims);
    const expected = applyPreparedClinicalTurn(memory, prepared);

    expect(expected.memory.unresolvedReports).toHaveLength(2);
    expect(expected.memory.unresolvedReports.map(({ reason }) => reason)).toEqual([
      'uncertain_administration',
      'uncertain_administration',
    ]);

    await commit(pool, prepared);

    expect(await loadPatientClinicalMemory(pool, patient.id)).toEqual(expected.memory);
  });

  it('pins a correction event primary source to the correcting inbound, not UUID sort order', async () => {
    const patient = await seedPatient();
    const originalTurn = await seedTurn(
      patient,
      1,
      'I have nausea.',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    );
    const original = await prepare(originalTurn, [symptomClaim('nausea')]);
    await commit(pool, original.prepared);
    await completeQueueJob(originalTurn);

    const correctionTurn = await seedTurn(
      patient,
      2,
      'Correction: it was headache, not nausea.',
      '00000000-0000-4000-8000-000000000001',
    );
    const correction = await prepare(correctionTurn, [
      {
        slot: 'correction',
        kind: 'correction',
        quote: 'it was headache, not nausea',
        ...ELIGIBLE,
        symptomText: 'headache',
        targetText: 'nausea',
      },
    ]);
    const expected = applyPreparedClinicalTurn(correction.memory, correction.prepared);
    const successor = expected.memory.events.find(({ operation }) => operation === 'correct');
    if (successor === undefined) throw new Error('expected_correction_successor');

    await commit(pool, correction.prepared);

    const stored = await pool.query<{ source_inbound_id: string }>(
      `SELECT source_inbound_id::text
         FROM clinical_event
        WHERE patient_id = $1 AND semantic_event_id = $2`,
      [patient.id, successor.id],
    );
    expect(stored.rows).toEqual([{ source_inbound_id: correctionTurn.inboundMessageId }]);
    expect(await loadPatientClinicalMemory(pool, patient.id)).toEqual(expected.memory);
  });

  it('projects only the final symptom leaf from a same-batch correction and replays exactly', async () => {
    const patient = await seedPatient();
    const turn = await seedTurn(patient, 1, 'I have nausea. Correction: headache.');
    const create = parseCommand({
      kind: 'CreateReport',
      sourceMessageId: turn.inboundMessageId,
      sourceSpans: [sourceSpan(turn, 'nausea')],
      eventKind: 'symptom',
      rawSymptom: 'nausea',
      symptomConcept: 'nausea',
      symptomStatus: 'current',
    });
    const createEventId = eventIdForCommand(create.id);
    const correction = parseCommand({
      kind: 'CorrectReport',
      sourceMessageId: turn.inboundMessageId,
      sourceSpans: [sourceSpan(turn, 'headache')],
      targetEventId: createEventId,
      targetEventVersion: 1,
      targetKind: 'symptom',
      rawSymptom: 'headache',
      symptomConcept: 'headache',
      symptomStatus: 'current',
    });
    const correctionEventId = eventIdForCommand(correction.id);
    const prepared = prepareCommands(await loadPatientClinicalMemory(pool, patient.id), turn, [
      create,
      correction,
    ]);

    const committed = await commit(pool, prepared);

    expect(committed.memory.events).toEqual([
      expect.objectContaining({ id: createEventId, current: false }),
      expect.objectContaining({
        id: correctionEventId,
        current: true,
        supersedesEventId: createEventId,
        symptomConcept: 'headache',
      }),
    ]);
    const events = await pool.query<{
      id: string;
      semantic_event_id: string;
      current: boolean;
    }>(
      `SELECT event.id::text,
              event.semantic_event_id,
              NOT EXISTS (
                SELECT 1 FROM clinical_event successor
                 WHERE successor.patient_id = event.patient_id
                   AND successor.supersedes_id = event.id
              ) AS current
         FROM clinical_event event
        WHERE event.patient_id = $1 AND event.semantic_event_id = ANY($2::varchar[])
        ORDER BY event.semantic_event_version`,
      [patient.id, [createEventId, correctionEventId]],
    );
    expect(events.rows).toEqual([
      { id: expect.any(String), semantic_event_id: createEventId, current: false },
      { id: expect.any(String), semantic_event_id: correctionEventId, current: true },
    ]);
    const summary = await pool.query<{
      event_count: number;
      structured_payload: { readonly eventIds: readonly string[]; readonly symptomCount: number };
    }>(
      `SELECT event_count, structured_payload
         FROM daily_summary
        WHERE patient_id = $1 AND local_date = '2026-08-13'
        ORDER BY version DESC
        LIMIT 1`,
      [patient.id],
    );
    expect(summary.rows).toEqual([
      {
        event_count: 1,
        structured_payload: expect.objectContaining({
          eventIds: [events.rows[1]!.id],
          symptomCount: 1,
        }),
      },
    ]);
    expect(
      await pool.query('SELECT 1 FROM adherence_record WHERE patient_id = $1', [patient.id]),
    ).toMatchObject({ rowCount: 0 });
    const afterCommit = await patientFingerprint(patient.id);
    expect(await commit(pool, prepared)).toEqual(committed);
    expect(await patientFingerprint(patient.id)).toEqual(afterCommit);
  });

  // Lane W (2026-08-17): the semantic layer owns the kind vocabulary
  // ('administration' | 'symptom' | 'safety' | 'contradiction'); clinical_event.event_type is
  // the CLINICAL RECORD's vocabulary, which the dashboard read contract, the schema.sql base
  // CHECK and daily-summary's structured payload all spell 'patient_statement' for a
  // patient-reported symptom. The writer projects at the storage seam so no NEW legacy-spelled
  // row can be created; the ones already stored are permanent (append-only table) and are
  // projected on read instead.
  it('stores a symptom event under the clinical-record vocabulary while the semantic kind stays symptom', async () => {
    const patient = await seedPatient();
    const turn = await seedTurn(patient, 1, 'I have headache.');
    const { prepared } = await prepare(turn, [symptomClaim('headache')]);

    const committed = await commit(pool, prepared);

    expect(committed.memory.events).toEqual([expect.objectContaining({ kind: 'symptom' })]);
    const stored = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM clinical_event
        WHERE patient_id = $1 AND semantic_event_id IS NOT NULL`,
      [patient.id],
    );
    expect(stored.rows).toEqual([{ event_type: 'patient_statement' }]);
    expect(await loadPatientClinicalMemory(pool, patient.id)).toEqual(committed.memory);
  });

  // Replay safety: a FIFO redrive of an already-committed turn must reload the SAME semantic
  // memory on either side of the writer-projection boundary, or the reducer would see a different
  // `kind` (and a different context hash) and re-persist the event under a new identity.
  it('reloads a legacy event_type=symptom row as the same semantic event and replays without writes', async () => {
    const patient = await seedPatient();
    const turn = await seedTurn(patient, 1, 'I have nausea.');
    const { prepared } = await prepare(turn, [symptomClaim('nausea')]);
    const committed = await commit(pool, prepared);

    // clinical_event is append-only (reject_immutable_update trigger), so the ONLY way to model a
    // row as the PREVIOUS deployed writer left it is to bypass the trigger for this one fixture
    // statement. Nothing in production may do this — which is exactly why those rows are permanent
    // and are projected on read instead of being backfilled.
    await pool.query('ALTER TABLE clinical_event DISABLE TRIGGER reject_immutable_update');
    try {
      const reverted = await pool.query(
        `UPDATE clinical_event SET event_type = 'symptom'
          WHERE patient_id = $1 AND event_type = 'patient_statement'`,
        [patient.id],
      );
      expect(reverted.rowCount).toBe(1);
    } finally {
      await pool.query('ALTER TABLE clinical_event ENABLE TRIGGER reject_immutable_update');
    }
    expect(
      await pool.query(
        `SELECT event_type FROM clinical_event
          WHERE patient_id = $1 AND semantic_event_id IS NOT NULL`,
        [patient.id],
      ),
    ).toMatchObject({ rows: [{ event_type: 'symptom' }] });

    expect(await loadPatientClinicalMemory(pool, patient.id)).toEqual(committed.memory);
    const afterRevert = await patientFingerprint(patient.id);
    expect(await commit(pool, prepared)).toEqual(committed);
    expect(await patientFingerprint(patient.id)).toEqual(afterRevert);
  });

  it('preserves a symptom occurrence across a later-day refinement and rebuilds only its original date', async () => {
    const patient = await seedPatient();
    const originalTurn = await seedTurn(patient, 1, 'I have nausea.');
    const original = await prepare(originalTurn, [symptomClaim('nausea')]);
    const originalCommitted = await commit(pool, original.prepared);
    const originalEvent = originalCommitted.memory.events.find(({ kind }) => kind === 'symptom');
    if (originalEvent === undefined) throw new Error('original_symptom_missing');
    await completeQueueJob(originalTurn);

    const refinementTurn = await seedTurn(patient, 2, 'The severity is 7.');
    await pool.query(
      `UPDATE inbound_reply
          SET received_at = '2026-08-14T16:00:00Z'
        WHERE patient_id = $1 AND id = $2`,
      [patient.id, refinementTurn.inboundMessageId],
    );
    const refinement = parseCommand({
      kind: 'RefineReport',
      sourceMessageId: refinementTurn.inboundMessageId,
      sourceSpans: [sourceSpan(refinementTurn, '7')],
      targetEventId: originalEvent.id,
      targetEventVersion: originalEvent.version,
      targetKind: 'symptom',
      severity: '7',
    });
    const refinementEventId = eventIdForCommand(refinement.id);
    const prepared = prepareCommands(
      await loadPatientClinicalMemory(pool, patient.id),
      refinementTurn,
      [refinement],
    );

    const committed = await commit(pool, prepared);

    const stored = await pool.query<{
      semantic_event_id: string;
      occurred_at: Date | null;
      local_date: string | null;
      patient_timezone: string | null;
    }>(
      `SELECT semantic_event_id, occurred_at, local_date::text, patient_timezone
         FROM clinical_event
        WHERE patient_id = $1 AND semantic_event_id = ANY($2::varchar[])
        ORDER BY semantic_event_version`,
      [patient.id, [originalEvent.id, refinementEventId]],
    );
    expect(
      stored.rows.map(({ semantic_event_id, occurred_at, local_date, patient_timezone }) => ({
        semantic_event_id,
        occurred_at: occurred_at?.toISOString() ?? null,
        local_date,
        patient_timezone,
      })),
    ).toEqual([
      {
        semantic_event_id: originalEvent.id,
        occurred_at: '2026-08-13T16:01:00.000Z',
        local_date: '2026-08-13',
        patient_timezone: 'America/Toronto',
      },
      {
        semantic_event_id: refinementEventId,
        occurred_at: '2026-08-13T16:01:00.000Z',
        local_date: '2026-08-13',
        patient_timezone: 'America/Toronto',
      },
    ]);
    const summaries = await pool.query<{
      local_date: string;
      version: number;
      event_count: number;
      structured_payload: {
        readonly eventIds: readonly string[];
        readonly events: readonly { readonly severity: number | null }[];
      };
    }>(
      `SELECT local_date::text, version, event_count, structured_payload
         FROM daily_summary
        WHERE patient_id = $1
        ORDER BY local_date, version`,
      [patient.id],
    );
    expect(summaries.rows).toHaveLength(2);
    expect(
      summaries.rows.map(({ local_date, version, event_count }) => ({
        local_date,
        version,
        event_count,
      })),
    ).toEqual([
      { local_date: '2026-08-13', version: 1, event_count: 1 },
      { local_date: '2026-08-13', version: 2, event_count: 1 },
    ]);
    const successor = await pool.query<{ id: string }>(
      'SELECT id::text FROM clinical_event WHERE patient_id = $1 AND semantic_event_id = $2',
      [patient.id, refinementEventId],
    );
    expect(summaries.rows[1]!.structured_payload).toMatchObject({
      eventIds: [successor.rows[0]!.id],
      events: [expect.objectContaining({ severity: 7 })],
    });
    const afterCommit = await patientFingerprint(patient.id);
    expect(await commit(pool, prepared)).toEqual(committed);
    expect(await patientFingerprint(patient.id)).toEqual(afterCommit);
  });

  it('does not invent a receipt-time occurrence for an unresolved historical symptom', async () => {
    const patient = await seedPatient();
    const turn = await seedTurn(patient, 1, 'I had nausea yesterday.');
    const command = parseCommand({
      kind: 'CreateReport',
      sourceMessageId: turn.inboundMessageId,
      sourceSpans: [sourceSpan(turn, 'nausea')],
      eventKind: 'symptom',
      rawSymptom: 'nausea',
      symptomConcept: 'nausea',
      symptomStatus: 'historical',
      timeText: 'yesterday',
    });
    const prepared = prepareCommands(await loadPatientClinicalMemory(pool, patient.id), turn, [
      command,
    ]);

    const committed = await commit(pool, prepared);

    expect(committed.memory.events).toEqual([
      expect.objectContaining({
        kind: 'symptom',
        symptomStatus: 'historical',
        timeText: 'yesterday',
      }),
    ]);
    const stored = await pool.query<{
      occurred_at: Date | null;
      local_date: string | null;
      local_time: string | null;
      patient_timezone: string | null;
    }>(
      `SELECT occurred_at, local_date::text, local_time, patient_timezone
         FROM clinical_event
        WHERE patient_id = $1 AND semantic_event_id IS NOT NULL`,
      [patient.id],
    );
    expect(stored.rows).toEqual([
      {
        occurred_at: null,
        local_date: null,
        local_time: null,
        patient_timezone: 'America/Toronto',
      },
    ]);
    expect(
      await pool.query('SELECT 1 FROM daily_summary WHERE patient_id = $1', [patient.id]),
    ).toMatchObject({ rowCount: 0 });
  });

  it('atomically rebuilds both affected local dates from canonical current leaves when a correction moves an administration report', async () => {
    const patient = await seedPatient();
    const medication = await pool.query<{ id: string }>(
      `INSERT INTO patient_medication
         (patient_id, entered_name, identity_system, identity_code, dose_text, valid_from,
          status, confirmed_by_clinician_sub, confirmed_at)
       VALUES ($1, 'Metformin', 'rxnorm', '6809', '500 mg', '2026-08-01',
               'active', $2, '2026-08-01T12:00:00Z')
       RETURNING id::text`,
      [patient.id, OWNER_ID],
    );
    const medicationId = medication.rows[0]?.id;
    if (medicationId === undefined) throw new Error('medication_seed_failed');
    const doseA = await pool.query<{ id: string }>(
      `INSERT INTO dose_schedule
         (patient_id, patient_medication_id, scheduled_at, local_dose_time,
          dose_date, schedule_timezone)
       VALUES ($1, $2, '2026-08-13T13:00:00Z', '09:00', '2026-08-13', 'America/Toronto')
       RETURNING id::text`,
      [patient.id, medicationId],
    );
    const doseAId = doseA.rows[0]?.id;
    if (doseAId === undefined) throw new Error('dose_a_seed_failed');
    const doseB = await pool.query<{ id: string }>(
      `INSERT INTO dose_schedule
         (patient_id, patient_medication_id, scheduled_at, local_dose_time,
          dose_date, schedule_timezone)
       VALUES ($1, $2, '2026-08-14T13:00:00Z', '09:00', '2026-08-14', 'America/Toronto')
       RETURNING id::text`,
      [patient.id, medicationId],
    );
    const doseBId = doseB.rows[0]?.id;
    if (doseBId === undefined) throw new Error('dose_b_seed_failed');

    const originalTurn = await seedTurn(
      patient,
      1,
      'I took the August 13 dose.',
      undefined,
      ON_WINDOW_RECEIVED_BASE,
    );
    const originalQuote = 'I took the August 13 dose';
    const originalIntent = {
      kind: 'CreateReport' as const,
      sourceMessageId: originalTurn.inboundMessageId,
      sourceSpans: [
        {
          messageId: originalTurn.inboundMessageId,
          start: originalTurn.body.indexOf(originalQuote),
          end: originalTurn.body.indexOf(originalQuote) + originalQuote.length,
          quote: originalQuote,
        },
      ],
      eventKind: 'administration' as const,
      medicationId,
      medicationVersion: 1,
      doseId: doseAId,
      doseVersion: 1,
      adherence: 'taken' as const,
      timing: 'on_time' as const,
      localDate: '2026-08-13',
      localTime: '09:00',
    };
    const originalCommand = clinicalIntentCommandSchema.parse({
      ...originalIntent,
      id: `command-${sha256(originalIntent).slice(0, 24)}`,
    });
    const originalPrepared = prepareCommands(
      await loadPatientClinicalMemory(pool, patient.id),
      originalTurn,
      [originalCommand],
    );
    const originalCommitted = await commit(pool, originalPrepared);
    const originalEventId = eventIdForCommand(originalCommand.id);
    expect(originalCommitted.memory.events).toEqual([
      expect.objectContaining({
        id: originalEventId,
        current: true,
        kind: 'administration',
        adherence: 'taken',
        timing: 'on_time',
        localDate: '2026-08-13',
        doseId: doseAId,
      }),
    ]);
    const originalPhysical = await pool.query<{ id: string; row: unknown }>(
      `SELECT id::text, to_jsonb(event) AS row
         FROM clinical_event event
        WHERE patient_id = $1 AND semantic_event_id = $2`,
      [patient.id, originalEventId],
    );
    const originalPhysicalId = originalPhysical.rows[0]?.id;
    const originalPhysicalRow = originalPhysical.rows[0]?.row;
    if (originalPhysicalId === undefined || originalPhysicalRow === undefined)
      throw new Error('original_event_not_persisted');
    await completeQueueJob(originalTurn);

    const correctionTurn = await seedTurn(patient, 2, 'Correction: I took the August 14 dose.');
    const correctionQuote = 'I took the August 14 dose';
    const correctionIntent = {
      kind: 'CorrectReport' as const,
      sourceMessageId: correctionTurn.inboundMessageId,
      sourceSpans: [
        {
          messageId: correctionTurn.inboundMessageId,
          start: correctionTurn.body.indexOf(correctionQuote),
          end: correctionTurn.body.indexOf(correctionQuote) + correctionQuote.length,
          quote: correctionQuote,
        },
      ],
      targetEventId: originalEventId,
      targetEventVersion: 1,
      targetKind: 'administration' as const,
      medicationId,
      medicationVersion: 1,
      doseId: doseBId,
      doseVersion: 1,
      adherence: 'taken' as const,
      timing: 'on_time' as const,
      localDate: '2026-08-14',
      localTime: '09:00',
    };
    const correctionCommand = clinicalIntentCommandSchema.parse({
      ...correctionIntent,
      id: `command-${sha256(correctionIntent).slice(0, 24)}`,
    });
    const correctionPrepared = prepareCommands(
      await loadPatientClinicalMemory(pool, patient.id),
      correctionTurn,
      [correctionCommand],
    );
    const beforeCorrection = await patientFingerprint(patient.id);

    await pool.query(`CREATE OR REPLACE FUNCTION test_fail_cross_date_projection()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'fault_injected_after_projection';
      END;
    $$`);
    await pool.query(`CREATE TRIGGER test_fault_cross_date_projection
      BEFORE INSERT ON outbound_message
      FOR EACH ROW EXECUTE FUNCTION test_fail_cross_date_projection()`);
    try {
      await expect(commit(pool, correctionPrepared)).rejects.toThrow(
        'fault_injected_after_projection',
      );
      expect(await patientFingerprint(patient.id)).toEqual(beforeCorrection);
    } finally {
      await pool.query('DROP TRIGGER test_fault_cross_date_projection ON outbound_message');
    }

    const correctionCommitted = await commit(pool, correctionPrepared);
    const correctionEventId = eventIdForCommand(correctionCommand.id);
    expect(correctionCommitted.memory.events).toEqual([
      expect.objectContaining({ id: originalEventId, current: false }),
      expect.objectContaining({
        id: correctionEventId,
        current: true,
        kind: 'administration',
        adherence: 'taken',
        timing: 'on_time',
        localDate: '2026-08-14',
        doseId: doseBId,
        supersedesEventId: originalEventId,
      }),
    ]);
    const unchangedOriginal = await pool.query<{ row: unknown }>(
      `SELECT to_jsonb(event) AS row
         FROM clinical_event event
        WHERE patient_id = $1 AND semantic_event_id = $2`,
      [patient.id, originalEventId],
    );
    expect(unchangedOriginal.rows).toEqual([{ row: originalPhysicalRow }]);

    const canonicalEvents = await pool.query<{
      id: string;
      semantic_event_id: string;
      semantic_event_version: number;
      event_type: string;
      clinical_operation: string;
      local_date: string;
      dose_id: string;
      current: boolean;
    }>(
      `SELECT event.id::text,
              event.semantic_event_id,
              event.semantic_event_version,
              event.event_type,
              event.clinical_operation,
              event.local_date::text,
              event.dose_id::text,
              NOT EXISTS (
                SELECT 1
                  FROM clinical_event successor
                 WHERE successor.patient_id = event.patient_id
                   AND successor.supersedes_id = event.id
              ) AS current
         FROM clinical_event event
        WHERE event.patient_id = $1 AND event.semantic_event_id IS NOT NULL
        ORDER BY event.semantic_event_version, event.created_at, event.id`,
      [patient.id],
    );
    expect(canonicalEvents.rows).toEqual([
      {
        id: originalPhysicalId,
        semantic_event_id: originalEventId,
        semantic_event_version: 1,
        event_type: 'administration',
        clinical_operation: 'create',
        local_date: '2026-08-13',
        dose_id: doseAId,
        current: false,
      },
      {
        id: expect.any(String),
        semantic_event_id: correctionEventId,
        semantic_event_version: 2,
        event_type: 'administration',
        clinical_operation: 'correct',
        local_date: '2026-08-14',
        dose_id: doseBId,
        current: true,
      },
    ]);
    const correctionPhysicalId = canonicalEvents.rows[1]?.id;
    if (correctionPhysicalId === undefined) throw new Error('correction_event_not_persisted');

    const summaries = await pool.query<{
      id: string;
      local_date: string;
      version: number;
      event_count: number;
      highest_tier: string;
      structured_payload: {
        readonly eventIds: readonly string[];
        readonly adherenceCounts: Readonly<Record<string, number>>;
      };
      supersedes_id: string | null;
    }>(
      `SELECT id::text, local_date::text, version, event_count, highest_tier,
              structured_payload, supersedes_id::text
         FROM daily_summary
        WHERE patient_id = $1
        ORDER BY local_date, version`,
      [patient.id],
    );
    expect(summaries.rows).toHaveLength(3);
    expect(summaries.rows[0]).toMatchObject({
      local_date: '2026-08-13',
      version: 1,
      event_count: 1,
      highest_tier: 'routine',
      structured_payload: {
        eventIds: [originalPhysicalId],
        adherenceCounts: { taken: 1 },
      },
      supersedes_id: null,
    });
    expect(summaries.rows[1]).toMatchObject({
      local_date: '2026-08-13',
      version: 2,
      event_count: 0,
      highest_tier: 'none',
      structured_payload: {
        eventIds: [],
        adherenceCounts: { taken: 0 },
      },
      supersedes_id: summaries.rows[0]!.id,
    });
    expect(summaries.rows[2]).toMatchObject({
      local_date: '2026-08-14',
      version: 1,
      event_count: 1,
      highest_tier: 'routine',
      structured_payload: {
        eventIds: [correctionPhysicalId],
        adherenceCounts: { taken: 1 },
      },
      supersedes_id: null,
    });

    const adherence = await pool.query<{
      dose_id: string;
      inbound_message_id: string;
      adherence_state: string;
    }>(
      `SELECT dose_id::text, inbound_message_id::text, adherence_state::text
         FROM adherence_record
        WHERE patient_id = $1
        ORDER BY dose_id`,
      [patient.id],
    );
    expect(adherence.rows).toEqual([
      {
        dose_id: doseBId,
        inbound_message_id: correctionTurn.inboundMessageId,
        adherence_state: 'taken',
      },
    ]);

    const afterCorrection = await patientFingerprint(patient.id);
    expect(await commit(pool, correctionPrepared)).toEqual(correctionCommitted);
    expect(await patientFingerprint(patient.id)).toEqual(afterCorrection);
  });

  it('collapses same-batch administration successors into one pre-turn projection transition', async () => {
    const patient = await seedPatient();
    const { medicationId, doseAId, doseBId } = await seedProjectionDoses(patient.id);
    const originalTurn = await seedTurn(patient, 1, 'I took the August 13 dose.');
    const original = parseCommand({
      kind: 'CreateReport',
      sourceMessageId: originalTurn.inboundMessageId,
      sourceSpans: [sourceSpan(originalTurn, 'I took the August 13 dose')],
      eventKind: 'administration',
      medicationId,
      medicationVersion: 1,
      doseId: doseAId,
      doseVersion: 1,
      adherence: 'taken',
      timing: 'on_time',
      localDate: '2026-08-13',
      localTime: '09:00',
    });
    const originalEventId = eventIdForCommand(original.id);
    await commit(
      pool,
      prepareCommands(await loadPatientClinicalMemory(pool, patient.id), originalTurn, [original]),
    );
    await completeQueueJob(originalTurn);

    const correctionTurn = await seedTurn(
      patient,
      2,
      'It was exactly 9 AM. Correction: it was the August 14 dose.',
    );
    const refinement = parseCommand({
      kind: 'RefineReport',
      sourceMessageId: correctionTurn.inboundMessageId,
      sourceSpans: [sourceSpan(correctionTurn, 'exactly 9 AM')],
      targetEventId: originalEventId,
      targetEventVersion: 1,
      targetKind: 'administration',
      exactTime: '09:00',
    });
    const refinementEventId = eventIdForCommand(refinement.id);
    const correction = parseCommand({
      kind: 'CorrectReport',
      sourceMessageId: correctionTurn.inboundMessageId,
      sourceSpans: [sourceSpan(correctionTurn, 'August 14 dose')],
      targetEventId: refinementEventId,
      targetEventVersion: 2,
      targetKind: 'administration',
      medicationId,
      medicationVersion: 1,
      doseId: doseBId,
      doseVersion: 1,
      adherence: 'taken',
      timing: 'on_time',
      localDate: '2026-08-14',
      localTime: '09:00',
    });
    const correctionEventId = eventIdForCommand(correction.id);
    const prepared = prepareCommands(
      await loadPatientClinicalMemory(pool, patient.id),
      correctionTurn,
      [refinement, correction],
    );

    const committed = await commit(pool, prepared);

    expect(committed.memory.events).toEqual([
      expect.objectContaining({ id: originalEventId, current: false, version: 1 }),
      expect.objectContaining({
        id: refinementEventId,
        current: false,
        version: 2,
        supersedesEventId: originalEventId,
      }),
      expect.objectContaining({
        id: correctionEventId,
        current: true,
        version: 3,
        supersedesEventId: refinementEventId,
        doseId: doseBId,
      }),
    ]);
    const physical = await pool.query<{
      id: string;
      semantic_event_id: string;
      semantic_event_version: number;
    }>(
      `SELECT id::text, semantic_event_id, semantic_event_version
         FROM clinical_event
        WHERE patient_id = $1 AND semantic_event_id = ANY($2::varchar[])
        ORDER BY semantic_event_version`,
      [patient.id, [originalEventId, refinementEventId, correctionEventId]],
    );
    expect(physical.rows).toEqual([
      { id: expect.any(String), semantic_event_id: originalEventId, semantic_event_version: 1 },
      { id: expect.any(String), semantic_event_id: refinementEventId, semantic_event_version: 2 },
      { id: expect.any(String), semantic_event_id: correctionEventId, semantic_event_version: 3 },
    ]);
    const adherence = await pool.query<{ dose_id: string; inbound_message_id: string }>(
      `SELECT dose_id::text, inbound_message_id::text
         FROM adherence_record
        WHERE patient_id = $1`,
      [patient.id],
    );
    expect(adherence.rows).toEqual([
      { dose_id: doseBId, inbound_message_id: correctionTurn.inboundMessageId },
    ]);
    const summaries = await pool.query<{
      local_date: string;
      version: number;
      event_count: number;
      structured_payload: { readonly eventIds: readonly string[] };
    }>(
      `SELECT local_date::text, version, event_count, structured_payload
         FROM daily_summary
        WHERE patient_id = $1
        ORDER BY local_date, version`,
      [patient.id],
    );
    expect(
      summaries.rows.map(({ local_date, version, event_count, structured_payload }) => ({
        local_date,
        version,
        event_count,
        eventIds: structured_payload.eventIds,
      })),
    ).toEqual([
      {
        local_date: '2026-08-13',
        version: 1,
        event_count: 1,
        eventIds: [physical.rows[0]!.id],
      },
      { local_date: '2026-08-13', version: 2, event_count: 0, eventIds: [] },
      {
        local_date: '2026-08-14',
        version: 1,
        event_count: 1,
        eventIds: [physical.rows[2]!.id],
      },
    ]);
    const afterCommit = await patientFingerprint(patient.id);
    expect(await commit(pool, prepared)).toEqual(committed);
    expect(await patientFingerprint(patient.id)).toEqual(afterCommit);
  });

  it('rejects a correction that targets a dose with an unrelated classifier projection', async () => {
    const patient = await seedPatient();
    const { medicationId, doseAId, doseBId } = await seedProjectionDoses(patient.id);
    const originalTurn = await seedTurn(patient, 1, 'I took the August 13 dose.');
    const originalQuote = 'I took the August 13 dose';
    const originalIntent = {
      kind: 'CreateReport' as const,
      sourceMessageId: originalTurn.inboundMessageId,
      sourceSpans: [
        {
          messageId: originalTurn.inboundMessageId,
          start: originalTurn.body.indexOf(originalQuote),
          end: originalTurn.body.indexOf(originalQuote) + originalQuote.length,
          quote: originalQuote,
        },
      ],
      eventKind: 'administration' as const,
      medicationId,
      medicationVersion: 1,
      doseId: doseAId,
      doseVersion: 1,
      adherence: 'taken' as const,
      timing: 'on_time' as const,
      localDate: '2026-08-13',
      localTime: '09:00',
    };
    const originalCommand = clinicalIntentCommandSchema.parse({
      ...originalIntent,
      id: `command-${sha256(originalIntent).slice(0, 24)}`,
    });
    await commit(
      pool,
      prepareCommands(await loadPatientClinicalMemory(pool, patient.id), originalTurn, [
        originalCommand,
      ]),
    );
    await completeQueueJob(originalTurn);

    const unrelatedInbound = await pool.query<{ id: string }>(
      `INSERT INTO inbound_reply
         (patient_id, raw_body, received_at, inbound_sequence)
       VALUES ($1, 'Unrelated classifier projection', '2026-08-14T16:00:00Z', 99)
       RETURNING id::text`,
      [patient.id],
    );
    await pool.query(
      `INSERT INTO adherence_record
         (patient_id, dose_id, inbound_message_id, adherence_state,
          reason_code, safety_flag, decided_by, status)
       VALUES ($1, $2, $3, 'taken', 'none', 'none', 'classifier', 'recorded')`,
      [patient.id, doseBId, unrelatedInbound.rows[0]!.id],
    );

    const correctionTurn = await seedTurn(patient, 2, 'Correction: I took the August 14 dose.');
    const correctionQuote = 'I took the August 14 dose';
    const correctionIntent = {
      kind: 'CorrectReport' as const,
      sourceMessageId: correctionTurn.inboundMessageId,
      sourceSpans: [
        {
          messageId: correctionTurn.inboundMessageId,
          start: correctionTurn.body.indexOf(correctionQuote),
          end: correctionTurn.body.indexOf(correctionQuote) + correctionQuote.length,
          quote: correctionQuote,
        },
      ],
      targetEventId: eventIdForCommand(originalCommand.id),
      targetEventVersion: 1,
      targetKind: 'administration' as const,
      medicationId,
      medicationVersion: 1,
      doseId: doseBId,
      doseVersion: 1,
      adherence: 'taken' as const,
      timing: 'on_time' as const,
      localDate: '2026-08-14',
      localTime: '09:00',
    };
    const correctionCommand = clinicalIntentCommandSchema.parse({
      ...correctionIntent,
      id: `command-${sha256(correctionIntent).slice(0, 24)}`,
    });
    const correctionPrepared = prepareCommands(
      await loadPatientClinicalMemory(pool, patient.id),
      correctionTurn,
      [correctionCommand],
    );
    const beforeCorrection = await patientFingerprint(patient.id);

    await expect(commit(pool, correctionPrepared)).rejects.toThrow(
      'clinical_projection_adherence_conflict',
    );
    expect(await patientFingerprint(patient.id)).toEqual(beforeCorrection);
  });

  it('preserves a concurrent target-dose winner and rolls back the losing correction', async () => {
    const patient = await seedPatient();
    const { medicationId, doseAId, doseBId } = await seedProjectionDoses(patient.id);
    const originalTurn = await seedTurn(patient, 1, 'I took the August 13 dose.');
    const originalQuote = 'I took the August 13 dose';
    const originalIntent = {
      kind: 'CreateReport' as const,
      sourceMessageId: originalTurn.inboundMessageId,
      sourceSpans: [
        {
          messageId: originalTurn.inboundMessageId,
          start: originalTurn.body.indexOf(originalQuote),
          end: originalTurn.body.indexOf(originalQuote) + originalQuote.length,
          quote: originalQuote,
        },
      ],
      eventKind: 'administration' as const,
      medicationId,
      medicationVersion: 1,
      doseId: doseAId,
      doseVersion: 1,
      adherence: 'taken' as const,
      timing: 'on_time' as const,
      localDate: '2026-08-13',
      localTime: '09:00',
    };
    const originalCommand = clinicalIntentCommandSchema.parse({
      ...originalIntent,
      id: `command-${sha256(originalIntent).slice(0, 24)}`,
    });
    await commit(
      pool,
      prepareCommands(await loadPatientClinicalMemory(pool, patient.id), originalTurn, [
        originalCommand,
      ]),
    );
    await completeQueueJob(originalTurn);

    const correctionTurn = await seedTurn(patient, 2, 'Correction: I took the August 14 dose.');
    const correctionQuote = 'I took the August 14 dose';
    const correctionIntent = {
      kind: 'CorrectReport' as const,
      sourceMessageId: correctionTurn.inboundMessageId,
      sourceSpans: [
        {
          messageId: correctionTurn.inboundMessageId,
          start: correctionTurn.body.indexOf(correctionQuote),
          end: correctionTurn.body.indexOf(correctionQuote) + correctionQuote.length,
          quote: correctionQuote,
        },
      ],
      targetEventId: eventIdForCommand(originalCommand.id),
      targetEventVersion: 1,
      targetKind: 'administration' as const,
      medicationId,
      medicationVersion: 1,
      doseId: doseBId,
      doseVersion: 1,
      adherence: 'taken' as const,
      timing: 'on_time' as const,
      localDate: '2026-08-14',
      localTime: '09:00',
    };
    const correctionCommand = clinicalIntentCommandSchema.parse({
      ...correctionIntent,
      id: `command-${sha256(correctionIntent).slice(0, 24)}`,
    });
    const correctionPrepared = prepareCommands(
      await loadPatientClinicalMemory(pool, patient.id),
      correctionTurn,
      [correctionCommand],
    );
    const competitor = await pool.connect();
    const applicationName = `s05-target-race-${phoneCounter}`;
    const racePool = new Pool({ connectionString: databaseUrl, application_name: applicationName });
    let competitorOpen = false;
    try {
      await competitor.query('BEGIN');
      competitorOpen = true;
      const winnerInbound = await competitor.query<{ id: string }>(
        `INSERT INTO inbound_reply
           (patient_id, raw_body, received_at, inbound_sequence)
         VALUES ($1, 'Concurrent winner', '2026-08-14T17:00:00Z', 99)
         RETURNING id::text`,
        [patient.id],
      );
      const winnerInboundId = winnerInbound.rows[0]!.id;
      await competitor.query(
        `INSERT INTO adherence_record
           (patient_id, dose_id, inbound_message_id, adherence_state,
            reason_code, safety_flag, decided_by, status)
         VALUES ($1, $2, $3, 'taken', 'none', 'none', 'classifier', 'recorded')`,
        [patient.id, doseBId, winnerInboundId],
      );
      const expectedAfterWinner = await patientFingerprint(patient.id, competitor);
      const losingCommit = commit(racePool, correctionPrepared);
      await waitForBlockedApplication(applicationName);
      await competitor.query('COMMIT');
      competitorOpen = false;

      await expect(losingCommit).rejects.toThrow('clinical_projection_adherence_conflict');
      expect(await patientFingerprint(patient.id)).toEqual(expectedAfterWinner);
      const adherence = await pool.query<{
        dose_id: string;
        inbound_message_id: string;
        decided_by: string;
      }>(
        `SELECT dose_id::text, inbound_message_id::text, decided_by::text
           FROM adherence_record
          WHERE patient_id = $1
          ORDER BY dose_id`,
        [patient.id],
      );
      expect(adherence.rows).toEqual(
        [
          {
            dose_id: doseAId,
            inbound_message_id: originalTurn.inboundMessageId,
            decided_by: 'classifier',
          },
          { dose_id: doseBId, inbound_message_id: winnerInboundId, decided_by: 'classifier' },
        ].sort((left, right) => left.dose_id.localeCompare(right.dose_id)),
      );
    } finally {
      if (competitorOpen) await competitor.query('ROLLBACK').catch(() => undefined);
      competitor.release();
      await racePool.end();
    }
  });

  it('atomically swaps two exact administration projections and replays without writes', async () => {
    const patient = await seedPatient();
    const { medicationId, doseAId, doseBId } = await seedProjectionDoses(patient.id);
    const originalA = await seedTurn(
      patient,
      1,
      'I took the August 13 dose.',
      undefined,
      ON_WINDOW_RECEIVED_BASE,
    );
    const createA = parseCommand({
      kind: 'CreateReport',
      sourceMessageId: originalA.inboundMessageId,
      sourceSpans: [sourceSpan(originalA, 'I took the August 13 dose')],
      eventKind: 'administration',
      medicationId,
      medicationVersion: 1,
      doseId: doseAId,
      doseVersion: 1,
      adherence: 'taken',
      timing: 'on_time',
      localDate: '2026-08-13',
      localTime: '09:00',
    });
    await commit(
      pool,
      prepareCommands(await loadPatientClinicalMemory(pool, patient.id), originalA, [createA]),
    );
    await completeQueueJob(originalA);

    const originalB = await seedTurn(patient, 2, 'I took the August 14 dose.');
    const createB = parseCommand({
      kind: 'CreateReport',
      sourceMessageId: originalB.inboundMessageId,
      sourceSpans: [sourceSpan(originalB, 'I took the August 14 dose')],
      eventKind: 'administration',
      medicationId,
      medicationVersion: 1,
      doseId: doseBId,
      doseVersion: 1,
      adherence: 'taken',
      timing: 'on_time',
      localDate: '2026-08-14',
      localTime: '09:00',
    });
    await commit(
      pool,
      prepareCommands(await loadPatientClinicalMemory(pool, patient.id), originalB, [createB]),
    );
    await completeQueueJob(originalB);

    const swapTurn = await seedTurn(
      patient,
      3,
      'Correction: the first was August 14 and the second was August 13.',
      undefined,
      ON_WINDOW_RECEIVED_BASE,
    );
    const correctionA = parseCommand({
      kind: 'CorrectReport',
      sourceMessageId: swapTurn.inboundMessageId,
      sourceSpans: [sourceSpan(swapTurn, 'first was August 14')],
      targetEventId: eventIdForCommand(createA.id),
      targetEventVersion: 1,
      targetKind: 'administration',
      medicationId,
      medicationVersion: 1,
      doseId: doseBId,
      doseVersion: 1,
      adherence: 'taken',
      timing: 'on_time',
      localDate: '2026-08-14',
      localTime: '09:00',
    });
    const correctionB = parseCommand({
      kind: 'CorrectReport',
      sourceMessageId: swapTurn.inboundMessageId,
      sourceSpans: [sourceSpan(swapTurn, 'second was August 13')],
      targetEventId: eventIdForCommand(createB.id),
      targetEventVersion: 1,
      targetKind: 'administration',
      medicationId,
      medicationVersion: 1,
      doseId: doseAId,
      doseVersion: 1,
      adherence: 'taken',
      timing: 'on_time',
      localDate: '2026-08-13',
      localTime: '09:00',
    });
    const prepared = prepareCommands(await loadPatientClinicalMemory(pool, patient.id), swapTurn, [
      correctionA,
      correctionB,
    ]);
    const beforeSwap = await patientFingerprint(patient.id);

    await pool.query(`CREATE OR REPLACE FUNCTION test_fail_swap_projection()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'fault_injected_after_swap_projection';
      END;
    $$`);
    await pool.query(`CREATE TRIGGER test_fault_swap_projection
      BEFORE INSERT ON outbound_message
      FOR EACH ROW EXECUTE FUNCTION test_fail_swap_projection()`);
    try {
      await expect(commit(pool, prepared)).rejects.toThrow('fault_injected_after_swap_projection');
      expect(await patientFingerprint(patient.id)).toEqual(beforeSwap);
    } finally {
      await pool.query('DROP TRIGGER test_fault_swap_projection ON outbound_message');
    }

    const committed = await commit(pool, prepared);
    const correctionAId = eventIdForCommand(correctionA.id);
    const correctionBId = eventIdForCommand(correctionB.id);
    const current = await pool.query<{
      semantic_event_id: string;
      dose_id: string;
      local_date: string;
    }>(
      `SELECT event.semantic_event_id, event.dose_id::text, event.local_date::text
         FROM clinical_event event
        WHERE event.patient_id = $1
          AND event.semantic_event_id = ANY($2::varchar[])
          AND NOT EXISTS (
            SELECT 1 FROM clinical_event successor
             WHERE successor.patient_id = event.patient_id
               AND successor.supersedes_id = event.id
          )
        ORDER BY event.dose_id`,
      [patient.id, [correctionAId, correctionBId]],
    );
    expect(current.rows).toEqual(
      [
        { semantic_event_id: correctionBId, dose_id: doseAId, local_date: '2026-08-13' },
        { semantic_event_id: correctionAId, dose_id: doseBId, local_date: '2026-08-14' },
      ].sort((left, right) => left.dose_id.localeCompare(right.dose_id)),
    );
    const adherence = await pool.query<{ dose_id: string; inbound_message_id: string }>(
      `SELECT dose_id::text, inbound_message_id::text
         FROM adherence_record
        WHERE patient_id = $1
        ORDER BY dose_id`,
      [patient.id],
    );
    expect(adherence.rows).toEqual(
      [doseAId, doseBId]
        .sort()
        .map((dose_id) => ({ dose_id, inbound_message_id: swapTurn.inboundMessageId })),
    );
    const latestSummaries = await pool.query<{
      local_date: string;
      event_count: number;
      structured_payload: { readonly adherenceCounts: { readonly taken: number } };
    }>(
      `SELECT DISTINCT ON (local_date)
              local_date::text, event_count, structured_payload
         FROM daily_summary
        WHERE patient_id = $1
        ORDER BY local_date, version DESC`,
      [patient.id],
    );
    expect(latestSummaries.rows).toEqual([
      {
        local_date: '2026-08-13',
        event_count: 1,
        structured_payload: expect.objectContaining({
          adherenceCounts: expect.objectContaining({ taken: 1 }),
        }),
      },
      {
        local_date: '2026-08-14',
        event_count: 1,
        structured_payload: expect.objectContaining({
          adherenceCounts: expect.objectContaining({ taken: 1 }),
        }),
      },
    ]);
    const afterSwap = await patientFingerprint(patient.id);
    expect(await commit(pool, prepared)).toEqual(committed);
    expect(await patientFingerprint(patient.id)).toEqual(afterSwap);
  });

  it('projects a durable dose clarification when a noncanonical administration becomes canonical', async () => {
    const patient = await seedPatient();
    const { medicationId, doseAId } = await seedProjectionDoses(patient.id);
    const originalTurn = await seedTurn(patient, 1, 'I took the morning dose.');
    const originalQuote = 'I took the morning dose';
    const originalSpan = {
      messageId: originalTurn.inboundMessageId,
      start: originalTurn.body.indexOf(originalQuote),
      end: originalTurn.body.indexOf(originalQuote) + originalQuote.length,
      quote: originalQuote,
    };
    const originalIntent = {
      kind: 'CreateReport' as const,
      sourceMessageId: originalTurn.inboundMessageId,
      sourceSpans: [originalSpan],
      eventKind: 'administration' as const,
      medicationId,
      medicationVersion: 1,
      adherence: 'taken' as const,
      timing: 'on_time' as const,
      localDate: '2026-08-13',
      localTime: '09:00',
    };
    const originalCommand = clinicalIntentCommandSchema.parse({
      ...originalIntent,
      id: `command-${sha256(originalIntent).slice(0, 24)}`,
    });
    const originalEventId = eventIdForCommand(originalCommand.id);
    const needId = `need-${sha256({ originalEventId, doseAId }).slice(0, 24)}`;
    const questionId = `question-${sha256(needId).slice(0, 24)}`;
    const openIntent = {
      kind: 'OpenInformationNeed' as const,
      sourceMessageId: originalTurn.inboundMessageId,
      sourceSpans: [originalSpan],
      needId,
      originInboundSequence: originalTurn.sequence,
      targetEventId: originalEventId,
      targetEventVersion: 1,
      field: 'dose_identity' as const,
      candidateMedicationIds: [medicationId],
      candidateDoseIds: [doseAId],
      candidateSymptomEventIds: [],
      candidateHistoricalEventIds: [],
      questionId,
      priority: 100,
    };
    const openCommand = clinicalIntentCommandSchema.parse({
      ...openIntent,
      id: `command-${sha256(openIntent).slice(0, 24)}`,
    });
    const askIntent = {
      kind: 'AskInformationNeed' as const,
      sourceMessageId: originalTurn.inboundMessageId,
      sourceSpans: [],
      needId,
      expectedNeedVersion: 1,
    };
    const askCommand = clinicalIntentCommandSchema.parse({
      ...askIntent,
      id: `command-${sha256(askIntent).slice(0, 24)}`,
    });
    const firstPrepared = prepareCommands(
      await loadPatientClinicalMemory(pool, patient.id),
      originalTurn,
      [originalCommand, openCommand, askCommand],
      {
        kind: 'question',
        acknowledgementId: 'acknowledgement-recorded',
        question: {
          needId,
          eventId: originalEventId,
          field: 'dose_identity',
          questionId,
        },
        reviewReasons: [],
      },
    );
    const firstCommitted = await commit(pool, firstPrepared);

    expect(firstCommitted.memory.events).toEqual([
      expect.objectContaining({ id: originalEventId, canonical: false, current: true }),
    ]);
    expect(firstCommitted.memory.needs).toEqual([
      expect.objectContaining({ id: needId, version: 2, state: 'asked' }),
    ]);
    expect(
      await pool.query('SELECT 1 FROM adherence_record WHERE patient_id = $1', [patient.id]),
    ).toMatchObject({ rowCount: 0 });
    expect(
      await pool.query('SELECT 1 FROM daily_summary WHERE patient_id = $1', [patient.id]),
    ).toMatchObject({ rowCount: 0 });
    await completeQueueJob(originalTurn);

    const answerTurn = await seedTurn(patient, 2, 'It was the August 13 dose.');
    const answerQuote = 'August 13 dose';
    const answerSpan = {
      messageId: answerTurn.inboundMessageId,
      start: answerTurn.body.indexOf(answerQuote),
      end: answerTurn.body.indexOf(answerQuote) + answerQuote.length,
      quote: answerQuote,
    };
    const resolveIntent = {
      kind: 'ResolveInformationNeed' as const,
      sourceMessageId: answerTurn.inboundMessageId,
      sourceSpans: [answerSpan],
      needId,
      expectedNeedVersion: 2,
    };
    const refineIntent = {
      kind: 'RefineReport' as const,
      sourceMessageId: answerTurn.inboundMessageId,
      sourceSpans: [answerSpan],
      targetEventId: originalEventId,
      targetEventVersion: 1,
      targetKind: 'administration' as const,
      medicationId,
      medicationVersion: 1,
      doseId: doseAId,
      doseVersion: 1,
      adherence: 'taken' as const,
      timing: 'on_time' as const,
      localDate: '2026-08-13',
      localTime: '09:00',
    };
    const commands = [resolveIntent, refineIntent].map((intent) =>
      clinicalIntentCommandSchema.parse({
        ...intent,
        id: `command-${sha256(intent).slice(0, 24)}`,
      }),
    );
    const prepared = prepareCommands(
      await loadPatientClinicalMemory(pool, patient.id),
      answerTurn,
      commands,
    );
    const committed = await commit(pool, prepared);
    const successorId = eventIdForCommand(commands[1]!.id);

    expect(committed.memory.events).toEqual([
      expect.objectContaining({ id: originalEventId, canonical: false, current: false }),
      expect.objectContaining({
        id: successorId,
        canonical: true,
        current: true,
        supersedesEventId: originalEventId,
        doseId: doseAId,
      }),
    ]);
    expect(committed.memory.needs).toEqual([
      expect.objectContaining({ id: needId, state: 'resolved' }),
    ]);
    expect(
      await pool.query(
        `SELECT dose_id::text, inbound_message_id::text, decided_by::text
           FROM adherence_record
          WHERE patient_id = $1`,
        [patient.id],
      ),
    ).toMatchObject({
      rows: [
        {
          dose_id: doseAId,
          inbound_message_id: answerTurn.inboundMessageId,
          decided_by: 'classifier',
        },
      ],
    });
    const afterCommit = await patientFingerprint(patient.id);
    expect(await commit(pool, prepared)).toEqual(committed);
    expect(await patientFingerprint(patient.id)).toEqual(afterCommit);
  });

  it('projects a symptom-only canonical turn into its patient-local daily summary', async () => {
    const patient = await seedPatient();
    const turn = await seedTurn(patient, 1, 'My headache started.');
    const { prepared } = await prepare(turn, [symptomClaim('headache')]);
    const committed = await commit(pool, prepared);
    const symptom = committed.memory.events.find(({ kind }) => kind === 'symptom');
    if (symptom === undefined) throw new Error('symptom_event_missing');
    const physical = await pool.query<{ id: string }>(
      `SELECT id::text
         FROM clinical_event
        WHERE patient_id = $1 AND semantic_event_id = $2`,
      [patient.id, symptom.id],
    );
    const summary = await pool.query<{
      local_date: string;
      event_count: number;
      structured_payload: {
        readonly symptomCount: number;
        readonly eventIds: readonly string[];
        readonly events: readonly { readonly eventType: string; readonly eventCode: string }[];
      };
    }>(
      `SELECT local_date::text, event_count, structured_payload
         FROM daily_summary
        WHERE patient_id = $1
        ORDER BY local_date, version`,
      [patient.id],
    );

    expect(summary.rows).toEqual([
      {
        local_date: '2026-08-13',
        event_count: 1,
        structured_payload: expect.objectContaining({
          symptomCount: 1,
          eventIds: [physical.rows[0]!.id],
          events: [
            expect.objectContaining({ eventType: 'patient_statement', eventCode: 'symptom' }),
          ],
        }),
      },
    ]);
  });

  it('projects administration and symptom leaves onto both affected local dates in one turn', async () => {
    const patient = await seedPatient();
    const { medicationId, doseBId } = await seedProjectionDoses(patient.id);
    const turn = await seedTurn(patient, 1, 'I took the August 14 dose. I have a headache.');
    const administrationQuote = 'I took the August 14 dose';
    const symptomQuote = 'I have a headache';
    const administrationIntent = {
      kind: 'CreateReport' as const,
      sourceMessageId: turn.inboundMessageId,
      sourceSpans: [
        {
          messageId: turn.inboundMessageId,
          start: turn.body.indexOf(administrationQuote),
          end: turn.body.indexOf(administrationQuote) + administrationQuote.length,
          quote: administrationQuote,
        },
      ],
      eventKind: 'administration' as const,
      medicationId,
      medicationVersion: 1,
      doseId: doseBId,
      doseVersion: 1,
      adherence: 'taken' as const,
      timing: 'on_time' as const,
      localDate: '2026-08-14',
      localTime: '09:00',
    };
    const symptomIntent = {
      kind: 'CreateReport' as const,
      sourceMessageId: turn.inboundMessageId,
      sourceSpans: [
        {
          messageId: turn.inboundMessageId,
          start: turn.body.indexOf(symptomQuote),
          end: turn.body.indexOf(symptomQuote) + symptomQuote.length,
          quote: symptomQuote,
        },
      ],
      eventKind: 'symptom' as const,
      rawSymptom: 'headache',
      symptomConcept: 'headache',
      symptomStatus: 'current' as const,
    };
    const commands = [administrationIntent, symptomIntent].map((intent) =>
      clinicalIntentCommandSchema.parse({
        ...intent,
        id: `command-${sha256(intent).slice(0, 24)}`,
      }),
    );
    await commit(
      pool,
      prepareCommands(await loadPatientClinicalMemory(pool, patient.id), turn, commands),
    );
    const summaries = await pool.query<{
      local_date: string;
      event_count: number;
      structured_payload: {
        readonly symptomCount: number;
        readonly adherenceCounts: { readonly taken: number };
      };
    }>(
      `SELECT local_date::text, event_count, structured_payload
         FROM daily_summary
        WHERE patient_id = $1
        ORDER BY local_date, version`,
      [patient.id],
    );

    expect(summaries.rows).toEqual([
      {
        local_date: '2026-08-13',
        event_count: 1,
        structured_payload: expect.objectContaining({
          symptomCount: 1,
          adherenceCounts: expect.objectContaining({ taken: 0 }),
        }),
      },
      {
        local_date: '2026-08-14',
        event_count: 1,
        structured_payload: expect.objectContaining({
          symptomCount: 0,
          adherenceCounts: expect.objectContaining({ taken: 1 }),
        }),
      },
    ]);
  });

  it('summarizes 101 same-day current leaves with exact totals and 100 deterministic details', async () => {
    const patient = await seedPatient();
    const tokens = Array.from(
      { length: 101 },
      (_, index) => `symptom${String(index + 1).padStart(3, '0')}`,
    );
    const body = tokens.join(' ');
    const turn = await seedTurn(patient, 1, body);
    const commands = tokens.map((token) => {
      const intent = {
        kind: 'CreateReport' as const,
        sourceMessageId: turn.inboundMessageId,
        sourceSpans: [
          {
            messageId: turn.inboundMessageId,
            start: body.indexOf(token),
            end: body.indexOf(token) + token.length,
            quote: token,
          },
        ],
        eventKind: 'symptom' as const,
        rawSymptom: token,
        symptomConcept: 'nausea',
        symptomStatus: 'current' as const,
      };
      return clinicalIntentCommandSchema.parse({
        ...intent,
        id: `command-${sha256(intent).slice(0, 24)}`,
      });
    });
    const prepared = prepareCommands(
      await loadPatientClinicalMemory(pool, patient.id),
      turn,
      commands,
    );
    const committed = await commit(pool, prepared);
    const summary = await pool.query<{
      event_count: number;
      highest_tier: string;
      structured_payload: {
        readonly eventCount: number;
        readonly detailedEventCount: number;
        readonly truncated: boolean;
        readonly eventIds: readonly string[];
        readonly events: readonly unknown[];
        readonly symptomCount: number;
        readonly adherenceCounts: Readonly<Record<string, number>>;
        readonly highestPriority: string;
      };
    }>(
      `SELECT event_count, highest_tier, structured_payload
         FROM daily_summary
        WHERE patient_id = $1 AND local_date = '2026-08-13'
        ORDER BY version DESC
        LIMIT 1`,
      [patient.id],
    );
    const retained = await pool.query<{ id: string }>(
      `SELECT id::text
         FROM clinical_event
        WHERE patient_id = $1 AND semantic_event_id IS NOT NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 100`,
      [patient.id],
    );
    const expectedEventIds = retained.rows.map(({ id }) => id).sort();

    expect(summary.rows).toEqual([
      {
        event_count: 101,
        highest_tier: 'routine',
        structured_payload: {
          localDate: '2026-08-13',
          patientTimeZone: 'America/Toronto',
          eventCount: 101,
          detailedEventCount: 100,
          truncated: true,
          eventIds: expectedEventIds,
          events: expect.any(Array),
          symptomCount: 101,
          adherenceCounts: {
            taken: 0,
            delayed: 0,
            skipped: 0,
            stopped: 0,
            question: 0,
            unknown: 0,
          },
          highestPriority: 'routine',
        },
      },
    ]);
    expect(summary.rows[0]!.structured_payload.events).toHaveLength(100);
    const afterCommit = await patientFingerprint(patient.id);
    expect(await commit(pool, prepared)).toEqual(committed);
    expect(await patientFingerprint(patient.id)).toEqual(afterCommit);
  });

  it('retains emergency as the daily highest priority when its detail falls outside the latest 100', async () => {
    const patient = await seedPatient();
    const emergencyTurn = await seedTurn(patient, 1, "I can't breathe.");
    const emergencyPrepared = await prepare(emergencyTurn, [], {
      emergencyPrefilter: true,
      symptomConcepts: [],
    });
    const emergencyCommitted = await commit(pool, emergencyPrepared.prepared);
    const emergency = emergencyCommitted.memory.events.find(
      ({ kind, safetyTier }) => kind === 'safety' && safetyTier === 'emergency',
    );
    if (emergency === undefined) throw new Error('emergency_event_missing');
    const emergencyPhysical = await pool.query<{ id: string }>(
      'SELECT id::text FROM clinical_event WHERE patient_id = $1 AND semantic_event_id = $2',
      [patient.id, emergency.id],
    );
    await completeQueueJob(emergencyTurn);

    const tokens = Array.from(
      { length: 100 },
      (_, index) => `routine${String(index + 1).padStart(3, '0')}`,
    );
    const routineTurn = await seedTurn(patient, 2, tokens.join(' '));
    const commands = tokens.map((token) =>
      parseCommand({
        kind: 'CreateReport',
        sourceMessageId: routineTurn.inboundMessageId,
        sourceSpans: [sourceSpan(routineTurn, token)],
        eventKind: 'symptom',
        rawSymptom: token,
        symptomConcept: 'nausea',
        symptomStatus: 'current',
      }),
    );
    await commit(
      pool,
      prepareCommands(await loadPatientClinicalMemory(pool, patient.id), routineTurn, commands),
    );
    const summary = await pool.query<{
      event_count: number;
      highest_tier: string;
      structured_payload: {
        readonly eventCount: number;
        readonly detailedEventCount: number;
        readonly truncated: boolean;
        readonly eventIds: readonly string[];
        readonly events: readonly { readonly priority: string }[];
        readonly symptomCount: number;
        readonly highestPriority: string;
      };
    }>(
      `SELECT event_count, highest_tier, structured_payload
         FROM daily_summary
        WHERE patient_id = $1 AND local_date = '2026-08-13'
        ORDER BY version DESC
        LIMIT 1`,
      [patient.id],
    );

    expect(summary.rows).toEqual([
      {
        event_count: 101,
        highest_tier: 'emergency',
        structured_payload: expect.objectContaining({
          eventCount: 101,
          detailedEventCount: 100,
          truncated: true,
          symptomCount: 100,
          highestPriority: 'emergency',
        }),
      },
    ]);
    expect(summary.rows[0]!.structured_payload.eventIds).not.toContain(
      emergencyPhysical.rows[0]!.id,
    );
    expect(summary.rows[0]!.structured_payload.events).toHaveLength(100);
    expect(
      summary.rows[0]!.structured_payload.events.every(({ priority }) => priority === 'routine'),
    ).toBe(true);
  });

  it('uses the authoritative scheduled instant for a fall-DST administration occurrence', async () => {
    const patient = await seedPatient();
    const { medicationId, doseBId } = await seedProjectionDoses(patient.id);
    await pool.query(
      `UPDATE dose_schedule
          SET scheduled_at = '2026-11-01T06:30:00Z',
              dose_date = '2026-11-01',
              local_dose_time = '01:30',
              schedule_timezone = 'America/Toronto'
        WHERE patient_id = $1 AND id = $2`,
      [patient.id, doseBId],
    );
    const turn = await seedTurn(patient, 1, 'I took the November 1 dose.');
    const quote = 'I took the November 1 dose';
    const intent = {
      kind: 'CreateReport' as const,
      sourceMessageId: turn.inboundMessageId,
      sourceSpans: [
        {
          messageId: turn.inboundMessageId,
          start: turn.body.indexOf(quote),
          end: turn.body.indexOf(quote) + quote.length,
          quote,
        },
      ],
      eventKind: 'administration' as const,
      medicationId,
      medicationVersion: 1,
      doseId: doseBId,
      doseVersion: 1,
      adherence: 'taken' as const,
      timing: 'on_time' as const,
      localDate: '2026-11-01',
      localTime: '01:30',
    };
    const command = clinicalIntentCommandSchema.parse({
      ...intent,
      id: `command-${sha256(intent).slice(0, 24)}`,
    });
    await commit(
      pool,
      prepareCommands(await loadPatientClinicalMemory(pool, patient.id), turn, [command]),
    );
    const summary = await pool.query<{
      structured_payload: { readonly events: readonly { readonly occurredAtUtc: string }[] };
    }>(
      `SELECT structured_payload
         FROM daily_summary
        WHERE patient_id = $1 AND local_date = '2026-11-01'
        ORDER BY version DESC
        LIMIT 1`,
      [patient.id],
    );
    const dose = await pool.query<{ scheduled_at: Date }>(
      'SELECT scheduled_at FROM dose_schedule WHERE patient_id = $1 AND id = $2',
      [patient.id, doseBId],
    );

    expect(dose.rows[0]!.scheduled_at.toISOString()).toBe('2026-11-01T06:30:00.000Z');
    expect(summary.rows[0]!.structured_payload.events).toEqual([
      expect.objectContaining({ occurredAtUtc: '2026-11-01T06:30:00.000Z' }),
    ]);
  });

  it('rejects a canonical administration whose dose belongs to another medication with zero writes', async () => {
    const patient = await seedPatient();
    const { doseAId } = await seedProjectionDoses(patient.id);
    const secondMedication = await pool.query<{ id: string }>(
      `INSERT INTO patient_medication
         (patient_id, entered_name, identity_system, identity_code, dose_text, valid_from,
          status, confirmed_by_clinician_sub, confirmed_at)
       VALUES ($1, 'Lisinopril', 'rxnorm', '29046', '10 mg', '2026-08-01',
               'active', $2, '2026-08-01T12:00:00Z')
       RETURNING id::text`,
      [patient.id, OWNER_ID],
    );
    const secondMedicationId = secondMedication.rows[0]?.id;
    if (secondMedicationId === undefined) throw new Error('second_medication_seed_failed');
    const turn = await seedTurn(patient, 1, 'I took the August 13 dose.');
    const command = parseCommand({
      kind: 'CreateReport',
      sourceMessageId: turn.inboundMessageId,
      sourceSpans: [sourceSpan(turn, 'I took the August 13 dose')],
      eventKind: 'administration',
      medicationId: secondMedicationId,
      medicationVersion: 1,
      doseId: doseAId,
      doseVersion: 1,
      adherence: 'taken',
      timing: 'on_time',
      localDate: '2026-08-13',
      localTime: '09:00',
    });
    const prepared = prepareCommands(await loadPatientClinicalMemory(pool, patient.id), turn, [
      command,
    ]);
    const beforeCommit = await patientFingerprint(patient.id);

    await expect(commit(pool, prepared)).rejects.toThrow('clinical_projection_adherence_conflict');
    expect(await patientFingerprint(patient.id)).toEqual(beforeCommit);
  });

  it('persists an emergency interruption with unresolved content and a durable pause', async () => {
    const patient = await seedPatient();
    const turn = await seedTurn(patient, 1, "I can't breathe.");
    const { memory, prepared } = await prepare(turn, [], {
      emergencyPrefilter: true,
      symptomConcepts: [],
    });
    const expected = applyPreparedClinicalTurn(memory, prepared);

    await commit(pool, prepared);
    const loaded = await loadPatientClinicalMemory(pool, patient.id);

    expect(loaded).toEqual(expected.memory);
    expect(loaded).toMatchObject({
      version: 1,
      routineClarificationsPaused: true,
      events: [expect.objectContaining({ kind: 'safety', safetyTier: 'emergency' })],
      needs: [],
      unresolvedReports: [expect.objectContaining({ reason: 'emergency_content_not_extracted' })],
      reviewItems: [
        expect.objectContaining({ kind: 'safety', status: 'open' }),
        expect.objectContaining({ kind: 'unresolved_report', status: 'open' }),
      ],
      processedBatches: [expect.objectContaining({ preparedHash: prepared.preparedHash })],
    });
    const outbound = await pool.query<{
      body: string;
      message_kind: string;
      asked_information_need_id: string | null;
    }>(
      `SELECT body, message_kind, asked_information_need_id::text
         FROM outbound_message
        WHERE patient_id = $1`,
      [patient.id],
    );
    expect(outbound.rows).toEqual([
      {
        body: prepared.responseText,
        message_kind: 'safety',
        asked_information_need_id: null,
      },
    ]);
  });

  it('replays after crash-after-commit without writes and rejects another full hash', async () => {
    const patient = await seedPatient();
    const turn = await seedTurn(patient, 1, 'My headache started. Thanks.');
    const { prepared } = await prepare(turn, [symptomClaim('headache')]);
    const alternative = prepareClinicalTurn(
      snapshot(await loadPatientClinicalMemory(pool, patient.id), turn),
      [
        {
          slot: 'social',
          kind: 'social',
          quote: 'Thanks',
          ...ELIGIBLE,
        },
      ],
    );
    expect(alternative.preparedHash).not.toBe(prepared.preparedHash);

    const first = await commit(pool, prepared);
    const afterFirst = await patientFingerprint(patient.id);
    const crashReplay = await commit(pool, prepared);
    expect(crashReplay).toEqual(first);
    expect(await patientFingerprint(patient.id)).toEqual(afterFirst);
    await expect(commit(pool, alternative)).rejects.toThrow('prepared_batch_integrity_error');
    expect(await patientFingerprint(patient.id)).toEqual(afterFirst);

    await completeQueueJob(turn);
    const laterTurn = await seedTurn(patient, 2, '7.');
    const later = await prepare(laterTurn, [
      {
        slot: 'later-severity-answer',
        kind: 'need_answer',
        quote: '7',
        ...ELIGIBLE,
        answerField: 'severity',
        answerText: '7',
      },
    ]);
    await commit(pool, later.prepared);
    const afterLaterTurn = await patientFingerprint(patient.id);
    const laterReplay = await commit(pool, prepared);

    expect(laterReplay).toEqual(first);
    expect(afterLaterTurn).not.toEqual(afterFirst);
    expect(await patientFingerprint(patient.id)).toEqual(afterLaterTurn);
  });

  it('preserves reducer entity order after the recent-receipt window rolls over', async () => {
    const patient = await seedPatient();
    const eventTurn = await seedTurn(patient, 1, 'Nausea left. Nausea right.');
    const eventPrepared = prepareResolvedSymptoms(
      await loadPatientClinicalMemory(pool, patient.id),
      eventTurn,
    );
    const eventResult = await commit(pool, eventPrepared);
    await completeQueueJob(eventTurn);
    expect(eventResult.memory.events.map(({ id }) => id)).not.toEqual(
      [...eventResult.memory.events.map(({ id }) => id)].sort(),
    );

    let rolloverPrepared: PreparedClinicalTurn | undefined;
    let rolloverResult: Awaited<ReturnType<typeof commit>> | undefined;
    for (let sequence = 2; sequence <= 129; sequence += 1) {
      const turn = await seedTurn(patient, sequence, 'Thanks.');
      const current = await prepare(turn, [
        { slot: 'social', kind: 'social', quote: 'Thanks', ...ELIGIBLE },
      ]);
      rolloverPrepared = current.prepared;
      rolloverResult = await commit(pool, current.prepared);
      await completeQueueJob(turn);
    }
    if (rolloverPrepared === undefined || rolloverResult === undefined)
      throw new Error('receipt_rollover_not_reached');

    expect(rolloverResult.memory.processedBatches).toHaveLength(128);
    expect(await commit(pool, rolloverPrepared)).toEqual(rolloverResult);
  });

  it('rolls back the whole turn when every persistence boundary is fault-injected', async () => {
    const patient = await seedPatient();
    const turn = await seedTurn(patient, 1, 'My headache started. I maybe took the tablet.');
    const { prepared } = await prepare(turn, [
      symptomClaim('headache'),
      {
        slot: 'uncertain-administration',
        kind: 'administration',
        quote: 'maybe took',
        ...ELIGIBLE,
        certainty: 'uncertain',
        actionText: 'took',
      },
    ]);
    const before = await patientFingerprint(patient.id);
    await pool.query(`CREATE OR REPLACE FUNCTION test_fail_clinical_commit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'fault_injected';
      END;
    $$`);
    const boundaries = [
      ['agent_turn', 'INSERT'],
      ['clinical_event', 'INSERT'],
      ['clinical_event_source', 'INSERT'],
      ['information_need', 'INSERT'],
      ['information_need_scope', 'INSERT'],
      ['information_need_transition', 'INSERT'],
      ['clinical_review_item', 'INSERT'],
      ['clinical_review_item_transition', 'INSERT'],
      ['outbound_message', 'INSERT'],
      ['turn_job', 'UPDATE'],
      ['patient', 'UPDATE'],
    ] as const;

    for (const [table, operation] of boundaries) {
      await pool.query(
        `CREATE TRIGGER test_fault_boundary BEFORE ${operation} ON ${table}
         FOR EACH ROW EXECUTE FUNCTION test_fail_clinical_commit()`,
      );
      try {
        await expect(commit(pool, prepared)).rejects.toThrow('fault_injected');
        expect(await patientFingerprint(patient.id)).toEqual(before);
      } finally {
        await pool.query(`DROP TRIGGER test_fault_boundary ON ${table}`);
      }
    }
  });

  it('rolls back operational failure metadata when a late patient update fails', async () => {
    const patient = await seedPatient();
    const turn = await seedTurn(patient, 1, 'I am not sure what happened.');
    const memory = await loadPatientClinicalMemory(pool, patient.id);
    const prepared = prepareClinicalFailureTurn(snapshot(memory, turn), 'ambiguous_outcome');
    const before = await patientFingerprint(patient.id);
    await pool.query(`CREATE OR REPLACE FUNCTION test_fail_clinical_commit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'fault_injected';
      END;
    $$`);
    await pool.query(`CREATE TRIGGER test_fault_failure_metadata
      BEFORE UPDATE ON patient
      FOR EACH ROW EXECUTE FUNCTION test_fail_clinical_commit()`);
    try {
      await expect(commit(pool, prepared)).rejects.toThrow('fault_injected');
      expect(await patientFingerprint(patient.id)).toEqual(before);
    } finally {
      await pool.query('DROP TRIGGER test_fault_failure_metadata ON patient');
    }
  });

  it('rolls back a historical-candidate insert fault with no partial recurrence turn', async () => {
    const { patient, prepared } = await seedEventIdentityNeed();
    const before = await patientFingerprint(patient.id);
    await pool.query(`CREATE OR REPLACE FUNCTION test_fail_clinical_commit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'fault_injected';
      END;
    $$`);
    await pool.query(
      `CREATE TRIGGER test_fault_boundary BEFORE INSERT ON information_need_event_candidate
       FOR EACH ROW EXECUTE FUNCTION test_fail_clinical_commit()`,
    );
    try {
      await expect(commit(pool, prepared)).rejects.toThrow('fault_injected');
      expect(await patientFingerprint(patient.id)).toEqual(before);
    } finally {
      await pool.query('DROP TRIGGER test_fault_boundary ON information_need_event_candidate');
    }
  });

  it('rejects a stale clinical-memory base version with zero writes', async () => {
    const patient = await seedPatient();
    const turn = await seedTurn(patient, 1, 'My headache started.');
    const { prepared } = await prepare(turn, [symptomClaim('headache')]);
    await pool.query(
      'UPDATE patient SET clinical_memory_version = clinical_memory_version + 1 WHERE id = $1',
      [patient.id],
    );
    const before = await patientFingerprint(patient.id);

    await expect(commit(pool, prepared)).rejects.toThrow('stale_memory_version');

    expect(await patientFingerprint(patient.id)).toEqual(before);
  });

  it('rejects a missing clinical-context authority with zero writes', async () => {
    const patient = await seedPatient();
    const turn = await seedTurn(patient, 1, 'My headache started.');
    const { prepared } = await prepare(turn, [symptomClaim('headache')]);
    await pool.query('UPDATE turn_job SET clinical_context_hash = NULL WHERE id = $1', [
      turn.turnJobId,
    ]);
    const before = await patientFingerprint(patient.id);

    await expect(commit(pool, prepared)).rejects.toThrow('clinical_context_changed');

    expect(await patientFingerprint(patient.id)).toEqual(before);
  });

  it.each([
    [
      'patient timezone',
      async ({ patient }: LiveAuthorityFixture) => {
        await pool.query(`UPDATE patient SET timezone = 'America/Vancouver' WHERE id = $1`, [
          patient.id,
        ]);
      },
    ],
    [
      'active medication',
      async ({ patient, medicationId }: LiveAuthorityFixture) => {
        const replacement = await pool.query<{ id: string }>(
          `INSERT INTO patient_medication
             (patient_id, entered_name, identity_system, identity_code, dose_text, valid_from,
              status, confirmed_by_clinician_sub, confirmed_at, supersedes_id)
           VALUES ($1, 'Metformin ER', 'rxnorm', '6809', '750 mg', '2026-08-01',
                   'active', $2, now(), $3)
           RETURNING id::text`,
          [patient.id, OWNER_ID, medicationId],
        );
        await pool.query(
          `INSERT INTO patient_medication_ingredient
             (patient_id, patient_medication_id, ingredient_order, ingredient_name, rxcui)
           VALUES ($1, $2, 1, 'metformin', '6809')`,
          [patient.id, replacement.rows[0]!.id],
        );
      },
    ],
    [
      'selected dose schedule',
      async ({ doseId }: LiveAuthorityFixture) => {
        await pool.query(
          `UPDATE dose_schedule
              SET scheduled_at = '2026-08-13T14:00:00Z', local_dose_time = '10:00'
            WHERE id = $1`,
          [doseId],
        );
      },
    ],
    [
      'current clinical fact',
      async ({ patient, factId }: LiveAuthorityFixture) => {
        await pool.query(
          `INSERT INTO clinical_fact
             (patient_id, fact_type, fact_code, statement_text, status,
              authored_by_clinician_sub, supersedes_id)
           VALUES ($1, 'condition', 'diabetes', 'Type 2 diabetes, clinician-updated',
                   'current', $2, $3)`,
          [patient.id, OWNER_ID, factId],
        );
      },
    ],
    [
      'selected evidence checksum',
      async ({ releaseId }: LiveAuthorityFixture) => {
        await pool.query(`UPDATE source_release SET checksum_sha256 = $2 WHERE id = $1`, [
          releaseId,
          'e'.repeat(64),
        ]);
      },
    ],
    [
      'selected evidence state',
      async ({ releaseId }: LiveAuthorityFixture) => {
        await pool.query(`UPDATE source_release SET state = 'withdrawn' WHERE id = $1`, [
          releaseId,
        ]);
      },
    ],
  ] as const)('rejects live %s drift after preparation with zero writes', async (_name, mutate) => {
    const fixture = await prepareFromLiveAuthority();
    await mutate(fixture);
    const before = await patientFingerprint(fixture.patient.id);

    await expect(
      commit(pool, fixture.prepared, (client) => loadLiveContextHash(client, fixture.prepared)),
    ).rejects.toThrow('clinical_context_changed');

    expect(await patientFingerprint(fixture.patient.id)).toEqual(before);
    expect(await clinicalVersion(fixture.patient.id)).toBe(fixture.prepared.baseMemoryVersion);
  });

  it('commits once when the complete live authority remains unchanged', async () => {
    const fixture = await prepareFromLiveAuthority();

    const committed = await commit(pool, fixture.prepared, (client) =>
      loadLiveContextHash(client, fixture.prepared),
    );

    expect(committed.memory.version).toBe(fixture.prepared.baseMemoryVersion + 1);
    const state = await pool.query<{
      agent_turns: number;
      prepared_outbounds: number;
      completed_at: Date | null;
    }>(
      `SELECT
         (SELECT count(*)::int FROM agent_turn WHERE patient_id = $1) AS agent_turns,
         (SELECT count(*)::int FROM outbound_message
           WHERE patient_id = $1 AND status = 'prepared') AS prepared_outbounds,
         completed_at
       FROM turn_job
       WHERE patient_id = $1 AND inbound_message_id = $2`,
      [fixture.patient.id, fixture.turn.inboundMessageId],
    );
    expect(state.rows[0]).toEqual({
      agent_turns: 1,
      prepared_outbounds: 1,
      completed_at: null,
    });
  });

  it('rejects finalization that waited behind a clinician authority revision', async () => {
    const fixture = await prepareFromLiveAuthority();
    const writerApplication = `clinical-writer-${phoneCounter}`;
    const finalizerApplication = `clinical-finalizer-${phoneCounter}`;
    const writerPool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      application_name: writerApplication,
    });
    const finalizerPool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      application_name: finalizerApplication,
    });
    const writer = await writerPool.connect();
    const advisoryLock = await pool.connect();
    let revision: Promise<string> | undefined;
    let finalization: ReturnType<typeof commit> | undefined;

    await pool.query(`CREATE OR REPLACE FUNCTION test_pause_clinical_fact_writer()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.patient_id::text, 0));
        RETURN NEW;
      END;
    $$`);
    await pool.query(`CREATE TRIGGER test_pause_clinical_fact_writer
      BEFORE INSERT ON clinical_fact
      FOR EACH ROW EXECUTE FUNCTION test_pause_clinical_fact_writer()`);

    try {
      await advisoryLock.query('SELECT pg_advisory_lock(hashtextextended($1::text, 0))', [
        fixture.patient.id,
      ]);
      revision = appendClinicalFactRevision(writer, {
        patientId: fixture.patient.id,
        clinicianSub: OWNER_ID,
        input: {
          factType: 'condition',
          factCode: 'diabetes',
          statementText: 'Type 2 diabetes, clinician-updated while finalization waits',
          status: 'current',
          supersedesId: fixture.factId,
        },
      });
      void revision.catch(() => undefined);
      await waitForBlockedApplication(writerApplication);

      finalization = commit(finalizerPool, fixture.prepared, (client) =>
        loadLiveContextHash(client, fixture.prepared),
      );
      void finalization.catch(() => undefined);
      await waitForBlockedApplication(finalizerApplication);

      await advisoryLock.query('SELECT pg_advisory_unlock(hashtextextended($1::text, 0))', [
        fixture.patient.id,
      ]);
      await revision;
      const outcome = await finalization.then(
        () => ({ status: 'fulfilled' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );

      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') {
        expect(
          outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        ).toMatch(/clinical_context_changed|could not serialize access/u);
      }
      const state = await pool.query<{
        clinical_memory_version: number;
        facts: number;
        agent_turns: number;
        events: number;
        needs: number;
        reviews: number;
        outbounds: number;
      }>(
        `SELECT p.clinical_memory_version::int,
                (SELECT count(*)::int FROM clinical_fact item
                  WHERE item.patient_id = p.id) AS facts,
                (SELECT count(*)::int FROM agent_turn item
                  WHERE item.patient_id = p.id) AS agent_turns,
                (SELECT count(*)::int FROM clinical_event item
                  WHERE item.patient_id = p.id) AS events,
                (SELECT count(*)::int FROM information_need item
                  WHERE item.patient_id = p.id) AS needs,
                (SELECT count(*)::int FROM clinical_review_item item
                  WHERE item.patient_id = p.id) AS reviews,
                (SELECT count(*)::int FROM outbound_message item
                  WHERE item.patient_id = p.id) AS outbounds
           FROM patient p
          WHERE p.id = $1`,
        [fixture.patient.id],
      );
      expect(state.rows).toEqual([
        {
          clinical_memory_version: 0,
          facts: 2,
          agent_turns: 0,
          events: 0,
          needs: 0,
          reviews: 0,
          outbounds: 0,
        },
      ]);
    } finally {
      await advisoryLock.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
      await Promise.allSettled([revision, finalization].filter(Boolean));
      await pool
        .query('DROP TRIGGER IF EXISTS test_pause_clinical_fact_writer ON clinical_fact')
        .catch(() => undefined);
      await pool.query('DROP FUNCTION IF EXISTS test_pause_clinical_fact_writer()');
      advisoryLock.release();
      writer.release();
      await Promise.all([writerPool.end(), finalizerPool.end()]);
    }
  });

  it('rejects a prepared batch from another pipeline version with zero writes', async () => {
    const patient = await seedPatient();
    const turn = await seedTurn(patient, 1, 'My headache started.');
    const { prepared } = await prepare(turn, [symptomClaim('headache')]);
    const stale = withPipelineVersions(prepared, {
      ...prepared.pipelineVersions,
      reducer: 'reducer-v0',
    });
    const before = await patientFingerprint(patient.id);

    await expect(commit(pool, stale)).rejects.toThrow('pipeline_version_changed');

    expect(await patientFingerprint(patient.id)).toEqual(before);
  });

  it('rejects a stale-snapshot response before connecting and writes nothing', async () => {
    const patient = await seedPatient();
    const turn = await seedTurn(patient, 1, 'My headache started.');
    const memory = await loadPatientClinicalMemory(pool, patient.id);
    const prepared = prepareClinicalTurn(
      snapshot(memory, turn, { expectedMemoryVersion: memory.version + 1 }),
      [symptomClaim('headache')],
    );
    const before = await patientFingerprint(patient.id);
    const connect = vi.fn();
    const loadCurrentContextHash = vi.fn();

    expect(prepared.responsePlan.kind).toBe('stale_snapshot');
    await expect(
      commitPreparedClinicalTurn({ connect } as unknown as Pool, prepared, loadCurrentContextHash),
    ).rejects.toThrow('stale_prepared_turn');
    expect(connect).not.toHaveBeenCalled();
    expect(loadCurrentContextHash).not.toHaveBeenCalled();
    await expect(commit(pool, prepared)).rejects.toThrow('stale_prepared_turn');
    expect(await patientFingerprint(patient.id)).toEqual(before);
  });

  it('rejects a STOP then START consent ABA with zero clinical writes', async () => {
    const patient = await seedPatient();
    const turn = await seedTurn(patient, 1, 'My headache started.');
    const { prepared } = await prepare(turn, [symptomClaim('headache')]);
    await pool.query(
      `UPDATE patient
          SET provider_opted_in = false,
              agent_enabled = false,
              opted_out_at = now(),
              messaging_state_version = messaging_state_version + 1
        WHERE id = $1`,
      [patient.id],
    );
    await pool.query(
      `UPDATE patient
          SET provider_opted_in = true,
              agent_enabled = true,
              opted_out_at = NULL,
              messaging_state_version = messaging_state_version + 1
        WHERE id = $1`,
      [patient.id],
    );
    const before = await patientFingerprint(patient.id);

    await expect(commit(pool, prepared)).rejects.toThrow('messaging_state_changed');

    expect(await patientFingerprint(patient.id)).toEqual(before);
  });

  it('allows only the lowest unfinished of two concurrent commits from the same base version', async () => {
    const patient = await seedPatient();
    const firstTurn = await seedTurn(patient, 1, 'My headache started.');
    const secondTurn = await seedTurn(patient, 2, 'My nausea started.');
    const base = await loadPatientClinicalMemory(pool, patient.id);
    const firstPrepared = prepareClinicalTurn(snapshot(base, firstTurn), [
      symptomClaim('headache'),
    ]);
    const secondPrepared = prepareClinicalTurn(snapshot(base, secondTurn), [
      symptomClaim('nausea'),
    ]);
    const firstConnection = new Pool({ connectionString: databaseUrl, max: 1 });
    const secondConnection = new Pool({ connectionString: databaseUrl, max: 1 });

    const results = await (async () => {
      try {
        return await Promise.allSettled([
          commit(firstConnection, firstPrepared),
          commit(secondConnection, secondPrepared),
        ]);
      } finally {
        await Promise.all([firstConnection.end(), secondConnection.end()]);
      }
    })();

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof commit>>> =>
        result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]?.reason)).toContain('conversation_job_not_lowest_unfinished');
    expect(await clinicalVersion(patient.id)).toBe(1);

    const loaded = await loadPatientClinicalMemory(pool, patient.id);
    expect(loaded.version).toBe(1);
    expect(loaded.events).toHaveLength(1);
    expect(loaded.events[0]).toMatchObject({
      rawSymptom: 'headache',
      sourceMessageIds: [firstTurn.inboundMessageId],
    });
    expect(loaded.processedBatches).toHaveLength(1);
    const writes = await pool.query<{ agent_turns: number; outbounds: number }>(
      `SELECT
         (SELECT count(*)::int FROM agent_turn WHERE patient_id = $1) AS agent_turns,
         (SELECT count(*)::int FROM outbound_message WHERE patient_id = $1) AS outbounds`,
      [patient.id],
    );
    expect(writes.rows).toEqual([{ agent_turns: 1, outbounds: 1 }]);
  });

  // Wave 1c (Lane C): the late_intent need — opened on a missed administration report,
  // asked immediately (no other need competes), its outbound row committed with the raw
  // NeedField as clarification_topic — and never re-asked: a later correction that resolves
  // the same dose's outcome auto-supersedes it via needSatisfiedByEvent instead of carrying
  // it forward, so the question is retired rather than repeated.
  it('opens and asks a late_intent need on a missed report, commits its clarification_topic, and auto-supersedes it when a later correction resolves the same dose', async () => {
    const patient = await seedPatient();
    const { medicationId, doseAId } = await seedProjectionDoses(patient.id);
    const medications = [
      { id: medicationId, version: 1, names: ['Metformin'], aliases: [], active: true },
    ];
    const doses = [
      {
        id: doseAId,
        version: 1,
        medicationId,
        label: 'Metformin 09:00',
        localDate: '2026-08-13',
        localTime: '09:00',
      },
    ];

    const missedTurn = await seedTurn(patient, 1, 'I missed my Metformin this morning.');
    const { prepared: missedPrepared } = await prepare(
      missedTurn,
      [
        {
          slot: 'missed-metformin',
          kind: 'administration',
          quote: 'missed my Metformin',
          ...ELIGIBLE,
          medicationText: 'Metformin',
          actionText: 'missed',
        },
      ],
      { medications, doses },
    );
    expect(missedPrepared.responsePlan.kind).toBe('question');
    expect(missedPrepared.responsePlan.question?.field).toBe('late_intent');
    const missedCommitted = await commit(pool, missedPrepared);
    const administrationEvent = missedCommitted.memory.events.find(
      (event) => event.kind === 'administration',
    );
    if (administrationEvent === undefined) throw new Error('expected_administration_event');
    expect(administrationEvent).toMatchObject({
      canonical: true,
      current: true,
      adherence: 'missed',
      doseId: doseAId,
    });
    expect(missedCommitted.memory.needs).toEqual([
      expect.objectContaining({
        field: 'late_intent',
        state: 'asked',
        targetEventId: administrationEvent.id,
      }),
    ]);
    const outboundAfterMissed = await pool.query<{ clarification_topic: string | null }>(
      `SELECT clarification_topic FROM outbound_message WHERE patient_id = $1`,
      [patient.id],
    );
    expect(outboundAfterMissed.rows).toEqual([{ clarification_topic: 'late_intent' }]);
    await completeQueueJob(missedTurn);

    const correctionTurn = await seedTurn(
      patient,
      2,
      'Actually I did take my Metformin after all.',
    );
    const { prepared: correctionPrepared } = await prepare(
      correctionTurn,
      [
        {
          slot: 'correction-took-it',
          kind: 'correction',
          quote: 'did take my Metformin',
          ...ELIGIBLE,
          targetText: 'Metformin',
          actionText: 'did take',
        },
      ],
      { medications, doses },
    );
    // Never re-asks: the correction turn must not open a second late_intent question.
    expect(correctionPrepared.responsePlan.kind).toBe('routine');
    const correctionCommitted = await commit(pool, correctionPrepared);
    expect(correctionCommitted.memory.needs).toEqual([
      expect.objectContaining({ field: 'late_intent', state: 'superseded' }),
    ]);
    const outboundAfterCorrection = await pool.query<{ clarification_topic: string | null }>(
      `SELECT clarification_topic FROM outbound_message WHERE patient_id = $1 ORDER BY created_at`,
      [patient.id],
    );
    expect(outboundAfterCorrection.rows.at(-1)?.clarification_topic).toBeNull();
  });
});

describe('historical clinical-memory translation against PostgreSQL 16', () => {
  it('blocks the exact M-09 row when patient source and symptom status are missing with zero writes', async () => {
    const patient = await seedPatient();
    const legacy = await pool.query<{ id: string }>(
      `INSERT INTO clinical_event
         (patient_id, event_type, event_code, statement_text, normalized_value,
          occurred_at, local_date, local_time, patient_timezone, severity)
       VALUES ($1, 'observation', 'severity', 'Headache was 2/10.', 'headache',
               '2026-08-13T12:00:00Z', '2026-08-13', '08:00', 'America/Toronto', 2)
       RETURNING id::text`,
      [patient.id],
    );
    const legacyEventId = legacy.rows[0]?.id;
    if (legacyEventId === undefined) throw new Error('legacy_event_seed_failed');
    const before = await patientFingerprint(patient.id);

    await expect(translateHistoricalClinicalMemory(pool, patient.id)).resolves.toEqual({
      kind: 'blocked',
      patientId: patient.id,
      blockers: [
        {
          legacyEventId,
          reasons: ['missing_patient_source', 'missing_symptom_status'],
        },
      ],
    });
    expect(await patientFingerprint(patient.id)).toEqual(before);
  });

  it('append-translates a fully sourced legacy symptom atomically and replays without writes', async () => {
    const patient = await seedPatient();
    const turn = await seedTurn(patient, 1, 'Headache was 2/10.');
    const sourceSpans = [
      {
        messageId: turn.inboundMessageId,
        start: 0,
        end: turn.body.length,
        quote: turn.body,
      },
    ];
    const clinicalValues = {
      rawSymptom: 'headache',
      symptomConcept: 'headache',
      symptomStatus: 'current',
      severity: '2',
      localDate: '2026-08-13',
      localTime: '08:00',
    };
    const legacy = await pool.query<{ id: string; row: unknown }>(
      `INSERT INTO clinical_event
         (patient_id, source_inbound_id, event_type, event_code, statement_text,
          normalized_value, occurred_at, local_date, local_time, patient_timezone,
          severity, authored_by, review_state, clinical_operation,
          is_canonical_patient_report, source_spans, clinical_values)
       VALUES ($1, $2, 'observation', 'symptom', $3, 'headache',
               '2026-08-13T12:00:00Z', '2026-08-13', '08:00', 'America/Toronto',
               2, 'patient', 'unreviewed', 'create', true, $4::jsonb, $5::jsonb)
       RETURNING id::text, to_jsonb(clinical_event) AS row`,
      [
        patient.id,
        turn.inboundMessageId,
        turn.body,
        JSON.stringify(sourceSpans),
        JSON.stringify(clinicalValues),
      ],
    );
    const legacyEventId = legacy.rows[0]?.id;
    if (legacyEventId === undefined) throw new Error('legacy_event_seed_failed');
    const before = await patientFingerprint(patient.id);

    await pool.query(`
      CREATE FUNCTION fail_historical_translation_summary() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'historical_translation_late_failure';
      END;
      $$;
      CREATE TRIGGER fail_historical_translation_summary
      BEFORE INSERT ON daily_summary
      FOR EACH ROW EXECUTE FUNCTION fail_historical_translation_summary();
    `);
    try {
      await expect(translateHistoricalClinicalMemory(pool, patient.id)).rejects.toThrow(
        'historical_translation_late_failure',
      );
      expect(await patientFingerprint(patient.id)).toEqual(before);
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS fail_historical_translation_summary ON daily_summary;
        DROP FUNCTION IF EXISTS fail_historical_translation_summary();
      `);
    }

    const first = await translateHistoricalClinicalMemory(pool, patient.id);
    if (first.kind !== 'translated') throw new Error('expected_historical_translation');
    expect(first).toEqual({
      kind: 'translated',
      patientId: patient.id,
      translations: [
        {
          legacyEventId,
          semanticEventId: `event-${sha256({ kind: 'legacy-clinical-event-v1', legacyEventId }).slice(0, 24)}`,
        },
      ],
    });
    const loaded = await loadPatientClinicalMemory(pool, patient.id);
    expect(loaded.version).toBe(0);
    expect(loaded.events).toEqual([
      expect.objectContaining({
        id: first.translations[0]?.semanticEventId,
        version: 1,
        kind: 'symptom',
        operation: 'create',
        authoredBy: 'patient',
        reviewState: 'unreviewed',
        current: true,
        canonical: true,
        sourceMessageIds: [turn.inboundMessageId],
        sourceSpans,
        ...clinicalValues,
      }),
    ]);
    const summary = await pool.query<{
      event_count: number;
      structured_payload: { eventCount: number; symptomCount: number };
    }>(
      `SELECT event_count, structured_payload
         FROM daily_summary
        WHERE patient_id = $1 AND local_date = '2026-08-13'
        ORDER BY version DESC LIMIT 1`,
      [patient.id],
    );
    expect(summary.rows).toEqual([
      {
        event_count: 1,
        structured_payload: expect.objectContaining({ eventCount: 1, symptomCount: 1 }),
      },
    ]);
    const storedLegacy = await pool.query<{ row: unknown }>(
      'SELECT to_jsonb(event) AS row FROM clinical_event event WHERE id = $1',
      [legacyEventId],
    );
    expect(storedLegacy.rows[0]?.row).toEqual(legacy.rows[0]?.row);

    const afterFirst = await patientFingerprint(patient.id);
    await expect(translateHistoricalClinicalMemory(pool, patient.id)).resolves.toEqual(first);
    expect(await patientFingerprint(patient.id)).toEqual(afterFirst);
  });

  it('preserves exact lineage, current leaves, adherence totals, summaries, and review outcomes', async () => {
    const patient = await seedPatient();
    const { medicationId, doseAId } = await seedProjectionDoses(patient.id);
    const originalTurn = await seedTurn(patient, 1, 'Headache started.');
    const correctionTurn = await seedTurn(patient, 2, 'Actually, the headache is gone.');
    const administrationTurn = await seedTurn(
      patient,
      3,
      'I took Metformin at 9:00.',
      undefined,
      ON_WINDOW_RECEIVED_BASE,
    );
    const span = (turn: SeededTurn) => [
      {
        messageId: turn.inboundMessageId,
        start: 0,
        end: turn.body.length,
        quote: turn.body,
      },
    ];
    const original = await pool.query<{ id: string }>(
      `INSERT INTO clinical_event
         (patient_id, source_inbound_id, event_type, event_code, statement_text,
          normalized_value, occurred_at, local_date, local_time, patient_timezone,
          authored_by, review_state, clinical_operation, is_canonical_patient_report,
          source_spans, clinical_values)
       VALUES ($1, $2, 'observation', 'symptom', $3, 'headache',
               '2026-08-13T12:00:00Z', '2026-08-13', '08:00', 'America/Toronto',
               'patient', 'unreviewed', 'create', true, $4::jsonb, $5::jsonb)
       RETURNING id::text`,
      [
        patient.id,
        originalTurn.inboundMessageId,
        originalTurn.body,
        JSON.stringify(span(originalTurn)),
        JSON.stringify({
          rawSymptom: 'headache',
          symptomConcept: 'headache',
          symptomStatus: 'current',
          localDate: '2026-08-13',
          localTime: '08:00',
        }),
      ],
    );
    const originalEventId = original.rows[0]?.id;
    if (originalEventId === undefined) throw new Error('legacy_event_seed_failed');
    const correction = await pool.query<{ id: string }>(
      `INSERT INTO clinical_event
         (patient_id, source_inbound_id, event_type, event_code, statement_text,
          normalized_value, occurred_at, local_date, local_time, patient_timezone,
          supersedes_id, authored_by, review_state, clinical_operation,
          is_canonical_patient_report, source_spans, clinical_values)
       VALUES ($1, $2, 'observation', 'correction', $3, 'headache',
               '2026-08-13T12:00:00Z', '2026-08-13', '08:00', 'America/Toronto',
               $4, 'patient', 'unreviewed', 'correct', true, $5::jsonb, $6::jsonb)
       RETURNING id::text`,
      [
        patient.id,
        correctionTurn.inboundMessageId,
        correctionTurn.body,
        originalEventId,
        JSON.stringify(span(correctionTurn)),
        JSON.stringify({
          rawSymptom: 'headache',
          symptomConcept: 'headache',
          symptomStatus: 'resolved',
          localDate: '2026-08-13',
          localTime: '08:00',
        }),
      ],
    );
    const correctionEventId = correction.rows[0]?.id;
    if (correctionEventId === undefined) throw new Error('legacy_event_seed_failed');
    const administration = await pool.query<{ id: string }>(
      `INSERT INTO clinical_event
         (patient_id, source_inbound_id, event_type, event_code, statement_text,
          normalized_value, occurred_at, local_date, local_time, patient_timezone,
          patient_medication_id, dose_id, authored_by, review_state,
          clinical_operation, is_canonical_patient_report, source_spans, clinical_values)
       VALUES ($1, $2, 'adherence', 'taken:none', $3, 'taken',
               '2026-08-13T13:00:00Z', '2026-08-13', '09:00', 'America/Toronto',
               $4, $5, 'patient', 'confirmed', 'create', true, $6::jsonb, $7::jsonb)
       RETURNING id::text`,
      [
        patient.id,
        administrationTurn.inboundMessageId,
        administrationTurn.body,
        medicationId,
        doseAId,
        JSON.stringify(span(administrationTurn)),
        JSON.stringify({
          medicationId,
          medicationVersion: 1,
          doseId: doseAId,
          doseVersion: 1,
          adherence: 'taken',
          timing: 'on_time',
          localDate: '2026-08-13',
          localTime: '09:00',
        }),
      ],
    );
    const administrationEventId = administration.rows[0]?.id;
    if (administrationEventId === undefined) throw new Error('legacy_event_seed_failed');
    const legacyBefore = await pool.query<{ row: unknown }>(
      `SELECT to_jsonb(event) AS row
         FROM clinical_event event
        WHERE patient_id = $1 AND semantic_event_id IS NULL
        ORDER BY id`,
      [patient.id],
    );
    const reviewBefore = await loadPatientClinicalMemory(pool, patient.id);
    expect(reviewBefore.reviewItems).toEqual([]);
    expect(reviewBefore.unresolvedReports).toEqual([]);

    const result = await translateHistoricalClinicalMemory(pool, patient.id);
    if (result.kind !== 'translated') throw new Error('expected_historical_translation');
    const semanticByLegacy = new Map(
      result.translations.map(({ legacyEventId, semanticEventId }) => [
        legacyEventId,
        semanticEventId,
      ]),
    );
    expect([...semanticByLegacy.keys()].sort()).toEqual(
      [originalEventId, correctionEventId, administrationEventId].sort(),
    );

    const memory = await loadPatientClinicalMemory(pool, patient.id);
    expect(memory.version).toBe(0);
    expect(memory.events).toHaveLength(3);
    expect(
      memory.events.find(({ id }) => id === semanticByLegacy.get(originalEventId)),
    ).toMatchObject({ kind: 'symptom', version: 1, current: false, symptomStatus: 'current' });
    expect(
      memory.events.find(({ id }) => id === semanticByLegacy.get(correctionEventId)),
    ).toMatchObject({
      kind: 'symptom',
      version: 2,
      operation: 'correct',
      current: true,
      symptomStatus: 'resolved',
      supersedesEventId: semanticByLegacy.get(originalEventId),
    });
    expect(
      memory.events.find(({ id }) => id === semanticByLegacy.get(administrationEventId)),
    ).toMatchObject({
      kind: 'administration',
      reviewState: 'confirmed',
      current: true,
      medicationId,
      doseId: doseAId,
      adherence: 'taken',
      timing: 'on_time',
    });
    expect(memory.reviewItems).toEqual(reviewBefore.reviewItems);
    expect(memory.unresolvedReports).toEqual(reviewBefore.unresolvedReports);

    const adherence = await pool.query<{
      dose_id: string;
      inbound_message_id: string;
      adherence_state: string;
    }>(
      `SELECT dose_id::text, inbound_message_id::text, adherence_state::text
         FROM adherence_record WHERE patient_id = $1`,
      [patient.id],
    );
    expect(adherence.rows).toEqual([
      {
        dose_id: doseAId,
        inbound_message_id: administrationTurn.inboundMessageId,
        adherence_state: 'taken',
      },
    ]);
    const summary = await pool.query<{
      event_count: number;
      structured_payload: {
        eventCount: number;
        symptomCount: number;
        adherenceCounts: { taken: number };
      };
    }>(
      `SELECT event_count, structured_payload
         FROM daily_summary
        WHERE patient_id = $1 AND local_date = '2026-08-13'
        ORDER BY version DESC LIMIT 1`,
      [patient.id],
    );
    expect(summary.rows).toEqual([
      {
        event_count: 2,
        structured_payload: expect.objectContaining({
          eventCount: 2,
          symptomCount: 1,
          adherenceCounts: expect.objectContaining({ taken: 1 }),
        }),
      },
    ]);
    const legacyAfter = await pool.query<{ row: unknown }>(
      `SELECT to_jsonb(event) AS row
         FROM clinical_event event
        WHERE patient_id = $1 AND semantic_event_id IS NULL
        ORDER BY id`,
      [patient.id],
    );
    expect(legacyAfter.rows).toEqual(legacyBefore.rows);

    const afterFirst = await patientFingerprint(patient.id);
    await expect(translateHistoricalClinicalMemory(pool, patient.id)).resolves.toEqual(result);
    expect(await patientFingerprint(patient.id)).toEqual(afterFirst);
  });
});

// Owner decision C (2026-08-17): the symptom context battery ships ON. These pin the flag on
// the PRODUCTION snapshot builder — loadConversationJob, not a test fixture — so the battery
// can never silently ship dead, and pin the operator kill switch that turns it back off.
describe('context battery rollout from the production snapshot builder', () => {
  async function loadLiveSnapshot(): Promise<PatientClinicalSnapshot> {
    const patient = await seedPatient();
    const turn = await seedTurn(patient, 1, 'I have nausea today.');
    const loaded = await loadConversationJob(pool, {
      inboundMessageId: turn.inboundMessageId,
      requestId: turn.inboundMessageId,
      expectedLanguage: 'en',
      promptVersion: PIPELINE_VERSIONS.extractor,
      schemaVersion: 'conversation-v3',
      includeClinicalSnapshot: true,
    });
    if (loaded?.kind !== 'ready' || loaded.clinicalSnapshot === undefined) {
      throw new Error('live_clinical_snapshot_missing');
    }
    return loaded.clinicalSnapshot;
  }

  function openedFields(live: PatientClinicalSnapshot): readonly string[] {
    const result = applyPreparedClinicalTurn(
      live.memory,
      prepareClinicalTurn(live, [symptomClaim('nausea')]),
    );
    return result.memory.needs
      .filter((need) => result.createdNeedIds.includes(need.id))
      .map(({ field }) => field)
      .sort();
  }

  it('opens context-battery needs on an identified-symptom turn', async () => {
    const live = await loadLiveSnapshot();
    expect(live.contextBatteryEnabled).toBe(true);
    expect(openedFields(live)).toEqual(['onset', 'quality', 'severity', 'triggers'].sort());
  });

  it('suppresses battery need-opening when the operator kill switch is set', async () => {
    process.env[CONTEXT_BATTERY_DISABLE_ENV] = 'true';
    try {
      const live = await loadLiveSnapshot();
      expect(live.contextBatteryEnabled).toBe(false);
      expect(openedFields(live)).toEqual(['severity']);
    } finally {
      delete process.env[CONTEXT_BATTERY_DISABLE_ENV];
    }
  });
});
