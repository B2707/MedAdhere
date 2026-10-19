import { Clock } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertStack } from '@/components/alert-stack';
import { AppShell } from '@/components/app-shell';
import { AutoRefresh } from '@/components/auto-refresh';
import { DayBar } from '@/components/day-thread/day-bar';
import { DayThread } from '@/components/day-thread/day-thread';
import { computeCensus, mergeThread } from '@/components/day-thread/thread-merge';
import { DaySummarySection } from '@/components/day-summary-section';
import { MedicationsHistoryPanel } from '@/components/medications-history-panel';
import { AdherenceOutcomeChart, SymptomSeverityChart } from '@/components/patient-trend-charts';
import { TimelineChart } from '@/components/timeline-chart';
import { VersionTimeline } from '@/components/version-timeline';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardToolbar } from '@/components/ui/card';
import { CollapsiblePanel } from '@/components/ui/collapsible';
import { apiFetch } from '@/lib/api';
import { resolvedOutcomeCount } from '@/lib/timeline-metrics';
import { PatientActions } from './patient-actions';
import { PatientHeaderStrip } from './patient-header';
import {
  patientRecordResponseSchema,
  type PatientRecordResponse,
  type TimelineRow,
} from '@/lib/dashboard-contracts';

/*
 * page.tsx — the patient record page composition (DESIGN-SPEC.md §4.0, §5 Lane D).
 * Owns ONLY composition: fetch, validate params, lay out the sections other lanes
 * exported — the Day Thread (Lane C) — plus this lane's own header strip /
 * alerts-in-window list / admin sheet.
 * Deleted: "Patient overview" + "Latest classification" (folded into the header strip,
 * R6/R9), the full AlertStack card + QueuePagination (R5/R7 — alerts are now thread
 * marks plus a compact deep-link list), the always-empty drug-label section (R8 —
 * `drug-label-panel.tsx` stays in the tree, unmounted). The draft-review UI (Lane F's
 * `draft-review.tsx`) is unmounted too (owner-approved, 2026-08-17): nothing in the
 * system writes a clinician reply-draft yet, so the panel and the thread's draft row
 * were both a dead surface — `draft-review.tsx` stays in the tree untouched, the
 * feature returns once a draft writer exists.
 */

export const dynamic = 'force-dynamic';

interface PatientDetailPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

type WindowDays = 7 | 30 | 90;

interface RecordParams {
  days: WindowDays;
  day?: string;
}

const DAY_VIEW_LABEL = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function validLocalDate(value: string | undefined): string | undefined {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

function parseRecordParams(
  searchParams: Record<string, string | string[] | undefined>,
): RecordParams {
  const rawDays = one(searchParams.days);
  const days: WindowDays = rawDays === '7' ? 7 : rawDays === '90' ? 90 : 30;
  return { days, day: validLocalDate(one(searchParams.day)) };
}

function queryString(params: RecordParams): string {
  const query = new URLSearchParams({ days: String(params.days) });
  if (params.day !== undefined) query.set('day', params.day);
  return query.toString();
}

function patientHref(patientId: string, params: RecordParams): string {
  return `/patients/${encodeURIComponent(patientId)}?${queryString(params)}`;
}

/**
 * The collapsed row must not promise more than the open row can show: scheduled doses exist long
 * before any of them resolve, and the chart plots only resolved outcomes. Same predicate as the
 * chart (`resolvedOutcomeCount`), so the header and the body can never disagree.
 */
function doseTimelineStatus(timeline: TimelineRow[]): string {
  if (timeline.length === 0) return 'No data yet';
  const doses = `${timeline.length} dose${timeline.length === 1 ? '' : 's'}`;
  return resolvedOutcomeCount(timeline) === 0
    ? `${doses} · no resolved outcomes yet`
    : `${doses} in window`;
}

function ErrorState({
  title,
  message,
  signIn = false,
}: {
  title: string;
  message: string;
  signIn?: boolean;
}) {
  return (
    <AppShell
      pageTitle="Patient detail"
      pageDescription="Medication adherence and stored label context."
    >
      <AutoRefresh isAuthenticated={false} />
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent className="mt-4 flex flex-col items-start gap-4">
          <p>{message}</p>
          {signIn ? (
            <form action="/api/auth/login" method="get">
              <Button type="submit" variant="primary">
                Sign in
              </Button>
            </form>
          ) : (
            <Link
              href="/patients"
              className="font-semibold text-[var(--color-accent)] underline underline-offset-2"
            >
              Back to patients
            </Link>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}

export default async function PatientDetailPage({ params, searchParams }: PatientDetailPageProps) {
  const [{ id }, rawSearchParams] = await Promise.all([params, searchParams]);
  const requestParams = parseRecordParams(rawSearchParams);
  const result = await apiFetch(
    `/api/patients/${encodeURIComponent(id)}/record?${queryString(requestParams)}`,
    patientRecordResponseSchema,
    { includeNotFound: true },
  );

  if (result.status === 'not_found') notFound();

  if (result.status === 'unauthenticated') {
    return (
      <ErrorState
        title="You’re not signed in"
        message="Your session has expired or you’re not signed in. Sign in to continue."
        signIn
      />
    );
  }

  if (result.status === 'error') {
    return (
      <ErrorState
        title="Couldn’t load this patient"
        message="The patient detail could not be loaded. This is usually temporary."
      />
    );
  }

  const {
    patient,
    timeline,
    timelineWindowDays,
    window,
    dayIndex,
    daySummary,
    messages,
    events,
    evidence,
    versions,
    alertsPage,
    history,
    trends,
  }: PatientRecordResponse = result.data;
  const dayLinks = dayIndex.map((day) => ({
    localDate: day.local_date,
    selected: day.local_date === window.selectedDay,
    href: patientHref(patient.id, { days: window.days, day: day.local_date }),
    hasSummary: day.latest_summary_version !== null,
  }));
  const dayViewLabel = DAY_VIEW_LABEL.format(new Date(`${window.selectedDay}T00:00:00.000Z`));
  const receivingCheckIns = patient.is_active && patient.agent_enabled && patient.provider_opted_in;
  const threadItems = mergeThread({ messages, events, evidence, daySummary });
  const census = computeCensus(threadItems);

  return (
    <AppShell
      pageTitle={patient.display_name?.trim() || patient.phone}
      pageDescription={`${patient.medication_name} · ${patient.phone}`}
      headerSlot={`${timelineWindowDays}-day view`}
      pageActions={
        <PatientActions
          patientId={patient.id}
          isActive={patient.is_active}
          agentEnabled={patient.agent_enabled}
          providerOptedIn={patient.provider_opted_in}
          messagingStateVersion={patient.messaging_state_version}
          reminderLimit={patient.reminder_limit}
          displayName={patient.display_name}
          phone={patient.phone}
        />
      }
    >
      <AutoRefresh />
      <div className="flex min-w-0 flex-col gap-8">
        <PatientHeaderStrip
          patient={patient}
          receivingCheckIns={receivingCheckIns}
          timeline={timeline}
        />
        {dayLinks.length > 0 && (
          <DayBar dayLinks={dayLinks} selectedDay={window.selectedDay} census={census} />
        )}
        <DaySummarySection summary={daySummary} evidence={evidence} />
        <DayThread
          messages={messages}
          events={events}
          evidence={evidence}
          daySummary={daySummary}
          timeZone={patient.timezone}
          dayLabel={dayViewLabel}
        />
        <AlertStack alerts={alertsPage.items} patientId={patient.id} days={window.days} />
        <Card
          role="region"
          aria-labelledby="trends-record-title"
          className="min-w-0 divide-y divide-[var(--color-border)] overflow-hidden p-0"
        >
          <CardToolbar className="p-5 sm:p-6">
            <CardTitle id="trends-record-title">Trends &amp; record</CardTitle>
            <nav aria-label="Record window" className="flex flex-wrap gap-2">
              {([7, 30, 90] as const).map((days) => (
                <Link
                  key={days}
                  href={patientHref(patient.id, { days, day: window.selectedDay })}
                  aria-current={days === window.days ? 'page' : undefined}
                  className={`inline-flex min-h-9 items-center rounded-[var(--radius-md)] border px-3 text-sm font-semibold focus-visible:focus-inset ${
                    days === window.days
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent-50)] text-[var(--color-accent)]'
                      : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)]'
                  }`}
                >
                  {days} days
                </Link>
              ))}
            </nav>
          </CardToolbar>
          <CollapsiblePanel
            title={`Dose timeline · last ${timelineWindowDays} days`}
            titleId="dose-timeline-title"
            status={doseTimelineStatus(timeline)}
            defaultOpen={timeline.length > 0}
          >
            <p className="mb-4 flex items-center gap-1.5 text-sm text-[var(--color-ink-muted)]">
              <Clock aria-hidden="true" size={14} />
              Outcomes use the patient&apos;s local dose date and time.
            </p>
            <TimelineChart rows={timeline} />
          </CollapsiblePanel>
          <SymptomSeverityChart series={trends.severity} />
          <AdherenceOutcomeChart series={trends.adherence} />
          <MedicationsHistoryPanel history={history} />
          <VersionTimeline versions={versions} timeZone={patient.timezone} />
        </Card>
      </div>
    </AppShell>
  );
}
