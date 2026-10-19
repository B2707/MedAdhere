/**
 * runner.test.ts — the live-eval runner's contracts WITHOUT any live call:
 * U-24 pacing (limiter caps concurrency), U-23 seam (the injected classify fn
 * is the ONLY path — text goes to it and nowhere else), DATA-01 (persisted
 * results are id-keyed; raw reply text never appears in the results payload),
 * and per-row error isolation (one transient failure ≠ a failed run).
 */
import { describe, expect, it } from 'vitest';
import { runLiveEval } from './runner.js';

const mkRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `g${String(i + 1).padStart(3, '0')}`,
    text: `sample reply number ${i + 1} zzqx`,
    adherence_state: 'taken',
    reason_code: 'none',
    safety_flag: 'none',
    slice_hint: 'adherence_core',
    lexicon_tags: [] as string[],
  }));

describe('runLiveEval (injected classify fn — zero live calls)', () => {
  it('U-24: concurrency never exceeds the limiter bound (5)', async () => {
    let active = 0;
    let maxActive = 0;
    const classify = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' } as const;
    };
    await runLiveEval(mkRows(25) as never, classify);
    expect(maxActive).toBeLessThanOrEqual(5);
    expect(maxActive).toBeGreaterThan(1); // it actually parallelizes
  });

  it('U-23 seam: every row text reaches the injected classify fn exactly once', async () => {
    const seen: string[] = [];
    const classify = async (text: string) => {
      seen.push(text);
      return { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' } as const;
    };
    const rows = mkRows(7);
    await runLiveEval(rows as never, classify);
    expect(seen.sort()).toEqual(rows.map((r) => r.text).sort());
  });

  it('DATA-01: the persisted results payload is id-keyed and contains NO reply text', async () => {
    const classify = async () =>
      ({ adherence_state: 'skipped', reason_code: 'forgot', safety_flag: 'none' }) as const;
    const rows = mkRows(3);
    const out = await runLiveEval(rows as never, classify);
    const serialized = JSON.stringify(out.results);
    expect(serialized).toContain('g001');
    expect(serialized).not.toContain('zzqx'); // sentinel from the row texts
    for (const r of out.results) {
      expect(r).toHaveProperty('id');
      expect(r).toHaveProperty('predicted');
      expect(r).toHaveProperty('gold');
    }
  });

  it('a throwing row records an error outcome and the run continues', async () => {
    let n = 0;
    const classify = async () => {
      n++;
      if (n === 2) throw new Error('transient 529');
      return { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' } as const;
    };
    const out = await runLiveEval(mkRows(4) as never, classify);
    expect(out.results.filter((r) => r.error).length).toBe(1);
    expect(out.results.filter((r) => !r.error).length).toBe(3);
  });

  it('F5 (U-16 parity): persisted error is name+status only — raw SDK message never reaches results', async () => {
    const classify = async () => {
      const err = new Error('400 bad request: echoed-reply-sentinel-xyzzy inside the body');
      (err as Error & { status: number }).status = 400;
      err.name = 'BadRequestError';
      throw err;
    };
    const out = await runLiveEval(mkRows(1) as never, classify);
    const serialized = JSON.stringify(out.results);
    expect(serialized).not.toContain('xyzzy');
    expect(out.results[0].error).toBe('BadRequestError (status 400)');
  });
});
