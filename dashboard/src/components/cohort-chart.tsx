'use client';

import { Activity, ArrowLeftRight, Check, CircleDashed, HelpCircle, X } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { EmptyState } from '@/components/ui/empty-state';
import {
  summarizeCohort,
  toChartData,
  type CohortDay,
  type CohortWindowDays,
} from '@/lib/cohort-metrics';

export { summarizeCohort, toChartData } from '@/lib/cohort-metrics';
export type { CohortChartPoint, CohortDay } from '@/lib/cohort-metrics';

/*
 * CohortChart (DASH-03 / D4 / D8) — the 30-day cohort adherence overview.
 *
 * 'use client' because this is an interactive dashboard component; the RSC page
 * passes plain serializable props (the raw data-API series). Renders a Recharts
 * adherence trend and four exhaustive delivered-check-in outcome buckets:
 *   - confirmed    — classifier taken/delayed/skipped/stopped
 *   - ambiguous    — classifier unknown/question
 *   - no response  — timeout `missed` (M13: a RESPONSE-RATE bucket, its own distinct
 *                    swatch, never folded into confirmed non-adherence)
 *   - unresolved   — denominator-eligible delivery with no classifier/timeout resolution yet
 *
 * D8 gotchas honoured: explicitly-sized wrapper div; gaps-not-nulls (the API omits
 * empty days — we never zero-fill); colours ONLY from CSS design tokens; and the sized
 * wrapper carries role="img" + an aria-label summarising the series. A screen-reader
 * table exposes every dated value rather than reducing the chart to aggregates.
 *
 * C7 (DESIGN-SPEC.md §3.2): the outcome breakdown paired colour with nothing else —
 * two of its four tones read close under a colour-vision deficiency. Each bucket now
 * carries a shape/glyph as the primary channel (Check / X / a ring / a dotted ring),
 * colour only as reinforcement, at the spec's ≥12px swatch floor.
 */

const BUCKETS = [
  {
    key: 'confirmed',
    label: 'confirmed response',
    color: 'var(--color-info-700)',
    Icon: Check,
  },
  {
    key: 'ambiguous',
    label: 'ambiguous',
    color: 'var(--color-warning-700)',
    Icon: HelpCircle,
  },
  {
    key: 'noResponse',
    label: 'no response',
    color: 'var(--color-danger-700)',
    Icon: X,
  },
  {
    key: 'unresolved',
    label: 'unresolved delivery',
    color: 'var(--color-ink-muted)',
    Icon: CircleDashed,
  },
] as const;

function formatDay(value: string): string {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf())) return value;
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

/** Format a 0–1 ratio as a whole-percent string, or an em-dash when null (never NaN). */
function formatPct(ratio: number | null): string {
  return ratio === null ? '—' : `${Math.round(ratio * 100)}%`;
}

function summarizeClassifications(series: CohortDay[]): {
  confirmed: number;
  ambiguous: number;
  noResponse: number;
  unresolved: number;
} {
  return series.reduce(
    (summary, day) => ({
      confirmed: summary.confirmed + day.confirmed,
      ambiguous: summary.ambiguous + day.ambiguous,
      noResponse: summary.noResponse + day.non_response,
      unresolved:
        summary.unresolved +
        Math.max(0, day.delivered - day.confirmed - day.ambiguous - day.non_response),
    }),
    { confirmed: 0, ambiguous: 0, noResponse: 0, unresolved: 0 },
  );
}

export function CohortChart({
  series,
  windowDays = 30,
}: {
  series: CohortDay[];
  windowDays?: CohortWindowDays;
}) {
  if (series.length === 0) {
    return (
      <EmptyState
        icon={<Activity size={24} />}
        title="No dose activity yet"
        description="Cohort adherence will appear after the first scheduled check-in has an outcome."
      />
    );
  }

  const data = toChartData(series);
  const { adherencePct, responsePct } = summarizeCohort(series);
  const classifications = summarizeClassifications(series);
  const outcomeCount =
    classifications.confirmed +
    classifications.ambiguous +
    classifications.noResponse +
    classifications.unresolved;
  const adherenceLabel = formatPct(adherencePct);
  const responseLabel = formatPct(responsePct);
  const ariaLabel = `${windowDays}-day cohort adherence chart: ${adherenceLabel} adherence among confirmed responses, ${responseLabel} response rate.`;

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(18rem,0.85fr)]">
      <section className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--elev-1)]">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-heading text-[var(--color-ink)]">
              Adherence trend
            </h2>
            <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
              Adherence among confirmed responses by day, last {windowDays} days
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold tracking-stat tabular-nums text-[var(--color-ink)]">
              {adherenceLabel}
            </p>
            <p className="font-[family-name:var(--font-mono)] text-xs uppercase tracking-mono text-[var(--color-ink-muted)]">
              response rate {responseLabel}
            </p>
          </div>
        </div>

        <p className="mb-2 flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
          <ArrowLeftRight aria-hidden="true" size={14} />
          Scroll horizontally to inspect all dates.
        </p>
        <div
          role="region"
          aria-label="Scrollable adherence chart"
          // A horizontal scroller must be keyboard-focusable for non-pointer users.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          className="w-full overflow-x-auto rounded-md"
        >
          <div role="img" aria-label={ariaLabel}>
            <div data-testid="adherence-chart" className="h-[230px] min-w-[720px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  accessibilityLayer
                  data={data}
                  margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
                >
                  <defs>
                    <linearGradient id="adherence-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.24} />
                      <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    vertical={false}
                    stroke="var(--color-border)"
                    strokeDasharray="3 3"
                  />
                  <XAxis
                    dataKey="day"
                    tickFormatter={formatDay}
                    tick={{ fill: 'var(--color-ink-muted)', fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={48}
                  />
                  <YAxis
                    domain={[0, 100]}
                    ticks={[0, 25, 50, 75, 100]}
                    tickFormatter={(value: number) => `${value}%`}
                    tick={{ fill: 'var(--color-ink-muted)', fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    width={42}
                  />
                  <Tooltip
                    labelFormatter={(label) => formatDay(String(label))}
                    formatter={(value) => [`${String(value)}%`, 'Adherence']}
                    contentStyle={{
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--color-surface)',
                      fontSize: 12,
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="adherencePct"
                    name="Adherence"
                    connectNulls={false}
                    isAnimationActive={false}
                    stroke="var(--color-accent)"
                    strokeWidth={2.5}
                    fill="url(#adherence-fill)"
                    activeDot={{ r: 4, fill: 'var(--color-accent)' }}
                    dot={{ r: 2.5, fill: 'var(--color-surface)', strokeWidth: 1.5 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        <div className="sr-only [contain:paint]">
          <table>
            <caption>Daily adherence data</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Adherence among confirmed responses</th>
                <th scope="col">Response rate</th>
                <th scope="col">Confirmed responses</th>
                <th scope="col">Ambiguous responses</th>
                <th scope="col">No response</th>
                <th scope="col">Unresolved delivery</th>
              </tr>
            </thead>
            <tbody>
              {data.map((point, index) => (
                <tr key={point.day}>
                  <th scope="row">{formatDay(point.day)}</th>
                  <td>
                    {point.adherencePct === null
                      ? 'Not available'
                      : `${Math.round(point.adherencePct)}%`}
                  </td>
                  <td>{formatPct(series[index]?.response_rate ?? null)}</td>
                  <td>{point.confirmed}</td>
                  <td>{point.ambiguous}</td>
                  <td>{point.noResponse}</td>
                  <td>{point.unresolved}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--elev-1)]">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-heading text-[var(--color-ink)]">
              All check-in outcomes
            </h2>
            <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
              Denominator-eligible delivered check-ins after the response window
            </p>
          </div>
          <span className="font-[family-name:var(--font-mono)] text-xs uppercase tracking-mono text-[var(--color-ink-muted)]">
            {outcomeCount} outcomes
          </span>
        </div>

        <ul className="space-y-5">
          {BUCKETS.map(({ key, label, color, Icon }) => {
            const count = classifications[key];
            const percentage = outcomeCount > 0 ? Math.round((count / outcomeCount) * 100) : 0;
            return (
              <li key={key}>
                <div className="mb-2 flex items-center justify-between gap-3 text-sm">
                  <span className="flex items-center gap-2 text-[var(--color-ink)]">
                    <span
                      aria-hidden="true"
                      className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full"
                      style={{ backgroundColor: color }}
                    >
                      <Icon className="text-[var(--color-surface)]" size={9} strokeWidth={3} />
                    </span>
                    {label}
                  </span>
                  <span className="font-[family-name:var(--font-mono)] text-xs tabular-nums text-[var(--color-ink-muted)]">
                    {count} · {percentage}%
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-canvas-raised)]">
                  <span
                    aria-hidden="true"
                    className="block h-full rounded-full"
                    style={{ backgroundColor: color, width: `${percentage}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>

        <p className="mt-6 border-t border-[var(--color-border)] pt-4 text-xs leading-5 text-[var(--color-ink-muted)]">
          No response is reported separately from confirmed medication behavior.
          {classifications.unresolved > 0 && (
            <>
              {' '}
              Unresolved delivery means delivered but not yet resolved by a classifier or timeout;
              it is an operational gap, not a medication-behavior result.
            </>
          )}
        </p>
      </section>
    </div>
  );
}
