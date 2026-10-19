// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { ReviewQueueNav } from './review-queue-nav';

describe('ReviewQueueNav current-page state', () => {
  it.each([
    ['/reviews/safety', /safety events/i],
    ['/reviews/unknown', /classifications and label matches/i],
  ])('marks exactly one current tab on %s', (activePath, currentName) => {
    render(<ReviewQueueNav activePath={activePath} />);
    const nav = screen.getByRole('navigation', { name: 'Review queues' });
    expect(within(nav).getAllByRole('link', { current: 'page' })).toHaveLength(1);
    expect(within(nav).getByRole('link', { name: currentName })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
