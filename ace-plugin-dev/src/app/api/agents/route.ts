import type { NextRequest } from "next/server";

import { promises as fs } from 'fs';
import path from 'path';
import { AgentResult } from "@/lib/agents";


class RequestBodyTooLargeError extends Error { }

async function loadFromFile(filename: string): Promise<string> {
    // build an absolute path to the JSON file using process.cwd()
    const filePath = path.join(process.cwd(), 'sample_response_data', filename);

    // read the file contents as a string
    const fileContents = await fs.readFile(filePath, 'utf8');

    return fileContents;
};
async function loadAgentResultFromFile(filename: string): Promise<AgentResult> {
    return JSON.parse(await loadFromFile(filename));
};
async function loadUnknownFromFile(filename: string): Promise<unknown> {
    return JSON.parse(await loadFromFile(filename));
};

export async function POST(req: NextRequest) {
    try {
        const body: Record<string, unknown> = await req.json();

        const {
            clinicalQuestion,
            startFromStage,
        } = body;

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

                        const intakeResult = await loadAgentResultFromFile('step1_intake_result.json');
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

                        const concepts = await loadAgentResultFromFile('step2_concepts.json');
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

                        const mappings = await loadAgentResultFromFile('step3_mappings.json');
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

                        const reviewedMappings = await loadUnknownFromFile('step4_reviewed_mappings.json');
                        const logic = await loadAgentResultFromFile('step4_logic.json');
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

                        const compiled = await loadAgentResultFromFile('step5_compiled.json');
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