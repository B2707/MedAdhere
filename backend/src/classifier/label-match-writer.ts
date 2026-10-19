/**
 * label-match-writer.ts — 04-06 DRUG-02, component 5 writer. Persists ADE annotations to
 * `label_match`. Extracted from the handler so it can be proven against a real PostgreSQL
 * (M4: same-row patient_id, ON CONFLICT idempotency, multi-PT).
 *
 * Design (04-06 pre-exec):
 *  - H3: ONE atomic multi-row INSERT … ON CONFLICT DO NOTHING (never a per-candidate loop —
 *    that would leave a corrupt partial set on a mid-write failure). Replay idempotency for
 *    the matcher comes from the handler's adherence pre-flight (single-shot); ON CONFLICT
 *    covers only the concurrent-redelivery race.
 *  - REV-M1: patient_id is the caller's in-scope inbound_reply.patient_id — never re-derived.
 *  - M1/U-13: matched_phrase is the verbatim matched span, bound as a parameter (never
 *    concatenated), so patient text cannot reach the SQL string or an error message.
 *  - M2: a short transaction-local statement_timeout bounds the write so a hung INSERT can
 *    never push the classifier invocation toward the Lambda ceiling.
 */
import type { Pool, PoolClient } from 'pg';
import type { AdeMatchCandidate } from './ade-matcher.js';

/** Bound the write so DB pressure can't extend the invocation to the Lambda timeout (M2). */
export const LABEL_MATCH_STATEMENT_TIMEOUT_MS = 2000;

export interface WriteLabelMatchesInput {
  readonly inboundMessageId: string;
  /** From the in-scope inbound_reply row (REV-M1) — never independently looked up. */
  readonly patientId: string;
  readonly candidates: readonly AdeMatchCandidate[];
}

type LabelMatchClient = Pick<PoolClient, 'query'>;

/** Use the caller's transaction so conversation finalization does not open a second connection. */
export async function writeLabelMatchesWithClient(
  client: LabelMatchClient,
  input: WriteLabelMatchesInput,
): Promise<number> {
  if (input.candidates.length === 0) return 0;

  const valueGroups: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (const candidate of input.candidates) {
    valueGroups.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
    params.push(
      input.inboundMessageId,
      input.patientId,
      candidate.matchedPhrase,
      candidate.meddraPt,
      candidate.hintLevel,
    );
  }

  await client.query(`SET LOCAL statement_timeout = ${LABEL_MATCH_STATEMENT_TIMEOUT_MS}`);
  const result = await client.query(
    `INSERT INTO label_match (inbound_message_id, patient_id, matched_phrase, meddra_pt, hint_level)
     VALUES ${valueGroups.join(', ')}
     ON CONFLICT (inbound_message_id, matched_phrase, meddra_pt) DO NOTHING`,
    params,
  );
  await client.query('SET LOCAL statement_timeout TO DEFAULT');
  return result.rowCount ?? 0;
}

/**
 * Insert the ADE annotations for one reply as a single atomic statement. Returns the number
 * of rows actually inserted (0 when candidates is empty or every row already existed).
 */
export async function writeLabelMatches(db: Pool, input: WriteLabelMatchesInput): Promise<number> {
  if (input.candidates.length === 0) return 0;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const inserted = await writeLabelMatchesWithClient(client, input);
    await client.query('COMMIT');
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      /* the timeout/error is what matters; a failed rollback must not mask it */
    });
    throw err;
  } finally {
    client.release();
  }
}
