import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { SourceReleaseManifest } from '@medadhere/shared';
import {
  activateHealthCanadaRelease,
  loadFrozenHealthCanadaRelease,
} from './import-health-canada-release.js';
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
  const root = mkdtempSync(join(tmpdir(), 'medadhere-health-canada-'));
  roots.push(root);
  const releaseRoot = `third-party-data/health-canada/${releaseId}`;
  const metadataPath = `${releaseRoot}/dpd-product-metadata.json`;
  const termsPath = `${releaseRoot}/TERMS.txt`;
  const transformPath = 'scripts/import-health-canada-release.ts';
  const metadata = JSON.stringify({
    reviewedAt: '2026-08-11T00:00:00Z',
    reviewedBy: 'MedAdhere source review',
    entries: [
      {
        metadataCode: 'dpd-5818-2026-07-10',
        drugCode: 5818,
        din: '00618632',
        brandName: 'APO-METOPROLOL',
        className: 'Human',
        ingredientNames: ['METOPROLOL TARTRATE'],
        dosageForms: ['Tablet'],
        routes: ['Oral'],
        atcCodes: ['C07AB02'],
        status: 'Marketed',
        statusDate: '1984-12-31',
        dpdLastUpdatedDate: '2026-08-06',
        monographDate: '2026-07-10',
        productPageUrl: 'https://health-products.canada.ca/dpd-bdpp/info?code=5818&lang=eng',
        monographUrl: 'https://pdf.hres.ca/dpd_pm/00085409.PDF',
      },
    ],
  });
  const terms = 'Exact reviewed Health Canada DPD metadata licence boundary.';
  write(root, metadataPath, metadata);
  write(root, termsPath, terms);
  write(root, transformPath, '// fixture transform');
  return {
    root,
    manifest: {
      manifestVersion: 1,
      source: 'health_canada',
      releaseId,
      activation: { status: 'active', reason: null },
      provenance: {
        publisher: 'Health Canada',
        sourceUrl: 'https://health-products.canada.ca/api/documentation/dpd-documentation-en.html',
        releaseUrl: 'https://health-products.canada.ca/api/drug/',
        retrievedAt: '2026-08-11T00:00:00Z',
        freshUntil: '2026-08-18T00:00:00Z',
        transformation: {
          status: 'applied',
          scriptPath: transformPath,
          scriptSha256: sha256('// fixture transform'),
          inputLogicalNames: ['dpd-product-metadata.json'],
          notes: 'Strictly validates reviewed DPD and product-monograph metadata.',
        },
      },
      licences: [
        {
          subject: 'Selected Health Canada DPD metadata',
          status: 'cleared',
          licenceId: 'OGL-Canada-2.0',
          termsUrl: 'https://open.canada.ca/en/open-government-licence-canada',
          termsSnapshotPath: termsPath,
          termsSnapshotSha256: sha256(terms),
          redistribution: 'allowed',
          commercialUse: 'allowed',
          shareAlike: false,
          patientFacingUse: 'allowed',
          modelProcessing: 'allowed',
          attribution: 'Contains information licensed under the Open Government Licence - Canada.',
          notes: 'Sponsor-authored product-monograph bodies are excluded.',
        },
      ],
      scope: {
        included: ['reviewed DPD product and product-monograph metadata'],
        excluded: ['product-monograph bodies and unreviewed clinical passages'],
      },
      expectedFiles: ['dpd-product-metadata.json'],
      files: [
        {
          logicalName: 'dpd-product-metadata.json',
          path: metadataPath,
          sourceUrl: 'https://health-products.canada.ca/api/drug/',
          kind: 'derived',
          sha256: sha256(metadata),
          bytes: Buffer.byteLength(metadata),
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
  await client.query(SCHEMA_SQL);
}, TIMEOUT_MS);

afterAll(async () => {
  await client?.end();
  await container?.stop();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('loadFrozenHealthCanadaRelease', () => {
  it('accepts exact reviewed metadata without copying monograph text', () => {
    const value = fixture('dpd-v1');
    expect(loadFrozenHealthCanadaRelease(value.root, value.manifest).evidence).toEqual([
      expect.objectContaining({
        code: 'dpd-5818-2026-07-10',
        sourceUrl: 'https://pdf.hres.ca/dpd_pm/00085409.PDF',
        tags: ['din:00618632'],
      }),
    ]);
  });

  it('rejects non-official URLs and duplicate DIN rows', () => {
    const value = fixture('dpd-invalid');
    const file = value.manifest.files[0]!;
    const parsed = JSON.parse(readFileSync(join(value.root, file.path), 'utf8')) as {
      entries: Array<Record<string, unknown>>;
    };
    parsed.entries.push({ ...parsed.entries[0], monographUrl: 'https://example.com/file.pdf' });
    const changed = JSON.stringify(parsed);
    write(value.root, file.path, changed);
    const manifest = {
      ...value.manifest,
      files: [
        {
          ...file,
          sha256: sha256(changed),
          bytes: Buffer.byteLength(changed),
          rowCount: 2,
        },
      ],
    };
    expect(() => loadFrozenHealthCanadaRelease(value.root, manifest)).toThrow();
  });
});

describe('activateHealthCanadaRelease', () => {
  it('dry-runs without writes and imports clinician-only candidate metadata on apply', async () => {
    const value = fixture('dpd-activation');
    const bundle = loadFrozenHealthCanadaRelease(value.root, value.manifest);
    expect(await activateHealthCanadaRelease(client, bundle)).toEqual({
      mode: 'dry-run',
      evidence: 1,
    });

    await activateHealthCanadaRelease(client, bundle, true);
    const stored = await client.query<{
      evidence_kind: string;
      coverage_state: string;
      tags: string[];
      source_url: string;
      licence_boundary: string;
    }>(
      `SELECT er.evidence_kind, er.coverage_state, er.tags, er.source_url,
              srf.licence_boundary
         FROM evidence_record er
         JOIN source_release sr ON sr.id = er.source_release_id
         JOIN source_release_file srf ON srf.source_release_id = sr.id
        WHERE sr.release_version = $1`,
      [value.manifest.releaseId],
    );
    expect(stored.rows).toEqual([
      {
        evidence_kind: 'monograph',
        coverage_state: 'candidate_only',
        tags: ['din:00618632'],
        source_url: 'https://pdf.hres.ca/dpd_pm/00085409.PDF',
        licence_boundary: 'OGL-Canada-2.0',
      },
    ]);
  });
});
