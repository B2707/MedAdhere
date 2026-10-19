// infra/test/auth.test.ts
//
// The SC1 SHAPE gate for the Cognito identity foundation (AuthConstruct). Hermetic
// `Template.fromStack` synth — NO live AWS credentials, NO network — mirroring the
// foundation-stack.test.ts `synth()` + `Template.fromStack` idiom (test:25-51).
//
// It pins the load-bearing security + immutability contract plan 04 wires by in-process ref:
//   - PUBLIC dashboard app client: GenerateSecret:false (D-05 — the security gate of this test; a
//     regression to a confidential client would mean stashing a secret in the Amplify SSR env).
//   - D4 auxiliary TOTP CLI client: GenerateSecret:false + ONLY ALLOW_USER_PASSWORD_AUTH and
//     ALLOW_REFRESH_TOKEN_AUTH. The primary dashboard client's auth-flow shape stays unchanged.
//   - signInCaseSensitive:false → UsernameConfiguration.CaseSensitive:false (project decision record pin).
//   - ZERO custom attributes — no `custom:`-prefixed Schema entry (D-13, immutable post-deploy).
//   - The immutable MFA posture: MfaConfiguration OPTIONAL + EnabledMfas SOFTWARE_TOKEN_MFA (L8 / D-13,
//     create-time-immutable per Pitfall 4 — a silent regression here would require a pool rebuild).
//   - Dual-host callback/logout allow-list: Amplify + Vercel + localhost in BOTH lists (H1 / Pitfall 7).
//   - Clean teardown: the pool carries DeletionPolicy:'Delete' (INFRA-04, mirrors the LogGroup
//     teardown assertion in foundation-stack.test.ts:342-351).

import { describe, it, expect } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AuthConstruct } from '../lib/constructs/auth.js';

// Literal test redirect hosts (H1 — the REQUIRED props; in the real stack plan 04 feeds the SAME
// value into hosting.ts's COGNITO_REDIRECT_URI). `.example` hosts keep the test obviously hermetic.
const AMPLIFY_URL = 'https://main.d1example.amplify.example.com';
const VERCEL_URL = 'https://medadhere.vercel.example.com';
const LOCALHOST_URL = 'http://localhost:3000';

/**
 * Build a synthesized throwaway stack hermetically (a fresh App + Stack, mirroring the foundation
 * test's `synth()` helper idiom), instantiate AuthConstruct with the literal test URLs, and return
 * the rendered template. No live AWS call happens at synth.
 */
function synth() {
  const app = new App();
  const stack = new Stack(app, 'TestAuth', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  new AuthConstruct(stack, 'Auth', {
    amplifyCallbackUrl: AMPLIFY_URL,
    vercelCallbackUrl: VERCEL_URL,
  });
  return { stack, template: Template.fromStack(stack) };
}

interface UserPoolClientProperties {
  readonly ClientName?: string;
  readonly GenerateSecret?: boolean;
  readonly ExplicitAuthFlows?: string[];
  readonly AllowedOAuthFlows?: string[];
  readonly AllowedOAuthFlowsUserPoolClient?: boolean;
  readonly AllowedOAuthScopes?: string[];
  readonly CallbackURLs?: string[];
  readonly LogoutURLs?: string[];
  readonly PreventUserExistenceErrors?: string;
}

function clientProperties(template: Template, clientName: string): UserPoolClientProperties {
  const clients = Object.values(template.findResources('AWS::Cognito::UserPoolClient'));
  const matches = clients.filter(
    (client) => (client.Properties as UserPoolClientProperties).ClientName === clientName,
  );
  expect(matches).toHaveLength(1);
  return matches[0]!.Properties as UserPoolClientProperties;
}

describe('AuthConstruct — Cognito UserPool (D-13 / SC1)', () => {
  it('declares exactly one UserPool', () => {
    synth().template.resourceCountIs('AWS::Cognito::UserPool', 1);
  });

  it('is case-insensitive (signInCaseSensitive:false → UsernameConfiguration.CaseSensitive:false — project decision record pin)', () => {
    synth().template.hasResourceProperties('AWS::Cognito::UserPool', {
      UsernameConfiguration: { CaseSensitive: false },
    });
  });

  it('has ZERO custom attributes — no `custom:`-prefixed Schema entry (D-13, immutable post-deploy)', () => {
    const { template } = synth();
    const pools = template.findResources('AWS::Cognito::UserPool');
    const pool = Object.values(pools)[0]!;
    const schema = (pool.Properties as { Schema?: Array<{ Name?: string }> }).Schema;
    expect(schema).toBeDefined();
    // No schema entry may carry a Cognito custom-attribute (`custom:`-prefixed) name.
    for (const attr of schema!) {
      expect(attr.Name?.startsWith('custom:')).toBe(false);
    }
  });

  it('L8 — pins the create-time-immutable MFA posture: OPTIONAL + SOFTWARE_TOKEN_MFA (D-13)', () => {
    const { template } = synth();
    // MfaConfiguration:'OPTIONAL' is the CFN shape of `mfa: cognito.Mfa.OPTIONAL`.
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      MfaConfiguration: 'OPTIONAL',
    });
    // EnabledMfas must include SOFTWARE_TOKEN_MFA (otp:true) and NOT SMS_MFA (sms:false) — the exact
    // immutable posture; a silent regression to a different MFA config (which would require a pool
    // rebuild to fix) fails this assertion.
    const pools = template.findResources('AWS::Cognito::UserPool');
    const pool = Object.values(pools)[0]!;
    const enabledMfas = (pool.Properties as { EnabledMfas?: string[] }).EnabledMfas;
    expect(enabledMfas).toBeDefined();
    expect(enabledMfas).toContain('SOFTWARE_TOKEN_MFA');
    expect(enabledMfas).not.toContain('SMS_MFA');
  });

  it('carries DeletionPolicy:Delete for clean single-stack teardown (INFRA-04)', () => {
    synth().template.hasResource('AWS::Cognito::UserPool', {
      DeletionPolicy: 'Delete',
    });
  });
});

describe('AuthConstruct — PUBLIC OAuth/PKCE app client (D-05)', () => {
  it('declares the dashboard client plus the auxiliary D4 TOTP CLI client', () => {
    synth().template.resourceCountIs('AWS::Cognito::UserPoolClient', 2);
  });

  it('declares a PUBLIC client: GenerateSecret:false (the load-bearing security assertion)', () => {
    const { template } = synth();
    const primary = clientProperties(template, 'medadhere-dashboard');
    expect(primary.GenerateSecret).toBe(false);
  });

  it('uses only the authorization-code OAuth flow with openid/email/profile scopes', () => {
    const { template } = synth();
    const primary = clientProperties(template, 'medadhere-dashboard');
    expect(primary.AllowedOAuthFlows).toEqual(['code']);
    expect(primary.AllowedOAuthFlowsUserPoolClient).toBe(true);
    expect(primary.AllowedOAuthScopes).toEqual(['openid', 'email', 'profile']);
  });

  it('keeps the primary dashboard client auth flows unchanged (no ExplicitAuthFlows override)', () => {
    const { template } = synth();
    const primary = clientProperties(template, 'medadhere-dashboard');
    expect(primary.ExplicitAuthFlows).toBeUndefined();
  });

  it('H1 — pre-seeds all three redirect hosts (Amplify + Vercel + localhost) in BOTH CallbackURLs and LogoutURLs', () => {
    const { template } = synth();
    const props = clientProperties(template, 'medadhere-dashboard');
    // Each host appears (by host prefix) in BOTH lists — the Jun-30 Vercel fallback is then a pure
    // host-swap with no pool change (RESEARCH Pitfall 7 / D-02).
    for (const host of [AMPLIFY_URL, VERCEL_URL, LOCALHOST_URL]) {
      expect(props.CallbackURLs!.some((u) => u.startsWith(host))).toBe(true);
      expect(props.LogoutURLs!.some((u) => u.startsWith(host))).toBe(true);
    }
  });

  it('does not leak account existence (PreventUserExistenceErrors ENABLED)', () => {
    const { template } = synth();
    const primary = clientProperties(template, 'medadhere-dashboard');
    expect(primary.PreventUserExistenceErrors).toBe('ENABLED');
  });
});

describe('AuthConstruct — D4 auxiliary TOTP CLI client', () => {
  it('is a no-secret client with exactly USER_PASSWORD_AUTH + refresh auth', () => {
    const { template } = synth();
    const totpClient = clientProperties(template, 'medadhere-totp-cli');
    expect(totpClient.GenerateSecret).toBe(false);
    expect(totpClient.ExplicitAuthFlows).toEqual([
      'ALLOW_USER_PASSWORD_AUTH',
      'ALLOW_REFRESH_TOKEN_AUTH',
    ]);
  });

  it('has no hosted-login OAuth surface', () => {
    const { template } = synth();
    const totpClient = clientProperties(template, 'medadhere-totp-cli');
    expect(totpClient.AllowedOAuthFlows).toBeUndefined();
    expect(totpClient.AllowedOAuthFlowsUserPoolClient).toBe(false);
    expect(totpClient.AllowedOAuthScopes).toBeUndefined();
    expect(totpClient.CallbackURLs).toBeUndefined();
    expect(totpClient.LogoutURLs).toBeUndefined();
  });
});

describe('AuthConstruct — managed-login domain (D-08)', () => {
  it('declares exactly one UserPoolDomain', () => {
    synth().template.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
  });

  it('binds a Cognito-default ManagedLoginBranding to the dashboard client ONLY (F-gap 2026-08-14)', () => {
    const { template } = synth();
    const clients = template.findResources('AWS::Cognito::UserPoolClient');
    const dashboard = Object.entries(clients).find(
      ([, client]) =>
        (client.Properties as UserPoolClientProperties).ClientName === 'medadhere-dashboard',
    );
    expect(dashboard).toBeDefined();
    // Exactly one style: managed login v2 serves "Login pages unavailable" for an app client with no
    // branding style, so the dashboard client MUST carry one. The D4 TOTP CLI client never loads a
    // hosted page (USER_PASSWORD_AUTH only), so a second style would be dead config.
    template.resourceCountIs('AWS::Cognito::ManagedLoginBranding', 1);
    template.hasResourceProperties('AWS::Cognito::ManagedLoginBranding', {
      UseCognitoProvidedValues: true,
      ClientId: { Ref: dashboard![0] },
    });
  });
});

describe('AuthConstruct — negative: NO client secret anywhere (D-05 / D4)', () => {
  it('the synthesized template contains no GenerateSecret:true UserPoolClient', () => {
    const { template } = synth();
    const clients = template.findResources('AWS::Cognito::UserPoolClient');
    // Every client must be public (GenerateSecret:false) — none may request a secret.
    for (const client of Object.values(clients)) {
      expect((client.Properties as { GenerateSecret?: boolean }).GenerateSecret).toBe(false);
    }
    // Belt-and-suspenders: the full template JSON carries no `"GenerateSecret": true`.
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toMatch(/"GenerateSecret"\s*:\s*true/);
  });
});
