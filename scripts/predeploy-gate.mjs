// scripts/predeploy-gate.mjs
//
// OPS-03 — the pre-deploy BLOCKING quality gate (Plan 06-07, SC7).
//
// A single regression bar the operator runs BEFORE any `cdk deploy`
// (runbook-06 step 0): `npm run predeploy`. It runs, in order and FAIL-FAST:
//
//   1. cheap guards   — no Postgres client under dashboard; no real-reply CSV
//                        committed under backend/eval
//   2. dependency audit — audit-ci at high+ with the repo's dated allowlist
//   3. typecheck x4   — `tsc --noEmit` in each workspace (backend, infra,
//                        dashboard, packages/shared); the root typecheck also
//                        covers scripts/ for the broader quality gate
//   4. lint           — repo-wide `eslint .` (includes the U-9 React/.tsx block
//                        added in 06-03a: react-hooks + jsx-a11y + react)
//   5. dashboard build — the production Next.js compilation used by Vercel
//   6. ops-03 lanes   — `npx vitest run` over the load-bearing backend
//                        pipeline suites plus infra contracts and operator CLIs
//   7. cdk synth      — `cdk synth --quiet` from infra/ (this is also the
//                        cdk-nag AwsSolutions gate — bin/medadhere.ts applies it)
//
// The FIRST nonzero stage stops the run and the process exits nonzero — that is
// the "blocks" contract. This gate is documentation of a named, reproducible
// bar; it is NOT wired into CI (CI keeps its own quality job). Nothing here runs
// at `cdk synth` time.
//
// DOCKER / TEST_DATABASE_URL (step-3 prerequisite): the classifier + timeout
// lanes include real-PostgreSQL contract tests (testcontainers `postgres:16`).
// They FAIL LOUD in beforeAll if neither a running Docker daemon nor a
// CI-style `TEST_DATABASE_URL` (a reachable PG16) is available. Start Docker (or
// export TEST_DATABASE_URL) before running the gate, or step 3 will block.
//
// Testability: `STAGES` (the manifest) and `runGate` (the sequencer) are pure
// and injectable so scripts/predeploy-gate.test.ts can prove the lanes + the
// fail-fast/blocking contract without spawning anything. Only the bottom
// main-guard actually spawns commands.

import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

// Repo root = one level up from scripts/. All stage cwds resolve against it so
// the gate works regardless of the caller's working directory.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The ordered OPS-03 stage manifest. Each stage: { name, command, args, cwd? }.
 * `cwd` is relative to the repo root (default: repo root).
 * @typedef {{ name: string, command: string, args: string[], cwd?: string }} Stage
 * @type {Stage[]}
 */
export const STAGES = [
  // 1. Cheap install-free guards first.
  {
    name: 'guard:no-pg',
    command: 'node',
    args: ['dashboard/scripts/check-no-pg.mjs'],
  },
  {
    name: 'guard:eval-csv',
    command: 'node',
    args: ['scripts/check-eval-csv-guard.mjs'],
  },
  // 2. Dependency audit — high+ advisories block unless explicitly allowlisted.
  {
    name: 'audit-ci',
    command: 'npx',
    args: ['audit-ci', '--config', 'audit-ci.jsonc'],
  },
  // 3. typecheck x4 — one `tsc --noEmit` per workspace; a failure names its workspace.
  {
    name: 'typecheck:backend',
    command: 'npm',
    args: ['run', 'typecheck', '--workspace', 'backend'],
  },
  { name: 'typecheck:infra', command: 'npm', args: ['run', 'typecheck', '--workspace', 'infra'] },
  {
    name: 'typecheck:dashboard',
    command: 'npm',
    args: ['run', 'typecheck', '--workspace', 'dashboard'],
  },
  {
    name: 'typecheck:packages/shared',
    command: 'npm',
    args: ['run', 'typecheck', '--workspace', 'packages/shared'],
  },
  // 4. lint — repo-wide eslint (the 06-03a U-9 React/.tsx block joins this lane).
  { name: 'lint', command: 'npm', args: ['run', 'lint'] },
  // 5. Production dashboard build — catches webpack resolution failures invisible to tsc/vitest.
  {
    name: 'dashboard-build',
    command: 'npm',
    args: ['run', 'build', '-w', '@medadhere/dashboard'],
  },
  // 6. OPS-03 regression lanes — pipeline suites plus infra contracts and operator CLIs.
  {
    name: 'ops-03-regression',
    command: 'npx',
    args: [
      'vitest',
      'run',
      'backend/src/inbound',
      'backend/src/enroll',
      'backend/src/classifier',
      'backend/src/timeout',
      'infra/test',
      'scripts',
    ],
  },
  // 7. cdk synth (--quiet) from infra/ — also the cdk-nag AwsSolutions gate.
  { name: 'cdk-synth', command: 'npx', args: ['cdk', 'synth', '--quiet'], cwd: 'infra' },
];

/**
 * Default runner: spawn the stage command, inherit stdio (so the failing tool's
 * own output reaches the operator), resolve with the numeric exit code. A spawn
 * error or a signal termination resolves nonzero so the gate blocks.
 * @param {Stage} stage
 * @returns {Promise<number>}
 */
export function defaultRunner(stage) {
  return new Promise((resolveCode) => {
    const child = spawn(stage.command, stage.args, {
      cwd: stage.cwd ? resolve(REPO_ROOT, stage.cwd) : REPO_ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32', // npm/npx are .cmd shims on Windows
    });
    child.on('error', () => resolveCode(1));
    child.on('close', (code, signal) => resolveCode(signal ? 1 : (code ?? 1)));
  });
}

/**
 * Run every stage in order, FAIL-FAST. Returns the outcome; the caller decides
 * the process exit code. The first nonzero stage stops the run (`ok: false`).
 * @param {{ runner?: (stage: Stage) => Promise<number>,
 *           logger?: { log: (m: string) => void, error: (m: string) => void } }} [opts]
 * @returns {Promise<{ ok: boolean, ranStages: string[], failedStage?: string, code: number }>}
 */
export async function runGate({ runner = defaultRunner, logger = console } = {}) {
  const ranStages = [];
  logger.log(`predeploy gate (OPS-03): ${STAGES.length} stages, fail-fast\n`);

  for (const stage of STAGES) {
    logger.log(`> ${stage.name}: ${stage.command} ${stage.args.join(' ')}`);
    ranStages.push(stage.name);
    const code = await runner(stage);
    if (code !== 0) {
      logger.error(
        `\nBLOCKED: predeploy gate FAILED at "${stage.name}" (exit ${code}). Deploy is not cleared.`,
      );
      return { ok: false, ranStages, failedStage: stage.name, code };
    }
    logger.log(`  ok: ${stage.name}\n`);
  }

  logger.log('predeploy gate PASSED — all OPS-03 stages green. Deploy is cleared.');
  return { ok: true, ranStages, code: 0 };
}

// Main guard — only run/spawn when invoked directly (`node scripts/predeploy-gate.mjs`
// / `npm run predeploy`), never on import (keeps the module side-effect-free for tests).
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  runGate()
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((err) => {
      console.error('predeploy gate crashed:', err);
      process.exit(1);
    });
}
