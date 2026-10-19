import {
  extractedClaimSchema,
  relatedExtractedClaimSchema,
  validatedClaimSchema,
  type ClinicalClaimInput,
  type ExtractedClaim,
  type SourceSpan,
  type ValidatedClaim,
} from './contracts.js';
import { z } from 'zod';
import { sha256 } from './hash.js';

function occurrences(body: string, quote: string): number[] {
  const offsets: number[] = [];
  for (let offset = body.indexOf(quote); offset >= 0; offset = body.indexOf(quote, offset + 1)) {
    offsets.push(offset);
  }
  return offsets;
}

function grounded(value: string | undefined, quote: string): boolean {
  if (value === undefined) return true;
  const haystack = quote.toLocaleLowerCase('en-US');
  const needle = value.toLocaleLowerCase('en-US');
  const word = /[\p{L}\p{N}]/u;
  for (
    let offset = haystack.indexOf(needle);
    offset >= 0;
    offset = haystack.indexOf(needle, offset + 1)
  ) {
    const before = haystack[offset - 1];
    const after = haystack[offset + needle.length];
    const startsOnBoundary =
      !word.test(needle[0] ?? '') || before === undefined || !word.test(before);
    const endsOnBoundary =
      !word.test(needle.at(-1) ?? '') || after === undefined || !word.test(after);
    if (startsOnBoundary && endsOnBoundary) return true;
  }
  return false;
}

function fieldsAreGrounded(claim: ExtractedClaim): boolean {
  const values = [
    'medicationText' in claim ? claim.medicationText : undefined,
    'doseText' in claim ? claim.doseText : undefined,
    'timeText' in claim ? claim.timeText : undefined,
    'actionText' in claim ? claim.actionText : undefined,
    'symptomText' in claim ? claim.symptomText : undefined,
    'bodySiteText' in claim ? claim.bodySiteText : undefined,
    'targetText' in claim ? claim.targetText : undefined,
    'detailText' in claim ? claim.detailText : undefined,
    'answerText' in claim ? claim.answerText : undefined,
  ];
  return values.every((value) => grounded(value, claim.quote));
}

export function validateExtractedClaims(
  message: { readonly id: string; readonly body: string },
  untrustedClaims: readonly ClinicalClaimInput[],
): readonly ValidatedClaim[] {
  const parsed = z
    .array(z.union([extractedClaimSchema, relatedExtractedClaimSchema]))
    .max(128)
    .parse(untrustedClaims)
    .map((input) => ('claim' in input ? input : { claim: input, informationNeedId: undefined }));
  const slots = new Set(parsed.map(({ claim }) => claim.slot));
  if (slots.size !== parsed.length) throw new Error('claim_slot_duplicate');
  const analyzedClaims = parsed.map(({ claim, informationNeedId }) => ({
    claim,
    informationNeedId,
    offsets: occurrences(message.body, claim.quote),
  }));
  if (
    analyzedClaims.some(
      ({ claim, informationNeedId }) =>
        informationNeedId !== undefined &&
        (claim.kind === 'need_answer') !== (informationNeedId !== null),
    )
  ) {
    throw new Error('claim_information_need_relationship_invalid');
  }
  if (analyzedClaims.some(({ offsets }) => offsets.length === 0)) {
    throw new Error('quote_not_exact');
  }
  if (analyzedClaims.some(({ offsets }) => offsets.length > 1)) {
    throw new Error('quote_not_unique');
  }
  if (analyzedClaims.some(({ claim }) => !fieldsAreGrounded(claim))) {
    throw new Error('source_field_mismatch');
  }
  if (
    analyzedClaims.some(
      ({ claim }) =>
        'targetClaimSlot' in claim &&
        claim.targetClaimSlot !== undefined &&
        !slots.has(claim.targetClaimSlot),
    )
  ) {
    throw new Error('claim_target_missing');
  }
  const groundedClaims = analyzedClaims.map(({ claim, informationNeedId, offsets }) => {
    const sourceSpan: SourceSpan = {
      messageId: message.id,
      start: offsets[0]!,
      end: offsets[0]! + claim.quote.length,
      quote: claim.quote,
    };
    const semanticInput = {
      ...claim,
      slot: undefined,
      targetClaimSlot: undefined,
      ...(informationNeedId === undefined || informationNeedId === null
        ? {}
        : { informationNeedId }),
      sourceSpan,
    };
    return {
      claim,
      informationNeedId,
      sourceSpan,
      semanticId: `claim-${sha256(semanticInput).slice(0, 24)}`,
    };
  });
  const semanticIdsBySlot = new Map(
    groundedClaims.map(({ claim, semanticId }) => [claim.slot, semanticId]),
  );
  const relatedAnswers = groundedClaims.filter(
    ({ informationNeedId }) => informationNeedId !== undefined && informationNeedId !== null,
  );
  const relatedAnswerSpans = relatedAnswers.map(({ sourceSpan }) => sourceSpan);
  if (
    new Set(relatedAnswers.map(({ informationNeedId }) => informationNeedId)).size !==
      relatedAnswers.length ||
    relatedAnswerSpans.some((sourceSpan, index) =>
      relatedAnswerSpans
        .slice(0, index)
        .some(
          (candidate) =>
            candidate.messageId === sourceSpan.messageId &&
            candidate.start < sourceSpan.end &&
            sourceSpan.start < candidate.end,
        ),
    )
  ) {
    throw new Error('claim_information_need_relationship_conflict');
  }
  if (new Set(groundedClaims.map(({ semanticId }) => semanticId)).size !== groundedClaims.length) {
    throw new Error('claim_semantic_duplicate');
  }

  return z.array(validatedClaimSchema).parse(
    groundedClaims.map(({ claim, informationNeedId, semanticId, sourceSpan }) => ({
      ...claim,
      semanticId,
      ...(informationNeedId === undefined || informationNeedId === null
        ? {}
        : { informationNeedId }),
      ...('targetClaimSlot' in claim && claim.targetClaimSlot !== undefined
        ? { targetSemanticId: semanticIdsBySlot.get(claim.targetClaimSlot)! }
        : {}),
      sourceSpan,
    })),
  );
}
