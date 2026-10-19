// infra/test/export-anon.test.ts
//
// The DASH-06 export SHAPE gate (Plan 06-06). Uses aws-cdk-lib/assertions `Template.fromStack` to prove
// the synthesized CloudFormation for ExportAnonConstruct has the correct M11-bucket + in-VPC-Lambda +
// scoped-IAM + dedicated-scheduler-role + validation-window-GATED-schedule shape WITHOUT any live AWS
// call. Hermetic: a throwaway stack with a minimal VPC + Lambda SG + a stub RDS + its DB secret, then
// `new ExportAnonConstruct(...)` — parameterized on `validationWindow` to assert the gated schedule both ways.
//
// Pins:
//   - M11 bucket: BLOCK_ALL public access, SSE-S3 (AES256), enforceSSL (TLS-only deny policy → no S10
//     suppression needed), DeletionPolicy Delete + autoDeleteObjects (INFRA-04 teardown)
//   - the export Lambda is in-VPC (VpcConfig/SubnetIds), ARM64/node24, EXPORT_BUCKET_NAME + DB env, no PGSSLMODE
//   - M1 least privilege: dbSecret GetSecretValue + a SCOPED s3:PutObject on the bucket object ARN (no bare `*`)
//   - a DEDICATED scheduler target role trusting scheduler.amazonaws.com, granted invoke on the export fn ONLY
//   - the nightly schedule is created UNDER validationWindow=true (default group — no new ScheduleGroup) and
//     ABSENT under validationWindow=false (gated both ways)
//   - U-5: the construct adds NO VPC endpoint (the existing S3 gateway endpoint carries the PutObject traffic)

import { describe, it, expect } from 'vitest';
import { App, Stack, RemovalPolicy } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { ExportAnonConstruct } from '../lib/constructs/export-anon.js';

/** Build a throwaway stack hermetically: minimal VPC + Lambda SG + stub RDS + DB secret, then the construct. */
function synth(validationWindow: boolean) {
  const app = new App();
  const stack = new Stack(app, 'TestExportAnon', {
    env: { account: '123456789012', region: 'us-east-1' },
  });

  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2 });
  const lambdaSg = new ec2.SecurityGroup(stack, 'LambdaSg', { vpc });

  const db = new rds.DatabaseInstance(stack, 'Db', {
    engine: rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.VER_16_4,
    }),
    vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    credentials: rds.Credentials.fromGeneratedSecret('medadhere_admin'),
    removalPolicy: RemovalPolicy.DESTROY,
  });

  new ExportAnonConstruct(stack, 'ExportAnon', {
    vpc,
    lambdaSg,
    db,
    dbSecret: db.secret!,
    validationWindow,
  });

  return { stack, template: Template.fromStack(stack), dbSecret: db.secret! };
}

describe('ExportAnonConstruct — M11 hardened export bucket', () => {
  it('blocks ALL public access', () => {
    const { template } = synth(false);
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('encrypts server-side with SSE-S3 (AES256 — no KMS cost)', () => {
    const { template } = synth(false);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
          }),
        ]),
      },
    });
  });

  it('enforces TLS-only access via a deny-on-insecure-transport bucket policy (discharges S10 — no suppression)', () => {
    const { template } = synth(false);
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      }),
    });
  });

  it('carries DeletionPolicy Delete + an autoDelete provider (INFRA-04 clean teardown)', () => {
    const { template } = synth(false);
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
    // autoDeleteObjects wires a Custom::S3AutoDeleteObjects resource that empties the bucket on destroy.
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
  });
});

describe('ExportAnonConstruct — in-VPC export Lambda (F07/F49/F28)', () => {
  it('places the export Lambda in the VPC private subnets on nodejs24.x / arm64', () => {
    const { template } = synth(false);
    const fns = template.findResources('AWS::Lambda::Function');
    // Our in-VPC fn is the export fn (VpcConfig present). The autoDelete provider fn is NON-VPC.
    const ourFns = Object.values(fns).filter(
      (f) => (f.Properties as { VpcConfig?: unknown }).VpcConfig !== undefined,
    );
    expect(ourFns.length).toBe(1);
    const p = ourFns[0]!.Properties as {
      Runtime: string;
      Architectures: string[];
      VpcConfig: { SubnetIds: unknown };
    };
    expect(p.Runtime).toBe('nodejs24.x'); // F07
    expect(p.Architectures).toEqual(['arm64']); // F07
    expect(p.VpcConfig.SubnetIds).toBeDefined(); // F49
  });

  it('carries EXPORT_BUCKET_NAME + the DB env with NO PGSSLMODE and NO DB password env (F28 / D-06)', () => {
    const { template } = synth(false);
    const fns = template.findResources('AWS::Lambda::Function');
    const exportFn = Object.values(fns).find((f) => {
      const env =
        (f.Properties as { Environment?: { Variables?: Record<string, unknown> } })
          .Environment?.Variables ?? {};
      return 'EXPORT_BUCKET_NAME' in env;
    });
    expect(exportFn).toBeDefined();
    const env = (exportFn!.Properties as {
      Environment: { Variables: Record<string, unknown> };
    }).Environment.Variables;
    expect(env.DB_NAME).toBe('medadhere'); // F26
    expect('DB_SECRET_ARN' in env).toBe(true); // D-06 — secret by ARN, not by value
    expect('PGSSLMODE' in env).toBe(false); // F28
    expect('DB_PASSWORD' in env).toBe(false);
    expect('DB_PASS' in env).toBe(false);
  });

  it('gives the export Lambda an explicit DESTROY/ONE_WEEK log group (F61 teardown)', () => {
    const { template } = synth(false);
    template.hasResource('AWS::Logs::LogGroup', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({ RetentionInDays: 7 }),
    });
  });
});

describe('ExportAnonConstruct — M1 least-privilege IAM', () => {
  it('grants a SCOPED s3:PutObject on the bucket object ARN only — never a bare `*`, never s3:* / Delete', () => {
    const { template } = synth(false);
    const policies = template.findResources('AWS::IAM::Policy');
    const putPolicy = Object.values(policies).find((p) =>
      JSON.stringify((p.Properties as { PolicyDocument: unknown }).PolicyDocument).includes('s3:PutObject'),
    );
    expect(putPolicy).toBeDefined();
    const doc = (putPolicy!.Properties as {
      PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> };
    }).PolicyDocument;
    const putStmt = doc.Statement.find((s) => {
      const a = Array.isArray(s.Action) ? s.Action : [s.Action];
      return a.includes('s3:PutObject');
    });
    expect(putStmt).toBeDefined();
    // Exactly s3:PutObject (no wildcard actions like s3:* or s3:DeleteObject).
    const actions = Array.isArray(putStmt!.Action) ? putStmt!.Action : [putStmt!.Action];
    expect(actions).toEqual(['s3:PutObject']);
    // The resource is the bucket object ARN (ends with /*), never a bare `*`.
    const resources = Array.isArray(putStmt!.Resource) ? putStmt!.Resource : [putStmt!.Resource];
    for (const r of resources) expect(r).not.toBe('*');
    expect(JSON.stringify(resources)).toContain('/*');
    // The whole policy names no DeleteObject / ListBucket / s3:* wildcard.
    const docStr = JSON.stringify(doc);
    expect(docStr).not.toContain('s3:DeleteObject');
    expect(docStr).not.toContain('s3:*');
  });

  it('grants the export fn dbSecret GetSecretValue (M1 — D-06)', () => {
    const { template, dbSecret } = synth(false);
    const secretLogicalId = Stack.of(dbSecret).resolve(
      (dbSecret.node.defaultChild as unknown as { logicalId: string }).logicalId,
    ) as string;
    const policies = template.findResources('AWS::IAM::Policy');
    const dbPolicy = Object.values(policies).find((p) =>
      JSON.stringify((p.Properties as { PolicyDocument: unknown }).PolicyDocument).includes(secretLogicalId),
    );
    expect(dbPolicy).toBeDefined();
    expect(JSON.stringify(dbPolicy)).toContain('secretsmanager:GetSecretValue');
  });
});

describe('ExportAnonConstruct — dedicated EventBridge Scheduler target role (U-33)', () => {
  it('creates a role trusting scheduler.amazonaws.com, granted lambda:InvokeFunction on the export fn', () => {
    const { template } = synth(false);
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 'sts:AssumeRole',
            Principal: { Service: 'scheduler.amazonaws.com' },
          }),
        ]),
      }),
    });
    // A policy on that role grants lambda:InvokeFunction (the grantInvoke shape).
    const policies = template.findResources('AWS::IAM::Policy');
    const invokePolicy = Object.values(policies).find((p) =>
      JSON.stringify((p.Properties as { PolicyDocument: unknown }).PolicyDocument).includes(
        'lambda:InvokeFunction',
      ),
    );
    expect(invokePolicy).toBeDefined();
  });
});

describe('ExportAnonConstruct — validation-window-gated nightly schedule (U-33 / U-5)', () => {
  it('creates the nightly schedule in the DEFAULT group under validationWindow=true (no new ScheduleGroup)', () => {
    const { template } = synth(true);
    template.resourceCountIs('AWS::Scheduler::Schedule', 1);
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(0 7 * * ? *)',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: Match.objectLike({
        Arn: Match.anyValue(),
        RoleArn: Match.anyValue(),
        RetryPolicy: {
          MaximumRetryAttempts: 2,
          MaximumEventAgeInSeconds: 3600,
        },
      }),
    });
    // Default group: the schedule declares NO GroupName, and NO CfnScheduleGroup is created (U-33).
    const schedules = template.findResources('AWS::Scheduler::Schedule');
    const schedule = Object.values(schedules)[0]!;
    expect((schedule.Properties as { GroupName?: unknown }).GroupName).toBeUndefined();
    template.resourceCountIs('AWS::Scheduler::ScheduleGroup', 0);
  });

  it('creates NO schedule under validationWindow=false (gated off — the default/teardown posture)', () => {
    const { template } = synth(false);
    template.resourceCountIs('AWS::Scheduler::Schedule', 0);
  });

  it('U-5: the construct adds NO VPC endpoint (the existing S3 gateway endpoint carries PutObject off-NAT)', () => {
    // Both gate states: the construct never creates an endpoint (a second S3 endpoint would break the
    // FoundationStack VPCEndpoint count=2 assert and conflict route-table prefix lists).
    expect(synth(false).template.findResources('AWS::EC2::VPCEndpoint')).toEqual({});
    expect(synth(true).template.findResources('AWS::EC2::VPCEndpoint')).toEqual({});
  });
});
