// Shared helper for Stage 1's forced-tool-use calls: pull the input object out
// of the model's tool_use block, or throw if the model didn't call the tool.

import type Anthropic from "@anthropic-ai/sdk";

// Per-node model ids, each overridable via env so a given deployment can point
// each node at whatever the account actually has access to. Defaults match the
// stage1 branch (@a5528a4): sonnet-4-6 for the cheaper nodes, opus-5 for the
// assessor. An account without opus-5 must set STAGE1_ASSESSOR_MODEL.
export const STAGE1_MODELS = {
  structurer: process.env.STAGE1_STRUCTURER_MODEL || "claude-sonnet-4-6",
  grader: process.env.STAGE1_GRADER_MODEL || "claude-sonnet-4-6",
  refiner: process.env.STAGE1_REFINER_MODEL || "claude-sonnet-4-6",
  assessor: process.env.STAGE1_ASSESSOR_MODEL || "claude-opus-5",
} as const;

/** Return the `.input` of the named forced tool call, or throw. */
export function forcedToolInput(
  response: Anthropic.Message,
  toolName: string
): unknown {
  const block = response.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === "tool_use" && b.name === toolName
  );
  if (!block) {
    throw new Error(`${toolName}: response contained no matching tool_use block`);
  }
  return block.input;
}

/** Concatenate all text blocks of a response (for the non-tool refiner call). */
export function responseText(response: Anthropic.Message): string {
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}
