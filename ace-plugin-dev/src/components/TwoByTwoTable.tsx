"use client";

import type { CountData } from "@/types/stats-table";


export function TwoByTwoTable({
    countData: countData
}: {
    countData: CountData
}): React.ReactNode {
    const r1c1 = countData.r1c1.counts;
    const r1c2 = countData.r1c2.counts - countData.r1c1.counts;
    const r1c3 = countData.r1c2.counts;

    const r2c1 = countData.r2c1.counts;
    const r2c2 = countData.r2c2.counts - countData.r2c1.counts;
    const r2c3 = countData.r2c2.counts;

    const r3c1 = r1c1 + r2c1;
    const r3c2 = r1c2 + r2c2;
    const r3c3 = r1c3 + r2c3;


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
                        <td className="border-3 border-black text-center">{r1c1}</td>
                        <td className="border-3 border-black text-center">{r1c2}</td>
                        <td className="border border-slate-300 dark:border-slate-700 text-center">{r1c3}</td>
                    </tr>
                    <tr>
                        <th scope="row" className="text-right">Unexposed Group</th>
                        <td className="border-3 border-black text-center">{r2c1}</td>
                        <td className="border-3 border-black text-center">{r2c2}</td>
                        <td className="border border-slate-300 dark:border-slate-700 text-center">{r2c3}</td>
                    </tr>
                    <tr>
                        <th scope="row" className="text-right">Total</th>
                        <td className="border border-slate-300 dark:border-slate-700 text-center">{r3c1}</td>
                        <td className="border border-slate-300 dark:border-slate-700 text-center">{r3c2}</td>
                        <td className="border border-slate-300 dark:border-slate-700 text-center">{r3c3}</td>
                    </tr>
                </tbody>
            </table>
        </div>
    )
}