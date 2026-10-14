import type { NextRequest } from "next/server";
import {
    conceptExtractionAgent,
    intakeAgent,
    ontologyMappingAgent,
    queryCompilerAgent,
    queryLogicAgent,
} from "../../../../../lib/agents";

// development
import { promises as fs } from 'fs';
import path from 'path';
import { AgentResult } from "../../../../../lib/agents";

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

function recordOrEmpty(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}


class RequestBodyTooLargeError extends Error { }

async function loadAgentResultFromFile(filename: string): Promise<AgentResult> {
    // build an absolute path to the JSON file using process.cwd()
    const filePath = path.join(process.cwd(), 'data', filename);

    // read the file contents as a string
    const fileContents = await fs.readFile(filePath, 'utf8');

    return JSON.parse(fileContents);
}
async function saveAgentResultToFile(data: AgentResult, filename: string): Promise<{ success: boolean; message: string }> {
    try {
        // resolve the file path in your project directory
        const filePath = path.join(process.cwd(), 'data', filename);

        // ensure the data is formatted cleanly as JSON
        const jsonString = JSON.stringify(data, null, 4);

        // write the file asynchronously
        await fs.writeFile(filePath, jsonString, 'utf8');

        return { success: true, message: 'JSON file saved successfully.' };
    } catch (error) {
        console.error('Error writing JSON file:', error);
        return { success: false, message: 'Failed to save JSON file.' };
    }
}


export async function POST(req: NextRequest) {
    const dependencies = { ...defaultDependencies };
    try {
        const body: Record<string, unknown> = await req.json();

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
                        // const intakeResult = await dependencies.intakeAgent(
                        //     clinicalQuestion,
                        //     apiKey
                        // );
                        const intakeResult = await loadAgentResultFromFile('step1.json');
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
                        // const concepts = await dependencies.conceptExtractionAgent(
                        //     clinicalQuestion,
                        //     recordOrEmpty(intakeData),
                        //     apiKey
                        // );
                        const concepts = await loadAgentResultFromFile('step2.json');
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
                        await saveAgentResultToFile(mappings, 'step3.json');
                        // const mappings = await readAgentResultFromFile('step3.json');
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