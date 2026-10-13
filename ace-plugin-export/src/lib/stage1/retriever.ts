// Retriever: the agentic retrieve→grade→refine loop, plus the deterministic
// initial-query builder. Faithful port of retriever.py + pipeline.py's
// _build_query. Refiner uses a plain (non-tool) sonnet-4-6 call.

import type Anthropic from "@anthropic-ai/sdk";
import type { GradedPaper, RetrievalResult, StructuredQuestion } from "./types";
import { gradePapers } from "./grader";
import { searchPubmed } from "./pubmed";
import { responseText, STAGE1_MODELS } from "./llm";

// Cap on the refiner's returned query; an over-long query has been observed to
// trigger an NCBI backend 500.
const MAX_REFINED_QUERY_CHARS = 350;

const USEFUL = new Set(["high", "moderate"]);

// ── Deterministic initial query (pipeline.py _build_query / _tokenize) ────────

const QUERY_STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "for", "in", "with", "and", "or", "of", "to",
  "do", "does", "have", "has", "be", "been", "at", "by", "vs", "versus",
  "patients", "patient", "who", "that", "this", "these", "those", "their",
  "risk", "rate", "incidence", "prevention", "compared", "taking",
  "no", "not", "without", "whether", "increased", "decreased", "associated",
]);

const PARENTHETICAL = /\([^)]*\)/g;
const STRIP_CHARS = ".,;:()[]\"'";

/** Split a field into query tokens, dropping parenthetical asides + punctuation. */
function tokenize(text: string): string[] {
  const stripped = text.replace(PARENTHETICAL, " ");
  return stripped
    .split(/\s+/)
    .map((w) => trimChars(w, STRIP_CHARS))
    .filter((t) => t.length > 0);
}

function trimChars(s: string, chars: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start])) start++;
  while (end > start && chars.includes(s[end - 1])) end--;
  return s.slice(start, end);
}

export function buildQuery(sq: StructuredQuestion): string {
  const interventionTokens = new Set(
    tokenize(sq.intervention)
      .map((t) => t.toLowerCase())
      .filter((t) => !QUERY_STOPWORDS.has(t))
  );

  // Skip comparator if it just negates the intervention ("No X", "Without X").
  let useComparator = false;
  if (sq.comparator) {
    const compTokens = new Set(
      tokenize(sq.comparator)
        .map((t) => t.toLowerCase())
        .filter((t) => !QUERY_STOPWORDS.has(t) && t.length > 2)
    );
    useComparator = ![...compTokens].some((t) => interventionTokens.has(t));
  }

  const parts = [sq.intervention];
  if (useComparator && sq.comparator) parts.push(sq.comparator);
  parts.push(sq.outcome, sq.population);

  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of parts) {
    for (const word of tokenize(part)) {
      const clean = word.toLowerCase();
      if (!QUERY_STOPWORDS.has(clean) && clean.length > 2 && !seen.has(clean)) {
        tokens.push(word);
        seen.add(clean);
      }
    }
  }
  return tokens.join(" ");
}

// ── Refiner + agentic loop ───────────────────────────────────────────────────

const REFINE_SYSTEM_PROMPT = `You refine PubMed search queries for a clinical evidence pipeline. The current query returned too few papers that actually apply to the clinician's question. Propose ONE improved PubMed query that targets the missing evidence.

Use a plain keyword query — condition names, drug names, population terms. Avoid field tags and boolean operators unless essential. Re-target or broaden based on why the current results fell short (e.g., wrong population, wrong indication, surrogate endpoints). Respond with ONLY the query string — no preamble, no quotes.`;

function usefulCount(gradedPapers: Iterable<GradedPaper>): number {
  let n = 0;
  for (const gp of gradedPapers) if (USEFUL.has(gp.grade.applicability)) n++;
  return n;
}

function formatQuestion(q: StructuredQuestion): string {
  return (
    `Population: ${q.population}; Intervention: ${q.intervention}; ` +
    `Comparator: ${q.comparator || "n/a"}; Outcome: ${q.outcome}`
  );
}

async function refineQuery(
  client: Anthropic,
  question: StructuredQuestion,
  currentQuery: string,
  gradedPapers: GradedPaper[]
): Promise<string> {
  const shortfalls = gradedPapers
    .filter((gp) => gp.grade.applicability === "low")
    .map(
      (gp) =>
        `- ${gp.article.title.slice(0, 80)}: ` +
        (gp.grade.applicability_flags.join("; ") || "low applicability")
    );
  const shortfallText =
    shortfalls.length > 0
      ? shortfalls.slice(0, 8).join("\n")
      : "Few or no relevant papers were found.";

  const userMessage =
    `Structured question:\n${formatQuestion(question)}\n\n` +
    `Query just used:\n${currentQuery}\n\n` +
    `Why the current results are insufficient:\n${shortfallText}\n\n` +
    "Propose one improved PubMed query string.";

  const response = await client.messages.create({
    model: STAGE1_MODELS.refiner,
    max_tokens: 256,
    system: REFINE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  let refined = trimChars(responseText(response).trim(), "`\"'").trim();
  if (!refined) return currentQuery; // fall back if the model returns nothing
  if (refined.length > MAX_REFINED_QUERY_CHARS) {
    const slice = refined.slice(0, MAX_REFINED_QUERY_CHARS);
    const cut = slice.lastIndexOf(" ");
    refined = cut > 0 ? slice.slice(0, cut) : slice; // break at a word boundary
  }
  return refined;
}

export async function retrieveAndGrade(
  client: Anthropic,
  question: StructuredQuestion,
  initialQuery: string,
  options: {
    maxResults?: number;
    usefulThreshold?: number;
    maxRounds?: number;
  } = {}
): Promise<RetrievalResult> {
  const maxResults = options.maxResults ?? 10;
  const usefulThreshold = options.usefulThreshold ?? 4;
  const maxRounds = options.maxRounds ?? 3;

  const queriesUsed: string[] = [];
  const gradedByPmid = new Map<string, GradedPaper>();
  let query = initialQuery;

  for (let round = 0; round < maxRounds; round++) {
    queriesUsed.push(query);
    const graded = await gradePapers(
      client,
      question,
      await searchPubmed(query, maxResults)
    );
    for (const gp of graded) {
      if (!gradedByPmid.has(gp.article.pmid)) {
        gradedByPmid.set(gp.article.pmid, gp); // dedupe: first grade wins
      }
    }

    const useful = usefulCount(gradedByPmid.values());
    const thresholdMet = useful >= usefulThreshold;
    const budgetExhausted = round === maxRounds - 1;
    if (thresholdMet || budgetExhausted) break;

    query = await refineQuery(client, question, query, [
      ...gradedByPmid.values(),
    ]);
  }

  const final = [...gradedByPmid.values()];
  return {
    graded_papers: final,
    rounds: queriesUsed.length,
    queries_used: queriesUsed,
    useful_count: usefulCount(final),
  };
}
