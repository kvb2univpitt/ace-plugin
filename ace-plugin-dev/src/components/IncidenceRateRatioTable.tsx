"use client";

import type { CountData } from "@/types/stats-table";

interface Interpretation {
    direction: "reduction" | "increase" | "none";
    percentageChange: string;
    isSignificant: boolean;
    verdict: string;
    narrative: string;
}

function getInterpretation(irr: number, pValue: number, alpha: number): Interpretation {
    const isSignificant = pValue < alpha;

    if (!isSignificant) {
        return {
            direction: "none",
            percentageChange: "0%",
            isSignificant: false,
            verdict: "No Statistically Significant Difference",
            narrative: `The data does not provide sufficient evidence to conclude that the event rates differ between the groups (p = ${pValue.toFixed(4)} ≥ α = ${alpha}). Any observed difference from parity (IRR = 1.0) could likely be due to random sampling variation.`,
        };
    }

    if (irr < 1) {
        const reduction = Math.round((1 - irr) * 100);
        return {
            direction: "reduction",
            percentageChange: `${reduction}%`,
            isSignificant: true,
            verdict: "Statistically Significant Protective Effect / Rate Reduction",
            narrative: `The exposed group experienced a statistically significant lower event rate compared to the unexposed group (p = ${pValue.toFixed(4)} < α = ${alpha}). Specifically, the rate of events is ${irr.toFixed(4)} times that of the control group, representing a ${reduction}% reduction in the incidence rate.`,
        };
    } else if (irr > 1) {
        const increase = Math.round((irr - 1) * 100);
        return {
            direction: "increase",
            percentageChange: `${increase}%`,
            isSignificant: true,
            verdict: "Statistically Significant Risk Factor / Rate Increase",
            narrative: `The exposed group experienced a statistically significant higher event rate compared to the unexposed group (p = ${pValue.toFixed(4)} < α = ${alpha}). Specifically, the rate of events is ${irr.toFixed(4)} times that of the control group, representing a ${increase}% increase in the incidence rate.`,
        };
    } else {
        return {
            direction: "none",
            percentageChange: "0%",
            isSignificant: true, // Mathematically paradoxical but structured safely
            verdict: "Perfect Parity",
            narrative: `The event rates are identical between both groups (IRR = 1.0), and this exact alignment is statistically verified (p = ${pValue.toFixed(4)}).`,
        };
    }
}

function normalCDF(z: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));

    return z > 0 ? 1 - p : p;
}

function InterpretationPanel({
    result: result
}: {
    result: Interpretation
}): React.ReactNode {
    return (
        <div className="space-y-6 md:col-span-2">
            <div className={`p-6 rounded-2xl border shadow-sm transition-colors duration-200 ${!result.isSignificant
                ? "bg-amber-50/40 border-amber-200"
                : result.direction === "reduction"
                    ? "bg-emerald-50/40 border-emerald-200"
                    : "bg-rose-50/40 border-rose-200"
                }`}>
                <div className="flex items-start space-x-4">
                    <div className="flex-1 space-y-1 text-sm">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium tracking-wide uppercase ${result.isSignificant ? "bg-indigo-100 text-indigo-800" : "bg-slate-200 text-slate-700"
                            }`}>
                            {result.isSignificant ? "Statistically Significant" : "Not Significant"}
                        </span>
                        <p className="font-bold text-slate-900 mt-2">{result.verdict}</p>
                        <p className="text-sm text-slate-600 mt-3 leading-relaxed">
                            {result.narrative}
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
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
    const alpha = 0.0001;

    const r1c4 = `${irr.toFixed(4)} (${lower95CI.toFixed(4)}-${upper95CI.toFixed(4)})`;

    const interpretation = getInterpretation(irr, pValue, alpha)

    return (
        <div className="grid grid-flow-row auto-rows-max">
            <div className="py-4">
                <div className="relative overflow-x-auto col-span-2">
                    <table className="text-sm [&_td]:px-6 [&_td]:py-4 [&_th]:px-6 [&_th]:py-4">
                        <thead>
                            <tr>
                                <th></th>
                                <th>Outcome</th>
                                <th>Total # of Patients</th>
                                <th>Total Outcomes per 100 Persons</th>
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
            </div>
            <div className="py-4">
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
                                <th className="px-6 py-2">Z-Score</th>
                                <td className="px-6 py-2">{zScore.toFixed(4)}</td>
                            </tr>
                            <tr className="hover:bg-gray-50 transition-colors">
                                <th className="px-6 py-2">P-Value</th>
                                <td className="px-6 py-2">{(pValue < alpha) ? '< 0.0001' : pValue.toFixed(4)}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
            <div className="py-4">
                <InterpretationPanel result={interpretation} />
            </div>
        </div>
    );
}