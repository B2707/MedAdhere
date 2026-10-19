// infra/lib/constructs/database.ts
//
// DatabaseConstruct (INFRA-02/04 / DATA-02 / D-14 / F26) — RDS PostgreSQL 16.4 t4g.micro
// Single-AZ, per RESEARCH Pattern 5.
//
//   - postgres VER_16_4, db.t4g.micro, multiAz:false (project decision record "Recommended Database" Single-AZ).
//   - gp3 20GB, storageEncrypted:true, backupRetention from props (default 7 = DATA-02 ">=7-day from
//     first deploy"; the account is on the Paid Plan so 7 deploys cleanly). 0 is the EXCEPTIONAL
//     override for a free-plan-restricted account, which rejected the 7-day target (Phase-1 finding);
//     the stack's DATA-02 guard hard-fails synth if validationWindow=true with <7,
//     enablePerformanceInsights:false (D-14).
//   - databaseName: "medadhere" (F26 — REQUIRED; `Credentials.fromGeneratedSecret` only sets the
//     master username, so WITHOUT databaseName Postgres exposes only the `postgres` DB and the
//     schema-init connect to DB_NAME='medadhere' fails with `database "medadhere" does not exist`
//     → custom-resource failure → full stack rollback).
//   - rds.force_ssl=1 ParameterGroup (D-14 — TLS in transit enforced server-side).
//   - removalPolicy: DESTROY + deletionProtection forwarded from the stack (default false) — BOTH
//     required or the DB leaks after a "successful" cdk destroy (project decision record caveat / INFRA-04). The
//     validationWindow → deletionProtection + stack-level terminationProtection wiring is done in
//     bin/medadhere.ts (F59); termination protection is a Stack-level prop, NOT set here.
//   - deleteAutomatedBackups + skip final snapshot on destroy (RESEARCH A6 — cleanest INFRA-04; the
//     manual P7 snapshot is the deliberate backup point).
//   - SG rule: db.connections.allowFrom(lambdaSg, Port.tcp(5432)) (RESEARCH Pitfall 1).
//
// NO Aurora, NO RDS Proxy (blocking anti-patterns). Credentials = a CDK-generated Secrets Manager
// secret (D-06) exposed as `secret` for downstream grantRead.

import { Construct } from 'constructs';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/** The database name the schema-init handler connects to (DB_NAME). F26. */
export const DATABASE_NAME = 'medadhere';
export const APPLICATION_DB_USERNAME = 'medadhere_app';
export const INBOUND_DB_USERNAME = 'medadhere_inbound';
export const STATUS_CALLBACK_DB_USERNAME = 'medadhere_status_callback';
export const SOURCE_IMPORT_DB_USERNAME = 'medadhere_source_import';

export interface DatabaseConstructProps {
  /** The VPC from NetworkConstruct. */
  readonly vpc: ec2.IVpc;
  /** The Lambda SG admitted to RDS:5432. */
  readonly lambdaSg: ec2.ISecurityGroup;
  /**
   * Forwarded from the stack (= validationWindow). Default false (INFRA-04 clean teardown). Flip
   * true ONLY during the P7 validation window via the cdk.json `validationWindow` context (F59).
   */
  readonly deletionProtection?: boolean;
  /**
   * Automated-backup retention in days. Default 7 (DATA-02 ">=7-day backups from first deploy"; the
   * account is on the Paid Plan so 7 deploys cleanly). Set 0 ONLY as the exceptional override for a
   * free-plan-restricted account, which rejects >0 ("backup retention period exceeds the maximum
   * available to free tier customers", Phase-1 finding) — but FoundationStack still hard-fails synth
   * if validationWindow=true with <7 (DATA-02). Forwarded from the stack.
   */
  readonly backupRetentionDays?: number;
}

export class DatabaseConstruct extends Construct {
  /** The RDS PostgreSQL 16.4 instance. */
  public readonly instance: rds.DatabaseInstance;
  /** The CDK-generated DB-password secret (D-06) — inherits removalPolicy DESTROY (F62). */
  public readonly secret: secretsmanager.ISecret;
  /** Generated credentials for the non-DDL runtime application role. */
  public readonly appSecret: secretsmanager.ISecret;
  /** Generated credentials for the public inbound webhook's table-limited role. */
  public readonly inboundSecret: secretsmanager.ISecret;
  /** Generated credentials for the public delivery-status callback's table-limited role. */
  public readonly statusCallbackSecret: secretsmanager.ISecret;
  /** Generated credentials used only by the explicit offline source-import operator path. */
  public readonly sourceImportSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: DatabaseConstructProps) {
    super(scope, id);

    const engine = rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.VER_16_4,
    });

    // rds.force_ssl=1 — server-side TLS enforcement in transit (D-14).
    const parameterGroup = new rds.ParameterGroup(this, 'Pg16Params', {
      engine,
      parameters: { 'rds.force_ssl': '1' },
    });

    this.instance = new rds.DatabaseInstance(this, 'Instance', {
      engine,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      multiAz: false, // Single-AZ (project decision record)
      storageType: rds.StorageType.GP3, // D-14
      allocatedStorage: 20, // D-14 floor
      parameterGroup,
      databaseName: DATABASE_NAME, // F26 — the connect target must exist
      credentials: rds.Credentials.fromGeneratedSecret('medadhere_admin'), // D-06 generated secret
      storageEncrypted: true, // INFRA-02 at-rest encryption
      backupRetention: Duration.days(props.backupRetentionDays ?? 7), // DATA-02 default 7 (see props)
      enablePerformanceInsights: false, // D-14
      // INFRA-DEPLOY-02 — honor project decision record "Manual minor-version upgrades. Schedule them on a known
      // day": disable auto minor-version upgrades so an unscheduled RDS upgrade can never restart the
      // instance mid-dose or mid-validation-window, and pin the weekly maintenance window to a low-
      // traffic slot (Sun 08:00-08:30 UTC = ~03:00-03:30 ET, well outside any plausible dose/validation
      // time) so any AWS-mandated maintenance lands predictably.
      autoMinorVersionUpgrade: false,
      preferredMaintenanceWindow: 'Sun:08:00-Sun:08:30',
      deletionProtection: props.deletionProtection ?? false, // INFRA-04 (F59 P7 toggle)
      removalPolicy: RemovalPolicy.DESTROY, // INFRA-04 clean teardown — BOTH required or leak
      deleteAutomatedBackups: true, // clean teardown (RESEARCH A6)
      publiclyAccessible: false, // private subnets, no public inbound (T-04-02)
    });

    // SG rule: the in-VPC Lambdas may reach RDS on 5432 (RESEARCH Pitfall 1).
    this.instance.connections.allowFrom(
      props.lambdaSg,
      ec2.Port.tcp(5432),
      'Allow the in-VPC Lambdas (schema-init + smoke) to reach RDS:5432',
    );

    this.secret = this.instance.secret!;
    this.appSecret = new rds.DatabaseSecret(this, 'AppCredentials', {
      username: APPLICATION_DB_USERNAME,
      dbname: DATABASE_NAME,
    });
    this.appSecret.applyRemovalPolicy(RemovalPolicy.DESTROY);
    this.inboundSecret = new rds.DatabaseSecret(this, 'InboundCredentials', {
      username: INBOUND_DB_USERNAME,
      dbname: DATABASE_NAME,
    });
    this.inboundSecret.applyRemovalPolicy(RemovalPolicy.DESTROY);
    this.statusCallbackSecret = new rds.DatabaseSecret(this, 'StatusCallbackCredentials', {
      username: STATUS_CALLBACK_DB_USERNAME,
      dbname: DATABASE_NAME,
    });
    this.statusCallbackSecret.applyRemovalPolicy(RemovalPolicy.DESTROY);
    this.sourceImportSecret = new rds.DatabaseSecret(this, 'SourceImportCredentials', {
      username: SOURCE_IMPORT_DB_USERNAME,
      dbname: DATABASE_NAME,
    });
    this.sourceImportSecret.applyRemovalPolicy(RemovalPolicy.DESTROY);
  }
}
