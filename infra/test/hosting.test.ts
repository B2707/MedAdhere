// infra/test/hosting.test.ts
//
// SC3 hermetic gate — pins the Amplify Hosting contract WITHOUT any live AWS call. A throwaway Stack
// instantiates HostingConstruct with literal props; `Template.fromStack` asserts the synthesized
// CloudFormation has the correct WEB_COMPUTE App + Branch shape, the monorepo + Cognito + data-API env
// (H2: COGNITO_REGION, never the reserved AWS_REGION), NO client secret / NO DB creds in the SSR env
// (D-05/Pattern 4), the explicit DeletionPolicy:Delete (H5), and least-privilege Amplify roles (M2).

import { describe, it, expect } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { HostingConstruct } from '../lib/constructs/hosting.js';

/** Literal props mirroring what FoundationStack passes (region as COGNITO_REGION, shared host — H1/H2). */
const PROPS = {
  userPoolId: 'us-east-1_TESTPOOL',
  userPoolClientId: 'testclientid0123456789',
  cognitoDomain: 'https://medadhere-auth.auth.us-east-1.amazoncognito.com',
  dataApiUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com',
  region: 'us-east-1',
  cognitoRedirectUri: 'https://dashboard.medadhere.example/api/auth/callback',
  githubOwner: 'B2707',
  githubRepository: 'medadhere',
  githubBranch: 'dashboard-deploy',
  githubTokenSecretName: 'medadhere/amplify-github-token',
};

function synthHosting() {
  const app = new App();
  const stack = new Stack(app, 'TestHosting', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  new HostingConstruct(stack, 'Hosting', PROPS);
  return Template.fromStack(stack);
}

/** Read the Amplify App's EnvironmentVariables as a { name: value } map. */
function envMap(template: Template): Record<string, string> {
  const apps = template.findResources('AWS::Amplify::App');
  const app = Object.values(apps)[0]!;
  const ev =
    (app.Properties as { EnvironmentVariables?: Array<{ Name: string; Value: string }> })
      .EnvironmentVariables ?? [];
  return Object.fromEntries(ev.map((e) => [e.Name, e.Value]));
}

describe('HostingConstruct — Amplify WEB_COMPUTE App + Branch (SC3)', () => {
  it('provisions exactly one WEB_COMPUTE App and one Branch (D-03 — SSR, not static WEB)', () => {
    const template = synthHosting();
    template.resourceCountIs('AWS::Amplify::App', 1);
    template.resourceCountIs('AWS::Amplify::Branch', 1);
    template.hasResourceProperties('AWS::Amplify::App', {
      Platform: 'WEB_COMPUTE',
    });
  });

  it('sources from the private GitHub branch with the OAuth token read from Secrets Manager (never inlined — M7/T-02-23)', () => {
    const template = synthHosting();
    const apps = template.findResources('AWS::Amplify::App');
    const app = Object.values(apps)[0]!;
    const props = app.Properties as { Repository?: string; OauthToken?: unknown };
    // The repo is wired (GitHubSourceCodeProvider) and the OAuth token is a `{{resolve:secretsmanager}}`
    // dynamic reference, NOT a plaintext token (M7 — the secret is human-created, out of stack).
    expect(typeof props.Repository).toBe('string');
    expect(JSON.stringify(props.OauthToken)).toContain('{{resolve:secretsmanager:');
    // The branch carries the private branch name.
    template.hasResourceProperties('AWS::Amplify::Branch', {
      BranchName: 'dashboard-deploy',
    });
  });

  it('H2/H3 — sets an INLINE monorepo BuildSpec that cd-s to the repo root for the @medadhere/dashboard workspace build (deploy-managed, not a subdir file)', () => {
    const template = synthHosting();
    const apps = template.findResources('AWS::Amplify::App');
    const app = Object.values(apps)[0]!;
    const buildSpec = (app.Properties as { BuildSpec?: string }).BuildSpec;
    // H3 — the build spec is set inline on the App (a dashboard/amplify.yml subdir
    // file is never discovered by Amplify); fromObjectToYaml renders a YAML string.
    expect(typeof buildSpec).toBe('string');
    const spec = buildSpec!;
    // H2 — install/build run from the monorepo ROOT (the sole package-lock.json),
    // reached by cd-ing to the repo root (no buildPath — it broke baseDirectory resolution).
    expect(spec).toContain('git rev-parse --show-toplevel');
    expect(spec).toContain('npm ci');
    expect(spec).not.toContain('buildPath');
    // H2 — the build targets the dashboard workspace explicitly.
    expect(spec).toContain('--workspace=@medadhere/dashboard');
    // appRoot + the appRoot-relative `.next` artifact dir round out the monorepo shape.
    // baseDirectory is `.next` (appRoot-relative), NOT `dashboard/.next` (deploy-day fix).
    expect(spec).toContain('appRoot: dashboard');
    expect(spec).toContain('baseDirectory: .next');
    expect(spec).not.toContain('dashboard/.next');
  });

  it('injects the monorepo + data-API + Cognito env (incl. COGNITO_REGION) into the SSR tier', () => {
    const env = envMap(synthHosting());
    expect(env.AMPLIFY_MONOREPO_APP_ROOT).toBe('dashboard'); // D-01 / H4 (matches amplify.yml appRoot)
    expect(env.DATA_API_URL).toBe(PROPS.dataApiUrl);
    expect(env.COGNITO_USER_POOL_ID).toBe(PROPS.userPoolId);
    expect(env.COGNITO_CLIENT_ID).toBe(PROPS.userPoolClientId);
    expect(env.COGNITO_DOMAIN).toBe(PROPS.cognitoDomain);
    expect(env.COGNITO_REGION).toBe(PROPS.region); // H2 — region under COGNITO_REGION
    expect(env.COGNITO_REDIRECT_URI).toBe(PROPS.cognitoRedirectUri); // H1 — from the shared host prop
  });

  it('H2 — NO Amplify env key starts with the reserved AWS_ prefix (COGNITO_REGION present, AWS_REGION absent)', () => {
    const env = envMap(synthHosting());
    // Amplify Hosting reserves the `AWS_*` prefix and blanks user env vars starting with it — a reserved
    // key would break the dashboard's `jose` issuer/audience verify at runtime. None may start with AWS_.
    for (const key of Object.keys(env)) {
      expect(key.startsWith('AWS_')).toBe(false);
    }
    expect('COGNITO_REGION' in env).toBe(true);
    expect('AWS_REGION' in env).toBe(false);
  });

  it('D-05/Pattern 4 — the SSR env carries NO client secret and NO DB credential/host', () => {
    const env = envMap(synthHosting());
    // D-05: the Cognito client is PUBLIC (PKCE) — no client secret reaches the SSR env (T-02-20).
    expect('COGNITO_CLIENT_SECRET' in env).toBe(false);
    // Pattern 4: the Next.js tier never touches RDS (Amplify SSR has no VPC) — no DB creds/host.
    for (const key of Object.keys(env)) {
      expect(key.startsWith('DB_')).toBe(false);
    }
    // Belt-and-suspenders: no plaintext secret leaks anywhere in the synthesized template.
    const json = JSON.stringify(synthHosting().toJSON()).toLowerCase();
    expect(json).not.toContain('clientsecret');
    expect(json).not.toContain('db_password');
  });

  it('H5 — the Amplify App + Branch carry an explicit DeletionPolicy:Delete (applyRemovalPolicy, not a no-op prop)', () => {
    const template = synthHosting();
    // The alpha App/Branch L2s expose no `removalPolicy` prop; applyRemovalPolicy(DESTROY) is the only
    // way DeletionPolicy:Delete is actually emitted — this assertion is exactly what H5 fixes (a no-op
    // prop would leave DeletionPolicy undefined and leak the App after a "clean" cdk destroy).
    template.hasResource('AWS::Amplify::App', { DeletionPolicy: 'Delete' });
    template.hasResource('AWS::Amplify::Branch', { DeletionPolicy: 'Delete' });
  });

  it('M2 — the Amplify compute/app roles grant no secretsmanager:*/rds*/ec2:CreateNetworkInterface/*-resource (least privilege)', () => {
    const template = synthHosting();
    // The Next.js SSR tier reaches ONLY the public API GW URL (Pattern 4) — its service roles need no
    // DB/VPC/Secrets permissions. The alpha construct may create Amplify service roles (principal
    // amplify.amazonaws.com) at synth; assert none of them — nor any Hosting-scoped IAM policy — grants
    // a forbidden action or a `*` resource (T-02-21 made real).
    const roles = template.findResources('AWS::IAM::Role');
    const amplifyRoles = Object.entries(roles).filter(([, r]) =>
      JSON.stringify(
        (r.Properties as { AssumeRolePolicyDocument?: unknown }).AssumeRolePolicyDocument ?? {},
      ).includes('amplify.amazonaws.com'),
    );
    // There IS at least one Amplify service role (the construct creates app/compute roles); assert each
    // carries no inline policy with a forbidden grant.
    for (const [, role] of amplifyRoles) {
      const json = JSON.stringify(role);
      expect(/secretsmanager:\*/.test(json)).toBe(false);
      expect(/"rds[:*]/.test(json)).toBe(false);
      expect(json.includes('ec2:CreateNetworkInterface')).toBe(false);
      expect(json.includes('"Resource":"*"')).toBe(false);
    }
    // No standalone IAM Policy attached to the Amplify surface grants those actions either.
    const policies = template.findResources('AWS::IAM::Policy');
    const allPolicyJson = JSON.stringify(Object.values(policies));
    expect(/secretsmanager:\*/.test(allPolicyJson)).toBe(false);
    expect(allPolicyJson.includes('ec2:CreateNetworkInterface')).toBe(false);
  });
});
