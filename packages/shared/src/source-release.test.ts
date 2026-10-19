import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceReleaseManifestSchema, type SourceReleaseManifest } from './index.js';

const HASH = 'a'.repeat(64);
const THIRD_PARTY_ROOT = join(process.cwd(), 'third-party-data');

function activeManifest(): unknown {
  return {
    manifestVersion: 1,
    source: 'ccdd',
    releaseId: '2026-06',
    activation: { status: 'active', reason: null },
    provenance: {
      publisher: 'Health Canada',
      sourceUrl: 'https://open.canada.ca/data/en/dataset/3e0a7b9e-a5e9-4131-bde4-ac685a1f1a38',
      releaseUrl: 'https://health-products.canada.ca/ccdd/Release_Notes',
      retrievedAt: '2026-08-09T00:00:00Z',
      freshUntil: '2026-09-08T00:00:00Z',
      transformation: {
        status: 'none',
        scriptPath: null,
        scriptSha256: null,
        inputLogicalNames: [],
        notes: 'Raw release file; no transformation.',
      },
    },
    licences: [
      {
        subject: 'CCDD release data',
        status: 'cleared',
        licenceId: 'OGL-Canada-2.0',
        termsUrl: 'https://open.canada.ca/en/open-government-licence-canada',
        termsSnapshotPath: 'third-party-data/ccdd/2026-06/LICENSE.txt',
        termsSnapshotSha256: HASH,
        redistribution: 'allowed',
        commercialUse: 'allowed',
        shareAlike: false,
        patientFacingUse: 'allowed',
        modelProcessing: 'allowed',
        attribution: 'Contains information licensed under the Open Government Licence - Canada.',
        notes: 'Applies only to the selected Health Canada CCDD release files.',
      },
    ],
    scope: {
      included: ['Manufactured Product data'],
      excluded: ['third-party material identified as excluded by the OGL'],
    },
    expectedFiles: ['mp.csv'],
    files: [
      {
        logicalName: 'mp.csv',
        path: 'third-party-data/ccdd/2026-06/mp.csv',
        sourceUrl: 'https://health-products.canada.ca/ccdd/mp',
        kind: 'raw',
        sha256: HASH,
        bytes: 1,
        rowCount: 1,
        redistribution: 'allowed',
      },
    ],
  };
}

function readManifest(source: string, release: string): unknown {
  return JSON.parse(readFileSync(join(THIRD_PARTY_ROOT, source, release, 'MANIFEST.json'), 'utf8'));
}

describe('sourceReleaseManifestSchema', () => {
  it('accepts a complete active release', () => {
    const parsed: SourceReleaseManifest = sourceReleaseManifestSchema.parse(activeManifest());
    expect(parsed).toMatchObject({
      source: 'ccdd',
      activation: { status: 'active' },
    });
  });

  it('supports a separately bounded Health Canada evidence release', () => {
    const manifest = { ...(activeManifest() as object), source: 'health_canada' };
    expect(sourceReleaseManifestSchema.parse(manifest).source).toBe('health_canada');
  });

  it('is strict at the manifest and nested contract boundaries', () => {
    const base = activeManifest() as Record<string, unknown>;
    expect(sourceReleaseManifestSchema.safeParse({ ...base, surprise: true }).success).toBe(false);

    const activation = base.activation as Record<string, unknown>;
    expect(
      sourceReleaseManifestSchema.safeParse({
        ...base,
        activation: { ...activation, implicitApproval: true },
      }).success,
    ).toBe(false);
  });

  it('rejects active releases with missing licence, provenance, checksum, or activation facts', () => {
    const base = activeManifest() as Record<string, unknown>;
    const provenance = base.provenance as Record<string, unknown>;
    const [licence] = base.licences as Array<Record<string, unknown>>;
    const [file] = base.files as Array<Record<string, unknown>>;

    expect(sourceReleaseManifestSchema.safeParse({ ...base, activation: undefined }).success).toBe(
      false,
    );
    expect(
      sourceReleaseManifestSchema.safeParse({
        ...base,
        provenance: { ...provenance, retrievedAt: null },
      }).success,
    ).toBe(false);
    expect(
      sourceReleaseManifestSchema.safeParse({
        ...base,
        provenance: { ...provenance, freshUntil: null },
      }).success,
    ).toBe(false);
    expect(
      sourceReleaseManifestSchema.safeParse({
        ...base,
        provenance: { ...provenance, freshUntil: '2026-08-08T00:00:00Z' },
      }).success,
    ).toBe(false);
    expect(
      sourceReleaseManifestSchema.safeParse({
        ...base,
        licences: [{ ...licence, termsSnapshotSha256: null }],
      }).success,
    ).toBe(false);
    expect(
      sourceReleaseManifestSchema.safeParse({
        ...base,
        licences: [{ ...licence, termsSnapshotPath: null }],
      }).success,
    ).toBe(false);
    expect(
      sourceReleaseManifestSchema.safeParse({
        ...base,
        files: [{ ...file, sha256: undefined }],
      }).success,
    ).toBe(false);
  });

  it('rejects active releases that are incomplete, review-required, or ambiguously licensed', () => {
    const base = activeManifest() as Record<string, unknown>;
    const [licence] = base.licences as Array<Record<string, unknown>>;
    const [file] = base.files as Array<Record<string, unknown>>;

    expect(sourceReleaseManifestSchema.safeParse({ ...base, files: [] }).success).toBe(false);
    expect(
      sourceReleaseManifestSchema.safeParse({
        ...base,
        licences: [{ ...licence, status: 'review_required', licenceId: null }],
      }).success,
    ).toBe(false);
    expect(
      sourceReleaseManifestSchema.safeParse({
        ...base,
        files: [{ ...file, redistribution: 'review_required' }],
      }).success,
    ).toBe(false);
  });

  it('supports an explicit review-required release without fake downloaded-file checksums', () => {
    const base = activeManifest() as Record<string, unknown>;
    const provenance = base.provenance as Record<string, unknown>;
    const [licence] = base.licences as Array<Record<string, unknown>>;
    const parsed = sourceReleaseManifestSchema.parse({
      ...base,
      activation: { status: 'review_required', reason: 'Release files have not been frozen.' },
      provenance: { ...provenance, retrievedAt: null, freshUntil: null },
      licences: [
        {
          ...licence,
          status: 'review_required',
          licenceId: null,
          termsSnapshotPath: null,
          termsSnapshotSha256: null,
          redistribution: 'review_required',
          commercialUse: 'review_required',
          shareAlike: null,
          patientFacingUse: 'review_required',
          modelProcessing: 'review_required',
        },
      ],
      files: [],
    });

    expect(parsed.files).toEqual([]);
    expect(parsed.activation.status).toBe('review_required');
  });

  it('rejects duplicate or unexpected file identities and unsafe repository paths', () => {
    const base = activeManifest() as Record<string, unknown>;
    const [file] = base.files as Array<Record<string, unknown>>;

    expect(
      sourceReleaseManifestSchema.safeParse({
        ...base,
        expectedFiles: ['mp.csv', 'mp.csv'],
      }).success,
    ).toBe(false);
    expect(
      sourceReleaseManifestSchema.safeParse({
        ...base,
        files: [file, { ...file }],
      }).success,
    ).toBe(false);
    expect(
      sourceReleaseManifestSchema.safeParse({
        ...base,
        files: [{ ...file, logicalName: 'not-expected.csv' }],
      }).success,
    ).toBe(false);
    expect(
      sourceReleaseManifestSchema.safeParse({
        ...base,
        files: [{ ...file, path: '../outside.csv' }],
      }).success,
    ).toBe(false);
  });
});

describe('committed source release metadata', () => {
  const manifests = {
    ccdd: readManifest('ccdd', '2026-06'),
    ccddActive: readManifest('ccdd', '2026-08-05'),
    ddinterPending: readManifest('ddinter', 'release-pending'),
    ddinter: readManifest('ddinter', '2026-08-11'),
    healthCanada: readManifest('health-canada', 'release-pending'),
    healthCanadaActive: readManifest('health-canada', 'reviewed-dpd-2026-08-11'),
    medlineplus: readManifest('medlineplus', '2026-08-08'),
    openfda: readManifest('openfda', 'release-pending'),
    openfdaActive: readManifest('openfda', 'reviewed-labels-2026-08-11'),
    onsides: readManifest('onsides', 'v3.1.1'),
  } as const;

  it('parses every manifest and keeps unresolved releases fail-closed', () => {
    for (const [source, manifest] of Object.entries({
      ccdd: manifests.ccdd,
      ddinter: manifests.ddinterPending,
      health_canada: manifests.healthCanada,
      openfda: manifests.openfda,
      onsides: manifests.onsides,
    })) {
      const parsed = sourceReleaseManifestSchema.parse(manifest);
      expect(parsed.source).toBe(source);
      expect(parsed.activation.status).not.toBe('active');
      expect(parsed.activation.reason).toBeTruthy();
    }
  });

  it('pins the CCDD Open Government Licence boundary and complete identity file set', () => {
    const parsed = sourceReleaseManifestSchema.parse(manifests.ccddActive);
    expect(parsed.activation.status).toBe('active');
    expect(parsed.licences[0]?.licenceId).toBe('OGL-Canada-2.0');
    expect(parsed.expectedFiles).toEqual(
      expect.arrayContaining([
        'mp.csv',
        'ntp.csv',
        'tm.csv',
        'mp-ntp-tm-en.csv',
        'mp-ntp-tm-fr.csv',
      ]),
    );
  });

  it('keeps DDInter inside the noncommercial share-alike downloadable-DDI boundary', () => {
    const parsed = sourceReleaseManifestSchema.parse(manifests.ddinter);
    const licence = parsed.licences[0];
    expect(licence?.licenceId).toBe('CC-BY-NC-SA-4.0');
    expect(licence?.commercialUse).toBe('prohibited');
    expect(licence?.shareAlike).toBe(true);
    expect(parsed.activation.status).toBe('active');
    expect(parsed.files).toHaveLength(9);
    expect(parsed.scope.excluded).toContain('model processing');
  });

  it('allows only NLM-authored MedlinePlus health-topic fields and requires source credit', () => {
    const parsed = sourceReleaseManifestSchema.parse(manifests.medlineplus);
    expect(parsed.activation.status).toBe('active');
    expect(parsed.files).toHaveLength(1);
    expect(parsed.scope.excluded.join(' ')).toMatch(/A\.D\.A\.M\.|ASHP|image/i);
    expect(parsed.licences[0]?.attribution).toMatch(/MedlinePlus.*National Library of Medicine/i);
  });

  it('keeps the generic openFDA placeholder inactive', () => {
    const parsed = sourceReleaseManifestSchema.parse(manifests.openfda);
    expect(parsed.activation.status).toBe('inactive');
    expect(parsed.licences[0]).toMatchObject({
      status: 'review_required',
      licenceId: null,
      patientFacingUse: 'review_required',
    });
  });

  it('activates only the bounded reviewed openFDA label selection', () => {
    const parsed = sourceReleaseManifestSchema.parse(manifests.openfdaActive);
    expect(parsed.activation.status).toBe('active');
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.rowCount).toBe(6);
  });

  it('activates only reviewed Health Canada metadata and excludes monograph bodies', () => {
    const parsed = sourceReleaseManifestSchema.parse(manifests.healthCanadaActive);
    expect(parsed.activation.status).toBe('active');
    expect(parsed.files[0]?.rowCount).toBe(6);
    expect(parsed.scope.excluded.join(' ')).toMatch(/monograph bodies/i);
  });

  it('pins the current OnSIDES derivative but makes no MIT or CC BY dataset claim', () => {
    const parsed = sourceReleaseManifestSchema.parse(manifests.onsides);
    const [file] = parsed.files;
    const bytes = readFileSync(join(process.cwd(), file!.path));
    const actualSha256 = createHash('sha256').update(bytes).digest('hex');

    expect(parsed.activation.status).toBe('review_required');
    expect(parsed.licences[0]).toMatchObject({
      status: 'review_required',
      licenceId: null,
      patientFacingUse: 'prohibited',
      modelProcessing: 'prohibited',
    });
    expect(file).toMatchObject({
      sha256: actualSha256,
      bytes: bytes.length,
      rowCount: 53,
      redistribution: 'review_required',
    });
    expect(parsed.provenance.transformation).toMatchObject({
      status: 'applied',
      scriptPath: 'scripts/vendor-onsides.mjs',
    });
  });
});
