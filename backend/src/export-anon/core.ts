// backend/src/export-anon/core.ts
//
// DASH-06 `export-anon` — the PURE, DI core of the anonymized adherence export (D6/D7/D14).
//
// The core touches NO AWS, NO pg driver, NO filesystem: it takes an INJECTED query client and an
// INJECTED S3 putter (exactly as freeze-drug-profiles.ts injects its QueryClient), so the offline unit
// test drives it at $0 and the Lambda / operator-script entrypoints supply the real seams. This mirrors
// the freeze DI seam (U-34) so the shared core never inherits the Lambda's fixed PEM/S3 wiring.
//
// D7 — EXPLICIT COLUMN ALLOWLIST (U-14): the artifact carries EXACTLY `ALLOWLIST_COLUMNS` and nothing
// else. `toCsv` PROJECTS every row strictly onto the allowlist, so a careless SELECT that carried an
// extra PII column could still never leak it. The excluded-by-construction set — phone, display_name,
// raw_body, auto_reply_error, matched_phrase, meddra_pt, Twilio SIDs, drug_profile_json,
// medication_name, timezone, and every ABSOLUTE timestamp — is never named. True anonymization is
// unattainable for a known ≤5 cohort, so the honest label is PSEUDONYMIZED (D7 dated reconciliation /
// U-29): a stable `patient_<n>` pseudonym + a study-day offset + local_dose_time + weekday preserve
// every descriptive statistic the absolute timestamps served, without the re-identifying instants.
//
// D14 — is_test POLARITY (the P7 validation cohort IS is_test=true; there are never real patients): the
// export INCLUDES the cohort by DEFAULT (excludeTest=false → the SQL predicate passes all rows), emits
// `is_test` as a tag column, and a 0-row result is a LOUD FAILURE (EmptyExportError) — never a silent
// empty CSV. `--exclude-test` is the INVERTED flag for the rare dev-noise run.
//
// Reporting canon (M13): the export is ROW-LEVEL with NO computed adherence summary — it carries
// `decided_by` + `dose_status` (timeout `missed` rows are a response-rate bucket, never relabeled as
// confirmed non-adherence) and lets the analysis compute rates downstream.

/**
 * The D7 column ALLOWLIST — the SINGLE SOURCE OF TRUTH for the emitted artifact. The SELECT aliases and
 * the CSV header are both derived from this list, and the set-equality test asserts the emitted columns
 * are EXACTLY this set (U-14). Order here is the column order in the CSV.
 *
 *   patient_pseudonym         stable `patient_<n>` (enrollment-ordered; renumbers after a wipe — D14/L13)
 *   is_test                   the D14 cohort tag (emitted, NEVER filtered on by default)
 *   adherence_state           classifier two-axis label (taken/delayed/skipped/stopped/question/unknown)
 *   reason_code               classifier reason (none/side_effect/ran_out/forgot/other)
 *   safety_flag               4-value safety enum (none/acute_physical/crisis/medical_question)
 *   decided_by                classifier | timeout (M13 — timeout rows are a response-rate bucket)
 *   dose_status               adherence_record.status outcome lifecycle: recorded | missed (F37)
 *   is_late                   inbound_reply.is_late (PIPE-06); NULL for a timeout/no-reply row
 *   is_unattributed           adherence_record.dose_id IS NULL (the PIPE-10 collision-path outcome)
 *   study_day                 dose_date − MIN(dose_date) offset in days (0-indexed; U-29 coarsening)
 *   local_dose_time           dose_schedule.local_dose_time (e.g. '09:00' — dose-slot analysis)
 *   dose_weekday              ISO weekday of dose_date (1=Mon … 7=Sun); NULL when dose_date is NULL
 *   outbound_status           outbound_message.status (queued…delivered/undelivered/failed)
 *   response_latency_seconds  reply_received − prompt_sent, seconds; NULL for timeout rows (U-25)
 */
export const ALLOWLIST_COLUMNS = [
  'patient_pseudonym',
  'is_test',
  'adherence_state',
  'reason_code',
  'safety_flag',
  'decided_by',
  'dose_status',
  'is_late',
  'is_unattributed',
  'study_day',
  'local_dose_time',
  'dose_weekday',
  'outbound_status',
  'response_latency_seconds',
] as const;

/** A single emitted column name (the CSV header + the pg row key must be one of these). */
export type ExportColumn = (typeof ALLOWLIST_COLUMNS)[number];

/**
 * The exported anonymized SELECT — the SSOT the real-PG write-contract test drives (no drift between the
 * handler's SQL and the semantic proof, exactly like DEACTIVATE_PATIENT_SQL / FREEZE_UPDATE_SQL).
 *
 * ANCHOR (U-25): one row per `adherence_record` (the write target — both classifier and timeout outcomes
 * live here). LEFT JOIN `inbound_reply` on `ar.inbound_message_id` — the SPECIFIC outcome reply (UNIQUE),
 * NOT on dose_id, so a dose with multiple replies never fans out and the emitted latency is the outcome
 * reply's. LEFT JOIN `dose_schedule` + `outbound_message` via `dose_id` (both UNIQUE on dose_id — no
 * fan-out); unattributed rows (dose_id NULL) keep NULL dose/outbound context.
 *
 * D14 predicate: `$1` is `excludeTest`. `NOT $1` → include every row (the default — the cohort IS
 * is_test=true); `$1=true` → only non-test rows (the dev-noise run). Window functions run AFTER the
 * WHERE, so the pseudonym numbering + the study-day origin are computed over the EXPORTED population.
 *
 * Absolute timestamps are coarsened at the SQL boundary (U-29): `study_day` = dose_date − MIN(dose_date),
 * `dose_weekday` = ISO weekday, `response_latency_seconds` = a duration. No absolute instant is selected.
 */
export const EXPORT_ANON_SQL = `SELECT
  'patient_' || DENSE_RANK() OVER (ORDER BY p.created_at, p.id)   AS patient_pseudonym,
  p.is_test                                                       AS is_test,
  ar.adherence_state                                             AS adherence_state,
  ar.reason_code                                                 AS reason_code,
  ar.safety_flag                                                 AS safety_flag,
  ar.decided_by                                                  AS decided_by,
  ar.status                                                      AS dose_status,
  ir.is_late                                                     AS is_late,
  (ar.dose_id IS NULL)                                           AS is_unattributed,
  (ds.dose_date - MIN(ds.dose_date) OVER ())::int                AS study_day,
  ds.local_dose_time                                             AS local_dose_time,
  EXTRACT(ISODOW FROM ds.dose_date)::int                         AS dose_weekday,
  om.status                                                      AS outbound_status,
  CASE
    WHEN ar.decided_by = 'timeout' THEN NULL
    ELSE EXTRACT(EPOCH FROM (ir.received_at - om.sent_at))::int
  END                                                            AS response_latency_seconds
FROM adherence_record ar
JOIN patient p             ON p.id = ar.patient_id
LEFT JOIN inbound_reply ir  ON ir.id = ar.inbound_message_id
LEFT JOIN dose_schedule ds  ON ds.id = ar.dose_id
LEFT JOIN outbound_message om ON om.dose_id = ar.dose_id
WHERE (NOT $1::boolean OR p.is_test = false)
ORDER BY p.created_at, p.id, ds.dose_date NULLS LAST, ds.local_dose_time, ar.created_at, ar.id`;

/** The minimal pg-style query seam the core depends on (so tests inject a fake — mirrors freeze). */
export interface QueryClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** The injected sink for the finished CSV (a real S3 PutObject in the Lambda; a file/S3 in the script). */
export interface ExportPutter {
  /** Persist the CSV; return where it went (an s3:// URI or a file path) for the id-only completion log. */
  put(csv: string): Promise<{ destination: string }>;
}

/** D14 — `excludeTest` is the INVERTED flag; default false INCLUDES the is_test cohort. */
export interface ExportAnonOptions {
  readonly excludeTest: boolean;
}

/** Injectable deps for a whole run — every I/O seam, so the offline unit test drives it at $0. */
export interface ExportAnonDeps {
  readonly client: QueryClient;
  readonly putter: ExportPutter;
  readonly options: ExportAnonOptions;
  /** PII-safe structured metric sink (ids/counts ONLY). Defaults to console.log(JSON). */
  readonly logMetric?: (entry: Record<string, unknown>) => void;
}

/** The structured result of a run (row count + where the artifact landed + the emitted columns). */
export interface ExportAnonResult {
  readonly rowCount: number;
  readonly destination: string;
  readonly columns: readonly string[];
  readonly csv: string;
}

/**
 * D14 — a 0-row export is a LOUD FAILURE, never a silent empty CSV. Thrown BEFORE the putter is ever
 * called (nothing is written). The Lambda lets it propagate (a visible invocation error in CloudWatch);
 * the operator script catches it and exits non-zero with this message.
 */
export class EmptyExportError extends Error {
  constructor(excludeTest: boolean) {
    super(
      `export-anon produced 0 rows (excludeTest=${excludeTest}). The P7 validation cohort is ` +
        'is_test=true (D14), so a 0-row export is a LOUD FAILURE — never a silent empty CSV. Verify ' +
        'the cohort is enrolled' +
        (excludeTest
          ? ' and that non-test rows exist (this run passed --exclude-test).'
          : '.'),
    );
    this.name = 'EmptyExportError';
  }
}

/** Format one field per RFC-4180: quote+escape on comma/quote/CR/LF; bool→true|false; null/undefined→''. */
function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
  return /["\r\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialize rows to an RFC-4180 CSV, PROJECTING each row strictly onto `columns` (default the D7
 * allowlist). Reading ONLY the allowlist keys is the load-bearing anonymization guarantee — a row that
 * carries an extra PII field (a careless SELECT) can never leak it into the artifact. Header row first;
 * CRLF record separators; a trailing CRLF after the last record.
 */
export function toCsv(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: readonly string[] = ALLOWLIST_COLUMNS,
): string {
  const header = columns.map(escapeCsvField).join(',');
  const records = rows.map((row) => columns.map((col) => escapeCsvField(row[col])).join(','));
  return [header, ...records].join('\r\n') + '\r\n';
}

/**
 * Run the whole anonymized export behind the injected seams. Query (D14 param), guard 0-row LOUDLY,
 * project → RFC-4180 CSV, hand it to the putter, and emit an id-only completion metric.
 */
export async function runExportAnon(deps: ExportAnonDeps): Promise<ExportAnonResult> {
  const { client, putter, options } = deps;
  const logMetric = deps.logMetric ?? ((entry) => console.log(JSON.stringify(entry)));

  // D14 — `excludeTest` drives the predicate; false (default) INCLUDES the is_test cohort.
  const { rows } = await client.query(EXPORT_ANON_SQL, [options.excludeTest]);

  if (rows.length === 0) {
    // Loud fail BEFORE any write (never a silent empty CSV). id-only metric, then throw.
    logMetric({ metric: 'export_anon_empty', rowCount: 0, excludeTest: options.excludeTest });
    throw new EmptyExportError(options.excludeTest);
  }

  const csv = toCsv(rows as Array<Record<string, unknown>>);
  const { destination } = await putter.put(csv);

  // id-only completion metric (counts + flags + the destination key — NEVER phone/body/row values).
  logMetric({
    metric: 'export_anon_completed',
    rowCount: rows.length,
    columnCount: ALLOWLIST_COLUMNS.length,
    excludeTest: options.excludeTest,
    destination,
  });

  return { rowCount: rows.length, destination, columns: ALLOWLIST_COLUMNS, csv };
}
