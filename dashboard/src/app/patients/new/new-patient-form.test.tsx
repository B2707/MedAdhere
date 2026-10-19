// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const { cookieStore, fetchMock } = vi.hoisted(() => ({
  cookieStore: new Map<string, string>(),
  fetchMock: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      cookieStore.has(name) ? { name, value: cookieStore.get(name)! } : undefined,
  })),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

import { NewPatientForm } from './new-patient-form';

beforeEach(() => {
  cookieStore.clear();
  cookieStore.set('id_token', 'ID.TOKEN.value');
  process.env.DATA_API_URL = 'https://data.example.com';
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

function fillAndSubmit(phone: string) {
  fireEvent.change(screen.getByLabelText(/phone/i), { target: { value: phone } });
  fireEvent.change(screen.getByLabelText(/^medication$/i), {
    target: { value: 'Metformin' },
  });
  fireEvent.change(screen.getByLabelText(/display name/i), {
    target: { value: 'Alex' },
  });
  fireEvent.submit(screen.getByRole('button', { name: /enroll patient/i }).closest('form')!);
}

describe('NewPatientForm failure retention', () => {
  it('provides the handoff framing, cancel route, and explicit scheduling section', () => {
    render(<NewPatientForm />);
    expect(screen.getByRole('heading', { name: /check-in schedule/i })).toBeInTheDocument();
    expect(screen.getByText(/research cohort only/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /cancel/i })).toHaveAttribute('href', '/patients');
    expect(
      screen.queryByRole('checkbox', { name: /mark as test patient/i }),
    ).not.toBeInTheDocument();
    expect(document.querySelector('input[name="is_test"]')).toBeNull();
  });

  it('defaults the schedule horizon to three days', () => {
    render(<NewPatientForm />);
    expect(screen.getByLabelText(/days to schedule/i)).toHaveValue(3);
  });

  it('retains medication but clears phone after client-shape validation fails', async () => {
    render(<NewPatientForm />);
    fireEvent.change(screen.getByLabelText(/days to schedule/i), {
      target: { value: '5' },
    });
    fillAndSubmit('514-555-0123');
    expect(await screen.findByRole('alert')).toHaveTextContent(/check the form/i);
    await waitFor(() => {
      expect(screen.getByLabelText(/^medication$/i)).toHaveValue('Metformin');
      expect(screen.getByLabelText(/days to schedule/i)).toHaveValue(5);
      expect(screen.getByLabelText(/phone/i)).toHaveValue('');
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retains medication but clears phone after a duplicate 409 response', async () => {
    fetchMock.mockResolvedValue({ status: 409, ok: false });
    render(<NewPatientForm />);
    fillAndSubmit('+15145550123');
    expect(await screen.findByRole('alert')).toHaveTextContent(/already be enrolled/i);
    await waitFor(() => {
      expect(screen.getByLabelText(/^medication$/i)).toHaveValue('Metformin');
      expect(screen.getByLabelText(/phone/i)).toHaveValue('');
    });
  });

  it('gives every dose-time input a real visible label, not just aria-label (F1)', () => {
    render(<NewPatientForm />);
    expect(screen.getByLabelText(/^dose 1$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/dose 2 \(optional\)/i)).toBeInTheDocument();
  });

  it('shows an error summary with an anchor per invalid field and moves focus to the first one (F3)', async () => {
    render(<NewPatientForm />);
    fillAndSubmit('514-555-0123');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('link', { name: /^phone$/i })).toHaveAttribute('href', '#phone');
    await waitFor(() => {
      expect(screen.getByLabelText(/phone/i)).toHaveFocus();
    });
  });

  it('associates the value-free timezone error with the invalid input', async () => {
    render(<NewPatientForm />);
    fireEvent.change(screen.getByLabelText(/timezone/i), {
      target: { value: 'America/Torono' },
    });
    fillAndSubmit('+15145550123');

    const timezoneError = await screen.findByText('Unrecognized timezone.');
    const timezoneInput = screen.getByLabelText(/timezone/i);
    expect(timezoneInput).toHaveAttribute('aria-invalid', 'true');
    expect(timezoneInput).toHaveAttribute('aria-describedby', timezoneError.id);
    expect(timezoneError).not.toHaveTextContent('America/Torono');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
