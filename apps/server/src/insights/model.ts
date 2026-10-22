import type { AppConfig } from "../config/env.ts";

/**
 * Minimal OpenAI-compatible chat client. The project only needs a single
 * non-streaming completion call, so this avoids pulling in a vendor SDK.
 *
 * Every call takes an AbortSignal so a stalled request cannot outlive the
 * run's overall deadline.
 */

export type ChatMessage = { role: "system" | "user"; content: string };

export type ThinkingMode = "enabled" | "disabled";

export type CompleteOptions = {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  signal: AbortSignal;
  /** Overrides the configured model, e.g. for a cheaper classification call. */
  model?: string;
  /**
   * DeepSeek's unified models think by default and bill reasoning tokens at the
   * output rate. Classification and clustering are mechanical, so they ask for
   * non-thinking; the insight call keeps thinking for synthesis quality.
   */
  thinking?: ThinkingMode;
  /** Short tag for usage logs, e.g. "cluster". */
  label?: string;
};

/** Token counts billed for one completion, as reported by the provider. */
export type ModelUsage = {
  label: string | undefined;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Input tokens served from the provider's prefix cache (billed ~50x cheaper). */
  cachedTokens: number;
  /** Output tokens spent thinking; included in completionTokens. */
  reasoningTokens: number;
};

export type ModelClient = {
  readonly name: string;
  complete: (options: CompleteOptions) => Promise<string>;
  /** True when an API key is configured; callers degrade when it is not. */
  readonly available: boolean;
};

export type ModelError = {
  kind: "http" | "network" | "malformed" | "truncated";
  message: string;
  status?: number;
};

export class ModelRequestError extends Error {
  readonly kind: ModelError["kind"];
  readonly status: number | undefined;

  constructor(error: ModelError) {
    super(error.message);
    this.name = "ModelRequestError";
    this.kind = error.kind;
    this.status = error.status;
  }
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

function retryDelayMs(attempt: number, response?: Response): number {
  const retryAfter = Number(response?.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  return 1_000 * 2 ** attempt;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Builds the chat-completions URL, tolerating a base that already ends in /v1. */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

/**
 * `thinking` is a DeepSeek extension. Sending it to another OpenAI-compatible
 * provider is a 400, so `auto` (the default) only forwards the per-call
 * preference when the endpoint is DeepSeek's own host. An explicit setting in
 * the environment overrides that and is sent as-is (e.g. through a proxy).
 */
function resolveThinking(
  configured: "auto" | ThinkingMode | undefined,
  requested: ThinkingMode | undefined,
  deepSeekEndpoint: boolean,
): ThinkingMode | undefined {
  if (configured === "enabled" || configured === "disabled") return configured;
  return deepSeekEndpoint ? requested : undefined;
}

function isDeepSeekEndpoint(baseUrl: string): boolean {
  try {
    return /(^|\.)deepseek\.com$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

type UsagePayload = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
};

export function createModelClient(
  config: AppConfig,
  fetchImpl: typeof globalThis.fetch,
  onUsage?: (usage: ModelUsage) => void,
): ModelClient {
  const { baseUrl, apiKey, name, thinking: configuredThinking } = config.model;
  const endpoint = chatCompletionsUrl(baseUrl);
  const deepSeekEndpoint = isDeepSeekEndpoint(baseUrl);

  return {
    name,
    available: Boolean(apiKey),

    async complete({
      messages,
      maxTokens = 1024,
      temperature = 0.2,
      signal,
      model,
      thinking: requestedThinking,
      label,
    }) {
      if (!apiKey) {
        throw new ModelRequestError({ kind: "http", message: "no API key configured" });
      }

      const thinking = resolveThinking(configuredThinking, requestedThinking, deepSeekEndpoint);
      const body = JSON.stringify({
        model: model ?? name,
        messages,
        max_tokens: maxTokens,
        temperature,
        ...(thinking ? { thinking: { type: thinking } } : {}),
      });

      for (let attempt = 0; ; attempt += 1) {
        let response: Response;
        try {
          response = await fetchImpl(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body,
            signal,
          });
        } catch (error) {
          if (attempt >= MAX_ATTEMPTS) {
            throw new ModelRequestError({ kind: "network", message: String(error) });
          }
          await sleep(retryDelayMs(attempt));
          continue;
        }

        if (!response.ok) {
          if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
            await sleep(retryDelayMs(attempt, response));
            continue;
          }
          throw new ModelRequestError({
            kind: "http",
            message: `model returned ${response.status}`,
            status: response.status,
          });
        }

        const payload = (await response.json()) as {
          choices?: { message?: { content?: string }; finish_reason?: string }[];
          usage?: UsagePayload;
        };
        const choice = payload.choices?.[0];

        // Report usage before the content checks: a truncated or empty answer
        // was still billed, and hiding that would make cost regressions look
        // like free failures.
        if (payload.usage && onUsage) {
          const usage = payload.usage;
          onUsage({
            label,
            model: model ?? name,
            promptTokens: usage.prompt_tokens ?? 0,
            completionTokens: usage.completion_tokens ?? 0,
            cachedTokens:
              usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0,
            reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
          });
        }

        // Reasoning models bill their reasoning tokens against max_tokens, so a
        // budget that is too small truncates the answer: finish_reason is
        // "length" and the content is empty or half-written JSON. Report that
        // distinctly instead of letting it surface as an empty or malformed
        // reply, which is indistinguishable from a genuine model fault.
        if (choice?.finish_reason === "length") {
          throw new ModelRequestError({
            kind: "truncated",
            message: `response truncated at max_tokens=${maxTokens}`,
          });
        }

        const content = choice?.message?.content;
        if (typeof content !== "string" || content.length === 0) {
          throw new ModelRequestError({ kind: "malformed", message: "empty completion" });
        }
        return content;
      }
    },
  };
}
