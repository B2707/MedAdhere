// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('@/components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import UnknownReviewsLoading from './loading';

describe('/reviews/unknown loading', () => {
  it('renders a labeled, accessible queue skeleton', () => {
    const { container } = render(<UnknownReviewsLoading />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading classification reviews/i);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-busy]')).toHaveLength(0);
  });

  it('keeps the heading skeleton within the mobile content width', () => {
    const { container } = render(<UnknownReviewsLoading />);
    const headingSkeleton = container.querySelector('.animate-pulse');

    expect(headingSkeleton).toHaveClass('w-full', 'max-w-96');
    expect(headingSkeleton).not.toHaveClass('w-96');
  });
});
