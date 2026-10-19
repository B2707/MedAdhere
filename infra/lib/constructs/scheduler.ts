// infra/lib/constructs/scheduler.ts
//
// SchedulerConstruct (PIPE-01 / T-03-07 / F61) — the STATIC EventBridge Scheduler surface the Phase-3
// pipeline schedules doses against. It creates exactly two resources:
//
//   1. The single `medadhere-prod` CfnScheduleGroup — the namespace the Enroll Lambda (Plan 03)
//      creates one-shot `at(...)` dose schedules into at RUNTIME (OPS-01/STUDY-05 naming convention).
//   2. A target-invoke Role trusting scheduler.amazonaws.com, granted lambda:InvokeFunction on the
//      Outbound Lambda ONLY (T-03-07 — no `*` resource). EventBridge Scheduler assumes this role to
//      invoke the Outbound Lambda when a dose schedule fires.
//
// EventBridge SCHEDULER one-shots only — never the legacy CloudWatch-Events Rule / cron-rule path for
// dose scheduling (Rules cap at 300/region; project decision record hard prohibition). The Enroll grants
// (scheduler:CreateSchedule/DeleteSchedule/ListSchedules scoped to medadhere-prod/* + the scoped
// iam:PassRole confused-deputy mitigation) land on the Enroll construct in Plan 03 — NOT here. This
// construct's job is the group + the role + the invoke grant.
//
// Teardown (F61 parity): the group carries applyRemovalPolicy(RemovalPolicy.DESTROY) — advisory
// explicitness so `cdk destroy` removes the group cleanly, mirroring the F61 LogGroup DESTROY
// convention used across the other constructs. The role is a standard L2 iam.Role (destroyed with the
// stack). This construct is wired into FoundationStack in Plan 03 (the integration wave) by in-process
// reference (D-12) — it takes the Outbound NodejsFunction as a prop.

import { Construct } from 'constructs';
import { RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { CfnScheduleGroup } from 'aws-cdk-lib/aws-scheduler';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { SCHEDULE_GROUP_NAME } from '@medadhere/shared';

// WR-02 — the schedule-group name is the SSOT const in @medadhere/shared; re-export it here so the
// existing importers of './scheduler.js' (the Enroll construct + the infra tests) resolve it unchanged.
export { SCHEDULE_GROUP_NAME };

export interface SchedulerConstructProps {
  /** The Outbound Lambda the scheduler target role may invoke (in-process ref — D-12). */
  readonly outboundFn: IFunction;
  /**
   * The Timeout Lambda the SAME scheduler target role may invoke (Plan 05-01, in-process ref — D-12).
   * The PIPE-05 `timeout-{patientId}-{doseId}` one-shot the Outbound Lambda creates targets this fn.
   */
  readonly timeoutFn: IFunction;
}

export class SchedulerConstruct extends Construct {
  /** The single `medadhere-prod` schedule group (Enroll creates one-shot dose schedules here). */
  public readonly group: CfnScheduleGroup;
  /** The role EventBridge Scheduler assumes to invoke the Outbound Lambda (lambda:InvokeFunction only). */
  public readonly targetRole: iam.Role;

  constructor(scope: Construct, id: string, props: SchedulerConstructProps) {
    super(scope, id);

    // The single dose schedule group. applyRemovalPolicy(DESTROY) is advisory explicitness-parity with
    // the F61 LogGroup DESTROY convention so teardown removes the group cleanly (CfnScheduleGroup is an
    // L1, so this sets its DeletionPolicy: 'Delete').
    this.group = new CfnScheduleGroup(this, 'MedadhereProdGroup', {
      name: SCHEDULE_GROUP_NAME,
    });
    this.group.applyRemovalPolicy(RemovalPolicy.DESTROY);

    // The scheduler target-invoke role: trust scheduler.amazonaws.com, granted lambda:InvokeFunction on
    // the Outbound Lambda (dose one-shots — PIPE-01) AND the Timeout Lambda (timeout one-shots —
    // PIPE-05) ONLY (T-03-07 — no `*` resource, no over-broad invoke).
    this.targetRole = new iam.Role(this, 'SchedulerTargetRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description:
        'EventBridge Scheduler assumes this role to invoke the Outbound (dose) + Timeout (non-response) Lambdas for a fired schedule (PIPE-01/PIPE-05)',
    });
    props.outboundFn.grantInvoke(this.targetRole);
    props.timeoutFn.grantInvoke(this.targetRole);
  }
}
