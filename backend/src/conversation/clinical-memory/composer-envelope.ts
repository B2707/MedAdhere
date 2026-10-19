/**
 * Wave 1b Lane B — PHI envelope for the clinical composer.
 *
 * Minimum viable context only: the intent, the patient's latest message, today's inbound
 * bodies, and recent outbound bodies — all with medication labels aliased med_1..n so the
 * model never sees real medication names. De-aliasing is deterministic and happens AFTER
 * validation (composer-validators.ts). The envelope has its OWN context ceiling with an
 * explicit typed size failure — it must never trip the shared 12k-token gateway gate or
 * the bare 96k-byte gateway throw.
 */

export interface ComposerDayMessage {
  readonly id: string;
  readonly direction: 'inbound' | 'outbound';
  readonly body: string;
  readonly occurredAtUtc: string;
}

/**
 * Day context handed in by the plumbing lane: `messages` is job.input.currentDayMessages
 * VERBATIM (the SQL that builds it already carries the four-line outbound status filter —
 * body present, status in queued/sent/delivered/sending_unknown, sent_at set — so the
 * composer can never reference a reply the patient never received).
 */
export interface ComposerDayContext {
  readonly messages: readonly ComposerDayMessage[];
  /** The current inbound body (excluded from currentDayMessages by the loader). */
  readonly latestPatientMessage: string;
}

export interface ComposerMedicationAlias {
  readonly alias: string;
  readonly displayName: string;
}

/** Composer-owned context ceiling (chars), far below the gateway's 96k-byte hard throw. */
export const COMPOSER_CONTEXT_CEILING_CHARS = 6_000;

export class ComposerContextOverflowError extends Error {
  override readonly name = 'ComposerContextOverflowError';

  constructor(
    readonly measuredChars: number,
    readonly ceilingChars: number,
  ) {
    super(`composer context is ${measuredChars} chars over a ${ceilingChars} ceiling`);
  }
}

export interface ComposerEnvelope {
  /** Aliased current inbound body. */
  readonly latestPatientMessage: string;
  /** Aliased patient-authored bodies from today, oldest first (latest excluded). */
  readonly todaysInbound: readonly string[];
  /** Aliased sent outbound bodies from today, oldest first. */
  readonly recentOutbound: readonly string[];
  /** Aliased deterministic patient-status facts, assembled BY CODE upstream. */
  readonly patientFacts: readonly string[];
}

export function buildMedicationAliases(
  displayNames: readonly string[],
  /**
   * Index-aligned ALTERNATE names for the same medications (ingredient names, brand names).
   * They share their medication's alias, so a patient writing "Tylenol" when the primary
   * display name is "acetaminophen" still never crosses to the provider un-aliased — and the
   * validator's patient-drug list recognizes the word instead of forcing a whole-reply
   * fallback. De-aliasing always resolves an alias back to its PRIMARY display name.
   */
  alternateNames: readonly (readonly string[])[] = [],
): readonly ComposerMedicationAlias[] {
  const primary = displayNames.map((displayName, index) => ({
    alias: `med_${index + 1}`,
    displayName,
  }));
  const alternates = alternateNames.flatMap((names, index) =>
    index >= displayNames.length
      ? []
      : names.map((displayName) => ({ alias: `med_${index + 1}`, displayName })),
  );
  return [...primary, ...alternates];
}

/**
 * Worker-side trim to the SAME ceiling `buildComposerEnvelope` enforces, applied BEFORE the
 * day context crosses the gateway wire and before it is persisted in the composition record.
 * Without it a heavy day sends up to 60 x 2,000 chars into the shared 96k-byte transport
 * throw (a bare Error, recorded as a provider-circuit failure) and inflates the stored
 * provenance past its 100k-byte ceiling. Oldest-first, exactly like the envelope, so the
 * validator's grounding corpus stays equal to what the model actually saw.
 */
export function trimComposerDayContext(context: ComposerDayContext): ComposerDayContext {
  let messages = context.messages;
  let total =
    context.latestPatientMessage.length + messages.reduce((sum, { body }) => sum + body.length, 0);
  while (total > COMPOSER_CONTEXT_CEILING_CHARS && messages.length > 0) {
    total -= messages[0]!.body.length;
    messages = messages.slice(1);
  }
  return messages.length === context.messages.length ? context : { ...context, messages };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Unicode-aware word boundary so a short or common-word medication name never garbles an
 * unrelated word it appears inside (displayName 'Iron' must not touch 'environment').
 */
export function medicationNameBoundaryPattern(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'giu');
}

/** Replaces every medication display name with its alias, longest name first. */
export function aliasText(text: string, aliases: readonly ComposerMedicationAlias[]): string {
  return [...aliases]
    .sort((left, right) => right.displayName.length - left.displayName.length)
    .reduce(
      (current, { alias, displayName }) =>
        current.replace(medicationNameBoundaryPattern(displayName), alias),
      text,
    );
}

/**
 * Replaces known med_N aliases with display names; unknown aliases are left for the validator.
 * An alias shared by several names (primary + alternates) always resolves to the FIRST pair,
 * which `buildMedicationAliases` guarantees is the primary display name.
 */
export function dealiasText(text: string, aliases: readonly ComposerMedicationAlias[]): string {
  const byAlias = new Map<string, string>();
  for (const { alias, displayName } of aliases) {
    if (!byAlias.has(alias)) byAlias.set(alias, displayName);
  }
  return text.replace(/\bmed_\d+\b/g, (token) => byAlias.get(token) ?? token);
}

export function buildComposerEnvelope(input: {
  readonly dayMessages: readonly ComposerDayMessage[];
  readonly latestPatientMessage: string;
  readonly patientFacts: readonly string[];
  readonly aliases: readonly ComposerMedicationAlias[];
}): ComposerEnvelope {
  const latestPatientMessage = aliasText(input.latestPatientMessage, input.aliases);
  const patientFacts = input.patientFacts.map((fact) => aliasText(fact, input.aliases));
  const minimumChars =
    latestPatientMessage.length + patientFacts.reduce((sum, fact) => sum + fact.length, 0);
  if (minimumChars > COMPOSER_CONTEXT_CEILING_CHARS) {
    throw new ComposerContextOverflowError(minimumChars, COMPOSER_CONTEXT_CEILING_CHARS);
  }

  // Oldest-first trim: keep dropping the oldest day message until everything fits.
  const aliased = input.dayMessages.map((message) => ({
    direction: message.direction,
    body: aliasText(message.body, input.aliases),
  }));
  let kept = aliased;
  let total = minimumChars + kept.reduce((sum, { body }) => sum + body.length, 0);
  while (total > COMPOSER_CONTEXT_CEILING_CHARS && kept.length > 0) {
    total -= kept[0]!.body.length;
    kept = kept.slice(1);
  }

  return {
    latestPatientMessage,
    todaysInbound: kept.filter(({ direction }) => direction === 'inbound').map(({ body }) => body),
    recentOutbound: kept
      .filter(({ direction }) => direction === 'outbound')
      .map(({ body }) => body),
    patientFacts,
  };
}
