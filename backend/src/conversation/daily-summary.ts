import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { z } from 'zod';

const prioritySchema = z.enum(['none', 'routine', 'important', 'emergency']);
// Lane S (2026-08-17): symptomName/onset are extractor-validated clinical_values fields
// already stored on the canonical event, not raw inbound text — the daily-summary prose is
// allowed to quote them verbatim. Both optional: only symptom events carry them.
const eventSchema = z
  .object({
    eventId: z.string().uuid(),
    eventType: z.enum(['patient_statement', 'observation', 'adherence', 'context', 'alert']),
    eventCode: z.string().trim().min(1).max(128).nullable(),
    occurredAtUtc: z.string().datetime({ offset: true }),
    severity: z.number().int().min(1).max(10).nullable(),
    priority: prioritySchema,
    // Bounds match the canonical textSchema (contracts.ts, 1000) these values come from: a
    // tighter cap here throws INSIDE the turn-commit transaction and rolls the patient's whole
    // message back. Over-long prose is handled downstream by MAX_RICH_SUMMARY_LENGTH, which
    // falls back to the truthful counter line.
    symptomName: z.string().trim().min(1).max(1_000).optional(),
    onset: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();

type AdherenceState = 'taken' | 'delayed' | 'skipped' | 'stopped' | 'question' | 'unknown';
const ADHERENCE_STATES: readonly AdherenceState[] = [
  'taken',
  'delayed',
  'skipped',
  'stopped',
  'question',
  'unknown',
];
const adherenceCountsSchema = z
  .object({
    taken: z.number().int().nonnegative(),
    delayed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    stopped: z.number().int().nonnegative(),
    question: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  })
  .strict();
const totalsSchema = z
  .object({
    eventCount: z.number().int().nonnegative(),
    symptomCount: z.number().int().nonnegative(),
    adherenceCounts: adherenceCountsSchema,
    highestPriority: prioritySchema,
  })
  .strict();

const inputSchema = z
  .object({
    localDate: z.string().date(),
    patientTimeZone: z.string().trim().min(1).max(64),
    events: z.array(eventSchema).max(100),
    totals: totalsSchema.optional(),
  })
  .strict();

const PRIORITY_RANK = { none: 0, routine: 1, important: 2, emergency: 3 } as const;
// tradeoff: fixed prose cap — generous enough for a handful of symptom clauses, small enough
// to bound a pathological day (extractor text fields run up to 1000 chars each). Revisit if a
// clinician workflow ever needs the full rich text past this length.
const MAX_RICH_SUMMARY_LENGTH = 480;

export type DailySummaryBuildInput = Readonly<z.input<typeof inputSchema>>;

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

function formatPatientLocalTime(occurredAtUtc: string, zone: string): string {
  return DateTime.fromISO(occurredAtUtc, { zone: 'utc' })
    .setZone(zone)
    .toFormat('h:mm a')
    .toLowerCase();
}

function symptomClause(event: z.output<typeof eventSchema>, patientTimeZone: string): string {
  const name = capitalize((event.symptomName ?? 'symptom').trim());
  const time = formatPatientLocalTime(event.occurredAtUtc, patientTimeZone);
  const severityPart = event.severity === null ? '' : ` (severity ${event.severity}/10)`;
  const onsetPart = event.onset === undefined ? '' : `, started ${event.onset}`;
  return `${name} reported at ${time}${severityPart}${onsetPart}`;
}

function adherenceClause(counts: Readonly<Record<AdherenceState, number>>): string {
  const parts = ADHERENCE_STATES.filter((state) => counts[state] > 0).map(
    (state) => `${counts[state]} dose${counts[state] === 1 ? '' : 's'} ${state}`,
  );
  return parts.length === 0 ? 'no dose outcome recorded today' : parts.join(', ');
}

function renderRichSummaryText(
  events: readonly z.output<typeof eventSchema>[],
  totals: z.output<typeof totalsSchema>,
  patientTimeZone: string,
): string {
  const clauses = [
    ...events
      .filter(({ eventCode }) => eventCode === 'symptom')
      .map((event) => symptomClause(event, patientTimeZone)),
    adherenceClause(totals.adherenceCounts),
  ];
  return capitalize(`${clauses.join('; ')}; highest priority ${totals.highestPriority}.`);
}

export function buildDailySummary(untrustedInput: DailySummaryBuildInput) {
  const input = inputSchema.parse({
    ...untrustedInput,
    events: [...untrustedInput.events],
  });
  const start = DateTime.fromISO(input.localDate, { zone: input.patientTimeZone }).startOf('day');
  const end = start.plus({ days: 1 });
  if (!start.isValid || !end.isValid) throw new Error('Invalid patient-local summary day');

  const events = [...input.events].sort(
    (left, right) =>
      Date.parse(left.occurredAtUtc) - Date.parse(right.occurredAtUtc) ||
      left.eventId.localeCompare(right.eventId),
  );
  const detailedAdherenceCounts = Object.fromEntries(
    ADHERENCE_STATES.map((state) => [
      state,
      events.filter(
        ({ eventType, eventCode }) =>
          eventType === 'adherence' && eventCode?.split(':', 1)[0] === state,
      ).length,
    ]),
  ) as Record<AdherenceState, number>;
  const highestPriority = events.reduce<(typeof prioritySchema)['_output']>(
    (highest, event) =>
      PRIORITY_RANK[event.priority] > PRIORITY_RANK[highest] ? event.priority : highest,
    'none',
  );
  const detailedSymptomCount = events.filter(({ eventCode }) => eventCode === 'symptom').length;
  const totals =
    input.totals ??
    totalsSchema.parse({
      eventCount: events.length,
      symptomCount: detailedSymptomCount,
      adherenceCounts: detailedAdherenceCounts,
      highestPriority,
    });
  if (
    totals.eventCount < events.length ||
    totals.symptomCount < detailedSymptomCount ||
    ADHERENCE_STATES.some(
      (state) => totals.adherenceCounts[state] < detailedAdherenceCounts[state],
    ) ||
    PRIORITY_RANK[totals.highestPriority] < PRIORITY_RANK[highestPriority]
  ) {
    throw new Error('Daily summary totals cannot understate retained event details');
  }
  const truncated = totals.eventCount > events.length;
  const structuredPayload = {
    localDate: input.localDate,
    patientTimeZone: input.patientTimeZone,
    eventCount: totals.eventCount,
    detailedEventCount: events.length,
    truncated,
    eventIds: events.map(({ eventId }) => eventId),
    events: events.map(({ eventId, eventType, eventCode, occurredAtUtc, severity, priority }) => ({
      eventId,
      eventType,
      eventCode,
      occurredAtUtc,
      severity,
      priority,
    })),
    symptomCount: totals.symptomCount,
    adherenceCounts: totals.adherenceCounts,
    highestPriority: totals.highestPriority,
  } as const;
  // The dashboard's daySummaryPayloadSchema.events is `.strict()` with exactly the six fields
  // above (dashboard/src/lib/dashboard-contracts.ts — out of this file's ownership), so
  // symptomName/onset must never be echoed into the persisted structuredPayload. They still
  // have to move the hash, or a symptom-name/onset-only correction would look identical to the
  // writer seam's dedup check (`prior.input_hash === summary.inputHash`) and the stale prose
  // would silently survive. Fold them into a hash-only sibling structure instead.
  const proseInputs = events.map(({ symptomName, onset }) => [symptomName ?? null, onset ?? null]);
  const canonicalPayload = JSON.stringify({ ...structuredPayload, proseInputs });
  const inputHash = createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
  const counterSummaryText = `${totals.eventCount} event${totals.eventCount === 1 ? '' : 's'}; ${totals.symptomCount} symptom report${totals.symptomCount === 1 ? '' : 's'}; highest priority ${totals.highestPriority}${truncated ? `; ${events.length} most recently recorded event detail${events.length === 1 ? '' : 's'} retained` : ''}.`;
  // The rich narrative reads only the retained slice of events — on a truncated day that slice
  // is a partial, potentially misleading view of the day, so truncation always falls back to
  // the truthful counter line regardless of its own rendered length.
  const richSummaryText = renderRichSummaryText(events, totals, input.patientTimeZone);
  const summaryText =
    truncated || richSummaryText.length > MAX_RICH_SUMMARY_LENGTH
      ? counterSummaryText
      : richSummaryText;

  return {
    inputHash,
    eventCount: totals.eventCount,
    symptomCount: totals.symptomCount,
    adherenceCounts: totals.adherenceCounts,
    highestPriority: totals.highestPriority,
    windowStartUtc: start.toUTC().toISO()!,
    windowEndUtc: end.toUTC().toISO()!,
    summaryText,
    structuredPayload,
  } as const;
}
