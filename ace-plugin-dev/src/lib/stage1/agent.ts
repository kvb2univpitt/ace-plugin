import type { AgentResult } from "../common/agent-result";
import { getClient } from "../common/claude";
import { runStage1 } from "./pipeline";
import { stage1ResultToIntakeData, stage1Summary } from "./adapter";

// ════════════════════════════════════════════════════════════════════
//  STAGE 1 — Intake & Literature Review
//  In  : clinician's raw clinical question (string)
//  Out : PICO-T structuring, REAL PubMed papers (graded), evidence assessment,
//        mapped onto the intake data shape the frontend + Stage 2 consume
//  Src : stage1/pubmed-retrieval @a5528a4 (Python → TS rewrite, src/lib/stage1/*)
//  Now : PubMed-backed. Structures the question into PICO-T, retrieves real
//        papers via NCBI E-utilities (agentic retrieve→grade→refine loop), and
//        synthesizes an evidence assessment — replacing the old in-file LLM
//        version that recalled papers from memory and could hallucinate them.
//        Needs NCBI_EMAIL (recommended) / NCBI_API_KEY (optional) in env.
// ════════════════════════════════════════════════════════════════════
export async function intakeAgent(
  clinicalQuestion: string,
  apiKey?: string
): Promise<AgentResult> {
  try {
    const result = await runStage1(getClient(apiKey), clinicalQuestion);
    return {
      agent: "Intake & Literature Review",
      status: "success",
      data: stage1ResultToIntakeData(result),
      summary: stage1Summary(result),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      agent: "Intake & Literature Review",
      status: "error",
      data: { error: message },
      summary: `Stage 1 (intake & literature review) failed: ${message}`,
    };
  }
}
