// backend/src/export-anon/handler.ts
//
// The in-VPC `export-anon` Lambda entry (DASH-06 / D6 / D14) — the EventBridge Scheduler INVOKE TARGET
// of the nightly, validation-window-gated anonymized-export schedule. It supplies the two real seams the
// PURE core (core.ts) is written against: the shared db-pool provider (F28 single-source TLS, M-2 pinned
// CA, D-11 max 2, per-cold-start secret) and a
// real S3 `PutObject` putter. The core owns the D7 allowlist + RFC-4180 CSV + the D14 0-row loud-fail.
//
//   EventBridge Scheduler (nightly, default group, dedicated target role) → THIS Lambda
//     → runExportAnon({ getPool(), S3 putter, excludeTest:false }) → s3://<bucket>/exports/…csv
//
// D14 — the no-argv (scheduler) path defaults excludeTest=false, so it exports the is_test=true cohort;
// a 0-row result throws EmptyExportError (the core) → a VISIBLE Lambda invocation error in CloudWatch
// (loud fail, never a silent empty object). Logging is id-only (rowCount/destination — never row values).
//
// Module mode: CommonJS (F11); no Twilio/SSM/LLM. The only side effects are the RDS SELECT + the S3 put.

import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { runExportAnon, type ExportPutter } from './core.js';
import { createDbPoolProvider } from '../shared/db-pool';

/** Reuse the AWS SDK clients across warm invocations (module scope → fewer TLS handshakes). */
const sm = new SecretsManagerClient({});
const s3 = new S3Client({});

const getPool = createDbPoolProvider(sm);

/** The optional scheduler/manual invoke payload — only an explicit excludeTest override is honored. */
interface ExportEvent {
  excludeTest?: boolean;
}

/**
 * Build (or return the cached) module-scoped pg.Pool. Cloned VERBATIM from timeout/handler.ts: the DB
 * credential is fetched from Secrets Manager (D-06 — never an env var) ONCE per cold container; TLS is
 * single-sourced (F28) via the explicit `ssl` object with the pinned RDS global CA bundle +
 * rejectUnauthorized:true (M-2). The export SELECT is read-only, so max 2 connections is ample (D-11).
 */

/**
 * A real S3 PutObject putter for the finished CSV. The object key is timestamped so nightly runs never
 * overwrite. The bucket is SSE-S3 + enforceSSL (M11), so no per-put encryption/TLS flag is needed here.
 * Exported so the operator script's `--apply` path reuses the exact same S3 write shape (no drift).
 */
export function makeS3Putter(
  client: S3Client,
  bucket: string,
  now: () => Date = () => new Date(),
): ExportPutter {
  return {
    async put(csv: string): Promise<{ destination: string }> {
      const stamp = now().toISOString().replace(/[:.]/g, '-');
      const key = `exports/adherence-anon-${stamp}.csv`;
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: csv,
          ContentType: 'text/csv',
        }),
      );
      return { destination: `s3://${bucket}/${key}` };
    },
  };
}

/**
 * The nightly export Lambda entrypoint. D14: the scheduler invokes with no meaningful payload, so
 * excludeTest defaults false → the is_test=true cohort is exported. An explicit `{ excludeTest:true }`
 * override is honored for a manual dev-noise run. A 0-row result throws EmptyExportError (the core) →
 * a visible Lambda error (loud fail). Returns { rowCount, destination } for the invocation record.
 */
export async function handler(
  event?: ExportEvent,
): Promise<{ rowCount: number; destination: string }> {
  const bucket = process.env.EXPORT_BUCKET_NAME;
  if (!bucket) {
    throw new Error('EXPORT_BUCKET_NAME env var is not set');
  }

  const excludeTest = event?.excludeTest === true; // D14 — default false (INCLUDE the cohort)
  const client = await getPool();
  const putter = makeS3Putter(s3, bucket);

  const result = await runExportAnon({ client, putter, options: { excludeTest } });
  return { rowCount: result.rowCount, destination: result.destination };
}
