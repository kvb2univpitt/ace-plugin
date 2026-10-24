"use client";

import type { Step5XmlPackage } from "@/lib/common/query-plan-types";
import type { CountData, IncidenceRateRatio, TableCounts } from "@/types/stats-table";


function normalCDF(z: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));

    return z > 0 ? 1 - p : p;
}

function computeTableCounts(countData: CountData): TableCounts {
    const r1c1 = countData.r1c1.counts;
    const r1c2 = countData.r1c2.counts;
    const r2c1 = countData.r2c1.counts;
    const r2c2 = countData.r2c2.counts;

    return {
        exposed: {
            positive: r1c1,
            negative: r1c2 - r1c1,
            total: r1c2
        },
        unexposed: {
            positive: r2c1,
            negative: r2c2 - r2c1,
            total: r2c2
        }
    };
}

function computeIncidenceRateRatio(countData: CountData): IncidenceRateRatio {
    const r1c1 = countData.r1c1.counts;
    const r1c2 = countData.r1c2.counts;
    const r2c1 = countData.r2c1.counts;
    const r2c2 = countData.r2c2.counts;

    // total # per 100 persons
    const r1c3 = (r1c1 / r1c2);
    const r2c3 = (r2c1 / r2c2);

    const irr = (r1c3 / r2c3);
    const lnIrr = Math.log(irr);
    const varLnIrr = (1.0 / r1c1) + (1.0 / r2c1);

    const lnStdErr = Math.sqrt(varLnIrr);
    const ci = 1.959964 * lnStdErr;
    const lower95CI = Math.exp(lnIrr - ci);
    const upper95CI = Math.exp(lnIrr + ci);

    const zScore = lnIrr / lnStdErr;
    const pValue = 2 * (1 - normalCDF(Math.abs(zScore)));

    return {
        exposedTotalPer100: r1c3,
        unexposedTotalPer100: r2c3,
        irr: irr,
        lnIrr: lnIrr,
        varLnIrr: varLnIrr,
        lnStdErr: lnStdErr,
        ci: ci,
        lower95CI: lower95CI,
        upper95CI: upper95CI,
        zScore: zScore,
        pValue: pValue
    }
}

export function IncidenceRateRatioStatsTable({
    irrStats: irrStats
}: {
    irrStats: IncidenceRateRatio
}) {
    return (
        <div className="relative overflow-x-auto shadow-md max-w-4xl">
            <table className="text-sm text-left text-gray-700 border-collapse">
                <tbody className="divide-y divide-gray-200">
                    <tr>
                        <th scope="row" className="px-3 py-1">SE for ln(IRR)</th>
                        <td className="px-3 py-1">{irrStats.lnStdErr.toFixed(4)}</td>
                    </tr>
                    <tr className="bg-gray-100">
                        <th scope="row" className="px-3 py-1">Incidence rate ratio</th>
                        <td className="px-3 py-1">{irrStats.irr.toFixed(4)}</td>
                    </tr>
                    <tr>
                        <th scope="row" className="px-3 py-1">Lower bound 95% CI</th>
                        <td className="px-3 py-1">{irrStats.lower95CI.toFixed(4)}</td>
                    </tr>
                    <tr className="bg-gray-100">
                        <th scope="row" className="px-3 py-1">Upper bound 95% CI</th>
                        <td className="px-3 py-1">{irrStats.upper95CI.toFixed(4)}</td>
                    </tr>
                    <tr>
                        <th scope="row" className="px-3 py-1">P-Value</th>
                        <td className="px-3 py-1">{(irrStats.pValue < 0.0001) ? '< 0.0001' : irrStats.pValue.toFixed(4)}</td>
                    </tr>
                </tbody>
            </table>
        </div>
    );
}

export function IncidenceRateRatioCountsTable({
    countData: countData,
    irrStats: irrStats
}: {
    countData: CountData
    irrStats: IncidenceRateRatio
}) {
    const r1c1 = countData.r1c1.counts;
    const r1c2 = countData.r1c2.counts;
    const r2c1 = countData.r2c1.counts;
    const r2c2 = countData.r2c2.counts;

    const r1c3 = irrStats.exposedTotalPer100;
    const r2c3 = irrStats.unexposedTotalPer100

    const r1c4 = `${irrStats.irr.toFixed(4)} (${irrStats.lower95CI.toFixed(4)}-${irrStats.upper95CI.toFixed(4)})`;


    return (
        <div className="relative overflow-x-auto">
            <table className="text-sm text-gray-700 [&_td]:px-6 [&_td]:py-4 [&_th]:px-6 [&_th]:py-4">
                <thead>
                    <tr>
                        <th></th>
                        <th>Outcome</th>
                        <th>Total</th>
                        <th>Total # Per 100 Persons</th>
                        <th>Incidence rate ratio (95% CI)</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <th scope="row" className="text-right">Exposed Group</th>
                        <td className="border border-slate-300 dark:border-slate-700 text-center">{r1c1}</td>
                        <td className="border border-slate-300 dark:border-slate-700 text-center">{r1c2}</td>
                        <td className="border border-slate-300 dark:border-slate-700 text-center">{(r1c3 * 100).toFixed(2)}</td>
                        <td className="border border-slate-300 dark:border-slate-700 text-center">{r1c4}</td>
                    </tr>
                    <tr>
                        <th scope="row" className="text-right">Unexposed Group</th>
                        <td className="border border-slate-300 dark:border-slate-700 text-center">{r2c1}</td>
                        <td className="border border-slate-300 dark:border-slate-700 text-center">{r2c2}</td>
                        <td className="border border-slate-300 dark:border-slate-700 text-center">{(r2c3 * 100).toFixed(2)}</td>
                        <td className="border border-slate-300 dark:border-slate-700 bg-slate-700 text-center text-white">Reference</td>
                    </tr>
                </tbody>
            </table>
        </div>
    );
}

export function TwoByTwoTable({
    countData: countData
}: {
    countData: CountData
}): React.ReactNode {
    const counts = computeTableCounts(countData);

    return (
        <div className="relative overflow-x-auto">
            <table className="text-sm text-gray-700 [&_td]:px-6 [&_td]:py-4 [&_th]:px-6 [&_th]:py-4">
                <thead>
                    <tr>
                        <th></th>
                        <th>Positive</th>
                        <th>Negative</th>
                        <th>Total</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <th scope="row" className="text-right">Exposed Group</th>
                        <td className="border-3 border-black text-center">{counts.exposed.positive}</td>
                        <td className="border-3 border-black text-center">{counts.exposed.negative}</td>
                        <td className="border border-slate-300 dark:border-slate-700 text-center">{counts.exposed.positive + counts.exposed.negative}</td>
                    </tr>
                    <tr>
                        <th scope="row" className="text-right">Unexposed Group</th>
                        <td className="border-3 border-black text-center">{counts.unexposed.positive}</td>
                        <td className="border-3 border-black text-center">{counts.unexposed.negative}</td>
                        <td className="border border-slate-300 dark:border-slate-700 text-center">{counts.unexposed.total}</td>
                    </tr>
                    <tr>
                        <th scope="row" className="text-right">Total</th>
                        <td className="border border-slate-300 dark:border-slate-700 text-center">{counts.exposed.positive + counts.unexposed.positive}</td>
                        <td className="border border-slate-300 dark:border-slate-700 text-center">{counts.exposed.negative + counts.unexposed.negative}</td>
                        <td className="border border-slate-300 dark:border-slate-700 text-center">{counts.exposed.total + counts.unexposed.total}</td>
                    </tr>
                </tbody>
            </table>
        </div>
    );
}

export function QueryXMLResultTable({
    countData: countData
}: {
    countData: CountData
}): React.ReactNode {
    return (
        <div className="relative overflow-x-auto shadow-md max-w-4xl">
            <table className="text-sm text-left text-gray-700 border-collapse">
                <caption className="font-bold caption-bottom p-4 text-xs italic text-gray-800 bg-gray-50 border-t border-gray-100">
                    i2b2 Query XML Results
                </caption>
                <thead className="text-xs text-gray-700 bg-gray-200 border-b border-gray-200">
                    <tr>
                        <th scope="col" className="px-3 py-2 font-semibold">Query Name</th>
                        <th scope="col" className="px-3 py-2 font-semibold">Counts</th>
                        <th scope="col" className="px-3 py-2 font-semibold">Exposure</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                    <tr className="bg-white">
                        <td className="px-3 py-1">{countData.r1c1.name}</td>
                        <td className="px-3 py-1">{countData.r1c1.counts}</td>
                        <td className="px-3 py-1">Exposed with positive outcome.</td>
                    </tr>
                    <tr className="bg-gray-100">
                        <td className="px-3 py-1">{countData.r1c2.name}</td>
                        <td className="px-3 py-1">{countData.r1c2.counts}</td>
                        <td className="px-3 py-1">Exposed total counts.</td>
                    </tr>
                    <tr className="bg-white">
                        <td className="px-3 py-1">{countData.r2c1.name}</td>
                        <td className="px-3 py-1">{countData.r2c1.counts}</td>
                        <td className="px-3 py-1">Unexposed with positive outcome.</td>
                    </tr>
                    <tr className="bg-gray-100 ">
                        <td className="px-3 py-1">{countData.r2c2.name}</td>
                        <td className="px-3 py-1">{countData.r2c2.counts}</td>
                        <td className="px-3 py-1">Unexposed total counts.</td>
                    </tr>
                </tbody>
            </table>
        </div>
    );
}

export function IncidenceRateRatioAnalysis({
    package: xmlPackage,
    countData: countData
}: {
    package: Step5XmlPackage,
    countData: CountData
}): React.ReactNode {
    const irrStats = computeIncidenceRateRatio(countData);

    return (
        <section aria-labelledby="step5-query-set" className="space-y-4">
            <div className="border-b border-gray-200 py-6">
                <h5 id="step5-query-set" className="wrap-break-word text-base font-semibold text-gray-900">{xmlPackage.querySetName || "Untitled i2b2 query set"}</h5>
            </div>
            <div className="grid grid-flow-col grid-rows-4 gap-1">
                <TwoByTwoTable countData={countData} />
                <IncidenceRateRatioCountsTable countData={countData} irrStats={irrStats} />
                <QueryXMLResultTable countData={countData} />
                <IncidenceRateRatioStatsTable irrStats={irrStats} />
            </div>
        </section>

    )
}