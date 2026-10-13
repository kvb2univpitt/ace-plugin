import type { LookupResult } from "./ontology/lookup";
import type {
  MappingCode,
  MappingResult,
  MappingRow,
} from "./ontology/mapper";
import type { ArtifactIssueOptions } from "./signed-artifact";
import {
  issueStep3OntologyProof,
  type Step3OntologyAnchor,
} from "./step3-ontology-proof";

export interface Step3ProofIdentity {
  concept: string;
  category: string;
  role?: string;
}

function withoutProof(code: MappingCode): MappingCode {
  const { ontologyProof, ...rest } = code;
  void ontologyProof;
  return { ...rest };
}

// A drug class with no single ontology node is mapped to the DISJUNCTION of its
// member ingredients (pathCombinator "or"). Step 4 OR-s those members into one
// criterion, and verifies each the same way it verifies a single anchor — so
// each member path needs its own signed proof, not just the headline node.
function signDisjunctionPaths(
  mapping: MappingRow,
  identity: Step3ProofIdentity,
  options: ArtifactIssueOptions
): MappingRow["shrineOntologyPaths"] | undefined {
  if (mapping.pathCombinator !== "or") return undefined;
  const paths = mapping.shrineOntologyPaths;
  if (!Array.isArray(paths) || paths.length === 0) return undefined;
  const headlineSystem = mapping.codes[0]?.system;
  return paths.map((p) => {
    const { ontologyProof: _drop, ...rest } = p;
    void _drop;
    const system = p.system ?? headlineSystem;
    if (!system) return { ...rest }; // no system → cannot sign; leave unsigned
    const anchor: Step3OntologyAnchor = {
      system,
      code: p.code,
      display: p.display,
      path: p.path,
    };
    return { ...rest, system, ontologyProof: issueProof(identity, anchor, options) };
  });
}

function issueProof(
  identity: Step3ProofIdentity,
  anchor: Step3OntologyAnchor,
  options: ArtifactIssueOptions
): string {
  const role = identity.role?.trim();
  return issueStep3OntologyProof(
    {
      concept: identity.concept,
      category: identity.category,
      ...(role ? { role } : {}),
      anchor,
    },
    options
  );
}

function attachMappingProof(
  mapping: MappingRow,
  options: ArtifactIssueOptions
): MappingRow {
  // This proves ENACT provenance only. Clinical appropriateness remains an
  // explicit Step 3 reviewer decision before the anchor can reach Step 4.
  const identity: Step3ProofIdentity = {
    concept: mapping.concept,
    category: mapping.category,
    ...(mapping.role !== undefined ? { role: mapping.role } : {}),
  };
  const codes = mapping.codes.map(withoutProof);
  const constituentCodes = mapping.constituentCodes?.map(withoutProof);
  const phenotype = mapping.phenotype
    ? (() => {
        const { ontologyProof, ...anchor } = mapping.phenotype;
        void ontologyProof;
        return { ...anchor };
      })()
    : undefined;

  if ((mapping.__tier ?? 1) === 99) {
    return { ...mapping, codes, constituentCodes, phenotype };
  }

  // For a class disjunction, sign every member path; otherwise this is undefined
  // and the row keeps its (single) shrineOntologyPaths unchanged.
  const signedPaths = signDisjunctionPaths(mapping, identity, options);
  const withSignedPaths = signedPaths
    ? { shrineOntologyPaths: signedPaths }
    : {};

  if (phenotype) {
    return {
      ...mapping,
      codes,
      constituentCodes,
      ...withSignedPaths,
      phenotype: {
        ...phenotype,
        ontologyProof: issueProof(identity, phenotype, options),
      },
    };
  }

  const anchorIndex = codes.findIndex(
    (code) => code.shrineOntologyPath === mapping.shrineOntologyPath
  );
  if (anchorIndex < 0) {
    return { ...mapping, codes, constituentCodes, phenotype, ...withSignedPaths };
  }
  const selected = codes[anchorIndex];
  const anchor: Step3OntologyAnchor = {
    system: selected.system,
    code: selected.code,
    display: selected.display,
    path: mapping.shrineOntologyPath,
  };
  codes[anchorIndex] = {
    ...selected,
    ontologyProof: issueProof(identity, anchor, options),
  };
  return { ...mapping, codes, constituentCodes, phenotype, ...withSignedPaths };
}

export function attachStep3MappingProofs(
  result: MappingResult,
  options: ArtifactIssueOptions = {}
): MappingResult {
  return {
    ...result,
    mappings: result.mappings.map((mapping) =>
      attachMappingProof(mapping, options)
    ),
    unmappedConcepts: result.unmappedConcepts.map((current) => ({ ...current })),
  };
}

export function attachStep3LookupProofs(
  result: LookupResult,
  identity: Step3ProofIdentity,
  options: ArtifactIssueOptions = {}
): LookupResult {
  return {
    ...result,
    paths: result.paths.map((path) => ({
      ...path,
      ontologyProof: issueProof(
        identity,
        {
          system: path.system,
          code: path.code,
          display: path.display,
          path: path.path,
        },
        options
      ),
    })),
  };
}
