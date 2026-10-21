import type { AgentResult } from "../common/agent-result";
import type { Step4ReviewContext } from "../common/query-plan-types";
import { compileI2b2XmlPackage } from "./i2b2-xml-compiler";
import { verifyStep4ReviewArtifact } from "../stage4/step4-review-artifact";
import { authorizeStep4QueryPlan } from "../stage4/step4-query-plan-authorization";

// ════════════════════════════════════════════════════════════════════
//  STAGE 5 — Sharephe / i2b2 XML Compiler
//  In  : clinical question + authorized Step 4 query plan + signed artifact
//  Out : deterministic i2b2 / Sharephe XML package (one artifact per count
//        query), each with ready / needs_mapping / needs_manual_review status
//  Src : step5/i2b2-xml @c34e744 (TS). Verifies the signed Step 4 artifact and
//        re-authorizes the submitted plan against its sealed claims, then
//        compiles deterministically via compileI2b2XmlPackage — NO LLM call, so
//        codes/paths/valueConstraints come straight from the sealed catalog.
// ════════════════════════════════════════════════════════════════════
export async function queryCompilerAgent(
  clinicalQuestion: string,
  queryLogic: unknown,
  artifactToken: unknown
): Promise<AgentResult> {
  // Step 5 compiles only what Step 4 authorized. Verify the signed review
  // artifact and re-authorize the submitted plan against its sealed claims;
  // codes/paths are re-derived from the sealed catalog, never from raw input.
  const artifact = verifyStep4ReviewArtifact(artifactToken);
  if (!artifact.ok || artifact.claims.clinicalQuestion !== clinicalQuestion) {
    return {
      agent: "Sharephe / i2b2 XML Compiler",
      status: "needs_clarification",
      data: {},
      summary:
        "Step 4 review authorization is invalid or expired. Run Step 4 again before compiling.",
    };
  }

  const authorization = authorizeStep4QueryPlan({
    submittedPlan: queryLogic,
    claims: artifact.claims,
  });
  const reviewContext: Step4ReviewContext = {
    authoritativeItems: artifact.claims.authoritativeItems,
    artifactToken: artifactToken as string,
  };
  if (!authorization.authorized) {
    return {
      agent: "Sharephe / i2b2 XML Compiler",
      status: "needs_clarification",
      data: authorization.plan as unknown as Record<string, unknown>,
      summary:
        "Step 4 authorization failed. Review the refreshed query plan before compiling.",
      reviewContext,
    };
  }

  try {
    const data = compileI2b2XmlPackage(authorization.plan);
    const readyCount = data.validationSummary.readyCount;
    const allArtifactsReady =
      data.artifacts.length > 0 && readyCount === data.artifacts.length;
    const status = allArtifactsReady ? "success" : "needs_clarification";
    return {
      agent: "Sharephe / i2b2 XML Compiler",
      status,
      data: data as unknown as Record<string, unknown>,
      summary: `Compiled ${data.artifacts.length} i2b2 XML artifacts. Ready: ${readyCount}; needs mapping: ${data.validationSummary.needsMappingCount}; needs manual review: ${data.validationSummary.needsManualReviewCount}.`,
      ...(status === "needs_clarification" ? { reviewContext } : {}),
    };
  } catch {
    return {
      agent: "Sharephe / i2b2 XML Compiler",
      status: "error",
      data: {},
      summary: "Deterministic i2b2 XML compilation failed.",
      reviewContext,
    };
  }
}
