// infra/lib/constructs/smoke.ts
//
// SmokeConstruct (D-16 / INFRA-05/06/07 / F07/F45/F47/F61) — the in-VPC Twilio smoke Lambda,
// per RESEARCH Patterns 3 + 7. Invoked manually/live in Plan 05 (NOT deploy-time custom resources).
// Only the Twilio transport smoke remains deployed. Anthropic access is isolated behind the
// Phase-8 LLM Gateway, which is the sole runtime holder of that secret.
//
//   - twilio-smoke (backend/src/smoke/twilio.ts): node24/ARM64, 30s timeout, same subnets/SG. env
//     TWILIO_SECRET_ARN, TWILIO_FROM_PARAM = the SSM parameter NAME (F45 — runtime-read, never a
//     value), TEST_RECIPIENT. grantRead on the Twilio secret + ssm:GetParameter scoped to the
//     /medadhere/twilio-from parameter ARN (F45). Egress to api.twilio.com via the NAT (D-01).
//   - Explicit DESTROY/ONE_WEEK LogGroup (F61); 30s timeout (F47 — a cold VPC Lambda + Secrets
//     fetch + external round-trip exceeds the 3s CDK default).
//
// NO aws_events.Rule / Schedule.cron (no scheduling in P1; blocking anti-pattern for later phases).

import { Construct } from 'constructs';
import { Stack, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as path from 'node:path';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { SSM_TWILIO_FROM } from './secrets.js';

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const SMOKE_DIR = path.join(REPO_ROOT, 'backend', 'src', 'smoke');
const TWILIO_ENTRY = path.join(SMOKE_DIR, 'twilio.ts');

export interface SmokeConstructProps {
  readonly vpc: ec2.IVpc;
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly twilioSecret: secretsmanager.ISecret;
  /** Deploy-time SSM token for the test recipient phone (twilio-smoke env). */
  readonly testRecipient: string;
}

export class SmokeConstruct extends Construct {
  public readonly twilioSmokeFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: SmokeConstructProps) {
    super(scope, id);

    const region = Stack.of(this).region;
    const account = Stack.of(this).account;

    // --- twilio-smoke --------------------------------------------------------------------------
    const twilioLogGroup = new logs.LogGroup(this, 'TwilioSmokeLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.twilioSmokeFn = new NodejsFunction(this, 'TwilioSmokeFn', {
      entry: TWILIO_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X, // F07
      architecture: Architecture.ARM_64, // F07
      timeout: Duration.seconds(30), // F47
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSg],
      logGroup: twilioLogGroup,
      environment: {
        TWILIO_SECRET_ARN: props.twilioSecret.secretArn,
        TWILIO_FROM_PARAM: SSM_TWILIO_FROM, // F45 — the parameter NAME, read at runtime
        TEST_RECIPIENT: props.testRecipient,
      },
    });
    props.twilioSecret.grantRead(this.twilioSmokeFn);
    // F45 — runtime ssm:GetParameter scoped to /medadhere/twilio-from so the handler's runtime read
    // works. The SSM parameter ARN drops the leading slash of the parameter name.
    this.twilioSmokeFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${region}:${account}:parameter${SSM_TWILIO_FROM}`],
      }),
    );
  }
}
