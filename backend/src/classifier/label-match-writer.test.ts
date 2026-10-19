/**
 * label-match-writer.test.ts — 04-06 component 5 (M4). Proves the label_match writer against
 * a REAL PostgreSQL 16 (testcontainers, or CI TEST_DATABASE_URL): same-row patient_id
 * (REV-M1), ON CONFLICT replay idempotency (H3), and multi-PT writes. No silent fallback —
 * fails loud in beforeAll if no Docker/DB.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { writeLabelMatches } from './label-match-writer.js';
import type { AdeMatchCandidate } from './ade-matcher.js';

const SCHEMA_SQL = readFileSync(join(__dirname, '../schema-init/schema.sql'), 'utf8');
const CONTAINER_TIMEOUT_MS = 180_000;
const TEST_OWNER_SUB = '8f6e7138-fd21-4b31-8ac3-934cfc610f44';

let container: StartedPostgreSqlContainer | undefined;
let pool: Pool;

async function seedReply(): Promise<{ inboundMessageId: string; patientId: string }> {
  const p = await pool.query(
    `INSERT INTO patient (owner_clinician_sub, phone, medication_name) VALUES ($1, $2, $3) RETURNING id`,
    [TEST_OWNER_SUB, `+1500555${Math.floor(Math.random() * 9000 + 1000)}`, 'metformin'],
  );
  const patientId = p.rows[0].id as string;
  const r = await pool.query(
    `INSERT INTO inbound_reply (patient_id, raw_body) VALUES ($1, $2) RETURNING id`,
    [patientId, 'my stomach is killing me'],
  );
  return { inboundMessageId: r.rows[0].id as string, patientId };
}

beforeAll(async () => {
  const ciUrl = process.env.TEST_DATABASE_URL;
  if (ciUrl) {
    pool = new Pool({ connectionString: ciUrl });
  } else {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
  }
  await pool.query('BEGIN');
  await pool.query(SCHEMA_SQL);
  await pool.query('COMMIT');
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

const cand = (
  matchedPhrase: string,
  meddraPt: string,
  hintLevel: 'info' | 'elevated' = 'info',
): AdeMatchCandidate => ({
  matchedPhrase,
  meddraPt,
  hintLevel,
});

describe('writeLabelMatches — real PostgreSQL', () => {
  it('inserts one row per candidate and stores the caller-supplied patient_id (REV-M1)', async () => {
    const { inboundMessageId, patientId } = await seedReply();
    const n = await writeLabelMatches(pool, {
      inboundMessageId,
      patientId,
      candidates: [cand('killing me', 'Abdominal pain', 'elevated'), cand('nauseous', 'Nausea')],
    });
    expect(n).toBe(2);
    const rows = await pool.query(
      `SELECT patient_id, matched_phrase, meddra_pt, hint_level FROM label_match WHERE inbound_message_id = $1 ORDER BY meddra_pt`,
      [inboundMessageId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((r) => r.patient_id === patientId)).toBe(true);
    expect(rows.rows[0]).toMatchObject({ meddra_pt: 'Abdominal pain', hint_level: 'elevated' });
  });

  it('is idempotent on replay — ON CONFLICT DO NOTHING inserts 0 the second time', async () => {
    const { inboundMessageId, patientId } = await seedReply();
    const candidates = [cand('killing me', 'Abdominal pain')];
    expect(await writeLabelMatches(pool, { inboundMessageId, patientId, candidates })).toBe(1);
    expect(await writeLabelMatches(pool, { inboundMessageId, patientId, candidates })).toBe(0);
    const count = await pool.query(
      `SELECT count(*)::int AS c FROM label_match WHERE inbound_message_id = $1`,
      [inboundMessageId],
    );
    expect(count.rows[0].c).toBe(1);
  });

  it('writes multiple distinct PTs for the same matched phrase', async () => {
    const { inboundMessageId, patientId } = await seedReply();
    const n = await writeLabelMatches(pool, {
      inboundMessageId,
      patientId,
      candidates: [cand('swollen', 'Oedema'), cand('swollen', 'Oedema peripheral')],
    });
    expect(n).toBe(2);
  });

  it('no-ops (returns 0) on an empty candidate list without erroring', async () => {
    const { inboundMessageId, patientId } = await seedReply();
    expect(await writeLabelMatches(pool, { inboundMessageId, patientId, candidates: [] })).toBe(0);
  });
});
