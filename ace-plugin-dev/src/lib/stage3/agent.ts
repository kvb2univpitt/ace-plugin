import type { AgentResult } from "../common/agent-result";
import { mapConcepts } from "./mapper";
import { llmDisambiguateMappings } from "./llm-fallback";
import { attachStep3MappingProofs } from "./step3-ontology-provenance";

// ════════════════════════════════════════════════════════════════════
//  STAGE 3 — SHRINE Ontology Mapping
//  In  : reviewed clinical concepts (Stage 2 output)
//  Out : concepts mapped to ICD-10-CM / RxNorm / LOINC / CPT / ATC codes
//        + SHRINE ontology paths
//  Src : step3/ontology-mapping @5b617ce (TS, DuckDB — deterministic lookup,
//        directly emits queryable SHRINE paths)
//  Now : INTEGRATED @5b617ce — deterministic DuckDB closure-table search.
//        The LLM is only a gated tiebreaker for ambiguous tier-3+ results
//        and a recovery pass for zero-candidate concepts; it can never
//        overwrite a tier-1/2 hit nor invent codes outside the candidate
//        set. Requires ENACT_DUCKDB_PATH. Disable fallback with
//        ENACT_DISABLE_LLM_FALLBACK=1.
// ════════════════════════════════════════════════════════════════════
// apiKey is accepted for pipeline-signature parity; the ontology engine and
// its LLM fallback use the env-key client internally.
export async function ontologyMappingAgent(
  concepts: Record<string, unknown>,
  apiKey?: string
): Promise<AgentResult> {
  try {
    const deterministic = await mapConcepts(concepts);

    const llmDisabled = process.env.ENACT_DISABLE_LLM_FALLBACK === "1";
    const needsLlm =
      !llmDisabled &&
      (deterministic.unmappedConcepts.length > 0 ||
        deterministic.mappings.some((m) => (m.__tier ?? 1) >= 3));
    const final = needsLlm
      ? await llmDisambiguateMappings(concepts, deterministic)
      : deterministic;
    // Attach opaque server proofs so Step 4 can authorize each anchor. From
    // step4/query-logic @c0a3c8d.
    const proven = attachStep3MappingProofs(final);

    // Strip internal hints (__tier, __alternates, __tablesTried) before
    // returning — they're useful for debugging but not part of the contract
    // with Step 4.
    const data = {
      mappings: proven.mappings.map(({ __tier, __alternates, __tablesTried, ...rest }) => {
        void __tier; void __alternates; void __tablesTried;
        return rest;
      }),
      unmappedConcepts: proven.unmappedConcepts,
      mappingConfidence: proven.mappingConfidence,
      mappingNotes: proven.mappingNotes,
    };

    return {
      agent: "SHRINE Ontology Mapping",
      status: "success",
      data,
      summary: `Mapped ${data.mappings.length} concepts via ENACT closure-table search${
        needsLlm ? " + LLM tiebreak" : ""
      }. Confidence: ${data.mappingConfidence}. Unmapped: ${data.unmappedConcepts.length}.`,
    };
  } catch (error) {
    return {
      agent: "SHRINE Ontology Mapping",
      status: "error",
      data: {
        error: error instanceof Error ? error.message : String(error),
      },
      summary:
        "Ontology mapping failed — verify ENACT_DUCKDB_PATH points at a built database (see scripts/build-ontology-db.sh).",
    };
  }
}
