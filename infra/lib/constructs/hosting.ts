// infra/lib/constructs/hosting.ts
//
// HostingConstruct (SC3 / D-01/D-02/D-03 / D-05/D-06 / D-12 / H1/H2/H5/H6 / M2/M7) — the Amplify
// Hosting half of the Phase-2 deploy infra. A leaf resource-declaration construct (the ses.ts /
// budgets.ts authoring analog: ONE concern, no in-VPC Lambda, typed `public readonly` members,
// `Stack.of(this)` for region where needed). It provisions a CDK-managed Amplify App + Branch that
// serves the Next.js 15 App Router dashboard (dashboard/) as SSR on the WEB_COMPUTE platform, sourced
// from a PRIVATE GitHub branch carrying dashboard/ (D-01 / RESEARCH Pitfall 6).
//
// ALPHA-MODULE PIN DISCIPLINE (D-03 / RESEARCH Pitfall 3) — this is the ONLY construct in the repo
// that imports an alpha CDK module. `@aws-cdk/aws-amplify-alpha` never graduated to the stable
// aws-cdk-lib (unlike apigatewayv2, which did), so its API can break between minors. It is pinned in
// infra/package.json to the EXACT alpha version matching the installed aws-cdk-lib minor
// (aws-cdk-lib 2.259.0 <-> @aws-cdk/aws-amplify-alpha 2.259.0-alpha.0) — NO `^` float. If the alpha
// churns, the Vercel fallback (D-02 / plan 05) sidesteps it entirely (same data-API path; only the
// host changes).
//
// What this construct declares:
//   - amplify.App (platform WEB_COMPUTE — App Router SSR, NOT the static-only WEB; D-03), sourced from
//     a GitHubSourceCodeProvider against the PRIVATE branch (D-01 / Pitfall 6) using an OAuth token
//     read from Secrets Manager (M7 — see below). The build env carries the Cognito + data-API runtime
//     config the Next.js tier reads (in-process refs / strings passed by plan 04 — D-12).
//   - amplify.Branch (stage PRODUCTION) for that private branch.
//
// H2 — the region env key is COGNITO_REGION, NEVER the reserved AWS_REGION. Amplify Hosting reserves
// the `AWS_*` prefix and rejects/blanks user-supplied env vars starting with it; the dashboard's
// lib/cognito.ts (plan 03) reads COGNITO_REGION. NO Amplify env key here may start with `AWS_` — a
// reserved key would blank at runtime and break the `jose` issuer/audience verify. Enforced by the
// hosting.test.ts no-`AWS_`-env-key assertion.
//
// H1 — the redirect host is a single shared value supplied as a prop (props.cognitoRedirectUri), the
// SAME redirect-host string plan 04 ALSO feeds to AuthConstruct's callback allow-list, so the Cognito
// allow-list and the SSR COGNITO_REDIRECT_URI cannot drift. Because the Amplify default WEB_COMPUTE
// domain (`<branch>.<appId>.<amplify-host>`) is a non-deterministic synth token (appId unknown at
// synth), there is NO hardcoded stand-in host here — plan 04 emits a CfnOutput of the resolved Amplify
// URL and plan 05's two-pass step reconciles both the Cognito client callback/redirect AND this env to
// the real first-deploy URL (Cognito callback URLs are mutable post-deploy).
//
// D-05 / D-06 (secret-free SSR env) — the build env carries NO client secret (the Cognito app client
// is PUBLIC / PKCE-only) and NO DB credential/host. The Next.js tier never touches RDS (Amplify SSR has
// no VPC connectivity — RESEARCH Pattern 4); it only calls the PUBLIC API GW URL (props.dataApiUrl)
// over the internet. T-02-20: no credential to the data plane ever reaches this tier.
//
// H5 — explicit DeletionPolicy: Delete via applyRemovalPolicy. The alpha App/Branch L2s expose NO
// `removalPolicy` prop, so an "apply where the prop exists" approach is a silent no-op and the App
// synthesizes with DeletionPolicy undefined (failing the teardown assertion + leaking after a "clean"
// cdk destroy). We call applyRemovalPolicy(RemovalPolicy.DESTROY) on the App (and Branch) so the
// attribute is actually emitted (INFRA-04 explicit teardown / T-02-22).
//
// M7 — the GitHub OAuth token secret (AMPLIFY_GITHUB_TOKEN_SECRET) is intentionally HUMAN-CREATED and
// OUT OF STACK: CDK only READS it via SecretValue.secretsManager(...) — it does NOT manage/create it,
// so it survives `cdk destroy`. Its teardown (force-delete the secret + revoke the GitHub token) is an
// explicit plan-05 leak-check step (INFRA-04 no-orphans). It is NEVER inlined in the template (T-02-23).
//
// BUILD-SPEC CONTRACT (H2/H3/H4/H6) — the monorepo build spec is set INLINE on the App via
// codebuild.BuildSpec.fromObjectToYaml (MONOREPO_BUILD_SPEC below), NOT discovered from a file. H3:
// Amplify reads an `amplify.yml` ONLY at the repo ROOT (or the inline App buildSpec); a subdir
// `dashboard/amplify.yml` is silently ignored, so the inline spec is the authoritative one. H2: the
// inline spec carries `buildPath:'/'` so `npm ci` runs from the monorepo root (the SOLE
// package-lock.json under npm workspaces) and the build targets `--workspace=@medadhere/dashboard`,
// with `artifacts.baseDirectory: dashboard/.next`. `dashboard/amplify.yml` is kept in sync as a
// local/dev reference only. This App's AMPLIFY_MONOREPO_APP_ROOT env var MUST still equal `dashboard`
// (H4). H6: Amplify Hosting supports up to Next 15 only — plan 03 caps `next` to `>=15.5.9 <16` for
// exactly this reason; `>=16.x` is valid here only once Amplify adds Next-16 support (or under the
// Vercel fallback, D-02).

import { Construct } from 'constructs';
import { RemovalPolicy, SecretValue } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as amplify from '@aws-cdk/aws-amplify-alpha';

/** The monorepo app root (D-01) — MUST equal dashboard/amplify.yml's `appRoot` (H4). */
const MONOREPO_APP_ROOT = 'dashboard';

/** The npm-workspace name of the dashboard package (dashboard/package.json `name`). */
const DASHBOARD_WORKSPACE = '@medadhere/dashboard';

/**
 * H2/H3 — the DEPLOY-MANAGED, location-independent Amplify monorepo build spec.
 *
 * H3: Amplify discovers an `amplify.yml` ONLY at the repo ROOT (or set inline on
 * the App). A `dashboard/amplify.yml` in a subdir is NEVER read, so the spec MUST
 * be set inline here (`buildSpec` prop) to take effect. `dashboard/amplify.yml`
 * is kept in sync purely as a local/dev reference — this inline spec is the one
 * Amplify actually uses.
 *
 * H2: the SOLE `package-lock.json` lives at the monorepo ROOT (npm workspaces), so
 * `npm ci` must run from the root, NOT from `dashboard/` (no lockfile → preBuild hard-fail).
 * We `cd` to the repo root in BOTH phases (`git rev-parse --show-toplevel` is robust to
 * Amplify's working dir) and build the dashboard workspace explicitly. The build output
 * lands at `dashboard/.next` = `appRoot/.next`, so `artifacts.baseDirectory` is `.next`
 * (appRoot-relative). Deploy-day fix 2026-06-19: an earlier `buildPath: '/'` variant
 * compiled fine but Amplify could not resolve the artifacts `baseDirectory` under the
 * `applications:`/`appRoot` format (neither `.next` nor `dashboard/.next` worked →
 * "Artifacts base directory not found"); removing `buildPath` and cd-ing to root in the
 * commands makes `baseDirectory: .next` unambiguously appRoot-relative.
 * `AMPLIFY_MONOREPO_APP_ROOT=dashboard` (env, below) stays in sync with `appRoot` (H4).
 */
const MONOREPO_BUILD_SPEC = codebuild.BuildSpec.fromObjectToYaml({
  version: 1,
  applications: [
    {
      appRoot: MONOREPO_APP_ROOT,
      frontend: {
        phases: {
          // H2 — install + build from the monorepo ROOT (the only package-lock.json).
          preBuild: { commands: ['cd "$(git rev-parse --show-toplevel)" && npm ci'] },
          build: {
            commands: [
              `cd "$(git rev-parse --show-toplevel)" && npm run build --workspace=${DASHBOARD_WORKSPACE}`,
            ],
          },
        },
        artifacts: {
          // appRoot-relative: next build writes dashboard/.next = appRoot/.next.
          baseDirectory: '.next',
          files: ['**/*'],
        },
      },
    },
  ],
});

export interface HostingConstructProps {
  // --- runtime config injected as Amplify SSR build env vars (in-process refs / strings — D-12) -----
  /** The Cognito user pool id (-> COGNITO_USER_POOL_ID). From AuthConstruct.userPool.userPoolId. */
  readonly userPoolId: string;
  /** The PUBLIC app client id (-> COGNITO_CLIENT_ID). From AuthConstruct.userPoolClient. */
  readonly userPoolClientId: string;
  /** The Cognito managed-login domain base URL (-> COGNITO_DOMAIN). From AuthConstruct.userPoolDomain. */
  readonly cognitoDomain: string;
  /** The PUBLIC data-API endpoint (-> DATA_API_URL). From DataApiConstruct.httpApi.apiEndpoint. */
  readonly dataApiUrl: string;
  /**
   * H2 — the deploy region, injected as COGNITO_REGION (NOT the Amplify-reserved AWS_REGION). The
   * dashboard's cognito.ts reads COGNITO_REGION (plan 03, in lockstep).
   */
  readonly region: string;
  /**
   * H1 — the SINGLE shared redirect host (-> COGNITO_REDIRECT_URI). The SAME value plan 04 feeds to
   * AuthConstruct's callback allow-list, so the Cognito allow-list and the SSR env cannot drift. No
   * hardcoded stand-in host (the real Amplify URL is reconciled post-first-deploy in plan 05).
   */
  readonly cognitoRedirectUri: string;

  // --- private-GitHub-branch source (D-01 / Pitfall 6) ----------------------------------------------
  /** The GitHub repo owner/org (the private repo Amplify connects to). */
  readonly githubOwner: string;
  /** The GitHub repository name. */
  readonly githubRepository: string;
  /** The PRIVATE branch carrying dashboard/ (NOT main — main holds README + .gitignore only, D-01). */
  readonly githubBranch: string;
  /**
   * M7 — the Secrets Manager secret NAME holding the GitHub OAuth token. The secret is HUMAN-CREATED
   * and OUT OF STACK (CDK reads it via SecretValue.secretsManager, never manages it); its teardown is
   * a plan-05 leak-check step. The token is never inlined in the synthesized template (T-02-23).
   */
  readonly githubTokenSecretName: string;
}

export class HostingConstruct extends Construct {
  /** The Amplify App (WEB_COMPUTE SSR — D-03). */
  public readonly app: amplify.App;
  /** The Amplify Branch for the private dashboard source branch. */
  public readonly branch: amplify.Branch;

  constructor(scope: Construct, id: string, props: HostingConstructProps) {
    super(scope, id);

    // --- Amplify App (WEB_COMPUTE SSR, private-GitHub-branch source, monorepo + Cognito/data-API env) -
    this.app = new amplify.App(this, 'App', {
      appName: 'medadhere-dashboard',
      // D-03 — SSR platform for the App Router (NOT the static-only WEB).
      platform: amplify.Platform.WEB_COMPUTE,
      // D-01 / Pitfall 6 — source = the PRIVATE GitHub branch carrying dashboard/. The OAuth token is
      // read from Secrets Manager (M7), NEVER inlined in the template (T-02-23).
      sourceCodeProvider: new amplify.GitHubSourceCodeProvider({
        owner: props.githubOwner,
        repository: props.githubRepository,
        oauthToken: SecretValue.secretsManager(props.githubTokenSecretName),
      }),
      // H2/H3 — set the monorepo build spec INLINE (deploy-managed + location-
      // independent). A subdir dashboard/amplify.yml is never discovered; only the
      // repo-root file or this inline spec takes effect. buildPath:'/' runs npm ci
      // from the root lockfile and builds the @medadhere/dashboard workspace.
      buildSpec: MONOREPO_BUILD_SPEC,
      // The Next.js SSR build/runtime env. In-process refs / strings (D-12). DELIBERATELY:
      //   - AMPLIFY_MONOREPO_APP_ROOT = 'dashboard' (D-01 — must equal dashboard/amplify.yml appRoot, H4)
      //   - COGNITO_REGION (H2 — NOT AWS_REGION; no Amplify env key may start with AWS_)
      //   - COGNITO_REDIRECT_URI from the shared redirect-host prop (H1 — no stand-in host)
      //   - NO client secret (D-05 — PUBLIC PKCE client) and NO DB secret/host (Pattern 4 — the SSR
      //     tier never touches RDS; it only calls the public DATA_API_URL).
      environmentVariables: {
        AMPLIFY_MONOREPO_APP_ROOT: MONOREPO_APP_ROOT,
        COGNITO_REGION: props.region,
        COGNITO_USER_POOL_ID: props.userPoolId,
        COGNITO_CLIENT_ID: props.userPoolClientId,
        COGNITO_DOMAIN: props.cognitoDomain,
        COGNITO_REDIRECT_URI: props.cognitoRedirectUri,
        DATA_API_URL: props.dataApiUrl,
      },
    });

    // --- Amplify Branch (the private dashboard source branch, PRODUCTION stage) ----------------------
    this.branch = this.app.addBranch('DashboardBranch', {
      branchName: props.githubBranch,
      stage: 'PRODUCTION',
    });

    // H5 — emit DeletionPolicy: Delete EXPLICITLY. The alpha App/Branch L2s expose no `removalPolicy`
    // prop, so applyRemovalPolicy is the ONLY way the attribute is actually written to the template
    // (INFRA-04 clean single-stack teardown / T-02-22). A no-op `removalPolicy` prop would leave
    // DeletionPolicy undefined and leak the App after a "clean" cdk destroy.
    this.app.applyRemovalPolicy(RemovalPolicy.DESTROY);
    this.branch.applyRemovalPolicy(RemovalPolicy.DESTROY);
  }
}
