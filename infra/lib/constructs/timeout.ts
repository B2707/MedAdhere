// infra/lib/constructs/timeout.ts
//
// TimeoutConstruct (Plan 05-01 / PIPE-05 / F07/F28/F49/F61 / M1) — the in-VPC Timeout Lambda: the
// EventBridge Scheduler INVOKE TARGET fired at `sent_at + RESPONSE_WINDOW_MINUTES` that writes the
// delivery-gated, wipe-safe `missed` adherence_record row. Clones the outbound.ts in-VPC pg-fn shape
// (NODEJS_24_X/ARM_64, PRIVATE_WITH_EGRESS + the shared lambdaSg, an explicit DESTROY/ONE_WEEK LogGroup,
// 30s timeout; nodeModules:['pg'] + the afterBundling cp of the RDS CA bundle; env
// DB_SECRET_ARN/DB_HOST/DB_PORT/DB_NAME with NO PGSSLMODE — F28), minus every Twilio/SSM/LLM surface (the
// timeout write touches none of them).
//
// M1 — least privilege: dbSecret.grantRead ONLY (secretsmanager:GetSecretValue on the DB secret). The
// Timeout Lambda is the scheduler INVOKE TARGET, so it carries ZERO scheduler IAM — no
// Create/Delete/List/PassRole. The Scheduler target-invoke role (scheduler.ts) is granted invoke on THIS
// fn by FoundationStack. The lambdaSg→RDS:5432 ingress already exists on the shared SG, so NO new ingress.
//
// M2 — the single-sourced response window (RESPONSE_WINDOW_MINUTES from @medadhere/shared) rides the env
// so the FoundationStack synth test can assert env equality across Outbound/Timeout/Classifier. The
// Timeout handler does not read it at runtime (the Outbound Lambda owns the window→schedule arithmetic);
// it is present for the single-source equality contract.

import { Construct } from 'constructs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as path from 'node:path';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { RESPONSE_WINDOW_MINUTES } from '@medadhere/shared';
import { DATABASE_NAME } from './database.js';

// Repo paths (this file is infra/lib/constructs/ → repo root is three levels up).
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const TIMEOUT_DIR = path.join(REPO_ROOT, 'backend', 'src', 'timeout');
const HANDLER_ENTRY = path.join(TIMEOUT_DIR, 'handler.ts');

export interface TimeoutConstructProps {
  /** The VPC from NetworkConstruct (in-process ref — D-12). */
  readonly vpc: ec2.IVpc;
  /** The shared Lambda SG already admitted to RDS:5432 (database.ts allowFrom). */
  readonly lambdaSg: ec2.ISecurityGroup;
  /** The Phase-1 RDS instance — endpoint host/port feed the Lambda env. */
  readonly db: rds.DatabaseInstance;
  /** The CDK-generated DB-credential secret (grantRead target — M1 / D-06). */
  readonly dbSecret: secretsmanager.ISecret;
}

export class TimeoutConstruct extends Construct {
  /** The in-VPC Timeout Lambda (the EventBridge Scheduler invoke target — PIPE-05). */
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: TimeoutConstructProps) {
    super(scope, id);

    // Explicit log group (F61) so it does not orphan after cdk destroy.
    const logGroup = new logs.LogGroup(this, 'TimeoutLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.fn = new NodejsFunction(this, 'TimeoutFn', {
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
        // M2 — the single-sourced response window (the SAME @medadhere/shared const Outbound/Classifier use).
        RESPONSE_WINDOW_MINUTES: String(RESPONSE_WINDOW_MINUTES),
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

    // M1 — least privilege: GetSecretValue on the DB secret only. NO scheduler IAM (this fn is the
    // invoke TARGET, not a schedule creator/sweeper). The lambdaSg→RDS:5432 ingress already exists.
    props.dbSecret.grantRead(this.fn);
  }
}
