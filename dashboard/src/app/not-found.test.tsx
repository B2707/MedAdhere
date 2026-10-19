// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/components/app-shell', () => ({
  AppShell: ({ children, pageTitle }: { children: ReactNode; pageTitle: string }) => (
    <div data-testid="app-shell" data-page-title={pageTitle}>
      {children}
    </div>
  ),
}));

import RootNotFound from './not-found';

describe('root not-found boundary', () => {
  it('renders the calm card inside AppShell with a route back to patients', () => {
    render(<RootNotFound />);
    expect(screen.getByTestId('app-shell')).toHaveAttribute('data-page-title', 'Page not found');
    expect(screen.getByRole('heading', { name: /page not found/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to patients/i })).toHaveAttribute(
      'href',
      '/patients',
    );
  });
});
