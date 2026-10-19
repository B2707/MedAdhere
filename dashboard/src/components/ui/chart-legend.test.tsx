// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChartLegend } from './chart-legend';

describe('ChartLegend — C7 the one legend primitive', () => {
  it('renders a swatch, name, and count for every series as non-interactive text when there is no toggle', () => {
    render(
      <ChartLegend
        ariaLabel="Dose outcome legend"
        items={[
          {
            key: 'taken',
            label: 'confirmed — taken/late',
            color: 'var(--color-success-700)',
            count: 4,
          },
          {
            key: 'skipped',
            label: 'confirmed — not taken',
            color: 'var(--color-danger-700)',
            count: 1,
          },
        ]}
      />,
    );

    const legend = screen.getByRole('list', { name: /dose outcome legend/i });
    expect(within(legend).getByText('confirmed — taken/late')).toBeInTheDocument();
    expect(within(legend).getByText('4')).toBeInTheDocument();
    expect(within(legend).queryByRole('button')).toBeNull();
  });

  it('renders each series as an aria-pressed toggle button when onToggle is supplied', () => {
    const onToggle = vi.fn();
    render(
      <ChartLegend
        ariaLabel="Symptom series"
        onToggle={onToggle}
        hiddenKeys={new Set(['nausea'])}
        items={[
          {
            key: 'nausea',
            label: 'nausea',
            color: 'var(--color-accent)',
            shape: 'line',
            dashArray: '4 2',
          },
          { key: 'fatigue', label: 'fatigue', color: 'var(--color-info-700)', shape: 'line' },
        ]}
      />,
    );

    const nauseaButton = screen.getByRole('button', { name: /nausea/i });
    expect(nauseaButton).toHaveAttribute('aria-pressed', 'false');
    const fatigueButton = screen.getByRole('button', { name: /fatigue/i });
    expect(fatigueButton).toHaveAttribute('aria-pressed', 'true');

    fatigueButton.click();
    expect(onToggle).toHaveBeenCalledWith('fatigue');
  });

  it('draws a dashed stroke preview for a line series so a repeated colour still disambiguates (A11)', () => {
    render(
      <ChartLegend
        ariaLabel="Symptom series"
        items={[
          { key: 'a', label: 'a', color: 'var(--color-accent)', shape: 'line', dashArray: '6 3' },
        ]}
      />,
    );
    const line = document.querySelector('svg line');
    expect(line).toHaveAttribute('stroke-dasharray', '6 3');
  });
});
