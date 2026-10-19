# OnSIDES v3.1.1 cohort slice

`onsides-labels.v3.1.1.json` was generated with `scripts/vendor-onsides.mjs` from
the official `onsides-v3.1.1.zip` GitHub release (84,862,297 bytes; SHA-256
`7739c73336786c92e73ca383af92d3f2814caf5e94206e08475b86d5a5ec22b9`).
The build script verifies that archive and the exact five extracted CSV inputs before
transforming them.

The committed slice contains MedDRA Preferred Terms from single-ingredient product
labels for the enrolled test-cohort ingredient RxCUI `6809` (metformin) only.
Combination-product labels are excluded so co-ingredient terms are not attributed to
metformin. Terms indicate label association, not causation.

Citation: Tanaka Y, Chen HY, Belloni P, et al. “OnSIDES database: Extracting
adverse drug events from drug labels using natural language processing models.”
_Med_. 2025;100642.

## Not included in this public repository

`onsides-labels.v3.1.1.json` is left out here because the redistribution terms for derived
OnSIDES data are unresolved (see `third-party-data/onsides/v3.1.1/NOTICE.md`). Rebuild it from
the official v3.1.1 release before running the classifier or its tests:

```sh
node scripts/vendor-onsides.mjs <extracted-onsides-dir> backend/src/classifier/assets/onsides-labels.v3.1.1.json <onsides-v3.1.1.zip>
```
