import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConversationGatewayRequest } from './gateway-contract.js';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** These transports only ever see the interpretation stage of the gateway request union. */
type InterpretationGatewayRequest = Extract<
  ConversationGatewayRequest,
  { readonly stage: 'interpretation' }
>;

const { lambdaSend } = vi.hoisted(() => ({ lambdaSend: vi.fn() }));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: vi.fn(function () {
    return { send: lambdaSend };
  }),
  InvokeCommand: vi.fn(function (input: unknown) {
    return { input };
  }),
}));

import { CLINICAL_EXTRACTOR_SCHEMA_SHA256 } from './clinical-memory/anthropic-extractor.js';
import {
  applyPreparedClinicalTurn,
  prepareClinicalTurn,
  type ExtractedClaim,
  type PatientClinicalMemory,
  type PatientClinicalSnapshot,
  type PreparedClinicalTurn,
} from './clinical-memory/index.js';
import {
  commitPreparedClinicalTurn,
  loadPatientClinicalMemory,
  reconcileUnsentAskedNeed,
} from './clinical-memory/repository.js';
import { terminalizePreparedAgentSend } from '../outbound/send-repository.js';
import { loadConversationJob } from './runtime-repository.js';
import { processConversationJob } from './turn-processor.js';

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema-init', 'schema.sql'), 'utf8');
const CONTAINER_TIMEOUT_MS = 180_000;
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GATEWAY_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:gateway';
const OUTBOUND_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:outbound';
const CONTEXT_HASH = 'a'.repeat(64);
const RECEIVED_BASE = '2026-08-13T16:00:00Z';
const ELIGIBLE = {
  polarity: 'positive',
  experiencer: 'patient',
  status: 'current',
  certainty: 'certain',
} as const;

let container: StartedPostgreSqlContainer | undefined;
let pool: Pool;
let phoneCounter = 0;

type SeededPatient = { readonly id: string; readonly messagingStateVersion: number };
type SeededTurn = {
  readonly patientId: string;
  readonly inboundMessageId: string;
  readonly turnJobId: string;
  readonly sequence: number;
  readonly body: string;
  readonly messagingStateVersion: number;
};

async function seedPatient(): Promise<SeededPatient> {
  phoneCounter += 1;
  const result = await pool.query<{ id: string; messaging_state_version: number }>(
    `INSERT INTO patient (phone, medication_name, owner_clinician_sub, timezone, is_test)
     VALUES ($1, 'test medication', $2, 'America/Toronto', true)
     RETURNING id::text, messaging_state_version`,
    [`+1500999${String(phoneCounter).padStart(4, '0')}`, OWNER_ID],
  );
  const row = result.rows[0]!;
  return { id: row.id, messagingStateVersion: row.messaging_state_version };
}

async function seedTurn(
  patient: SeededPatient,
  sequence: number,
  body: string,
  receivedBase = RECEIVED_BASE,
): Promise<SeededTurn> {
  const inbound = await pool.query<{ id: string }>(
    `INSERT INTO inbound_reply
       (patient_id, raw_body, received_at, inbound_sequence, enqueued_at)
     VALUES ($1, $2, $4::timestamptz + ($3 * interval '1 minute'), $3, now())
     RETURNING id::text`,
    [patient.id, body, sequence, receivedBase],
  );
  const inboundMessageId = inbound.rows[0]!.id;
  const job = await pool.query<{ id: string }>(
    `INSERT INTO turn_job
       (patient_id, inbound_message_id, inbound_sequence, messaging_state_version,
        clinical_context_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id::text`,
    [patient.id, inboundMessageId, sequence, patient.messagingStateVersion, CONTEXT_HASH],
  );
  return {
    patientId: patient.id,
    inboundMessageId,
    turnJobId: job.rows[0]!.id,
    sequence,
    body,
    messagingStateVersion: patient.messagingStateVersion,
  };
}

async function completeQueueJob(turn: SeededTurn): Promise<void> {
  const completed = await pool.query(
    `UPDATE turn_job SET completed_at = now() WHERE id = $1 AND completed_at IS NULL`,
    [turn.turnJobId],
  );
  expect(completed.rowCount).toBe(1);
}

type MedicationFixture = {
  readonly alphaId: string;
  readonly betaId: string;
  readonly gammaId: string;
  readonly alphaDoseId: string;
  readonly betaDoseId: string;
  readonly gammaDoseId: string;
};

async function seedMedications(patientId: string): Promise<MedicationFixture> {
  const ids: string[] = [];
  const doseIds: string[] = [];
  // scheduled_at must equal local_dose_time in the schedule timezone (EDT, UTC-4 on 2026-08-13).
  for (const [name, time, scheduledAt] of [
    ['alpha', '08:00', '2026-08-13T12:00:00Z'],
    ['beta', '09:00', '2026-08-13T13:00:00Z'],
    ['gamma', '10:00', '2026-08-13T14:00:00Z'],
  ] as const) {
    const medication = await pool.query<{ id: string }>(
      `INSERT INTO patient_medication
         (patient_id, entered_name, identity_system, identity_code, dose_text, valid_from,
          status, confirmed_by_clinician_sub, confirmed_at)
       VALUES ($1, $2, 'rxnorm', '6809', '500 mg', '2026-08-01',
               'active', $3, '2026-08-01T12:00:00Z')
       RETURNING id::text`,
      [patientId, name, OWNER_ID],
    );
    ids.push(medication.rows[0]!.id);
    const dose = await pool.query<{ id: string }>(
      `INSERT INTO dose_schedule
         (patient_id, patient_medication_id, scheduled_at, local_dose_time,
          dose_date, schedule_timezone)
       VALUES ($1, $2, $4, $3, '2026-08-13', 'America/Toronto')
       RETURNING id::text`,
      [patientId, medication.rows[0]!.id, time, scheduledAt],
    );
    doseIds.push(dose.rows[0]!.id);
  }
  return {
    alphaId: ids[0]!,
    betaId: ids[1]!,
    gammaId: ids[2]!,
    alphaDoseId: doseIds[0]!,
    betaDoseId: doseIds[1]!,
    gammaDoseId: doseIds[2]!,
  };
}

function snapshotWithMedications(
  memory: PatientClinicalMemory,
  turn: SeededTurn,
  fixture: MedicationFixture,
  overrides: Partial<PatientClinicalSnapshot> = {},
): PatientClinicalSnapshot {
  return {
    memory,
    inboundMessage: { id: turn.inboundMessageId, sequence: turn.sequence, body: turn.body },
    consentEpoch: turn.messagingStateVersion,
    expectedConsentEpoch: turn.messagingStateVersion,
    expectedMemoryVersion: memory.version,
    medications: [
      {
        id: fixture.alphaId,
        version: 1,
        names: ['alpha'],
        aliases: ['morning pill'],
        active: true,
      },
      { id: fixture.betaId, version: 1, names: ['beta'], aliases: ['morning pill'], active: true },
      { id: fixture.gammaId, version: 1, names: ['gamma'], aliases: [], active: true },
    ],
    doses: [
      {
        id: fixture.alphaDoseId,
        version: 1,
        medicationId: fixture.alphaId,
        label: 'alpha dose',
        localDate: '2026-08-13',
        localTime: '08:00',
      },
      {
        id: fixture.betaDoseId,
        version: 1,
        medicationId: fixture.betaId,
        label: 'beta dose',
        localDate: '2026-08-13',
        localTime: '09:00',
      },
      {
        id: fixture.gammaDoseId,
        version: 1,
        medicationId: fixture.gammaId,
        label: 'gamma dose',
        localDate: '2026-08-13',
        localTime: '10:00',
      },
    ],
    symptomConcepts: ['nausea'],
    languageDisposition: 'english',
    emergencyPrefilter: false,
    contextHash: CONTEXT_HASH,
    pipelineVersions: {
      extractor: 'extractor-v1',
      resolver: 'resolver-v1',
      reducer: 'reducer-v1',
      renderer: 'renderer-v2',
    },
    ...overrides,
  };
}

function administrationClaim(
  slot: string,
  turn: SeededTurn,
  quote: string,
  medicationText: string,
): ExtractedClaim {
  if (!turn.body.includes(quote)) throw new Error('test_quote_missing');
  return {
    slot,
    kind: 'administration',
    quote,
    ...ELIGIBLE,
    medicationText,
    actionText: 'took',
  };
}

async function commitTurn(
  turn: SeededTurn,
  fixture: MedicationFixture,
  claims: readonly ExtractedClaim[],
  overrides: Partial<PatientClinicalSnapshot> = {},
): Promise<{
  readonly memory: PatientClinicalMemory;
  readonly prepared: PreparedClinicalTurn;
  readonly expected: PatientClinicalMemory;
}> {
  const memory = await loadPatientClinicalMemory(pool, turn.patientId);
  const prepared = prepareClinicalTurn(
    snapshotWithMedications(memory, turn, fixture, overrides),
    claims,
  );
  const expected = applyPreparedClinicalTurn(memory, prepared).memory;
  await commitPreparedClinicalTurn(pool, prepared, async () => prepared.contextHash);
  await completeQueueJob(turn);
  return { memory, prepared, expected };
}

function commandInput(command: unknown): { FunctionName: string; Payload: Uint8Array } {
  return (command as { input: { FunctionName: string; Payload: Uint8Array } }).input;
}

function installLambdaTransport(
  options: { readonly rejectOutboundBeforeAcceptance?: boolean } = {},
): void {
  lambdaSend.mockImplementation(async (command: unknown) => {
    const input = commandInput(command);
    if (input.FunctionName === GATEWAY_ARN) {
      const request = JSON.parse(
        new TextDecoder().decode(input.Payload),
      ) as InterpretationGatewayRequest;
      const response = {
        ok: true,
        requestId: request.requestId,
        stage: 'interpretation',
        result: {
          claims: [
            {
              sourceMessageId: request.input.currentMessage.id,
              informationNeedId: null,
              claim: {
                slot: 'claim_1',
                kind: 'symptom',
                quote: 'headache',
                ...ELIGIBLE,
                symptomText: 'headache',
              },
            },
          ],
        },
        usage: { inputTokens: 40, outputTokens: 15 },
        metadata: {
          modelId: 'claude-sonnet-5',
          promptVersion: request.input.promptVersion,
          schemaSha256: CLINICAL_EXTRACTOR_SCHEMA_SHA256,
          latencyMs: 10,
        },
      };
      return { Payload: new TextEncoder().encode(JSON.stringify(response)) };
    }
    const outbound = JSON.parse(new TextDecoder().decode(input.Payload)) as {
      patientId: string;
      agentTurnId: string;
    };
    if (options.rejectOutboundBeforeAcceptance) throw new Error('outbound dispatch failed');
    await pool.query(
      `UPDATE outbound_message SET status = 'queued', twilio_sid = $3
        WHERE patient_id = $1 AND agent_turn_id = $2`,
      [outbound.patientId, outbound.agentTurnId, `SM${outbound.agentTurnId.replaceAll('-', '')}`],
    );
    return { Payload: new TextEncoder().encode(JSON.stringify({ sent: true, sid: 'SM1' })) };
  });
}

function callsFor(functionArn: string): number {
  return lambdaSend.mock.calls.filter(
    ([command]) => commandInput(command).FunctionName === functionArn,
  ).length;
}

async function outboundStates(patientId: string) {
  const rows = await pool.query<{
    inbound_id: string;
    status: string;
    sent_at: Date | null;
    status_updated_at: Date | null;
    plan_kind: string | null;
    suppressed_by_newer_inbound: boolean;
  }>(
    `SELECT turn_record.inbound_message_id::text AS inbound_id,
            om.status, om.sent_at, om.status_updated_at, om.suppressed_by_newer_inbound,
            turn_record.prepared_response_plan ->> 'kind' AS plan_kind
       FROM outbound_message om
       JOIN agent_turn turn_record
         ON turn_record.patient_id = om.patient_id AND turn_record.id = om.agent_turn_id
      WHERE om.patient_id = $1
      ORDER BY om.created_at`,
    [patientId],
  );
  return rows.rows;
}

async function loadClinicalSnapshotFor(turn: SeededTurn) {
  const loaded = await loadConversationJob(pool, {
    inboundMessageId: turn.inboundMessageId,
    requestId: turn.inboundMessageId,
    expectedLanguage: 'en',
    promptVersion: 'conversation-v45-single-stage',
    schemaVersion: 'conversation-v3',
    includeClinicalSnapshot: true,
  });
  if (loaded?.kind !== 'ready' || loaded.clinicalSnapshot === undefined) {
    throw new Error('expected_ready_snapshot');
  }
  return loaded.clinicalSnapshot;
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
  process.env.LLM_GATEWAY_FN_ARN = GATEWAY_ARN;
  process.env.OUTBOUND_FN_ARN = OUTBOUND_ARN;
}, CONTAINER_TIMEOUT_MS);

beforeEach(() => {
  lambdaSend.mockReset();
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('wave 1a chat-style batching against PostgreSQL 16', () => {
  it('drains three rapid messages into three record-only-or-surviving commits with ONE sendable reply', async () => {
    const patient = await seedPatient();
    const turns = [
      await seedTurn(patient, 1, 'My headache is back.'),
      await seedTurn(patient, 2, 'My headache is back.'),
      await seedTurn(patient, 3, 'My headache is back.'),
    ];
    installLambdaTransport();
    try {
      for (const turn of turns) {
        await processConversationJob(turn.inboundMessageId, pool);
        await completeQueueJob(turn);
      }

      // All three turns recorded their claims.
      const events = await pool.query<{ count: string }>(
        `SELECT count(*)::text FROM clinical_event WHERE patient_id = $1 AND event_type = 'patient_statement'`,
        [patient.id],
      );
      expect(Number(events.rows[0]?.count)).toBe(3);

      // Earlier turns' outbound rows are terminal FROM BIRTH; only the survivor sent.
      const outbound = await outboundStates(patient.id);
      expect(outbound).toHaveLength(3);
      expect(outbound.map(({ status }) => status)).toEqual(['failed', 'failed', 'queued']);
      expect(outbound[0]).toMatchObject({ sent_at: null, suppressed_by_newer_inbound: true });
      expect(outbound[0]?.status_updated_at).not.toBeNull();
      expect(outbound[1]).toMatchObject({ sent_at: null, suppressed_by_newer_inbound: true });
      expect(outbound[2]).toMatchObject({ suppressed_by_newer_inbound: false });
      expect(callsFor(OUTBOUND_ARN)).toBe(1);

      // The surviving turn aggregates the burst: it asks the FIRST suppressed turn's question.
      expect(outbound[2]?.plan_kind).toBe('question');
      const memory = await loadPatientClinicalMemory(pool, patient.id);
      const asked = memory.needs.filter(({ state }) => state === 'asked');
      expect(asked).toHaveLength(1);
      expect(asked[0]?.originInboundMessageId).toBe(turns[0]!.inboundMessageId);
      // No needs stranded: everything else stays open for later turns. Owner decision C: with
      // the context battery ON each of the three symptom events opens its own 4-need episode
      // (severity plus the top three context fields), so 12 needs exist and 11 stay open.
      expect(memory.needs).toHaveLength(12);
      expect(memory.needs.filter(({ state }) => state === 'open')).toHaveLength(11);
    } finally {
      await pool.query('DELETE FROM patient WHERE id = $1', [patient.id]);
    }
  });

  it('backstop-terminalizes an un-sent question reply on redrive and reopens the asked need', async () => {
    const patient = await seedPatient();
    const first = await seedTurn(patient, 1, 'My headache is back.');
    installLambdaTransport({ rejectOutboundBeforeAcceptance: true });
    try {
      await expect(processConversationJob(first.inboundMessageId, pool)).rejects.toThrow(
        'outbound dispatch failed',
      );
      const beforeRedrive = await loadPatientClinicalMemory(pool, patient.id);
      // Owner decision C: the battery opens severity plus three context needs; exactly one of
      // them is asked this turn. Need order is created_at-then-id, so pick the asked one by state.
      expect(beforeRedrive.needs.map(({ state }) => state).sort()).toEqual([
        'asked',
        'open',
        'open',
        'open',
      ]);
      const needId = beforeRedrive.needs.find(({ state }) => state === 'asked')!.id;

      // A newer message arrives before the redrive delivers the question.
      const second = await seedTurn(patient, 2, 'My headache is back.');
      installLambdaTransport();
      lambdaSend.mockClear();
      await processConversationJob(first.inboundMessageId, pool);
      await completeQueueJob(first);

      // The reply was terminalized (not sent) and the need reopened for the survivor.
      expect(callsFor(OUTBOUND_ARN)).toBe(0);
      const outboundAfter = await outboundStates(patient.id);
      expect(outboundAfter).toEqual([
        expect.objectContaining({
          status: 'failed',
          sent_at: null,
          suppressed_by_newer_inbound: true,
        }),
      ]);
      const reconciled = await loadPatientClinicalMemory(pool, patient.id);
      expect(reconciled.needs.find(({ id }) => id === needId)).toEqual(
        expect.objectContaining({
          id: needId,
          state: 'open',
          clarificationAttemptUsed: false,
          version: 3,
        }),
      );
      expect(reconciled.needs.map(({ state }) => state)).toEqual(['open', 'open', 'open', 'open']);
      // Idempotent: a second reconcile attempt is a no-op.
      const turnRow = await pool.query<{ id: string }>(
        `SELECT id::text FROM agent_turn WHERE patient_id = $1 AND inbound_message_id = $2`,
        [patient.id, first.inboundMessageId],
      );
      await expect(
        reconcileUnsentAskedNeed(pool, { patientId: patient.id, agentTurnId: turnRow.rows[0]!.id }),
      ).resolves.toBe(false);

      // The surviving turn asks the reopened question again.
      await processConversationJob(second.inboundMessageId, pool);
      await completeQueueJob(second);
      expect(callsFor(OUTBOUND_ARN)).toBe(1);
      const survived = await loadPatientClinicalMemory(pool, patient.id);
      expect(survived.needs.find(({ id }) => id === needId)).toMatchObject({
        state: 'asked',
        clarificationAttemptUsed: true,
        version: 4,
      });
    } finally {
      await pool.query('DELETE FROM patient WHERE id = $1', [patient.id]);
    }
  });

  it('round-trips stale-question expiry with its grace anchor and resolves a late clear answer', async () => {
    const patient = await seedPatient();
    const fixture = await seedMedications(patient.id);
    try {
      // Turn 1: ambiguous administration -> asked medication-identity need.
      const first = await seedTurn(patient, 1, 'I took my morning pill.');
      await commitTurn(first, fixture, [
        administrationClaim('slot-1', first, 'took my morning pill', 'morning pill'),
      ]);
      // Turns 2-4: three substantive turns that never answer the question.
      const second = await seedTurn(patient, 2, 'I took gamma.');
      await commitTurn(second, fixture, [
        administrationClaim('slot-2', second, 'took gamma', 'gamma'),
      ]);
      const third = await seedTurn(patient, 3, 'Nausea today.');
      await commitTurn(third, fixture, [
        {
          slot: 'slot-3',
          kind: 'symptom',
          quote: 'Nausea',
          ...ELIGIBLE,
          symptomText: 'nausea',
        },
      ]);
      const fourth = await seedTurn(patient, 4, 'I took gamma.');
      await commitTurn(fourth, fixture, [
        administrationClaim('slot-4', fourth, 'took gamma', 'gamma'),
      ]);

      // Turn 5 expires the stale question and asks the next one; the DB round-trips the
      // expiry stamp exactly as the reducer produced it.
      const fifth = await seedTurn(patient, 5, 'ok');
      const expiry = await commitTurn(fifth, fixture, []);
      const afterExpiry = await loadPatientClinicalMemory(pool, patient.id);
      expect(afterExpiry).toEqual(expiry.expected);
      const expired = afterExpiry.needs.find(({ field }) => field === 'medication_identity');
      expect(expired).toMatchObject({
        state: 'expired',
        expiredAtInboundMessageId: fifth.inboundMessageId,
      });
      expect(afterExpiry.needs.find(({ field }) => field === 'severity')?.state).toBe('asked');

      // Turn 6: the late clear answer still resolves the expired need within grace.
      const sixth = await seedTurn(patient, 6, 'alpha');
      const graceAnswer = await commitTurn(sixth, fixture, [
        {
          slot: 'slot-6',
          kind: 'need_answer',
          quote: 'alpha',
          ...ELIGIBLE,
          answerField: 'medication_identity',
          answerText: 'alpha',
        },
      ]);
      const resolvedMemory = await loadPatientClinicalMemory(pool, patient.id);
      expect(resolvedMemory).toEqual(graceAnswer.expected);
      expect(
        resolvedMemory.needs.find(({ field }) => field === 'medication_identity'),
      ).toMatchObject({ state: 'resolved', expiredAtInboundMessageId: fifth.inboundMessageId });
      const refined = resolvedMemory.events.find(
        (event) =>
          event.current &&
          event.kind === 'administration' &&
          event.medicationId === fixture.alphaId,
      );
      expect(refined).toMatchObject({ doseId: fixture.alphaDoseId, adherence: 'taken' });
    } finally {
      await pool.query('DELETE FROM patient WHERE id = $1', [patient.id]);
    }
  });

  it('flips pendingClarification to the re-ask row and flags an overnight asked need', async () => {
    const patient = await seedPatient();
    const fixture = await seedMedications(patient.id);
    try {
      // Turn 1 asks the severity question; its reply is sent.
      const first = await seedTurn(patient, 1, 'Nausea today.');
      const asked = await commitTurn(first, fixture, [
        { slot: 'slot-1', kind: 'symptom', quote: 'Nausea', ...ELIGIBLE, symptomText: 'nausea' },
      ]);
      expect(asked.prepared.responsePlan.kind).toBe('question');
      await pool.query(
        `UPDATE outbound_message SET status = 'sent', sent_at = $2::timestamptz
          WHERE patient_id = $1`,
        [patient.id, '2026-08-13T16:02:00Z'],
      );

      // Turn 2 does not answer -> plan-only re-ask, no AskInformationNeed command.
      const second = await seedTurn(patient, 2, 'I took gamma.');
      const reask = await commitTurn(second, fixture, [
        administrationClaim('slot-2', second, 'took gamma', 'gamma'),
      ]);
      expect(reask.prepared.responsePlan.kind).toBe('question');
      expect(reask.prepared.responsePlan.question?.reask).toBe(true);
      expect(reask.prepared.commands.some(({ kind }) => kind === 'AskInformationNeed')).toBe(false);
      await pool.query(
        `UPDATE outbound_message SET status = 'sent', sent_at = $2::timestamptz
          WHERE patient_id = $1 AND sent_at IS NULL`,
        [patient.id, '2026-08-13T16:04:00Z'],
      );

      // Next morning: the pending clarification IS the re-ask row, and the runtime flags the
      // still-asked need as overnight so the next turn expires it.
      const third = await seedTurn(patient, 3, 'ok', '2026-08-14T12:00:00Z');
      const loaded = await loadConversationJob(pool, {
        inboundMessageId: third.inboundMessageId,
        requestId: third.inboundMessageId,
        expectedLanguage: 'en',
        promptVersion: 'conversation-v45-single-stage',
        schemaVersion: 'conversation-v3',
        includeClinicalSnapshot: true,
      });
      if (loaded?.kind !== 'ready' || loaded.clinicalSnapshot === undefined) {
        throw new Error('expected_ready_snapshot');
      }
      expect(loaded.input.pendingClarificationSourceMessageId).toBe(second.inboundMessageId);
      expect(loaded.input.pendingClarification).toBe(reask.prepared.responseText);
      const askedNeed = loaded.clinicalSnapshot.memory.needs.find(({ state }) => state === 'asked');
      expect(loaded.clinicalSnapshot.overnightAskedNeedIds).toEqual([askedNeed?.id]);
      expect(loaded.clinicalSnapshot.newerInboundExists).toBe(false);
      expect(loaded.clinicalSnapshot.suppressedBurstInboundMessageIds).toEqual([]);
    } finally {
      await pool.query('DELETE FROM patient WHERE id = $1', [patient.id]);
    }
  });

  it('projects an expired-in-grace need to the production extractor so a late answer stays claimable', async () => {
    const patient = await seedPatient();
    const fixture = await seedMedications(patient.id);
    try {
      // Turns 1-5 reproduce the expiry scenario: medication_identity expires at turn 5 with its
      // grace anchor, and the nausea severity need becomes the asked question.
      const first = await seedTurn(patient, 1, 'I took my morning pill.');
      await commitTurn(first, fixture, [
        administrationClaim('slot-1', first, 'took my morning pill', 'morning pill'),
      ]);
      const second = await seedTurn(patient, 2, 'I took gamma.');
      await commitTurn(second, fixture, [
        administrationClaim('slot-2', second, 'took gamma', 'gamma'),
      ]);
      const third = await seedTurn(patient, 3, 'Nausea today.');
      await commitTurn(third, fixture, [
        { slot: 'slot-3', kind: 'symptom', quote: 'Nausea', ...ELIGIBLE, symptomText: 'nausea' },
      ]);
      const fourth = await seedTurn(patient, 4, 'I took gamma.');
      await commitTurn(fourth, fixture, [
        administrationClaim('slot-4', fourth, 'took gamma', 'gamma'),
      ]);
      const fifth = await seedTurn(patient, 5, 'ok');
      await commitTurn(fifth, fixture, []);
      const memory = await loadPatientClinicalMemory(pool, patient.id);
      const expired = memory.needs.find(({ field }) => field === 'medication_identity');
      const asked = memory.needs.find(({ field }) => field === 'severity');
      expect(expired?.state).toBe('expired');
      expect(asked?.state).toBe('asked');

      // Turn 6 runs the REAL production path: the gateway request must list the grace-expired
      // need alongside the asked one, or the model is forbidden from emitting its need_answer.
      const sixth = await seedTurn(patient, 6, 'My headache is back.');
      installLambdaTransport();
      await processConversationJob(sixth.inboundMessageId, pool);
      await completeQueueJob(sixth);
      const gatewayCall = lambdaSend.mock.calls.find(
        ([command]) => commandInput(command).FunctionName === GATEWAY_ARN,
      );
      expect(gatewayCall).toBeDefined();
      const request = JSON.parse(
        new TextDecoder().decode(commandInput(gatewayCall![0]).Payload),
      ) as InterpretationGatewayRequest;
      expect(request.input.openInformationNeeds).toEqual([
        { id: expired!.id, field: 'medication_identity' },
        { id: asked!.id, field: 'severity' },
      ]);
    } finally {
      await pool.query('DELETE FROM patient WHERE id = $1', [patient.id]);
    }
  });

  it('keeps a mid-burst reminder from covering the burst — only sent conversational replies cover', async () => {
    const patient = await seedPatient();
    const turns = [
      await seedTurn(patient, 1, 'My headache is back.'),
      await seedTurn(patient, 2, 'My headache is back.'),
      await seedTurn(patient, 3, 'My headache is back.'),
    ];
    installLambdaTransport();
    try {
      await processConversationJob(turns[0]!.inboundMessageId, pool);
      await completeQueueJob(turns[0]!);
      await processConversationJob(turns[1]!.inboundMessageId, pool);
      await completeQueueJob(turns[1]!);

      // An unrelated scheduled reminder fires mid-burst, sent AFTER both suppressed receipts.
      await pool.query(
        `INSERT INTO outbound_message
           (patient_id, status, body, message_kind, reminder_attempt, sent_at)
         VALUES ($1, 'sent', 'Time for your scheduled dose.', 'reminder', 1,
                 $2::timestamptz + interval '10 minutes')`,
        [patient.id, RECEIVED_BASE],
      );

      // The survivor still aggregates BOTH suppressed turns: a reminder is not a reply.
      const snapshot = await loadClinicalSnapshotFor(turns[2]!);
      expect(snapshot.suppressedBurstInboundMessageIds).toEqual([
        turns[0]!.inboundMessageId,
        turns[1]!.inboundMessageId,
      ]);
    } finally {
      await pool.query('DELETE FROM patient WHERE id = $1', [patient.id]);
    }
  });

  it('keeps a consent-stale terminalized turn OUT of a later burst aggregate', async () => {
    const patient = await seedPatient();
    const first = await seedTurn(patient, 1, 'My headache is back.');
    installLambdaTransport({ rejectOutboundBeforeAcceptance: true });
    try {
      // Turn 1 commits its question but the send fails, leaving the reply 'prepared'.
      await expect(processConversationJob(first.inboundMessageId, pool)).rejects.toThrow(
        'outbound dispatch failed',
      );
      // Consent changes (STOP/START epoch bump) before the redrive; the backstop terminalizes
      // the stale reply WITHOUT the newer-inbound stamp.
      await pool.query(
        `UPDATE patient SET messaging_state_version = messaging_state_version + 1 WHERE id = $1`,
        [patient.id],
      );
      installLambdaTransport();
      await processConversationJob(first.inboundMessageId, pool);
      await completeQueueJob(first);
      const outbound = await outboundStates(patient.id);
      expect(outbound).toEqual([
        expect.objectContaining({
          status: 'failed',
          sent_at: null,
          suppressed_by_newer_inbound: false,
        }),
      ]);

      // A later same-day message must NOT fold the 9am consent casualty into its "burst".
      const bumped = { ...patient, messagingStateVersion: patient.messagingStateVersion + 1 };
      const later = await seedTurn(bumped, 2, 'ok');
      const snapshot = await loadClinicalSnapshotFor(later);
      expect(snapshot.suppressedBurstInboundMessageIds).toEqual([]);
    } finally {
      await pool.query('DELETE FROM patient WHERE id = $1', [patient.id]);
    }
  });

  it('re-ask rows carry NO asked_information_need_id, so the backstop cannot re-arm the one-shot latch', async () => {
    const patient = await seedPatient();
    const fixture = await seedMedications(patient.id);
    try {
      // Turn 1 asks the severity question (first ask row carries the need id) and it sends.
      const first = await seedTurn(patient, 1, 'Nausea today.');
      const asked = await commitTurn(first, fixture, [
        { slot: 'slot-1', kind: 'symptom', quote: 'Nausea', ...ELIGIBLE, symptomText: 'nausea' },
      ]);
      expect(asked.prepared.responsePlan.kind).toBe('question');
      await pool.query(
        `UPDATE outbound_message SET status = 'sent', sent_at = $2::timestamptz
          WHERE patient_id = $1`,
        [patient.id, '2026-08-13T16:02:00Z'],
      );

      // Turn 2 re-asks (response-plan-only). Its row must not look like a first ask.
      const second = await seedTurn(patient, 2, 'I took gamma.');
      const reask = await commitTurn(second, fixture, [
        administrationClaim('slot-2', second, 'took gamma', 'gamma'),
      ]);
      expect(reask.prepared.responsePlan.question?.reask).toBe(true);
      const rows = await pool.query<{
        id: string;
        agent_turn_id: string;
        inbound_id: string;
        asked_need: string | null;
      }>(
        `SELECT om.id::text, om.agent_turn_id::text, om.asked_information_need_id::text AS asked_need,
                turn_record.inbound_message_id::text AS inbound_id
           FROM outbound_message om
           JOIN agent_turn turn_record
             ON turn_record.patient_id = om.patient_id AND turn_record.id = om.agent_turn_id
          WHERE om.patient_id = $1
          ORDER BY om.created_at`,
        [patient.id],
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0]?.asked_need).not.toBeNull();
      const reaskRow = rows.rows[1]!;
      expect(reaskRow.inbound_id).toBe(second.inboundMessageId);
      expect(reaskRow.asked_need).toBeNull();

      // Message 3 arrives before the re-ask sends: the backstop terminalizes it. The consumed
      // clarification attempt must NOT come back — the need stays asked, latch intact.
      const before = await loadPatientClinicalMemory(pool, patient.id);
      const need = before.needs.find(({ state }) => state === 'asked');
      expect(need).toMatchObject({ field: 'severity', clarificationAttemptUsed: true });
      await expect(
        terminalizePreparedAgentSend(pool, {
          patientId: patient.id,
          agentTurnId: reaskRow.agent_turn_id,
          outboundMessageId: reaskRow.id,
          supersededByNewerInbound: true,
        }),
      ).resolves.toBe(true);
      await expect(
        reconcileUnsentAskedNeed(pool, {
          patientId: patient.id,
          agentTurnId: reaskRow.agent_turn_id,
        }),
      ).resolves.toBe(false);
      const after = await loadPatientClinicalMemory(pool, patient.id);
      expect(after.needs.find(({ id }) => id === need!.id)).toMatchObject({
        state: 'asked',
        clarificationAttemptUsed: true,
        version: need!.version,
      });
    } finally {
      await pool.query('DELETE FROM patient WHERE id = $1', [patient.id]);
    }
  });
});
