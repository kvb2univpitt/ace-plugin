"use client";

import { useState, useCallback } from "react";
import type { Step5XmlPackage } from "@/lib/common/query-plan-types";
import { Step5ResultAnalysis } from "@/components/Step5ResultAnalysis";
import { step5XmlPackage } from "./data";
import { getFakeQueryXmlResults } from "@/lib/i2b2/query-xml"

export default function Home() {
    const [patientCounts, setPatientCounts] = useState<Map<string, number>>(new Map());
    const [data, setData] = useState<Step5XmlPackage>();

    const runPipeline = useCallback(async () => {
        setData(step5XmlPackage);
        setPatientCounts(getFakeQueryXmlResults(step5XmlPackage.artifacts));
    }, []);

    return (
        <div className="min-h-screen bg-white">
            <header className="border-b border-gray-200 bg-white/80 backdrop-blur-sm sticky top-0 z-50">
                <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-violet-600 flex items-center justify-center">
                            <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
                            </svg>
                        </div>
                        <div>
                            <h1 className="text-lg font-bold text-gray-900">ENACT ACE</h1>
                            <p className="text-xs text-gray-700">Automated Clinical Evidence</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="hidden items-center gap-2 sm:flex">
                            <span className="text-xs px-2 py-1 rounded-full bg-amber-50 text-amber-600 border border-amber-300 font-medium">ACE Clinician</span>
                            <span className="text-xs px-2 py-1 rounded-full bg-violet-50 text-violet-600 border border-violet-300 font-medium">Informatics</span>
                            <span className="text-xs px-2 py-1 rounded-full bg-blue-50 text-blue-600 border border-blue-300 font-medium">Statistics</span>
                            <span className="text-xs px-2 py-1 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-500/30 font-medium">Analyst</span>
                        </div>
                    </div>
                </div>
            </header>
            <main className="max-w-7xl mx-auto px-6 py-8">
                {/* Input Section */}
                <div className="mb-8">
                    <div className="bg-gray-50 rounded-2xl border border-gray-200 p-6">
                        <label className="block text-base font-medium text-gray-900 mb-2">
                            Clinical Question
                        </label>
                        <textarea
                            placeholder="Enter a clinical question (e.g., Is calf muscle injury associated with increased risk of deep vein thrombosis?)"
                            className="w-full h-32 bg-white border border-gray-300 rounded-xl px-4 py-3 text-base text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500/50 resize-none"
                        />
                        <div className="mt-4 flex flex-col items-stretch gap-4 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex min-w-0 flex-wrap gap-2">
                                <span className="text-sm text-gray-600">Examples:</span>
                            </div>
                            <button
                                onClick={() => runPipeline()}
                                className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-violet-600 px-4 py-2.5 text-center text-sm font-medium text-white transition-all hover:from-amber-400 hover:to-violet-500 disabled:cursor-not-allowed disabled:opacity-40 sm:ml-4 sm:w-auto sm:shrink-0 sm:px-6"
                            >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                                </svg>
                                Start Automated Clinical Evidence Generation
                            </button>
                        </div>
                    </div>
                </div>
                <div className="space-y-4">
                    <div className={`bg-gray-50 rounded-2xl border p-5 animate-slide-in`}>
                        <Step5ResultAnalysis data={data} patientCounts={patientCounts} />
                    </div>
                </div>
            </main>
        </div>
    );
}