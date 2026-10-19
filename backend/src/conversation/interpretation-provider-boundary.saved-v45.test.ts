import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { conversationTurnResultSchema } from '@medadhere/shared';
import { z } from 'zod';
import { createBoundedClaimProviderBoundary } from './clinical-memory/bounded-provider.js';

const fixtureSchema = z
  .object({
    source: z
      .object({
        kind: z.literal('saved_post_boundary_review_bundle'),
        rawProviderOutputAvailable: z.literal(false),
        file: z.string().min(1),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    rows: z.array(
      z
        .object({
          scenarioId: z.string().min(1),
          turnId: z.string().uuid(),
          outputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
          disposition: z.enum([
            'genuine_semantic_failure',
            'corpus_contract_issue',
            'previously_correct',
          ]),
          messageBody: z.string().min(1),
          savedPostBoundaryTurnResult: z.record(z.unknown()),
        })
        .strict(),
    ),
  })
  .strict();

const fixture = fixtureSchema.parse(
  JSON.parse(
    readFileSync(
      join(__dirname, 'interpretation-provider-boundary.saved-v45.fixture.json'),
      'utf8',
    ),
  ),
);
const nonce = 'cccccccccccccccccccccccc';
const fixtureSha256 = createHash('sha256')
  .update(readFileSync(join(__dirname, 'interpretation-provider-boundary.saved-v45.fixture.json')))
  .digest('hex');
const semanticReviewFixtureHashes = [
  'e7399dcf84d5f3d7879496b8cd8ee24cd1138229bc046a50661e467e64df71b3',
  '53f2df566a2a239caf20f6481b147e0b7eb6ee2dc1d87cb32b48a697a0e42805',
  '4dfc5567622e5734fb9df40d15f81245a1a7e260635c2960603643d416be1d76',
] as const;

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function hashSavedTurnResult(value: unknown): string {
  const result = conversationTurnResultSchema.parse(value);
  return `sha256:${createHash('sha256').update(canonicalJson(result), 'utf8').digest('hex')}`;
}

function boundary(row: (typeof fixture.rows)[number]) {
  return createBoundedClaimProviderBoundary(
    {
      currentMessage: { id: row.turnId, direction: 'inbound', body: row.messageBody },
      openInformationNeeds: [],
    },
    { createNonce: () => nonce },
  );
}

describe('saved v45 bounded-extractor compatibility', () => {
  it('pins the saved evidence as post-boundary results rather than raw provider output', () => {
    expect(fixture.source).toEqual({
      kind: 'saved_post_boundary_review_bundle',
      rawProviderOutputAvailable: false,
      file: 'conversation-review-3a1e7552-0533-4288-9943-106d87610ed6-71e9e253-e674-422d-b2e1-12a9ba31b178.json',
      sha256: '3a6b3aec28c62e61328218d6e5cc0ad60578abbee67597ff6eed816cf135c549',
    });
    expect(fixtureSha256).toBe('95e510f85932d229b069925d2a4a75d46a5050f0d43a048c4fb3275ae912859e');
    expect(fixture.rows).toHaveLength(27);
  });

  it('pins the three saved semantic-review partitions that identify failed turns', () => {
    expect(
      semanticReviewFixtureHashes.map((_expected, index) =>
        createHash('sha256')
          .update(
            readFileSync(
              join(
                __dirname,
                'clinical-memory',
                'fixtures',
                `v45-semantic-review-part-${index}.json`,
              ),
            ),
          )
          .digest('hex'),
      ),
    ).toEqual(semanticReviewFixtureHashes);
  });

  it('rejects all 27 saved post-boundary results as bounded provider output', () => {
    for (const row of fixture.rows) {
      expect(hashSavedTurnResult(row.savedPostBoundaryTurnResult)).toBe(row.outputHash);
      expect(() => boundary(row).parseResult(row.savedPostBoundaryTurnResult)).toThrow(z.ZodError);
    }
  });

  it('marks the four genuine saved semantic failures explicitly incompatible', () => {
    const failures = fixture.rows.filter(
      ({ disposition }) => disposition === 'genuine_semantic_failure',
    );

    expect(failures.map(({ turnId }) => turnId).sort()).toEqual(
      [
        '63a6eea6-a3f8-44f7-a74b-6dc588cbd81c',
        '5e81f99b-8588-440f-8dc8-55ec66e076a8',
        '542d4a55-4fbd-46c6-88bd-6b3e9880f549',
        'af479246-3ec8-4e94-9ef5-c3651425da2d',
      ].sort(),
    );
    for (const row of failures) {
      expect(() => boundary(row).parseResult(row.savedPostBoundaryTurnResult)).toThrow(z.ZodError);
    }
  });

  it('keeps every previously correct saved turn unchanged as incompatible baseline evidence', () => {
    const correct = fixture.rows.filter(({ disposition }) => disposition === 'previously_correct');
    const before = JSON.stringify(correct);

    expect(correct).toHaveLength(20);
    expect(new Set(correct.map(({ outputHash }) => outputHash)).size).toBe(20);
    for (const row of correct) {
      expect(() => boundary(row).parseResult(row.savedPostBoundaryTurnResult)).toThrow(z.ZodError);
    }
    expect(JSON.stringify(correct)).toBe(before);
  });

  it.each([
    'turnIntent',
    'adherenceClassification',
    'clinicalEvent',
    'informationNeed',
    'evidence',
    'clinicianReviewDraft',
    'safetyCandidate',
  ])('rejects provider-owned %s meaning even beside valid raw claims', (forbiddenField) => {
    const providerBoundary = boundary(fixture.rows[0]!);

    expect(() => providerBoundary.parseResult({ claims: [], [forbiddenField]: null })).toThrow(
      z.ZodError,
    );
  });

  it('round-trips bounded controls for previously correct recurrence, multi-claim, and empty turns', () => {
    const recurrence = fixture.rows.find(
      ({ turnId }) => turnId === '9ef73af1-4220-4943-81ba-e963da271dae',
    )!;
    const recurrenceBoundary = boundary(recurrence);
    const recurrenceClaim = {
      slot: 'claim_1',
      kind: 'recurrence' as const,
      quote: recurrence.messageBody,
      polarity: 'positive' as const,
      experiencer: 'patient' as const,
      status: 'current' as const,
      certainty: 'certain' as const,
      symptomText: 'dizziness',
    };
    expect(
      recurrenceBoundary.parseResult({
        claims: [
          {
            sourceRef: recurrenceBoundary.input.currentMessage.sourceRef,
            informationNeedRef: null,
            claim: recurrenceClaim,
          },
        ],
      }).claims[0]!.claim,
    ).toEqual(recurrenceClaim);

    const multiClaim = fixture.rows.find(
      ({ turnId }) => turnId === '63193030-f782-40f2-aa0e-ea2e543b583f',
    )!;
    const multiClaimBoundary = boundary(multiClaim);
    const symptomClaims = ['nausea', 'headache'].map((symptomText, index) => ({
      slot: `claim_${index + 1}`,
      kind: 'symptom' as const,
      quote: multiClaim.messageBody,
      polarity: 'positive' as const,
      experiencer: 'patient' as const,
      status: 'current' as const,
      certainty: 'certain' as const,
      symptomText,
      timeText: 'today',
    }));
    expect(
      multiClaimBoundary
        .parseResult({
          claims: symptomClaims.map((claim) => ({
            sourceRef: multiClaimBoundary.input.currentMessage.sourceRef,
            informationNeedRef: null,
            claim,
          })),
        })
        .claims.map(({ claim }) => claim),
    ).toEqual(symptomClaims);

    const empty = fixture.rows.find(
      ({ turnId }) => turnId === '13b183ad-9238-43aa-be8b-f00195e15f1f',
    )!;
    expect(boundary(empty).parseResult({ claims: [] })).toEqual({ claims: [] });
  });
});
