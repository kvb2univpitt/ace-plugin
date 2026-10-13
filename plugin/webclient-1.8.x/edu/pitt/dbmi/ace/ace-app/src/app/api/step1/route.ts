import type { NextRequest } from "next/server";
import {
    conceptExtractionAgent,
    intakeAgent,
    ontologyMappingAgent,
    queryCompilerAgent,
    queryLogicAgent,
} from "../../../lib/agents";

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


class RequestBodyTooLargeError extends Error { }


export async function POST(req: NextRequest) {
    const dependencies = { ...defaultDependencies };
    try {
        const body: Record<string, unknown> = await req.json();

        const { clinicalQuestion } = body;

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
    } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
            return Response.json(
                { error: "request body is too large" },
                { status: 413 }
            );
        }
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }
}

// export async function POST(req: NextRequest) {
//     try {
//         const body: Record<string, unknown> = await req.json();

//         const {
//             clinicalQuestion,
//             startFromStage,
//             intakeData,
//             editedConcepts,
//             editedMappings,
//             editedQueryLogic,
//             mappingsData,
//             artifactToken,
//         } = body;

//         return Response.json({
//             question: clinicalQuestion,
//             name: 'Kevin Bui'
//         });
//     } catch (error) {
//         if (error instanceof RequestBodyTooLargeError) {
//             return Response.json(
//                 { error: "request body is too large" },
//                 { status: 413 }
//             );
//         }
//         return Response.json({ error: "invalid JSON body" }, { status: 400 });
//     }
// }

export async function GET() {
    return Response.json({ message: 'Hello world!' });
}