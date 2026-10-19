import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const fixtureRoot = join(__dirname, 'fixtures');

const frozenFixtures = [
  {
    path: 'retained-matrix.v1.json',
    sha256: '0f1e0fd90538f9e01ec9693bb17c02de86929aa250fb6ff9cfb657e1a22829d4',
    caseCount: 35,
    sequenceInvariantCount: 10,
  },
  {
    path: 'blockers.v2.json',
    sha256: '3b7a0db4a4d5158bfcb42711f53cdc6fecccca3d8c64f2d077e1c20403e035c5',
    caseCount: 6,
  },
  {
    path: 'regressions.v2.json',
    sha256: 'ec5a24665e6b8ef2110929841127ee308f96a105d8333411cfdadb8d5e5c9756',
    caseCount: 6,
  },
] as const;

const fixtureSchema = z
  .object({
    schemaVersion: z.union([z.string(), z.number()]),
    cases: z.array(z.object({ id: z.string().min(1) }).passthrough()),
    sequenceInvariants: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

describe('frozen clinical-memory oracle', () => {
  it.each(frozenFixtures)('keeps $path byte-exact with unique case IDs', (fixture) => {
    const bytes = readFileSync(join(fixtureRoot, fixture.path));
    const parsed = fixtureSchema.parse(JSON.parse(bytes.toString('utf8')));

    expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.sha256);
    expect(parsed.cases).toHaveLength(fixture.caseCount);
    expect(new Set(parsed.cases.map(({ id }) => id)).size).toBe(fixture.caseCount);
    if ('sequenceInvariantCount' in fixture) {
      expect(parsed.sequenceInvariants).toHaveLength(fixture.sequenceInvariantCount);
    }
  });
});
