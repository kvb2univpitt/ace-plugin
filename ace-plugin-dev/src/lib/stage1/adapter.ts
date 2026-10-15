// Adapter: map the rich Stage1Result (PICO-T + graded PubMed papers + evidence
// assessment) onto the intake `data` shape the ACE frontend and Stage 2 already
// consume — so the PubMed-backed rewrite needs NO frontend change. Every field
// is DERIVED from real pipeline output; nothing is invented.

import type { GradedPaper, Stage1Result, StructuredQuestion } from "./types";

const APPLICABILITY_RANK: Record<string, number> = { high: 0, moderate: 1, low: 2 };

/** Restate the question in explicit PICO-T form. */
function picoRestatement(sq: StructuredQuestion): string {
  const comparator =
    sq.comparator && sq.comparator.trim() ? ` versus ${sq.comparator}` : "";
  const timeframe =
    sq.timeframe && sq.timeframe.trim() ? ` over ${sq.timeframe}` : "";
  return (
    `In ${sq.population}, what is the effect of ${sq.intervention}${comparator} ` +
    `on ${sq.outcome}${timeframe}?`
  );
}

/** Heuristic question-type label (the old intake classified this; derive it). */
function questionType(question: string, sq: StructuredQuestion): string {
  const q = question.toLowerCase();
  if (sq.comparator && sq.comparator.trim()) return "comparative_effectiveness";
  if (/\b(incidence|prevalence|how many|how common)\b/.test(q))
    return "incidence_prevalence";
  if (/\b(risk|associated|likelihood|odds)\b/.test(q)) return "risk_assessment";
  if (/\b(outcome|mortality|survival|efficacy|effect)\b/.test(q))
    return "treatment_outcome";
  return "other";
}

/** Map the assessor's confidence to the intake literature-status enum. */
function literatureStatus(confidence: number, nPapers: number): string {
  if (nPapers === 0) return "no_existing_evidence";
  if (confidence >= 0.7) return "well_established";
  if (confidence >= 0.3) return "partial_evidence";
  return "no_existing_evidence";
}

function firstAuthorEtAl(authors: string[]): string {
  if (authors.length === 0) return "—";
  return authors.length === 1 ? authors[0] : `${authors[0]} et al.`;
}

/** Sort papers most-useful-first: cited by the assessment, then applicability. */
function orderedPapers(result: Stage1Result): GradedPaper[] {
  const cited = new Set(result.assessment.cited_pmids);
  return [...result.graded_papers].sort((a, b) => {
    const ac = cited.has(a.article.pmid) ? 0 : 1;
    const bc = cited.has(b.article.pmid) ? 0 : 1;
    if (ac !== bc) return ac - bc;
    const ar = APPLICABILITY_RANK[a.grade.applicability] ?? 3;
    const br = APPLICABILITY_RANK[b.grade.applicability] ?? 3;
    return ar - br;
  });
}

function paperRelevance(gp: GradedPaper, cited: Set<string>): string {
  const parts = [
    gp.grade.study_type,
    `applicability: ${gp.grade.applicability}`,
  ];
  if (cited.has(gp.article.pmid)) parts.push("cited in assessment");
  if (gp.grade.applicability_flags.length > 0) {
    parts.push(gp.grade.applicability_flags.join("; "));
  }
  return parts.join(" · ");
}

/**
 * Build the intake `data` object. Includes the frontend-expected fields plus
 * the raw structured/assessment/graded_papers for Stage 2 context and review.
 */
export function stage1ResultToIntakeData(
  result: Stage1Result,
  maxPapers = 10
): Record<string, unknown> {
  const sq = result.structured;
  const a = result.assessment;
  const cited = new Set(a.cited_pmids);

  const literaturePapers = orderedPapers(result)
    .slice(0, maxPapers)
    .map((gp) => ({
      title: gp.article.title,
      authors: firstAuthorEtAl(gp.article.authors),
      year: gp.article.year ? String(gp.article.year) : "—",
      url: `https://pubmed.ncbi.nlm.nih.gov/${gp.article.pmid}/`,
      relevance: paperRelevance(gp, cited),
    }));

  const refinedQuestion = picoRestatement(sq);
  const revisedQuestions = [
    {
      question: refinedQuestion,
      clarification:
        "Restated in explicit PICO-T form (population, intervention, " +
        "comparator, and outcome made precise).",
    },
  ];

  return {
    isValid: true,
    questionType: questionType(result.question, sq),
    refinedQuestion,
    literatureStatus: literatureStatus(a.confidence, result.graded_papers.length),
    literatureNotes: a.summary,
    literaturePapers,
    revisedQuestions,
    suitableForShrine: true,
    suitabilityNotes:
      "Stage 1 characterizes the published evidence base for this question. " +
      "SHRINE suitability is confirmed downstream, when the concepts are mapped " +
      "to queryable ontology codes.",
    suggestedClarifications: sq.ambiguities,
    // ── Rich pipeline output (real data), for review + Stage 2 context ──
    structured: sq,
    assessment: a,
    gradedPapers: result.graded_papers,
    confidence: a.confidence,
    keyFindings: a.key_findings,
    applicabilityGaps: a.applicability_gaps,
    citedPmids: a.cited_pmids,
    trace: result.trace,
  };
}

/** One-line stage summary for the AgentResult. */
export function stage1Summary(result: Stage1Result): string {
  const a = result.assessment;
  const n = result.graded_papers.length;
  return (
    `Structured PICO-T; retrieved ${n} PubMed paper${n === 1 ? "" : "s"} over ` +
    `${result.trace.rounds} round${result.trace.rounds === 1 ? "" : "s"} ` +
    `(${result.trace.useful_count} applicable). Evidence confidence ` +
    `${a.confidence.toFixed(2)}.`
  );
}
