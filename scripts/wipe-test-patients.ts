// scripts/wipe-test-patients.ts
//
// Confirmation-gated Phase-7 pre-cohort reset. Dry-run is the default and reports both patient
// polarities without deleting anything. --apply sweeps each is_test=true patient's dose-/timeout-
// EventBridge schedules through wipeTestPatients, then CASCADE-deletes the captured patient ids.
//
// DB access mirrors scripts/export-anon.ts: credentials come from Secrets Manager and TLS pins the
// tracked RDS global CA bundle supplied through DB_CA_BUNDLE_PATH. There is deliberately no scripts/*.pem
// fallback because untracked PEM files are forbidden.

import { readFileSync } from 'node:fs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';
import {
  wipeTestPatients,
  type Queryable,
  type WipeResult,
} from '../backend/src/lib/tester-hygiene.js';

const TRACKED_CA_EXAMPLE = 'backend/src/schema-init/rds-global-bundle.pem';

interface DbSecret {
  username: string;
  password: string;
}

export interface WipeClient extends Queryable {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export type WipeRunResult =
  | {
      readonly mode: 'dry-run';
      readonly testPatients: number;
      readonly nonTestPatients: number;
    }
  | {
      readonly mode: 'applied';
      readonly wipe: WipeResult;
    };

function countFromResult(result: { rows: unknown[] }): number {
  const row = result.rows[0] as { count?: unknown } | undefined;
  const count = Number(row?.count);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('wipe-test-patients: count query returned an invalid result');
  }
  return count;
}

/**
 * Dry-run counts only. Apply owns the complete transaction around wipeTestPatients so its SELECT,
 * schedule sweeps, and DELETE stay on the same dedicated client.
 */
export async function runWipe(args: {
  readonly client: WipeClient;
  readonly apply: boolean;
}): Promise<WipeRunResult> {
  if (!args.apply) {
    const testRows = await args.client.query(
      'SELECT count(*)::text AS count FROM patient WHERE is_test = true',
    );
    const nonTestRows = await args.client.query(
      'SELECT count(*)::text AS count FROM patient WHERE is_test = false',
    );
    return {
      mode: 'dry-run',
      testPatients: countFromResult(testRows),
      nonTestPatients: countFromResult(nonTestRows),
    };
  }

  await args.client.query('BEGIN');
  try {
    const wipe = await wipeTestPatients(args.client, { confirmDestructive: true });
    await args.client.query('COMMIT');
    return { mode: 'applied', wipe };
  } catch (error: unknown) {
    await args.client.query('ROLLBACK');
    throw error;
  }
}

/**
 * Build the operator pool with Secrets Manager credentials and CA-pinned TLS. DB_CA_BUNDLE_PATH is
 * checked before any AWS or DB reach so a missing bundle fails locally and actionably.
 */
export async function buildPool(): Promise<Pool> {
  const caBundlePath = process.env.DB_CA_BUNDLE_PATH;
  if (!caBundlePath) {
    throw new Error(
      `DB_CA_BUNDLE_PATH env var is required; point it at a tracked bundle such as ${TRACKED_CA_EXAMPLE}`,
    );
  }

  const dbSecretArn = process.env.DB_SECRET_ARN;
  if (!dbSecretArn) throw new Error('DB_SECRET_ARN env var is not set');

  const { DB_HOST, DB_TLS_SERVERNAME, DB_PORT, DB_NAME } = process.env;
  if (!DB_HOST || !DB_TLS_SERVERNAME || !DB_PORT || !DB_NAME) {
    throw new Error('DB_HOST / DB_TLS_SERVERNAME / DB_PORT / DB_NAME env vars must all be set');
  }
  const port = Number(DB_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`DB_PORT is not a valid TCP port (1-65535): ${DB_PORT}`);
  }

  const rdsCaBundle = readFileSync(caBundlePath, 'utf8');
  const sm = new SecretsManagerClient({});
  const secretValue = await sm.send(new GetSecretValueCommand({ SecretId: dbSecretArn }));
  if (!secretValue.SecretString) {
    throw new Error('DB secret has no SecretString — secret not populated');
  }
  const { username, password } = JSON.parse(secretValue.SecretString) as DbSecret;

  return new Pool({
    host: DB_HOST,
    port,
    database: DB_NAME,
    user: username,
    password,
    max: 2,
    ssl: { ca: rdsCaBundle, rejectUnauthorized: true, servername: DB_TLS_SERVERNAME },
  });
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const pool = await buildPool();
  const client = await pool.connect();
  try {
    // TRANSACTIONALITY: tester-hygiene.ts requires one checked-out PoolClient; a bare Pool can route
    // BEGIN/SELECT/DELETE/COMMIT across different connections and break the atomic wipe.
    const result = await runWipe({ client, apply });
    if (result.mode === 'dry-run') {
      console.log(
        `[wipe] dry-run — is_test=true: ${result.testPatients}; ` +
          `is_test=false survivors: ${result.nonTestPatients}; nothing deleted`,
      );
      console.log(
        '[wipe] pass --apply to sweep schedules and CASCADE-delete is_test=true patients',
      );
      return;
    }
    console.log(
      `[wipe] applied — testers found: ${result.wipe.testersFound}; ` +
        `patients deleted: ${result.wipe.patientsDeleted}; ` +
        `schedules swept: ${result.wipe.schedulesSwept}`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

declare const require: { main?: unknown } | undefined;
declare const module: unknown;
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unexpected error';
    console.error(`[wipe] fatal: ${message}`);
    process.exitCode = 1;
  });
}
