import { describe, expect, it } from 'vitest';
import { renderClinicalClaim, type EvidenceReference } from './index.js';

const RELEASE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function evidence(overrides: Partial<EvidenceReference> = {}): EvidenceReference {
  return {
    evidenceId: 'label-headache-v1',
    source: 'openfda',
    sourceReleaseId: RELEASE_ID,
    sourceVersion: '2026-08-01',
    title: 'Reviewed label passage',
    passage: 'Headache is listed as a possible adverse reaction.',
    url: 'https://open.fda.gov/example',
    language: 'en',
    coverageState: 'direct_evidence',
    allowedTemplateIds: ['direct-label-evidence-v1'],
    ...overrides,
  };
}

function render(input: Omit<Parameters<typeof renderClinicalClaim>[0], 'sourceChecksumSha256'>) {
  return renderClinicalClaim({ ...input, sourceChecksumSha256: 'a'.repeat(64) });
}

describe('renderClinicalClaim', () => {
  it('renders only the exact direct passage through an allowlisted source template', () => {
    expect(
      render({
        evidence: evidence(),
        templateId: 'direct-label-evidence-v1',
        language: 'en',
      }),
    ).toEqual({
      text: 'Headache is listed as a possible adverse reaction. I’ll note this for your doctor. Source: reviewed medication label. https://open.fda.gov/example',
      evidenceId: 'label-headache-v1',
      templateId: 'direct-label-evidence-v1',
      sourceVersion: '2026-08-01',
      sourceChecksumSha256: 'a'.repeat(64),
    });
  });

  it('includes the required MedlinePlus.gov/NLM credit and link', () => {
    const claim = render({
      evidence: evidence({
        source: 'medlineplus',
        passage: 'Poor sleep can affect how you feel during the day.',
        url: 'https://medlineplus.gov/healthysleep.html',
        allowedTemplateIds: ['medlineplus-summary-v1'],
      }),
      templateId: 'medlineplus-summary-v1',
      language: 'en',
    });
    expect(claim?.text).toContain('Source: MedlinePlus.gov, National Library of Medicine.');
    expect(claim?.text).toContain('https://medlineplus.gov/healthysleep.html');
  });

  it.each([
    ['fr', 'Je vais le noter pour votre médecin.'],
    ['es', 'Se lo anotaré a su médico.'],
    ['ar', 'سأدوّن ذلك لطبيبك.'],
  ])(
    'uses the source-controlled %s wrapper without translating the evidence passage',
    (language, wrapper) => {
      const passage = `reviewed-${language}-passage`;
      const claim = render({
        evidence: evidence({ language, passage }),
        templateId: 'direct-label-evidence-v1',
        language,
      });
      expect(claim?.text).toContain(passage);
      expect(claim?.text).toContain(wrapper);
    },
  );

  it('rejects candidate-only, OnSIDES, mismatched-language, and unapproved-template claims', () => {
    expect(() =>
      render({
        evidence: evidence({ coverageState: 'candidate_only' }),
        templateId: 'direct-label-evidence-v1',
        language: 'en',
      }),
    ).toThrow();
    expect(() =>
      render({
        evidence: evidence({ source: 'onsides' }),
        templateId: 'direct-label-evidence-v1',
        language: 'en',
      }),
    ).toThrow();
    expect(() =>
      render({
        evidence: evidence(),
        templateId: 'direct-label-evidence-v1',
        language: 'fr',
      }),
    ).toThrow();
    expect(() =>
      render({
        evidence: evidence(),
        templateId: 'not-allowed' as never,
        language: 'en',
      }),
    ).toThrow();
  });

  it('returns null for unsupported patient languages rather than translating a fact', () => {
    expect(
      render({
        evidence: evidence({ language: 'de' }),
        templateId: 'direct-label-evidence-v1',
        language: 'de',
      }),
    ).toBeNull();
  });

  it('preserves the full source-release version allowed by the evidence contract', () => {
    const sourceVersion = 'v'.repeat(128);
    expect(
      render({
        evidence: evidence({ sourceVersion }),
        templateId: 'direct-label-evidence-v1',
        language: 'en',
      })?.sourceVersion,
    ).toBe(sourceVersion);
  });

  it('fails closed when passage, credit, and link do not fit the patient message bound', () => {
    expect(() =>
      render({
        evidence: evidence({ passage: 'x'.repeat(250) }),
        templateId: 'direct-label-evidence-v1',
        language: 'en',
      }),
    ).toThrow(/320/);
  });
});
