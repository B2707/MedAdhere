import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  PATIENT_RECORD_LIMITS,
  PatientRecordDayOutsideWindowError,
  loadAlertQueue,
  loadDraftQueue,
  loadPatientRecord,
  parsePatientRecordQuery,
  parseReviewQueueQuery,
} from './patient-record';

interface ReadEvent {
  routeKey?: string;
  pathParameters?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
}

export interface ReadRouteResult {
  statusCode: number;
  body: Record<string, unknown>;
}

interface ReadRouteDependencies {
  getPool: () => Promise<Pool>;
  patientDetailSql: string;
  patientTimelineSql: string;
  listPatientsSql: string;
  alertThreshold: () => number;
  responseWindowMinutes: () => number;
  timelineWindowDays: () => number;
  logMetric: (entry: Record<string, unknown>) => void;
}

// Lambda's synchronous response payload limit is 6 MiB. Keep one full MiB of serialization and
// gateway headroom, and fail with a small envelope if the assembled contract ever exceeds it.
export const PATIENT_RECORD_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const patientIdSchema = z.string().uuid();

export function patientAlertState(row: Record<string, unknown>, threshold: number) {
  const consecutiveMissed = typeof row.consecutive_missed === 'number' ? row.consecutive_missed : 0;
  // The SEPARATE reported-miss streak (classifier 'skipped', status='recorded') — never mixed with
  // the silence streak above; both share the D5 is_active/opt-out suppression and threshold.
  const consecutiveReportedMisses =
    typeof row.consecutive_reported_misses === 'number' ? row.consecutive_reported_misses : 0;
  const isAlertEligible = row.is_active === true && row.opted_out_at === null;
  return {
    consecutive_missed: consecutiveMissed,
    alerting: isAlertEligible && consecutiveMissed >= threshold,
    consecutive_reported_misses: consecutiveReportedMisses,
    reported_miss_alerting: isAlertEligible && consecutiveReportedMisses >= threshold,
  };
}

async function patientDetail(
  db: Pool,
  patientId: string,
  clinicianSub: string,
  dependencies: ReadRouteDependencies,
): Promise<ReadRouteResult> {
  const detail = await db.query(dependencies.patientDetailSql, [patientId, clinicianSub]);
  if (detail.rows.length === 0) {
    dependencies.logMetric({ metric: 'data_api_patient_not_found' });
    return { statusCode: 404, body: { error: 'patient not found' } };
  }
  const responseWindow = dependencies.responseWindowMinutes();
  const timelineWindow = dependencies.timelineWindowDays();
  const [alertRows, timeline] = await Promise.all([
    db.query(dependencies.listPatientsSql, [patientId, responseWindow, clinicianSub]),
    db.query(dependencies.patientTimelineSql, [
      patientId,
      timelineWindow,
      clinicianSub,
      PATIENT_RECORD_LIMITS.timeline,
    ]),
  ]);
  const alertRow = alertRows.rows[0];
  if (!alertRow) {
    dependencies.logMetric({ metric: 'data_api_patient_not_found' });
    return { statusCode: 404, body: { error: 'patient not found' } };
  }
  const threshold = dependencies.alertThreshold();
  return {
    statusCode: 200,
    body: {
      patient: { ...detail.rows[0], ...patientAlertState(alertRow, threshold) },
      timeline: timeline.rows,
      alertThreshold: threshold,
      timelineWindowDays: timelineWindow,
    },
  };
}

async function patientRecord(
  db: Pick<PoolClient, 'query'>,
  patientId: string,
  clinicianSub: string,
  query: ReturnType<typeof parsePatientRecordQuery>,
  dependencies: ReadRouteDependencies,
): Promise<ReadRouteResult> {
  let record;
  try {
    record = await loadPatientRecord(db, patientId, clinicianSub, query);
  } catch (error) {
    if (!(error instanceof PatientRecordDayOutsideWindowError)) throw error;
    dependencies.logMetric({ metric: 'data_api_bad_request', routeKey: 'record' });
    return { statusCode: 400, body: { error: 'selected day is outside the requested window' } };
  }
  if (record === null) {
    dependencies.logMetric({ metric: 'data_api_patient_not_found' });
    return { statusCode: 404, body: { error: 'patient not found' } };
  }
  const alertRows = await db.query(dependencies.listPatientsSql, [
    patientId,
    dependencies.responseWindowMinutes(),
    clinicianSub,
  ]);
  const timeline = await db.query(dependencies.patientTimelineSql, [
    patientId,
    query.days,
    clinicianSub,
    PATIENT_RECORD_LIMITS.timeline,
  ]);
  const alertRow = alertRows.rows[0];
  if (!alertRow) return { statusCode: 404, body: { error: 'patient not found' } };
  const threshold = dependencies.alertThreshold();
  const boundedTimeline = timeline.rows.map((row: Record<string, unknown>) => ({
    ...row,
    label_matches: Array.isArray(row.label_matches)
      ? row.label_matches
          .slice(0, PATIENT_RECORD_LIMITS.timelineLabelMatches)
          .map((labelMatch: unknown) => {
            if (typeof labelMatch !== 'object' || labelMatch === null) return labelMatch;
            const match = labelMatch as Record<string, unknown>;
            return {
              ...match,
              matched_phrase:
                typeof match.matched_phrase === 'string'
                  ? match.matched_phrase.slice(0, PATIENT_RECORD_LIMITS.timelineLabelText)
                  : match.matched_phrase,
              meddra_pt:
                typeof match.meddra_pt === 'string'
                  ? match.meddra_pt.slice(0, PATIENT_RECORD_LIMITS.timelineLabelText)
                  : match.meddra_pt,
            };
          })
      : [],
  }));
  const body = {
    patient: { ...record.patient, ...patientAlertState(alertRow, threshold) },
    timeline: boundedTimeline,
    alertThreshold: threshold,
    timelineWindowDays: query.days,
    window: { days: query.days, selectedDay: record.selectedDay },
    dayIndex: record.dayIndex,
    daySummary: record.daySummary,
    messages: record.messages,
    events: record.events,
    evidence: record.evidence,
    versions: record.versions,
    alertsPage: record.alertsPage,
    draftsPage: record.draftsPage,
    history: record.history,
    trends: record.trends,
  };
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > PATIENT_RECORD_MAX_RESPONSE_BYTES) {
    dependencies.logMetric({ metric: 'data_api_patient_record_response_too_large' });
    return { statusCode: 500, body: { error: 'patient record response exceeds safe size' } };
  }
  return { statusCode: 200, body };
}

async function patientRecordSnapshot(
  db: Pool,
  patientId: string,
  clinicianSub: string,
  query: ReturnType<typeof parsePatientRecordQuery>,
  dependencies: ReadRouteDependencies,
): Promise<ReadRouteResult> {
  // Handler unit doubles predating this route expose only query(). Production always supplies pg.Pool,
  // whose connect() path below owns the root-contract snapshot and lifecycle.
  if (typeof db.connect !== 'function') {
    return patientRecord(db, patientId, clinicianSub, query, dependencies);
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const result = await patientRecord(client, patientId, clinicianSub, query, dependencies);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

export async function handlePatientReadRoute(
  event: ReadEvent,
  clinicianSub: string,
  dependencies: ReadRouteDependencies,
): Promise<ReadRouteResult | null> {
  const routeKey = event.routeKey;
  if (routeKey === 'GET /api/patients/{id}' || routeKey === 'GET /api/patients/{id}/record') {
    let patientId: string;
    try {
      patientId = patientIdSchema.parse(event.pathParameters?.id);
    } catch {
      dependencies.logMetric({ metric: 'data_api_bad_request', routeKey });
      return { statusCode: 400, body: { error: 'invalid patient id' } };
    }
    if (routeKey === 'GET /api/patients/{id}') {
      return patientDetail(await dependencies.getPool(), patientId, clinicianSub, dependencies);
    }
    let query;
    try {
      query = parsePatientRecordQuery(event.queryStringParameters);
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      dependencies.logMetric({ metric: 'data_api_bad_request', routeKey });
      return { statusCode: 400, body: { error: 'invalid record query' } };
    }
    return patientRecordSnapshot(
      await dependencies.getPool(),
      patientId,
      clinicianSub,
      query,
      dependencies,
    );
  }

  if (routeKey !== 'GET /api/reviews/alerts' && routeKey !== 'GET /api/reviews/drafts') return null;
  let query;
  try {
    query = parseReviewQueueQuery(
      event.queryStringParameters,
      routeKey === 'GET /api/reviews/alerts' ? 'alerts' : 'drafts',
    );
  } catch {
    dependencies.logMetric({ metric: 'data_api_bad_request', routeKey });
    return { statusCode: 400, body: { error: 'invalid review queue query' } };
  }
  const db = await dependencies.getPool();
  return routeKey === 'GET /api/reviews/alerts'
    ? { statusCode: 200, body: { alertsPage: await loadAlertQueue(db, clinicianSub, query) } }
    : { statusCode: 200, body: { draftsPage: await loadDraftQueue(db, clinicianSub, query) } };
}
