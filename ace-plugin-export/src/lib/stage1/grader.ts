// Grader: assess each retrieved paper for study-type + applicability against the
// structured question. Faithful port of grader.py. Forced Claude tool-use with
// defensive PMID matching (unknown grades ignored; ungraded papers defaulted).

import type Anthropic from "@anthropic-ai/sdk";
import type { GradedPaper, PaperGrade, PubMedArticle, StructuredQuestion } from "./types";
import { forcedToolInput, STAGE1_MODELS } from "./llm";

const SYSTEM_PROMPT = `You grade retrieved papers for a clinician evidence-assessment pipeline. Each paper is given by its abstract, and you assess it against a specific structured clinical question.

For every paper, determine:
- study_type: classify from the abstract — RCT, cohort, case-control, case-series, systematic-review, guideline, or other. Pick the single best fit.
- applicability: how well the paper applies to THIS question's population, intervention, comparator, and outcome — high, moderate, or low.
- applicability_flags: specific, concrete reasons applicability is limited (e.g., "excludes patients with eGFR < 30", "mean age 55, question is about octogenarians", "surrogate endpoint, not a clinical outcome"). Name the actual mismatch — do not give generic caveats. Leave empty when the paper is highly applicable.

Grade every paper you are given. Judge applicability strictly against the structured question, not the paper's general quality or prestige.`;

const PAPER_GRADE_SCHEMA = {
  type: "object" as const,
  properties: {
    pmid: { type: "string", description: "PMID of the paper being graded" },
    study_type: {
      type: "string",
      enum: [
        "RCT",
        "cohort",
        "case-control",
        "case-series",
        "systematic-review",
        "guideline",
        "other",
      ],
      description: "Best-fit study type inferred from the abstract",
    },
    applicability: {
      type: "string",
      enum: ["high", "moderate", "low"],
      description: "How well the paper applies to the structured question",
    },
    applicability_flags: {
      type: "array",
      items: { type: "string" },
      description:
        "Specific, concrete reasons applicability is limited; empty if highly applicable",
    },
  },
  required: ["pmid", "study_type", "applicability", "applicability_flags"],
};

const TOOL: Anthropic.Tool = {
  name: "submit_paper_grades",
  description:
    "Submit study-type and applicability grades for every retrieved paper.",
  input_schema: {
    type: "object",
    properties: {
      grades: {
        type: "array",
        items: PAPER_GRADE_SCHEMA,
        description: "One grade per retrieved paper",
      },
    },
    required: ["grades"],
  },
};

function formatQuestion(q: StructuredQuestion): string {
  return (
    `Population:   ${q.population}\n` +
    `Intervention: ${q.intervention}\n` +
    `Comparator:   ${q.comparator || "not specified"}\n` +
    `Outcome:      ${q.outcome}\n` +
    `Timeframe:    ${q.timeframe || "not specified"}`
  );
}

function formatPapers(papers: PubMedArticle[]): string {
  return papers
    .map((p) => `PMID: ${p.pmid} | ${p.title} | ${(p.abstract || "").slice(0, 1200)}`)
    .join("\n\n");
}

function parseGrade(raw: unknown): PaperGrade | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.pmid !== "string" || !r.pmid) return null;
  return {
    pmid: r.pmid,
    study_type: typeof r.study_type === "string" ? r.study_type : "other",
    applicability:
      typeof r.applicability === "string" ? r.applicability : "low",
    applicability_flags: Array.isArray(r.applicability_flags)
      ? r.applicability_flags.filter((v): v is string => typeof v === "string")
      : [],
  };
}

export async function gradePapers(
  client: Anthropic,
  question: StructuredQuestion,
  papers: PubMedArticle[]
): Promise<GradedPaper[]> {
  if (papers.length === 0) return [];

  const userMessage =
    "## Structured Question\n\n" +
    formatQuestion(question) +
    "\n\n## Retrieved Papers\n\n" +
    formatPapers(papers);

  const response = await client.messages.create({
    model: STAGE1_MODELS.grader,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [TOOL],
    tool_choice: { type: "tool", name: "submit_paper_grades" },
    messages: [{ role: "user", content: userMessage }],
  });

  const input = forcedToolInput(response, "submit_paper_grades") as {
    grades?: unknown;
  };
  const rawGrades = Array.isArray(input.grades) ? input.grades : [];
  const byPmid = new Map<string, PaperGrade>();
  for (const raw of rawGrades) {
    const g = parseGrade(raw);
    if (g) byPmid.set(g.pmid, g);
  }

  // Match defensively by PMID: ignore grades for unknown PMIDs, and attach a
  // conservative default for any input paper the model failed to grade.
  return papers.map((p) => ({
    article: p,
    grade:
      byPmid.get(p.pmid) ?? {
        pmid: p.pmid,
        study_type: "other",
        applicability: "low",
        applicability_flags: ["not graded"],
      },
  }));
}
