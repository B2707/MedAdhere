// infra/lib/constructs/export-anon.ts
//
// ExportAnonConstruct (Plan 06-06 / DASH-06 / D6/D7/D14 / M11 / F07/F28/F49/F61) — the anonymized
// adherence-export surface: the first S3 writer in the stack, its in-VPC export Lambda, a DEDICATED
// EventBridge Scheduler target role, and a validation-window-GATED nightly schedule.
//
//   EventBridge Scheduler (nightly, DEFAULT group, dedicated target role) → in-VPC export Lambda
//     → RDS SELECT (D7 allowlist) → S3 PutObject → s3://<hardened bucket>/exports/…csv
//
// M11 bucket hardening (mirrors the OPS-02 SNS-topic posture): BLOCK_ALL public access, enforceSSL
// (a TLS-only bucket policy — this fully discharges cdk-nag S10, so NO S10 suppression), SSE-S3
// server-side encryption, and DESTROY + autoDeleteObjects for the INFRA-04 clean teardown (the
// runbook-06 order is: final export → download/verify → destroy).
//
// U-5 — the S3 GATEWAY VPC endpoint ALREADY EXISTS (network.ts) and keeps this PutObject traffic OFF
// the NAT; this construct adds NO endpoint (adding a second would fail synth — VPCEndpoint count is
// pinned at 2 — and conflict the route-table prefix lists).
//
// U-33 — the schedule uses the AWS DEFAULT schedule group (NO new CfnScheduleGroup — a second group
// would break the `ScheduleGroup count === 1` synth assert) and a DEDICATED target role (the existing
// scheduler.ts targetRole grants Outbound+Timeout invoke ONLY; this export fn gets its own).
//
// In-VPC Lambda shape clones timeout.ts EXACTLY (NODEJS_24_X/ARM_64, PRIVATE_WITH_EGRESS + the shared
// lambdaSg, an explicit DESTROY/ONE_WEEK LogGroup; nodeModules:['pg'] + the afterBundling cp of the RDS
// CA bundle; env DB_SECRET_ARN/DB_HOST/DB_PORT/DB_NAME with NO PGSSLMODE — F28), PLUS EXPORT_BUCKET_NAME.
//
// M1 — least privilege: dbSecret.grantRead (GetSecretValue on the DB secret) + a SCOPED s3:PutObject on
// the export bucket's object ARN only (never a bare `*`, never s3:* / DeleteObject / ListBucket). The
// lambdaSg→RDS:5432 ingress already exists on the shared SG, so NO new ingress.
//
// The bucket + fn + LogGroup + target role are created UNCONDITIONALLY (so the default, non-validation
// cdk-nag scan + the two FoundationStack synth counts exercise them); ONLY the nightly schedule is
// gated on `validationWindow` (created under -c validationWindow=true, torn down when it flips false).

import { Construct } from 'constructs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as path from 'node:path';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { CfnSchedule } from 'aws-cdk-lib/aws-scheduler';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { DATABASE_NAME } from './database.js';

// Repo paths (this file is infra/lib/constructs/ → repo root is three levels up).
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const EXPORT_DIR = path.join(REPO_ROOT, 'backend', 'src', 'export-anon');
const HANDLER_ENTRY = path.join(EXPORT_DIR, 'handler.ts');

/** Nightly export fire time (UTC). Validation-window gated; a one-shot cadence is not needed (this is a
 * recurring nightly cron, not a per-dose one-shot — so a real Scheduler cron, never a CloudWatch Rule). */
const NIGHTLY_EXPORT_CRON = 'cron(0 7 * * ? *)'; // 07:00 UTC daily

export interface ExportAnonConstructProps {
  /** The VPC from NetworkConstruct (in-process ref — D-12). */
  readonly vpc: ec2.IVpc;
  /** The shared Lambda SG already admitted to RDS:5432 (database.ts allowFrom). */
  readonly lambdaSg: ec2.ISecurityGroup;
  /** The Phase-1 RDS instance — endpoint host/port feed the Lambda env. */
  readonly db: rds.DatabaseInstance;
  /** The CDK-generated DB-credential secret (grantRead target — M1 / D-06). */
  readonly dbSecret: secretsmanager.ISecret;
  /**
   * The P7 validation-window toggle (F59). The nightly export schedule is created ONLY when true; the
   * bucket + fn + target role always exist (cost is ~$0 — KBs of CSV, near-zero invokes).
   */
  readonly validationWindow: boolean;
}

export class ExportAnonConstruct extends Construct {
  /** The in-VPC export Lambda (the EventBridge Scheduler invoke target — DASH-06). */
  public readonly exportFn: NodejsFunction;
  /** The M11-hardened destination bucket (BLOCK_ALL, enforceSSL, SSE-S3, DESTROY + autoDelete). */
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: ExportAnonConstructProps) {
    super(scope, id);

    // --- M11-hardened export bucket (the first S3 writer in the stack) ---------------------------
    // BLOCK_ALL + enforceSSL (TLS-only bucket policy → discharges cdk-nag S10, no suppression) +
    // SSE-S3 encryption + DESTROY/autoDelete (INFRA-04 clean teardown). NO server access logs (S1 is a
    // named accepted disposition — a second log bucket adds cost/no signal for a single-writer research
    // export, mirroring the APIG1 disposition).
    this.bucket = new s3.Bucket(this, 'ExportBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED, // SSE-S3 (no KMS cost)
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: false,
    });

    // Explicit log group (F61) so it does not orphan after cdk destroy.
    const logGroup = new logs.LogGroup(this, 'ExportAnonLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- in-VPC export Lambda (clone timeout.ts's in-VPC pg-fn shape) -----------------------------
    this.exportFn = new NodejsFunction(this, 'ExportAnonFn', {
      entry: HANDLER_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X, // F07
      architecture: Architecture.ARM_64, // F07
      timeout: Duration.seconds(60), // batch: cold VPC + Secrets fetch + whole-dataset SELECT + S3 put
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }, // F49
      securityGroups: [props.lambdaSg], // F49 — shared SG (already admitted to RDS:5432)
      logGroup,
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        DB_HOST: props.db.dbInstanceEndpointAddress,
        DB_PORT: props.db.dbInstanceEndpointPort,
        DB_NAME: DATABASE_NAME, // "medadhere" (F26)
        EXPORT_BUCKET_NAME: this.bucket.bucketName,
        // NO PGSSLMODE (F28) — the handler single-sources TLS via the explicit pg `ssl` object.
      },
      bundling: {
        // pg is a real runtime dependency the handler imports; keep it out of the esbuild bundle and
        // install it in the Lambda node_modules instead (native-friendly). @aws-sdk/client-s3 bundles
        // via esbuild (it is a declared backend dep — U-32).
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

    // M1 — least privilege: GetSecretValue on the DB secret only (the lambdaSg→RDS:5432 ingress exists).
    props.dbSecret.grantRead(this.exportFn);

    // M1 — a SCOPED s3:PutObject on the export bucket's object ARN only. NOT grantWrite (which would add
    // PutObject*/Abort*), NOT DeleteObject/ListBucket — the export only writes new objects. The `/*`
    // object-key wildcard is the sole IAM5 finding here (suppressed with the scoped-write rationale).
    this.exportFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [`${this.bucket.bucketArn}/*`],
      }),
    );

    // --- dedicated EventBridge Scheduler target role (U-33) --------------------------------------
    // Trust scheduler.amazonaws.com; granted lambda:InvokeFunction on the export fn ONLY (T-03-07 — no
    // `*` resource). The existing scheduler.ts targetRole invokes Outbound+Timeout ONLY, so the nightly
    // export gets its OWN least-privilege target role. Created unconditionally so the default cdk-nag
    // scan verifies its grantInvoke disposition; it is inert until the gated schedule references it.
    const targetRole = new iam.Role(this, 'ExportScheduleRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description:
        'EventBridge Scheduler assumes this role to invoke the anonymized-export Lambda for the nightly validation-window schedule (DASH-06)',
    });
    this.exportFn.grantInvoke(targetRole);

    // --- validation-window-GATED nightly schedule (DEFAULT group — U-33; -c validationWindow) --------
    // A recurring nightly cron CfnSchedule in the AWS default schedule group (groupName omitted → no new
    // group). Created ONLY under validationWindow=true and torn down when it flips false (mirrors the
    // deployHosting/DatabaseConstruct context-gated pattern). flexibleTimeWindow OFF (exact fire).
    if (props.validationWindow) {
      new CfnSchedule(this, 'NightlyExportSchedule', {
        flexibleTimeWindow: { mode: 'OFF' },
        scheduleExpression: NIGHTLY_EXPORT_CRON,
        // groupName intentionally omitted → the AWS default schedule group (U-33 — no second group).
        target: {
          arn: this.exportFn.functionArn,
          roleArn: targetRole.roleArn,
          // Cap repeated invocations during a wipe→enroll gap; ExportAnonErrorsAlarm provides loudness.
          retryPolicy: {
            maximumRetryAttempts: 2,
            maximumEventAgeInSeconds: 3600,
          },
        },
        state: 'ENABLED',
        description:
          'Nightly anonymized adherence export (DASH-06) — validation-window only (-c validationWindow=true).',
      });
    }
  }
}
