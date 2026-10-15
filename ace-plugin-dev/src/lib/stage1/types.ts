// Stage 1 (Intake & Literature Review) shared types.
//
// Faithful TS port of services/stage1/stage1 (Python, @a5528a4). The pipeline
// structures a clinician question into PICO-T, retrieves real PubMed papers via
// NCBI E-utilities, grades each for study-type + applicability, and synthesizes
// an evidence assessment — replacing the old intakeAgent that recalled papers
// from the model's memory and could hallucinate them.

/** PICO-T structuring of the clinician's free-text question. */
export interface StructuredQuestion {
  population: string;
  intervention: string;
  comparator?: string | null;
  outcome: string;
  timeframe?: string | null;
  /** Aspects of the question left underspecified — flagged, not silently resolved. */
  ambiguities: string[];
}

/** One PubMed record (subset of MEDLINE fields we use). */
export interface PubMedArticle {
  pmid: string;
  title: string;
  abstract?: string | null;
  year?: number | null;
  journal?: string | null;
  authors: string[];
}

/** The grader's per-paper judgement against the structured question. */
export interface PaperGrade {
  pmid: string;
  /** RCT | cohort | case-control | case-series | systematic-review | guideline | other */
  study_type: string;
  /** high | moderate | low */
  applicability: string;
  /** Concrete reasons applicability is limited; empty when highly applicable. */
  applicability_flags: string[];
}

export interface GradedPaper {
  article: PubMedArticle;
  grade: PaperGrade;
}

/** The assessor's synthesis across the graded papers. */
export interface EvidenceAssessment {
  summary: string;
  key_findings: string[];
  applicability_gaps: string[];
  unresolved_ambiguities: string[];
  /** 0.0–1.0: how settled the literature is on this question. */
  confidence: number;
  cited_pmids: string[];
}

export interface RetrievalResult {
  graded_papers: GradedPaper[];
  rounds: number;
  queries_used: string[];
  useful_count: number;
}

export interface Stage1Trace {
  search_query: string;
  queries_used: string[];
  rounds: number;
  useful_count: number;
  n_papers: number;
}

export interface Stage1Result {
  question: string;
  structured: StructuredQuestion;
  graded_papers: GradedPaper[];
  assessment: EvidenceAssessment;
  trace: Stage1Trace;
}
