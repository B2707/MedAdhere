/**
 * tester-hygiene.guard.test.ts — Docker-free unit proofs for the STUDY-04 / DATA-01
 * tester-data hygiene helpers (Plan 05-02).
 *
 *   - M6: the destructive wipe/scrub REFUSE loudly and write NOTHING without an explicit
 *         { confirmDestructive: true } flag (the precondition fires before any DB/AWS reach).
 *   - M5: the wipe sweeps BOTH the `dose-` and `timeout-` schedule prefixes for every tester
 *         BEFORE the destructive DELETE, so no orphaned EventBridge one-shot fires post-wipe.
 *
 * `@aws-sdk/client-scheduler` is fully mocked at the SDK boundary (vi.hoisted + vi.mock
 * factory — the same posture as scheduler-deactivate.test.ts / enroll/handler.test.ts), so
 * the real `deactivateSchedules` sweep runs against a spy and no AWS call ever leaves.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  PHASE8_PATIENT_OWNED_TABLES,
  scrubTesterText,
  STUDY04_CASCADE_CHILDREN,
  TESTER_HYGIENE_FIELD_INVENTORY,
  wipeTestPatients,
  type Queryable,
} from './tester-hygiene';

type SchedulerCommand = { kind: 'list' | 'delete'; input: Record<string, unknown> };
type QueryResult = { rows: unknown[]; rowCount: number | null };

// Real 36-char UUIDs (Phase-3 HIGH-3 — never a short fixture that hides a truncation bug).
const TESTER_A = '3f1b3fbe-8e5f-4bd2-9d3a-1c2e4a5b6c7d';
const TESTER_B = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const SCHEMA_SQL = readFileSync(join(__dirname, '..', 'schema-init', 'schema.sql'), 'utf8');

function listPrefixes(): string[] {
  return (schedulerSend.mock.calls as Array<[SchedulerCommand]>)
    .map(([cmd]) => cmd)
    .filter((cmd) => cmd.kind === 'list')
    .map((cmd) => cmd.input.NamePrefix as string);
}

beforeEach(() => {
  schedulerSend.mockReset();
  schedulerSend.mockResolvedValue({ Schedules: [] });
});

describe('tester-hygiene — destructive-op flag is required (M6)', () => {
  it('wipeTestPatients refuses loudly and writes NOTHING without { confirmDestructive: true }', async () => {
    const query = vi.fn<(text: string, values?: unknown[]) => Promise<QueryResult>>();
    const client: Queryable = { query };

    await expect(wipeTestPatients(client, { confirmDestructive: false })).rejects.toThrow(
      /confirmDestructive/,
    );
    // A JS caller omitting the field entirely must also be refused.
    await expect(wipeTestPatients(client, {} as { confirmDestructive: boolean })).rejects.toThrow(
      /confirmDestructive/,
    );

    expect(query, 'no DB write may happen on a refused wipe').not.toHaveBeenCalled();
    expect(schedulerSend, 'no schedule sweep may happen on a refused wipe').not.toHaveBeenCalled();
  });

  it('scrubTesterText refuses loudly and writes NOTHING without confirmation', async () => {
    const query = vi.fn<(text: string, values?: unknown[]) => Promise<QueryResult>>();
    const client: Queryable = { query };

    await expect(scrubTesterText(client, TESTER_A, { confirmDestructive: false })).rejects.toThrow(
      /confirmDestructive/,
    );

    expect(query, 'no redaction may happen on a refused scrub').not.toHaveBeenCalled();
  });

  it('scrubTesterText confirms before BEGIN, rolls back on mid-manifest failure, and preserves the original error', async () => {
    const original = new Error('boom in manifest');
    const query = vi.fn<(text: string, values?: unknown[]) => Promise<QueryResult>>(
      async (text) => {
        if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [], rowCount: null };
        if (/information_schema\.tables/i.test(text)) return { rows: [{}], rowCount: 1 };
        if (/UPDATE inbound_reply/i.test(text)) return { rows: [], rowCount: 1 };
        if (/UPDATE outbound_message/i.test(text)) throw original;
        return { rows: [], rowCount: 0 };
      },
    );
    const client: Queryable = { query };

    await expect(scrubTesterText(client, TESTER_A, { confirmDestructive: true })).rejects.toBe(
      original,
    );

    expect(query.mock.calls[0]![0]).toBe('BEGIN');
    expect(query.mock.calls.map(([text]) => text)).toContain('ROLLBACK');
    expect(query.mock.calls.map(([text]) => text)).not.toContain('COMMIT');
  });
});

describe('tester-hygiene — wipe sweeps every schedule prefix per tester before deleting (M5)', () => {
  it('calls dose, reminder, and timeout sweeps for every tester before DELETE', async () => {
    const query = vi
      .fn<(text: string, values?: unknown[]) => Promise<QueryResult>>()
      // 1) enumerate testers
      .mockResolvedValueOnce({ rows: [{ id: TESTER_A }, { id: TESTER_B }], rowCount: 2 })
      // 2) the one-transaction cascade DELETE
      .mockResolvedValueOnce({ rows: [], rowCount: 2 });
    const client: Queryable = { query };

    const result = await wipeTestPatients(client, { confirmDestructive: true });

    // Every prefix is swept for both testers (the sweep resolves the real NamePrefix shapes).
    const prefixes = listPrefixes();
    for (const id of [TESTER_A, TESTER_B]) {
      expect(prefixes, `dose- sweep for ${id}`).toContain(`dose-${id}-`);
      expect(prefixes, `reminder- sweep for ${id}`).toContain(`reminder-${id}-`);
      expect(prefixes, `timeout- sweep for ${id}`).toContain(`timeout-${id}-`);
    }

    // Ordering: the SELECT (call #1) and every sweep precede the DELETE (call #2) — a schedule
    // must never be able to fire against a row that is about to be deleted out from under it.
    const selectOrder = query.mock.invocationCallOrder[0]!;
    const deleteOrder = query.mock.invocationCallOrder[1]!;
    const lastSweepOrder = Math.max(...schedulerSend.mock.invocationCallOrder);
    expect(selectOrder).toBeLessThan(deleteOrder);
    expect(lastSweepOrder, 'all sweeps must complete before the DELETE').toBeLessThan(deleteOrder);

    // L-3 (TOCTOU): the DELETE binds the EXACT captured ids (id = ANY($1)), NOT a re-evaluated
    // `WHERE is_test = true` that could pick up a patient enrolled after the SELECT.
    const deleteCall = query.mock.calls[1]!;
    expect(String(deleteCall[0])).toMatch(/DELETE FROM patient\s+WHERE id = ANY\(\$1/i);
    expect(String(deleteCall[0])).not.toMatch(/is_test/i);
    expect(deleteCall[1]).toEqual([[TESTER_A, TESTER_B]]);

    expect(result.testersFound).toBe(2);
    expect(result.patientsDeleted).toBe(2);
  });

  it('is a no-op DELETE with an empty sweep when there are zero testers', async () => {
    const query = vi
      .fn<(text: string, values?: unknown[]) => Promise<QueryResult>>()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // enumerate → none
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DELETE → 0
    const client: Queryable = { query };

    const result = await wipeTestPatients(client, { confirmDestructive: true });

    expect(schedulerSend, 'no testers → no sweep').not.toHaveBeenCalled();
    // L-3: an empty captured set still binds cleanly — DELETE … WHERE id = ANY(ARRAY[]::uuid[]).
    const deleteCall = query.mock.calls[1]!;
    expect(String(deleteCall[0])).toMatch(/DELETE FROM patient\s+WHERE id = ANY\(\$1/i);
    expect(deleteCall[1]).toEqual([[]]);
    expect(result).toEqual({ testersFound: 0, patientsDeleted: 0, schedulesSwept: 0 });
  });
});

describe('tester-hygiene — PHI/free-text manifest drift guards (08-02)', () => {
  it('classifies every approved Phase-8 patient-owned table for the STUDY-04 wipe', () => {
    expect(PHASE8_PATIENT_OWNED_TABLES).toEqual([
      'patient_medication',
      'patient_medication_ingredient',
      'clinical_fact',
      'turn_job',
      'agent_turn',
      'clinical_event',
      'clinical_event_source',
      'clinical_event_evidence',
      'information_need',
      'information_need_scope',
      'information_need_event_candidate',
      'information_need_transition',
      'clinical_review_item',
      'clinical_review_item_transition',
      'daily_summary',
      'clinician_review_draft',
      'clinician_review_action',
      'usage_bucket',
    ]);
    for (const table of PHASE8_PATIENT_OWNED_TABLES) {
      expect(
        STUDY04_CASCADE_CHILDREN,
        `${table} must be in the live wipe blast-radius manifest`,
      ).toContain(table);
    }
  });

  it('keeps a machine-readable writer/reader/surface/retention/max-length/scrub action for every manifest field', () => {
    expect(TESTER_HYGIENE_FIELD_INVENTORY.length).toBeGreaterThan(0);
    for (const item of TESTER_HYGIENE_FIELD_INVENTORY) {
      expect(item.table).toMatch(/^[a-z_]+$/);
      expect(item.column).toMatch(/^[a-z_]+$/);
      expect(item.writer.length, `${item.table}.${item.column} writer`).toBeGreaterThan(0);
      expect(item.reader.length, `${item.table}.${item.column} reader`).toBeGreaterThan(0);
      expect(item.readSurface, `${item.table}.${item.column} readSurface`).toMatch(
        /^(owner_scoped_data_api|owner_scoped_review_queue|service_owned_export|privileged_ops|future_phase8_owner_scoped_repository|internal_worker_only)$/,
      );
      expect(item.retention.length, `${item.table}.${item.column} retention`).toBeGreaterThan(0);
      expect(item.maxLength, `${item.table}.${item.column} maxLength`).toBeGreaterThan(0);
      expect(item.scrubAction).toMatch(/^(preserve|redact_empty_string|redact_null|delete_rows)$/);
    }
  });

  it('classifies the new turn-stage results and agent outbound metadata before they can retain tester text', () => {
    const inventory = new Map(
      TESTER_HYGIENE_FIELD_INVENTORY.map((item) => [`${item.table}.${item.column}`, item]),
    );
    expect(inventory.get('turn_job.interpretation_result')).toMatchObject({
      maxLength: 100_000,
      scrubAction: 'redact_null',
      readSurface: 'internal_worker_only',
    });
    expect(inventory.get('turn_job.writer_result')).toMatchObject({
      maxLength: 100_000,
      scrubAction: 'redact_null',
      readSurface: 'internal_worker_only',
    });
    expect(inventory.get('patient.preferred_language')).toMatchObject({
      maxLength: 35,
      scrubAction: 'preserve',
    });
    expect(inventory.get('outbound_message.clarification_topic')).toMatchObject({
      maxLength: 32,
      scrubAction: 'preserve',
    });
    expect(inventory.get('outbound_message.temporal_candidates')).toMatchObject({
      maxLength: 100_000,
      scrubAction: 'preserve',
    });
    expect(inventory.get('clinical_event.normalized_value')).toMatchObject({
      maxLength: 200,
      scrubAction: 'delete_rows',
    });
    expect(inventory.get('clinical_event.patient_timezone')).toMatchObject({
      maxLength: 64,
      scrubAction: 'preserve',
    });
    expect(inventory.get('outbound_message.message_kind')).toMatchObject({
      maxLength: 24,
      scrubAction: 'preserve',
    });
    expect(inventory.get('outbound_message.language')).toMatchObject({
      maxLength: 35,
      scrubAction: 'preserve',
    });
  });

  it('classifies patient-visible or exportable fields as owner-scoped/service-owned, never unscoped', () => {
    for (const item of TESTER_HYGIENE_FIELD_INVENTORY) {
      if (item.readSurface === 'internal_worker_only') continue;
      expect(
        [
          'owner_scoped_data_api',
          'owner_scoped_review_queue',
          'service_owned_export',
          'privileged_ops',
          'future_phase8_owner_scoped_repository',
        ],
        `${item.table}.${item.column} must declare a bounded reader surface`,
      ).toContain(item.readSurface);
    }
  });

  it('classifies every current patient-owned text/jsonb/varchar column so schema drift cannot add unreviewed PHI', () => {
    const tableBlocks = [
      ...SCHEMA_SQL.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(([\s\S]*?)\n\);/g),
    ];
    const patientOwnedTables = new Set(['patient', ...STUDY04_CASCADE_CHILDREN]);
    const directPatientTables = tableBlocks
      .filter((match) => /REFERENCES patient \(/.test(match[2] ?? ''))
      .map((match) => match[1]!);
    expect(
      directPatientTables.filter((table) => !patientOwnedTables.has(table)).sort(),
      'any new table with a direct patient FK must be classified in STUDY04_CASCADE_CHILDREN',
    ).toEqual([]);
    const schemaColumns = tableBlocks.flatMap((match) => {
      const table = match[1]!;
      const block = match[2]!;
      if (!patientOwnedTables.has(table)) return [];
      return block
        .split('\n')
        .map((line) => /^\s*([a-z_]+)\s+(text|jsonb|varchar\((\d+)\))\b/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => ({
          key: `${table}.${match[1]}`,
          maxLength: match[3] === undefined ? undefined : Number(match[3]),
        }));
    });
    const alterColumns = [
      ...SCHEMA_SQL.matchAll(
        /ALTER TABLE ([a-z_]+) ADD COLUMN IF NOT EXISTS ([a-z_]+) (text|jsonb|varchar\((\d+)\))/g,
      ),
    ]
      .filter((match) => patientOwnedTables.has(match[1]!))
      .map((match) => ({
        key: `${match[1]}.${match[2]}`,
        maxLength: match[4] === undefined ? undefined : Number(match[4]),
      }));
    const classified = new Set(
      TESTER_HYGIENE_FIELD_INVENTORY.map((item) => `${item.table}.${item.column}`),
    );
    const allColumns = [...schemaColumns, ...alterColumns];
    expect(
      allColumns
        .map((column) => column.key)
        .filter((column) => !classified.has(column))
        .sort(),
      'any new patient-owned text/jsonb/varchar column must be classified in TESTER_HYGIENE_FIELD_INVENTORY',
    ).toEqual([]);

    const inventoryByColumn = new Map(
      TESTER_HYGIENE_FIELD_INVENTORY.map((item) => [`${item.table}.${item.column}`, item]),
    );
    const lengthMismatches = allColumns
      .filter((column) => column.maxLength !== undefined)
      .filter((column) => inventoryByColumn.get(column.key)?.maxLength !== column.maxLength)
      .map(
        (column) =>
          `${column.key}: schema=${column.maxLength}, manifest=${inventoryByColumn.get(column.key)?.maxLength}`,
      );
    expect(lengthMismatches, 'manifest maxLength must equal schema varchar(n)').toEqual([]);
  });

  it('deletes immutable Phase-8 tester rows instead of issuing trigger-rejected redaction updates', async () => {
    const existingTables = new Set([
      'patient_medication',
      'clinical_fact',
      'agent_turn',
      'clinical_event',
      'daily_summary',
      'clinician_review_draft',
    ]);
    const query = vi.fn<(text: string, values?: unknown[]) => Promise<QueryResult>>(
      async (text) => {
        if (/information_schema\.tables/i.test(text)) {
          const tableName = /\$table:([a-z_]+)/.exec(text)?.[1];
          return {
            rows: tableName !== undefined && existingTables.has(tableName) ? [{}] : [],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
    );
    const client: Queryable = { query };

    await scrubTesterText(client, TESTER_A, { confirmDestructive: true });

    const sql = query.mock.calls.map(([text]) => text).join('\n');
    expect(sql).toMatch(/UPDATE dose_schedule[\s\S]*SET patient_medication_id = NULL/);
    expect(sql).toMatch(/DELETE FROM clinical_fact/);
    expect(sql).toMatch(/DELETE FROM agent_turn/);
    expect(sql).toMatch(/DELETE FROM clinical_event/);
    expect(sql).toMatch(/DELETE FROM daily_summary/);
    expect(sql).toMatch(/DELETE FROM clinician_review_draft/);
    expect(sql).not.toMatch(/UPDATE clinical_event/);
    expect(sql).not.toMatch(/UPDATE daily_summary/);
    expect(sql).not.toMatch(/UPDATE clinician_review_draft/);
  });

  it('detaches tester dose schedules before deleting patient_medication rows', async () => {
    const existingTables = new Set(['patient_medication']);
    const query = vi.fn<(text: string, values?: unknown[]) => Promise<QueryResult>>(
      async (text) => {
        if (/information_schema\.tables/i.test(text)) {
          const tableName = /\$table:([a-z_]+)/.exec(text)?.[1];
          return {
            rows: tableName !== undefined && existingTables.has(tableName) ? [{}] : [],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
    );
    const client: Queryable = { query };

    await scrubTesterText(client, TESTER_A, { confirmDestructive: true });

    const updateIndex = query.mock.calls.findIndex(([text]) =>
      /UPDATE dose_schedule[\s\S]*SET patient_medication_id = NULL/.test(text),
    );
    const deleteIndex = query.mock.calls.findIndex(([text]) =>
      /DELETE FROM patient_medication/.test(text),
    );
    expect(updateIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(-1);
    expect(updateIndex).toBeLessThan(deleteIndex);
    const updateSql = String(query.mock.calls[updateIndex]![0]);
    expect(updateSql).toMatch(/FROM patient p/);
    expect(updateSql).toMatch(/p\.is_test = true/);
    expect(updateSql).toMatch(/p\.id = \$1/);
    expect(query.mock.calls[updateIndex]![1]).toEqual([TESTER_A]);
  });
});
