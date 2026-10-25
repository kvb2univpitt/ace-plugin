"use client";

import type { CountData } from "@/types/stats-table";


export function QueryXMLResultTable({
    countData: countData
}: {
    countData: CountData
}): React.ReactNode {
    return (
        <div className="relative overflow-x-auto shadow-md">
            <table className="w-full text-sm text-left border-collapse">
                <caption className="font-bold caption-top p-2 italic text-gray-800 bg-gray-50 border-t border-gray-100">
                    i2b2 Query XML Results
                </caption>
                <thead className="bg-gray-200 border-b border-gray-200">
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
                        <td className="px-3 py-1">Exposed group with positive outcome.</td>
                    </tr>
                    <tr className="bg-gray-100">
                        <td className="px-3 py-1">{countData.r1c2.name}</td>
                        <td className="px-3 py-1">{countData.r1c2.counts}</td>
                        <td className="px-3 py-1">Exposed group total.</td>
                    </tr>
                    <tr className="bg-white">
                        <td className="px-3 py-1">{countData.r2c1.name}</td>
                        <td className="px-3 py-1">{countData.r2c1.counts}</td>
                        <td className="px-3 py-1">Unexposed group with positive outcome.</td>
                    </tr>
                    <tr className="bg-gray-100 ">
                        <td className="px-3 py-1">{countData.r2c2.name}</td>
                        <td className="px-3 py-1">{countData.r2c2.counts}</td>
                        <td className="px-3 py-1">Unexposed group total.</td>
                    </tr>
                </tbody>
            </table>
        </div>
    );
}