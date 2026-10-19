// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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

import { MobileNav } from './mobile-nav';

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /open navigation menu/i }));
}

describe('MobileNav', () => {
  beforeEach(() => {
    pathnameState.value = '/patients';
  });

  it('exposes the three real destinations through a compact 44px trigger', () => {
    render(<MobileNav />);

    const trigger = screen.getByRole('button', { name: /open navigation menu/i });
    expect(trigger).toHaveClass('size-11');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    openMenu();

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const dialog = screen.getByRole('dialog', { name: /navigation menu/i });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(trigger).toHaveAttribute('aria-controls', dialog.id);

    const navigation = within(dialog).getByRole('navigation', { name: /mobile primary/i });
    const links = within(navigation).getAllByRole('link');
    expect(links).toHaveLength(3);
    expect(links.map((link) => link.textContent)).toEqual([
      'Patients',
      'Reviews',
      'Enroll patient',
    ]);
    for (const link of links) {
      expect(link).toHaveClass('min-h-11');
    }
    expect(within(navigation).getByRole('button', { name: /sign out/i })).toHaveClass('min-h-11');
  });

  it('renders a scrim behind the dialog that dismisses it and returns focus to the trigger', () => {
    render(<MobileNav />);
    const trigger = screen.getByRole('button', { name: /open navigation menu/i });
    openMenu();

    fireEvent.click(screen.getByTestId('mobile-nav-scrim'));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('moves focus into the dialog on open and traps Tab / Shift+Tab inside it', () => {
    render(<MobileNav />);
    openMenu();

    const dialog = screen.getByRole('dialog');
    const focusable = [
      ...within(dialog).getAllByRole('link'),
      within(dialog).getByRole('button', { name: /sign out/i }),
    ];
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    expect(first).toHaveFocus();

    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(first).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('closes the menu with Escape and returns focus to the trigger', () => {
    render(<MobileNav />);

    const trigger = screen.getByRole('button', { name: /open navigation menu/i });
    openMenu();
    const dialog = screen.getByRole('dialog');

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('marks the patient roster destination current on a patient detail route', () => {
    pathnameState.value = '/patients/patient-1';
    render(<MobileNav />);
    openMenu();

    expect(screen.getByRole('link', { name: /^patients$/i })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('marks Reviews current for any /reviews sub-route', () => {
    pathnameState.value = '/reviews/safety';
    render(<MobileNav />);
    openMenu();

    expect(screen.getByRole('link', { name: /^reviews$/i })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('marks Enroll patient current, not Patients, on /patients/new', () => {
    pathnameState.value = '/patients/new';
    render(<MobileNav />);
    openMenu();

    expect(screen.getByRole('link', { name: /enroll patient/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: /^patients$/i })).not.toHaveAttribute('aria-current');
  });

  it('collapses after choosing a destination', () => {
    render(<MobileNav />);
    openMenu();

    const reviews = screen.getByRole('link', { name: /^reviews$/i });
    reviews.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(reviews);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes when the route changes underneath an open dialog', () => {
    const { rerender } = render(<MobileNav />);
    openMenu();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    pathnameState.value = '/reviews/safety';
    rerender(<MobileNav />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
