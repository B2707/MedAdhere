// infra/test/context.test.ts
//
// Unit tests for the pure context parser (post-exec review 01-05, TEST-3/TEST-4/CDK-2/ME-02): the
// bin/medadhere.ts entry point was untestable (it synthesizes at module load), so the coercion +
// validation now lives in lib/context.ts and is exercised directly here.

import { describe, it, expect } from 'vitest';
import { parseBackupRetentionDays } from '../lib/context.js';

describe('parseBackupRetentionDays (DATA-02 default + loud validation)', () => {
  it('defaults to 7 (DATA-02 baseline) when the value is absent/empty', () => {
    expect(parseBackupRetentionDays(undefined)).toBe(7);
    expect(parseBackupRetentionDays(null)).toBe(7);
    expect(parseBackupRetentionDays('')).toBe(7); // CDK-2: empty `-c backupRetentionDays=` no longer -> 0
  });

  it('accepts a cdk.json JSON number or a CLI string', () => {
    expect(parseBackupRetentionDays(7)).toBe(7);
    expect(parseBackupRetentionDays('7')).toBe(7);
    expect(parseBackupRetentionDays(0)).toBe(0); // the explicit free-plan exception
    expect(parseBackupRetentionDays('0')).toBe(0);
    expect(parseBackupRetentionDays(35)).toBe(35); // RDS single-AZ cap
  });

  it('throws LOUDLY on garbage rather than silently disabling backups', () => {
    expect(() => parseBackupRetentionDays('abc')).toThrow();
    expect(() => parseBackupRetentionDays('7.5')).toThrow();
    expect(() => parseBackupRetentionDays('-1')).toThrow();
    expect(() => parseBackupRetentionDays('40')).toThrow(); // > the 35-day RDS cap
  });

  it('rejects a boolean before Number() coercion (IN-05 — Number(true)===1 must not slip through)', () => {
    // A cdk.json typo `"backupRetentionDays": true` would otherwise become a silent 1-day retention.
    expect(() => parseBackupRetentionDays(true)).toThrow();
    expect(() => parseBackupRetentionDays(false)).toThrow();
  });
});
