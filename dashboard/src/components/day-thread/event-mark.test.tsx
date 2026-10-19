// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EventMark } from './event-mark';
import type { PatientRecordResponse } from '@/lib/dashboard-contracts';

type ClinicalEventRow = PatientRecordResponse['events'][number];
type EventEvidence = PatientRecordResponse['evidence'][number];

const TZ = 'America/Toronto';

function clinicalEvent(overrides: Partial<ClinicalEventRow> = {}): ClinicalEventRow {
  return {
    id: 'e1',
    event_type: 'observation',
    event_code: 'symptom:headache',
    statement_text: 'Headache, 8 of 10.',
    normalized_value: null,
    occurred_at: '2026-08-11T14:05:00.000Z',
    local_date: '2026-08-11',
    local_time: '10:05',
    patient_timezone: TZ,
    severity: null,
    patient_medication_id: null,
    dose_id: null,
    agent_turn_id: null,
    source_inbound_id: null,
    supersedes_id: null,
    created_at: '2026-08-11T14:06:00.000Z',
    ...overrides,
  };
}

function evidence(overrides: Partial<EventEvidence> = {}): EventEvidence {
  return {
    clinical_event_id: 'e1',
    evidence_id: 'ev-1',
    template_id: 'ddi.pair.v1',
    source: 'ddinter',
    source_version: '2.0',
    evidence_code: 'metformin-alcohol',
    passage: 'Direct interaction evidence.',
    url: 'https://ddinter.scbdd.com/',
    language: 'en',
    coverage_state: 'direct_evidence',
    ...overrides,
  };
}

describe('EventMark — unmarked (priority: none, §4.4-a)', () => {
  it('renders the statement with no priority chip and no rail styling', () => {
    render(
      <EventMark id="e1" event={clinicalEvent()} priority="none" evidence={[]} timeZone={TZ} />,
    );

    expect(screen.getByText('Headache, 8 of 10.')).toBeInTheDocument();
    expect(
      screen.queryByText(/emergency|important|routine|needs human review/i),
    ).not.toBeInTheDocument();
  });

  it('carries no border-left rail width class', () => {
    const { container } = render(
      <EventMark id="e1" event={clinicalEvent()} priority="none" evidence={[]} timeZone={TZ} />,
    );

    expect(container.querySelector('.border-l-4')).toBeNull();
  });

  it('still shows a standalone time gutter derived from occurred_at', () => {
    render(
      <EventMark id="e1" event={clinicalEvent()} priority="none" evidence={[]} timeZone={TZ} />,
    );

    expect(screen.getByText('10:05')).toBeInTheDocument();
  });
});

describe('EventMark — marked (§4.4-b)', () => {
  it.each([
    ['emergency', /emergency/i],
    ['important', /important/i],
    ['routine', /routine/i],
    ['fallback', /needs human review/i],
  ] as const)('shows the %s tier chip (icon + word, never colour alone)', (priority, copy) => {
    render(
      <EventMark id="e1" event={clinicalEvent()} priority={priority} evidence={[]} timeZone={TZ} />,
    );

    expect(screen.getByText(copy)).toBeInTheDocument();
  });

  it('renders a 4px left rail for a marked event', () => {
    const { container } = render(
      <EventMark
        id="e1"
        event={clinicalEvent()}
        priority="emergency"
        evidence={[]}
        timeZone={TZ}
      />,
    );

    expect(container.querySelector('.border-l-4')).not.toBeNull();
  });

  it('gives routine a rail but no row tint fill', () => {
    const { container } = render(
      <EventMark id="e1" event={clinicalEvent()} priority="routine" evidence={[]} timeZone={TZ} />,
    );

    const marked = container.querySelector('.border-l-4') as HTMLElement | null;
    expect(marked).not.toBeNull();
    expect(marked?.style.backgroundColor).toBe('');
  });

  it('gives emergency a row tint fill', () => {
    const { container } = render(
      <EventMark
        id="e1"
        event={clinicalEvent()}
        priority="emergency"
        evidence={[]}
        timeZone={TZ}
      />,
    );

    const marked = container.querySelector('.border-l-4') as HTMLElement | null;
    expect(marked?.style.backgroundColor).not.toBe('');
  });

  it('renders fallback with a dashed rail, distinct from a clinical-severity solid rail', () => {
    const { container } = render(
      <EventMark id="e1" event={clinicalEvent()} priority="fallback" evidence={[]} timeZone={TZ} />,
    );

    const marked = container.querySelector('.border-l-4') as HTMLElement | null;
    expect(marked?.style.borderLeftStyle).toBe('dashed');
  });

  it('renders a mono severity chip when severity is present', () => {
    render(
      <EventMark
        id="e1"
        event={clinicalEvent({ severity: 7 })}
        priority="important"
        evidence={[]}
        timeZone={TZ}
      />,
    );

    expect(screen.getByText(/sev 7 \/ 10/i)).toBeInTheDocument();
  });

  it('shows no severity chip when severity is null', () => {
    render(
      <EventMark
        id="e1"
        event={clinicalEvent({ severity: null })}
        priority="important"
        evidence={[]}
        timeZone={TZ}
      />,
    );

    expect(screen.queryByText(/sev /i)).not.toBeInTheDocument();
  });

  it('expands evidence on demand behind a text disclosure naming the source count', () => {
    render(
      <EventMark
        id="e1"
        event={clinicalEvent()}
        priority="important"
        evidence={[evidence(), evidence({ evidence_id: 'ev-2', source: 'openfda' })]}
        timeZone={TZ}
      />,
    );

    expect(screen.getByText(/2 sources/i)).toBeInTheDocument();
    expect(screen.getByText('DDInter')).toBeInTheDocument();
    expect(screen.getByText('OpenFDA')).toBeInTheDocument();
  });

  it('renders no evidence disclosure when there is no evidence', () => {
    render(
      <EventMark
        id="e1"
        event={clinicalEvent()}
        priority="important"
        evidence={[]}
        timeZone={TZ}
      />,
    );

    expect(screen.queryByText(/sources/i)).not.toBeInTheDocument();
  });
});

describe('EventMark — text fallbacks and structure', () => {
  it('falls back to the event code when statement_text is null', () => {
    render(
      <EventMark
        id="e1"
        event={clinicalEvent({ statement_text: null, event_code: 'dose:taken' })}
        priority="routine"
        evidence={[]}
        timeZone={TZ}
      />,
    );

    expect(screen.getByText('dose:taken')).toBeInTheDocument();
  });

  it('falls back to "No text recorded" when both statement_text and event_code are null', () => {
    render(
      <EventMark
        id="e1"
        event={clinicalEvent({ statement_text: null, event_code: null })}
        priority="routine"
        evidence={[]}
        timeZone={TZ}
      />,
    );

    expect(screen.getByText(/no text recorded/i)).toBeInTheDocument();
  });

  it('renders the statement with dir="auto" for bidi-safe rendering', () => {
    render(
      <EventMark id="e1" event={clinicalEvent()} priority="routine" evidence={[]} timeZone={TZ} />,
    );

    expect(screen.getByText('Headache, 8 of 10.')).toHaveAttribute('dir', 'auto');
  });

  it('carries the jump-rail anchor id derived from the event id', () => {
    const { container } = render(
      <EventMark
        id="my-event-id"
        event={clinicalEvent()}
        priority="routine"
        evidence={[]}
        timeZone={TZ}
      />,
    );

    expect(container.querySelector('#event-my-event-id')).not.toBeNull();
  });
});

describe('EventMark — tethered rendering (no own time gutter)', () => {
  it('omits the standalone time gutter when tethered beneath a message', () => {
    render(
      <EventMark
        id="e1"
        event={clinicalEvent()}
        priority="none"
        evidence={[]}
        timeZone={TZ}
        tethered
      />,
    );

    expect(screen.queryByText('10:05')).not.toBeInTheDocument();
  });

  it('still shows the tier chip and rail when tethered and marked', () => {
    render(
      <EventMark
        id="e1"
        event={clinicalEvent()}
        priority="emergency"
        evidence={[]}
        timeZone={TZ}
        tethered
      />,
    );

    expect(screen.getByText(/emergency/i)).toBeInTheDocument();
  });
});
