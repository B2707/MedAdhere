'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ListChecks, LogOut, Menu, UserRoundPlus, Users, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/*
 * Mobile primary navigation — a REAL dialog (N3, DESIGN-SPEC.md §3.3).
 *
 * Below `md` the sidebar collapses to this: a 44px trigger that opens a scrimmed,
 * focus-trapped sheet (`role="dialog" aria-modal="true"`). Three real destinations
 * (N1) plus sign-out below a rule — no anchor-into-a-page items, no permanently
 * unreachable "active" state.
 */
interface MobileLink {
  href: string;
  label: string;
  icon: ReactNode;
  isActive: (pathname: string) => boolean;
}

const LINKS: MobileLink[] = [
  {
    href: '/patients',
    label: 'Patients',
    icon: <Users aria-hidden="true" size={18} />,
    isActive: (pathname) =>
      pathname === '/patients' ||
      (pathname.startsWith('/patients/') && pathname !== '/patients/new'),
  },
  {
    href: '/reviews',
    label: 'Reviews',
    icon: <ListChecks aria-hidden="true" size={18} />,
    isActive: (pathname) => pathname === '/reviews' || pathname.startsWith('/reviews/'),
  },
  {
    href: '/patients/new',
    label: 'Enroll patient',
    icon: <UserRoundPlus aria-hidden="true" size={18} />,
    isActive: (pathname) => pathname === '/patients/new',
  },
];

/** Every element inside the dialog that Tab should be able to reach. */
function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
}

export function MobileNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const dismiss = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Route-change dismiss (N3): a dialog left open across a navigation underneath it
  // (e.g. a shared layout, or an in-page route change) must not survive silently.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Focus trap + initial focus + background scroll lock, only while open.
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (dialog === null) return;

    focusableElements(dialog)[0]?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dismiss();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusableElements(dialog);
      if (items.length === 0) return;
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeydown);
    return () => {
      document.removeEventListener('keydown', handleKeydown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls="mobile-primary-navigation"
        aria-label={open ? 'Close navigation menu' : 'Open navigation menu'}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex size-11 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-ink)]"
      >
        {open ? <X aria-hidden="true" size={20} /> : <Menu aria-hidden="true" size={20} />}
      </button>

      {open && (
        <div className="fixed inset-0 z-40">
          <div
            data-testid="mobile-nav-scrim"
            aria-hidden="true"
            onClick={dismiss}
            className="absolute inset-0 bg-[color-mix(in_srgb,var(--color-ink)_50%,transparent)]"
          />
          <div
            ref={dialogRef}
            id="mobile-primary-navigation"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            className="enter-rise relative z-10 border-b border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[var(--elev-3)]"
          >
            <nav aria-label="Mobile primary">
              <div className="grid gap-1">
                {LINKS.map((link) => {
                  const active = link.isActive(pathname);
                  return (
                    <Link
                      key={link.label}
                      href={link.href}
                      aria-current={active ? (pathname === link.href ? 'page' : 'true') : undefined}
                      onClick={() => setOpen(false)}
                      className={cn(
                        'flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-semibold',
                        active
                          ? 'bg-[var(--color-accent-50)] text-[var(--color-accent)]'
                          : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]',
                      )}
                    >
                      {link.icon}
                      {link.label}
                    </Link>
                  );
                })}
                <form
                  action="/api/auth/logout"
                  method="get"
                  className="border-t border-[var(--color-border-subtle)] pt-2"
                >
                  <button
                    type="submit"
                    className="flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-sm font-semibold text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
                  >
                    <LogOut aria-hidden="true" size={18} />
                    Sign out
                  </button>
                </form>
              </div>
            </nav>
          </div>
        </div>
      )}
    </div>
  );
}
