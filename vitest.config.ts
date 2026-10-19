import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Root Vitest config (F66). The root `test` / `vitest run` script and every
// later-wave `vitest run <file>` resolve against this. Include all *.test.ts
// across the workspaces; exclude build artifacts.
//
// The `@/*` alias → `dashboard/src/*` lets the dashboard auth/middleware tests
// (which use Next's `@/` path alias) run under the root `npm test` used by CI.
// `@/` is dashboard-only (verified — no other workspace imports it), so this
// alias is safe for the whole monorepo suite.
export default defineConfig({
  // D9: the dashboard tsconfig sets `jsx: "preserve"` (Next.js compiles JSX), so
  // Vitest 4's OXC transformer would otherwise refuse to transform `.tsx`. Force
  // the automatic React runtime (`react-jsx`) here — it applies only to files
  // parsed as JSX (`.tsx`/`.jsx`), leaving every node-env `.ts` test untouched.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./dashboard/src', import.meta.url)),
    },
  },
  test: {
    // D9 (06-03a): `.test.tsx` joins the suite for the first React component
    // tests (Table/Badge, later the charts/banner). Node stays the DEFAULT
    // environment; component tests opt into jsdom with a per-file
    // `// @vitest-environment jsdom` pragma.
    include: ['**/*.test.ts', '**/*.test.tsx'],
    // Build output and nested worktree checkouts are excluded so a stale copy of
    // the tree can never double-run the whole suite inside the main run.
    exclude: ['**/node_modules/**', '**/dist/**', '**/cdk.out/**', '**/.next/**'],
    // `globals: true` exposes describe/it/expect without an explicit import and,
    // with the setup file, lets `@testing-library/jest-dom` extend `expect`.
    // Existing node-env tests already import from 'vitest' explicitly, so this
    // is purely additive and does not break them.
    globals: true,
    // CDK `Template.fromStack` synths otherwise create a fresh ~56MB `cdk.out*`
    // tmpdir per App and previously leaked ~80GB. globalSetup creates a
    // self-deleting run base and prunes stale leftovers; the cdk-outdir
    // setupFile points CDK_OUTDIR at a race-free per-worker subdirectory.
    globalSetup: './test-setup/cdk-outdir.ts',
    setupFiles: ['./vitest.setup.ts', './test-setup/cdk-outdir.setup.ts'],
    // CDK `Template.fromStack` synth tests (foundation-stack) and the
    // testcontainers schema test are slow on shared CI runners — the 5s default
    // intermittently times out. 60s covers the measured full-stack synth under
    // parallel bundling without masking a genuine hang.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
