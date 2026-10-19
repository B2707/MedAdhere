// infra/lib/constructs/schema-init.ts
//
// SchemaInitConstruct (D-03/D-12 / F01/F03/F28/F61) — the custom resource that applies schema.sql
// to private RDS on deploy, per RESEARCH Pattern 2.
//
//   - A NodejsFunction wrapping backend/src/schema-init/handler.ts (node24/ARM64, 5-min timeout, in
//     the PRIVATE_WITH_EGRESS subnets on the Lambda SG).
//   - schema.sql AND the AWS RDS global CA bundle (rds-global-bundle.pem, M-2) are COPIED into the
//     bundle via esbuild commandHooks.afterBundling (F01/F03) — esbuild bundles JS/TS only, so without
//     these copies the handler's runtime readFileSync('schema.sql' / 'rds-global-bundle.pem') ENOENTs
//     at deploy → custom-resource throws → CFN rolls back the whole VPC/NAT/RDS stack. Because the
//     copies are part of the OUTPUT bundle hash, editing schema.sql changes BOTH the Lambda code-asset
//     S3 key AND the CustomResource SqlHash property — a SQL-only edit cannot silently run stale
//     bundled SQL (F03). The CA bundle is read by the handler for server-cert verification.
//   - env for the admin plus four role secrets and DB_HOST/DB_PORT/DB_NAME — and NO PGSSLMODE
//     (F28; the handler single-sources TLS via the explicit pg `ssl` object).
//   - Explicit DESTROY/ONE_WEEK LogGroups for BOTH the onEvent Lambda AND the Provider framework
//     Lambda (F61) so neither log group orphans after cdk destroy.
//   - All five DB secrets grantRead(fn) + db.connections.allowFrom(fn, Port.tcp(5432)).
//   - Provider(onEventHandler: fn) + CustomResource hashes for schema.sql and handler.ts — the
//     re-run triggers; the handler returns the STABLE "medadhere-schema" id (T-03-03).

import { Construct } from 'constructs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Provider } from 'aws-cdk-lib/custom-resources';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { DATABASE_NAME } from './database.js';

// Repo paths (this file is infra/lib/constructs/ → repo root is three levels up).
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const SCHEMA_INIT_DIR = path.join(REPO_ROOT, 'backend', 'src', 'schema-init');
const HANDLER_ENTRY = path.join(SCHEMA_INIT_DIR, 'handler.ts');
const SCHEMA_SQL_PATH = path.join(SCHEMA_INIT_DIR, 'schema.sql');

export interface SchemaInitConstructProps {
  readonly vpc: ec2.IVpc;
  readonly lambdaSg: ec2.ISecurityGroup;
  readonly db: rds.DatabaseInstance;
  readonly adminDbSecret: secretsmanager.ISecret;
  readonly appDbSecret: secretsmanager.ISecret;
  readonly inboundDbSecret: secretsmanager.ISecret;
  readonly statusCallbackDbSecret: secretsmanager.ISecret;
  readonly sourceImportDbSecret: secretsmanager.ISecret;
}

export class SchemaInitConstruct extends Construct {
  public readonly onEventFn: NodejsFunction;
  public readonly customResource: CustomResource;

  constructor(scope: Construct, id: string, props: SchemaInitConstructProps) {
    super(scope, id);

    // Explicit log group (F61) so it does not orphan after cdk destroy.
    const onEventLogGroup = new logs.LogGroup(this, 'SchemaInitLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.onEventFn = new NodejsFunction(this, 'SchemaInitFn', {
      entry: HANDLER_ENTRY,
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X, // F07
      architecture: Architecture.ARM_64, // D-08 / F07
      timeout: Duration.minutes(5),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSg],
      logGroup: onEventLogGroup,
      environment: {
        DB_ADMIN_SECRET_ARN: props.adminDbSecret.secretArn,
        DB_APP_SECRET_ARN: props.appDbSecret.secretArn,
        DB_INBOUND_SECRET_ARN: props.inboundDbSecret.secretArn,
        DB_STATUS_CALLBACK_SECRET_ARN: props.statusCallbackDbSecret.secretArn,
        DB_SOURCE_IMPORT_SECRET_ARN: props.sourceImportDbSecret.secretArn,
        DB_HOST: props.db.dbInstanceEndpointAddress,
        DB_PORT: props.db.dbInstanceEndpointPort,
        DB_NAME: DATABASE_NAME, // "medadhere" (F26)
        // NO PGSSLMODE (F28) — the handler single-sources TLS via the explicit pg `ssl` object.
      },
      bundling: {
        // pg is a real runtime dependency the handler imports; keep it out of the esbuild bundle and
        // install it in the Lambda node_modules instead (native-friendly).
        nodeModules: ['pg'],
        // F01/F03 — copy schema.sql into the bundle output dir alongside the compiled handler so the
        // handler's runtime readFileSync(join(__dirname,'schema.sql')) resolves. M-2 — copy the AWS RDS
        // global CA bundle (rds-global-bundle.pem) the SAME way so the handler's
        // readFileSync(join(__dirname,'rds-global-bundle.pem')) resolves for server-cert verification
        // (rejectUnauthorized:true). Both copies are part of the OUTPUT bundle hash, so editing either
        // changes the Lambda code-asset S3 key (no stale bundled artifact).
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp ${path.join(inputDir, 'backend', 'src', 'schema-init', 'schema.sql')} ${outputDir}`,
            `cp ${path.join(inputDir, 'backend', 'src', 'schema-init', 'rds-global-bundle.pem')} ${outputDir}`,
          ],
        },
      },
    });

    props.adminDbSecret.grantRead(this.onEventFn);
    props.appDbSecret.grantRead(this.onEventFn);
    props.inboundDbSecret.grantRead(this.onEventFn);
    props.statusCallbackDbSecret.grantRead(this.onEventFn);
    props.sourceImportDbSecret.grantRead(this.onEventFn);
    props.db.connections.allowFrom(
      this.onEventFn,
      ec2.Port.tcp(5432),
      'Allow the schema-init Lambda to reach RDS:5432',
    );

    // Provider framework — handles CFN signaling/timeout (no hand-rolled cfn-response). Give its own
    // framework Lambda an explicit DESTROY/ONE_WEEK log group (F61) so it does not orphan either.
    const providerLogGroup = new logs.LogGroup(this, 'SchemaInitProviderLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const provider = new Provider(this, 'SchemaInitProvider', {
      onEventHandler: this.onEventFn,
      logGroup: providerLogGroup,
    });

    // CFN invokes onEvent on Update only when a custom-resource property differs. Track both the SQL
    // and handler source so role/grant changes cannot deploy as new Lambda code without being applied.
    const sqlHash = createHash('md5').update(readFileSync(SCHEMA_SQL_PATH, 'utf8')).digest('hex');
    const handlerHash = createHash('md5').update(readFileSync(HANDLER_ENTRY, 'utf8')).digest('hex');

    this.customResource = new CustomResource(this, 'SchemaInit', {
      serviceToken: provider.serviceToken,
      properties: {
        SqlHash: sqlHash,
        HandlerHash: handlerHash,
        AppSecretArn: props.appDbSecret.secretArn,
        InboundSecretArn: props.inboundDbSecret.secretArn,
        StatusCallbackSecretArn: props.statusCallbackDbSecret.secretArn,
        SourceImportSecretArn: props.sourceImportDbSecret.secretArn,
      },
    });

    // Post-exec review DEPLOY-3: the onEvent Lambda connects to RDS:5432, but referencing the DB
    // endpoint only orders the CR after the DB *instance* — NOT after the lambdaSg→RDS:5432 ingress
    // rule (a separate resource on the DB's SG, added in DatabaseConstruct). Without this, the
    // first-deploy CR invocation can race the SG opening and time out. Depend on the whole DB
    // construct subtree (which includes that ingress rule) so the CR runs only once 5432 is open.
    this.customResource.node.addDependency(props.db);
  }
}
