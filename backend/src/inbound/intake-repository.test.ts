import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { markInboundEnqueued, reserveInboundIntake } from './intake-repository.js';

const PATIENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const INBOUND_ID = '7c9e6679-7425-40de-963d-02d4f4a986e1';
const FOREIGN_PATIENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PHONE = '+15145550123';
const MESSAGE_SID = 'SM11111111111111111111111111111111';

type QueryReply = Pick<QueryResult, 'rows' | 'rowCount'>;

function result(rows: unknown[] = [], rowCount = rows.length): QueryReply {
  return { rows, rowCount };
}

/** Both intake windows still had room: two rows back, neither in its notice slot. */
function capacityAvailable(): QueryReply {
  return result([
    { bucket_scope: 'patient_burst', consumed_units: 1, limit_units: 21 },
    { bucket_scope: 'patient_day', consumed_units: 1, limit_units: 51 },
  ]);
}

function makePool(
  responder: (
    sql: string,
    params: readonly unknown[] | undefined,
  ) => QueryReply | Promise<QueryReply>,
  capacity: QueryReply = capacityAvailable(),
) {
  const query = vi.fn(async (sql: string, params?: readonly unknown[]) =>
    /usage_bucket/i.test(sql) ? capacity : responder(sql, params),
  );
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => responder(sql, params)),
  } as unknown as Pool;
  return { pool, query, release };
}

const baseInput = {
  phone: PHONE,
  rawBody: 'taken this morning',
  emergencyCategory: null,
  messageSid: MESSAGE_SID,
  createTurnJob: true,
  control: null,
} as const;

describe('reserveInboundIntake', () => {
  it('locks the patient and atomically allocates the sequence, inbound row, and turn job', async () => {
    const { pool, query, release } = makePool((sql) => {
      if (/FROM patient/i.test(sql)) {
        return result([
          {
            id: PATIENT_ID,
            timezone: 'America/Toronto',
            preferred_language: 'fr-CA',
            messaging_state_version: 7,
          },
        ]);
      }
      if (/FROM inbound_reply/i.test(sql)) return result();
      if (/UPDATE patient[\s\S]*next_inbound_sequence/i.test(sql)) {
        return result([{ inbound_sequence: 7 }]);
      }
      if (/INSERT INTO inbound_reply/i.test(sql)) return result([{ id: INBOUND_ID }]);
      if (/INSERT INTO turn_job/i.test(sql)) return result([], 1);
      return result([], 0);
    });

    await expect(reserveInboundIntake(pool, baseInput)).resolves.toEqual({
      kind: 'new',
      patientId: PATIENT_ID,
      inboundMessageId: INBOUND_ID,
      inboundSequence: 7,
      shouldEnqueue: true,
      shouldSweepSchedules: false,
      preferredLanguage: 'fr-CA',
    });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements[0]).toMatch(/^BEGIN$/i);
    expect(statements[1]).toMatch(
      /FROM patient[\s\S]*is_active\s*=\s*true[\s\S]*agent_enabled[\s\S]*provider_opted_in[\s\S]*FOR UPDATE/i,
    );
    expect(statements[1]).toMatch(
      /SELECT\s+id,\s*timezone,\s*preferred_language,\s*messaging_state_version/i,
    );
    expect(statements[2]).toMatch(/twilio_message_sid\s*=\s*\$1/i);
    expect(statements[3]).toMatch(/next_inbound_sequence\s*=\s*next_inbound_sequence\s*\+\s*1/i);
    expect(statements[4]).toMatch(
      /ON CONFLICT\s*\(\s*twilio_message_sid\s*\)\s*WHERE\s+twilio_message_sid\s+IS\s+NOT\s+NULL\s+DO\s+NOTHING/i,
    );
    expect(statements[4]).toMatch(/original_control[\s\S]*control_messaging_state_version/i);
    expect(query.mock.calls[4]?.[1]).toEqual([
      PATIENT_ID,
      baseInput.rawBody,
      false,
      MESSAGE_SID,
      7,
      null,
      null,
    ]);
    expect(statements[5]).toMatch(/INSERT INTO usage_bucket/i);
    expect(statements[6]).toMatch(/INSERT INTO turn_job/i);
    expect(statements[6]).toMatch(/messaging_state_version/i);
    expect(query.mock.calls[6]?.[1]).toEqual([PATIENT_ID, INBOUND_ID, 7, 7]);
    expect(statements[7]).toMatch(/^COMMIT$/i);
    expect(release).toHaveBeenCalledOnce();
  });

  it('republishes only an incomplete duplicate whose successful handoff stamp is absent', async () => {
    const { pool, query } = makePool((sql) => {
      if (/FROM patient/i.test(sql)) {
        return result([{ id: PATIENT_ID, timezone: 'America/Toronto', preferred_language: 'es' }]);
      }
      if (/FROM inbound_reply/i.test(sql)) {
        return result([
          {
            id: INBOUND_ID,
            patient_id: PATIENT_ID,
            inbound_sequence: '4',
            enqueued_at: null,
            has_turn_job: true,
            completed: false,
          },
        ]);
      }
      return result([], 0);
    });

    await expect(reserveInboundIntake(pool, baseInput)).resolves.toEqual({
      kind: 'duplicate',
      patientId: PATIENT_ID,
      inboundMessageId: INBOUND_ID,
      inboundSequence: 4,
      shouldEnqueue: true,
      shouldSweepSchedules: false,
      preferredLanguage: 'es',
    });
    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual([
      'BEGIN',
      expect.stringMatching(/FROM patient/i),
      expect.stringMatching(/FROM inbound_reply/i),
      'COMMIT',
    ]);
  });

  it('fails closed without returning identifiers when the SID belongs to another patient', async () => {
    const { pool } = makePool((sql) => {
      if (/FROM patient/i.test(sql)) return result([{ id: PATIENT_ID }]);
      if (/FROM inbound_reply/i.test(sql)) {
        return result([
          {
            id: INBOUND_ID,
            patient_id: FOREIGN_PATIENT_ID,
            inbound_sequence: '1',
            enqueued_at: null,
            has_turn_job: true,
            completed: false,
          },
        ]);
      }
      return result([], 0);
    });

    await expect(reserveInboundIntake(pool, baseInput)).rejects.toThrow(
      'MessageSid is already assigned to another patient',
    );
  });

  it.each([
    {
      label: 'already queued',
      row: { enqueued_at: new Date('2026-08-11T10:00:00Z'), has_turn_job: true, completed: false },
    },
    {
      label: 'already completed',
      row: { enqueued_at: null, has_turn_job: true, completed: true },
    },
    {
      label: 'control message without a turn job',
      row: { enqueued_at: null, has_turn_job: false, completed: false },
    },
  ])('suppresses a $label duplicate', async ({ row }) => {
    const { pool } = makePool((sql) => {
      if (/FROM patient/i.test(sql)) return result([{ id: PATIENT_ID }]);
      if (/FROM inbound_reply/i.test(sql)) {
        return result([
          {
            id: INBOUND_ID,
            patient_id: PATIENT_ID,
            inbound_sequence: '4',
            ...row,
          },
        ]);
      }
      return result([], 0);
    });

    await expect(reserveInboundIntake(pool, baseInput)).resolves.toMatchObject({
      kind: 'duplicate',
      shouldEnqueue: false,
    });
  });

  it('rolls back the allocated sequence when another transaction wins the global SID race', async () => {
    let duplicateReads = 0;
    const { pool, query } = makePool((sql) => {
      if (/FROM patient/i.test(sql)) return result([{ id: PATIENT_ID }]);
      if (/FROM inbound_reply/i.test(sql)) {
        duplicateReads += 1;
        if (duplicateReads === 1) return result();
        return result([
          {
            id: INBOUND_ID,
            patient_id: PATIENT_ID,
            inbound_sequence: '9',
            enqueued_at: null,
            has_turn_job: true,
            completed: false,
          },
        ]);
      }
      if (/UPDATE patient/i.test(sql)) return result([{ inbound_sequence: '9' }]);
      if (/INSERT INTO inbound_reply/i.test(sql)) return result();
      return result([], 0);
    });

    await expect(reserveInboundIntake(pool, baseInput)).resolves.toMatchObject({
      kind: 'duplicate',
      inboundSequence: 9,
      shouldEnqueue: true,
    });
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
  });

  it('rolls back the entire intake if turn-job creation fails', async () => {
    const { pool, query, release } = makePool((sql) => {
      if (/FROM patient/i.test(sql)) return result([{ id: PATIENT_ID }]);
      if (/FROM inbound_reply/i.test(sql)) return result();
      if (/UPDATE patient/i.test(sql)) return result([{ inbound_sequence: '1' }]);
      if (/INSERT INTO inbound_reply/i.test(sql)) return result([{ id: INBOUND_ID }]);
      if (/INSERT INTO turn_job/i.test(sql)) throw new Error('turn job unavailable');
      return result([], 0);
    });

    await expect(reserveInboundIntake(pool, baseInput)).rejects.toThrow(/turn job unavailable/);
    expect(query.mock.calls.map(([sql]) => String(sql))).toContain('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });

  it('creates the emergency alert before committing the inbound reservation', async () => {
    const safetyEventId = '9b2e6679-4f89-42de-963d-02d4f4a986aa';
    const { pool, query } = makePool((sql) => {
      if (/FROM patient/i.test(sql)) {
        return result([
          {
            id: PATIENT_ID,
            timezone: 'America/Toronto',
            preferred_language: 'en',
          },
        ]);
      }
      if (/FROM inbound_reply/i.test(sql)) return result();
      if (/next_inbound_sequence/i.test(sql)) return result([{ inbound_sequence: '1' }]);
      if (/INSERT INTO inbound_reply/i.test(sql)) return result([{ id: INBOUND_ID }]);
      if (/INSERT INTO safety_events/i.test(sql)) return result([{ id: safetyEventId }]);
      return result([], 0);
    });

    await expect(
      reserveInboundIntake(pool, {
        ...baseInput,
        emergencyCategory: 'acute_physical',
        createTurnJob: false,
      }),
    ).resolves.toMatchObject({ kind: 'new', safetyEventId, shouldEnqueue: false });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    const alertIndex = statements.findIndex((sql) => /INSERT INTO safety_events/i.test(sql));
    expect(alertIndex).toBeGreaterThan(
      statements.findIndex((sql) => /INSERT INTO inbound_reply/i.test(sql)),
    );
    expect(alertIndex).toBeLessThan(statements.indexOf('COMMIT'));
    expect(query.mock.calls[alertIndex]?.[1]).toEqual([PATIENT_ID, INBOUND_ID, 'acute_physical']);
  });

  it('atomically stores STOP, disables provider and agent state without retiring the current patient, and requests one sweep', async () => {
    const { pool, query } = makePool((sql) => {
      if (/FROM patient/i.test(sql)) {
        return result([
          {
            id: PATIENT_ID,
            timezone: 'America/Toronto',
            preferred_language: 'en',
            messaging_state_version: 7,
          },
        ]);
      }
      if (/FROM inbound_reply/i.test(sql)) return result();
      if (/next_inbound_sequence/i.test(sql)) return result([{ inbound_sequence: '2' }]);
      if (/provider_opted_in\s*=\s*false/i.test(sql)) return result([], 1);
      if (/INSERT INTO inbound_reply/i.test(sql)) return result([{ id: INBOUND_ID }]);
      return result([], 0);
    });

    await expect(
      reserveInboundIntake(pool, { ...baseInput, createTurnJob: false, control: 'stop' }),
    ).resolves.toMatchObject({
      kind: 'new',
      shouldEnqueue: false,
      shouldSweepSchedules: true,
    });
    const stateWrite = query.mock.calls.find(([sql]) =>
      /UPDATE patient[\s\S]*provider_opted_in\s*=\s*false/i.test(String(sql)),
    );
    expect(String(stateWrite?.[0])).toMatch(/agent_enabled\s*=\s*false/i);
    expect(String(stateWrite?.[0])).toMatch(
      /messaging_state_version\s*=\s*messaging_state_version\s*\+\s*1/i,
    );
    expect(String(stateWrite?.[0])).toMatch(
      /opted_out_at\s*=\s*COALESCE\(opted_out_at,\s*(?:now\(\)|CURRENT_TIMESTAMP)\)/i,
    );
    expect(String(stateWrite?.[0])).not.toMatch(/is_active\s*=\s*false/i);
    expect(query.mock.calls.some(([sql]) => /INSERT INTO turn_job/i.test(String(sql)))).toBe(false);
    const inboundWrite = query.mock.calls.find(([sql]) =>
      /INSERT INTO inbound_reply/i.test(String(sql)),
    );
    expect(inboundWrite?.[1]).toEqual([
      PATIENT_ID,
      baseInput.rawBody,
      false,
      MESSAGE_SID,
      2,
      'stop',
      8,
    ]);
  });

  it('atomically stores START and restores provider consent only, leaving agent activation untouched', async () => {
    const { pool, query } = makePool((sql) => {
      if (/FROM patient/i.test(sql)) {
        return result([
          {
            id: PATIENT_ID,
            timezone: 'America/Toronto',
            preferred_language: 'en',
            messaging_state_version: 8,
          },
        ]);
      }
      if (/FROM inbound_reply/i.test(sql)) return result();
      if (/next_inbound_sequence/i.test(sql)) return result([{ inbound_sequence: '3' }]);
      if (/provider_opted_in\s*=\s*true/i.test(sql)) return result([], 1);
      if (/INSERT INTO inbound_reply/i.test(sql)) return result([{ id: INBOUND_ID }]);
      return result([], 0);
    });

    await expect(
      reserveInboundIntake(pool, { ...baseInput, createTurnJob: false, control: 'start' }),
    ).resolves.toMatchObject({
      kind: 'new',
      shouldEnqueue: false,
      shouldSweepSchedules: false,
    });
    const stateWrite = query.mock.calls.find(([sql]) =>
      /UPDATE patient[\s\S]*provider_opted_in\s*=\s*true/i.test(String(sql)),
    );
    expect(String(stateWrite?.[0])).toMatch(
      /messaging_state_version\s*=\s*messaging_state_version\s*\+\s*1/i,
    );
    expect(String(stateWrite?.[0])).toMatch(/opted_out_at\s*=\s*NULL/i);
    expect(String(stateWrite?.[0])).not.toMatch(/agent_enabled\s*=\s*true/i);
    expect(String(stateWrite?.[0])).not.toMatch(/is_active\s*=/i);
    expect(query.mock.calls.some(([sql]) => /INSERT INTO turn_job/i.test(String(sql)))).toBe(false);
    const inboundWrite = query.mock.calls.find(([sql]) =>
      /INSERT INTO inbound_reply/i.test(String(sql)),
    );
    expect(inboundWrite?.[1]).toEqual([
      PATIENT_ID,
      baseInput.rawBody,
      false,
      MESSAGE_SID,
      3,
      'start',
      9,
    ]);
  });

  it('does not replay consent state but requests an idempotent schedule resweep for duplicate STOP', async () => {
    const { pool, query } = makePool((sql) => {
      if (/FROM patient/i.test(sql)) {
        return result([
          {
            id: PATIENT_ID,
            timezone: 'America/Toronto',
            preferred_language: 'en',
            messaging_state_version: 8,
          },
        ]);
      }
      if (/FROM inbound_reply/i.test(sql)) {
        return result([
          {
            id: INBOUND_ID,
            patient_id: PATIENT_ID,
            inbound_sequence: '4',
            enqueued_at: null,
            has_turn_job: false,
            completed: false,
            original_control: 'stop',
            control_messaging_state_version: 8,
          },
        ]);
      }
      return result([], 0);
    });

    await expect(
      reserveInboundIntake(pool, { ...baseInput, createTurnJob: false, control: 'stop' }),
    ).resolves.toMatchObject({
      kind: 'duplicate',
      shouldEnqueue: false,
      shouldSweepSchedules: true,
    });
    expect(
      query.mock.calls.some(([sql]) =>
        /UPDATE patient[\s\S]*provider_opted_in\s*=\s*(?:true|false)/i.test(String(sql)),
      ),
    ).toBe(false);
  });

  it.each([
    {
      label: 'legacy row without metadata',
      originalControl: null,
      controlVersion: null,
    },
    {
      label: 'STOP from an older epoch',
      originalControl: 'stop',
      controlVersion: 7,
    },
    {
      label: 'non-STOP control at the current epoch',
      originalControl: 'start',
      controlVersion: 8,
    },
  ])(
    'denies schedule sweeping for a duplicate $label',
    async ({ originalControl, controlVersion }) => {
      const { pool } = makePool((sql) => {
        if (/FROM patient/i.test(sql)) {
          return result([
            {
              id: PATIENT_ID,
              timezone: 'America/Toronto',
              preferred_language: 'en',
              messaging_state_version: 8,
            },
          ]);
        }
        if (/FROM inbound_reply/i.test(sql)) {
          return result([
            {
              id: INBOUND_ID,
              patient_id: PATIENT_ID,
              inbound_sequence: '4',
              enqueued_at: null,
              has_turn_job: false,
              completed: false,
              original_control: originalControl,
              control_messaging_state_version: controlVersion,
            },
          ]);
        }
        return result([], 0);
      });

      await expect(
        reserveInboundIntake(pool, { ...baseInput, createTurnJob: false, control: 'stop' }),
      ).resolves.toMatchObject({
        kind: 'duplicate',
        shouldSweepSchedules: false,
      });
    },
  );

  it.each([
    { label: 'missing', rows: [] },
    { label: 'ambiguous legacy', rows: [{ id: PATIENT_ID }, { id: FOREIGN_PATIENT_ID }] },
  ])('returns unmatched without writing for a $label current-phone identity', async ({ rows }) => {
    const { pool, query } = makePool((sql) => {
      if (/FROM patient/i.test(sql)) return result(rows);
      return result([], 0);
    });

    await expect(reserveInboundIntake(pool, baseInput)).resolves.toEqual({
      kind: 'unmatched',
      matchCount: rows.length,
    });
    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual([
      'BEGIN',
      expect.stringMatching(/FROM patient/i),
      'COMMIT',
    ]);
  });

  it('fails closed when a deterministic emergency has ambiguous active matches', async () => {
    const { pool, query } = makePool((sql) => {
      if (/FROM patient/i.test(sql)) {
        return result([{ id: PATIENT_ID }, { id: FOREIGN_PATIENT_ID }]);
      }
      return result([], 0);
    });

    await expect(
      reserveInboundIntake(pool, {
        ...baseInput,
        emergencyCategory: 'crisis',
        createTurnJob: false,
      }),
    ).resolves.toEqual({ kind: 'unmatched', matchCount: 2 });
    expect(query.mock.calls[1]?.[1]).toEqual([PHONE, true]);
    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual([
      'BEGIN',
      expect.stringMatching(/FROM patient/i),
      'COMMIT',
    ]);
  });

  it('uses current-record lookup for controls and deterministic emergencies only', async () => {
    const { pool, query } = makePool((sql) => {
      if (/FROM patient/i.test(sql)) return result([]);
      return result([], 0);
    });

    await reserveInboundIntake(pool, baseInput);
    await reserveInboundIntake(pool, { ...baseInput, control: 'help', createTurnJob: false });
    await reserveInboundIntake(pool, {
      ...baseInput,
      messageSid: 'SM22222222222222222222222222222222',
      emergencyCategory: 'crisis',
      createTurnJob: false,
    });

    const patientReads = query.mock.calls
      .map(([sql, params]) => ({ sql: String(sql), params }))
      .filter(({ sql }) => /FROM patient/i.test(sql));
    expect(patientReads).toHaveLength(3);
    expect(patientReads[0]?.params).toEqual([PHONE, false]);
    expect(patientReads[1]?.params).toEqual([PHONE, true]);
    expect(patientReads[2]?.params).toEqual([PHONE, true]);
  });
});

// H-05 — opting out can never depend on the agent still being active, so an exact signed
// STOP/START falls back to the retired record for the same phone. Everything else does not.
describe('reserveInboundIntake retired-record consent lookup', () => {
  function retiredPool(retiredRows: unknown[]) {
    return makePool((sql) => {
      if (/is_active\s*=\s*false/i.test(sql)) return result(retiredRows);
      if (/FROM patient/i.test(sql)) return result([]);
      if (/FROM inbound_reply/i.test(sql)) return result();
      if (/next_inbound_sequence/i.test(sql)) return result([{ inbound_sequence: '1' }]);
      if (/INSERT INTO inbound_reply/i.test(sql)) return result([{ id: INBOUND_ID }]);
      return result([], 0);
    });
  }

  it.each(['stop', 'start'] as const)(
    'resolves the single retired record for an exact %s and changes consent only',
    async (control) => {
      const { pool, query } = retiredPool([{ id: PATIENT_ID, timezone: 'America/Toronto' }]);

      await expect(
        reserveInboundIntake(pool, { ...baseInput, createTurnJob: false, control }),
      ).resolves.toMatchObject({
        kind: 'new',
        patientId: PATIENT_ID,
        shouldEnqueue: false,
        shouldSweepSchedules: control === 'stop',
      });

      const statements = query.mock.calls.map(([sql]) => String(sql));
      expect(statements[2]).toMatch(/FROM patient[\s\S]*is_active\s*=\s*false[\s\S]*FOR UPDATE/i);
      expect(statements.some((sql) => /UPDATE patient[\s\S]*is_active/i.test(sql))).toBe(false);
      expect(
        statements.some((sql) => /UPDATE patient[\s\S]*agent_enabled\s*=\s*true/i.test(sql)),
      ).toBe(false);
      expect(statements.some((sql) => /INSERT INTO turn_job/i.test(sql))).toBe(false);
      expect(statements.some((sql) => /usage_bucket/i.test(sql))).toBe(false);
    },
  );

  it.each([
    { label: 'HELP', control: 'help' as const, createTurnJob: false },
    { label: 'ordinary text', control: null, createTurnJob: true },
  ])('never reaches a retired record for $label', async ({ control, createTurnJob }) => {
    const { pool, query } = retiredPool([{ id: PATIENT_ID, timezone: 'America/Toronto' }]);

    await expect(
      reserveInboundIntake(pool, { ...baseInput, createTurnJob, control }),
    ).resolves.toEqual({ kind: 'unmatched', matchCount: 0 });
    expect(query.mock.calls.some(([sql]) => /is_active\s*=\s*false/i.test(String(sql)))).toBe(
      false,
    );
  });

  it('fails closed without writing when one phone maps to two retired records', async () => {
    const { pool, query } = retiredPool([
      { id: PATIENT_ID, timezone: 'America/Toronto' },
      { id: FOREIGN_PATIENT_ID, timezone: 'America/Toronto' },
    ]);

    await expect(
      reserveInboundIntake(pool, { ...baseInput, createTurnJob: false, control: 'stop' }),
    ).resolves.toEqual({ kind: 'unmatched', matchCount: 2 });
    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual([
      'BEGIN',
      expect.stringMatching(/is_active\s*=\s*true/i),
      expect.stringMatching(/is_active\s*=\s*false/i),
      'COMMIT',
    ]);
  });
});

// M-04 — the burst/day gate runs under the patient lock the intake already holds.
describe('reserveInboundIntake intake capacity gate', () => {
  function gatePool(capacity: QueryReply) {
    return makePool((sql) => {
      if (/FROM patient/i.test(sql)) return result([{ id: PATIENT_ID, timezone: 'Asia/Tokyo' }]);
      if (/FROM inbound_reply/i.test(sql)) return result();
      if (/next_inbound_sequence/i.test(sql)) return result([{ inbound_sequence: '5' }]);
      if (/INSERT INTO inbound_reply/i.test(sql)) return result([{ id: INBOUND_ID }]);
      return result([], 0);
    }, capacity);
  }

  it('consumes both locked windows against the patient-local day before the turn job exists', async () => {
    const { pool, query } = gatePool(capacityAvailable());

    await expect(reserveInboundIntake(pool, baseInput)).resolves.toMatchObject({
      shouldEnqueue: true,
      rateLimited: undefined,
    });

    const consume = query.mock.calls.find(([sql]) => /usage_bucket/i.test(String(sql)));
    expect(String(consume?.[0])).toMatch(/patient_burst[\s\S]*patient_day/i);
    expect(String(consume?.[0])).toMatch(/AT TIME ZONE \$4/i);
    // limit_units carries the locked limit plus the single notice slot.
    expect(consume?.[1]).toEqual([PATIENT_ID, '10 minutes', 21, 'Asia/Tokyo', 51]);
  });

  it('consumes capacity for unread media while creating no turn job', async () => {
    const { pool, query } = gatePool(capacityAvailable());

    await expect(
      reserveInboundIntake(pool, { ...baseInput, createTurnJob: false }),
    ).resolves.toMatchObject({
      kind: 'new',
      shouldEnqueue: false,
      rateLimited: undefined,
    });
    expect(query.mock.calls.some(([sql]) => /usage_bucket/i.test(String(sql)))).toBe(true);
    expect(query.mock.calls.some(([sql]) => /INSERT INTO turn_job/i.test(String(sql)))).toBe(false);
  });

  it.each([
    {
      label: 'the burst window',
      rows: [
        { bucket_scope: 'patient_burst', consumed_units: 21, limit_units: 21 },
        { bucket_scope: 'patient_day', consumed_units: 21, limit_units: 51 },
      ],
    },
    {
      label: 'the patient-local day',
      rows: [
        { bucket_scope: 'patient_burst', consumed_units: 4, limit_units: 21 },
        { bucket_scope: 'patient_day', consumed_units: 51, limit_units: 51 },
      ],
    },
  ])('stores the message and asks for one notice when $label just filled', async ({ rows }) => {
    const { pool, query } = gatePool(result(rows));

    await expect(reserveInboundIntake(pool, baseInput)).resolves.toMatchObject({
      kind: 'new',
      inboundMessageId: INBOUND_ID,
      shouldEnqueue: false,
      rateLimited: 'notice',
    });
    expect(query.mock.calls.some(([sql]) => /INSERT INTO inbound_reply/i.test(String(sql)))).toBe(
      true,
    );
    expect(query.mock.calls.some(([sql]) => /INSERT INTO turn_job/i.test(String(sql)))).toBe(false);
    expect(query.mock.calls.map(([sql]) => String(sql))).toContain('COMMIT');
  });

  it.each([
    { label: 'both windows are spent', rows: [] },
    {
      label: 'only the untouched window still moves',
      rows: [{ bucket_scope: 'patient_day', consumed_units: 30, limit_units: 51 }],
    },
  ])('stores the message silently once the notice slot is taken and $label', async ({ rows }) => {
    const { pool, query } = gatePool(result(rows));

    await expect(reserveInboundIntake(pool, baseInput)).resolves.toMatchObject({
      kind: 'new',
      shouldEnqueue: false,
      rateLimited: 'silent',
    });
    expect(query.mock.calls.some(([sql]) => /INSERT INTO turn_job/i.test(String(sql)))).toBe(false);
  });

  it.each(['stop', 'help'] as const)('leaves %s exempt from capacity entirely', async (control) => {
    const { pool, query } = gatePool(result([]));

    await expect(
      reserveInboundIntake(pool, { ...baseInput, createTurnJob: false, control }),
    ).resolves.toMatchObject({ kind: 'new', shouldEnqueue: false, rateLimited: undefined });
    expect(query.mock.calls.some(([sql]) => /usage_bucket/i.test(String(sql)))).toBe(false);
  });
});

describe('markInboundEnqueued', () => {
  it('idempotently stamps only after the caller confirms the SQS send', async () => {
    const { pool } = makePool((sql) => {
      if (/UPDATE inbound_reply/i.test(sql)) return result([{ enqueued_at: new Date() }]);
      return result([], 0);
    });

    await expect(markInboundEnqueued(pool, INBOUND_ID)).resolves.toBeUndefined();
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/SET enqueued_at\s*=\s*COALESCE\(enqueued_at,\s*now\(\)\)/i),
      [INBOUND_ID],
    );
  });

  it('fails when the stored inbound row disappeared before the stamp', async () => {
    const { pool } = makePool(() => result());
    await expect(markInboundEnqueued(pool, INBOUND_ID)).rejects.toThrow(/inbound row missing/i);
  });
});
