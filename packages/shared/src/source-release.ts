import { z } from 'zod';

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const sha256Schema = z.string().regex(SHA256, 'expected a lowercase SHA-256 digest');
const httpsUrlSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://'), {
    message: 'source and terms URLs must use HTTPS',
  });
const identifierSchema = z.string().regex(IDENTIFIER);
const repositoryPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) => !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..'),
    { message: 'path must be a safe repository-relative path' },
  );

const activationSchema = z
  .object({
    status: z.enum(['inactive', 'review_required', 'active']),
    reason: z.string().trim().min(1).nullable(),
  })
  .strict();

const transformationSchema = z
  .object({
    status: z.enum(['none', 'planned', 'applied']),
    scriptPath: repositoryPathSchema.nullable(),
    scriptSha256: sha256Schema.nullable(),
    inputLogicalNames: z.array(z.string().trim().min(1)),
    notes: z.string().trim().min(1),
  })
  .strict();

const provenanceSchema = z
  .object({
    publisher: z.string().trim().min(1),
    sourceUrl: httpsUrlSchema,
    releaseUrl: httpsUrlSchema,
    retrievedAt: z.string().datetime({ offset: true }).nullable(),
    freshUntil: z.string().datetime({ offset: true }).nullable(),
    transformation: transformationSchema,
  })
  .strict();

const permissionSchema = z.enum(['allowed', 'prohibited', 'review_required']);

const licenceSchema = z
  .object({
    subject: z.string().trim().min(1),
    status: z.enum(['cleared', 'review_required', 'prohibited']),
    licenceId: z.string().trim().min(1).nullable(),
    termsUrl: httpsUrlSchema,
    termsSnapshotPath: repositoryPathSchema.nullable(),
    termsSnapshotSha256: sha256Schema.nullable(),
    redistribution: z.enum(['allowed', 'restricted', 'prohibited', 'review_required']),
    commercialUse: permissionSchema,
    shareAlike: z.boolean().nullable(),
    patientFacingUse: permissionSchema,
    modelProcessing: permissionSchema,
    attribution: z.string().trim().min(1).nullable(),
    notes: z.string().trim().min(1),
  })
  .strict();

const scopeSchema = z
  .object({
    included: z.array(z.string().trim().min(1)).min(1),
    excluded: z.array(z.string().trim().min(1)),
  })
  .strict();

const sourceReleaseFileSchema = z
  .object({
    logicalName: identifierSchema,
    path: repositoryPathSchema,
    sourceUrl: httpsUrlSchema,
    kind: z.enum(['raw', 'derived']),
    sha256: sha256Schema,
    bytes: z.number().int().positive(),
    rowCount: z.number().int().nonnegative().nullable(),
    redistribution: z.enum(['allowed', 'restricted', 'prohibited', 'review_required']),
  })
  .strict();

function addIssue(context: z.RefinementCtx, path: Array<string | number>, message: string): void {
  context.addIssue({ code: 'custom', path, message });
}

/**
 * Frozen third-party source release contract.
 *
 * Review-required manifests deliberately keep unknown hashes/timestamps as `null` or keep
 * not-yet-downloaded files out of `files`. They can be inspected, but cannot become active.
 * Active releases require a complete expected-file set, exact checksums, a terms snapshot,
 * resolved usage rights, and complete retrieval/transformation provenance.
 */
export const sourceReleaseManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    source: z.enum(['ccdd', 'ddinter', 'medlineplus', 'openfda', 'health_canada', 'onsides']),
    releaseId: identifierSchema,
    activation: activationSchema,
    provenance: provenanceSchema,
    licences: z.array(licenceSchema).min(1),
    scope: scopeSchema,
    expectedFiles: z.array(identifierSchema).min(1),
    files: z.array(sourceReleaseFileSchema),
  })
  .strict()
  .superRefine((manifest, context) => {
    const expected = new Set(manifest.expectedFiles);
    const actual = new Set(manifest.files.map((file) => file.logicalName));

    if (expected.size !== manifest.expectedFiles.length) {
      addIssue(context, ['expectedFiles'], 'expected file identities must be unique');
    }
    if (actual.size !== manifest.files.length) {
      addIssue(context, ['files'], 'source release file identities must be unique');
    }
    for (const file of manifest.files) {
      if (!expected.has(file.logicalName)) {
        addIssue(context, ['files'], `unexpected source release file: ${file.logicalName}`);
      }
    }

    const transformation = manifest.provenance.transformation;
    if (
      transformation.status === 'none' &&
      (transformation.scriptPath !== null ||
        transformation.scriptSha256 !== null ||
        transformation.inputLogicalNames.length > 0)
    ) {
      addIssue(
        context,
        ['provenance', 'transformation'],
        'an untransformed release cannot claim a script or transform inputs',
      );
    }
    if (
      transformation.status === 'applied' &&
      (transformation.scriptPath === null ||
        transformation.scriptSha256 === null ||
        transformation.inputLogicalNames.length === 0)
    ) {
      addIssue(
        context,
        ['provenance', 'transformation'],
        'an applied transformation requires its script path, script checksum, and inputs',
      );
    }

    if (manifest.activation.status !== 'active') {
      if (manifest.activation.reason === null) {
        addIssue(context, ['activation', 'reason'], 'a non-active release requires a reason');
      }
      return;
    }

    if (manifest.activation.reason !== null) {
      addIssue(context, ['activation', 'reason'], 'an active release cannot retain a hold reason');
    }
    if (manifest.provenance.retrievedAt === null) {
      addIssue(context, ['provenance', 'retrievedAt'], 'an active release requires retrieval time');
    }
    if (manifest.provenance.freshUntil === null) {
      addIssue(
        context,
        ['provenance', 'freshUntil'],
        'an active release requires a freshness limit',
      );
    } else if (
      manifest.provenance.retrievedAt !== null &&
      manifest.provenance.freshUntil <= manifest.provenance.retrievedAt
    ) {
      addIssue(
        context,
        ['provenance', 'freshUntil'],
        'an active release freshness limit must follow retrieval time',
      );
    }
    if (transformation.status === 'planned') {
      addIssue(
        context,
        ['provenance', 'transformation', 'status'],
        'a planned transformation is not activation evidence',
      );
    }
    if (
      manifest.files.some((file) => file.kind === 'derived') &&
      transformation.status !== 'applied'
    ) {
      addIssue(
        context,
        ['provenance', 'transformation'],
        'active derived files require applied transformation provenance',
      );
    }
    for (const expectedFile of expected) {
      if (!actual.has(expectedFile)) {
        addIssue(context, ['files'], `active release is missing expected file: ${expectedFile}`);
      }
    }
    for (const [index, file] of manifest.files.entries()) {
      if (file.redistribution === 'review_required') {
        addIssue(
          context,
          ['files', index, 'redistribution'],
          'active release files require an explicit redistribution decision',
        );
      }
    }
    for (const [index, licence] of manifest.licences.entries()) {
      if (licence.status !== 'cleared') {
        addIssue(context, ['licences', index, 'status'], 'active release rights must be cleared');
      }
      if (licence.licenceId === null) {
        addIssue(context, ['licences', index, 'licenceId'], 'active release requires a licence ID');
      }
      if (licence.termsSnapshotSha256 === null) {
        addIssue(
          context,
          ['licences', index, 'termsSnapshotSha256'],
          'active release requires a checksum of the reviewed terms snapshot',
        );
      }
      if (licence.termsSnapshotPath === null) {
        addIssue(
          context,
          ['licences', index, 'termsSnapshotPath'],
          'active release requires the reviewed terms snapshot path',
        );
      }
      if (
        licence.redistribution === 'review_required' ||
        licence.commercialUse === 'review_required' ||
        licence.shareAlike === null ||
        licence.patientFacingUse === 'review_required' ||
        licence.modelProcessing === 'review_required'
      ) {
        addIssue(
          context,
          ['licences', index],
          'active release cannot contain unresolved rights facts',
        );
      }
    }
  });

export type SourceReleaseManifest = z.infer<typeof sourceReleaseManifestSchema>;
