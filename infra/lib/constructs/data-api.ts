// infra/lib/constructs/data-api.ts
//
// DataApiConstruct (SC4 / D-09/D-10/D-11/D-12 / F07/F28/F47/F49/F61 / INFRA-02 / M1/M4) — the
// data-path half of the Phase-2 proof chain. Fronts the in-VPC data-API Lambda with an API Gateway
// HTTP API v2 + a NATIVE Cognito JWT authorizer, per RESEARCH Pattern 3.
//
//   Public internet → API GW HTTP API ( native Cognito JWT authorizer = the enforcement boundary )
//     → in-VPC NodejsFunction (PRIVATE_WITH_EGRESS, shared lambdaSg) → RDS SELECT 1 → { ok: true }
//
// Plan 05-03 (STUDY-05 / Q4/M1/M12) adds a SECOND route + a SECOND dedicated fn behind the SAME HTTP API +
// the SAME Cognito defaultAuthorizer: POST /api/patients/{id}/deactivate → the admin-deactivation write
// Lambda (this.deactivateFn). Q4 — it is a SEPARATE fn so the read-only SELECT-1 health fn NEVER carries
// scheduler:DeleteSchedule; the write fn holds sweep-only scheduler IAM (List + Delete, NO Create/PassRole).
//
// The authorizer validates the id_token BEFORE the Lambda (issuer = this pool's URL, jwtAudience =
// [clientId]); the Lambda does ZERO JWT work (D-09). A direct call to the API GW URL without a valid
// id_token fails closed at the authorizer, independent of the Next.js middleware (T-02-06 defense in
// depth). No CORS — the /patients server component calls server-to-server (D-10, T-02 surface min).
//
// In-VPC Lambda shape mirrors smoke.ts EXACTLY (the leaner in-VPC NodejsFunction — NOT schema-init's
// Provider/CustomResource): ARM64/node24 (F07), PRIVATE_WITH_EGRESS + the shared lambdaSg (F49), an
// explicit DESTROY/ONE_WEEK LogGroup (F61), 30s timeout (F47). The RDS CA bundle is copied into the
// bundle via esbuild afterBundling (F01/F03 — load-bearing: the handler's runtime
// readFileSync(join(__dirname,'rds-global-bundle.pem')) ENOENTs without it), and `pg` is kept out of
// the esbuild bundle (nodeModules:['pg']). env DB_SECRET_ARN/DB_HOST/DB_PORT/DB_NAME — and NO
// PGSSLMODE (F28; the handler single-sources TLS via the explicit pg `ssl` object).
//
// M1 — least privilege: the only grant is `dbSecret.grantRead(this.fn)` (secretsmanager:GetSecretValue
// on the DB secret only). No `*` resource, no bedrock:/servicequotas: anywhere. The lambdaSg→RDS:5432
// ingress already exists on the shared SG (database.ts allowFrom(lambdaSg)), so NO new per-fn ingress.
//
// M4 / INFRA-02 — the auto-created $default stage is throttled to rateLimit:50 / burstLimit:50 (the
// T-02-11 API-flood cap). The L2 HttpStage exposes no throttle prop, so we set the CfnStage's
// DefaultRouteSettings via the escape hatch (the synthesized Stage carries DefaultRouteSettings:
// { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 50 }).
//
// This construct is NOT wired into FoundationStack here — plan 04 (the integration wave) consumes it,
// passing the live Phase-1 VPC/SG/db/dbSecret + the plan-01 Cognito userPool/userPoolClient by
// in-process object reference (D-12 — NO Fn::ImportValue, NO cross-stack export).

import { Construct } from 'constructs';
import { Stack, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as path from 'node:path';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import { HttpApi, HttpMethod, CfnStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { DATABASE_NAME } from './database.js';
import { SCHEDULE_GROUP_NAME } from './scheduler.js';

// Repo paths (this file is infra/lib/constructs/ → repo root is three levels up).
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const DATA_API_DIR = path.join(REPO_ROOT, 'backend', 'src', 'data-api');
const HANDLER_ENTRY = path.join(DATA_API_DIR, 'handler.ts');
// Plan 05-03 — the DEDICATED admin-deactivation write Lambda (Q4 — its own fn, never a router on the health fn).
const DEACTIVATE_DIR = path.join(REPO_ROOT, 'backend', 'src', 'deactivate');
const DEACTIVATE_ENTRY = path.join(DEACTIVATE_DIR, 'handler.ts');
const REVIEW_DECISION_ENTRY = path.join(
  REPO_ROOT,
  'backend',
  'src',
  'review-decision',
  'handler.ts',
);
const REMINDER_LIMIT_ENTRY = path.join(REPO_ROOT, 'backend', 'src', 'reminder-limit', 'handler.ts');
const REACTIVATE_ENTRY = path.join(REPO_ROOT, 'backend', 'src', 'reactivate', 'handler.ts');
// Plan 06-02 (DASH-05 / D2) — the lean NON-VPC enroll-api write fn (validates + SYNC-invokes the Enroll fn).
const ENROLL_API_DIR = path.join(REPO_ROOT, 'backend', 'src', 'enroll-api');
const ENROLL_API_ENTRY = path.join(ENROLL_API_DIR, 'handler.ts');

export interface DataApiConstructProps {
  /** The VPC from NetworkConstruct (in-process ref — D-12). */
  readonly vpc: ec2.IVpc;
  /** The shared Lambda SG already admitted to RDS:5432 (database.ts allowFrom). */
  readonly lambdaSg: ec2.ISecurityGroup;
  /** The Phase-1 RDS instance — endpoint host/port feed the Lambda env. */
  readonly db: rds.DatabaseInstance;
  /** The CDK-generated DB-credential secret (grantRead target — M1 / D-06). */
  readonly dbSecret: secretsmanager.ISecret;
  /** The plan-01 Cognito user pool — the JWT authorizer's issuer source (D-09). */
  readonly userPool: cognito.IUserPool;
  /** The plan-01 public app client — jwtAudience = [clientId] (id_token aud === client id, D-09/D-10). */
  readonly userPoolClient: cognito.IUserPoolClient;
}

export class DataApiConstruct extends Construct {
  /** The in-VPC data-API Lambda (the SOLE DB client from the dashboard tier). */
  public readonly fn: NodejsFunction;
  /**
   * The DEDICATED in-VPC admin-deactivation write Lambda (Plan 05-03 / STUDY-05 / Q4). A SEPARATE fn from
   * `this.fn` so the read-only SELECT-1 health fn NEVER carries scheduler:DeleteSchedule — it holds the
   * sweep-only scheduler IAM (List + Delete) that the STOP-mirror admin deactivation route needs.
   */
  public readonly deactivateFn: NodejsFunction;
  /** Dedicated DB writer for immutable clinician review decisions. */
  public readonly reviewDecisionFn: NodejsFunction;
  /** Dedicated DB writer for optimistic reminder-limit changes. */
  public readonly reminderLimitFn: NodejsFunction;
  /** Dedicated DB writer for clinician-owned reactivation and schedule restoration. */
  public readonly reactivateFn: NodejsFunction;
  /**
   * The lean NON-VPC enroll-api write Lambda (Plan 06-02 / DASH-05 / D2). It holds NO pg client / NO DB
   * secret / NO VPC attachment — it zod-validates the enrollment body then SYNC-invokes the in-VPC Enroll
   * Lambda. Exposed so FoundationStack can post-wire the grant + ENROLL_FN_ARN env AFTER the Enroll
   * construct is built (construct order — the Enroll fn does not exist yet here; U-4).
   */
  public readonly enrollApiFn: NodejsFunction;
  /** The HTTP API v2 fronting the Lambdas behind the native Cognito JWT authorizer. */
  public readonly httpApi: HttpApi;

  constructor(scope: Construct, id: string, props: DataApiConstructProps) {
    super(scope, id);

    const region = Stack.of(this).region;
    const account = Stack.of(this).account;

    // --- in-VPC data-API Lambda (mirror smoke.ts's leaner shape) --------------------------------
    // Explicit log group (F61) so it does not orphan after cdk destroy.
    const logGroup = new logs.LogGroup(this, 'DataApiLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.fn = new NodejsFunction(this, 'DataApiFn', {
      entry: HANDLER_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X, // F07
      architecture: Architecture.ARM_64, // F07
      timeout: Duration.seconds(30), // F47 — cold VPC + Secrets fetch + RDS round-trip
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }, // F49
      securityGroups: [props.lambdaSg], // F49 — shared SG (already admitted to RDS:5432)
      logGroup,
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        DB_HOST: props.db.dbInstanceEndpointAddress,
        DB_PORT: props.db.dbInstanceEndpointPort,
        DB_NAME: DATABASE_NAME, // "medadhere" (F26)
        // NO PGSSLMODE (F28) — the handler single-sources TLS via the explicit pg `ssl` object.
      },
      bundling: {
        // pg is a real runtime dependency the handler imports; keep it out of the esbuild bundle and
        // install it in the Lambda node_modules instead (native-friendly).
        nodeModules: ['pg'],
        // F01/F03 — copy the AWS RDS global CA bundle (rds-global-bundle.pem, M-2) into the bundle
        // output dir alongside the compiled handler so the handler's runtime
        // readFileSync(join(__dirname,'rds-global-bundle.pem')) resolves for server-cert verification
        // (rejectUnauthorized:true). The copy is part of the OUTPUT bundle hash, so editing it changes
        // the Lambda code-asset S3 key (no stale bundled artifact).
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp ${path.join(inputDir, 'backend', 'src', 'schema-init', 'rds-global-bundle.pem')} ${outputDir}`,
          ],
        },
      },
    });

    // M1 — least privilege: the ONLY grant is GetSecretValue on the DB secret. The lambdaSg→RDS:5432
    // ingress already exists on the shared SG (database.ts allowFrom(lambdaSg)), so NO new ingress. This
    // read-only health fn carries ZERO scheduler IAM (Q4 — that lives ONLY on the deactivation fn below).
    props.dbSecret.grantRead(this.fn);

    // --- dedicated admin-deactivation write Lambda (Plan 05-03 / STUDY-05 / Q4) ------------------
    // Q4 — a SEPARATE in-VPC fn (never a router on the SELECT-1 health fn): the read-only health fn must
    // NEVER carry scheduler:DeleteSchedule. Same in-VPC pg-fn shape as the health fn (F07/F49/F28/F61) with
    // its own DESTROY/ONE_WEEK log group + its own PEM cp; env DB_SECRET_ARN/DB_HOST/DB_PORT/DB_NAME, NO PGSSLMODE.
    const deactivateLogGroup = new logs.LogGroup(this, 'DeactivateLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.deactivateFn = new NodejsFunction(this, 'DeactivateFn', {
      entry: DEACTIVATE_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X, // F07
      architecture: Architecture.ARM_64, // F07
      timeout: Duration.seconds(30), // F47 — cold VPC + Secrets fetch + RDS UPDATE + the schedule sweep
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }, // F49
      securityGroups: [props.lambdaSg], // F49 — shared SG (already admitted to RDS:5432)
      logGroup: deactivateLogGroup,
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        DB_HOST: props.db.dbInstanceEndpointAddress,
        DB_PORT: props.db.dbInstanceEndpointPort,
        DB_NAME: DATABASE_NAME, // "medadhere" (F26)
        // NO PGSSLMODE (F28) — the handler single-sources TLS via the explicit pg `ssl` object.
      },
      bundling: {
        // pg is a real runtime dependency the handler imports; keep it out of the esbuild bundle and
        // install it in the Lambda node_modules instead (native-friendly).
        nodeModules: ['pg'],
        // F01/F03 — copy the AWS RDS global CA bundle (M-2, server-cert verification) into the bundle
        // output dir so the handler's runtime readFileSync(join(__dirname,'rds-global-bundle.pem')) resolves.
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp ${path.join(inputDir, 'backend', 'src', 'schema-init', 'rds-global-bundle.pem')} ${outputDir}`,
          ],
        },
      },
    });

    // M1 — least privilege: GetSecretValue on the DB secret only (the lambdaSg→RDS:5432 ingress already exists).
    props.dbSecret.grantRead(this.deactivateFn);

    // Scheduler IAM (SWEEP-ONLY — mirror enroll.ts:145-159 / the Wave-1 inbound H1 sweep). The handler's
    // deactivateSchedules(id,'dose'|'timeout') paginates ListSchedules then DeleteSchedule each result:
    //   (a) scheduler:DeleteSchedule scoped to the medadhere-prod schedule + group ARNs (runtime-name
    //       wildcard confined to the group — never a bare `*`);
    //   (b) scheduler:ListSchedules as its OWN Resource:'*' statement (the AWS Service Authorization
    //       Reference gives ListSchedules NO resource type, so a scoped ARN is DENIED at runtime — HIGH-2),
    //       bounded by an aws:RequestedRegion Condition so the `*` stays confined to the deploy region.
    // NO CreateSchedule, NO iam:PassRole — the admin sweep never CREATES a schedule (that is Outbound/Enroll).
    const scheduleArn = `arn:aws:scheduler:${region}:${account}:schedule/${SCHEDULE_GROUP_NAME}/*`;
    const scheduleGroupArn = `arn:aws:scheduler:${region}:${account}:schedule-group/${SCHEDULE_GROUP_NAME}`;
    this.deactivateFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['scheduler:DeleteSchedule'],
        resources: [scheduleArn, scheduleGroupArn],
      }),
    );

    this.deactivateFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['scheduler:ListSchedules'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:RequestedRegion': region },
        },
      }),
    );

    const createDoctorWriteFn = (
      functionId: string,
      logGroupId: string,
      entry: string,
    ): NodejsFunction => {
      const writeLogGroup = new logs.LogGroup(this, logGroupId, {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      const fn = new NodejsFunction(this, functionId, {
        entry,
        handler: 'handler',
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        timeout: Duration.seconds(30),
        vpc: props.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [props.lambdaSg],
        logGroup: writeLogGroup,
        environment: {
          DB_SECRET_ARN: props.dbSecret.secretArn,
          DB_HOST: props.db.dbInstanceEndpointAddress,
          DB_PORT: props.db.dbInstanceEndpointPort,
          DB_NAME: DATABASE_NAME,
        },
        bundling: {
          nodeModules: ['pg'],
          commandHooks: {
            beforeBundling: () => [],
            beforeInstall: () => [],
            afterBundling: (inputDir: string, outputDir: string) => [
              `cp ${path.join(inputDir, 'backend', 'src', 'schema-init', 'rds-global-bundle.pem')} ${outputDir}`,
            ],
          },
        },
      });
      props.dbSecret.grantRead(fn);
      return fn;
    };

    this.reviewDecisionFn = createDoctorWriteFn(
      'ReviewDecisionFn',
      'ReviewDecisionLogs',
      REVIEW_DECISION_ENTRY,
    );
    this.reminderLimitFn = createDoctorWriteFn(
      'ReminderLimitFn',
      'ReminderLimitLogs',
      REMINDER_LIMIT_ENTRY,
    );
    this.reactivateFn = createDoctorWriteFn('ReactivateFn', 'ReactivateLogs', REACTIVATE_ENTRY);

    // --- lean NON-VPC enroll-api write fn (Plan 06-02 / DASH-05 / D2) ---------------------------
    // The ONLY public enrollment write front. It is deliberately LEAN + NON-VPC: no vpc/vpcSubnets, no pg
    // (no nodeModules:['pg']), no RDS CA PEM, no dbSecret grant — its only side effect is a synchronous
    // (RequestResponse) invoke of the in-VPC Enroll Lambda, so it never touches RDS directly. timeout 28s
    // stays under the 29s API-GW HTTP-integration cap (a slower integration would surface as a 504). The
    // runtime-provided @aws-sdk/client-lambda is externalized by the default esbuild config (never bundled).
    // The grantInvoke + ENROLL_FN_ARN env are wired at the STACK level (U-4 post-wire) because the Enroll
    // construct is created AFTER this one.
    const enrollApiLogGroup = new logs.LogGroup(this, 'EnrollApiLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.enrollApiFn = new NodejsFunction(this, 'EnrollApiFn', {
      entry: ENROLL_API_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X, // F07
      architecture: Architecture.ARM_64, // F07
      timeout: Duration.seconds(28), // < the 29s API-GW HTTP-integration cap (D2)
      logGroup: enrollApiLogGroup,
      // NON-VPC by omission (no vpc/vpcSubnets/securityGroups): it invokes the Enroll fn over the Lambda
      // control plane, never RDS — so it needs no VPC attachment, no DB env, and no CA bundle.
    });

    // --- HTTP API v2 + native Cognito JWT authorizer (D-09) -------------------------------------
    // STABLE aws-cdk-lib modules only (NO alpha). The authorizer pins issuer = this pool's URL and
    // jwtAudience = [clientId] (id_token aud === client id) — a token from another pool or an aud-less
    // access token is rejected (T-02-07). It is the HTTP API's defaultAuthorizer (the enforcement
    // boundary, D-09); the Lambda does zero JWT work.
    const issuer = `https://cognito-idp.${region}.amazonaws.com/${props.userPool.userPoolId}`;
    const authorizer = new HttpJwtAuthorizer('CognitoJwt', issuer, {
      jwtAudience: [props.userPoolClient.userPoolClientId],
    });

    this.httpApi = new HttpApi(this, 'DataApi', {
      defaultAuthorizer: authorizer,
    });

    // GET /api/health → SELECT 1 (the SC4 route). The default authorizer applies, so the route is
    // JWT-protected with no per-route auth wiring. No CORS (server-to-server, D-10).
    this.httpApi.addRoutes({
      path: '/api/health',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('HealthInt', this.fn),
    });

    // --- Plan 06-01 (SC0 / D1) read expansion: the SELECT fn becomes the READ ROUTER ---------------
    // ALL FIVE dashboard reads land as NEW routes on the SAME HTTP API, wired to the SAME read-only
    // SELECT fn (this.fn) which now switches internally on routeKey. Zero IAM delta — no new fn, no new
    // grant; the Cognito defaultAuthorizer auto-covers every route (a tokenless call 401s at the gateway,
    // D-09). The admin WRITE stays on its own dedicated least-privilege fn (deactivateFn) — reads are
    // never a router on a write fn and writes are never a router on the read fn (Q4 / M12). No CORS
    // (server-to-server, D-10). Adding routes to this.fn creates NO Lambda — the in-VPC fn count stays 2.
    this.httpApi.addRoutes({
      path: '/api/patients',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('PatientsListInt', this.fn),
    });
    this.httpApi.addRoutes({
      path: '/api/patients/{id}',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('PatientDetailInt', this.fn),
    });
    this.httpApi.addRoutes({
      path: '/api/cohort-adherence',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('CohortAdherenceInt', this.fn),
    });
    this.httpApi.addRoutes({
      path: '/api/reviews/safety',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('SafetyQueueInt', this.fn),
    });
    this.httpApi.addRoutes({
      path: '/api/reviews/unknown',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('UnknownQueueInt', this.fn),
    });
    for (const [pathName, integrationId] of [
      ['/api/patients/{id}/record', 'PatientRecordInt'],
      ['/api/reviews/alerts', 'ReviewAlertsInt'],
      ['/api/reviews/drafts', 'ReviewDraftsInt'],
    ] as const) {
      this.httpApi.addRoutes({
        path: pathName,
        methods: [HttpMethod.GET],
        integration: new HttpLambdaIntegration(integrationId, this.fn),
      });
    }

    // POST /api/patients/{id}/deactivate → the dedicated deactivation fn (STUDY-05 / SC4 / Q4). The default
    // Cognito authorizer applies (no per-route auth wiring), so a tokenless request 401s at the gateway
    // BEFORE the Lambda (D-09). No CORS (server-to-server, D-10).
    //
    // M12 — authz==authn TODAY: `selfSignUpEnabled:false` (auth.ts:90) means the pool holds exactly one
    // admin, so "any authenticated caller" == "the admin" and the JWT authorizer IS the authorization (a
    // synth guard in data-api.test.ts pins selfSignUpEnabled false). P6 OBLIGATION: when the pool goes
    // multi-user, add a Cognito group/scope check on this route — and the DECIDED P6 write architecture is
    // THIS dedicated-write-Lambda pattern (a NEW least-privilege fn per admin-write route, never a router on
    // the read-only SELECT fn). L4 forward-obligation: a P6 cookie-auth write UI must add CSRF protection —
    // this backend route is JWT-bearer server-to-server, so it has no cookie surface yet.
    this.httpApi.addRoutes({
      path: '/api/patients/{id}/deactivate',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('DeactivateInt', this.deactivateFn),
    });

    for (const [pathName, integrationId, fn] of [
      ['/api/patients/{id}/drafts/{draftId}/decision', 'ReviewDecisionInt', this.reviewDecisionFn],
      ['/api/patients/{id}/reminder-limit', 'ReminderLimitInt', this.reminderLimitFn],
      ['/api/patients/{id}/reactivate', 'ReactivateInt', this.reactivateFn],
    ] as const) {
      this.httpApi.addRoutes({
        path: pathName,
        methods: [HttpMethod.POST],
        integration: new HttpLambdaIntegration(integrationId, fn),
      });
    }

    for (const [pathName, method, integrationId] of [
      ['/api/patients/{id}/clinical-history', HttpMethod.GET, 'ClinicalHistoryReadInt'],
      ['/api/patients/{id}/medications', HttpMethod.POST, 'ClinicalMedicationWriteInt'],
      ['/api/patients/{id}/clinical-facts', HttpMethod.POST, 'ClinicalFactWriteInt'],
      // The doctor-owned contact-detail correction (people change numbers and names). It rides this fn
      // like the clinical-history writes — no new Lambda, no new grant; it only UPDATEs columns the fn's
      // existing DB credential already reaches, so the IAM delta is zero.
      ['/api/patients/{id}/details', HttpMethod.POST, 'PatientDetailsWriteInt'],
    ] as const) {
      this.httpApi.addRoutes({
        path: pathName,
        methods: [method],
        integration: new HttpLambdaIntegration(integrationId, this.fn),
      });
    }

    // Plan 06-02 (DASH-05 / D2) — POST /api/patients → the lean non-VPC enroll-api fn. It lands on the SAME
    // HTTP API, so the Cognito defaultAuthorizer covers it (a tokenless enrollment 401s at the gateway
    // BEFORE the Lambda — D-09). The GET /api/patients route (the list) already exists; a route is keyed on
    // method+path, so GET and POST on /api/patients are distinct routes. No CORS (server-to-server, D-10).
    this.httpApi.addRoutes({
      path: '/api/patients',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('EnrollApiInt', this.enrollApiFn),
    });

    // M4 / INFRA-02 — throttle the auto-created $default stage to 50 rps / 50 burst (the T-02-11
    // API-flood cap). The L2 HttpStage has no throttle prop, so set the CfnStage's DefaultRouteSettings
    // via the escape hatch — the synthesized AWS::ApiGatewayV2::Stage then carries DefaultRouteSettings:
    // { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 50 }.
    const defaultStage = this.httpApi.defaultStage!;
    (defaultStage.node.defaultChild as CfnStage).defaultRouteSettings = {
      throttlingRateLimit: 50,
      throttlingBurstLimit: 50,
    };
  }
}
