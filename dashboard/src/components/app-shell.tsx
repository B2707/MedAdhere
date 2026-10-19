import * as React from 'react';
import Link from 'next/link';
import { ListChecks, LogOut, UserRoundPlus, Users } from 'lucide-react';
import { NavLink } from '@/components/nav-link';
import { MobileNav } from '@/components/mobile-nav';

/*
 * AppShell — the persistent app frame (DESIGN-SPEC.md §2.2, §5 Lane B).
 *
 * Responsive shell, one sticky element per breakpoint bucket:
 *  - <768: the aside collapses to a 56px top bar (logo + MobileNav trigger,
 *    sticky top-0) — the ONLY sticky chrome on mobile. The page header below
 *    scrolls with the content.
 *  - 768–1023 (md): a 72px icon rail, fixed full height, icon-only links with
 *    a native `title` tooltip (NavLink) — no labels, no section kickers.
 *  - >=1024 (lg): a 248px labelled sidebar, fixed full height.
 *
 * Primary nav is 3 real destinations (N1): Patients, Reviews, Enroll patient.
 * "Study analytics" is no longer a sidebar item — it becomes an in-page tab on
 * `/patients` (Lane E). Sign-out sits below a rule, always reachable. The
 * notification bell (N2) and the header search box (C4 — Lane E owns the sole
 * surviving search, in the roster header) are deleted, not relocated.
 *
 * Landmark roles: <nav> (primary), <header> (page context, md+ only), <main>
 * (content). The accent is reserved for the active nav item only.
 */
export function AppShell({
  children,
  pageTitle,
  pageDescription,
  headerSlot,
  pageActions,
}: {
  children: React.ReactNode;
  pageTitle: string;
  pageDescription?: string;
  headerSlot?: React.ReactNode;
  pageActions?: React.ReactNode;
  /**
   * Accepted-but-unused: several pages still pass this (a pre-redesign duplicate
   * of `pageTitle`, P2!). Kept in the prop type only so those call sites — owned
   * by other lanes — keep type-checking; nothing renders it anymore.
   */
  topBarLabel?: string;
}) {
  return (
    <div className="min-h-dvh bg-[var(--color-canvas)] md:grid md:grid-cols-[72px_minmax(0,1fr)] lg:grid-cols-[248px_minmax(0,1fr)]">
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-50 -translate-y-20 rounded-md bg-[var(--color-ink)] px-4 py-3 text-sm font-semibold text-[var(--color-surface)] transition-transform focus:translate-y-0"
      >
        Skip to main content
      </a>

      <aside className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 md:h-dvh md:flex-col md:items-stretch md:justify-start md:gap-6 md:border-b-0 md:border-r md:px-3 md:py-5 lg:px-4">
        <Link
          href="/patients"
          aria-label="MedAdhere overview"
          className="flex min-h-11 min-w-11 items-center gap-3 rounded-md"
        >
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent)] text-base font-bold text-[var(--color-on-accent)]">
            M
          </span>
          <div className="hidden min-w-0 lg:block">
            <div className="text-base font-semibold leading-tight text-[var(--color-ink)]">
              MedAdhere
            </div>
            <p className="font-[family-name:var(--font-mono)] text-xs font-medium tracking-mono text-[var(--color-ink-muted)]">
              CLINICIAN
            </p>
          </div>
        </Link>

        <MobileNav />

        <nav
          aria-label="Primary"
          className="hidden min-w-0 md:flex md:flex-1 md:flex-col md:items-stretch md:gap-1"
        >
          <NavLink
            href="/patients"
            label="Patients"
            matchPrefix="/patients"
            excludePrefixes={['/patients/new']}
            icon={<Users aria-hidden="true" size={18} />}
          />
          <NavLink
            href="/reviews"
            label="Reviews"
            matchPrefix="/reviews"
            icon={<ListChecks aria-hidden="true" size={18} />}
          />
          <NavLink
            href="/patients/new"
            label="Enroll patient"
            icon={<UserRoundPlus aria-hidden="true" size={18} />}
          />

          <form
            action="/api/auth/logout"
            method="get"
            className="mt-auto shrink-0 border-t border-[var(--color-border-subtle)] pt-4"
          >
            <button
              type="submit"
              className="flex min-h-11 min-w-11 items-center justify-center gap-3 rounded-md text-sm font-semibold text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)] md:w-full md:justify-center lg:justify-start lg:px-3"
            >
              <LogOut aria-hidden="true" size={18} />
              <span className="sr-only lg:not-sr-only">Sign out</span>
            </button>
          </form>
        </nav>
      </aside>

      <div className="min-w-0">
        {headerSlot !== undefined && (
          <header className="sticky top-0 z-20 hidden border-b border-[var(--color-border-subtle)] bg-[color-mix(in_srgb,var(--color-surface)_92%,transparent)] shadow-[var(--elev-2)] md:block">
            <div className="flex min-h-11 items-center justify-end px-6 lg:px-8">
              <span className="inline-flex min-h-9 items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 font-[family-name:var(--font-mono)] text-xs font-medium uppercase tracking-mono text-[var(--color-ink-muted)]">
                {headerSlot}
              </span>
            </div>
          </header>
        )}

        <main
          id="main-content"
          tabIndex={-1}
          className="bg-[var(--color-canvas)] px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
        >
          <div className="mx-auto w-full max-w-[1280px]">
            <div className="mb-6 flex flex-col items-start justify-between gap-4 sm:flex-row">
              <div className="min-w-0 flex-1">
                <h1 className="text-xl font-semibold tracking-display text-[var(--color-ink)]">
                  {pageTitle}
                </h1>
                {pageDescription !== undefined && (
                  <p className="mt-1 max-w-[42rem] text-base text-[var(--color-ink-muted)]">
                    {pageDescription}
                  </p>
                )}
              </div>
              {/* Never `shrink-0` here: the actions cluster wraps internally, and pinning this
                  wrapper to its min-content width overflows the body between 768px and 825px. */}
              {pageActions !== undefined && (
                <div className="flex min-h-11 min-w-0 flex-wrap items-center">{pageActions}</div>
              )}
            </div>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
