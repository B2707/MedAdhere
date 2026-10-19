// infra/lib/constructs/monitoring.ts
//
// MonitoringConstruct (OPS-02 / Plan 05-04) creates the CloudWatch alarms and metric filters used for
// operational inspection. The user removed OPS-02 email delivery on 2026-08-04, so the construct has no
// SNS topic, subscription, KMS alarm-topic key, or alarm action. Alarms remain visible in CloudWatch;
// safety and classification work remains visible in the dashboard review queues.
//
// Alarm inventory (12 CloudWatch alarms):
//   (b) pipeline errors — native AWS/Lambda Errors via in-process `.metricErrors()` (D-12; never a
//       hand-built metric with a functionName string) on EXACTLY six fns: inbound, outbound,
//       classifier, enroll, timeout, export. The deactivation fn is deliberately NOT alarmed (05-03: its
//       failure signal is the data-API 5xx + error log).
//   (c) DLQ depth >= 1 — AWS/SQS ApproximateNumberOfMessagesVisible on the FIFO redrive DLQ.
//   (a) safety insert — metric filter on the classifier + inbound log groups for the canonical id-only
//       `safety_event_recorded` line (Q6) → a next-business-day-review alarm.
//   (d) Anthropic failure — metric filters for `anthropic_auth_failure` + `classifier_transient_exhausted`
//       (M8/Q7: an Anthropic throw writes an `unknown` row and returns success — it never DLQs, so the
//       filter IS the signal; NOT any Bedrock namespace — D-BEDROCK-REMOVED).
//   (g) H6 emergency-routing failure — a DISTINCT urgent alarm watching current failure signals:
//       `classifier_safety_send_failed` for the model-side REST send, plus
//       `inbound_emergency_persistence_failed` when emergency intake cannot persist and
//       `inbound_safety_reserve_failed` when the stored emergency cannot create its review row.
//       The fixed inbound TwiML still returns 200 on persistence failure; the alarm protects the
//       clinician-review trail. Removed inbound REST-send/divert metrics are intentionally absent.
//   (h) M9 — metric filters for `timeout_schedule_failed` (the OUTBOUND log group — F1) +
//       `classifier_contract_failure`.
//   (f) >=2-consecutive-undelivered — a metric filter for the status-callback-derived `consecutive_undelivered`.
// (e) billing is NOT duplicated here — the account-wide cost backstop is BudgetsConstruct (cross-referenced
//     in tests). This construct creates no Budget.
//
// H3: every log group here is an in-process ref passed by FoundationStack (F2) — the CDK-generated log
// group names make `fromLogGroupName` unavailable.

import { Construct } from 'constructs';
import { Duration } from 'aws-cdk-lib';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import type { IQueue } from 'aws-cdk-lib/aws-sqs';

/** The custom-metric namespace all OPS-02 metric-filter metrics live in. */
const OPS_NAMESPACE = 'MedAdhere/OPS';
/** Alarm on the FIRST occurrence (>= 1) — one bad event is worth an operator's attention. */
const ALARM_THRESHOLD = 1;
/** Pipeline-error evaluation window (the plan's "error-rate > 0 / 15 min"). */
const PIPELINE_ERROR_PERIOD_MIN = 15;
/** DLQ-depth sampling window (a single message parked in a terminal DLQ should alarm). */
const DLQ_PERIOD_MIN = 5;
/** Metric-filter alarm window (safety / anthropic / emergency / timeout-contract / undelivered). */
const FILTER_ALARM_PERIOD_MIN = 15;

export interface MonitoringConstructProps {
  // (b) the EXACTLY-six alarmed pipeline fns (in-process refs — D-12; `.metricErrors()` binds each
  //     FunctionName dimension to the fn's own name token, never a hand-built string).
  readonly inboundFn: IFunction;
  readonly outboundFn: IFunction;
  readonly classifierFn: IFunction;
  readonly enrollFn: IFunction;
  readonly timeoutFn: IFunction;
  readonly exportFn: IFunction;
  // (c) the one terminal FIFO redrive DLQ.
  readonly redriveDlq: IQueue;
  // The four H3-exposed log groups the metric filters read (in-process — F1: outbound carries the
  // timeout_schedule_failed line).
  readonly classifierLogGroup: logs.ILogGroup;
  readonly inboundLogGroup: logs.ILogGroup;
  readonly statusCallbackLogGroup: logs.ILogGroup;
  readonly outboundLogGroup: logs.ILogGroup;
}

export class MonitoringConstruct extends Construct {
  constructor(scope: Construct, id: string, props: MonitoringConstructProps) {
    super(scope, id);

    // Shared alarm factory — threshold >= 1, single period, missing data is not-breaching (idle == OK).
    const makeAlarm = (alarmId: string, metric: cw.IMetric, description: string): cw.Alarm => {
      const alarm = new cw.Alarm(this, alarmId, {
        metric,
        threshold: ALARM_THRESHOLD,
        evaluationPeriods: 1,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      });
      return alarm;
    };

    // Shared metric-filter factory — one filter per canonical id-only line (all feeding one custom
    // metric so a group's alarm fires when ANY of its lines appears). Returns the summed metric.
    const filterAlarmMetric = (
      metricName: string,
      lines: ReadonlyArray<{ id: string; logGroup: logs.ILogGroup; lineMetric: string }>,
    ): cw.Metric => {
      for (const line of lines) {
        new logs.MetricFilter(this, line.id, {
          logGroup: line.logGroup,
          // The canonical id-only JSON pattern: `{ $.metric = "<name>" }` — matches
          // console.log(JSON.stringify({ metric: '<name>', ...ids })) (Q6/L3 established pattern).
          filterPattern: logs.FilterPattern.stringValue('$.metric', '=', line.lineMetric),
          metricNamespace: OPS_NAMESPACE,
          metricName,
          metricValue: '1',
          defaultValue: 0, // emit 0 on non-match so the alarm has continuous data (no INSUFFICIENT_DATA gaps)
        });
      }
      return new cw.Metric({
        namespace: OPS_NAMESPACE,
        metricName,
        statistic: 'Sum',
        period: Duration.minutes(FILTER_ALARM_PERIOD_MIN),
      });
    };

    // --- (b) pipeline-error alarms — EXACTLY the six fns via in-process .metricErrors() (D-12) ---------
    const errorFns: ReadonlyArray<{ id: string; fn: IFunction }> = [
      { id: 'InboundErrorsAlarm', fn: props.inboundFn },
      { id: 'OutboundErrorsAlarm', fn: props.outboundFn },
      { id: 'ClassifierErrorsAlarm', fn: props.classifierFn },
      { id: 'EnrollErrorsAlarm', fn: props.enrollFn },
      { id: 'TimeoutErrorsAlarm', fn: props.timeoutFn },
      { id: 'ExportAnonErrorsAlarm', fn: props.exportFn },
    ];
    for (const { id: alarmId, fn } of errorFns) {
      makeAlarm(
        alarmId,
        fn.metricErrors({ period: Duration.minutes(PIPELINE_ERROR_PERIOD_MIN), statistic: 'Sum' }),
        `OPS-02 (b) pipeline error: ${alarmId} — AWS/Lambda Errors >= 1 / ${PIPELINE_ERROR_PERIOD_MIN} min`,
      );
    }

    // --- (c) one FIFO redrive DLQ-depth alarm ---------------------------------------------------------
    makeAlarm(
      'TurnRedriveDlqDepthAlarm',
      props.redriveDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(DLQ_PERIOD_MIN),
        statistic: 'Maximum',
      }),
      'OPS-02 (c) turn redrive DLQ depth >= 1 — a parked patient wake needs operator review',
    );

    // --- (a) safety insert → next-business-day review (Q6) --------------------------------------------
    makeAlarm(
      'SafetyEventRecordedAlarm',
      filterAlarmMetric('SafetyEventRecorded', [
        {
          id: 'SafetyEventRecordedClassifierFilter',
          logGroup: props.classifierLogGroup,
          lineMetric: 'safety_event_recorded',
        },
        {
          id: 'SafetyEventRecordedInboundFilter',
          logGroup: props.inboundLogGroup,
          lineMetric: 'safety_event_recorded',
        },
      ]),
      'OPS-02 (a) a safety_events row was recorded — clinician next-business-day review (Q6).',
    );

    // --- (d) Anthropic failure — the metric filter IS the signal (M8: it never DLQs) ------------------
    makeAlarm(
      'AnthropicFailureAlarm',
      filterAlarmMetric('AnthropicFailure', [
        {
          id: 'AnthropicAuthFailureFilter',
          logGroup: props.classifierLogGroup,
          lineMetric: 'anthropic_auth_failure',
        },
        {
          id: 'ClassifierTransientExhaustedFilter',
          logGroup: props.classifierLogGroup,
          lineMetric: 'classifier_transient_exhausted',
        },
      ]),
      'OPS-02 (d) Anthropic auth failure or exhausted transients — the classifier wrote an unknown row ' +
        '(never DLQs — M8); rotate/fund the key or investigate the outage.',
    );

    // --- (g) H6 emergency-routing failure — a DISTINCT URGENT alarm from (a) --------------------------
    // The classifier still owns its model-side safety REST send. Inbound now returns fixed emergency
    // TwiML directly, so its live failure signals are intake persistence and safety-row persistence.
    makeAlarm(
      'EmergencyRoutingFailureAlarm',
      filterAlarmMetric('EmergencyRoutingFailure', [
        {
          id: 'ClassifierSafetySendFailedFilter',
          logGroup: props.classifierLogGroup,
          lineMetric: 'classifier_safety_send_failed',
        },
        {
          id: 'InboundEmergencyPersistenceFailedFilter',
          logGroup: props.inboundLogGroup,
          lineMetric: 'inbound_emergency_persistence_failed',
        },
        {
          id: 'InboundSafetyReserveFailedFilter',
          logGroup: props.inboundLogGroup,
          lineMetric: 'inbound_safety_reserve_failed',
        },
      ]),
      'OPS-02 (g) URGENT (H6): emergency response or review routing failed — the model-side safety ' +
        'send failed, emergency intake could not persist, or its review row could not be recorded.',
    );

    // --- (h) M9 — timeout-schedule (OUTBOUND log group, F1) + classifier-contract failure -------------
    makeAlarm(
      'TimeoutOrContractFailureAlarm',
      filterAlarmMetric('TimeoutOrContractFailure', [
        {
          id: 'TimeoutScheduleFailedFilter',
          logGroup: props.outboundLogGroup, // F1 — outbound/handler.ts emits timeout_schedule_failed
          lineMetric: 'timeout_schedule_failed',
        },
        {
          id: 'ClassifierContractFailureFilter',
          logGroup: props.classifierLogGroup,
          lineMetric: 'classifier_contract_failure',
        },
      ]),
      'OPS-02 (h/M9) a timeout one-shot failed to schedule (non-response detection at risk) or the ' +
        'classifier hit a contract failure.',
    );

    // --- (f) >=2-consecutive-undelivered (status-callback-derived) ------------------------------------
    makeAlarm(
      'ConsecutiveUndeliveredAlarm',
      filterAlarmMetric('ConsecutiveUndelivered', [
        {
          id: 'ConsecutiveUndeliveredFilter',
          logGroup: props.statusCallbackLogGroup,
          lineMetric: 'consecutive_undelivered',
        },
      ]),
      'OPS-02 (f) a patient has >= 2 consecutive undelivered/failed SMS — the number may be wrong or ' +
        'the patient unreachable; the cohort denominator is at risk.',
    );
  }
}
