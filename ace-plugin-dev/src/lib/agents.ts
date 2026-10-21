// Orchestration barrel. Each stage now owns its own src/lib/stageN/ folder
// (agent entry + engine). This file re-exports the five stage agents for the
// SSE route handler and keeps the non-interactive runPipeline.
import type { AgentResult } from "./common/agent-result";
import { intakeAgent } from "./stage1/agent";
import { conceptExtractionAgent } from "./stage2/agent";
import { ontologyMappingAgent } from "./stage3/agent";
import { queryLogicAgent } from "./stage4/agent";
import { queryCompilerAgent } from "./stage5/agent";

export type { AgentResult } from "./common/agent-result";
export type { QueryLogicOptions, Step4DraftCompleter } from "./stage4/agent";
export {
  intakeAgent,
  conceptExtractionAgent,
  ontologyMappingAgent,
  queryLogicAgent,
  queryCompilerAgent,
};

export interface PipelineResult {
  stage: number;
  agentName: string;
  result: AgentResult;
}

// ════════════════════════════════════════════════════════════════════
//  ORCHESTRATOR — one-shot pipeline (Stage 1 → 5)
//  Non-interactive runner: chains all five stages in order and reports
//  each stage via onStageComplete. The live app uses the stage-by-stage
//  API route (route.ts) instead, which pauses for human review between
//  stages; this runPipeline is kept for non-interactive/batch use.
// ════════════════════════════════════════════════════════════════════
export async function runPipeline(
  clinicalQuestion: string,
  onStageComplete: (result: PipelineResult) => void
): Promise<PipelineResult[]> {
  const results: PipelineResult[] = [];

  // Stage 1: Intake & Literature Review
  const intakeResult = await intakeAgent(clinicalQuestion);
  const stage1: PipelineResult = {
    stage: 1,
    agentName: "Intake & Literature Review",
    result: intakeResult,
  };
  results.push(stage1);
  onStageComplete(stage1);

  if (!intakeResult.data.suitableForShrine) {
    return results;
  }

  // Stage 2: Clinical Concept Extraction
  const conceptResult = await conceptExtractionAgent(
    clinicalQuestion,
    intakeResult.data
  );
  const stage2: PipelineResult = {
    stage: 2,
    agentName: "Clinical Concept Extraction",
    result: conceptResult,
  };
  results.push(stage2);
  onStageComplete(stage2);

  // Stage 3: SHRINE Ontology Mapping
  const mappingResult = await ontologyMappingAgent(conceptResult.data);
  const stage3: PipelineResult = {
    stage: 3,
    agentName: "SHRINE Ontology Mapping",
    result: mappingResult,
  };
  results.push(stage3);
  onStageComplete(stage3);

  // Stage 4: Query Logic Builder
  const logicResult = await queryLogicAgent(
    clinicalQuestion,
    conceptResult.data,
    mappingResult.data
  );
  const stage4: PipelineResult = {
    stage: 4,
    agentName: "Query Logic Builder",
    result: logicResult,
  };
  results.push(stage4);
  onStageComplete(stage4);

  // Step 4 must produce an authorized plan (with a signed review artifact)
  // before Step 5 can compile. Bail on needs_clarification/error.
  if (logicResult.status !== "success") {
    return results;
  }

  // Stage 5: Sharephe / i2b2 XML Compiler — hand it the signed artifact token,
  // not the raw mappings (codes are re-derived from the sealed Step 4 catalog).
  const compilerResult = await queryCompilerAgent(
    clinicalQuestion,
    logicResult.data,
    logicResult.reviewContext?.artifactToken
  );
  const stage5: PipelineResult = {
    stage: 5,
    agentName: "Sharephe / i2b2 XML Compiler",
    result: compilerResult,
  };
  results.push(stage5);
  onStageComplete(stage5);

  return results;
}
