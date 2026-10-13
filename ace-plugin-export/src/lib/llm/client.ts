// Provider-agnostic LLM client. Picks a backend via env var:
//
//   LLM_PROVIDER=anthropic   (default)
//     uses @anthropic-ai/sdk; requires ANTHROPIC_API_KEY in env.
//     model from ANTHROPIC_MODEL or "claude-sonnet-4-6".
//
//   LLM_PROVIDER=openrouter
//     uses OpenRouter's OpenAI-compatible /chat/completions endpoint via fetch;
//     requires OPENROUTER_API_KEY. Model from OPENROUTER_MODEL
//     (default "anthropic/claude-sonnet-4.6").
//
// Callers should depend only on `complete()` / `getProvider()`.

import Anthropic from "@anthropic-ai/sdk";

export interface CompleteRequest {
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  /** Override the provider's default model for this call. */
  model?: string;
}

export interface LlmProvider {
  /** Provider tag — e.g. "anthropic" or "openrouter". For logging/diagnostics. */
  readonly name: string;
  /** Current effective model id. */
  readonly model: string;
  complete(req: CompleteRequest): Promise<string>;
}

// ── Anthropic ────────────────────────────────────────────────────────────────

class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic;

  constructor() {
    this.model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
    this.client = new Anthropic();
  }

  async complete(req: CompleteRequest): Promise<string> {
    const resp = await this.client.messages.create({
      model: req.model || this.model,
      max_tokens: req.maxTokens ?? 2048,
      system: req.systemPrompt,
      messages: [{ role: "user", content: req.userMessage }],
    });
    const block = resp.content[0];
    return block?.type === "text" ? block.text : "";
  }
}

// ── OpenRouter (OpenAI-compatible) ───────────────────────────────────────────

class OpenRouterProvider implements LlmProvider {
  readonly name = "openrouter";
  readonly model: string;
  private apiKey: string;
  private endpoint = "https://openrouter.ai/api/v1/chat/completions";

  constructor() {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      throw new Error(
        "OPENROUTER_API_KEY is not set (required when LLM_PROVIDER=openrouter)"
      );
    }
    this.apiKey = key;
    this.model = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.6";
  }

  async complete(req: CompleteRequest): Promise<string> {
    const body = {
      model: req.model || this.model,
      max_tokens: req.maxTokens ?? 2048,
      messages: [
        { role: "system", content: req.systemPrompt },
        { role: "user", content: req.userMessage },
      ],
    };
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    // OpenRouter recommends these for analytics / rate limits when shipping
    // an app, harmless if unset.
    if (process.env.OPENROUTER_REFERER)
      headers["HTTP-Referer"] = process.env.OPENROUTER_REFERER;
    if (process.env.OPENROUTER_APP_TITLE)
      headers["X-Title"] = process.env.OPENROUTER_APP_TITLE;

    const resp = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`OpenRouter ${resp.status}: ${text.slice(0, 300)}`);
    }
    const json = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content ?? "";
  }
}

// ── Selection ────────────────────────────────────────────────────────────────

let cached: LlmProvider | null = null;

export function getProvider(): LlmProvider {
  if (cached) return cached;
  const choice = (process.env.LLM_PROVIDER || "anthropic").toLowerCase();
  cached = choice === "openrouter" ? new OpenRouterProvider() : new AnthropicProvider();
  return cached;
}

/** Convenience: strip ```json fences and parse JSON, throwing on failure. */
export function parseJsonLoose<T = unknown>(raw: string): T {
  const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
  return JSON.parse(cleaned) as T;
}
