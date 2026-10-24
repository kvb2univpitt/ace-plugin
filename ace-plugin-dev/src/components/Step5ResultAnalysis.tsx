"use client";

import type { Step5XmlPackage } from "@/lib/common/query-plan-types";
import type { CountData } from "@/types/stats-table";
import { IncidenceRateRatioAnalysis } from "@/components/IncidenceRateRatioAnalysis";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStep5XmlPackage(value: unknown): value is Step5XmlPackage {
    if (!isRecord(value) || value.version !== "step5-i2b2-xml-v1") return false;
    if (typeof value.querySetName !== "string" || !Array.isArray(value.artifacts)) {
        return false;
    }
    if (
        !value.artifacts.every(
            (artifact) =>
                isRecord(artifact) &&
                typeof artifact.queryId === "string" &&
                typeof artifact.queryName === "string" &&
                (typeof artifact.xml === "string" || artifact.xml === null) &&
                (artifact.status === "ready" ||
                    artifact.status === "needs_mapping" ||
                    artifact.status === "needs_manual_review") &&
                typeof artifact.sharepheReady === "boolean" &&
                isStringArray(artifact.warnings) &&
                typeof artifact.panelSummary === "string"
        )
    ) {
        return false;
    }
    const summary = value.validationSummary;
    return (
        isRecord(summary) &&
        Number.isInteger(summary.readyCount) &&
        Number.isInteger(summary.needsMappingCount) &&
        Number.isInteger(summary.needsManualReviewCount) &&
        (summary.readyCount as number) >= 0 &&
        (summary.needsMappingCount as number) >= 0 &&
        (summary.needsManualReviewCount as number) >= 0 &&
        isStringArray(summary.warnings)
    );
}

function getNewCountData(): CountData {
    return {
        r1c1: {
            id: "",
            name: "",
            counts: -1
        },
        r1c2: {
            id: "",
            name: "",
            counts: -1
        },
        r2c1: {
            id: "",
            name: "",
            counts: -1
        },
        r2c2: {
            id: "",
            name: "",
            counts: -1
        }
    }
}


function getCountData(xmlPackage: Step5XmlPackage, patientCounts: Map<string, number>): CountData {
    const countData: CountData = getNewCountData();

    xmlPackage.artifacts.map((artifact) => {
        const queryId = artifact.queryId;
        const queryName = artifact.queryName;
        const counts = patientCounts.get(queryId) ?? -1;

        if (queryId.includes("-no-")) {
            // unexposed
            if (queryId.endsWith("-denominator")) {
                // total counts
                countData.r2c2.id = queryId;
                countData.r2c2.name = queryName;
                countData.r2c2.counts = counts;
            } else {
                // positive counts
                countData.r2c1.id = queryId;
                countData.r2c1.name = queryName;
                countData.r2c1.counts = counts;
            }
        } else {
            // exposed
            if (queryId.endsWith("-denominator")) {
                // total counts
                countData.r1c2.id = queryId;
                countData.r1c2.name = queryName;
                countData.r1c2.counts = counts;
            } else {
                // positive counts
                countData.r1c1.id = queryId;
                countData.r1c1.name = queryName;
                countData.r1c1.counts = counts;
            }
        }
    });

    return countData;
}

function checkDataExists(countData: CountData): string[] {
    const errorMsg: string[] = [];

    if (countData.r1c1.counts < 0) {
        errorMsg.push("Counts for the exposed group that has a positive outcome.")
    }
    if (countData.r1c2.counts < 0) {
        errorMsg.push("Total counts for the exposed group.");
    }
    if (countData.r2c1.counts < 0) {
        errorMsg.push("Counts for the unexposed group that has a positive outcome.");
    }
    if (countData.r2c2.counts < 0) {
        errorMsg.push("Total counts for the unexposed group.");
    }

    return errorMsg;
}

function checkDataIsValid(countData: CountData): string[] {
    const errorMsg: string[] = [];

    if (countData.r1c2.counts <= 0) {
        errorMsg.push("Total counts for the exposed group.");
    }
    if (countData.r2c2.counts <= 0) {
        errorMsg.push("Total counts for the unexposed group.");
    }

    return errorMsg;
}

export function Step5ResultAnalysis({
    data,
    patientCounts
}: {
    data: unknown;
    patientCounts: Map<string, number>;
}): React.ReactNode {
    if (isStep5XmlPackage(data)) {
        const countData = getCountData(data, patientCounts);

        let errors = checkDataExists(countData);
        if (errors.length > 0) {
            return (
                <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
                    <p className="font-semibold">Missing the following counts:</p>
                    <ul className="max-w-md space-y-1 text-body list-inside">
                        {errors.map((msg, index) => (
                            <li key={index} className="flex items-center">
                                <svg className="w-4 h-4 text-red-700 me-1.5 shrink-0" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24">
                                    <path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m15 9-6 6m0-6 6 6m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                                </svg>
                                {msg}
                            </li>
                        ))}
                    </ul>
                </div>
            );
        }

        errors = checkDataIsValid(countData);
        if (errors.length > 0) {
            return (
                <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
                    <p className="font-semibold">The following counts must be greater than 0:</p>
                    <ul className="max-w-md space-y-1 text-body list-inside">
                        {errors.map((msg, index) => (
                            <li key={index} className="flex items-center">
                                <svg className="w-4 h-4 text-red-700 me-1.5 shrink-0" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24">
                                    <path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m15 9-6 6m0-6 6 6m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                                </svg>
                                {msg}
                            </li>
                        ))}
                    </ul>
                </div>
            );
        }

        return (<IncidenceRateRatioAnalysis package={data} countData={countData} />);
    } else {
        return (
            <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <p className="font-semibold">No XML package was emitted.</p>
                <p className="mt-1">Review the refreshed Step 4 plan, then run Step 5 again.</p>
            </div>
        );
    }
}