// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/components/nav-link', () => ({
  NavLink: ({ href, label }: { href: string; label: string; icon: ReactNode }) => (
    <a href={href}>{label}</a>
  ),
}));

import PatientDetailLoading from './loading';
import PatientNotFound from './not-found';

describe('/patients/[id] route states', () => {
  it('renders an accessible loading region', () => {
    const { container } = render(<PatientDetailLoading />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading patient detail/i);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-busy]')).toHaveLength(0);
  });

  it('renders the not-found arm with a route back to the patient list', () => {
    render(<PatientNotFound />);
    expect(
      screen.getByRole('heading', { level: 2, name: /patient not found/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to patients/i })).toHaveAttribute(
      'href',
      '/patients',
    );
  });
});
