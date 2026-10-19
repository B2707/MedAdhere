import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { assignWorkerCdkOutdir, CDK_OUT_BASE_ENV, pruneStaleCdkTmp } from './cdk-outdir';

const NOW = Date.UTC(2026, 6, 18);
const MAX_AGE_MS = 60 * 60 * 1000;
const OLD_MTIME = new Date(NOW - MAX_AGE_MS - 1);

describe('pruneStaleCdkTmp', () => {
  it('removes an old cdk.out directory', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'medadhere-cdk-outdir-test-'));
    const staleName = 'cdk.outABC123';
    const stalePath = join(sandbox, staleName);
    mkdirSync(stalePath);
    utimesSync(stalePath, OLD_MTIME, OLD_MTIME);

    try {
      const removed = pruneStaleCdkTmp(sandbox, { maxAgeMs: MAX_AGE_MS, now: NOW });

      expect(removed).toEqual([staleName]);
      expect(existsSync(stalePath)).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('keeps a fresh cdk.out directory', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'medadhere-cdk-outdir-test-'));
    const freshPath = join(sandbox, 'cdk.outDEF456');
    mkdirSync(freshPath);
    const freshMtime = new Date(NOW);
    utimesSync(freshPath, freshMtime, freshMtime);

    try {
      const removed = pruneStaleCdkTmp(sandbox, { maxAgeMs: MAX_AGE_MS, now: NOW });

      expect(removed).toEqual([]);
      expect(existsSync(freshPath)).toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('keeps an old directory with a non-matching name', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'medadhere-cdk-outdir-test-'));
    const unrelatedPath = join(sandbox, 'unrelated-directory');
    mkdirSync(unrelatedPath);
    utimesSync(unrelatedPath, OLD_MTIME, OLD_MTIME);

    try {
      const removed = pruneStaleCdkTmp(sandbox, { maxAgeMs: MAX_AGE_MS, now: NOW });

      expect(removed).toEqual([]);
      expect(existsSync(unrelatedPath)).toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('keeps an old regular file with a cdk.out-prefixed name', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'medadhere-cdk-outdir-test-'));
    const filePath = join(sandbox, 'cdk.outfile');
    writeFileSync(filePath, 'not a directory');
    utimesSync(filePath, OLD_MTIME, OLD_MTIME);

    try {
      const removed = pruneStaleCdkTmp(sandbox, { maxAgeMs: MAX_AGE_MS, now: NOW });

      expect(removed).toEqual([]);
      expect(existsSync(filePath)).toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('returns an empty array when the temporary directory does not exist', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'medadhere-cdk-outdir-test-'));
    const missingPath = join(sandbox, 'missing');

    try {
      const pruneMissingDirectory = () => pruneStaleCdkTmp(missingPath);

      expect(pruneMissingDirectory).not.toThrow();
      expect(pruneMissingDirectory()).toEqual([]);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe('assignWorkerCdkOutdir', () => {
  it('uses the configured base and creates distinct paths for different pool ids', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'medadhere-cdk-outdir-test-'));
    const firstEnv: NodeJS.ProcessEnv = {
      [CDK_OUT_BASE_ENV]: sandbox,
      VITEST_POOL_ID: '1',
    };
    const secondEnv: NodeJS.ProcessEnv = {
      [CDK_OUT_BASE_ENV]: sandbox,
      VITEST_POOL_ID: '2',
    };

    try {
      const firstOutdir = assignWorkerCdkOutdir(firstEnv);
      const secondOutdir = assignWorkerCdkOutdir(secondEnv);

      expect(firstOutdir).toBe(join(sandbox, 'worker-1'));
      expect(secondOutdir).toBe(join(sandbox, 'worker-2'));
      expect(firstOutdir).not.toBe(secondOutdir);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('sets CDK_OUTDIR on the provided environment', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'medadhere-cdk-outdir-test-'));
    const env: NodeJS.ProcessEnv = {
      [CDK_OUT_BASE_ENV]: sandbox,
      VITEST_POOL_ID: '3',
    };

    try {
      const assignedOutdir = assignWorkerCdkOutdir(env);

      expect(env.CDK_OUTDIR).toBe(assignedOutdir);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
