// infra/test/enroll.test.ts
//
// The PIPE-01/08/09 Enroll-Lambda SHAPE gate. Uses aws-cdk-lib/assertions `Template.fromStack` to prove
// the synthesized CloudFormation for EnrollConstruct has the correct in-VPC + clean-teardown + least-
// privilege + scoped-scheduler-IAM shape WITHOUT any live AWS call, no network, no DB.
//
// Pins:
//   - the Enroll Lambda is in-VPC (VpcConfig/SubnetIds), nodejs24.x / arm64 (F07/F49)
//   - the DB env (DB_NAME=medadhere) + OUTBOUND_FN_ARN + SCHEDULER_TARGET_ROLE_ARN, with NO PGSSLMODE
//     and NO DB-password env (F28 / D-06)
//   - an explicit DESTROY/ONE_WEEK LogGroup (F61 teardown)
//   - M1 — grantRead-only on the DB secret (no bedrock:/servicequotas:)
//   - M5 — scheduler:CreateSchedule/DeleteSchedule scoped to the medadhere-prod schedule/schedule-group
//     ARNs (no broad `*`); iam:PassRole scoped to the target-role ARN with the
//     iam:PassedToService=scheduler.amazonaws.com condition; and scheduler:ListSchedules as its OWN
//     Resource:'*' statement bounded by an aws:RequestedRegion Condition (HIGH-2 — ListSchedules has no
//     resource type, so a scoped ARN is denied at runtime). The carve-out invariant holds: the ONLY `*`
//     statement is ListSchedules-only AND carries a Condition.

import { describe, it, expect } from 'vitest';
import { App, Stack, RemovalPolicy } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
import { EnrollConstruct } from '../lib/constructs/enroll.js';

const OUTBOUND_FN_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:Outbound';

function synth() {
  const app = new App();
  const stack = new Stack(app, 'TestEnroll', {
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

  // A stub scheduler target role — the PassRole resource + the CreateSchedule Target.RoleArn.
  const targetRole = new iam.Role(stack, 'SchedulerTargetRole', {
    assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
  });

  new EnrollConstruct(stack, 'Enroll', {
    vpc,
    lambdaSg,
    db,
    dbSecret,
    outboundFnArn: OUTBOUND_FN_ARN,
    schedulerTargetRoleArn: targetRole.roleArn,
  });

  return { stack, template: Template.fromStack(stack), dbSecret };
}

interface PolicyStatement {
  Action?: unknown;
  Resource?: unknown;
  Condition?: unknown;
}

/** Collect every IAM policy statement across all AWS::IAM::Policy resources in the template. */
function allStatements(template: Template): PolicyStatement[] {
  const policies = template.findResources('AWS::IAM::Policy');
  return Object.values(policies).flatMap(
    (p) =>
      (p.Properties as { PolicyDocument: { Statement: PolicyStatement[] } }).PolicyDocument
        .Statement,
  );
}

function actionsOf(stmt: PolicyStatement): string[] {
  const a = stmt.Action;
  return Array.isArray(a) ? (a as string[]) : a === undefined ? [] : [a as string];
}

describe('EnrollConstruct — in-VPC Enroll Lambda (F07/F49/F28)', () => {
  it('places the Enroll Lambda in the VPC private subnets on nodejs24.x / arm64', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    const ourFns = Object.values(fns).filter(
      (f) => (f.Properties as { VpcConfig?: unknown }).VpcConfig !== undefined,
    );
    expect(ourFns.length).toBe(1); // the single Enroll fn
    const p = ourFns[0]!.Properties as {
      Runtime: string;
      Architectures: string[];
      VpcConfig: { SubnetIds: unknown };
    };
    expect(p.Runtime).toBe('nodejs24.x'); // F07
    expect(p.Architectures).toEqual(['arm64']); // F07
    expect(p.VpcConfig.SubnetIds).toBeDefined(); // F49 — in the VPC private subnets
  });

  it('carries the DB env + OUTBOUND_FN_ARN + SCHEDULER_TARGET_ROLE_ARN, with NO PGSSLMODE / NO DB password (F28/D-06)', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    const enroll = Object.values(fns).find(
      (f) =>
        (f.Properties as { Environment?: { Variables?: Record<string, unknown> } })
          .Environment?.Variables?.DB_NAME === 'medadhere',
    );
    expect(enroll).toBeDefined();
    const env = (enroll!.Properties as {
      Environment: { Variables: Record<string, unknown> };
    }).Environment.Variables;
    // F28 — no PGSSLMODE downgrade path; D-06 — no password in env.
    expect('PGSSLMODE' in env).toBe(false);
    expect('DB_PASSWORD' in env).toBe(false);
    expect('DB_PASS' in env).toBe(false);
    // The in-process refs (D-12) are pinned in the env.
    expect(env.OUTBOUND_FN_ARN).toBe(OUTBOUND_FN_ARN);
    expect('SCHEDULER_TARGET_ROLE_ARN' in env).toBe(true);
    // The secret is referenced by ARN, not by value.
    expect('DB_SECRET_ARN' in env).toBe(true);
  });

  it('gives the Enroll Lambda an explicit DESTROY/ONE_WEEK log group (F61 teardown)', () => {
    const { template } = synth();
    const groups = template.findResources('AWS::Logs::LogGroup');
    const destroyGroups = Object.values(groups).filter(
      (g) =>
        (g as { DeletionPolicy?: string }).DeletionPolicy === 'Delete' &&
        (g.Properties as { RetentionInDays?: number }).RetentionInDays === 7,
    );
    expect(destroyGroups.length).toBeGreaterThanOrEqual(1);
  });
});

describe('EnrollConstruct — M1: grantRead-only on the DB secret (no bedrock:/servicequotas:)', () => {
  it('grants secretsmanager:GetSecretValue on the DB secret only — no LLM-runtime / quota actions', () => {
    const { template } = synth();
    const allPolicyJson = JSON.stringify(
      Object.values(template.findResources('AWS::IAM::Policy')),
    );
    expect(allPolicyJson).toContain('secretsmanager:GetSecretValue');
    expect(allPolicyJson).not.toContain('bedrock:');
    expect(allPolicyJson).not.toContain('servicequotas:');
  });
});

describe('EnrollConstruct — M5: scoped scheduler IAM + confused-deputy PassRole', () => {
  it('scopes scheduler:CreateSchedule and DeleteSchedule to the medadhere-prod ARNs (no broad `*`)', () => {
    const { template } = synth();
    const statements = allStatements(template);
    const createDelete = statements.filter((s) =>
      actionsOf(s).some(
        (a) => a === 'scheduler:CreateSchedule' || a === 'scheduler:DeleteSchedule',
      ),
    );
    expect(createDelete.length).toBeGreaterThanOrEqual(1);
    for (const stmt of createDelete) {
      const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
      // No broad `*` on Create/Delete.
      for (const r of resources) {
        expect(r).not.toBe('*');
      }
      // The medadhere-prod schedule + schedule-group ARNs are present (rendered as Fn::Join tokens
      // carrying the literal group name).
      const json = JSON.stringify(resources);
      expect(json).toContain('schedule/medadhere-prod/*');
      expect(json).toContain('schedule-group/medadhere-prod');
    }
  });

  it('scopes iam:PassRole to the target-role ARN with iam:PassedToService=scheduler.amazonaws.com (Pitfall 7)', () => {
    const { template } = synth();
    const statements = allStatements(template);
    const passRole = statements.filter((s) => actionsOf(s).includes('iam:PassRole'));
    expect(passRole.length).toBe(1);
    const stmt = passRole[0]!;
    // Not a `*` resource — scoped to the single target-role ARN.
    const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
    for (const r of resources) {
      expect(r).not.toBe('*');
    }
    // The confused-deputy condition is present.
    expect(JSON.stringify(stmt.Condition)).toContain('scheduler.amazonaws.com');
    expect(JSON.stringify(stmt.Condition)).toContain('iam:PassedToService');
  });

  it('carve-out invariant: the ONLY Resource:`*` statement contains ONLY scheduler:ListSchedules AND a Condition', () => {
    const { template } = synth();
    const statements = allStatements(template);
    for (const stmt of statements) {
      const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
      const hasStar = resources.some((r) => r === '*');
      if (!hasStar) continue;
      // The ONLY permissible `*` is a ListSchedules-only statement carrying a Condition (never an
      // unconditioned `*`, never `*` attached to Create/Delete/PassRole).
      const actions = actionsOf(stmt);
      expect(actions).toEqual(['scheduler:ListSchedules']);
      expect(stmt.Condition).toBeDefined();
    }
  });

  it('authors scheduler:ListSchedules with Resource:`*` + a bounding Condition (HIGH-2 — ListSchedules has no resource type)', () => {
    const { template } = synth();
    const statements = allStatements(template);
    // ListSchedules must be its OWN `*` statement — a scoped schedule/group ARN is denied at runtime.
    const listStmts = statements.filter((s) =>
      actionsOf(s).includes('scheduler:ListSchedules'),
    );
    expect(listStmts.length).toBe(1);
    const listStmt = listStmts[0]!;
    // ListSchedules-only (never bundled with Create/Delete), `*`-scoped, with a bounding Condition.
    expect(actionsOf(listStmt)).toEqual(['scheduler:ListSchedules']);
    const resources = Array.isArray(listStmt.Resource) ? listStmt.Resource : [listStmt.Resource];
    expect(resources).toEqual(['*']);
    expect(listStmt.Condition).toBeDefined();
    // The bounding condition confines the `*` to the deployment region (aws:RequestedRegion).
    expect(JSON.stringify(listStmt.Condition)).toContain('aws:RequestedRegion');
    // Exactly one `*` statement in the whole policy — the ListSchedules carve-out, nothing else.
    const starStatements = statements.filter((s) => {
      const rs = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
      return rs.some((r) => r === '*');
    });
    expect(starStatements).toHaveLength(1);
  });
});
