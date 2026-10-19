// infra/test/outbound.test.ts
//
// The SC3/SC6 Outbound-Lambda SHAPE gate. Uses aws-cdk-lib/assertions `Template.fromStack` to prove the
// synthesized CloudFormation for OutboundConstruct has the correct in-VPC + clean-teardown + least-
// privilege + asset-bundling shape WITHOUT any live AWS call, no network, no DB.
//
// Pins:
//   - the Outbound Lambda is in-VPC (VpcConfig/SubnetIds), nodejs24.x / arm64 (F07/F49)
//   - the DB env (DB_NAME=medadhere) carries NO PGSSLMODE and NO DB-password env (F28 / D-06)
//   - the env carries TWILIO_FROM_PARAM (F45 — the SSM parameter NAME) + STATUS_CALLBACK_URL (Pitfall 2)
//   - an explicit DESTROY/ONE_WEEK LogGroup (F61 teardown)
//   - M1 — grantRead-only IAM (GetSecretValue on the two secrets + a scoped ssm:GetParameter), with NO
//     `*` resource and NO bedrock:/servicequotas: action
//   - the esbuild afterBundling cp copies BOTH template.mustache AND rds-global-bundle.pem (verified by
//     reading the construct source — the bundle command is a synth-time esbuild detail not exposed in
//     the synthesized template, so we assert the construct emits both cp lines).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { App, Stack, RemovalPolicy } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { OutboundConstruct } from '../lib/constructs/outbound.js';

function synth() {
  const app = new App();
  const stack = new Stack(app, 'TestOutbound', {
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
  const dbSecret = db.secret!;

  // A standalone Twilio secret (the placeholder shape) — the grantRead target.
  const twilioSecret = new secretsmanager.Secret(stack, 'TwilioSecret', {
    secretName: 'medadhere/twilio',
  });

  new OutboundConstruct(stack, 'Outbound', {
    vpc,
    lambdaSg,
    db,
    dbSecret,
    twilioSecret,
    statusCallbackUrl:
      'https://abc123.execute-api.us-east-1.amazonaws.com/twilio/status#rc=3&ct=1000&rt=5000&tt=15000&rp=ct,rt,5xx',
  });

  return { stack, template: Template.fromStack(stack), dbSecret, twilioSecret };
}

describe('OutboundConstruct — in-VPC Outbound Lambda (F07/F49/F28)', () => {
  it('places the Outbound Lambda in the VPC private subnets on nodejs24.x / arm64', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    const ourFns = Object.values(fns).filter(
      (f) => (f.Properties as { VpcConfig?: unknown }).VpcConfig !== undefined,
    );
    expect(ourFns.length).toBe(1); // the single Outbound fn
    const p = ourFns[0]!.Properties as {
      Runtime: string;
      Architectures: string[];
      VpcConfig: { SubnetIds: unknown };
    };
    expect(p.Runtime).toBe('nodejs24.x'); // F07
    expect(p.Architectures).toEqual(['arm64']); // F07
    expect(p.VpcConfig.SubnetIds).toBeDefined(); // F49 — in the VPC private subnets
  });

  it('carries the DB env (DB_NAME=medadhere) + TWILIO_FROM_PARAM + STATUS_CALLBACK_URL, with NO PGSSLMODE / NO DB password (F28/F45/D-06)', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    const outbound = Object.values(fns).find(
      (f) =>
        (f.Properties as { Environment?: { Variables?: Record<string, unknown> } }).Environment
          ?.Variables?.DB_NAME === 'medadhere',
    );
    expect(outbound).toBeDefined();
    const env = (
      outbound!.Properties as {
        Environment: { Variables: Record<string, unknown> };
      }
    ).Environment.Variables;
    // F28 — no PGSSLMODE downgrade path; D-06 — no password in env.
    expect('PGSSLMODE' in env).toBe(false);
    expect('DB_PASSWORD' in env).toBe(false);
    expect('DB_PASS' in env).toBe(false);
    // F45 — the SSM parameter NAME is in the env (read at runtime), not a baked FROM value.
    expect(env.TWILIO_FROM_PARAM).toBe('/medadhere/twilio-from');
    expect('TWILIO_FROM' in env).toBe(false);
    // Pitfall 2 — the exact status-callback URL is pinned in the env.
    expect(env.STATUS_CALLBACK_URL).toBe(
      'https://abc123.execute-api.us-east-1.amazonaws.com/twilio/status#rc=3&ct=1000&rt=5000&tt=15000&rp=ct,rt,5xx',
    );
    // The secrets are referenced by ARN, not by value.
    expect('DB_SECRET_ARN' in env).toBe(true);
    expect('TWILIO_SECRET_ARN' in env).toBe(true);
  });

  it('gives the Outbound Lambda an explicit DESTROY/ONE_WEEK log group (F61 teardown)', () => {
    const { template } = synth();
    template.hasResource('AWS::Logs::LogGroup', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({ RetentionInDays: 7 }),
    });
  });
});

describe('OutboundConstruct — M1: grantRead-only IAM (no `*`, no bedrock:/servicequotas:)', () => {
  it('grants secretsmanager:GetSecretValue + a scoped ssm:GetParameter, with no `*` resource and no bedrock:/servicequotas: action', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    // The Outbound fn's inline policy (the addToRolePolicy ssm:GetParameter + the grantRead statements).
    const allPolicyJson = JSON.stringify(Object.values(policies));
    expect(allPolicyJson).toContain('secretsmanager:GetSecretValue');
    expect(allPolicyJson).toContain('ssm:GetParameter');
    // Least privilege — no Bedrock / servicequotas anywhere.
    expect(allPolicyJson).not.toContain('bedrock:');
    expect(allPolicyJson).not.toContain('servicequotas:');

    // No `*` (all-resources) grant on any statement.
    for (const policy of Object.values(policies)) {
      const doc = (
        policy.Properties as {
          PolicyDocument: { Statement: Array<{ Resource: unknown }> };
        }
      ).PolicyDocument;
      for (const stmt of doc.Statement) {
        const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
        for (const res of resources) {
          expect(res).not.toBe('*');
        }
      }
    }
  });

  it('scopes the ssm:GetParameter to the /medadhere/twilio-from parameter ARN (F45)', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const ssmPolicy = Object.values(policies).find((p) =>
      JSON.stringify((p.Properties as { PolicyDocument: unknown }).PolicyDocument).includes(
        'ssm:GetParameter',
      ),
    );
    expect(ssmPolicy).toBeDefined();
    // The scoped ARN ends with parameter/medadhere/twilio-from (the leading slash is dropped in the ARN).
    expect(JSON.stringify(ssmPolicy)).toContain('parameter/medadhere/twilio-from');
  });
});

describe('OutboundConstruct — the bundle copies BOTH template.mustache AND the RDS CA bundle (F01/F03)', () => {
  it('the construct source emits an afterBundling cp for BOTH the pem AND template.mustache', () => {
    // The esbuild afterBundling cp is a synth-time bundling detail (not a synthesized template
    // property), so assert the construct source emits both cp lines — the regression gate that a future
    // edit cannot silently drop the template (which would ENOENT the handler's module-scope read).
    const src = readFileSync(
      path.join(__dirname, '..', 'lib', 'constructs', 'outbound.ts'),
      'utf8',
    );
    expect(src).toMatch(/cp \$\{path\.join\(inputDir.*rds-global-bundle\.pem.*\$\{outputDir\}/);
    expect(src).toMatch(/cp \$\{path\.join\(inputDir.*template\.mustache.*\$\{outputDir\}/);
  });
});
