import { z } from 'zod';
import { evidenceReferenceSchema } from './conversation-contract.js';

const SHA256 = /^[a-f0-9]{64}$/;
const SUPPORTED_LANGUAGES = ['en', 'fr', 'es', 'ar'] as const;
const templateIdSchema = z.enum(['direct-label-evidence-v1', 'medlineplus-summary-v1']);

const renderInputSchema = z
  .object({
    evidence: evidenceReferenceSchema,
    templateId: templateIdSchema,
    language: z.string().trim().min(2).max(35),
    sourceChecksumSha256: z.string().regex(SHA256),
  })
  .strict();

export const renderedClinicalClaimSchema = z
  .object({
    text: z.string().trim().min(1).max(320),
    evidenceId: z.string().trim().min(1).max(128),
    templateId: templateIdSchema,
    sourceVersion: z.string().trim().min(1).max(128),
    sourceChecksumSha256: z.string().regex(SHA256),
  })
  .strict();

const wrappers = {
  en: 'I’ll note this for your doctor.',
  fr: 'Je vais le noter pour votre médecin.',
  es: 'Se lo anotaré a su médico.',
  ar: 'سأدوّن ذلك لطبيبك.',
} as const;

const MEDLINEPLUS_CREDIT = 'Source: MedlinePlus.gov, National Library of Medicine.';

function languageBase(language: string): string {
  return language.toLowerCase().split('-')[0]!;
}

/** Exact room left for an NLM passage after the required wrapper, credit, and link. */
export function medlinePlusPassageBudget(language: 'en' | 'es', url: string): number {
  return 320 - Array.from(` ${wrappers[language]} ${MEDLINEPLUS_CREDIT} ${url}`).length;
}

/** Render exact reviewed evidence; no model-authored clinical paraphrase enters this sentence. */
export function renderClinicalClaim(
  value: z.input<typeof renderInputSchema>,
): z.infer<typeof renderedClinicalClaimSchema> | null {
  const input = renderInputSchema.parse(value);
  const language = languageBase(input.language);
  if (!SUPPORTED_LANGUAGES.includes(language as (typeof SUPPORTED_LANGUAGES)[number])) return null;
  if (languageBase(input.evidence.language) !== language) {
    throw new Error('clinical claim language does not match its reviewed evidence');
  }
  if (
    input.evidence.coverageState !== 'direct_evidence' ||
    !input.evidence.allowedTemplateIds.includes(input.templateId)
  ) {
    throw new Error('clinical claim is not backed by an allowed direct-evidence template');
  }

  const isMedlinePlus = input.evidence.source === 'medlineplus';
  const validSourceTemplate = isMedlinePlus
    ? input.templateId === 'medlineplus-summary-v1'
    : (input.evidence.source === 'openfda' || input.evidence.source === 'health_canada') &&
      input.templateId === 'direct-label-evidence-v1';
  if (!validSourceTemplate) {
    throw new Error('clinical claim source is not patient-facing evidence');
  }
  const source = isMedlinePlus ? MEDLINEPLUS_CREDIT : 'Source: reviewed medication label.';
  const text = `${input.evidence.passage} ${wrappers[language as keyof typeof wrappers]} ${source} ${input.evidence.url}`;
  if (Array.from(text).length > 320) {
    throw new Error('rendered clinical claim exceeds 320 characters');
  }
  return renderedClinicalClaimSchema.parse({
    text,
    evidenceId: input.evidence.evidenceId,
    templateId: input.templateId,
    sourceVersion: input.evidence.sourceVersion,
    sourceChecksumSha256: input.sourceChecksumSha256,
  });
}

export type RenderedClinicalClaim = z.infer<typeof renderedClinicalClaimSchema>;
