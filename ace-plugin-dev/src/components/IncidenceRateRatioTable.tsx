"use client";

import type { CountData } from "@/types/stats-table";


function normalCDF(z: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));

    return z > 0 ? 1 - p : p;
}

export function IncidenceRateRatioTable({
    countData: countData
}: {
    countData: CountData
}): React.ReactNode {
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

    const r1c4 = `${irr.toFixed(4)} (${lower95CI.toFixed(4)}-${upper95CI.toFixed(4)})`;

    return (
        <div className="grid grid-flow-col grid-rows-2 gap-4">
            <div className="relative overflow-x-auto col-span-2">
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
            <div className="max-w-fit overflow-hidden bg-white border border-gray-200 shadow-md">
                <table className="w-full text-sm text-left border-collapse table-auto">
                    <tbody className="divide-y divide-gray-200">
                        <tr className="hover:bg-gray-50 transition-colors">
                            <th className="px-6 py-2">SE for ln(IRR)</th>
                            <td className="px-6 py-2">{lnStdErr.toFixed(4)}</td>
                        </tr>
                        <tr className="hover:bg-gray-50 transition-colors">
                            <th className="px-6 py-2">Incidence Rate Ratio</th>
                            <td className="px-6 py-2">{irr.toFixed(4)}</td>
                        </tr>
                        <tr className="hover:bg-gray-50 transition-colors">
                            <th className="px-6 py-2">Lower Bound 95% CI</th>
                            <td className="px-6 py-2">{lower95CI.toFixed(4)}</td>
                        </tr>
                        <tr className="hover:bg-gray-50 transition-colors">
                            <th className="px-6 py-2">Upper Bound 95% CI</th>
                            <td className="px-6 py-2">{upper95CI.toFixed(4)}</td>
                        </tr>
                        <tr className="hover:bg-gray-50 transition-colors">
                            <th className="px-6 py-2">P-Value</th>
                            <td className="px-6 py-2">{(pValue < 0.0001) ? '< 0.0001' : pValue.toFixed(4)}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    );
}