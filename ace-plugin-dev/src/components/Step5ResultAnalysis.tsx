"use client";

import type { Step5XmlPackage } from "@/lib/common/query-plan-types";
import { TwoByTwoTable } from "@/components/TwoByTwoTable";


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

export function Step5ResultAnalysis({
    data,
    patientCounts
}: {
    data: unknown;
    patientCounts: Map<string, number>;
}): React.ReactNode {
    if (isStep5XmlPackage(data)) {
        return <TwoByTwoTable package={data} patientCounts={patientCounts} />;
    } else {
        return (
            <div
                role="alert"
                className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            >
                <p className="font-semibold">No XML package was emitted.</p>
                <p className="mt-1">
                    Review the refreshed Step 4 plan, then run Step 5 again.
                </p>
            </div>
        );
    }
}