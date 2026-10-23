"use client";

import type { Step5XmlPackage } from "@/lib/common/query-plan-types";
import type { TableData, TableCounts, IncidenceRateRatio } from "@/types/stats-table";


function normalCDF(z: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));

    return z > 0 ? 1 - p : p;
}

function computeTableCounts(tableData: TableData): TableCounts {
    const r1c1 = tableData.r1c1.counts;
    const r1c2 = tableData.r1c2.counts;
    const r2c1 = tableData.r2c1.counts;
    const r2c2 = tableData.r2c2.counts;

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

function computeIncidenceRateRatio(tableData: TableData): IncidenceRateRatio {
    const r1c1 = tableData.r1c1.counts;
    const r1c2 = tableData.r1c2.counts;
    const r2c1 = tableData.r2c1.counts;
    const r2c2 = tableData.r2c2.counts;

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

export function TwoByTwoTable({
    counts: counts
}: {
    counts: TableCounts
}): React.ReactNode {
    return (
        <div className="relative overflow-x-auto">
            <table className="text-sm [&_td]:px-6 [&_td]:py-4 [&_th]:px-6 [&_th]:py-4">
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

export function IncidenceRateRatioTable({
    package: xmlPackage,
    tableData: tableData
}: {
    package: Step5XmlPackage,
    tableData: TableData
}): React.ReactNode {
    const counts = computeTableCounts(tableData);
    const irrStats = computeIncidenceRateRatio(tableData);

    const r1c1 = tableData.r1c1.counts;
    const r1c2 = tableData.r1c2.counts;
    const r2c1 = tableData.r2c1.counts;
    const r2c2 = tableData.r2c2.counts;

    const r1c3 = irrStats.exposedTotalPer100;
    const r2c3 = irrStats.unexposedTotalPer100

    const r1c4 = `${irrStats.irr.toFixed(4)} (${irrStats.lower95CI.toFixed(4)}-${irrStats.upper95CI.toFixed(4)})`;

    return (
        <section aria-labelledby="step5-query-set" className="space-y-4">
            <div className="border-b border-gray-200 pb-4">
                <h5 id="step5-query-set" className="wrap-break-word text-base font-semibold text-gray-900">{xmlPackage.querySetName || "Untitled i2b2 query set"}</h5>
            </div>
            <div className="relative overflow-x-auto mb-10">
                <table className="text-sm [&_td]:px-6 [&_td]:py-4 [&_th]:px-6 [&_th]:py-4">
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
            <div className="relative overflow-x-auto">
                <table className="w-60 border-collapse text-left text-sm text-gray-700">
                    <tbody>
                        <tr>
                            <th scope="row">SE for ln(IRR)</th>
                            <td>{irrStats.lnStdErr.toFixed(4)}</td>
                        </tr>
                        <tr>
                            <th scope="row">Incidence rate ratio</th>
                            <td>{irrStats.irr.toFixed(4)}</td>
                        </tr>
                        <tr>
                            <th scope="row">Lower bound 95% CI</th>
                            <td>{irrStats.lower95CI.toFixed(4)}</td>
                        </tr>
                        <tr>
                            <th scope="row">Upper bound 95% CI</th>
                            <td>{irrStats.upper95CI.toFixed(4)}</td>
                        </tr>
                        <tr>
                            <th scope="row">P-Value</th>
                            <td>{(irrStats.pValue < 0.0001) ? '< 0.0001' : irrStats.pValue.toFixed(4)}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </section>
    );
}