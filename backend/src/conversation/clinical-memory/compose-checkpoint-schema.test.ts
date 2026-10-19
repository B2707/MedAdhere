/**
 * Wave 1b hardening (fix 5) — pure unit test for composeCheckpointSchema's composition size
 * ceiling. Mirrors schema.sql's outbound_message_composition_check
 * (octet_length(composition::text) <= 100000): an oversize provenance blob must fail HERE, in
 * zod, before checkpointComposedOutbound ever reaches Postgres — a normal validation error
 * instead of a post-commit CHECK-constraint crash. No database is involved; composeCheckpointSchema
 * is pure and side-effect-free to import.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { composeCheckpointSchema, type ComposeCheckpointInput } from './repository.js';

function baseInput(composition: Record<string, unknown>): ComposeCheckpointInput {
  return {
    outboundMessageId: randomUUID(),
    patientId: randomUUID(),
    agentTurnId: randomUUID(),
    composedBody: 'Got it, noted.',
    composition,
  };
}

describe('composeCheckpointSchema — composition size ceiling mirrors the DB CHECK', () => {
  it('accepts a typical small composition', () => {
    expect(() =>
      composeCheckpointSchema.parse(baseInput({ intent: { kind: 'acknowledgement' } })),
    ).not.toThrow();
  });

  it('accepts a composition at exactly the 100,000-byte boundary', () => {
    const emptyBytes = Buffer.byteLength(JSON.stringify({ padding: '' }), 'utf8');
    const composition = { padding: 'x'.repeat(100_000 - emptyBytes) };
    expect(Buffer.byteLength(JSON.stringify(composition), 'utf8')).toBe(100_000);
    expect(() => composeCheckpointSchema.parse(baseInput(composition))).not.toThrow();
  });

  it('rejects a composition one byte over the ceiling with a typed zod issue, not a DB round trip', () => {
    const emptyBytes = Buffer.byteLength(JSON.stringify({ padding: '' }), 'utf8');
    const composition = { padding: 'x'.repeat(100_000 - emptyBytes + 1) };
    expect(Buffer.byteLength(JSON.stringify(composition), 'utf8')).toBe(100_001);
    expect(() => composeCheckpointSchema.parse(baseInput(composition))).toThrow(
      /composition_size_ceiling/,
    );
  });
});
