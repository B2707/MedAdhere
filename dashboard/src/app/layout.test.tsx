// @vitest-environment node
//
// RootLayout is an async Server Component with no hooks, so it can be called
// directly as a plain function and its returned element tree inspected —
// no DOM render needed for the data-theme hook (DESIGN-SPEC.md §5 Lane B).

import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

vi.mock('next/font/google', () => ({
  Public_Sans: () => ({ variable: '--font-public-sans' }),
  IBM_Plex_Mono: () => ({ variable: '--font-ibm-plex-mono' }),
}));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));

import { cookies } from 'next/headers';
import RootLayout from './layout';

const mockedCookies = vi.mocked(cookies);

function setThemeCookie(value: string | undefined) {
  mockedCookies.mockResolvedValue({
    get: (name: string) => (name === 'theme' && value !== undefined ? { value } : undefined),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

describe('RootLayout data-theme hook', () => {
  it('omits data-theme when no cookie is set — system preference alone decides', async () => {
    setThemeCookie(undefined);
    const element = (await RootLayout({ children: null })) as ReactElement<{
      'data-theme'?: string;
    }>;
    expect(element.props['data-theme']).toBeUndefined();
  });

  it('stamps data-theme from a valid "dark" cookie', async () => {
    setThemeCookie('dark');
    const element = (await RootLayout({ children: null })) as ReactElement<{
      'data-theme'?: string;
    }>;
    expect(element.props['data-theme']).toBe('dark');
  });

  it('stamps data-theme from a valid "light" cookie', async () => {
    setThemeCookie('light');
    const element = (await RootLayout({ children: null })) as ReactElement<{
      'data-theme'?: string;
    }>;
    expect(element.props['data-theme']).toBe('light');
  });

  it('ignores an invalid cookie value rather than passing it through', async () => {
    setThemeCookie('rainbow');
    const element = (await RootLayout({ children: null })) as ReactElement<{
      'data-theme'?: string;
    }>;
    expect(element.props['data-theme']).toBeUndefined();
  });
});
