/**
 * ade-synonyms.test.ts — 04-06 component 2 (H8). The lay-phrase → MedDRA PT map is
 * authored from GENERAL lay-medical vocabulary, NOT from the gold ade_match phrasings
 * (that would be train-on-test — the held-out ade-match-gold.csv scores generalization).
 * These tests exercise the MECHANISM and the map's well-formedness, using generic
 * phrasings.
 */
import { describe, expect, it } from 'vitest';
import { ADE_SYNONYM_MAP, synonymHits } from './ade-synonyms.js';

describe('ADE_SYNONYM_MAP — well-formedness', () => {
  it('has a substantial map (≥40 entries) with non-empty canonical MedDRA PTs', () => {
    expect(ADE_SYNONYM_MAP.length).toBeGreaterThanOrEqual(40);
    for (const entry of ADE_SYNONYM_MAP) {
      expect(entry.pattern).toBeInstanceOf(RegExp);
      expect(entry.pts.length).toBeGreaterThan(0);
      for (const pt of entry.pts) {
        expect(pt).toMatch(/^[A-Z]/); // MedDRA PTs are capitalised
        expect(pt.trim()).toBe(pt);
        expect(pt.length).toBeGreaterThan(1);
      }
    }
  });

  it('every pattern is global-flag-free (avoids lastIndex statefulness across calls)', () => {
    for (const entry of ADE_SYNONYM_MAP) {
      expect(entry.pattern.global).toBe(false);
    }
  });
});

describe('synonymHits — mechanism', () => {
  it('maps common lay symptom phrases to their MedDRA PTs', () => {
    expect(synonymHits('my stomach is killing me').flatMap((h) => h.pts)).toContain('Abdominal pain');
    expect(synonymHits('I feel so nauseous today').flatMap((h) => h.pts)).toContain('Nausea');
    expect(synonymHits('the whole room is spinning').flatMap((h) => h.pts)).toContain('Dizziness');
    expect(synonymHits('I could not sleep at all').flatMap((h) => h.pts)).toContain('Insomnia');
    expect(synonymHits('my mouth is so dry').flatMap((h) => h.pts)).toContain('Dry mouth');
  });

  it('is case-insensitive and tolerates emoji/punctuation noise', () => {
    expect(synonymHits('THE ROOM IS SPINNING 😵!!').flatMap((h) => h.pts)).toContain('Dizziness');
  });

  it('returns the VERBATIM matched span (M1 — exact fragment, not the whole text)', () => {
    const hits = synonymHits('honestly my mouth is so dry since starting this');
    expect(hits.length).toBeGreaterThan(0);
    const span = hits[0]!.matchedPhrase;
    expect(span.length).toBeLessThan('honestly my mouth is so dry since starting this'.length);
    expect('honestly my mouth is so dry since starting this'.toLowerCase()).toContain(span.toLowerCase());
  });

  it('returns [] when no symptom phrase is present (deterministic across calls)', () => {
    expect(synonymHits('took it this morning with breakfast, all good')).toEqual([]);
    expect(synonymHits('yes done')).toEqual([]);
    // determinism: same input, same output twice (guards regex lastIndex bugs)
    const a = synonymHits('my head is pounding and I feel dizzy');
    const b = synonymHits('my head is pounding and I feel dizzy');
    expect(a).toEqual(b);
  });

  it('can surface multiple distinct symptoms in one message', () => {
    const pts = synonymHits('my head is pounding and the room is spinning').flatMap((h) => h.pts);
    expect(pts).toContain('Headache');
    expect(pts).toContain('Dizziness');
  });
});

describe('synonymHits — negation (healthcare MEDIUM-2)', () => {
  it('drops a symptom negated by a preceding negator', () => {
    expect(synonymHits('no nausea today')).toEqual([]);
    expect(synonymHits("I'm not dizzy at all")).toEqual([]);
    expect(synonymHits("haven't had a headache since")).toEqual([]);
    expect(synonymHits('denies any chest pain')).toEqual([]);
  });

  it('does NOT self-reject idioms whose negator is INSIDE the matched span (review constraint)', () => {
    expect(synonymHits('I have no appetite').flatMap((h) => h.pts)).toContain('Decreased appetite');
    expect(synonymHits("can't sleep at all").flatMap((h) => h.pts)).toContain('Insomnia');
    expect(synonymHits("I can't breathe").flatMap((h) => h.pts)).toContain('Dyspnoea');
  });

  it('still fires when the negation applies to a DIFFERENT, earlier clause', () => {
    // "no fever but so nauseous" — nausea is not negated
    expect(synonymHits('no fever but so nauseous').flatMap((h) => h.pts)).toContain('Nausea');
  });
});

describe('synonymHits — map corrections (healthcare MEDIUM-3/4, LOW-6)', () => {
  it('bare "libido"/positive mentions no longer map to Libido decreased', () => {
    expect(synonymHits('my libido is back to normal')).toEqual([]);
    expect(synonymHits('low sex drive lately').flatMap((h) => h.pts)).toContain('Libido decreased');
  });

  it('GI/abdominal cramps map to Abdominal pain, not Muscle spasms', () => {
    expect(synonymHits('bad stomach cramps').flatMap((h) => h.pts)).toContain('Abdominal pain');
    expect(synonymHits('leg cramps at night').flatMap((h) => h.pts)).toContain('Muscle spasms');
    expect(synonymHits('bad cramps')).toEqual([]); // bare "cramps" is too ambiguous to map
  });

  it('nightmares are matched (regex grouping fix)', () => {
    expect(synonymHits('terrible nightmares every night').flatMap((h) => h.pts)).toContain('Abnormal dreams');
  });
});
