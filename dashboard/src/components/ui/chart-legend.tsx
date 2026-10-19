'use client';

import { cn } from '@/lib/utils';

/*
 * ChartLegend — the ONE legend treatment for every chart (DESIGN-SPEC.md §3.5-C7).
 *
 * Before this: `cohort-chart.tsx` and `timeline-chart.tsx` hand-rolled their own `<ul>` legends,
 * and `patient-trend-charts.tsx` used Recharts' default `<Legend />` (unstyled, 14px, non-token,
 * non-interactive) — two different systems. This is the single replacement: token type (≥12px),
 * a swatch + shape glyph (never colour alone — A11), the series name, and an optional live count,
 * each wrapped in a real `<button>` so a series can be toggled off without leaving the keyboard.
 *
 * `shape: 'line'` draws the swatch as a short dashed/solid stroke preview matching the series'
 * actual `strokeDasharray`, so a legend entry for a line series carries the SAME pattern that
 * disambiguates it on the chart once colours repeat past 6 series (A11).
 */

export interface ChartLegendItem {
  key: string;
  label: string;
  color: string;
  /** Live count shown after the name, e.g. how many points are in this series right now. */
  count?: number;
  /** 'line' draws a stroke preview (optionally dashed); 'square' (default) draws a filled swatch. */
  shape?: 'square' | 'line';
  /** SVG stroke-dasharray for a 'line' swatch — the on-chart disambiguation glyph (A11). */
  dashArray?: string;
}

export function ChartLegend({
  items,
  ariaLabel,
  hiddenKeys,
  onToggle,
  className,
}: {
  items: ChartLegendItem[];
  ariaLabel: string;
  /** Series currently toggled off. Omit (with `onToggle`) for a non-interactive legend. */
  hiddenKeys?: ReadonlySet<string>;
  /** Present ⇒ every entry renders as a toggle `<button aria-pressed>`. Absent ⇒ plain `<span>`s. */
  onToggle?: (key: string) => void;
  className?: string;
}) {
  return (
    <ul aria-label={ariaLabel} className={cn('flex flex-wrap gap-x-4 gap-y-2', className)}>
      {items.map((item) => {
        const hidden = hiddenKeys?.has(item.key) ?? false;
        const swatch =
          item.shape === 'line' ? (
            <svg aria-hidden="true" width="18" height="12" viewBox="0 0 18 12" className="shrink-0">
              <line
                x1="1"
                y1="6"
                x2="17"
                y2="6"
                stroke={item.color}
                strokeWidth="2.5"
                strokeDasharray={item.dashArray}
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <span
              aria-hidden="true"
              className="inline-block size-3.5 shrink-0 rounded-[var(--radius-sm)]"
              style={{ backgroundColor: item.color }}
            />
          );

        const content = (
          <>
            {swatch}
            <span
              className={cn(
                'text-sm',
                hidden
                  ? 'text-[var(--color-ink-muted)] line-through'
                  : 'text-[var(--color-ink-secondary)]',
              )}
            >
              {item.label}
            </span>
            {item.count !== undefined && (
              <span className="font-[family-name:var(--font-mono)] text-xs tabular-nums text-[var(--color-ink-muted)]">
                {item.count}
              </span>
            )}
          </>
        );

        return (
          <li key={item.key}>
            {onToggle !== undefined ? (
              <button
                type="button"
                aria-pressed={!hidden}
                onClick={() => onToggle(item.key)}
                className="flex min-h-11 items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 hover:bg-[var(--color-surface-hover)] focus-visible:focus-inset"
              >
                {content}
              </button>
            ) : (
              <span className="flex min-h-6 items-center gap-1.5">{content}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
