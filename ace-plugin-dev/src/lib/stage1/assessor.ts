// Assessor: synthesize an evidence assessment across the graded papers.
// Faithful port of assessor.py. Uses opus-5 (per the stage1 branch's model
// re-check) with a small retry against partial tool-output samples.

import type Anthropic from "@anthropic-ai/sdk";
import type { EvidenceAssessment, GradedPaper, StructuredQuestion } from "./types";
import { forcedToolInput, STAGE1_MODELS } from "./llm";

const ASSESSOR_MAX_ATTEMPTS = 3;

const SYSTEM_PROMPT = `You are a clinical evidence analyst for CCES (Clinical Consultation and Evidence Synthesis). Produce an honest, structured characterization of what retrieved literature collectively says about a clinical question — NOT a treatment recommendation. The clinician makes the final judgment.

Each paper comes pre-assessed with a study type and an applicability grade (high, moderate, or low) against this specific question, plus applicability flags naming concrete limitations. Reason over these grades rather than re-deriving applicability from the abstracts: give more evidential weight to high-applicability papers, treat low-applicability papers cautiously, and let the applicability flags directly inform your applicability_gaps.

Guidelines:
- Summarize what the evidence shows across papers, not paper-by-paper
- Cite PMIDs in brackets for every key finding; omit findings you cannot attribute
- Flag applicability gaps proactively, drawing on the papers' applicability flags: if trials excluded the specific population (e.g., eGFR < 30, age > 80), name the gap explicitly
- Flag when the literature does not address an aspect of the question; do not fabricate coverage
- Confidence (0.0–1.0) reflects coverage and consistency of the evidence, not paper prestige; 0.0 = no relevant evidence found, 1.0 = large consistent trials directly answering the question. Down-weight confidence when the strongest available evidence is low-applicability
- Be concise: 2-4 sentence summary, 3-6 findings, gaps and ambiguities only where real`;

const TOOL: Anthropic.Tool = {
  name: "submit_evidence_assessment",
  description:
    "Submit the structured evidence assessment for the clinical question.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "2-4 sentence narrative of what the literature collectively says",
      },
      key_findings: {
        type: "array",
        items: { type: "string" },
        description:
          "3-6 specific findings, each citing one or more PMIDs in brackets",
      },
      applicability_gaps: {
        type: "array",
        items: { type: "string" },
        description:
          "Ways the retrieved literature does not fully apply to the structured question",
      },
      unresolved_ambiguities: {
        type: "array",
        items: { type: "string" },
        description: "Aspects of the question the literature could not address",
      },
      confidence: {
        type: "number",
        description: "0.0-1.0: how settled the literature is on this question",
        minimum: 0.0,
        maximum: 1.0,
      },
      cited_pmids: {
        type: "array",
        items: { type: "string" },
        description: "PMIDs the assessment actually relies on (subset of input)",
      },
    },
    required: [
      "summary",
      "key_findings",
      "applicability_gaps",
      "unresolved_ambiguities",
      "confidence",
      "cited_pmids",
    ],
  },
};

function formatQuestion(q: StructuredQuestion): string {
  const lines = [
    `Population:   ${q.population}`,
    `Intervention: ${q.intervention}`,
    `Comparator:   ${q.comparator || "not specified"}`,
    `Outcome:      ${q.outcome}`,
    `Timeframe:    ${q.timeframe || "not specified"}`,
  ];
  if (q.ambiguities.length > 0) {
    lines.push("Ambiguities flagged:");
    for (const a of q.ambiguities) lines.push(`  - ${a}`);
  }
  return lines.join("\n");
}

function formatPapers(gradedPapers: GradedPaper[]): string {
  return gradedPapers
    .map(({ article: p, grade: g }) => {
      let abstract = (p.abstract || "").slice(0, 1500);
      if (p.abstract && p.abstract.length > 1500) abstract += "...";
      const flags = g.applicability_flags.length
        ? g.applicability_flags.join(", ")
        : "none";
      return (
        `PMID: ${p.pmid} | ${g.study_type} | applicability: ${g.applicability} | ` +
        `flags: ${flags} | ${p.title} | ${abstract}`
      );
    })
    .join("\n\n---\n\n");
}

function strArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/** Validate the tool output into an EvidenceAssessment, or null if malformed. */
function parseAssessment(input: unknown): EvidenceAssessment | null {
  if (typeof input !== "object" || input === null) return null;
  const r = input as Record<string, unknown>;
  if (typeof r.summary !== "string") return null;
  if (typeof r.confidence !== "number") return null;
  const confidence = Math.min(1, Math.max(0, r.confidence));
  return {
    summary: r.summary,
    key_findings: strArray(r.key_findings),
    applicability_gaps: strArray(r.applicability_gaps),
    unresolved_ambiguities: strArray(r.unresolved_ambiguities),
    confidence,
    cited_pmids: strArray(r.cited_pmids),
  };
}

export async function assessEvidence(
  client: Anthropic,
  question: StructuredQuestion,
  gradedPapers: GradedPaper[]
): Promise<EvidenceAssessment> {
  const userMessage =
    "## Structured Question\n\n" +
    formatQuestion(question) +
    "\n\n## Retrieved & Graded Papers\n\n" +
    formatPapers(gradedPapers);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= ASSESSOR_MAX_ATTEMPTS; attempt++) {
    const response = await client.messages.create({
      model: STAGE1_MODELS.assessor,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "submit_evidence_assessment" },
      messages: [{ role: "user", content: userMessage }],
    });
    try {
      const parsed = parseAssessment(
        forcedToolInput(response, "submit_evidence_assessment")
      );
      if (parsed) return parsed;
      lastErr = new Error("assessor produced a partial/invalid assessment");
    } catch (err) {
      lastErr = err; // no tool_use block — retry for a fresh sample
    }
  }
  throw new Error(
    `assessor failed to produce a valid EvidenceAssessment after ` +
      `${ASSESSOR_MAX_ATTEMPTS} attempts: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`
  );
}
