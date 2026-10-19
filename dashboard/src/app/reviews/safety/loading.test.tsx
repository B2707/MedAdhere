// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('@/components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import SafetyReviewsLoading from './loading';

describe('/reviews/safety loading', () => {
  it('renders a labeled, accessible queue skeleton', () => {
    const { container } = render(<SafetyReviewsLoading />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading safety reviews/i);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-busy]')).toHaveLength(0);
    expect(container.querySelector('.max-w-96')).toHaveClass('w-full');
  });
});
