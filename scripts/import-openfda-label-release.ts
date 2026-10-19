import {
  renderClinicalClaim,
  sourceReleaseManifestSchema,
  type SourceReleaseManifest,
} from '@medadhere/shared';
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

const reviewedLabelsSchema = z
  .object({
    reviewedAt: z.string().datetime({ offset: true }),
    reviewedBy: z.string().trim().min(1).max(128),
    entries: z
      .array(
        z
          .object({
            evidenceCode: z.string().trim().min(1).max(128),
            rxcui: z.string().regex(/^\d{1,32}$/),
            setId: z.string().uuid(),
            effectiveTime: z.string().regex(/^\d{8}$/),
            passage: z.string().trim().min(1).max(320),
            sourceUrl: z
              .string()
              .url()
              .refine((url) => url.startsWith('https://dailymed.nlm.nih.gov/')),
            language: z.literal('en'),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

interface OpenFdaEvidence {
  readonly code: string;
  readonly passage: string;
  readonly sourceUrl: string;
  readonly tags: readonly string[];
}

export interface FrozenOpenFdaLabelRelease {
  readonly manifest: SourceReleaseManifest;
  readonly checksumSha256: string;
  readonly evidence: readonly OpenFdaEvidence[];
}

export function loadFrozenOpenFdaLabelRelease(
  repositoryRoot: string,
  input: unknown,
): FrozenOpenFdaLabelRelease {
  const manifest = sourceReleaseManifestSchema.parse(input);
  if (
    manifest.source !== 'openfda' ||
    manifest.activation.status !== 'active' ||
    manifest.files.length !== 1
  ) {
    throw new FrozenReleaseVerificationError('expected one active reviewed openFDA label file');
  }
  for (const licence of manifest.licences) {
    verifyFrozenFile(repositoryRoot, licence.termsSnapshotPath!, licence.termsSnapshotSha256!);
  }
  const transformation = manifest.provenance.transformation;
  if (transformation.status !== 'applied') {
    throw new FrozenReleaseVerificationError('openFDA labels require a reviewed transform');
  }
  verifyFrozenFile(repositoryRoot, transformation.scriptPath!, transformation.scriptSha256!);

  const file = manifest.files[0]!;
  const reviewed = reviewedLabelsSchema.parse(
    JSON.parse(
      verifyFrozenFile(repositoryRoot, file.path, file.sha256, file.bytes).toString('utf8'),
    ),
  );
  if (file.rowCount !== reviewed.entries.length) {
    throw new FrozenReleaseVerificationError('openFDA reviewed-label row count does not match');
  }
  if (
    new Set(reviewed.entries.map((entry) => entry.evidenceCode)).size !== reviewed.entries.length
  ) {
    throw new FrozenReleaseVerificationError('openFDA evidence codes must be unique');
  }

  for (const entry of reviewed.entries) {
    try {
      renderClinicalClaim({
        evidence: {
          evidenceId: entry.evidenceCode,
          source: 'openfda',
          sourceReleaseId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          sourceVersion: manifest.releaseId,
          title: entry.evidenceCode,
          passage: entry.passage,
          url: entry.sourceUrl,
          language: entry.language,
          coverageState: 'direct_evidence',
          allowedTemplateIds: ['direct-label-evidence-v1'],
        },
        templateId: 'direct-label-evidence-v1',
        language: entry.language,
        sourceChecksumSha256: 'a'.repeat(64),
      });
    } catch {
      throw new FrozenReleaseVerificationError('an openFDA passage cannot render safely');
    }
  }

  return Object.freeze({
    manifest,
    checksumSha256: releaseChecksum(manifest),
    evidence: Object.freeze(
      reviewed.entries.map((entry) => ({
        code: entry.evidenceCode,
        passage: entry.passage,
        sourceUrl: entry.sourceUrl,
        tags: Object.freeze([`rxcui:${entry.rxcui}`]),
      })),
    ),
  });
}

async function insertEvidence(
  client: SourceImportClient,
  releaseId: string,
  evidence: readonly OpenFdaEvidence[],
): Promise<void> {
  await insertEvidenceRecords(
    client,
    releaseId,
    evidence.map((row) => ({
      ...row,
      kind: 'label',
      language: 'en',
      coverageState: 'direct_evidence',
    })),
  );
}

export type OpenFdaLabelImportResult =
  | { readonly mode: 'dry-run'; readonly evidence: number }
  | { readonly mode: 'applied'; readonly releaseId: string; readonly evidence: number };

export async function activateOpenFdaLabelRelease(
  client: SourceImportClient,
  bundle: FrozenOpenFdaLabelRelease,
  apply = false,
): Promise<OpenFdaLabelImportResult> {
  if (!apply) return { mode: 'dry-run', evidence: bundle.evidence.length };
  const releaseId = await activateVerifiedSource({
    client,
    manifest: bundle.manifest,
    checksumSha256: bundle.checksumSha256,
    insertRows: (id) => insertEvidence(client, id, bundle.evidence),
  });
  return { mode: 'applied', releaseId, evidence: bundle.evidence.length };
}

export async function runOpenFdaLabelImportCli(
  argv: readonly string[],
  deps: SourceImportCliDeps<OpenFdaLabelImportResult>,
): Promise<number> {
  return runSourceImportCli(argv, deps, OPENFDA_CLI);
}

const OPENFDA_CLI: SourceImportCliConfig<FrozenOpenFdaLabelRelease, OpenFdaLabelImportResult> = {
  label: 'openfda-label-import',
  load: loadFrozenOpenFdaLabelRelease,
  apply: (client, bundle) => activateOpenFdaLabelRelease(client, bundle, true),
  dryRunLines: (bundle) => [
    `[openfda-label-import] dry-run verified: evidence=${bundle.evidence.length}; no database writes`,
  ],
  appliedLine: (result) => `[openfda-label-import] applied: evidence=${result.evidence}`,
};

if (typeof require !== 'undefined' && require.main === module) {
  void runSourceImportMain(process.argv.slice(2), OPENFDA_CLI).then(
    (exitCode) => (process.exitCode = exitCode),
  );
}
