'use client';

import { useState } from 'react';
import { Activity, LineChart as LineChartIcon } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CollapsiblePanel } from '@/components/ui/collapsible';
import { ChartLegend } from '@/components/ui/chart-legend';
import { EmptyState } from '@/components/ui/empty-state';
import type { PatientTrends } from '@/lib/dashboard-contracts';

/*
 * patient-trend-charts.tsx — the two per-patient trend charts (08-06 acceptance):
 *
 *   1. worst symptom severity per patient-local day, one line per symptom
 *   2. daily count per adherence outcome
 *
 * 'use client' because these are interactive; the RSC page passes plain serializable props
 * straight from the parsed trends payload. D8 gotchas honoured: an explicitly sized wrapper,
 * `accessibilityLayer`, colours from CSS design tokens ONLY, gaps rather than zero-fill (a
 * day with no observation is not a day with severity zero), and a `role="img"` wrapper whose
 * label summarises the series. A screen-reader table exposes every dated value, because the
 * chart's own shape is not readable and the numbers are the clinical content.
 *
 * Clinical Swiss token pass (DESIGN-SPEC.md §5 Lane F): C7 replaces Recharts' unstyled default
 * `<Legend />` with the one shared `<ChartLegend>` (token type, toggleable per series). A11 —
 * `SYMPTOM_COLORS` still cycles 6 tokens, so a 7th+ symptom repeats a colour; a PARALLEL, shorter
 * `SYMPTOM_DASH_PATTERNS` cycle (length 4, coprime-ish with 6) means the repeat never lands on the
 * same dash pattern too, so the legend's stroke-preview glyph keeps disambiguating past 6 series.
 */

/** Token-only categorical palette, cycled. The legend and table carry the identity. */
const SYMPTOM_COLORS = [
  'var(--color-accent-graphic)',
  'var(--color-info-700)',
  'var(--color-warning-700)',
  'var(--color-danger-700)',
  'var(--color-success-700)',
  'var(--color-neutral-700)',
] as const;

/** A11: parallel dash cycle, deliberately a DIFFERENT length than the colour cycle (LCM(6,4)=12)
 *  so a symptom that repeats a colour past index 5 still gets a fresh dash pattern. */
const SYMPTOM_DASH_PATTERNS = [undefined, '6 3', '2 2', '10 3 2 3'] as const;

/** The six adherence outcomes, in the order the contract declares them. */
const OUTCOMES = [
  { key: 'taken', label: 'taken', color: 'var(--color-success-700)' },
  { key: 'delayed', label: 'delayed', color: 'var(--color-warning-700)' },
  { key: 'skipped', label: 'skipped', color: 'var(--color-accent-graphic)' },
  { key: 'stopped', label: 'stopped', color: 'var(--color-danger-700)' },
  { key: 'unknown', label: 'unknown', color: 'var(--color-neutral-700)' },
  { key: 'question', label: 'question', color: 'var(--color-info-700)' },
] as const;

const AXIS_TICK = { fill: 'var(--color-ink-muted)', fontSize: 12 } as const;
const TOOLTIP_STYLE = {
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--color-surface)',
  fontSize: 12,
} as const;

export interface SeverityChartPoint {
  day: string;
  [symptom: string]: string | number;
}

/**
 * Pivot the flat severity series into one row per local day with one key per symptom.
 *
 * A symptom the patient did not report on a given day is left ABSENT rather than set to
 * zero: zero is not a severity the 1–10 scale can express, and a zero-filled point would
 * draw a line through a day the patient never spoke about.
 */
export function toSeverityChartData(series: PatientTrends['severity']): {
  data: SeverityChartPoint[];
  symptoms: string[];
} {
  const byDay = new Map<string, SeverityChartPoint>();
  const symptoms: string[] = [];

  for (const row of series) {
    if (!symptoms.includes(row.symptom)) symptoms.push(row.symptom);
    const point = byDay.get(row.local_date) ?? { day: row.local_date };
    const existing = point[row.symptom];
    // "Worst per day": a duplicated day/symptom pair keeps the higher severity.
    point[row.symptom] =
      typeof existing === 'number' ? Math.max(existing, row.max_severity) : row.max_severity;
    byDay.set(row.local_date, point);
  }

  // ISO `YYYY-MM-DD` sorts lexicographically, so this is calendar order.
  const observed = [...byDay.values()].sort((left, right) => (left.day < right.day ? -1 : 1));
  const data: SeverityChartPoint[] = [];
  let previousObservedDay: string | null = null;
  for (const point of observed) {
    if (previousObservedDay !== null) {
      const nextDay = new Date(Date.parse(`${previousObservedDay}T00:00:00Z`) + 86_400_000)
        .toISOString()
        .slice(0, 10);
      if (nextDay < point.day) data.push({ day: nextDay });
    }
    data.push(point);
    previousObservedDay = point.day;
  }

  return { data, symptoms: [...symptoms].sort() };
}

/** One collapsible trend row inside the page's flat record-sections card. */
function ChartPanel({
  id,
  title,
  status,
  defaultOpen,
  description,
  children,
}: {
  id: string;
  title: string;
  status: string;
  defaultOpen: boolean;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <CollapsiblePanel title={title} titleId={id} status={status} defaultOpen={defaultOpen}>
      <p className="mb-4 text-sm text-[var(--color-ink-muted)]">{description}</p>
      {children}
    </CollapsiblePanel>
  );
}

/** Toggle a key in/out of a hidden-series Set, immutably (never mutate the caller's state). */
function toggleHidden(hidden: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(hidden);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function SymptomSeverityChart({ series }: { series: PatientTrends['severity'] }) {
  const { data, symptoms } = toSeverityChartData(series);
  const observedDays = new Set(series.map((row) => row.local_date)).size;
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const visibleSymptoms = symptoms.filter((symptom) => !hidden.has(symptom));

  return (
    <ChartPanel
      id="symptom-severity-title"
      title="Worst symptom severity by day"
      status={
        data.length === 0
          ? 'No data yet'
          : `${symptoms.length} symptom${symptoms.length === 1 ? '' : 's'} · ${observedDays} observed day${observedDays === 1 ? '' : 's'}`
      }
      defaultOpen={data.length > 0}
      description="The highest severity the patient reported for each symptom on each of their local days."
    >
      {data.length === 0 ? (
        <EmptyState
          icon={<LineChartIcon size={24} />}
          title="No symptom reported yet"
          description="Severity appears here once the patient rates a symptom in conversation."
          className="min-h-0 py-6"
        />
      ) : (
        <>
          <ChartLegend
            ariaLabel="Symptom series"
            className="mb-4"
            hiddenKeys={hidden}
            onToggle={(key) => setHidden((current) => toggleHidden(current, key))}
            items={symptoms.map((symptom, index) => ({
              key: symptom,
              label: symptom,
              color: SYMPTOM_COLORS[index % SYMPTOM_COLORS.length]!,
              shape: 'line',
              dashArray: SYMPTOM_DASH_PATTERNS[index % SYMPTOM_DASH_PATTERNS.length],
            }))}
          />

          <div
            role="img"
            aria-label={`Worst symptom severity by day: ${symptoms.length} symptoms across ${observedDays} observed days, rated 1 to 10.`}
          >
            <div className="h-[240px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  accessibilityLayer
                  data={data}
                  margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
                >
                  <CartesianGrid
                    vertical={false}
                    stroke="var(--color-border)"
                    strokeDasharray="3 3"
                  />
                  <XAxis
                    dataKey="day"
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={32}
                  />
                  <YAxis
                    domain={[1, 10]}
                    ticks={[1, 2, 4, 6, 8, 10]}
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    width={28}
                  />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  {symptoms.map((symptom, index) => (
                    <Line
                      key={symptom}
                      type="monotone"
                      dataKey={symptom}
                      name={symptom}
                      connectNulls={false}
                      isAnimationActive={false}
                      hide={!visibleSymptoms.includes(symptom)}
                      stroke={SYMPTOM_COLORS[index % SYMPTOM_COLORS.length]}
                      strokeDasharray={SYMPTOM_DASH_PATTERNS[index % SYMPTOM_DASH_PATTERNS.length]}
                      strokeWidth={2.5}
                      dot={{ r: 2.5 }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="sr-only [contain:paint]">
            <table>
              <caption>Worst symptom severity by day</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  {symptoms.map((symptom) => (
                    <th key={symptom} scope="col">
                      {symptom}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((point) => (
                  <tr key={point.day}>
                    <th scope="row">{point.day}</th>
                    {symptoms.map((symptom) => (
                      <td key={symptom}>
                        {typeof point[symptom] === 'number' ? point[symptom] : 'Not reported'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </ChartPanel>
  );
}

export function AdherenceOutcomeChart({ series }: { series: PatientTrends['adherence'] }) {
  const total = series.reduce(
    (sum, day) => sum + OUTCOMES.reduce((daySum, outcome) => daySum + day[outcome.key], 0),
    0,
  );
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  return (
    <ChartPanel
      id="adherence-outcome-title"
      title="Daily adherence outcomes"
      status={
        series.length === 0
          ? 'No data yet'
          : `${total} outcome${total === 1 ? '' : 's'} · ${series.length} day${series.length === 1 ? '' : 's'}`
      }
      defaultOpen={series.length > 0}
      description="How many doses landed in each outcome on each of the patient's local days."
    >
      {series.length === 0 ? (
        <EmptyState
          icon={<Activity size={24} />}
          title="No adherence outcome yet"
          description="Outcomes appear here once a scheduled dose is resolved from a patient reply."
          className="min-h-0 py-6"
        />
      ) : (
        <>
          <ChartLegend
            ariaLabel="Adherence outcome series"
            className="mb-4"
            hiddenKeys={hidden}
            onToggle={(key) => setHidden((current) => toggleHidden(current, key))}
            items={OUTCOMES.map((outcome) => ({
              key: outcome.key,
              label: outcome.label,
              color: outcome.color,
            }))}
          />

          <div
            role="img"
            aria-label={`Daily adherence outcomes: ${total} recorded outcomes across ${series.length} days.`}
          >
            <div className="h-[240px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  accessibilityLayer
                  data={series}
                  margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
                >
                  <CartesianGrid
                    vertical={false}
                    stroke="var(--color-border)"
                    strokeDasharray="3 3"
                  />
                  <XAxis
                    dataKey="local_date"
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={32}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={AXIS_TICK}
                    tickLine={false}
                    axisLine={false}
                    width={28}
                  />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  {OUTCOMES.map((outcome) => (
                    <Bar
                      key={outcome.key}
                      dataKey={outcome.key}
                      name={outcome.key}
                      stackId="outcomes"
                      isAnimationActive={false}
                      hide={hidden.has(outcome.key)}
                      fill={outcome.color}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="sr-only [contain:paint]">
            <table>
              <caption>Adherence outcomes by day</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  {OUTCOMES.map((outcome) => (
                    <th key={outcome.key} scope="col">
                      {outcome.key}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {series.map((day) => (
                  <tr key={day.local_date}>
                    <th scope="row">{day.local_date}</th>
                    {OUTCOMES.map((outcome) => (
                      <td key={outcome.key}>{day[outcome.key]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </ChartPanel>
  );
}
