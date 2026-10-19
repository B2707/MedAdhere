// scripts/predeploy-gate.test.ts
//
// Test-the-gate coverage for the OPS-03 pre-deploy blocking gate (Plan 06-07).
// The gate itself (predeploy-gate.mjs) shells out to typecheck/lint/vitest/cdk —
// heavy, Docker-dependent commands we must NOT run inside a unit test. So the gate
// is authored with a DI seam: `STAGES` (the ordered stage manifest) and `runGate`
// (the sequencer) are pure/injectable, and the real command execution is a runner
// passed in. These tests assert the stage manifest is exactly the plan's lanes and
// that the sequencer blocks (nonzero, fail-fast) on the FIRST failing stage.
//
// Root vitest includes **/*.test.ts, so this runs under `npm test`. It imports the
// .mjs module directly (ESM); no command is ever spawned here.

import { describe, expect, it, vi } from 'vitest';
// predeploy-gate.mjs is a plain ESM script (JSDoc-typed) that ships no .d.ts. The root typecheck now
// includes `tsc -p scripts/tsconfig.json`, but this cross-language import remains untyped; the types
// are declared locally.
// @ts-expect-error the .mjs sibling has no declaration file; Stage/runGate shapes are typed locally below.
import { STAGES, runGate } from './predeploy-gate.mjs';

/** Local mirror of the gate's Stage shape (the .mjs @typedef) for type-safe assertions. */
type Stage = { name: string; command: string; args: string[]; cwd?: string };

const silentLogger = { log: () => {}, error: () => {} };

describe('predeploy-gate STAGES manifest (OPS-03 lanes, in order)', () => {
  it('declares the cheap guards first, then quality checks, build, regression, and synth', () => {
    expect(STAGES.map((s: Stage) => s.name)).toEqual([
      'guard:no-pg',
      'guard:eval-csv',
      'audit-ci',
      'typecheck:backend',
      'typecheck:infra',
      'typecheck:dashboard',
      'typecheck:packages/shared',
      'lint',
      'dashboard-build',
      'ops-03-regression',
      'cdk-synth',
    ]);
  });

  it('runs the no-pg and eval-csv install-free guards before other stages', () => {
    expect(STAGES.slice(0, 2)).toEqual([
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
    ]);
  });

  it('runs audit-ci at the high-severity policy pinned in audit-ci.jsonc', () => {
    const audit = STAGES.find((s: Stage) => s.name === 'audit-ci');
    expect(audit).toEqual({
      name: 'audit-ci',
      command: 'npx',
      args: ['audit-ci', '--config', 'audit-ci.jsonc'],
    });
  });

  it('runs typecheck x4 — one per workspace (backend, infra, dashboard, packages/shared)', () => {
    const typechecks = STAGES.filter((s: Stage) => s.name.startsWith('typecheck:'));
    expect(typechecks).toHaveLength(4);
    for (const stage of typechecks) {
      expect(stage.command).toBe('npm');
      expect(stage.args.slice(0, 2)).toEqual(['run', 'typecheck']);
      expect(stage.args).toContain('--workspace');
    }
    const workspaces = typechecks.map((s: Stage) => s.args[s.args.indexOf('--workspace') + 1]);
    expect(workspaces).toEqual(['backend', 'infra', 'dashboard', 'packages/shared']);
  });

  it('lint stage runs the repo-wide eslint (the U-9 React block joins this lane)', () => {
    const lint = STAGES.find((s: Stage) => s.name === 'lint');
    expect(lint).toBeDefined();
    expect(lint?.command).toBe('npm');
    expect(lint?.args).toEqual(['run', 'lint']);
  });

  it('builds the dashboard for production after lint and before cdk synth', () => {
    const stageNames = STAGES.map((s: Stage) => s.name);
    const build = STAGES.find((s: Stage) => s.name === 'dashboard-build');

    expect(build).toEqual({
      name: 'dashboard-build',
      command: 'npm',
      args: ['run', 'build', '-w', '@medadhere/dashboard'],
    });
    expect(stageNames.indexOf('dashboard-build')).toBeGreaterThan(stageNames.indexOf('lint'));
    expect(stageNames.indexOf('dashboard-build')).toBeLessThan(stageNames.indexOf('cdk-synth'));
  });

  it('ops-03 regression lane covers the pipeline, infra contracts, and operator scripts', () => {
    const lane = STAGES.find((s: Stage) => s.name === 'ops-03-regression');
    expect(lane).toBeDefined();
    expect(lane?.command).toBe('npx');
    expect(lane?.args).toEqual([
      'vitest',
      'run',
      'backend/src/inbound',
      'backend/src/enroll',
      'backend/src/classifier',
      'backend/src/timeout',
      'infra/test',
      'scripts',
    ]);
  });

  it('cdk synth stage runs `cdk synth --quiet` from the infra workspace dir', () => {
    const synth = STAGES.find((s: Stage) => s.name === 'cdk-synth');
    expect(synth).toBeDefined();
    expect(synth?.command).toBe('npx');
    expect(synth?.args).toEqual(['cdk', 'synth', '--quiet']);
    expect(synth?.cwd).toBe('infra');
  });
});

describe('runGate sequencing + blocking behavior', () => {
  it('returns ok when every stage exits 0, running all stages in order', async () => {
    const runner = vi.fn().mockResolvedValue(0);
    const result = await runGate({ runner, logger: silentLogger });

    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.failedStage).toBeUndefined();
    expect(runner).toHaveBeenCalledTimes(STAGES.length);
    expect(result.ranStages).toEqual(STAGES.map((s: Stage) => s.name));
  });

  it.each(['guard:no-pg', 'guard:eval-csv', 'audit-ci', 'dashboard-build'])(
    'BLOCKS fail-fast on a seeded nonzero exit from %s',
    async (failedStage) => {
      const runner = vi.fn(async (stage) => (stage.name === failedStage ? 2 : 0));
      const result = await runGate({ runner, logger: silentLogger });
      const failedIndex = STAGES.findIndex((stage: Stage) => stage.name === failedStage);

      expect(result.ok).toBe(false);
      expect(result.failedStage).toBe(failedStage);
      expect(result.code).toBe(2);
      expect(result.ranStages).toEqual(
        STAGES.slice(0, failedIndex + 1).map((stage: Stage) => stage.name),
      );
      expect(runner).toHaveBeenCalledTimes(failedIndex + 1);
    },
  );
});
