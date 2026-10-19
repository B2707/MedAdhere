/**
 * screen-drug-names.test.ts — DB-free tests for the Phase-7 DRUG-03 operator screening glue.
 *
 * Upstream HTTP is injected. The key path test uses the real resolveDrugProfile implementation,
 * including its real RxNorm TTY=IN normalizer, and the real vendored OnSIDES JSON membership seam.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  parseDrugNames,
  runDrugNameScreening,
  runDrugNameScreeningCli,
  type ScreenDrugProfile,
} from './screen-drug-names.js';

type FakeResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
};

function makeKeyedFetch(
  routes: readonly { readonly match: string; readonly response: FakeResponse }[],
): typeof fetch {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    const route = routes.find(({ match }) => url.includes(match));
    if (!route) throw new Error(`no mocked route for URL: ${url}`);
    return {
      ok: route.response.ok,
      status: route.response.status,
      json: async () => route.response.body,
    } as Response;
  }) as unknown as typeof fetch;
}

const NULL_LABEL = { ok: false, status: 404, body: {} } as const;
const EMPTY_DPD = { ok: true, status: 200, body: [] } as const;

describe('screen-drug-names argv', () => {
  it('accepts one or more candidate names exactly as argv entries', () => {
    expect(parseDrugNames(['Warfarin', 'Amoxicillin Clavulanate'])).toEqual([
      'Warfarin',
      'Amoxicillin Clavulanate',
    ]);
  });

  it.each([[[]], [['']], [['   ']]])('rejects missing or blank medication names (%j)', (argv) => {
    expect(() => parseDrugNames(argv)).toThrow(/usage|name/i);
  });
});

describe('screen-drug-names offline screening', () => {
  it('exercises the freeze-time TTY=IN normalizer and reports the excluded source honestly', async () => {
    const fetchFn = makeKeyedFetch([
      {
        match: 'approximateTerm',
        response: {
          ok: true,
          status: 200,
          body: { approximateGroup: { candidate: [{ rxcui: '855332' }] } },
        },
      },
      {
        match: '/rxcui/855332/related.json?tty=IN',
        response: {
          ok: true,
          status: 200,
          body: {
            relatedGroup: {
              conceptGroup: [
                {
                  tty: 'IN',
                  conceptProperties: [{ rxcui: '11289', name: 'warfarin', tty: 'IN' }],
                },
              ],
            },
          },
        },
      },
      { match: 'api.fda.gov', response: NULL_LABEL },
      { match: 'drugproduct', response: EMPTY_DPD },
    ]);
    const lines: string[] = [];

    const result = await runDrugNameScreening(['Warfarin tablet'], {
      fetchFn,
      writeLine: (line) => lines.push(line),
    });

    expect(result.exitCode).toBe(0);
    expect(result.atLeastOnePasses).toBe(false);
    expect(result.entries).toEqual([
      {
        name: 'Warfarin tablet',
        ingredientRxcuis: ['11289'],
        onsidesCoveragePasses: false,
        status: 'uncovered',
      },
    ]);
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining('/rxcui/855332/related.json?tty=IN'),
    );
    expect(lines).toContain(
      'Warfarin tablet: ingredient RxCUI(s): 11289; OnSIDES coverage: UNCOVERED',
    );
    expect(lines.at(-1)).toBe(
      'SUMMARY: covered: 0; uncovered: 1; indeterminate: 0; ' +
        'at least one screened name passes OnSIDES coverage: NO',
    );
  });

  it('prints every result and passes the D2 summary when at least one name is covered', async () => {
    const profiles = new Map<string, ScreenDrugProfile>([
      [
        'Covered',
        {
          label_features_enabled: true,
          ingredient_rxcuis: ['11289'],
        },
      ],
      [
        'Uncovered combination',
        {
          label_features_enabled: true,
          ingredient_rxcuis: ['11289', '99999999'],
        },
      ],
    ]);
    const lines: string[] = [];

    const result = await runDrugNameScreening(['Covered', 'Uncovered combination'], {
      fetchFn: vi.fn(),
      resolveProfile: async (name) => profiles.get(name)!,
      hasLabelData: (rxcui) => rxcui === '11289',
      writeLine: (line) => lines.push(line),
    });

    expect(result.entries.map((entry) => entry.status)).toEqual(['covered', 'uncovered']);
    expect(result.atLeastOnePasses).toBe(true);
    expect(lines).toEqual([
      'Covered: ingredient RxCUI(s): 11289; OnSIDES coverage: COVERED',
      'Uncovered combination: ingredient RxCUI(s): 11289, 99999999; OnSIDES coverage: UNCOVERED',
      'SUMMARY: covered: 1; uncovered: 1; indeterminate: 0; ' +
        'at least one screened name passes OnSIDES coverage: YES',
    ]);
  });

  it('treats an unresolved profile as indeterminate with a nonzero exit', async () => {
    const lines: string[] = [];

    const result = await runDrugNameScreening(['Unknown'], {
      fetchFn: vi.fn(),
      resolveProfile: async () => ({
        label_features_enabled: false,
        reason: 'unresolved',
        rxcui: null,
        resolved_from_rxcui: null,
      }),
      writeLine: (line) => lines.push(line),
    });

    expect(result).toMatchObject({
      exitCode: 1,
      atLeastOnePasses: false,
      entries: [
        {
          name: 'Unknown',
          ingredientRxcuis: [],
          onsidesCoveragePasses: false,
          status: 'indeterminate',
          reason: 'unresolved',
        },
      ],
    });
    expect(lines).toEqual([
      'Unknown: ingredient RxCUI(s): none; OnSIDES coverage: INDETERMINATE (reason: unresolved)',
      'SUMMARY: covered: 0; uncovered: 0; indeterminate: 1; ' +
        'at least one screened name passes OnSIDES coverage: NO',
    ]);
  });

  it('returns nonzero when a real resolver network failure degrades to indeterminate', async () => {
    const lines: string[] = [];
    const errors: string[] = [];

    const exitCode = await runDrugNameScreeningCli(['Warfarin'], {
      fetchFn: vi.fn(async () => {
        throw new Error('ECONNRESET — simulated network failure');
      }) as unknown as typeof fetch,
      writeLine: (line) => lines.push(line),
      writeError: (line) => errors.push(line),
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual([]);
    expect(lines[0]).toMatch(/INDETERMINATE.*reason: unresolved/i);
    expect(lines.at(-1)).toMatch(/indeterminate: 1/i);
  });

  it('keeps the CLI exit zero for genuine resolved-but-uncovered OnSIDES coverage', async () => {
    const errors: string[] = [];

    const exitCode = await runDrugNameScreeningCli(['Unknown'], {
      fetchFn: vi.fn(),
      resolveProfile: async () => ({
        label_features_enabled: true,
        ingredient_rxcuis: ['99999999'],
      }),
      hasLabelData: () => false,
      writeLine: vi.fn(),
      writeError: (line) => errors.push(line),
    });

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
  });

  it('returns non-zero only for usage or internal errors', async () => {
    const usageErrors: string[] = [];
    const internalErrors: string[] = [];

    const usageExit = await runDrugNameScreeningCli([], {
      fetchFn: vi.fn(),
      writeLine: vi.fn(),
      writeError: (line) => usageErrors.push(line),
    });
    const internalExit = await runDrugNameScreeningCli(['Warfarin'], {
      fetchFn: vi.fn(),
      resolveProfile: async () => {
        throw new Error('resolver seam failed');
      },
      writeLine: vi.fn(),
      writeError: (line) => internalErrors.push(line),
    });

    expect(usageExit).toBe(1);
    expect(usageErrors).toEqual([expect.stringMatching(/usage:/)]);
    expect(internalExit).toBe(1);
    expect(internalErrors).toEqual(['screen-drug-names: resolver seam failed']);
  });

  it('uses the internal-error fallback when the CLI catches a non-Error thrown value', async () => {
    const errors: string[] = [];

    const exitCode = await runDrugNameScreeningCli(['Warfarin'], {
      fetchFn: vi.fn(),
      resolveProfile: async () => {
        throw 42;
      },
      writeLine: vi.fn(),
      writeError: (line) => errors.push(line),
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual(['screen-drug-names: internal error']);
  });
});
