import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { SourceReleaseManifest } from '@medadhere/shared';
import type { Client } from 'pg';
import { createDbPoolProvider } from '../backend/src/shared/db-pool.js';

export type SourceImportClient = Pick<Client, 'query'>;

export interface EvidenceInsertRow {
  readonly code: string;
  readonly kind: 'label' | 'medlineplus' | 'monograph' | 'adverse_event_index';
  readonly language: string;
  readonly passage: string;
  readonly sourceUrl: string;
  readonly coverageState: 'direct_evidence' | 'candidate_only' | 'coverage_unknown';
  readonly tags: readonly string[];
}

export interface SourceImportCliDeps<TResult> {
  readonly repositoryRoot: string;
  readonly readManifest: (path: string) => unknown;
  readonly withClient: (run: (client: SourceImportClient) => Promise<TResult>) => Promise<TResult>;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

export interface SourceImportCliConfig<TBundle, TResult> {
  readonly label: string;
  readonly load: (repositoryRoot: string, input: unknown) => TBundle;
  readonly apply: (client: SourceImportClient, bundle: TBundle) => Promise<TResult>;
  readonly dryRunLines: (bundle: TBundle) => readonly string[];
  readonly appliedLine: (result: TResult) => string;
}

export class FrozenReleaseVerificationError extends Error {
  constructor(message: string) {
    super(`Frozen source verification failed: ${message}`);
    this.name = 'FrozenReleaseVerificationError';
  }
}

export class SourceActivationConflictError extends Error {
  constructor() {
    super('Source release already exists');
    this.name = 'SourceActivationConflictError';
  }
}

export function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quoted && character === '"' && line[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      cells.push(cell);
      cell = '';
    } else {
      cell += character;
    }
  }
  if (quoted) throw new FrozenReleaseVerificationError('CSV contains an unclosed quote');
  return [...cells, cell];
}

export function verifyFrozenFile(
  root: string,
  path: string,
  expectedSha256: string,
  expectedBytes?: number,
): Buffer {
  const realRoot = realpathSync(root);
  const realFile = realpathSync(resolve(realRoot, path));
  if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${sep}`)) {
    throw new FrozenReleaseVerificationError('a manifest path resolves outside the repository');
  }
  const bytes = readFileSync(realFile);
  if (
    sha256(bytes) !== expectedSha256 ||
    (expectedBytes !== undefined && bytes.length !== expectedBytes)
  ) {
    throw new FrozenReleaseVerificationError('checksum or byte count does not match the manifest');
  }
  return bytes;
}

export function releaseChecksum(manifest: SourceReleaseManifest): string {
  return sha256(
    manifest.files
      .map((file) => `${file.logicalName}:${file.sha256}`)
      .sort()
      .join('\n'),
  );
}

export function parseSourceImportArgs(argv: readonly string[]): {
  manifestPath: string;
  apply: boolean;
} {
  let manifestPath: string | undefined;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--manifest' && manifestPath === undefined) {
      manifestPath = argv[index + 1];
      index += 1;
    } else if (argument === '--apply' && !apply) {
      apply = true;
    } else {
      throw new Error('invalid arguments');
    }
  }
  if (!manifestPath) throw new Error('manifest path is required');
  return { manifestPath, apply };
}

export async function insertEvidenceRecords(
  client: SourceImportClient,
  releaseId: string,
  rows: readonly EvidenceInsertRow[],
  chunkSize = 500,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    await client.query(
      `INSERT INTO evidence_record
         (source_release_id, evidence_code, evidence_kind, language, passage,
          source_url, coverage_state, tags)
       SELECT $1, item.code, item.kind, item.language, item.passage,
              item.source_url, item.coverage_state,
              ARRAY(SELECT jsonb_array_elements_text(item.tags::jsonb))
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[],
                     $6::text[], $7::text[], $8::text[])
              AS item(code, kind, language, passage, source_url, coverage_state, tags)`,
      [
        releaseId,
        chunk.map((row) => row.code),
        chunk.map((row) => row.kind),
        chunk.map((row) => row.language),
        chunk.map((row) => row.passage),
        chunk.map((row) => row.sourceUrl),
        chunk.map((row) => row.coverageState),
        chunk.map((row) => JSON.stringify(row.tags)),
      ],
    );
  }
}

export async function runSourceImportCli<TBundle, TResult>(
  argv: readonly string[],
  deps: SourceImportCliDeps<TResult>,
  config: SourceImportCliConfig<TBundle, TResult>,
): Promise<number> {
  try {
    const { manifestPath, apply } = parseSourceImportArgs(argv);
    const bundle = config.load(deps.repositoryRoot, deps.readManifest(manifestPath));
    if (!apply) {
      for (const line of config.dryRunLines(bundle)) deps.log(line);
      return 0;
    }
    const result = await deps.withClient((client) => config.apply(client, bundle));
    deps.log(config.appliedLine(result));
    return 0;
  } catch (error) {
    deps.error(`[${config.label}] failed: ${(error as Error).name || 'Error'}`);
    return 1;
  }
}

export async function runSourceImportMain<TBundle, TResult>(
  argv: readonly string[],
  config: SourceImportCliConfig<TBundle, TResult>,
): Promise<number> {
  const getPool = createDbPoolProvider(new SecretsManagerClient({}));
  return runSourceImportCli(
    argv,
    {
      repositoryRoot: process.cwd(),
      readManifest: (path) => JSON.parse(readFileSync(path, 'utf8')) as unknown,
      withClient: async (run) => {
        const pool = await getPool();
        const client = await pool.connect();
        try {
          return await run(client);
        } finally {
          client.release();
          await pool.end();
        }
      },
      log: (line) => process.stdout.write(`${line}\n`),
      error: (line) => process.stderr.write(`${line}\n`),
    },
    config,
  );
}

/** Activate one already-verified source and its rows atomically. */
export async function activateVerifiedSource(args: {
  readonly client: SourceImportClient;
  readonly manifest: SourceReleaseManifest;
  readonly checksumSha256: string;
  readonly insertRows: (releaseId: string) => Promise<void>;
}): Promise<string> {
  const { client, manifest } = args;
  if (manifest.activation.status !== 'active' || manifest.licences.length !== 1) {
    throw new FrozenReleaseVerificationError('activation requires one fully cleared licence');
  }
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `source-release:${manifest.source}`,
    ]);
    const existing = await client.query(
      'SELECT 1 FROM source_release WHERE source_name = $1 AND release_version = $2',
      [manifest.source, manifest.releaseId],
    );
    if (existing.rowCount !== 0) throw new SourceActivationConflictError();

    const previous = await client.query<{ id: string }>(
      `SELECT id FROM source_release
        WHERE source_name = $1 AND state = 'active'
        FOR UPDATE`,
      [manifest.source],
    );
    const previousId = previous.rows[0]?.id ?? null;
    if (previousId) {
      await client.query("UPDATE source_release SET state = 'superseded' WHERE id = $1", [
        previousId,
      ]);
    }
    const licence = manifest.licences[0]!;
    const release = await client.query<{ id: string }>(
      `INSERT INTO source_release
         (source_name, release_version, checksum_sha256, source_url, licence_id, terms_url,
          state, is_complete, supersedes_id, retrieved_at, fresh_until, activated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', false, $7, $8, $9, now())
       RETURNING id`,
      [
        manifest.source,
        manifest.releaseId,
        args.checksumSha256,
        manifest.provenance.releaseUrl,
        licence.licenceId,
        licence.termsUrl,
        previousId,
        manifest.provenance.retrievedAt,
        manifest.provenance.freshUntil,
      ],
    );
    const releaseId = release.rows[0]!.id;
    for (const file of manifest.files) {
      await client.query(
        `INSERT INTO source_release_file
           (source_release_id, file_name, checksum_sha256, row_count,
            licence_boundary, import_complete)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [
          releaseId,
          file.logicalName,
          file.sha256,
          file.rowCount,
          file.logicalName === 'reviewed-identity-bridge.json'
            ? 'reviewed-derived-factual-map'
            : licence.licenceId,
        ],
      );
    }
    await args.insertRows(releaseId);
    await client.query('UPDATE source_release SET is_complete = true WHERE id = $1', [releaseId]);
    await client.query('COMMIT');
    return releaseId;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
