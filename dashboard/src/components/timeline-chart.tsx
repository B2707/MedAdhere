'use client';

import { adeHintInputSchema, buildAdeHint } from '../../../packages/shared/src/ade-hint';
import { AlertTriangle, ArrowLeftRight, BarChart3, FileWarning, Tag } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { ChartLegend } from '@/components/ui/chart-legend';
import { EmptyState } from '@/components/ui/empty-state';
import type { TimelineRow } from '@/lib/dashboard-contracts';
import {
  doseLabel,
  toTimelineChartData,
  type TimelineBucket,
  type TimelineChartPoint,
} from '@/lib/timeline-metrics';

export type { TimelineLabelMatch, TimelineRow } from '@/lib/dashboard-contracts';
// The bucket math lives in a server-safe module (this one is `'use client'`); re-exported so the
// chart stays the single import site for callers and tests.
export { doseLabel, timelineBucket, toTimelineChartData } from '@/lib/timeline-metrics';
export type { TimelineBucket, TimelineChartPoint } from '@/lib/timeline-metrics';

/*
 * Clinical Swiss token pass (DESIGN-SPEC.md §5 Lane F): C7 (one <ChartLegend>, no hand-rolled
 * legend), A1 (12px tick floor — was 9px), PF2 (aggregate the bar series past ~60 points so a
 * 90-day window never forces a several-thousand-pixel-wide SVG).
 */

/** Public metadata keeps M13 labels and swatches testable without inspecting SVG internals. */
export const TIMELINE_BUCKETS = {
  confirmedTaken: {
    label: 'confirmed — taken/late',
    color: 'var(--color-success-700)',
  },
  confirmedNotTaken: {
    label: 'confirmed — not taken (skipped/stopped)',
    color: 'var(--color-danger-700)',
  },
  ambiguous: {
    label: 'ambiguous response',
    color: 'var(--color-warning-700)',
  },
  noResponse: {
    label: 'no response',
    color: 'var(--color-neutral-700)',
  },
} as const;

/** PF2: past this many points the bar chart aggregates into fixed-size chunks so its rendered
 *  width stops growing linearly with the window — the accessible text table below stays
 *  full-fidelity regardless (it reads the un-aggregated `data`, never `chartData`). */
const MAX_TIMELINE_POINTS = 60;

/** Sum-preserving decimation: contiguous doses fold into one stacked bar per chunk. */
function aggregateForChart(data: TimelineChartPoint[]): TimelineChartPoint[] {
  if (data.length <= MAX_TIMELINE_POINTS) return data;
  const chunkSize = Math.ceil(data.length / MAX_TIMELINE_POINTS);
  const chunks: TimelineChartPoint[] = [];
  for (let start = 0; start < data.length; start += chunkSize) {
    const chunk = data.slice(start, start + chunkSize);
    const first = chunk[0]!;
    const last = chunk[chunk.length - 1]!;
    chunks.push({
      doseId: `chunk-${start}`,
      label: first.label === last.label ? first.label : `${first.label} – ${last.label}`,
      bucket: first.bucket,
      reasonCode: null,
      confirmedTaken: chunk.reduce((sum, point) => sum + point.confirmedTaken, 0),
      confirmedNotTaken: chunk.reduce((sum, point) => sum + point.confirmedNotTaken, 0),
      ambiguous: chunk.reduce((sum, point) => sum + point.ambiguous, 0),
      noResponse: chunk.reduce((sum, point) => sum + point.noResponse, 0),
    });
  }
  return chunks;
}

interface TimelineHint {
  id: string;
  doseLabel: string;
  text: string;
  level: 'info' | 'elevated';
}

function timelineHints(rows: TimelineRow[]): TimelineHint[] {
  return rows.flatMap((row) =>
    row.label_matches.flatMap((match) => {
      const parsed = adeHintInputSchema.safeParse({
        matched_phrase: match.matched_phrase,
        meddra_pt: match.meddra_pt,
        hint_level: match.hint_level,
      });
      if (!parsed.success) return [];
      return [
        {
          id: match.id,
          doseLabel: doseLabel(row),
          text: buildAdeHint(parsed.data),
          level: parsed.data.hint_level,
        },
      ];
    }),
  );
}

export function TimelineChart({ rows }: { rows: TimelineRow[] }) {
  const data = toTimelineChartData(rows);
  if (data.length === 0) {
    return (
      <EmptyState
        icon={<BarChart3 size={24} />}
        title="No recorded outcomes yet"
        description="Adherence outcomes will appear after a check-in is delivered and resolved."
      />
    );
  }

  const chartData = aggregateForChart(data);
  const hints = timelineHints(rows);
  const count = (bucket: TimelineBucket) => data.filter((point) => point.bucket === bucket).length;
  const ariaLabel =
    `Adherence timeline: ${count('confirmedTaken')} confirmed taken or late, ` +
    `${count('confirmedNotTaken')} confirmed skipped or stopped, ` +
    `${count('ambiguous')} ambiguous responses, ${count('noResponse')} without a response.`;
  const reasons = data.filter((point) => point.reasonCode !== null && point.reasonCode !== 'none');

  return (
    <div className="flex flex-col gap-6">
      <ChartLegend
        ariaLabel="Dose outcome legend"
        items={Object.entries(TIMELINE_BUCKETS).map(([key, bucket]) => ({
          key,
          label: bucket.label,
          color: bucket.color,
          count: count(key as TimelineBucket),
        }))}
      />

      <div>
        <p className="mb-2 flex items-center gap-2 text-sm text-[var(--color-ink-muted)]">
          <ArrowLeftRight aria-hidden="true" size={14} />
          Scroll horizontally to inspect all doses.
        </p>
        <div
          role="region"
          aria-label="Scrollable dose timeline"
          // A horizontal scroller must be keyboard-focusable for non-pointer users.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          className="w-full overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-canvas-raised)] p-4"
        >
          <div role="img" aria-label={ariaLabel}>
            <div
              data-testid="dose-timeline-chart"
              aria-hidden="true"
              className="h-[220px] min-w-[720px]"
              style={{ width: Math.max(720, chartData.length * 44) }}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  accessibilityLayer
                  data={chartData}
                  margin={{ top: 12, right: 8, bottom: 20, left: 8 }}
                  barCategoryGap="20%"
                >
                  <CartesianGrid
                    vertical={false}
                    stroke="var(--color-border)"
                    strokeDasharray="3 3"
                  />
                  <XAxis
                    dataKey="label"
                    interval="preserveStartEnd"
                    minTickGap={44}
                    tickFormatter={(value: string) =>
                      value.replace('2026-', '').replace(' ', ' · ')
                    }
                    tick={{ fill: 'var(--color-ink-muted)', fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis hide domain={[0, 1]} />
                  <Tooltip
                    labelFormatter={(label) => String(label)}
                    formatter={(_value, name) => [String(name), 'Outcome']}
                    contentStyle={{
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--color-surface)',
                      fontSize: 12,
                    }}
                  />
                  {Object.entries(TIMELINE_BUCKETS).map(([key, bucket]) => (
                    <Bar
                      key={key}
                      dataKey={key}
                      name={bucket.label}
                      stackId="outcome"
                      fill={bucket.color}
                      radius={[4, 4, 0, 0]}
                      isAnimationActive={false}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>

      <div className="sr-only [contain:paint]">
        <table>
          <caption>Dated dose outcomes</caption>
          <thead>
            <tr>
              <th scope="col">Scheduled dose</th>
              <th scope="col">Outcome</th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody>
            {data.map((point) => (
              <tr key={point.doseId}>
                <th scope="row">{point.label}</th>
                <td>{TIMELINE_BUCKETS[point.bucket].label}</td>
                <td>{point.reasonCode?.replaceAll('_', ' ') ?? 'Not reported'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {reasons.length > 0 && (
        <section className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-canvas-raised)] p-4">
          <div className="flex items-center gap-2">
            <FileWarning aria-hidden="true" className="text-[var(--color-ink-muted)]" size={18} />
            <h3 className="text-base font-semibold text-[var(--color-ink)]">Outcome details</h3>
          </div>
          <ul className="flex flex-col gap-1 text-sm text-[var(--color-ink-secondary)]">
            {reasons.map((point) => (
              <li key={point.doseId} className="mt-2">
                <span className="font-semibold text-[var(--color-ink)]">{point.label}: </span>
                Reason: {point.reasonCode?.replaceAll('_', ' ')}
              </li>
            ))}
          </ul>
        </section>
      )}

      {hints.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Tag aria-hidden="true" className="text-[var(--color-ink-muted)]" size={18} />
            <h3 className="text-base font-semibold text-[var(--color-ink)]">Label-match hints</h3>
          </div>
          <ul className="flex flex-col gap-2">
            {hints.map((hint) => (
              <li
                key={hint.id}
                className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-canvas-raised)] p-4 text-sm text-[var(--color-ink-secondary)]"
              >
                <AlertTriangle
                  aria-hidden="true"
                  className={
                    hint.level === 'elevated'
                      ? 'mt-1 shrink-0 text-[var(--color-danger-700)]'
                      : 'mt-1 shrink-0 text-[var(--color-ink-muted)]'
                  }
                  size={17}
                />
                <span className="flex flex-col items-start gap-1">
                  {hint.level === 'elevated' && (
                    <Badge variant="destructive">Elevated label match</Badge>
                  )}
                  <span>
                    <span className="font-semibold text-[var(--color-ink)]">
                      {hint.doseLabel}:{' '}
                    </span>
                    {hint.text}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
