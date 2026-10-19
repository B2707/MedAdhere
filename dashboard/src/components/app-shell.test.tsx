// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

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

import { AppShell } from './app-shell';

describe('AppShell — shell & navigation (DESIGN-SPEC.md §5 Lane B)', () => {
  beforeEach(() => {
    pathnameState.value = '/patients';
  });

  it('renders the real page title as the single level-one heading', () => {
    render(
      <AppShell pageTitle="Patient overview">
        <p>Content</p>
      </AppShell>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Patient overview' })).toBeInTheDocument();
    expect(screen.getByText('CLINICIAN')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /medadhere overview/i })).toHaveClass(
      'min-h-11',
      'min-w-11',
    );
    expect(screen.getByRole('link', { name: /skip to main content/i })).toHaveAttribute(
      'href',
      '#main-content',
    );
  });

  it('labels the three real nav destinations (N1) — Patients, Reviews, Enroll patient', () => {
    render(
      <AppShell pageTitle="Patients">
        <p>Content</p>
      </AppShell>,
    );
    expect(screen.getByRole('link', { name: /^patients$/i })).toHaveAttribute('href', '/patients');
    expect(screen.getByRole('link', { name: /^reviews$/i })).toHaveAttribute('href', '/reviews');
    expect(screen.getByRole('link', { name: /enroll patient/i })).toHaveAttribute(
      'href',
      '/patients/new',
    );
    // Study analytics is no longer a sidebar destination — it becomes an in-page
    // tab on /patients (Lane E). The MONITOR/MANAGE section kickers go with it.
    expect(screen.queryByRole('link', { name: /study analytics/i })).not.toBeInTheDocument();
    expect(screen.queryByText('MONITOR')).not.toBeInTheDocument();
    expect(screen.queryByText('MANAGE')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /sign out/i })).toHaveLength(1);
  });

  it('deletes the notification bell (N2) and the placeholder identity block (N6)', () => {
    render(
      <AppShell pageTitle="Patients">
        <p>Content</p>
      </AppShell>,
    );
    expect(screen.queryByRole('link', { name: /open review queues/i })).not.toBeInTheDocument();
    expect(screen.queryByText('SECURE SESSION')).not.toBeInTheDocument();
    expect(screen.queryByText('Clinician workspace')).not.toBeInTheDocument();
  });

  it('deletes the shell search box entirely (C4 — Lane E owns the sole surviving search)', () => {
    render(
      <AppShell pageTitle="Cohort overview">
        <p>Content</p>
      </AppShell>,
    );
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/search patients/i)).not.toBeInTheDocument();
  });

  it('marks Reviews current as page only on the exact /reviews route', () => {
    pathnameState.value = '/reviews';
    render(
      <AppShell pageTitle="Reviews">
        <p>Content</p>
      </AppShell>,
    );
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getAllByRole('link', { current: 'page' })).toHaveLength(1);
    expect(within(nav).getByRole('link', { name: /^reviews$/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('marks Reviews current (not page) on a review sub-route', () => {
    pathnameState.value = '/reviews/safety';
    render(
      <AppShell pageTitle="Reviews">
        <p>Content</p>
      </AppShell>,
    );
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getAllByRole('link', { current: true })).toHaveLength(1);
    expect(within(nav).getByRole('link', { name: /^reviews$/i })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('marks Patients current without marking Reviews on /patients', () => {
    pathnameState.value = '/patients';
    render(
      <AppShell pageTitle="Patients">
        <p>Content</p>
      </AppShell>,
    );
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getAllByRole('link', { current: 'page' })).toHaveLength(1);
    expect(within(nav).getByRole('link', { name: /^patients$/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: /^reviews$/i })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('marks Enroll patient, not Patients, on /patients/new', () => {
    pathnameState.value = '/patients/new';
    render(
      <AppShell pageTitle="Enroll patient">
        <p>Content</p>
      </AppShell>,
    );
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: /enroll patient/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: /^patients$/i })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('marks Patients active (not page) on a patient detail route', () => {
    pathnameState.value = '/patients/patient-1';
    render(
      <AppShell pageTitle="Patient detail">
        <p>Content</p>
      </AppShell>,
    );
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: /^patients$/i })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(within(nav).getByRole('link', { name: /enroll patient/i })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('renders page actions beside the page heading', () => {
    render(
      <AppShell
        pageTitle="Cohort overview"
        pageActions={<a href="/patients/new">Enroll patient</a>}
      >
        <p>Content</p>
      </AppShell>,
    );
    expect(
      within(screen.getByRole('main')).getByRole('link', { name: /enroll patient/i }),
    ).toHaveAttribute('href', '/patients/new');
  });

  it('lets a wide page-actions cluster wrap instead of forcing the body to scroll sideways', () => {
    render(
      <AppShell
        pageTitle="Patient detail"
        pageActions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <a href="/patients">Back to overview</a>
            <button type="button">Edit details</button>
            <button type="button">Deactivate</button>
          </div>
        }
      >
        <p>Content</p>
      </AppShell>,
    );

    const actions = within(screen.getByRole('main')).getByRole('link', {
      name: /back to overview/i,
    }).parentElement?.parentElement;
    expect(actions).not.toHaveClass('shrink-0');
    expect(actions).toHaveClass('flex', 'min-w-0', 'flex-wrap');
  });

  it('renders headerSlot as page context, never as a duplicate title (P2!)', () => {
    render(
      <AppShell pageTitle="Patient detail" headerSlot="14-day view">
        <p>Content</p>
      </AppShell>,
    );
    expect(screen.getByRole('banner')).toHaveTextContent('14-day view');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryAllByText('Patient detail')).toHaveLength(1);
  });

  it('omits the header entirely when no headerSlot is supplied', () => {
    render(
      <AppShell pageTitle="Patients">
        <p>Content</p>
      </AppShell>,
    );
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
  });

  it('keeps a single sticky element active below 768px (§2.2) — no top-[68px] magic offset', () => {
    render(
      <AppShell pageTitle="Patients" headerSlot="3 events">
        <p>Content</p>
      </AppShell>,
    );
    const aside = document.querySelector('aside');
    expect(aside).toHaveClass('sticky', 'top-0');
    const header = screen.getByRole('banner');
    expect(header).toHaveClass('hidden', 'md:block');
    expect(header).not.toHaveClass('top-[68px]');
  });

  it('accepts a legacy topBarLabel prop without rendering it (P2! — no title duplication)', () => {
    render(
      <AppShell pageTitle="Cohort overview" topBarLabel="Overview">
        <p>Content</p>
      </AppShell>,
    );
    expect(screen.queryAllByText('Overview')).toHaveLength(0);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('uses token radius and type scale on the logo tile (N7)', () => {
    render(
      <AppShell pageTitle="Patients">
        <p>Content</p>
      </AppShell>,
    );
    expect(screen.getByText('M')).toHaveClass('rounded-md', 'text-base');
  });

  it('provides a compact labelled menu for 320px navigation', () => {
    render(
      <AppShell pageTitle="Patients">
        <p>Content</p>
      </AppShell>,
    );

    const button = screen.getByRole('button', { name: /open navigation menu/i });
    expect(button.parentElement).toHaveClass('md:hidden');
    expect(button).toHaveClass('size-11');
    expect(button).toHaveAttribute('aria-controls', 'mobile-primary-navigation');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('navigation', { name: 'Primary' })).toHaveClass('hidden', 'md:flex');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('navigation', { name: /mobile primary/i });
    expect(within(menu).getByRole('link', { name: /^reviews$/i })).toHaveAttribute(
      'href',
      '/reviews',
    );
    expect(within(menu).getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });
});
