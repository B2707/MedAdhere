// backend/src/classifier/classify.ts
//
// The PURE classifier core (Plan 04-03, gate fix U-23) + the PROMOTED Anthropic forced-tool
// helpers (audit MED-10: `buildAnthropicToolConfig` / `parseToolUseOrThrow` / TOOL_NAME /
// MODEL_ID moved HERE from smoke/anthropic.ts, which now re-imports them — production code
// never imports from smoke/, and there is exactly ONE place the wire shape is written).
//
// `classifyReplyText(rawBody, { apiKey })` is shared VERBATIM by the Lambda handler and the
// eval harness (`backend/eval/run-eval.ts`) — only key acquisition differs (per-invoke Secrets
// Manager read in the handler vs an injected key in the eval). PURITY CONTRACT (U-23): no DB,
// no Twilio, no EventBridge, no Secrets Manager in this module — the eval must never send SMS,
// and a test pins the import list.
//
// U-26 PINNED retry budget (supersedes "re-derived"): SDK `maxRetries: 2` (= 3 total attempts,
// ROADMAP SC4 "retry ×3"; exponential backoff + jitter built in), per-attempt
// `timeout: 25_000` ms. Arithmetic: 120 s Lambda − ~15 s headroom (secret read + DB I/O)
// ≈ 105 s budget ÷ 3 attempts = 35 s ceiling per attempt; 25 s + worst-case backoff
// (~1 s + ~2 s + jitter) + a modest `retry-after` allowance fits with margin. The smoke's
// `maxRetries: 0` is smoke-only (30 s Lambda) and is NOT inherited. The SDK honors server
// `retry-after` within its own bounded backoff; anything that still exceeds the budget
// surfaces as a per-attempt timeout → transient → the handler's SC4 terminal policy.
//
// Failure taxonomy (04-AI-SPEC split failure paths — typed, never conflated):
//   ClassifyTransientError — 429 / 5xx / connection / per-attempt timeout AFTER SDK retries.
//   ClassifyAuthError      — 401 (revoked key / credit exhaustion): will not heal on retry;
//                            the handler emits the distinct anthropic_auth_failure metric.
//   ClassifyContractError  — non-tool_use stop, missing block, or ZodError from .parse().
//                            Carries the RAW tool_use input (the U-11 safety-salvage seam:
//                            04-04 shallow-reads safety_flag from it before falling to unknown)
//                            plus a PII-safe issueSummary (paths + codes ONLY — U-16: received
//                            values can echo reply-influenced model output).

import Anthropic from '@anthropic-ai/sdk';
import {
  AdherenceClassification,
  adherenceClassificationJsonSchema,
  PREFILTER_MAX_CHARS,
} from '@medadhere/shared';
import { PROMPT_TOOL_NAME, PROMPT_VERSION, effectiveSystemPrompt } from './prompt';

/**
 * The single forced tool the model must call (never `tool_choice: "auto"`). ONE literal:
 * prompt.ts owns it (the prompt text names the tool) and this module re-exports it as the
 * promoted wire-contract name — a rename can never desync the prompt from the forced tool
 * (code-review LOW fix, 2026-07-03).
 */
export const TOOL_NAME = PROMPT_TOOL_NAME;

/** Anthropic Haiku 4.5 — the BARE Messages-API id (env-overridable; IN-02 wires it in CDK). */
export const MODEL_ID = process.env.ANTHROPIC_MODEL_ID ?? 'claude-haiku-4-5-20251001';

/** U-26 pinned budget — see the header arithmetic. Adjacent to the client construction below. */
export const CLASSIFY_MAX_RETRIES = 2; // 3 total attempts = SC4 "retry ×3"
export const CLASSIFY_ATTEMPT_TIMEOUT_MS = 25_000;

/** The Messages-API tool inputs the callers spread into `messages.create`. */
interface AnthropicToolConfig {
  tools: Array<{
    name: string;
    description: string;
    input_schema: Anthropic.Tool.InputSchema;
    strict: boolean;
  }>;
  tool_choice: { type: 'tool'; name: string };
}

/**
 * Build the forced-tool inputs in the Anthropic Messages-API shape (snake_case `input_schema`;
 * `tool_choice:{type:'tool',name}` FORCES the call). The `input_schema` is the self-contained
 * (`$refStrategy:'none'`) schema generated in @medadhere/shared — the SSOT, reused verbatim.
 *
 * `strict: true` (Plan 04-03 addition over the smoke): server-side enforcement of the
 * input_schema. Exercised LIVE once at W0.4 (gate fix U-22 — zod-to-json-schema may emit a
 * stray top-level `$schema` key strict could reject); fallback = drop `strict`, the `.parse()`
 * D-16 gate below remains the guarantee.
 */
export function buildAnthropicToolConfig(): AnthropicToolConfig {
  return {
    tools: [
      {
        name: TOOL_NAME,
        description: 'Record the structured adherence classification for one patient SMS reply.',
        input_schema: adherenceClassificationJsonSchema as unknown as Anthropic.Tool.InputSchema,
        strict: true,
      },
    ],
    tool_choice: { type: 'tool', name: TOOL_NAME },
  };
}

/** Minimal structural view of an Anthropic Messages response — satisfied by the real `Message`. */
interface MessagesResponseLike {
  stop_reason?: string | null;
  content?: Array<{ type?: string; name?: string; input?: unknown; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Haiku 4.5 list pricing (USD per Mtok) — the thesis cost line cites these exact constants. */
export const HAIKU_INPUT_USD_PER_MTOK = 1;
export const HAIKU_OUTPUT_USD_PER_MTOK = 5;

/**
 * One per-call telemetry record — the thesis latency/cost dataset + runtime budget tracking.
 * PII-free by construction: token counts, timing, and version identifiers only — never reply
 * text or model output (safe to log verbatim, same discipline as ContractIssueSummary/U-16).
 */
export interface ClassifyUsage {
  readonly model: string;
  readonly promptVersion: string;
  /** Wall-clock duration of the messages.create call (all SDK attempts included). */
  readonly latencyMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** List-price estimate; present iff both token counts arrived on the response. */
  readonly estimatedCostUsd?: number;
}

/**
 * The D-16 contract gate. Require `stop_reason === "tool_use"` and the FORCED tool's block with
 * a present `.input`, then `AdherenceClassification.parse(...)` — which THROWS on enum drift or
 * missing fields. No silent prose acceptance; the untrusted `block.input` is never trusted
 * before `.parse()` (T-03-02). Thrown errors here are mapped to ClassifyContractError by
 * classifyReplyText (the smoke handler keeps the raw throw — its 30 s path surfaces it as-is).
 */
export function parseToolUseOrThrow(res: MessagesResponseLike): AdherenceClassification {
  if (res.stop_reason !== 'tool_use') {
    throw new Error(
      `Anthropic did not call the tool: stop_reason=${res.stop_reason ?? 'undefined'} (expected "tool_use")`,
    );
  }
  const toolUseBlock = res.content?.find((b) => b.type === 'tool_use' && b.name === TOOL_NAME);
  if (!toolUseBlock || toolUseBlock.input === undefined) {
    throw new Error(
      `Anthropic response had no "${TOOL_NAME}" tool_use block with an input to parse`,
    );
  }
  return AdherenceClassification.parse(toolUseBlock.input);
}

/** PII-safe ZodError view: paths + codes ONLY (U-16 — never messages/received values). */
export interface ContractIssueSummary {
  readonly path: string;
  readonly code: string;
}

function summarizeZodIssues(error: unknown): ContractIssueSummary[] | null {
  if (!(error instanceof Error) || error.name !== 'ZodError' || !('issues' in error)) return null;
  const issues = (error as { readonly issues?: unknown }).issues;
  if (!Array.isArray(issues)) return null;
  return issues.flatMap((issue) => {
    if (
      typeof issue !== 'object' ||
      issue === null ||
      !('path' in issue) ||
      !Array.isArray(issue.path) ||
      !('code' in issue) ||
      typeof issue.code !== 'string'
    ) {
      return [];
    }
    return [{ path: issue.path.map(String).join('.'), code: issue.code }];
  });
}

/** Transient API failure after the SDK's own retries — the handler writes unknown + success. */
export class ClassifyTransientError extends Error {
  override readonly name = 'ClassifyTransientError';
}

/** 401 — revoked key / credit exhaustion. Distinct stop-the-line signal (anthropic_auth_failure). */
export class ClassifyAuthError extends Error {
  override readonly name = 'ClassifyAuthError';
}

/** Contract failure — carries the raw tool input for the U-11 safety salvage + U-16 summary. */
export class ClassifyContractError extends Error {
  override readonly name = 'ClassifyContractError';
  constructor(
    message: string,
    /** The raw, UNVALIDATED tool_use input (undefined when no block existed). 04-04 shallow-reads
     *  safety_flag from it — fail-open on safety, fail-closed on the label. */
    public readonly rawToolInput: unknown,
    /** Paths + codes only (U-16) — safe to log verbatim. */
    public readonly issueSummary: readonly ContractIssueSummary[],
  ) {
    super(message);
  }
}

export interface ClassifyOptions {
  /** The Anthropic API key — per-invoke Secrets Manager read (handler) or injected (eval, U-23). */
  readonly apiKey: string;
  /**
   * Optional per-call telemetry sink. Fires whenever a Messages response ARRIVED — including
   * contract failures (those calls consumed tokens too; excluding them would undercount the
   * thesis cost data) — and never on transport failures (no response = no usage to report).
   * The core stays pure (U-23): the callback is the seam; the handler logs it, the eval
   * aggregates it. A throwing callback is caught and dropped — observability must never
   * block the patient-reply classification path (deliberate, documented exception to the
   * no-swallowed-errors rule).
   */
  readonly onUsage?: (usage: ClassifyUsage) => void;
  /**
   * Optional system-prompt appendix (04-07 D1, item M). When set, the effective system string is
   * `effectiveSystemPrompt(appendix)` = base + delimiter + appendix (arm B of the DRUG-03
   * ablation). PRODUCTION NEVER SETS THIS — the handler call site (`handler.ts`) omits it, so the
   * live classifier always sends the base SYSTEM_PROMPT byte-identically (arm A). Only the eval
   * `--ablation` path threads a generated OnSIDES term block through here.
   */
  readonly systemAppendix?: string;
}

/**
 * Classify one patient reply text — the production core (U-23). Forced tool + temperature 0 +
 * defensive truncation + the D-16 `.parse()` gate, with the typed failure taxonomy above.
 * Exactly ONE Messages call per invocation: contract failures never re-prompt (the W0.1 design
 * change note — repair retries would mask the drift signal FM #4 needs).
 */
export async function classifyReplyText(
  rawBody: string,
  opts: ClassifyOptions,
): Promise<AdherenceClassification> {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    maxRetries: CLASSIFY_MAX_RETRIES, // U-26 — see header arithmetic
    timeout: CLASSIFY_ATTEMPT_TIMEOUT_MS, // per-attempt
  });

  // Defensive truncation, aligned with the prefilter bound (a cue past 2000 chars is out of
  // scope for both detectors by contract).
  const bounded = rawBody.slice(0, PREFILTER_MAX_CHARS);

  let res: MessagesResponseLike;
  const startedAt = Date.now();
  try {
    res = await client.messages.create({
      model: MODEL_ID,
      max_tokens: 512, // one small tool call; a max_tokens stop is a detectable contract failure
      temperature: 0, // deterministic-leaning classification (FM #4)
      // AUGMENT, never fork, the U-23 core (04-07 D1, item M): production omits systemAppendix so
      // this is byte-identical to the base SYSTEM_PROMPT; arm B appends the OnSIDES term block.
      system: effectiveSystemPrompt(opts.systemAppendix),
      // The immunity boundary: untrusted patient text rides INSIDE the tags, never bare.
      messages: [{ role: 'user', content: `<patient_sms>${bounded}</patient_sms>` }],
      ...buildAnthropicToolConfig(),
    });
  } catch (err: unknown) {
    // 401 AND 403 are the operator-action class: revoked key, credit exhaustion, or an
    // org-level permission block — none heal on retry; both get the terminal unknown row +
    // the stop-the-line metric (code-review MEDIUM decision, 2026-07-03).
    if (
      err instanceof Anthropic.AuthenticationError ||
      err instanceof Anthropic.PermissionDeniedError
    ) {
      throw new ClassifyAuthError(
        'Anthropic auth/permission failure (401/403) — revoked key, credit exhaustion, or org block',
      );
    }
    if (
      err instanceof Anthropic.RateLimitError ||
      err instanceof Anthropic.InternalServerError ||
      err instanceof Anthropic.APIConnectionError
    ) {
      const name = err instanceof Error ? err.name : 'unknown';
      throw new ClassifyTransientError(`Anthropic transient failure after SDK retries (${name})`);
    }
    // DELIBERATE crash-class fallthrough (conscious decision, code-review MEDIUM 2026-07-03):
    // 404 (wrong model id) / 409 / 422 (malformed request) are CONFIG/CODE bugs — they must
    // surface LOUDLY in the onFailure DLQ, not be silently laundered into `unknown` rows.
    throw err;
  }

  // Telemetry fires HERE — a response arrived, so tokens were consumed and latency is real,
  // regardless of whether the .parse() gate below accepts or rejects it.
  if (opts.onUsage) {
    const inputTokens = res.usage?.input_tokens;
    const outputTokens = res.usage?.output_tokens;
    const estimatedCostUsd =
      inputTokens !== undefined && outputTokens !== undefined
        ? (inputTokens * HAIKU_INPUT_USD_PER_MTOK + outputTokens * HAIKU_OUTPUT_USD_PER_MTOK) /
          1_000_000
        : undefined;
    try {
      opts.onUsage({
        model: MODEL_ID,
        promptVersion: PROMPT_VERSION,
        latencyMs: Date.now() - startedAt,
        inputTokens,
        outputTokens,
        estimatedCostUsd,
      });
    } catch {
      // Deliberately dropped: a broken telemetry sink must never block classification.
    }
  }

  try {
    return parseToolUseOrThrow(res);
  } catch (err: unknown) {
    const toolUseBlock = res.content?.find((b) => b.type === 'tool_use' && b.name === TOOL_NAME);
    // The shared workspace can resolve its own Zod copy, so `instanceof ZodError` is not a
    // reliable package boundary. Keep the diagnostic structural and PII-safe.
    const issueSummary = summarizeZodIssues(err);
    throw new ClassifyContractError(
      issueSummary !== null
        ? 'classification failed the D-16 schema gate'
        : err instanceof Error
          ? err.message
          : 'unknown contract failure',
      toolUseBlock?.input,
      issueSummary ?? [],
    );
  }
}
