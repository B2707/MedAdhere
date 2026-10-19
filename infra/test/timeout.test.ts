// infra/test/timeout.test.ts
//
// The PIPE-05 Timeout-Lambda SHAPE gate. Uses aws-cdk-lib/assertions `Template.fromStack` to prove the
// synthesized CloudFormation for TimeoutConstruct has the correct in-VPC + clean-teardown + least-
// privilege shape WITHOUT any live AWS call, no network, no DB.
//
// Pins:
//   - the Timeout Lambda is in-VPC (VpcConfig/SubnetIds), nodejs24.x / arm64 (F07/F49)
//   - the DB env (DB_NAME=medadhere) + RESPONSE_WINDOW_MINUTES, with NO PGSSLMODE / NO DB-password (F28/D-06)
//   - an explicit DESTROY/ONE_WEEK LogGroup (F61 teardown)
//   - M1 — grantRead-only on the DB secret; the Timeout Lambda is the scheduler INVOKE TARGET, so it
//     carries ZERO scheduler IAM (no Create/Delete/List/PassRole) and no `*` resource / bedrock / quota
//   - the esbuild afterBundling cp copies the RDS CA bundle

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { App, Stack, RemovalPolicy } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { TimeoutConstruct } from '../lib/constructs/timeout.js';

function synth() {
  const app = new App();
  const stack = new Stack(app, 'TestTimeout', {
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

  new TimeoutConstruct(stack, 'Timeout', { vpc, lambdaSg, db, dbSecret });

  return { stack, template: Template.fromStack(stack) };
}

describe('TimeoutConstruct — in-VPC Timeout Lambda (F07/F49/F28)', () => {
  it('places the Timeout Lambda in the VPC private subnets on nodejs24.x / arm64', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    const ourFns = Object.values(fns).filter(
      (f) => (f.Properties as { VpcConfig?: unknown }).VpcConfig !== undefined,
    );
    expect(ourFns.length).toBe(1);
    const p = ourFns[0]!.Properties as {
      Runtime: string;
      Architectures: string[];
      VpcConfig: { SubnetIds: unknown };
    };
    expect(p.Runtime).toBe('nodejs24.x');
    expect(p.Architectures).toEqual(['arm64']);
    expect(p.VpcConfig.SubnetIds).toBeDefined();
  });

  it('carries the DB env + RESPONSE_WINDOW_MINUTES, with NO PGSSLMODE / NO DB password (F28/D-06/M2)', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    const timeout = Object.values(fns).find(
      (f) =>
        (f.Properties as { Environment?: { Variables?: Record<string, unknown> } })
          .Environment?.Variables?.DB_NAME === 'medadhere',
    );
    expect(timeout).toBeDefined();
    const env = (timeout!.Properties as {
      Environment: { Variables: Record<string, unknown> };
    }).Environment.Variables;
    expect('PGSSLMODE' in env).toBe(false);
    expect('DB_PASSWORD' in env).toBe(false);
    expect('DB_SECRET_ARN' in env).toBe(true);
    // M2 — the single-sourced response window (120) rides the env for the synth equality assertion.
    expect(env.RESPONSE_WINDOW_MINUTES).toBe('120');
  });

  it('gives the Timeout Lambda an explicit DESTROY/ONE_WEEK log group (F61 teardown)', () => {
    const { template } = synth();
    template.hasResource('AWS::Logs::LogGroup', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({ RetentionInDays: 7 }),
    });
  });
});

describe('TimeoutConstruct — M1: grantRead-only, ZERO scheduler IAM (it is the invoke TARGET)', () => {
  it('grants secretsmanager:GetSecretValue on the DB secret only — no scheduler:, no bedrock:, no servicequotas:', () => {
    const { template } = synth();
    const allPolicyJson = JSON.stringify(Object.values(template.findResources('AWS::IAM::Policy')));
    expect(allPolicyJson).toContain('secretsmanager:GetSecretValue');
    // The Timeout Lambda only WRITES the missed row — it never creates/deletes/lists schedules.
    expect(allPolicyJson).not.toContain('scheduler:');
    expect(allPolicyJson).not.toContain('iam:PassRole');
    expect(allPolicyJson).not.toContain('bedrock:');
    expect(allPolicyJson).not.toContain('servicequotas:');
  });

  it('has NO `*` Resource on any IAM policy statement (least privilege)', () => {
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

describe('TimeoutConstruct — the bundle copies the RDS CA bundle (F01/F03)', () => {
  it('the construct source emits an afterBundling cp for the pem (the handler module-scope readFileSync)', () => {
    const src = readFileSync(
      path.join(__dirname, '..', 'lib', 'constructs', 'timeout.ts'),
      'utf8',
    );
    expect(src).toMatch(/cp \$\{path\.join\(inputDir.*rds-global-bundle\.pem.*\$\{outputDir\}/);
  });
});
