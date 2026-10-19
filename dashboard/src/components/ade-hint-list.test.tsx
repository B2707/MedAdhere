// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AdeHintList } from './ade-hint-list';

describe('AdeHintList — corrected database contract', () => {
  it('renders an info hint from the exact DB row shape without a prominence badge or undefined', () => {
    const { container } = render(
      <AdeHintList
        hints={[
          {
            matched_phrase: 'felt queasy',
            meddra_pt: 'Nausea',
            hint_level: 'info',
          },
        ]}
      />,
    );

    expect(screen.getByText(/felt queasy/i)).toBeInTheDocument();
    expect(screen.getByText(/Nausea/)).toBeInTheDocument();
    expect(screen.queryByText(/elevated label match/i)).toBeNull();
    expect(container.textContent).not.toContain('undefined');
  });

  it('gives an elevated hint a text badge and renders patient text through escaped JSX', () => {
    const { container } = render(
      <AdeHintList
        hints={[
          {
            matched_phrase: '<img src=x onerror=alert(1)>',
            meddra_pt: 'Angioedema',
            hint_level: 'elevated',
          },
        ]}
      />,
    );

    expect(screen.getByText(/elevated label match/i)).toBeInTheDocument();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).not.toContain('undefined');
  });

  it('omits malformed external rows instead of rendering a broken hint', () => {
    const { container } = render(
      <AdeHintList
        hints={[
          {
            matched_phrase: 'headache',
            meddra_pt: 'Headache',
            hint_level: 'listed',
          },
        ]}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
