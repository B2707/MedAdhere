import { sourceReleaseManifestSchema, type SourceReleaseManifest } from '@medadhere/shared';
import { z } from 'zod';
import {
  FrozenReleaseVerificationError,
  activateVerifiedSource,
  parseCsvLine,
  releaseChecksum,
  runSourceImportCli,
  runSourceImportMain,
  verifyFrozenFile,
  type SourceImportCliConfig,
  type SourceImportCliDeps,
  type SourceImportClient,
} from './source-release-import.js';

export {
  FrozenReleaseVerificationError,
  SourceActivationConflictError,
} from './source-release-import.js';

type SqlClient = SourceImportClient;

const ddiRowSchema = z
  .object({
    lowDrugId: z.string().trim().min(1).max(64),
    lowDrugName: z.string().trim().min(1).max(320),
    highDrugId: z.string().trim().min(1).max(64),
    highDrugName: z.string().trim().min(1).max(320),
    level: z.enum(['contraindicated', 'major', 'moderate', 'minor', 'unknown']),
  })
  .strict()
  .refine((row) => row.lowDrugId < row.highDrugId, 'DDInter pairs must be canonical');

const reviewedMappingSchema = z
  .object({
    identitySystem: z.enum(['ccdd', 'rxnorm']),
    identityCode: z.string().trim().min(1).max(64),
    ddinterDrugId: z.string().trim().min(1).max(64).nullable(),
    mappingStatus: z.enum(['mapped', 'ambiguous', 'unmapped']),
    reviewedBy: z.string().trim().min(1).max(128),
    reviewedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((mapping) => (mapping.mappingStatus === 'mapped') === (mapping.ddinterDrugId !== null), {
    message: 'mapped status requires exactly one DDInter drug ID',
  });

const reviewedMappingsSchema = z.array(reviewedMappingSchema).max(100_000);
const EXPECTED_DDI_HEADER = ['DDInterID_A', 'Drug_A', 'DDInterID_B', 'Drug_B', 'Level'];
const INSERT_CHUNK_SIZE = 5_000;

interface DdinterDrug {
  readonly id: string;
  readonly displayName: string;
}

interface DdinterInteraction {
  readonly lowDrugId: string;
  readonly highDrugId: string;
  readonly level: z.infer<typeof ddiRowSchema>['level'];
}

type ReviewedMapping = z.infer<typeof reviewedMappingSchema>;

export interface FrozenDdinterRelease {
  readonly manifest: SourceReleaseManifest;
  readonly checksumSha256: string;
  readonly drugs: readonly DdinterDrug[];
  readonly interactions: readonly DdinterInteraction[];
  readonly mappings: readonly ReviewedMapping[];
}

function parseDdinterCsv(bytes: Buffer): readonly z.infer<typeof ddiRowSchema>[] {
  const lines = bytes
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  const header = parseCsvLine(lines[0] ?? '');
  if (
    header.length !== EXPECTED_DDI_HEADER.length ||
    header.some((cell, index) => cell !== EXPECTED_DDI_HEADER[index])
  ) {
    throw new FrozenReleaseVerificationError('CSV header is not the reviewed DDInter format');
  }
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    if (cells.length !== 5) {
      throw new FrozenReleaseVerificationError('CSV row has the wrong field count');
    }
    const [idA, nameA, idB, nameB, rawLevel] = cells.map((cell) => cell.trim());
    const canonical =
      idA! < idB!
        ? { lowDrugId: idA, lowDrugName: nameA, highDrugId: idB, highDrugName: nameB }
        : { lowDrugId: idB, lowDrugName: nameB, highDrugId: idA, highDrugName: nameA };
    const parsed = ddiRowSchema.safeParse({ ...canonical, level: rawLevel!.toLowerCase() });
    if (!parsed.success) throw new FrozenReleaseVerificationError('CSV row is invalid');
    return parsed.data;
  });
}

function aggregateDdinterRows(rows: readonly z.infer<typeof ddiRowSchema>[]): {
  readonly drugs: readonly DdinterDrug[];
  readonly interactions: readonly DdinterInteraction[];
} {
  const drugs = new Map<string, string>();
  const interactions = new Map<string, DdinterInteraction>();
  for (const row of rows) {
    for (const [id, name] of [
      [row.lowDrugId, row.lowDrugName],
      [row.highDrugId, row.highDrugName],
    ] as const) {
      const existingName = drugs.get(id);
      if (existingName !== undefined && existingName !== name) {
        throw new FrozenReleaseVerificationError('one DDInter drug ID has conflicting names');
      }
      drugs.set(id, name);
    }
    const key = `${row.lowDrugId}\u0000${row.highDrugId}`;
    const existing = interactions.get(key);
    if (existing && existing.level !== row.level) {
      throw new FrozenReleaseVerificationError('one DDInter pair has conflicting levels');
    }
    interactions.set(key, {
      lowDrugId: row.lowDrugId,
      highDrugId: row.highDrugId,
      level: row.level,
    });
  }
  return {
    drugs: Array.from(drugs, ([id, displayName]) => ({ id, displayName })).sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    interactions: Array.from(interactions.values()).sort((a, b) =>
      `${a.lowDrugId}\u0000${a.highDrugId}`.localeCompare(`${b.lowDrugId}\u0000${b.highDrugId}`),
    ),
  };
}

function assertUniqueMappings(mappings: readonly ReviewedMapping[]): void {
  const identities = mappings.map((mapping) => `${mapping.identitySystem}:${mapping.identityCode}`);
  if (new Set(identities).size !== identities.length) {
    throw new FrozenReleaseVerificationError('reviewed mappings contain a duplicate identity');
  }
}

/** Verify and parse an offline DDInter release without touching the database. */
export function loadFrozenDdinterRelease(
  repositoryRoot: string,
  value: unknown,
): FrozenDdinterRelease {
  const manifest = sourceReleaseManifestSchema.parse(value);
  if (manifest.source !== 'ddinter' || manifest.activation.status !== 'active') {
    throw new FrozenReleaseVerificationError('the manifest is not an active DDInter release');
  }
  for (const licence of manifest.licences) {
    verifyFrozenFile(repositoryRoot, licence.termsSnapshotPath!, licence.termsSnapshotSha256!);
  }
  const transformation = manifest.provenance.transformation;
  if (transformation.status === 'applied') {
    verifyFrozenFile(repositoryRoot, transformation.scriptPath!, transformation.scriptSha256!);
  }

  const ddiRows: z.infer<typeof ddiRowSchema>[] = [];
  const mappings: ReviewedMapping[] = [];
  for (const file of manifest.files) {
    const bytes = verifyFrozenFile(repositoryRoot, file.path, file.sha256, file.bytes);
    if (file.rowCount === null) {
      throw new FrozenReleaseVerificationError('every DDInter file requires a row count');
    }
    if (file.kind === 'raw') {
      const rows = parseDdinterCsv(bytes);
      if (rows.length !== file.rowCount) {
        throw new FrozenReleaseVerificationError('raw DDI row count does not match the manifest');
      }
      for (const row of rows) ddiRows.push(row);
    } else {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(bytes.toString('utf8')) as unknown;
      } catch {
        throw new FrozenReleaseVerificationError('reviewed mapping file is not valid JSON');
      }
      const parsedMappings = reviewedMappingsSchema.safeParse(parsedJson);
      if (!parsedMappings.success || parsedMappings.data.length !== file.rowCount) {
        throw new FrozenReleaseVerificationError('reviewed mapping row count or shape is invalid');
      }
      for (const mapping of parsedMappings.data) mappings.push(mapping);
    }
  }
  if (ddiRows.length === 0) {
    throw new FrozenReleaseVerificationError('release contains no DDI rows');
  }
  assertUniqueMappings(mappings);
  const aggregated = aggregateDdinterRows(ddiRows);
  const membership = new Set(aggregated.drugs.map((drug) => drug.id));
  if (
    mappings.some(
      (mapping) => mapping.mappingStatus === 'mapped' && !membership.has(mapping.ddinterDrugId!),
    )
  ) {
    throw new FrozenReleaseVerificationError('a reviewed mapping fails release membership');
  }
  const checksumSha256 = releaseChecksum(manifest);
  return Object.freeze({
    manifest,
    checksumSha256,
    drugs: Object.freeze(aggregated.drugs),
    interactions: Object.freeze(aggregated.interactions),
    mappings: Object.freeze(mappings),
  });
}

function chunks<T>(values: readonly T[]): readonly (readonly T[])[] {
  return Array.from({ length: Math.ceil(values.length / INSERT_CHUNK_SIZE) }, (_, index) =>
    values.slice(index * INSERT_CHUNK_SIZE, (index + 1) * INSERT_CHUNK_SIZE),
  );
}

async function insertBundleRows(
  client: SqlClient,
  releaseId: string,
  bundle: FrozenDdinterRelease,
): Promise<void> {
  for (const group of chunks(bundle.drugs)) {
    await client.query(
      `INSERT INTO ddinter_drug (source_release_id, ddinter_drug_id, display_name)
       SELECT $1, rows.id, rows.display_name
         FROM unnest($2::text[], $3::text[]) AS rows(id, display_name)`,
      [releaseId, group.map((row) => row.id), group.map((row) => row.displayName)],
    );
  }
  for (const group of chunks(bundle.mappings)) {
    await client.query(
      `INSERT INTO ingredient_ddinter_map
         (source_release_id, identity_system, identity_code, ddinter_drug_id,
          mapping_status, reviewed_by, reviewed_at)
       SELECT $1, rows.identity_system, rows.identity_code, rows.ddinter_drug_id,
              rows.mapping_status, rows.reviewed_by, rows.reviewed_at::timestamptz
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
              AS rows(identity_system, identity_code, ddinter_drug_id,
                      mapping_status, reviewed_by, reviewed_at)`,
      [
        releaseId,
        group.map((row) => row.identitySystem),
        group.map((row) => row.identityCode),
        group.map((row) => row.ddinterDrugId),
        group.map((row) => row.mappingStatus),
        group.map((row) => row.reviewedBy),
        group.map((row) => row.reviewedAt),
      ],
    );
  }
  for (const group of chunks(bundle.interactions)) {
    await client.query(
      `INSERT INTO medication_interaction
         (source_release_id, low_ddinter_drug_id, high_ddinter_drug_id, interaction_level)
       SELECT $1, rows.low_id, rows.high_id, rows.interaction_level
         FROM unnest($2::text[], $3::text[], $4::text[])
              AS rows(low_id, high_id, interaction_level)`,
      [
        releaseId,
        group.map((row) => row.lowDrugId),
        group.map((row) => row.highDrugId),
        group.map((row) => row.level),
      ],
    );
  }
}

export type DdinterImportResult =
  | {
      readonly mode: 'dry-run';
      readonly drugs: number;
      readonly mappings: number;
      readonly interactions: number;
    }
  | {
      readonly mode: 'applied';
      readonly releaseId: string;
      readonly drugs: number;
      readonly mappings: number;
      readonly interactions: number;
    };

/** Dry-run by default; an explicit true activates the verified release in one transaction. */
export async function activateDdinterRelease(
  client: SqlClient,
  bundle: FrozenDdinterRelease,
  apply = false,
): Promise<DdinterImportResult> {
  const counts = {
    drugs: bundle.drugs.length,
    mappings: bundle.mappings.length,
    interactions: bundle.interactions.length,
  };
  if (!apply) return { mode: 'dry-run', ...counts };

  const releaseId = await activateVerifiedSource({
    client,
    manifest: bundle.manifest,
    checksumSha256: bundle.checksumSha256,
    insertRows: (id) => insertBundleRows(client, id, bundle),
  });
  return { mode: 'applied', releaseId, ...counts };
}

/** CLI seam: local verification always runs; database access requires explicit --apply. */
export async function runDdinterImportCli(
  argv: readonly string[],
  deps: SourceImportCliDeps<DdinterImportResult>,
): Promise<number> {
  return runSourceImportCli(argv, deps, DDINTER_CLI);
}

const DDINTER_CLI: SourceImportCliConfig<FrozenDdinterRelease, DdinterImportResult> = {
  label: 'ddinter-import',
  load: loadFrozenDdinterRelease,
  apply: (client, bundle) => activateDdinterRelease(client, bundle, true),
  dryRunLines: (bundle) => [
    `[ddinter-import] dry-run verified: drugs=${bundle.drugs.length} mappings=${bundle.mappings.length} interactions=${bundle.interactions.length}; no database writes`,
    '[ddinter-import] pass --apply to activate this exact verified release',
  ],
  appliedLine: (result) =>
    `[ddinter-import] applied: drugs=${result.drugs} mappings=${result.mappings} interactions=${result.interactions}`,
};

declare const require: { main?: unknown } | undefined;
declare const module: unknown;
if (typeof require !== 'undefined' && require.main === module) {
  void runSourceImportMain(process.argv.slice(2), DDINTER_CLI).then(
    (exitCode) => (process.exitCode = exitCode),
  );
}
