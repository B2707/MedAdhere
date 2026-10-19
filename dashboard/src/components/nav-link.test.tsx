// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pathnameState } = vi.hoisted(() => ({
  pathnameState: { value: '/patients' },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameState.value,
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { NavLink } from './nav-link';

describe('NavLink aria-current semantics', () => {
  beforeEach(() => {
    pathnameState.value = '/patients';
  });

  it('marks an exact route with aria-current=page', () => {
    render(<NavLink href="/patients" label="Patients" icon={<span />} />);
    expect(screen.getByRole('link', { name: 'Patients' })).toHaveAttribute('aria-current', 'page');
  });

  it('marks a prefix route with aria-current=true', () => {
    pathnameState.value = '/reviews/unknown';
    render(
      <NavLink href="/reviews/safety" label="Reviews" icon={<span />} matchPrefix="/reviews" />,
    );
    expect(screen.getByRole('link', { name: 'Reviews' })).toHaveAttribute('aria-current', 'true');
  });

  it('omits aria-current from an inactive route', () => {
    render(<NavLink href="/reviews/safety" label="Reviews" icon={<span />} />);
    expect(screen.getByRole('link', { name: 'Reviews' })).not.toHaveAttribute('aria-current');
  });

  it('can exclude an exact route while matching its detail routes', () => {
    const { rerender } = render(
      <NavLink
        href="/patients#patient-roster-search"
        label="Patients"
        icon={<span />}
        matchPrefix="/patients"
        excludePaths={['/patients']}
      />,
    );
    expect(screen.getByRole('link', { name: 'Patients' })).not.toHaveAttribute('aria-current');

    pathnameState.value = '/patients/patient-1';
    rerender(
      <NavLink
        href="/patients#patient-roster-search"
        label="Patients"
        icon={<span />}
        matchPrefix="/patients"
        excludePaths={['/patients']}
      />,
    );
    expect(screen.getByRole('link', { name: 'Patients' })).toHaveAttribute('aria-current', 'true');
  });
});
