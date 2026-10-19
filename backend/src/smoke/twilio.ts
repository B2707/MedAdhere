// backend/src/smoke/twilio.ts
//
// In-VPC app-originated Twilio SMS smoke handler (D-04 / D-15 / INFRA-07 / F45).
//
// Proves the real runtime egress path: Lambda → NAT → api.twilio.com (there is NO PrivateLink to
// Twilio — this is precisely why D-01 mandates the NAT). A non-error `status` proves the API path;
// the actual DELIVERY to the recipient's carrier is the INFRA-07 Canadian-A2P proof, confirmed by a
// human in Plan 05 (carrier filtering of A2P long-codes is the residual risk — RESEARCH Pitfall 3).
//
// F45 — runtime SSM FROM read: the Twilio FROM number is read from SSM Parameter Store AT RUNTIME
// (GetParameterCommand on TWILIO_FROM_PARAM, default "/medadhere/twilio-from"), NOT a deploy-time
// baked `TWILIO_FROM` env var. This makes the D-05 long-code → toll-free re-point a one-liner
// (`aws ssm put-parameter` + re-invoke) with NO redeploy.
//
// Credentials (accountSid / authToken) are read from Secrets Manager (TWILIO_SECRET_ARN; D-06,
// populated post-deploy via `put-secret-value`) — never hard-coded, never logged. twilio@^6 is the
// current major (RESEARCH Assumption A1 — RESOLVED 2026-06-16; ratifies the project decision record ^5 pin to ^6,
// Node-20-aligned, `messages.create()` unchanged from v5).
//
// No live Twilio call happens in this plan / in CI — the live send is gated to Plan 05.

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import twilio from 'twilio';

const sm = new SecretsManagerClient({});
const ssm = new SSMClient({});

/** Shape of the Twilio credential secret (D-06; populated post-deploy). */
interface TwilioSecret {
  accountSid: string;
  authToken: string;
}

export async function handler(): Promise<{ sid: string; status: string }> {
  const twilioSecretArn = process.env.TWILIO_SECRET_ARN;
  if (!twilioSecretArn) {
    throw new Error('TWILIO_SECRET_ARN env var is not set');
  }
  const testRecipient = process.env.TEST_RECIPIENT;
  if (!testRecipient) {
    throw new Error('TEST_RECIPIENT env var is not set');
  }

  // --- Twilio creds from Secrets Manager (with the F47 empty-secret guard) -----------------------
  const secretValue = await sm.send(
    new GetSecretValueCommand({ SecretId: twilioSecretArn }),
  );
  if (!secretValue.SecretString || secretValue.SecretString.trim() === '') {
    // F47: a clear, actionable error instead of an opaque JSON-parse crash on the placeholder secret.
    throw new Error(
      'Twilio secret not yet populated — run `aws secretsmanager put-secret-value` first (D-06)',
    );
  }
  // Post-exec review WR-02/SEC-2: the placeholder secret CDK synthesizes is a NON-EMPTY JSON object
  // (`{"placeholder":"<generated>"}`), so the empty-string guard above can never catch it. Validate the
  // actual credential keys are present — otherwise `twilio(undefined, undefined)` throws an opaque
  // error, defeating the F47 actionable-message intent.
  // WR-06: a present-but-non-JSON secret (e.g. an operator stored a raw token instead of the JSON
  // object) would otherwise throw an opaque `SyntaxError` — turn it into an actionable error naming
  // the expected shape. The raw secret is NEVER included in the message.
  let parsed: Partial<TwilioSecret>;
  try {
    parsed = JSON.parse(secretValue.SecretString) as Partial<TwilioSecret>;
  } catch {
    throw new Error(
      'Twilio secret is not valid JSON — store it as {"accountSid":"…","authToken":"…"} via `aws secretsmanager put-secret-value` (D-06)',
    );
  }
  const { accountSid, authToken } = parsed;
  if (!accountSid || !authToken) {
    throw new Error(
      'Twilio secret not yet populated (no accountSid/authToken) — run `aws secretsmanager put-secret-value` first (D-06)',
    );
  }

  // --- FROM number from SSM at RUNTIME (F45) — re-pointable without redeploy ----------------------
  const fromParamName = process.env.TWILIO_FROM_PARAM ?? '/medadhere/twilio-from';
  const fromParam = await ssm.send(
    new GetParameterCommand({ Name: fromParamName }),
  );
  const fromNumber = fromParam.Parameter?.Value;
  if (!fromNumber) {
    throw new Error(
      `Twilio FROM number SSM parameter ${fromParamName} is empty or missing`,
    );
  }

  // Egress: Lambda → NAT → api.twilio.com (no PrivateLink — D-01 mandates the NAT for this path).
  const client = twilio(accountSid, authToken);
  const msg = await client.messages.create({
    from: fromNumber, // SSM-sourced (F45 / D-15); D-05 toll-free re-point needs no redeploy
    to: testRecipient, // non-developer Canadian mobile (D-04 / D-15)
    body: 'MedAdhere smoke test — reply ignored.',
  });

  // A non-error status proves the in-VPC → NAT → Twilio API path; carrier DELIVERY (INFRA-07
  // Canadian-A2P) is confirmed by a human in Plan 05.
  return { sid: msg.sid, status: msg.status };
}
