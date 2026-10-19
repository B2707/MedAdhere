// infra/lib/constructs/inbound.ts
//
// InboundConstruct (Plan 04-02 / SC1 / PIPE-02/03 / gate fixes U-06/REV-M3 + U-08/REV-M4) —
// the PUBLIC Twilio inbound-message webhook surface. A DEDICATED API Gateway HTTP API v2 with a
// single `POST /twilio/inbound` route carrying NO authorizer — the SOLE auth is the in-handler
// HMAC (twilio.validateRequest), EXACTLY the status-callback.ts posture. NEVER the DataApi: its
// Cognito defaultAuthorizer would 401 every Twilio webhook (U-06/REV-M3; the alternative of
// evolving StatusCallbackConstruct into a two-route construct was considered and REJECTED —
// don't restructure a tested construct mid-phase).
//
//   Twilio (internet) → API GW HTTP API v2 ( NO authorizer — auth is the handler HMAC ) → in-VPC Lambda
//     → reservation-first inbound_reply write → STOP/HELP terminal → SC3 safety divert
//     → SendMessage (id-only) to this construct's patient-keyed FIFO queue
//
// The construct owns the Phase-8 FIFO work queue and its single FIFO redrive DLQ. Explicit
// MessageDeduplicationId values remain mandatory; patient UUID MessageGroupId values serialize one
// patient's turns while different patients remain concurrent. The queue carries IDs only.
//
// In-VPC Lambda shape mirrors status-callback.ts EXACTLY (NODEJS_24_X/ARM_64, PRIVATE_WITH_EGRESS
// + shared lambdaSg, explicit DESTROY/ONE_WEEK LogGroup, 30s timeout, nodeModules:['pg'] + the
// afterBundling cp of the RDS CA bundle; env DB_* with NO PGSSLMODE — F28). Adds:
//   - QUEUE_URL — the FIFO publish target;
//   - INBOUND_URL — placeholder at construct time, overridden by FoundationStack's addEnvironment
//     with the endpoint-derived exact URL (the Pitfall-2 single source the HMAC anchors on).
//
// M4/INFRA-02 — the $default stage is throttled 50/50 via the same CfnStage escape hatch (U-06:
// each accepted inbound request costs LLM + SMS money downstream, so the public flood cap stays).
//
// cdk-nag same-PR rule (U-05): this construct's IAM4/L1/APIG1/APIG4 paths are appended to
// infra/lib/nag.ts in the SAME commit that creates it.

import { Construct } from 'constructs';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as path from 'node:path';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { HttpApi, HttpMethod, CfnStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { DATABASE_NAME } from './database.js';
import { SCHEDULE_GROUP_NAME } from './scheduler.js';

// Repo paths (this file is infra/lib/constructs/ → repo root is three levels up).
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const INBOUND_DIR = path.join(REPO_ROOT, 'backend', 'src', 'inbound');
const HANDLER_ENTRY = path.join(INBOUND_DIR, 'handler.ts');

/** The single PUBLIC webhook route Twilio POSTs inbound patient replies to (NO authorizer). */
export const INBOUND_ROUTE = '/twilio/inbound';

export interface InboundConstructProps {
  /** The VPC from NetworkConstruct (in-process ref — D-12). */
  readonly vpc: ec2.IVpc;
  /** The shared Lambda SG already admitted to RDS:5432 (database.ts allowFrom). */
  readonly lambdaSg: ec2.ISecurityGroup;
  /** The Phase-1 RDS instance — endpoint host/port feed the Lambda env. */
  readonly db: rds.DatabaseInstance;
  /** The CDK-generated DB-credential secret (grantRead target — M1 / D-06). */
  readonly dbSecret: secretsmanager.ISecret;
  /** The Twilio credential secret — HMAC authToken (grantRead — M1/D-06). */
  readonly twilioSecret: secretsmanager.ISecret;
  /**
   * The exact fully-qualified inbound webhook URL the handler validates signatures against
   * (Pitfall 2). Placeholder at construct time; FoundationStack overrides via addEnvironment
   * with the endpoint-derived URL once the HttpApi exists (the status-callback wiring pattern).
   */
  readonly inboundUrl: string;
}

export class InboundConstruct extends Construct {
  /** The in-VPC inbound webhook Lambda. */
  public readonly fn: NodejsFunction;
  /** The PUBLIC HTTP API v2 fronting the Lambda — NO authorizer (auth is the handler HMAC). */
  public readonly httpApi: HttpApi;
  /** Patient-keyed FIFO work queue; the classifier/turn worker consumes and re-wakes this queue. */
  public readonly workQueue: sqs.Queue;
  /** The one terminal redrive DLQ for exhausted FIFO work. */
  public readonly redriveDlq: sqs.Queue;
  /**
   * The inbound Lambda's CloudWatch log group (H3, Plan 05-04). Exposed so MonitoringConstruct's
   * OPS-02 metric filters can read it in-process (safety_event_recorded + the H6 emergency-routing
   * inbound_safety_divert_failed line). CDK-generated name → fromLogGroupName is unavailable.
   */
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: InboundConstructProps) {
    super(scope, id);

    // --- Patient-ordered work transport -----------------------------------------------------------
    // Both queues are FIFO: AWS requires a FIFO source queue's DLQ to be FIFO too. The work queue
    // deliberately disables content-based deduplication so every producer must use the reviewed
    // `sid:` / `wake:` MessageDeduplicationId contract.
    this.redriveDlq = new sqs.Queue(this, 'TurnRedriveDlq', {
      fifo: true,
      contentBasedDeduplication: false,
      enforceSSL: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.workQueue = new sqs.Queue(this, 'TurnWorkQueue', {
      fifo: true,
      contentBasedDeduplication: false,
      enforceSSL: true,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      // 2× the 180s worker timeout (SQS floor is 1×): a transiently failed turn retries in 6 min,
      // not 18 — a FIFO group blocks conversationally-visibly while its head message is invisible.
      visibilityTimeout: Duration.seconds(360),
      deadLetterQueue: {
        queue: this.redriveDlq,
        maxReceiveCount: 5,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- in-VPC inbound Lambda (mirror status-callback.ts's in-VPC pg fn) ------------------------
    // H3 (Plan 05-04): exposed as `public readonly logGroup` for MonitoringConstruct's OPS-02 filters.
    this.logGroup = new logs.LogGroup(this, 'InboundLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.fn = new NodejsFunction(this, 'InboundFn', {
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
        TWILIO_SECRET_ARN: props.twilioSecret.secretArn, // HMAC authToken
        INBOUND_URL: props.inboundUrl, // Pitfall 2 — validateRequest anchors on this URL
        QUEUE_URL: this.workQueue.queueUrl, // id-only patient-keyed FIFO publish target
        DB_SECRET_ARN: props.dbSecret.secretArn,
        DB_HOST: props.db.dbInstanceEndpointAddress,
        DB_PORT: props.db.dbInstanceEndpointPort,
        DB_NAME: DATABASE_NAME, // "medadhere" (F26)
        // NO PGSSLMODE (F28) — the handler single-sources TLS via the explicit pg `ssl` object.
      },
      bundling: {
        nodeModules: ['pg'],
        // F01/F03 — copy the AWS RDS global CA bundle (M-2) into the bundle output dir so the
        // handler's runtime readFileSync(join(__dirname,'rds-global-bundle.pem')) resolves.
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp ${path.join(inputDir, 'backend', 'src', 'schema-init', 'rds-global-bundle.pem')} ${outputDir}`,
          ],
        },
      },
    });

    // M1 — least privilege: grantRead the two secrets and SendMessage scoped to the work queue.
    props.dbSecret.grantRead(this.fn);
    props.twilioSecret.grantRead(this.fn);
    const { region, account } = Stack.of(this);
    // Without this grant the webhook would persist the reply but fail to wake the turn worker.
    this.workQueue.grantSendMessages(this.fn);

    // --- H1 STOP-sweep IAM (Plan 05-01 P4 hotfix) ------------------------------------------------
    // The inbound handler's STOP path calls deactivateSchedules(id,'dose')+(id,'timeout'), whose first
    // call is ListSchedules — but Phase 4 shipped InboundFn with ZERO scheduler:* grants, so the sweep
    // AccessDenied'd at runtime AFTER is_active=false committed, leaving orphaned dose-/timeout- schedules
    // firing at a STOP'd patient. Grant the SWEEP-ONLY shape mirroring enroll.ts:145–159 — NO
    // CreateSchedule, NO PassRole (the sweep never creates or passes a role):
    //   (a) scheduler:DeleteSchedule scoped to the medadhere-prod schedule + group ARNs;
    //   (b) scheduler:ListSchedules as its OWN Resource:'*' statement (the AWS Service Authorization
    //       Reference gives ListSchedules no resource type, so a scoped ARN is DENIED at runtime — HIGH-2),
    //       bounded with an aws:RequestedRegion Condition so the `*` stays confined to the deploy region.
    const scheduleArn = `arn:aws:scheduler:${region}:${account}:schedule/${SCHEDULE_GROUP_NAME}/*`;
    const scheduleGroupArn = `arn:aws:scheduler:${region}:${account}:schedule-group/${SCHEDULE_GROUP_NAME}`;
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['scheduler:DeleteSchedule'],
        resources: [scheduleArn, scheduleGroupArn],
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['scheduler:ListSchedules'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:RequestedRegion': region },
        },
      }),
    );

    // --- DEDICATED PUBLIC HTTP API v2 — NO authorizer (U-06/REV-M3) ----------------------------
    // The synthesized stack has ZERO ApiGatewayV2::Authorizer resources (the test pins this —
    // the load-bearing inverse of the DataApi's Cognito JWT enforcement boundary).
    this.httpApi = new HttpApi(this, 'InboundApi');

    // POST /twilio/inbound → the in-VPC handler. NO authorizer on this route by design.
    this.httpApi.addRoutes({
      path: INBOUND_ROUTE,
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('InboundInt', this.fn),
    });

    // M4 / INFRA-02 / U-06 — throttle the $default stage 50/50 (each accepted request costs LLM +
    // SMS money downstream), via the same CfnStage escape hatch as status-callback.ts.
    const defaultStage = this.httpApi.defaultStage!;
    (defaultStage.node.defaultChild as CfnStage).defaultRouteSettings = {
      throttlingRateLimit: 50,
      throttlingBurstLimit: 50,
    };
  }
}
