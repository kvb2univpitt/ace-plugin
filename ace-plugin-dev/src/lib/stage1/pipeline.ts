// Stage 1 pipeline: structure → build query → retrieve+grade (agentic) →
// assess. Faithful port of pipeline.py's run_stage1 (the usage/timing telemetry
// is dropped — it doesn't affect the pipeline output the ACE service consumes).

import type Anthropic from "@anthropic-ai/sdk";
import type { EvidenceAssessment, Stage1Result } from "./types";
import { structureQuestion } from "./structurer";
import { buildQuery, retrieveAndGrade } from "./retriever";
import { assessEvidence } from "./assessor";

/**
 * A valid assessment for the empty-retrieval case. Neutral: a legitimate
 * question can retrieve nothing too, so this does NOT imply out-of-scope — only
 * that there was nothing citable to assess.
 */
function noEvidenceAssessment(): EvidenceAssessment {
  return {
    summary:
      "No citable literature was retrieved for this question, so no evidence " +
      "assessment could be made.",
    key_findings: [],
    applicability_gaps: ["No evidence retrieved to assess."],
    unresolved_ambiguities: [],
    confidence: 0.0,
    cited_pmids: [],
  };
}

export async function runStage1(
  client: Anthropic,
  question: string,
  maxPapers = 10
): Promise<Stage1Result> {
  const structured = await structureQuestion(client, question);
  const initialQuery = buildQuery(structured);
  const retrieval = await retrieveAndGrade(client, structured, initialQuery, {
    maxResults: maxPapers,
  });

  // Short-circuit BEFORE the Assessor when retrieval is empty: feeding the
  // Assessor nothing risks it fabricating an assessment. "Searched, found
  // nothing citable" is a valid no-information result, not a crash.
  const assessment =
    retrieval.graded_papers.length === 0
      ? noEvidenceAssessment()
      : await assessEvidence(client, structured, retrieval.graded_papers);

  return {
    question,
    structured,
    graded_papers: retrieval.graded_papers,
    assessment,
    trace: {
      search_query: initialQuery,
      queries_used: retrieval.queries_used,
      rounds: retrieval.rounds,
      useful_count: retrieval.useful_count,
      n_papers: retrieval.graded_papers.length,
    },
  };
}
