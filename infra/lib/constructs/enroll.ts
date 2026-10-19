// infra/lib/constructs/enroll.ts
//
// EnrollConstruct (PIPE-01/08/09 / F07/F28/F49/F61 / M1 / M5 / T-03-10/11/12/14) — the in-VPC Enroll
// Lambda: writes the patient + dose_schedule rows and creates the per-dose EventBridge Scheduler
// one-shots. Clones the data-api.ts in-VPC pg fn shape (NODEJS_24_X/ARM_64, PRIVATE_WITH_EGRESS + the
// shared lambdaSg, an explicit DESTROY/ONE_WEEK LogGroup, 30s timeout; nodeModules:['pg'] + the
// afterBundling cp of the RDS CA bundle; env DB_SECRET_ARN/DB_HOST/DB_PORT/DB_NAME with NO PGSSLMODE —
// F28) and adds the two scheduler-IAM things only the Enroll Lambda needs:
//
//   Scheduler IAM (M5 / RESEARCH Pattern 6) — built FROM Stack.of(this).region/account (the smoke.ts
//   addToRolePolicy scoped-ARN idiom):
//     (a) scheduler:CreateSchedule / DeleteSchedule scoped to the medadhere-prod schedule + schedule-
//         group ARNs. scheduler:ListSchedules is its OWN single-action statement with Resource:'*' — the
//         AWS Service Authorization Reference gives ListSchedules NO resource type, so scoping it to a
//         schedule/group ARN is DENIED at runtime (HIGH-2, confirmed by the live smoke + WR-01). The `*`
//         is bounded with an aws:RequestedRegion Condition (never an unconditioned `*`, never bundled
//         with Create/Delete). Create/Delete ALWAYS stay scoped to the medadhere-prod ARNs.
//     (b) iam:PassRole scoped to the single scheduler target-role ARN with the
//         iam:PassedToService=scheduler.amazonaws.com condition (Pitfall 7 confused-deputy, T-03-10).
//
// M1 — least privilege: dbSecret.grantRead only (secretsmanager:GetSecretValue on the DB secret); plus
// the two scoped scheduler statements above. NO `*` resource on Create/Delete/PassRole, no
// LLM-runtime / quota actions anywhere. The lambdaSg→RDS:5432 ingress already exists on the shared SG
// (database.ts allowFrom(lambdaSg)), so NO new per-fn ingress. This construct is wired into
// FoundationStack in Plan 03's integration wave by in-process refs (D-12 — no CFN cross-stack import): its env
// OUTBOUND_FN_ARN / SCHEDULER_TARGET_ROLE_ARN are the live Outbound fn ARN + scheduler target-role ARN,
// and the SAME target-role ARN feeds the PassRole resource.
//
// EventBridge SCHEDULER one-shots only — never the legacy CloudWatch-Events Rule / cron-rule path for
// dose scheduling (project decision record hard prohibition). The runtime CreateSchedule lives in the handler; this
// construct only grants the IAM that authorizes it.

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
import { SCHEDULE_GROUP_NAME } from './scheduler.js';

// Repo paths (this file is infra/lib/constructs/ → repo root is three levels up).
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const ENROLL_DIR = path.join(REPO_ROOT, 'backend', 'src', 'enroll');
const HANDLER_ENTRY = path.join(ENROLL_DIR, 'handler.ts');

export interface EnrollConstructProps {
  /** The VPC from NetworkConstruct (in-process ref — D-12). */
  readonly vpc: ec2.IVpc;
  /** The shared Lambda SG already admitted to RDS:5432 (database.ts allowFrom). */
  readonly lambdaSg: ec2.ISecurityGroup;
  /** The Phase-1 RDS instance — endpoint host/port feed the Lambda env. */
  readonly db: rds.DatabaseInstance;
  /** The CDK-generated DB-credential secret (grantRead target — M1 / D-06). */
  readonly dbSecret: secretsmanager.ISecret;
  /**
   * The Outbound Lambda ARN — the CreateSchedule Target.Arn the handler sets (in-process ref, D-12).
   * Passed by FoundationStack as this.outbound.fn.functionArn.
   */
  readonly outboundFnArn: string;
  /**
   * The scheduler target-role ARN — the CreateSchedule Target.RoleArn AND the PassRole resource
   * (in-process ref, D-12). Passed by FoundationStack as this.scheduler.targetRole.roleArn.
   */
  readonly schedulerTargetRoleArn: string;
}

export class EnrollConstruct extends Construct {
  /** The in-VPC Enroll Lambda (writes patient/dose rows + creates the per-dose scheduler one-shots). */
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: EnrollConstructProps) {
    super(scope, id);

    const region = Stack.of(this).region;
    const account = Stack.of(this).account;

    // Explicit log group (F61) so it does not orphan after cdk destroy.
    const logGroup = new logs.LogGroup(this, 'EnrollLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.fn = new NodejsFunction(this, 'EnrollFn', {
      entry: HANDLER_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X, // F07
      architecture: Architecture.ARM_64, // F07
      timeout: Duration.seconds(30), // F47 — cold VPC + Secrets fetch + RDS + N CreateSchedule round-trips
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }, // F49
      securityGroups: [props.lambdaSg], // F49 — shared SG (already admitted to RDS:5432)
      logGroup,
      environment: {
        DB_SECRET_ARN: props.dbSecret.secretArn,
        DB_HOST: props.db.dbInstanceEndpointAddress,
        DB_PORT: props.db.dbInstanceEndpointPort,
        DB_NAME: DATABASE_NAME, // "medadhere" (F26)
        OUTBOUND_FN_ARN: props.outboundFnArn, // CreateSchedule Target.Arn (in-process ref — D-12)
        SCHEDULER_TARGET_ROLE_ARN: props.schedulerTargetRoleArn, // CreateSchedule Target.RoleArn + PassRole
        // NO PGSSLMODE (F28) — the handler single-sources TLS via the explicit pg `ssl` object.
      },
      bundling: {
        // pg is a real runtime dependency the handler imports; keep it out of the esbuild bundle and
        // install it in the Lambda node_modules instead (native-friendly).
        nodeModules: ['pg'],
        // F01/F03 — copy the AWS RDS global CA bundle (M-2, server-cert verification) into the bundle
        // output dir alongside the compiled handler so the handler's runtime
        // readFileSync(join(__dirname,'rds-global-bundle.pem')) resolves. The copy is part of the OUTPUT
        // bundle hash, so editing it changes the Lambda code-asset S3 key (no stale artifact).
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp ${path.join(inputDir, 'backend', 'src', 'schema-init', 'rds-global-bundle.pem')} ${outputDir}`,
          ],
        },
      },
    });

    // M1 — least privilege: GetSecretValue on the DB secret only. The lambdaSg→RDS:5432 ingress already
    // exists on the shared SG, so NO new ingress.
    props.dbSecret.grantRead(this.fn);

    // --- Scheduler IAM (M5 / RESEARCH Pattern 6) -------------------------------------------------
    // ARNs built FROM Stack.of(this).region/account (the smoke.ts scoped-ARN idiom). The schedule ARN
    // is per-schedule (medadhere-prod/<name>); the schedule-group ARN is the group itself.
    const scheduleArn = `arn:aws:scheduler:${region}:${account}:schedule/${SCHEDULE_GROUP_NAME}/*`;
    const scheduleGroupArn = `arn:aws:scheduler:${region}:${account}:schedule-group/${SCHEDULE_GROUP_NAME}`;

    // (a) scheduler:CreateSchedule / DeleteSchedule — scoped to the medadhere-prod schedule + group ARNs
    // (least privilege; no broad `*`). The runtime CreateSchedule/DeleteSchedule calls stay inside this
    // one group, so the scoped ARNs are sufficient and correct for these two actions.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['scheduler:CreateSchedule', 'scheduler:DeleteSchedule'],
        resources: [scheduleArn, scheduleGroupArn],
      }),
    );

    // (a2) scheduler:ListSchedules — HIGH-2: the AWS Service Authorization Reference gives ListSchedules
    // NO resource type, so a scoped schedule/group ARN is DENIED at runtime (this breaks deactivateSchedules()
    // whose first call is ListSchedules → MED-6 compensation, OPS-01/STUDY-05 deactivation, and the LOW-8
    // drain). It therefore requires Resource:'*'. Kept as its OWN single-action statement (never bundled
    // with Create/Delete) and bounded with an aws:RequestedRegion Condition so the `*` is still confined
    // to the deployment region.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['scheduler:ListSchedules'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:RequestedRegion': region },
        },
      }),
    );

    // (b) iam:PassRole scoped to the single scheduler target-role ARN, with the confused-deputy
    // condition iam:PassedToService=scheduler.amazonaws.com (Pitfall 7 / T-03-10). The Enroll Lambda
    // passes this role to EventBridge Scheduler as the CreateSchedule Target.RoleArn; the condition
    // ensures the role can be passed ONLY to the scheduler service, not exfiltrated to another service.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [props.schedulerTargetRoleArn],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' },
        },
      }),
    );
  }
}
