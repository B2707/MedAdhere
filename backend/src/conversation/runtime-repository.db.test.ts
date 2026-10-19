import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimProviderCircuit,
  loadBoundedExtractionStageResult,
  loadConversationJob,
  persistConversationStageResult,
  recordProviderCircuitFailure,
  recordProviderCircuitSuccess,
  releaseProviderCircuitClaim,
  reserveConversationStage,
} from './runtime-repository.js';

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema-init', 'schema.sql'), 'utf8');
const CONTAINER_TIMEOUT_MS = 180_000;
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LEASE_A = '10000000-0000-4000-8000-000000000001';
const LEASE_B = '10000000-0000-4000-8000-000000000002';
const ZERO_HASH = '0'.repeat(64);
let container: StartedPostgreSqlContainer | undefined;
let pool: Pool;
let phoneCounter = 0;

type SeededTurn = {
  readonly patientId: string;
  readonly inboundMessageId: string;
  readonly turnJobId: string;
};

async function seedPatient(active = true): Promise<string> {
  phoneCounter += 1;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO patient
       (phone, medication_name, owner_clinician_sub, timezone, is_active)
     VALUES ($1, 'legacy medication', $2, 'America/Toronto', $3)
     RETURNING id::text`,
    [`+1500777${String(phoneCounter).padStart(4, '0')}`, OWNER_ID, active],
  );
  return inserted.rows[0]!.id;
}

async function appendTurn(patientId: string, sequence = 1): Promise<SeededTurn> {
  const inbound = await pool.query<{ id: string }>(
    `INSERT INTO inbound_reply
       (patient_id, raw_body, received_at, inbound_sequence)
     VALUES ($1, 'I took it after lunch.',
             '2026-08-11T16:00:00Z'::timestamptz + ($2 * interval '1 minute'), $2)
     RETURNING id::text`,
    [patientId, sequence],
  );
  const job = await pool.query<{ id: string }>(
    `INSERT INTO turn_job
       (patient_id, inbound_message_id, inbound_sequence, messaging_state_version)
     SELECT $1, $2, $3, messaging_state_version FROM patient WHERE id = $1
     RETURNING id::text`,
    [patientId, inbound.rows[0]!.id, sequence],
  );
  return { patientId, inboundMessageId: inbound.rows[0]!.id, turnJobId: job.rows[0]!.id };
}

async function completeQueueJob(turn: SeededTurn): Promise<void> {
  const completed = await pool.query(
    `UPDATE turn_job SET completed_at = now() WHERE id = $1 AND completed_at IS NULL`,
    [turn.turnJobId],
  );
  expect(completed.rowCount).toBe(1);
}

async function loadReady(turn: SeededTurn) {
  const loaded = await loadConversationJob(pool, {
    inboundMessageId: turn.inboundMessageId,
    requestId: '20000000-0000-4000-8000-000000000001',
    expectedLanguage: 'en',
    promptVersion: 'conversation-v1',
    schemaVersion: 'conversation-v1',
  });
  if (loaded?.kind !== 'ready') throw new Error('expected ready job');
  return loaded;
}

function boundedRecord() {
  return {
    modelId: 'claude-sonnet-5',
    promptVersion: 'clinical-extractor-v1',
    schemaVersion: 'clinical-extraction-v2',
    schemaSha256: 'a'.repeat(64),
    contextHash: ZERO_HASH,
    inputTokens: 100,
    outputTokens: 40,
    latencyMs: 100,
    stage: 'interpretation' as const,
    output: { claims: [] },
  };
}

async function persistBoundedStage(turn: SeededTurn): Promise<void> {
  const record = boundedRecord();
  expect(
    await reserveConversationStage(pool, {
      turnJobId: turn.turnJobId,
      patientId: turn.patientId,
      stage: record.stage,
      reservedInputTokens: 1_000,
      reservedOutputTokens: 500,
    }),
  ).toMatchObject({ kind: 'reserved' });
  expect(
    await persistConversationStageResult(pool, {
      turnJobId: turn.turnJobId,
      patientId: turn.patientId,
      record,
    }),
  ).toEqual({ kind: 'stored' });
}

beforeAll(async () => {
  const ciUrl = process.env.TEST_DATABASE_URL;
  if (ciUrl) {
    pool = new Pool({ connectionString: ciUrl });
  } else {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
  }
  await pool.query(SCHEMA_SQL);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('conversation runtime repository against PostgreSQL 16', () => {
  it('loads a bounded DB snapshot and returns an explicit inactive-patient suppression', async () => {
    const patientId = await seedPatient();
    const turn = await appendTurn(patientId);
    await pool.query(
      `INSERT INTO outbound_message (patient_id, status, body, sent_at, message_kind)
       VALUES ($1, 'queued', 'Delivered history', '2026-08-11T15:00:00Z', 'check_in'),
              ($1, 'failed', 'Unsent history', '2026-08-11T15:01:00Z', 'check_in')`,
      [patientId],
    );
    const loaded = await loadReady(turn);
    expect(loaded.input).toMatchObject({
      patientId,
      inboundMessageId: turn.inboundMessageId,
      activeMedications: [],
      clinicalFacts: [],
      drugInteractions: [],
      evidence: [],
    });
    expect(loaded.input.currentDayMessages.map(({ body }) => body)).toEqual(['Delivered history']);
    await pool.query('UPDATE patient SET is_active = false WHERE id = $1', [patientId]);
    await expect(
      loadConversationJob(pool, {
        inboundMessageId: turn.inboundMessageId,
        requestId: '20000000-0000-4000-8000-000000000001',
        expectedLanguage: 'en',
        promptVersion: 'conversation-v1',
        schemaVersion: 'conversation-v1',
      }),
    ).resolves.toEqual({
      kind: 'suppressed',
      turnJobId: turn.turnJobId,
      patientId,
      reason: 'inactive_patient',
    });
    await pool.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('returns the stored intake epoch and suppresses a delayed job after START changes it', async () => {
    const patientId = await seedPatient();
    const turn = await appendTurn(patientId);

    expect((await loadReady(turn)).messagingStateVersion).toBe(1);
    await pool.query(
      `UPDATE patient
          SET provider_opted_in = true,
              messaging_state_version = messaging_state_version + 1
        WHERE id = $1`,
      [patientId],
    );

    await expect(
      loadConversationJob(pool, {
        inboundMessageId: turn.inboundMessageId,
        requestId: '20000000-0000-4000-8000-000000000001',
        expectedLanguage: 'en',
        promptVersion: 'conversation-v1',
        schemaVersion: 'conversation-v1',
      }),
    ).resolves.toEqual({
      kind: 'suppressed',
      turnJobId: turn.turnJobId,
      patientId,
      reason: 'messaging_state_changed',
    });
    await pool.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('fails closed when a legacy turn job has no knowable intake epoch', async () => {
    const patientId = await seedPatient();
    const turn = await appendTurn(patientId);
    await pool.query('UPDATE turn_job SET messaging_state_version = NULL WHERE id = $1', [
      turn.turnJobId,
    ]);

    await expect(
      loadConversationJob(pool, {
        inboundMessageId: turn.inboundMessageId,
        requestId: '20000000-0000-4000-8000-000000000001',
        expectedLanguage: 'en',
        promptVersion: 'conversation-v1',
        schemaVersion: 'conversation-v1',
      }),
    ).resolves.toEqual({
      kind: 'suppressed',
      turnJobId: turn.turnJobId,
      patientId,
      reason: 'messaging_state_changed',
    });
    await pool.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('uses inbound sequence instead of inverted receive timestamps for message history', async () => {
    const patientId = await seedPatient();
    const first = await appendTurn(patientId, 1);
    const second = await appendTurn(patientId, 2);
    const third = await appendTurn(patientId, 3);
    const current = await appendTurn(patientId, 4);
    await pool.query(
      `UPDATE inbound_reply
          SET raw_body = CASE id
                WHEN $1 THEN 'sequence one'
                WHEN $2 THEN 'sequence two'
                WHEN $3 THEN 'sequence three'
                ELSE 'current'
              END,
              received_at = CASE id
                WHEN $1 THEN '2026-08-11T16:02:00Z'::timestamptz
                WHEN $2 THEN '2026-08-11T16:00:00Z'::timestamptz
                WHEN $3 THEN '2026-08-11T16:01:00Z'::timestamptz
                ELSE '2026-08-11T16:04:00Z'::timestamptz
              END
        WHERE id IN ($1, $2, $3, $4)`,
      [
        first.inboundMessageId,
        second.inboundMessageId,
        third.inboundMessageId,
        current.inboundMessageId,
      ],
    );
    const legacy = await pool.query<{ id: string; raw_body: string }>(
      `INSERT INTO inbound_reply (patient_id, raw_body, received_at)
       VALUES ($1, 'legacy prior', '2026-08-11T15:59:00Z'),
              ($1, 'legacy future', '2026-08-11T16:05:00Z')
       RETURNING id::text, raw_body`,
      [patientId],
    );
    const legacyPrior = legacy.rows.find(({ raw_body }) => raw_body === 'legacy prior')!;
    const legacyFuture = legacy.rows.find(({ raw_body }) => raw_body === 'legacy future')!;
    const outbound = await pool.query<{ id: string; body: string }>(
      `INSERT INTO outbound_message (patient_id, status, body, message_kind, sent_at)
       VALUES ($1, 'sent', 'outbound before all', 'check_in', '2026-08-11T15:30:00Z'),
              ($1, 'sent', 'outbound after sequence two', 'check_in',
               '2026-08-11T16:00:30Z')
       RETURNING id::text, body`,
      [patientId],
    );
    const outboundBefore = outbound.rows.find(({ body }) => body === 'outbound before all')!;
    const outboundAfterSecond = outbound.rows.find(
      ({ body }) => body === 'outbound after sequence two',
    )!;

    const firstLoaded = await loadReady(first);
    const currentLoaded = await loadReady(current);

    expect(firstLoaded.input.currentDayMessages.map(({ id }) => id)).not.toContain(
      second.inboundMessageId,
    );
    expect(
      currentLoaded.input.currentDayMessages
        .map(({ id }) => id)
        .filter((id) =>
          [first.inboundMessageId, second.inboundMessageId, third.inboundMessageId].includes(id),
        ),
    ).toEqual([first.inboundMessageId, second.inboundMessageId, third.inboundMessageId]);
    expect(currentLoaded.input.currentDayMessages.map(({ id }) => id)).toContain(legacyPrior.id);
    expect(currentLoaded.input.currentDayMessages.map(({ id }) => id)).not.toContain(
      legacyFuture.id,
    );
    const mixedIds = new Set([
      outboundBefore.id,
      legacyPrior.id,
      first.inboundMessageId,
      second.inboundMessageId,
      outboundAfterSecond.id,
      third.inboundMessageId,
    ]);
    expect(
      currentLoaded.input.currentDayMessages.map(({ id }) => id).filter((id) => mixedIds.has(id)),
    ).toEqual([
      outboundBefore.id,
      legacyPrior.id,
      first.inboundMessageId,
      second.inboundMessageId,
      outboundAfterSecond.id,
      third.inboundMessageId,
    ]);
    await pool.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('copies only bounded DDInter findings into the turn input', async () => {
    const patientId = await seedPatient();
    const release = await pool.query<{ id: string }>(
      `INSERT INTO source_release
         (source_name, release_version, checksum_sha256, source_url, licence_id, terms_url,
          state, is_complete, activated_at)
       VALUES ('ddinter', $1, $2, 'https://ddinter2.scbdd.com/download/',
               'CC-BY-NC-SA-4.0', 'https://ddinter2.scbdd.com/terms/', 'active', true, now())
       RETURNING id::text`,
      [`runtime-${patientId}`, 'c'.repeat(64)],
    );
    const medications = await pool.query<{ id: string; entered_name: string }>(
      `INSERT INTO patient_medication
         (patient_id, entered_name, valid_from, status, confirmed_by_clinician_sub, confirmed_at)
       VALUES ($1, 'Amoxicillin', '2026-08-01', 'active', $2, now()),
              ($1, 'Warfarin', '2026-08-01', 'active', $2, now())
       RETURNING id::text, entered_name`,
      [patientId, OWNER_ID],
    );
    for (const [index, medication] of medications.rows.entries()) {
      await pool.query(
        `INSERT INTO patient_medication_ingredient
           (patient_id, patient_medication_id, ingredient_order, ingredient_name, rxcui)
         VALUES ($1, $2, 1, $3, $4)`,
        [patientId, medication.id, medication.entered_name, index === 0 ? '723' : '11289'],
      );
    }
    await pool.query(
      `INSERT INTO ddinter_drug (source_release_id, ddinter_drug_id, display_name)
       VALUES ($1, 'DD-AMOX', 'Amoxicillin'), ($1, 'DD-WARF', 'Warfarin')`,
      [release.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO ingredient_ddinter_map
         (source_release_id, identity_system, identity_code, ddinter_drug_id,
          mapping_status, reviewed_by, reviewed_at)
       VALUES ($1, 'rxnorm', '723', 'DD-AMOX', 'mapped', 'reviewer', now()),
              ($1, 'rxnorm', '11289', 'DD-WARF', 'mapped', 'reviewer', now())`,
      [release.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO medication_interaction
         (source_release_id, low_ddinter_drug_id, high_ddinter_drug_id, interaction_level)
       VALUES ($1, 'DD-AMOX', 'DD-WARF', 'major')`,
      [release.rows[0]!.id],
    );
    const loaded = await loadReady(await appendTurn(patientId));

    expect(loaded.input.drugInteractions).toEqual([
      expect.objectContaining({
        state: 'interaction_found',
        source: 'ddinter',
        displayNames: ['Amoxicillin', 'Warfarin'],
        pair: { lowDrugId: 'DD-AMOX', highDrugId: 'DD-WARF' },
        level: 'major',
      }),
    ]);
    await pool.query('DELETE FROM patient WHERE id = $1', [patientId]);
    await pool.query('DELETE FROM source_release WHERE id = $1', [release.rows[0]!.id]);
  });

  it('loads patient language, pending candidates, dose attribution, and prior correction identity', async () => {
    const patientId = await seedPatient();
    await pool.query(`UPDATE patient SET preferred_language = 'fr' WHERE id = $1`, [patientId]);
    const sourceTurn = await appendTurn(patientId, 1);
    const promptTurn = await appendTurn(patientId, 2);
    const promptAgentTurn = await pool.query<{ id: string }>(
      `INSERT INTO agent_turn
         (patient_id, inbound_message_id, turn_job_id, detected_language,
          normalized_english_meaning, model_id, prompt_version, schema_version,
          context_hash, input_tokens, output_tokens, latency_ms, final_policy_tier)
       VALUES ($1, $2, $3, 'en', 'The patient identified the white pill.', 'test-model',
               'conversation-v1', 'conversation-v1', $4, 0, 0, 0, 'routine')
       RETURNING id::text`,
      [patientId, promptTurn.inboundMessageId, promptTurn.turnJobId, ZERO_HASH],
    );
    await pool.query(
      `INSERT INTO clinician_review_draft
         (patient_id, local_date, version, input_hash, patient_statements, draft_text,
          source_agent_turn_id)
       VALUES ($1, '2026-08-11', 1, $2, $3::jsonb, 'Structured clinician review draft', $4)`,
      [
        patientId,
        ZERO_HASH,
        JSON.stringify([
          { sourceMessageId: sourceTurn.inboundMessageId, text: 'Original patient report.' },
          { sourceMessageId: promptTurn.inboundMessageId, text: 'The white pill.' },
        ]),
        promptAgentTurn.rows[0]!.id,
      ],
    );
    const medication = await pool.query<{ id: string }>(
      `INSERT INTO patient_medication
         (patient_id, entered_name, valid_from, valid_to, status,
          confirmed_by_clinician_sub, confirmed_at)
       VALUES ($1, 'Prior medication', '2026-08-01', '2026-08-10', 'active', $2, now())
       RETURNING id::text`,
      [patientId, OWNER_ID],
    );
    await pool.query(
      `INSERT INTO patient_medication
         (patient_id, entered_name, valid_from, status, confirmed_by_clinician_sub,
          confirmed_at, supersedes_id)
       VALUES ($1, 'Current medication', '2026-08-11', 'active', $2, now(), $3)`,
      [patientId, OWNER_ID, medication.rows[0]!.id],
    );
    const doses = await pool.query<{ id: string; local_dose_time: string }>(
      `INSERT INTO dose_schedule
         (patient_id, patient_medication_id, scheduled_at, local_dose_time,
          dose_date, schedule_timezone)
       VALUES
         ($1, $2, '2026-08-11T00:00:00Z', '20:00', '2026-08-10', 'America/Toronto'),
         ($1, $2, '2026-08-11T12:00:00Z', '08:00', '2026-08-11', 'America/Toronto'),
         ($1, $2, '2026-08-12T00:00:00Z', '20:00', '2026-08-11', 'America/Toronto')
       RETURNING id::text, local_dose_time`,
      [patientId, medication.rows[0]!.id],
    );
    const priorDose = doses.rows.find(({ local_dose_time }) => local_dose_time === '20:00')!;
    const original = await pool.query<{ id: string }>(
      `INSERT INTO clinical_event
         (patient_id, source_inbound_id, event_type, event_code, statement_text, normalized_value, occurred_at,
          local_date, local_time, patient_timezone, severity, patient_medication_id, dose_id,
          created_at)
       VALUES ($1, $4, 'observation', 'symptom', 'Headache', 'headache',
               '2026-08-11T00:00:00Z', '2026-08-10', '20:00', 'America/Toronto', 2, $2, $3,
               '2026-08-11T15:00:00Z')
       RETURNING id::text`,
      [patientId, medication.rows[0]!.id, priorDose.id, sourceTurn.inboundMessageId],
    );
    const correction = await pool.query<{ id: string }>(
      `INSERT INTO clinical_event
         (patient_id, source_inbound_id, event_type, event_code, statement_text, normalized_value, occurred_at,
          local_date, local_time, patient_timezone, severity, patient_medication_id, dose_id,
          supersedes_id, created_at)
       VALUES ($1, $5, 'observation', 'correction', 'Headache was mild', 'headache',
               '2026-08-11T00:01:00Z', '2026-08-10', '20:01', 'America/Toronto', 2, $2, $3,
               $4, '2026-08-11T15:01:00Z')
       RETURNING id::text`,
      [
        patientId,
        medication.rows[0]!.id,
        priorDose.id,
        original.rows[0]!.id,
        sourceTurn.inboundMessageId,
      ],
    );
    await pool.query(
      `INSERT INTO outbound_message
         (patient_id, agent_turn_id, status, body, message_kind, language, clarification_topic,
          temporal_candidates, in_reply_to_inbound_id, sent_at)
       VALUES ($1, $4, 'delivered', 'Was that 8 AM or PM?', 'clarification', 'fr',
               'dose_meridiem', $2::jsonb, $3, '2026-08-11T16:02:30Z')`,
      [
        patientId,
        JSON.stringify(
          doses.rows
            .filter(({ local_dose_time }) => local_dose_time === '20:00')
            .map(({ id }) => ({
              candidateId: id,
              patientMedicationId: medication.rows[0]!.id,
              doseId: id,
              occurredAtUtc: '2026-08-11T00:00:00.000Z',
              localDate: '2026-08-10',
              localTime: '20:00',
              patientTimeZone: 'America/Toronto',
              source: 'scheduled_dose',
              ambiguous: true,
            })),
        ),
        promptTurn.inboundMessageId,
        promptAgentTurn.rows[0]!.id,
      ],
    );
    const turn = await appendTurn(patientId, 3);
    const loaded = await loadReady(turn);

    expect(loaded.input.locale.expectedLanguage).toBe('en');
    expect(loaded.input.currentMessage.language).toBe('en');
    expect(loaded.input.pendingClarification).toBe('Was that 8 AM or PM?');
    expect(loaded.input.pendingClarificationTopic).toBe('dose_meridiem');
    expect(loaded.input.pendingClarificationSourceMessageId).toBe(sourceTurn.inboundMessageId);
    expect(loaded.input.activeMedications.map(({ enteredName }) => enteredName)).toEqual([
      'Prior medication',
    ]);
    expect(loaded.input.temporalCandidates.map(({ candidateId }) => candidateId)).toEqual([
      priorDose.id,
    ]);
    expect(loaded.input.recentObservations.at(-1)).toMatchObject({
      clinicalEventId: correction.rows[0]!.id,
      sourceMessageId: sourceTurn.inboundMessageId,
      supersedesClinicalEventId: original.rows[0]!.id,
      normalizedValue: 'headache',
      severity: 2,
      temporalCandidateIds: [priorDose.id],
      patientMedicationIds: [medication.rows[0]!.id],
    });
    await pool.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('loads an older scheduled dose named by an explicit ISO date without widening to other dates', async () => {
    const patientId = await seedPatient();
    const historicalMedication = await pool.query<{ id: string }>(
      `INSERT INTO patient_medication
         (patient_id, entered_name, valid_from, valid_to, status,
          confirmed_by_clinician_sub, confirmed_at)
       VALUES ($1, 'Historical medication', '2026-08-01', '2026-08-08', 'active', $2, now())
       RETURNING id::text`,
      [patientId, OWNER_ID],
    );
    await pool.query(
      `INSERT INTO patient_medication
         (patient_id, entered_name, valid_from, status, confirmed_by_clinician_sub,
          confirmed_at, supersedes_id)
       VALUES ($1, 'Replacement medication', '2026-08-09', 'active', $2, now(), $3)`,
      [patientId, OWNER_ID, historicalMedication.rows[0]!.id],
    );
    const doses = await pool.query<{ id: string; local_date: string }>(
      `INSERT INTO dose_schedule
         (patient_id, patient_medication_id, scheduled_at, local_dose_time, dose_date,
          schedule_timezone)
       VALUES
         ($1, $2, '2026-08-08T13:00:00Z', '09:00', '2026-08-08', 'America/Toronto'),
         ($1, $2, '2026-08-07T13:00:00Z', '09:00', '2026-08-07', 'America/Toronto')
       RETURNING id::text, dose_date::text AS local_date`,
      [patientId, historicalMedication.rows[0]!.id],
    );
    const turn = await appendTurn(patientId);
    await pool.query(
      `UPDATE inbound_reply
          SET raw_body = 'I meant the dose on 2026-08-08.'
        WHERE id = $1`,
      [turn.inboundMessageId],
    );

    const loaded = await loadReady(turn);
    const expected = doses.rows.find(({ local_date }) => local_date === '2026-08-08')!;
    const unrelated = doses.rows.find(({ local_date }) => local_date === '2026-08-07')!;

    expect(loaded.input.temporalCandidates.map(({ candidateId }) => candidateId)).toEqual([
      expected.id,
    ]);
    expect(loaded.input.temporalCandidates.map(({ candidateId }) => candidateId)).not.toContain(
      unrelated.id,
    );
    expect(loaded.input.activeMedications.map(({ enteredName }) => enteredName)).toEqual([
      'Historical medication',
    ]);
    await pool.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('fails closed instead of truncating more than sixty current-day messages', async () => {
    const patientId = await seedPatient();
    const turn = await appendTurn(patientId);
    await pool.query(
      `INSERT INTO inbound_reply (patient_id, raw_body, received_at)
       SELECT $1, 'prior-' || ordinal::text,
              '2026-08-11T15:00:00Z'::timestamptz + (ordinal * interval '1 second')
         FROM generate_series(1, 61) AS ordinal`,
      [patientId],
    );
    await expect(loadReady(turn)).rejects.toMatchObject({
      name: 'RuntimeContextOverflowError',
      collection: 'messages',
    });
    await pool.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('atomically reserves and reconciles the strict bounded checkpoint', async () => {
    const patientId = await seedPatient();
    const turn = await appendTurn(patientId);
    await persistBoundedStage(turn);
    expect(
      await reserveConversationStage(pool, {
        turnJobId: turn.turnJobId,
        patientId,
        stage: 'interpretation',
        reservedInputTokens: 1,
        reservedOutputTokens: 1,
      }),
    ).toEqual({ kind: 'already_attempted' });
    const stored = await loadBoundedExtractionStageResult(pool, {
      turnJobId: turn.turnJobId,
      patientId,
    });
    expect(stored?.output).toEqual({ claims: [] });
    expect(
      await persistConversationStageResult(pool, {
        turnJobId: turn.turnJobId,
        patientId,
        record: boundedRecord(),
      }),
    ).toEqual({ kind: 'replay' });
    const usage = await pool.query<{ reserved: number; consumed: number }>(
      `SELECT sum(reserved_units)::int AS reserved, sum(consumed_units)::int AS consumed
         FROM usage_bucket WHERE patient_id = $1`,
      [patientId],
    );
    expect(usage.rows[0]).toEqual({ reserved: 0, consumed: 140 });
    await pool.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('serializes concurrent FIFO reservations without overspending a patient local-day budget', async () => {
    const patientId = await seedPatient();
    const first = await appendTurn(patientId, 1);
    const second = await appendTurn(patientId, 2);
    const reserve = (turn: SeededTurn) =>
      reserveConversationStage(pool, {
        turnJobId: turn.turnJobId,
        patientId,
        stage: 'interpretation',
        reservedInputTokens: 250_000,
        reservedOutputTokens: 20_000,
      });
    const [firstResult, secondResult] = await Promise.allSettled([reserve(first), reserve(second)]);
    expect(firstResult).toMatchObject({ status: 'fulfilled', value: { kind: 'reserved' } });
    expect(secondResult.status).toBe('rejected');
    if (secondResult.status !== 'rejected') throw new Error('expected_fifo_rejection');
    expect(String(secondResult.reason)).toContain('conversation_job_not_lowest_unfinished');

    await completeQueueJob(first);
    await expect(reserve(second)).resolves.toEqual({ kind: 'budget_exhausted' });
    const total = await pool.query<{ total: number }>(
      `SELECT sum(reserved_units + consumed_units)::int AS total
         FROM usage_bucket WHERE patient_id = $1`,
      [patientId],
    );
    expect(total.rows[0]!.total).toBe(270_000);
    await pool.query('DELETE FROM patient WHERE id = $1', [patientId]);
  });

  it('opens after five failures and grants only one expired-cooldown half-open probe', async () => {
    const providerKey = `anthropic-${phoneCounter}`;
    for (let index = 0; index < 5; index += 1) {
      await recordProviderCircuitFailure(pool, {
        providerKey,
        leaseId: LEASE_A,
        failureKind: 'transient',
      });
    }
    expect(await claimProviderCircuit(pool, { providerKey, leaseId: LEASE_A })).toMatchObject({
      kind: 'open',
    });
    await pool.query(
      `UPDATE provider_circuit SET cooldown_until = now() - interval '1 second'
        WHERE provider_key = $1`,
      [providerKey],
    );
    const claims = await Promise.all([
      claimProviderCircuit(pool, { providerKey, leaseId: LEASE_A }),
      claimProviderCircuit(pool, { providerKey, leaseId: LEASE_B }),
    ]);
    expect(claims.filter(({ kind }) => kind === 'half_open')).toHaveLength(1);
    expect(claims.filter(({ kind }) => kind === 'open')).toHaveLength(1);
    const halfOpen = claims.find(({ kind }) => kind === 'half_open');
    if (halfOpen?.kind !== 'half_open') throw new Error('expected half-open claim');
    await releaseProviderCircuitClaim(pool, {
      providerKey,
      leaseId: halfOpen.leaseId,
    });
    const replacement = await claimProviderCircuit(pool, {
      providerKey,
      leaseId: LEASE_B,
    });
    expect(replacement).toMatchObject({ kind: 'half_open', leaseId: LEASE_B });
    await recordProviderCircuitSuccess(pool, {
      providerKey,
      leaseId: LEASE_B,
    });
    expect(await claimProviderCircuit(pool, { providerKey, leaseId: LEASE_A })).toEqual({
      kind: 'closed',
    });
    await pool.query('DELETE FROM provider_circuit WHERE provider_key = $1', [providerKey]);
  });

  it('opens immediately for an authentication failure', async () => {
    const providerKey = `anthropic-auth-${phoneCounter}`;
    await recordProviderCircuitFailure(pool, {
      providerKey,
      leaseId: LEASE_A,
      failureKind: 'auth',
    });
    expect(await claimProviderCircuit(pool, { providerKey, leaseId: LEASE_B })).toMatchObject({
      kind: 'open',
    });
    await recordProviderCircuitFailure(pool, {
      providerKey,
      leaseId: LEASE_A,
      failureKind: 'transient',
    });
    expect(await claimProviderCircuit(pool, { providerKey, leaseId: LEASE_B })).toMatchObject({
      kind: 'open',
    });
    await pool.query('DELETE FROM provider_circuit WHERE provider_key = $1', [providerKey]);
  });

  it('does not let a late closed-claim success erase a newer authentication trip', async () => {
    const providerKey = `anthropic-stale-success-${phoneCounter}`;
    const first = await claimProviderCircuit(pool, { providerKey, leaseId: LEASE_A });
    const second = await claimProviderCircuit(pool, { providerKey, leaseId: LEASE_B });
    expect(first).toEqual({ kind: 'closed' });
    expect(second).toEqual({ kind: 'closed' });

    await recordProviderCircuitFailure(pool, {
      providerKey,
      leaseId: LEASE_B,
      failureKind: 'auth',
    });
    await recordProviderCircuitSuccess(pool, { providerKey, leaseId: LEASE_A });

    const stored = await pool.query<{
      state: string;
      consecutive_failures: number;
      last_failure_kind: string | null;
    }>(
      `SELECT state, consecutive_failures, last_failure_kind
         FROM provider_circuit
        WHERE provider_key = $1`,
      [providerKey],
    );
    expect(stored.rows[0]).toEqual({
      state: 'open',
      consecutive_failures: 1,
      last_failure_kind: 'auth',
    });
    await pool.query('DELETE FROM provider_circuit WHERE provider_key = $1', [providerKey]);
  });

  it('lets a later success reset a sub-threshold failure while the circuit stays closed', async () => {
    const providerKey = `anthropic-stale-success-threshold-${phoneCounter}`;
    const first = await claimProviderCircuit(pool, { providerKey, leaseId: LEASE_A });
    const second = await claimProviderCircuit(pool, { providerKey, leaseId: LEASE_B });
    expect(first).toEqual({ kind: 'closed' });
    expect(second).toEqual({ kind: 'closed' });

    await recordProviderCircuitFailure(pool, {
      providerKey,
      leaseId: LEASE_B,
      failureKind: 'transient',
    });
    await recordProviderCircuitSuccess(pool, { providerKey, leaseId: LEASE_A });

    const stored = await pool.query<{
      state: string;
      consecutive_failures: number;
      last_failure_kind: string | null;
    }>(
      `SELECT state, consecutive_failures, last_failure_kind
         FROM provider_circuit
        WHERE provider_key = $1`,
      [providerKey],
    );
    expect(stored.rows[0]).toEqual({
      state: 'closed',
      consecutive_failures: 0,
      last_failure_kind: null,
    });
    await pool.query('DELETE FROM provider_circuit WHERE provider_key = $1', [providerKey]);
  });
});
