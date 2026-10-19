import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { SourceReleaseManifest } from '@medadhere/shared';
import {
  SourceActivationConflictError,
  activateDdinterRelease,
  loadFrozenDdinterRelease,
  runDdinterImportCli,
} from './import-ddinter-release.js';

const SCHEMA_SQL = readFileSync(
  join(process.cwd(), 'backend', 'src', 'schema-init', 'schema.sql'),
  'utf8',
);
const TIMEOUT_MS = 180_000;
const HASH = 'a'.repeat(64);
const DDI_CSV = [
  'DDInterID_A,Drug_A,DDInterID_B,Drug_B,Level',
  'DD-AMOX,Amoxicillin,DD-WARF,Warfarin,Major',
  '',
].join('\n');
const REVIEWED_MAPPINGS = JSON.stringify([
  {
    identitySystem: 'rxnorm',
    identityCode: '723',
    ddinterDrugId: 'DD-AMOX',
    mappingStatus: 'mapped',
    reviewedBy: 'reviewer-1',
    reviewedAt: '2026-08-11T00:00:00Z',
  },
  {
    identitySystem: 'rxnorm',
    identityCode: '11289',
    ddinterDrugId: 'DD-WARF',
    mappingStatus: 'mapped',
    reviewedBy: 'reviewer-1',
    reviewedAt: '2026-08-11T00:00:00Z',
  },
]);

let container: StartedPostgreSqlContainer | undefined;
let client: Client;
let databaseUrl: string;
const roots: string[] = [];

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function write(root: string, path: string, value: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, value);
}

function fixture(releaseId: string): { root: string; manifest: SourceReleaseManifest } {
  const root = mkdtempSync(join(tmpdir(), 'medadhere-ddinter-'));
  roots.push(root);
  const releaseRoot = `third-party-data/ddinter/${releaseId}`;
  const ddiPath = `${releaseRoot}/ddi-a.csv`;
  const mappingsPath = `${releaseRoot}/reviewed-mappings.json`;
  const termsPath = `${releaseRoot}/TERMS.html`;
  const transformPath = `${releaseRoot}/normalize-ddinter.ts`;
  const terms = '<html>reviewed terms</html>';
  const transform = '// reviewed transform';
  write(root, ddiPath, DDI_CSV);
  write(root, mappingsPath, REVIEWED_MAPPINGS);
  write(root, termsPath, terms);
  write(root, transformPath, transform);

  return {
    root,
    manifest: {
      manifestVersion: 1,
      source: 'ddinter',
      releaseId,
      activation: { status: 'active', reason: null },
      provenance: {
        publisher: 'DDInter',
        sourceUrl: 'https://ddinter2.scbdd.com/',
        releaseUrl: 'https://ddinter2.scbdd.com/download/',
        retrievedAt: '2026-08-11T00:00:00Z',
        freshUntil: '2026-09-10T00:00:00Z',
        transformation: {
          status: 'applied',
          scriptPath: transformPath,
          scriptSha256: sha256(transform),
          inputLogicalNames: ['ddi-a.csv'],
          notes: 'Reviewed local mapping file added after the raw DDI import.',
        },
      },
      licences: [
        {
          subject: 'DDInter downloadable DDI',
          status: 'cleared',
          licenceId: 'CC-BY-NC-SA-4.0',
          termsUrl: 'https://ddinter2.scbdd.com/terms/',
          termsSnapshotPath: termsPath,
          termsSnapshotSha256: sha256(terms),
          redistribution: 'restricted',
          commercialUse: 'prohibited',
          shareAlike: true,
          patientFacingUse: 'prohibited',
          modelProcessing: 'prohibited',
          attribution: 'DDInter data.',
          notes: 'Noncommercial academic lookup only.',
        },
      ],
      scope: {
        included: ['downloadable drug-drug interaction records'],
        excluded: ['patient-facing claims'],
      },
      expectedFiles: ['ddi-a.csv', 'reviewed-mappings.json'],
      files: [
        {
          logicalName: 'ddi-a.csv',
          path: ddiPath,
          sourceUrl: 'https://ddinter2.scbdd.com/download/',
          kind: 'raw',
          sha256: sha256(DDI_CSV),
          bytes: Buffer.byteLength(DDI_CSV),
          rowCount: 1,
          redistribution: 'restricted',
        },
        {
          logicalName: 'reviewed-mappings.json',
          path: mappingsPath,
          sourceUrl: 'https://ddinter2.scbdd.com/download/',
          kind: 'derived',
          sha256: sha256(REVIEWED_MAPPINGS),
          bytes: Buffer.byteLength(REVIEWED_MAPPINGS),
          rowCount: 2,
          redistribution: 'restricted',
        },
      ],
    },
  };
}

beforeAll(async () => {
  if (process.env.TEST_DATABASE_URL) {
    databaseUrl = process.env.TEST_DATABASE_URL;
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  } else {
    container = await new PostgreSqlContainer('postgres:16').start();
    databaseUrl = container.getConnectionUri();
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  }
  await client.query('BEGIN');
  try {
    await client.query(SCHEMA_SQL);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}, TIMEOUT_MS);

afterAll(async () => {
  await client?.end();
  await container?.stop();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('loadFrozenDdinterRelease', () => {
  it('verifies file, terms, transform checksums and exact parsed row counts', () => {
    const { root, manifest } = fixture('load-ok');
    const bundle = loadFrozenDdinterRelease(root, manifest);
    expect(bundle.drugs).toEqual([
      { id: 'DD-AMOX', displayName: 'Amoxicillin' },
      { id: 'DD-WARF', displayName: 'Warfarin' },
    ]);
    expect(bundle.interactions).toEqual([
      { lowDrugId: 'DD-AMOX', highDrugId: 'DD-WARF', level: 'major' },
    ]);
    expect(bundle.mappings).toHaveLength(2);
  });

  it('fails closed before database access on a checksum or row-count mismatch', () => {
    const checksum = fixture('bad-checksum');
    const badChecksumManifest = {
      ...checksum.manifest,
      files: checksum.manifest.files.map((file, index) =>
        index === 0 ? { ...file, sha256: HASH } : file,
      ),
    };
    expect(() => loadFrozenDdinterRelease(checksum.root, badChecksumManifest)).toThrow(
      /verification failed/i,
    );

    const rows = fixture('bad-rows');
    const badRowManifest = {
      ...rows.manifest,
      files: rows.manifest.files.map((file, index) =>
        index === 0 ? { ...file, rowCount: 2 } : file,
      ),
    };
    expect(() => loadFrozenDdinterRelease(rows.root, badRowManifest)).toThrow(/row count/i);
  });

  it('rejects a reviewed mapping to a drug absent from this exact release', () => {
    const value = fixture('bad-membership');
    const mappingPath = value.manifest.files[1]!.path;
    const mappings = JSON.parse(REVIEWED_MAPPINGS) as Array<Record<string, unknown>>;
    mappings[0]!.ddinterDrugId = 'DD-OTHER';
    const serialized = JSON.stringify(mappings);
    write(value.root, mappingPath, serialized);
    const badMembershipManifest = {
      ...value.manifest,
      files: value.manifest.files.map((file, index) =>
        index === 1
          ? { ...file, sha256: sha256(serialized), bytes: Buffer.byteLength(serialized) }
          : file,
      ),
    };
    expect(() => loadFrozenDdinterRelease(value.root, badMembershipManifest)).toThrow(
      /membership/i,
    );
  });
});

describe('activateDdinterRelease', () => {
  it('defaults to dry-run and writes nothing', async () => {
    const value = fixture('dry-run');
    const bundle = loadFrozenDdinterRelease(value.root, value.manifest);
    const result = await activateDdinterRelease(client, bundle, false);
    expect(result).toEqual({ mode: 'dry-run', drugs: 2, mappings: 2, interactions: 1 });
    const stored = await client.query(
      "SELECT 1 FROM source_release WHERE source_name = 'ddinter' AND release_version = $1",
      [value.manifest.releaseId],
    );
    expect(stored.rowCount).toBe(0);
  });

  it('atomically imports a complete release and supersedes the previous active release', async () => {
    const first = fixture('activation-v1');
    const second = fixture('activation-v2');
    const firstResult = await activateDdinterRelease(
      client,
      loadFrozenDdinterRelease(first.root, first.manifest),
      true,
    );
    const secondResult = await activateDdinterRelease(
      client,
      loadFrozenDdinterRelease(second.root, second.manifest),
      true,
    );
    expect(firstResult.mode).toBe('applied');
    expect(secondResult.mode).toBe('applied');
    const releases = await client.query<{
      release_version: string;
      state: string;
      is_complete: boolean;
    }>(
      `SELECT release_version, state, is_complete
         FROM source_release
        WHERE source_name = 'ddinter' AND release_version IN ($1, $2)
        ORDER BY release_version`,
      [first.manifest.releaseId, second.manifest.releaseId],
    );
    expect(releases.rows).toEqual([
      { release_version: 'activation-v1', state: 'superseded', is_complete: true },
      { release_version: 'activation-v2', state: 'active', is_complete: true },
    ]);
    const files = await client.query<{
      file_name: string;
      import_complete: boolean;
      licence_boundary: string;
    }>(
      `SELECT srf.file_name, srf.import_complete, srf.licence_boundary
         FROM source_release_file srf
         JOIN source_release sr ON sr.id = srf.source_release_id
        WHERE sr.release_version = $1
        ORDER BY srf.file_name`,
      [second.manifest.releaseId],
    );
    expect(files.rows).toHaveLength(2);
    expect(files.rows.every((file) => file.import_complete)).toBe(true);
    expect(files.rows.map((file) => [file.file_name, file.licence_boundary])).toEqual([
      ['ddi-a.csv', 'CC-BY-NC-SA-4.0'],
      ['reviewed-mappings.json', 'CC-BY-NC-SA-4.0'],
    ]);
  });

  it('rejects a conflicting repeat without changing the active release', async () => {
    const value = fixture('activation-conflict');
    const bundle = loadFrozenDdinterRelease(value.root, value.manifest);
    await activateDdinterRelease(client, bundle, true);
    await expect(activateDdinterRelease(client, bundle, true)).rejects.toBeInstanceOf(
      SourceActivationConflictError,
    );
    const active = await client.query<{ release_version: string }>(
      "SELECT release_version FROM source_release WHERE source_name = 'ddinter' AND state = 'active'",
    );
    expect(active.rows[0]?.release_version).toBe('activation-conflict');
  });

  it('serializes concurrent activation so exactly one release remains active', async () => {
    const first = fixture('concurrent-a');
    const second = fixture('concurrent-b');
    const firstClient = new Client({ connectionString: databaseUrl });
    const secondClient = new Client({ connectionString: databaseUrl });
    await Promise.all([firstClient.connect(), secondClient.connect()]);
    try {
      await Promise.all([
        activateDdinterRelease(
          firstClient,
          loadFrozenDdinterRelease(first.root, first.manifest),
          true,
        ),
        activateDdinterRelease(
          secondClient,
          loadFrozenDdinterRelease(second.root, second.manifest),
          true,
        ),
      ]);
    } finally {
      await Promise.all([firstClient.end(), secondClient.end()]);
    }
    const releases = await client.query<{ state: string }>(
      `SELECT state FROM source_release
        WHERE source_name = 'ddinter' AND release_version IN ('concurrent-a', 'concurrent-b')`,
    );
    expect(releases.rows.map((row) => row.state).sort()).toEqual(['active', 'superseded']);
  });
});

describe('runDdinterImportCli', () => {
  it('is read-only by default and requires --apply before opening the database', async () => {
    const value = fixture('cli-dry-run');
    let databaseCalls = 0;
    const log: string[] = [];
    const exitCode = await runDdinterImportCli(['--manifest', 'MANIFEST.json'], {
      repositoryRoot: value.root,
      readManifest: () => value.manifest,
      withClient: async () => {
        databaseCalls += 1;
        throw new Error('database must not be opened');
      },
      log: (line) => log.push(line),
      error: () => undefined,
    });
    expect(exitCode).toBe(0);
    expect(databaseCalls).toBe(0);
    expect(log).toEqual([
      '[ddinter-import] dry-run verified: drugs=2 mappings=2 interactions=1; no database writes',
      '[ddinter-import] pass --apply to activate this exact verified release',
    ]);
  });

  it('opens one database client only after explicit --apply', async () => {
    const value = fixture('cli-apply');
    let databaseCalls = 0;
    const exitCode = await runDdinterImportCli(['--manifest', 'MANIFEST.json', '--apply'], {
      repositoryRoot: value.root,
      readManifest: () => value.manifest,
      withClient: async (run) => {
        databaseCalls += 1;
        return run(client);
      },
      log: () => undefined,
      error: () => undefined,
    });
    expect(exitCode).toBe(0);
    expect(databaseCalls).toBe(1);
  });
});
