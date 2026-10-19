/**
 * teardown-purge.test.ts — assertion-level proof of the DATA-01/STUDY-04 teardown lifecycle
 * (Plan 05-02 deliverable 4). No infra is created or deployed here (spend-free); this reads the
 * already-committed database construct source READ-ONLY and asserts it is wired for clean
 * `cdk destroy` DB removal (INFRA-04). The manual Twilio message-log purge — the one step
 * `cdk destroy` cannot perform — is documented in tester-hygiene.ts and asserted present here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DATABASE_CONSTRUCT = readFileSync(
  join(__dirname, '..', '..', '..', 'infra', 'lib', 'constructs', 'database.ts'),
  'utf8',
);
const TESTER_HYGIENE = readFileSync(join(__dirname, 'tester-hygiene.ts'), 'utf8');

describe('teardown purge — cdk destroy removes the operational DB (DATA-02/INFRA-04)', () => {
  it('the database construct sets removalPolicy DESTROY + deletionProtection default false + deleteAutomatedBackups (all three required or the DB leaks)', () => {
    expect(DATABASE_CONSTRUCT).toMatch(/removalPolicy:\s*RemovalPolicy\.DESTROY/);
    expect(DATABASE_CONSTRUCT).toMatch(/deletionProtection:\s*props\.deletionProtection\s*\?\?\s*false/);
    expect(DATABASE_CONSTRUCT).toMatch(/deleteAutomatedBackups:\s*true/);
  });

  it('records the Twilio message-log purge as a manual project-end step (cdk destroy cannot reach it)', () => {
    expect(TESTER_HYGIENE.toLowerCase()).toContain('twilio');
    expect(TESTER_HYGIENE.toLowerCase()).toMatch(/manual|by hand|console/);
  });
});
