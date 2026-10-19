import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  prepareClinicalTurn,
  syntheticPromptedConfirmationClaims,
  type ExtractedClaim,
  type PatientClinicalMemory,
  type PatientClinicalSnapshot,
  type PreparedClinicalTurn,
} from './index.js';
import { commitPreparedClinicalTurn, loadPatientClinicalMemory } from './repository.js';

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
// Dose scheduled 2026-08-13T13:00:00Z = 09:00 America/Toronto. The 2-hour response window
// (RESPONSE_WINDOW_MINUTES = 120) + ON_WINDOW_GRACE_MINUTES = 15 puts the on-window
// boundary at 15:15:00Z.
const SCHEDULED_AT = '2026-08-13T13:00:00Z';
const ON_WINDOW_RECEIVED_AT = '2026-08-13T14:00:00Z';
const LATE_RECEIVED_AT = '2026-08-13T16:30:00Z';

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

type SeededDose = {
  readonly medicationId: string;
  readonly doseId: string;
};

let container: StartedPostgreSqlContainer | undefined;
let pool: Pool;
let phoneCounter = 0;
const patientsToDelete = new Set<string>();

async function seedPatient(): Promise<SeededPatient> {
  phoneCounter += 1;
  const result = await pool.query<{ id: string; messaging_state_version: number }>(
    `INSERT INTO patient
       (phone, medication_name, owner_clinician_sub, timezone, is_test)
     VALUES ($1, 'test medication', $2, 'America/Toronto', true)
     RETURNING id::text, messaging_state_version`,
    [`+1500777${String(phoneCounter).padStart(4, '0')}`, OWNER_ID],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('patient_seed_failed');
  patientsToDelete.add(row.id);
  return { id: row.id, messagingStateVersion: row.messaging_state_version };
}

async function seedTurn(
  patient: SeededPatient,
  sequence: number,
  body: string,
  receivedAt: string,
): Promise<SeededTurn> {
  const inbound = await pool.query<{ id: string }>(
    `INSERT INTO inbound_reply
       (patient_id, raw_body, received_at, inbound_sequence)
     VALUES ($1, $2, $3::timestamptz, $4)
     RETURNING id::text`,
    [patient.id, body, receivedAt, sequence],
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

async function seedMedicationWithDose(patientId: string): Promise<SeededDose> {
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
  const dose = await pool.query<{ id: string }>(
    `INSERT INTO dose_schedule
       (patient_id, patient_medication_id, scheduled_at, local_dose_time,
        dose_date, schedule_timezone)
     VALUES ($1, $2, $3::timestamptz, '09:00', '2026-08-13', 'America/Toronto')
     RETURNING id::text`,
    [patientId, medicationId, SCHEDULED_AT],
  );
  const doseId = dose.rows[0]?.id;
  if (doseId === undefined) throw new Error('dose_seed_failed');
  return { medicationId, doseId };
}

function snapshot(
  memory: PatientClinicalMemory,
  turn: SeededTurn,
  seeded: SeededDose,
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
    medications: [
      {
        id: seeded.medicationId,
        version: 1,
        names: ['Metformin'],
        aliases: [],
        active: true,
      },
    ],
    doses: [
      {
        id: seeded.doseId,
        version: 1,
        medicationId: seeded.medicationId,
        label: '500 mg',
        localDate: '2026-08-13',
        localTime: '09:00',
      },
    ],
    symptomConcepts: ['headache', 'nausea'],
    languageDisposition: 'english',
    emergencyPrefilter: false,
    contextHash: CONTEXT_HASH,
    pipelineVersions: PIPELINE_VERSIONS,
    ...overrides,
  };
}

async function preparePromptedConfirmation(
  turn: SeededTurn,
  seeded: SeededDose,
): Promise<PreparedClinicalTurn> {
  const memory = await loadPatientClinicalMemory(pool, turn.patientId);
  const state = snapshot(memory, turn, seeded, { promptedDoseId: seeded.doseId });
  const claims = syntheticPromptedConfirmationClaims(state);
  if (claims === null) throw new Error('expected_bare_confirmation_claims');
  return prepareClinicalTurn(state, claims);
}

async function commit(prepared: PreparedClinicalTurn) {
  return commitPreparedClinicalTurn(pool, prepared, async () => prepared.contextHash);
}

async function completeQueueJob(turn: SeededTurn): Promise<void> {
  const completed = await pool.query(
    `UPDATE turn_job SET completed_at = now() WHERE id = $1 AND completed_at IS NULL`,
    [turn.turnJobId],
  );
  expect(completed.rowCount).toBe(1);
}

async function adherenceRows(patientId: string) {
  const rows = await pool.query<{
    id: string;
    dose_id: string | null;
    inbound_message_id: string | null;
    adherence_state: string;
    reason_code: string;
    safety_flag: string;
    decided_by: string;
    status: string;
  }>(
    `SELECT id::text, dose_id::text, inbound_message_id::text, adherence_state::text,
            reason_code::text, safety_flag::text, decided_by::text, status::text
       FROM adherence_record
      WHERE patient_id = $1
      ORDER BY created_at`,
    [patientId],
  );
  return rows.rows;
}

async function latestSummary(patientId: string, localDate: string) {
  const rows = await pool.query<{
    event_count: number;
    structured_payload: {
      readonly symptomCount: number;
      readonly adherenceCounts: Readonly<Record<string, number>>;
      readonly events: readonly { readonly eventCode: string | null }[];
    };
  }>(
    `SELECT event_count, structured_payload
       FROM daily_summary
      WHERE patient_id = $1 AND local_date = $2::date
      ORDER BY version DESC
      LIMIT 1`,
    [patientId, localDate],
  );
  return rows.rows[0];
}

type SeededConfirmedAdministration = {
  readonly physicalId: string;
  readonly inboundId: string;
};

// clinical_event is append-only immutable, so seed the clinician-confirmed
// administration directly (legacy-row pattern; no reducer path flips review_state).
async function seedConfirmedAdministration(
  patientId: string,
  seeded: SeededDose,
): Promise<SeededConfirmedAdministration> {
  const reportBody = 'I took my Metformin.';
  const reportQuote = 'took my Metformin';
  const reportInbound = await pool.query<{ id: string }>(
    `INSERT INTO inbound_reply (patient_id, raw_body, received_at, inbound_sequence)
     VALUES ($1, $2, $3::timestamptz, 1)
     RETURNING id::text`,
    [patientId, reportBody, ON_WINDOW_RECEIVED_AT],
  );
  const reportInboundId = reportInbound.rows[0]!.id;
  const reportSpans = [
    {
      messageId: reportInboundId,
      start: reportBody.indexOf(reportQuote),
      end: reportBody.indexOf(reportQuote) + reportQuote.length,
      quote: reportQuote,
    },
  ];
  const confirmed = await pool.query<{ id: string }>(
    `INSERT INTO clinical_event
       (patient_id, source_inbound_id, event_type, occurred_at, local_date, local_time,
        patient_timezone, patient_medication_id, dose_id, semantic_event_id,
        semantic_event_version, authored_by, review_state, clinical_operation,
        is_canonical_patient_report, source_spans, clinical_values)
     VALUES ($1, $2, 'administration', '2026-08-13T13:00:00Z', '2026-08-13', '09:00',
             'America/Toronto', $3, $4, $5, 1, 'patient', 'confirmed', 'create',
             true, $6::jsonb, $7::jsonb)
     RETURNING id::text`,
    [
      patientId,
      reportInboundId,
      seeded.medicationId,
      seeded.doseId,
      'event-confirmed-administration',
      JSON.stringify(reportSpans),
      JSON.stringify({
        medicationId: seeded.medicationId,
        medicationVersion: 1,
        doseId: seeded.doseId,
        doseVersion: 1,
        adherence: 'taken',
        localDate: '2026-08-13',
        localTime: '09:00',
      }),
    ],
  );
  const physicalId = confirmed.rows[0]!.id;
  await pool.query(
    `INSERT INTO clinical_event_source
       (patient_id, clinical_event_id, source_inbound_id, source_order)
     VALUES ($1, $2, $3, 0)`,
    [patientId, physicalId, reportInboundId],
  );
  return { physicalId, inboundId: reportInboundId };
}

beforeAll(async () => {
  const ciUrl = process.env.TEST_DATABASE_URL;
  let databaseUrl: string;
  if (ciUrl) {
    databaseUrl = ciUrl;
  } else {
    container = await new PostgreSqlContainer('postgres:16').start();
    databaseUrl = container.getConnectionUri();
  }
  pool = new Pool({ connectionString: databaseUrl, max: 8 });
  await pool.query(SCHEMA_SQL);
}, CONTAINER_TIMEOUT_MS);

afterEach(async () => {
  const ids = [...patientsToDelete];
  patientsToDelete.clear();
  if (ids.length > 0) await pool.query('DELETE FROM patient WHERE id = ANY($1::uuid[])', [ids]);
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('Wave 0 hotfix projections (live bare-confirmation crash class)', () => {
  it('commits a bare on-window "Yes" as adherence_state taken through the real projection', async () => {
    const patient = await seedPatient();
    const seeded = await seedMedicationWithDose(patient.id);
    const turn = await seedTurn(patient, 1, 'Yes', ON_WINDOW_RECEIVED_AT);

    await commit(await preparePromptedConfirmation(turn, seeded));

    expect(await adherenceRows(patient.id)).toEqual([
      expect.objectContaining({
        dose_id: seeded.doseId,
        inbound_message_id: turn.inboundMessageId,
        adherence_state: 'taken',
        reason_code: 'none',
        safety_flag: 'none',
        decided_by: 'classifier',
        status: 'recorded',
      }),
    ]);
    expect(await latestSummary(patient.id, '2026-08-13')).toMatchObject({
      event_count: 1,
      structured_payload: {
        adherenceCounts: expect.objectContaining({ taken: 1, delayed: 0, skipped: 0 }),
        events: [expect.objectContaining({ eventCode: 'taken' })],
      },
    });
  });

  it('commits a bare "No" as adherence_state skipped, never taken', async () => {
    const patient = await seedPatient();
    const seeded = await seedMedicationWithDose(patient.id);
    const turn = await seedTurn(patient, 1, 'No', ON_WINDOW_RECEIVED_AT);

    await commit(await preparePromptedConfirmation(turn, seeded));

    expect(await adherenceRows(patient.id)).toEqual([
      expect.objectContaining({
        dose_id: seeded.doseId,
        inbound_message_id: turn.inboundMessageId,
        adherence_state: 'skipped',
        reason_code: 'none',
        safety_flag: 'none',
        decided_by: 'classifier',
        status: 'recorded',
      }),
    ]);
    expect(await latestSummary(patient.id, '2026-08-13')).toMatchObject({
      structured_payload: {
        adherenceCounts: expect.objectContaining({ taken: 0, skipped: 1 }),
        events: [expect.objectContaining({ eventCode: 'skipped' })],
      },
    });
  });

  it('derives late from received_at and records a bare late "Yes" as delayed', async () => {
    const patient = await seedPatient();
    const seeded = await seedMedicationWithDose(patient.id);
    const turn = await seedTurn(patient, 1, 'Yes', LATE_RECEIVED_AT);

    await commit(await preparePromptedConfirmation(turn, seeded));

    expect(await adherenceRows(patient.id)).toEqual([
      expect.objectContaining({
        dose_id: seeded.doseId,
        adherence_state: 'delayed',
        decided_by: 'classifier',
        status: 'recorded',
      }),
    ]);
    expect(await latestSummary(patient.id, '2026-08-13')).toMatchObject({
      structured_payload: {
        adherenceCounts: expect.objectContaining({ taken: 0, delayed: 1 }),
        events: [expect.objectContaining({ eventCode: 'delayed' })],
      },
    });
  });

  it('keeps an on-time taken report on-time when a duplicate confirmation arrives after the window', async () => {
    const patient = await seedPatient();
    const seeded = await seedMedicationWithDose(patient.id);
    const reportTurn = await seedTurn(patient, 1, 'Yes', ON_WINDOW_RECEIVED_AT);
    await commit(await preparePromptedConfirmation(reportTurn, seeded));
    await completeQueueJob(reportTurn);
    const takenRow = (await adherenceRows(patient.id))[0];
    if (takenRow === undefined) throw new Error('expected_taken_row');
    expect(takenRow.adherence_state).toBe('taken');

    // Duplicate SMS confirmation well past the on-window boundary (15:15Z): timing
    // must stay anchored to the message that established the outcome, not drift late.
    const duplicateTurn = await seedTurn(patient, 2, 'Yes', '2026-08-13T18:00:00Z');
    await commit(await preparePromptedConfirmation(duplicateTurn, seeded));

    expect(await adherenceRows(patient.id)).toEqual([
      expect.objectContaining({
        id: takenRow.id,
        dose_id: seeded.doseId,
        adherence_state: 'taken',
        decided_by: 'classifier',
        status: 'recorded',
      }),
    ]);
    expect(await latestSummary(patient.id, '2026-08-13')).toMatchObject({
      structured_payload: {
        adherenceCounts: expect.objectContaining({ taken: 1, delayed: 0 }),
      },
    });
  });

  it('records "Not yet" as a pending non-canonical administration with no adherence row, then closes it on the later "took it"', async () => {
    const patient = await seedPatient();
    const seeded = await seedMedicationWithDose(patient.id);
    const pendingTurn = await seedTurn(patient, 1, 'Not yet', ON_WINDOW_RECEIVED_AT);

    const pendingCommitted = await commit(await preparePromptedConfirmation(pendingTurn, seeded));

    expect(pendingCommitted.memory.events).toEqual([
      expect.objectContaining({
        kind: 'administration',
        canonical: false,
        current: true,
        medicationId: seeded.medicationId,
        doseId: seeded.doseId,
      }),
    ]);
    expect(pendingCommitted.memory.events[0]).not.toHaveProperty('adherence');
    // Wave 1c: a still-PENDING administration opens the pinned late_intent question exactly like
    // a missed one, targeting this event. Projection stays untouched — no adherence row, no
    // summary event — the need is the ONLY thing a pending report adds.
    expect(pendingCommitted.memory.needs).toEqual([
      expect.objectContaining({
        field: 'late_intent',
        state: 'asked',
        targetEventId: pendingCommitted.memory.events[0]?.id,
      }),
    ]);
    expect(await adherenceRows(patient.id)).toEqual([]);
    expect(
      await pool.query('SELECT 1 FROM daily_summary WHERE patient_id = $1', [patient.id]),
    ).toMatchObject({ rowCount: 0 });
    await completeQueueJob(pendingTurn);

    const resolutionTurn = await seedTurn(patient, 2, 'took it', '2026-08-13T14:45:00Z');
    const resolved = await commit(await preparePromptedConfirmation(resolutionTurn, seeded));

    expect(resolved.memory.events).toEqual([
      expect.objectContaining({ kind: 'administration', current: false, canonical: false }),
      expect.objectContaining({
        kind: 'administration',
        current: true,
        canonical: true,
        adherence: 'taken',
        doseId: seeded.doseId,
      }),
    ]);
    // The dose resolving auto-supersedes the pinned question — it is never re-asked.
    expect(resolved.memory.needs).toEqual([
      expect.objectContaining({ field: 'late_intent', state: 'superseded' }),
    ]);
    expect(await adherenceRows(patient.id)).toEqual([
      expect.objectContaining({
        dose_id: seeded.doseId,
        inbound_message_id: resolutionTurn.inboundMessageId,
        adherence_state: 'taken',
        decided_by: 'classifier',
        status: 'recorded',
      }),
    ]);
  });

  it('rewrites the adherence row as skipped when a correction flips taken to missed', async () => {
    const patient = await seedPatient();
    const seeded = await seedMedicationWithDose(patient.id);
    const reportTurn = await seedTurn(patient, 1, 'Yes', ON_WINDOW_RECEIVED_AT);
    await commit(await preparePromptedConfirmation(reportTurn, seeded));
    await completeQueueJob(reportTurn);
    const takenRow = (await adherenceRows(patient.id))[0];
    if (takenRow === undefined) throw new Error('expected_taken_row');
    expect(takenRow.adherence_state).toBe('taken');

    const correctionTurn = await seedTurn(
      patient,
      2,
      'Actually I did not take my Metformin.',
      '2026-08-13T14:20:00Z',
    );
    const correctionClaims: ExtractedClaim[] = [
      {
        slot: 'correction-not-taken',
        kind: 'correction',
        quote: 'did not take my Metformin',
        ...ELIGIBLE,
        targetText: 'Metformin',
        actionText: 'did not take',
      },
    ];
    const memory = await loadPatientClinicalMemory(pool, patient.id);
    await commit(prepareClinicalTurn(snapshot(memory, correctionTurn, seeded), correctionClaims));

    expect(await adherenceRows(patient.id)).toEqual([
      expect.objectContaining({
        id: takenRow.id,
        dose_id: seeded.doseId,
        inbound_message_id: correctionTurn.inboundMessageId,
        adherence_state: 'skipped',
        decided_by: 'classifier',
        status: 'recorded',
      }),
    ]);
    expect(await latestSummary(patient.id, '2026-08-13')).toMatchObject({
      structured_payload: {
        adherenceCounts: expect.objectContaining({ taken: 0, skipped: 1 }),
      },
    });
  });

  it('supersedes a timeout adherence row when the patient reports after the window (arbiter)', async () => {
    const patient = await seedPatient();
    const seeded = await seedMedicationWithDose(patient.id);
    const timeoutRow = await pool.query<{ id: string }>(
      `INSERT INTO adherence_record
         (patient_id, dose_id, inbound_message_id, adherence_state,
          reason_code, safety_flag, decided_by, status)
       VALUES ($1, $2, NULL, 'unknown', 'none', 'none', 'timeout', 'missed')
       RETURNING id::text`,
      [patient.id, seeded.doseId],
    );
    const timeoutRowId = timeoutRow.rows[0]?.id;
    if (timeoutRowId === undefined) throw new Error('timeout_seed_failed');
    const turn = await seedTurn(patient, 1, 'took it', LATE_RECEIVED_AT);

    await commit(await preparePromptedConfirmation(turn, seeded));

    expect(await adherenceRows(patient.id)).toEqual([
      expect.objectContaining({
        id: timeoutRowId,
        dose_id: seeded.doseId,
        inbound_message_id: turn.inboundMessageId,
        adherence_state: 'delayed',
        decided_by: 'classifier',
        status: 'recorded',
      }),
    ]);
  });

  it('still throws loudly on a genuine double-write (non-timeout existing row)', async () => {
    const patient = await seedPatient();
    const seeded = await seedMedicationWithDose(patient.id);
    const foreignInbound = await pool.query<{ id: string }>(
      `INSERT INTO inbound_reply (patient_id, raw_body, received_at, inbound_sequence)
       VALUES ($1, 'earlier reply', '2026-08-13T13:30:00Z', 900)
       RETURNING id::text`,
      [patient.id],
    );
    await pool.query(
      `INSERT INTO adherence_record
         (patient_id, dose_id, inbound_message_id, adherence_state,
          reason_code, safety_flag, decided_by, status)
       VALUES ($1, $2, $3, 'taken', 'none', 'none', 'classifier', 'recorded')`,
      [patient.id, seeded.doseId, foreignInbound.rows[0]!.id],
    );
    const turn = await seedTurn(patient, 1, 'Yes', ON_WINDOW_RECEIVED_AT);

    await expect(commit(await preparePromptedConfirmation(turn, seeded))).rejects.toThrow(
      'clinical_projection_adherence_conflict',
    );
  });

  it('keeps a reported miss from poisoning the same-day summary alongside a symptom', async () => {
    const patient = await seedPatient();
    const seeded = await seedMedicationWithDose(patient.id);
    const turn = await seedTurn(
      patient,
      1,
      'I missed my Metformin and I have a headache.',
      ON_WINDOW_RECEIVED_AT,
    );
    const claims: ExtractedClaim[] = [
      {
        slot: 'missed-administration',
        kind: 'administration',
        quote: 'missed my Metformin',
        ...ELIGIBLE,
        medicationText: 'Metformin',
        actionText: 'missed',
      },
      {
        slot: 'symptom-headache',
        kind: 'symptom',
        quote: 'headache',
        ...ELIGIBLE,
        symptomText: 'headache',
      },
    ];
    const memory = await loadPatientClinicalMemory(pool, patient.id);
    const prepared = prepareClinicalTurn(snapshot(memory, turn, seeded), claims);

    await commit(prepared);

    expect(await adherenceRows(patient.id)).toEqual([
      expect.objectContaining({ dose_id: seeded.doseId, adherence_state: 'skipped' }),
    ]);
    expect(await latestSummary(patient.id, '2026-08-13')).toMatchObject({
      event_count: 2,
      structured_payload: {
        symptomCount: 1,
        adherenceCounts: expect.objectContaining({ skipped: 1, taken: 0 }),
      },
    });
  });

  it('commits a contradiction of a confirmed administration and surfaces it in the daily summary', async () => {
    const patient = await seedPatient();
    const seeded = await seedMedicationWithDose(patient.id);
    await seedConfirmedAdministration(patient.id, seeded);

    const contradictionTurn = await seedTurn(
      patient,
      2,
      'Actually I did not take my Metformin.',
      '2026-08-13T14:10:00Z',
    );
    const contradictionClaims: ExtractedClaim[] = [
      {
        slot: 'correction-not-taken',
        kind: 'correction',
        quote: 'did not take my Metformin',
        ...ELIGIBLE,
        targetText: 'Metformin',
        actionText: 'did not take',
      },
    ];
    const contradictionMemory = await loadPatientClinicalMemory(pool, patient.id);
    const contradictionCommitted = await commit(
      prepareClinicalTurn(
        snapshot(contradictionMemory, contradictionTurn, seeded),
        contradictionClaims,
      ),
    );

    expect(contradictionCommitted.memory.events).toEqual([
      expect.objectContaining({
        kind: 'administration',
        current: true,
        reviewState: 'confirmed',
      }),
      expect.objectContaining({ kind: 'contradiction', canonical: false, current: true }),
    ]);
    expect(contradictionCommitted.memory.reviewItems).toEqual([
      expect.objectContaining({ kind: 'contradiction', status: 'open' }),
    ]);
    const contradictionRow = await pool.query<{ event_type: string; local_date: string | null }>(
      `SELECT event_type, local_date::text FROM clinical_event
        WHERE patient_id = $1 AND event_type = 'contradiction'`,
      [patient.id],
    );
    // W0.7: the event row keeps event_type='contradiction' and is dated by the
    // contradicting message so it can land on that day's summary.
    expect(contradictionRow.rows).toEqual([
      { event_type: 'contradiction', local_date: '2026-08-13' },
    ]);
    expect(await latestSummary(patient.id, '2026-08-13')).toMatchObject({
      event_count: 2,
      structured_payload: {
        adherenceCounts: expect.objectContaining({ taken: 1 }),
        events: expect.arrayContaining([
          expect.objectContaining({ eventType: 'patient_statement', eventCode: 'contradiction' }),
        ]),
      },
    });
  });

  it('skips a legacy null-occurrence contradiction instead of failing the turn', async () => {
    const patient = await seedPatient();
    const seeded = await seedMedicationWithDose(patient.id);
    const confirmed = await seedConfirmedAdministration(patient.id, seeded);
    // Pre-W0.7 contradiction rows were persisted without an occurrence — they must
    // stay off the summary rather than rolling back every later turn.
    const legacyBody = 'Actually I did not take it.';
    const legacyQuote = 'did not take it';
    const legacyInbound = await pool.query<{ id: string }>(
      `INSERT INTO inbound_reply (patient_id, raw_body, received_at, inbound_sequence)
       VALUES ($1, $2, '2026-08-13T14:05:00Z', 2)
       RETURNING id::text`,
      [patient.id, legacyBody],
    );
    const legacyInboundId = legacyInbound.rows[0]!.id;
    const legacySpans = [
      {
        messageId: legacyInboundId,
        start: legacyBody.indexOf(legacyQuote),
        end: legacyBody.indexOf(legacyQuote) + legacyQuote.length,
        quote: legacyQuote,
      },
    ];
    const legacyContradiction = await pool.query<{ id: string }>(
      `INSERT INTO clinical_event
         (patient_id, source_inbound_id, event_type, occurred_at, local_date, local_time,
          patient_timezone, contradiction_of_event_id, semantic_event_id,
          semantic_event_version, authored_by, review_state, clinical_operation,
          is_canonical_patient_report, source_spans, clinical_values)
       VALUES ($1, $2, 'contradiction', NULL, NULL, NULL,
               'America/Toronto', $3, 'event-legacy-contradiction', 1, 'patient',
               'unreviewed', 'contradict', false, $4::jsonb, '{}'::jsonb)
       RETURNING id::text`,
      [patient.id, legacyInboundId, confirmed.physicalId, JSON.stringify(legacySpans)],
    );
    await pool.query(
      `INSERT INTO clinical_event_source
         (patient_id, clinical_event_id, source_inbound_id, source_order)
       VALUES ($1, $2, $3, 0)`,
      [patient.id, legacyContradiction.rows[0]!.id, legacyInboundId],
    );

    const symptomTurn = await seedTurn(patient, 3, 'I have a headache.', '2026-08-13T14:30:00Z');
    const symptomClaims: ExtractedClaim[] = [
      {
        slot: 'symptom-headache',
        kind: 'symptom',
        quote: 'headache',
        ...ELIGIBLE,
        symptomText: 'headache',
      },
    ];
    const memory = await loadPatientClinicalMemory(pool, patient.id);
    await commit(prepareClinicalTurn(snapshot(memory, symptomTurn, seeded), symptomClaims));

    const summary = await latestSummary(patient.id, '2026-08-13');
    expect(summary).toMatchObject({
      event_count: 2,
      structured_payload: {
        symptomCount: 1,
        adherenceCounts: expect.objectContaining({ taken: 1 }),
      },
    });
    expect(
      summary!.structured_payload.events.some(({ eventCode }) => eventCode === 'contradiction'),
    ).toBe(false);
  });

  it('does not fail the turn over an unrelated historical administration with no resolvable source message', async () => {
    const patient = await seedPatient();
    const seeded = await seedMedicationWithDose(patient.id);
    // Clinician-authored administration on an old date: contract-valid with no
    // source message at all, so its timing can never be derived from an
    // inbound_reply row. It must not poison unrelated later turns.
    const oldDose = await pool.query<{ id: string }>(
      `INSERT INTO dose_schedule
         (patient_id, patient_medication_id, scheduled_at, local_dose_time,
          dose_date, schedule_timezone)
       VALUES ($1, $2, '2026-08-10T13:00:00Z', '09:00', '2026-08-10', 'America/Toronto')
       RETURNING id::text`,
      [patient.id, seeded.medicationId],
    );
    const oldDoseId = oldDose.rows[0]!.id;
    await pool.query(
      `INSERT INTO clinical_event
         (patient_id, source_inbound_id, event_type, occurred_at, local_date, local_time,
          patient_timezone, patient_medication_id, dose_id, semantic_event_id,
          semantic_event_version, authored_by, review_state, clinical_operation,
          is_canonical_patient_report, source_spans, clinical_values)
       VALUES ($1, NULL, 'administration', '2026-08-10T13:00:00Z', '2026-08-10', '09:00',
               'America/Toronto', $2, $3, 'event-clinician-administration', 1, 'clinician',
               'confirmed', 'create', true, '[]'::jsonb, $4::jsonb)`,
      [
        patient.id,
        seeded.medicationId,
        oldDoseId,
        JSON.stringify({
          medicationId: seeded.medicationId,
          medicationVersion: 1,
          doseId: oldDoseId,
          doseVersion: 1,
          adherence: 'taken',
          localDate: '2026-08-10',
          localTime: '09:00',
        }),
      ],
    );

    const turn = await seedTurn(patient, 1, 'Yes', ON_WINDOW_RECEIVED_AT);
    await commit(await preparePromptedConfirmation(turn, seeded));

    expect(await adherenceRows(patient.id)).toEqual([
      expect.objectContaining({
        dose_id: seeded.doseId,
        adherence_state: 'taken',
        decided_by: 'classifier',
        status: 'recorded',
      }),
    ]);
    expect(await latestSummary(patient.id, '2026-08-13')).toMatchObject({
      structured_payload: { adherenceCounts: expect.objectContaining({ taken: 1 }) },
    });
    expect(
      await pool.query(
        `SELECT 1 FROM daily_summary WHERE patient_id = $1 AND local_date = '2026-08-10'::date`,
        [patient.id],
      ),
    ).toMatchObject({ rowCount: 0 });
  });
});
