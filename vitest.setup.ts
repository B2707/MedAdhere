// Root Vitest setup (D9, plan 06-03a). Loaded via `setupFiles` in
// `vitest.config.ts` for EVERY test file in the monorepo suite.
//
// It registers the `@testing-library/jest-dom` matchers (`toBeInTheDocument`,
// `toHaveClass`, `toHaveAttribute`, …) onto Vitest's `expect`. This is a
// side-effect import: it calls `expect.extend(...)` once for the whole run.
//
// Safe in the DEFAULT node environment too — importing the matcher pack does
// not touch `document`/`window`, so the 800+ existing node-env pure-logic tests
// are unaffected. Component tests opt into a DOM with a per-file
// `// @vitest-environment jsdom` pragma (node stays the default).
import '@testing-library/jest-dom/vitest';
