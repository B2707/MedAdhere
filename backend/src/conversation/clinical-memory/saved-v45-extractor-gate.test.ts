import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const fixtureRoot = join(__dirname, 'fixtures');
const files = [
  'v45-semantic-review-part-0.json',
  'v45-semantic-review-part-1.json',
  'v45-semantic-review-part-2.json',
] as const;

const reviewRowSchema = z
  .object({
    scenarioId: z.string(),
    turnId: z.string(),
    outputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    reviewerKind: z.string(),
    reviewerModel: z.string(),
    codebookVersion: z.literal('semantic-review-codebook.v2'),
    codebookHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    metricResults: z.array(
      z
        .object({
          metricId: z.string(),
          passed: z.boolean(),
          failureCodes: z.array(z.number().int()),
        })
        .strict(),
    ),
    hashEcho: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .strict();

function rows() {
  return files.flatMap((file) =>
    reviewRowSchema
      .array()
      .parse(JSON.parse(readFileSync(join(fixtureRoot, file), 'utf8')))
      .map((row) => ({
        file,
        ...row,
      })),
  );
}

describe('saved v45 extractor evidence gate', () => {
  it('freezes the four genuine failed scenarios from saved semantic review', () => {
    const failedRows = rows().filter(({ metricResults }) =>
      metricResults.some(({ passed }) => !passed),
    );

    expect(failedRows).toHaveLength(7);
    expect([...new Set(failedRows.map(({ scenarioId }) => scenarioId))].sort()).toEqual([
      'conv-dev-005',
      'conv-dev-013',
      'conv-dev-021',
      'conv-dev-033',
    ]);
  });

  it('does not treat saved review summaries as bounded exact-source extraction outputs', () => {
    for (const row of rows()) {
      expect(Object.keys(row)).not.toContain('claims');
      expect(Object.keys(row)).not.toContain('providerOutput');
      expect(Object.keys(row)).not.toContain('messageBody');
      expect(Object.keys(row)).not.toContain('sourceSpans');
    }
  });
});
