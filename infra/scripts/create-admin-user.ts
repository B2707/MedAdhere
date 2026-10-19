// infra/scripts/create-admin-user.ts
//
// Repeatable single-admin provisioning script (DASH-01 / SC1 / CONTEXT Q5 "Developer's Discretion").
//
// THESIS LOG NOTE: this script is run ONCE post-deploy against the LIVE Cognito pool (NOT at synth,
// NOT in CI) — it is the documented, repeatable alternative to by-hand console creation (CONTEXT Q5).
// Run it via the infra tsx runner after `cdk deploy`:
//
//     USER_POOL_ID=<pool-id> ADMIN_EMAIL=<admin@example> npm run create-admin   (from infra/)
//
// It calls Cognito AdminCreateUser for the single admin (selfSignUpEnabled is OFF on the pool — D-13,
// T-02-04, so ONLY this operator-run script can create the admin). Cognito emails a one-time
// temporary password (DesiredDeliveryMediums:['EMAIL']); the admin then completes the
// FORCE_CHANGE_PASSWORD flow at first managed-login. Re-running is safe: a UsernameExistsException is
// caught and logged, not thrown (idempotent-friendly — mirrors the actionable-error-guard idiom of
// the Phase-1 smoke/schema-init handlers).

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';

async function main(): Promise<void> {
  // Env guards — actionable `throw new Error(...)` exactly like the Phase-1 handler env guards
  // (e.g. schema-init/handler.ts's `throw new Error('DB_SECRET_ARN env var is not set')`).
  const userPoolId = process.env.USER_POOL_ID;
  if (!userPoolId) {
    throw new Error('USER_POOL_ID env var is not set');
  }
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    throw new Error('ADMIN_EMAIL env var is not set');
  }

  // Per-invoke client construction (mirrors the standalone-script idiom of backend/src/smoke). No
  // credentials are read here — the AWS SDK resolves them from the operator's ambient environment.
  const client = new CognitoIdentityProviderClient({});

  try {
    await client.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: adminEmail,
        UserAttributes: [
          { Name: 'email', Value: adminEmail },
          { Name: 'email_verified', Value: 'true' },
        ],
        // Cognito emails a one-time temporary password; the admin completes
        // FORCE_CHANGE_PASSWORD at first managed-login.
        DesiredDeliveryMediums: ['EMAIL'],
      }),
    );
    console.log(`Created admin user: ${adminEmail}`);
    console.log(
      'The admin completes the FORCE_CHANGE_PASSWORD flow at first managed-login (temporary password emailed by Cognito).',
    );
  } catch (err) {
    // Idempotent-friendly: re-running against an already-provisioned pool is a no-op, not a failure.
    if (err instanceof UsernameExistsException) {
      console.log('admin user already exists — skipping');
      return;
    }
    throw err;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
