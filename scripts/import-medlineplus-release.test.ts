import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { renderClinicalClaim, type SourceReleaseManifest } from '@medadhere/shared';
import {
  activateMedlinePlusRelease,
  loadFrozenMedlinePlusRelease,
  runMedlinePlusImportCli,
} from './import-medlineplus-release.js';
import { sha256 } from './source-release-import.js';

const SCHEMA_SQL = readFileSync(
  join(process.cwd(), 'backend', 'src', 'schema-init', 'schema.sql'),
  'utf8',
);
const TIMEOUT_MS = 180_000;
const TOPICS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<health-topics total="2" date-generated="08/08/2026 04:00:00">
  <health-topic title="High Blood Pressure" url="https://medlineplus.gov/highbloodpressure.html" id="100" language="English" date-created="01/01/2000" meta-desc="Summary">
    <also-called>Hypertension</also-called>
    <full-summary>&lt;p&gt;High blood pressure usually has no symptoms.&lt;/p&gt;&lt;p&gt;Your clinician can check it.&lt;/p&gt;</full-summary>
    <group url="https://medlineplus.gov/heart.html" id="1">Heart</group>
    <mesh-heading><descriptor id="D006973">Hypertension</descriptor></mesh-heading>
    <related-topic url="https://medlineplus.gov/bloodpressure.html" id="200">Blood Pressure</related-topic>
    <see-reference>High BP</see-reference>
    <site title="External encyclopedia" url="https://example.com"><information-category>Encyclopedia</information-category><standard-description>DO NOT INGEST THIS SITE BODY</standard-description></site>
  </health-topic>
  <health-topic title="Presión arterial alta" url="https://medlineplus.gov/spanish/highbloodpressure.html" id="101" language="Spanish" date-created="01/01/2000" meta-desc="Resumen">
    <full-summary>&lt;p&gt;La presión arterial alta generalmente no tiene síntomas.&lt;/p&gt;</full-summary>
    <group url="https://medlineplus.gov/spanish/heart.html" id="1">Corazón</group>
    <language-mapped-topic url="https://medlineplus.gov/highbloodpressure.html" id="100" language="English">High Blood Pressure</language-mapped-topic>
    <site title="External" url="https://example.com"><information-category>Organizations</information-category></site>
  </health-topic>
</health-topics>`;

let container: StartedPostgreSqlContainer | undefined;
let client: Client;
const roots: string[] = [];

function write(root: string, path: string, value: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, value);
}

function fixture(releaseId: string): { root: string; manifest: SourceReleaseManifest } {
  const root = mkdtempSync(join(tmpdir(), 'medadhere-medlineplus-'));
  roots.push(root);
  const releaseRoot = `third-party-data/medlineplus/${releaseId}`;
  const xmlPath = `${releaseRoot}/health-topics.xml`;
  const termsPath = `${releaseRoot}/TERMS.html`;
  const transformPath = `${releaseRoot}/import-transform.ts`;
  const terms = '<html>reviewed MedlinePlus terms</html>';
  const transform = '// reviewed field allowlist and text transform';
  write(root, xmlPath, TOPICS_XML);
  write(root, termsPath, terms);
  write(root, transformPath, transform);
  return {
    root,
    manifest: {
      manifestVersion: 1,
      source: 'medlineplus',
      releaseId,
      activation: { status: 'active', reason: null },
      provenance: {
        publisher: 'U.S. National Library of Medicine',
        sourceUrl: 'https://medlineplus.gov/xml.html',
        releaseUrl: 'https://medlineplus.gov/xml.html',
        retrievedAt: '2026-08-11T00:00:00Z',
        freshUntil: '2026-09-10T00:00:00Z',
        transformation: {
          status: 'applied',
          scriptPath: transformPath,
          scriptSha256: sha256(transform),
          inputLogicalNames: ['health-topics.xml'],
          notes: 'Only NLM-authored topic metadata and full summaries are transformed.',
        },
      },
      licences: [
        {
          subject: 'NLM-authored MedlinePlus health topics',
          status: 'cleared',
          licenceId: 'LicenseRef-US-Federal-Public-Domain',
          termsUrl: 'https://medlineplus.gov/about/using/usingcontent/',
          termsSnapshotPath: termsPath,
          termsSnapshotSha256: sha256(terms),
          redistribution: 'allowed',
          commercialUse: 'allowed',
          shareAlike: false,
          patientFacingUse: 'allowed',
          modelProcessing: 'allowed',
          attribution: 'Source: MedlinePlus.gov, National Library of Medicine.',
          notes: 'Only the allowlisted public-domain topic fields are included.',
        },
      ],
      scope: {
        included: ['topic metadata, vocabulary, full summary, and related topic IDs'],
        excluded: ['site records, linked third-party bodies, ASHP, A.D.A.M., and media'],
      },
      expectedFiles: ['health-topics.xml'],
      files: [
        {
          logicalName: 'health-topics.xml',
          path: xmlPath,
          sourceUrl: 'https://medlineplus.gov/xml.html',
          kind: 'raw',
          sha256: sha256(TOPICS_XML),
          bytes: Buffer.byteLength(TOPICS_XML),
          rowCount: 2,
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

describe('loadFrozenMedlinePlusRelease', () => {
  it('keeps only allowlisted topic fields and excludes site-record content', () => {
    const value = fixture('parse-v1');
    const bundle = loadFrozenMedlinePlusRelease(value.root, value.manifest);
    expect(bundle.topicCount).toBe(2);
    expect(bundle.evidence).toHaveLength(2);
    expect(bundle.evidence[0]).toMatchObject({
      code: 'medlineplus-100-1',
      language: 'en',
      sourceUrl: 'https://medlineplus.gov/highbloodpressure.html',
      tags: expect.arrayContaining([
        'condition:medlineplus:100',
        'condition:mesh:d006973',
        'synonym:hypertension',
        'related:medlineplus:200',
      ]),
    });
    expect(bundle.evidence[0]?.passage).toContain('High blood pressure usually has no symptoms.');
    expect(bundle.evidence.map((row) => row.passage).join(' ')).not.toContain('DO NOT INGEST');
    expect(bundle.evidence[1]?.language).toBe('es');
  });

  it('counts a valid topic with no NLM summary but creates no empty evidence row', () => {
    const value = fixture('empty-summary');
    const xml = TOPICS_XML.replace('total="2"', 'total="3"').replace(
      '</health-topics>',
      '  <health-topic title="Adhesions" url="https://medlineplus.gov/adhesions.html" id="3920" language="English"><full-summary></full-summary></health-topic>\n</health-topics>',
    );
    const path = value.manifest.files[0]!.path;
    write(value.root, path, xml);
    const manifest = {
      ...value.manifest,
      files: value.manifest.files.map((file) => ({
        ...file,
        sha256: sha256(xml),
        bytes: Buffer.byteLength(xml),
        rowCount: 3,
      })),
    };
    const bundle = loadFrozenMedlinePlusRelease(value.root, manifest);
    expect(bundle.topicCount).toBe(3);
    expect(bundle.evidence).toHaveLength(2);
  });

  it('chunks every direct-evidence passage so the credited SMS template fits', () => {
    const value = fixture('sms-bounded');
    const longSummary = Array.from({ length: 400 }, () => 'headache').join(' ');
    const xml = TOPICS_XML.replace(
      'High blood pressure usually has no symptoms.&lt;/p&gt;&lt;p&gt;Your clinician can check it.',
      longSummary,
    );
    const path = value.manifest.files[0]!.path;
    write(value.root, path, xml);
    const manifest = {
      ...value.manifest,
      files: value.manifest.files.map((file) => ({
        ...file,
        sha256: sha256(xml),
        bytes: Buffer.byteLength(xml),
      })),
    };
    const bundle = loadFrozenMedlinePlusRelease(value.root, manifest);

    for (const row of bundle.evidence) {
      const claim = renderClinicalClaim({
        evidence: {
          evidenceId: row.code,
          source: 'medlineplus',
          sourceReleaseId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          sourceVersion: manifest.releaseId,
          title: row.code,
          passage: row.passage,
          url: row.sourceUrl,
          language: row.language,
          coverageState: 'direct_evidence',
          allowedTemplateIds: ['medlineplus-summary-v1'],
        },
        templateId: 'medlineplus-summary-v1',
        language: row.language,
        sourceChecksumSha256: 'a'.repeat(64),
      });
      expect(claim?.text.length).toBeLessThanOrEqual(320);
    }
  });

  it('fails closed on a manifest topic-count mismatch', () => {
    const value = fixture('bad-count');
    const manifest = {
      ...value.manifest,
      files: value.manifest.files.map((file) => ({ ...file, rowCount: 3 })),
    };
    expect(() => loadFrozenMedlinePlusRelease(value.root, manifest)).toThrow(/row count/i);
  });
});

describe('activateMedlinePlusRelease', () => {
  it('dry-runs without writes, then imports bounded evidence atomically on explicit apply', async () => {
    const value = fixture('activation-v1');
    const bundle = loadFrozenMedlinePlusRelease(value.root, value.manifest);
    expect(await activateMedlinePlusRelease(client, bundle)).toEqual({
      mode: 'dry-run',
      topics: 2,
      evidence: 2,
    });
    expect(
      (
        await client.query(
          "SELECT 1 FROM source_release WHERE source_name = 'medlineplus' AND release_version = $1",
          [value.manifest.releaseId],
        )
      ).rowCount,
    ).toBe(0);

    const applied = await activateMedlinePlusRelease(client, bundle, true);
    expect(applied.mode).toBe('applied');
    const stored = await client.query<{
      evidence_code: string;
      coverage_state: string;
      tags: string[];
    }>(
      `SELECT er.evidence_code, er.coverage_state, er.tags
         FROM evidence_record er
         JOIN source_release sr ON sr.id = er.source_release_id
        WHERE sr.release_version = $1
        ORDER BY er.evidence_code`,
      [value.manifest.releaseId],
    );
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows[0]).toMatchObject({
      evidence_code: 'medlineplus-100-1',
      coverage_state: 'direct_evidence',
    });
  });
});

describe('runMedlinePlusImportCli', () => {
  it('does not open a database unless --apply is explicit', async () => {
    const value = fixture('cli-dry-run');
    let databaseCalls = 0;
    const exitCode = await runMedlinePlusImportCli(['--manifest', 'MANIFEST.json'], {
      repositoryRoot: value.root,
      readManifest: () => value.manifest,
      withClient: async () => {
        databaseCalls += 1;
        throw new Error('database must not be opened');
      },
      log: () => undefined,
      error: () => undefined,
    });
    expect(exitCode).toBe(0);
    expect(databaseCalls).toBe(0);
  });
});
