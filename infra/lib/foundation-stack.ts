// infra/lib/foundation-stack.ts
//
// FoundationStack (D-07) — the SINGLE Phase-1 stack. Composes all eight constructs in dependency
// order: network → database → secrets → schema-init → smoke → budgets → bastion.
//
// The `validationWindow` boolean (from the cdk.json / app context, read in bin/medadhere.ts, F59) is
// forwarded to DatabaseConstruct as `deletionProtection`. Stack-level `terminationProtection` is set
// from the SAME flag in bin/medadhere.ts (it is a Stack-level prop, NOT a construct prop).

import { Stack, Annotations, CfnOutput, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { RESPONSE_WINDOW_MINUTES, SCHEDULE_GROUP_NAME } from '@medadhere/shared';
import { NetworkConstruct } from './constructs/network.js';
import { DatabaseConstruct } from './constructs/database.js';
import { SecretsConstruct } from './constructs/secrets.js';
import { SchemaInitConstruct } from './constructs/schema-init.js';
import { SmokeConstruct } from './constructs/smoke.js';
import { BudgetsConstruct } from './constructs/budgets.js';
import { BastionConstruct } from './constructs/bastion.js';
import { AuthConstruct } from './constructs/auth.js';
import { DataApiConstruct } from './constructs/data-api.js';
import { HostingConstruct } from './constructs/hosting.js';
import { StatusCallbackConstruct, STATUS_CALLBACK_ROUTE } from './constructs/status-callback.js';
import { OutboundConstruct } from './constructs/outbound.js';
import { TimeoutConstruct } from './constructs/timeout.js';
import { SchedulerConstruct } from './constructs/scheduler.js';
import { EnrollConstruct } from './constructs/enroll.js';
import { InboundConstruct, INBOUND_ROUTE } from './constructs/inbound.js';
import { ClassifierConstruct } from './constructs/classifier.js';
import { LlmGatewayConstruct } from './constructs/llm-gateway.js';
import { MonitoringConstruct } from './constructs/monitoring.js';
import { ExportAnonConstruct } from './constructs/export-anon.js';

export interface FoundationStackProps extends StackProps {
  /**
   * The P7 validation-window toggle (F59). Forwarded to DatabaseConstruct as `deletionProtection`;
   * stack-level `terminationProtection` is set from the same flag via StackProps in bin/medadhere.ts.
   * Default false (INFRA-04 clean teardown).
   */
  readonly validationWindow?: boolean;
  /**
   * RDS automated-backup retention in days, forwarded to DatabaseConstruct. Default 7 (DATA-02
   * ">=7-day backups from first deploy"; the account is on the Paid Plan, so 7 deploys cleanly). 0 is
   * the EXCEPTIONAL free-plan override (the free plan caps RDS backup retention). Set via the
   * cdk.json / `-c backupRetentionDays=N` context.
   */
  readonly backupRetentionDays?: number;
}

export class FoundationStack extends Stack {
  public readonly network: NetworkConstruct;
  public readonly database: DatabaseConstruct;
  public readonly secrets: SecretsConstruct;
  public readonly schemaInit: SchemaInitConstruct;
  public readonly smoke: SmokeConstruct;
  public readonly budgets: BudgetsConstruct;
  public readonly bastion: BastionConstruct;
  // Phase-2 (plan 04) integration wave — wired by in-process object refs (D-12), NO CFN cross-stack import.
  public readonly auth: AuthConstruct;
  public readonly dataApi: DataApiConstruct;
  public readonly hosting?: HostingConstruct;
  // Phase-3 (plan 03) integration wave — wired by in-process object refs (D-12), NO CFN cross-stack import.
  public readonly statusCallback: StatusCallbackConstruct;
  public readonly outbound: OutboundConstruct;
  // Phase-5 (plan 05-01) — the PIPE-05 non-response Timeout Lambda (in-process ref — D-12).
  public readonly timeout: TimeoutConstruct;
  public readonly scheduler: SchedulerConstruct;
  public readonly enroll: EnrollConstruct;
  // Phase-4/8 integration seam — inbound webhook + patient FIFO + queue worker (D-12).
  public readonly inbound: InboundConstruct;
  public readonly llmGateway: LlmGatewayConstruct;
  public readonly classifier: ClassifierConstruct;
  // Phase-5 (plan 05-04) — OPS-02 CloudWatch alarms + filters (email delivery removed 2026-08-04).
  public readonly monitoring: MonitoringConstruct;
  // Phase-6 (plan 06-06) — DASH-06 anonymized export: M11 bucket + in-VPC export Lambda + gated schedule.
  public readonly exportAnon: ExportAnonConstruct;

  constructor(scope: Construct, id: string, props?: FoundationStackProps) {
    super(scope, id, props);

    const validationWindow = props?.validationWindow ?? false;
    const backupRetentionDays = props?.backupRetentionDays ?? 7;

    // DATA-02 <-> F59 coupling guard (post-exec review 01-05, HIGH). The validation window
    // (validationWindow=true, 2026-08-26..09-05) MUST run with >=7-day RDS backups — the classifier
    // outputs (adherence_record / safety_events) are irrecoverable from Twilio logs. Fail synth LOUDLY
    // if a validation-window deploy would disable/shorten backups, so the documented one-flag toggle
    // can never silently ship BackupRetentionPeriod<7 alongside deletion/termination protection.
    if (validationWindow && backupRetentionDays < 7) {
      Annotations.of(this).addError(
        `DATA-02: validationWindow=true requires backupRetentionDays>=7 (got ${backupRetentionDays}) — pass -c backupRetentionDays=7`,
      );
    }

    // 1. Network — the VPC, NAT, endpoints, and the Lambda SG everything else attaches to. The
    //    Secrets Manager interface endpoint + the S3 gateway endpoint are unconditional.
    this.network = new NetworkConstruct(this, 'Network');

    // 2. Database — RDS + force_ssl param group + the Lambda→RDS:5432 SG rule. deletionProtection is
    //    the forwarded validationWindow flag (F59).
    this.database = new DatabaseConstruct(this, 'Database', {
      vpc: this.network.vpc,
      lambdaSg: this.network.lambdaSg,
      deletionProtection: validationWindow,
      backupRetentionDays,
    });

    // 3. Secrets — out-of-stack Twilio/Anthropic refs + re-exposed DB secret + SSM deploy-time reads.
    this.secrets = new SecretsConstruct(this, 'Secrets', {
      dbSecret: this.database.secret,
      appDbSecret: this.database.appSecret,
      inboundDbSecret: this.database.inboundSecret,
      statusCallbackDbSecret: this.database.statusCallbackSecret,
      sourceImportDbSecret: this.database.sourceImportSecret,
    });

    // 4. Schema-init — the custom resource that applies schema.sql to RDS on deploy.
    this.schemaInit = new SchemaInitConstruct(this, 'SchemaInit', {
      vpc: this.network.vpc,
      lambdaSg: this.network.lambdaSg,
      db: this.database.instance,
      adminDbSecret: this.secrets.dbSecret,
      appDbSecret: this.secrets.appDbSecret,
      inboundDbSecret: this.secrets.inboundDbSecret,
      statusCallbackDbSecret: this.secrets.statusCallbackDbSecret,
      sourceImportDbSecret: this.secrets.sourceImportDbSecret,
    });
    new CfnOutput(this, 'SourceImportDbSecretArn', {
      value: this.secrets.sourceImportDbSecret.secretArn,
      description:
        'Generated least-privilege credential for explicitly approved offline source imports; never distributed to a runtime Lambda.',
    });

    // 5. Smoke — the in-VPC Twilio transport smoke. Anthropic is isolated behind the gateway below.
    this.smoke = new SmokeConstruct(this, 'Smoke', {
      vpc: this.network.vpc,
      lambdaSg: this.network.lambdaSg,
      twilioSecret: this.secrets.twilioSecret,
      testRecipient: this.secrets.testRecipient,
    });

    // 6. Budgets — the account-wide monthly cost backstop. The EMAIL subscriber is a SYNTH-TIME
    //    LITERAL (WR-01): an AWS Budgets EMAIL subscriber address must be a real address, NOT a
    //    `{{resolve:ssm}}` dynamic-reference token (Budgets does not resolve dynamic references for
    //    subscriber addresses), or the D-11 runaway-cost backstop silently never notifies. Sourced
    //    from `-c billingEmail=` / cdk.json context.
    const { email: billingEmail, isPlaceholder: isBillingEmailPlaceholder } =
      this.resolveBillingEmail();
    this.budgets = new BudgetsConstruct(this, 'Budgets', {
      billingEmail,
    });

    // WR-01 — guard the billing-email placeholder. The WR-01 fix
    // falls back to the RFC-2606 `.invalid` literal when no `-c billingEmail=` is passed, so a
    // default/validation deploy could SILENTLY wire the D-11 budget alerts to an undeliverable address.
    // DEBATE-11 (260618-88u): emit an UNCONDITIONAL synth WARNING whenever the placeholder is in use —
    // so even a default deploy gets a visible synth signal that the runaway-cost backstop's alerts are
    // undeliverable — while KEEPING the hard addError on validation-window deploys.
    // Placeholder-by-default stays allowed (warning, not error).
    if (isBillingEmailPlaceholder) {
      Annotations.of(this).addWarning(
        'billingEmail is the RFC-2606 .invalid placeholder — the D-11 runaway-cost Budget alerts will NOT be deliverable. Pass -c billingEmail=<real address> for any deploy you want to receive cost alerts. (Hard-required only on validation-window deploys.)',
      );
      if (validationWindow) {
        Annotations.of(this).addError(
          'billingEmail placeholder (.invalid) shipped on a validation-window deploy — pass -c billingEmail=<real address>',
        );
      }
    }

    // 7. Bastion — the on-demand SSM bastion for private-RDS access.
    this.bastion = new BastionConstruct(this, 'Bastion', {
      vpc: this.network.vpc,
      db: this.database.instance,
    });

    // === Phase-2 integration wave (plan 04, D-12) ==================================================
    // Wire AuthConstruct + DataApiConstruct + HostingConstruct into THIS single stack by in-process
    // object refs (this.network.vpc / this.network.lambdaSg / this.secrets.dbSecret / this.auth.*) —
    // exactly like the schema-init/smoke wiring above. NO CFN cross-stack import, NO CfnOutput cross-stack
    // import (RESEARCH Pitfall 5). One stack ⇒ one clean `cdk destroy` (INFRA-04).

    // H1 — the redirect hosts are the SINGLE SOURCE OF TRUTH: the SAME host strings feed BOTH the
    // Cognito callback/logout allow-list (AuthConstruct) AND the Amplify SSR COGNITO_REDIRECT_URI
    // (HostingConstruct), so the allow-list and the SSR env cannot drift. Resolved from context with
    // synth-safe defaults; the real first-deploy Amplify URL is reconciled in plan 05's two-pass step
    // (Cognito callback URLs are mutable post-deploy) using the AmplifyUrl CfnOutput emitted below.
    const hosts = this.resolveHostingConfig();

    // 9. Auth — the Cognito identity foundation (declare the pool/client FIRST; data-api + hosting
    //    consume its refs below). The redirect-host props here are H1's single source of truth.
    this.auth = new AuthConstruct(this, 'Auth', {
      amplifyCallbackUrl: hosts.amplifyHost,
      vercelCallbackUrl: hosts.vercelHost,
    });

    // 10. Data-API — the in-VPC SELECT 1 Lambda behind the HTTP API native Cognito JWT authorizer.
    //     ALL in-process refs (D-12): the live Phase-1 VPC/SG/db/dbSecret + the plan-01 Cognito refs.
    this.dataApi = new DataApiConstruct(this, 'DataApi', {
      vpc: this.network.vpc,
      lambdaSg: this.network.lambdaSg,
      db: this.database.instance,
      dbSecret: this.secrets.appDbSecret,
      userPool: this.auth.userPool,
      userPoolClient: this.auth.userPoolClient,
    });

    // Deploy-gate for the Amplify dashboard tier (M7). The Amplify App reads the human-created,
    // out-of-stack secret `medadhere/amplify-github-token` via SecretValue.secretsManager — so a
    // deploy without that secret fails at App create and rolls the whole stack back. Backend/SMS
    // smoke deploys (SC4) do NOT need the dashboard: pass `-c deployHosting=false` to skip the
    // Amplify App/Branch + its CfnOutputs. Defaults true — full deploys and all synth tests are
    // unchanged (dashboard host of record is Vercel, D-02, so Amplify is optional infra here).
    const deployHosting =
      this.node.tryGetContext('deployHosting') !== false &&
      this.node.tryGetContext('deployHosting') !== 'false';

    if (deployHosting) {
      // 11. Hosting — the Amplify WEB_COMPUTE App + Branch for the dashboard tier. Consumes the
      //     synthesized Cognito + data-API refs (in-process — D-12). H1: cognitoRedirectUri is the SAME
      //     host the AuthConstruct allow-list used (hosts.amplifyHost + the callback path). H2: region
      //     is injected as COGNITO_REGION (NOT AWS_REGION) inside HostingConstruct.
      this.hosting = new HostingConstruct(this, 'Hosting', {
        userPoolId: this.auth.userPool.userPoolId,
        userPoolClientId: this.auth.userPoolClient.userPoolClientId,
        cognitoDomain: this.auth.userPoolDomain.baseUrl(),
        dataApiUrl: this.dataApi.httpApi.apiEndpoint,
        region: this.region,
        cognitoRedirectUri: `${hosts.amplifyHost.replace(/\/$/, '')}/api/auth/callback`,
        githubOwner: hosts.githubOwner,
        githubRepository: hosts.githubRepository,
        githubBranch: hosts.githubBranch,
        githubTokenSecretName: hosts.githubTokenSecretName,
      });

      // H1 — emit the deployed Amplify URL (+ data-API URL) as informational SAME-STACK CfnOutputs so
      // plan 05's two-pass step can read the real `<branch>.<appId>` Amplify host (non-deterministic at
      // synth) and reconcile BOTH the Cognito client callback/redirect AND the Amplify COGNITO_REDIRECT_URI
      // env to it. These are NOT cross-stack exports (no CFN cross-stack import consumer) — they are read by the
      // operator/plan-05 tooling, not another stack (D-12 preserved).
      new CfnOutput(this, 'AmplifyUrl', {
        value: `https://${this.hosting.branch.branchName}.${this.hosting.app.defaultDomain}`,
        description:
          'Deployed Amplify default URL — plan 05 reconciles the Cognito callback/redirect to this (H1).',
      });
      new CfnOutput(this, 'AmplifyAppId', {
        value: this.hosting.app.appId,
        description: 'Amplify App id (for plan-05 reconciliation tooling).',
      });
    }
    new CfnOutput(this, 'DataApiUrl', {
      value: this.dataApi.httpApi.apiEndpoint,
      description:
        'Public data-API (HTTP API) endpoint the dashboard SSR tier calls (DATA_API_URL).',
    });
    new CfnOutput(this, 'D4ClientId', {
      value: this.auth.totpClient.userPoolClientId,
      description:
        'D4 auxiliary no-secret Cognito app-client id for the runbook TOTP USER_PASSWORD_AUTH flow.',
    });

    // === Phase-3 integration wave (plan 03, D-12) =================================================
    // Wire StatusCallbackConstruct → OutboundConstruct → SchedulerConstruct → EnrollConstruct into THIS
    // single stack by in-process object refs (this.network.vpc / this.network.lambdaSg /
    // this.database.instance / this.secrets.dbSecret / this.secrets.twilioSecret + the new constructs'
    // in-process refs) — exactly like the Phase-2 wave above. NO CFN cross-stack import, NO cross-stack export
    // (D-12). One stack ⇒ one clean `cdk destroy` (INFRA-04). Dependency order: status-callback gives the
    // HTTP API endpoint → outbound consumes STATUS_CALLBACK_URL → scheduler grantInvoke on outbound →
    // enroll env gets the outbound ARN + the scheduler target-role ARN (+ the PassRole resource).

    // 12. Status-callback — the PUBLIC Twilio delivery-status webhook (HTTP API v2, NO authorizer). Built
    //     FIRST so its httpApi.apiEndpoint is available to compute the single-source STATUS_CALLBACK_URL.
    //     The construct's STATUS_CALLBACK_URL env is overridden below (addEnvironment) with the exact URL
    //     derived from its own endpoint — the fragment-free Pitfall-2 source validateRequest anchors on.
    this.statusCallback = new StatusCallbackConstruct(this, 'StatusCallback', {
      vpc: this.network.vpc,
      lambdaSg: this.network.lambdaSg,
      db: this.database.instance,
      dbSecret: this.secrets.statusCallbackDbSecret,
      twilioSecret: this.secrets.twilioSecret,
      // Placeholder at construct time; replaced with the real apiEndpoint-derived URL immediately below
      // (apiEndpoint is a CFN token resolvable only AFTER the HttpApi exists — the chicken-and-egg the
      // addEnvironment override resolves while keeping ONE source of truth).
      statusCallbackUrl: 'pending',
    });

    // The single-source exact status-callback URL (Pitfall 2): the status-callback HTTP API endpoint +
    // the POST /twilio/status route. apiEndpoint has no trailing slash; STATUS_CALLBACK_ROUTE has a
    // leading slash. The callback handler validates this fragment-free URL because Twilio excludes URL
    // fragments from signature computation. The Outbound handler gets the same URL plus bounded
    // connection overrides so an authenticated 5xx is actually retried.
    const statusCallbackUrl = `${this.statusCallback.httpApi.apiEndpoint}${STATUS_CALLBACK_ROUTE}`;
    const twilioRetryOverrides = '#rc=3&ct=1000&rt=5000&tt=15000&rp=ct,rt,5xx';
    const outboundStatusCallbackUrl = `${statusCallbackUrl}${twilioRetryOverrides}`;
    // Override the placeholder on the status-callback fn with the real derived URL (single source).
    this.statusCallback.fn.addEnvironment('STATUS_CALLBACK_URL', statusCallbackUrl);

    // 13. Outbound — the in-VPC EventBridge Scheduler target (render + Twilio send + outbound_message
    //     write). Consumes the single-source STATUS_CALLBACK_URL (Pitfall 2) + the live VPC/SG/db/secrets.
    this.outbound = new OutboundConstruct(this, 'Outbound', {
      vpc: this.network.vpc,
      lambdaSg: this.network.lambdaSg,
      db: this.database.instance,
      dbSecret: this.secrets.appDbSecret,
      twilioSecret: this.secrets.twilioSecret,
      statusCallbackUrl: outboundStatusCallbackUrl,
    });
    // A callback can be the only durable evidence for an accepted-but-response-lost check-in. The
    // callback Lambda synchronously asks this exact Outbound Lambda to recreate its deterministic
    // timeout/reminder schedules. The grant is scoped to this function only.
    this.statusCallback.fn.addEnvironment('OUTBOUND_FN_ARN', this.outbound.fn.functionArn);
    this.outbound.fn.grantInvoke(this.statusCallback.fn);

    // 13b. Timeout — the PIPE-05 non-response detector (the EventBridge Scheduler INVOKE TARGET fired at
    //      sent_at + RESPONSE_WINDOW_MINUTES). Built BEFORE Scheduler so its fn ARN feeds the target-invoke
    //      grant, and BEFORE the Outbound post-wire below so its ARN is available (in-process refs — D-12).
    this.timeout = new TimeoutConstruct(this, 'Timeout', {
      vpc: this.network.vpc,
      lambdaSg: this.network.lambdaSg,
      db: this.database.instance,
      dbSecret: this.secrets.appDbSecret,
    });

    // 14. Scheduler — the static medadhere-prod schedule group + the target-invoke role. grantInvoke on
    //     BOTH the Outbound (dose one-shots) AND Timeout (timeout one-shots) fns (in-process refs — the
    //     role the Enroll + Outbound Lambdas pass to Scheduler).
    this.scheduler = new SchedulerConstruct(this, 'Scheduler', {
      outboundFn: this.outbound.fn,
      timeoutFn: this.timeout.fn,
    });

    // 14b. POST-WIRE the Outbound env + stack-level scheduler IAM (H4) — the Timeout fn ARN and the
    //      Scheduler target-role ARN exist only NOW (both built after Outbound). Mirror the established
    //      addEnvironment/addToRolePolicy-after-later-construct pattern (STATUS_CALLBACK_URL/INBOUND_URL).
    //      The Outbound Lambda creates the timeout-{patientId}-{doseId} one-shot at send time.
    this.outbound.fn.addEnvironment('TIMEOUT_FN_ARN', this.timeout.fn.functionArn);
    this.outbound.fn.addEnvironment('SCHEDULER_TARGET_ROLE_ARN', this.scheduler.targetRole.roleArn);
    this.outbound.fn.addEnvironment('RESPONSE_WINDOW_MINUTES', String(RESPONSE_WINDOW_MINUTES));
    // M3 — the Outbound Lambda only CREATES the timeout one-shot: grant scheduler:CreateSchedule
    // (group-scoped) + iam:PassRole (scoped to the target-role ARN, confused-deputy condition) ONLY.
    // NO DeleteSchedule, NO ListSchedules (those are the sweep-side grants on Inbound/deactivation).
    const outboundScheduleArn = `arn:aws:scheduler:${this.region}:${this.account}:schedule/${SCHEDULE_GROUP_NAME}/*`;
    const outboundScheduleGroupArn = `arn:aws:scheduler:${this.region}:${this.account}:schedule-group/${SCHEDULE_GROUP_NAME}`;
    this.outbound.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['scheduler:CreateSchedule'],
        resources: [outboundScheduleArn, outboundScheduleGroupArn],
      }),
    );
    this.outbound.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [this.scheduler.targetRole.roleArn],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' },
        },
      }),
    );

    // The doctor reactivation writer is created with DataApi, before the Outbound target and
    // Scheduler role exist. Post-wire only the resources it needs to replace the patient's dose
    // one-shots: sweep the group, recreate each owned dose target, and pass this one target role.
    this.dataApi.reactivateFn.addEnvironment('OUTBOUND_FN_ARN', this.outbound.fn.functionArn);
    this.dataApi.reactivateFn.addEnvironment(
      'SCHEDULER_TARGET_ROLE_ARN',
      this.scheduler.targetRole.roleArn,
    );
    this.dataApi.reactivateFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['scheduler:CreateSchedule', 'scheduler:DeleteSchedule'],
        resources: [outboundScheduleArn, outboundScheduleGroupArn],
      }),
    );
    this.dataApi.reactivateFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['scheduler:ListSchedules'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:RequestedRegion': this.region },
        },
      }),
    );
    this.dataApi.reactivateFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [this.scheduler.targetRole.roleArn],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' },
        },
      }),
    );

    // 15. Enroll — the in-VPC Enroll Lambda. env OUTBOUND_FN_ARN = the Outbound fn ARN,
    //     SCHEDULER_TARGET_ROLE_ARN = the scheduler target-role ARN; the SAME target-role ARN feeds the
    //     Enroll PassRole resource (in-process refs — D-12). The Enroll scheduler/PassRole grants land on
    //     the Enroll construct.
    this.enroll = new EnrollConstruct(this, 'Enroll', {
      vpc: this.network.vpc,
      lambdaSg: this.network.lambdaSg,
      db: this.database.instance,
      dbSecret: this.secrets.appDbSecret,
      outboundFnArn: this.outbound.fn.functionArn,
      schedulerTargetRoleArn: this.scheduler.targetRole.roleArn,
    });

    // === Phase-6 wave (plan 06-02, DASH-05 / D2) POST-WIRE ========================================
    // The lean non-VPC enroll-api fn (created inside DataApiConstruct above) SYNC-invokes the in-VPC Enroll
    // Lambda. Its grant + fn-ARN env exist only NOW that BOTH constructs are built (DataApi is created in
    // the Phase-2 wave, well before Enroll). Mirror the Outbound/Timeout post-wire idiom (14b above): grant
    // the enroll-api fn lambda:InvokeFunction on the Enroll fn (least-privilege — NO other action, NO DB),
    // and inject the Enroll fn ARN as ENROLL_FN_ARN (U-4).
    this.enroll.fn.grantInvoke(this.dataApi.enrollApiFn);
    this.dataApi.enrollApiFn.addEnvironment('ENROLL_FN_ARN', this.enroll.fn.functionArn);

    // The operator sets the Twilio per-message statusCallback to this URL (RESEARCH A6: it is the
    // messages.create statusCallback, so typically no Twilio console config is needed). Emitted as an
    // informational SAME-STACK CfnOutput (NOT a cross-stack export — no CFN cross-stack import consumer, D-12).
    new CfnOutput(this, 'StatusCallbackUrl', {
      value: outboundStatusCallbackUrl,
      description:
        'Public Twilio delivery-status callback URL with bounded connection retries; its fragment is excluded from Twilio signature validation.',
    });

    // === Phase-4 integration wave (plan 04-02, D-12) ==============================================
    // 16. Inbound — the PUBLIC Twilio inbound-message webhook (dedicated HTTP API v2, NO authorizer —
    //     U-06/REV-M3) + the patient-keyed FIFO work queue and one redrive DLQ. Same placeholder→
    //     addEnvironment single-source URL wiring as the status-callback above (Pitfall 2): the
    //     handler's HMAC anchors on the EXACT endpoint-derived URL, kept in ONE place.
    this.inbound = new InboundConstruct(this, 'Inbound', {
      vpc: this.network.vpc,
      lambdaSg: this.network.lambdaSg,
      db: this.database.instance,
      dbSecret: this.secrets.inboundDbSecret,
      twilioSecret: this.secrets.twilioSecret,
      inboundUrl: 'pending', // replaced with the endpoint-derived URL immediately below
    });
    const inboundUrl = `${this.inbound.httpApi.apiEndpoint}${INBOUND_ROUTE}`;
    const inboundProviderUrl = `${inboundUrl}${twilioRetryOverrides}`;
    this.inbound.fn.addEnvironment('INBOUND_URL', inboundUrl);

    // The operator points the Twilio phone number's "A message comes in" webhook at this URL
    // (unlike the status callback, the INBOUND webhook IS a Twilio console/API configuration).
    new CfnOutput(this, 'InboundUrl', {
      value: inboundProviderUrl,
      description:
        'Public Twilio inbound-message webhook URL with bounded connection retries; the handler validates the same fragment-free route because Twilio excludes the fragment from signatures.',
    });

    // 17. Isolated, non-VPC LLM gateway. This is the only runtime Anthropic-secret holder.
    this.llmGateway = new LlmGatewayConstruct(this, 'LlmGateway', {
      anthropicSecret: this.secrets.anthropicSecret,
    });

    // 17b. Existing Classifier construct seam, now the 08-04a queue worker: one batch-size-one SQS
    //     event source consumes the patient FIFO and can emit one replacement wake after a bounded drain.
    this.classifier = new ClassifierConstruct(this, 'Classifier', {
      vpc: this.network.vpc,
      lambdaSg: this.network.lambdaSg,
      db: this.database.instance,
      dbSecret: this.secrets.appDbSecret,
      llmGatewayFn: this.llmGateway.fn,
      outboundFn: this.outbound.fn,
      queue: this.inbound.workQueue,
    });

    // === Phase-6 wave (plan 06-06, DASH-06, D-12) ================================================
    // 18. Export-anon (DASH-06) — created before monitoring so its in-process function ref is alarmed.
    this.exportAnon = new ExportAnonConstruct(this, 'ExportAnon', {
      vpc: this.network.vpc,
      lambdaSg: this.network.lambdaSg,
      db: this.database.instance,
      dbSecret: this.secrets.appDbSecret,
      validationWindow,
    });

    // The schema custom resource creates/rotates the four login roles and installs their exact ACLs.
    // Order every database Lambda after it so a clean deploy cannot invoke code with a secret whose
    // PostgreSQL role or grants do not exist yet. The source-import secret is operator-only and is
    // intentionally absent from this list.
    for (const databaseFn of [
      this.dataApi.fn,
      this.dataApi.deactivateFn,
      this.dataApi.reviewDecisionFn,
      this.dataApi.reminderLimitFn,
      this.dataApi.reactivateFn,
      this.statusCallback.fn,
      this.outbound.fn,
      this.timeout.fn,
      this.enroll.fn,
      this.inbound.fn,
      this.classifier.fn,
      this.exportAnon.exportFn,
    ]) {
      databaseFn.node.addDependency(this.schemaInit.customResource);
    }

    // === Phase-5 monitoring wave (plan 05-04, F2 — WIRING ONLY, D-12) =============================
    // 19. Monitoring (OPS-02) — native AWS/Lambda Errors alarms on the six pipeline fns
    //     (in-process .metricErrors(), D-12) + the one FIFO redrive DLQ-depth alarm + the
    //     safety/anthropic/emergency-routing/timeout-contract/consecutive-undelivered metric-filter
    //     alarms. Email delivery was removed by user decision on 2026-08-04. All alarm inventory +
    //     severity lives in the construct; the stack passes the in-process fn/DLQ/logGroup refs.
    this.monitoring = new MonitoringConstruct(this, 'Monitoring', {
      inboundFn: this.inbound.fn,
      outboundFn: this.outbound.fn,
      classifierFn: this.classifier.fn,
      enrollFn: this.enroll.fn,
      timeoutFn: this.timeout.fn,
      exportFn: this.exportAnon.exportFn,
      redriveDlq: this.inbound.redriveDlq,
      classifierLogGroup: this.classifier.logGroup,
      inboundLogGroup: this.inbound.logGroup,
      statusCallbackLogGroup: this.statusCallback.logGroup,
      outboundLogGroup: this.outbound.logGroup, // F1 — the timeout_schedule_failed line lands here
    });
  }

  /**
   * Resolve the Phase-2 Amplify/Vercel redirect hosts + the private-GitHub-branch source config from
   * cdk.json / `-c` context, with synth-safe defaults. H1 —
   * the returned `amplifyHost` is the SINGLE shared redirect host fed to BOTH the Cognito allow-list
   * (AuthConstruct) AND the Amplify SSR `COGNITO_REDIRECT_URI` (HostingConstruct) so they cannot drift.
   * The real first-deploy Amplify URL is reconciled in plan 05's two-pass step (Cognito callback URLs
   * are mutable post-deploy); these defaults keep hermetic synth + the first deploy green.
   */
  private resolveHostingConfig(): {
    amplifyHost: string;
    vercelHost: string;
    githubOwner: string;
    githubRepository: string;
    githubBranch: string;
    githubTokenSecretName: string;
  } {
    const ctxStr = (key: string, fallback: string): string => {
      const v = this.node.tryGetContext(key);
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
    };
    return {
      // Synth-safe stand-in hosts (D-02 pre-seeds BOTH up front so the Jun-30 fallback is a pure
      // host-swap, RESEARCH Pitfall 7). Real hosts pass `-c amplifyHost=` / `-c vercelHost=`.
      amplifyHost: ctxStr('amplifyHost', 'https://dashboard.medadhere.example'),
      vercelHost: ctxStr('vercelHost', 'https://medadhere.vercel.app'),
      // Private-GitHub-branch source (D-01 / Pitfall 6) — main holds README + .gitignore only; the
      // dashboard app code lives on the private branch Amplify connects to.
      githubOwner: ctxStr('githubOwner', 'B2707'),
      githubRepository: ctxStr('githubRepository', 'medadhere'),
      githubBranch: ctxStr('githubBranch', 'dashboard-deploy'),
      // M7 — the GitHub OAuth token secret NAME (human-created, OUT OF STACK; read via
      // SecretValue.secretsManager, never CDK-managed). Teardown is a plan-05 leak-check step.
      githubTokenSecretName: ctxStr('githubTokenSecretName', 'medadhere/amplify-github-token'),
    };
  }

  /**
   * Resolve the Budgets EMAIL-subscriber address as a SYNTH-TIME LITERAL (WR-01), sourced from the
   * `-c billingEmail=` / cdk.json context. An AWS
   * Budgets EMAIL subscriber address must be a real, deliverable address — a `{{resolve:ssm}}`
   * dynamic-reference token (the previous `valueForStringParameter` source) is NOT resolved for a
   * subscriber address, so the D-11 runaway-cost backstop would silently never notify. When no real
   * email is supplied (hermetic synth / a default deploy that hasn't set it) we fall back to the
   * RFC-2606 `.invalid` placeholder — a valid literal that keeps synth/CI green; a real deploy passes
   * the real billing email.
   *
   * WR-01: returns `isPlaceholder` (true when the `.invalid` fallback was used) so the constructor can
   * fail synth on a validation-window deploy that forgot a real `-c billingEmail=`.
   */
  private resolveBillingEmail(): { email: string; isPlaceholder: boolean } {
    const ctx = this.node.tryGetContext('billingEmail');
    return typeof ctx === 'string' && ctx.trim() !== ''
      ? { email: ctx.trim(), isPlaceholder: false }
      : { email: 'billing-pending@medadhere.invalid', isPlaceholder: true };
  }
}
