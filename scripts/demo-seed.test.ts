// scripts/demo-seed.test.ts
//
// Real-PostgreSQL proof for the demo-cohort seed. The seed's whole value is that ONE operator
// command makes the clinician dashboard show something, so this drives the ACTUAL data-API read SQL
// (imported from backend/src/data-api) against a container with the real schema.sql applied — not a
// hand-written approximation of it.
//
// Covered: the cohort exists and is owner-scoped; the roster, cohort trend, safety queue, unknown
// queue, alert queue, draft queue, and patient-record reads all return rows; adherence outcomes are
// spread across weeks; a second seed run produces no duplicates (one-shot idempotence); and --wipe
// leaves zero demo rows behind in every table the seed writes.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DateTime } from 'luxon';
import {
  COHORT_ADHERENCE_SQL,
  LIST_PATIENTS_SQL,
  SAFETY_QUEUE_SQL,
  UNKNOWN_QUEUE_SQL,
} from '../backend/src/data-api/handler.js';
import {
  loadAlertQueue,
  loadDraftQueue,
  loadPatientRecord,
} from '../backend/src/data-api/patient-record.js';
import { patientAlertState } from '../backend/src/data-api/patient-record-route.js';
import {
  clinicalEventRowSchema,
  clinicalHistorySchema,
  conversationMessageRowSchema,
  daySummarySchema,
  eventEvidenceSchema,
  patientAlertSchema,
  patientsResponseSchema,
  reviewDraftSchema,
} from '../dashboard/src/lib/dashboard-contracts.js';
import {
  DEMO_COHORT,
  DEMO_UPCOMING_DAYS,
  applyDemoSeed,
  buildDemoPlan,
  demoAnchor,
  demoPatientIds,
  demoUuid,
  wipeDemoSeed,
} from './demo-seed.js';

const SCHEMA_SQL = readFileSync(
  join(__dirname, '..', 'backend', 'src', 'schema-init', 'schema.sql'),
  'utf8',
);
const CONTAINER_TIMEOUT_MS = 180_000;
const OWNER_SUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_SUB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RESPONSE_WINDOW_MINUTES = 120;

/** Every table the seed writes — the wipe assertion sweeps all of them. */
const SEEDED_TABLES = [
  'patient',
  'patient_medication',
  'patient_medication_ingredient',
  'dose_schedule',
  'outbound_message',
  'inbound_reply',
  'turn_job',
  'agent_turn',
  'adherence_record',
  'safety_events',
  'label_match',
  'clinical_event',
  'clinical_event_evidence',
  'daily_summary',
  'clinician_review_draft',
  'clinician_review_action',
  'clinical_fact',
] as const;

/** Every active patient keeps a week of upcoming doses; the opted-out patient keeps none. */
const DEMO_UPCOMING_MINIMUM = (DEMO_COHORT.length - 1) * DEMO_UPCOMING_DAYS;

let container: StartedPostgreSqlContainer | undefined;
let client: Client;

const plan = (): ReturnType<typeof buildDemoPlan> =>
  buildDemoPlan({ now: DateTime.now(), ownerSub: OWNER_SUB });

/** The exact JSON transform API Gateway applies (Date → ISO string) before the dashboard parses. */
function onTheWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

async function count(sql: string, values: readonly unknown[] = []): Promise<number> {
  const result = await client.query<{ count: string }>(sql, [...values]);
  return Number(result.rows[0]!.count);
}

async function seededRowCount(table: string): Promise<number> {
  // Every seeded child row hangs off a demo patient except source_release/evidence_record, which the
  // wipe removes by id and which are asserted separately.
  const key = table === 'patient' ? 'id' : 'patient_id';
  return count(`SELECT count(*)::text AS count FROM ${table} WHERE ${key} = ANY($1::uuid[])`, [
    demoPatientIds(),
  ]);
}

beforeAll(async () => {
  const ciUrl = process.env.TEST_DATABASE_URL;
  if (ciUrl) {
    client = new Client({ connectionString: ciUrl });
  } else {
    container = await new PostgreSqlContainer('postgres:16').start();
    client = new Client({ connectionString: container.getConnectionUri() });
  }
  await client.connect();
  await client.query('BEGIN');
  try {
    await client.query(SCHEMA_SQL);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  await applyDemoSeed(client, plan());
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

describe('demo-seed — the seeded cohort', () => {
  it('creates every cohort patient as a removable test row owned by the operator', async () => {
    const { rows } = await client.query<{
      id: string;
      is_test: boolean;
      owner_clinician_sub: string;
      is_active: boolean;
    }>(
      `SELECT id, is_test, owner_clinician_sub, is_active
         FROM patient WHERE id = ANY($1::uuid[]) ORDER BY phone`,
      [demoPatientIds()],
    );
    expect(rows).toHaveLength(DEMO_COHORT.length);
    expect(rows.every((row) => row.is_test)).toBe(true);
    expect(rows.every((row) => row.owner_clinician_sub === OWNER_SUB)).toBe(true);
    // One opted-out patient is part of the story the roster is meant to show.
    expect(rows.filter((row) => !row.is_active)).toHaveLength(1);
  });

  it('keeps live upcoming dose schedules, not just history', async () => {
    const upcoming = await count(
      `SELECT count(*)::text AS count FROM dose_schedule
        WHERE patient_id = ANY($1::uuid[]) AND scheduled_at > CURRENT_TIMESTAMP`,
      [demoPatientIds()],
    );
    expect(upcoming).toBeGreaterThanOrEqual(DEMO_UPCOMING_MINIMUM);
  });

  it('spreads classified adherence outcomes across multiple weeks', async () => {
    const { rows } = await client.query<{ adherence_state: string; days: string; count: string }>(
      `SELECT ar.adherence_state,
              count(DISTINCT ds.dose_date)::text AS days,
              count(*)::text AS count
         FROM adherence_record ar
         JOIN dose_schedule ds ON ds.id = ar.dose_id
        WHERE ar.patient_id = ANY($1::uuid[]) AND ar.decided_by = 'classifier'
        GROUP BY ar.adherence_state`,
      [demoPatientIds()],
    );
    const states = new Set(rows.map((row) => row.adherence_state));
    expect(states.has('taken')).toBe(true);
    expect(states.has('delayed')).toBe(true);
    expect(states.has('skipped')).toBe(true);
    expect(states.has('unknown')).toBe(true);
    const distinctDays = Math.max(...rows.map((row) => Number(row.days)));
    expect(distinctDays).toBeGreaterThanOrEqual(14);

    const missed = await count(
      `SELECT count(*)::text AS count FROM adherence_record
        WHERE patient_id = ANY($1::uuid[]) AND decided_by = 'timeout' AND status = 'missed'`,
      [demoPatientIds()],
    );
    expect(missed).toBeGreaterThan(0);
  });

  it('records inbound and outbound message history for every patient', async () => {
    const inbound = await seededRowCount('inbound_reply');
    const outbound = await seededRowCount('outbound_message');
    expect(inbound).toBeGreaterThan(0);
    expect(outbound).toBeGreaterThan(inbound);
    const kinds = await client.query<{ message_kind: string }>(
      `SELECT DISTINCT message_kind FROM outbound_message WHERE patient_id = ANY($1::uuid[])`,
      [demoPatientIds()],
    );
    const seen = new Set(kinds.rows.map((row) => row.message_kind));
    expect(seen.has('check_in')).toBe(true);
    expect(seen.has('reminder')).toBe(true);
    expect(seen.has('clarification')).toBe(true);
  });
});

describe('demo-seed — the dashboard reads light up', () => {
  it('fills the roster with alerting patients and real trailing adherence', async () => {
    const { rows } = await client.query<{
      id: string;
      consecutive_missed: number;
      adherence_rate: number | null;
      last_reply_at: string | null;
      recent_doses: unknown[];
    }>(LIST_PATIENTS_SQL, [null, RESPONSE_WINDOW_MINUTES, OWNER_SUB]);
    expect(rows).toHaveLength(DEMO_COHORT.length);
    expect(rows.filter((row) => row.consecutive_missed >= 3).length).toBeGreaterThanOrEqual(2);
    expect(rows.every((row) => row.adherence_rate !== null)).toBe(true);
    expect(rows.every((row) => row.last_reply_at !== null)).toBe(true);
    expect(rows.every((row) => row.recent_doses.length > 0)).toBe(true);
  });

  it('scopes every seeded row to the owning clinician', async () => {
    const { rows } = await client.query(LIST_PATIENTS_SQL, [
      null,
      RESPONSE_WINDOW_MINUTES,
      OTHER_SUB,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('produces a multi-day cohort adherence series', async () => {
    const { rows } = await client.query<{ day: string; delivered: number; responded: number }>(
      COHORT_ADHERENCE_SQL,
      [RESPONSE_WINDOW_MINUTES, 30, OWNER_SUB],
    );
    expect(rows.length).toBeGreaterThanOrEqual(14);
    expect(rows.every((row) => row.delivered > 0)).toBe(true);
    expect(rows.some((row) => row.responded > 0)).toBe(true);
  });

  it('opens the safety review queue with at least one urgent event', async () => {
    const { rows } = await client.query<{ flag_category: string; is_urgent: boolean }>(
      SAFETY_QUEUE_SQL,
      [15, 100, OWNER_SUB],
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.filter((row) => row.is_urgent)).not.toHaveLength(0);
    expect(rows.map((row) => row.flag_category)).toContain('crisis');
  });

  it('populates both arms of the unknown/ambiguity review queue', async () => {
    const { rows } = await client.query<{ queue_kind: string }>(UNKNOWN_QUEUE_SQL, [
      100,
      OWNER_SUB,
    ]);
    const kinds = new Set(rows.map((row) => row.queue_kind));
    expect(kinds.has('ambiguity')).toBe(true);
    expect(kinds.has('label_match')).toBe(true);
  });

  it('opens the clinician alert and draft queues', async () => {
    const alerts = await loadAlertQueue(client, OWNER_SUB, { cursor: null, limit: 100 });
    expect(alerts.items.length).toBeGreaterThanOrEqual(2);

    const drafts = await loadDraftQueue(client, OWNER_SUB, { cursor: null, limit: 100 });
    // Exactly one open draft: the second seeded draft already carries a clinician decision.
    expect(drafts.items).toHaveLength(1);
  });

  it('renders a full patient record for the alerting patient', async () => {
    const record = await loadPatientRecord(client, demoUuid('patient/alice'), OWNER_SUB, {
      days: 30,
      selectedDay: demoAnchor(DateTime.now(), 'America/Toronto').toISODate(),
      alerts: { cursor: null, limit: 100 },
      drafts: { cursor: null, limit: 3 },
    });
    expect(record).not.toBeNull();
    expect(record!.dayIndex.length).toBeGreaterThan(0);
    expect(record!.daySummary).not.toBeNull();
    expect(record!.messages.length).toBeGreaterThan(0);
    expect(record!.events.length).toBeGreaterThan(0);
    expect(record!.history.medications).toHaveLength(1);
    expect(record!.history.facts).toHaveLength(2);
    expect(record!.trends.adherence.length).toBeGreaterThan(0);
    expect(record!.trends.severity.length).toBeGreaterThan(0);
    expect(record!.alertsPage.items.length).toBeGreaterThan(0);
    expect(record!.draftsPage.items.length).toBeGreaterThan(0);
  });

  it('attaches frozen cited evidence to a clinical event', async () => {
    const record = await loadPatientRecord(client, demoUuid('patient/marcus'), OWNER_SUB, {
      days: 30,
      selectedDay: demoAnchor(DateTime.now(), 'America/Toronto').minus({ days: 4 }).toISODate(),
      alerts: { cursor: null, limit: 100 },
      drafts: { cursor: null, limit: 3 },
    });
    expect(record!.evidence).toHaveLength(1);
  });

  // The dashboard zod-parses every response; a single enum or shape drift blanks the page. Validate
  // the seeded rows against the SAME contracts, over the JSON round-trip the API Gateway performs.
  it('satisfies the dashboard response contracts', async () => {
    const roster = await client.query(LIST_PATIENTS_SQL, [
      null,
      RESPONSE_WINDOW_MINUTES,
      OWNER_SUB,
    ]);
    patientsResponseSchema.parse(
      onTheWire({
        patients: roster.rows.map((row) => ({
          ...row,
          ...patientAlertState(row as Record<string, unknown>, 3),
        })),
        alertThreshold: 3,
      }),
    );

    const record = await loadPatientRecord(client, demoUuid('patient/alice'), OWNER_SUB, {
      days: 30,
      selectedDay: demoAnchor(DateTime.now(), 'America/Toronto').toISODate(),
      alerts: { cursor: null, limit: 100 },
      drafts: { cursor: null, limit: 3 },
    });
    daySummarySchema.parse(onTheWire(record!.daySummary));
    for (const message of record!.messages) conversationMessageRowSchema.parse(onTheWire(message));
    for (const event of record!.events) clinicalEventRowSchema.parse(onTheWire(event));
    for (const draft of record!.draftsPage.items) reviewDraftSchema.parse(onTheWire(draft));
    for (const alert of record!.alertsPage.items) patientAlertSchema.parse(onTheWire(alert));
    clinicalHistorySchema.parse(onTheWire(record!.history));

    const marcus = await loadPatientRecord(client, demoUuid('patient/marcus'), OWNER_SUB, {
      days: 30,
      selectedDay: demoAnchor(DateTime.now(), 'America/Toronto').minus({ days: 4 }).toISODate(),
      alerts: { cursor: null, limit: 100 },
      drafts: { cursor: null, limit: 3 },
    });
    for (const item of marcus!.evidence) eventEvidenceSchema.parse(onTheWire(item));
  });
});

describe('demo-seed — idempotence and wipe', () => {
  it('produces identical row counts when run a second time', async () => {
    // One pg Client serialises queries, so these counts are gathered sequentially on purpose.
    const before: number[] = [];
    for (const table of SEEDED_TABLES) before.push(await seededRowCount(table));
    await applyDemoSeed(client, plan());
    const after: number[] = [];
    for (const table of SEEDED_TABLES) after.push(await seededRowCount(table));
    expect(after).toEqual(before);
    expect(await seededRowCount('patient')).toBe(DEMO_COHORT.length);
  });

  it('removes exactly the demo rows on --wipe and leaves unrelated rows alone', async () => {
    const survivorId = demoUuid('test/survivor-patient');
    await client.query(
      `INSERT INTO patient (id, phone, medication_name, owner_clinician_sub, is_test)
       VALUES ($1, '+15005559999', 'unrelated medication', $2, false)`,
      [survivorId, OWNER_SUB],
    );

    const counts = await wipeDemoSeed(client, plan());
    expect(counts.patientsDeleted).toBe(DEMO_COHORT.length);
    expect(counts.releasesDeleted).toBe(1);

    for (const table of SEEDED_TABLES) {
      expect([table, await seededRowCount(table)]).toEqual([table, 0]);
    }
    expect(
      await count('SELECT count(*)::text AS count FROM source_release WHERE id = $1', [
        plan().sourceReleaseId,
      ]),
    ).toBe(0);
    expect(
      await count('SELECT count(*)::text AS count FROM evidence_record WHERE id = $1', [
        demoUuid('evidence/lisinopril-cough'),
      ]),
    ).toBe(0);

    expect(
      await count('SELECT count(*)::text AS count FROM patient WHERE id = $1', [survivorId]),
    ).toBe(1);
    await client.query('DELETE FROM patient WHERE id = $1', [survivorId]);
  });
});
