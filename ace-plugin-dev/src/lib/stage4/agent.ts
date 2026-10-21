import type { AgentResult } from "../common/agent-result";
import { callAgent } from "../common/claude";
import { getProvider, type CompleteRequest } from "../llm/client";
import { buildStep4QueryPlan, queryPlanPromptInput } from "./query-plan-builder";
import type { PreparedMapping, Step4QueryPlan } from "../common/query-plan-types";
import {
  prepareStep3QueryInput,
  toQueryPlanItem,
  type MappingResolver,
  type OntologyAnchorResolver,
} from "./step3-query-input";
import {
  issueStep4ReviewArtifact,
  step4ReviewArtifactPayloadFits,
} from "./step4-review-artifact";
import { persistentStep4ValidationIssues } from "./query-plan-validation";

export type Step4DraftCompleter = (request: CompleteRequest) => Promise<string>;

export interface QueryLogicOptions {
  ontologyProofSecret?: string;
  ontologyProofNow?: number;
  resolveMappings?: MappingResolver;
  resolveOntologyAnchor?: OntologyAnchorResolver;
}

// ════════════════════════════════════════════════════════════════════
//  STAGE 4 — Query Logic Builder
//  In  : clinical question + reviewed concepts + reviewed mappings
//  Out : deterministic Step 4 query plan (count queries, panels, temporal
//        rules, analysis cells) + a signed review artifact for Step 5
//  Src : step4/query-logic @c0a3c8d (TS). The model only DRAFTS semantic
//        mappingIds; the plan is built deterministically from the reviewed
//        Step 3 catalog (buildStep4QueryPlan), so codes/paths/valueConstraints
//        are hydrated from authoritative mappings, never invented. The draft
//        completer honors worktree-feat's BYO apiKey.
// ════════════════════════════════════════════════════════════════════
function step4DraftPrompt(args: {
  clinicalQuestion: string;
  concepts: Record<string, unknown>;
  mappings: PreparedMapping[];
}): { systemPrompt: string; userMessage: string } {
  return {
    systemPrompt: `You are the Query Logic Builder Agent for the ENACT ACE.

Draft a semantic Step 4 query plan for reviewed SHRINE ontology mappings.

You receive a clinical question, extracted concepts, and model-safe mapping summaries. Each mapping summary has a semantic mappingId. Use only those mappingIds to refer to mapped concepts.

Output ONLY valid JSON with this shape:
{
  "querySetName": "short descriptive name",
  "analysisType": "cohort_count | comparative_count",
  "countQueries": [
    {
      "id": "stable-query-id",
      "name": "query display name",
      "purpose": "what this count measures",
      "panels": [
        {
          "id": "stable-panel-id",
          "title": "panel display name",
          "logic": "WITH | WITHOUT",
          "mappingIds": ["semantic:mapping id"],
          "occursAtLeast": 1,
          "panelTiming": "ANY | SAMEVISIT | SAMEINSTANCENUM",
          "dateRange": {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}
        }
      ],
      "temporalRules": [
        {
          "id": "stable-temporal-id",
          "relation": "BEFORE | AFTER | BEFORE_OR_SAME | AFTER_OR_SAME",
          "firstPanelId": "panel-id",
          "secondPanelId": "panel-id",
          "minDays": 0,
          "maxDays": 365
        }
      ]
    }
  ],
  "analysisCells": [
    {
      "id": "stable-cell-id",
      "arm": "arm name or overall",
      "outcome": "the exact string \\"cohort\\" for denominator cells; the outcome name for outcome_positive cells",
      "kind": "denominator | outcome_positive",
      "queryId": "stable-query-id"
    }
  ]
}

panel rules (a violation discards the ENTIRE draft, so follow exactly):
- ONE panel per concept: within a single countQuery, each mappingId may appear in at most ONE panel. Never place the same mappingId in two panels of the same query.
- Do NOT invent a panel for a criterion you have no mappingId for. Age, sex, race and other pure demographics are handled outside the panels — if the mapping catalog has no id for it, omit that panel entirely. Never reuse an unrelated concept (e.g. the diagnosis) as a stand-in for a missing one.
- Repeated measurements of one test go in a SINGLE panel with "occursAtLeast" set to the count — NOT one panel per measurement. E.g. "two eGFR <60 results ≥90 days apart" is one eGFR panel with occursAtLeast: 2 (the ≥90-day gap is reviewed separately; do not model it as two eGFR panels).
- The two arms of a comparative study are separate countQueries, each a full cohort. Distinguish them by the value constraint already attached to the shared lab mapping (e.g. HbA1c >8% vs ≤8%) — one arm per query, not two HbA1c panels in one query.

analysisCells rules (a violation discards the ENTIRE draft, so follow exactly):
- Every "denominator" cell MUST set "outcome" to the exact string "cohort".
- Every "outcome_positive" cell MUST set "outcome" to a non-"cohort" outcome label, and MUST share its "arm" with a denominator cell in the same arm.
- For "comparative_count", emit at least two distinct denominator arms — one per exposure/comparator group (e.g. HbA1c >8% vs ≤8%) — plus the outcome_positive cell(s) for each arm. A two-arm study with one outcome therefore has 2 denominator + 2 outcome_positive cells.

The output must contain semantic mappingIds only. Do not output ontology paths, billing or clinical codes, systems, levels, item arrays, or value constraints. The application will hydrate those fields from reviewed Step 3 mappings after your draft is parsed.`,
    userMessage: JSON.stringify(
      {
        clinicalQuestion: args.clinicalQuestion,
        concepts: args.concepts,
        mappings: queryPlanPromptInput(args.mappings),
      },
      null,
      2
    ),
  };
}

function step4Status(plan: Step4QueryPlan): AgentResult["status"] {
  return plan.validationIssues.some((issue) => issue.severity === "error")
    ? "needs_clarification"
    : "success";
}

// Step 4 consumes a drug-class disjunction through the existing `all_codes_or`
// concept-set path: a `pathCombinator: "or"` row (a class expanded to its member
// ingredients) is reshaped into a concept set whose members are the signed
// `shrineOntologyPaths`. Everything downstream — per-member variants grouped
// into ONE OR-ed panel, then i2b2 — is the already-built concept-set machinery;
// this only reshapes the reviewed input. Ingredient rows (pathCombinator
// "single") are untouched. Proofs ride along on each path from Step 3, so the
// authorization boundary verifies every OR-ed member exactly as a single anchor.
function expandClassDisjunctions(reviewedMappings: unknown): unknown {
  if (
    typeof reviewedMappings !== "object" ||
    reviewedMappings === null ||
    Array.isArray(reviewedMappings)
  ) {
    return reviewedMappings;
  }
  const container = reviewedMappings as Record<string, unknown>;
  const rows = container.mappings;
  if (!Array.isArray(rows)) return reviewedMappings;

  let changed = false;
  const rewritten = rows.map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return row;
    const r = row as Record<string, unknown>;
    if (r.pathCombinator !== "or") return row;
    const paths = r.shrineOntologyPaths;
    if (!Array.isArray(paths) || paths.length === 0) return row;

    const codes = paths
      .filter(
        (p): p is Record<string, unknown> =>
          typeof p === "object" && p !== null && !Array.isArray(p)
      )
      .map((p) => ({
        system: p.system,
        code: p.code,
        display: p.display,
        shrineOntologyPath: p.path,
        ...(typeof p.ontologyProof === "string"
          ? { ontologyProof: p.ontologyProof }
          : {}),
      }));
    if (codes.length === 0) return row;

    const preferred =
      typeof r.shrineOntologyPath === "string" && r.shrineOntologyPath
        ? r.shrineOntologyPath
        : (codes[0].shrineOntologyPath as string);

    changed = true;
    return {
      ...r,
      selectionMode: "all_codes_or",
      shrineOntologyPath: preferred,
      codes,
    };
  });

  if (!changed) return reviewedMappings;
  return { ...container, mappings: rewritten };
}

// A comparative plan needs >=2 distinct denominator arms (one per exposure /
// comparator group). Counting them lets the draft loop tell a real two-arm plan
// apart from a single-cohort read the deterministic fallback could also produce.
function denominatorArmCount(plan: Step4QueryPlan): number {
  return new Set(
    plan.analysisCells
      .filter((cell) => cell.kind === "denominator")
      .map((cell) => cell.arm)
  ).size;
}

// Does this question want a two-arm comparison? Used to decide whether a single-
// arm draft is worth retrying. Catches explicit comparisons ("X versus Y",
// "compared with") AND negation comparators ("X vs NO X", "without X") — the
// latter leave no comparator concept in the mappings, so a role check alone
// misses them. Erring toward "yes" only costs extra draft attempts; missing a
// comparison silently ships a single-arm plan, which is the bug we're fixing.
function looksComparative(
  question: string,
  mappings: PreparedMapping[]
): boolean {
  const q = ` ${question.toLowerCase()} `;
  if (
    /\b(versus|vs\.?|compared\s+(?:with|to)|comparator|relative\s+to)\b/.test(q) ||
    /\b(no|without|non-?users?|absence\s+of)\s+\S/.test(q)
  ) {
    return true;
  }
  return mappings.some(
    (m) => (m.role ?? "").trim().toLowerCase() === "comparator"
  );
}

export async function queryLogicAgent(
  clinicalQuestion: string,
  concepts: Record<string, unknown>,
  mappings: unknown,
  apiKey?: string,
  completeDraft?: Step4DraftCompleter,
  options: QueryLogicOptions = {}
): Promise<AgentResult> {
  // Preserve worktree-feat's BYO key: with a user key, draft via callAgent on
  // that key; otherwise use the default provider (which honors the openrouter
  // option). Tests may still inject an explicit completer.
  const draft: Step4DraftCompleter =
    completeDraft ??
    (apiKey
      ? (request) =>
          callAgent(
            request.systemPrompt,
            request.userMessage,
            apiKey,
            request.maxTokens
          )
      : (request) => getProvider().complete(request));

  // ── Step 4 must NOT touch the ontology DB (team decision, 2026-09-08) ──
  // The ontology database is searched only in Stage 3, which signs each real
  // anchor with a server-issued proof. Stage 4 trusts ONLY those signed proofs:
  // a missing/expired proof is a hard error that sends the clinician back to
  // Stage 3 — Stage 4 never re-queries DuckDB to renew a proof or to re-map a
  // concept Stage 3 left out. We enforce this by injecting no-op resolvers that
  // replace prepareStep3QueryInput's DB-backed defaults (revalidateExactOntology-
  // Anchor / mapConcepts). Tests may still inject real resolvers via `options`.
  const noDbAnchorResolver: OntologyAnchorResolver = async () => false;
  const noDbMappingResolver: MappingResolver = async () => ({
    mappings: [],
    unmappedConcepts: [],
    mappingConfidence: "low",
    mappingNotes: "Step 4 does not query the ontology DB; recovery disabled.",
  });

  const step3 = await prepareStep3QueryInput({
    reviewedMappings: expandClassDisjunctions(mappings),
    concepts,
    ontologyProofSecret: options.ontologyProofSecret,
    ontologyProofNow: options.ontologyProofNow,
    resolveMappings: options.resolveMappings ?? noDbMappingResolver,
    resolveOntologyAnchor: options.resolveOntologyAnchor ?? noDbAnchorResolver,
  });

  const authoritativeItems = step3.mappings.map((mapping) => {
    const item = toQueryPlanItem(mapping);
    const { role, valueConstraint, ...required } = item;
    return {
      ...required,
      ...(role !== undefined ? { role } : {}),
      ...(valueConstraint !== undefined
        ? { valueConstraint: { ...valueConstraint } }
        : {}),
    };
  });
  const hasInitialStep3Errors = step3.validationIssues.some(
    (issue) => issue.severity === "error"
  );
  const artifactSizeExceeded =
    !hasInitialStep3Errors &&
    !step4ReviewArtifactPayloadFits(
      {
        clinicalQuestion,
        authoritativeItems,
        generation: "deterministic_fallback",
        persistentIssues: persistentStep4ValidationIssues(
          step3.validationIssues
        ),
      },
      8 * 1024
    );
  if (artifactSizeExceeded) {
    step3.validationIssues.push({
      code: "step4_artifact_limit_exceeded",
      severity: "error",
      message:
        "The authoritative Step 3 catalog is too large for a reviewable Step 4 artifact.",
      target: "step3",
    });
  }

  // The LLM draft is non-deterministic: for a comparative (multi-arm) question
  // it sometimes returns a single-arm or malformed plan that fails hydration/
  // validation and silently falls back to the deterministic planner — which
  // cannot build a "without X" comparator arm at all, so the whole comparison
  // collapses to one arm ("why is it single-arm again"). Retry the draft:
  //   * take the FIRST clean comparative plan (>=2 denominator arms) at once —
  //     that is the hard-to-get result worth spending attempts on;
  //   * for a question that doesn't look comparative, accept the first clean
  //     (single-cohort) plan immediately — no wasted attempts;
  //   * a comparative-looking question that still drafts single-arm is retried,
  //     since a later sample may recognize the comparison.
  // Fall back to the deterministic planner only when NO attempt produced a clean
  // LLM plan (or the provider is down).
  const MAX_DRAFT_ATTEMPTS = 3;
  const wantComparative = looksComparative(clinicalQuestion, step3.mappings);
  let rawDraft: string | null = null;
  let modelUnavailable = false;
  let comparativePlan: Step4QueryPlan | undefined;
  let bestLlmPlan: Step4QueryPlan | undefined;
  if (step3.mappings.length > 0 && !artifactSizeExceeded) {
    const prompt = step4DraftPrompt({
      clinicalQuestion,
      concepts,
      mappings: step3.mappings,
    });
    for (let attempt = 0; attempt < MAX_DRAFT_ATTEMPTS; attempt++) {
      let candidate: string | null = null;
      try {
        // 16384 gives the multi-arm JSON plan headroom (4096 truncated it).
        candidate = await draft({
          systemPrompt: prompt.systemPrompt,
          userMessage: prompt.userMessage,
          maxTokens: 16384,
        });
      } catch {
        modelUnavailable = true;
        break; // provider down — retrying won't help
      }
      rawDraft = candidate;
      const candidatePlan = buildStep4QueryPlan({
        question: clinicalQuestion,
        concepts,
        step3,
        rawDraft: candidate,
      });
      const clean =
        candidatePlan.generation === "llm" &&
        !candidatePlan.validationIssues.some(
          (issue) => issue.severity === "error"
        );
      if (!clean) continue; // draft failed to hydrate/validate — try again
      if (!bestLlmPlan) bestLlmPlan = candidatePlan;
      const isTwoArm =
        candidatePlan.analysisType === "comparative_count" &&
        denominatorArmCount(candidatePlan) >= 2;
      if (isTwoArm) {
        comparativePlan = candidatePlan;
        break;
      }
      if (!wantComparative) break; // single-cohort is the expected answer
    }
  }

  let plan: Step4QueryPlan;
  if (comparativePlan) {
    plan = comparativePlan; // a real two-arm comparison
  } else if (bestLlmPlan) {
    plan = bestLlmPlan; // clean single-cohort read (or best LLM plan we got)
  } else {
    plan = buildStep4QueryPlan({
      question: clinicalQuestion,
      concepts,
      step3,
      rawDraft,
      modelUnavailable: modelUnavailable || rawDraft !== null,
    });
  }

  let artifactBlocked = step3.validationIssues.some(
    (issue) => issue.severity === "error"
  );
  const artifactInput = {
    clinicalQuestion,
    authoritativeItems,
    generation: plan.generation,
    persistentIssues: persistentStep4ValidationIssues(plan.validationIssues),
  };
  if (
    !artifactBlocked &&
    !step4ReviewArtifactPayloadFits(artifactInput)
  ) {
    artifactBlocked = true;
    plan = {
      ...plan,
      validationIssues: [
        ...plan.validationIssues,
        {
          code: "step4_artifact_limit_exceeded",
          severity: "error",
          message:
            "The authoritative Step 3 catalog is too large for a reviewable Step 4 artifact.",
          target: "step3",
        },
      ],
    };
  }
  const artifactToken = artifactBlocked
    ? undefined
    : issueStep4ReviewArtifact({
        clinicalQuestion,
        authoritativeItems,
        generation: plan.generation,
        persistentIssues: persistentStep4ValidationIssues(
          plan.validationIssues
        ),
      });
  const fallbackWarning = plan.validationIssues.some(
    (issue) => issue.code === "step4_model_unavailable"
  )
    ? " Used deterministic fallback because the model draft was unavailable or unusable."
    : "";

  return {
    agent: "Query Logic Builder",
    status: step4Status(plan),
    data: plan as unknown as Record<string, unknown>,
    summary: `Built ${plan.countQueries.length} count queries from ${step3.mappings.length} authoritative mappings.${fallbackWarning}`,
    reviewContext: {
      authoritativeItems,
      ...(artifactToken ? { artifactToken } : {}),
    },
  };
}
