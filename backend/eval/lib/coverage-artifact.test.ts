/**
 * coverage-artifact.test.ts — the D2→D1 OnSIDES coverage handoff contract (review HIGH, 04-07).
 *
 * Offline + $0: pure builder + validator. Proves the writer→reader round-trip, the sort/version
 * stamping, and that a missing/malformed/stale artifact FAILS CLOSED (throws CoverageArtifactError).
 */
import { describe, it, expect } from 'vitest';
import {
  COVERAGE_ARTIFACT_VERSION,
  CoverageArtifactError,
  buildCoverageArtifact,
  coverageHandoffFromArtifact,
  parseCoverageArtifact,
} from './coverage-artifact.js';

const SRC = 'v3.1.1';

function build() {
  return buildCoverageArtifact({
    entries: [
      { ingredientRxcui: '6809', hasLabelData: true },
      { ingredientRxcui: '11289', hasLabelData: true },
      { ingredientRxcui: '99999999', hasLabelData: false, reason: 'no_onsides_label_data' },
    ],
    covered: ['11289', '6809'], // deliberately unsorted → the builder sorts
    uncovered: ['99999999'],
    allCovered: false,
    reviewedOverride: true,
    onsidesSourceVersion: SRC,
    generatedAt: '1970-01-01T00:00:00.000Z',
  });
}

describe('buildCoverageArtifact', () => {
  it('stamps kind/version/source, sorts covered + uncovered, and preserves per-entry reason', () => {
    const a = build();
    expect(a.kind).toBe('onsides-coverage');
    expect(a.artifactVersion).toBe(COVERAGE_ARTIFACT_VERSION);
    expect(a.onsidesSourceVersion).toBe(SRC);
    expect(a.covered).toEqual(['11289', '6809']); // sorted
    expect(a.uncovered).toEqual(['99999999']);
    expect(a.allCovered).toBe(false);
    expect(a.reviewedOverride).toBe(true);
    const uncoveredEntry = a.entries.find((e) => e.rxcui === '99999999');
    expect(uncoveredEntry).toMatchObject({ hasLabelData: false, reason: 'no_onsides_label_data' });
    // A covered entry carries no reason.
    expect(a.entries.find((e) => e.rxcui === '6809')?.reason).toBeUndefined();
  });

  it('emits a DATA-01-clean artifact — no patient id / reply text, only rxcuis + booleans', () => {
    const serialized = JSON.stringify(build());
    expect(serialized).not.toMatch(/patient|phone|"text"|reply|rawBody/i);
  });
});

describe('parseCoverageArtifact — fail-CLOSED validation', () => {
  it('round-trips a valid artifact through JSON', () => {
    const raw = JSON.parse(JSON.stringify(build()));
    const parsed = parseCoverageArtifact(raw, SRC);
    expect(parsed.covered).toEqual(['11289', '6809']);
    expect(parsed.uncovered).toEqual(['99999999']);
  });

  it('throws CoverageArtifactError on a malformed shape', () => {
    expect(() => parseCoverageArtifact({ kind: 'onsides-coverage', covered: 'nope' }, SRC)).toThrow(
      CoverageArtifactError,
    );
    expect(() => parseCoverageArtifact(null, SRC)).toThrow(CoverageArtifactError);
  });

  it('throws on an unknown artifact version (stale schema)', () => {
    const raw = {
      ...JSON.parse(JSON.stringify(build())),
      artifactVersion: COVERAGE_ARTIFACT_VERSION + 1,
    };
    expect(() => parseCoverageArtifact(raw, SRC)).toThrow(/version/i);
  });

  it('throws on an OnSIDES source-version mismatch (coverage built against a different asset)', () => {
    const raw = JSON.parse(JSON.stringify(build()));
    expect(() => parseCoverageArtifact(raw, 'v9.9.9')).toThrow(/OnSIDES/i);
  });
});

describe('coverageHandoffFromArtifact', () => {
  it('projects covered → covered and uncovered → excluded', () => {
    const handoff = coverageHandoffFromArtifact(build());
    expect(handoff.covered).toEqual(['11289', '6809']);
    expect(handoff.excluded).toEqual(['99999999']);
    expect(handoff.reviewedOverride).toBe(true);
    expect(handoff.onsidesSourceVersion).toBe(SRC);
  });
});
