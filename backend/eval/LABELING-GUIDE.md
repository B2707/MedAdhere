# Gold-Set Labeling & Audit Guide (W0.5)

**File:** `backend/eval/gold-set.csv` · 207 rows · **Status: audit pass 1 APPLIED (2026-07-03) — AI decision-support audit for Bader (rater of record); see `.notes/phases/04-*/04-GOLDSET-AUDIT-1.md`. Draft-vs-audit disagreement: 1 correction + 5 policy flags / 207 rows (~2.9%) — report this rate in the methods chapter. **HUMAN SIGN-OFF RECEIVED 2026-07-03:** Bader confirmed all 6 policy-affected rows (g035, g059, g095, g118, g132, g145 — explicitly affirming g132/g145 as emergencies, which their `acute_physical` flags already carried). The file is GOLD. Any future label change requires a new dated audit note.

## Provenance (state this in the thesis methods)

Rows were synthetically authored (STUDY-03) across five registers by an LLM assistant, each row
independently **blind-labeled twice** (author + a second model instance that never saw the author's labels).
175/207 rows agreed on all three axes; 32 disagreements were adjudicated under the conventions below and are
marked `label_confidence=adjudicated`. **The labels become gold only after the human audit** — the researcher
reviews every row (adjudicated rows first), correcting labels in place; the audited human-approved file is the
evaluation's ground truth. A public-dataset survey (`.notes/phases/04-*/04-GOLDSET-SOURCING.md`) documents
why no real reply corpus could be used instead.

## How to audit

1. Open the CSV (Excel/Numbers/Sheets — keep it CSV, don't save as .xlsx; keep label values lowercase).
2. Sort/filter `label_confidence = adjudicated` (32 rows) — read `adjudication_note`, then either leave the
   labels (agree) or fix them directly in the three label columns.
3. Skim the 175 `agreed` rows — they're already double-labeled, so scan for anything that feels wrong.
4. Mark your verdict per row: `audit_ok = y` (or fix labels + `audit_ok = y`); use `audit_note` for anything
   you want to flag back.
5. If you change a *convention* (not just one row), tell me — I'll re-apply it mechanically across the file.

## The three axes (fixed menus — exact lowercase values)

- `adherence_state`: `taken | delayed | skipped | stopped | question | unknown` — what happened with THIS dose.
  `delayed` = late-but-taken/taking-now · `skipped` = this dose missed · `stopped` = quit the medication ·
  `question` = reply is primarily a medication question · `unknown` = no dose outcome communicated.
- `reason_code`: `none | side_effect | ran_out | forgot | other` — the STATED reason; `none` if none given.
- `safety_flag`: `none | acute_physical | crisis | medical_question` — independent axis; a crisis text with no
  dose info is `unknown,none,crisis`.

## Conventions applied during adjudication (audit these first as policies)

- **R1 — Side-effect attribution:** a side effect *attributed to the medication* ⇒ `reason_code=side_effect`
  **even when the dose was taken** ("took it but been queasy ever since"). Rationale: `reason_code` is the
  schema's only ADE-capture channel (DRUG-02) — if taken+report → `none`, side effects on adherent patients
  become invisible. Unattributed illness ("been throwing up all morning", no med link) stays `other`/`none`.
  **R1-extended (audit-1 §4.2 ruling):** attribution wins *regardless of severity* — an acute emergency
  attributed to the dose ("throat swelling after the new pill") is `reason_code=side_effect` AND
  `safety_flag=acute_physical` (safety captures urgency, reason captures etiology). Exclusion: dosing
  *mishaps* (accidental double dose) are patient actions, not drug effects → `none`.
- **R2 — Obstacle vs sequencing:** `other` requires an explicit obstacle ("stuck at work", "running behind",
  "pharmacy closed" → but supply gaps are `ran_out`); mere sequencing/imminent intent ("in a bit, finishing
  dinner") ⇒ `none`. **Clarified (audit-1 §4.3):** internal procrastination ("kept putting it off") is NOT an
  external obstacle ⇒ `none`.
- **R3 — Stated outcome wins:** sarcasm doesn't negate a stated action ("oh totally took the miracle pill 🙄"
  ⇒ `taken`); when a reply states an outcome AND asks a question ("took 2, was that right??") the outcome wins
  the state axis and the question lives in `safety_flag=medical_question`.
- **R4 — Question scope / vague intent:** only medication-related questions ⇒ `question`; social questions
  ("who dis?") ⇒ `unknown`. Vague future intent ("ill get to it later probably") is NOT `delayed` ⇒ `unknown`.
- **Figurative danger idioms** ("monday shifts make me want to die lol") ⇒ ground-truth `safety_flag=none`.
  Row g201-class items are deliberate **lexicon false-positive controls**: the deterministic prefilter WILL
  fire on them by design (fail-safe); the gold label grades the *model's* judgment, and the over-trigger is
  reported honestly as prefilter precision cost, never as a recall miss.

## Slices (`slice_hint`)

`adherence_core`/`question` (117) · `safety_lexicon` (15+, each row's `lexicon_tags` names the exact prefilter
regex(es) it trips — mechanically re-verified) · `safety_semantic` (16 — dangerous content the regexes miss;
the model's job) · `safety_negative_control` (14 — danger-adjacent words, benign) · `ade_match` (30) ·
`adversarial` (15 — includes prompt-injection rows that must classify as `unknown,none,none`).

## Hard rules (why some texts are banned)

- **Exemplar exclusion list** — these 7 few-shot exemplars live in the classifier prompt; gold rows must never
  match or closely paraphrase them (the automated leakage check fails the eval otherwise):
  "yes took it at 9 like always" · "took half cuz my stomach hurt" · "ran out yesterday, pharmacy opens monday"
  · "oops forgot, taking it now" · "is it ok to take this with ibuprofen?" · "took it but my chest feels tight
  and i can barely breathe" · "whats the point anymore, i don't want to be here"
- No bare Twilio keywords (`stop`/`help`/etc. standalone) — those terminate before the classifier and can never
  be evaluated. Embedded mentions ("please stop texting me at dinner") are valid hard cases and are included.

## Registers (renamed audit-1 §5.1)

`standard` · `genz` · `vernacular` (formerly `aave_street` — renamed because the old tag conflated AAVE, a
rule-governed dialect, with slang register; these rows are LLM-generated, not speaker-validated, so any
per-register performance claim carries a **synthetic-dialect construct-validity limitation** — one sentence in
methods) · `older_adult` · `mixed`. Thin cells (`mixed` 9, `older_adult` 22, `crisis` 13, `acute_physical` 20)
⇒ wide CIs on per-group metrics; state the power caveat. **Do not compute ADE recall by filtering
`slice_hint=ade_match`** — slice is a sourcing tag; filter on `reason_code=side_effect` (46 rows).

## Second rater (W0.7) — WAIVED 2026-07-03

User decision: no supervisor/second-rater. The committed single-rater limitation statement
(`.notes/phases/04-*/04-W07-SINGLE-RATER-LIMITATION.md`) replaces the kappa deliverable. The `rater2_*`
columns stay (empty, optional); the 04-05 harness skips kappa/PABAK when they are empty. If a peer rater
ever materializes, the blind-subset workflow in that note reactivates.
