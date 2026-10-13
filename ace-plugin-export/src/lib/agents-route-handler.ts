import type { NextRequest } from "next/server";
import {
  conceptExtractionAgent,
  intakeAgent,
  ontologyMappingAgent,
  queryCompilerAgent,
  queryLogicAgent,
} from "./agents";

interface AgentRouteDependencies {
  intakeAgent: typeof intakeAgent;
  conceptExtractionAgent: typeof conceptExtractionAgent;
  ontologyMappingAgent: typeof ontologyMappingAgent;
  queryLogicAgent: typeof queryLogicAgent;
  queryCompilerAgent: typeof queryCompilerAgent;
}

const defaultDependencies: AgentRouteDependencies = {
  intakeAgent,
  conceptExtractionAgent,
  ontologyMappingAgent,
  queryLogicAgent,
  queryCompilerAgent,
};

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

class RequestBodyTooLargeError extends Error {}

async function readJsonBody(req: NextRequest): Promise<Record<string, unknown>> {
  const contentLength = req.headers.get("content-length");
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_REQUEST_BODY_BYTES
  ) {
    throw new RequestBodyTooLargeError();
  }

  if (!req.body) throw new SyntaxError("Missing request body");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new RequestBodyTooLargeError();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  ) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SyntaxError("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createAgentsPostHandler(
  overrides: Partial<AgentRouteDependencies> = {}
) {
  const dependencies = { ...defaultDependencies, ...overrides };

  return async function agentsPostHandler(req: NextRequest) {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return Response.json(
          { error: "request body is too large" },
          { status: 413 }
        );
      }
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }
    const {
      clinicalQuestion,
      startFromStage,
      intakeData,
      editedConcepts,
      editedMappings,
      editedQueryLogic,
      mappingsData,
      artifactToken,
    } = body;

    // Optional user-supplied API key (worktree-feat BYO key), threaded to
    // every agent so the pipeline can run on the caller's own key.
    const apiKey =
      typeof body.apiKey === "string" && body.apiKey ? body.apiKey : undefined;

    if (!clinicalQuestion || typeof clinicalQuestion !== "string") {
      return Response.json(
        { error: "clinicalQuestion is required" },
        { status: 400 }
      );
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        function send(data: Record<string, unknown>) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          );
        }

        try {
          if (!startFromStage || startFromStage === 1) {
            send({
              type: "stage_start",
              stage: 1,
              agent: "Intake & Literature Review",
            });
            const intakeResult = await dependencies.intakeAgent(
              clinicalQuestion,
              apiKey
            );
            send({
              type: "stage_complete",
              stage: 1,
              agent: "Intake & Literature Review",
              result: intakeResult,
            });
            send({ type: "stage1_review" });
          } else if (startFromStage === 2) {
            send({
              type: "stage_start",
              stage: 2,
              agent: "Clinical Concept Extraction",
            });
            const concepts = await dependencies.conceptExtractionAgent(
              clinicalQuestion,
              recordOrEmpty(intakeData),
              apiKey
            );
            send({
              type: "stage_complete",
              stage: 2,
              agent: "Clinical Concept Extraction",
              result: concepts,
            });
            send({ type: "stage2_review" });
          } else if (startFromStage === 3) {
            send({
              type: "stage_start",
              stage: 3,
              agent: "SHRINE Ontology Mapping",
            });
            const mappings = await dependencies.ontologyMappingAgent(
              recordOrEmpty(editedConcepts),
              apiKey
            );
            send({
              type: "stage_complete",
              stage: 3,
              agent: "SHRINE Ontology Mapping",
              result: mappings,
            });
            send({ type: "stage3_review" });
          } else if (startFromStage === 4) {
            send({
              type: "stage_start",
              stage: 4,
              agent: "Query Logic Builder",
            });
            const reviewedMappings = editedMappings ?? mappingsData ?? {};
            const logic = await dependencies.queryLogicAgent(
              clinicalQuestion,
              recordOrEmpty(editedConcepts),
              reviewedMappings,
              apiKey
            );
            send({
              type: "stage_complete",
              stage: 4,
              agent: "Query Logic Builder",
              result: logic,
            });
            send({ type: "stage4_review", mappingsData: reviewedMappings });
          } else if (startFromStage === 5) {
            send({
              type: "stage_start",
              stage: 5,
              agent: "Sharephe / i2b2 XML Compiler",
            });
            const compiled = await dependencies.queryCompilerAgent(
              clinicalQuestion,
              editedQueryLogic || {},
              artifactToken
            );
            send({
              type: "stage_complete",
              stage: 5,
              agent: "Sharephe / i2b2 XML Compiler",
              result: compiled,
            });
            if (compiled.status === "success") {
              send({
                type: "pipeline_complete",
                message: "All stages complete.",
              });
            } else if (compiled.status === "needs_clarification") {
              send({ type: "stage4_review" });
            } else {
              send({
                type: "error",
                stage: 5,
                message: compiled.summary || "Step 5 compilation failed.",
              });
            }
          }
        } catch (error) {
          send({
            type: "error",
            message: error instanceof Error ? error.message : "Unknown error",
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  };
}
