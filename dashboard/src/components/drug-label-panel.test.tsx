// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  DRUG_PROFILE_SOURCE,
  drugProfileSchema,
  type DrugProfileData,
} from '../../../packages/shared/src/drug-profile';
import {
  FDA_DISCLAIMER_RETRIEVED_DATE,
  FDA_DISCLAIMER_SOURCE,
  FDA_LABEL_DISCLAIMER,
} from '../../../packages/shared/src/fda-disclaimer';
import { DrugLabelPanel } from './drug-label-panel';

const resolvedRaw = {
  label_features_enabled: true as const,
  rxcui: '11289',
  resolved_from_rxcui: '855332',
  multi_ingredient: false,
  ingredient_rxcuis: ['11289'],
  boxed_warning_present: true,
  boxed_warning: ['Serious boxed warning'],
  warnings_and_cautions: ['Warning line 1\nWarning line 2'],
  adverse_reactions: ['Nausea'],
  dpd: { din: '02456789', atc: 'B01AA03' },
  source: DRUG_PROFILE_SOURCE.FDA_LABEL,
  multi_ingredient_limitation: null,
};

function parseProfile(raw: unknown = resolvedRaw): DrugProfileData {
  return drugProfileSchema.parse(raw);
}

describe('DrugLabelPanel — DRUG-04 three-state boxed-warning badge', () => {
  it('renders the present state, warning excerpt, DIN/ATC, and FDA provenance', () => {
    render(
      <DrugLabelPanel
        medicationName="Warfarin"
        profile={parseProfile()}
        fetchedAt="2026-07-17T10:00:00.000Z"
      />,
    );
    expect(screen.getByText(/boxed warning present/i)).toHaveClass(
      'bg-[var(--color-danger-50)]',
      'text-[var(--color-danger-700)]',
    );
    expect(screen.getByText(/warning line 1/i)).toBeInTheDocument();
    expect(screen.getByText('02456789')).toBeInTheDocument();
    expect(screen.getByText('B01AA03')).toBeInTheDocument();
    expect(screen.getByText(/US FDA label, fetched 2026-07-17 UTC/i)).toBeInTheDocument();
  });

  it('renders absent-because-checked only for an FDA-label-backed profile', () => {
    render(
      <DrugLabelPanel
        medicationName="Metformin"
        profile={parseProfile({
          ...resolvedRaw,
          boxed_warning_present: false,
          boxed_warning: null,
        })}
        fetchedAt="2026-07-17T10:00:00.000Z"
      />,
    );
    expect(screen.getByText(/boxed warning not present on checked FDA label/i)).toHaveClass(
      'border-[var(--color-border)]',
      'text-[var(--color-ink)]',
    );
    expect(screen.queryByText(/unknown — no FDA label/i)).toBeNull();
  });

  it('renders unknown — no FDA label for the ingredient-only source, never false reassurance', () => {
    render(
      <DrugLabelPanel
        medicationName="Example drug"
        profile={parseProfile({
          ...resolvedRaw,
          source: DRUG_PROFILE_SOURCE.INGREDIENT_ONLY,
          boxed_warning_present: false,
          boxed_warning: null,
          warnings_and_cautions: null,
          adverse_reactions: null,
        })}
        fetchedAt="2026-07-17T10:00:00.000Z"
      />,
    );
    expect(screen.getByText(/unknown — no FDA label/i)).toHaveClass(
      'bg-[var(--color-canvas-raised)]',
      'text-[var(--color-ink)]',
    );
    expect(screen.queryByText(/not present on checked FDA label/i)).toBeNull();
  });

  it('renders the unresolved/unavailable state without throwing', () => {
    render(
      <DrugLabelPanel
        medicationName="Unknown drug"
        profile={parseProfile({
          label_features_enabled: false,
          reason: 'unresolved',
          rxcui: null,
          resolved_from_rxcui: null,
        })}
        fetchedAt={null}
      />,
    );
    expect(screen.getByText(/drug label unavailable/i)).toBeInTheDocument();
  });
});

describe('DrugLabelPanel — safe text, null handling, and pinned disclaimer', () => {
  it('keeps the boxed-warning badge and sibling profile fields when one warning member is malformed', () => {
    render(
      <DrugLabelPanel
        medicationName="Warfarin"
        profile={parseProfile({
          ...resolvedRaw,
          warnings_and_cautions: [{ text: 'malformed member' }],
        })}
        fetchedAt="2026-07-17T10:00:00.000Z"
      />,
    );
    expect(screen.getByText(/boxed warning present/i)).toBeInTheDocument();
    expect(screen.getByText('02456789')).toBeInTheDocument();
    expect(screen.getByText('B01AA03')).toBeInTheDocument();
  });

  it('keeps boxed warnings and warnings-and-precautions in separately labeled sections', () => {
    render(
      <DrugLabelPanel
        medicationName="Warfarin"
        profile={parseProfile()}
        fetchedAt="2026-07-17T10:00:00.000Z"
      />,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Boxed warning' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: 'Warnings and precautions' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Serious boxed warning')).toBeInTheDocument();
    expect(screen.getByText(/warning line 1/i)).toBeInTheDocument();
  });

  it('does not imply a boxed-warning excerpt when only warnings-and-precautions exist', () => {
    render(
      <DrugLabelPanel
        medicationName="Metformin"
        profile={parseProfile({
          ...resolvedRaw,
          boxed_warning_present: false,
          boxed_warning: null,
        })}
        fetchedAt="2026-07-17T10:00:00.000Z"
      />,
    );
    expect(screen.queryByRole('heading', { level: 3, name: 'Boxed warning' })).toBeNull();
    expect(
      screen.getByRole('heading', { level: 3, name: 'Warnings and precautions' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/warning line 1/i)).toBeInTheDocument();
  });

  it('renders null DIN/ATC and empty normalized arrays without undefined', () => {
    const { container } = render(
      <DrugLabelPanel
        medicationName="Example drug"
        profile={parseProfile({
          ...resolvedRaw,
          boxed_warning_present: false,
          boxed_warning: null,
          warnings_and_cautions: null,
          adverse_reactions: null,
          dpd: { din: null, atc: null },
        })}
        fetchedAt={null}
      />,
    );
    expect(screen.getAllByText('Not available')).toHaveLength(2);
    expect(container.textContent).not.toContain('undefined');
  });

  it('renders warning text through escaped JSX with whitespace-pre-line and no HTML injection', () => {
    const warning = '<img src=x onerror=alert(1)>\nSecond line';
    const boxedWarning = '<script>alert(2)</script>\nBoxed second line';
    const { container } = render(
      <DrugLabelPanel
        medicationName="Example drug"
        profile={parseProfile({
          ...resolvedRaw,
          boxed_warning: [boxedWarning],
          warnings_and_cautions: [warning],
        })}
        fetchedAt="2026-07-17T10:00:00.000Z"
      />,
    );
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toHaveClass('whitespace-pre-line');
    expect(screen.getByText(/<script>alert\(2\)<\/script>/)).toHaveClass('whitespace-pre-line');
    expect(container.querySelector('img, script')).toBeNull();
  });

  it('renders the exact shared disclaimer with its current source and retrieval date', () => {
    render(
      <DrugLabelPanel
        medicationName="Warfarin"
        profile={parseProfile()}
        fetchedAt="2026-07-17T10:00:00.000Z"
      />,
    );
    expect(screen.getByText(FDA_LABEL_DISCLAIMER)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /openFDA drug label API/i })).toHaveAttribute(
      'href',
      FDA_DISCLAIMER_SOURCE,
    );
    expect(screen.getByText(new RegExp(FDA_DISCLAIMER_RETRIEVED_DATE))).toBeInTheDocument();
  });
});
