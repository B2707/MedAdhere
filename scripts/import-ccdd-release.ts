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

interface NodeRequire {
  (id: string): unknown;
  main?: unknown;
}
declare const require: NodeRequire;
declare const module: unknown;

const HEADERS = {
  'mp.csv': [
    'mp_code',
    'mp_formal_name',
    'mp_en_description',
    'mp_fr_description',
    'mp_status',
    'mp_status_effective_time',
    'mp_type',
    'Health_Canada_identifier',
    'Health_Canada_product_name',
  ],
  'ntp.csv': [
    'ntp_code',
    'ntp_formal_name',
    'ntp_en_description',
    'ntp_fr_description',
    'ntp_status',
    'ntp_status_effective_time',
    'ntp_type',
  ],
  'tm.csv': [
    'tm_code',
    'tm_formal_name',
    'tm_fr_description',
    'tm_status',
    'tm_status_effective_time',
  ],
  'mp-ntp-tm-en.csv': [
    'mp_code',
    'mp_formal_name',
    'ntp_code',
    'ntp_formal_name',
    'tm_code',
    'tm_formal_name',
  ],
  'mp-ntp-tm-fr.csv': [
    'mp_code',
    'mp_fr_description',
    'ntp_code',
    'ntp_fr_description',
    'tm_code',
    'tm_fr_description',
  ],
} as const;

const conceptSchema = z
  .object({
    kind: z.enum(['mp', 'ntp', 'tm']),
    code: z.string().trim().min(1).max(64),
    displayNameEn: z.string().trim().min(1).max(1000).nullable(),
    displayNameFr: z.string().trim().min(1).max(1000).nullable(),
    status: z.string().trim().min(1).max(32).nullable(),
    din: z
      .string()
      .regex(/^\d{8}$/)
      .nullable(),
  })
  .strict();

const relationSchema = z
  .object({
    mpCode: z.string().trim().min(1).max(64),
    ntpCode: z.string().trim().min(1).max(64),
    tmCode: z.string().trim().min(1).max(64),
    language: z.enum(['en', 'fr']),
  })
  .strict();

const identityBridgeSchema = z
  .object({
    din: z.string().regex(/^\d{8}$/),
    ccddProductCode: z.string().trim().min(1).max(64),
    ingredientOrder: z.number().int().min(1).max(32),
    ingredientName: z.string().trim().min(1).max(320),
    ccddIngredientCode: z.string().trim().min(1).max(64),
    rxcui: z.string().regex(/^\d{1,32}$/),
    reviewedBy: z.string().trim().min(1).max(128),
    reviewedAt: z.string().datetime({ offset: true }),
  })
  .strict();

type CcddConcept = z.infer<typeof conceptSchema>;
type CcddRelation = z.infer<typeof relationSchema>;
type MedicationIdentityBridge = z.infer<typeof identityBridgeSchema>;

export interface FrozenCcddRelease {
  readonly manifest: SourceReleaseManifest;
  readonly checksumSha256: string;
  readonly concepts: readonly CcddConcept[];
  readonly relations: readonly CcddRelation[];
  readonly identityBridges: readonly MedicationIdentityBridge[];
}

function parseCsv(bytes: Buffer, expectedHeader: readonly string[]): readonly string[][] {
  const lines = bytes
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  const header = parseCsvLine(lines[0] ?? '');
  if (
    header.length !== expectedHeader.length ||
    header.some((cell, index) => cell !== expectedHeader[index])
  ) {
    throw new FrozenReleaseVerificationError('CSV header is not the reviewed CCDD format');
  }
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line).map((cell) => cell.trim());
    if (cells.length !== expectedHeader.length) {
      throw new FrozenReleaseVerificationError('CCDD CSV row has the wrong field count');
    }
    return cells;
  });
}

function nullable(value: string): string | null {
  return value.length === 0 || value === 'NA' ? null : value;
}

function conceptsFor(name: keyof typeof HEADERS, rows: readonly string[][]): CcddConcept[] {
  if (name === 'mp.csv') {
    return rows.map((row) =>
      conceptSchema.parse({
        kind: 'mp',
        code: row[0],
        displayNameEn: nullable(row[8]!) ?? nullable(row[1]!),
        displayNameFr: nullable(row[3]!),
        status: nullable(row[4]!),
        din: row[6] === 'DIN' ? nullable(row[7]!) : null,
      }),
    );
  }
  if (name === 'ntp.csv') {
    return rows.map((row) =>
      conceptSchema.parse({
        kind: 'ntp',
        code: row[0],
        displayNameEn: nullable(row[1]!),
        displayNameFr: nullable(row[3]!),
        status: nullable(row[4]!),
        din: null,
      }),
    );
  }
  if (name === 'tm.csv') {
    return rows.map((row) =>
      conceptSchema.parse({
        kind: 'tm',
        code: row[0],
        displayNameEn: nullable(row[1]!),
        displayNameFr: nullable(row[2]!),
        status: nullable(row[3]!),
        din: null,
      }),
    );
  }
  return [];
}

function relationsFor(
  name: 'mp-ntp-tm-en.csv' | 'mp-ntp-tm-fr.csv',
  rows: readonly string[][],
): CcddRelation[] {
  const language = name === 'mp-ntp-tm-en.csv' ? 'en' : 'fr';
  return rows.map((row) =>
    relationSchema.parse({ mpCode: row[0], ntpCode: row[2], tmCode: row[4], language }),
  );
}

function assertCatalogIntegrity(
  concepts: readonly CcddConcept[],
  relations: readonly CcddRelation[],
  identityBridges: readonly MedicationIdentityBridge[],
): void {
  const keys = new Set(concepts.map((row) => `${row.kind}:${row.code}`));
  if (keys.size !== concepts.length) {
    throw new FrozenReleaseVerificationError('CCDD concepts contain duplicate identities');
  }
  for (const relation of relations) {
    if (
      !keys.has(`mp:${relation.mpCode}`) ||
      !keys.has(`ntp:${relation.ntpCode}`) ||
      !keys.has(`tm:${relation.tmCode}`)
    ) {
      throw new FrozenReleaseVerificationError('CCDD relationship references a missing concept');
    }
  }
  const bridgeKeys = new Set<string>();
  for (const bridge of identityBridges) {
    const key = `${bridge.din}:${bridge.ingredientOrder}`;
    const product = concepts.find(
      (row) => row.kind === 'mp' && row.code === bridge.ccddProductCode && row.din === bridge.din,
    );
    const ingredient = concepts.find(
      (row) => row.kind === 'tm' && row.code === bridge.ccddIngredientCode,
    );
    const relation = relations.find(
      (row) =>
        row.language === 'en' &&
        row.mpCode === bridge.ccddProductCode &&
        row.tmCode === bridge.ccddIngredientCode,
    );
    if (
      bridgeKeys.has(key) ||
      !product ||
      !ingredient ||
      !relation ||
      ingredient.displayNameEn?.toLocaleLowerCase('en') !==
        bridge.ingredientName.toLocaleLowerCase('en')
    ) {
      throw new FrozenReleaseVerificationError(
        'reviewed identity bridge does not match the frozen CCDD catalog',
      );
    }
    bridgeKeys.add(key);
  }
}

export function loadFrozenCcddRelease(repositoryRoot: string, input: unknown): FrozenCcddRelease {
  const manifest = sourceReleaseManifestSchema.parse(input);
  if (manifest.source !== 'ccdd' || manifest.activation.status !== 'active') {
    throw new FrozenReleaseVerificationError('the manifest is not an active CCDD release');
  }
  for (const licence of manifest.licences) {
    verifyFrozenFile(repositoryRoot, licence.termsSnapshotPath!, licence.termsSnapshotSha256!);
  }
  const transformation = manifest.provenance.transformation;
  if (transformation.status !== 'applied') {
    throw new FrozenReleaseVerificationError('CCDD requires the reviewed CSV transform');
  }
  verifyFrozenFile(repositoryRoot, transformation.scriptPath!, transformation.scriptSha256!);

  const parsedFiles = new Map<keyof typeof HEADERS, readonly string[][]>();
  let identityBridges: readonly MedicationIdentityBridge[] | undefined;
  for (const file of manifest.files) {
    if (file.logicalName === 'reviewed-identity-bridge.json') {
      if (file.kind !== 'derived' || file.rowCount === null || identityBridges !== undefined) {
        throw new FrozenReleaseVerificationError('CCDD identity bridge manifest is invalid');
      }
      identityBridges = z
        .array(identityBridgeSchema)
        .min(1)
        .parse(
          JSON.parse(
            verifyFrozenFile(repositoryRoot, file.path, file.sha256, file.bytes).toString('utf8'),
          ),
        );
      if (identityBridges.length !== file.rowCount) {
        throw new FrozenReleaseVerificationError('CCDD identity bridge row count does not match');
      }
      continue;
    }
    const name = file.logicalName as keyof typeof HEADERS;
    const header = HEADERS[name];
    if (!header || file.kind !== 'raw' || file.rowCount === null) {
      throw new FrozenReleaseVerificationError('CCDD manifest has an unexpected file');
    }
    const rows = parseCsv(
      verifyFrozenFile(repositoryRoot, file.path, file.sha256, file.bytes),
      header,
    );
    if (rows.length !== file.rowCount) {
      throw new FrozenReleaseVerificationError('CCDD row count does not match');
    }
    parsedFiles.set(name, rows);
  }

  const concepts = (['mp.csv', 'ntp.csv', 'tm.csv'] as const).flatMap((name) =>
    conceptsFor(name, parsedFiles.get(name) ?? []),
  );
  const relations = (['mp-ntp-tm-en.csv', 'mp-ntp-tm-fr.csv'] as const).flatMap((name) =>
    relationsFor(name, parsedFiles.get(name) ?? []),
  );
  if (!identityBridges) {
    throw new FrozenReleaseVerificationError('CCDD reviewed identity bridge is missing');
  }
  assertCatalogIntegrity(concepts, relations, identityBridges);
  return Object.freeze({
    manifest,
    checksumSha256: releaseChecksum(manifest),
    concepts: Object.freeze(concepts),
    relations: Object.freeze(relations),
    identityBridges: Object.freeze(identityBridges),
  });
}

function groups<T>(values: readonly T[], size = 5_000): readonly (readonly T[])[] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size),
  );
}

async function insertCatalog(
  client: SourceImportClient,
  releaseId: string,
  bundle: FrozenCcddRelease,
): Promise<void> {
  for (const rows of groups(bundle.identityBridges)) {
    await client.query(
      `INSERT INTO medication_identity_bridge
         (source_release_id, din, ccdd_product_code, ingredient_order,
          ingredient_name, ccdd_ingredient_code, rxcui, reviewed_by, reviewed_at)
       SELECT $1, * FROM unnest(
         $2::text[], $3::text[], $4::smallint[], $5::text[], $6::text[], $7::text[],
         $8::text[], $9::timestamptz[]
       )`,
      [
        releaseId,
        rows.map((row) => row.din),
        rows.map((row) => row.ccddProductCode),
        rows.map((row) => row.ingredientOrder),
        rows.map((row) => row.ingredientName),
        rows.map((row) => row.ccddIngredientCode),
        rows.map((row) => row.rxcui),
        rows.map((row) => row.reviewedBy),
        rows.map((row) => row.reviewedAt),
      ],
    );
  }
}

export type CcddImportResult =
  | {
      readonly mode: 'dry-run';
      readonly validatedConcepts: number;
      readonly validatedRelations: number;
      readonly identityBridges: number;
    }
  | {
      readonly mode: 'applied';
      readonly releaseId: string;
      readonly validatedConcepts: number;
      readonly validatedRelations: number;
      readonly identityBridges: number;
    };

export async function activateCcddRelease(
  client: SourceImportClient,
  bundle: FrozenCcddRelease,
  apply = false,
): Promise<CcddImportResult> {
  const counts = {
    validatedConcepts: bundle.concepts.length,
    validatedRelations: bundle.relations.length,
    identityBridges: bundle.identityBridges.length,
  };
  if (!apply) return { mode: 'dry-run', ...counts };
  const releaseId = await activateVerifiedSource({
    client,
    manifest: bundle.manifest,
    checksumSha256: bundle.checksumSha256,
    insertRows: (id) => insertCatalog(client, id, bundle),
  });
  return { mode: 'applied', releaseId, ...counts };
}

export async function runCcddImportCli(
  argv: readonly string[],
  deps: SourceImportCliDeps<CcddImportResult>,
): Promise<number> {
  return runSourceImportCli(argv, deps, CCDD_CLI);
}

const CCDD_CLI: SourceImportCliConfig<FrozenCcddRelease, CcddImportResult> = {
  label: 'ccdd-import',
  load: loadFrozenCcddRelease,
  apply: (client, bundle) => activateCcddRelease(client, bundle, true),
  dryRunLines: (bundle) => [
    `[ccdd-import] dry-run verified: validatedConcepts=${bundle.concepts.length} validatedRelations=${bundle.relations.length} identityBridges=${bundle.identityBridges.length}; no database writes`,
  ],
  appliedLine: (result) =>
    `[ccdd-import] applied: validatedConcepts=${result.validatedConcepts} validatedRelations=${result.validatedRelations} identityBridges=${result.identityBridges}`,
};

if (typeof require !== 'undefined' && require.main === module) {
  void runSourceImportMain(process.argv.slice(2), CCDD_CLI).then(
    (exitCode) => (process.exitCode = exitCode),
  );
}
