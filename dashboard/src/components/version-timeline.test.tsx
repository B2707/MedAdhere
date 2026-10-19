// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VersionTimeline } from './version-timeline';
import type { PatientRecordResponse } from '@/lib/dashboard-contracts';

type RecordVersion = PatientRecordResponse['versions'][number];

const TZ = 'America/Toronto';

function version(
  overrides: Partial<RecordVersion> & Pick<RecordVersion, 'id' | 'record_kind'>,
): RecordVersion {
  return {
    version: 1,
    supersedes_id: null,
    created_at: '2026-08-11T14:05:00.000Z',
    ...overrides,
  };
}

function renderTimeline(versions: RecordVersion[]) {
  return render(<VersionTimeline versions={versions} timeZone={TZ} />);
}

describe('VersionTimeline', () => {
  it('lists the most recent revision first', () => {
    renderTimeline([
      version({
        id: 'older',
        record_kind: 'daily_summary',
        created_at: '2026-08-10T14:05:00.000Z',
      }),
      version({
        id: 'newer',
        record_kind: 'clinical_fact',
        created_at: '2026-08-11T14:05:00.000Z',
      }),
    ]);

    const rendered = screen.getAllByRole('listitem').map((node) => node.textContent ?? '');
    expect(rendered[0]).toContain('Clinical fact');
    expect(rendered[1]).toContain('Day summary');
  });

  it.each([
    ['daily_summary', 'Day summary'],
    ['clinician_review_draft', 'Review draft'],
    ['clinical_event', 'Recorded event'],
    ['clinical_fact', 'Clinical fact'],
    ['patient_medication', 'Medication'],
  ] as const)('names the %s record kind in plain words', (kind, label) => {
    renderTimeline([version({ id: 'r1', record_kind: kind })]);

    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('marks a revision that replaces an earlier one without hiding the earlier one', () => {
    renderTimeline([
      version({ id: 'v2', record_kind: 'clinical_event', version: 2, supersedes_id: 'v1' }),
      version({ id: 'v1', record_kind: 'clinical_event', version: 1 }),
    ]);

    expect(screen.getByText(/replaces an earlier version/i)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows the predecessor identifier so the append-only chain is traceable', () => {
    renderTimeline([
      version({
        id: 'current-record',
        record_kind: 'clinical_event',
        version: 2,
        supersedes_id: 'predecessor-record',
      }),
    ]);

    expect(screen.getByText('predecessor-record')).toBeInTheDocument();
  });

  it('shows the version number and both timestamps for each revision', () => {
    renderTimeline([version({ id: 'r1', record_kind: 'daily_summary', version: 3 })]);

    expect(screen.getByText(/version 3/i)).toBeInTheDocument();
    expect(screen.getByText(/2026-08-11 14:05 UTC/)).toBeInTheDocument();
    expect(screen.getByText(/10:05\s?AM/)).toBeInTheDocument();
  });

  it('reports an unnumbered revision honestly instead of inventing a version', () => {
    renderTimeline([version({ id: 'r1', record_kind: 'clinical_event', version: null })]);

    expect(screen.getByText(/version not recorded/i)).toBeInTheDocument();
  });

  it('shows the record identifier so a revision can be traced', () => {
    renderTimeline([version({ id: 'trace-me', record_kind: 'clinical_fact' })]);

    expect(screen.getByText('trace-me')).toBeInTheDocument();
  });

  it('collapses by default when empty and expands when revisions exist', () => {
    const empty = renderTimeline([]);
    expect(empty.container.querySelector('details')).not.toHaveAttribute('open');
    expect(screen.getByText('No data yet')).toBeInTheDocument();
    empty.unmount();

    const withData = renderTimeline([version({ id: 'one', record_kind: 'daily_summary' })]);
    expect(withData.container.querySelector('details')).toHaveAttribute('open');
    expect(screen.getByText('1 revision')).toBeInTheDocument();
  });

  it('shows an empty state when nothing has been revised yet', () => {
    renderTimeline([]);

    expect(screen.getByText(/no revisions yet/i)).toBeInTheDocument();
  });
});
