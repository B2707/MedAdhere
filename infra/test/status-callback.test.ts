// infra/test/status-callback.test.ts
//
// The SC7 status-callback SHAPE gate — the deliberate INVERSE of data-api.test.ts's JWT-authorizer
// assertion. Uses aws-cdk-lib/assertions `Template.fromStack` to prove the synthesized CloudFormation
// for StatusCallbackConstruct has the correct PUBLIC (un-authorized) HTTP route + in-VPC + clean-
// teardown + throttle + least-privilege shape WITHOUT any live AWS call.
//
// Pins:
//   - the POST /twilio/status route has NO AuthorizationType JWT (the inverse of data-api.test.ts:122-128)
//   - the synthesized stack has ZERO AWS::ApiGatewayV2::Authorizer resources (so a FUTURE accidental
//     authorizer on the public callback FAILS this test — the load-bearing guard)
//   - the callback Lambda is in-VPC (VpcConfig/SubnetIds), nodejs24.x / arm64, NO PGSSLMODE env (F28)
//   - M4 / INFRA-02 — the $default Stage carries DefaultRouteSettings 50/50 (the T-03-09 flood cap)
//   - M1 — grantRead-only IAM (GetSecretValue on the DB + Twilio secrets), no `*`, no bedrock:/servicequotas:

import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { describe, it, expect } from 'vitest';
import { App, Stack, RemovalPolicy } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { StatusCallbackConstruct } from '../lib/constructs/status-callback.js';

function synth() {
  const app = new App();
  const stack = new Stack(app, 'TestStatusCallback', {
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

  new StatusCallbackConstruct(stack, 'StatusCallback', {
    vpc,
    lambdaSg,
    db,
    dbSecret,
    twilioSecret,
    statusCallbackUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com/twilio/status',
  });

  return { stack, template: Template.fromStack(stack), dbSecret, twilioSecret };
}

describe('StatusCallbackConstruct — PUBLIC route, NO authorizer (resolved default 3 — inverse of data-api)', () => {
  it('declares exactly one HTTP API', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  });

  it('exposes a POST /twilio/status route with NO AuthorizationType JWT', () => {
    const { template } = synth();
    const routes = template.findResources('AWS::ApiGatewayV2::Route');
    const statusRoute = Object.values(routes).find(
      (r) => (r.Properties as { RouteKey?: string }).RouteKey === 'POST /twilio/status',
    );
    expect(statusRoute).toBeDefined();
    const props = statusRoute!.Properties as { AuthorizationType?: string };
    // The route is intentionally NOT JWT-authorized (auth is the in-handler HMAC). API GW renders an
    // un-authorized route with AuthorizationType 'NONE' or no AuthorizationType key at all — assert it
    // is NOT 'JWT' either way (the inverse of the data-api JWT assertion).
    expect(props.AuthorizationType).not.toBe('JWT');
  });

  it('the synthesized stack has ZERO ApiGatewayV2::Authorizer resources (the public callback must NEVER gain an authorizer)', () => {
    // This is the load-bearing guard: a future accidental defaultAuthorizer / per-route authorizer on
    // the public callback would synthesize an Authorizer resource and FAIL this test.
    const { template } = synth();
    const authorizers = template.findResources('AWS::ApiGatewayV2::Authorizer');
    expect(Object.keys(authorizers)).toHaveLength(0);
    template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 0);
  });
});

describe('StatusCallbackConstruct — in-VPC callback Lambda (F07/F49/F28)', () => {
  it('places the callback Lambda in the VPC private subnets on nodejs24.x / arm64', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    const ourFns = Object.values(fns).filter(
      (f) => (f.Properties as { VpcConfig?: unknown }).VpcConfig !== undefined,
    );
    expect(ourFns.length).toBe(1); // the single callback fn (the apigw integration adds no in-VPC fn)
    const p = ourFns[0]!.Properties as {
      Runtime: string;
      Architectures: string[];
      VpcConfig: { SubnetIds: unknown };
    };
    expect(p.Runtime).toBe('nodejs24.x'); // F07
    expect(p.Architectures).toEqual(['arm64']); // F07
    expect(p.VpcConfig.SubnetIds).toBeDefined(); // F49
  });

  it('carries the DB + Twilio env with NO PGSSLMODE and NO DB password (F28 / D-06)', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    const callback = Object.values(fns).find(
      (f) =>
        (f.Properties as { Environment?: { Variables?: Record<string, unknown> } }).Environment
          ?.Variables?.DB_NAME === 'medadhere',
    );
    expect(callback).toBeDefined();
    const env = (
      callback!.Properties as {
        Environment: { Variables: Record<string, unknown> };
      }
    ).Environment.Variables;
    expect('PGSSLMODE' in env).toBe(false); // F28
    expect('DB_PASSWORD' in env).toBe(false); // D-06
    expect('DB_PASS' in env).toBe(false);
    expect('DB_SECRET_ARN' in env).toBe(true);
    expect('TWILIO_SECRET_ARN' in env).toBe(true);
    // Pitfall 2 — the exact callback URL the handler validates against is pinned in the env.
    expect(env.STATUS_CALLBACK_URL).toBe(
      'https://abc123.execute-api.us-east-1.amazonaws.com/twilio/status',
    );
  });

  it('gives the callback Lambda an explicit DESTROY/ONE_WEEK log group (F61 teardown)', () => {
    const { template } = synth();
    template.hasResource('AWS::Logs::LogGroup', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({ RetentionInDays: 7 }),
    });
  });
});

describe('StatusCallbackConstruct — M4 / INFRA-02: $default stage throttled to 50/50 (T-03-09 flood cap)', () => {
  it('sets DefaultRouteSettings ThrottlingRateLimit:50 + ThrottlingBurstLimit:50 on the Stage', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: Match.objectLike({
        ThrottlingRateLimit: 50,
        ThrottlingBurstLimit: 50,
      }),
    });
  });
});

describe('StatusCallbackConstruct — OPS-02 (f): the consecutive-undelivered derivation is provider-scoped', () => {
  it('the bundled handler lookback filters to rows that reached the provider (sent_at IS NOT NULL)', () => {
    // The alarm's metric filter (monitoring.ts) can only see the emitted log line, so the
    // suppression guard lives in the handler's streak SQL. Pin it here the way outbound.test.ts
    // pins its bundling cp lines: a future edit that drops the filter would page the delivery
    // alarm for suppressed record-only rows that never reached Twilio.
    const src = readFileSync(
      nodePath.join(__dirname, '..', '..', 'backend', 'src', 'status-callback', 'handler.ts'),
      'utf8',
    );
    expect(src).toMatch(
      /SELECT status FROM outbound_message[\s\S]*?sent_at IS NOT NULL[\s\S]*?LIMIT/,
    );
  });
});

describe('StatusCallbackConstruct — M1: grantRead-only IAM (no `*`, no bedrock:/servicequotas:)', () => {
  it('grants secretsmanager:GetSecretValue on the DB + Twilio secrets, with no `*` resource and no bedrock:/servicequotas: action', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const allPolicyJson = JSON.stringify(Object.values(policies));
    expect(allPolicyJson).toContain('secretsmanager:GetSecretValue');
    expect(allPolicyJson).not.toContain('bedrock:');
    expect(allPolicyJson).not.toContain('servicequotas:');

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
});
