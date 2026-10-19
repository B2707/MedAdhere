// infra/lib/constructs/secrets.ts
//
// SecretsConstruct (D-06 / D-15 / F21 / A3) — the secret + SSM surface downstream Lambdas read.
//
//   - Twilio + Anthropic secrets: OUT-OF-STACK persistent secrets created once by the operator and
//     imported by name (A3). They survive `cdk destroy`; CDK owns neither resource nor value.
//   - The DB-password secret is the CDK-generated one from DatabaseConstruct — re-exposed here so a
//     single construct owns the secret surface for downstream grantRead (schema-init reads the DB
//     secret; twilio-smoke reads the Twilio secret).
//   - SSM deploy-time read (D-15) via `valueForStringParameter` (resolves to a synth-safe
//     `{{resolve:ssm}}` token — no live AWS at synth): `/medadhere/test-recipient` (twilio-smoke env).
//     The billing email is NO LONGER read here — WR-01 moved Budgets to the synth-time literal
//     `-c billingEmail=`, so the old `/medadhere/billing-email` SSM read was dead (zero consumers) and
//     emitted a misleading CFN SSM Parameter — it has been removed. We do
//     NOT read `/medadhere/twilio-from` here either — the twilio handler reads it at RUNTIME via
//     GetParameterCommand (F45); the stack passes only the parameter NAME.

import { Construct } from 'constructs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/** Persistent application-secret names. The operator creates these once outside CloudFormation. */
export const TWILIO_SECRET_NAME = 'medadhere/twilio';
export const ANTHROPIC_SECRET_NAME = 'medadhere/anthropic';

/** SSM parameter NAMES (D-15). The twilio-from name is passed to the handler, never read at deploy. */
export const SSM_TEST_RECIPIENT = '/medadhere/test-recipient';
export const SSM_TWILIO_FROM = '/medadhere/twilio-from'; // F45 — read at RUNTIME, not at deploy

export interface SecretsConstructProps {
  /** The CDK-generated DB-password secret from DatabaseConstruct (D-06). */
  readonly dbSecret: secretsmanager.ISecret;
  /** Generated non-DDL application DB credential from DatabaseConstruct. */
  readonly appDbSecret: secretsmanager.ISecret;
  /** Generated credential for the public inbound webhook role. */
  readonly inboundDbSecret: secretsmanager.ISecret;
  /** Generated credential for the public status-callback role. */
  readonly statusCallbackDbSecret: secretsmanager.ISecret;
  /** Generated credential reserved for the offline source-import operator path. */
  readonly sourceImportDbSecret: secretsmanager.ISecret;
}

export class SecretsConstruct extends Construct {
  /** The CDK-generated DB-password secret (re-exposed for grantRead). */
  public readonly dbSecret: secretsmanager.ISecret;
  /** Generated non-DDL application DB credential used by runtime Lambdas. */
  public readonly appDbSecret: secretsmanager.ISecret;
  /** Generated table-limited credential used only by the inbound Lambda. */
  public readonly inboundDbSecret: secretsmanager.ISecret;
  /** Generated table-limited credential used only by the status-callback Lambda. */
  public readonly statusCallbackDbSecret: secretsmanager.ISecret;
  /** Generated source-loader credential; it is deliberately not distributed to a runtime Lambda. */
  public readonly sourceImportDbSecret: secretsmanager.ISecret;
  /** The out-of-stack persistent Twilio credential secret imported by name (A3). */
  public readonly twilioSecret: secretsmanager.ISecret;
  /** The out-of-stack persistent Anthropic API-key secret imported by name (A3). */
  public readonly anthropicSecret: secretsmanager.ISecret;
  /** Deploy-time SSM token for the test recipient phone (twilio-smoke env). */
  public readonly testRecipient: string;

  constructor(scope: Construct, id: string, props: SecretsConstructProps) {
    super(scope, id);

    this.dbSecret = props.dbSecret;
    this.appDbSecret = props.appDbSecret;
    this.inboundDbSecret = props.inboundDbSecret;
    this.statusCallbackDbSecret = props.statusCallbackDbSecret;
    this.sourceImportDbSecret = props.sourceImportDbSecret;

    // A3 — references only. CloudFormation emits no AWS::SecretsManager::Secret resources for these
    // names, so their lifecycle is independent of this stack and they survive `cdk destroy`.
    this.twilioSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'TwilioSecret',
      TWILIO_SECRET_NAME,
    );
    this.anthropicSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'AnthropicSecret',
      ANTHROPIC_SECRET_NAME,
    );

    // SSM deploy-time read (D-15) — synth-safe `{{resolve:ssm}}` token (NOT a live lookup; F68). Only
    // the test-recipient remains; the billing-email read was removed (WR-01 moved it to a literal).
    this.testRecipient = ssm.StringParameter.valueForStringParameter(this, SSM_TEST_RECIPIENT);
  }
}
