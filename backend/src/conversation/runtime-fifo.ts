import type { PoolClient } from 'pg';

export async function assertLowestUnfinishedConversationJob(
  client: Pick<PoolClient, 'query'>,
  patientId: string,
  inboundSequence: number | string,
): Promise<void> {
  const lower = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM turn_job
        WHERE patient_id = $1
          AND completed_at IS NULL
          AND inbound_sequence < $2::bigint
     ) AS exists`,
    [patientId, inboundSequence],
  );
  if (lower.rows[0]?.exists) throw new Error('conversation_job_not_lowest_unfinished');
}
