import Anthropic from "@anthropic-ai/sdk";

// Single Claude entry point shared by the LLM stages (Stage 2 and Stage 4's
// draft). Owns the model id and the response-text extraction — change the model
// in ONE place here.
const client = new Anthropic();
const userClientCache = new Map<string, Anthropic>();

// Return a client for a user-supplied API key (cached), or the default env-key
// client when no key is provided. From worktree-feat @39cd804.
export function getClient(apiKey?: string): Anthropic {
  if (!apiKey) return client;
  if (!userClientCache.has(apiKey)) {
    userClientCache.set(apiKey, new Anthropic({ apiKey }));
  }
  return userClientCache.get(apiKey)!;
}

export async function callAgent(
  systemPrompt: string,
  userMessage: string,
  apiKey?: string,
  maxTokens = 8192
): Promise<string> {
  const response = await getClient(apiKey).messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });
  // Scan all content blocks for the first text block, rather than assuming
  // content[0] is text — a non-text block first (e.g. thinking) would
  // otherwise silently produce an empty result. From step2 @2724b34.
  const textBlock = response.content.find(
    (block): block is Anthropic.Messages.TextBlock => block.type === "text"
  );
  if (!textBlock) {
    console.error(
      "callAgent: no text block in response.",
      `stop_reason=${response.stop_reason}`,
      `blockTypes=${response.content.map((b) => b.type).join(",") || "(empty)"}`
    );
    return "";
  }
  return textBlock.text;
}
