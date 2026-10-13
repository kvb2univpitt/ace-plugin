// Structurer: clinician free-text question → PICO-T (StructuredQuestion).
// Faithful port of structurer.py. Uses forced Claude tool-use.

import type Anthropic from "@anthropic-ai/sdk";
import type { StructuredQuestion } from "./types";
import { forcedToolInput, STAGE1_MODELS } from "./llm";

const SYSTEM_PROMPT = `You help turn clinician free-text questions into structured form for downstream automated evidence assessment.
Use PICO-T framing: Population, Intervention, Comparator, Outcome, Timeframe.
Extract each field from the question as precisely as possible.
Flag anything underspecified in ambiguities rather than silently resolving it — for example, if the outcome is vague (bleeding? stroke? mortality?), list that.
Keep field values concise: one sentence or less per field.`;

const TOOL: Anthropic.Tool = {
  name: "submit_structured_question",
  description:
    "Submit the structured PICO-T representation of the clinician's question.",
  input_schema: {
    type: "object",
    properties: {
      population: { type: "string", description: "Who the question is about" },
      intervention: {
        type: "string",
        description: "What is being done, given, or studied",
      },
      comparator: {
        type: "string",
        description: "What the intervention is compared to",
      },
      outcome: {
        type: "string",
        description: "What is being measured or assessed",
      },
      timeframe: {
        type: "string",
        description: "Time horizon: acute, chronic, or specific duration",
      },
      ambiguities: {
        type: "array",
        items: { type: "string" },
        description: "Aspects of the question that are underspecified",
      },
    },
    required: ["population", "intervention", "outcome", "ambiguities"],
  },
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

export async function structureQuestion(
  client: Anthropic,
  question: string
): Promise<StructuredQuestion> {
  const response = await client.messages.create({
    model: STAGE1_MODELS.structurer,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [TOOL],
    tool_choice: { type: "tool", name: "submit_structured_question" },
    messages: [{ role: "user", content: question }],
  });
  const input = forcedToolInput(response, "submit_structured_question");
  const raw = input as Record<string, unknown>;
  if (!str(raw.population) || !str(raw.intervention) || !str(raw.outcome)) {
    throw new Error("structurer: tool output missing required PICO fields");
  }
  return {
    population: str(raw.population),
    intervention: str(raw.intervention),
    comparator: optStr(raw.comparator),
    outcome: str(raw.outcome),
    timeframe: optStr(raw.timeframe),
    ambiguities: strArray(raw.ambiguities),
  };
}
