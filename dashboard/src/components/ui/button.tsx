import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/*
 * Button — shell primitive (shadcn-style, Radix-free for thesis transparency).
 *
 * Clinical Swiss (DESIGN-SPEC.md §1.1, §5 Lane A item 3): the accent teal is RESERVED —
 * only `primary` uses it. Hover/press are real state colors (`--color-accent-hover` /
 * `--color-accent-press`, `--color-danger-hover` / `--color-danger-press`), never
 * `hover:opacity-90` — opacity-hover on a saturated fill lightens it and *lowers* the text
 * contrast on the one control that must never lose it.
 *
 * `size="md"` (44px) is the floor for anything a doctor taps. `size="sm"` (36px) is a
 * documented, deliberate exception for dense in-table controls only — never the default.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors duration-200 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        // primary — the accent CTA (reserved use)
        primary:
          'bg-[var(--color-accent)] text-[var(--color-on-accent)] shadow-[var(--elev-1)] hover:bg-[var(--color-accent-hover)] active:bg-[var(--color-accent-press)]',
        // secondary — neutral slate; no accent
        secondary:
          'border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[var(--elev-1)] hover:bg-[var(--color-surface-hover)] active:bg-[var(--color-canvas-raised)]',
        destructive:
          'bg-[var(--color-danger-700)] text-[var(--color-surface)] shadow-[var(--elev-1)] hover:bg-[var(--color-danger-hover)] active:bg-[var(--color-danger-press)]',
        // ghost — text-only neutral control (e.g. sign-out)
        ghost:
          'text-[var(--color-ink)] hover:bg-[var(--color-surface-hover)] active:bg-[var(--color-canvas-raised)]',
      },
      size: {
        /** 36px — in-table controls only; never the default. */
        sm: 'min-h-9 px-3',
        /** 44px — the touch-target floor (WCAG 2.5.5). */
        md: 'min-h-11 px-4',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = 'Button';

export { buttonVariants };
