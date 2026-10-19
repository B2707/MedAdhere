#!/usr/bin/env node
/**
 * no-pg-under-dashboard guard (D-14, SC4 anti-pattern gate).
 *
 * Amplify Hosting SSR compute has NO VPC path to RDS (amplify-hosting#3362), so
 * a Postgres client in the dashboard tier can never reach the database — all DB
 * access MUST go through the data API. This guard FAILS the build on ANY direct
 * Postgres-client usage under dashboard/.
 *
 * Scans dashboard/src, dashboard/middleware.ts, and dashboard/*.ts(x) for the
 * forbidden D-14 patterns:  'pg' / "pg" / `pg` import specifiers (single-quote,
 * double-quote, OR backtick) for the whole pg family (pg, pg-pool, pg-native,
 * pg-promise, postgres), a `{ Pool }`-from-a-pg-family import, `.Pool` member
 * access on a pg import, and the node-postgres package name.
 *
 * EXCLUDES: node_modules, this scripts/ directory (so the guard never matches
 * its own documentation strings), and single-line comments that DOCUMENT the
 * ban (so explanatory comments don't trip the gate).
 *
 * Exit 0 + "OK: no pg import under dashboard/" when clean; exit 1 + the
 * offending file:line when any match is found.
 *
 * No dependencies — pure Node (fs + path), so CI runs it before any install.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_ROOT = resolve(__dirname, '..');
const SCRIPTS_DIR = resolve(__dirname);

// The D-14 forbidden patterns. The pg import specifier is a quoted (single,
// double, OR backtick) member of the pg family (pg, pg-pool, pg-native,
// pg-promise, postgres); a `{ Pool }`-from-a-pg-family import (the real
// node-postgres Pool re-export, incl. pg-pool); `.Pool` member access on a pg
// import; the node-postgres package name. The backquote in the char class is
// escaped to keep this template-literal-safe even if the file is ever embedded.
const FORBIDDEN = [
  // M5 — quoted pg-family specifier, backtick-aware: 'pg' "pg" `pg`, plus
  // pg-pool / pg-native / pg-promise / postgres in any of the three quote styles.
  { name: 'pg-family import specifier', re: /(['"`])(pg|pg-pool|pg-native|pg-promise|postgres)\1/ },
  // M5 — `import { Pool } ... from '<pg-family>'` (the real Pool re-export path).
  { name: 'Pool import from a pg-family package', re: /\bPool\b[\s\S]*?\bfrom\s*(['"`])(pg|pg-pool)\1/ },
  { name: 'pg.Pool member access', re: /\bpg\.Pool\b/ },
  { name: 'node-postgres package', re: /node-postgres/ },
];

const SCANNABLE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs']);
const SKIP_DIRS = new Set(['node_modules', '.next', 'out', 'dist', '.git']);

/** Strip line/block comments so a comment documenting the ban does not trip it. */
function stripComments(line) {
  // Remove a trailing // line comment and any /* ... */ block on the line.
  return line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
}

/** Recursively collect scannable files under a directory. */
function collectFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (resolve(full) === SCRIPTS_DIR) continue; // never scan the guard itself
      out.push(...collectFiles(full));
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.');
      const ext = dot >= 0 ? entry.name.slice(dot) : '';
      if (SCANNABLE_EXT.has(ext)) out.push(full);
    }
  }
  return out;
}

// Build the file list: dashboard/src (recursive) + the top-level dashboard files.
const files = new Set(collectFiles(join(DASHBOARD_ROOT, 'src')));
for (const entry of readdirSync(DASHBOARD_ROOT, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const dot = entry.name.lastIndexOf('.');
  const ext = dot >= 0 ? entry.name.slice(dot) : '';
  if (SCANNABLE_EXT.has(ext)) files.add(join(DASHBOARD_ROOT, entry.name));
}

const violations = [];
for (const file of files) {
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split('\n');
  } catch {
    continue;
  }
  lines.forEach((rawLine, idx) => {
    const line = stripComments(rawLine);
    for (const { name, re } of FORBIDDEN) {
      if (re.test(line)) {
        violations.push({ file, line: idx + 1, pattern: name, text: rawLine.trim() });
      }
    }
  });
}

if (violations.length > 0) {
  console.error('FAIL: forbidden Postgres-client usage under dashboard/ (D-14):');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.pattern}]  ${v.text}`);
  }
  console.error(
    '\nThe dashboard tier MUST NOT touch a DB client — Amplify SSR has no VPC ' +
      'path to RDS. Route all data access through the data API.',
  );
  process.exit(1);
}

console.log('OK: no pg import under dashboard/');
process.exit(0);
