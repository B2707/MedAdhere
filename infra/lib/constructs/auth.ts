// infra/lib/constructs/auth.ts
//
// AuthConstruct (DASH-01 / SC1 / D-05 / D-08 / D-13) — the Cognito identity foundation for the
// clinician dashboard. A standalone, per-concern resource-declaration construct (the secrets.ts
// role-match analog: no in-VPC Lambda, owns ONE concern, exposes typed `public readonly` members
// for downstream in-process refs — D-12). It is NOT wired into FoundationStack here; plan 04 (the
// integration wave) consumes `userPool` / `userPoolClient` by object reference to build the
// data-API native JWT authorizer (issuer = pool URL, jwtAudience = [clientId]) and the Amplify host.
//
// What this construct declares:
//   - UserPool: designed ONCE (D-13, RESEARCH Pitfall 4 — the marked props are create-time/immutable,
//     so a wrong value here requires a full pool rebuild). signInCaseSensitive:false (project decision record pin),
//     self sign-up OFF, email alias, ZERO custom attributes (immutable post-deploy — D-13), strong
//     12-char password policy, MFA OPTIONAL + software-token only, EMAIL_ONLY recovery, advanced
//     security OFF (cost, D-13). removalPolicy DESTROY (INFRA-04 clean single-stack teardown).
//   - Primary UserPoolClient: a PUBLIC client per D-05 — `generateSecret: false`. NO
//     confidential-client secret exists anywhere (RESEARCH Pattern 1's confidential secret-bearing
//     snippet is SUPERSEDED by D-05): a public PKCE client avoids stashing any secret in the
//     Amplify SSR env. OAuth authorization-code grant + openid/email/profile scopes.
//   - D4 auxiliary UserPoolClient: a second no-secret, non-OAuth client used only by the operator's
//     AWS CLI TOTP enrollment state machine. Explicit auth flows are limited to
//     USER_PASSWORD_AUTH + refresh; the primary PKCE client is unchanged.
//   - UserPoolDomain: Cognito managed login (D-08), a deterministic globally-unique prefix.
//
// H1 — single redirect-host source of truth (NO baked dummy/stand-in URL). The callback + sign-out
// allow-list is fed from REQUIRED redirect-host props (`amplifyCallbackUrl`, `vercelCallbackUrl`)
// plus the hardcoded `http://localhost:3000`. The Amplify default WEB_COMPUTE domain
// (`<branch>.<appId>.<region-host>`) is a non-deterministic CDK token whose appId is unknown at
// synth, so the exact-match `redirect_uri` cannot be hardcoded here — instead plan 04 passes the
// SAME host string into BOTH this allow-list AND `hosting.ts`'s `COGNITO_REDIRECT_URI` SSR env (the
// load-bearing single-source-of-truth that closes `redirect_uri_mismatch`). Because Cognito client
// callback/logout URLs are MUTABLE post-deploy, the first-deploy two-pass reconciliation (update the
// client callback from the first-deploy Amplify CfnOutput URL) is handled in plan 04 (the CfnOutput)
// + plan 05 (the explicit two-pass update step). This construct only accepts the host props and
// pre-seeds localhost + the Vercel host (D-02 — the Jun-30 fallback is a pure host-swap).
//
// M8 — the deterministic domain prefix below is reused on every redeploy and is GLOBALLY UNIQUE per
// region, so it MUST be confirmed-released before any destroy→redeploy (mirrors the SES
// delete-identity-before-redeploy hygiene, D-DEPLOY-4). The post-destroy
// `describe-user-pool-domain`-returns-none release check is enforced in plan 05.

import { Construct } from 'constructs';
import { RemovalPolicy } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';

/**
 * The Cognito managed-login domain prefix (D-08). Deterministic + globally unique per region. M8 —
 * reused on every redeploy, so it must be confirmed-released before a destroy→redeploy (enforced in
 * plan 05 via a post-destroy `describe-user-pool-domain`-returns-none check).
 */
export const COGNITO_DOMAIN_PREFIX = 'medadhere-auth';

/** The local-dev redirect host, allow-listed up front so `next dev` works without a pool change. */
const LOCALHOST_URL = 'http://localhost:3000';

export interface AuthConstructProps {
  /**
   * H1 — the Amplify redirect host (the WEB_COMPUTE default domain on the Amplify path). REQUIRED.
   * This is the SAME host string plan 04 ALSO feeds to `COGNITO_REDIRECT_URI` in hosting.ts (one
   * shared source of truth into BOTH the Cognito allow-list and the SSR env). NO baked stand-in URL.
   */
  readonly amplifyCallbackUrl: string;
  /**
   * H1 — the Vercel redirect host (the Jun-30 fallback path, D-02). REQUIRED and pre-seeded up front
   * so the fallback is a pure host-swap with no pool change (RESEARCH Pitfall 7).
   */
  readonly vercelCallbackUrl: string;
}

/**
 * Join a redirect-host base to a path, tolerating a trailing slash on the host so
 * `https://host/` + `api/auth/callback` does not yield a double slash.
 */
function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

export class AuthConstruct extends Construct {
  /** The Cognito UserPool (designed once — D-13). */
  public readonly userPool: cognito.UserPool;
  /** The PUBLIC OAuth/PKCE app client (D-05 — generateSecret:false; NO client secret anywhere). */
  public readonly userPoolClient: cognito.UserPoolClient;
  /** The D4 no-secret USER_PASSWORD_AUTH client used by the operator's TOTP CLI flow. */
  public readonly totpClient: cognito.UserPoolClient;
  /** The Cognito managed-login domain (D-08). */
  public readonly userPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: AuthConstructProps) {
    super(scope, id);

    // --- UserPool (D-13 — design ONCE; the marked props are create-time/immutable, Pitfall 4) -------
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'medadhere-clinicians',
      signInCaseSensitive: false, // project decision record pin — case-insensitive email sign-in
      selfSignUpEnabled: false, // only AdminCreateUser provisions the single admin (T-02-04)
      signInAliases: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      // ZERO custom attributes (D-13) — custom user-pool attributes are immutable post-deploy; do
      // NOT pass any. The one-admin model needs none (T-02-03 minimal attribute surface).
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      // MFA OPTIONAL + software-token (TOTP) ONLY, no SMS (D-13). Create-time-immutable (Pitfall 4) —
      // pinned by an explicit assertion in auth.test.ts (L8) so a silent regression fails the gate.
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY, // T-02-05 — no SMS recovery surface
      // Advanced security OFF (D-13) — accepted cost tradeoff for a one-admin research-grade target;
      // do NOT enable `advancedSecurityMode`.
      removalPolicy: RemovalPolicy.DESTROY, // INFRA-04 — clean single-stack teardown (D-12)
    });

    // --- UserPoolClient (D-05 — PUBLIC PKCE client; NO client secret) -------------------------------
    // H1 — the callback + logout allow-lists are built from the REQUIRED redirect-host props plus the
    // hardcoded localhost. Each host needs a callback path (`/api/auth/callback`) and a sign-out path
    // (`/`). The exact Amplify-host value is reconciled post-first-deploy in plan 04/05 (Cognito
    // callback URLs are mutable post-deploy); this just pre-seeds all three hosts up front (Pitfall 7).
    const callbackUrls = [
      joinUrl(props.amplifyCallbackUrl, 'api/auth/callback'),
      joinUrl(props.vercelCallbackUrl, 'api/auth/callback'),
      joinUrl(LOCALHOST_URL, 'api/auth/callback'),
    ];
    const logoutUrls = [
      joinUrl(props.amplifyCallbackUrl, ''),
      joinUrl(props.vercelCallbackUrl, ''),
      joinUrl(LOCALHOST_URL, ''),
    ];

    this.userPoolClient = new cognito.UserPoolClient(this, 'Client', {
      userPool: this.userPool,
      userPoolClientName: 'medadhere-dashboard',
      generateSecret: false, // D-05 — the load-bearing PUBLIC-client flag; NO client secret anywhere
      // OAuth authorization-code grant + PKCE (the hand-rolled flow always sends `code_verifier`
      // itself, D-08 — Cognito is not relied on to enforce PKCE). The userSrp auth flow is NOT used
      // (this is the managed-login OAuth redirect flow, not a direct SRP login).
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls,
      },
      preventUserExistenceErrors: true, // T-02 — do not leak which accounts exist
    });

    // --- D4 auxiliary client (operator-only AWS CLI TOTP enrollment) -----------------------------
    // AWS CLI cannot execute SRP because it cannot compute SRP_A. This second PUBLIC client enables
    // the runbook's USER_PASSWORD_AUTH challenge state machine without changing the dashboard PKCE
    // client above. Supplying authFlows explicitly makes the CFN contract exactly password + refresh
    // (CDK automatically includes ALLOW_REFRESH_TOKEN_AUTH unless refresh-token rotation is enabled).
    this.totpClient = new cognito.UserPoolClient(this, 'TotpClient', {
      userPool: this.userPool,
      userPoolClientName: 'medadhere-totp-cli',
      generateSecret: false,
      authFlows: { userPassword: true },
      disableOAuth: true,
      preventUserExistenceErrors: true,
    });

    // --- UserPoolDomain (D-08 — Cognito managed login) ---------------------------------------------
    // M8 — COGNITO_DOMAIN_PREFIX is deterministic + globally unique per region; release-before-redeploy
    // obligation documented at the top of this file (enforced in plan 05).
    this.userPoolDomain = new cognito.UserPoolDomain(this, 'Domain', {
      userPool: this.userPool,
      cognitoDomain: { domainPrefix: COGNITO_DOMAIN_PREFIX },
      // Managed Login v2 (user decision 2026-07-31): modern login page, $0 on the Essentials tier
      // (pool already Essentials — CDK default).
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // --- ManagedLoginBranding (F-gap, found 2026-08-14) --------------------------------------------
    // Managed login v2 serves "Login pages unavailable" for an app client that has no branding style,
    // and CreateUserPoolClient (unlike the console) creates none — so every fresh deploy had broken
    // sign-in until an operator ran create-managed-login-branding by hand. L1 (no L2 exists);
    // useCognitoProvidedValues:true is the default Cognito look and REQUIRES omitting settings/assets.
    // Ordered after the domain, which is the prerequisite that carries the managed-login version.
    const branding = new cognito.CfnManagedLoginBranding(this, 'DashboardBranding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.userPoolClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    branding.node.addDependency(this.userPoolDomain);
  }
}
