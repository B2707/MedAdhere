// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { AutoRefresh } from './auto-refresh';

describe('AutoRefresh — session-expiry storm guard (SIGNIN-DIAGNOSIS.md §3 Slice D)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refresh.mockClear();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls on an interval while authenticated', () => {
    render(<AutoRefresh intervalMs={10_000} />);
    vi.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('never starts polling once the page renders the signed-out state', () => {
    render(<AutoRefresh intervalMs={10_000} isAuthenticated={false} />);
    vi.advanceTimersByTime(30_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('stops polling the moment a re-render reports the session is gone', () => {
    const { rerender } = render(<AutoRefresh intervalMs={10_000} isAuthenticated />);
    vi.advanceTimersByTime(10_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    rerender(<AutoRefresh intervalMs={10_000} isAuthenticated={false} />);
    vi.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
