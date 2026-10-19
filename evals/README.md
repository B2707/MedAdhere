# Evals — Pointer

This project's evaluation assets (this directory is the harness-audit-visible
index; the substance lives with the code):

- **Classifier eval harness** — `backend/eval/` : gold set (`gold-set.csv`,
  207 hand-labeled, 97.1% agreement), ADE-match gold (`ade-match-gold.csv`),
  labeling guide, and the eval runner under `backend/eval/lib/` (445/445 at
  last full run). This is the thesis contribution's measurement instrument.
- **Automated tests** — 1,600+ vitest tests across `backend/`, `infra/test/`,
  `dashboard/`, `packages/`, `test-setup/` (root `npm test`).
