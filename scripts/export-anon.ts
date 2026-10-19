// scripts/export-anon.ts
//
// DASH-06 `export-anon` — the OPERATOR entry for the anonymized adherence export (D6/D7/D14). Run
// OFFLINE against the private RDS over an SSM bastion tunnel. It reuses the SAME pure DI core as the
// nightly Lambda (backend/src/export-anon/core.ts), so the operator run and the scheduled run can never
// drift on the D7 allowlist, the RFC-4180 CSV, or the D14 0-row loud-fail. DB access mirrors the
// freeze-drug-profiles.ts posture: a pg.Pool over the pinned RDS CA bundle, credential from Secrets
// Manager (never an env var), with a DB_CA_BUNDLE_PATH override for the operator machine.
//
//   npx tsx scripts/export-anon.ts                 # DRY-RUN (default): query + build CSV + preview, NO write
//   npx tsx scripts/export-anon.ts --out ./local-exports/export.csv
//   npx tsx scripts/export-anon.ts --out ./local-exports/export.csv --force
//   npx tsx scripts/export-anon.ts --apply         # write the CSV to S3 (EXPORT_BUCKET_NAME)
//   npx tsx scripts/export-anon.ts --exclude-test  # D14 INVERTED flag — drop the is_test cohort (dev-noise only)
//
// D14: the DEFAULT includes the is_test=true cohort (the P7 validation cohort IS is_test=true). A 0-row
// result is a LOUD FAILURE — the core throws EmptyExportError and this script exits NON-ZERO with a clear
// message (never a silent empty CSV). Env for a tunneled run: DB_SECRET_ARN, DB_HOST (127.0.0.1 via the
// tunnel), DB_TLS_SERVERNAME (the RDS hostname), DB_PORT, DB_NAME, DB_CA_BUNDLE_PATH; plus
// EXPORT_BUCKET_NAME for --apply.
//
// Module mode: CommonJS-compatible (no import.meta), mirroring the backend handlers + freeze CLI.

import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import {
  runExportAnon,
  EmptyExportError,
  type ExportPutter,
} from '../backend/src/export-anon/core.js';
import { makeS3Putter } from '../backend/src/export-anon/handler.js';

/** Shape of the CDK-generated DB credential secret (D-06). */
interface DbSecret {
  username: string;
  password: string;
}

/**
 * Build a pg.Pool over the pinned RDS CA bundle, reusing the freeze-drug-profiles.ts posture: the DB
 * credential comes from Secrets Manager (D-06 — never an env var), and TLS is configured by ONE explicit
 * `ssl` object that pins the AWS RDS global CA bundle (M-2: rejectUnauthorized:true, never false). The
 * operator provides the PEM path via DB_CA_BUNDLE_PATH (or places it next to this script).
 */
async function buildPool(): Promise<Pool> {
  const dbSecretArn = process.env.DB_SECRET_ARN;
  if (!dbSecretArn) throw new Error('DB_SECRET_ARN env var is not set');

  const { DB_HOST, DB_TLS_SERVERNAME, DB_PORT, DB_NAME } = process.env;
  if (!DB_HOST || !DB_TLS_SERVERNAME || !DB_PORT || !DB_NAME) {
    throw new Error(
      'DB_HOST / DB_TLS_SERVERNAME / DB_PORT / DB_NAME env vars must all be set',
    );
  }
  const port = Number(DB_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`DB_PORT is not a valid TCP port (1-65535): ${DB_PORT}`);
  }

  const sm = new SecretsManagerClient({});
  const secretValue = await sm.send(new GetSecretValueCommand({ SecretId: dbSecretArn }));
  if (!secretValue.SecretString) {
    throw new Error('DB secret has no SecretString — secret not populated');
  }
  const { username, password } = JSON.parse(secretValue.SecretString) as DbSecret;

  // M-2 — pin the AWS RDS global CA bundle and VERIFY the server cert. Single-source TLS (F28).
  const caBundlePath = process.env.DB_CA_BUNDLE_PATH ?? join(__dirname, 'rds-global-bundle.pem');
  const rdsCaBundle = readFileSync(caBundlePath, 'utf8');

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

/** Resolve the `--out <path>` argument (the local-file destination), or undefined when absent. */
function outPathFromArgv(argv: string[]): string | undefined {
  const idx = argv.indexOf('--out');
  if (idx < 0) return undefined;
  return argv[idx + 1];
}

/** Write an owner-only local export, refusing an existing path unless the operator passes --force. */
export function writeLocalExport(outPath: string, csv: string, force: boolean): void {
  let fileDescriptor: number | undefined;
  try {
    const createFlags =
      constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_NONBLOCK |
      constants.O_NOFOLLOW |
      (force ? 0 : constants.O_EXCL);
    fileDescriptor = openSync(outPath, createFlags, 0o600);
    const destination = fstatSync(fileDescriptor);
    if (!destination.isFile() || destination.nlink !== 1) {
      throw new Error(
        `local export destination must be a single-link regular file: ${outPath}`,
      );
    }
    fchmodSync(fileDescriptor, 0o600);
    ftruncateSync(fileDescriptor, 0);
    writeFileSync(fileDescriptor, csv, { encoding: 'utf8' });
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ELOOP'
    ) {
      throw new Error(`local export destination must not be a symlink: ${outPath}`);
    }
    if (
      !force &&
      error instanceof Error &&
      'code' in error &&
      error.code === 'EEXIST'
    ) {
      throw new Error(
        `local export already exists at ${outPath}; choose a new path or pass --force`,
      );
    }
    throw error;
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
  }
}

/** CLI entrypoint — MED-7-style gate: DRY-RUN default; a write happens ONLY under --apply or --out. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const excludeTest = argv.includes('--exclude-test'); // D14 inverted flag (dev-noise runs only)
  const apply = argv.includes('--apply');
  const force = argv.includes('--force');
  const outPath = outPathFromArgv(argv);
  if (argv.includes('--out') && (!outPath || outPath.startsWith('--'))) {
    console.error('[export] --out requires a file path, e.g. --out adherence-anon.csv');
    process.exitCode = 1;
    return;
  }
  if (outPath && !force && existsSync(outPath)) {
    console.error(`[export] local export already exists at ${outPath}; choose a new path or pass --force`);
    process.exitCode = 1;
    return;
  }

  const mode = outPath
    ? `LOCAL FILE (${outPath})`
    : apply
      ? 'APPLY (S3 write)'
      : 'DRY-RUN (no write — preview only)';
  console.log('='.repeat(72));
  console.log(
    `DASH-06 export-anon — mode: ${mode}` +
      (excludeTest
        ? ' [--exclude-test: is_test cohort DROPPED (dev-noise only)]'
        : ' [includes the is_test cohort — D14]'),
  );
  console.log('='.repeat(72));

  const pool = await buildPool();
  try {
    let putter: ExportPutter;
    if (outPath) {
      putter = {
        async put(csv: string): Promise<{ destination: string }> {
          writeLocalExport(outPath, csv, force);
          return { destination: outPath };
        },
      };
    } else if (apply) {
      const bucket = process.env.EXPORT_BUCKET_NAME;
      if (!bucket) throw new Error('EXPORT_BUCKET_NAME env var is required for --apply');
      putter = makeS3Putter(new S3Client({}), bucket);
    } else {
      // DRY-RUN: exercise the query + CSV build + the 0-row guard, but write nothing.
      putter = {
        async put(): Promise<{ destination: string }> {
          return { destination: '(dry-run — nothing written)' };
        },
      };
    }

    const result = await runExportAnon({ client: pool, putter, options: { excludeTest } });
    console.log(`[export] ${result.rowCount} row(s) → ${result.destination}`);
    console.log(`[export] columns (D7 allowlist): ${result.columns.join(', ')}`);

    if (!apply && !outPath) {
      // Hand-review preview (the CSV is already anonymized by construction — pseudonyms, no PII).
      const preview = result.csv.split('\r\n').slice(0, 6).join('\n');
      console.log('[export] dry-run preview (header + up to 5 rows):');
      console.log(preview);
      console.log('[export] pass --apply to write to S3, or --out <path> for a local file.');
    }
  } catch (error: unknown) {
    // D14 — a 0-row export is a LOUD, NON-ZERO-exit failure (never a silent empty CSV).
    if (error instanceof EmptyExportError) {
      console.error(`[export] ${error.message}`);
    } else {
      const message = error instanceof Error ? error.message : 'unexpected error';
      console.error(`[export] fatal: ${message}`);
    }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

// Run main() only when executed directly (tsx/node), not when imported by a test module.
// `require.main === module` is the CJS direct-invocation guard (no import.meta — matches CJS mode).
declare const require: { main?: unknown } | undefined;
declare const module: unknown;
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unexpected error';
    console.error(`[export] fatal: ${message}`);
    process.exitCode = 1;
  });
}
