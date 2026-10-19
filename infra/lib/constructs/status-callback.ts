// infra/lib/constructs/status-callback.ts
//
// StatusCallbackConstruct (SC7 / PIPE-01 / F07/F28/F49/F61 / M1/M4 / INFRA-02 / T-03-03/06/08/09) — the
// PUBLIC Twilio delivery-status webhook surface. Fronts the in-VPC status-callback Lambda with an API
// Gateway HTTP API v2 + a single `POST /twilio/status` route that carries NO authorizer (resolved
// default 3 — Twilio cannot present a Cognito JWT; the SOLE auth is the in-handler HMAC validateRequest).
//
//   Twilio (internet) → API GW HTTP API v2 ( NO authorizer — auth is the handler HMAC ) → in-VPC Lambda
//     → forward-only rank-guarded UPDATE outbound_message
//
// This is the deliberate INVERSE of the DataApiConstruct: that one pins a native Cognito JWT authorizer
// as its enforcement boundary; this one OMITS it entirely. The hermetic test asserts the inverse — the
// route has no JWT authorization type AND the synthesized stack has ZERO ApiGatewayV2::Authorizer
// resources — so a future accidental authorizer on the public callback fails the test.
//
// In-VPC Lambda shape mirrors data-api.ts EXACTLY (NODEJS_24_X/ARM_64, PRIVATE_WITH_EGRESS + the shared
// lambdaSg, explicit DESTROY/ONE_WEEK LogGroup, 30s timeout; nodeModules:['pg'] + the afterBundling cp
// of the RDS CA bundle; env DB_SECRET_ARN/DB_HOST/DB_PORT/DB_NAME with NO PGSSLMODE — F28). It also gets
// TWILIO_SECRET_ARN (the handler reads the authToken from the SAME medadhere/twilio secret) and the
// env-pinned STATUS_CALLBACK_URL (Pitfall 2 — validateRequest anchors on the exact URL).
//
// M4 / INFRA-02 — the auto-created $default stage is throttled to rateLimit:50 / burstLimit:50 (the
// T-03-09 API-flood cap on the public route), via the same CfnStage escape hatch as data-api.ts.
//
// M1 — least privilege: grantRead on the DB secret + grantRead on the Twilio secret only. No `*`
// resource, no LLM-runtime / quota actions. Wired into FoundationStack in Plan 03 (D-12); its httpApi
// endpoint + the /twilio/status route is the fragment-free signature anchor; FoundationStack appends
// bounded connection overrides only for the Outbound env URL.

import { Construct } from 'constructs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as path from 'node:path';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { HttpApi, HttpMethod, CfnStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { DATABASE_NAME } from './database.js';

// Repo paths (this file is infra/lib/constructs/ → repo root is three levels up).
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const STATUS_CALLBACK_DIR = path.join(REPO_ROOT, 'backend', 'src', 'status-callback');
const HANDLER_ENTRY = path.join(STATUS_CALLBACK_DIR, 'handler.ts');

/** The single PUBLIC webhook route Twilio POSTs delivery-status updates to (NO authorizer). */
export const STATUS_CALLBACK_ROUTE = '/twilio/status';

export interface StatusCallbackConstructProps {
  /** The VPC from NetworkConstruct (in-process ref — D-12). */
  readonly vpc: ec2.IVpc;
  /** The shared Lambda SG already admitted to RDS:5432 (database.ts allowFrom). */
  readonly lambdaSg: ec2.ISecurityGroup;
  /** The Phase-1 RDS instance — endpoint host/port feed the Lambda env. */
  readonly db: rds.DatabaseInstance;
  /** The CDK-generated DB-credential secret (grantRead target — M1 / D-06). */
  readonly dbSecret: secretsmanager.ISecret;
  /** The out-of-stack Twilio secret — the handler reads authToken (grantRead — M1/A3). */
  readonly twilioSecret: secretsmanager.ISecret;
  /**
   * The exact fragment-free status-callback URL the handler validates against. The Outbound URL has
   * connection overrides in its fragment, which Twilio excludes from signature computation.
   */
  readonly statusCallbackUrl: string;
}

export class StatusCallbackConstruct extends Construct {
  /** The in-VPC status-callback Lambda. */
  public readonly fn: NodejsFunction;
  /** The PUBLIC HTTP API v2 fronting the Lambda — NO authorizer (auth is the handler HMAC). */
  public readonly httpApi: HttpApi;
  /**
   * The status-callback Lambda's CloudWatch log group (H3, Plan 05-04). Exposed so MonitoringConstruct's
   * OPS-02 (f) metric filter can read the `consecutive_undelivered` line the handler derives from
   * outbound_message.status. CDK-generated name → fromLogGroupName is unavailable.
   */
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: StatusCallbackConstructProps) {
    super(scope, id);

    // --- in-VPC status-callback Lambda (mirror data-api.ts's in-VPC pg fn) -----------------------
    // Explicit log group (F61) so it does not orphan after cdk destroy. H3 (Plan 05-04): exposed as
    // `public readonly logGroup` for MonitoringConstruct's OPS-02 (f) consecutive_undelivered filter.
    this.logGroup = new logs.LogGroup(this, 'StatusCallbackLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.fn = new NodejsFunction(this, 'StatusCallbackFn', {
      entry: HANDLER_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X, // F07
      architecture: Architecture.ARM_64, // F07
      timeout: Duration.seconds(30), // F47 — cold VPC + Secrets fetch + RDS round-trip
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }, // F49
      securityGroups: [props.lambdaSg], // F49 — shared SG (already admitted to RDS:5432)
      logGroup: this.logGroup,
      environment: {
        TWILIO_SECRET_ARN: props.twilioSecret.secretArn, // the handler reads the authToken from this
        STATUS_CALLBACK_URL: props.statusCallbackUrl, // Pitfall 2 — validateRequest anchors on this URL
        DB_SECRET_ARN: props.dbSecret.secretArn,
        DB_HOST: props.db.dbInstanceEndpointAddress,
        DB_PORT: props.db.dbInstanceEndpointPort,
        DB_NAME: DATABASE_NAME, // "medadhere" (F26)
        // NO PGSSLMODE (F28) — the handler single-sources TLS via the explicit pg `ssl` object.
      },
      bundling: {
        nodeModules: ['pg'],
        // F01/F03 — copy the AWS RDS global CA bundle (M-2) into the bundle output dir so the handler's
        // runtime readFileSync(join(__dirname,'rds-global-bundle.pem')) resolves for server-cert
        // verification. The copy is part of the OUTPUT bundle hash (no stale artifact).
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp ${path.join(inputDir, 'backend', 'src', 'schema-init', 'rds-global-bundle.pem')} ${outputDir}`,
          ],
        },
      },
    });

    // M1 — least privilege: grantRead the DB secret + the Twilio secret (authToken). The lambdaSg→
    // RDS:5432 ingress already exists on the shared SG, so NO new ingress. No `*`, no LLM-runtime grant.
    props.dbSecret.grantRead(this.fn);
    props.twilioSecret.grantRead(this.fn);

    // --- PUBLIC HTTP API v2 — NO authorizer (resolved default 3) ---------------------------------
    // Unlike DataApiConstruct, this HttpApi has NO defaultAuthorizer and the route has NO authorizer:
    // Twilio carries no Cognito JWT, so the SOLE auth is the in-handler HMAC validateRequest. The
    // synthesized stack therefore has ZERO ApiGatewayV2::Authorizer resources (the test pins this).
    this.httpApi = new HttpApi(this, 'StatusCallbackApi');

    // POST /twilio/status → the in-VPC handler. NO authorizer on this route by design.
    this.httpApi.addRoutes({
      path: STATUS_CALLBACK_ROUTE,
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('StatusCallbackInt', this.fn),
    });

    // M4 / INFRA-02 — throttle the auto-created $default stage to 50 rps / 50 burst (the T-03-09 public-
    // route flood cap), via the same CfnStage DefaultRouteSettings escape hatch as data-api.ts.
    const defaultStage = this.httpApi.defaultStage!;
    (defaultStage.node.defaultChild as CfnStage).defaultRouteSettings = {
      throttlingRateLimit: 50,
      throttlingBurstLimit: 50,
    };
  }
}
