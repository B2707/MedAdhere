// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DaySummarySection } from './day-summary-section';
import type { PatientRecordResponse } from '@/lib/dashboard-contracts';

type DaySummary = NonNullable<PatientRecordResponse['daySummary']>;
type EventEvidence = PatientRecordResponse['evidence'][number];

function summary(overrides: Partial<DaySummary> = {}, truncated = false): DaySummary {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    local_date: '2026-08-11',
    version: 3,
    input_hash: 'a'.repeat(64),
    event_count: 2,
    highest_tier: 'important',
    summary_text: 'One emergency, one important item, and one routine observation.',
    window_start: '2026-08-11T04:00:00.000Z',
    window_end: '2026-08-12T04:00:00.000Z',
    structured_payload: {
      localDate: '2026-08-11',
      patientTimeZone: 'America/Toronto',
      eventCount: 2,
      detailedEventCount: 2,
      truncated,
      eventIds: ['e1', 'e2'],
      events: [],
      symptomCount: 1,
      adherenceCounts: { taken: 1, delayed: 0, skipped: 0, stopped: 0, unknown: 0, question: 0 },
      highestPriority: 'important',
    },
    supersedes_id: null,
    created_at: '2026-08-12T04:00:01.000Z',
    ...overrides,
  };
}

function evidenceFor(eventId: string): EventEvidence {
  return {
    clinical_event_id: eventId,
    evidence_id: `ev-${eventId}`,
    template_id: 'ddi.pair.v1',
    source: 'ddinter',
    source_version: '2.0',
    evidence_code: 'metformin-alcohol',
    passage: 'Direct interaction evidence.',
    url: 'https://ddinter.scbdd.com/',
    language: 'en',
    coverage_state: 'direct_evidence',
  };
}

describe('DaySummarySection — prose lede only (R1/R14)', () => {
  it('renders the section title and the summary prose', () => {
    render(<DaySummarySection summary={summary()} evidence={[]} />);

    expect(
      screen.getByRole('heading', { level: 2, name: /what happened today/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(summary().summary_text)).toBeInTheDocument();
  });

  it('shows the agent-generated meta line with the version', () => {
    render(<DaySummarySection summary={summary({ version: 3 })} evidence={[]} />);

    expect(screen.getByText(/agent-generated/i)).toBeInTheDocument();
    expect(screen.getByText(/v3/)).toBeInTheDocument();
  });

  it('renders no per-event list or the old escalated/routine split (R1)', () => {
    render(<DaySummarySection summary={summary()} evidence={[]} />);

    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByText(/needs review first/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/routine record/i)).not.toBeInTheDocument();
  });

  it('shows a bounded-subset warning only when the payload is truncated', () => {
    render(<DaySummarySection summary={summary({}, true)} evidence={[]} />);

    expect(screen.getByText(/bounded subset — read full log/i)).toBeInTheDocument();
  });

  it('shows no truncation warning when the payload is not truncated', () => {
    render(<DaySummarySection summary={summary({}, false)} evidence={[]} />);

    expect(screen.queryByText(/bounded subset/i)).not.toBeInTheDocument();
  });

  it('states incomplete evidence coverage without implying an all-clear', () => {
    render(<DaySummarySection summary={summary()} evidence={[]} />);

    expect(screen.getByText(/coverage for this day is unknown/i)).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/this is not an all-clear/i);
  });

  it('marks coverage partial when only some cited events have evidence', () => {
    render(<DaySummarySection summary={summary()} evidence={[evidenceFor('e1')]} />);

    expect(
      screen.getByText(/some evidence for this day could not be retrieved/i),
    ).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/this is not an all-clear/i);
  });

  it('shows no coverage note when every cited event has evidence', () => {
    render(
      <DaySummarySection summary={summary()} evidence={[evidenceFor('e1'), evidenceFor('e2')]} />,
    );

    expect(screen.queryByText(/all-clear/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/coverage/i)).not.toBeInTheDocument();
  });

  it('renders a calm empty state naming the full log when there is no summary yet', () => {
    render(<DaySummarySection summary={null} evidence={[]} />);

    const region = within(
      screen.getByRole('heading', { level: 2 }).closest('section') as HTMLElement,
    );
    expect(region.getByText(/no agent summary for this day/i)).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/full log is below/i);
  });
});
