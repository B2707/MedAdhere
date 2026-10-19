import { describe, it, expect } from 'vitest';
import {
  FDA_DISCLAIMER_RETRIEVED_DATE,
  FDA_DISCLAIMER_SOURCE,
  FDA_LABEL_DISCLAIMER,
} from './fda-disclaimer.js';

// U-27: the drug-label panel (06-04) and any label-context surface must render the
// openFDA disclaimer VERBATIM. This is the single cited source of that text.
describe('FDA_LABEL_DISCLAIMER — verbatim openFDA disclaimer (U-27)', () => {
  it('is a non-empty string', () => {
    expect(typeof FDA_LABEL_DISCLAIMER).toBe('string');
    expect(FDA_LABEL_DISCLAIMER.length).toBeGreaterThan(0);
  });

  it('contains the exact "Do not rely on openFDA" opening sentence', () => {
    expect(FDA_LABEL_DISCLAIMER).toContain(
      'Do not rely on openFDA to make decisions regarding medical care.',
    );
  });

  it('matches the official openFDA disclaimer text verbatim', () => {
    expect(FDA_LABEL_DISCLAIMER).toBe(
      'Do not rely on openFDA to make decisions regarding medical care. Always speak to your health provider about the risks and benefits of FDA-regulated products.',
    );
  });

  it('is a stable pinned literal (frozen via `as const`)', () => {
    // A string primitive is inherently immutable; the `as const` in the source
    // pins the literal type. This asserts the binding equals its own literal —
    // a runtime stability smoke check that the const was not accidentally widened.
    const pinned: 'Do not rely on openFDA to make decisions regarding medical care. Always speak to your health provider about the risks and benefits of FDA-regulated products.' =
      FDA_LABEL_DISCLAIMER;
    expect(pinned).toBe(FDA_LABEL_DISCLAIMER);
  });
});

describe('FDA_DISCLAIMER_SOURCE — one-line source attribution', () => {
  it('is the current openFDA drug-label API documentation URL', () => {
    expect(FDA_DISCLAIMER_SOURCE).toBe('https://open.fda.gov/apis/drug/label/');
  });

  it('pins the orchestrator-verified retrieval date', () => {
    expect(FDA_DISCLAIMER_RETRIEVED_DATE).toBe('2026-07-29');
  });
});
