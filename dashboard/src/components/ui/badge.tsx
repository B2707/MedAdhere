import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/*
 * Badge — status pill (shadcn new-york style; cva variants like button.tsx).
 *
 * Clinical Swiss (DESIGN-SPEC.md §1.1, §5 Lane A item 4): the accent teal is RESERVED
 * (primary buttons / active nav / focus rings), so `default` stays a neutral ink chip, not
 * the accent hue. `success`/`warning`/`info`/`destructive` are the tier ramp's 50-tint fill
 * + 700-tier text — the same pairing the day-thread marks use (clinical-labels.tsx),
 * kept ≥4.5:1 as text.
 *
 * Colour is never the sole categorical channel (§1.1, A4/C1/A11): every variant supports
 * an `icon` slot rendered ahead of the label so a shape/glyph always travels with the tint.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-2 whitespace-nowrap rounded-full border px-2 py-1 text-sm font-medium leading-none',
  {
    variants: {
      variant: {
        // default — neutral ink chip (NOT the reserved accent)
        default: 'border-transparent bg-[var(--color-ink)] text-[var(--color-surface)]',
        // secondary — muted surface chip
        secondary: 'border-transparent bg-[var(--color-canvas-raised)] text-[var(--color-ink)]',
        // success — positive tier (confirmed taken/delayed, receiving check-ins)
        success: 'border-transparent bg-[var(--color-success-50)] text-[var(--color-success-700)]',
        // warning — important tier (ambiguous outcomes)
        warning: 'border-transparent bg-[var(--color-warning-50)] text-[var(--color-warning-700)]',
        // info — needs-human tier (fallback, system-failure)
        info: 'border-transparent bg-[var(--color-info-50)] text-[var(--color-info-700)]',
        // destructive — danger tier (inactive / opted-out / error state)
        destructive:
          'border-transparent bg-[var(--color-danger-50)] text-[var(--color-danger-700)]',
        // outline — hairline chip, no fill
        outline: 'border-[var(--color-border)] text-[var(--color-ink)]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  /** Shape/glyph companion to the tint — colour is never the only categorical channel. */
  icon?: React.ReactNode;
}

export function Badge({ className, variant, icon, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {icon !== undefined && (
        <span aria-hidden="true" className="inline-flex shrink-0">
          {icon}
        </span>
      )}
      {children}
    </span>
  );
}

export { badgeVariants };
