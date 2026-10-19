// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewDraft } from '@/lib/dashboard-contracts';

const { actionMock, useActionStateMock } = vi.hoisted(() => ({
  actionMock: vi.fn(),
  useActionStateMock: vi.fn(),
}));

vi.mock('./review-actions', () => ({ reviewDraftDecisionAction: actionMock }));
vi.mock('react', async () => {
  const react = await vi.importActual<typeof import('react')>('react');
  return { ...react, useActionState: useActionStateMock };
});

import { DraftReview } from './draft-review';

const PATIENT_ID = '11111111-1111-4111-8111-111111111111';
const CORRECTION_ID = '33333333-3333-4333-8333-333333333333';
const TZ = 'America/Toronto';
const HASH = 'a'.repeat(64);

function draft(overrides: Partial<ReviewDraft> & Pick<ReviewDraft, 'id'>): ReviewDraft {
  return {
    local_date: '2026-08-11',
    version: 2,
    input_hash: HASH,
    draft_text: 'Patient reports a headache after the morning dose.',
    patient_statements: [{ sourceMessageId: 'msg-1', text: 'my head hurts' }],
    confirmed_facts: ['fact-1'],
    model_inferences: ['Headache may be dose-related.'],
    uncertainties: ['Dose time was not stated.'],
    evidence_references: ['ddinter:metformin-alcohol'],
    proposed_corrections: [
      {
        correctionId: CORRECTION_ID,
        factId: null,
        proposedText: 'Add: recurring morning headaches',
        rationale: 'Reported on three separate days.',
        sourceMessageIds: ['msg-1'],
      },
    ],
    source_agent_turn_id: null,
    supersedes_id: null,
    created_at: '2026-08-11T14:05:00.000Z',
    is_latest: true,
    latest_action: null,
    ...overrides,
  };
}

function renderReview(drafts: ReviewDraft[]) {
  return render(<DraftReview patientId={PATIENT_ID} drafts={drafts} timeZone={TZ} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useActionStateMock.mockReturnValue([{}, vi.fn(), false]);
});

describe('DraftReview — attribution and uncertainty', () => {
  it('labels each item by how it came to be known', () => {
    renderReview([draft({ id: 'd1' })]);

    expect(screen.getByText(/patient statement/i)).toBeInTheDocument();
    expect(screen.getByText(/^doctor-confirmed fact$/i)).toBeInTheDocument();
    expect(screen.getByText(/model inference/i)).toBeInTheDocument();
  });

  it('marks every recorded uncertainty explicitly', () => {
    renderReview([draft({ id: 'd1' })]);

    expect(screen.getByText(/uncertain — dose time was not stated/i)).toBeInTheDocument();
  });

  it('shows the drafted text, the patient words behind it and the cited evidence', () => {
    renderReview([draft({ id: 'd1' })]);

    expect(
      screen.getByText('Patient reports a headache after the morning dose.'),
    ).toBeInTheDocument();
    expect(screen.getByText('my head hurts')).toBeInTheDocument();
    expect(screen.getByText('Headache may be dose-related.')).toBeInTheDocument();
    expect(screen.getByText('ddinter:metformin-alcohol')).toHaveClass('break-all');
    expect(
      screen.getByRole('heading', { name: /doctor-confirmed fact identifiers/i }),
    ).toBeInTheDocument();
  });

  it('omits a bucket the draft left empty instead of showing an empty heading', () => {
    renderReview([draft({ id: 'd1', model_inferences: [], uncertainties: [] })]);

    expect(screen.queryByText(/model inference/i)).toBeNull();
    expect(screen.queryByText(/uncertain/i)).toBeNull();
  });
});

describe('DraftReview — the decision form', () => {
  it('carries the draft version so the server can refuse a stale decision', () => {
    const { container } = renderReview([draft({ id: 'd1', version: 4 })]);

    const expectedVersion = container.querySelector('input[name="expectedVersion"]');
    expect(expectedVersion).toHaveAttribute('value', '4');
  });

  it('offers each proposed correction as an explicitly selectable checkbox', () => {
    renderReview([draft({ id: 'd1' })]);

    const checkbox = screen.getByRole('checkbox', { name: /recurring morning headaches/i });
    expect(checkbox).toHaveAttribute('name', 'correctionId');
    expect(checkbox).toHaveAttribute('value', CORRECTION_ID);
    expect(checkbox).not.toBeChecked();
    expect(checkbox.closest('label')).toHaveClass('min-h-11');
    expect(screen.getByText(/reported on three separate days/i)).toBeInTheDocument();
  });

  it('replaces the controls with a focused polite status after a recorded decision', () => {
    useActionStateMock.mockReturnValue([{ confirmed: true }, vi.fn(), false]);
    renderReview([draft({ id: 'd1' })]);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/decision recorded/i);
    expect(status).toHaveFocus();
    expect(screen.queryByRole('button', { name: /^confirm/i })).toBeNull();
  });

  it('submits the decision as the button value so confirm and reject share one form', () => {
    renderReview([draft({ id: 'd1' })]);

    expect(screen.getByRole('button', { name: /^confirm/i })).toHaveAttribute('value', 'confirm');
    expect(screen.getByRole('button', { name: /^reject/i })).toHaveAttribute('value', 'reject');
  });

  it('binds the action to this patient and this draft', () => {
    renderReview([draft({ id: 'd1' })]);

    expect(actionMock.bind).toBeDefined();
    expect(useActionStateMock).toHaveBeenCalled();
  });

  it('says a rejection records the decision without applying any correction', () => {
    renderReview([draft({ id: 'd1' })]);

    expect(screen.getByText(/a rejection records your decision/i)).toBeInTheDocument();
  });
});

describe('DraftReview — stale and reviewed drafts', () => {
  it('refuses a superseded draft in place and tells the doctor to reload', () => {
    renderReview([draft({ id: 'd1', is_latest: false })]);

    const notice = screen.getByRole('alert');
    expect(notice).toHaveTextContent(/replaced by a newer version/i);
    expect(notice).toHaveTextContent(/reload/i);
    expect(screen.queryByRole('button', { name: /^confirm/i })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('shows the recorded decision instead of controls once a draft is reviewed', () => {
    renderReview([
      draft({
        id: 'd1',
        latest_action: {
          id: 'action-1',
          decision: 'confirm',
          expected_version: 2,
          selected_correction_ids: [CORRECTION_ID],
          created_at: '2026-08-11T15:00:00.000Z',
        },
      }),
    ]);

    expect(screen.getByText(/you confirmed this draft/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^confirm/i })).toBeNull();
  });

  it('names a recorded rejection as a rejection', () => {
    renderReview([
      draft({
        id: 'd1',
        latest_action: {
          id: 'action-1',
          decision: 'reject',
          expected_version: 2,
          selected_correction_ids: [],
          created_at: '2026-08-11T15:00:00.000Z',
        },
      }),
    ]);

    expect(screen.getByText(/you rejected this draft/i)).toBeInTheDocument();
  });

  it('surfaces a server conflict as a reload instruction, not a retry invitation', () => {
    useActionStateMock.mockReturnValue([
      { conflict: true, error: 'This draft was updated while you were reading it. Reload.' },
      vi.fn(),
      false,
    ]);
    renderReview([draft({ id: 'd1' })]);

    const notice = screen.getByRole('alert');
    expect(notice).toHaveTextContent(/reload/i);
    expect(notice.textContent).not.toMatch(/try again/i);
  });

  it('surfaces an ordinary failure without leaking internals', () => {
    useActionStateMock.mockReturnValue([{ error: 'Something went wrong.' }, vi.fn(), false]);
    renderReview([draft({ id: 'd1' })]);

    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong.');
  });
});

describe('DraftReview — ordering and empty state', () => {
  it('lists the most recent draft first', () => {
    renderReview([
      draft({ id: 'older', local_date: '2026-08-09', created_at: '2026-08-09T14:05:00.000Z' }),
      draft({ id: 'newer', local_date: '2026-08-11', created_at: '2026-08-11T14:05:00.000Z' }),
    ]);

    const articles = screen.getAllByRole('article');
    expect(within(articles[0]!).getByRole('heading', { level: 3 })).toHaveTextContent('2026-08-11');
    expect(within(articles[1]!).getByRole('heading', { level: 3 })).toHaveTextContent('2026-08-09');
  });

  it('shows an empty state when nothing is waiting for review', () => {
    renderReview([]);

    expect(screen.getByText(/no drafts to review/i)).toBeInTheDocument();
  });
});
