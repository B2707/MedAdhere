// infra/test/foundation-stack.test.ts
//
// The INFRA-02/04/05 SHAPE gate (the CI gate before the live deploy in Plan 05). Uses
// aws-cdk-lib/assertions `Template.fromStack` to prove the synthesized CloudFormation template has
// the correct VPC/NAT/endpoint/RDS/secrets/budgets/IAM/Lambda shape WITHOUT any live AWS call.
//
// Hermetic synth: a test App supplies an explicit env region. The Budgets EMAIL subscriber is a
// synth-time LITERAL (WR-01), NOT a `{{resolve:ssm}}` token. The remaining
// `valueForStringParameter` token (test-recipient) resolves to a synth-safe `{{resolve:ssm}}` token
// and needs NO stub (F68).

import { describe, it, expect } from 'vitest';
import { App, Tags } from 'aws-cdk-lib';
import { Template, Match, Annotations } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation-stack.js';
import { applyNag } from '../lib/nag.js';

/**
 * Build a synthesized stack hermetically, replicating the bin/medadhere.ts composition root: the
 * `validationWindow` flag drives BOTH the stack-level `terminationProtection` StackProp AND the
 * forwarded `validationWindow` → DatabaseConstruct `deletionProtection` (F59), and the four standard
 * app-level tags are applied via `Tags.of(app)` (D-17). This is what the real `cdk synth` runs.
 */
function synth(
  opts: {
    validationWindow?: boolean;
    backupRetentionDays?: number;
    deployHosting?: boolean;
  } = {},
) {
  const validationWindow = opts.validationWindow ?? false;
  const backupRetentionDays = opts.backupRetentionDays ?? 7;
  const app = new App({
    context: {
      validationWindow,
      // MED-5 — only inject the deployHosting gate when explicitly turned OFF (the SC4 backend/SMS smoke
      // path); left absent it defaults true, so every other test keeps the full Amplify-inclusive stack.
      ...(opts.deployHosting === false ? { deployHosting: false } : {}),
    },
  });
  const stack = new FoundationStack(app, 'TestFoundation', {
    env: { account: '123456789012', region: 'us-east-1' },
    terminationProtection: validationWindow, // F59 — stack-level prop (bin/medadhere.ts)
    validationWindow, // forwarded to deletionProtection (F59)
    backupRetentionDays, // DATA-02 default 7; explicit 0 only for the free-plan exception
  });
  // D-17 — the standard app-level tag set (bin/medadhere.ts). Phase tag bumped to the current phase
  // (plan 02-04 updated bin/medadhere.ts from the Phase-1 tag to '02-auth-dashboard-shell').
  Tags.of(app).add('project', 'medadhere');
  Tags.of(app).add('phase', '02-auth-dashboard-shell');
  Tags.of(app).add('owner', 'bader');
  Tags.of(app).add('managed-by', 'cdk');
  return { stack, template: Template.fromStack(stack) };
}

describe('FoundationStack — deployed app composition', () => {
  it('synthesizes with cdk-nag without stale suppression resource paths', () => {
    const app = new App({ context: { validationWindow: false, deployHosting: false } });
    const stack = new FoundationStack(app, 'TestFoundationNag', {
      env: { region: 'us-east-1' },
      validationWindow: false,
      backupRetentionDays: 7,
    });
    applyNag(app, stack);

    expect(() => app.synth()).not.toThrow();
    const errors = Annotations.fromStack(stack)
      .findError('*', Match.anyValue())
      .map(({ id, entry }) => ({ id, message: entry.data }));
    expect(errors).toEqual([]);
  });
});

describe('FoundationStack — VPC / NAT / endpoints (INFRA-05 / D-01)', () => {
  it('has exactly ONE NAT Gateway (D-01 — single NAT)', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  it('has a VPC with private subnets across 2 AZs', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::EC2::VPC', 1);
    // 2 AZs × (public + private) = 4 subnets.
    template.resourceCountIs('AWS::EC2::Subnet', 4);
  });

  it('has the Secrets Manager INTERFACE endpoint + S3 GATEWAY endpoint, and NEITHER a Bedrock Runtime NOR a CloudWatch Logs endpoint (D-01 / Bedrock removed)', () => {
    const { template } = synth();
    // Exactly 2 endpoints: Secrets Manager (interface) + S3 (gateway). The Bedrock Runtime interface
    // endpoint is removed entirely (D-BEDROCK-REMOVED) — its ~$14.60/mo never appears in any synth.
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 2);
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Interface',
      ServiceName: 'com.amazonaws.us-east-1.secretsmanager',
    });
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
    });
    const endpoints = template.findResources('AWS::EC2::VPCEndpoint');
    const serviceNames = Object.values(endpoints).map((e) =>
      JSON.stringify((e.Properties as { ServiceName: unknown }).ServiceName),
    );
    // No Bedrock Runtime endpoint anywhere (Bedrock removed).
    expect(serviceNames.some((s) => s.includes('bedrock'))).toBe(false);
    // No CloudWatch Logs interface endpoint — that traffic routes via the NAT deliberately (D-01).
    expect(serviceNames.some((s) => s.includes('logs'))).toBe(false);
  });

  it('scopes the interface-endpoint SG: NO ingress opening 443 to the whole VPC CIDR (F24)', () => {
    const { template } = synth();
    const ingress = template.findResources('AWS::EC2::SecurityGroupIngress');
    // No standalone 443 ingress rule whose source is a CIDR (open:false means SG-to-SG only).
    for (const rule of Object.values(ingress)) {
      const p = rule.Properties as {
        FromPort?: number;
        CidrIp?: string;
      };
      if (p.FromPort === 443) {
        expect(p.CidrIp).toBeUndefined();
      }
    }
  });
});

describe('FoundationStack — RDS (INFRA-02/04 / DATA-02 / D-14 / F26)', () => {
  it('provisions postgres 16.4 t4g.micro Single-AZ with the clean-destroy + DBName shape', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      EngineVersion: Match.stringLikeRegexp('^16\\.4'),
      DBInstanceClass: 'db.t4g.micro',
      MultiAZ: false,
      StorageEncrypted: true,
      StorageType: 'gp3',
      BackupRetentionPeriod: 7, // DATA-02 default (account is on the Paid Plan)
      DeletionProtection: false,
      DBName: 'medadhere', // F26
    });
  });

  it('DATA-02: defaults backups to 7 (Paid Plan); 0 only as the explicit free-plan exception', () => {
    // Default (no override): DATA-02 ">=7-day from first deploy".
    synth().template.hasResourceProperties('AWS::RDS::DBInstance', {
      BackupRetentionPeriod: 7,
    });
    // 0 is the exceptional override for a free-plan-restricted account (validationWindow=false here).
    synth({ backupRetentionDays: 0 }).template.hasResourceProperties('AWS::RDS::DBInstance', {
      BackupRetentionPeriod: 0,
    });
  });

  it('DATA-02 <-> F59 coupling: the validation-window posture ships protections AND >=7-day backups together', () => {
    const { template } = synth({
      validationWindow: true,
      backupRetentionDays: 7,
    });
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      DeletionProtection: true,
      BackupRetentionPeriod: 7,
    });
  });

  it('DATA-02 guard: a validation-window deploy with backups <7 FAILS synth (no silent backup-disabled cohort)', () => {
    // Build directly (not via synth(), which renders the template) to read the error annotation.
    const app = new App({
      context: { validationWindow: true },
    });
    const stack = new FoundationStack(app, 'TestFoundation', {
      env: { account: '123456789012', region: 'us-east-1' },
      terminationProtection: true,
      validationWindow: true,
      backupRetentionDays: 0, // the dangerous combo the guard must catch
    });
    Annotations.fromStack(stack).hasError(
      '*',
      Match.stringLikeRegexp('DATA-02:.*backupRetentionDays'),
    );
  });

  it('sets removalPolicy DESTROY (DeletionPolicy: Delete) on the RDS instance (INFRA-04)', () => {
    const { template } = synth();
    template.hasResource('AWS::RDS::DBInstance', {
      DeletionPolicy: 'Delete',
    });
  });

  it('declares an rds.force_ssl=1 parameter group (D-14)', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::RDS::DBParameterGroup', {
      Parameters: Match.objectLike({ 'rds.force_ssl': '1' }),
    });
  });

  it('disables auto minor-version upgrades + pins a low-traffic maintenance window (INFRA-DEPLOY-02 / project decision record manual upgrades)', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      AutoMinorVersionUpgrade: false,
      PreferredMaintenanceWindow: 'Sun:08:00-Sun:08:30',
    });
  });
});

describe('FoundationStack — secrets + grants (D-06 / F21 / T-04-01 / A3)', () => {
  it('owns generated admin plus four least-privilege DB-role secrets; Twilio and Anthropic remain references', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::SecretsManager::Secret', 5);
    const secretResources = template.findResources('AWS::SecretsManager::Secret');
    const secretJson = JSON.stringify(secretResources);
    for (const username of [
      'medadhere_admin',
      'medadhere_app',
      'medadhere_inbound',
      'medadhere_status_callback',
      'medadhere_source_import',
    ]) {
      expect(secretJson).toContain(username);
    }
    for (const secret of Object.values(secretResources)) {
      const name = (secret.Properties as { Name?: string }).Name;
      expect(name).not.toBe('medadhere/twilio');
      expect(name).not.toBe('medadhere/anthropic');
    }
    const json = JSON.stringify(template.toJSON());
    // The imported names may appear in env/IAM references, but no secret values may appear.
    expect(json).not.toMatch(/"accountSid"\s*:\s*"[^"]+"/);
    expect(json).not.toMatch(/"authToken"\s*:\s*"[^"]+"/);
  });

  it('gives schema-init all DB secrets and isolates each public Lambda from app/source credentials', () => {
    const { template } = synth();
    const secrets = template.findResources('AWS::SecretsManager::Secret');
    const secretId = (username: string) =>
      Object.entries(secrets).find(([, secret]) => JSON.stringify(secret).includes(username))?.[0];
    const appSecretId = secretId('medadhere_app');
    const inboundSecretId = secretId('medadhere_inbound');
    const statusSecretId = secretId('medadhere_status_callback');
    const sourceSecretId = secretId('medadhere_source_import');
    expect([appSecretId, inboundSecretId, statusSecretId, sourceSecretId]).not.toContain(undefined);

    const functions = Object.values(template.findResources('AWS::Lambda::Function'));
    const envs = functions.map(
      (fn) =>
        (fn.Properties as { Environment?: { Variables?: Record<string, unknown> } }).Environment
          ?.Variables ?? {},
    );
    const schemaEnv = envs.find((env) => 'DB_ADMIN_SECRET_ARN' in env);
    expect(schemaEnv).toBeDefined();
    const adminSecretRef = JSON.stringify(schemaEnv?.DB_ADMIN_SECRET_ARN);
    const appSecretRef = JSON.stringify(schemaEnv?.DB_APP_SECRET_ARN);
    const inboundSecretRef = JSON.stringify(schemaEnv?.DB_INBOUND_SECRET_ARN);
    const statusSecretRef = JSON.stringify(schemaEnv?.DB_STATUS_CALLBACK_SECRET_ARN);
    const sourceSecretRef = JSON.stringify(schemaEnv?.DB_SOURCE_IMPORT_SECRET_ARN);
    expect(adminSecretRef).toContain('DatabaseInstanceSecretAttachment');
    expect(appSecretRef).toContain(appSecretId!);
    expect(inboundSecretRef).toContain(inboundSecretId!);
    expect(statusSecretRef).toContain(statusSecretId!);
    expect(sourceSecretRef).toContain(sourceSecretId!);
    expect('DB_SECRET_ARN' in schemaEnv!).toBe(false);

    const runtimeDbEnvs = envs.filter((env) => 'DB_SECRET_ARN' in env);
    expect(runtimeDbEnvs).toHaveLength(12);
    for (const env of runtimeDbEnvs) {
      const expectedSecretRef =
        'INBOUND_URL' in env
          ? inboundSecretRef
          : 'STATUS_CALLBACK_URL' in env &&
              'OUTBOUND_FN_ARN' in env &&
              !('TWILIO_FROM_PARAM' in env)
            ? statusSecretRef
            : appSecretRef;
      expect(JSON.stringify(env.DB_SECRET_ARN)).toBe(expectedSecretRef);
      expect(JSON.stringify(env.DB_SECRET_ARN)).not.toBe(adminSecretRef);
      expect(JSON.stringify(env.DB_SECRET_ARN)).not.toBe(sourceSecretRef);
      expect('DB_ADMIN_SECRET_ARN' in env).toBe(false);
      expect('DB_APP_SECRET_ARN' in env).toBe(false);
      expect('DB_SOURCE_IMPORT_SECRET_ARN' in env).toBe(false);
    }

    const secretReadStatements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (policy) =>
        (
          policy.Properties as {
            PolicyDocument: { Statement: Array<{ Action: unknown; Resource?: unknown }> };
          }
        ).PolicyDocument.Statement.filter((statement) =>
          JSON.stringify(statement.Action).includes('secretsmanager:GetSecretValue'),
        ),
    );
    expect(
      secretReadStatements.filter((statement) =>
        JSON.stringify(statement.Resource).includes('DatabaseInstanceSecretAttachment'),
      ),
    ).toHaveLength(1);
    expect(
      secretReadStatements.filter((statement) =>
        JSON.stringify(statement.Resource).includes(appSecretId!),
      ),
    ).toHaveLength(11); // schema-init + ten non-public runtime DB Lambdas
    expect(
      secretReadStatements.filter((statement) =>
        JSON.stringify(statement.Resource).includes(inboundSecretId!),
      ),
    ).toHaveLength(2); // schema-init + inbound
    expect(
      secretReadStatements.filter((statement) =>
        JSON.stringify(statement.Resource).includes(statusSecretId!),
      ),
    ).toHaveLength(2); // schema-init + status callback
    expect(
      secretReadStatements.filter((statement) =>
        JSON.stringify(statement.Resource).includes(sourceSecretId!),
      ),
    ).toHaveLength(1); // schema-init only; the loader is an operator CLI, never a Lambda

    const outputs = template.toJSON().Outputs as Record<string, { Value?: unknown }>;
    expect(JSON.stringify(outputs.SourceImportDbSecretArn?.Value)).toContain(sourceSecretId!);
  });

  it('tracks every role secret in the custom resource and orders all DB Lambdas after schema-init', () => {
    const { template } = synth();
    const resources = template.toJSON().Resources as Record<
      string,
      { Type: string; Properties?: Record<string, unknown>; DependsOn?: string | string[] }
    >;
    const schemaEntry = Object.entries(resources).find(
      ([, resource]) => 'SqlHash' in (resource.Properties ?? {}),
    );
    expect(schemaEntry).toBeDefined();
    const [schemaLogicalId, schemaResource] = schemaEntry!;
    for (const property of [
      'AppSecretArn',
      'InboundSecretArn',
      'StatusCallbackSecretArn',
      'SourceImportSecretArn',
    ]) {
      expect(schemaResource.Properties?.[property]).toBeDefined();
    }

    const dbFunctions = Object.entries(resources).filter(
      ([, resource]) =>
        resource.Type === 'AWS::Lambda::Function' &&
        'DB_SECRET_ARN' in
          (((
            resource.Properties?.Environment as { Variables?: Record<string, unknown> } | undefined
          )?.Variables ?? {}) as Record<string, unknown>),
    );
    expect(dbFunctions).toHaveLength(12);
    for (const [, fn] of dbFunctions) {
      const dependencies = Array.isArray(fn.DependsOn)
        ? fn.DependsOn
        : fn.DependsOn
          ? [fn.DependsOn]
          : [];
      expect(dependencies).toContain(schemaLogicalId);
    }
  });

  it('WR-02: the synth emits NO /medadhere/billing-email SSM Parameter (the dead valueForStringParameter read was removed)', () => {
    const { template } = synth();
    // The billing email is a synth-time literal now (WR-01); the old dead SSM read emitted a
    // misleading `{{resolve:ssm:/medadhere/billing-email}}` dynamic reference. Assert it is gone.
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toContain('/medadhere/billing-email');
    // The still-live test-recipient SSM read must remain (it is a real consumer, not dead).
    expect(json).toContain('/medadhere/test-recipient');
  });

  it('grants scoped secret reads including Twilio smoke and the isolated Anthropic gateway', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const getSecretStatements = Object.values(policies).flatMap((p) => {
      const doc = (
        p.Properties as {
          PolicyDocument: { Statement: Array<{ Action: unknown }> };
        }
      ).PolicyDocument;
      return doc.Statement.filter((s) => {
        const a = s.Action;
        const actions = Array.isArray(a) ? a : [a];
        return actions.some(
          (x) => typeof x === 'string' && x.includes('secretsmanager:GetSecretValue'),
        );
      });
    });
    // At least three distinct GetSecretValue grants (schema-init DB + Twilio smoke + gateway).
    expect(getSecretStatements.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps Twilio/Anthropic read grants scoped to imported partial ARNs', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const policiesJson = JSON.stringify(policies);
    // fromSecretNameV2 grantRead expands the name to the Secrets Manager physical-name suffix
    // wildcard. This is intentionally different from the unsuffixed ARN passed to Lambda env.
    expect(policiesJson).toContain(':secret:medadhere/twilio-??????');
    expect(policiesJson).toContain(':secret:medadhere/anthropic-??????');

    const statements = Object.values(policies).flatMap(
      (policy) =>
        (
          policy.Properties as {
            PolicyDocument: { Statement: Array<Record<string, unknown>> };
          }
        ).PolicyDocument.Statement,
    );
    const grantCount = (secretName: string) =>
      statements.filter((statement) => {
        const statementJson = JSON.stringify(statement);
        return (
          statementJson.includes('secretsmanager:GetSecretValue') &&
          statementJson.includes(`:secret:${secretName}-??????`)
        );
      }).length;
    expect(grantCount('medadhere/twilio')).toBe(4);
    expect(grantCount('medadhere/anthropic')).toBe(1);

    const anthropicPolicy = Object.values(policies).find((p) =>
      JSON.stringify((p.Properties as { PolicyDocument: unknown }).PolicyDocument).includes(
        ':secret:medadhere/anthropic-??????',
      ),
    );
    expect(anthropicPolicy).toBeDefined();
    const policyJson = JSON.stringify(anthropicPolicy);
    // It grants GetSecretValue...
    expect(policyJson).toContain('secretsmanager:GetSecretValue');
    // ...and carries NO Bedrock action of any kind (grantRead-ONLY by D-ANTHROPIC).
    expect(policyJson).not.toContain('bedrock:');
  });

  it('passes the imported Twilio/Anthropic secret ARNs to every consuming Lambda env', () => {
    const { template } = synth();
    const functions = template.findResources('AWS::Lambda::Function');
    const envs = Object.values(functions).map(
      (fn) =>
        (
          fn.Properties as {
            Environment?: { Variables?: Record<string, unknown> };
          }
        ).Environment?.Variables ?? {},
    );

    const twilioArns = envs
      .filter((env) => 'TWILIO_SECRET_ARN' in env)
      .map((env) => env.TWILIO_SECRET_ARN);
    const anthropicArns = envs
      .filter((env) => 'ANTHROPIC_SECRET_ARN' in env)
      .map((env) => env.ANTHROPIC_SECRET_ARN);

    expect(twilioArns).toHaveLength(4);
    expect(anthropicArns).toHaveLength(1);
    for (const arn of twilioArns) {
      expect(JSON.stringify(arn)).toContain(':secret:medadhere/twilio');
      expect(JSON.stringify(arn)).not.toContain('-??????');
    }
    for (const arn of anthropicArns) {
      expect(JSON.stringify(arn)).toContain(':secret:medadhere/anthropic');
      expect(JSON.stringify(arn)).not.toContain('-??????');
    }
  });
});

describe('FoundationStack — Lambdas: runtime/arch/subnets/IAM (F07 / F15 / F45 / F49)', () => {
  it('runs all fourteen database and Twilio Lambdas on nodejs24.x / arm64 in private subnets', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    // Our in-VPC functions = those with a VpcConfig (the Provider framework Lambda has none). There are
    // exactly ELEVEN: schema-init + twilio-smoke + data-api (Phase 1/2) PLUS the three
    // Phase-3 in-VPC fns added by the plan-03 integration wave — outbound + status-callback + enroll
    // (Bedrock removed entirely) — PLUS the Phase-4 inbound webhook + classifier fns (plans
    // 04-02/04-03) — PLUS the Phase-5 Timeout Lambda (plan 05-01, PIPE-05) — PLUS the Phase-5 dedicated
    // admin-deactivation write fn (plan 05-03, Q4/STUDY-05) — PLUS the Phase-6 in-VPC anonymized-export
    // fn (plan 06-06, DASH-06). The Amplify SSR tier is NOT in the VPC, and the S3-autoDelete provider
    // Lambda is NON-VPC (no VpcConfig — it reaches the public API GW / S3 over the internet), so neither
    // counts here.
    const ourFns = Object.values(fns).filter(
      (f) => (f.Properties as { VpcConfig?: unknown }).VpcConfig !== undefined,
    );
    // Phase 8 clinical-history routes reuse data-api, so no duplicate Lambda is added.
    expect(ourFns.length).toBe(14);
    for (const f of ourFns) {
      const p = f.Properties as {
        Runtime: string;
        Architectures: string[];
        VpcConfig: { SubnetIds: unknown };
      };
      expect(p.Runtime).toBe('nodejs24.x'); // F07
      expect(p.Architectures).toEqual(['arm64']); // F07
      expect(p.VpcConfig.SubnetIds).toBeDefined(); // F49 — in the VPC private subnets
    }
  });

  it('Bedrock removed: NO bedrock: action and NO servicequotas:* wildcard anywhere in the stack (D-BEDROCK-REMOVED)', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const allPoliciesJson = JSON.stringify(Object.values(policies));
    // The whole Bedrock IAM surface is gone — no model grant of any kind...
    expect(allPoliciesJson).not.toContain('bedrock:');
    // ...and crucially NO servicequotas wildcard (the only `*` resource the stack ever had, WR-05).
    expect(allPoliciesJson).not.toContain('servicequotas:');
  });

  it('grants ssm:GetParameter scoped to /medadhere/twilio-from to the twilio-smoke role (F45)', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const json = JSON.stringify(Object.values(policies));
    expect(json).toContain('ssm:GetParameter');
    expect(json).toContain('parameter/medadhere/twilio-from');
  });

  it('sets TWILIO_FROM_PARAM to the SSM parameter NAME (not a value) and never sets TWILIO_FROM or PGSSLMODE (F45/F28)', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    const envs = Object.values(fns).map(
      (f) =>
        (f.Properties as { Environment?: { Variables?: Record<string, unknown> } }).Environment
          ?.Variables ?? {},
    );
    const twilioEnv = envs.find((e) => 'TWILIO_FROM_PARAM' in e);
    expect(twilioEnv).toBeDefined();
    expect(twilioEnv!.TWILIO_FROM_PARAM).toBe('/medadhere/twilio-from'); // F45 — the NAME
    // No deploy-time TWILIO_FROM value, no PGSSLMODE anywhere (F28).
    for (const e of envs) {
      expect('TWILIO_FROM' in e).toBe(false);
      expect('PGSSLMODE' in e).toBe(false);
    }
    // Only the isolated non-VPC gateway carries the Anthropic secret ARN, never the key.
    const anthropicEnv = envs.find((e) => 'ANTHROPIC_SECRET_ARN' in e);
    expect(anthropicEnv).toBeDefined();
    expect('ANTHROPIC_API_KEY' in anthropicEnv!).toBe(false); // the key is NEVER an env var
    for (const k of Object.keys(anthropicEnv!)) {
      expect(k.startsWith('BEDROCK_')).toBe(false);
    }
  });

  it('wires the FIFO processor to only the isolated gateway and existing outbound Lambda', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    const processor = Object.values(fns).find((fn) => {
      const variables = (fn.Properties as { Environment?: { Variables?: Record<string, unknown> } })
        .Environment?.Variables;
      return variables?.LLM_GATEWAY_FN_ARN !== undefined && variables.DB_NAME === 'medadhere';
    });
    expect(processor).toBeDefined();
    const env = (processor!.Properties as { Environment: { Variables: Record<string, unknown> } })
      .Environment.Variables;
    expect(JSON.stringify(env.LLM_GATEWAY_FN_ARN)).toContain('LlmGatewayGatewayFn');
    expect(JSON.stringify(env.OUTBOUND_FN_ARN)).toContain('OutboundOutboundFn');

    const policies = template.findResources('AWS::IAM::Policy');
    const processorPolicy = Object.values(policies).find((policy) => {
      const json = JSON.stringify(policy);
      return json.includes('LlmGatewayGatewayFn') && json.includes('sqs:ReceiveMessage');
    });
    expect(processorPolicy).toBeDefined();
    const policyJson = JSON.stringify(processorPolicy);
    expect(policyJson).toContain('lambda:InvokeFunction');
    expect(policyJson).toContain('OutboundOutboundFn');
  });
});

describe('FoundationStack — schema-init custom resource (D-03 / F03)', () => {
  it('reruns schema-init when either the SQL or role-management handler changes', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
    template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      SqlHash: Match.stringLikeRegexp('^[a-f0-9]{32}$'), // MD5 hex
      HandlerHash: Match.stringLikeRegexp('^[a-f0-9]{32}$'),
    });
  });

  it('places the schema-init Lambda in the VPC (private subnets)', () => {
    const { template } = synth();
    // The DB_NAME=medadhere env marks the schema-init function; assert it has a VpcConfig.
    const fns = template.findResources('AWS::Lambda::Function');
    const schemaInit = Object.values(fns).find(
      (f) =>
        (f.Properties as { Environment?: { Variables?: Record<string, unknown> } }).Environment
          ?.Variables?.DB_NAME === 'medadhere',
    );
    expect(schemaInit).toBeDefined();
    expect((schemaInit!.Properties as { VpcConfig?: unknown }).VpcConfig).toBeDefined();
  });

  it('gives the schema-init Lambda an explicit DESTROY/ONE_WEEK log group (F61)', () => {
    const { template } = synth();
    // Exactly 17 log groups — schema-init fn + provider framework fn + twilio-smoke + LLM gateway +
    // data-api (Phase 1/2) PLUS the three Phase-3 DESTROY/ONE_WEEK log groups added by the plan-03 wave
    // (outbound + status-callback + enroll) PLUS the Phase-4 inbound + classifier log groups (plans
    // 04-02/04-03) PLUS the Phase-5 Timeout log group (plan 05-01) PLUS the Phase-5 admin-deactivation
    // fn log group (plan 05-03, Q4) PLUS the Phase-6 export-anon fn log group (plan 06-06) PLUS the
    // Phase-6 lean non-VPC enroll-api fn log group (plan 06-02, DASH-05 — its OWN explicit group; the fn is
    // non-VPC so it does NOT bump the in-VPC fn count above, only the LogGroup total: 13 → 14). The
    // S3-autoDelete provider fn has NO explicit AWS::Logs::LogGroup resource, so it does not add one.
    // There is no Bedrock log group (Bedrock removed entirely, D-BEDROCK-REMOVED).
    template.resourceCountIs('AWS::Logs::LogGroup', 17);
    template.hasResource('AWS::Logs::LogGroup', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({ RetentionInDays: 7 }),
    });
  });
});

describe('FoundationStack — Budgets (D-11 / F56)', () => {
  it('has a monthly COST budget of $100 with the SIX ACTUAL+FORECASTED 25/50/100 EMAIL notifications', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
        BudgetLimit: { Amount: 100, Unit: 'USD' },
      }),
    });
    const budgets = template.findResources('AWS::Budgets::Budget');
    const budget = Object.values(budgets)[0]!;
    const notifs = (
      budget.Properties as {
        NotificationsWithSubscribers: Array<{
          Notification: { NotificationType: string; Threshold: number };
          Subscribers: Array<{ SubscriptionType: string }>;
        }>;
      }
    ).NotificationsWithSubscribers;
    expect(notifs).toHaveLength(6);
    const pairs = notifs.map(
      (n) => `${n.Notification.NotificationType}:${n.Notification.Threshold}`,
    );
    for (const t of ['ACTUAL', 'FORECASTED']) {
      for (const v of [25, 50, 100]) {
        expect(pairs).toContain(`${t}:${v}`);
      }
    }
    // Every notification carries an EMAIL subscriber.
    for (const n of notifs) {
      expect(n.Subscribers.some((s) => s.SubscriptionType === 'EMAIL')).toBe(true);
    }
  });

  it('sources the EMAIL subscriber address as a synth-time LITERAL — never a {{resolve:ssm}} token (WR-01)', () => {
    const { template } = synth();
    const budgets = template.findResources('AWS::Budgets::Budget');
    const budget = Object.values(budgets)[0]!;
    const notifs = (
      budget.Properties as {
        NotificationsWithSubscribers: Array<{
          Subscribers: Array<{ SubscriptionType: string; Address: unknown }>;
        }>;
      }
    ).NotificationsWithSubscribers;
    // The D-11 runaway-cost backstop only notifies if the EMAIL address is a real literal. An AWS
    // Budgets EMAIL subscriber does NOT resolve a `{{resolve:ssm}}` dynamic reference, so a token
    // there means the alert silently never fires (WR-01). Assert every address is a literal email.
    for (const n of notifs) {
      for (const s of n.Subscribers) {
        expect(typeof s.Address).toBe('string');
        expect(s.Address as string).not.toContain('{{resolve:ssm'); // WR-01 — not a dynamic SSM token
        expect(s.Address as string).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/); // looks like an email
      }
    }
  });

  it('WR-01 guard: a validation-window deploy that ships the .invalid billingEmail placeholder FAILS synth', () => {
    // Build directly (not via synth(), which never sets billingEmail) so resolveBillingEmail() falls
    // back to the `.invalid` placeholder — the exact combo (isBillingEmailPlaceholder && validationWindow)
    // the guard must catch. backupRetentionDays:7 keeps the DATA-02 guard quiet too.
    const app = new App({
      context: { validationWindow: true }, // NO billingEmail -> placeholder
    });
    const stack = new FoundationStack(app, 'TestFoundation', {
      env: { account: '123456789012', region: 'us-east-1' },
      terminationProtection: true,
      validationWindow: true,
      backupRetentionDays: 7,
    });
    Annotations.fromStack(stack).hasError('*', Match.stringLikeRegexp('billingEmail placeholder'));
  });

  it('WR-01: a validation-window deploy WITH a real billingEmail does NOT error (the guard only fires on the placeholder)', () => {
    const app = new App({
      context: {
        billingEmail: 'real-billing@medadhere.example',
        validationWindow: true,
      },
    });
    const stack = new FoundationStack(app, 'TestFoundation', {
      env: { account: '123456789012', region: 'us-east-1' },
      terminationProtection: true,
      validationWindow: true,
      backupRetentionDays: 7,
    });
    Annotations.fromStack(stack).hasNoError(
      '*',
      Match.stringLikeRegexp('billingEmail placeholder'),
    );
  });
});

describe('FoundationStack — email delivery removed', () => {
  it('creates no SES sender identity', () => {
    synth().template.resourceCountIs('AWS::SES::EmailIdentity', 0);
  });
});

describe('FoundationStack — bastion (D-09)', () => {
  it('declares a t4g.micro SSM bastion (free-tier-eligible) with NO inbound ports', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't4g.micro', // nano is NOT free-tier-eligible on the free plan (Phase-1 finding)
    });
    // The bastion SG has no ingress rules (SSM is outbound-only).
    const sgs = template.findResources('AWS::EC2::SecurityGroup');
    const bastionSg = Object.values(sgs).find((sg) =>
      JSON.stringify(
        (sg.Properties as { GroupDescription?: string }).GroupDescription ?? '',
      ).includes('bastion'),
    );
    expect(bastionSg).toBeDefined();
    const ingress = (
      bastionSg!.Properties as {
        SecurityGroupIngress?: unknown[];
      }
    ).SecurityGroupIngress;
    expect(ingress === undefined || ingress.length === 0).toBe(true);
  });
});

describe('FoundationStack — P7 validationWindow toggle (F59)', () => {
  it('with validationWindow:true sets stack-level termination protection AND RDS DeletionProtection:true', () => {
    const { stack, template } = synth({ validationWindow: true });
    expect(stack.terminationProtection).toBe(true);
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      DeletionProtection: true,
    });
  });

  it('with validationWindow absent/false both are false (INFRA-04 clean teardown default)', () => {
    const { stack, template } = synth({ validationWindow: false });
    expect(stack.terminationProtection).toBe(false);
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      DeletionProtection: false,
    });
  });
});

describe('FoundationStack — standard tags (D-17)', () => {
  it('tags resources with the standard project/phase/owner/managed-by set', () => {
    const { template } = synth();
    // The RDS instance carries the app-level tags (sample assertion). Assert each tag with a
    // single-element arrayWith so the match is order-independent (CDK sorts tags alphabetically,
    // so a multi-element arrayWith — which matches a contiguous ordered subsequence — would fail).
    for (const tag of [
      { Key: 'project', Value: 'medadhere' },
      { Key: 'phase', Value: '02-auth-dashboard-shell' },
      { Key: 'owner', Value: 'bader' },
      { Key: 'managed-by', Value: 'cdk' },
    ]) {
      template.hasResourceProperties('AWS::RDS::DBInstance', {
        Tags: Match.arrayWith([tag]),
      });
    }
  });
});

describe('FoundationStack — Phase-2 integration: auth + data-api + hosting wired by in-process ref (D-12 / SC3/SC4)', () => {
  it('wires exactly ONE Cognito UserPool + TWO public app clients (no GenerateSecret) into the single stack (D-05/D4/D-13)', () => {
    const { template } = synth();
    // Plan 02-04 wires AuthConstruct into the SINGLE FoundationStack (D-12 — in-process ref, no
    // second stack). Exactly one pool + the primary PKCE client + D4 auxiliary TOTP CLI client.
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 2);
    // D-05 — the app client is PUBLIC: no GenerateSecret:true anywhere (a confidential client would
    // force stashing a secret in the Amplify SSR env, which T-02-20 forbids).
    const clients = template.findResources('AWS::Cognito::UserPoolClient');
    for (const c of Object.values(clients)) {
      const gen = (c.Properties as { GenerateSecret?: unknown }).GenerateSecret;
      // CDK omits the prop (undefined) or emits false for a public client; never true.
      expect(gen === undefined || gen === false).toBe(true);
    }
    // Negative guard: the synthesized template contains NO UserPoolClient with GenerateSecret:true and
    // no plaintext Cognito client secret leaked anywhere.
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toMatch(/"GenerateSecret"\s*:\s*true/);
    expect(json.toLowerCase()).not.toContain('clientsecret');
  });

  it('surfaces the D4 auxiliary client id as a stack output for the runbook', () => {
    const { template } = synth();
    template.hasOutput('D4ClientId', {
      Value: {
        Ref: Match.stringLikeRegexp('AuthTotpClient'),
      },
    });
  });

  it('fronts the data API with an HTTP API v2 + a native JWT authorizer (D-09 — the SC4 enforcement boundary)', () => {
    const { template } = synth();
    // THREE HTTP APIs — the JWT-authorized data API (Phase 2) + the authorizer-less status-callback
    // API (Phase 3) + the authorizer-less inbound webhook API (Phase 4, plan 04-02 — U-06/REV-M3).
    // Exactly one carries a JWT authorizer; BOTH public Twilio webhooks carry none.
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 3);
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'HTTP',
    });
    // A native Cognito JWT authorizer (issuer = pool URL, jwtAudience = [clientId]) validates the
    // id_token BEFORE the Lambda (D-09). The Issuer is a CDK Fn::Join token, so assert the authorizer
    // type + that the serialized authorizer carries the cognito-idp issuer host. The status-callback and
    // inbound APIs add NO authorizer, so the authorizer count STAYS exactly 1 (a count bump cannot mask one).
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
    });
    const authorizers = template.findResources('AWS::ApiGatewayV2::Authorizer');
    expect(Object.keys(authorizers)).toHaveLength(1);
    expect(JSON.stringify(Object.values(authorizers)[0])).toContain('cognito-idp');
  });

  it('the status-callback API POST /twilio/status route carries NO JWT authorizer (the public Twilio webhook is authorizer-less — MED-3)', () => {
    const { template } = synth();
    // Positive guard so the AWS::ApiGatewayV2::Api count bump (1→2) can never mask an accidental
    // authorizer on the PUBLIC callback route. Find the route by its RouteKey and assert it is NOT
    // JWT-authorized — AuthorizationType is absent/NONE and it carries no AuthorizerId. (The data-api
    // route IS JWT-authorized — asserted in data-api.test.ts — so this isolates the callback route.)
    const routes = template.findResources('AWS::ApiGatewayV2::Route');
    const callbackRoute = Object.values(routes).find(
      (r) => (r.Properties as { RouteKey?: string }).RouteKey === 'POST /twilio/status',
    );
    expect(callbackRoute).toBeDefined();
    const props = callbackRoute!.Properties as {
      AuthorizationType?: string;
      AuthorizerId?: unknown;
    };
    // No JWT authorization on the public webhook (auth is the in-handler HMAC validateRequest).
    expect(props.AuthorizationType === undefined || props.AuthorizationType === 'NONE').toBe(true);
    expect(props.AuthorizerId).toBeUndefined();
  });

  it('declares the single medadhere-prod EventBridge Scheduler group (PIPE-01 — the plan-03 wave wired the scheduler construct)', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::Scheduler::ScheduleGroup', 1);
    template.hasResourceProperties('AWS::Scheduler::ScheduleGroup', {
      Name: 'medadhere-prod',
    });
  });

  it('the data-api Lambda is in-VPC and carries NO PGSSLMODE env (F28 — single-sourced TLS via the pg ssl object)', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    // The data-api fn is identified by its env (DB_SECRET_ARN + DB_HOST + a VpcConfig). The existing
    // PGSSLMODE-absence loop (above) already iterates ALL fns incl. this 4th one; this re-asserts it
    // explicitly for the data-api fn so a regression that adds PGSSLMODE fails an integration test too.
    const dataApiFns = Object.values(fns).filter((f) => {
      const p = f.Properties as {
        VpcConfig?: unknown;
        Environment?: { Variables?: Record<string, unknown> };
      };
      const env = p.Environment?.Variables ?? {};
      return p.VpcConfig !== undefined && 'DB_SECRET_ARN' in env && 'DB_HOST' in env;
    });
    // schema-init AND data-api both carry DB_SECRET_ARN+DB_HOST+VpcConfig (2 fns); neither has PGSSLMODE.
    expect(dataApiFns.length).toBeGreaterThanOrEqual(1);
    for (const f of dataApiFns) {
      const env =
        (f.Properties as { Environment?: { Variables?: Record<string, unknown> } }).Environment
          ?.Variables ?? {};
      expect('PGSSLMODE' in env).toBe(false);
    }
  });

  it('provisions the Amplify WEB_COMPUTE App + Branch (SC3 — Amplify deploy infra is real in the single stack)', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::Amplify::App', 1);
    template.resourceCountIs('AWS::Amplify::Branch', 1);
    template.hasResourceProperties('AWS::Amplify::App', {
      Platform: 'WEB_COMPUTE', // D-03 — SSR, not static WEB
    });
  });

  it('MED-5: `-c deployHosting=false` skips the Amplify App/Branch but keeps the rest of the stack intact (SC4 smoke path)', () => {
    const { template } = synth({ deployHosting: false });
    // The Amplify dashboard tier is gated out entirely (dashboard host of record is Vercel, D-02) so a
    // backend/SMS smoke deploy no longer needs the human-created GitHub-token secret.
    template.resourceCountIs('AWS::Amplify::App', 0);
    template.resourceCountIs('AWS::Amplify::Branch', 0);
    // ...while the rest of the single stack is unchanged: the VPC, the RDS instance, the Scheduler group,
    // and the Cognito pool all still synthesize (the smoke path is a complete backend without the dashboard).
    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.resourceCountIs('AWS::Scheduler::ScheduleGroup', 1);
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
  });

  it('keeps teardown clean: the new Cognito pool, data-api log group, and Amplify App carry DeletionPolicy:Delete (INFRA-04 / T-02-22)', () => {
    const { template } = synth();
    // The integration wave must not break the single-stack clean teardown (D-12). Each new
    // stateful/host resource carries DeletionPolicy: Delete so one `cdk destroy` leaves no leak.
    template.hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Delete' });
    template.hasResource('AWS::Amplify::App', { DeletionPolicy: 'Delete' }); // H5 applyRemovalPolicy
    template.hasResource('AWS::Amplify::Branch', { DeletionPolicy: 'Delete' });
    // The data-api DESTROY/ONE_WEEK log group is the 5th (RetentionInDays 7) — assert at least one
    // DESTROY log group with 7-day retention exists (the data-api + smoke + schema-init groups).
    template.hasResource('AWS::Logs::LogGroup', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({ RetentionInDays: 7 }),
    });
  });

  it('uses in-process refs ONLY — NO Fn::ImportValue / cross-stack export in the synthesized template (D-12 / Pitfall 5)', () => {
    const { template } = synth();
    const json = JSON.stringify(template.toJSON());
    // D-12 — the three Phase-2 constructs receive live objects by reference, never via CFN export.
    // A single stack with no imports means one clean `cdk destroy` (INFRA-04). Assert the template
    // declares no Outputs Export and no Fn::ImportValue consumer.
    expect(json).not.toContain('Fn::ImportValue');
    const t = template.toJSON() as { Outputs?: Record<string, { Export?: unknown }> };
    for (const out of Object.values(t.Outputs ?? {})) {
      // The informational AmplifyUrl/DataApiUrl outputs (H1) must NOT be cross-stack exports.
      expect(out.Export).toBeUndefined();
    }
  });
});

describe('FoundationStack — Phase-5 integration: Timeout Lambda + PIPE-05 wiring (plan 05-01, D-12)', () => {
  it('M2: RESPONSE_WINDOW_MINUTES is identical across the Outbound and Timeout functions', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    // The conversation worker no longer owns timeout scheduling; collect the two remaining consumers.
    const windows = Object.values(fns)
      .map(
        (f) =>
          (f.Properties as { Environment?: { Variables?: Record<string, unknown> } }).Environment
            ?.Variables,
      )
      .filter((env): env is Record<string, unknown> => !!env && 'RESPONSE_WINDOW_MINUTES' in env)
      .map((env) => env.RESPONSE_WINDOW_MINUTES);
    expect(windows.length).toBe(2);
    for (const w of windows) {
      expect(w).toBe('120');
    }
    expect(new Set(windows).size).toBe(1); // no drift
  });

  it('the Outbound fn env carries TIMEOUT_FN_ARN + SCHEDULER_TARGET_ROLE_ARN + RESPONSE_WINDOW_MINUTES (H4 post-wire)', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    // The Outbound fn is uniquely the SMS-SENDING fn: it carries BOTH STATUS_CALLBACK_URL (Pitfall-2
    // pin) AND TWILIO_FROM_PARAM (the send FROM number). The status-callback fn also has
    // STATUS_CALLBACK_URL but NEVER sends, so it lacks TWILIO_FROM_PARAM — the discriminator.
    const outbound = Object.values(fns).find((f) => {
      const env =
        (f.Properties as { Environment?: { Variables?: Record<string, unknown> } }).Environment
          ?.Variables ?? {};
      return 'STATUS_CALLBACK_URL' in env && 'TWILIO_FROM_PARAM' in env;
    });
    expect(outbound).toBeDefined();
    const env = (
      outbound!.Properties as {
        Environment: { Variables: Record<string, unknown> };
      }
    ).Environment.Variables;
    expect('TIMEOUT_FN_ARN' in env).toBe(true);
    expect('SCHEDULER_TARGET_ROLE_ARN' in env).toBe(true);
    expect(env.RESPONSE_WINDOW_MINUTES).toBe('120');
  });

  it('gives both Twilio webhooks bounded retries while keeping HMAC validator URLs fragment-free', () => {
    const { template } = synth();
    const environments = Object.values(template.findResources('AWS::Lambda::Function')).map(
      (fn) =>
        (fn.Properties as { Environment?: { Variables?: Record<string, unknown> } }).Environment
          ?.Variables ?? {},
    );
    const outbound = environments.find(
      (env) => 'STATUS_CALLBACK_URL' in env && 'TWILIO_FROM_PARAM' in env,
    );
    const callback = environments.find(
      (env) => 'STATUS_CALLBACK_URL' in env && !('TWILIO_FROM_PARAM' in env),
    );
    const inbound = environments.find((env) => 'INBOUND_URL' in env);
    const outputs = template.toJSON().Outputs as Record<string, { Value?: unknown }>;

    expect(JSON.stringify(outbound?.STATUS_CALLBACK_URL)).toContain(
      '#rc=3&ct=1000&rt=5000&tt=15000&rp=ct,rt,5xx',
    );
    expect(JSON.stringify(callback?.STATUS_CALLBACK_URL)).not.toContain('#');
    expect(JSON.stringify(inbound?.INBOUND_URL)).not.toContain('#');
    expect(JSON.stringify(outputs.InboundUrl?.Value)).toContain(
      '#rc=3&ct=1000&rt=5000&tt=15000&rp=ct,rt,5xx',
    );
    expect(callback?.OUTBOUND_FN_ARN).toBeDefined();

    const callbackPolicy = Object.entries(template.findResources('AWS::IAM::Policy')).find(
      ([logicalId, policy]) =>
        logicalId.includes('StatusCallback') &&
        JSON.stringify(policy).includes('lambda:InvokeFunction') &&
        JSON.stringify(policy).includes('OutboundOutboundFn'),
    )?.[1];
    expect(callbackPolicy).toBeDefined();
    const callbackPolicyJson = JSON.stringify(callbackPolicy);
    expect(callbackPolicyJson).not.toContain('"Resource":"*"');
  });

  it('M3: the Outbound fn role gets scheduler:CreateSchedule (group-scoped) + iam:PassRole (scoped, confused-deputy cond) — NO Delete, NO List', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    // The Outbound fn's DefaultPolicy is the one carrying scheduler:CreateSchedule (the post-wire grant).
    const outboundPolicy = Object.entries(policies).find(
      ([logicalId, policy]) =>
        logicalId.includes('OutboundFn') &&
        JSON.stringify((policy.Properties as { PolicyDocument: unknown }).PolicyDocument).includes(
          'scheduler:CreateSchedule',
        ),
    )?.[1];
    expect(outboundPolicy).toBeDefined();
    const doc = (
      outboundPolicy!.Properties as {
        PolicyDocument: {
          Statement: Array<{ Action: unknown; Resource: unknown; Condition?: unknown }>;
        };
      }
    ).PolicyDocument;
    const actionsIn = (stmt: { Action: unknown }): string[] => {
      const a = stmt.Action;
      return Array.isArray(a) ? (a as string[]) : [a as string];
    };
    // CreateSchedule is scoped to the medadhere-prod ARNs (never a bare `*`); NO Delete/List on this fn.
    const createStmt = doc.Statement.find((s) => actionsIn(s).includes('scheduler:CreateSchedule'));
    expect(createStmt).toBeDefined();
    const createResources = Array.isArray(createStmt!.Resource)
      ? createStmt!.Resource
      : [createStmt!.Resource];
    for (const r of createResources) expect(r).not.toBe('*');
    expect(JSON.stringify(createResources)).toContain('schedule/medadhere-prod/*');
    for (const s of doc.Statement) {
      expect(actionsIn(s)).not.toContain('scheduler:DeleteSchedule');
      expect(actionsIn(s)).not.toContain('scheduler:ListSchedules');
    }
    // PassRole scoped to the target-role ARN with the confused-deputy condition (Pitfall 7).
    const passStmt = doc.Statement.find((s) => actionsIn(s).includes('iam:PassRole'));
    expect(passStmt).toBeDefined();
    const passResources = Array.isArray(passStmt!.Resource)
      ? passStmt!.Resource
      : [passStmt!.Resource];
    for (const r of passResources) expect(r).not.toBe('*');
    expect(JSON.stringify(passStmt!.Condition)).toContain('scheduler.amazonaws.com');
    expect(JSON.stringify(passStmt!.Condition)).toContain('iam:PassedToService');
  });

  it('keeps ONE medadhere-prod schedule group (the Timeout fn is an invoke target, not a second group)', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::Scheduler::ScheduleGroup', 1);
  });
});

describe('FoundationStack — Phase-5 integration: admin deactivation route (plan 05-03, STUDY-05 / Q4/M1/M12)', () => {
  /** Coerce a policy statement's Action to a string[] (CDK renders a single action as a bare string). */
  const actionsIn = (stmt: { Action: unknown }): string[] => {
    const a = stmt.Action;
    return Array.isArray(a) ? (a as string[]) : [a as string];
  };

  it('exposes POST /api/patients/{id}/deactivate on the DataApi HttpApi, JWT-authorized (the Cognito default authorizer)', () => {
    const { template } = synth();
    // The full-stack proof of the 401 boundary: the route carries AuthorizationType JWT, so a tokenless
    // request 401s at the authorizer BEFORE the deactivation Lambda runs (Q8: the P5 exit is this backend
    // route; the dashboard UI is P6).
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /api/patients/{id}/deactivate',
      AuthorizationType: 'JWT',
    });
  });

  it('grants the deactivation fn ONLY sweep-side scheduler IAM (List *+region + Delete group) — NO Create, NO PassRole', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    // The deactivation fn's DefaultPolicy is uniquely identified by its `Deactivate` logical-id fragment.
    const entry = Object.entries(policies).find(([id]) => id.includes('Deactivate'));
    expect(entry).toBeDefined();
    const doc = (
      entry![1].Properties as {
        PolicyDocument: {
          Statement: Array<{ Action: unknown; Resource: unknown; Condition?: unknown }>;
        };
      }
    ).PolicyDocument;

    const listStmt = doc.Statement.find((s) => actionsIn(s).includes('scheduler:ListSchedules'));
    expect(listStmt).toBeDefined();
    const listResources = Array.isArray(listStmt!.Resource)
      ? listStmt!.Resource
      : [listStmt!.Resource];
    expect(listResources).toContain('*');
    expect(JSON.stringify(listStmt!.Condition)).toContain('aws:RequestedRegion');

    const delStmt = doc.Statement.find((s) => actionsIn(s).includes('scheduler:DeleteSchedule'));
    expect(delStmt).toBeDefined();
    const delResources = Array.isArray(delStmt!.Resource) ? delStmt!.Resource : [delStmt!.Resource];
    for (const r of delResources) expect(r).not.toBe('*');
    expect(JSON.stringify(delResources)).toContain('schedule/medadhere-prod');

    for (const s of doc.Statement) {
      expect(actionsIn(s)).not.toContain('scheduler:CreateSchedule');
      expect(actionsIn(s)).not.toContain('iam:PassRole');
    }
  });

  it('Q4: the read-only SELECT-1 health fn carries ZERO scheduler IAM in the full stack', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const healthEntry = Object.entries(policies).find(
      ([id]) => id.includes('DataApiFn') && !id.includes('Deactivate'),
    );
    expect(healthEntry).toBeDefined();
    expect(JSON.stringify(healthEntry![1])).not.toContain('scheduler:');
  });

  it('M12: selfSignUpEnabled stays false (AdminCreateUserOnly) — the single-admin authz==authn guard', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
    });
  });
});

describe('FoundationStack — 08-06 doctor API write isolation and reactivation post-wire', () => {
  const actionsIn = (statement: { Action: unknown }): string[] => {
    const actions = statement.Action;
    return Array.isArray(actions) ? (actions as string[]) : [actions as string];
  };

  it.each(['GET /api/patients/{id}/record', 'GET /api/reviews/alerts', 'GET /api/reviews/drafts'])(
    'exposes %s behind the Cognito JWT authorizer',
    (routeKey) => {
      const { template } = synth();
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: routeKey,
        AuthorizationType: 'JWT',
      });
    },
  );

  it.each([
    'POST /api/patients/{id}/drafts/{draftId}/decision',
    'POST /api/patients/{id}/reminder-limit',
    'POST /api/patients/{id}/reactivate',
  ])('exposes %s behind the Cognito JWT authorizer', (routeKey) => {
    const { template } = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: routeKey,
      AuthorizationType: 'JWT',
    });
  });

  it('post-wires reactivate to Outbound and the Scheduler target role', () => {
    const { template } = synth();
    const functions = template.findResources('AWS::Lambda::Function');
    const entry = Object.entries(functions).find(([logicalId]) =>
      logicalId.includes('ReactivateFn'),
    );
    expect(entry).toBeDefined();
    const env = (entry![1].Properties as { Environment: { Variables: Record<string, unknown> } })
      .Environment.Variables;
    expect(JSON.stringify(env.OUTBOUND_FN_ARN)).toContain('OutboundOutboundFn');
    expect(JSON.stringify(env.SCHEDULER_TARGET_ROLE_ARN)).toContain('SchedulerTargetRole');
  });

  it('grants reactivate only scoped schedule create/delete, region-bounded list, and scoped PassRole', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const entry = Object.entries(policies).find(([logicalId]) =>
      logicalId.includes('ReactivateFn'),
    );
    expect(entry).toBeDefined();
    const document = (
      entry![1].Properties as {
        PolicyDocument: {
          Statement: Array<{ Action: unknown; Resource: unknown; Condition?: unknown }>;
        };
      }
    ).PolicyDocument;

    for (const action of ['scheduler:CreateSchedule', 'scheduler:DeleteSchedule']) {
      const statement = document.Statement.find((candidate) =>
        actionsIn(candidate).includes(action),
      );
      expect(statement).toBeDefined();
      const resources = Array.isArray(statement!.Resource)
        ? statement!.Resource
        : [statement!.Resource];
      expect(resources).not.toContain('*');
      expect(JSON.stringify(resources)).toContain('schedule/medadhere-prod');
    }

    const listStatement = document.Statement.find((candidate) =>
      actionsIn(candidate).includes('scheduler:ListSchedules'),
    );
    expect(listStatement).toBeDefined();
    expect(listStatement!.Resource).toBe('*');
    expect(JSON.stringify(listStatement!.Condition)).toContain('aws:RequestedRegion');

    const passStatement = document.Statement.find((candidate) =>
      actionsIn(candidate).includes('iam:PassRole'),
    );
    expect(passStatement).toBeDefined();
    expect(passStatement!.Resource).not.toBe('*');
    expect(JSON.stringify(passStatement!.Resource)).toContain('SchedulerTargetRole');
    expect(JSON.stringify(passStatement!.Condition)).toContain('iam:PassedToService');
    expect(JSON.stringify(passStatement!.Condition)).toContain('scheduler.amazonaws.com');

    const serialized = JSON.stringify(entry![1]);
    expect(serialized).not.toContain('twilio');
    expect(serialized).not.toContain('bedrock:');
    expect(serialized).not.toContain('anthropic');
  });
});

describe('FoundationStack — Phase-5 integration: Monitoring/alerting (OPS-02, plan 05-04, F2 wiring)', () => {
  it('keeps OPS-02 CloudWatch-only with no SNS topic, subscription, policy, or alarm-topic KMS key', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::SNS::Topic', 0);
    template.resourceCountIs('AWS::SNS::Subscription', 0);
    template.resourceCountIs('AWS::SNS::TopicPolicy', 0);
    template.resourceCountIs('AWS::KMS::Key', 0);
  });

  it('provisions 12 alarms + 10 current metric filters with no external alarm actions', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::CloudWatch::Alarm', 12);
    template.resourceCountIs('AWS::Logs::MetricFilter', 10);
    const filters = JSON.stringify(template.findResources('AWS::Logs::MetricFilter'));
    expect(filters).toContain('inbound_emergency_persistence_failed');
    expect(filters).not.toContain('inbound_safety_send_failed');
    expect(filters).not.toContain('inbound_safety_divert_failed');
    for (const alarm of Object.values(template.findResources('AWS::CloudWatch::Alarm'))) {
      const actions = (alarm.Properties as { AlarmActions?: unknown[] }).AlarmActions;
      expect(actions).toBeUndefined();
    }
  });

  it('(b) alarms EXACTLY the six pipeline fns including export — NOT the deactivation fn', () => {
    const { template } = synth();
    const errorAlarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')).filter(
      (a) => {
        const p = a.Properties as { Namespace?: string; MetricName?: string };
        return p.Namespace === 'AWS/Lambda' && p.MetricName === 'Errors';
      },
    );
    expect(errorAlarms.length).toBe(6);
    // 05-03: the deactivation fn is deliberately excluded — its failure signal is the 5xx + error log.
    const dims = JSON.stringify(
      errorAlarms.map((a) => (a.Properties as { Dimensions: unknown }).Dimensions),
    );
    expect(dims).not.toContain('Deactivate');
    expect(dims).toContain('ExportAnon');
  });

  it('(h) F1: the timeout_schedule_failed metric filter reads the OUTBOUND log group (H3 exposure proven by synth)', () => {
    const { template } = synth();
    const timeoutFilter = Object.values(template.findResources('AWS::Logs::MetricFilter')).find(
      (f) =>
        (f.Properties as { FilterPattern: string }).FilterPattern.includes(
          'timeout_schedule_failed',
        ),
    );
    expect(timeoutFilter).toBeDefined();
    const lgRef = JSON.stringify(
      (timeoutFilter!.Properties as { LogGroupName: unknown }).LogGroupName,
    );
    expect(lgRef).toContain('OutboundOutboundLogs'); // the Outbound construct's exposed log group (F1)
  });
});

describe('FoundationStack — 08-04a FIFO route replaces EventBridge without removing Scheduler', () => {
  it('synthesizes one FIFO work queue, one FIFO DLQ, and one batch-size-one event source', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      Enabled: true,
    });

    const queues = Object.values(template.findResources('AWS::SQS::Queue'));
    expect(queues).toHaveLength(2);
    for (const queue of queues) {
      const props = queue.Properties as {
        FifoQueue?: boolean;
        SqsManagedSseEnabled?: boolean;
        MessageRetentionPeriod?: number;
      };
      expect(props.FifoQueue).toBe(true);
      expect(props.SqsManagedSseEnabled).toBe(true);
      expect(props.MessageRetentionPeriod).toBe(1_209_600);
    }
    const workQueue = queues.find(
      (queue) => (queue.Properties as { RedrivePolicy?: unknown }).RedrivePolicy !== undefined,
    );
    expect(workQueue).toBeDefined();
    expect(workQueue!.Properties).toMatchObject({
      VisibilityTimeout: 360,
      RedrivePolicy: { maxReceiveCount: 5 },
    });
  });

  it('removes the complete EventBridge classifier route while preserving EventBridge Scheduler', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::Events::EventBus', 0);
    template.resourceCountIs('AWS::Events::Rule', 0);
    template.resourceCountIs('AWS::Lambda::EventInvokeConfig', 0);
    template.resourceCountIs('AWS::Scheduler::ScheduleGroup', 1);
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toContain('events:PutEvents');
    expect(json).not.toContain('events.amazonaws.com');
    expect(json).not.toContain('EVENT_BUS_NAME');
  });

  it('wires QUEUE_URL to inbound and worker and pins the worker timeout to 180 seconds', () => {
    const { template } = synth();
    const functions = Object.values(template.findResources('AWS::Lambda::Function'));
    const queueFunctions = functions.filter((fn) => {
      const env =
        (fn.Properties as { Environment?: { Variables?: Record<string, unknown> } }).Environment
          ?.Variables ?? {};
      return 'QUEUE_URL' in env;
    });
    expect(queueFunctions).toHaveLength(2);
    const worker = queueFunctions.find(
      (fn) => (fn.Properties as { Timeout?: number }).Timeout === 180,
    );
    expect(worker).toBeDefined();
    const workQueue = Object.values(template.findResources('AWS::SQS::Queue')).find(
      (queue) => (queue.Properties as { RedrivePolicy?: unknown }).RedrivePolicy !== undefined,
    );
    expect(workQueue).toBeDefined();
    expect(
      (workQueue!.Properties as { VisibilityTimeout?: number }).VisibilityTimeout,
    ).toBeGreaterThanOrEqual(2 * 180);
  });
});

describe('FoundationStack — DATA-02: the validationWindow-on path ships ALL THREE protections together (plan 05-04)', () => {
  it('validationWindow=true + retention>=7 → RDS DeletionProtection:true + BackupRetentionPeriod>=7 + stack terminationProtection', () => {
    const { stack, template } = synth({ validationWindow: true, backupRetentionDays: 7 });
    // (1) stack-level termination protection (F59, bin/medadhere.ts)
    expect(stack.terminationProtection).toBe(true);
    // (2) RDS deletion protection + (3) >=7-day backups — all shipped together (no silent gap).
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      DeletionProtection: true,
      BackupRetentionPeriod: 7,
    });
  });
});

describe('FoundationStack — Phase-6 integration: enrollment write path (plan 06-02, DASH-05 / D2 / U-4)', () => {
  /** Coerce a policy statement's Action to a string[] (CDK renders a single action as a bare string). */
  const actionsIn = (stmt: { Action: unknown }): string[] => {
    const a = stmt.Action;
    return Array.isArray(a) ? (a as string[]) : [a as string];
  };

  it('exposes POST /api/patients on the DataApi HttpApi, JWT-authorized (the Cognito default authorizer)', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /api/patients',
      AuthorizationType: 'JWT',
    });
  });

  it('U-4 post-wire: the lean non-VPC enroll-api fn carries ENROLL_FN_ARN and NO DB env (it never opens pg)', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    // The enroll-api fn is uniquely the NON-VPC fn carrying ENROLL_FN_ARN (the stack post-wire env).
    const enrollApi = Object.values(fns).find((f) => {
      const p = f.Properties as {
        VpcConfig?: unknown;
        Environment?: { Variables?: Record<string, unknown> };
      };
      return p.VpcConfig === undefined && 'ENROLL_FN_ARN' in (p.Environment?.Variables ?? {});
    });
    expect(enrollApi).toBeDefined();
    const env = (
      enrollApi!.Properties as {
        Environment: { Variables: Record<string, unknown> };
      }
    ).Environment.Variables;
    // Lean: it invokes the Enroll fn, never RDS — so NO DB secret/host and NO PGSSLMODE.
    expect('DB_SECRET_ARN' in env).toBe(false);
    expect('DB_HOST' in env).toBe(false);
    expect('PGSSLMODE' in env).toBe(false);
  });

  it('U-4 grantInvoke: the enroll-api fn is granted lambda:InvokeFunction on the ENROLL fn ONLY (scoped, no `*`, no DB/scheduler)', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    // The enroll-api → Enroll grantInvoke is the ONLY InvokeFunction policy referencing the Enroll fn
    // (the scheduler target roles invoke Outbound/Timeout/Export, never Enroll). Identify it by both.
    const invokePolicy = Object.values(policies).find((pol) => {
      const doc = JSON.stringify((pol.Properties as { PolicyDocument: unknown }).PolicyDocument);
      return doc.includes('lambda:InvokeFunction') && doc.includes('EnrollEnrollFn');
    });
    expect(invokePolicy).toBeDefined();
    const doc = (
      invokePolicy!.Properties as {
        PolicyDocument: { Statement: Array<{ Action: unknown; Resource: unknown }> };
      }
    ).PolicyDocument;

    const invokeStmt = doc.Statement.find((s) => actionsIn(s).includes('lambda:InvokeFunction'));
    expect(invokeStmt).toBeDefined();
    // Scoped to the Enroll fn ARN — never a bare `*`.
    const res = Array.isArray(invokeStmt!.Resource) ? invokeStmt!.Resource : [invokeStmt!.Resource];
    for (const r of res) expect(r).not.toBe('*');
    expect(JSON.stringify(res)).toContain('EnrollEnrollFn');
    // The lean write fn carries NO DB-secret read and NO scheduler action (it only invokes).
    const full = JSON.stringify(invokePolicy);
    expect(full).not.toContain('secretsmanager:GetSecretValue');
    expect(full).not.toContain('scheduler:');
  });

  it('keeps the enroll-api non-VPC while clinical history reuses the data-api function', () => {
    const { template } = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    const inVpc = Object.values(fns).filter(
      (f) => (f.Properties as { VpcConfig?: unknown }).VpcConfig !== undefined,
    );
    expect(inVpc.length).toBe(14);
  });
});
