// vendor-onsides.mjs — OnSIDES vendoring reproducer (Plan 04-06, gate fix U-27).
//
// One-time build step (NOT a CI step): joins the OnSIDES v3.1.1 release down to
// a KB-scale per-RxCUI adverse-effect index bundled with the classifier Lambda,
// so the deterministic ADE matcher (DRUG-02) never ships or parses the 400 MB
// source CSV. The full `product_adverse_effect.csv` is ~400 MB unzipped — well
// past the 250 MB Lambda-layer limit (the exact U-27 concern), so we flatten it
// at build time and commit only the tiny result.
//
// Source (pinned): OnSIDES v3.1.1 GitHub release zip:
//   https://github.com/tatonetti-lab/onsides/releases/download/v3.1.1/onsides-v3.1.1.zip
// Citation: Tanaka Y, Chen HY, Belloni P, et al. "OnSIDES database…" Med. 2025;100642.
//
// Usage: node scripts/vendor-onsides.mjs <path-to-extracted-onsides-dir> <out.json> <onsides-v3.1.1.zip>
// Reads <dir>/csv/{vocab_rxnorm_ingredient, vocab_rxnorm_ingredient_to_product,
//   product_to_rxnorm, vocab_meddra_adverse_effect, product_adverse_effect}.csv
//
// Join path (ingredient-level — the stable US join; product/clinical-drug RxCUIs
// that lack an RxNorm code use OMOP-prefixed ids we deliberately skip):
//   ingredient RxCUI → single-ingredient ingredient_to_product.product_id
//     → product_to_rxnorm(rxnorm_product_id=product_id).label_id
//       → product_adverse_effect(product_label_id=label_id)
//         → meddra PT + label_section → hint_level.
import {
  createReadStream,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

// Actual Phase-7 test-cohort ingredient (RxNorm TTY=IN) RxCUI, verified against
// vocab_rxnorm_ingredient at build time (a miss is a hard error, never silent).
const COHORT_INGREDIENT_RXCUIS = [
  6809, // metformin
];

const ELEVATED_SECTIONS = new Set(['BW', 'WP']); // boxed warning / warnings & precautions
const PINNED_ARCHIVE = {
  bytes: 84862297,
  sha256: '7739c73336786c92e73ca383af92d3f2814caf5e94206e08475b86d5a5ec22b9',
};
const PINNED_CSV = {
  'vocab_rxnorm_ingredient.csv': {
    bytes: 63820,
    sha256: '84e37e2b6b96cd96de556b9bcf4359a7eb322ba8ef3a627fe9666890524e5f7a',
    header: ['rxnorm_id', 'rxnorm_name', 'rxnorm_term_type'],
  },
  'vocab_rxnorm_ingredient_to_product.csv': {
    bytes: 118648,
    sha256: '3b07b2f34ba665be6f14cbce3f7c54c25daa8946868470ca868e1d55f9447632',
    header: ['product_id', 'ingredient_id'],
  },
  'product_to_rxnorm.csv': {
    bytes: 839921,
    sha256: '0fdd5237a136f1086dcde3ddac56e77847b3e80e7bfafdb540c2e1bd0cc40fc7',
    header: ['label_id', 'rxnorm_product_id'],
  },
  'vocab_meddra_adverse_effect.csv': {
    bytes: 210126,
    sha256: 'fddc123742cfd3beb215ea0dbfe0bb4edb977792b6c87c949eb66587c90b2661',
    header: ['meddra_id', 'meddra_name', 'meddra_term_type'],
  },
  'product_adverse_effect.csv': {
    bytes: 399718339,
    sha256: '167354272565e7df8eccdfa9592aa4d863999382a01ea438902154663713039b',
    header: [
      'product_label_id',
      'effect_id',
      'label_section',
      'effect_meddra_id',
      'match_method',
      'pred0',
      'pred1',
    ],
  },
};

/** Parse one CSV line honoring quoted fields with embedded commas + doubled quotes. */
function parseCsvLine(line) {
  const out = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQ = false;
      } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      out.push(cell);
      cell = '';
    } else cell += c;
  }
  if (inQ) throw new Error('unterminated quoted CSV field');
  out.push(cell);
  return out;
}

function assertHeader(path, actual, expected) {
  if (actual.length !== expected.length || actual.some((cell, index) => cell !== expected[index])) {
    throw new Error(`${path}: unexpected CSV header (${actual.join(',')})`);
  }
}

function loadCsv(path, expectedHeader) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const header = parseCsvLine(lines[0]);
  assertHeader(path, header, expectedHeader);
  return lines.slice(1).map((l, rowIndex) => {
    const cells = parseCsvLine(l);
    if (cells.length !== header.length) {
      throw new Error(`${path}: row ${rowIndex + 2} has ${cells.length}/${header.length} fields`);
    }
    return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
  });
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyPinnedFile(path, expected, label) {
  const bytes = statSync(path).size;
  if (bytes !== expected.bytes) {
    throw new Error(`${label}: expected ${expected.bytes} bytes, got ${bytes}`);
  }
  const digest = await sha256(path);
  if (digest !== expected.sha256) {
    throw new Error(`${label}: SHA-256 ${digest} != pinned ${expected.sha256}`);
  }
}

function compareCodePoints(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function writeJsonAtomic(path, value) {
  const tempPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

async function main() {
  const dir = process.argv[2];
  const outPath = process.argv[3];
  const archivePath = process.argv[4];
  if (!dir || !outPath || !archivePath) {
    console.error(
      'usage: node scripts/vendor-onsides.mjs <onsides-dir> <out.json> <onsides-v3.1.1.zip>',
    );
    return 2;
  }
  const csv = (f) => join(dir, 'csv', f);
  await verifyPinnedFile(archivePath, PINNED_ARCHIVE, 'OnSIDES v3.1.1 archive');
  for (const [file, expected] of Object.entries(PINNED_CSV)) {
    await verifyPinnedFile(csv(file), expected, `OnSIDES v3.1.1 ${file}`);
  }

  // 1. ingredient RxCUI → set of product ids
  const ingToProduct = loadCsv(
    csv('vocab_rxnorm_ingredient_to_product.csv'),
    PINNED_CSV['vocab_rxnorm_ingredient_to_product.csv'].header,
  );
  const targetRxcuis = new Set(COHORT_INGREDIENT_RXCUIS.map(String));
  const ingredientsByProduct = new Map();
  for (const row of ingToProduct) {
    const ingredients = ingredientsByProduct.get(row.product_id) ?? new Set();
    ingredients.add(row.ingredient_id);
    ingredientsByProduct.set(row.product_id, ingredients);
  }
  const productToRxcui = new Map(); // product_id → ingredient rxcui
  for (const row of ingToProduct) {
    if (
      targetRxcuis.has(row.ingredient_id) &&
      ingredientsByProduct.get(row.product_id)?.size === 1
    ) {
      productToRxcui.set(row.product_id, row.ingredient_id);
    }
  }

  // Verify every requested RxCUI actually resolved (U-27: a bad/absent asset must fail loud)
  const ingredients = loadCsv(
    csv('vocab_rxnorm_ingredient.csv'),
    PINNED_CSV['vocab_rxnorm_ingredient.csv'].header,
  );
  const rxcuiName = new Map(ingredients.map((r) => [r.rxnorm_id, r.rxnorm_name]));
  const resolved = new Set([...productToRxcui.values()]);
  const unresolved = [...targetRxcuis].filter((r) => !resolved.has(r));
  if (unresolved.length > 0) {
    throw new Error(
      `vendor-onsides: RxCUIs with no single-ingredient product mapping: ${unresolved.join(', ')}`,
    );
  }
  const unnamed = [...targetRxcuis].filter((rxcui) => !rxcuiName.has(rxcui));
  if (unnamed.length > 0)
    throw new Error(`vendor-onsides: unknown ingredient RxCUIs: ${unnamed.join(', ')}`);

  // 2. product id → label ids
  const prodToRx = loadCsv(
    csv('product_to_rxnorm.csv'),
    PINNED_CSV['product_to_rxnorm.csv'].header,
  );
  const labelToRxcui = new Map(); // label_id → ingredient rxcui
  const labelCountByRxcui = new Map([...targetRxcuis].map((rxcui) => [rxcui, new Set()]));
  for (const row of prodToRx) {
    const rxcui = productToRxcui.get(row.rxnorm_product_id);
    if (rxcui) {
      labelToRxcui.set(row.label_id, rxcui);
      labelCountByRxcui.get(rxcui).add(row.label_id);
    }
  }
  const withoutLabels = [...targetRxcuis].filter(
    (rxcui) => labelCountByRxcui.get(rxcui).size === 0,
  );
  if (withoutLabels.length > 0) {
    throw new Error(`vendor-onsides: RxCUIs with no product labels: ${withoutLabels.join(', ')}`);
  }

  // 3. meddra id → { pt, isPt }
  const meddra = loadCsv(
    csv('vocab_meddra_adverse_effect.csv'),
    PINNED_CSV['vocab_meddra_adverse_effect.csv'].header,
  );
  const meddraPt = new Map(
    meddra.filter((m) => m.meddra_term_type === 'PT').map((m) => [m.meddra_id, m.meddra_name]),
  );

  // 4. stream the 400 MB product_adverse_effect.csv ONCE, keep only target labels + PT effects
  const index = new Map(); // rxcui → Map<meddra_id, {pt, hint_level}>
  const rl = createInterface({
    input: createReadStream(csv('product_adverse_effect.csv')),
    crlfDelay: Infinity,
  });
  let header = null;
  let scanned = 0;
  for await (const line of rl) {
    if (!header) {
      header = parseCsvLine(line);
      assertHeader(
        csv('product_adverse_effect.csv'),
        header,
        PINNED_CSV['product_adverse_effect.csv'].header,
      );
      continue;
    }
    scanned++;
    // fast reject before full parse: product_label_id is the first field
    const firstComma = line.indexOf(',');
    const labelId = line.slice(0, firstComma);
    const rxcui = labelToRxcui.get(labelId);
    if (!rxcui) continue;
    const cells = parseCsvLine(line);
    if (cells.length !== header.length) {
      throw new Error(
        `${csv('product_adverse_effect.csv')}: row ${scanned + 1} has ${cells.length}/${header.length} fields`,
      );
    }
    const rec = Object.fromEntries(header.map((h, i) => [h, cells[i]]));
    const pt = meddraPt.get(rec.effect_meddra_id);
    if (!pt) continue; // non-PT (LLT) rows are dropped — we key on Preferred Terms
    if (!index.has(rxcui)) index.set(rxcui, new Map());
    const perDrug = index.get(rxcui);
    const hint = ELEVATED_SECTIONS.has(rec.label_section) ? 'elevated' : 'info';
    const existing = perDrug.get(rec.effect_meddra_id);
    // dedup across a drug's multiple product labels; 'elevated' wins over 'info'
    if (!existing || (existing.hint_level === 'info' && hint === 'elevated')) {
      perDrug.set(rec.effect_meddra_id, { meddra_id: rec.effect_meddra_id, pt, hint_level: hint });
    }
  }
  const withoutEffects = [...targetRxcuis].filter((rxcui) => !index.get(rxcui)?.size);
  if (withoutEffects.length > 0) {
    throw new Error(
      `vendor-onsides: RxCUIs with no MedDRA PT effects: ${withoutEffects.join(', ')}`,
    );
  }

  // 5. emit denormalized, sorted, keyed by RxCUI
  const out = {
    _meta: {
      source: 'OnSIDES v3.1.1 — https://github.com/tatonetti-lab/onsides/releases/tag/v3.1.1',
      citation: 'Tanaka Y, Chen HY, Belloni P, et al. OnSIDES database. Med. 2025;100642.',
      generated_from:
        'product_adverse_effect.csv (PT effects only), single-ingredient product labels',
      rxcui_count: index.size,
      note: 'Phase-7 test-cohort slice: metformin ingredient RxCUI 6809.',
    },
    labels: {},
  };
  for (const [rxcui, effects] of [...index.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    out.labels[rxcui] = {
      ingredient: rxcuiName.get(rxcui) ?? null,
      effects: [...effects.values()].sort(
        (a, b) => compareCodePoints(a.pt, b.pt) || compareCodePoints(a.meddra_id, b.meddra_id),
      ),
    };
  }
  writeJsonAtomic(outPath, out);
  const bytes = readFileSync(outPath).length;
  console.log(
    `vendor-onsides: scanned ${scanned} effect rows → ${index.size} RxCUIs, ${outPath} = ${(bytes / 1024).toFixed(1)} KB`,
  );
  for (const [rxcui, d] of Object.entries(out.labels)) {
    console.log(
      `  ${rxcui} ${d.ingredient}: ${d.effects.length} PTs (${d.effects.filter((e) => e.hint_level === 'elevated').length} elevated)`,
    );
  }
  return 0;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((e) => {
    console.error('vendor-onsides failed:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
