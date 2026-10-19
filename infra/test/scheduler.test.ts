// infra/test/scheduler.test.ts
//
// The PIPE-01 scheduler-surface SHAPE gate. Uses aws-cdk-lib/assertions `Template.fromStack` to prove
// the synthesized CloudFormation for SchedulerConstruct has the correct shape WITHOUT any live AWS:
//   - exactly one CfnScheduleGroup named 'medadhere-prod' carrying DeletionPolicy 'Delete'
//     (applyRemovalPolicy DESTROY — F61 teardown parity)
//   - a target Role trusting scheduler.amazonaws.com (the scheduler assume-role principal)
//   - a lambda:InvokeFunction grant scoped to the Outbound Lambda ONLY (T-03-07 — no `*` resource)
//
// Hermetic: a throwaway stack instantiates a stub Outbound Lambda (a plain in-VPC NodejsFunction is
// unnecessary — a minimal lambda.Function suffices as the grantInvoke target), then the
// SchedulerConstruct under test.

import { describe, it, expect } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SchedulerConstruct } from '../lib/constructs/scheduler.js';

function synth() {
  const app = new App();
  const stack = new Stack(app, 'TestScheduler', {
    env: { account: '123456789012', region: 'us-east-1' },
  });

  // A minimal stub for the Outbound Lambda the scheduler target role is granted invoke on.
  const outboundFn = new lambda.Function(stack, 'StubOutboundFn', {
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => {};'),
  });
  // Plan 05-01: the SAME scheduler target role now also invokes the Timeout Lambda (the PIPE-05
  // timeout-{patientId}-{doseId} one-shot targets it).
  const timeoutFn = new lambda.Function(stack, 'StubTimeoutFn', {
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => {};'),
  });

  new SchedulerConstruct(stack, 'Scheduler', { outboundFn, timeoutFn });

  return { stack, template: Template.fromStack(stack), outboundFn, timeoutFn };
}

describe('SchedulerConstruct — the medadhere-prod schedule group (PIPE-01)', () => {
  it('declares exactly one CfnScheduleGroup named medadhere-prod', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::Scheduler::ScheduleGroup', 1);
    template.hasResourceProperties('AWS::Scheduler::ScheduleGroup', {
      Name: 'medadhere-prod',
    });
  });

  it('the schedule group carries DeletionPolicy Delete (applyRemovalPolicy DESTROY — F61 teardown parity)', () => {
    const { template } = synth();
    template.hasResource('AWS::Scheduler::ScheduleGroup', {
      DeletionPolicy: 'Delete',
    });
  });
});

describe('SchedulerConstruct — the target-invoke Role (T-03-07 least privilege)', () => {
  it('creates a Role trusting scheduler.amazonaws.com (the scheduler assume-role principal)', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: { Service: 'scheduler.amazonaws.com' },
          }),
        ]),
      }),
    });
  });

  it('grants lambda:InvokeFunction on the Outbound AND Timeout Lambdas ONLY — no `*` resource', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    // Find the policy that grants lambda:InvokeFunction (the scheduler target role's invoke grant).
    const invokePolicy = Object.values(policies).find((p) =>
      JSON.stringify((p.Properties as { PolicyDocument: unknown }).PolicyDocument).includes(
        'lambda:InvokeFunction',
      ),
    );
    expect(invokePolicy).toBeDefined();

    const doc = (invokePolicy!.Properties as {
      PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> };
    }).PolicyDocument;
    // The invoke statements target specific function ARNs (Fn::GetAtt of the stub fns), NEVER `*`.
    for (const stmt of doc.Statement) {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      if (!actions.includes('lambda:InvokeFunction')) continue;
      const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
      for (const res of resources) {
        expect(res).not.toBe('*'); // never an all-functions invoke (least privilege)
      }
    }
    // BOTH the Outbound and the Timeout fn ARNs are invoke targets of the SAME role (Plan 05-01).
    const policyJson = JSON.stringify(doc);
    expect(policyJson).toContain('StubOutboundFn');
    expect(policyJson).toContain('StubTimeoutFn');
  });

  it('the whole synthesized stack carries NO `*` resource on any IAM policy statement (least privilege)', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    for (const policy of Object.values(policies)) {
      const doc = (policy.Properties as {
        PolicyDocument: { Statement: Array<{ Resource: unknown }> };
      }).PolicyDocument;
      for (const stmt of doc.Statement) {
        const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
        for (const res of resources) {
          expect(res).not.toBe('*');
        }
      }
    }
  });
});
