// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  AttributionLabel,
  COVERAGE_LABELS,
  EventMarkChip,
  EvidenceList,
  PriorityLabel,
  TIER_RAIL,
  UncertaintyLabel,
  UtcAndLocalTime,
  formatLocalClockTime,
  formatUtcAndLocal,
} from './clinical-labels';
import type { PatientRecordResponse } from '@/lib/dashboard-contracts';

type EventEvidence = PatientRecordResponse['evidence'][number];

function evidence(overrides: Partial<EventEvidence> = {}): EventEvidence {
  return {
    clinical_event_id: 'event-1',
    evidence_id: 'evidence-1',
    template_id: 'ddi.pair.v1',
    source: 'ddinter',
    source_version: '2.0',
    evidence_code: 'metformin-alcohol',
    passage: 'Concurrent use may increase the risk of lactic acidosis.',
    url: 'https://ddinter.scbdd.com/',
    language: 'en',
    coverage_state: 'direct_evidence',
    ...overrides,
  };
}

describe('formatUtcAndLocal', () => {
  it('derives the patient-local rendering from the stored UTC instant and IANA zone', () => {
    const formatted = formatUtcAndLocal('2026-08-11T14:05:00.000Z', 'America/Toronto');

    expect(formatted).not.toBeNull();
    expect(formatted?.utc).toBe('2026-08-11 14:05 UTC');
    // 14:05Z in Toronto (EDT, UTC-4) is 10:05 AM the same day.
    expect(formatted?.local).toMatch(/Aug 11, 2026/);
    expect(formatted?.local).toMatch(/10:05\s?AM/);
  });

  it('keeps the UTC instant readable when the stored timezone is unusable', () => {
    const formatted = formatUtcAndLocal('2026-08-11T14:05:00.000Z', 'Not/AZone');

    expect(formatted?.utc).toBe('2026-08-11 14:05 UTC');
    expect(formatted?.local).toBe('local time unavailable');
  });

  it('returns null for an unparseable instant rather than rendering Invalid Date', () => {
    expect(formatUtcAndLocal('not-a-timestamp', 'America/Toronto')).toBeNull();
  });
});

describe('formatLocalClockTime', () => {
  it('renders a bare 24-hour patient-local clock time for the day-thread gutter', () => {
    // 14:05Z in Toronto (EDT, UTC-4) is 10:05 local.
    expect(formatLocalClockTime('2026-08-11T14:05:00.000Z', 'America/Toronto')).toBe('10:05');
  });

  it('falls back to a placeholder rather than "Invalid Date" for an unparseable instant', () => {
    expect(formatLocalClockTime('not-a-timestamp', 'America/Toronto')).toBe('--:--');
  });

  it('falls back to a placeholder for an unusable stored timezone', () => {
    expect(formatLocalClockTime('2026-08-11T14:05:00.000Z', 'Not/AZone')).toBe('--:--');
  });
});

describe('UtcAndLocalTime', () => {
  it('shows both UTC and patient-local time and machine-readable dateTime', () => {
    render(<UtcAndLocalTime utc="2026-08-11T14:05:00.000Z" timeZone="America/Toronto" />);

    const time = screen.getByText(/UTC/).closest('time');
    expect(time).toHaveAttribute('dateTime', '2026-08-11T14:05:00.000Z');
    expect(time).toHaveTextContent('2026-08-11 14:05 UTC');
    expect(time).toHaveTextContent(/10:05\s?AM/);
    expect(time).toHaveTextContent(/local/i);
  });

  it('states the time is unavailable instead of hiding a bad instant', () => {
    render(<UtcAndLocalTime utc="broken" timeZone="America/Toronto" />);

    expect(screen.getByText(/time unavailable/i)).toBeInTheDocument();
  });
});

describe('priority and attribution labels never rely on color alone', () => {
  it.each([
    ['emergency', /emergency/i],
    ['important', /important/i],
    ['routine', /routine/i],
    ['none', /no priority recorded/i],
  ] as const)('renders %s as visible text plus a decorative icon', (priority, copy) => {
    const { container } = render(<PriorityLabel priority={priority} />);

    expect(screen.getByText(copy)).toBeInTheDocument();
    const icon = container.querySelector('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('names the fallback tier "Needs human review" rather than a clinical severity', () => {
    render(<PriorityLabel priority="fallback" />);

    const label = screen.getByText(/needs human review/i);
    expect(label).toBeInTheDocument();
    expect(label.textContent).not.toMatch(/emergency|important|routine/i);
  });

  it.each([
    ['patient_statement', /patient statement/i],
    ['doctor_confirmed', /doctor-confirmed/i],
    ['model_inference', /model inference/i],
  ] as const)('distinguishes %s with text, not hue', (attribution, copy) => {
    render(<AttributionLabel attribution={attribution} />);

    expect(screen.getByText(copy)).toBeInTheDocument();
  });

  it('labels uncertainty explicitly', () => {
    render(<UncertaintyLabel />);

    expect(screen.getByText(/uncertain/i)).toBeInTheDocument();
  });

  it('surfaces an uncertainty note alongside the label', () => {
    render(<UncertaintyLabel note="AM/PM ambiguous" />);

    expect(screen.getByText(/uncertain — AM\/PM ambiguous/i)).toBeInTheDocument();
  });
});

describe('EvidenceList', () => {
  it('names the source, version and cited code for each claim', () => {
    render(<EvidenceList evidence={[evidence({ coverage_state: 'direct_evidence' })]} />);

    expect(screen.getByText(/DDInter/i)).toBeInTheDocument();
    expect(screen.getByText('v2.0')).toHaveClass('break-all');
    expect(screen.getByText(/direct evidence/i)).toBeInTheDocument();
    expect(screen.getByText('metformin-alcohol')).toBeInTheDocument();
  });

  it('never presents missing coverage as safe', () => {
    expect(COVERAGE_LABELS.coverage_unknown).toMatch(/not found in this dataset/i);
    expect(COVERAGE_LABELS.candidate_only).toMatch(/not confirmed/i);
    for (const label of Object.values(COVERAGE_LABELS)) {
      expect(label).not.toMatch(/\bsafe\b/i);
    }
  });

  it('renders nothing when a claim carries no evidence', () => {
    const { container } = render(<EvidenceList evidence={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('TIER_RAIL — the day-thread mark anatomy (§4.4)', () => {
  it('sources every marked tier’s rail colour from a shared theme token, never a raw hex', () => {
    for (const tier of ['routine', 'important', 'emergency', 'fallback'] as const) {
      expect(TIER_RAIL[tier].rail).toMatch(/^var\(--color-/);
    }
  });

  it('gives routine no row fill — tinting routine would flood the page', () => {
    expect(TIER_RAIL.routine.fill).toBeNull();
    expect(TIER_RAIL.important.fill).not.toBeNull();
    expect(TIER_RAIL.emergency.fill).not.toBeNull();
  });

  it('marks fallback as a dashed, non-clinical-severity texture (RS1)', () => {
    expect(TIER_RAIL.fallback.dashed).toBe(true);
    expect(TIER_RAIL.emergency.dashed).toBe(false);
    expect(TIER_RAIL.important.dashed).toBe(false);
    expect(TIER_RAIL.routine.dashed).toBe(false);
  });

  it('excludes "none" — that value renders unmarked, never through TIER_RAIL', () => {
    expect(Object.keys(TIER_RAIL)).not.toContain('none');
  });
});

describe('EventMarkChip', () => {
  it('renders its content as a mono, uppercase, tabular-nums metadata chip', () => {
    render(<EventMarkChip>SEV 7 / 10</EventMarkChip>);

    const chip = screen.getByText('SEV 7 / 10');
    expect(chip).toHaveClass('uppercase', 'tabular-nums');
  });
});
