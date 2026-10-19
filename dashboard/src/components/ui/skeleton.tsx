import * as React from 'react';
import { cn } from '@/lib/utils';

/*
 * Skeleton — visual loading affordance. Route wrappers own the single announcement.
 *
 * `aspectRatio` (PF1) lets a chart placeholder reserve the chart's exact rendered height
 * before the client bundle loads, so a `next/dynamic` chart never causes layout shift.
 */
export function Skeleton({
  className,
  style,
  aspectRatio,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  aspectRatio?: React.CSSProperties['aspectRatio'];
}) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-[var(--color-canvas-raised)]', className)}
      style={aspectRatio !== undefined ? { aspectRatio, ...style } : style}
      {...props}
    />
  );
}
