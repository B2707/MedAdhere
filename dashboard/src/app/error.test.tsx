// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => (
    <div data-testid="app-shell">{children}</div>
  ),
}));

import ErrorBoundary from './error';
import GlobalError from './global-error';

const syntheticError = Object.assign(new Error('SYNTHETIC_PHI_MESSAGE'), {
  stack: 'SYNTHETIC_STACK_TRACE',
});

describe('App Router error boundaries', () => {
  it('renders a calm in-app fallback and calls reset without exposing error details', () => {
    const reset = vi.fn();
    const { container } = render(
      <ErrorBoundary error={syntheticError} reset={reset} />,
    );
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container).not.toHaveTextContent('SYNTHETIC_PHI_MESSAGE');
    expect(container).not.toHaveTextContent('SYNTHETIC_STACK_TRACE');
  });

  it('renders a root fallback with html/body and calls reset without exposing error details', () => {
    const reset = vi.fn();
    const element = GlobalError({ error: syntheticError, reset });
    expect(element.type).toBe('html');
    const body = element.props.children as ReactElement<{
      children: ReactNode;
    }>;
    expect(body.type).toBe('body');
    const { container } = render(<>{body.props.children}</>);
    expect(
      screen.getByRole('heading', { level: 1, name: /couldn.t load MedAdhere/i }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(container).not.toHaveTextContent('SYNTHETIC_PHI_MESSAGE');
    expect(container).not.toHaveTextContent('SYNTHETIC_STACK_TRACE');
  });
});
