import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { SourceReleaseManifest } from '@medadhere/shared';
import { activateCcddRelease, loadFrozenCcddRelease } from './import-ccdd-release.js';
import { sha256 } from './source-release-import.js';

const SCHEMA_SQL = readFileSync(
  join(process.cwd(), 'backend', 'src', 'schema-init', 'schema.sql'),
  'utf8',
);
const TIMEOUT_MS = 180_000;
const roots: string[] = [];
let container: StartedPostgreSqlContainer | undefined;
let client: Client;

const files = {
  'mp.csv':
    'mp_code,mp_formal_name,mp_en_description,mp_fr_description,mp_status,mp_status_effective_time,mp_type,Health_Canada_identifier,Health_Canada_product_name\n"02500001","TEST PRODUCT (ingredient 10 mg tablet)","NA","PRODUIT TEST (ingrédient 10 mg comprimé)","Active","20260801","DIN","02500001","TEST PRODUCT"\n',
  'ntp.csv':
    'ntp_code,ntp_formal_name,ntp_en_description,ntp_fr_description,ntp_status,ntp_status_effective_time,ntp_type\n"9000001","ingredient 10 mg oral tablet","NA","ingrédient 10 mg comprimé oral","Active","20260801","NA"\n',
  'tm.csv':
    'tm_code,tm_formal_name,tm_fr_description,tm_status,tm_status_effective_time\n"8000001","ingredient","ingrédient","Active","20260801"\n',
  'mp-ntp-tm-en.csv':
    'mp_code,mp_formal_name,ntp_code,ntp_formal_name,tm_code,tm_formal_name\n"02500001","TEST PRODUCT","9000001","ingredient 10 mg oral tablet","8000001","ingredient"\n',
  'mp-ntp-tm-fr.csv':
    'mp_code,mp_fr_description,ntp_code,ntp_fr_description,tm_code,tm_fr_description\n"02500001","PRODUIT TEST","9000001","ingrédient 10 mg comprimé oral","8000001","ingrédient"\n',
} as const;

const reviewedBridge = JSON.stringify(
  [
    {
      din: '02500001',
      ccddProductCode: '02500001',
      ingredientOrder: 1,
      ingredientName: 'ingredient',
      ccddIngredientCode: '8000001',
      rxcui: '12345',
      reviewedBy: 'fixture-reviewer',
      reviewedAt: '2026-08-11T00:00:00Z',
    },
  ],
  null,
  2,
);

function write(root: string, path: string, value: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, value);
}

function fixture(releaseId: string): { root: string; manifest: SourceReleaseManifest } {
  const root = mkdtempSync(join(tmpdir(), 'medadhere-ccdd-'));
  roots.push(root);
  const releaseRoot = `third-party-data/ccdd/${releaseId}`;
  const termsPath = `${releaseRoot}/TERMS.txt`;
  const transformPath = 'scripts/import-ccdd-release.ts';
  const terms = 'Exact OGL Canada reviewed terms.';
  write(root, termsPath, terms);
  write(root, transformPath, '// fixture transform');
  for (const [name, contents] of Object.entries(files))
    write(root, `${releaseRoot}/${name}`, contents);
  write(root, `${releaseRoot}/reviewed-identity-bridge.json`, reviewedBridge);
  return {
    root,
    manifest: {
      manifestVersion: 1,
      source: 'ccdd',
      releaseId,
      activation: { status: 'active', reason: null },
      provenance: {
        publisher: 'Health Canada',
        sourceUrl: 'https://open.canada.ca/data/en/dataset/3e0a7b9e-a5e9-4131-bde4-ac685a1f1a38',
        releaseUrl: 'https://health-products.canada.ca/ccdd/Release_Notes',
        retrievedAt: '2026-08-11T00:00:00Z',
        freshUntil: '2026-09-10T00:00:00Z',
        transformation: {
          status: 'applied',
          scriptPath: transformPath,
          scriptSha256: sha256('// fixture transform'),
          inputLogicalNames: [...Object.keys(files), 'reviewed-identity-bridge.json'],
          notes: 'Exact reviewed CCDD CSV schema.',
        },
      },
      licences: [
        {
          subject: 'Health Canada CCDD release data',
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
          notes: 'CCDD data only.',
        },
      ],
      scope: {
        included: ['MP, NTP, TM, DIN, and bilingual relations'],
        excluded: ['device NTP and special groupings'],
      },
      expectedFiles: [...Object.keys(files), 'reviewed-identity-bridge.json'],
      files: [
        ...Object.entries(files).map(([name, contents]) => ({
          logicalName: name,
          path: `${releaseRoot}/${name}`,
          sourceUrl: `https://health-products.canada.ca/ccdd/${name}`,
          kind: 'raw' as const,
          sha256: sha256(contents),
          bytes: Buffer.byteLength(contents),
          rowCount: 1,
          redistribution: 'allowed' as const,
        })),
        {
          logicalName: 'reviewed-identity-bridge.json',
          path: `${releaseRoot}/reviewed-identity-bridge.json`,
          sourceUrl: 'https://www.nlm.nih.gov/research/umls/rxnorm/',
          kind: 'derived' as const,
          sha256: sha256(reviewedBridge),
          bytes: Buffer.byteLength(reviewedBridge),
          rowCount: 1,
          redistribution: 'allowed' as const,
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

describe('loadFrozenCcddRelease', () => {
  it('preserves all three concept kinds, DIN, French names, and both relation languages', () => {
    const value = fixture('ccdd-v1');
    const bundle = loadFrozenCcddRelease(value.root, value.manifest);
    expect(bundle.concepts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'mp', code: '02500001', din: '02500001' }),
        expect.objectContaining({
          kind: 'ntp',
          code: '9000001',
          displayNameFr: 'ingrédient 10 mg comprimé oral',
        }),
        expect.objectContaining({ kind: 'tm', code: '8000001', displayNameEn: 'ingredient' }),
      ]),
    );
    expect(bundle.relations.map((row) => row.language)).toEqual(['en', 'fr']);
    expect(bundle.identityBridges).toEqual([
      expect.objectContaining({
        din: '02500001',
        ccddIngredientCode: '8000001',
        rxcui: '12345',
      }),
    ]);
  });

  it('rejects a reviewed bridge that does not match the frozen CCDD product relation', () => {
    const value = fixture('ccdd-bad-bridge');
    const bridgeFile = value.manifest.files.find(
      (file) => file.logicalName === 'reviewed-identity-bridge.json',
    )!;
    const bad = reviewedBridge.replace('8000001', '8000999');
    write(value.root, bridgeFile.path, bad);
    const manifest = {
      ...value.manifest,
      files: value.manifest.files.map((entry) =>
        entry.logicalName === bridgeFile.logicalName
          ? { ...entry, sha256: sha256(bad), bytes: Buffer.byteLength(bad) }
          : entry,
      ),
    };
    expect(() => loadFrozenCcddRelease(value.root, manifest)).toThrow(/bridge/i);
  });

  it('fails closed on an unexpected header or row count', () => {
    const value = fixture('ccdd-bad');
    const file = value.manifest.files[0]!;
    const bad = readFileSync(join(value.root, file.path), 'utf8').replace('mp_code', 'wrong');
    write(value.root, file.path, bad);
    const manifest = {
      ...value.manifest,
      files: value.manifest.files.map((entry) =>
        entry.logicalName === file.logicalName
          ? { ...entry, sha256: sha256(bad), bytes: Buffer.byteLength(bad) }
          : entry,
      ),
    };
    expect(() => loadFrozenCcddRelease(value.root, manifest)).toThrow(/header/i);
  });
});

describe('activateCcddRelease', () => {
  it('dry-runs without writes and atomically activates the identity catalog on apply', async () => {
    const value = fixture('ccdd-activation');
    const bundle = loadFrozenCcddRelease(value.root, value.manifest);
    expect(await activateCcddRelease(client, bundle)).toEqual({
      mode: 'dry-run',
      validatedConcepts: 3,
      validatedRelations: 2,
      identityBridges: 1,
    });
    const applied = await activateCcddRelease(client, bundle, true);
    expect(applied.mode).toBe('applied');
    const counts = await client.query<{
      bridges: string;
      bridge_licence_boundary: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM medication_identity_bridge b JOIN source_release s ON s.id = b.source_release_id WHERE s.release_version = $1) AS bridges,
         (SELECT licence_boundary FROM source_release_file f JOIN source_release s ON s.id = f.source_release_id WHERE s.release_version = $1 AND f.file_name = 'reviewed-identity-bridge.json') AS bridge_licence_boundary`,
      [value.manifest.releaseId],
    );
    expect(counts.rows[0]).toEqual({
      bridges: '1',
      bridge_licence_boundary: 'reviewed-derived-factual-map',
    });
  });
});
