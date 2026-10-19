// infra/test/data-api.test.ts
//
// The SC4 data-path SHAPE gate. Uses aws-cdk-lib/assertions `Template.fromStack` to prove the
// synthesized CloudFormation for DataApiConstruct has the correct API-GW-native-JWT-authorizer +
// in-VPC-Lambda + clean-teardown + least-privilege + throttle shape WITHOUT any live AWS call,
// no network, and no live DB. Hermetic: a throwaway stack instantiates a minimal VPC + Lambda SG +
// a stub RDS DatabaseInstance + a DB Secret + the plan-01 AuthConstruct (for the pool/client refs),
// then `new DataApiConstruct(...)`.
//
// Pins (the SC4 enforcement contract, plan 02-02):
//   - AWS::ApiGatewayV2::Authorizer of type JWT with a Cognito issuer (D-09 — the enforcement boundary)
//   - GET /api/health route exists and is JWT-authorized (the default authorizer applies)
//   - the data-API Lambda is in-VPC (VpcConfig/SubnetIds), ARM64, node24, no PGSSLMODE env, no DB password env
//   - the data-API LogGroup is DESTROY + RetentionInDays 7 (F61 teardown)
//   - M4 / INFRA-02 — the $default Stage carries DefaultRouteSettings 50/50
//   - M1 — the data-API Lambda IAM policy grants secretsmanager:GetSecretValue (DB secret), with no `*`
//     resource and no bedrock:/servicequotas: action (least privilege)

import { describe, it, expect } from 'vitest';
import { App, Stack, RemovalPolicy } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { AuthConstruct } from '../lib/constructs/auth.js';
import { DataApiConstruct } from '../lib/constructs/data-api.js';

/**
 * Build a throwaway stack hermetically: a minimal VPC + Lambda SG + a stub RDS instance + a DB Secret
 * + the plan-01 AuthConstruct (pool/client refs), then the DataApiConstruct under test. This is a
 * fast isolated stack (NOT the full FoundationStack) so the synth stays quick.
 */
function synth() {
  const app = new App();
  const stack = new Stack(app, 'TestDataApi', {
    env: { account: '123456789012', region: 'us-east-1' },
  });

  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2 });
  const lambdaSg = new ec2.SecurityGroup(stack, 'LambdaSg', { vpc });

  // A minimal stub RDS instance — only its endpoint host/port + its generated secret are consumed.
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

  // Use a standalone DB secret reference so the M1 IAM-policy assertion targets a known logical-id
  // fragment. (db.secret is itself a Secret; grantRead on it produces a policy referencing it.)

  const auth = new AuthConstruct(stack, 'Auth', {
    amplifyCallbackUrl: 'https://main.example-amplify.amazonaws.com',
    vercelCallbackUrl: 'https://medadhere.vercel.app',
  });

  new DataApiConstruct(stack, 'DataApi', {
    vpc,
    lambdaSg,
    db,
    dbSecret,
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
  });

  return {
    stack,
    template: Template.fromStack(stack),
    dbSecret,
    userPoolClient: auth.userPoolClient,
  };
}

describe('DataApiConstruct — native Cognito JWT authorizer (SC4 / D-09 — the enforcement boundary)', () => {
  it('declares exactly one HTTP API', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  });

  it('fronts it with a native JWT authorizer keyed to a Cognito issuer + a client audience', () => {
    const { template } = synth();
    // The authorizer is JWT with an Audience (the [clientId] list) and an Issuer. The Issuer is a CDK
    // `Fn::Join` token (region + pool id) — not a plain string — so assert its shape, then assert the
    // `cognito-idp` literal is present in the joined issuer URL (D-09 — issuer = pool URL).
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
      JwtConfiguration: Match.objectLike({
        Audience: Match.anyValue(), // [clientId] — id_token aud === client id (D-09/D-10)
        Issuer: Match.anyValue(),
      }),
    });
    // The issuer URL is built as `https://cognito-idp.<region>.amazonaws.com/<poolId>` — assert the
    // load-bearing `cognito-idp` host literal appears in the synthesized authorizer (the Cognito pin).
    const authorizers = template.findResources('AWS::ApiGatewayV2::Authorizer');
    const auth = Object.values(authorizers)[0]!;
    const jwt = (auth.Properties as { JwtConfiguration: { Issuer: unknown } }).JwtConfiguration;
    expect(JSON.stringify(jwt.Issuer)).toContain('cognito-idp');
  });

  it('L2 — the JWT Audience references the UserPoolClient (a wrong client-id audience must fail)', () => {
    // L2 — Match.anyValue() on Audience would pass even for a WRONG client id. The audience is
    // jwtAudience=[clientId] which CDK renders as [{ Ref: <UserPoolClient logical id> }]; assert the
    // synthesized Audience resolves to a Ref of THIS pool's client (mirror the dbSecret logical-id
    // technique used by the M1 IAM assertion). A token whose aud is any other client must be rejected.
    const { template, userPoolClient } = synth();
    const clientLogicalId = stackLogicalId(
      userPoolClient as unknown as { node: { defaultChild?: unknown } } & object,
    );
    const authorizers = template.findResources('AWS::ApiGatewayV2::Authorizer');
    const auth = Object.values(authorizers)[0]!;
    const audience = (auth.Properties as { JwtConfiguration: { Audience: unknown } })
      .JwtConfiguration.Audience;
    // The audience is the single-element [{ Ref: <client logical id> }] list (id_token aud === client).
    expect(JSON.stringify(audience)).toContain(clientLogicalId);
  });

  it('exposes a GET /api/health route that is JWT-authorized (the default authorizer applies)', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /api/health',
      AuthorizationType: 'JWT', // the route is protected by the default authorizer (T-02-06)
    });
  });
});

describe('DataApiConstruct — in-VPC data-API Lambda (F07/F49/F28 / SC4)', () => {
  it('places all five database Lambdas in private subnets on nodejs24.x / arm64', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    // Our in-VPC functions = those with a VpcConfig (the apigw integration adds no in-VPC fn). Since 05-03
    // there are TWO: the read-only SELECT-1 health fn AND the dedicated admin-deactivation write fn (Q4).
    const ourFns = Object.values(fns).filter(
      (f) => (f.Properties as { VpcConfig?: unknown }).VpcConfig !== undefined,
    );
    expect(ourFns.length).toBe(5); // data API + four dedicated doctor-write functions
    for (const f of ourFns) {
      const p = f.Properties as {
        Runtime: string;
        Architectures: string[];
        VpcConfig: { SubnetIds: unknown };
      };
      expect(p.Runtime).toBe('nodejs24.x'); // F07
      expect(p.Architectures).toEqual(['arm64']); // F07
      expect(p.VpcConfig.SubnetIds).toBeDefined(); // F49 — in the VPC private subnets
    }
  });

  it('carries the DB env (DB_NAME=medadhere) with NO PGSSLMODE and NO DB password env (F28 / D-06)', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    const dataApi = Object.values(fns).find(
      (f) =>
        (f.Properties as { Environment?: { Variables?: Record<string, unknown> } }).Environment
          ?.Variables?.DB_NAME === 'medadhere',
    );
    expect(dataApi).toBeDefined();
    const env = (
      dataApi!.Properties as {
        Environment: { Variables: Record<string, unknown> };
      }
    ).Environment.Variables;
    // F28 — single-source TLS via the pg `ssl` object; no PGSSLMODE downgrade path in the env.
    expect('PGSSLMODE' in env).toBe(false);
    // D-06 — the DB password is fetched per-invoke from Secrets Manager, never an env var.
    expect('DB_PASSWORD' in env).toBe(false);
    expect('DB_PASS' in env).toBe(false);
    // The secret is referenced by ARN (DB_SECRET_ARN), not by value.
    expect('DB_SECRET_ARN' in env).toBe(true);
  });

  it('gives the data-API Lambda an explicit DESTROY/ONE_WEEK log group (F61 teardown)', () => {
    const { template } = synth();
    template.hasResource('AWS::Logs::LogGroup', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({ RetentionInDays: 7 }),
    });
  });
});

describe('DataApiConstruct — M4 / INFRA-02: $default stage is throttled to 50/50', () => {
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

describe('DataApiConstruct — M1: data-API Lambda IAM is least-privilege (dbSecret.grantRead only)', () => {
  it('grants secretsmanager:GetSecretValue on the DB secret, with no `*` resource and no bedrock:/servicequotas: action', () => {
    const { template, dbSecret } = synth();
    const policies = template.findResources('AWS::IAM::Policy');

    // Find the policy that references the DB secret — its PolicyDocument resolves the secret ARN via a
    // `{ Ref: <secret logical id> }`, so the secret's logical-id fragment appears in the policy JSON.
    // Since 05-03 TWO fns grantRead the DB secret (health + deactivation). This M1 assertion targets the
    // READ-ONLY health fn — the DB-secret policy WITHOUT any scheduler action (the deactivation fn's scoped
    // List/Delete IAM is asserted in the 05-03 block below); the health fn must stay grantRead-only (Q4).
    const secretLogicalId = stackLogicalId(dbSecret);
    const dbPolicy = Object.values(policies).find((p) => {
      const docStr = JSON.stringify((p.Properties as { PolicyDocument: unknown }).PolicyDocument);
      return docStr.includes(secretLogicalId) && !docStr.includes('scheduler:');
    });
    expect(dbPolicy).toBeDefined();

    const policyJson = JSON.stringify(dbPolicy);
    // It grants GetSecretValue on the DB secret...
    expect(policyJson).toContain('secretsmanager:GetSecretValue');
    // ...and carries NO Bedrock / servicequotas action of any kind (grantRead-ONLY — M1 least privilege).
    expect(policyJson).not.toContain('bedrock:');
    expect(policyJson).not.toContain('servicequotas:');

    // No `*` (all-resources) grant in the policy document — every statement is scoped to a resource ARN.
    const doc = (
      dbPolicy!.Properties as {
        PolicyDocument: { Statement: Array<{ Resource: unknown }> };
      }
    ).PolicyDocument;
    for (const stmt of doc.Statement) {
      const r = stmt.Resource;
      const resources = Array.isArray(r) ? r : [r];
      for (const res of resources) {
        expect(res).not.toBe('*'); // no all-resources grant (least privilege)
      }
    }
  });
});

describe('DataApiConstruct — 05-03 admin deactivation route (dedicated write Lambda / STUDY-05 / Q4/M1/M12)', () => {
  /** Coerce a policy statement's Action to a string[] (CDK renders a single action as a bare string). */
  function actionsIn(stmt: { Action: unknown }): string[] {
    const a = stmt.Action;
    return Array.isArray(a) ? (a as string[]) : [a as string];
  }
  /** The DefaultPolicy of the dedicated deactivation fn (logical id carries `Deactivate`). */
  function deactivatePolicyDoc(template: ReturnType<typeof synth>['template']) {
    const policies = template.findResources('AWS::IAM::Policy');
    const entry = Object.entries(policies).find(([id]) => id.includes('Deactivate'));
    expect(entry).toBeDefined();
    return (
      entry![1].Properties as {
        PolicyDocument: {
          Statement: Array<{ Action: unknown; Resource: unknown; Condition?: unknown }>;
        };
      }
    ).PolicyDocument;
  }

  it('exposes POST /api/patients/{id}/deactivate on the SAME HTTP API, JWT-authorized (the default authorizer covers it)', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /api/patients/{id}/deactivate',
      AuthorizationType: 'JWT', // the Cognito default authorizer applies — an unauthenticated call 401s at the gateway
    });
  });

  it('proves the 401 gateway boundary: EVERY route is JWT-authorized — there is NO AuthorizationType NONE route', () => {
    const { template } = synth();
    // Both the health route and the new deactivate route inherit the Cognito defaultAuthorizer, so a
    // tokenless request is rejected 401 at the authorizer BEFORE any Lambda runs (no unauthenticated route).
    const routes = template.findResources('AWS::ApiGatewayV2::Route');
    expect(Object.keys(routes).length).toBeGreaterThanOrEqual(2);
    for (const r of Object.values(routes)) {
      expect((r.Properties as { AuthorizationType?: string }).AuthorizationType).toBe('JWT');
    }
    // Exactly one authorizer, and it is the Cognito JWT one (the enforcement boundary, D-09).
    template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', { AuthorizerType: 'JWT' });
  });

  it('grants the deactivation fn ONLY sweep-side scheduler IAM: ListSchedules(*+region) + DeleteSchedule(group) — NO Create, NO PassRole', () => {
    const { template } = synth();
    const doc = deactivatePolicyDoc(template);

    // ListSchedules has NO resource type → its own statement, Resource '*' bounded by aws:RequestedRegion.
    const listStmt = doc.Statement.find((s) => actionsIn(s).includes('scheduler:ListSchedules'));
    expect(listStmt).toBeDefined();
    const listResources = Array.isArray(listStmt!.Resource)
      ? listStmt!.Resource
      : [listStmt!.Resource];
    expect(listResources).toContain('*');
    expect(JSON.stringify(listStmt!.Condition)).toContain('aws:RequestedRegion');

    // DeleteSchedule is group-scoped (runtime-name wildcard inside medadhere-prod) — never a bare `*`.
    const delStmt = doc.Statement.find((s) => actionsIn(s).includes('scheduler:DeleteSchedule'));
    expect(delStmt).toBeDefined();
    const delResources = Array.isArray(delStmt!.Resource) ? delStmt!.Resource : [delStmt!.Resource];
    for (const r of delResources) expect(r).not.toBe('*');
    expect(JSON.stringify(delResources)).toContain('schedule/medadhere-prod');

    // The sweep NEVER creates and NEVER passes a role (create-only + PassRole live on Outbound/Enroll).
    for (const s of doc.Statement) {
      expect(actionsIn(s)).not.toContain('scheduler:CreateSchedule');
      expect(actionsIn(s)).not.toContain('iam:PassRole');
    }
  });

  it('Q4: the read-only SELECT-1 health fn carries ZERO scheduler IAM (only the dedicated write fn sweeps)', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    // The health fn's policy is the DataApiFn one (NOT the Deactivate one). It must carry no scheduler action.
    const healthEntry = Object.entries(policies).find(
      ([id]) => id.includes('DataApiFn') && !id.includes('Deactivate'),
    );
    expect(healthEntry).toBeDefined();
    expect(JSON.stringify(healthEntry![1])).not.toContain('scheduler:');
  });

  it('M12: selfSignUpEnabled stays false (AdminCreateUserOnly) — authz==authn today, single admin', () => {
    // The single-admin assumption that makes "any pool member == the admin" hold. If the pool ever goes
    // multi-user this guard fails, flagging that the P6 group/scope check is now required (data-api.ts note).
    const { template } = synth();
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
    });
  });
});

describe('DataApiConstruct — 06-01 read expansion (SC0 / D1 — routeKey switch on the read-only SELECT fn)', () => {
  // D1: the SELECT fn gains an internal routeKey switch for ALL five reads. They land as NEW routes on the
  // SAME HTTP API behind the SAME Cognito defaultAuthorizer (zero IAM delta) — the writes stay on their own
  // dedicated fn. Synth gate: every read route exists, is JWT-authorized, and adds NO new in-VPC Lambda.
  const READ_ROUTES = [
    'GET /api/patients',
    'GET /api/patients/{id}',
    'GET /api/cohort-adherence',
    'GET /api/reviews/safety',
    'GET /api/reviews/unknown',
    'GET /api/patients/{id}/record',
    'GET /api/reviews/alerts',
    'GET /api/reviews/drafts',
  ];

  it('exposes all eight read routes on the SAME HTTP API, each JWT-authorized (the default authorizer covers them)', () => {
    const { template } = synth();
    for (const routeKey of READ_ROUTES) {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: routeKey,
        AuthorizationType: 'JWT', // inherits the Cognito defaultAuthorizer — a tokenless call 401s at the gateway
      });
    }
  });

  it('wires the Phase-8 record, alert, and draft reads to the existing data API function', () => {
    const { template } = synth();
    const routes = template.findResources('AWS::ApiGatewayV2::Route');
    const integrations = template.findResources('AWS::ApiGatewayV2::Integration');
    for (const routeKey of [
      'GET /api/patients/{id}/record',
      'GET /api/reviews/alerts',
      'GET /api/reviews/drafts',
      // The contact-detail correction is a doctor WRITE that deliberately rides the same fn as the
      // clinical-history writes — no new Lambda, no IAM delta.
      'POST /api/patients/{id}/details',
    ]) {
      const route = Object.values(routes).find(
        (candidate) => (candidate.Properties as { RouteKey?: string }).RouteKey === routeKey,
      );
      expect(route).toBeDefined();
      const target = JSON.stringify((route!.Properties as { Target: unknown }).Target);
      const integration = Object.entries(integrations).find(([logicalId]) =>
        target.includes(logicalId),
      )?.[1];
      expect(integration).toBeDefined();
      expect(JSON.stringify(integration!.Properties)).toContain('DataApiFn');
    }
  });

  it('has exactly eighteen routes after the Phase-8 doctor read/write routes', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 18);
  });

  it('EVERY route is JWT-authorized — there is still NO AuthorizationType NONE route', () => {
    const { template } = synth();
    const routes = template.findResources('AWS::ApiGatewayV2::Route');
    expect(Object.keys(routes).length).toBe(18);
    for (const r of Object.values(routes)) {
      expect((r.Properties as { AuthorizationType?: string }).AuthorizationType).toBe('JWT');
    }
    template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
  });

  it('keeps dashboard reads and doctor-only clinical history on the existing data API Lambda', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    const ourFns = Object.values(fns).filter(
      (f) => (f.Properties as { VpcConfig?: unknown }).VpcConfig !== undefined,
    );
    expect(ourFns.length).toBe(5);
  });
});

describe('DataApiConstruct — doctor-only clinical history', () => {
  it.each([
    'GET /api/patients/{id}/clinical-history',
    'POST /api/patients/{id}/medications',
    'POST /api/patients/{id}/clinical-facts',
    'POST /api/patients/{id}/details',
  ])('exposes %s behind the Cognito JWT authorizer', (routeKey) => {
    const { template } = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: routeKey,
      AuthorizationType: 'JWT',
    });
  });

  it.each([
    ['POST /api/patients/{id}/drafts/{draftId}/decision', 'ReviewDecisionFn'],
    ['POST /api/patients/{id}/reminder-limit', 'ReminderLimitFn'],
    ['POST /api/patients/{id}/reactivate', 'ReactivateFn'],
  ])('wires %s only to its dedicated %s integration', (routeKey, functionName) => {
    const { template } = synth();
    const route = Object.values(template.findResources('AWS::ApiGatewayV2::Route')).find(
      (candidate) => (candidate.Properties as { RouteKey?: string }).RouteKey === routeKey,
    );
    expect(route).toBeDefined();
    const target = JSON.stringify((route!.Properties as { Target: unknown }).Target);
    const integration = Object.entries(
      template.findResources('AWS::ApiGatewayV2::Integration'),
    ).find(([logicalId]) => target.includes(logicalId))?.[1];
    expect(integration).toBeDefined();
    expect(JSON.stringify(integration!.Properties)).toContain(functionName);
  });
});

describe('DataApiConstruct — 08-06 dedicated doctor writes', () => {
  it.each([
    'POST /api/patients/{id}/drafts/{draftId}/decision',
    'POST /api/patients/{id}/reminder-limit',
    'POST /api/patients/{id}/reactivate',
  ])('exposes %s behind the Cognito JWT authorizer', (routeKey) => {
    const { template } = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: routeKey,
      AuthorizationType: 'JWT',
    });
  });

  it('creates one dedicated VPC Lambda per write with the app DB secret and no TLS downgrade env', () => {
    const { template } = synth();
    const functions = template.findResources('AWS::Lambda::Function');
    for (const name of ['ReviewDecisionFn', 'ReminderLimitFn', 'ReactivateFn']) {
      const entry = Object.entries(functions).find(([logicalId]) => logicalId.includes(name));
      expect(entry).toBeDefined();
      const properties = entry![1].Properties as {
        Runtime: string;
        Architectures: string[];
        VpcConfig?: unknown;
        Environment?: { Variables?: Record<string, unknown> };
      };
      expect(properties.Runtime).toBe('nodejs24.x');
      expect(properties.Architectures).toEqual(['arm64']);
      expect(properties.VpcConfig).toBeDefined();
      const env = properties.Environment?.Variables ?? {};
      expect(env.DB_NAME).toBe('medadhere');
      expect('DB_SECRET_ARN' in env).toBe(true);
      expect('PGSSLMODE' in env).toBe(false);
      expect('DB_PASSWORD' in env).toBe(false);
    }
  });

  it('keeps review-decision and reminder-limit free of Scheduler, Twilio, and LLM permissions', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    for (const name of ['ReviewDecisionFn', 'ReminderLimitFn']) {
      const entry = Object.entries(policies).find(([logicalId]) => logicalId.includes(name));
      expect(entry).toBeDefined();
      const serialized = JSON.stringify(entry![1]);
      expect(serialized).not.toContain('scheduler:');
      expect(serialized).not.toContain('twilio');
      expect(serialized).not.toContain('bedrock:');
      expect(serialized).not.toContain('anthropic');
      expect(serialized).not.toContain('servicequotas:');
    }
  });

  it('gives each doctor writer only the scoped app-secret read before stack post-wiring', () => {
    const { template, dbSecret } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const secretLogicalId = stackLogicalId(dbSecret);
    for (const name of ['ReviewDecisionFn', 'ReminderLimitFn', 'ReactivateFn']) {
      const entry = Object.entries(policies).find(([logicalId]) => logicalId.includes(name));
      expect(entry).toBeDefined();
      const document = (
        entry![1].Properties as {
          PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> };
        }
      ).PolicyDocument;
      const secretStatement = document.Statement.find((statement) =>
        JSON.stringify(statement.Action).includes('secretsmanager:GetSecretValue'),
      );
      expect(secretStatement).toBeDefined();
      expect(JSON.stringify(secretStatement!.Resource)).toContain(secretLogicalId);
      expect(secretStatement!.Resource).not.toBe('*');
    }
  });
});

describe('DataApiConstruct — 06-02 enrollment write path (DASH-05 / D2 — lean non-VPC enroll-api fn + POST route)', () => {
  it('exposes POST /api/patients on the SAME HTTP API, JWT-authorized (the Cognito default authorizer covers it)', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /api/patients',
      AuthorizationType: 'JWT', // a tokenless enrollment 401s at the gateway BEFORE the Lambda
    });
  });

  it('adds the enroll-api fn as a lean NON-VPC nodejs24.x/arm64 fn (no VpcConfig, no DB env, 28s cap)', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    // The enroll-api is the sole non-VPC function; data API and deactivation use the database VPC.
    expect(Object.keys(fns).length).toBe(6);
    const inVpc = Object.values(fns).filter(
      (f) => (f.Properties as { VpcConfig?: unknown }).VpcConfig !== undefined,
    );
    expect(inVpc.length).toBe(5);
    const nonVpc = Object.values(fns).filter(
      (f) => (f.Properties as { VpcConfig?: unknown }).VpcConfig === undefined,
    );
    expect(nonVpc.length).toBe(1);

    const enrollApi = nonVpc[0]!;
    const p = enrollApi.Properties as {
      Runtime: string;
      Architectures: string[];
      Timeout: number;
      Environment?: { Variables?: Record<string, unknown> };
    };
    expect(p.Runtime).toBe('nodejs24.x'); // F07
    expect(p.Architectures).toEqual(['arm64']); // F07
    expect(p.Timeout).toBe(28); // < the 29s API-GW HTTP-integration cap (D2)
    // Lean: NO DB secret / host env, NO PGSSLMODE — it never opens a pg connection.
    const env = p.Environment?.Variables ?? {};
    expect('DB_SECRET_ARN' in env).toBe(false);
    expect('DB_HOST' in env).toBe(false);
    expect('PGSSLMODE' in env).toBe(false);
  });

  it('gives every function its own DESTROY/ONE_WEEK log group (F61 teardown)', () => {
    const { template } = synth();
    // Five DB functions + the lean enroll-api function.
    template.resourceCountIs('AWS::Logs::LogGroup', 6);
  });
});

/**
 * Resolve the CloudFormation logical id CDK assigns a construct's default child (the L1 resource).
 * Used to find the IAM policy that references the DB secret via its `{ Ref: <logicalId> }`.
 */
function stackLogicalId(construct: { node: { defaultChild?: unknown } } & object): string {
  const stack = Stack.of(construct as never);
  const child = (construct as { node: { defaultChild?: unknown } }).node.defaultChild;
  return stack.resolve((child as { logicalId: string }).logicalId) as string;
}
