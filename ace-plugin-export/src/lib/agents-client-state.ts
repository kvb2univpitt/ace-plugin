import type {
  Step4QueryPlan,
  Step4ReviewContext,
} from "./query-plan-types";

export type StageUiStatus =
  | "pending"
  | "running"
  | "complete"
  | "needs_review"
  | "error";

export interface StageCompletionDisposition {
  stageStatus: StageUiStatus;
  clearStep4Review: boolean;
  restoreStep4Review: boolean;
}

export async function assertAgentStreamResponse(
  response: Response
): Promise<void> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (response.ok && contentType.includes("text/event-stream")) return;

  if (!response.ok) {
    let message = `Agent request failed with status ${response.status}.`;
    try {
      const payload = (await response.json()) as unknown;
      if (
        isRecord(payload) &&
        typeof payload.error === "string" &&
        payload.error.trim().length > 0
      ) {
        message = payload.error;
      }
    } catch {
      // Retain the status-based message when the error body is not JSON.
    }
    throw new Error(message);
  }

  throw new Error("Agent request returned an unexpected response format.");
}

export function reviewStageForFailedContinuation(
  startFromStage: unknown
): 1 | 2 | 3 | 4 | null {
  if (startFromStage === 2) return 1;
  if (startFromStage === 3) return 2;
  if (startFromStage === 4) return 3;
  if (startFromStage === 5) return 4;
  return null;
}

export function classifyStageCompletion(
  stage: number,
  resultStatus: unknown
): StageCompletionDisposition {
  if (stage !== 5) {
    return {
      stageStatus: "complete",
      clearStep4Review: false,
      restoreStep4Review: false,
    };
  }

  if (resultStatus === "success") {
    return {
      stageStatus: "complete",
      clearStep4Review: true,
      restoreStep4Review: false,
    };
  }
  if (resultStatus === "needs_clarification") {
    return {
      stageStatus: "needs_review",
      clearStep4Review: false,
      restoreStep4Review: true,
    };
  }
  return {
    stageStatus: "error",
    clearStep4Review: false,
    restoreStep4Review: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getSafeReviewContext(result: unknown): Step4ReviewContext | null {
  if (!isRecord(result) || !isRecord(result.reviewContext)) return null;
  if (!Array.isArray(result.reviewContext.authoritativeItems)) return null;
  if (
    result.reviewContext.artifactToken !== undefined &&
    (typeof result.reviewContext.artifactToken !== "string" ||
      result.reviewContext.artifactToken.trim().length === 0)
  ) {
    return null;
  }
  return result.reviewContext as unknown as Step4ReviewContext;
}

export function getSafeStep4ReviewUpdate(result: unknown): {
  plan: Step4QueryPlan;
  reviewContext: Step4ReviewContext;
} | null {
  if (!isRecord(result) || !isRecord(result.data)) return null;
  if (result.data.version !== "step4-query-plan-v1") return null;
  const reviewContext = getSafeReviewContext(result);
  if (!reviewContext) return null;

  return {
    plan: result.data as unknown as Step4QueryPlan,
    reviewContext,
  };
}

export function resolveStep4ReviewRecovery(result: unknown): {
  update: ReturnType<typeof getSafeStep4ReviewUpdate>;
  artifactToken: string | null;
  needsRegeneration: boolean;
} {
  const update = getSafeStep4ReviewUpdate(result);
  const reviewContext = update?.reviewContext ?? getSafeReviewContext(result);

  if (!reviewContext) {
    return {
      update: null,
      artifactToken: null,
      needsRegeneration: true,
    };
  }

  const artifactToken = reviewContext.artifactToken ?? null;

  return {
    update,
    artifactToken,
    needsRegeneration: artifactToken === null,
  };
}
