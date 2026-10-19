import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { extractedClaimSchema, needFieldSchema } from './contracts.js';

export interface NamespaceAliases {
  readonly canonicalToProvider: ReadonlyMap<string, string>;
  readonly providerToCanonical: ReadonlyMap<string, string>;
}

export function assertUniqueEntityReferences(
  label: string,
  references: readonly (string | null)[],
): void {
  const nonNull = references.filter((reference): reference is string => reference !== null);
  if (new Set(nonNull).size !== nonNull.length) {
    throw new Error(`Duplicate ${label} reference`);
  }
}

export function namespaceAliases(
  namespace: string,
  nonce: string,
  canonicalIds: readonly (string | null)[],
): NamespaceAliases {
  const pairs = [...new Set(canonicalIds.filter((value): value is string => value !== null))].map(
    (canonicalId, index) => [canonicalId, `${namespace}_${nonce}_${index + 1}`] as const,
  );
  return {
    canonicalToProvider: new Map(pairs),
    providerToCanonical: new Map(pairs.map(([canonical, provider]) => [provider, canonical])),
  };
}

const boundedClaimProviderRequestSchema = z
  .object({
    currentMessage: z
      .object({
        id: z.string().trim().min(1).max(160),
        direction: z.literal('inbound'),
        body: z
          .string()
          .min(1)
          .max(2_000)
          .refine((body) => body.trim().length > 0, 'Source text must not be blank'),
      })
      .strict(),
    openInformationNeeds: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(160),
            field: needFieldSchema,
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

const providerSourceRefSchema = z.string().regex(/^source_[a-f0-9]{24}_[1-9]\d*$/u);
const providerInformationNeedRefSchema = z.string().regex(/^need_[a-f0-9]{24}_[1-9]\d*$/u);
const providerClaimSlotSchema = /^claim_[1-9]\d*$/u;
const providerClaimTextSchema = z.string().trim().min(1).max(1_000);
const providerWireClaimSchema = z
  .object({
    slot: z.string().trim().min(1).max(160),
    quote: z
      .string()
      .min(1)
      .max(1_000)
      .refine((quote) => quote === quote.trim(), 'Source quote must not require normalization'),
    polarity: z.enum(['positive', 'negative']),
    experiencer: z.enum(['patient', 'other', 'unknown']),
    status: z.enum(['current', 'resolved', 'historical', 'hypothetical', 'habitual', 'future']),
    certainty: z.enum(['certain', 'uncertain']),
    kind: z.enum([
      'administration',
      'correction',
      'symptom',
      'symptom_detail',
      'recurrence',
      'need_answer',
      'social',
    ]),
    medicationText: providerClaimTextSchema.optional(),
    doseText: providerClaimTextSchema.optional(),
    timeText: providerClaimTextSchema.optional(),
    actionText: providerClaimTextSchema.optional(),
    symptomText: providerClaimTextSchema.optional(),
    targetText: providerClaimTextSchema.optional(),
    targetClaimSlot: z.string().trim().min(1).max(160).optional(),
    bodySiteText: providerClaimTextSchema.optional(),
    detailField: z.enum(['severity', 'duration', 'body_site', 'status', 'frequency']).optional(),
    detailText: providerClaimTextSchema.optional(),
    answerField: needFieldSchema.optional(),
    answerText: providerClaimTextSchema.optional(),
  })
  .strict();

const providerRawClaimSchema = providerWireClaimSchema
  .superRefine((claim, context) => {
    if (!providerClaimSlotSchema.test(claim.slot)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['slot'],
        message: 'Claim slots must be request-local',
      });
    }
    if (
      claim.targetClaimSlot !== undefined &&
      !providerClaimSlotSchema.test(claim.targetClaimSlot)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetClaimSlot'],
        message: 'Claim targets must be request-local',
      });
    }
  })
  .transform<z.infer<typeof extractedClaimSchema>>((claim, context) => {
    const parsed = extractedClaimSchema.safeParse(claim);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) context.addIssue(issue);
      return z.NEVER;
    }
    return parsed.data;
  });

export const boundedClaimProviderOutputSchema = z
  .object({
    claims: z
      .array(
        z
          .object({
            sourceRef: providerSourceRefSchema,
            informationNeedRef: providerInformationNeedRefSchema.nullable(),
            claim: providerRawClaimSchema,
          })
          .strict(),
      )
      .max(128),
  })
  .strict()
  .superRefine(({ claims }, context) => {
    const slots = new Set<string>();
    for (const [index, { claim }] of claims.entries()) {
      if (slots.has(claim.slot)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['claims', index, 'claim', 'slot'],
          message: 'Claim slots must be unique',
        });
      }
      slots.add(claim.slot);
    }
    for (const [index, { claim }] of claims.entries()) {
      if (
        'targetClaimSlot' in claim &&
        claim.targetClaimSlot !== undefined &&
        (!slots.has(claim.targetClaimSlot) || claim.targetClaimSlot === claim.slot)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['claims', index, 'claim', 'targetClaimSlot'],
          message: 'Claim target is not present in this request',
        });
      }
    }
    const targets = new Map(
      claims.flatMap(({ claim }) =>
        'targetClaimSlot' in claim && claim.targetClaimSlot !== undefined
          ? [[claim.slot, claim.targetClaimSlot] as const]
          : [],
      ),
    );
    for (const [index, { claim }] of claims.entries()) {
      const visited = new Set<string>([claim.slot]);
      for (
        let target = targets.get(claim.slot);
        target !== undefined;
        target = targets.get(target)
      ) {
        if (visited.has(target)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['claims', index, 'claim', 'targetClaimSlot'],
            message: 'Claim targets must be acyclic',
          });
          break;
        }
        visited.add(target);
      }
    }
  });

type DeepReadonly<Value> = Value extends (...arguments_: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

export type BoundedClaimProviderRequest = DeepReadonly<
  z.infer<typeof boundedClaimProviderRequestSchema>
>;
export type BoundedClaimProviderOutput = z.infer<typeof boundedClaimProviderOutputSchema>;

/**
 * Model-visible wire contract for the tool input_schema ONLY — never a parse gate.
 * It advertises the same per-kind claim union the output gate already enforces via
 * its transform through extractedClaimSchema, so the model sees which optional
 * fields belong to which claim kind. Responses are still parsed exclusively by
 * boundedClaimProviderOutputSchema.
 */
export const boundedClaimProviderWireSchema = z
  .object({
    claims: z
      .array(
        z
          .object({
            sourceRef: providerSourceRefSchema,
            informationNeedRef: providerInformationNeedRefSchema.nullable(),
            claim: extractedClaimSchema,
          })
          .strict(),
      )
      .max(128),
  })
  .strict();

export const boundedClaimExtractionSchema = z
  .object({
    claims: z
      .array(
        z
          .object({
            sourceMessageId: z.string().trim().min(1).max(160),
            informationNeedId: z.string().trim().min(1).max(160).nullable(),
            claim: extractedClaimSchema,
          })
          .strict(),
      )
      .max(128),
  })
  .strict();

export type BoundedClaimExtraction = DeepReadonly<z.infer<typeof boundedClaimExtractionSchema>>;

function localProviderReference(
  namespace: string,
  aliases: NamespaceAliases,
  canonicalId: string,
): string {
  const reference = aliases.canonicalToProvider.get(canonicalId);
  if (reference === undefined) throw new Error(`Unknown canonical ${namespace} reference`);
  return reference;
}

function localCanonicalReference(
  namespace: string,
  aliases: NamespaceAliases,
  providerRef: string,
): string {
  if (!providerRef.startsWith(`${namespace}_`)) {
    throw new Error(`Cross-namespace ${namespace} reference`);
  }
  const canonicalId = aliases.providerToCanonical.get(providerRef);
  if (canonicalId === undefined) throw new Error(`Unknown provider ${namespace} reference`);
  return canonicalId;
}

/** Builds the request-local, exact-source claim boundary used by production and evaluation. */
export function createBoundedClaimProviderBoundary(
  untrustedInput: unknown,
  options: { readonly createNonce?: () => string } = {},
) {
  const input = boundedClaimProviderRequestSchema.parse(untrustedInput);
  assertUniqueEntityReferences(
    'information need',
    input.openInformationNeeds.map(({ id }) => id),
  );
  const orderedInformationNeeds = [...input.openInformationNeeds].sort(
    (left, right) => left.field.localeCompare(right.field) || left.id.localeCompare(right.id),
  );
  const nonce = (options.createNonce ?? (() => randomBytes(12).toString('hex')))();
  if (!/^[a-f0-9]{24}$/u.test(nonce)) throw new Error('Invalid provider alias nonce');
  const sourceAliases = namespaceAliases('source', nonce, [input.currentMessage.id]);
  const needAliases = namespaceAliases(
    'need',
    nonce,
    orderedInformationNeeds.map(({ id }) => id),
  );
  const needFieldsById = new Map(
    orderedInformationNeeds.map(({ id, field }) => [id, field] as const),
  );
  const visibleNeedFields = orderedInformationNeeds.map(({ field }) => field);
  const uniquelyVisibleNeedFields = new Set(
    visibleNeedFields.filter(
      (field) => visibleNeedFields.indexOf(field) === visibleNeedFields.lastIndexOf(field),
    ),
  );
  const providerInput = Object.freeze({
    currentMessage: Object.freeze({
      sourceRef: localProviderReference('source', sourceAliases, input.currentMessage.id),
      body: input.currentMessage.body,
    }),
    openInformationNeeds: Object.freeze(
      orderedInformationNeeds.map(({ id, field }) =>
        Object.freeze({
          informationNeedRef: localProviderReference('need', needAliases, id),
          field,
        }),
      ),
    ),
  });

  return Object.freeze({
    input: providerInput,
    parseResult: (untrustedResult: unknown): BoundedClaimExtraction => {
      const result = boundedClaimProviderOutputSchema.parse(untrustedResult);
      const claims = result.claims.map(({ sourceRef, informationNeedRef, claim }) => {
        const relatedNeedId =
          informationNeedRef === null
            ? null
            : localCanonicalReference('need', needAliases, informationNeedRef);
        if (claim.kind !== 'need_answer' && relatedNeedId !== null) {
          throw new Error('Provider claim information-need relationship is invalid');
        }
        if (
          claim.kind === 'need_answer' &&
          (relatedNeedId === null || needFieldsById.get(relatedNeedId) !== claim.answerField)
        ) {
          throw new Error('Provider claim information-need relationship is invalid');
        }
        const informationNeedId =
          claim.kind === 'need_answer' && uniquelyVisibleNeedFields.has(claim.answerField)
            ? relatedNeedId
            : null;
        return Object.freeze({
          sourceMessageId: localCanonicalReference('source', sourceAliases, sourceRef),
          informationNeedId,
          claim: Object.freeze({ ...claim }),
        });
      });
      return Object.freeze({ claims: Object.freeze(claims) });
    },
  });
}

export type BoundedClaimProviderInput = ReturnType<
  typeof createBoundedClaimProviderBoundary
>['input'];
