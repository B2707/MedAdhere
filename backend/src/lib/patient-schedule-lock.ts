import type { PoolClient } from 'pg';

/**
 * Transaction-scoped schedule-mutation lock. Callers must lock the patient row first, then acquire
 * this advisory lock, and hold both until all external Scheduler mutations and the transaction commit.
 */
export async function lockPatientScheduleMutation(
  client: Pick<PoolClient, 'query'>,
  patientId: string,
): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [patientId]);
}
