// infra/lib/constructs/outbound.ts
//
// OutboundConstruct (SC3/SC6 / PIPE-01 / F07/F28/F45/F49/F61 / M1 / T-03-06/07/08) — the in-VPC
// Outbound Lambda: the EventBridge Scheduler TARGET that renders the SMS, sends it via Twilio, and
// writes the outbound_message row. Clones the smoke.ts twilio-smoke fn shape (Twilio secret grantRead +
// the F45 scoped ssm:GetParameter) AND the data-api.ts in-VPC pg fn (pg env + nodeModules:['pg'] +
// commandHooks.afterBundling cp). Only the bundled assets differ: BOTH rds-global-bundle.pem AND
// template.mustache are copied (the two-line cp mirrors schema-init.ts's schema.sql + pem cp).
//
//   EventBridge Scheduler (assumes the scheduler target role) → THIS Lambda
//     → reserve outbound_message (HIGH-2) → render template.mustache → Twilio send → write the row
//
// Network/runtime shape (F07/F49/F61): NODEJS_24_X + ARM_64 + 30s timeout, PRIVATE_WITH_EGRESS on the
// shared lambdaSg (already admitted to RDS:5432), an explicit DESTROY/ONE_WEEK LogGroup so it does not
// orphan. env: TWILIO_SECRET_ARN, TWILIO_FROM_PARAM = SSM_TWILIO_FROM (the parameter NAME, read at
// runtime — F45), STATUS_CALLBACK_URL (the status-callback route plus bounded Twilio connection
// overrides, passed by FoundationStack), and DB_SECRET_ARN/DB_HOST/DB_PORT/DB_NAME. NO PGSSLMODE (F28).
//
// M1 — least privilege: grantRead on the Twilio secret + grantRead on the DB secret + a scoped
// ssm:GetParameter on the /medadhere/twilio-from parameter ARN ONLY (the smoke.ts idiom). NO `*`
// resource, NO LLM-runtime / quota actions anywhere. The lambdaSg→RDS:5432 ingress already exists on the
// shared SG, so NO new per-fn ingress. This construct is wired into FoundationStack in Plan 03 (D-12).

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
import { DATABASE_NAME } from './database.js';
import { SSM_TWILIO_FROM } from './secrets.js';

// Repo paths (this file is infra/lib/constructs/ → repo root is three levels up).
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const OUTBOUND_DIR = path.join(REPO_ROOT, 'backend', 'src', 'outbound');
const HANDLER_ENTRY = path.join(OUTBOUND_DIR, 'handler.ts');

export interface OutboundConstructProps {
  /** The VPC from NetworkConstruct (in-process ref — D-12). */
  readonly vpc: ec2.IVpc;
  /** The shared Lambda SG already admitted to RDS:5432 (database.ts allowFrom). */
  readonly lambdaSg: ec2.ISecurityGroup;
  /** The Phase-1 RDS instance — endpoint host/port feed the Lambda env. */
  readonly db: rds.DatabaseInstance;
  /** The CDK-generated DB-credential secret (grantRead target — M1 / D-06). */
  readonly dbSecret: secretsmanager.ISecret;
  /** The out-of-stack persistent Twilio credential secret (grantRead target — M1 / A3). */
  readonly twilioSecret: secretsmanager.ISecret;
  /**
   * The fully-qualified status-callback URL used by messages.create, including bounded connection
   * overrides. The callback handler validates the same endpoint/route without the fragment, which
   * Twilio excludes from signature computation.
   */
  readonly statusCallbackUrl: string;
}

export class OutboundConstruct extends Construct {
  /** The in-VPC Outbound Lambda (the EventBridge Scheduler target). */
  public readonly fn: NodejsFunction;
  /**
   * The Outbound Lambda's CloudWatch log group (H3/F1, Plan 05-04). Exposed so MonitoringConstruct's
   * OPS-02 (h) metric filter can read the `timeout_schedule_failed` line — that line is emitted by
   * outbound/handler.ts (Q3 CreateSchedule-after-send failure), so it lands in THIS log group, not the
   * classifier's. CDK-generated name → the ref must be passed in-process (fromLogGroupName is unavailable).
   */
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: OutboundConstructProps) {
    super(scope, id);

    const region = Stack.of(this).region;
    const account = Stack.of(this).account;

    // Explicit log group (F61) so it does not orphan after cdk destroy.
    this.logGroup = new logs.LogGroup(this, 'OutboundLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.fn = new NodejsFunction(this, 'OutboundFn', {
      entry: HANDLER_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X, // F07
      architecture: Architecture.ARM_64, // F07
      timeout: Duration.seconds(30), // F47 — cold VPC + Secrets/SSM fetch + RDS + Twilio round-trip
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }, // F49
      securityGroups: [props.lambdaSg], // F49 — shared SG (already admitted to RDS:5432)
      logGroup: this.logGroup,
      environment: {
        TWILIO_SECRET_ARN: props.twilioSecret.secretArn,
        TWILIO_FROM_PARAM: SSM_TWILIO_FROM, // F45 — the parameter NAME, read at runtime
        STATUS_CALLBACK_URL: props.statusCallbackUrl, // Pitfall 2 — single-source exact URL
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
        // F01/F03 — copy BOTH the AWS RDS global CA bundle (M-2, server-cert verification) AND the SC3
        // Mustache template into the bundle output dir alongside the compiled handler, so the handler's
        // runtime readFileSync(join(__dirname,'rds-global-bundle.pem')) and
        // readFileSync(join(__dirname,'template.mustache')) both resolve. Both copies are part of the
        // OUTPUT bundle hash, so editing either changes the Lambda code-asset S3 key (no stale artifact).
        // Mirrors schema-init.ts's two-line cp (schema.sql + pem).
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp ${path.join(inputDir, 'backend', 'src', 'schema-init', 'rds-global-bundle.pem')} ${outputDir}`,
            `cp ${path.join(inputDir, 'backend', 'src', 'outbound', 'template.mustache')} ${outputDir}`,
          ],
        },
      },
    });

    // M1 — least privilege. grantRead the two secrets the handler reads (Twilio creds + DB creds); a
    // scoped ssm:GetParameter on the /medadhere/twilio-from parameter ARN ONLY (the smoke.ts F45 idiom —
    // the SSM parameter ARN drops the leading slash of the parameter name). NO `*` resource anywhere.
    props.twilioSecret.grantRead(this.fn);
    props.dbSecret.grantRead(this.fn);
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${region}:${account}:parameter${SSM_TWILIO_FROM}`],
      }),
    );
  }
}
