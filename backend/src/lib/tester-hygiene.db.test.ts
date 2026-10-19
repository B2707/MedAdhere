/**
 * tester-hygiene.db.test.ts — STUDY-04 + DATA-01 integration proofs against a REAL PostgreSQL 16
 * (testcontainers, or a CI-provided PG via TEST_DATABASE_URL — the F67 real-DB posture cloned from
 * schema.test.ts). `@aws-sdk/client-scheduler` is mocked at the SDK boundary so the wipe's M5
 * schedule sweep runs hermetically; every other operation hits the real database.
 *
 * Covered:
 *   - STUDY-04: wipeTestPatients CASCADE-clears live child tables for is_test patients and
 *     leaves a real (is_test=false) patient and its children untouched (no orphans), and sweeps
 *     the `dose-`/`timeout-` schedules of every tester (M5).
 *   - DATA-01 (H7, redact-in-place): scrubTesterText blanks EXACTLY that tester's raw_body,
 *     DELETEs its label_match rows, and KEEPS safety_events + adherence_record (and the
 *     adherence→inbound linkage) intact.
 *   - DATA-01 guard: an is_test=false patient's raw_body SURVIVES a scrub attempt — the
 *     patient-JOIN on p.is_test=true is the load-bearing guard.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

const { schedulerSend } = vi.hoisted(() => ({ schedulerSend: vi.fn() }));

vi.mock('@aws-sdk/client-scheduler', () => ({
  SchedulerClient: class {
    send = schedulerSend;
  },
  ListSchedulesCommand: class {
    readonly kind = 'list';
    constructor(readonly input: Record<string, unknown>) {}
  },
  DeleteScheduleCommand: class {
    readonly kind = 'delete';
    constructor(readonly input: Record<string, unknown>) {}
  },
}));

import {
  scrubTesterText,
  STUDY04_CASCADE_CHILDREN,
  wipeTestPatients,
  type Queryable,
} from './tester-hygiene';

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema-init', 'schema.sql'), 'utf8');
const CONTAINER_TIMEOUT_MS = 180_000;

let container: StartedPostgreSqlContainer | undefined;
let client: Client;
let liveStudy04Children: readonly string[] = [];

async function applySchema(c: Client): Promise<void> {
  await c.query('BEGIN');
  try {
    await c.query(SCHEMA_SQL);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  }
}

beforeAll(async () => {
  const ciUrl = process.env.TEST_DATABASE_URL;
  if (ciUrl) {
    client = new Client({ connectionString: ciUrl });
    await client.connect();
  } else {
    container = await new PostgreSqlContainer('postgres:16').start();
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
  }
  await applySchema(client);
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])`,
    [[...STUDY04_CASCADE_CHILDREN]],
  );
  liveStudy04Children = rows.map((row) => row.table_name);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

beforeEach(() => {
  schedulerSend.mockReset();
  schedulerSend.mockResolvedValue({ Schedules: [] });
});

// ---- seed helpers ----------------------------------------------------------------------

let phoneCounter = 0;
const TEST_OWNER_SUB = '8f6e7138-fd21-4b31-8ac3-934cfc610f44';

function nextPhone(): string {
  phoneCounter += 1;
  return `+1500666${String(phoneCounter).padStart(4, '0')}`;
}

/** Seed a patient with the full child fan-out (dose, outbound, inbound, adherence, safety, label). */
async function seedPatientGraph(
  isTest: boolean,
  rawBody: string,
): Promise<{ patientId: string; doseId: string; inboundId: string }> {
  const p = await client.query<{ id: string }>(
    `INSERT INTO patient (owner_clinician_sub, phone, medication_name, is_test) VALUES ($1, $2, 'metformin', $3) RETURNING id`,
    [TEST_OWNER_SUB, nextPhone(), isTest],
  );
  const patientId = p.rows[0]!.id;

  const release = await client.query<{ id: string }>(
    `INSERT INTO source_release
       (source_name, release_version, checksum_sha256, source_url, licence_id, state, is_complete)
     VALUES ($1, '2026-test', $2, 'https://example.invalid/hygiene', 'test-only', 'active', true)
     RETURNING id`,
    [`hygiene-${patientId}`, 'c'.repeat(64)],
  );
  const releaseId = release.rows[0]!.id;
  const evidence = await client.query<{ id: string }>(
    `INSERT INTO evidence_record
       (source_release_id, evidence_code, evidence_kind, language, passage, source_url, coverage_state)
     VALUES ($1, $2, 'label', 'en', 'bounded evidence text', 'https://example.invalid/e', 'direct_evidence')
     RETURNING id`,
    [releaseId, patientId],
  );
  const medication = await client.query<{ id: string }>(
    `INSERT INTO patient_medication
       (patient_id, entered_name, identity_system, identity_code, dose_text, form, route, status,
        confirmed_by_clinician_sub, confirmed_at)
     VALUES ($1, 'Metformin patient text', 'local', $2, '500 mg', 'tablet', 'oral', 'active', $3, now())
     RETURNING id`,
    [patientId, patientId, TEST_OWNER_SUB],
  );
  const medicationId = medication.rows[0]!.id;

  const d = await client.query<{ id: string }>(
    `INSERT INTO dose_schedule (patient_id, patient_medication_id, scheduled_at, local_dose_time)
     VALUES ($1, $2, now(), '09:00') RETURNING id`,
    [patientId, medicationId],
  );
  const doseId = d.rows[0]!.id;

  const inbound = await client.query<{ id: string }>(
    `INSERT INTO inbound_reply (patient_id, dose_id, raw_body, inbound_sequence)
     VALUES ($1, $2, $3, 1) RETURNING id`,
    [patientId, doseId, rawBody],
  );
  const inboundId = inbound.rows[0]!.id;

  await client.query(
    `INSERT INTO outbound_message (patient_id, dose_id, status, body)
     VALUES ($1, $2, 'sent', 'outbound patient text')`,
    [patientId, doseId],
  );
  await client.query(
    `INSERT INTO adherence_record
       (patient_id, dose_id, inbound_message_id, adherence_state, reason_code, safety_flag, decided_by, status)
     VALUES ($1, $2, $3, 'taken', 'none', 'none', 'classifier', 'recorded')`,
    [patientId, doseId, inboundId],
  );
  await client.query(
    `INSERT INTO safety_events (patient_id, inbound_message_id, flag_category) VALUES ($1, $2, 'crisis')`,
    [patientId, inboundId],
  );
  await client.query(
    `INSERT INTO label_match (patient_id, inbound_message_id, matched_phrase, meddra_pt, hint_level)
     VALUES ($1, $2, 'stomach hurt', 'Abdominal pain', 'info')`,
    [patientId, inboundId],
  );
  await client.query(
    `INSERT INTO patient_medication_ingredient
       (patient_id, patient_medication_id, ingredient_order, ingredient_name, ccdd_ingredient_code, rxcui)
     VALUES ($1, $2, 1, 'Metformin ingredient text', 'CCDD-1', '860975')`,
    [patientId, medicationId],
  );
  const turnJob = await client.query<{ id: string }>(
    `INSERT INTO turn_job (patient_id, inbound_message_id, inbound_sequence)
     VALUES ($1, $2, 1) RETURNING id`,
    [patientId, inboundId],
  );
  const turnJobId = turnJob.rows[0]!.id;
  await client.query(
    `UPDATE turn_job
        SET interpretation_attempted_at = now(),
            interpretation_result = '{"normalizedEnglishMeaning":"patient stage text"}'::jsonb,
            writer_attempted_at = now(),
            writer_result = '{"body":"agent writer patient text"}'::jsonb
      WHERE id = $1`,
    [turnJobId],
  );
  const agentTurn = await client.query<{ id: string }>(
    `INSERT INTO agent_turn
       (patient_id, inbound_message_id, turn_job_id, detected_language, normalized_english_meaning,
        translated_text, model_id, prompt_version, schema_version, context_hash, input_tokens,
        output_tokens, latency_ms, final_policy_tier)
     VALUES ($1, $2, $3, 'en', 'normalized patient text', 'translated patient text',
        'model-test', 'prompt-test', 'schema-test', $4, 1, 1, 1, 'routine')
     RETURNING id`,
    [patientId, inboundId, turnJobId, 'd'.repeat(64)],
  );
  const agentTurnId = agentTurn.rows[0]!.id;
  await client.query(
    `INSERT INTO outbound_message
       (patient_id, status, body, message_kind, in_reply_to_inbound_id, agent_turn_id,
        language, clarification_topic, temporal_candidates)
     VALUES ($1, 'prepared', 'agent outbound patient text', 'clarification', $2, $3, 'en',
             'dose_meridiem', $4::jsonb)`,
    [
      patientId,
      inboundId,
      agentTurnId,
      JSON.stringify([{ candidateId: doseId, doseId, patientMedicationId: medicationId }]),
    ],
  );
  await client.query(
    `INSERT INTO clinical_fact
       (patient_id, fact_type, statement_text, status, authored_by_clinician_sub)
     VALUES ($1, 'note', 'clinician fact text', 'current', $2)`,
    [patientId, TEST_OWNER_SUB],
  );
  const event = await client.query<{ id: string }>(
    `INSERT INTO clinical_event
       (patient_id, agent_turn_id, source_inbound_id, event_type, statement_text,
        normalized_value, occurred_at, local_date, local_time, patient_timezone,
        patient_medication_id, dose_id, semantic_event_id, semantic_event_version,
        authored_by, review_state, clinical_operation, is_canonical_patient_report,
        source_spans, clinical_values)
     VALUES ($1, $2, $3, 'patient_statement', 'patient event text', 'patient event', now(),
             CURRENT_DATE, '09:00', 'America/Toronto', $4, $5, $6, 1,
             'patient', 'unreviewed', 'create', false, '[]'::jsonb, '{}'::jsonb)
     RETURNING id`,
    [patientId, agentTurnId, inboundId, medicationId, doseId, `event-${patientId}`],
  );
  const eventId = event.rows[0]!.id;
  await client.query(
    `INSERT INTO clinical_event_source
       (patient_id, clinical_event_id, source_inbound_id, source_order)
     VALUES ($1, $2, $3, 0)`,
    [patientId, eventId, inboundId],
  );
  await client.query(
    `INSERT INTO clinical_event_evidence
       (patient_id, clinical_event_id, evidence_record_id, template_id)
     VALUES ($1, $2, $3, 'template-test')`,
    [patientId, eventId, evidence.rows[0]!.id],
  );
  const need = await client.query<{ id: string }>(
    `INSERT INTO information_need
       (patient_id, semantic_need_id, origin_inbound_id, origin_inbound_sequence,
        requested_field, question_id, priority, created_by_agent_turn_id)
     VALUES ($1, $2, $3, 1, 'event_identity', $4, 110, $5)
     RETURNING id`,
    [patientId, `need-${patientId}`, inboundId, `question-${patientId}`, agentTurnId],
  );
  const needId = need.rows[0]!.id;
  await client.query(
    `INSERT INTO information_need_scope (patient_id, information_need_id, scope_payload)
     VALUES ($1, $2, $3::jsonb)`,
    [
      patientId,
      needId,
      JSON.stringify({
        candidateMedicationIds: [],
        candidateDoseIds: [],
        candidateSymptomEventIds: [],
        candidateHistoricalEventIds: [],
        candidateHistoricalEvents: [{ eventId: `event-${patientId}`, eventVersion: 1 }],
        pendingOperation: { kind: 'recur' },
      }),
    ],
  );
  await client.query(
    `INSERT INTO information_need_event_candidate
       (patient_id, information_need_id, candidate_order, clinical_event_id,
        candidate_event_semantic_id, candidate_event_version)
     VALUES ($1, $2, 0, $3, $4, 1)`,
    [patientId, needId, eventId, `event-${patientId}`],
  );
  await client.query(
    `INSERT INTO information_need_transition
       (patient_id, information_need_id, command_semantic_id, source_inbound_id,
        agent_turn_id, transition_version, from_state, to_state, clarification_attempt_used)
     VALUES ($1, $2, $3, $4, $5, 1, NULL, 'open', false)`,
    [patientId, needId, `command-${patientId}`, inboundId, agentTurnId],
  );
  const reviewItem = await client.query<{ id: string }>(
    `INSERT INTO clinical_review_item
       (patient_id, semantic_review_item_id, semantic_unresolved_report_id, item_kind,
        source_inbound_id, target_clinical_event_id, reason, source_spans,
        candidate_scope, created_by_agent_turn_id)
     VALUES ($1, $2, $3, 'unresolved_report', $4, $5, 'test review', '[]'::jsonb,
             $6::jsonb, $7)
     RETURNING id`,
    [
      patientId,
      `review-${patientId}`,
      `unresolved-${patientId}`,
      inboundId,
      eventId,
      JSON.stringify({
        candidateMedicationIds: [],
        candidateDoseIds: [],
        candidateEventIds: [`event-${patientId}`],
      }),
      agentTurnId,
    ],
  );
  await client.query(
    `INSERT INTO clinical_review_item_transition
       (patient_id, clinical_review_item_id, agent_turn_id, transition_version,
        from_status, to_status)
     VALUES ($1, $2, $3, 1, NULL, 'open')`,
    [patientId, reviewItem.rows[0]!.id, agentTurnId],
  );
  await client.query(
    `INSERT INTO daily_summary
       (patient_id, local_date, version, window_start, window_end, input_hash,
        event_count, highest_tier, summary_text)
     VALUES ($1, CURRENT_DATE, 1, now(), now() + interval '1 hour', $2, 1, 'routine',
        'summary patient text')`,
    [patientId, 'e'.repeat(64)],
  );
  const draft = await client.query<{ id: string }>(
    `INSERT INTO clinician_review_draft
       (patient_id, local_date, version, input_hash, patient_statements, confirmed_facts,
        model_inferences, uncertainties, evidence_references, proposed_corrections, draft_text,
        source_agent_turn_id)
     VALUES ($1, CURRENT_DATE, 1, $2, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
        '[]'::jsonb, '[]'::jsonb, 'draft patient text', $3)
     RETURNING id`,
    [patientId, 'f'.repeat(64), agentTurnId],
  );
  await client.query(
    `INSERT INTO clinician_review_action
       (patient_id, clinician_review_draft_id, clinician_sub, decision, expected_version)
     VALUES ($1, $2, $3, 'confirm', 1)`,
    [patientId, draft.rows[0]!.id, TEST_OWNER_SUB],
  );
  await client.query(
    `INSERT INTO usage_bucket
       (bucket_scope, subject_key, patient_id, window_start, window_end, limit_units)
     VALUES ('patient_tokens', $1, $2, now(), now() + interval '1 day', 10)`,
    [patientId, patientId],
  );
  return { patientId, doseId, inboundId };
}

async function count(table: string, patientId: string): Promise<number> {
  // `patient` is keyed by `id`; every child table references it via `patient_id`.
  const keyColumn = table === 'patient' ? 'id' : 'patient_id';
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE ${keyColumn} = $1`,
    [patientId],
  );
  return Number(rows[0]!.n);
}

// ---- STUDY-04 wipe ---------------------------------------------------------------------

describe('wipeTestPatients (STUDY-04) — CASCADE clears testers, spares real patients, sweeps schedules', () => {
  it('removes testers without orphans, spares real patients, and sweeps every prefix (M5)', async () => {
    await client.query('BEGIN');
    try {
      const testerA = await seedPatientGraph(true, 'took it');
      const testerB = await seedPatientGraph(true, 'skipped today');
      const real = await seedPatientGraph(false, 'real patient reply');
      const scopedClient: Queryable = {
        async query(text, values) {
          if (text === 'SELECT id FROM patient WHERE is_test = true') {
            return {
              rows: [{ id: testerA.patientId }, { id: testerB.patientId }],
              rowCount: 2,
            };
          }
          return client.query(text, values as unknown[]);
        },
      };
      const result = await wipeTestPatients(scopedClient, {
        confirmDestructive: true,
      });

      // Every tester + child row is gone…
      expect(await count('patient', testerA.patientId)).toBe(0);
      expect(await count('patient', testerB.patientId)).toBe(0);
      for (const t of liveStudy04Children) {
        expect(await count(t, testerA.patientId), `${t} orphan for tester A`).toBe(0);
        expect(await count(t, testerB.patientId), `${t} orphan for tester B`).toBe(0);
      }
      // …while the real (is_test=false) patient and ALL its children survive untouched.
      expect(await count('patient', real.patientId)).toBe(1);
      for (const t of liveStudy04Children) {
        expect(await count(t, real.patientId), `${t} must survive for the real patient`).toBe(
          t === 'outbound_message' ? 2 : 1,
        );
      }

      // M5: the sweep hit every prefix for both testers before the DELETE.
      const prefixes = (
        schedulerSend.mock.calls as Array<[{ input: Record<string, unknown> }]>
      ).map(([cmd]) => cmd.input.NamePrefix as string);
      for (const id of [testerA.patientId, testerB.patientId]) {
        expect(prefixes).toContain(`dose-${id}-`);
        expect(prefixes).toContain(`reminder-${id}-`);
        expect(prefixes).toContain(`timeout-${id}-`);
      }

      expect(result.testersFound).toBe(2);
      expect(result.patientsDeleted).toBe(2);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

// ---- DATA-01 per-tester scrub ----------------------------------------------------------

describe('scrubTesterText (DATA-01, H7 redact-in-place) — blanks raw_body, deletes label_match, keeps audit', () => {
  it("sets exactly that tester's raw_body='' and deletes its label_match, but KEEPS safety_events + adherence_record (and the inbound linkage)", async () => {
    const tester = await seedPatientGraph(true, 'chest pain, took the pill');
    const other = await seedPatientGraph(true, 'other tester text');

    const result = await scrubTesterText(client as unknown as Queryable, tester.patientId, {
      confirmDestructive: true,
    });

    // raw_body redacted in place — the row and its linkage are KEPT.
    const scrubbed = await client.query<{ raw_body: string }>(
      `SELECT raw_body FROM inbound_reply WHERE id = $1`,
      [tester.inboundId],
    );
    expect(
      scrubbed.rowCount,
      'the inbound_reply row must remain (redact-in-place, never delete)',
    ).toBe(1);
    expect(scrubbed.rows[0]!.raw_body).toBe('');

    // label_match DELETEd (regenerable), safety_events + adherence_record KEPT.
    expect(await count('label_match', tester.patientId)).toBe(0);
    const dose = await client.query<{ patient_medication_id: string | null }>(
      `SELECT patient_medication_id FROM dose_schedule WHERE id = $1`,
      [tester.doseId],
    );
    expect(dose.rowCount, 'the medication-linked dose must survive scrub').toBe(1);
    expect(dose.rows[0]!.patient_medication_id).toBeNull();
    const outbound = await client.query<{ body: string | null; temporal_candidates: unknown }>(
      `SELECT body, temporal_candidates FROM outbound_message WHERE patient_id = $1`,
      [tester.patientId],
    );
    expect(outbound.rows).toHaveLength(2);
    expect(outbound.rows.every((row) => row.body === '')).toBe(true);
    expect(outbound.rows.some((row) => Array.isArray(row.temporal_candidates))).toBe(true);
    expect(await count('dose_schedule', tester.patientId)).toBe(1);
    expect(await count('inbound_reply', tester.patientId)).toBe(1);
    expect(await count('outbound_message', tester.patientId)).toBe(2);
    expect(await count('safety_events', tester.patientId), 'SAFETY-04 audit must survive').toBe(1);
    expect(await count('adherence_record', tester.patientId)).toBe(1);
    for (const table of [
      'patient_medication',
      'patient_medication_ingredient',
      'clinical_fact',
      'agent_turn',
      'clinical_event',
      'clinical_event_evidence',
      'daily_summary',
      'clinician_review_draft',
      'clinician_review_action',
    ]) {
      expect(await count(table, tester.patientId), `${table} test rows must be scrub-deleted`).toBe(
        0,
      );
    }
    expect(
      await count('turn_job', tester.patientId),
      'mutable turn_job marker survives scrub',
    ).toBe(1);
    const turnJob = await client.query<{
      interpretation_result: unknown;
      writer_result: unknown;
    }>(`SELECT interpretation_result, writer_result FROM turn_job WHERE patient_id = $1`, [
      tester.patientId,
    ]);
    expect(turnJob.rows[0]).toEqual({ interpretation_result: null, writer_result: null });
    expect(
      await count('usage_bucket', tester.patientId),
      'mutable usage_bucket reservation survives scrub',
    ).toBe(1);

    // The adherence→inbound linkage is intact (inbound_message_id not nulled).
    const link = await client.query<{ inbound_message_id: string | null }>(
      `SELECT inbound_message_id FROM adherence_record WHERE patient_id = $1`,
      [tester.patientId],
    );
    expect(link.rows[0]!.inbound_message_id).toBe(tester.inboundId);

    // A different tester is untouched by a targeted scrub.
    const untouched = await client.query<{ raw_body: string }>(
      `SELECT raw_body FROM inbound_reply WHERE id = $1`,
      [other.inboundId],
    );
    expect(untouched.rows[0]!.raw_body).toBe('other tester text');
    expect(await count('patient_medication', other.patientId)).toBe(1);
    expect(await count('agent_turn', other.patientId)).toBe(1);

    expect(result.repliesRedacted).toBe(1);
    expect(result.labelMatchesDeleted).toBe(1);
    // The safety_events audit ROW is retained (asserted above), and its auto_reply_error was swept.
    expect(result.safetyErrorsScrubbed).toBe(1);
    await client.query('DELETE FROM patient WHERE id = ANY($1::uuid[])', [
      [tester.patientId, other.patientId],
    ]);
  });

  it("L-4 — NULLs the phone-bearing safety_events.auto_reply_error for the tester but KEEPS the rest of the audit row; a real patient's diagnostic is untouched", async () => {
    const tester = await seedPatientGraph(true, 'chest pain, took the pill');
    const real = await seedPatientGraph(false, 'real patient reply');
    // Simulate the U-18/failed-send diagnostic: the sliced Twilio error names the recipient To number.
    await client.query(
      `UPDATE safety_events SET auto_reply_status = 'failed', auto_reply_error = $2 WHERE patient_id = $1`,
      [tester.patientId, 'Twilio 30008 sending to +15145550123: unreachable'],
    );
    await client.query(
      `UPDATE safety_events SET auto_reply_status = 'failed', auto_reply_error = $2 WHERE patient_id = $1`,
      [real.patientId, 'Twilio 30008 sending to +15145559999: unreachable'],
    );

    const result = await scrubTesterText(client as unknown as Queryable, tester.patientId, {
      confirmDestructive: true,
    });

    // The tester's auto_reply_error is nulled…
    const scrubbed = await client.query<{
      auto_reply_status: string | null;
      auto_reply_error: string | null;
      flag_category: string;
    }>(
      `SELECT auto_reply_status, auto_reply_error, flag_category FROM safety_events WHERE patient_id = $1`,
      [tester.patientId],
    );
    expect(scrubbed.rowCount, 'the safety_events row is RETAINED (audit evidence)').toBe(1);
    expect(scrubbed.rows[0]!.auto_reply_error).toBeNull();
    // …while the rest of the audit row is intact (status + category kept — only the PII tail is gone).
    expect(scrubbed.rows[0]!.auto_reply_status).toBe('failed');
    expect(scrubbed.rows[0]!.flag_category).toBe('crisis');
    expect(result.safetyErrorsScrubbed).toBe(1);

    // A real (is_test=false) patient's diagnostic is NEVER touched — the p.is_test JOIN guard holds.
    const realRow = await client.query<{ auto_reply_error: string | null }>(
      `SELECT auto_reply_error FROM safety_events WHERE patient_id = $1`,
      [real.patientId],
    );
    expect(realRow.rows[0]!.auto_reply_error).toBe(
      'Twilio 30008 sending to +15145559999: unreachable',
    );
    await client.query('DELETE FROM patient WHERE id = ANY($1::uuid[])', [
      [tester.patientId, real.patientId],
    ]);
  });

  it('a real (is_test=false) patient survives a scrub attempt — the patient-JOIN guard (load-bearing)', async () => {
    const real = await seedPatientGraph(false, 'DO NOT ERASE — real patient text');

    const result = await scrubTesterText(client as unknown as Queryable, real.patientId, {
      confirmDestructive: true,
    });

    const after = await client.query<{ raw_body: string }>(
      `SELECT raw_body FROM inbound_reply WHERE id = $1`,
      [real.inboundId],
    );
    expect(after.rows[0]!.raw_body, 'a real patient can NEVER be scrubbed').toBe(
      'DO NOT ERASE — real patient text',
    );
    // Its label_match must also survive — the JOIN guard covers both statements.
    expect(await count('label_match', real.patientId)).toBe(1);

    expect(result.repliesRedacted).toBe(0);
    expect(result.labelMatchesDeleted).toBe(0);
    expect(
      result.safetyErrorsScrubbed,
      'the JOIN guard covers the auto_reply_error scrub too',
    ).toBe(0);
    await client.query('DELETE FROM patient WHERE id = $1', [real.patientId]);
  });

  it('rolls back every scrub change when a mid-manifest statement fails', async () => {
    const tester = await seedPatientGraph(true, 'rollback patient text');
    const failingClient: Queryable = {
      async query(text, values) {
        if (/DELETE FROM clinical_fact/i.test(text)) {
          throw new Error('forced clinical fact failure');
        }
        return client.query(text, values as unknown[]);
      },
    };

    await expect(
      scrubTesterText(failingClient, tester.patientId, { confirmDestructive: true }),
    ).rejects.toThrow('forced clinical fact failure');

    const inbound = await client.query<{ raw_body: string }>(
      `SELECT raw_body FROM inbound_reply WHERE id = $1`,
      [tester.inboundId],
    );
    const dose = await client.query<{ patient_medication_id: string | null }>(
      `SELECT patient_medication_id FROM dose_schedule WHERE id = $1`,
      [tester.doseId],
    );
    expect(inbound.rows[0]!.raw_body).toBe('rollback patient text');
    expect(dose.rows[0]!.patient_medication_id).not.toBeNull();
    expect(await count('patient_medication', tester.patientId)).toBe(1);
    expect(await count('label_match', tester.patientId)).toBe(1);

    await client.query('DELETE FROM patient WHERE id = $1', [tester.patientId]);
  });
});
