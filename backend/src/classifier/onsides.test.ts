import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  ONSIDES_ASSET_FILE,
  ONSIDES_SOURCE_VERSION,
  loadOnsidesIndex,
  onsidesEffectsForRxcui,
  onsidesHasLabelData,
} from './onsides.js';

const COHORT_RXCUIS = ['6809'] as const;
const assetBytes = statSync(join(__dirname, ONSIDES_ASSET_FILE)).size;

describe('vendored OnSIDES v3.1.1 cohort slice', () => {
  it('rejects an unverified source archive without overwriting an existing asset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vendor-onsides-'));
    const csvDir = join(dir, 'csv');
    const output = join(dir, 'out.json');
    const archive = join(dir, 'wrong.zip');

    try {
      mkdirSync(csvDir);
      writeFileSync(
        join(csvDir, 'vocab_rxnorm_ingredient.csv'),
        'rxnorm_id,rxnorm_name\n6809,metformin\n',
      );
      writeFileSync(
        join(csvDir, 'vocab_rxnorm_ingredient_to_product.csv'),
        'product_id,ingredient_id\n1,6809\n',
      );
      writeFileSync(join(csvDir, 'product_to_rxnorm.csv'), 'label_id,rxnorm_product_id\n1,1\n');
      writeFileSync(
        join(csvDir, 'vocab_meddra_adverse_effect.csv'),
        'meddra_id,meddra_name,meddra_term_type\n10028813,Nausea,PT\n',
      );
      writeFileSync(
        join(csvDir, 'product_adverse_effect.csv'),
        'product_label_id,effect_id,label_section,effect_meddra_id\n1,1,AR,10028813\n',
      );
      writeFileSync(archive, 'not the pinned archive');
      writeFileSync(output, 'preserve me');

      const result = spawnSync(
        process.execPath,
        [join(__dirname, '../../../scripts/vendor-onsides.mjs'), dir, output, archive],
        { encoding: 'utf8' },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/archive|sha-256|84,862,297/i);
      expect(readFileSync(output, 'utf8')).toBe('preserve me');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('covers the enrolled metformin ingredient RxCUI and no unused drugs', () => {
    const idx = loadOnsidesIndex();

    expect(Object.keys(idx.labels)).toEqual([...COHORT_RXCUIS]);
    expect(idx.meta.rxcui_count).toBe(COHORT_RXCUIS.length);
    expect(idx.labels['6809']?.ingredient?.toLowerCase()).toContain('metformin');
    expect(onsidesHasLabelData('6809')).toBe(true);
    expect(onsidesEffectsForRxcui('6809').length).toBeGreaterThan(0);
  });

  it('is compact, pins the source tag, and contains unique MedDRA PT rows', () => {
    const idx = loadOnsidesIndex();
    const raw = readFileSync(join(__dirname, ONSIDES_ASSET_FILE), 'utf8');
    const effects = onsidesEffectsForRxcui('6809');

    expect(assetBytes).toBeLessThan(256 * 1024);
    expect(ONSIDES_SOURCE_VERSION).toBe('v3.1.1');
    expect(idx.meta.source).toContain('OnSIDES v3.1.1');
    expect(idx.meta.citation).toMatch(/Tanaka|OnSIDES/);
    expect(raw).not.toMatch(/excluded|pending/i);
    expect(effects).toHaveLength(53);
    expect(effects.filter((effect) => effect.hint_level === 'elevated')).toHaveLength(2);
    expect(effects.map((effect) => effect.pt)).not.toEqual(
      expect.arrayContaining(["Fournier's gangrene", 'Bladder cancer', 'Amputation']),
    );
    expect(new Set(effects.map((effect) => effect.meddra_id)).size).toBe(effects.length);
    expect(
      effects.every((effect) => effect.pt && ['info', 'elevated'].includes(effect.hint_level)),
    ).toBe(true);
  });

  it('fails closed for unknown and empty RxCUIs without confusing them with covered data', () => {
    expect(onsidesEffectsForRxcui('999999999')).toEqual([]);
    expect(onsidesEffectsForRxcui('')).toEqual([]);
    expect(onsidesHasLabelData('999999999')).toBe(false);
    expect(onsidesHasLabelData('')).toBe(false);
    expect(onsidesHasLabelData('toString')).toBe(false);
  });

  it('loadOnsidesIndex returns the SAME cached object (module-scope, no per-call reparse)', () => {
    expect(loadOnsidesIndex()).toBe(loadOnsidesIndex());
  });
});
