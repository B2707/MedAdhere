// scripts/reconcile-patient-owners.ts
//
// Reconcile ownerless rows restored from the Phase-7 snapshot before enabling Phase-8 access.
// The operator supplies a strict JSON array:
//   [{
//     "legacyPatientId": "<patient UUID>",
//     "clinicianSub": "<verified Cognito UUID>",
//     "confirmStoredMedication": true
//   }]
// Ownership is never inferred from phone, display name, medication, or row order. Dry-run is the
// default. Only --apply performs guarded updates, all on one checked-out client and one transaction.

import { readFileSync } from 'node:fs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MAPPINGS = 10_000;
const TRACKED_CA_EXAMPLE = 'backend/src/schema-init/rds-global-bundle.pem';
const USAGE =
  'usage: npx tsx scripts/reconcile-patient-owners.ts --mapping <owners.json> [--apply]';

const NULL_OWNER_SELECT_SQL = `SELECT p.id::text AS id,
       p.medication_name,
       EXISTS (
         SELECT 1 FROM patient_medication pm WHERE pm.patient_id = p.id
       ) AS has_medication
  FROM patient p
 WHERE p.owner_clinician_sub IS NULL
 ORDER BY p.id`;
const LOCK_PATIENT_WRITES_SQL = 'LOCK TABLE patient IN SHARE ROW EXCLUSIVE MODE';
const LOCK_PATIENT_MEDICATION_WRITES_SQL =
  'LOCK TABLE patient_medication IN SHARE ROW EXCLUSIVE MODE';
const LOCK_DOSE_SCHEDULE_WRITES_SQL = 'LOCK TABLE dose_schedule IN SHARE ROW EXCLUSIVE MODE';
const NULL_OWNER_SELECT_FOR_UPDATE_SQL = `${NULL_OWNER_SELECT_SQL} FOR UPDATE OF p`;
const UPDATE_OWNER_SQL =
  'UPDATE patient SET owner_clinician_sub = $1 WHERE id = $2::uuid AND owner_clinician_sub IS NULL';
const INSERT_STORED_MEDICATION_SQL = `INSERT INTO patient_medication (
       patient_id,
       entered_name,
       status,
       confirmed_by_clinician_sub,
       confirmed_at
     )
     SELECT p.id,
            p.medication_name,
            'active',
            $1::text,
            CURRENT_TIMESTAMP
       FROM patient p
      WHERE p.id = $2::uuid
        AND p.owner_clinician_sub = $1::text
        AND NOT EXISTS (
              SELECT 1 FROM patient_medication pm WHERE pm.patient_id = p.id
            )
     RETURNING id::text AS id`;
const BACKFILL_SCHEDULE_MEDICATION_SQL = `UPDATE dose_schedule
   SET patient_medication_id = $1::uuid
 WHERE patient_id = $2::uuid
   AND patient_medication_id IS NULL`;
const NULL_OWNER_COUNT_SQL =
  'SELECT count(*)::text AS count FROM patient WHERE owner_clinician_sub IS NULL';
const MEDICATION_MISMATCH_COUNT_SQL = `SELECT count(*)::text AS medication_mismatches
  FROM (
    SELECT p.id
      FROM patient p
      LEFT JOIN patient_medication pm ON pm.patient_id = p.id
     WHERE p.id = ANY($1::uuid[])
     GROUP BY p.id
    HAVING count(pm.id) <> 1
       OR count(pm.id) FILTER (WHERE pm.status = 'active') <> 1
  ) mismatched`;
const SCHEDULE_MISMATCH_COUNT_SQL = `WITH carried AS (
       SELECT *
         FROM unnest($1::uuid[], $2::uuid[]) AS pair(patient_id, medication_id)
     )
     SELECT count(*)::text AS schedule_mismatches
       FROM dose_schedule ds
       JOIN carried c ON c.patient_id = ds.patient_id
       LEFT JOIN patient_medication pm
         ON pm.patient_id = ds.patient_id
        AND pm.id = ds.patient_medication_id
      WHERE ds.patient_medication_id IS DISTINCT FROM c.medication_id
         OR pm.id IS NULL
         OR pm.status IS DISTINCT FROM 'active'`;

export interface OwnerMapping {
  readonly legacyPatientId: string;
  readonly clinicianSub: string;
  readonly confirmStoredMedication: true;
}

export interface ReconciliationClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount: number | null;
  }>;
}

export type ReconciliationResult =
  | { readonly mode: 'dry-run'; readonly mappedPatients: number }
  | { readonly mode: 'applied'; readonly updatedPatients: number };

export interface ReconciliationCliDeps {
  readonly readFile: (path: string, encoding: 'utf8') => string;
  readonly withClient: (
    run: (client: ReconciliationClient) => Promise<ReconciliationResult>,
  ) => Promise<ReconciliationResult>;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

class SafeReconciliationError extends Error {
  constructor(readonly safeMessage: string) {
    super(safeMessage);
    this.name = 'SafeReconciliationError';
  }
}

function validateMappings(value: unknown): readonly OwnerMapping[] {
  if (!Array.isArray(value) || value.length > MAX_MAPPINGS) {
    throw new SafeReconciliationError(
      `mapping file must be a JSON array with at most ${MAX_MAPPINGS} entries`,
    );
  }

  const patientIds = new Set<string>();
  const mappings = value.map((entry: unknown): OwnerMapping => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new SafeReconciliationError('mapping file entries must be strict UUID pairs');
    }
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (
      keys.length !== 3 ||
      keys[0] !== 'clinicianSub' ||
      keys[1] !== 'confirmStoredMedication' ||
      keys[2] !== 'legacyPatientId'
    ) {
      throw new SafeReconciliationError(
        'mapping file entries may contain only legacyPatientId, clinicianSub, and confirmStoredMedication',
      );
    }
    if (record.confirmStoredMedication !== true) {
      throw new SafeReconciliationError('confirmStoredMedication must be exactly true');
    }
    if (
      typeof record.legacyPatientId !== 'string' ||
      !UUID_PATTERN.test(record.legacyPatientId) ||
      typeof record.clinicianSub !== 'string' ||
      !UUID_PATTERN.test(record.clinicianSub)
    ) {
      throw new SafeReconciliationError('mapping file entries must contain two valid UUIDs');
    }

    const legacyPatientId = record.legacyPatientId.toLowerCase();
    if (patientIds.has(legacyPatientId)) {
      throw new SafeReconciliationError('mapping file contains a duplicate legacy patient UUID');
    }
    patientIds.add(legacyPatientId);
    return Object.freeze({
      legacyPatientId,
      clinicianSub: record.clinicianSub.toLowerCase(),
      confirmStoredMedication: true,
    });
  });

  return Object.freeze(mappings);
}

/** Parse an operator-reviewed mapping without accepting phone/name inference fields. */
export function parseOwnerMappings(contents: string): readonly OwnerMapping[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new SafeReconciliationError('mapping file must be valid JSON');
  }
  return validateMappings(parsed);
}

interface LegacyPatientSnapshot {
  readonly id: string;
  readonly medicationName: string;
}

function legacyPatientSnapshots(result: {
  readonly rows: readonly Record<string, unknown>[];
}): readonly LegacyPatientSnapshot[] {
  let invalidMedicationCount = 0;
  let existingMedicationCount = 0;
  const snapshots = result.rows.map((row): LegacyPatientSnapshot => {
    if (
      typeof row.id !== 'string' ||
      !UUID_PATTERN.test(row.id) ||
      typeof row.has_medication !== 'boolean'
    ) {
      throw new SafeReconciliationError('database returned an invalid NULL-owner result');
    }
    const medicationName = row.medication_name;
    if (
      typeof medicationName !== 'string' ||
      medicationName.trim().length === 0 ||
      Array.from(medicationName).length > 320
    ) {
      invalidMedicationCount += 1;
    }
    if (row.has_medication) existingMedicationCount += 1;
    return {
      id: row.id.toLowerCase(),
      medicationName: typeof medicationName === 'string' ? medicationName : '',
    };
  });
  if (invalidMedicationCount !== 0 || existingMedicationCount !== 0) {
    throw new SafeReconciliationError(
      `stored medication precondition failed: invalid=${invalidMedicationCount}, existing=${existingMedicationCount}`,
    );
  }
  return Object.freeze(snapshots.map((snapshot) => Object.freeze(snapshot)));
}

function assertExactCoverage(
  legacyPatientIds: readonly string[],
  mappings: readonly OwnerMapping[],
): ReadonlyMap<string, string> {
  const mappingByPatient = new Map(
    mappings.map(({ legacyPatientId, clinicianSub }) => [legacyPatientId, clinicianSub]),
  );
  const legacySet = new Set(legacyPatientIds);
  const missing = legacyPatientIds.filter((id) => !mappingByPatient.has(id)).length;
  const unknown = mappings.filter(({ legacyPatientId }) => !legacySet.has(legacyPatientId)).length;
  if (missing !== 0 || unknown !== 0) {
    throw new SafeReconciliationError(
      `mapping coverage mismatch: missing=${missing}, unknown=${unknown}`,
    );
  }
  return mappingByPatient;
}

function countFromResult(
  result: { readonly rows: readonly Record<string, unknown>[] },
  field: string,
): number {
  const count = Number(result.rows[0]?.[field]);
  if (!Number.isInteger(count) || count < 0) {
    throw new SafeReconciliationError('database returned an invalid NULL-owner count');
  }
  return count;
}

/** Validate exact coverage in dry-run, or apply every guarded update atomically and recheck zero NULL. */
export async function reconcilePatientOwners(args: {
  readonly client: ReconciliationClient;
  readonly mappings: readonly OwnerMapping[];
  readonly apply: boolean;
}): Promise<ReconciliationResult> {
  const mappings = validateMappings(args.mappings);
  if (!args.apply) {
    const snapshots = legacyPatientSnapshots(await args.client.query(NULL_OWNER_SELECT_SQL));
    const legacyPatientIds = snapshots.map(({ id }) => id);
    assertExactCoverage(legacyPatientIds, mappings);
    return { mode: 'dry-run', mappedPatients: legacyPatientIds.length };
  }

  await args.client.query('BEGIN');
  try {
    // The restored snapshot may predate the NOT-NULL owner constraint. Block concurrent patient writes
    // and medication inserts in a fixed parent-then-child order so neither final check can race.
    await args.client.query(LOCK_PATIENT_WRITES_SQL);
    await args.client.query(LOCK_PATIENT_MEDICATION_WRITES_SQL);
    await args.client.query(LOCK_DOSE_SCHEDULE_WRITES_SQL);
    const snapshots = legacyPatientSnapshots(
      await args.client.query(NULL_OWNER_SELECT_FOR_UPDATE_SQL),
    );
    const legacyPatientIds = snapshots.map(({ id }) => id);
    const mappingByPatient = assertExactCoverage(legacyPatientIds, mappings);
    const carriedMedicationIds: string[] = [];
    for (const patientId of legacyPatientIds) {
      const clinicianSub = mappingByPatient.get(patientId);
      if (!clinicianSub) {
        throw new SafeReconciliationError('mapping coverage changed during reconciliation');
      }
      const update = await args.client.query(UPDATE_OWNER_SQL, [clinicianSub, patientId]);
      if (update.rowCount !== 1) {
        throw new SafeReconciliationError('concurrent owner change prevented reconciliation');
      }
      const medicationInsert = await args.client.query(INSERT_STORED_MEDICATION_SQL, [
        clinicianSub,
        patientId,
      ]);
      const medicationId = medicationInsert.rows[0]?.id;
      if (
        medicationInsert.rowCount !== 1 ||
        typeof medicationId !== 'string' ||
        !UUID_PATTERN.test(medicationId)
      ) {
        throw new SafeReconciliationError('stored medication insert failed during reconciliation');
      }
      carriedMedicationIds.push(medicationId.toLowerCase());
      await args.client.query(BACKFILL_SCHEDULE_MEDICATION_SQL, [medicationId, patientId]);
    }

    const remainingNull = countFromResult(await args.client.query(NULL_OWNER_COUNT_SQL), 'count');
    if (remainingNull !== 0) {
      throw new SafeReconciliationError('NULL-owner recheck failed after reconciliation');
    }
    const medicationMismatches = countFromResult(
      await args.client.query(MEDICATION_MISMATCH_COUNT_SQL, [legacyPatientIds]),
      'medication_mismatches',
    );
    if (medicationMismatches !== 0) {
      throw new SafeReconciliationError('medication recheck failed after reconciliation');
    }
    const scheduleMismatches = countFromResult(
      await args.client.query(SCHEDULE_MISMATCH_COUNT_SQL, [
        legacyPatientIds,
        carriedMedicationIds,
      ]),
      'schedule_mismatches',
    );
    if (scheduleMismatches !== 0) {
      throw new SafeReconciliationError('schedule recheck failed after reconciliation');
    }
    await args.client.query('COMMIT');
    return { mode: 'applied', updatedPatients: legacyPatientIds.length };
  } catch (error: unknown) {
    try {
      await args.client.query('ROLLBACK');
    } catch {
      throw new SafeReconciliationError('database rollback failed during reconciliation');
    }
    throw error;
  }
}

function parseCliArgs(argv: readonly string[]): {
  readonly mappingPath: string;
  readonly apply: boolean;
} {
  let mappingPath: string | undefined;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply' && !apply) {
      apply = true;
      continue;
    }
    if (argument === '--mapping' && mappingPath === undefined) {
      const candidate = argv[index + 1];
      if (!candidate || candidate.startsWith('--')) {
        throw new SafeReconciliationError(USAGE);
      }
      mappingPath = candidate;
      index += 1;
      continue;
    }
    throw new SafeReconciliationError(USAGE);
  }
  if (!mappingPath) throw new SafeReconciliationError(USAGE);
  return { mappingPath, apply };
}

/** Run the CLI through injected file, database, and console seams; all emitted messages are count-only. */
export async function runReconcilePatientOwnersCli(
  argv: readonly string[],
  deps: ReconciliationCliDeps,
): Promise<0 | 1> {
  try {
    const { mappingPath, apply } = parseCliArgs(argv);
    let contents: string;
    try {
      contents = deps.readFile(mappingPath, 'utf8');
    } catch {
      throw new SafeReconciliationError('mapping file could not be read');
    }
    const mappings = parseOwnerMappings(contents);
    const result = await deps.withClient((client) =>
      reconcilePatientOwners({ client, mappings, apply }),
    );
    if (result.mode === 'dry-run') {
      deps.log(
        `[reconcile] dry-run complete — ${result.mappedPatients} owner/medication mapping(s) validated; no rows updated`,
      );
      deps.log(
        '[reconcile] pass --apply to update NULL owners and carry stored medications in one transaction',
      );
    } else {
      deps.log(
        `[reconcile] applied — ${result.updatedPatients} owner(s) and stored medication(s) reconciled; zero NULL owners remain`,
      );
    }
    return 0;
  } catch (error: unknown) {
    const message =
      error instanceof SafeReconciliationError
        ? error.safeMessage
        : 'database reconciliation failed';
    deps.error(`[reconcile] failed — ${message}`);
    return 1;
  }
}

interface DbSecret {
  readonly username: string;
  readonly password: string;
}

export async function buildPool(): Promise<Pool> {
  const caBundlePath = process.env.DB_CA_BUNDLE_PATH;
  if (!caBundlePath) {
    throw new Error(
      `DB_CA_BUNDLE_PATH is required; use a tracked bundle such as ${TRACKED_CA_EXAMPLE}`,
    );
  }
  const dbSecretArn = process.env.DB_SECRET_ARN;
  const { DB_HOST, DB_TLS_SERVERNAME, DB_PORT, DB_NAME } = process.env;
  if (!dbSecretArn || !DB_HOST || !DB_TLS_SERVERNAME || !DB_PORT || !DB_NAME) {
    throw new Error('database connection environment is incomplete');
  }
  const port = Number(DB_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('DB_PORT must be an integer from 1 through 65535');
  }

  const secret = await new SecretsManagerClient({}).send(
    new GetSecretValueCommand({ SecretId: dbSecretArn }),
  );
  if (!secret.SecretString) throw new Error('database secret is not populated');
  const credentials = JSON.parse(secret.SecretString) as Partial<DbSecret>;
  if (typeof credentials.username !== 'string' || typeof credentials.password !== 'string') {
    throw new Error('database secret has an invalid shape');
  }

  return new Pool({
    host: DB_HOST,
    port,
    database: DB_NAME,
    user: credentials.username,
    password: credentials.password,
    max: 1,
    ssl: {
      ca: readFileSync(caBundlePath, 'utf8'),
      rejectUnauthorized: true,
      servername: DB_TLS_SERVERNAME,
    },
  });
}

async function withProductionClient(
  run: (client: ReconciliationClient) => Promise<ReconciliationResult>,
): Promise<ReconciliationResult> {
  const pool = await buildPool();
  const client = await pool.connect();
  try {
    return await run({
      query: async (text, values = []) => {
        const result = await client.query(text, [...values]);
        return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount };
      },
    });
  } finally {
    client.release();
    await pool.end();
  }
}

async function main(): Promise<void> {
  process.exitCode = await runReconcilePatientOwnersCli(process.argv.slice(2), {
    readFile: readFileSync,
    withClient: withProductionClient,
    log: console.log,
    error: console.error,
  });
}

declare const require: { main?: unknown } | undefined;
declare const module: unknown;
if (typeof require !== 'undefined' && require.main === module) {
  void main();
}
