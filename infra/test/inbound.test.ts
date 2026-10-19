// infra/test/inbound.test.ts
//
// The Plan 04-02 inbound SHAPE gate — mirrors status-callback.test.ts (the construct it clones,
// gate fix U-06/REV-M3: a DEDICATED no-authorizer HttpApi, NEVER the Cognito-guarded DataApi).
// Uses aws-cdk-lib/assertions Template.fromStack — no live AWS call.
//
// Pins:
//   - the POST /twilio/inbound route has NO AuthorizationType JWT + ZERO ApiGatewayV2::Authorizer
//     resources (the load-bearing inverse assertion — an accidental authorizer 401s every Twilio POST)
//   - the inbound Lambda is in-VPC, nodejs24.x/arm64, explicit DESTROY/ONE_WEEK log group,
//     NO PGSSLMODE / NO DB password env (F28/D-06); INBOUND_URL + QUEUE_URL wired
//   - the $default stage mirrors the 50/50 throttle (each accepted request costs LLM + SMS money — U-06)
//   - one FIFO work queue + one FIFO redrive DLQ, with explicit-dedup mode and scoped SendMessage
//   - M1 least privilege: GetSecretValue on DB+Twilio secrets, no stale SSM read, no `*` Resource

import { describe, it, expect } from 'vitest';
import { App, Stack, RemovalPolicy } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { InboundConstruct } from '../lib/constructs/inbound.js';

const PINNED_URL = 'https://xyz789.execute-api.us-east-1.amazonaws.com/twilio/inbound';

function synth() {
  const app = new App();
  const stack = new Stack(app, 'TestInbound', {
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

  const twilioSecret = new secretsmanager.Secret(stack, 'TwilioSecret', {
    secretName: 'medadhere/twilio',
  });

  new InboundConstruct(stack, 'Inbound', {
    vpc,
    lambdaSg,
    db,
    dbSecret,
    twilioSecret,
    inboundUrl: PINNED_URL,
  });

  return { stack, template: Template.fromStack(stack) };
}

describe('InboundConstruct — DEDICATED PUBLIC route, NO authorizer (U-06/REV-M3 — never the DataApi)', () => {
  it('declares exactly one HTTP API', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  });

  it('exposes a POST /twilio/inbound route with NO AuthorizationType JWT', () => {
    const { template } = synth();
    const routes = template.findResources('AWS::ApiGatewayV2::Route');
    const inboundRoute = Object.values(routes).find(
      (r) => (r.Properties as { RouteKey?: string }).RouteKey === 'POST /twilio/inbound',
    );
    expect(inboundRoute).toBeDefined();
    const props = inboundRoute!.Properties as { AuthorizationType?: string };
    expect(props.AuthorizationType).not.toBe('JWT');
  });

  it('the synthesized stack has ZERO ApiGatewayV2::Authorizer resources (the inverse assertion)', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 0);
  });
});

describe('InboundConstruct — in-VPC Lambda shape (F07/F49/F28/D-06)', () => {
  it('places the inbound Lambda in the VPC private subnets on nodejs24.x / arm64', () => {
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

  it('carries DB + Twilio + INBOUND_URL + QUEUE_URL, with no stale bus/SSM env or DB password', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    const inbound = Object.values(fns).find(
      (f) =>
        (f.Properties as { Environment?: { Variables?: Record<string, unknown> } }).Environment
          ?.Variables?.DB_NAME === 'medadhere',
    );
    expect(inbound).toBeDefined();
    const env = (
      inbound!.Properties as {
        Environment: { Variables: Record<string, unknown> };
      }
    ).Environment.Variables;
    expect('PGSSLMODE' in env).toBe(false);
    expect('DB_PASSWORD' in env).toBe(false);
    expect('DB_SECRET_ARN' in env).toBe(true);
    expect('TWILIO_SECRET_ARN' in env).toBe(true);
    expect(env.INBOUND_URL).toBe(PINNED_URL); // Pitfall-2 exact-URL pin (overridden by addEnvironment in-stack)
    expect('TWILIO_FROM_PARAM' in env).toBe(false);
    expect('QUEUE_URL' in env).toBe(true); // the FIFO publish target
    expect('EVENT_BUS_NAME' in env).toBe(false);
  });

  it('gives the inbound Lambda an explicit DESTROY/ONE_WEEK log group (F61 teardown)', () => {
    const { template } = synth();
    template.hasResource('AWS::Logs::LogGroup', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({ RetentionInDays: 7 }),
    });
  });
});

describe('InboundConstruct — throttle mirror (U-06: each accepted request costs LLM + SMS money)', () => {
  it('sets DefaultRouteSettings 50/50 on the $default stage', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: Match.objectLike({
        ThrottlingRateLimit: 50,
        ThrottlingBurstLimit: 50,
      }),
    });
  });
});

describe('InboundConstruct — patient FIFO queue + one redrive DLQ (08-04a)', () => {
  it('creates exactly one FIFO work queue and one FIFO redrive DLQ with the pinned lifecycle', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.resourceCountIs('AWS::Events::EventBus', 0);

    const queues = Object.values(template.findResources('AWS::SQS::Queue'));
    for (const queue of queues) {
      const props = queue.Properties as {
        FifoQueue?: boolean;
        SqsManagedSseEnabled?: boolean;
        MessageRetentionPeriod?: number;
      };
      expect(props.FifoQueue).toBe(true);
      expect(props.SqsManagedSseEnabled).toBe(true);
      expect(props.MessageRetentionPeriod).toBe(14 * 24 * 60 * 60);
      expect(queue.DeletionPolicy).toBe('Delete');
    }

    const workQueue = queues.find(
      (queue) => (queue.Properties as { RedrivePolicy?: unknown }).RedrivePolicy !== undefined,
    );
    expect(workQueue).toBeDefined();
    const props = workQueue!.Properties as {
      VisibilityTimeout?: number;
      ContentBasedDeduplication?: boolean;
      RedrivePolicy: { maxReceiveCount: number; deadLetterTargetArn: unknown };
    };
    expect(props.VisibilityTimeout).toBe(360);
    expect(props.ContentBasedDeduplication).not.toBe(true);
    expect(props.RedrivePolicy.maxReceiveCount).toBe(5);
    expect(props.RedrivePolicy.deadLetterTargetArn).toBeDefined();
  });

  it('enforces TLS-only access on both queues', () => {
    const { template } = synth();
    const policies = Object.values(template.findResources('AWS::SQS::QueuePolicy'));
    expect(policies).toHaveLength(2);
    for (const policy of policies) {
      const json = JSON.stringify(policy.Properties);
      expect(json).toContain('aws:SecureTransport');
      expect(json).toContain('Deny');
    }
  });

  it('grants same-queue sqs:SendMessage scoped to the work queue and no events:PutEvents', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    let sendStatement: { Action: unknown; Resource: unknown } | undefined;
    for (const policy of Object.values(policies)) {
      const doc = (
        policy.Properties as {
          PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> };
        }
      ).PolicyDocument;
      for (const stmt of doc.Statement) {
        const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        expect(actions).not.toContain('events:PutEvents');
        if (actions.includes('sqs:SendMessage')) sendStatement = stmt;
      }
    }
    expect(sendStatement).toBeDefined();
    const resources = Array.isArray(sendStatement!.Resource)
      ? sendStatement!.Resource
      : [sendStatement!.Resource];
    for (const res of resources) {
      expect(res).not.toBe('*');
    }
    expect(JSON.stringify(resources)).toMatch(/Fn::GetAtt/);
  });
});

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

describe('InboundConstruct — M1 least privilege (no stale SSM; the ONLY `*` is ListSchedules)', () => {
  it('grants GetSecretValue but no ssm:GetParameter; the ONLY Resource:`*` statement is scheduler:ListSchedules + a Condition', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const allPolicyJson = JSON.stringify(Object.values(policies));
    expect(allPolicyJson).toContain('secretsmanager:GetSecretValue');
    expect(allPolicyJson).not.toContain('ssm:GetParameter');
    expect(allPolicyJson).not.toContain('parameter/medadhere/twilio-from');
    expect(allPolicyJson).not.toContain('bedrock:');
    expect(allPolicyJson).not.toContain('servicequotas:');

    // The H1 STOP-sweep grant introduces exactly ONE `*` statement (ListSchedules — it has no resource
    // type). Every OTHER statement stays scoped; the carve-out invariant mirrors the enroll construct.
    const statements = allStatements(template);
    for (const stmt of statements) {
      const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
      if (!resources.some((r) => r === '*')) continue;
      expect(actionsOf(stmt)).toEqual(['scheduler:ListSchedules']);
      expect(stmt.Condition).toBeDefined();
    }
    const starStatements = statements.filter((s) => {
      const rs = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
      return rs.some((r) => r === '*');
    });
    expect(starStatements).toHaveLength(1);
  });
});

describe('InboundConstruct — H1 STOP-sweep IAM (P4 hotfix): List(*+region) + Delete(group-scoped) ONLY', () => {
  it('authors scheduler:ListSchedules as its OWN `*` statement bounded by aws:RequestedRegion (has no resource type)', () => {
    const { template } = synth();
    const listStmts = allStatements(template).filter((s) =>
      actionsOf(s).includes('scheduler:ListSchedules'),
    );
    expect(listStmts.length).toBe(1);
    const listStmt = listStmts[0]!;
    expect(actionsOf(listStmt)).toEqual(['scheduler:ListSchedules']); // never bundled with Delete
    const resources = Array.isArray(listStmt.Resource) ? listStmt.Resource : [listStmt.Resource];
    expect(resources).toEqual(['*']);
    expect(JSON.stringify(listStmt.Condition)).toContain('aws:RequestedRegion');
  });

  it('scopes scheduler:DeleteSchedule to the medadhere-prod schedule/group ARNs (no broad `*`)', () => {
    const { template } = synth();
    const deleteStmts = allStatements(template).filter((s) =>
      actionsOf(s).includes('scheduler:DeleteSchedule'),
    );
    expect(deleteStmts.length).toBeGreaterThanOrEqual(1);
    for (const stmt of deleteStmts) {
      const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
      for (const r of resources) expect(r).not.toBe('*');
      const json = JSON.stringify(resources);
      expect(json).toContain('schedule/medadhere-prod/*'); // the runtime-named per-schedule ARN
      expect(json).toContain('schedule-group/medadhere-prod');
    }
  });

  it('the sweep NEVER creates or passes a role: NO scheduler:CreateSchedule, NO iam:PassRole (it only sweeps)', () => {
    const { template } = synth();
    const statements = allStatements(template);
    for (const stmt of statements) {
      const actions = actionsOf(stmt);
      expect(actions).not.toContain('scheduler:CreateSchedule');
      expect(actions).not.toContain('iam:PassRole');
    }
  });
});
