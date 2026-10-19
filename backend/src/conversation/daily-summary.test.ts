import { describe, expect, it } from 'vitest';
import { buildDailySummary } from './daily-summary.js';

const symptom = {
  eventId: '10000000-0000-4000-8000-000000000001',
  eventType: 'observation' as const,
  eventCode: 'symptom',
  occurredAtUtc: '2026-08-11T12:00:00.000Z',
  severity: 2,
  priority: 'routine' as const,
};

const adherence = {
  eventId: '10000000-0000-4000-8000-000000000002',
  eventType: 'adherence' as const,
  eventCode: 'taken:none',
  occurredAtUtc: '2026-08-11T13:00:00.000Z',
  severity: null,
  priority: 'routine' as const,
};

describe('deterministic daily summary', () => {
  it('produces byte-equivalent payload and hash for the same ordered facts', () => {
    const first = buildDailySummary({
      localDate: '2026-08-11',
      patientTimeZone: 'America/Toronto',
      events: [symptom, adherence],
    });
    const replay = buildDailySummary({
      localDate: '2026-08-11',
      patientTimeZone: 'America/Toronto',
      events: [symptom, adherence],
    });

    expect(replay).toEqual(first);
    expect(JSON.stringify(replay.structuredPayload)).toBe(JSON.stringify(first.structuredPayload));
    expect(first).toMatchObject({
      eventCount: 2,
      symptomCount: 1,
      highestPriority: 'routine',
      adherenceCounts: {
        taken: 1,
        delayed: 0,
        skipped: 0,
        stopped: 0,
        question: 0,
        unknown: 0,
      },
    });
    expect(first.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('orders facts canonically and changes the hash when a fact changes', () => {
    const ordered = buildDailySummary({
      localDate: '2026-08-11',
      patientTimeZone: 'America/Toronto',
      events: [symptom, adherence],
    });
    const reverse = buildDailySummary({
      localDate: '2026-08-11',
      patientTimeZone: 'America/Toronto',
      events: [adherence, symptom],
    });
    const changed = buildDailySummary({
      localDate: '2026-08-11',
      patientTimeZone: 'America/Toronto',
      events: [{ ...symptom, severity: 3 }, adherence],
    });

    expect(reverse).toEqual(ordered);
    expect(changed.inputHash).not.toBe(ordered.inputHash);
  });

  it('uses exact DST-aware local-day bounds and highest severity tier', () => {
    const summary = buildDailySummary({
      localDate: '2026-11-01',
      patientTimeZone: 'America/Toronto',
      events: [{ ...symptom, priority: 'emergency' }],
    });

    expect(summary.windowStartUtc).toBe('2026-11-01T04:00:00.000Z');
    expect(summary.windowEndUtc).toBe('2026-11-02T05:00:00.000Z');
    expect(summary.highestPriority).toBe('emergency');
  });

  it('keeps truthful totals when only bounded recent details are retained', () => {
    const summary = buildDailySummary({
      localDate: '2026-08-11',
      patientTimeZone: 'America/Toronto',
      events: [adherence],
      totals: {
        eventCount: 101,
        symptomCount: 4,
        adherenceCounts: {
          taken: 20,
          delayed: 1,
          skipped: 2,
          stopped: 0,
          question: 0,
          unknown: 0,
        },
        highestPriority: 'emergency',
      },
    });

    expect(summary).toMatchObject({
      eventCount: 101,
      symptomCount: 4,
      highestPriority: 'emergency',
      structuredPayload: {
        eventCount: 101,
        detailedEventCount: 1,
        truncated: true,
      },
    });
    expect(summary.summaryText).toContain('1 most recently recorded event detail retained');
  });

  it('rejects aggregate totals that understate retained details', () => {
    expect(() =>
      buildDailySummary({
        localDate: '2026-08-11',
        patientTimeZone: 'America/Toronto',
        events: [{ ...symptom, priority: 'emergency' }],
        totals: {
          eventCount: 1,
          symptomCount: 0,
          adherenceCounts: {
            taken: 0,
            delayed: 0,
            skipped: 0,
            stopped: 0,
            question: 0,
            unknown: 0,
          },
          highestPriority: 'routine',
        },
      }),
    ).toThrow('cannot understate');
  });
});

// Lane S (2026-08-17, owner option A): summaryText renders informative prose from the
// structured fields instead of a bare counter line — symptom name + severity + onset (a
// clinical_values verbatim quote, not raw inbound text), adherence outcomes by state with
// counts, highest tier, and patient-local times. DRAFT wording — owner-gate-pending.
describe('rich deterministic daily summary prose', () => {
  const headache = {
    eventId: '20000000-0000-4000-8000-000000000001',
    eventType: 'patient_statement' as const,
    eventCode: 'symptom',
    occurredAtUtc: '2026-08-16T19:13:00.000Z', // 3:13 pm America/Toronto (EDT, UTC-4)
    severity: 8,
    priority: 'routine' as const,
    symptomName: 'headache',
    onset: 'about an hour earlier',
  };

  it("renders tonight's live example informatively", () => {
    const summary = buildDailySummary({
      localDate: '2026-08-16',
      patientTimeZone: 'America/Toronto',
      events: [headache],
    });

    expect(summary.summaryText).toBe(
      'Headache reported at 3:13 pm (severity 8/10), started about an hour earlier; ' +
        'no dose outcome recorded today; highest priority routine.',
    );
  });

  it('renders a plain fallback line on an empty day', () => {
    const summary = buildDailySummary({
      localDate: '2026-08-11',
      patientTimeZone: 'America/Toronto',
      events: [],
    });

    expect(summary.summaryText).toBe('No dose outcome recorded today; highest priority none.');
  });

  it('renders every symptom on a multi-symptom day', () => {
    const nausea = {
      eventId: '20000000-0000-4000-8000-000000000002',
      eventType: 'patient_statement' as const,
      eventCode: 'symptom',
      occurredAtUtc: '2026-08-16T12:30:00.000Z', // 8:30 am America/Toronto
      severity: 3,
      priority: 'routine' as const,
      symptomName: 'nausea',
      onset: 'right after breakfast',
    };
    const summary = buildDailySummary({
      localDate: '2026-08-16',
      patientTimeZone: 'America/Toronto',
      events: [headache, nausea],
    });

    expect(summary.summaryText).toBe(
      'Nausea reported at 8:30 am (severity 3/10), started right after breakfast; ' +
        'Headache reported at 3:13 pm (severity 8/10), started about an hour earlier; ' +
        'no dose outcome recorded today; highest priority routine.',
    );
  });

  it('renders adherence outcomes by state with counts on an adherence-only day', () => {
    const taken = { ...adherence, eventId: '20000000-0000-4000-8000-000000000003' };
    const delayed = {
      ...adherence,
      eventId: '20000000-0000-4000-8000-000000000004',
      eventCode: 'delayed:none',
    };
    const summary = buildDailySummary({
      localDate: '2026-08-11',
      patientTimeZone: 'America/Toronto',
      events: [taken, delayed],
    });

    expect(summary.summaryText).toBe('1 dose taken, 1 dose delayed; highest priority routine.');
    expect(summary.summaryText).not.toContain('no dose outcome');
  });

  it('changes the hash when only the new prose fields differ', () => {
    const withOnset = buildDailySummary({
      localDate: '2026-08-16',
      patientTimeZone: 'America/Toronto',
      events: [headache],
    });
    const differentOnset = buildDailySummary({
      localDate: '2026-08-16',
      patientTimeZone: 'America/Toronto',
      events: [{ ...headache, onset: 'right before lunch' }],
    });

    expect(differentOnset.inputHash).not.toBe(withOnset.inputHash);
  });

  it('replays byte-identically when the widened input repeats', () => {
    const first = buildDailySummary({
      localDate: '2026-08-16',
      patientTimeZone: 'America/Toronto',
      events: [headache],
    });
    const replay = buildDailySummary({
      localDate: '2026-08-16',
      patientTimeZone: 'America/Toronto',
      events: [headache],
    });

    expect(replay).toEqual(first);
  });

  it('falls back to the counter line when the truncated-day cap applies', () => {
    // Existing truncation cap (>100 retained events) — the rich per-event narrative would
    // misrepresent a day it only has a partial slice of, so it always falls back here too.
    const summary = buildDailySummary({
      localDate: '2026-08-11',
      patientTimeZone: 'America/Toronto',
      events: [headache],
      totals: {
        eventCount: 101,
        symptomCount: 5,
        adherenceCounts: {
          taken: 0,
          delayed: 0,
          skipped: 0,
          stopped: 0,
          question: 0,
          unknown: 0,
        },
        highestPriority: 'routine',
      },
    });

    expect(summary.summaryText).toBe(
      '101 events; 5 symptom reports; highest priority routine; ' +
        '1 most recently recorded event detail retained.',
    );
  });

  it('falls back to the counter line when the rendered prose exceeds the length cap', () => {
    const longOnset = 'x'.repeat(200);
    const manySymptoms = Array.from({ length: 5 }, (_, index) => ({
      eventId: `20000000-0000-4000-8000-00000000001${index}`,
      eventType: 'patient_statement' as const,
      eventCode: 'symptom',
      occurredAtUtc: `2026-08-16T1${index}:00:00.000Z`,
      severity: 5,
      priority: 'routine' as const,
      symptomName: `symptom-${index}`,
      onset: longOnset,
    }));
    const summary = buildDailySummary({
      localDate: '2026-08-16',
      patientTimeZone: 'America/Toronto',
      events: manySymptoms,
    });

    expect(summary.summaryText).toBe('5 events; 5 symptom reports; highest priority routine.');
  });

  it('accepts the full canonical text bound on symptomName and onset instead of throwing the turn away', () => {
    // Both fields come from canonical clinical_values, bounded by textSchema at 1000 chars
    // (contracts.ts). A tighter bound here throws out of buildDailySummary INSIDE the
    // turn-commit transaction, rolling back the patient's whole message.
    const summary = buildDailySummary({
      localDate: '2026-08-16',
      patientTimeZone: 'America/Toronto',
      events: [{ ...headache, symptomName: 'a'.repeat(1000), onset: 'b'.repeat(1000) }],
    });

    // Prose that long can never fit the cap, so the truthful counter line ships — never a throw.
    expect(summary.summaryText).toBe('1 event; 1 symptom report; highest priority routine.');
  });

  it('keeps the persisted structuredPayload.events shape dashboard-compatible', () => {
    // dashboard/src/lib/dashboard-contracts.ts daySummaryPayloadSchema.events is `.strict()`
    // with exactly these 6 keys (out of this file's ownership) — symptomName/onset must never
    // leak into the persisted payload, only into summaryText and the inputHash.
    const summary = buildDailySummary({
      localDate: '2026-08-16',
      patientTimeZone: 'America/Toronto',
      events: [headache],
    });

    expect(Object.keys(summary.structuredPayload.events[0]!).sort()).toEqual(
      ['eventCode', 'eventId', 'eventType', 'occurredAtUtc', 'priority', 'severity'].sort(),
    );
  });

  it('never renders a banned triage adjective from the deterministic template', () => {
    const BANNED = ['severe', 'serious', 'critical', 'urgent', 'life-threatening', 'dangerous'];
    const summary = buildDailySummary({
      localDate: '2026-08-16',
      patientTimeZone: 'America/Toronto',
      events: [{ ...headache, priority: 'emergency' as const }],
    });

    const lower = summary.summaryText.toLowerCase();
    for (const term of BANNED) {
      expect(lower).not.toContain(term);
    }
  });
});
