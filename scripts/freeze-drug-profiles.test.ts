/**
 * freeze-drug-profiles.test.ts — network-free, DB-free unit test of the DRUG-01 offline freeze script.
 *
 * NO real network, NO real DB. Global `fetch` is mocked (an injected FetchFn — the script's `:96` seam)
 * and a fake pg-style query client is injected so the test drives resolution + normalization + assembly +
 * (gated) UPDATE in isolation. It proves the pre-D2 behaviors PLUS the 04-07 D2 additions:
 *   - resolved happy path (--apply): RxNorm approximateTerm → normalize TTY=IN → OpenFDA label → DPD.
 *   - dry-run default = NO write (MED-7).
 *   - warn-and-disable on unresolved (no candidate) / unresolved_ingredient (no TTY=IN) — no throw.
 *   - OpenFDA A4 fallback (name search) still on the CANDIDATE rxcui.
 *   - no-throw contract on upstream errors.
 *   - D2: candidate→ingredient normalization, candidate/ingredient RxCUI split, multi-ingredient handling,
 *     OnSIDES coverage gate over the real vendored asset, and the shared writer-side contract union.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveDrugProfile,
  freezePatient,
  runFreeze,
  runFreezeCli,
  normalizeToIngredientRxcui,
  checkOnsidesCoverage,
  collectResolvedIngredientRxcuis,
  type Patient,
  type QueryClient,
} from './freeze-drug-profiles.js';
import { drugProfileWriteSchema } from '@medadhere/shared';

/** A minimal fake pg-style client that records every query (text + params) for assertions. */
function makeFakeClient(): QueryClient & { calls: Array<{ text: string; params: unknown[] }> } {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  return {
    calls,
    query: vi.fn(async (text: string, params?: unknown[]) => {
      calls.push({ text, params: params ?? [] });
      return { rows: [] };
    }),
  };
}

/** Build a mocked global fetch from an ordered queue of {ok, status, json} responses. */
type FakeResponse = { ok: boolean; status: number; body: unknown };
function makeFetch(responses: FakeResponse[]): typeof fetch {
  const queue = [...responses];
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    void input;
    const next = queue.shift();
    if (!next) throw new Error('fetch called more times than the test queued');
    return {
      ok: next.ok,
      status: next.status,
      json: async () => next.body,
    } as Response;
  }) as unknown as typeof fetch;
}

/** A fetch keyed by URL substring → response (order-independent; used for the resolved happy path). */
function makeKeyedFetch(routes: Array<{ match: string; res: FakeResponse }>): typeof fetch {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    const hit = routes.find((r) => url.includes(r.match));
    if (!hit) throw new Error(`no mocked route for URL: ${url}`);
    return {
      ok: hit.res.ok,
      status: hit.res.status,
      json: async () => hit.res.body,
    } as Response;
  }) as unknown as typeof fetch;
}

const PATIENT: Patient = { id: 'p-1', medication_name: 'Warfarin' };

// The upstream payloads for a fully-resolved SINGLE-ingredient drug (warfarin, ingredient rxcui 11289).
const RX_OK = {
  approximateGroup: { candidate: [{ rxcui: '11289', rank: '1' }] },
};
// RxNorm /rxcui/{id}/related.json?tty=IN — warfarin's candidate (11289) IS an ingredient → returns itself.
const RELATED_SELF_IN = {
  relatedGroup: {
    rxcui: '11289',
    termType: ['IN'],
    conceptGroup: [
      { tty: 'IN', conceptProperties: [{ rxcui: '11289', name: 'warfarin', tty: 'IN' }] },
    ],
  },
};
const LABEL_OK = {
  results: [
    {
      boxed_warning: ['WARNING: BLEEDING RISK — warfarin can cause major or fatal bleeding.'],
      warnings_and_cautions: ['Tissue necrosis', 'Systemic atheroemboli'],
      adverse_reactions: ['Hemorrhage', 'Nausea'],
    },
  ],
};
const DPD_PRODUCT_OK = [{ drug_code: 12345, drug_identification_number: '02242924' }];
const DPD_TC_OK = [{ tc_atc_number: 'B01AA03' }];

/** The five keyed routes for a fully-resolved single-ingredient drug (order-independent). */
const RESOLVED_ROUTES: Array<{ match: string; res: FakeResponse }> = [
  { match: 'approximateTerm', res: { ok: true, status: 200, body: RX_OK } },
  { match: 'related.json', res: { ok: true, status: 200, body: RELATED_SELF_IN } },
  { match: 'api.fda.gov', res: { ok: true, status: 200, body: LABEL_OK } },
  { match: 'drugproduct', res: { ok: true, status: 200, body: DPD_PRODUCT_OK } },
  { match: 'therapeuticclass', res: { ok: true, status: 200, body: DPD_TC_OK } },
];

beforeEach(() => {
  vi.restoreAllMocks();
  // Silence the script's console banner/diagnostics during the test run.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveDrugProfile — DRUG-01 RxNorm → TTY=IN normalize → OpenFDA → DPD assembly', () => {
  it('assembles a resolved drug_profile_json (ingredient rxcui, provenance, boxed_warning, arrays, dpd) for a known drug', async () => {
    const fetchFn = makeKeyedFetch(RESOLVED_ROUTES);

    const profile = await resolveDrugProfile('Warfarin', fetchFn);

    expect(profile.label_features_enabled).toBe(true);
    if (profile.label_features_enabled) {
      expect(profile.rxcui).toBe('11289'); // ingredient (TTY=IN)
      expect(profile.resolved_from_rxcui).toBe('11289'); // candidate == ingredient here
      expect(profile.multi_ingredient).toBe(false);
      expect(profile.ingredient_rxcuis).toEqual(['11289']);
      expect(profile.multi_ingredient_limitation).toBeNull();
      expect(profile.boxed_warning_present).toBe(true);
      expect(profile.boxed_warning).toEqual(LABEL_OK.results[0]!.boxed_warning);
      expect(profile.warnings_and_cautions).toEqual(LABEL_OK.results[0]!.warnings_and_cautions);
      expect(profile.adverse_reactions).toEqual(LABEL_OK.results[0]!.adverse_reactions);
      expect(profile.dpd).toEqual({ din: '02242924', atc: 'B01AA03' });
      expect(typeof profile.source).toBe('string');
      expect(profile.source.length).toBeGreaterThan(0);
    }
  });

  it('warn-and-disable: RxNorm returns no candidate rxcui → {label_features_enabled:false, reason:"unresolved", rxcui:null} (no throw)', async () => {
    // Only the RxNorm approximateTerm call happens; empty candidate list → no rxcui → unresolved.
    const fetchFn = makeFetch([
      { ok: true, status: 200, body: { approximateGroup: { candidate: [] } } },
    ]);

    const profile = await resolveDrugProfile('Zxqynotadrug', fetchFn);

    expect(profile.label_features_enabled).toBe(false);
    if (!profile.label_features_enabled) {
      expect(profile.reason).toBe('unresolved');
      expect(profile.rxcui).toBeNull();
      expect(profile.resolved_from_rxcui).toBeNull();
    }
  });

  it('OpenFDA fallback (A4): rxcui search 404s → falls back to a generic_name/brand_name search before declaring unresolved', async () => {
    const calledUrls: string[] = [];
    const fetchFn = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calledUrls.push(url);
      if (url.includes('related.json')) {
        return { ok: true, status: 200, json: async () => RELATED_SELF_IN } as Response;
      }
      if (url.includes('rxnav.nlm.nih.gov')) {
        return { ok: true, status: 200, json: async () => RX_OK } as Response;
      }
      if (url.includes('api.fda.gov')) {
        // The rxcui-keyed search 404s; the name-keyed fallback succeeds.
        if (url.includes('openfda.rxcui')) {
          return { ok: false, status: 404, json: async () => ({}) } as Response;
        }
        return { ok: true, status: 200, json: async () => LABEL_OK } as Response;
      }
      if (url.includes('drugproduct')) {
        return { ok: true, status: 200, json: async () => DPD_PRODUCT_OK } as Response;
      }
      if (url.includes('therapeuticclass')) {
        return { ok: true, status: 200, json: async () => DPD_TC_OK } as Response;
      }
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const profile = await resolveDrugProfile('Warfarin', fetchFn);

    // The fallback path was exercised: at least one rxcui search AND one name-based search.
    const fdaCalls = calledUrls.filter((u) => u.includes('api.fda.gov'));
    expect(fdaCalls.some((u) => u.includes('openfda.rxcui'))).toBe(true);
    expect(fdaCalls.some((u) => /generic_name|brand_name/.test(u))).toBe(true);
    // And the fallback resolved a label.
    expect(profile.label_features_enabled).toBe(true);
  });

  it('no-throw contract: a network error from an upstream API degrades to warn-and-disable (never throws)', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNRESET — simulated network failure');
    }) as unknown as typeof fetch;

    // Must NOT reject.
    const profile = await resolveDrugProfile('Warfarin', fetchFn);

    expect(profile.label_features_enabled).toBe(false);
    if (!profile.label_features_enabled) {
      expect(profile.reason).toBe('unresolved');
    }
  });

  it('(04-07 :289) ingredient resolves but OpenFDA label 404s → RESOLVED (OnSIDES-matchable), ingredient rxcui KEPT, FDA context null', async () => {
    // The 04-07 freeze-correctness decision: a failed OpenFDA label must NOT kill OnSIDES. OnSIDES ADE
    // matching is keyed by the INGREDIENT rxcui and is independent of the OpenFDA label (keyed by the
    // candidate), so the resolved ingredient is preserved and the profile stays label_features_enabled
    // — with null FDA-label context — rather than being nulled to unresolved.
    const productCandidate = { approximateGroup: { candidate: [{ rxcui: '855332', rank: '1' }] } };
    const relatedProductToIn = {
      relatedGroup: {
        conceptGroup: [
          { tty: 'IN', conceptProperties: [{ rxcui: '11289', name: 'warfarin', tty: 'IN' }] },
        ],
      },
    };
    const fetchFn = makeKeyedFetch([
      { match: 'approximateTerm', res: { ok: true, status: 200, body: productCandidate } },
      { match: 'related.json', res: { ok: true, status: 200, body: relatedProductToIn } },
      // OpenFDA: BOTH the rxcui-keyed lookup AND the name fallback 404 → no usable label.
      { match: 'api.fda.gov', res: { ok: false, status: 404, body: {} } },
      // DPD supplementary lookup also unavailable → dpd stays null (independent of the label outcome).
      { match: 'drugproduct', res: { ok: false, status: 404, body: {} } },
    ]);

    const profile = await resolveDrugProfile('SomeProduct', fetchFn);

    expect(profile.label_features_enabled).toBe(true); // NOT nulled to unresolved
    if (profile.label_features_enabled) {
      expect(profile.rxcui).toBe('11289'); // the ingredient (OnSIDES key) is PRESERVED
      expect(profile.resolved_from_rxcui).toBe('855332');
      // No FDA label context — the fields are null and provenance marks the OnSIDES-only source.
      expect(profile.boxed_warning).toBeNull();
      expect(profile.boxed_warning_present).toBe(false);
      expect(profile.warnings_and_cautions).toBeNull();
      expect(profile.adverse_reactions).toBeNull();
      expect(profile.dpd).toEqual({ din: null, atc: null });
      expect(profile.source).toMatch(/no OpenFDA label/i);
      // The preserved ingredient is part of the OnSIDES coverage set — OnSIDES CAN still match it.
      expect(
        collectResolvedIngredientRxcuis([
          { patientId: 'x', medicationName: 'y', profile, wasWritten: false },
        ]),
      ).toEqual(['11289']);
      // It still round-trips through the shared writer union (a valid resolved write profile).
      expect(drugProfileWriteSchema.safeParse(profile).success).toBe(true);
    }
  });
});

describe('normalizeToIngredientRxcui — RxNorm /rxcui/{id}/related.json?tty=IN (04-07 D2 fix)', () => {
  it('(#1) a product/clinical-drug candidate rxcui → returns the ingredient TTY=IN rxcui', async () => {
    // approximateTerm rank-1 is a product/clinical-drug rxcui (855332 = "warfarin 5 MG Oral Tablet"-shaped);
    // related?tty=IN resolves it to its ingredient (warfarin, 11289 — the OnSIDES key space).
    const relatedProductToIn = {
      relatedGroup: {
        rxcui: '',
        conceptGroup: [
          { tty: 'IN', conceptProperties: [{ rxcui: '11289', name: 'warfarin', tty: 'IN' }] },
        ],
      },
    };
    const fetchFn = makeKeyedFetch([
      { match: 'related.json', res: { ok: true, status: 200, body: relatedProductToIn } },
    ]);

    const ingredients = await normalizeToIngredientRxcui('855332', fetchFn);

    expect(ingredients).toEqual(['11289']);
  });

  it('(#2) an already-ingredient candidate → returns itself', async () => {
    const fetchFn = makeKeyedFetch([
      { match: 'related.json', res: { ok: true, status: 200, body: RELATED_SELF_IN } },
    ]);

    const ingredients = await normalizeToIngredientRxcui('11289', fetchFn);

    expect(ingredients).toEqual(['11289']);
  });

  it('returns [] when related?tty=IN carries no IN concept (empty conceptProperties)', async () => {
    const emptyIn = {
      relatedGroup: { rxcui: '', conceptGroup: [{ tty: 'IN', conceptProperties: [] }] },
    };
    const fetchFn = makeKeyedFetch([
      { match: 'related.json', res: { ok: true, status: 200, body: emptyIn } },
    ]);

    expect(await normalizeToIngredientRxcui('999999', fetchFn)).toEqual([]);
  });

  it('returns [] when the related endpoint 404s (never throws here)', async () => {
    const fetchFn = makeFetch([{ ok: false, status: 404, body: {} }]);
    expect(await normalizeToIngredientRxcui('999999', fetchFn)).toEqual([]);
  });
});

describe('resolveDrugProfile — D2 candidate/ingredient split + unresolved_ingredient guard', () => {
  it('(#3) related?tty=IN empty (no IN) → warn-and-disable (unresolved_ingredient), NOT a stored product rxcui', async () => {
    // approximateTerm resolves to a PRODUCT rxcui (855332) that has no TTY=IN ingredient.
    const productCandidate = { approximateGroup: { candidate: [{ rxcui: '855332', rank: '1' }] } };
    const emptyIn = {
      relatedGroup: { rxcui: '', conceptGroup: [{ tty: 'IN', conceptProperties: [] }] },
    };
    const fetchFn = makeKeyedFetch([
      { match: 'approximateTerm', res: { ok: true, status: 200, body: productCandidate } },
      { match: 'related.json', res: { ok: true, status: 200, body: emptyIn } },
      // OpenFDA/DPD must NOT be needed — the run short-circuits at the empty-IN guard.
    ]);

    const profile = await resolveDrugProfile('SomeProduct', fetchFn);

    expect(profile.label_features_enabled).toBe(false);
    if (!profile.label_features_enabled) {
      expect(profile.reason).toBe('unresolved_ingredient');
      // The whole point of the finding: NEVER store the product rxcui as the frozen ingredient rxcui.
      expect(profile.rxcui).toBeNull();
      // Provenance of what we DID resolve is retained for hand review.
      expect(profile.resolved_from_rxcui).toBe('855332');
    }
  });

  it('(#5) OpenFDA lookup uses the CANDIDATE rxcui while the frozen ingredient rxcui is the TTY=IN one; both persisted', async () => {
    const calledUrls: string[] = [];
    // Product candidate 855332 → ingredient 11289.
    const productCandidate = { approximateGroup: { candidate: [{ rxcui: '855332', rank: '1' }] } };
    const relatedProductToIn = {
      relatedGroup: {
        conceptGroup: [
          { tty: 'IN', conceptProperties: [{ rxcui: '11289', name: 'warfarin', tty: 'IN' }] },
        ],
      },
    };
    const fetchFn = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calledUrls.push(url);
      if (url.includes('approximateTerm')) {
        return { ok: true, status: 200, json: async () => productCandidate } as Response;
      }
      if (url.includes('related.json')) {
        return { ok: true, status: 200, json: async () => relatedProductToIn } as Response;
      }
      if (url.includes('api.fda.gov')) {
        return { ok: true, status: 200, json: async () => LABEL_OK } as Response;
      }
      if (url.includes('drugproduct')) {
        return { ok: true, status: 200, json: async () => DPD_PRODUCT_OK } as Response;
      }
      if (url.includes('therapeuticclass')) {
        return { ok: true, status: 200, json: async () => DPD_TC_OK } as Response;
      }
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const profile = await resolveDrugProfile('SomeProduct', fetchFn);

    // OpenFDA primary lookup is keyed by the CANDIDATE rxcui (855332), NOT the ingredient (11289).
    const fdaCalls = calledUrls.filter((u) => u.includes('api.fda.gov'));
    expect(fdaCalls.some((u) => u.includes('openfda.rxcui:855332'))).toBe(true);
    expect(fdaCalls.some((u) => u.includes('openfda.rxcui:11289'))).toBe(false);

    expect(profile.label_features_enabled).toBe(true);
    if (profile.label_features_enabled) {
      expect(profile.rxcui).toBe('11289'); // frozen ingredient (OnSIDES key)
      expect(profile.resolved_from_rxcui).toBe('855332'); // candidate (OpenFDA key)
      // The frozen ingredient rxcui is the one OnSIDES coverage checks.
      expect(
        collectResolvedIngredientRxcuis([
          { patientId: 'x', medicationName: 'y', profile, wasWritten: false },
        ]),
      ).toEqual(['11289']);
    }
  });

  it('(#6) combination-drug candidate → multi_ingredient flag + primary ingredient + full list + limitation', async () => {
    // amoxicillin/clavulanate: candidate product → two TTY=IN ingredients (723, 48937).
    const comboCandidate = { approximateGroup: { candidate: [{ rxcui: '617296', rank: '1' }] } };
    const relatedMultiIn = {
      relatedGroup: {
        conceptGroup: [
          {
            tty: 'IN',
            conceptProperties: [
              { rxcui: '723', name: 'amoxicillin', tty: 'IN' },
              { rxcui: '48937', name: 'clavulanate', tty: 'IN' },
            ],
          },
        ],
      },
    };
    const fetchFn = makeKeyedFetch([
      { match: 'approximateTerm', res: { ok: true, status: 200, body: comboCandidate } },
      { match: 'related.json', res: { ok: true, status: 200, body: relatedMultiIn } },
      { match: 'api.fda.gov', res: { ok: true, status: 200, body: LABEL_OK } },
      { match: 'drugproduct', res: { ok: true, status: 200, body: DPD_PRODUCT_OK } },
      { match: 'therapeuticclass', res: { ok: true, status: 200, body: DPD_TC_OK } },
    ]);

    const profile = await resolveDrugProfile('Amoxicillin-Clavulanate', fetchFn);

    expect(profile.label_features_enabled).toBe(true);
    if (profile.label_features_enabled) {
      expect(profile.multi_ingredient).toBe(true);
      expect(profile.rxcui).toBe('723'); // primary (ingredient_rxcuis[0])
      expect(profile.ingredient_rxcuis).toEqual(['723', '48937']);
      expect(profile.resolved_from_rxcui).toBe('617296');
      expect(typeof profile.multi_ingredient_limitation).toBe('string');
      expect(profile.multi_ingredient_limitation).toMatch(/single-ingredient|OnSIDES/i);
    }
  });
});

describe('checkOnsidesCoverage — approved OnSIDES cohort slice', () => {
  it('covers RxCUI 6809 and records every other resolved ingredient as unavailable', () => {
    const report = checkOnsidesCoverage(['11289', '6809', '198211', '99999999']);

    const byRxcui = new Map(report.entries.map((e) => [e.ingredientRxcui, e]));
    expect(byRxcui.get('6809')).toEqual({ ingredientRxcui: '6809', hasLabelData: true });
    for (const rxcui of ['11289', '198211', '99999999']) {
      expect(byRxcui.get(rxcui)).toMatchObject({
        hasLabelData: false,
        reason: 'no_onsides_label_data',
      });
    }
    expect(report.covered).toEqual(['6809']);
    expect(report.uncovered).toEqual(['11289', '198211', '99999999']);
    expect(report.allCovered).toBe(false);
  });

  it('passes only when every resolved ingredient is in the approved slice', () => {
    expect(checkOnsidesCoverage(['11289', '6809']).allCovered).toBe(false);
    expect(checkOnsidesCoverage(['6809']).allCovered).toBe(true);
    expect(checkOnsidesCoverage([]).allCovered).toBe(true); // vacuously true — nothing resolved
    expect(checkOnsidesCoverage(['99999999']).allCovered).toBe(false);
  });
});

describe('freezePatient — MED-7 dry-run/apply gating of the parameterized UPDATE', () => {
  it('--apply: issues the parameterized UPDATE patient SET drug_profile_json=$1, drug_profile_fetched_at=now() WHERE id=$2', async () => {
    const fetchFn = makeKeyedFetch(RESOLVED_ROUTES);
    const client = makeFakeClient();

    const { profile, wasWritten } = await freezePatient(PATIENT, client, fetchFn, { apply: true });

    const updates = client.calls.filter((c) => /UPDATE\s+patient/i.test(c.text));
    expect(updates).toHaveLength(1);
    const upd = updates[0]!;
    expect(upd.text).toMatch(/drug_profile_json\s*=\s*\$1/i);
    expect(upd.text).toMatch(/drug_profile_fetched_at\s*=\s*now\(\)/i);
    expect(upd.text).toMatch(/WHERE\s+id\s*=\s*\$2/i);
    expect(upd.params[1]).toBe('p-1');
    const written =
      typeof upd.params[0] === 'string' ? JSON.parse(upd.params[0] as string) : upd.params[0];
    expect((written as { label_features_enabled: boolean }).label_features_enabled).toBe(true);
    expect(profile.label_features_enabled).toBe(true);
    expect(wasWritten).toBe(true); // the parameterized UPDATE actually resolved
  });

  it('dry-run default (apply:false) issues NO UPDATE patient statement — zero DB writes (MED-7)', async () => {
    const fetchFn = makeKeyedFetch(RESOLVED_ROUTES);
    const client = makeFakeClient();

    const { profile, wasWritten } = await freezePatient(PATIENT, client, fetchFn, { apply: false });

    expect(profile.label_features_enabled).toBe(true);
    expect(wasWritten).toBe(false); // dry-run never writes
    const updates = client.calls.filter((c) => /UPDATE\s+patient/i.test(c.text));
    expect(updates).toHaveLength(0);
    expect(client.calls).toHaveLength(0);
  });

  it('--apply on an unresolved drug writes the warn-and-disable shape (label_features_enabled:false) and never throws', async () => {
    const fetchFn = makeFetch([
      { ok: true, status: 200, body: { approximateGroup: { candidate: [] } } },
    ]);
    const client = makeFakeClient();

    const { profile, wasWritten } = await freezePatient(PATIENT, client, fetchFn, { apply: true });

    expect(profile.label_features_enabled).toBe(false);
    expect(wasWritten).toBe(true); // the warn-and-disable shape WAS persisted (write succeeded)
    const updates = client.calls.filter((c) => /UPDATE\s+patient/i.test(c.text));
    expect(updates).toHaveLength(1);
    const written =
      typeof updates[0]!.params[0] === 'string'
        ? JSON.parse(updates[0]!.params[0] as string)
        : updates[0]!.params[0];
    expect((written as { label_features_enabled: boolean }).label_features_enabled).toBe(false);
    expect((written as { reason: string }).reason).toBe('unresolved');
  });
});

describe('runFreeze — orchestration: per-patient try/catch keeps the run going (Pitfall 6, no hard-fail)', () => {
  it('one patient throwing does NOT abort the whole run — all patients are processed', async () => {
    const patients: Patient[] = [
      { id: 'p-1', medication_name: 'BoomDrug' }, // will throw inside resolution
      { id: 'p-2', medication_name: 'Warfarin' }, // resolves fine
    ];
    const client = makeFakeClient();

    const fetchFn = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('BoomDrug')) throw new Error('boom');
      if (url.includes('related.json')) {
        return { ok: true, status: 200, json: async () => RELATED_SELF_IN } as Response;
      }
      if (url.includes('rxnav.nlm.nih.gov')) {
        return { ok: true, status: 200, json: async () => RX_OK } as Response;
      }
      if (url.includes('api.fda.gov')) {
        return { ok: true, status: 200, json: async () => LABEL_OK } as Response;
      }
      if (url.includes('drugproduct')) {
        return { ok: true, status: 200, json: async () => DPD_PRODUCT_OK } as Response;
      }
      if (url.includes('therapeuticclass')) {
        return { ok: true, status: 200, json: async () => DPD_TC_OK } as Response;
      }
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const results = await runFreeze(patients, client, fetchFn, { apply: true });

    expect(results).toHaveLength(2);
    expect(results[0]!.profile.label_features_enabled).toBe(false); // p-1 degraded
    expect(results[1]!.profile.label_features_enabled).toBe(true); // p-2 resolved
    const updates = client.calls.filter((c) => /UPDATE\s+patient/i.test(c.text));
    expect(updates).toHaveLength(2);
  });
});

describe('(#7) shared writer-side contract — freeze profiles parse against drugProfileWriteSchema', () => {
  it('resolved, unresolved, unresolved_ingredient, and multi-ingredient profiles all satisfy the shared union', async () => {
    // Representative resolved (single ingredient).
    const resolved = await resolveDrugProfile('Warfarin', makeKeyedFetch(RESOLVED_ROUTES));
    // Representative multi-ingredient resolved.
    const multi = await resolveDrugProfile(
      'Amoxicillin-Clavulanate',
      makeKeyedFetch([
        {
          match: 'approximateTerm',
          res: {
            ok: true,
            status: 200,
            body: { approximateGroup: { candidate: [{ rxcui: '617296' }] } },
          },
        },
        {
          match: 'related.json',
          res: {
            ok: true,
            status: 200,
            body: {
              relatedGroup: {
                conceptGroup: [
                  {
                    tty: 'IN',
                    conceptProperties: [
                      { rxcui: '723', tty: 'IN' },
                      { rxcui: '48937', tty: 'IN' },
                    ],
                  },
                ],
              },
            },
          },
        },
        { match: 'api.fda.gov', res: { ok: true, status: 200, body: LABEL_OK } },
        { match: 'drugproduct', res: { ok: true, status: 200, body: DPD_PRODUCT_OK } },
        { match: 'therapeuticclass', res: { ok: true, status: 200, body: DPD_TC_OK } },
      ]),
    );
    // Representative unresolved (no candidate).
    const unresolved = await resolveDrugProfile(
      'Zxqynotadrug',
      makeFetch([{ ok: true, status: 200, body: { approximateGroup: { candidate: [] } } }]),
    );
    // Representative unresolved_ingredient (candidate had no TTY=IN).
    const unresolvedIngredient = await resolveDrugProfile(
      'SomeProduct',
      makeKeyedFetch([
        {
          match: 'approximateTerm',
          res: {
            ok: true,
            status: 200,
            body: { approximateGroup: { candidate: [{ rxcui: '855332' }] } },
          },
        },
        {
          match: 'related.json',
          res: {
            ok: true,
            status: 200,
            body: { relatedGroup: { conceptGroup: [{ tty: 'IN', conceptProperties: [] }] } },
          },
        },
      ]),
    );

    // Every representative writer output round-trips through the shared discriminated union.
    for (const profile of [resolved, multi, unresolved, unresolvedIngredient]) {
      expect(drugProfileWriteSchema.safeParse(profile).success).toBe(true);
    }
    // Sanity: the reasons the two unresolved profiles carry are the two allowed literals.
    expect((unresolved as { reason: string }).reason).toBe('unresolved');
    expect((unresolvedIngredient as { reason: string }).reason).toBe('unresolved_ingredient');
  });

  it('the shared union REJECTS malformed writer profiles (pins the contract, not just accepts anything)', () => {
    // Resolved profile missing the new provenance field is rejected.
    expect(
      drugProfileWriteSchema.safeParse({
        label_features_enabled: true,
        rxcui: '11289',
        // resolved_from_rxcui missing
        multi_ingredient: false,
        ingredient_rxcuis: ['11289'],
        boxed_warning_present: false,
        boxed_warning: null,
        warnings_and_cautions: null,
        adverse_reactions: null,
        dpd: { din: null, atc: null },
        source: 'test',
        multi_ingredient_limitation: null,
      }).success,
    ).toBe(false);

    // An unknown unresolved reason is rejected.
    expect(
      drugProfileWriteSchema.safeParse({
        label_features_enabled: false,
        reason: 'bogus',
        rxcui: null,
        resolved_from_rxcui: null,
      }).success,
    ).toBe(false);
  });
});

describe('(04-07 :396) --apply write success drives [written] vs [WRITE FAILED] + a non-zero exit', () => {
  it('a DB-write failure keeps the RESOLVED profile, reports wasWritten:false + writeError (never masqueraded as unresolved)', async () => {
    const fetchFn = makeKeyedFetch(RESOLVED_ROUTES);
    const rejectingClient: QueryClient = {
      query: vi.fn(async () => {
        throw new Error('ECONNRESET — RDS failover mid-write');
      }),
    };

    const outcome = await freezePatient(PATIENT, rejectingClient, fetchFn, { apply: true });

    // The write FAILED, but the real resolution is preserved — the tag can be honest, not [written].
    expect(outcome.wasWritten).toBe(false);
    expect(outcome.writeError).toBeTruthy();
    expect(outcome.profile.label_features_enabled).toBe(true); // NOT nulled to unresolved
  });

  it('runFreezeCli: a rejecting client surfaces failedWrites + a non-zero exitCode, and still writes the coverage artifact', async () => {
    const writeFile = vi.fn();
    const result = await runFreezeCli({
      patients: [PATIENT], // Warfarin → ingredient 11289 (covered) so coverage does not confound the exit
      client: {
        query: vi.fn(async () => {
          throw new Error('ECONNRESET — write path down');
        }),
      },
      fetchFn: makeKeyedFetch(RESOLVED_ROUTES),
      options: { apply: true, coverageOverride: false },
      writeFile,
      coverageArtifactPath: '/tmp/onsides-coverage-test.json',
      now: () => new Date(0),
      hasLabelData: () => true,
    });

    expect(result.failedWrites).toEqual(['p-1']);
    expect(result.results[0]!.wasWritten).toBe(false);
    expect(result.results[0]!.writeError).toBeTruthy();
    expect(result.exitCode).toBe(1); // ENFORCED — a real write failure is a hard non-zero exit
    // The coverage artifact is still persisted (coverage was clean here — 11289 is vendored).
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(result.coverage.allCovered).toBe(true);
  });
});

describe('runFreezeCli — ENFORCE + CONSUME the OnSIDES coverage gate (review HIGH, 04-07)', () => {
  // A drug whose ingredient rxcui (99999999) is NOT in the 15-ingredient vendored asset → uncovered.
  const novelDrugRoutes: Array<{ match: string; res: FakeResponse }> = [
    {
      match: 'approximateTerm',
      res: {
        ok: true,
        status: 200,
        body: { approximateGroup: { candidate: [{ rxcui: '99999999', rank: '1' }] } },
      },
    },
    {
      match: 'related.json',
      res: {
        ok: true,
        status: 200,
        body: {
          relatedGroup: {
            conceptGroup: [{ tty: 'IN', conceptProperties: [{ rxcui: '99999999', tty: 'IN' }] }],
          },
        },
      },
    },
    { match: 'api.fda.gov', res: { ok: true, status: 200, body: LABEL_OK } },
    { match: 'drugproduct', res: { ok: true, status: 200, body: DPD_PRODUCT_OK } },
    { match: 'therapeuticclass', res: { ok: true, status: 200, body: DPD_TC_OK } },
  ];

  it('(a) exits NON-ZERO when a resolved cohort ingredient has NO OnSIDES data (no override) + persists the DATA-01 artifact', async () => {
    const writeFile = vi.fn();
    const result = await runFreezeCli({
      patients: [{ id: 'p-9', medication_name: 'NovelDrug' }],
      client: makeFakeClient(),
      fetchFn: makeKeyedFetch(novelDrugRoutes),
      options: { apply: false, coverageOverride: false },
      writeFile,
      coverageArtifactPath: '/tmp/onsides-coverage-test.json',
      now: () => new Date(0),
    });

    expect(result.coverage.allCovered).toBe(false);
    expect(result.coverage.uncovered).toEqual(['99999999']);
    expect(result.exitCode).toBe(1); // ENFORCED — no longer a bare console.warn that exits 0

    // CONSUMED: a machine-readable artifact is persisted (the D2→D1 handoff run-eval loads).
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, payload] = writeFile.mock.calls[0]!;
    expect(path).toBe('/tmp/onsides-coverage-test.json');
    const artifact = JSON.parse(payload as string);
    expect(artifact.kind).toBe('onsides-coverage');
    expect(artifact.covered).toEqual([]);
    expect(artifact.uncovered).toEqual(['99999999']);
    expect(artifact.allCovered).toBe(false);
    expect(artifact.reviewedOverride).toBe(false);
    // The uncovered ingredient is recorded as an explicit no_onsides_label_data disposition.
    const entry = artifact.entries.find((e: { rxcui: string }) => e.rxcui === '99999999');
    expect(entry).toMatchObject({ hasLabelData: false, reason: 'no_onsides_label_data' });
    // DATA-01: the coverage artifact carries NO patient id and NO reply/med text.
    expect(payload).not.toContain('p-9');
    expect(payload).not.toContain('NovelDrug');
  });

  it('(a2) an explicit reviewed override downgrades the uncovered gate to deliberate exclusions (exit 0)', async () => {
    const writeFile = vi.fn();
    const result = await runFreezeCli({
      patients: [{ id: 'p-9', medication_name: 'NovelDrug' }],
      client: makeFakeClient(),
      fetchFn: makeKeyedFetch(novelDrugRoutes),
      options: { apply: false, coverageOverride: true },
      writeFile,
      coverageArtifactPath: '/tmp/onsides-coverage-test.json',
      now: () => new Date(0),
    });

    expect(result.coverage.allCovered).toBe(false);
    expect(result.exitCode).toBe(0); // reviewed override → deliberate exclusion, not a hard failure
    const artifact = JSON.parse(writeFile.mock.calls[0]![1] as string);
    expect(artifact.reviewedOverride).toBe(true);
    expect(artifact.uncovered).toEqual(['99999999']);
  });

  it('(a3) a fully-covered cohort exits 0 with allCovered:true and no exclusions', async () => {
    const writeFile = vi.fn();
    const result = await runFreezeCli({
      patients: [PATIENT],
      client: makeFakeClient(),
      fetchFn: makeKeyedFetch(RESOLVED_ROUTES),
      options: { apply: false, coverageOverride: false },
      writeFile,
      coverageArtifactPath: '/tmp/onsides-coverage-test.json',
      now: () => new Date(0),
      hasLabelData: () => true,
    });

    expect(result.coverage.allCovered).toBe(true);
    expect(result.exitCode).toBe(0);
    const artifact = JSON.parse(writeFile.mock.calls[0]![1] as string);
    expect(artifact.covered).toEqual(['11289']);
    expect(artifact.uncovered).toEqual([]);
    expect(artifact.allCovered).toBe(true);
  });
});
