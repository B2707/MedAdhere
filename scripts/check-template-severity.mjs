// scripts/check-template-severity.mjs
//
// The SAFETY-04 template severity grep-guard (Plan 04-04; the W0.3 residual the plan scheduled
// here). The auto-reply templates are DETECT-AND-REDIRECT, never triage: two-sided check that
//   (a) no banned triage ADJECTIVE appears in any template constant, and
//   (b) the redirect DIRECTIVES are present (911+988 on the emergency template; 811 on the
//       medical-question and HELP templates).
// The banned list mirrors BANNED_SEVERITY_TERMS in packages/shared/src/safety-lexicon.ts (the
// SSOT the unit tests consume); this script re-declares it deliberately so a test-side edit
// cannot silently weaken the CI gate — drift between the two lists fails loudly below.
//
// Install-free by design (runs BEFORE `npm ci` in the CI quality job): plain node + fs, no TS
// loader — it parses the template string literals out of the lexicon source text.

import { readFileSync } from 'node:fs';

const LEXICON_PATH = 'packages/shared/src/safety-lexicon.ts';
const BANNED = ['severe', 'serious', 'critical', 'urgent', 'life-threatening', 'dangerous'];

const src = readFileSync(LEXICON_PATH, 'utf8');

// (a') list-drift guard: every banned term here must still be in BANNED_SEVERITY_TERMS.
const bannedBlock = /BANNED_SEVERITY_TERMS[\s\S]*?\];/.exec(src)?.[0] ?? '';
const listDrift = BANNED.filter((t) => !bannedBlock.includes(`'${t}'`));
if (listDrift.length > 0) {
  console.error(
    `severity grep-guard: BANNED_SEVERITY_TERMS in ${LEXICON_PATH} no longer carries: ${listDrift.join(', ')} — reconcile the lists`,
  );
  process.exit(1);
}

// Extract each template constant and join its single-quoted string fragments. The emergency
// template lives in the (non-exported) SAFETY_AUTO_REPLY_EMERGENCY_BY_LANGUAGE map — the
// exported SAFETY_AUTO_REPLY_EMERGENCY alias carries no string literals of its own — so the
// match deliberately includes non-exported consts and scans every language variant.
const templateMatches = [
  ...src.matchAll(/(?:export )?const (SAFETY_AUTO_REPLY_\w+|HELP_AUTO_REPLY)\s*=([\s\S]*?);/g),
];
if (templateMatches.length < 3) {
  console.error(
    `severity grep-guard: expected >= 3 template constants in ${LEXICON_PATH}, found ${templateMatches.length}`,
  );
  process.exit(1);
}

const REQUIRED_DIRECTIVES = {
  SAFETY_AUTO_REPLY_EMERGENCY_BY_LANGUAGE: ['911', '988'],
  SAFETY_AUTO_REPLY_MEDICAL_QUESTION: ['811'],
  HELP_AUTO_REPLY: ['811', 'STOP'],
};

let failed = false;

// Presence guard: a rename must fail loudly, never silently drop a directive requirement.
const matchedNames = new Set(templateMatches.map(([, name]) => name));
for (const requiredName of Object.keys(REQUIRED_DIRECTIVES)) {
  if (!matchedNames.has(requiredName)) {
    console.error(
      `severity grep-guard: ${LEXICON_PATH} no longer carries the ${requiredName} constant`,
    );
    failed = true;
  }
}

for (const [, name, bodyExpr] of templateMatches) {
  const text = [...bodyExpr.matchAll(/'([^']*)'/g)].map((m) => m[1]).join('');
  const lower = text.toLowerCase();
  for (const term of BANNED) {
    if (lower.includes(term)) {
      console.error(`severity grep-guard: ${name} contains the banned triage adjective "${term}"`);
      failed = true;
    }
  }
  for (const directive of REQUIRED_DIRECTIVES[name] ?? []) {
    if (!text.includes(directive)) {
      console.error(
        `severity grep-guard: ${name} is missing the required "${directive}" directive`,
      );
      failed = true;
    }
  }
}

// --- Wave 1a template floor: clinical-memory renderer strings (orientation + re-ask) ---
// Same two-sided check over the patient-facing template constants in response.ts: the pinned
// QUESTIONS map, the EXPLAINERS map, the orientation reply, and the re-ask lead-in. Blocks are
// extracted by constant name so a rename/removal fails loudly instead of silently dropping
// coverage. Only string literals inside these blocks are scanned — never identifiers (the
// `severity` KEY would false-positive on the banned "severe" substring).

const RESPONSE_PATH = 'backend/src/conversation/clinical-memory/response.ts';
const responseSrc = readFileSync(RESPONSE_PATH, 'utf8');

const RESPONSE_BLOCKS = {
  QUESTIONS: /const QUESTIONS[\s\S]*?\};/,
  EXPLAINERS: /export const EXPLAINERS[\s\S]*?\} as const/,
  ORIENTATION_REPLY: /const ORIENTATION_REPLY =[\s\S]*?;/,
  REASK_LEAD_IN: /const REASK_LEAD_IN =[\s\S]*?;/,
};
// Owner supersession (2026-08-17): the casual greeting is now composed by the AI; ORIENTATION_REPLY
// is the fallback-only floor that must read sanely mid-thread (the old "Hey, how's it going?" pin
// re-greeted patients). The 811/STOP notices live in the enrollment disclosure + HELP replies.
// The pin below keeps the fallback floor byte-exact so drift still fails the guard.
const RESPONSE_REQUIRED_DIRECTIVES = {
  ORIENTATION_REPLY: ["All good — I'm around if you need anything."],
};

for (const [name, pattern] of Object.entries(RESPONSE_BLOCKS)) {
  const block = pattern.exec(responseSrc)?.[0];
  if (block === undefined) {
    console.error(`severity grep-guard: ${RESPONSE_PATH} no longer carries the ${name} block`);
    failed = true;
    continue;
  }
  const text = [...block.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]).join('');
  const lower = text.toLowerCase();
  for (const term of BANNED) {
    if (lower.includes(term)) {
      console.error(`severity grep-guard: ${name} contains the banned triage adjective "${term}"`);
      failed = true;
    }
  }
  for (const directive of RESPONSE_REQUIRED_DIRECTIVES[name] ?? []) {
    if (!text.includes(directive)) {
      console.error(
        `severity grep-guard: ${name} is missing the required "${directive}" directive`,
      );
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log(
  `severity grep-guard clean: ${templateMatches.length} lexicon templates + ${Object.keys(RESPONSE_BLOCKS).length} renderer blocks — no triage adjectives, all directives present.`,
);
