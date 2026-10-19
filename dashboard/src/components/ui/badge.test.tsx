// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge, badgeVariants } from './badge';

describe('Badge — status pill with cva variants', () => {
  it('renders its children as visible text (default variant)', () => {
    render(<Badge>Test patient</Badge>);
    expect(screen.getByText('Test patient')).toBeInTheDocument();
  });

  it('maps each variant to its own token-based classes', () => {
    // The accent teal is RESERVED (DESIGN-SPEC.md §1.1) — the default badge stays neutral.
    expect(badgeVariants({ variant: 'default' })).toContain('var(--color-ink)');
    expect(badgeVariants({ variant: 'secondary' })).toContain('var(--color-canvas-raised)');
    // Semantic variants are the tier ramp's 50-tint fill + 700-tier text.
    expect(badgeVariants({ variant: 'success' })).toContain('var(--color-success-50)');
    expect(badgeVariants({ variant: 'success' })).toContain('var(--color-success-700)');
    expect(badgeVariants({ variant: 'warning' })).toContain('var(--color-warning-50)');
    expect(badgeVariants({ variant: 'warning' })).toContain('var(--color-warning-700)');
    expect(badgeVariants({ variant: 'info' })).toContain('var(--color-info-50)');
    expect(badgeVariants({ variant: 'info' })).toContain('var(--color-info-700)');
    expect(badgeVariants({ variant: 'destructive' })).toContain('var(--color-danger-50)');
    expect(badgeVariants({ variant: 'destructive' })).toContain('var(--color-danger-700)');
    expect(badgeVariants({ variant: 'outline' })).toContain('var(--color-border)');
    // Variants are visually distinct.
    expect(badgeVariants({ variant: 'destructive' })).not.toBe(
      badgeVariants({ variant: 'secondary' }),
    );
    expect(badgeVariants({ variant: 'warning' })).not.toBe(badgeVariants({ variant: 'success' }));
  });

  it('applies the selected variant class to the rendered element', () => {
    render(<Badge variant="destructive">Opted out</Badge>);
    expect(screen.getByText('Opted out')).toHaveClass('bg-[var(--color-danger-50)]');
  });

  it('merges a caller className with the variant classes', () => {
    render(<Badge className="ml-2">Inactive</Badge>);
    const badge = screen.getByText('Inactive');
    expect(badge).toHaveClass('ml-2');
  });

  it('renders an icon slot ahead of the label, hidden from assistive tech (colour is never the only categorical channel)', () => {
    render(
      <Badge variant="warning" icon={<svg data-testid="tier-glyph" />}>
        Important
      </Badge>,
    );
    const icon = screen.getByTestId('tier-glyph');
    expect(icon).toBeInTheDocument();
    expect(icon.closest('[aria-hidden="true"]')).not.toBeNull();
    // Icon precedes the text in document order.
    const badge = screen.getByText('Important').closest('span');
    expect(badge?.firstElementChild).toContainElement(icon);
  });

  it('omits the icon wrapper when no icon is supplied', () => {
    render(<Badge>No icon</Badge>);
    const badge = screen.getByText('No icon');
    expect(badge.querySelector('[aria-hidden="true"]')).toBeNull();
  });
});
