// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import PatientsLoading from './loading';

describe('/patients loading', () => {
  it('uses one non-empty status announcement and no busy skeleton nodes', () => {
    const { container } = render(<PatientsLoading />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading patients/i);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-busy]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-slot="metric-skeleton"]')).toHaveLength(4);
  });
});
