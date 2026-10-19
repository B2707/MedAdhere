import { describe, expect, it } from 'vitest';
import {
  COMPOSER_CONTEXT_CEILING_CHARS,
  ComposerContextOverflowError,
  buildComposerEnvelope,
  buildMedicationAliases,
  aliasText,
  dealiasText,
  trimComposerDayContext,
  type ComposerDayMessage,
} from './composer-envelope.js';

const message = (overrides: Partial<ComposerDayMessage>): ComposerDayMessage => ({
  id: 'msg-1',
  direction: 'inbound',
  body: 'hello',
  occurredAtUtc: '2026-08-16T12:00:00.000Z',
  ...overrides,
});

describe('medication aliasing', () => {
  it('assigns med_1..n in input order', () => {
    const aliases = buildMedicationAliases(['Metformin', 'Lisinopril']);
    expect(aliases).toEqual([
      { alias: 'med_1', displayName: 'Metformin' },
      { alias: 'med_2', displayName: 'Lisinopril' },
    ]);
  });

  it('aliases display names case-insensitively, longest name first', () => {
    const aliases = buildMedicationAliases(['Metformin', 'Metformin XR']);
    expect(aliasText('I took metformin xr and Metformin today', aliases)).toBe(
      'I took med_2 and med_1 today',
    );
  });

  it('escapes regex metacharacters in display names', () => {
    const aliases = buildMedicationAliases(['Vitamin D (2000 IU)']);
    expect(aliasText('took vitamin d (2000 iu) at noon', aliases)).toBe('took med_1 at noon');
  });

  it('de-aliases deterministically and round-trips', () => {
    const aliases = buildMedicationAliases(['Metformin']);
    const aliased = aliasText('Metformin at 8', aliases);
    expect(dealiasText(aliased, aliases)).toBe('Metformin at 8');
  });

  it('leaves an unknown alias untouched for the validator to reject', () => {
    const aliases = buildMedicationAliases(['Metformin']);
    expect(dealiasText('med_9 is due', aliases)).toBe('med_9 is due');
  });

  it('does not garble an unrelated word that contains a short medication name as a substring', () => {
    const aliases = buildMedicationAliases(['Iron']);
    expect(aliasText('the environment is stressful right now', aliases)).toBe(
      'the environment is stressful right now',
    );
  });

  it('still aliases the real mention of the same short medication name', () => {
    const aliases = buildMedicationAliases(['Iron']);
    expect(aliasText('I take Iron at noon', aliases)).toBe('I take med_1 at noon');
  });

  it('aliases a medication ALTERNATE name to the same med_N and de-aliases to the primary', () => {
    const aliases = buildMedicationAliases(['acetaminophen'], [['Tylenol', 'paracetamol']]);
    expect(aliasText('I took Tylenol, not paracetamol', aliases)).toBe('I took med_1, not med_1');
    // Without this the patient's own brand name crossed to the provider un-aliased and any
    // echo of it tripped the drug-outside-the-patient-list gate into a whole-reply fallback.
    expect(dealiasText('noted your med_1 dose', aliases)).toBe('noted your acetaminophen dose');
  });

  it('ignores alternate names for a medication index that does not exist', () => {
    expect(buildMedicationAliases(['Iron'], [[], ['Ghost']])).toEqual([
      { alias: 'med_1', displayName: 'Iron' },
    ]);
  });
});

describe('trimComposerDayContext', () => {
  it('drops oldest-first to the composer ceiling BEFORE the wire and the stored provenance', () => {
    const long = (id: string) => message({ id, body: 'x'.repeat(2_000) });
    const context = {
      messages: Array.from({ length: 10 }, (_, index) => long(`m${index}`)),
      latestPatientMessage: 'still tired',
    };
    const trimmed = trimComposerDayContext(context);
    const chars =
      trimmed.latestPatientMessage.length +
      trimmed.messages.reduce((sum, { body }) => sum + body.length, 0);
    expect(chars).toBeLessThanOrEqual(COMPOSER_CONTEXT_CEILING_CHARS);
    // Oldest dropped, newest kept — identical rule to the envelope's own trim.
    expect(trimmed.messages.at(-1)?.id).toBe('m9');
  });

  it('returns the same object when everything already fits', () => {
    const context = { messages: [message({ id: 'a' })], latestPatientMessage: 'hi' };
    expect(trimComposerDayContext(context)).toBe(context);
  });
});

describe('buildComposerEnvelope', () => {
  const aliases = buildMedicationAliases(['Metformin']);

  it('splits day messages by direction, aliases bodies, and preserves order', () => {
    const envelope = buildComposerEnvelope({
      dayMessages: [
        message({ id: 'a', direction: 'inbound', body: 'took Metformin at 8' }),
        message({ id: 'b', direction: 'outbound', body: 'Thanks for letting me know.' }),
        message({ id: 'c', direction: 'inbound', body: 'feeling a bit tired' }),
      ],
      latestPatientMessage: 'still tired after Metformin',
      patientFacts: ['next Metformin dose today 8:00 pm'],
      aliases,
    });
    expect(envelope.todaysInbound).toEqual(['took med_1 at 8', 'feeling a bit tired']);
    expect(envelope.recentOutbound).toEqual(['Thanks for letting me know.']);
    expect(envelope.latestPatientMessage).toBe('still tired after med_1');
    expect(envelope.patientFacts).toEqual(['next med_1 dose today 8:00 pm']);
  });

  it('trims oldest day messages first when over the ceiling', () => {
    const big = 'x'.repeat(Math.ceil(COMPOSER_CONTEXT_CEILING_CHARS * 0.9));
    const envelope = buildComposerEnvelope({
      dayMessages: [
        message({ id: 'old', body: big }),
        message({ id: 'mid', body: big }),
        message({ id: 'new', body: 'kept' }),
      ],
      latestPatientMessage: 'latest',
      patientFacts: [],
      aliases,
    });
    // Oldest first: "old" is dropped, the newer duplicate body and "kept" survive.
    expect(envelope.todaysInbound).toEqual([big, 'kept']);
  });

  it('throws a typed overflow when the untrimmable minimum exceeds the ceiling', () => {
    expect(() =>
      buildComposerEnvelope({
        dayMessages: [],
        latestPatientMessage: 'y'.repeat(COMPOSER_CONTEXT_CEILING_CHARS + 1),
        patientFacts: [],
        aliases,
      }),
    ).toThrow(ComposerContextOverflowError);
  });

  it('overflow error carries measured and ceiling chars', () => {
    try {
      buildComposerEnvelope({
        dayMessages: [],
        latestPatientMessage: 'y'.repeat(COMPOSER_CONTEXT_CEILING_CHARS + 5),
        patientFacts: [],
        aliases,
      });
      expect.unreachable('expected overflow');
    } catch (error) {
      expect(error).toBeInstanceOf(ComposerContextOverflowError);
      const overflow = error as ComposerContextOverflowError;
      expect(overflow.ceilingChars).toBe(COMPOSER_CONTEXT_CEILING_CHARS);
      expect(overflow.measuredChars).toBeGreaterThan(COMPOSER_CONTEXT_CEILING_CHARS);
    }
  });
});
