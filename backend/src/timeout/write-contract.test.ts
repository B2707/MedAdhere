/**
 * write-contract.test.ts — the PIPE-05/PIPE-06 write-contract MATRIX against a REAL PostgreSQL 16
 * (testcontainers, the schema.test.ts posture). The mocked-pg unit tests pin the SQL TEXT; this test
 * proves the SQL SEMANTICS actually hold in Postgres — the only place `ON CONFLICT … DO NOTHING`, the
 * `EXISTS` delivery gate, the `WHERE decided_by='timeout'` arbiter, and the H2 status flip are exercised
 * end-to-end. It imports the EXACT handler SQL constants (TIMEOUT_INSERT_SQL / ADHERENCE_UPSERT_SQL), so
 * a future edit to either handler that breaks the contract fails HERE — no drift between test and code.
 *
 * Requires a running Docker daemon OR a CI-provided TEST_DATABASE_URL (PG 16). NO AWS, NO credentials.
 *
 * The matrix (05-PLAN "RED tests"):
 *   - fresh delivered send → the {unknown,none,none,timeout,missed} row is inserted (patient_id from
 *     dose_schedule — M4);
 *   - prior classifier row → DO NOTHING (the reply wins);
 *   - double-fire → exactly one row;
 *   - H5: an undelivered/failed (or absent) send → NO missed row;
 *   - M4: a wiped/absent dose → no-op, NO 23503 FK throw;
 *   - H2 / PIPE-06: a timeout row + a late classifier reply flips decided_by timeout→classifier AND
 *     status missed→recorded;
 *   - late-reply-then-timeout → DO NOTHING (one final row either ordering);
 *   - the classifier arbiter NEVER overwrites another classifier row (WHERE decided_by='timeout').
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, type QueryResult } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { TIMEOUT_INSERT_SQL } from './handler.js';
import { ADHERENCE_UPSERT_SQL } from '../classifier/handler.js';

const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema-init', 'schema.sql'), 'utf8');

const CONTAINER_TIMEOUT_MS = 180_000;

let container: StartedPostgreSqlContainer | undefined;
let client: Client;
// The resolved connection string — captured so the U-3 two-connection contention block can open its
// OWN genuine second/third connections to the SAME Postgres (real lock contention, not one Client).
let connectionUri: string;

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
    connectionUri = ciUrl;
  } else {
    container = await new PostgreSqlContainer('postgres:16').start();
    connectionUri = container.getConnectionUri();
  }
  client = new Client({ connectionString: connectionUri });
  await client.connect();
  await applySchema(client);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

// ---- seed helpers (per-test, inside BEGIN/ROLLBACK) -------------------------------------
let phoneCounter = 0;
const TEST_OWNER_SUB = '8f6e7138-fd21-4b31-8ac3-934cfc610f44';

function nextPhone(): string {
  phoneCounter += 1;
  return `+1500666${String(phoneCounter).padStart(4, '0')}`;
}

async function seedDose(): Promise<{ patientId: string; doseId: string }> {
  const p = await client.query<{ id: string }>(
    `INSERT INTO patient (owner_clinician_sub, phone, medication_name) VALUES ($1, $2, 'metformin') RETURNING id`,
    [TEST_OWNER_SUB, nextPhone()],
  );
  const patientId = p.rows[0]!.id;
  const d = await client.query<{ id: string }>(
    `INSERT INTO dose_schedule (patient_id, scheduled_at, local_dose_time)
     VALUES ($1, now(), '09:00') RETURNING id`,
    [patientId],
  );
  return { patientId, doseId: d.rows[0]!.id };
}

/** Insert an outbound_message for the dose with the given delivery status. */
async function seedOutbound(patientId: string, doseId: string, status: string): Promise<void> {
  await client.query(
    `INSERT INTO outbound_message (patient_id, dose_id, status) VALUES ($1, $2, $3)`,
    [patientId, doseId, status],
  );
}

async function seedInbound(patientId: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO inbound_reply (patient_id, raw_body) VALUES ($1, 'took it') RETURNING id`,
    [patientId],
  );
  return r.rows[0]!.id;
}

/** The current adherence_record for a dose (or undefined). */
async function recordFor(doseId: string) {
  const { rows } = await client.query<{
    adherence_state: string;
    reason_code: string;
    safety_flag: string;
    decided_by: string;
    status: string;
    inbound_message_id: string | null;
  }>(
    `SELECT adherence_state, reason_code, safety_flag, decided_by, status, inbound_message_id
       FROM adherence_record WHERE dose_id = $1`,
    [doseId],
  );
  return rows[0];
}

async function countFor(doseId: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM adherence_record WHERE dose_id = $1`,
    [doseId],
  );
  return Number(rows[0]!.n);
}

describe('Timeout write — delivery-gated, wipe-safe idempotent missed INSERT (real PG16)', () => {
  it('a fresh DELIVERED send with no prior row → inserts {unknown,none,none,timeout,missed}, patient_id from dose_schedule (M4)', async () => {
    await client.query('BEGIN');
    const { patientId, doseId } = await seedDose();
    await seedOutbound(patientId, doseId, 'delivered');
    const res = await client.query(TIMEOUT_INSERT_SQL, [doseId]);
    expect(res.rowCount).toBe(1);
    const row = await recordFor(doseId);
    expect(row).toMatchObject({
      adherence_state: 'unknown',
      reason_code: 'none',
      safety_flag: 'none',
      decided_by: 'timeout',
      status: 'missed',
      inbound_message_id: null,
    });
    // patient_id was derived from dose_schedule (M4) — assert it equals the dose's patient.
    const pid = await client.query<{ patient_id: string }>(
      `SELECT patient_id FROM adherence_record WHERE dose_id = $1`,
      [doseId],
    );
    expect(pid.rows[0]!.patient_id).toBe(patientId);
    await client.query('ROLLBACK');
  });

  it('a prior CLASSIFIER row → DO NOTHING (the reply wins; the classifier row is untouched)', async () => {
    await client.query('BEGIN');
    const { patientId, doseId } = await seedDose();
    await seedOutbound(patientId, doseId, 'delivered');
    const inboundId = await seedInbound(patientId);
    await client.query(ADHERENCE_UPSERT_SQL, [
      patientId,
      doseId,
      inboundId,
      'taken',
      'none',
      'none',
    ]);
    const res = await client.query(TIMEOUT_INSERT_SQL, [doseId]);
    expect(res.rowCount).toBe(0);
    const row = await recordFor(doseId);
    expect(row?.decided_by).toBe('classifier');
    expect(row?.status).toBe('recorded');
    await client.query('ROLLBACK');
  });

  it('a double-fire (timeout INSERT twice) → the second is a no-op; exactly ONE row', async () => {
    await client.query('BEGIN');
    const { patientId, doseId } = await seedDose();
    await seedOutbound(patientId, doseId, 'sent');
    expect((await client.query(TIMEOUT_INSERT_SQL, [doseId])).rowCount).toBe(1);
    expect((await client.query(TIMEOUT_INSERT_SQL, [doseId])).rowCount).toBe(0);
    expect(await countFor(doseId)).toBe(1);
    await client.query('ROLLBACK');
  });

  it('H5 — an UNDELIVERED send → NO missed row (non-response ≠ non-delivery)', async () => {
    await client.query('BEGIN');
    const { patientId, doseId } = await seedDose();
    await seedOutbound(patientId, doseId, 'undelivered');
    expect((await client.query(TIMEOUT_INSERT_SQL, [doseId])).rowCount).toBe(0);
    expect(await countFor(doseId)).toBe(0);
    await client.query('ROLLBACK');
  });

  it('H5 — a FAILED send → NO missed row', async () => {
    await client.query('BEGIN');
    const { patientId, doseId } = await seedDose();
    await seedOutbound(patientId, doseId, 'failed');
    expect((await client.query(TIMEOUT_INSERT_SQL, [doseId])).rowCount).toBe(0);
    await client.query('ROLLBACK');
  });

  it('H5 — a dose with NO outbound_message at all → NO missed row (the EXISTS gate fails)', async () => {
    await client.query('BEGIN');
    const { doseId } = await seedDose();
    expect((await client.query(TIMEOUT_INSERT_SQL, [doseId])).rowCount).toBe(0);
    await client.query('ROLLBACK');
  });

  it('M4 — a WIPED/absent dose id → no-op with NO 23503 FK throw (the SELECT FROM dose_schedule finds nothing)', async () => {
    await client.query('BEGIN');
    // A random UUID that is NOT in dose_schedule (the STUDY-04-wiped case): the INSERT … SELECT simply
    // matches no rows → rowCount 0, no foreign-key violation, no false OPS-02 alarm.
    const res = await client.query(TIMEOUT_INSERT_SQL, ['00000000-0000-4000-8000-000000000000']);
    expect(res.rowCount).toBe(0);
    await client.query('ROLLBACK');
  });

  it('U-2/H1 — a delivered dose whose patient was DEACTIVATED (is_active=false) → NO missed row', async () => {
    await client.query('BEGIN');
    const { patientId, doseId } = await seedDose();
    await seedOutbound(patientId, doseId, 'delivered');
    // STOP / admin-deactivate committed is_active=false AFTER the timeout one-shot was created (or a
    // best-effort schedule sweep missed it). The H1 EXISTS gate must suppress the `missed` write.
    await client.query(`UPDATE patient SET is_active = false WHERE id = $1`, [patientId]);
    expect((await client.query(TIMEOUT_INSERT_SQL, [doseId])).rowCount).toBe(0);
    expect(await countFor(doseId)).toBe(0);
    await client.query('ROLLBACK');
  });

  it('U-2/H1 control — the SAME delivered-dose setup with is_active=true DOES insert the missed row', async () => {
    await client.query('BEGIN');
    const { patientId, doseId } = await seedDose();
    await seedOutbound(patientId, doseId, 'delivered');
    // is_active defaults true (seedDose) — the ONLY difference from the arm above → the write proceeds.
    expect((await client.query(TIMEOUT_INSERT_SQL, [doseId])).rowCount).toBe(1);
    expect(await countFor(doseId)).toBe(1);
    await client.query('ROLLBACK');
  });
});

describe('PIPE-06 interlock — the timeout ↔ late-reply matrix (H2 status flip)', () => {
  it('timeout row THEN a late classifier reply → flips decided_by timeout→classifier AND status missed→recorded (H2)', async () => {
    await client.query('BEGIN');
    const { patientId, doseId } = await seedDose();
    await seedOutbound(patientId, doseId, 'delivered');
    const inboundId = await seedInbound(patientId);
    // 1. The timeout fires first → {missed, timeout}.
    expect((await client.query(TIMEOUT_INSERT_SQL, [doseId])).rowCount).toBe(1);
    let row = await recordFor(doseId);
    expect(row).toMatchObject({ decided_by: 'timeout', status: 'missed' });
    // 2. The late reply lands → the classifier upsert overwrites ONLY the timeout row.
    const upd = await client.query(ADHERENCE_UPSERT_SQL, [
      patientId,
      doseId,
      inboundId,
      'taken',
      'side_effect',
      'none',
    ]);
    expect(upd.rowCount).toBe(1);
    row = await recordFor(doseId);
    // H2: BOTH axes flip — decided_by AND status — plus the label + reply linkage.
    expect(row).toMatchObject({
      decided_by: 'classifier',
      status: 'recorded',
      adherence_state: 'taken',
      reason_code: 'side_effect',
      inbound_message_id: inboundId,
    });
    expect(await countFor(doseId)).toBe(1);
    await client.query('ROLLBACK');
  });

  it('late reply THEN timeout → the timeout INSERT is a DO NOTHING no-op (classifier row stands)', async () => {
    await client.query('BEGIN');
    const { patientId, doseId } = await seedDose();
    await seedOutbound(patientId, doseId, 'delivered');
    const inboundId = await seedInbound(patientId);
    // 1. The reply is classified first → {recorded, classifier}.
    await client.query(ADHERENCE_UPSERT_SQL, [
      patientId,
      doseId,
      inboundId,
      'skipped',
      'forgot',
      'none',
    ]);
    // 2. The (now stale) timeout fires → DO NOTHING.
    expect((await client.query(TIMEOUT_INSERT_SQL, [doseId])).rowCount).toBe(0);
    const row = await recordFor(doseId);
    expect(row).toMatchObject({
      decided_by: 'classifier',
      status: 'recorded',
      adherence_state: 'skipped',
    });
    expect(await countFor(doseId)).toBe(1);
    await client.query('ROLLBACK');
  });

  it('the classifier arbiter NEVER overwrites another CLASSIFIER row (WHERE decided_by=timeout is false → 0 rows)', async () => {
    await client.query('BEGIN');
    const { patientId, doseId } = await seedDose();
    await seedOutbound(patientId, doseId, 'delivered');
    const firstInbound = await seedInbound(patientId);
    const secondInbound = await seedInbound(patientId);
    await client.query(ADHERENCE_UPSERT_SQL, [
      patientId,
      doseId,
      firstInbound,
      'taken',
      'none',
      'none',
    ]);
    // A second classifier write for the SAME dose (a double-text) must NOT overwrite the first — the
    // WHERE decided_by='timeout' guard makes the DO UPDATE affect zero rows (PIPE-06 "never classifier").
    const second = await client.query(ADHERENCE_UPSERT_SQL, [
      patientId,
      doseId,
      secondInbound,
      'skipped',
      'forgot',
      'none',
    ]);
    expect(second.rowCount).toBe(0);
    const row = await recordFor(doseId);
    expect(row).toMatchObject({ adherence_state: 'taken', inbound_message_id: firstInbound });
    await client.query('ROLLBACK');
  });
});

describe('PIPE-06 arbiter — GENUINE two-connection contention on UNIQUE(dose_id) (U-3)', () => {
  // Real lock contention needs SEPARATE connections: writer A holds an uncommitted row while writer B
  // executes on its OWN connection and BLOCKS on the UNIQUE(dose_id) index until A commits. A single
  // Client only ever serializes statements — it can never prove the arbiter under true concurrency
  // (the sequential matrix above hand-traces the SQL; this block proves PG actually enforces it).
  const BLOCK_PROBE_MS = 300;
  const BLOCK_OBSERVE_TIMEOUT_MS = 5_000;
  let clientA: Client;
  let clientB: Client;
  let clientAPid: number;
  let clientBPid: number;

  beforeEach(async () => {
    clientA = new Client({ connectionString: connectionUri });
    clientB = new Client({ connectionString: connectionUri });
    await clientA.connect();
    await clientB.connect();
    clientAPid = (await clientA.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid;
    clientBPid = (await clientB.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid;
  });

  afterEach(async () => {
    // These arms COMMIT (no BEGIN…ROLLBACK to lean on), so end both contention connections every time.
    await clientA?.end();
    await clientB?.end();
  });

  /** Resolve to 'timeout' after ms — the "is B still blocked?" probe for Promise.race. */
  function afterMs(ms: number): Promise<'timeout'> {
    return new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));
  }

  /** Observe the target query active inside PostgreSQL and blocked by the expected transaction. */
  async function waitForDatabaseBlock(blockedPid: number, blockerPid: number): Promise<void> {
    const deadline = Date.now() + BLOCK_OBSERVE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { rows } = await client.query<{
        state: string;
        wait_event_type: string | null;
        blocker_pids: number[];
      }>(
        `SELECT state, wait_event_type, pg_blocking_pids(pid) AS blocker_pids
           FROM pg_stat_activity
          WHERE pid = $1`,
        [blockedPid],
      );
      const observed = rows[0];
      if (
        observed?.state === 'active' &&
        observed.wait_event_type === 'Lock' &&
        observed.blocker_pids.includes(blockerPid)
      ) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timed out waiting for PostgreSQL to observe the blocked query');
  }

  /**
   * Seed a COMMITTED dose fixture (patient + dose + delivered outbound + inbound) that BOTH connections
   * can see — the contention is on the uncommitted adherence_record row, so its prerequisites must
   * already be committed. Unique phone (uq_patient_active_phone); the returned cleanup cascade-deletes
   * the patient so these committed rows never leak into the BEGIN…ROLLBACK cases above.
   */
  async function seedCommitted(): Promise<{
    patientId: string;
    doseId: string;
    inboundId: string;
    cleanup: () => Promise<void>;
  }> {
    const p = await client.query<{ id: string }>(
      `INSERT INTO patient (owner_clinician_sub, phone, medication_name) VALUES ($1, $2, 'metformin') RETURNING id`,
      [TEST_OWNER_SUB, nextPhone()],
    );
    const patientId = p.rows[0]!.id;
    const d = await client.query<{ id: string }>(
      `INSERT INTO dose_schedule (patient_id, scheduled_at, local_dose_time)
       VALUES ($1, now(), '09:00') RETURNING id`,
      [patientId],
    );
    const doseId = d.rows[0]!.id;
    await client.query(
      `INSERT INTO outbound_message (patient_id, dose_id, status) VALUES ($1, $2, 'delivered')`,
      [patientId, doseId],
    );
    const inbound = await client.query<{ id: string }>(
      `INSERT INTO inbound_reply (patient_id, raw_body) VALUES ($1, 'took it') RETURNING id`,
      [patientId],
    );
    const cleanup = async (): Promise<void> => {
      await client.query(`DELETE FROM patient WHERE id = $1`, [patientId]);
    };
    return { patientId, doseId, inboundId: inbound.rows[0]!.id, cleanup };
  }

  it('a concurrent STOP wins the patient lock before timeout eligibility is decided', async () => {
    const { patientId, doseId, cleanup } = await seedCommitted();
    let stopTransactionOpen = false;
    let pendingTimeoutWrite: Promise<QueryResult> | undefined;
    try {
      await clientA.query('BEGIN');
      stopTransactionOpen = true;
      // Mirrors reserveInboundIntake: lock the patient first, then apply the STOP state.
      await clientA.query('SELECT id FROM patient WHERE id = $1 FOR UPDATE', [patientId]);
      await clientA.query(
        `UPDATE patient
            SET provider_opted_in = false,
                agent_enabled = false
          WHERE id = $1`,
        [patientId],
      );

      const timeoutWrite = clientB.query(TIMEOUT_INSERT_SQL, [doseId]);
      pendingTimeoutWrite = timeoutWrite;
      await waitForDatabaseBlock(clientBPid, clientAPid);

      await clientA.query('COMMIT');
      stopTransactionOpen = false;
      expect((await timeoutWrite).rowCount).toBe(0);
      expect(await countFor(doseId)).toBe(0);
    } finally {
      if (stopTransactionOpen) await clientA.query('ROLLBACK');
      await pendingTimeoutWrite?.catch(() => undefined);
      await cleanup();
    }
  });

  it('timeout row (uncommitted) THEN a concurrent classifier upsert BLOCKS on UNIQUE(dose_id); after COMMIT the classifier wins (exactly one row, decided_by=classifier)', async () => {
    const { patientId, doseId, inboundId, cleanup } = await seedCommitted();
    try {
      await clientA.query('BEGIN');
      // A writes the timeout row but holds it uncommitted → it owns the UNIQUE(dose_id) slot.
      expect((await clientA.query(TIMEOUT_INSERT_SQL, [doseId])).rowCount).toBe(1);

      // B (autocommit) fires the classifier upsert for the SAME dose — it must BLOCK on the index.
      const bWrite = clientB.query(ADHERENCE_UPSERT_SQL, [
        patientId,
        doseId,
        inboundId,
        'taken',
        'side_effect',
        'none',
      ]);
      // Both .then handlers return 'resolved' so this probe promise never rejects (no unhandled reject).
      const probe = await Promise.race([
        bWrite.then(
          () => 'resolved' as const,
          () => 'resolved' as const,
        ),
        afterMs(BLOCK_PROBE_MS),
      ]);
      expect(probe, 'B must still be blocked while A holds the uncommitted timeout row').toBe(
        'timeout',
      );

      // A commits → B unblocks and re-evaluates DO UPDATE … WHERE decided_by='timeout' against A's now-
      // committed timeout row → the predicate holds → the row flips to classifier/recorded.
      await clientA.query('COMMIT');
      const bResult = await bWrite;
      expect(bResult.rowCount).toBe(1);

      const { rows } = await client.query(
        `SELECT decided_by, status FROM adherence_record WHERE dose_id = $1`,
        [doseId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ decided_by: 'classifier', status: 'recorded' });
    } finally {
      await cleanup();
    }
  });

  it('classifier row (uncommitted) THEN a concurrent timeout INSERT BLOCKS; after COMMIT the timeout is a DO NOTHING no-op (exactly one row, decided_by=classifier)', async () => {
    const { patientId, doseId, inboundId, cleanup } = await seedCommitted();
    try {
      await clientA.query('BEGIN');
      // A writes the classifier row but holds it uncommitted.
      expect(
        (
          await clientA.query(ADHERENCE_UPSERT_SQL, [
            patientId,
            doseId,
            inboundId,
            'taken',
            'none',
            'none',
          ])
        ).rowCount,
      ).toBe(1);

      // B (autocommit) fires the timeout INSERT for the SAME dose — it must BLOCK on UNIQUE(dose_id).
      const bWrite = clientB.query(TIMEOUT_INSERT_SQL, [doseId]);
      const probe = await Promise.race([
        bWrite.then(
          () => 'resolved' as const,
          () => 'resolved' as const,
        ),
        afterMs(BLOCK_PROBE_MS),
      ]);
      expect(probe, 'B must still be blocked while A holds the uncommitted classifier row').toBe(
        'timeout',
      );

      // A commits → B unblocks, sees the committed classifier row, and its ON CONFLICT DO NOTHING
      // resolves to 0 rows (the classifier verdict is never clobbered by a late timeout).
      await clientA.query('COMMIT');
      const bResult = await bWrite;
      expect(bResult.rowCount).toBe(0);

      const { rows } = await client.query(
        `SELECT decided_by, status FROM adherence_record WHERE dose_id = $1`,
        [doseId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ decided_by: 'classifier', status: 'recorded' });
    } finally {
      await cleanup();
    }
  });
});
