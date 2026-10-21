import type { Step4ReviewContext } from "./query-plan-types";

// The common result shape every stage agent returns, consumed by the SSE
// orchestrator (common/agents-route-handler.ts) and runPipeline.
export interface AgentResult {
  agent: string;
  status: "success" | "error" | "needs_clarification";
  data: Record<string, unknown>;
  summary: string;
  reviewContext?: Step4ReviewContext;
}
