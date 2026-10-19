import { DateTime } from 'luxon';
import { z } from 'zod';
import { temporalCandidateSchema, type TemporalCandidate } from './conversation-contract.js';

export const MAX_TEMPORAL_CANDIDATES = 20;
const MAX_SCHEDULED_DOSE_INPUTS = MAX_TEMPORAL_CANDIDATES + 1;
const explicitIsoDatePattern = /(?<![A-Za-z0-9])\d{4}-\d{2}-\d{2}(?![A-Za-z0-9])/g;

const uuidSchema = z.string().uuid();
const isoDateSchema = z.string().date();
const isoDateTimeSchema = z.string().datetime({ offset: true });
const localTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9._+-]+)+)$/);

export const scheduledDoseCandidateInputSchema = z
  .object({
    doseId: uuidSchema,
    patientMedicationId: uuidSchema.nullable(),
    scheduledAtUtc: isoDateTimeSchema,
    localDate: isoDateSchema,
    localTime: localTimeSchema,
    patientTimeZone: timeZoneSchema,
  })
  .strict();

export type ScheduledDoseCandidateInput = Readonly<
  z.infer<typeof scheduledDoseCandidateInputSchema>
>;

const temporalCandidateGenerationInputSchema = z
  .object({
    currentUtc: isoDateTimeSchema,
    currentLocalDate: isoDateSchema,
    patientTimeZone: timeZoneSchema,
    explicitRecentLocalDates: z.array(isoDateSchema).max(MAX_TEMPORAL_CANDIDATES),
    pendingCandidateIds: z.array(uuidSchema).max(MAX_TEMPORAL_CANDIDATES),
    scheduledDoses: z.array(scheduledDoseCandidateInputSchema).max(MAX_SCHEDULED_DOSE_INPUTS),
  })
  .strict()
  .superRefine(({ pendingCandidateIds, scheduledDoses }, context) => {
    const doseIds = scheduledDoses.map(({ doseId }) => doseId);
    if (new Set(doseIds).size !== doseIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scheduledDoses'],
        message: 'Scheduled doses contain a duplicate dose id',
      });
    }
    if (new Set(pendingCandidateIds).size !== pendingCandidateIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pendingCandidateIds'],
        message: 'Pending candidates contain a duplicate id',
      });
    }
  });

export type TemporalCandidateGenerationInput = Readonly<{
  currentUtc: string;
  currentLocalDate: string;
  patientTimeZone: string;
  explicitRecentLocalDates: readonly string[];
  pendingCandidateIds: readonly string[];
  scheduledDoses: readonly ScheduledDoseCandidateInput[];
  /** M-01: narrows the pool to the doses the patient's own time reference names. */
  expression?: TemporalExpressionResolution;
}>;

function assertDoseProvenance(dose: ScheduledDoseCandidateInput, patientTimeZone: string): void {
  if (dose.patientTimeZone !== patientTimeZone) {
    throw new Error('Scheduled dose timezone does not match the patient timezone');
  }
  const local = DateTime.fromISO(dose.scheduledAtUtc, { setZone: true }).setZone(patientTimeZone);
  if (
    !local.isValid ||
    local.toISODate() !== dose.localDate ||
    local.toFormat('HH:mm') !== dose.localTime
  ) {
    throw new Error('Scheduled dose UTC instant does not match its stored local date/time');
  }
}

function priorLocalDate(currentLocalDate: string, patientTimeZone: string): string {
  const prior = DateTime.fromISO(currentLocalDate, { zone: patientTimeZone }).minus({ days: 1 });
  const date = prior.toISODate();
  if (!prior.isValid || date === null) throw new Error('Unable to resolve the prior local date');
  return date;
}

/** Extracts the bounded, deterministic ISO dates that can safely widen one dose lookup. */
export function extractExplicitRecentLocalDates(
  untrustedText: string,
  untrustedCurrentLocalDate: string,
  untrustedPatientTimeZone: string,
): string[] {
  const text = z.string().parse(untrustedText);
  const currentLocalDate = isoDateSchema.parse(untrustedCurrentLocalDate);
  const patientTimeZone = timeZoneSchema.parse(untrustedPatientTimeZone);
  const current = DateTime.fromISO(currentLocalDate, { zone: patientTimeZone });
  if (!current.isValid) throw new Error('Unable to resolve the current local date');

  const dates = new Set<string>();
  for (const match of text.matchAll(explicitIsoDatePattern)) {
    const candidate = match[0];
    const parsed = DateTime.fromISO(candidate, { zone: patientTimeZone });
    if (!parsed.isValid || parsed.toISODate() !== candidate || candidate > currentLocalDate)
      continue;
    dates.add(candidate);
    if (dates.size === MAX_TEMPORAL_CANDIDATES) break;
  }
  return [...dates];
}

export interface TemporalWindow {
  readonly localDate: string;
  /** Inclusive local wall clock, `HH:mm`. */
  readonly startLocalTime: string;
  /** Exclusive local wall clock, `HH:mm`, where `24:00` means end of day. */
  readonly endLocalTime: string;
}

export type TemporalExpressionResolution =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'resolved';
      readonly source: 'explicit_time' | 'relative_time';
      readonly windows: readonly TemporalWindow[];
    }
  | {
      readonly kind: 'ambiguous';
      readonly source: 'explicit_time';
      readonly clarificationTopic: 'dose_meridiem';
      readonly windows: readonly TemporalWindow[];
    };

const TIME_OF_DAY_WINDOWS: Readonly<Record<string, readonly [string, string]>> = {
  morning: ['04:00', '12:00'],
  afternoon: ['12:00', '17:00'],
  evening: ['17:00', '24:00'],
  night: ['17:00', '24:00'],
};
const PRIOR_DAY_PATTERN = /\b(?:yesterday|last\s+day)\b/iu;
const CURRENT_DAY_PATTERN = /\btoday\b/iu;
const LAST_NIGHT_PATTERN = /\b(?:last\s+night|overnight)\b/iu;
const TIME_OF_DAY_PATTERN = /\b(?:this\s+)?(morning|afternoon|evening|night)\b|\b(tonight)\b/iu;
const EXPLICIT_TIME_PATTERN =
  /\b(\d{1,2})(?::[0-5]\d)?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])|\b([01]?\d|2[0-3]):[0-5]\d\b|\b(?:at|around|about|near|approximately)\s+(\d{1,2})\b(?!\s*(?::\d|a\.?m\.?|p\.?m\.?))/giu;

function hourWindow(localDate: string, hour: number): TemporalWindow {
  return {
    localDate,
    startLocalTime: `${String(hour).padStart(2, '0')}:00`,
    endLocalTime: `${String(hour + 1).padStart(2, '0')}:00`,
  };
}

/**
 * Resolves patient time references against the patient's own clock (M-01).
 *
 * Deterministic wherever the wall clock allows it: a reading that has not
 * happened yet cannot describe a dose already taken, so it is dropped. A bare
 * hour that still reads two ways after that ("at 8" late in the evening)
 * returns the ambiguity that drives exactly one `dose_meridiem` clarification.
 */
export function resolveTemporalExpression(
  untrustedText: string,
  untrustedCurrentUtc: string,
  untrustedPatientTimeZone: string,
): TemporalExpressionResolution {
  const text = z.string().max(4_000).parse(untrustedText);
  const patientTimeZone = timeZoneSchema.parse(untrustedPatientTimeZone);
  const now = DateTime.fromISO(isoDateTimeSchema.parse(untrustedCurrentUtc), {
    setZone: true,
  }).setZone(patientTimeZone);
  const currentLocalDate = now.toISODate();
  if (!now.isValid || currentLocalDate === null) {
    throw new Error('Unable to resolve the current patient-local instant');
  }
  const currentLocalTime = now.toFormat('HH:mm');
  const priorDate = priorLocalDate(currentLocalDate, patientTimeZone);

  const lastNight = LAST_NIGHT_PATTERN.test(text);
  const priorDay = lastNight || PRIOR_DAY_PATTERN.test(text);
  const currentDay = CURRENT_DAY_PATTERN.test(text);
  const mentionedDates = new Set([...text.matchAll(explicitIsoDatePattern)].map(([date]) => date));
  const explicitDates = extractExplicitRecentLocalDates(text, currentLocalDate, patientTimeZone);
  if (mentionedDates.size !== explicitDates.length || explicitDates.length > 1) {
    return { kind: 'none' };
  }
  const explicitDate = explicitDates[0] ?? null;
  if (
    (priorDay && currentDay) ||
    (explicitDate !== null &&
      ((priorDay && explicitDate !== priorDate) ||
        (currentDay && explicitDate !== currentLocalDate)))
  ) {
    return { kind: 'none' };
  }
  const localDate = explicitDate ?? (priorDay ? priorDate : currentLocalDate);

  const explicitTimes = [...text.matchAll(EXPLICIT_TIME_PATTERN)];
  const timeOfDay = TIME_OF_DAY_PATTERN.exec(text);

  let source: 'explicit_time' | 'relative_time' = 'relative_time';
  const ambiguousWindowPairs: Array<readonly [TemporalWindow, TemporalWindow]> = [];
  let windows: TemporalWindow[] = [];
  for (const reference of explicitTimes) {
    if (reference[1] !== undefined && reference[2] !== undefined) {
      const statedHour = Number(reference[1]);
      if (statedHour < 1 || statedHour > 12) continue;
      const hour = statedHour % 12;
      windows.push(hourWindow(localDate, /^p/i.test(reference[2]) ? hour + 12 : hour));
      continue;
    }
    if (reference[3] !== undefined) {
      const hour = Number(reference[3]);
      if (hour >= 1 && hour <= 12) {
        const twelveHour = hour % 12;
        const pair = [
          hourWindow(localDate, twelveHour),
          hourWindow(localDate, twelveHour + 12),
        ] as const;
        ambiguousWindowPairs.push(pair);
        windows.push(...pair);
      } else {
        windows.push(hourWindow(localDate, hour));
      }
      continue;
    }
    const statedHour = Number(reference[4]);
    if (statedHour >= 1 && statedHour <= 12) {
      const hour = statedHour % 12;
      const pair = [hourWindow(localDate, hour), hourWindow(localDate, hour + 12)] as const;
      ambiguousWindowPairs.push(pair);
      windows.push(...pair);
    }
  }
  if (windows.length > 0) {
    source = 'explicit_time';
  } else if (lastNight) {
    windows = [
      { localDate: priorDate, startLocalTime: '17:00', endLocalTime: '24:00' },
      { localDate: currentLocalDate, startLocalTime: '00:00', endLocalTime: '04:00' },
    ];
  } else if (timeOfDay !== null) {
    const word = (timeOfDay[1] ?? 'evening').toLowerCase();
    const [startLocalTime, endLocalTime] = TIME_OF_DAY_WINDOWS[word]!;
    windows = [{ localDate, startLocalTime, endLocalTime }];
  } else if (priorDay) {
    windows = [{ localDate: priorDate, startLocalTime: '00:00', endLocalTime: '24:00' }];
  } else {
    return { kind: 'none' };
  }

  const past = [
    ...new Map(
      windows.map((window) => [
        `${window.localDate}:${window.startLocalTime}:${window.endLocalTime}`,
        window,
      ]),
    ).values(),
  ]
    .sort(
      (left, right) =>
        left.localDate.localeCompare(right.localDate) ||
        left.startLocalTime.localeCompare(right.startLocalTime),
    )
    .filter(
      (window) => window.localDate !== currentLocalDate || window.startLocalTime < currentLocalTime,
    );
  if (past.length === 0) return { kind: 'none' };
  const pastWindowKeys = new Set(
    past.map(
      ({ localDate: date, startLocalTime, endLocalTime }) =>
        `${date}:${startLocalTime}:${endLocalTime}`,
    ),
  );
  const meridiemAmbiguous = ambiguousWindowPairs.some((pair) =>
    pair.every(({ localDate: date, startLocalTime, endLocalTime }) =>
      pastWindowKeys.has(`${date}:${startLocalTime}:${endLocalTime}`),
    ),
  );
  return meridiemAmbiguous
    ? {
        kind: 'ambiguous',
        source: 'explicit_time',
        clarificationTopic: 'dose_meridiem',
        windows: past,
      }
    : { kind: 'resolved', source, windows: past };
}

function withinWindows(
  dose: Pick<ScheduledDoseCandidateInput, 'localDate' | 'localTime'>,
  windows: readonly TemporalWindow[],
): boolean {
  return windows.some(
    ({ localDate, startLocalTime, endLocalTime }) =>
      dose.localDate === localDate &&
      dose.localTime >= startLocalTime &&
      dose.localTime < endLocalTime,
  );
}

/**
 * Builds the small, deterministic scheduled-dose pool supplied to one model turn.
 * A pending clarification keeps only its prior allowlisted dose ids; otherwise the
 * pool covers the patient's current/prior local day plus explicitly referenced dates.
 */
export function generateScheduledDoseCandidates(
  untrustedInput: TemporalCandidateGenerationInput,
): TemporalCandidate[] {
  const { expression, ...rest } = untrustedInput;
  const input = temporalCandidateGenerationInputSchema.parse({
    ...rest,
    explicitRecentLocalDates: [...untrustedInput.explicitRecentLocalDates],
    pendingCandidateIds: [...untrustedInput.pendingCandidateIds],
    scheduledDoses: [...untrustedInput.scheduledDoses],
  });
  input.scheduledDoses.forEach((dose) => assertDoseProvenance(dose, input.patientTimeZone));

  const currentUtcMillis = Date.parse(input.currentUtc);
  const pendingIds = new Set(input.pendingCandidateIds);
  const selectedDates = new Set([
    input.currentLocalDate,
    priorLocalDate(input.currentLocalDate, input.patientTimeZone),
    ...input.explicitRecentLocalDates,
  ]);
  const selected = input.scheduledDoses
    .filter(({ doseId, scheduledAtUtc, localDate }) => {
      if (Date.parse(scheduledAtUtc) > currentUtcMillis) return false;
      return pendingIds.size > 0 ? pendingIds.has(doseId) : selectedDates.has(localDate);
    })
    .sort(
      (left, right) =>
        Date.parse(left.scheduledAtUtc) - Date.parse(right.scheduledAtUtc) ||
        left.doseId.localeCompare(right.doseId),
    );
  if (selected.length > MAX_TEMPORAL_CANDIDATES) {
    throw new Error(`Temporal resolution produced more than ${MAX_TEMPORAL_CANDIDATES} candidates`);
  }

  // A pending clarification already fixed its allowlist, so only a fresh turn
  // narrows by the patient's own time reference. An expression that matches no
  // scheduled dose never removes one — the wider pool stays available.
  const narrowed =
    pendingIds.size > 0 || expression === undefined || expression.kind === 'none'
      ? []
      : selected.filter((dose) => withinWindows(dose, expression.windows));
  const resolved = narrowed.length > 0 ? narrowed : selected;
  const source =
    pendingIds.size > 0
      ? 'pending_clarification'
      : narrowed.length > 0 && expression !== undefined && expression.kind !== 'none'
        ? expression.source
        : 'scheduled_dose';

  const ambiguous = resolved.length > 1;
  return resolved.map((dose) =>
    temporalCandidateSchema.parse({
      candidateId: dose.doseId,
      patientMedicationId: dose.patientMedicationId,
      doseId: dose.doseId,
      occurredAtUtc: dose.scheduledAtUtc,
      localDate: dose.localDate,
      localTime: dose.localTime,
      patientTimeZone: dose.patientTimeZone,
      source,
      ambiguous,
    }),
  );
}
