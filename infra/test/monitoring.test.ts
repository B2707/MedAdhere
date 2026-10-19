// infra/test/monitoring.test.ts
//
// The OPS-02 monitoring/alerting SHAPE gate (Plan 05-04). Uses aws-cdk-lib/assertions
// `Template.fromStack` to prove the synthesized CloudFormation for MonitoringConstruct has the correct
// alarm inventory + metric-filter patterns WITHOUT any live AWS call, no network, no DB.
//
// Pins (the RED contract):
//   - ZERO SNS, KMS, subscription, or alarm-action resources. The user removed OPS-02 email delivery;
//     monitoring remains visible in CloudWatch and the dashboard review queues remain the operator path.
//   - Exactly SIX AWS/Lambda Errors alarms (inbound/outbound/classifier/enroll/timeout/export) via in-process
//     .metricErrors() (D-12 — the FunctionName dimension is a CFN ref, never a hand-built string).
//   - Exactly ONE AWS/SQS ApproximateNumberOfMessagesVisible alarm for the FIFO redrive DLQ.
//   - FIVE metric-filter-fed custom alarms: safety insert (a), Anthropic failure (d), emergency-routing
//     failure (g, distinct urgent), timeout/contract failure (h), consecutive-undelivered (f).
//   - TEN metric filters carrying the canonical id-only `$.metric = "<name>"` pattern strings, with the
//     (h) `timeout_schedule_failed` filter reading the OUTBOUND log group (F1) and the (g) emergency group
//     carrying THREE current signals (classifier send failure + inbound intake/persistence failures).
//   - The construct creates NO Budget (billing (e) stays the BudgetsConstruct's job — cross-referenced).

import { describe, it, expect } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { MonitoringConstruct } from '../lib/constructs/monitoring.js';

function stubFn(stack: Stack, id: string): lambda.Function {
  return new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => {};'),
  });
}

function synth() {
  const app = new App();
  const stack = new Stack(app, 'TestMonitoring', {
    env: { account: '123456789012', region: 'us-east-1' },
  });

  const inboundFn = stubFn(stack, 'InboundFn');
  const outboundFn = stubFn(stack, 'OutboundFn');
  const classifierFn = stubFn(stack, 'ClassifierFn');
  const enrollFn = stubFn(stack, 'EnrollFn');
  const timeoutFn = stubFn(stack, 'TimeoutFn');
  const exportFn = stubFn(stack, 'ExportAnonFn');

  const redriveDlq = new sqs.Queue(stack, 'TurnRedriveDlq');

  const classifierLogGroup = new logs.LogGroup(stack, 'ClassifierLogs');
  const inboundLogGroup = new logs.LogGroup(stack, 'InboundLogs');
  const statusCallbackLogGroup = new logs.LogGroup(stack, 'StatusCallbackLogs');
  const outboundLogGroup = new logs.LogGroup(stack, 'OutboundLogs');

  const monitoring = new MonitoringConstruct(stack, 'Monitoring', {
    inboundFn,
    outboundFn,
    classifierFn,
    enrollFn,
    timeoutFn,
    exportFn,
    redriveDlq,
    classifierLogGroup,
    inboundLogGroup,
    statusCallbackLogGroup,
    outboundLogGroup,
  });

  return { stack, template: Template.fromStack(stack), monitoring };
}

/** Collect the FilterPattern strings across all synthesized metric filters. */
function filterPatterns(template: Template): string[] {
  const filters = template.findResources('AWS::Logs::MetricFilter');
  return Object.values(filters).map(
    (f) => (f.Properties as { FilterPattern: string }).FilterPattern,
  );
}

describe('MonitoringConstruct — CloudWatch only, with no OPS-02 email delivery', () => {
  it('creates no SNS topic, subscription, topic policy, or alarm-topic KMS key', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::SNS::Topic', 0);
    template.resourceCountIs('AWS::SNS::Subscription', 0);
    template.resourceCountIs('AWS::SNS::TopicPolicy', 0);
    template.resourceCountIs('AWS::KMS::Key', 0);
  });
});

describe('MonitoringConstruct — (b) pipeline-error alarms: EXACTLY the six fns via in-process metricErrors (D-12)', () => {
  it('creates SIX AWS/Lambda Errors alarms — inbound/outbound/classifier/enroll/timeout/export, no more', () => {
    const { template } = synth();
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const errorAlarms = Object.values(alarms).filter((a) => {
      const p = a.Properties as { Namespace?: string; MetricName?: string };
      return p.Namespace === 'AWS/Lambda' && p.MetricName === 'Errors';
    });
    // Exactly six — the deactivation fn is deliberately NOT alarmed (05-03: its 5xx + error log is the signal).
    expect(errorAlarms.length).toBe(6);
    expect(JSON.stringify(errorAlarms)).toContain('ExportAnonFn');
  });

  it('D-12: each Errors alarm binds FunctionName to a CFN ref (in-process .metricErrors()), never a hand-built string', () => {
    const { template } = synth();
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const errorAlarms = Object.values(alarms).filter((a) => {
      const p = a.Properties as { Namespace?: string; MetricName?: string };
      return p.Namespace === 'AWS/Lambda' && p.MetricName === 'Errors';
    });
    for (const alarm of errorAlarms) {
      const dims = (alarm.Properties as { Dimensions: Array<{ Name: string; Value: unknown }> })
        .Dimensions;
      const fnDim = dims.find((d) => d.Name === 'FunctionName');
      expect(fnDim).toBeDefined();
      // In-process metricErrors → the FunctionName is a { Ref: ... } token, NOT a literal string.
      expect(typeof fnDim!.Value).toBe('object');
    }
  });
});

describe('MonitoringConstruct — (c) turn-queue redrive DLQ-depth alarm', () => {
  it('creates ONE AWS/SQS ApproximateNumberOfMessagesVisible alarm', () => {
    const { template } = synth();
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const dlqAlarms = Object.values(alarms).filter((a) => {
      const p = a.Properties as { Namespace?: string; MetricName?: string };
      return p.Namespace === 'AWS/SQS' && p.MetricName === 'ApproximateNumberOfMessagesVisible';
    });
    expect(dlqAlarms.length).toBe(1);
  });
});

describe('MonitoringConstruct — (a)/(d)/(g)/(h)/(f) metric-filter alarms + canonical id-only patterns (Q6/L3)', () => {
  it('creates TEN metric filters carrying only current canonical `$.metric = "<name>"` patterns', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::Logs::MetricFilter', 10);
    const patterns = filterPatterns(template);
    const joined = patterns.join('\n');
    // (a) safety insert (classifier + inbound log groups) — Q6 canonical id-only line.
    expect(joined).toContain('{ $.metric = "safety_event_recorded" }');
    // (d) Anthropic failure — the metric filter IS the signal (M8: an Anthropic throw never DLQs).
    expect(joined).toContain('{ $.metric = "anthropic_auth_failure" }');
    expect(joined).toContain('{ $.metric = "classifier_transient_exhausted" }');
    // (g) H6 emergency-routing failures — model-side send failure plus the two current inbound
    // persistence failures. Removed inbound REST-send/divert lines must not silently remain wired.
    expect(joined).toContain('{ $.metric = "classifier_safety_send_failed" }');
    expect(joined).toContain('{ $.metric = "inbound_safety_reserve_failed" }');
    expect(joined).toContain('{ $.metric = "inbound_emergency_persistence_failed" }');
    expect(joined).not.toContain('inbound_safety_send_failed');
    expect(joined).not.toContain('inbound_safety_divert_failed');
    // (h) M9 — timeout-schedule + classifier-contract failures.
    expect(joined).toContain('{ $.metric = "timeout_schedule_failed" }');
    expect(joined).toContain('{ $.metric = "classifier_contract_failure" }');
    // (f) — the status-callback-derived consecutive-undelivered metric.
    expect(joined).toContain('{ $.metric = "consecutive_undelivered" }');
  });

  it('(a) safety_event_recorded is filtered on BOTH the classifier AND inbound log groups', () => {
    const { template } = synth();
    const filters = template.findResources('AWS::Logs::MetricFilter');
    const safety = Object.values(filters).filter((f) =>
      (f.Properties as { FilterPattern: string }).FilterPattern.includes('safety_event_recorded'),
    );
    expect(safety.length).toBe(2); // one per source log group
  });

  it('(h) F1: the timeout_schedule_failed filter reads the OUTBOUND log group (that line is emitted by outbound/handler.ts)', () => {
    const { template, stack } = synth();
    const filters = template.findResources('AWS::Logs::MetricFilter');
    const timeoutFilter = Object.values(filters).find((f) =>
      (f.Properties as { FilterPattern: string }).FilterPattern.includes('timeout_schedule_failed'),
    );
    expect(timeoutFilter).toBeDefined();
    // The LogGroupName must resolve to the OUTBOUND log group (the F1 correctness pin), not the classifier's.
    const outboundLg = stack.node.tryFindChild('OutboundLogs');
    const logGroupRef = JSON.stringify(
      (timeoutFilter!.Properties as { LogGroupName: unknown }).LogGroupName,
    );
    expect(logGroupRef).toContain('OutboundLogs');
    expect(outboundLg).toBeDefined();
  });

  it('emits the five metric-filter custom alarms (a/d/g/h/f) → total alarm count is TWELVE', () => {
    const { template } = synth();
    // 6 Lambda Errors + 1 DLQ depth + 5 metric-filter (safety/anthropic/emergency/timeout-contract/undelivered).
    template.resourceCountIs('AWS::CloudWatch::Alarm', 12);
  });
});

describe('MonitoringConstruct — alarms remain visible in CloudWatch without email actions', () => {
  it('every CloudWatch alarm has no AlarmActions', () => {
    const { template } = synth();
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    expect(Object.keys(alarms).length).toBe(12);
    for (const alarm of Object.values(alarms)) {
      const actions = (alarm.Properties as { AlarmActions?: unknown[] }).AlarmActions;
      expect(actions).toBeUndefined();
    }
  });

  it('alarms fire on >=1 (threshold 1, GreaterThanOrEqualToThreshold) and treat missing data as not-breaching', () => {
    const { template } = synth();
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    for (const alarm of Object.values(alarms)) {
      const p = alarm.Properties as {
        ComparisonOperator: string;
        Threshold: number;
        TreatMissingData?: string;
      };
      expect(p.ComparisonOperator).toBe('GreaterThanOrEqualToThreshold');
      expect(p.Threshold).toBe(1);
      expect(p.TreatMissingData).toBe('notBreaching');
    }
  });
});

describe('MonitoringConstruct — (e) billing is the BudgetsConstruct cross-reference, NOT duplicated here', () => {
  it('the monitoring construct creates NO AWS::Budgets::Budget (billing coverage stays in BudgetsConstruct)', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::Budgets::Budget', 0);
  });
});
