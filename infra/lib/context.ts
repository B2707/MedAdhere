// infra/lib/context.ts
//
// Pure context-parsing helpers for the CDK app entry (bin/medadhere.ts). Factored out so the coercion
// + validation is unit-testable WITHOUT instantiating the app (which synthesizes at module load).
// Post-exec review (01-05): the bin entry point's Number() coercion was previously untested and could
// silently coerce an empty `-c backupRetentionDays=` to 0.

/** RDS automated-backup retention max (days). The RDS service cap for a single-AZ instance is 35. */
export const MAX_BACKUP_RETENTION_DAYS = 35;

/**
 * Parse + validate the `backupRetentionDays` context value (a cdk.json JSON number, a CLI string from
 * `-c backupRetentionDays=N`, or absent). Returns `fallback` (default 7, the DATA-02 ">=7-day backups
 * from first deploy" baseline) when the value is absent/empty; otherwise requires a whole number in
 * [0, 35] and throws LOUDLY on anything else (non-numeric, negative, fractional, out-of-range) so a
 * fat-fingered override can never silently disable backups.
 *
 * 0 is the EXCEPTIONAL value for a free-plan-restricted account (RDS rejects >0 there); the
 * FoundationStack DATA-02 guard still hard-fails synth if validationWindow=true with <7.
 */
export function parseBackupRetentionDays(raw: unknown, fallback = 7): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  // A boolean coerces silently via Number(true)===1 / Number(false)===0 (both in [0,35]) — reject it
  // explicitly so a cdk.json typo like `"backupRetentionDays": true` can never become a 1-day
  // retention (IN-05). The value legitimately comes only from a JSON number or a CLI string.
  if (typeof raw === 'boolean') {
    throw new Error(
      `backupRetentionDays must be a number or numeric string, not a boolean (got ${JSON.stringify(raw)})`,
    );
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_BACKUP_RETENTION_DAYS) {
    throw new Error(
      `backupRetentionDays must be a whole number of days in [0, ${MAX_BACKUP_RETENTION_DAYS}] ` +
        `(got ${JSON.stringify(raw)})`,
    );
  }
  return n;
}
