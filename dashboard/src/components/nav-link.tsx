'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/*
 * Sidebar nav link. The cyan accent (left border + accent text) and
 * `aria-current` is applied ONLY when the link is active — the accent
 * is reserved for the active nav item (UI-SPEC §Color reserved list). 44px min
 * touch target (min-h-11). Status conveyed by icon + label, never color alone.
 *
 * `icon` is a pre-rendered ReactNode (e.g. `<Users size={18} />`), NOT a component
 * function — a Server Component parent (AppShell) cannot pass a function/component
 * reference across the server→client boundary ("Functions cannot be passed directly
 * to Client Components"); a rendered element serializes into the RSC payload fine.
 * (Deploy-day fix 2026-06-19 — only surfaced on a live SSR request of /patients.)
 */
export function NavLink({
  href,
  label,
  icon,
  matchPrefix,
  exact = false,
  excludePrefixes = [],
  excludePaths = [],
}: {
  href: string;
  label: string;
  icon: ReactNode;
  matchPrefix?: string;
  exact?: boolean;
  excludePrefixes?: string[];
  excludePaths?: string[];
}) {
  const pathname = usePathname();
  const matches = (candidate: string) =>
    pathname === candidate || pathname.startsWith(`${candidate}/`);
  const isExact = pathname === href;
  const isExcluded =
    excludePaths.includes(pathname) || excludePrefixes.some((prefix) => matches(prefix));
  const isActive =
    !isExcluded &&
    (exact ? isExact : matches(href) || (matchPrefix !== undefined && matches(matchPrefix)));

  return (
    <Link
      href={href}
      title={label}
      aria-current={isActive ? (isExact ? 'page' : 'true') : undefined}
      className={cn(
        'flex min-h-11 min-w-11 items-center justify-center gap-3 rounded-md border px-3 text-sm font-semibold transition-colors duration-150 md:w-full md:justify-center lg:justify-start',
        isActive
          ? 'border-[var(--color-accent-hover)] bg-[var(--color-accent-50)] text-[var(--color-accent)]'
          : 'border-transparent text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)] active:bg-[var(--color-border-subtle)]',
      )}
    >
      {icon}
      <span className="sr-only lg:not-sr-only">{label}</span>
    </Link>
  );
}
