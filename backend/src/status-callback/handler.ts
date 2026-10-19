// backend/src/status-callback/handler.ts
//
// The in-VPC Twilio delivery-status callback Lambda (SC7) — the SOLE auth on the public status route.
// Twilio POSTs a delivery-status update for a previously-sent message; this handler authenticates it
// with an in-handler HMAC-SHA1 (twilio.validateRequest), then advances outbound_message.status
// forward-only by status-rank:
//
//   Twilio (internet) → API GW HTTP API v2 (no platform-side gatekeeper — see the construct) → THIS Lambda
//     → twilio.validateRequest(authToken, X-Twilio-Signature, exact env URL, FULL params)  [HIGH-1]
//     → forward-only rank-guarded UPDATE outbound_message SET status, status_updated_at      [SC7]
//
// HIGH-1 (signature validation on the public route). Twilio carries no platform bearer credential
// (resolved default 3); the SOLE auth is the in-handler HMAC over the posted form. Two load-bearing
// details make that auth pass for a REAL callback behind API Gateway:
//   1. API Gateway v2 base64-encodes form-encoded request bodies, so when event.isBase64Encoded is
//      true we MUST base64-decode event.body BEFORE parsing — feeding the raw base64 to URLSearchParams
//      parses garbage and 403s every real callback.
//   2. twilio.getExpectedTwilioSignature sorts ALL posted params alphabetically and appends them to the
//      URL before the HMAC, so validateRequest MUST receive the FULL param set (every Twilio form
//      field), NOT a {MessageSid,MessageStatus,ErrorCode} subset — a subset produces a different digest
//      and 403s every real callback.
// We validate against the exact fragment-free env-pinned STATUS_CALLBACK_URL, NOT a URL rebuilt from
// the Host header. The Outbound callback URL adds Twilio connection overrides in a fragment, which
// Twilio excludes from signature computation. On signature failure: 403 with NO DB write (T-03-03).
//
// SC7 monotonicity. Twilio does NOT guarantee callback ordering (a `delivered` can arrive before
// `sent`). The UPDATE is rank-guarded so a late lower-ranked callback matches zero rows and never rolls
// the status backward (T-03-04). The rank map (STATUS_RANK) is imported from @medadhere/shared (Plan
// 01) — the single source of truth shared with the in-memory mirror — never redefined here.
//
// Module mode: CommonJS (F11) — `__dirname` + `readFileSync` resolve natively under NodeNext, so the
// bundled CA PEM (copied alongside this handler by the CDK afterBundling cp) is read directly at module
// scope. This is an API GW HTTP-integration handler — it accepts the API GW v2 proxy `event` (with
// event.body / event.isBase64Encoded / event.headers) and returns the plain { statusCode, headers, body }
// shape (NOT an aws-lambda custom-resource event type).
//
// Single-source TLS (F28) + CA pinning (M-2): the shared db-pool provider supplies ONE explicit pg
// `ssl` object `{ ca: <pinned RDS global bundle>, rejectUnauthorized: true }`. NEVER
// rejectUnauthorized:false, NEVER a PGSSLMODE env. The Twilio authToken is read from the SAME
// medadhere/twilio Secrets Manager secret as the send path (D-06) — never env, never logged.

import { createHash } from 'node:crypto';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';
import twilio from 'twilio';
import { STATUS_RANK, STORED_STATUS_RANK_SQL_CASE, type OutboundStatus } from '@medadhere/shared';
import { createDbPoolProvider } from '../shared/db-pool';

/** Reuse the Secrets Manager client across warm invocations (module scope → fewer TLS handshakes). */
const sm = new SecretsManagerClient({});
const lambda = new LambdaClient({});

const getPool = createDbPoolProvider(sm);

/** Shape of the Twilio credential secret (D-06; populated post-deploy). Only authToken is read here. */
interface TwilioSecret {
  accountSid: string;
  authToken: string;
}

/**
 * The API GW v2 HTTP-proxy event shape this handler consumes. Twilio POSTs a urlencoded form body that
 * API Gateway v2 base64-encodes (isBase64Encoded=true), with the HMAC signature in the
 * `X-Twilio-Signature` header (API GW may lowercase header keys, so we look it up case-insensitively).
 */
interface ApiGatewayProxyEventV2 {
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
  rawQueryString?: string;
}

/** The API GW HTTP-integration response shape (the data-api/handler.ts shape). */
interface HttpResult {
  statusCode: number;
  headers: { 'content-type': string };
  body: string;
}

/**
 * Build (or return the cached) module-scoped pg.Pool. Cloned VERBATIM from data-api/handler.ts: the DB
 * credential is fetched from Secrets Manager (D-06 — never an env var) ONCE per cold container; the
 * connection env vars are guarded with actionable errors; TLS is single-sourced (F28) via the explicit
 * `ssl` object with the pinned RDS global CA bundle + rejectUnauthorized:true (M-2 / T-03-08).
 */

/**
 * Read the Twilio authToken from the SAME medadhere/twilio Secrets Manager secret as the send path.
 * Reuses the smoke/twilio.ts F47/WR-06/WR-02 parse-and-guard block verbatim — only authToken is needed
 * for validateRequest, but the full creds shape is validated so a misconfigured secret surfaces an
 * actionable error rather than handing `undefined` to the HMAC (which would 403 every callback).
 */
async function getAuthToken(): Promise<string> {
  const twilioSecretArn = process.env.TWILIO_SECRET_ARN;
  if (!twilioSecretArn) {
    throw new Error('TWILIO_SECRET_ARN env var is not set');
  }
  const secretValue = await sm.send(new GetSecretValueCommand({ SecretId: twilioSecretArn }));
  if (!secretValue.SecretString || secretValue.SecretString.trim() === '') {
    // F47: a clear, actionable error instead of an opaque JSON-parse crash on the placeholder secret.
    throw new Error(
      'Twilio secret not yet populated — run `aws secretsmanager put-secret-value` first (D-06)',
    );
  }
  // WR-06: a present-but-non-JSON secret must surface an actionable shape-naming error. The raw secret
  // is NEVER included in the message.
  let parsed: Partial<TwilioSecret>;
  try {
    parsed = JSON.parse(secretValue.SecretString) as Partial<TwilioSecret>;
  } catch {
    throw new Error(
      'Twilio secret is not valid JSON — store it as {"accountSid":"…","authToken":"…"} via `aws secretsmanager put-secret-value` (D-06)',
    );
  }
  // WR-02: guard the key so we never hand twilio.validateRequest an undefined authToken.
  const { authToken } = parsed;
  if (!authToken) {
    throw new Error(
      'Twilio secret not yet populated (no authToken) — run `aws secretsmanager put-secret-value` first (D-06)',
    );
  }
  return authToken;
}

/** The known Twilio MessageStatus values STATUS_RANK covers — narrows the inbound status safely. */
function isOutboundStatus(value: string): value is OutboundStatus {
  return value in STATUS_RANK;
}

/**
 * Case-insensitive header lookup (API GW v2 may lowercase header keys; the SDK header is X-Twilio-Signature).
 */
function header(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

const CALLBACK_QUERY_PATTERN = /^callbackToken=([A-Za-z0-9_-]{43})$/;

/** Accept only the exact canonical query emitted by Outbound; reject decoding aliases/ambiguity. */
function parseCallbackToken(rawQueryString: string): string | null {
  return CALLBACK_QUERY_PATTERN.exec(rawQueryString)?.[1] ?? null;
}

async function recoverCheckInLifecycle(outboundMessageId: string): Promise<void> {
  const outboundFnArn = process.env.OUTBOUND_FN_ARN;
  if (!outboundFnArn) throw new Error('OUTBOUND_FN_ARN env var is not set');
  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: outboundFnArn,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify({ outboundMessageId }), 'utf8'),
    }),
  );
  if (
    response.FunctionError ||
    typeof response.StatusCode !== 'number' ||
    response.StatusCode < 200 ||
    response.StatusCode >= 300
  ) {
    throw new Error('check-in lifecycle recovery did not complete');
  }
}

/** De-identified structured metric line (metric/error/count fields only). */
function logMetric(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

/** The terminal delivery-FAILURE statuses (non-response != non-delivery). */
const TERMINAL_FAILURE_STATUSES: ReadonlySet<string> = new Set(['undelivered', 'failed']);
/** OPS-02 (f): alarm when a patient's most-recent run of delivery failures reaches this length. */
const CONSECUTIVE_UNDELIVERED_THRESHOLD = 2;
/** Bounded lookback — inspect at most this many recent messages for the leading failure run. */
const RECENT_MESSAGE_LOOKBACK = 10;

/**
 * OPS-02 (f) derivation: after a message reaches a terminal FAILURE status, count the patient's
 * leading run of consecutive undelivered/failed messages (most-recent first). At >= the threshold,
 * emit the canonical de-identified `consecutive_undelivered` metric line MonitoringConstruct alarms on
 * (Plan 05-04). It includes only the streak count, never any patient/message identifier. The callback
 * Lambda has DB access, so the derivation lives here rather than requiring a second query surface.
 *
 * Only rows that actually reached the provider participate: accepted sends carry sent_at, and a
 * definitive synchronous Twilio rejection carries callback_token_hash (stamped at claim, before
 * the provider call) with a terminal failure status but NO sent_at — both are real delivery
 * evidence. A suppressed record-only or consent-terminalized row (marked 'failed' without ever
 * being claimed for Twilio) has neither, says nothing about deliverability, and must neither
 * page the delivery alarm nor break a real streak.
 */
async function checkConsecutiveUndelivered(db: Pool, patientId: string): Promise<void> {
  const recent = await db.query(
    `SELECT status FROM outbound_message
      WHERE patient_id = $1
        AND (sent_at IS NOT NULL
             OR (callback_token_hash IS NOT NULL AND status IN ('failed', 'undelivered')))
      ORDER BY created_at DESC, sent_at DESC NULLS LAST
      LIMIT $2`,
    [patientId, RECENT_MESSAGE_LOOKBACK],
  );
  let streak = 0;
  for (const row of recent.rows as Array<{ status: string }>) {
    if (TERMINAL_FAILURE_STATUSES.has(row.status)) streak += 1;
    else break; // the leading run ends at the first non-failure (most-recent-first order)
  }
  if (streak >= CONSECUTIVE_UNDELIVERED_THRESHOLD) {
    logMetric({ metric: 'consecutive_undelivered', consecutiveCount: streak });
  }
}

/**
 * Twilio delivery-status callback entrypoint. Decode → full-param → validate → forward-only advance.
 *
 * @returns the API GW HTTP-integration response shape — empty 200 on success/stale input, empty 403
 *          on signature failure, or empty retryable 503 when a valid SID is not durable yet / DB fails.
 */
export async function handler(event: ApiGatewayProxyEventV2): Promise<HttpResult> {
  // --- HIGH-1: decode the body BEFORE parsing -----------------------------------------------------
  // API GW v2 base64-encodes form-encoded bodies, so a real Twilio callback ALWAYS hits the decode
  // branch. Feeding the raw base64 to URLSearchParams parses garbage and 403s every real callback.
  // We handle both branches so mocked/plaintext tests work too.
  const rawBody = event?.body ?? '';
  const decodedBody = event?.isBase64Encoded
    ? Buffer.from(rawBody, 'base64').toString('utf8')
    : rawBody;

  // --- HIGH-1: build the FULL param object (every posted field) -----------------------------------
  // validateRequest's getExpectedTwilioSignature sorts ALL params alphabetically onto the URL before
  // the HMAC, so we must pass the COMPLETE set — NOT a hand-picked subset.
  const params = new URLSearchParams(decodedBody);
  const fullParams: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    fullParams[key] = value;
  }

  const signature = header(event?.headers, 'x-twilio-signature') ?? '';

  // --- Authenticate: in-handler HMAC over the EXACT env-pinned URL (the ONLY auth on this route) ---
  const statusCallbackUrl = process.env.STATUS_CALLBACK_URL;
  if (!statusCallbackUrl) {
    throw new Error('STATUS_CALLBACK_URL env var is not set');
  }
  const authToken = await getAuthToken();
  const rawQueryString = event?.rawQueryString ?? '';
  const signedCallbackUrl = rawQueryString
    ? `${statusCallbackUrl}?${rawQueryString}`
    : statusCallbackUrl;
  // Pitfall 2 — validate against the env-pinned exact URL, NOT a Host-header-reconstructed one, and
  // pass the FULL decoded param set (HIGH-1). On failure: 403, NO DB write (Spoofing mitigation).
  const valid = twilio.validateRequest(authToken, signature, signedCallbackUrl, fullParams);
  if (!valid) {
    return { statusCode: 403, headers: { 'content-type': 'text/plain' }, body: '' };
  }

  // --- SC7: forward-only rank-guarded status advance ----------------------------------------------
  // Read the message identity + new status FROM the validated full param object (never trust unparsed
  // input). An unknown/missing MessageStatus is ignored with a 200 so Twilio does not retry endlessly.
  const messageSid = fullParams.MessageSid ?? fullParams.SmsSid;
  const newStatusRaw = fullParams.MessageStatus ?? fullParams.SmsStatus;
  if (!messageSid || !newStatusRaw || !isOutboundStatus(newStatusRaw)) {
    return { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: '' };
  }
  const newStatus: OutboundStatus = newStatusRaw;

  // Parse correlation only after the HMAC succeeds. The raw token is never stored or logged; only its
  // SHA-256 digest crosses the database boundary.
  const callbackToken = parseCallbackToken(rawQueryString);
  if (!callbackToken) {
    return { statusCode: 403, headers: { 'content-type': 'text/plain' }, body: '' };
  }
  const callbackTokenHash = createHash('sha256').update(callbackToken).digest();

  try {
    const db = await getPool();
    // Forward-only: the UPDATE matches only when the incoming rank STRICTLY exceeds the stored rank,
    // so a late lower-ranked callback (e.g. `sent` after `delivered`) matches zero rows and never rolls
    // back (Pitfall 1 / T-03-04). MessageSid is parameterized — never interpolated (T-03-05).
    //
    // H-02: the CASE is GENERATED from STORED_STATUS_RANK, not hand-mirrored. The hand-written copy
    // listed only the four Twilio statuses, so every STORED-only status (notably `sending_unknown`)
    // fell through `ELSE 4` and tied the terminal rank — a later delivered/failed callback for an
    // accepted-but-ack-lost send was silently dropped and the row stranded. The generated fragment
    // gives every below-terminal status its own branch, so `ELSE` now only catches the three real
    // terminals.
    const advanced = await db.query(
      `WITH target AS MATERIALIZED (
         SELECT id, twilio_sid, (twilio_sid IS NULL) AS newly_bound
           FROM outbound_message
          WHERE callback_token_hash = $4
          FOR UPDATE
       )
       UPDATE outbound_message om
          SET twilio_sid = COALESCE(om.twilio_sid, $2),
              sent_at = COALESCE(om.sent_at, om.status_updated_at, now()),
              status = CASE
                WHEN $3 > (${STORED_STATUS_RANK_SQL_CASE}) THEN $1
                ELSE om.status
              END,
              status_updated_at = CASE
                WHEN $3 > (${STORED_STATUS_RANK_SQL_CASE}) THEN now()
                ELSE om.status_updated_at
              END
         FROM target
        WHERE om.id = target.id
          AND (
            target.twilio_sid = $2
            OR (
              target.twilio_sid IS NULL
              AND om.status IN ('sending', 'sending_unknown')
            )
          )
          AND NOT EXISTS (
            SELECT 1
              FROM outbound_message other
             WHERE other.twilio_sid = $2
               AND other.id <> target.id
          )
      RETURNING om.id, om.patient_id, om.message_kind, target.newly_bound`,
      [newStatus, messageSid, STATUS_RANK[newStatus], callbackTokenHash],
    );

    const advancedRow = advanced.rows[0] as
      | { id: string; patient_id: string; message_kind: string; newly_bound: boolean }
      | undefined;
    if (!advancedRow) {
      // A valid provider HMAC is not sufficient to mutate an unrelated row: a token/SID mismatch,
      // already-bound different SID, or unknown token fails closed and is not retried.
      return { statusCode: 403, headers: { 'content-type': 'text/plain' }, body: '' };
    }

    // A callback can be the only durable proof that an ack-lost check-in was accepted. Invoke the
    // existing Outbound Lambda synchronously so it recreates deterministic timeout/reminder schedules.
    // Re-run this on same-token/SID retries too: schedule-name conflicts are treated as idempotent
    // success downstream, while a failed first invoke gets another chance via Twilio's 5xx retry.
    if (advancedRow.message_kind === 'check_in') {
      await recoverCheckInLifecycle(advancedRow.id);
    }

    // OPS-02 (f): ONLY when this callback actually advanced a row to a terminal FAILURE status do we
    // derive the consecutive-undelivered signal. Best-effort — a derivation failure NEVER 5xxes the
    // webhook (a Twilio retry would dead-end on the rank guard and re-run this pointlessly).
    if (advancedRow && TERMINAL_FAILURE_STATUSES.has(newStatus)) {
      try {
        await checkConsecutiveUndelivered(db, advancedRow.patient_id);
      } catch (err: unknown) {
        logMetric({
          metric: 'consecutive_undelivered_check_failed',
          errorName: err instanceof Error ? err.name : 'unknown',
        });
      }
    }
  } catch {
    // Empty response: retryable for Twilio, without leaking the SID, patient data, or DB details.
    return { statusCode: 503, headers: { 'content-type': 'text/plain' }, body: '' };
  }

  // Twilio expects an empty 200 acknowledgement.
  return { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: '' };
}
