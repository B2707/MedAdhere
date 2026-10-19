import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { SourceReleaseManifest } from '@medadhere/shared';
import {
  activateOpenFdaLabelRelease,
  loadFrozenOpenFdaLabelRelease,
} from './import-openfda-label-release.js';
import { sha256 } from './source-release-import.js';

const SCHEMA_SQL = readFileSync(
  join(process.cwd(), 'backend', 'src', 'schema-init', 'schema.sql'),
  'utf8',
);
const TIMEOUT_MS = 180_000;
const roots: string[] = [];
let container: StartedPostgreSqlContainer | undefined;
let client: Client;

function write(root: string, path: string, value: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, value);
}

function fixture(releaseId: string): { root: string; manifest: SourceReleaseManifest } {
  const root = mkdtempSync(join(tmpdir(), 'medadhere-openfda-'));
  roots.push(root);
  const releaseRoot = `third-party-data/openfda/${releaseId}`;
  const labelsPath = `${releaseRoot}/reviewed-label-passages.json`;
  const termsPath = `${releaseRoot}/TERMS.txt`;
  const transformPath = 'scripts/import-openfda-label-release.ts';
  const labels = JSON.stringify({
    reviewedAt: '2026-08-11T00:00:00Z',
    reviewedBy: 'MedAdhere source review',
    entries: [
      {
        evidenceCode: 'openfda-amlodipine-adverse-v1',
        rxcui: '17767',
        setId: '003dd1ec-16f8-4f96-b6a8-c4689d35892a',
        effectiveTime: '20260420',
        passage: 'The most common adverse reaction to amlodipine is edema.',
        sourceUrl:
          'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=003dd1ec-16f8-4f96-b6a8-c4689d35892a',
        language: 'en',
      },
    ],
  });
  const terms = 'Exact reviewed openFDA terms snapshot.';
  write(root, labelsPath, labels);
  write(root, termsPath, terms);
  write(root, transformPath, '// fixture transform');
  return {
    root,
    manifest: {
      manifestVersion: 1,
      source: 'openfda',
      releaseId,
      activation: { status: 'active', reason: null },
      provenance: {
        publisher: 'U.S. Food and Drug Administration',
        sourceUrl: 'https://open.fda.gov/apis/drug/label/',
        releaseUrl: 'https://open.fda.gov/apis/drug/label/',
        retrievedAt: '2026-08-11T00:00:00Z',
        freshUntil: '2026-09-10T00:00:00Z',
        transformation: {
          status: 'applied',
          scriptPath: transformPath,
          scriptSha256: sha256('// fixture transform'),
          inputLogicalNames: ['reviewed-label-passages.json'],
          notes: 'Exact reviewed passages only.',
        },
      },
      licences: [
        {
          subject: 'Selected openFDA drug-label records without a dataset warning',
          status: 'cleared',
          licenceId: 'CC0-1.0',
          termsUrl: 'https://open.fda.gov/terms/',
          termsSnapshotPath: termsPath,
          termsSnapshotSha256: sha256(terms),
          redistribution: 'allowed',
          commercialUse: 'allowed',
          shareAlike: false,
          patientFacingUse: 'allowed',
          modelProcessing: 'allowed',
          attribution: 'Data provided by the U.S. Food and Drug Administration.',
          notes: 'No warning that CC0 does not apply appears in the drug-label API documentation.',
        },
      ],
      scope: {
        included: ['manually reviewed bounded label passages and exact label identifiers'],
        excluded: ['unreviewed sections, GMDN, diagnosis, and treatment advice'],
      },
      expectedFiles: ['reviewed-label-passages.json'],
      files: [
        {
          logicalName: 'reviewed-label-passages.json',
          path: labelsPath,
          sourceUrl: 'https://open.fda.gov/apis/drug/label/',
          kind: 'raw',
          sha256: sha256(labels),
          bytes: Buffer.byteLength(labels),
          rowCount: 1,
          redistribution: 'allowed',
        },
      ],
    },
  };
}

beforeAll(async () => {
  if (process.env.TEST_DATABASE_URL) {
    client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();
  } else {
    container = await new PostgreSqlContainer('postgres:16').start();
    client = new Client({ connectionString: container.getConnectionUri() });
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

describe('loadFrozenOpenFdaLabelRelease', () => {
  it('accepts exact reviewed, renderable passages with complete provenance', () => {
    const value = fixture('labels-v1');
    const bundle = loadFrozenOpenFdaLabelRelease(value.root, value.manifest);
    expect(bundle.evidence).toEqual([
      expect.objectContaining({
        code: 'openfda-amlodipine-adverse-v1',
        passage: 'The most common adverse reaction to amlodipine is edema.',
        tags: ['rxcui:17767'],
      }),
    ]);
  });

  it('rejects overlong or unreviewed label material before activation', () => {
    const value = fixture('labels-too-long');
    const file = value.manifest.files[0]!;
    const labels = JSON.parse(readFileSync(join(value.root, file.path), 'utf8')) as {
      entries: Array<Record<string, unknown>>;
    };
    labels.entries[0]!.passage = 'x'.repeat(300);
    const changed = JSON.stringify(labels);
    write(value.root, file.path, changed);
    const manifest = {
      ...value.manifest,
      files: [{ ...file, sha256: sha256(changed), bytes: Buffer.byteLength(changed) }],
    };
    expect(() => loadFrozenOpenFdaLabelRelease(value.root, manifest)).toThrow(/render/i);
  });
});

describe('activateOpenFdaLabelRelease', () => {
  it('dry-runs without writes and atomically activates reviewed evidence on apply', async () => {
    const value = fixture('labels-activation');
    const bundle = loadFrozenOpenFdaLabelRelease(value.root, value.manifest);
    expect(await activateOpenFdaLabelRelease(client, bundle)).toEqual({
      mode: 'dry-run',
      evidence: 1,
    });
    expect(
      (
        await client.query(
          "SELECT 1 FROM source_release WHERE source_name = 'openfda' AND release_version = $1",
          [value.manifest.releaseId],
        )
      ).rowCount,
    ).toBe(0);

    const applied = await activateOpenFdaLabelRelease(client, bundle, true);
    expect(applied.mode).toBe('applied');
    const stored = await client.query<{
      passage: string;
      tags: string[];
      coverage_state: string;
    }>(
      `SELECT er.passage, er.tags, er.coverage_state
         FROM evidence_record er
         JOIN source_release sr ON sr.id = er.source_release_id
        WHERE sr.release_version = $1`,
      [value.manifest.releaseId],
    );
    expect(stored.rows).toEqual([
      {
        passage: 'The most common adverse reaction to amlodipine is edema.',
        tags: ['rxcui:17767'],
        coverage_state: 'direct_evidence',
      },
    ]);
  });
});
