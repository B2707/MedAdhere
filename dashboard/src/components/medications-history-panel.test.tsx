// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MedicationsHistoryPanel } from './medications-history-panel';
import type { PatientRecordResponse } from '@/lib/dashboard-contracts';

type ClinicalHistory = PatientRecordResponse['history'];
type Medication = ClinicalHistory['medications'][number];
type Fact = ClinicalHistory['facts'][number];

function medication(
  overrides: Partial<Medication> & Pick<Medication, 'id' | 'enteredName' | 'status'>,
): Medication {
  return {
    identity: { system: 'din', code: '02245678' },
    doseText: '500 mg twice daily',
    form: 'tablet',
    route: 'oral',
    validFrom: '2026-06-01',
    validTo: null,
    supersedesId: null,
    ingredients: [{ name: 'metformin', ccddIngredientCode: null, rxcui: '6809' }],
    ...overrides,
  };
}

function fact(
  overrides: Partial<Fact> & Pick<Fact, 'id' | 'factType' | 'statementText' | 'status'>,
): Fact {
  return {
    factCode: null,
    supersedesId: null,
    ...overrides,
  };
}

function renderPanel(history: Partial<ClinicalHistory> = {}) {
  return render(<MedicationsHistoryPanel history={{ medications: [], facts: [], ...history }} />);
}

describe('MedicationsHistoryPanel — medications', () => {
  it('shows the medication name, dose, form, route and start date', () => {
    renderPanel({
      medications: [medication({ id: 'm1', enteredName: 'Metformin', status: 'active' })],
    });

    expect(screen.getByText('Metformin')).toBeInTheDocument();
    expect(screen.getByText(/500 mg twice daily/)).toBeInTheDocument();
    expect(screen.getByText(/tablet/)).toBeInTheDocument();
    expect(screen.getByText(/oral/)).toBeInTheDocument();
    expect(screen.getByText(/2026-06-01/)).toBeInTheDocument();
  });

  it('names the coded identity and every ingredient behind a medication', () => {
    renderPanel({
      medications: [medication({ id: 'm1', enteredName: 'Metformin', status: 'active' })],
    });

    expect(screen.getByText(/DIN 02245678/i)).toBeInTheDocument();
    expect(screen.getByText(/metformin/)).toBeInTheDocument();
  });

  it('states plainly when a medication was never coded to a source', () => {
    renderPanel({
      medications: [
        medication({ id: 'm1', enteredName: 'Herbal tea', status: 'active', identity: null }),
      ],
    });

    expect(screen.getByText(/not coded to a source/i)).toBeInTheDocument();
  });

  it('keeps superseded medications visible and labelled instead of hiding them', () => {
    renderPanel({
      medications: [
        medication({
          id: 'old',
          enteredName: 'Metformin 250 mg',
          status: 'corrected',
          validTo: '2026-07-01',
        }),
        medication({ id: 'new', enteredName: 'Metformin 500 mg', status: 'active' }),
      ],
    });

    expect(screen.getByText('Metformin 250 mg')).toBeInTheDocument();
    expect(screen.getByText(/superseded by a correction/i)).toBeInTheDocument();
  });

  it('orders active medications above stopped and superseded ones', () => {
    renderPanel({
      medications: [
        medication({ id: 'c', enteredName: 'Corrected med', status: 'corrected' }),
        medication({ id: 's', enteredName: 'Stopped med', status: 'stopped' }),
        medication({ id: 'a', enteredName: 'Active med', status: 'active' }),
      ],
    });

    const rendered = screen.getAllByRole('listitem').map((node) => node.textContent ?? '');
    const activeIndex = rendered.findIndex((text) => text.includes('Active med'));
    const stoppedIndex = rendered.findIndex((text) => text.includes('Stopped med'));
    const correctedIndex = rendered.findIndex((text) => text.includes('Corrected med'));

    expect(activeIndex).toBeLessThan(stoppedIndex);
    expect(stoppedIndex).toBeLessThan(correctedIndex);
  });

  it('collapses by default when empty and expands when the record has entries', () => {
    const empty = renderPanel();
    expect(empty.container.querySelector('details')).not.toHaveAttribute('open');
    expect(screen.getByText('No data yet')).toBeInTheDocument();
    empty.unmount();

    const withData = renderPanel({
      medications: [medication({ id: 'm1', enteredName: 'Metformin', status: 'active' })],
    });
    expect(withData.container.querySelector('details')).toHaveAttribute('open');
    expect(screen.getByText(/1 medication · 0 history entries/i)).toBeInTheDocument();
  });

  it('shows an empty state when the doctor has recorded no medication', () => {
    renderPanel();

    expect(screen.getByText(/no medication recorded/i)).toBeInTheDocument();
  });

  it('wraps an unbroken medication name instead of overflowing a narrow card', () => {
    const enteredName = 'm'.repeat(320);
    renderPanel({
      medications: [medication({ id: 'm1', enteredName, status: 'active' })],
    });

    expect(screen.getByText(enteredName)).toHaveClass('min-w-0', 'break-words');
  });
});

describe('MedicationsHistoryPanel — clinical history', () => {
  it('puts allergies above conditions and notes', () => {
    renderPanel({
      facts: [
        fact({
          id: 'n1',
          factType: 'note',
          statementText: 'Prefers morning doses',
          status: 'current',
        }),
        fact({
          id: 'c1',
          factType: 'condition',
          statementText: 'Type 2 diabetes',
          status: 'current',
        }),
        fact({ id: 'a1', factType: 'allergy', statementText: 'Penicillin', status: 'current' }),
      ],
    });

    const rendered = screen.getAllByRole('listitem').map((node) => node.textContent ?? '');
    const allergyIndex = rendered.findIndex((text) => text.includes('Penicillin'));
    const conditionIndex = rendered.findIndex((text) => text.includes('Type 2 diabetes'));
    const noteIndex = rendered.findIndex((text) => text.includes('Prefers morning doses'));

    expect(allergyIndex).toBeGreaterThanOrEqual(0);
    expect(allergyIndex).toBeLessThan(conditionIndex);
    expect(conditionIndex).toBeLessThan(noteIndex);
  });

  it('keeps corrected and retracted facts visible and labelled', () => {
    renderPanel({
      facts: [
        fact({
          id: 'f1',
          factType: 'condition',
          statementText: 'Prediabetes',
          status: 'corrected',
        }),
        fact({ id: 'f2', factType: 'allergy', statementText: 'Sulfa drugs', status: 'retracted' }),
      ],
    });

    expect(screen.getByText('Prediabetes')).toBeInTheDocument();
    expect(screen.getByText('Sulfa drugs')).toBeInTheDocument();
    expect(screen.getByText(/superseded by a correction/i)).toBeInTheDocument();
    expect(screen.getByText(/retracted/i)).toBeInTheDocument();
  });

  it('omits a history group that has no entries rather than showing an empty heading', () => {
    renderPanel({
      facts: [
        fact({ id: 'a1', factType: 'allergy', statementText: 'Penicillin', status: 'current' }),
      ],
    });

    expect(screen.getByRole('heading', { name: /allergies/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /conditions/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: /^notes$/i })).toBeNull();
  });

  it('shows an empty state when the doctor has recorded no history', () => {
    renderPanel();

    expect(screen.getByText(/no clinical history recorded/i)).toBeInTheDocument();
  });

  it('says the doctor owns this record and the agent cannot change it', () => {
    renderPanel();

    expect(screen.getByText(/only you can add or change/i)).toBeInTheDocument();
  });
});
