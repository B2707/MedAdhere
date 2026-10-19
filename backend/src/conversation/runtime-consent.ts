import type { PoolClient } from 'pg';
import { z } from 'zod';

const messagingConsentExpectationSchema = z
  .object({
    patientId: z.string().uuid(),
    expectedMessagingStateVersion: z.number().int().positive(),
  })
  .strict();

export type MessagingConsentExpectation = z.infer<typeof messagingConsentExpectationSchema>;

export class MessagingConsentSuppressedError extends Error {
  override readonly name = 'MessagingConsentSuppressedError';

  constructor() {
    super('Conversation messaging consent changed');
  }
}

type MessagingConsentRow = {
  readonly is_active: boolean;
  readonly agent_enabled: boolean;
  readonly provider_opted_in: boolean;
  readonly messaging_state_version: number;
};

type SqlExecutor = Pick<PoolClient, 'query'>;

function consentMatches(row: MessagingConsentRow, expectedVersion: number): boolean {
  return (
    row.messaging_state_version === expectedVersion &&
    row.is_active &&
    row.agent_enabled &&
    row.provider_opted_in
  );
}

/** Locks and validates the exact consent version inside an existing transaction. */
export async function lockMessagingConsent(
  client: SqlExecutor,
  untrustedExpectation: MessagingConsentExpectation,
): Promise<void> {
  const expectation = messagingConsentExpectationSchema.parse(untrustedExpectation);
  const consent = await client.query<MessagingConsentRow>(
    `SELECT is_active, agent_enabled, provider_opted_in, messaging_state_version
       FROM patient
      WHERE id = $1
      FOR NO KEY UPDATE`,
    [expectation.patientId],
  );
  const row = consent.rows[0];
  if (row === undefined || !consentMatches(row, expectation.expectedMessagingStateVersion)) {
    throw new MessagingConsentSuppressedError();
  }
}
