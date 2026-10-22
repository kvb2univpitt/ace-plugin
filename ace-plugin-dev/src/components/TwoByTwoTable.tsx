"use client";

import type { Step5XmlPackage } from "@/lib/common/query-plan-types";
import { getTableCellData } from "./Step5ResultAnalysis";

function normalCDF(z: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));

    return z > 0 ? 1 - p : p;
}

export function TwoByTwoTable(
    {
        package: xmlPackage,
        patientCounts: patientCounts
    }: {
        package: Step5XmlPackage,
        patientCounts: Map<string, number>
    }
): React.ReactNode {
    // get the table cell counts
    const cellData = getTableCellData(xmlPackage, patientCounts);

    // number of patients in the exposed group that test positive
    const r1c1 = cellData.get("r1c1");

    // total number of patients in the exposed group
    const r1c2 = cellData.get("r1c2");

    // number of patients in the unexposed group that test positive
    const r2c1 = cellData.get("r2c1");

    // total number of patients in the unexposed group
    const r2c2 = cellData.get("r2c2");

    // total # per 100 persons
    const r1c3 = (r1c1 && r1c2 && r1c2 > 0) ? (r1c1 / r1c2) : 0;
    const r2c3 = (r2c1 && r2c2 && r2c2 > 0) ? (r2c1 / r2c2) : 0;

    const irr = (r2c3 > 0) ? (r1c3 / r2c3) : 0;
    const lnIrr = Math.log(irr);
    const varLnIrr = (r1c1 && r2c1 && r1c1 > 0 && r2c1 > 0) ? (1.0 / r1c1) + (1.0 / r2c1) : 0;

    const lnStdErr = Math.sqrt(varLnIrr);
    const ci = 1.959964 * lnStdErr;
    const lower95CI = Math.exp(lnIrr - ci);
    const upper95CI = Math.exp(lnIrr + ci);

    const zScore = lnIrr / lnStdErr;
    const pValue = 2 * (1 - normalCDF(Math.abs(zScore)));

    const r1c4 = `${irr.toFixed(4)} (${lower95CI.toFixed(4)}-${upper95CI.toFixed(4)})`;

    return (
        <section aria-labelledby="step5-query-set" className="space-y-4">
            <div className="border-b border-gray-200 pb-4">
                <h5 id="step5-query-set" className="break-words text-base font-semibold text-gray-900">
                    {xmlPackage.querySetName || "Untitled i2b2 query set"}
                </h5>
            </div>
            <div className="relative overflow-x-auto">
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
        </section>
    );
}
