import type { PoolClient } from 'pg';
import { matchAde, type AdeMatchCandidate } from '../classifier/ade-matcher.js';
import { LABEL_MATCH_STATEMENT_TIMEOUT_MS } from '../classifier/label-match-writer.js';
import { onsidesEffectsForRxcui, onsidesHasLabelData } from '../classifier/onsides.js';
import { writeLabelMatchesWithClient } from '../classifier/label-match-writer.js';

type SqlClient = Pick<PoolClient, 'query'>;

export interface RuntimeLabelMatchInput {
  readonly patientId: string;
  readonly inboundMessageId: string;
  readonly currentBody: string;
  readonly activeMedicationIds: readonly string[];
  readonly hasSymptomObservation: boolean;
}

/** Advisory only: a match enters the existing clinician queue and never changes patient output. */
export async function persistRuntimeLabelMatches(
  client: SqlClient,
  input: RuntimeLabelMatchInput,
): Promise<number> {
  if (!input.hasSymptomObservation || input.activeMedicationIds.length === 0) return 0;

  // Bound the whole optional lookup, not only its final INSERT. A locked ingredient row must
  // never hold open the clinical-finalization transaction.
  await client.query(`SET LOCAL statement_timeout = ${LABEL_MATCH_STATEMENT_TIMEOUT_MS}`);
  const ingredients = await client.query<{ rxcui: string }>(
    `SELECT DISTINCT pmi.rxcui
       FROM patient_medication_ingredient pmi
      WHERE pmi.patient_id = $1
        AND pmi.patient_medication_id = ANY($2::uuid[])
        AND pmi.rxcui IS NOT NULL
      ORDER BY pmi.rxcui`,
    [input.patientId, input.activeMedicationIds],
  );

  const candidates = new Map<string, AdeMatchCandidate>();
  for (const { rxcui } of ingredients.rows) {
    const result = matchAde({
      text: input.currentBody,
      reasonCode: 'side_effect',
      rxcui,
      effects: onsidesEffectsForRxcui(rxcui),
      hasLabelData: onsidesHasLabelData(rxcui),
    });
    for (const candidate of result.candidates) {
      const key = `${candidate.matchedPhrase.toLowerCase()}\u0000${candidate.meddraPt.toLowerCase()}`;
      const prior = candidates.get(key);
      if (prior === undefined || candidate.hintLevel === 'elevated') {
        candidates.set(key, candidate);
      }
    }
  }

  const inserted = await writeLabelMatchesWithClient(client, {
    patientId: input.patientId,
    inboundMessageId: input.inboundMessageId,
    candidates: [...candidates.values()],
  });
  await client.query('SET LOCAL statement_timeout TO DEFAULT');
  return inserted;
}
