// backend/src/smoke/anthropic.ts
//
// In-VPC Anthropic Messages-API forced-tool smoke handler (D-ANTHROPIC / D-16 / INFRA-06 / SC3).
//
// This is the live classifier-backend smoke handler: it invokes Claude Haiku 4.5 via the Anthropic
// Messages API direct (D-ANTHROPIC — the sole classifier backend). The live LLM round-trip (Phase-1
// SC3) is proven against api.anthropic.com. It forces a single tool call carrying the two-axis +
// safety_flag classification and runs the `.parse()` D-16 contract gate. We do NOT re-declare the
// schema (D-16 mandates @medadhere/shared is the SSOT); the import also exercises the F12 build-less
// `exports` resolution under `tsc --noEmit`.
//
// The pure logic — building the forced Messages-API tool inputs and the `.parse()` contract gate —
// is factored into the exported helpers `buildAnthropicToolConfig` / `parseToolUseOrThrow` so the
// network-free / creds-free / API-key-free unit test (anthropic.test.ts) can exercise the contract
// with NO live call (CI-safe). The LIVE Messages API call runs only when the deployed Lambda is
// invoked — gated to a follow-up the user runs with the real key. No live call happens at import
// time or in CI.

import Anthropic from '@anthropic-ai/sdk';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type { AdherenceClassification } from '@medadhere/shared';

// Phase-4 (04-03, audit MED-10): the forced-tool helpers were PROMOTED to the production
// classifier core — backend/src/classifier/classify.ts is now the ONE place the Messages-API
// wire shape is written (tools[].input_schema + strict:true + tool_choice:{type:'tool',name}).
// This smoke module re-imports them (never a copy) and re-exports by name so its existing
// consumers/tests keep their import path. Note: buildAnthropicToolConfig now carries
// `strict: true` — the W0.4 live smoke re-run is exactly the U-22 strict-schema check.
import {
  buildAnthropicToolConfig,
  parseToolUseOrThrow,
  TOOL_NAME,
  MODEL_ID,
} from '../classifier/classify';
export { buildAnthropicToolConfig, parseToolUseOrThrow, TOOL_NAME, MODEL_ID };

/** Fixed non-PII exemplar reply (T-03-04: synthetic string, never patient data). */
const EXEMPLAR_REPLY = 'took half cuz my stomach hurt';

const SYSTEM_PROMPT =
  `You classify a single patient SMS reply about a medication dose. ` +
  `Call the ${TOOL_NAME} tool exactly once with the structured classification. Never reply in prose.`;

/** Shape of the Anthropic credential secret (medadhere/anthropic; populated post-deploy via
 *  `put-secret-value` as `{"apiKey":"sk-ant-…"}`). The key value is NEVER logged. */
interface AnthropicSecret {
  apiKey: string;
}

// Reuse the Secrets Manager client across warm invocations (module scope → fewer TLS handshakes).
// The Anthropic client CANNOT be module-scoped: the API key is fetched per-invoke from Secrets
// Manager and is never an env var (D-ANTHROPIC) — so we construct `new Anthropic({ apiKey })` inside
// the handler after the secret read, mirroring twilio.ts's per-invoke secret read.
const sm = new SecretsManagerClient({});

/**
 * Lambda entry point (LIVE — invoked only by the deployed in-VPC smoke Lambda). Reads the Anthropic
 * API key from Secrets Manager, issues a forced-tool Messages call to Haiku 4.5 over the NAT egress
 * path (Lambda → NAT → api.anthropic.com), asserts the response parses into the canonical
 * `AdherenceClassification` (D-16), and returns the parsed classification
 * plus Anthropic's `{ input_tokens, output_tokens }` usage (the SC3 proof).
 */
export async function handler(): Promise<{
  ok: true;
  classification: AdherenceClassification;
  usage: Anthropic.Usage;
}> {
  const anthropicSecretArn = process.env.ANTHROPIC_SECRET_ARN;
  if (!anthropicSecretArn) {
    throw new Error('ANTHROPIC_SECRET_ARN env var is not set');
  }

  // --- Anthropic API key from Secrets Manager (with the F47 empty-secret guard) -------------------
  const secretValue = await sm.send(
    new GetSecretValueCommand({ SecretId: anthropicSecretArn }),
  );
  if (!secretValue.SecretString || secretValue.SecretString.trim() === '') {
    // A clear, actionable error instead of an opaque JSON-parse crash on the placeholder secret.
    throw new Error(
      'Anthropic secret not yet populated — run `aws secretsmanager put-secret-value` first (D-ANTHROPIC)',
    );
  }
  // The placeholder secret CDK synthesizes is a NON-EMPTY JSON object (`{"placeholder":"<generated>"}`),
  // so the empty-string guard above can never catch it. Validate the actual `apiKey` is present —
  // otherwise `new Anthropic({ apiKey: undefined })` falls back to the env/opaque error, defeating the
  // actionable-message intent. The key value is NEVER logged.
  // WR-06: a present-but-non-JSON secret (e.g. an operator stored the raw `sk-ant-…` key instead of
  // `{"apiKey":"sk-ant-…"}`) would otherwise throw an opaque `SyntaxError` — turn it into an actionable
  // error naming the expected shape. The raw secret is NEVER included in the message.
  let parsed: Partial<AnthropicSecret>;
  try {
    parsed = JSON.parse(secretValue.SecretString) as Partial<AnthropicSecret>;
  } catch {
    throw new Error(
      'Anthropic secret is not valid JSON — store it as {"apiKey":"sk-ant-…"} via `aws secretsmanager put-secret-value` (D-ANTHROPIC)',
    );
  }
  const { apiKey } = parsed;
  if (!apiKey) {
    throw new Error(
      'Anthropic secret not yet populated (no apiKey) — run `aws secretsmanager put-secret-value` first (D-ANTHROPIC)',
    );
  }

  // Egress: Lambda → NAT → api.anthropic.com (no PrivateLink to Anthropic — mirrors the Twilio NAT
  // path). Fit the SDK to the 30s Lambda budget:
  // the SDK default is a 10-min per-attempt timeout + 2 retries, so a degraded API would be hard-killed
  // by the Lambda as an opaque "Task timed out". IN-06: a 25s timeout with maxRetries:1 is up to ~50s
  // of SDK wall-clock (a timed-out first attempt + a full retry), which still exceeds the 30s Lambda
  // timeout — so use maxRetries:0: a SINGLE 25s attempt fits cleanly under 30s and surfaces a clean
  // APIConnectionTimeoutError/RateLimitError instead of an opaque Lambda hard-kill.
  const client = new Anthropic({ apiKey, timeout: 25_000, maxRetries: 0 });
  const res = await client.messages.create({
    model: MODEL_ID,
    max_tokens: 512,
    // temperature:0 for a deterministic single-tool smoke.
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: EXEMPLAR_REPLY }],
    ...buildAnthropicToolConfig(),
  });

  const classification = parseToolUseOrThrow(res);

  return {
    ok: true,
    classification,
    usage: res.usage,
  };
}
