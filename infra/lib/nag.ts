// infra/lib/nag.ts
//
// cdk-nag AwsSolutions wiring for the DEPLOYED app entry (Phase-4 W0.3b, audit LOW-19).
//
// `applyNag(app, stack)` is called from bin/medadhere.ts, so the standard `cdk synth`
// (the CI quality job's hermetic synth AND every `cdk deploy`) runs the AwsSolutions rule
// pack — any NEW unsuppressed finding is an error-level Annotation and FAILS synth.
//
// Every suppression below is a DELIBERATE, per-finding accepted disposition:
//   - granular IAM4/IAM5 findings are appliesTo-scoped (never a blanket rule suppression),
//   - each reason cites the project decision (decision record / REQUIREMENTS / phase-review IDs).
// The raw, UNSUPPRESSED view stays available via the review harness:
//   cd infra && npx cdk synth --app "npx tsx scan/cdk-nag-scan.ts" --quiet

import { Aspects, type App, type Stack } from 'aws-cdk-lib';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';

/** CDK-default Lambda execution managed policies (exact cdk-nag finding strings). */
const LAMBDA_BASIC_EXEC =
  'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';
const LAMBDA_VPC_EXEC =
  'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole';

/**
 * Applies the AwsSolutions rule pack to the app and the accepted-disposition
 * suppressions to the FoundationStack. Called ONLY from bin/medadhere.ts (the
 * scan/cdk-nag-scan.ts harness deliberately stays suppression-free).
 */
export function applyNag(app: App, stack: Stack): void {
  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

  const p = (rest: string): string => `/${stack.node.id}/${rest}`;

  // --- IAM4: CDK-default Lambda execution roles (Basic + VPC managed policies) -------------
  // All eight service roles carry only the two AWS-canonical Lambda execution policies
  // (own-log-group writes + ENI lifecycle for VPC attachment). Re-authoring them as
  // customer-managed copies adds maintenance surface with zero security delta for a solo
  // research deployment; every OTHER grant in these roles is already least-privilege
  // (M1 — grantRead-only secrets, scoped scheduler ARNs; see infra/test/*.test.ts guards).
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    [
      p('Classifier/ClassifierFn/ServiceRole/Resource'), // Plan 04-03 (U-05 same-PR rule)
      p('DataApi/DataApiFn/ServiceRole/Resource'),
      p('DataApi/DeactivateFn/ServiceRole/Resource'), // Plan 05-03 (U-05 same-PR rule)
      p('DataApi/ReviewDecisionFn/ServiceRole/Resource'),
      p('DataApi/ReminderLimitFn/ServiceRole/Resource'),
      p('DataApi/ReactivateFn/ServiceRole/Resource'),
      p('Enroll/EnrollFn/ServiceRole/Resource'),
      p('ExportAnon/ExportAnonFn/ServiceRole/Resource'), // Plan 06-06 (U-07 same-PR rule)
      p('Inbound/InboundFn/ServiceRole/Resource'), // Plan 04-02 (U-05 same-PR rule)
      p('LlmGateway/GatewayFn/ServiceRole/Resource'),
      p('Outbound/OutboundFn/ServiceRole/Resource'),
      p('Timeout/TimeoutFn/ServiceRole/Resource'), // Plan 05-01 (U-05 same-PR rule)
      p('SchemaInit/SchemaInitFn/ServiceRole/Resource'),
      p('Smoke/TwilioSmokeFn/ServiceRole/Resource'),
      p('StatusCallback/StatusCallbackFn/ServiceRole/Resource'),
    ],
    [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'CDK-default Lambda execution policies (own log group + VPC ENI lifecycle only). ' +
          'Accepted disposition (04-PLAN W0.3): customer-managed copies add no security for ' +
          'this stack; all other grants are M1 least-privilege and test-guarded.',
        appliesTo: [LAMBDA_BASIC_EXEC, LAMBDA_VPC_EXEC],
      },
    ],
  );

  // The custom-resource Provider framework handler is non-VPC — Basic only.
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    p('SchemaInit/SchemaInitProvider/framework-onEvent/ServiceRole/Resource'),
    [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'CDK custom-resource Provider framework handler — CDK attaches the canonical ' +
          'AWSLambdaBasicExecutionRole itself; the framework Lambda is CDK-managed code.',
        appliesTo: [LAMBDA_BASIC_EXEC],
      },
    ],
  );

  // The lean enroll-api fn (Plan 06-02, DASH-05) is NON-VPC — Basic exec only (no VPC ENI policy).
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    p('DataApi/EnrollApiFn/ServiceRole/Resource'),
    [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'CDK-default Lambda execution policy (own log group only — the enroll-api fn is NON-VPC, so it ' +
          'carries no VPC ENI policy). Accepted disposition (06-02): a customer-managed copy adds no ' +
          'security; the only other grant is the scoped lambda:InvokeFunction on the Enroll fn (the ' +
          'grantInvoke IAM5 below), test-guarded in foundation-stack.test.ts.',
        appliesTo: [LAMBDA_BASIC_EXEC],
      },
    ],
  );

  // --- IAM4: bastion SSM role ----------------------------------------------------------------
  NagSuppressions.addResourceSuppressionsByPath(stack, p('Bastion/BastionRole/Resource'), [
    {
      id: 'AwsSolutions-IAM4',
      reason:
        'AmazonSSMManagedInstanceCore is the AWS-canonical policy for Session Manager and is ' +
        'the entire point of the D-09 bastion (no SSH keys, no inbound ports). A hand-rolled ' +
        'copy would drift from the SSM agent requirements.',
      appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore'],
    },
  ]);

  // --- IAM5: Enroll runtime scheduler permissions ---------------------------------------------
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    p('Enroll/EnrollFn/ServiceRole/DefaultPolicy/Resource'),
    [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'scheduler:ListSchedules has NO resource type in the AWS Service Authorization ' +
          'Reference — an ARN-scoped statement is DENIED at runtime (Phase-3 HIGH-2, confirmed ' +
          'by live smoke + WR-01). It is its own single-action statement bounded by an ' +
          'aws:RequestedRegion condition, never bundled with Create/Delete.',
        appliesTo: ['Resource::*'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Per-dose one-shot schedules are created/deleted at runtime with runtime-generated ' +
          'names — the wildcard is confined to the medadhere-prod schedule group ARN ' +
          '(M5 / RESEARCH Pattern 6); Create/Delete never get a bare *.',
        appliesTo: [
          {
            regex:
              '/^Resource::arn:aws:scheduler:[a-z0-9-]+:<AWS::AccountId>:schedule\\/medadhere-prod\\/\\*$/g',
          },
        ],
      },
    ],
  );

  // --- IAM5: Inbound H1 STOP-sweep scheduler permissions (Plan 05-01, U-05 same-PR rule) -------
  // The InboundFn STOP path sweeps dose-/timeout- schedules via deactivateSchedules (List + Delete).
  // Same accepted disposition as the Enroll grants: ListSchedules has no resource type (must be `*`),
  // and the per-schedule Delete ARN carries the runtime-name wildcard confined to the medadhere-prod
  // group. NO CreateSchedule / PassRole on this fn (the sweep never creates).
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    p('Inbound/InboundFn/ServiceRole/DefaultPolicy/Resource'),
    [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'scheduler:ListSchedules has NO resource type in the AWS Service Authorization ' +
          'Reference — an ARN-scoped statement is DENIED at runtime (Phase-3 HIGH-2). It is its ' +
          'own single-action statement bounded by an aws:RequestedRegion condition, never bundled ' +
          'with DeleteSchedule (the H1 STOP-sweep grant, Plan 05-01).',
        appliesTo: ['Resource::*'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Per-dose/timeout one-shot schedules are DELETED at runtime by runtime-generated names — ' +
          'the wildcard is confined to the medadhere-prod schedule group ARN (H1 STOP sweep); ' +
          'DeleteSchedule never gets a bare *.',
        appliesTo: [
          {
            regex:
              '/^Resource::arn:aws:scheduler:[a-z0-9-]+:<AWS::AccountId>:schedule\\/medadhere-prod\\/\\*$/g',
          },
        ],
      },
    ],
  );

  // --- IAM5: DataApi admin-deactivation sweep scheduler permissions (Plan 05-03, U-05 same-PR rule) --
  // The dedicated DeactivateFn (Q4 — NOT the SELECT-1 health fn) sweeps dose-/timeout- schedules via
  // deactivateSchedules (List + Delete) on the admin STUDY-05 route. Same accepted disposition as the Enroll
  // + Inbound-H1 grants: ListSchedules has no resource type (must be `*`), and the per-schedule Delete ARN
  // carries the runtime-name wildcard confined to the medadhere-prod group. NO CreateSchedule / PassRole on
  // this fn (the admin sweep never creates); the health fn (DataApi/DataApiFn) carries NO scheduler IAM at all.
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    p('DataApi/DeactivateFn/ServiceRole/DefaultPolicy/Resource'),
    [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'scheduler:ListSchedules has NO resource type in the AWS Service Authorization ' +
          'Reference — an ARN-scoped statement is DENIED at runtime (Phase-3 HIGH-2). It is its ' +
          'own single-action statement bounded by an aws:RequestedRegion condition, never bundled ' +
          'with DeleteSchedule (the STUDY-05 admin-deactivation sweep, Plan 05-03).',
        appliesTo: ['Resource::*'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Per-dose/timeout one-shot schedules are DELETED at runtime by runtime-generated names — ' +
          'the wildcard is confined to the medadhere-prod schedule group ARN (STUDY-05 admin sweep); ' +
          'DeleteSchedule never gets a bare *.',
        appliesTo: [
          {
            regex:
              '/^Resource::arn:aws:scheduler:[a-z0-9-]+:<AWS::AccountId>:schedule\\/medadhere-prod\\/\\*$/g',
          },
        ],
      },
    ],
  );

  // --- IAM5: clinician reactivation schedule replacement (08-06) ------------------------------
  // ReactivateFn first sweeps only the patient's dose-prefix, then recreates those deterministic
  // one-shots. ListSchedules has no resource type; Create/Delete stay confined to the one schedule
  // group. PassRole is fully scoped to SchedulerTargetRole and therefore needs no suppression.
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    p('DataApi/ReactivateFn/ServiceRole/DefaultPolicy/Resource'),
    [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'scheduler:ListSchedules has no resource type in the AWS Service Authorization ' +
          'Reference. It is a separate single-action statement bounded by aws:RequestedRegion ' +
          'for the clinician-owned reactivation dose sweep.',
        appliesTo: ['Resource::*'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Reactivation replaces runtime-named dose one-shots; the wildcard is confined to the ' +
          'medadhere-prod schedule group ARN. Create/Delete never receive a bare resource wildcard.',
        appliesTo: [
          {
            regex:
              '/^Resource::arn:aws:scheduler:[a-z0-9-]+:<AWS::AccountId>:schedule\\/medadhere-prod\\/\\*$/g',
          },
        ],
      },
    ],
  );

  // --- IAM5: Outbound CreateSchedule (Plan 05-01, H4 stack-level post-wire; U-05 same-PR rule) --
  // The OutboundFn creates the PIPE-05 timeout one-shot at send time: scheduler:CreateSchedule scoped
  // to the medadhere-prod schedule group ARN (runtime-generated name wildcard) + iam:PassRole scoped
  // to the target-role ARN (no wildcard — no IAM5 there). NO Delete/List on this fn (create-only, M3).
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    p('Outbound/OutboundFn/ServiceRole/DefaultPolicy/Resource'),
    [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Per-dose timeout one-shot schedules are CREATED at runtime with runtime-generated names ' +
          '(timeout-{patientId}-{doseId}) — the wildcard is confined to the medadhere-prod schedule ' +
          'group ARN (M3 create-only grant, Plan 05-01); CreateSchedule never gets a bare *.',
        appliesTo: [
          {
            regex:
              '/^Resource::arn:aws:scheduler:[a-z0-9-]+:<AWS::AccountId>:schedule\\/medadhere-prod\\/\\*$/g',
          },
        ],
      },
    ],
  );

  // --- IAM5: grantInvoke's standard <FnArn>:* qualifier pair ---------------------------------
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    p('Scheduler/SchedulerTargetRole/DefaultPolicy/Resource'),
    [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'grantInvoke() standard shape: lambda:InvokeFunction on the Outbound fn ARN plus its ' +
          '":*" version/alias qualifier — scoped to that single function, not a wildcard grant.',
        appliesTo: [{ regex: '/^Resource::<OutboundOutboundFn.*\\.Arn>:\\*$/g' }],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'grantInvoke() standard shape: lambda:InvokeFunction on the Timeout fn ARN plus its ' +
          '":*" version/alias qualifier — the PIPE-05 timeout one-shot invoke target (Plan 05-01), ' +
          'scoped to that single function, not a wildcard grant.',
        appliesTo: [{ regex: '/^Resource::<TimeoutTimeoutFn.*\\.Arn>:\\*$/g' }],
      },
    ],
  );

  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    p('SchemaInit/SchemaInitProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource'),
    [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'CDK custom-resource Provider framework grantInvoke onto the SchemaInit handler — ' +
          'fn ARN + ":*" qualifier, generated by the framework itself and scoped to that one fn.',
        appliesTo: [{ regex: '/^Resource::<SchemaInitSchemaInitFn.*\\.Arn>:\\*$/g' }],
      },
    ],
  );

  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    p('StatusCallback/StatusCallbackFn/ServiceRole/DefaultPolicy/Resource'),
    [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'grantInvoke() standard shape: lambda:InvokeFunction on the Outbound fn ARN plus its ' +
          '":*" version/alias qualifier. The callback uses this one synchronous target to recover ' +
          'deterministic schedules after an accepted-but-response-lost check-in.',
        appliesTo: [{ regex: '/^Resource::<OutboundOutboundFn.*\\.Arn>:\\*$/g' }],
      },
    ],
  );

  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    p('Classifier/ClassifierFn/ServiceRole/DefaultPolicy/Resource'),
    [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'grantInvoke() standard shape scoped to the isolated LLM gateway function ARN plus its ' +
          '":*" version/alias qualifier; this is not a wildcard function grant.',
        appliesTo: [{ regex: '/^Resource::<LlmGatewayGatewayFn.*\\.Arn>:\\*$/g' }],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'grantInvoke() standard shape scoped to the Outbound function ARN plus its ":*" ' +
          'version/alias qualifier; this is not a wildcard function grant.',
        appliesTo: [{ regex: '/^Resource::<OutboundOutboundFn.*\\.Arn>:\\*$/g' }],
      },
    ],
  );

  // --- IAM5: export-anon scoped s3:PutObject (Plan 06-06, DASH-06; U-07 same-PR rule) ----------
  // The in-VPC export fn writes the anonymized CSV with a SCOPED s3:PutObject on the export bucket's
  // object ARN only (never grantWrite/s3:*, never DeleteObject/ListBucket). The `/*` is the object-key
  // wildcard confined to the single export bucket — the standard scoped-object-write shape, not a bare *.
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    p('ExportAnon/ExportAnonFn/ServiceRole/DefaultPolicy/Resource'),
    [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Least-privilege s3:PutObject scoped to the export bucket object ARN (arn:…:export-bucket/*) — ' +
          'the object-key wildcard is confined to that one bucket (M1, Plan 06-06); the fn holds no ' +
          'DeleteObject/ListBucket/s3:* and no bare `*`.',
        appliesTo: [{ regex: '/^Resource::<ExportAnonExportBucket.*\\.Arn>\\/\\*$/g' }],
      },
    ],
  );

  // --- IAM5: export-anon scheduler target-role grantInvoke (Plan 06-06; U-07/U-33) -------------
  // The DEDICATED export scheduler target role (trust scheduler.amazonaws.com) is granted invoke on the
  // export fn ONLY — the standard grantInvoke shape: lambda:InvokeFunction on the fn ARN + its ":*"
  // version/alias qualifier, scoped to that single function (mirrors the Scheduler target-role suppression).
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    p('ExportAnon/ExportScheduleRole/DefaultPolicy/Resource'),
    [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'grantInvoke() standard shape: lambda:InvokeFunction on the export fn ARN plus its ":*" ' +
          'version/alias qualifier — the dedicated nightly-export scheduler target role (Plan 06-06, ' +
          'U-33), scoped to that single function, not a wildcard grant.',
        appliesTo: [{ regex: '/^Resource::<ExportAnonExportAnonFn.*\\.Arn>:\\*$/g' }],
      },
    ],
  );

  // --- IAM5: enroll-api → Enroll grantInvoke (Plan 06-02, DASH-05; stack-level post-wire U-4) --------
  // The lean non-VPC enroll-api fn is granted invoke on the in-VPC Enroll fn ONLY (enrollFn.grantInvoke) —
  // the standard grantInvoke shape: lambda:InvokeFunction on the Enroll fn ARN + its ":*" version/alias
  // qualifier, scoped to that single function (mirrors the Scheduler / export scheduler target-role
  // suppressions). NO DB-secret read, NO scheduler action on this fn — it only invokes the Enroll Lambda.
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    p('DataApi/EnrollApiFn/ServiceRole/DefaultPolicy/Resource'),
    [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'grantInvoke() standard shape: lambda:InvokeFunction on the Enroll fn ARN plus its ":*" ' +
          'version/alias qualifier — the DASH-05 enroll-api SYNC-invokes the in-VPC Enroll Lambda ' +
          '(Plan 06-02 post-wire, U-4), scoped to that single function, not a wildcard grant.',
        appliesTo: [{ regex: '/^Resource::<EnrollEnrollFn.*\\.Arn>:\\*$/g' }],
      },
    ],
  );

  // --- S1: export bucket server access logs (Plan 06-06, named accepted disposition) ----------
  // Same accepted disposition as the API access logs (APIG1): a second server-access-log bucket adds
  // storage/ingest cost with no new signal for a single-writer, nightly, KB-scale research export bucket
  // whose only writer is the code-reviewed export Lambda. The bucket is BLOCK_ALL + enforceSSL + SSE-S3.
  NagSuppressions.addResourceSuppressionsByPath(stack, p('ExportAnon/ExportBucket/Resource'), [
    {
      id: 'AwsSolutions-S1',
      reason:
        'Server access logging accepted-off for research-grade ops: the export bucket has a single ' +
        'code-reviewed writer (the export Lambda) and KB-scale nightly objects; a second access-log ' +
        'bucket adds cost without new signal. BLOCK_ALL + enforceSSL + SSE-S3 remain enforced. ' +
        '(AwsSolutions-S10 needs no suppression — enforceSSL discharges the SSL-only rule.)',
    },
  ]);

  // --- RDS: Single-AZ research database -------------------------------------------------------
  NagSuppressions.addResourceSuppressionsByPath(stack, p('Database/Instance/Resource'), [
    {
      id: 'AwsSolutions-RDS3',
      reason:
        'Single-AZ db.t4g.micro is the ratified DB decision (project decision record "Recommended Database": ' +
        '"No multi-AZ failover. Fine for an academic project"). Multi-AZ doubles instance cost ' +
        'for zero research value.',
    },
    {
      id: 'AwsSolutions-RDS10',
      reason:
        'deletionProtection is context-driven (F59): default false is REQUIRED for the ' +
        'INFRA-04 clean `cdk destroy` teardown; it flips true (with stack terminationProtection) ' +
        'via -c validationWindow=true for the P7 validation window (DATA-02).',
    },
    {
      id: 'AwsSolutions-RDS11',
      reason:
        'Default port 5432 accepted: the instance is private-subnet only with SG-scoped ingress ' +
        '(lambdaSg + bastionSg exclusively); port obfuscation adds no defense for a ' +
        'non-internet-routable research DB.',
    },
  ]);

  // --- SMG4: no automatic DB-secret rotation ---------------------------------------------------
  // COMPLIANCE DISPOSITION (2026-07-30): the persistent out-of-stack third-party secrets
  // medadhere/twilio and medadhere/anthropic are deliberately unrotated for the project duration.
  // This is accepted for the solo research project; teardown rotates/revokes both credentials at
  // project end. Imported secrets produce no stack-owned AwsSolutions-SMG4 finding to suppress.
  for (const secretPath of [
    'Database/Instance/Secret/Resource',
    'Database/AppCredentials/Resource',
    'Database/InboundCredentials/Resource',
    'Database/StatusCallbackCredentials/Resource',
    'Database/SourceImportCredentials/Resource',
  ]) {
    NagSuppressions.addResourceSuppressionsByPath(stack, p(secretPath), [
      {
        id: 'AwsSolutions-SMG4',
        reason:
          'DB-secret rotation adds a rotation Lambda + VPC cost. Manual rotation is the documented ' +
          'research-grade posture for the ~3-month deployment window (honours project, no real ' +
          'patients). In-place secret changes are not automatic: password alignment requires an ' +
          'explicitly triggered schema-init reapply followed by fresh runtime containers.',
      },
    ]);
  }

  // --- VPC7: no flow logs (named accepted disposition, 04-PLAN W0.3) ---------------------------
  NagSuppressions.addResourceSuppressionsByPath(stack, p('Network/Vpc/Resource'), [
    {
      id: 'AwsSolutions-VPC7',
      reason:
        'Flow Logs are a named accepted disposition (04-PLAN W0.3): CloudWatch ingest cost on ' +
        'a single-NAT, single-developer research VPC with code-reviewed SGs; the budget is ' +
        'NAT-dominated already (project decision record cost constraints).',
    },
  ]);

  // --- EC2 bastion (EC26 named accepted disposition, 04-PLAN W0.3) -----------------------------
  NagSuppressions.addResourceSuppressionsByPath(stack, p('Bastion/Bastion/Resource'), [
    {
      id: 'AwsSolutions-EC26',
      reason:
        'Unencrypted EBS on the bastion is a named accepted disposition (04-PLAN W0.3): the ' +
        'D-09 bastion is a disposable SSM tunnel endpoint, stopped after deploy; no PHI or ' +
        'application data is ever at rest on its volume (all data lives in encrypted RDS).',
    },
    {
      id: 'AwsSolutions-EC28',
      reason:
        'Detailed (1-min) monitoring costs extra and informs nothing: the bastion is stopped ' +
        'except during manual DB-tunnel sessions; basic monitoring suffices.',
    },
    {
      id: 'AwsSolutions-EC29',
      reason:
        'Termination protection intentionally OFF — INFRA-04 clean-teardown default for the ' +
        'whole stack; the bastion is disposable by design (D-09) and recreated by cdk deploy.',
    },
  ]);

  // --- COG8: Cognito feature plan ---------------------------------------------------------------
  NagSuppressions.addResourceSuppressionsByPath(stack, p('Auth/UserPool/Resource'), [
    {
      id: 'AwsSolutions-COG8',
      reason:
        'Cognito Essentials tier is a deliberate cost decision: the pool holds a handful of ' +
        'clinician-role research accounts (≤5 test users, no real patients); Plus-tier threat ' +
        'protection is priced and scoped for production consumer pools.',
    },
    {
      id: 'AwsSolutions-COG2',
      reason:
        'MFA remains OPTIONAL with software-token (TOTP) only and no SMS factor; COG2 requires ' +
        'MFA REQUIRED. The D4 no-secret medadhere-totp-cli client shipped with USER_PASSWORD_AUTH ' +
        'because SRP is not CLI-computable, accepted 2026-07-30 as a deliberate, ' +
        'permanently-provisioned credential-auth surface. Compensating posture: a 12-character ' +
        'password policy, preventUserExistenceErrors, a single admin account, TOTP enrolled at ' +
        'bootstrap before any patient enrollment, and no real patients.',
    },
  ]);

  // --- API Gateway ------------------------------------------------------------------------------
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    [
      p('DataApi/DataApi/DefaultStage/Resource'),
      p('Inbound/InboundApi/DefaultStage/Resource'), // Plan 04-02 (U-05 same-PR rule)
      p('StatusCallback/StatusCallbackApi/DefaultStage/Resource'),
    ],
    [
      {
        id: 'AwsSolutions-APIG1',
        reason:
          'API access logging accepted-off for research-grade ops: these HTTP APIs front single ' +
          'Lambdas whose CloudWatch logs already record every invocation (request id, caller ' +
          'context, outcome); a second access-log group adds ingest cost without new signal.',
      },
    ],
  );

  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    p('StatusCallback/StatusCallbackApi/POST--twilio--status/Resource'),
    [
      {
        id: 'AwsSolutions-APIG4',
        reason:
          'Twilio webhooks cannot present IAM/Cognito/JWT credentials — authenticity is ' +
          'enforced IN-HANDLER via X-Twilio-Signature HMAC validation ' +
          '(twilio.validateRequest, Phase-3 HIGH-1; 403 + no DB write on failure, T-03-03). ' +
          'This is the Twilio-documented webhook auth pattern.',
      },
    ],
  );

  // Plan 04-02 — the inbound webhook route (U-05 same-PR rule; U-06: the existing APIG4
  // suppression above is path-scoped to POST--twilio--status and does NOT cover this route).
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    p('Inbound/InboundApi/POST--twilio--inbound/Resource'),
    [
      {
        id: 'AwsSolutions-APIG4',
        reason:
          'Twilio inbound-message webhooks cannot present IAM/Cognito/JWT credentials — ' +
          'authenticity is enforced IN-HANDLER via X-Twilio-Signature HMAC validation over the ' +
          'env-pinned exact INBOUND_URL (twilio.validateRequest; 403 + zero side effects on ' +
          'failure — Plan 04-02 step 1, gate fix U-06/REV-M3). Same accepted disposition as ' +
          'the status-callback route.',
      },
    ],
  );

  // --- SQS3: the one terminal FIFO redrive DLQ (08-04a) ---------------------------------------
  NagSuppressions.addResourceSuppressionsByPath(stack, p('Inbound/TurnRedriveDlq/Resource'), [
    {
      id: 'AwsSolutions-SQS3',
      reason:
        'This queue is the terminal DLQ for the patient-keyed FIFO work queue. A DLQ-for-DLQ ' +
        'adds no recovery value; it is FIFO, SSE-encrypted, TLS-enforced, retained 14 days, ' +
        'and operator-reviewed through its dedicated CloudWatch depth alarm.',
    },
  ]);
}
