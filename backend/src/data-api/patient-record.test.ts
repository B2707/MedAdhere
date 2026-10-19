import { describe, expect, it, vi } from 'vitest';
import {
  ALERT_QUEUE_SQL,
  DRAFT_QUEUE_SQL,
  PATIENT_ALERTS_SQL,
  PATIENT_DAY_INDEX_SQL,
  PATIENT_DAY_SUMMARY_SQL,
  PATIENT_EVENTS_SQL,
  PATIENT_EVENT_EVIDENCE_SQL,
  PATIENT_MESSAGES_SQL,
  PATIENT_RECORD_LIMITS,
  PATIENT_RECORD_VERSIONS_SQL,
  PATIENT_REVIEW_DRAFTS_SQL,
  PATIENT_RECORD_SCOPE_SQL,
  PATIENT_SEVERITY_TRENDS_SQL,
  PATIENT_ADHERENCE_TRENDS_SQL,
  loadAlertQueue,
  loadDraftQueue,
  parsePatientRecordQuery,
  parseReviewQueueQuery,
} from './patient-record.js';
import {
  PATIENT_RECORD_MAX_RESPONSE_BYTES,
  handlePatientReadRoute,
} from './patient-record-route.js';

const CLINICIAN_SUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('08-06 patient-record request contract', () => {
  it('defaults safely and accepts only supported windows, real local dates, and bounded page sizes', () => {
    expect(parsePatientRecordQuery(undefined)).toEqual({
      days: 30,
      selectedDay: null,
      alerts: { cursor: null, limit: 100 },
      drafts: { cursor: null, limit: 3 },
    });
    expect(
      parsePatientRecordQuery({
        days: '90',
        day: '2026-08-12',
        alertsLimit: '25',
        draftsLimit: '3',
      }),
    ).toEqual({
      days: 90,
      selectedDay: '2026-08-12',
      alerts: { cursor: null, limit: 25 },
      drafts: { cursor: null, limit: 3 },
    });

    for (const query of [
      { days: '31' },
      { day: '2026-02-30' },
      { alertsLimit: '0' },
      { draftsLimit: '11' },
      { alertsCursor: 'not-base64url!' },
    ]) {
      expect(() => parsePatientRecordQuery(query)).toThrow();
    }
  });

  it('parses the dedicated queue cursor and limit independently', () => {
    expect(parseReviewQueueQuery(undefined)).toEqual({ cursor: null, limit: 100 });
    expect(parseReviewQueueQuery({ limit: '1' })).toEqual({ cursor: null, limit: 1 });
    expect(() => parseReviewQueueQuery({ limit: '101' })).toThrow();
  });
});

describe('08-06 bounded owner-scoped SQL contract', () => {
  it('pins every collection to its declared bound and selected-day/window responsibility', () => {
    expect(PATIENT_RECORD_LIMITS).toEqual({
      timeline: 100,
      timelineLabelMatches: 5,
      timelineLabelText: 128,
      dayIndex: 90,
      messages: 50,
      events: 50,
      evidence: 25,
      versions: 100,
      alerts: 25,
      alertRequest: 100,
      drafts: 3,
      draftRequest: 10,
      trendPoints: 90,
      historyMedications: 100,
      historyFacts: 200,
      historyIngredients: 4,
      historyIngredientName: 128,
      historyFactText: 500,
      reviewQueue: 100,
    });

    for (const sql of [
      PATIENT_RECORD_SCOPE_SQL,
      PATIENT_DAY_INDEX_SQL,
      PATIENT_DAY_SUMMARY_SQL,
      PATIENT_MESSAGES_SQL,
      PATIENT_EVENTS_SQL,
      PATIENT_EVENT_EVIDENCE_SQL,
      PATIENT_RECORD_VERSIONS_SQL,
      PATIENT_ALERTS_SQL,
      PATIENT_REVIEW_DRAFTS_SQL,
      PATIENT_SEVERITY_TRENDS_SQL,
      PATIENT_ADHERENCE_TRENDS_SQL,
    ]) {
      expect(sql).toContain('owner_clinician_sub = $2');
    }
    for (const sql of [
      PATIENT_DAY_SUMMARY_SQL,
      PATIENT_MESSAGES_SQL,
      PATIENT_EVENTS_SQL,
      PATIENT_EVENT_EVIDENCE_SQL,
      PATIENT_RECORD_VERSIONS_SQL,
    ]) {
      expect(sql).toContain('selected_day');
    }
    for (const sql of [ALERT_QUEUE_SQL, DRAFT_QUEUE_SQL]) {
      expect(sql).toContain('owner_clinician_sub = $1');
    }
    expect(ALERT_QUEUE_SQL).toMatch(/LIMIT \$5::int/);
    expect(DRAFT_QUEUE_SQL).toMatch(/LIMIT \$5::int/);
  });

  it('uses the canonical same-patient current-leaf predicate everywhere except audit history', () => {
    const currentLeaf =
      /NOT EXISTS \(\s*SELECT 1\s+FROM clinical_event replacement\s+WHERE replacement\.patient_id = ce\.patient_id\s+AND replacement\.supersedes_id = ce\.id\s*\)/;

    for (const sql of [
      PATIENT_DAY_INDEX_SQL,
      PATIENT_EVENTS_SQL,
      PATIENT_EVENT_EVIDENCE_SQL,
      PATIENT_ALERTS_SQL,
      PATIENT_SEVERITY_TRENDS_SQL,
      ALERT_QUEUE_SQL,
    ]) {
      expect(sql).toMatch(currentLeaf);
    }
    // PATIENT_ADHERENCE_TRENDS_SQL (Wave-3 rewrite) reads the already-computed adherence_record
    // outcome, not clinical_event — there is no supersession chain to filter on that table.
    expect(PATIENT_RECORD_VERSIONS_SQL).not.toMatch(currentLeaf);
    expect(PATIENT_ADHERENCE_TRENDS_SQL).not.toMatch(currentLeaf);
  });

  it('exposes provider send evidence on message rows (sent_at NULL marks a never-sent row)', () => {
    // The clinician panel badges outbound rows that never reached the provider; both UNION arms
    // must carry the column so the shape stays aligned (inbound rows are always NULL).
    expect(PATIENT_MESSAGES_SQL).toMatch(/om\.sent_at/);
    expect(PATIENT_MESSAGES_SQL).toMatch(/NULL::timestamptz AS sent_at/);
  });

  it('groups severity by stable normalized symptom identity read from clinical_values, not the dead columns', () => {
    expect(PATIENT_SEVERITY_TRENDS_SQL).toContain('clinical_values');
    expect(PATIENT_SEVERITY_TRENDS_SQL).toContain('symptom');
    expect(PATIENT_SEVERITY_TRENDS_SQL).not.toMatch(/ce\.normalized_value/);
    expect(PATIENT_SEVERITY_TRENDS_SQL).not.toMatch(/ce\.severity\b/);
    expect(PATIENT_SEVERITY_TRENDS_SQL).not.toMatch(/GROUP BY ce\.local_date, ce\.event_code/);
  });

  it('reads adherence trends from the durable adherence_record outcome, not clinical_event', () => {
    expect(PATIENT_ADHERENCE_TRENDS_SQL).toContain('adherence_record');
    expect(PATIENT_ADHERENCE_TRENDS_SQL).toContain('dose_schedule');
    expect(PATIENT_ADHERENCE_TRENDS_SQL).not.toContain('clinical_event');
    expect(PATIENT_ADHERENCE_TRENDS_SQL).toContain("decided_by = 'classifier'");
  });

  it('returns an opaque next cursor without leaking its internal sort columns', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          event_code: 'important',
          occurred_at: new Date('2026-08-12T12:00:00.000Z'),
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          event_code: 'fallback',
          occurred_at: new Date('2026-08-12T11:00:00.000Z'),
        },
      ],
    });

    const db = { query };
    const page = await loadAlertQueue(db, CLINICIAN_SUB, { cursor: null, limit: 1 });
    expect(page).toMatchObject({ cursor: null, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(page.items[0]).not.toHaveProperty('_sort_rank');

    const second = parseReviewQueueQuery({ cursor: page.nextCursor!, limit: '1' });
    await loadAlertQueue(db, CLINICIAN_SUB, second);
    expect(query.mock.calls[1]?.[1]).toEqual([
      CLINICIAN_SUB,
      1,
      '2026-08-12T12:00:00.000Z',
      '22222222-2222-4222-8222-222222222222',
      2,
    ]);
  });

  it('keeps draft cursors immutable and the queue pending-only', async () => {
    expect(DRAFT_QUEUE_SQL).not.toContain('has_action::int');
    expect(DRAFT_QUEUE_SQL).not.toContain('ORDER BY has_action');
    expect(DRAFT_QUEUE_SQL).toContain(
      'NOT EXISTS (\n          SELECT 1 FROM clinician_review_action',
    );
    expect(PATIENT_REVIEW_DRAFTS_SQL).not.toContain('sort_rank');

    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          created_at: new Date('2026-08-12T12:00:00.000Z'),
          has_action: false,
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          created_at: new Date('2026-08-12T11:00:00.000Z'),
          has_action: false,
        },
      ],
    });

    const first = await loadDraftQueue({ query }, CLINICIAN_SUB, { cursor: null, limit: 1 });
    expect(JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'))).toEqual({
      createdAt: '2026-08-12T12:00:00.000Z',
      id: '22222222-2222-4222-8222-222222222222',
    });

    await loadDraftQueue({ query }, CLINICIAN_SUB, {
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(query.mock.calls[1]?.[1]).toEqual([
      CLINICIAN_SUB,
      '2026-08-12T12:00:00.000Z',
      '22222222-2222-4222-8222-222222222222',
      null,
      2,
    ]);
  });
});

describe('08-06 patient-record snapshot route', () => {
  const PATIENT_ID = '11111111-1111-4111-8111-111111111111';
  const TODAY = '2026-08-12';

  function routeDependencies(query: ReturnType<typeof vi.fn>, release: ReturnType<typeof vi.fn>) {
    const client = { query, release };
    const runQuery = query as unknown as (
      sql: string,
      params?: readonly unknown[],
    ) => Promise<unknown>;
    const poolQuery = vi.fn((sql: string, params?: readonly unknown[]) => runQuery(sql, params));
    return {
      dependencies: {
        getPool: async () => ({ connect: async () => client, query: poolQuery }),
        patientDetailSql: 'DETAIL',
        patientTimelineSql: 'TIMELINE',
        listPatientsSql: 'LIST',
        alertThreshold: () => 3,
        responseWindowMinutes: () => 120,
        timelineWindowDays: () => 30,
        logMetric: vi.fn(),
      },
      poolQuery,
    };
  }

  function successfulQuery() {
    return vi.fn(async (sql: string) => {
      if (sql === 'LIST') {
        return { rows: [{ consecutive_missed: 0, is_active: true, opted_out_at: null }] };
      }
      if (sql === 'TIMELINE') return { rows: [] };
      if (sql.includes('selected_day_in_window')) {
        return {
          rows: [
            {
              id: PATIENT_ID,
              display_name: 'Test Patient',
              phone: '+15005550006',
              medication_name: 'metformin',
              timezone: 'America/Toronto',
              is_test: true,
              is_active: true,
              opted_out_at: null,
              created_at: new Date('2026-08-12T12:00:00.000Z'),
              drug_profile_fetched_at: null,
              preferred_language: 'en',
              reminder_limit: 2,
              agent_enabled: true,
              provider_opted_in: true,
              messaging_state_version: 1,
              from_date: '2026-08-06',
              today: TODAY,
              selected_day: TODAY,
              selected_day_in_window: true,
            },
          ],
        };
      }
      if (sql === 'SELECT 1 FROM patient WHERE id = $1 AND owner_clinician_sub = $2') {
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  }

  function timelineQuery(timelineRows: Array<Record<string, unknown>>) {
    const query = successfulQuery() as unknown as (
      sql: string,
      params?: readonly unknown[],
    ) => Promise<unknown>;
    return vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql === 'TIMELINE') return { rows: timelineRows };
      return query(sql, params);
    });
  }

  it('assembles the complete record on one checked-out repeatable-read read-only client', async () => {
    const query = successfulQuery();
    const release = vi.fn();
    const { dependencies, poolQuery } = routeDependencies(query, release);

    const result = await handlePatientReadRoute(
      {
        routeKey: 'GET /api/patients/{id}/record',
        pathParameters: { id: PATIENT_ID },
        queryStringParameters: { day: TODAY },
      },
      CLINICIAN_SUB,
      dependencies as never,
    );

    expect(result?.statusCode).toBe(200);
    expect(query.mock.calls[0]?.[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(query.mock.calls.some(([sql]) => sql === 'LIST')).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql === 'TIMELINE')).toBe(true);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back and releases the checked-out client when any record read fails', async () => {
    const failure = new Error('read failed');
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('BEGIN')) return { rows: [] };
      if (sql === 'ROLLBACK') return { rows: [] };
      throw failure;
    });
    const release = vi.fn();
    const { dependencies } = routeDependencies(query, release);

    await expect(
      handlePatientReadRoute(
        {
          routeKey: 'GET /api/patients/{id}/record',
          pathParameters: { id: PATIENT_ID },
        },
        CLINICIAN_SUB,
        dependencies as never,
      ),
    ).rejects.toBe(failure);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      expect.stringContaining('selected_day_in_window'),
      'ROLLBACK',
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it('bounds timeline labels and strings before returning the record envelope', async () => {
    const oversized = 'x'.repeat(PATIENT_RECORD_LIMITS.timelineLabelText + 10);
    const labels = Array.from({ length: PATIENT_RECORD_LIMITS.timelineLabelMatches + 1 }, () => ({
      id: PATIENT_ID,
      matched_phrase: oversized,
      meddra_pt: oversized,
      hint_level: 'info',
    }));
    const query = timelineQuery([
      { dose_id: PATIENT_ID, label_matches: labels },
      { dose_id: CLINICIAN_SUB, label_matches: null },
    ]);
    const release = vi.fn();
    const { dependencies } = routeDependencies(query, release);

    const result = await handlePatientReadRoute(
      { routeKey: 'GET /api/patients/{id}/record', pathParameters: { id: PATIENT_ID } },
      CLINICIAN_SUB,
      dependencies as never,
    );

    const timeline = result?.body.timeline as Array<Record<string, unknown>>;
    expect(timeline[0]?.label_matches).toHaveLength(PATIENT_RECORD_LIMITS.timelineLabelMatches);
    expect(timeline[0]?.label_matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          matched_phrase: 'x'.repeat(PATIENT_RECORD_LIMITS.timelineLabelText),
          meddra_pt: 'x'.repeat(PATIENT_RECORD_LIMITS.timelineLabelText),
        }),
      ]),
    );
    expect(timeline[1]?.label_matches).toEqual([]);
  });

  it('retains a small 500 only as defense in depth for an impossible oversized envelope', async () => {
    const hugeHistoryRow = {
      id: PATIENT_ID,
      entered_name: 'x'.repeat(PATIENT_RECORD_MAX_RESPONSE_BYTES + 1),
      identity_system: null,
      identity_code: null,
      dose_text: null,
      form: null,
      route: null,
      valid_from: TODAY,
      valid_to: null,
      status: 'active',
      supersedes_id: null,
      ingredients: [],
    };
    const baseQuery = successfulQuery() as unknown as (
      sql: string,
      params?: readonly unknown[],
    ) => Promise<unknown>;
    const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.startsWith("SELECT 'medication'::text AS kind")) {
        return { rows: [hugeHistoryRow], rowCount: 1 };
      }
      return baseQuery(sql, params);
    });
    const release = vi.fn();
    const { dependencies } = routeDependencies(query, release);

    const result = await handlePatientReadRoute(
      { routeKey: 'GET /api/patients/{id}/record', pathParameters: { id: PATIENT_ID } },
      CLINICIAN_SUB,
      dependencies as never,
    );

    expect(result).toEqual({
      statusCode: 500,
      body: { error: 'patient record response exceeds safe size' },
    });
    expect(dependencies.logMetric).toHaveBeenCalledWith({
      metric: 'data_api_patient_record_response_too_large',
    });
  });
});
