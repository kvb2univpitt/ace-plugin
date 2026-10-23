"use client";

import type { Step5XmlPackage } from "@/lib/common/query-plan-types";
import type { CellData, TableData } from "@/types/stats-table";
import { IncidenceRateRatioTable } from "@/components/IncidenceRateRatioTable";


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

function createCellData(id: string, description: string, counts: number): CellData {
    return {
        id: id,
        description: description,
        counts: counts
    };
}

function getTableData(xmlPackage: Step5XmlPackage, patientCounts: Map<string, number>): TableData {
    const tableData: TableData = {
        r1c1: createCellData("", "", -1),
        r1c2: createCellData("", "", -1),
        r2c1: createCellData("", "", -1),
        r2c2: createCellData("", "", -1)
    };

    xmlPackage.artifacts.map((artifact) => {
        const queryId = artifact.queryId;
        const queryName = artifact.queryName;
        const tableCell = artifact.tableCell;
        const counts = patientCounts.get(queryId) ?? -1;

        const cellData = createCellData(queryId, queryName, counts);
        switch (tableCell) {
            case "r1c1":
                tableData.r1c1 = cellData;
                break;
            case "r1c2":
                tableData.r1c2 = cellData;
                break;
            case "r2c1":
                tableData.r2c1 = cellData;
                break;
            case "r2c2":
                tableData.r2c2 = cellData;
                break;
        }
    });

    return tableData;
}

function checkDataExists(tableData: TableData): string[] {
    const errorMsg: string[] = [];

    if (tableData.r1c1.counts < 0) {
        errorMsg.push("Counts for the exposed group that has a positive outcome.")
    }
    if (tableData.r1c2.counts < 0) {
        errorMsg.push("Total counts for the exposed group.");
    }
    if (tableData.r2c1.counts < 0) {
        errorMsg.push("Counts for the unexposed group that has a positive outcome.");
    }
    if (tableData.r2c2.counts < 0) {
        errorMsg.push("Total counts for the unexposed group.");
    }

    return errorMsg;
}

function checkDataIsValid(tableData: TableData): string[] {
    const errorMsg: string[] = [];

    if (tableData.r1c2.counts <= 0) {
        errorMsg.push("Total counts for the exposed group.");
    }
    if (tableData.r2c2.counts <= 0) {
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
        const tableData = getTableData(data, patientCounts);

        let errors = checkDataExists(tableData);
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

        errors = checkDataIsValid(tableData);
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

        return <IncidenceRateRatioTable package={data} tableData={tableData} />
    } else {
        return (
            <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <p className="font-semibold">No XML package was emitted.</p>
                <p className="mt-1">Review the refreshed Step 4 plan, then run Step 5 again.</p>
            </div>
        );
    }
}