"use client";

import type { Step5XmlPackage } from "@/lib/common/query-plan-types";
import type { CountData } from "@/types/stats-table";
import { TwoByTwoTable } from "@/components/TwoByTwoTable"
import { IncidenceRateRatioTable } from "@/components/IncidenceRateRatioTable"
import { QueryXMLResultTable } from "@/components/QueryXMLResultTable"


export function IncidenceRateRatioAnalysis({
    package: xmlPackage,
    countData: countData
}: {
    package: Step5XmlPackage,
    countData: CountData
}): React.ReactNode {

    return (
        <section aria-labelledby="step5-query-set" className="space-y-4">
            <div className="border-b border-gray-200 pb-4">
                <h5 id="step5-query-set" className="wrap-break-word text-base font-semibold text-gray-900">{xmlPackage.querySetName || "Untitled i2b2 query set"}</h5>
                <div className="mt-2 flex flex-wrap gap-2 text-xs font-semibold">
                    <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-700">Ready {xmlPackage.validationSummary.readyCount}</span>
                    <span className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-red-700">Needs mapping {xmlPackage.validationSummary.needsMappingCount}</span>
                    <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-amber-700">Manual review {xmlPackage.validationSummary.needsManualReviewCount}</span>
                </div>
            </div>

            {xmlPackage.validationSummary.warnings.length > 0 ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    <p className="font-semibold">Package warnings</p>
                    <ul className="mt-1 list-disc space-y-1 pl-5">
                        {xmlPackage.validationSummary.warnings.map((warning, index) => (
                            <li key={`${index}-${warning}`}>{warning}</li>
                        ))}
                    </ul>
                </div>
            ) : null}

            <article className="rounded-lg border border-gray-200 bg-white">
                <header className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-200 px-4 py-3">
                    <div className="min-w-0">
                        <h6 className="wrap-break-word text-sm font-semibold text-gray-900">2x2 Table</h6>
                    </div>
                </header>
                <div className="border-t border-gray-200 px-4 pt-2 pb-6">
                    <div className="grid grid-flow-col grid-rows-2 gap-6">
                        <TwoByTwoTable countData={countData} />
                        <QueryXMLResultTable countData={countData} />
                    </div>
                </div>
            </article>

            <article className="rounded-lg border border-gray-200 bg-white">
                <header className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-200 px-4 py-3">
                    <div className="min-w-0">
                        <h6 className="wrap-break-word text-sm font-semibold text-gray-900">Incidence Rate Ratio (IRR)</h6>
                    </div>
                </header>
                <div className="border-t border-gray-200 px-4 py-6 pb-6">
                    <IncidenceRateRatioTable countData={countData} />
                </div>
            </article>
        </section>
    );
}