import { sourceReleaseManifestSchema, type SourceReleaseManifest } from '@medadhere/shared';
import { z } from 'zod';
import {
  FrozenReleaseVerificationError,
  activateVerifiedSource,
  insertEvidenceRecords,
  releaseChecksum,
  runSourceImportCli,
  runSourceImportMain,
  verifyFrozenFile,
  type SourceImportCliConfig,
  type SourceImportCliDeps,
  type SourceImportClient,
} from './source-release-import.js';

interface NodeRequire {
  (id: string): unknown;
  main?: unknown;
}
declare const require: NodeRequire;
declare const module: unknown;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const reviewedMetadataSchema = z
  .object({
    reviewedAt: z.string().datetime({ offset: true }),
    reviewedBy: z.string().trim().min(1).max(128),
    entries: z
      .array(
        z
          .object({
            metadataCode: z.string().trim().min(1).max(128),
            drugCode: z.number().int().positive(),
            din: z.string().regex(/^\d{8}$/),
            brandName: z.string().trim().min(1).max(320),
            className: z.literal('Human'),
            ingredientNames: z.array(z.string().trim().min(1).max(320)).min(1).max(32),
            dosageForms: z.array(z.string().trim().min(1).max(80)).min(1).max(16),
            routes: z.array(z.string().trim().min(1).max(80)).min(1).max(16),
            atcCodes: z.array(z.string().trim().min(1).max(32)).min(1).max(16),
            status: z.literal('Marketed'),
            statusDate: dateSchema,
            dpdLastUpdatedDate: dateSchema,
            monographDate: dateSchema,
            productPageUrl: z.string().url(),
            monographUrl: z.string().url(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

interface HealthCanadaEvidence {
  readonly code: string;
  readonly passage: string;
  readonly sourceUrl: string;
  readonly tags: readonly string[];
}

export interface FrozenHealthCanadaRelease {
  readonly manifest: SourceReleaseManifest;
  readonly checksumSha256: string;
  readonly evidence: readonly HealthCanadaEvidence[];
}

export function loadFrozenHealthCanadaRelease(
  repositoryRoot: string,
  input: unknown,
): FrozenHealthCanadaRelease {
  const manifest = sourceReleaseManifestSchema.parse(input);
  if (
    manifest.source !== 'health_canada' ||
    manifest.activation.status !== 'active' ||
    manifest.files.length !== 1
  ) {
    throw new FrozenReleaseVerificationError('expected one active Health Canada metadata file');
  }
  for (const licence of manifest.licences) {
    verifyFrozenFile(repositoryRoot, licence.termsSnapshotPath!, licence.termsSnapshotSha256!);
  }
  const transformation = manifest.provenance.transformation;
  if (transformation.status !== 'applied') {
    throw new FrozenReleaseVerificationError(
      'Health Canada metadata requires a reviewed transform',
    );
  }
  verifyFrozenFile(repositoryRoot, transformation.scriptPath!, transformation.scriptSha256!);

  const file = manifest.files[0]!;
  const reviewed = reviewedMetadataSchema.parse(
    JSON.parse(
      verifyFrozenFile(repositoryRoot, file.path, file.sha256, file.bytes).toString('utf8'),
    ),
  );
  if (file.rowCount !== reviewed.entries.length) {
    throw new FrozenReleaseVerificationError('Health Canada metadata row count does not match');
  }
  if (
    new Set(reviewed.entries.map((entry) => entry.metadataCode)).size !== reviewed.entries.length ||
    new Set(reviewed.entries.map((entry) => entry.din)).size !== reviewed.entries.length
  ) {
    throw new FrozenReleaseVerificationError(
      'Health Canada metadata codes and DINs must be unique',
    );
  }

  const evidence = reviewed.entries.map((entry): HealthCanadaEvidence => {
    const expectedPage = `https://health-products.canada.ca/dpd-bdpp/info?code=${entry.drugCode}&lang=eng`;
    if (
      entry.productPageUrl !== expectedPage ||
      !/^https:\/\/pdf\.hres\.ca\/dpd_pm\/\d+\.PDF$/.test(entry.monographUrl)
    ) {
      throw new FrozenReleaseVerificationError('Health Canada metadata uses an unapproved URL');
    }
    return Object.freeze({
      code: entry.metadataCode,
      passage: `${entry.brandName}; DIN ${entry.din}; ${entry.status}; product monograph dated ${entry.monographDate}.`,
      sourceUrl: entry.monographUrl,
      tags: Object.freeze([`din:${entry.din}`]),
    });
  });

  return Object.freeze({
    manifest,
    checksumSha256: releaseChecksum(manifest),
    evidence: Object.freeze(evidence),
  });
}

async function insertEvidence(
  client: SourceImportClient,
  releaseId: string,
  evidence: readonly HealthCanadaEvidence[],
): Promise<void> {
  await insertEvidenceRecords(
    client,
    releaseId,
    evidence.map((row) => ({
      ...row,
      kind: 'monograph',
      language: 'en',
      coverageState: 'candidate_only',
    })),
  );
}

export type HealthCanadaImportResult =
  | { readonly mode: 'dry-run'; readonly evidence: number }
  | { readonly mode: 'applied'; readonly releaseId: string; readonly evidence: number };

export async function activateHealthCanadaRelease(
  client: SourceImportClient,
  bundle: FrozenHealthCanadaRelease,
  apply = false,
): Promise<HealthCanadaImportResult> {
  if (!apply) return { mode: 'dry-run', evidence: bundle.evidence.length };
  const releaseId = await activateVerifiedSource({
    client,
    manifest: bundle.manifest,
    checksumSha256: bundle.checksumSha256,
    insertRows: (id) => insertEvidence(client, id, bundle.evidence),
  });
  return { mode: 'applied', releaseId, evidence: bundle.evidence.length };
}

export async function runHealthCanadaImportCli(
  argv: readonly string[],
  deps: SourceImportCliDeps<HealthCanadaImportResult>,
): Promise<number> {
  return runSourceImportCli(argv, deps, HEALTH_CANADA_CLI);
}

const HEALTH_CANADA_CLI: SourceImportCliConfig<
  FrozenHealthCanadaRelease,
  HealthCanadaImportResult
> = {
  label: 'health-canada-import',
  load: loadFrozenHealthCanadaRelease,
  apply: (client, bundle) => activateHealthCanadaRelease(client, bundle, true),
  dryRunLines: (bundle) => [
    `[health-canada-import] dry-run verified: evidence=${bundle.evidence.length}; no database writes`,
  ],
  appliedLine: (result) => `[health-canada-import] applied: evidence=${result.evidence}`,
};

if (typeof require !== 'undefined' && require.main === module) {
  void runSourceImportMain(process.argv.slice(2), HEALTH_CANADA_CLI).then(
    (exitCode) => (process.exitCode = exitCode),
  );
}
