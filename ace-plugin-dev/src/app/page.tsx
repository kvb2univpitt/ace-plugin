"use client";

import { useState, useRef, useCallback } from "react";
import {
  QueryPlanReview,
  QueryPlanSummary,
} from "@/components/QueryPlanReview";
import { Step5ResultAnalysis } from "@/components/Step5ResultAnalysis";
import {
  assertAgentStreamResponse,
  classifyStageCompletion,
  getSafeStep4ReviewUpdate,
  reviewStageForFailedContinuation,
  resolveStep4ReviewRecovery,
  type StageUiStatus,
} from "@/lib/common/agents-client-state";
import { hasValidationErrors } from "@/lib/stage4/query-plan-review";
import type {
  QueryPlanItem,
  Step4QueryPlan,
  Step4ReviewContext,
} from "@/lib/common/query-plan-types";
import { getPatientCounts } from "@/lib/i2b2/query-xml"

/** One member path of an expanded drug class, as shown in the review list. */
interface ClassPath {
  path: string;
  tableCd?: string;
  code: string;
  display: string;
}

interface StageResult {
  agent: string;
  status: string;
  data: Record<string, unknown>;
  summary: string;
  reviewContext?: Step4ReviewContext;
  patientCounts: Map<string, number>;
}

interface StageState {
  stage: number;
  agent: string;
  status: StageUiStatus;
  result?: StageResult;
}

type LabValueOperator =
  | "GreaterThan"
  | "GreaterThanOrEqual"
  | "Equal"
  | "LessThanOrEqual"
  | "LessThan";

type LabValueConstraint =
  | { type: "single"; operator: LabValueOperator; value: number; unit?: string | null }
  | { type: "range"; value1: number; value2: number; unit?: string | null }
  | { type: "flag"; flag: "High" | "Normal" | "Low" };

interface ConceptItem {
  name: string;
  role?: string;
  class?: string;
  /** Medications: "ingredient" | "class" — decides which ENACT medication table Step 3 searches. */
  conceptType?: string;
  type?: string;
  relevance?: string;
  valueConstraint?: LabValueConstraint | null;
}

const OPERATOR_SYMBOL: Record<LabValueOperator, string> = {
  GreaterThan: ">",
  GreaterThanOrEqual: "≥",
  Equal: "=",
  LessThanOrEqual: "≤",
  LessThan: "<",
};

function formatLabValueConstraint(vc: LabValueConstraint | null | undefined): string {
  if (!vc) return "";
  if (vc.type === "flag") return vc.flag;
  if (vc.type === "single") {
    const op = OPERATOR_SYMBOL[vc.operator] ?? vc.operator;
    return `${op} ${vc.value}${vc.unit ? " " + vc.unit : ""}`;
  }
  if (vc.type === "range") {
    return `${vc.value1}–${vc.value2}${vc.unit ? " " + vc.unit : ""}`;
  }
  return "";
}

const STAGES = [
  {
    num: 1,
    name: "Intake & Literature Review",
    color: "amber",
    description: "Validate question, check existing evidence, assess SHRINE suitability",
    team: "ACE Clinician Team",
  },
  {
    num: 2,
    name: "Clinical Concept Extraction",
    color: "violet",
    description: "Extract diseases, medications, labs, demographics, temporal relationships",
    team: "ACE Clinician & Informatics",
  },
  {
    num: 3,
    name: "SHRINE Ontology Mapping",
    color: "emerald",
    description: "Map concepts to ICD-10, RxNorm, LOINC codes in SHRINE dictionary",
    team: "Informatics Analyst Team",
  },
  {
    num: 4,
    name: "Query Logic Builder",
    color: "violet",
    description: "Define inclusion/exclusion criteria with With, Without, When logic",
    team: "ACE Clinician & Informatics",
  },
  {
    num: 5,
    name: "2x2 Table / Incidence Rate Ratio (IRR)",
    color: "blue",
    description: "Compile reviewed query logic into validated i2b2 XML",
    team: "Informatics Analyst Team",
  },
];

const EXAMPLE_QUESTIONS = [
  "Is calf muscle injury associated with increased risk of deep vein thrombosis?",
  "Does hydroxychloroquine (HCQ) prevent Covid-19 as post-exposure prophylaxis (after exposure to the virus)?",
  "Does empagliflozin (Jardiance) have a lower limb amputation (LLA) rate compared to canagliflozin (Invokana), as previously reported? FDA had issued a Boxed Warning on increased risk of LLAs for canagliflozin in 2017 and removed the Boxed Warning in September 2020.",
];

function StatusIcon({ status }: { status: StageUiStatus }) {
  if (status === "pending") {
    return (
      <div className="w-8 h-8 rounded-full border-2 border-gray-300 flex items-center justify-center">
        <div className="w-2 h-2 rounded-full bg-gray-300" />
      </div>
    );
  }
  if (status === "running") {
    return (
      <div className="relative w-8 h-8 flex items-center justify-center">
        <div className="absolute w-8 h-8 rounded-full border-2 border-amber-400 animate-pulse-ring" />
        <div className="w-4 h-4 rounded-full bg-amber-400 animate-pulse" />
      </div>
    );
  }
  if (status === "complete") {
    return (
      <div className="w-8 h-8 rounded-full bg-emerald-500 flex items-center justify-center">
        <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
    );
  }
  if (status === "needs_review") {
    return (
      <div className="w-8 h-8 rounded-full bg-amber-500 flex items-center justify-center">
        <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3.75h.008v.008H12V16.5z" />
        </svg>
      </div>
    );
  }
  return (
    <div className="w-8 h-8 rounded-full bg-red-500 flex items-center justify-center">
      <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </div>
  );
}

function colorClass(color: string, type: "bg" | "text" | "border") {
  const map: Record<string, Record<string, string>> = {
    amber: { bg: "bg-amber-50", text: "text-amber-600", border: "border-amber-300" },
    violet: { bg: "bg-violet-50", text: "text-violet-600", border: "border-violet-300" },
    emerald: { bg: "bg-emerald-50", text: "text-emerald-600", border: "border-emerald-300" },
    blue: { bg: "bg-blue-50", text: "text-blue-600", border: "border-blue-300" },
  };
  return map[color]?.[type] || "";
}

function renderDataSection(title: string, items: unknown) {
  if (!items || (Array.isArray(items) && items.length === 0)) return null;

  if (Array.isArray(items)) {
    return (
      <div className="mb-4">
        <h5 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-2">{title}</h5>
        <div className="flex flex-wrap gap-2">
          {items.map((item, i) => {
            const label = typeof item === "string" ? item : (item as Record<string, unknown>).name || (item as Record<string, unknown>).concept || (item as Record<string, unknown>).description || JSON.stringify(item);
            const sub = typeof item === "object" && item !== null
              ? (item as Record<string, unknown>).role || (item as Record<string, unknown>).class || (item as Record<string, unknown>).type || (item as Record<string, unknown>).system || ""
              : "";
            const conceptType = typeof item === "object" && item !== null
              ? (item as Record<string, unknown>).conceptType
              : "";
            return (
              <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-gray-200 text-sm text-gray-900">
                {String(label)}
                {sub && <span className="text-gray-600 text-xs">({String(sub)})</span>}
                {conceptType ? (
                  <span className="text-violet-700 text-xs px-1 py-0.5 rounded bg-violet-100">{String(conceptType)}</span>
                ) : null}
              </span>
            );
          })}
        </div>
      </div>
    );
  }

  if (typeof items === "object" && items !== null) {
    return (
      <div className="mb-4">
        <h5 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-2">{title}</h5>
        <div className="text-sm text-gray-900 bg-gray-100 rounded-md p-3 font-mono whitespace-pre-wrap">
          {JSON.stringify(items, null, 2)}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4">
      <h5 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-1">{title}</h5>
      <p className="text-base text-gray-900">{String(items)}</p>
    </div>
  );
}

function StageDetail({ result, stageNum, forceExpand }: { result: StageResult; stageNum: number; forceExpand?: boolean }) {
  const [expanded, setExpanded] = useState(stageNum === 5 || !!forceExpand);
  const data = result.data;
  const patientCounts = result.patientCounts;

  const renderContent = () => {
    switch (stageNum) {
      case 1:
        return (
          <>
            {renderDataSection("Question Type", data.questionType)}
            {renderDataSection("Refined Question", data.refinedQuestion)}
            {renderDataSection("Literature Status", data.literatureStatus)}
            {renderDataSection("Literature Notes", data.literatureNotes)}

            {(data.literaturePapers as { title: string; authors: string; year: string; url: string; relevance: string }[])?.length > 0 && (
              <div className="mb-4">
                <h5 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-2">Found Literature</h5>
                <div className="space-y-2">
                  {(data.literaturePapers as { title: string; authors: string; year: string; url: string; relevance: string }[]).map((paper, i) => (
                    <div key={i} className="p-3 rounded-lg bg-gray-50 border border-gray-200">
                      <a
                        href={paper.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-base font-medium text-amber-600 hover:text-amber-700 underline underline-offset-2 transition-colors"
                      >
                        {paper.title}
                      </a>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-sm text-gray-700">{paper.authors}</span>
                        {paper.year && <span className="text-xs px-1.5 py-0.5 rounded bg-gray-200 text-gray-900">{paper.year}</span>}
                      </div>
                      <p className="text-sm text-gray-600 mt-1">{paper.relevance}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {renderDataSection("SHRINE Suitable", data.suitableForShrine ? "Yes" : "No")}
            {renderDataSection("Suitability Notes", data.suitabilityNotes)}
            {(data.suggestedClarifications as string[])?.length > 0 &&
              renderDataSection("Suggested Clarifications", data.suggestedClarifications)}
          </>
        );
      case 2: {
        const labs = (data.labTests as ConceptItem[] | undefined) || [];
        return (
          <>
            {renderDataSection("Population", data.populationDescription)}
            {renderDataSection("Diseases/Conditions", data.diseases)}
            {renderDataSection("Medications", data.medications)}
            {labs.length > 0 && (
              <div className="mb-4">
                <h5 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-2">Lab Tests</h5>
                <div className="flex flex-wrap gap-2">
                  {labs.map((lab, i) => {
                    const vcLabel = formatLabValueConstraint(lab.valueConstraint);
                    return (
                      <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-gray-200 text-sm text-gray-900">
                        {lab.name}
                        {vcLabel && <span className="text-amber-700 font-mono text-xs">[{vcLabel}]</span>}
                        {lab.relevance && <span className="text-gray-600 text-xs">({lab.relevance})</span>}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
            {renderDataSection("Demographics", data.demographics)}
            {renderDataSection("Temporal Relationships", data.temporalRelationships)}
            {renderDataSection("Outcomes", data.outcomes)}
            {renderDataSection("Comparison Groups", data.comparisonGroups)}
          </>
        );
      }
      case 3:
        return (
          <>
            {renderDataSection("Mapping Confidence", data.mappingConfidence)}
            {renderDataSection("Mapping Notes", data.mappingNotes)}
            {(data.mappings as unknown[])?.map((m: unknown, i: number) => {
              const mapping = m as Record<string, unknown>;
              return (
                <div key={i} className="mb-2 p-3 rounded-md bg-gray-50 border border-gray-200">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-base font-medium text-gray-900">{String(mapping.concept)}</span>
                    <span className="text-sm px-2 py-0.5 rounded bg-gray-200 text-gray-700">{String(mapping.category)}</span>
                    {mapping.conceptType ? (
                      <span className="text-sm px-2 py-0.5 rounded bg-violet-100 text-violet-700">{String(mapping.conceptType)}</span>
                    ) : null}
                    <SourceBadge source={mapping.source as MappingItem["source"]} />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(mapping.codes as { system: string; code: string; display: string }[])?.map((c, j) => (
                      <span key={j} className="text-sm px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 font-mono">
                        {c.system}: {c.code}
                      </span>
                    ))}
                  </div>
                  {mapping.shrineOntologyPath ? (
                    <p className="text-sm text-gray-700 mt-1 font-mono">{String(mapping.shrineOntologyPath)}</p>
                  ) : null}
                </div>
              );
            })}
            {(data.unmappedConcepts as string[])?.length > 0 &&
              renderDataSection("Unmapped Concepts", data.unmappedConcepts)}
          </>
        );
      case 4:
        return <QueryPlanSummary plan={data as unknown as Step4QueryPlan} />;
      case 5:
        return <Step5ResultAnalysis data={data} patientCounts={patientCounts} />;
      default:
        return <pre className="text-sm text-gray-900 whitespace-pre-wrap">{JSON.stringify(data, null, 2)}</pre>;
    }
  };

  return (
    <div className="animate-slide-in">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 transition-colors mb-2"
      >
        <svg className={`w-3 h-3 transition-transform ${expanded ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        {expanded ? "Collapse details" : "Show details"}
      </button>
      {expanded && (
        <div className="pl-4 border-l border-gray-200 animate-slide-in">
          {renderContent()}
        </div>
      )}
    </div>
  );
}

// ─── Lab Value Controls ───
function LabValueControls({
  value,
  onChange,
}: {
  value: LabValueConstraint | null | undefined;
  onChange: (vc: LabValueConstraint | null) => void;
}) {
  const current = value ?? null;
  const type: "none" | "single" | "range" | "flag" = current?.type ?? "none";

  const setType = (t: "none" | "single" | "range" | "flag") => {
    if (t === "none") onChange(null);
    else if (t === "flag") onChange({ type: "flag", flag: (current as { flag?: "High" | "Normal" | "Low" })?.flag || "High" });
    else if (t === "single") {
      const prev = current as { operator?: LabValueOperator; value?: number; unit?: string | null } | null;
      onChange({ type: "single", operator: prev?.operator || "GreaterThan", value: prev?.value ?? 0, unit: prev?.unit ?? "" });
    } else {
      const prev = current as { value1?: number; value2?: number; unit?: string | null } | null;
      onChange({ type: "range", value1: prev?.value1 ?? 0, value2: prev?.value2 ?? 0, unit: prev?.unit ?? "" });
    }
  };

  const inputCls = "bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-500/40";

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <label className="block text-xs text-gray-600 mb-1">Value constraint</label>
        <select value={type} onChange={(e) => setType(e.target.value as "none" | "single" | "range" | "flag")} className={inputCls}>
          <option value="none">None</option>
          <option value="single">Threshold (e.g., &gt; 7.5)</option>
          <option value="range">Range (between…)</option>
          <option value="flag">Flag (High/Normal/Low)</option>
        </select>
      </div>
      {type === "single" && current?.type === "single" && (
        <>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Operator</label>
            <select
              value={current.operator}
              onChange={(e) => onChange({ ...current, operator: e.target.value as LabValueOperator })}
              className={inputCls}
            >
              <option value="GreaterThan">&gt;</option>
              <option value="GreaterThanOrEqual">≥</option>
              <option value="Equal">=</option>
              <option value="LessThanOrEqual">≤</option>
              <option value="LessThan">&lt;</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Value</label>
            <input
              type="number"
              step="any"
              value={Number.isFinite(current.value) ? current.value : ""}
              onChange={(e) => onChange({ ...current, value: e.target.value === "" ? 0 : parseFloat(e.target.value) })}
              className={`${inputCls} w-24`}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Unit</label>
            <input
              value={current.unit ?? ""}
              onChange={(e) => onChange({ ...current, unit: e.target.value })}
              placeholder="e.g., %, mg/dL"
              className={`${inputCls} w-28`}
            />
          </div>
        </>
      )}
      {type === "range" && current?.type === "range" && (
        <>
          <div>
            <label className="block text-xs text-gray-600 mb-1">From</label>
            <input
              type="number"
              step="any"
              value={Number.isFinite(current.value1) ? current.value1 : ""}
              onChange={(e) => onChange({ ...current, value1: e.target.value === "" ? 0 : parseFloat(e.target.value) })}
              className={`${inputCls} w-24`}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">To</label>
            <input
              type="number"
              step="any"
              value={Number.isFinite(current.value2) ? current.value2 : ""}
              onChange={(e) => onChange({ ...current, value2: e.target.value === "" ? 0 : parseFloat(e.target.value) })}
              className={`${inputCls} w-24`}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Unit</label>
            <input
              value={current.unit ?? ""}
              onChange={(e) => onChange({ ...current, unit: e.target.value })}
              placeholder="e.g., mg/dL"
              className={`${inputCls} w-28`}
            />
          </div>
        </>
      )}
      {type === "flag" && current?.type === "flag" && (
        <div>
          <label className="block text-xs text-gray-600 mb-1">Flag</label>
          <select
            value={current.flag}
            onChange={(e) => onChange({ ...current, flag: e.target.value as "High" | "Normal" | "Low" })}
            className={inputCls}
          >
            <option value="High">High</option>
            <option value="Normal">Normal</option>
            <option value="Low">Low</option>
          </select>
        </div>
      )}
    </div>
  );
}

// ─── Concept Editor (after Step 2) ───
function ConceptEditor({
  concepts,
  onChange,
}: {
  concepts: Record<string, unknown>;
  onChange: (updated: Record<string, unknown>) => void;
}) {
  const [addCategory, setAddCategory] = useState("diseases");
  const [addName, setAddName] = useState("");
  const [addRole, setAddRole] = useState("");
  const [addConceptType, setAddConceptType] = useState("");
  const [addLabValue, setAddLabValue] = useState<LabValueConstraint | null>(null);
  const [editingLabIdx, setEditingLabIdx] = useState<number | null>(null);

  // Medication conceptType. Step 3 routes on it: "ingredient" → RxNorm
  // ingredient table (ACT_MED_ALPHA_2018), "class" → VA drug-class nodes
  // (ACT_MED_VA_2018). The reviewer can flip it here before mapping runs.
  const CONCEPT_TYPE_OPTIONS = ["ingredient", "class"];

  const CATEGORIES = [
    { key: "diseases", label: "Diseases / Conditions", roleLabel: "Role", roleOptions: ["target_condition", "comorbidity", "exclusion"] },
    { key: "medications", label: "Medications", roleLabel: "Role", roleOptions: ["exposure", "comparator", "concomitant"] },
    { key: "labTests", label: "Lab Tests", roleLabel: "Relevance", roleOptions: [] },
    { key: "outcomes", label: "Outcomes", roleLabel: "Type", roleOptions: ["primary", "secondary"] },
  ];

  const removeItem = (category: string, index: number) => {
    const list = [...((concepts[category] as ConceptItem[]) || [])];
    list.splice(index, 1);
    onChange({ ...concepts, [category]: list });
    if (category === "labTests" && editingLabIdx === index) setEditingLabIdx(null);
  };

  const cycleConceptType = (category: string, index: number) => {
    const list = [...((concepts[category] as ConceptItem[]) || [])];
    const current = { ...list[index] };
    const currentIdx = CONCEPT_TYPE_OPTIONS.indexOf(current.conceptType || "");
    current.conceptType = CONCEPT_TYPE_OPTIONS[(currentIdx + 1) % CONCEPT_TYPE_OPTIONS.length];
    list[index] = current;
    onChange({ ...concepts, [category]: list });
  };

  const updateLabValueConstraint = (index: number, vc: LabValueConstraint | null) => {
    const list = [...((concepts.labTests as ConceptItem[]) || [])];
    const current = { ...list[index] };
    if (vc === null) delete current.valueConstraint;
    else current.valueConstraint = vc;
    list[index] = current;
    onChange({ ...concepts, labTests: list });
  };

  const addItem = () => {
    if (!addName.trim()) return;
    const list = [...((concepts[addCategory] as ConceptItem[]) || [])];
    const cat = CATEGORIES.find((c) => c.key === addCategory);
    const newItem: ConceptItem = { name: addName.trim() };
    if (addRole) {
      if (addCategory === "labTests") newItem.relevance = addRole;
      else if (addCategory === "medications") { newItem.role = addRole; }
      else if (addCategory === "diseases") newItem.role = addRole;
      else if (addCategory === "outcomes") newItem.type = addRole;
    } else if (cat?.roleOptions.length) {
      // default to first option
      if (addCategory === "diseases") newItem.role = cat.roleOptions[0];
      else if (addCategory === "medications") newItem.role = cat.roleOptions[0];
      else if (addCategory === "outcomes") newItem.type = cat.roleOptions[0];
    }
    if (addCategory === "medications") newItem.conceptType = addConceptType || CONCEPT_TYPE_OPTIONS[0];
    if (addCategory === "labTests" && addLabValue) newItem.valueConstraint = addLabValue;
    list.push(newItem);
    onChange({ ...concepts, [addCategory]: list });
    setAddName("");
    setAddRole("");
    setAddConceptType("");
    setAddLabValue(null);
  };

  return (
    <div className="space-y-4">
      {CATEGORIES.map((cat) => {
        const items = (concepts[cat.key] as ConceptItem[]) || [];
        if (items.length === 0) return null;
        const isLabCat = cat.key === "labTests";
        return (
          <div key={cat.key}>
            <h5 className="text-xs font-semibold text-gray-700 uppercase tracking-wider mb-2">{cat.label}</h5>
            <div className="flex flex-wrap gap-2">
              {items.map((item, i) => {
                const roleVal = item.role || item.class || item.type || item.relevance || "";
                const vcLabel = isLabCat ? formatLabValueConstraint(item.valueConstraint) : "";
                const isMedCat = cat.key === "medications";
                return (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-lg bg-gray-100 border border-gray-200 text-sm text-gray-900 group"
                  >
                    {item.name}
                    {vcLabel && <span className="text-amber-700 font-mono text-xs">[{vcLabel}]</span>}
                    {roleVal && <span className="text-gray-900 text-xs">({roleVal})</span>}
                    {isMedCat && (
                      <button
                        onClick={() => cycleConceptType(cat.key, i)}
                        className="text-violet-700 text-xs px-1.5 py-0.5 rounded bg-violet-100 hover:bg-violet-200 transition-colors"
                        title="Click to toggle ingredient / class — decides whether Step 3 searches the RxNorm ingredient table or the VA drug-class table"
                      >
                        {item.conceptType || "set type"}
                      </button>
                    )}
                    {isLabCat && (
                      <button
                        onClick={() => setEditingLabIdx(editingLabIdx === i ? null : i)}
                        className="ml-1 w-5 h-5 rounded-md flex items-center justify-center text-gray-500 hover:text-violet-600 hover:bg-violet-50 transition-colors"
                        title={item.valueConstraint ? "Edit lab value" : "Add lab value"}
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                    )}
                    <button
                      onClick={() => removeItem(cat.key, i)}
                      className="ml-1 w-5 h-5 rounded-md flex items-center justify-center text-gray-900 hover:text-red-600 hover:bg-red-50 transition-colors"
                      title="Remove"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </span>
                );
              })}
            </div>
            {isLabCat && editingLabIdx !== null && items[editingLabIdx] && (
              <div className="mt-3 p-3 rounded-lg bg-amber-50 border border-amber-200">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold text-amber-800">
                    Lab value for <span className="font-mono">{items[editingLabIdx].name}</span>
                  </p>
                  <button
                    onClick={() => setEditingLabIdx(null)}
                    className="text-xs text-gray-500 hover:text-gray-700 transition-colors"
                  >
                    Close
                  </button>
                </div>
                <LabValueControls
                  value={items[editingLabIdx].valueConstraint}
                  onChange={(vc) => updateLabValueConstraint(editingLabIdx, vc)}
                />
              </div>
            )}
          </div>
        );
      })}

      {/* Add concept form */}
      <div className="pt-3 border-t border-gray-200">
        <h5 className="text-xs font-semibold text-gray-700 uppercase tracking-wider mb-2">Add a Concept</h5>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="block text-xs text-gray-900 mb-1">Category</label>
            <select
              value={addCategory}
              onChange={(e) => { setAddCategory(e.target.value); setAddRole(""); setAddConceptType(""); setAddLabValue(null); }}
              className="bg-gray-100 border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
            >
              {CATEGORIES.map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
          </div>
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs text-gray-900 mb-1">Name</label>
            <input
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder="e.g., Type 2 Diabetes Mellitus"
              className="w-full bg-gray-100 border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
              onKeyDown={(e) => { if (e.key === "Enter") addItem(); }}
            />
          </div>
          {CATEGORIES.find((c) => c.key === addCategory)?.roleOptions.length ? (
            <div>
              <label className="block text-xs text-gray-900 mb-1">
                {CATEGORIES.find((c) => c.key === addCategory)?.roleLabel}
              </label>
              <select
                value={addRole}
                onChange={(e) => setAddRole(e.target.value)}
                className="bg-gray-100 border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
              >
                <option value="">Select...</option>
                {CATEGORIES.find((c) => c.key === addCategory)?.roleOptions.map((opt) => (
                  <option key={opt} value={opt}>{opt.replace(/_/g, " ")}</option>
                ))}
              </select>
            </div>
          ) : (
            <div className="flex-1 min-w-[150px]">
              <label className="block text-xs text-gray-900 mb-1">
                {CATEGORIES.find((c) => c.key === addCategory)?.roleLabel || "Detail"}
              </label>
              <input
                value={addRole}
                onChange={(e) => setAddRole(e.target.value)}
                placeholder="Optional"
                className="w-full bg-gray-100 border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
              />
            </div>
          )}
          {addCategory === "medications" && (
            <div>
              <label className="block text-xs text-gray-900 mb-1">Concept Type</label>
              <select
                value={addConceptType}
                onChange={(e) => setAddConceptType(e.target.value)}
                className="bg-gray-100 border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
              >
                {CONCEPT_TYPE_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
          )}
          <button
            onClick={addItem}
            disabled={!addName.trim()}
            className="px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Add
          </button>
        </div>
        {addCategory === "labTests" && (
          <div className="mt-3 p-3 rounded-lg bg-amber-50 border border-amber-200">
            <p className="text-xs font-semibold text-amber-800 mb-2">Optional: lab value for this concept</p>
            <LabValueControls value={addLabValue} onChange={setAddLabValue} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Mapping Editor (after Step 3) ───
interface MappingCode {
  system: string;
  code: string;
  display: string;
  /** ACT ontology path resolved for this code (used by Step 4 as the termPath). */
  shrineOntologyPath?: string;
  ontologyProof?: string;
}

interface MappingItem {
  concept: string;
  category: string;
  role?: string;
  /** Medications: "ingredient" | "class" — which ENACT medication table the path was resolved in. */
  conceptType?: string;
  codes: MappingCode[];
  shrineOntologyPath?: string;
  /** i2b2 C_TABLE_CD of shrineOntologyPath, preserved so Step 4 keeps the table prefix. */
  shrineOntologyTableCd?: string;
  notes?: string;
  /** Every path Step 4 queries. Length > 1 only for an expanded drug class. */
  shrineOntologyPaths?: { path: string; tableCd?: string; code: string; display: string; system?: string; ontologyProof?: string }[];
  /** "or" means the paths above are OR-ed into ONE criterion. */
  pathCombinator?: "single" | "or";
  /** Present with pathCombinator "or": which class was expanded, and how big. */
  classExpansion?: { classLabel: string; ingredientCount: number; combinationCount: number };
  /** Members the reviewer ticked out. Step 4 ignores these; they can be ticked back in. */
  excludedPaths?: { path: string; tableCd?: string; code: string; display: string; system?: string; ontologyProof?: string }[];
  /** PheCode this diagnosis is anchored on (the phenotype Step 4 queries). */
  phenotype?: {
    system: string;
    code: string;
    display: string;
    path: string;
    ontologyProof?: string;
  };
  /** All ICD codes the PheCode covers, for the expandable list. */
  constituentCodes?: MappingCode[];
  /** Standardized threshold (operator/value/unit) reviewed here and sent to Step 4. */
  valueConstraint?: LabValueConstraint | null;
  /** How the CODE was chosen. The path is always resolved from the ontology. */
  source?: "ontology" | "llm-disambiguated" | "llm-suggested";
  /** "exact" = tier 1-2 (code or exact name); "check" = tier 3-5, looser. */
  matchQuality?: "exact" | "check";
}

/**
 * Provenance badge. A row whose code the LLM proposed or re-picked is marked,
 * so a reviewer never has to guess whether a mapping came out of the ontology
 * search or out of a model. The PATH is always ontology-resolved either way —
 * Step 3 refuses to emit one the ENACT tables did not produce.
 */
function SourceBadge({ source }: { source?: MappingItem["source"] }) {
  if (!source || source === "ontology") return null;
  const suggested = source === "llm-suggested";
  return (
    <span
      title={
        suggested
          ? "The ontology search found no candidate. The LLM proposed this code, and it was then resolved to a real ACT path by exact-code match. Verify the code is right."
          : "The ontology search returned several close candidates; the LLM chose among them. The path comes from the ontology."
      }
      className="text-xs px-2 py-0.5 rounded bg-violet-100 text-violet-700 font-medium ring-1 ring-violet-200"
    >
      ✦ {suggested ? "LLM suggested" : "LLM picked"}
    </span>
  );
}

function MappingEditor({
  mappings,
  onChange,
}: {
  mappings: Record<string, unknown>;
  onChange: (updated: Record<string, unknown>) => void;
}) {
  const [addingTo, setAddingTo] = useState<number | null>(null);
  const [newSystem, setNewSystem] = useState("ICD-10-CM");
  const [newCode, setNewCode] = useState("");
  const [newDisplay, setNewDisplay] = useState("");
  const [resolving, setResolving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addOkPath, setAddOkPath] = useState<{ idx: number; code: string; path: string } | null>(null);
  const [editingVcIdx, setEditingVcIdx] = useState<number | null>(null);

  const items = (mappings.mappings as MappingItem[]) || [];

  const CODE_SYSTEMS = ["ICD-10-CM", "ICD-10-PCS", "RxNorm", "LOINC", "CPT", "HCPCS", "ATC"];

  const removeMapping = (index: number) => {
    const updated = [...items];
    updated.splice(index, 1);
    onChange({ ...mappings, mappings: updated });
  };

  // Explicitly drop an unmapped concept the clinician chooses not to pursue.
  // Step 4 errors on any concept left unmapped, so this is the human-in-the-loop
  // way to clear it (rather than silently ignoring it).
  const removeUnmapped = (index: number) => {
    const list = Array.isArray(mappings.unmappedConcepts)
      ? [...(mappings.unmappedConcepts as unknown[])]
      : [];
    list.splice(index, 1);
    onChange({ ...mappings, unmappedConcepts: list });
  };

  // Bulk-clear every unmapped concept at once. These are the concepts that block
  // Step 4 (derived endpoints, vague names, garbage like "unspecified"), and
  // clearing them one X at a time every run is the recurring pain point. They
  // can always be re-added via the mapping editor if one was needed.
  const clearAllUnmapped = () => {
    onChange({ ...mappings, unmappedConcepts: [] });
  };

  const removeCode = (mappingIdx: number, codeIdx: number) => {
    const updated = [...items];
    const codes = [...updated[mappingIdx].codes];
    codes.splice(codeIdx, 1);
    updated[mappingIdx] = { ...updated[mappingIdx], codes };
    onChange({ ...mappings, mappings: updated });
  };

  // The reviewer's threshold is authoritative — Step 4 reads it off the mapping
  // row and Step 5 compiles it into the SHRINE constraint.
  const updateValueConstraint = (mappingIdx: number, vc: LabValueConstraint | null) => {
    const updated = [...items];
    const row = { ...updated[mappingIdx] };
    if (vc === null) delete row.valueConstraint;
    else row.valueConstraint = vc;
    updated[mappingIdx] = row;
    onChange({ ...mappings, mappings: updated });
  };

  // Add a code manually AND resolve its ACT ontology path, so Step 4 gets a real
  // termPath for it (not just a bare code). The path is looked up in the same
  // ENACT ontology the automatic mapping uses.
  const addCode = async (mappingIdx: number) => {
    const codeVal = newCode.trim();
    if (!codeVal || resolving) return;
    const mapping = items[mappingIdx];
    const display = newDisplay.trim() || codeVal;
    setResolving(true);
    setAddError(null);

    // ENACT stores codes prefixed by system (e.g. "ICD10CM:E11.9"); if the user
    // typed a bare code, prefix it so the exact-code (tier-1) match can hit.
    const CODE_PREFIX: Record<string, string> = {
      "ICD-10-CM": "ICD10CM",
      "ICD-10-PCS": "ICD10PCS",
      RxNorm: "RXNORM",
      LOINC: "LOINC",
      CPT: "CPT4",
      HCPCS: "HCPCS",
    };
    const lookupCode = codeVal.includes(":")
      ? codeVal
      : CODE_PREFIX[newSystem]
        ? `${CODE_PREFIX[newSystem]}:${codeVal}`
        : codeVal;

    let resolvedCode: MappingCode | undefined;
    try {
      const ACE_REST_URL = (typeof window === 'undefined') ? '' : window.ACE_REST_URL;
      const resp = await fetch(`${ACE_REST_URL}/api/ontology/lookup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: display,
          code: lookupCode,
          category: mapping.category,
          role: mapping.role,
          codeSystem: newSystem,
          conceptType: mapping.conceptType,
          limit: 1,
        }),
      });
      const data = await resp.json();
      const candidate = data.paths?.[0] as Record<string, unknown> | undefined;
      if (
        resp.ok &&
        candidate &&
        typeof candidate.system === "string" &&
        typeof candidate.code === "string" &&
        typeof candidate.display === "string" &&
        typeof candidate.path === "string" &&
        typeof candidate.ontologyProof === "string"
      ) {
        resolvedCode = {
          system: candidate.system,
          code: candidate.code,
          display: candidate.display,
          shrineOntologyPath: candidate.path,
          ontologyProof: candidate.ontologyProof,
        };
      }
    } catch {
      /* lookup failed (offline / DB missing) — still add the code, just without a path */
    }

    const updated = [...items];
    const codes = [...updated[mappingIdx].codes];
    codes.push(
      resolvedCode ?? { system: newSystem, code: codeVal, display }
    );
    // If the concept had no ACT path yet, adopt this resolved path so Step 4 has
    // a queryable termPath for it.
    const nextPath =
      updated[mappingIdx].shrineOntologyPath ||
      resolvedCode?.shrineOntologyPath;
    updated[mappingIdx] = { ...updated[mappingIdx], codes, shrineOntologyPath: nextPath };
    onChange({ ...mappings, mappings: updated });

    setResolving(false);
    setNewCode("");
    setNewDisplay("");
    if (resolvedCode?.shrineOntologyPath) {
      // Surface the searched code's ACT path so the reviewer sees it resolved.
      setAddError(null);
      setAddOkPath({
        idx: mappingIdx,
        code: resolvedCode.code,
        path: resolvedCode.shrineOntologyPath,
      });
      setAddingTo(null);
    } else {
      // Keep the form open and warn — the reviewer should know Step 4 has no path.
      setAddOkPath(null);
      setAddError(
        `Added "${codeVal}", but no ACT path was found for it in the ${mapping.category} ontology. Step 4 will have no path for this code — check the code/system.`
      );
    }
  };

  // Tick one ingredient of an expanded drug class in or out. Moves it between
  // shrineOntologyPaths (what Step 4 queries) and excludedPaths (kept so the
  // reviewer can undo, and so the audit trail shows a deliberate exclusion).
  // shrineOntologyPath stays in sync as paths[0] for consumers reading the
  // singular field.
  const toggleClassPath = (mappingIdx: number, code: string) => {
    const updated = [...items];
    const m = updated[mappingIdx];
    const included = m.shrineOntologyPaths || [];
    const excluded = m.excludedPaths || [];
    const isIncluded = included.some((p) => p.code === code);

    const nextIncluded = isIncluded
      ? included.filter((p) => p.code !== code)
      : [...included, ...excluded.filter((p) => p.code === code)];
    const nextExcluded = isIncluded
      ? [...excluded, ...included.filter((p) => p.code === code)]
      : excluded.filter((p) => p.code !== code);

    updated[mappingIdx] = {
      ...m,
      shrineOntologyPaths: nextIncluded,
      excludedPaths: nextExcluded,
      shrineOntologyPath: nextIncluded[0]?.path ?? "",
      shrineOntologyTableCd: nextIncluded[0]?.tableCd,
    };
    onChange({ ...mappings, mappings: updated });
  };

  // Remove a constituent ICD code AND its sub-codes from the phenotype's set.
  const removeConstituent = (mappingIdx: number, codeStr: string) => {
    const keep = (c: MappingCode) =>
      !(
        c.code === codeStr ||
        (c.code.startsWith(codeStr) && c.code.length > codeStr.length)
      );
    const updated = [...items];
    const m = updated[mappingIdx];
    updated[mappingIdx] = {
      ...m,
      codes: (m.codes || []).filter(keep),
      constituentCodes: (m.constituentCodes || []).filter(keep),
    };
    onChange({ ...mappings, mappings: updated });
  };

  return (
    <div className="space-y-3">
      {items.map((mapping, i) => (
        <div key={i} className="p-4 rounded-lg bg-gray-50 border border-gray-200">
          <div className="flex items-center justify-between mb-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-medium text-gray-900">{mapping.concept}</span>
              <span className="text-sm px-2 py-0.5 rounded bg-gray-200 text-gray-700">{mapping.category}</span>
              {mapping.conceptType ? (
                <span
                  className="text-sm px-2 py-0.5 rounded bg-violet-100 text-violet-700"
                  title={
                    mapping.conceptType === "class"
                      ? "Drug class → resolved among VA drug-class nodes (ACT_MED_VA_2018)"
                      : "Ingredient → resolved in the RxNorm ingredient table (ACT_MED_ALPHA_2018)"
                  }
                >
                  {mapping.conceptType}
                </span>
              ) : null}
              {mapping.classExpansion && (
                <span
                  title={`Drug class with no VA class node — expanded to its member ingredients. Step 4 ORs all ${mapping.classExpansion.ingredientCount} paths into ONE criterion.`}
                  className="text-xs px-2 py-0.5 rounded bg-teal-100 text-teal-800 font-medium ring-1 ring-teal-200"
                >
                  ⋃ class · {mapping.classExpansion.ingredientCount} ingredients
                </span>
              )}
              {mapping.classExpansion && mapping.classExpansion.combinationCount > 0 && (
                <span
                  title="Combination products are included — a patient on the combo is exposed to the class. For a head-to-head comparison, check these don't also contain the comparator drug."
                  className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-medium ring-1 ring-amber-200"
                >
                  ⚠ {mapping.classExpansion.combinationCount} combination products
                </span>
              )}
              {mapping.phenotype && (
                <span
                  title={`Phenotype anchor — Step 4 queries this PheCode, which covers the ICD codes below.\n${mapping.phenotype.path}`}
                  className="text-xs px-2 py-0.5 rounded bg-indigo-100 text-indigo-700 font-medium ring-1 ring-indigo-200"
                >
                  ⌾ {mapping.phenotype.code} · phenotype
                </span>
              )}
              {mapping.valueConstraint && (
                <span
                  title="Value constraint — carried to Step 4 and compiled into the SHRINE constraint."
                  className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-mono font-medium ring-1 ring-amber-200"
                >
                  {formatLabValueConstraint(mapping.valueConstraint)}
                </span>
              )}
              <SourceBadge source={mapping.source} />
              {mapping.matchQuality === "check" && (
                <span
                  title="Matched on a prefix, substring or fuzzy name match rather than a code or exact name — confirm this is the intended concept."
                  className="text-xs px-2 py-0.5 rounded bg-orange-100 text-orange-700 font-medium ring-1 ring-orange-200"
                >
                  check match
                </span>
              )}
            </div>
            <button
              onClick={() => removeMapping(i)}
              className="w-7 h-7 rounded-md flex items-center justify-center text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
              title="Remove entire mapping"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Codes list */}
          <div className="flex flex-wrap gap-2 mb-2">
            {mapping.codes.map((c, j) => (
              <span key={j} className="inline-flex items-center gap-1 text-sm px-2 py-1 rounded bg-emerald-100 text-emerald-700 font-mono group">
                {c.system}: {c.code}
                {c.display && c.display !== c.code && (
                  <span className="text-emerald-600 font-sans text-xs">({c.display})</span>
                )}
                {c.shrineOntologyPath && (
                  <span
                    title={`ACT path: ${c.shrineOntologyPath}`}
                    className="text-emerald-500 font-sans text-[10px]"
                  >
                    ✓ path
                  </span>
                )}
                <button
                  onClick={() => removeCode(i, j)}
                  className="ml-0.5 w-4 h-4 rounded flex items-center justify-center text-emerald-500 hover:text-red-600 hover:bg-red-50 transition-colors"
                  title="Remove code"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            ))}
          </div>

          {/* Expanded drug-class members — every path Step 4 will OR together.
              Without this the row reads as "Statins → Lovastatin" and the
              reviewer approves 17 paths they never saw. */}
          {mapping.pathCombinator === "or" &&
            (mapping.shrineOntologyPaths?.length ||
              mapping.excludedPaths?.length) && (
              <ExpandedClassPaths
                included={mapping.shrineOntologyPaths || []}
                excluded={mapping.excludedPaths || []}
                onToggle={(code) => toggleClassPath(i, code)}
              />
            )}

          {/* Constituent ICD codes covered by the PheCode phenotype */}
          {mapping.constituentCodes && mapping.constituentCodes.length > 1 && (
            <ConstituentCodes
              codes={mapping.constituentCodes}
              onRemove={(codeStr) => removeConstituent(i, codeStr)}
            />
          )}

          {/* Value constraint — human-in-the-loop review of the standardized
              operator / value / unit before it reaches Step 4. Offered for
              measurement-style concepts, and always shown when one is present. */}
          {(mapping.category === "lab" ||
            mapping.category === "vital_sign" ||
            mapping.valueConstraint) && (
              <div className="mt-2 pt-2 border-t border-gray-200">
                {editingVcIdx === i ? (
                  <div className="space-y-2">
                    <LabValueControls
                      value={mapping.valueConstraint}
                      onChange={(vc) => updateValueConstraint(i, vc)}
                    />
                    <button
                      onClick={() => setEditingVcIdx(null)}
                      className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
                    >
                      Done
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setEditingVcIdx(i)}
                    className="flex items-center gap-1.5 text-sm text-amber-700 hover:text-amber-800 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                    {mapping.valueConstraint ? "Edit value constraint" : "Add value constraint"}
                  </button>
                )}
              </div>
            )}

          {/* Add code form */}
          {addingTo === i ? (
            <div className="flex flex-wrap items-end gap-2 mt-2 pt-2 border-t border-gray-200">
              <div>
                <label className="block text-xs text-gray-600 mb-1">System</label>
                <select
                  value={newSystem}
                  onChange={(e) => setNewSystem(e.target.value)}
                  className="bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                >
                  {CODE_SYSTEMS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="flex-1 min-w-[120px]">
                <label className="block text-xs text-gray-600 mb-1">Code</label>
                <input
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value)}
                  placeholder="e.g., E11.9"
                  className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                  onKeyDown={(e) => { if (e.key === "Enter") addCode(i); }}
                />
              </div>
              <div className="flex-1 min-w-[150px]">
                <label className="block text-xs text-gray-600 mb-1">Display Name</label>
                <input
                  value={newDisplay}
                  onChange={(e) => setNewDisplay(e.target.value)}
                  placeholder="Optional"
                  className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                />
              </div>
              <button
                onClick={() => addCode(i)}
                disabled={!newCode.trim() || resolving}
                className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {resolving ? "Resolving path…" : "Add"}
              </button>
              <button
                onClick={() => { setAddingTo(null); setNewCode(""); setNewDisplay(""); setAddError(null); setAddOkPath(null); }}
                className="text-sm text-gray-500 hover:text-gray-700 transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setAddingTo(i)}
              className="flex items-center gap-1.5 text-sm text-emerald-600 hover:text-emerald-700 transition-colors mt-1"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Add code
            </button>
          )}

          {addingTo === i && addError && (
            <p className="mt-2 text-xs text-amber-700">{addError}</p>
          )}
          {addOkPath?.idx === i && (
            <p className="mt-2 text-xs text-emerald-700 break-all">
              ✓ resolved <span className="font-mono">{addOkPath.code}</span> → ACT path:{" "}
              <span className="font-mono text-gray-600">{addOkPath.path}</span>
            </p>
          )}

          {mapping.shrineOntologyPath && (
            <p className="text-sm text-gray-600 mt-2 font-mono">{mapping.shrineOntologyPath}</p>
          )}
        </div>
      ))}

      {(mappings.unmappedConcepts as unknown[])?.length > 0 && (
        <div className="p-3 rounded-lg bg-amber-50 border border-amber-200">
          <div className="flex items-center justify-between mb-1">
            <h6 className="text-sm font-semibold text-amber-700">
              Unmapped Concepts ({(mappings.unmappedConcepts as unknown[]).length})
            </h6>
            <button
              onClick={clearAllUnmapped}
              title="Remove every unmapped concept at once"
              className="text-xs font-medium px-2 py-1 rounded bg-amber-200 text-amber-800 hover:bg-red-200 hover:text-red-700"
            >
              Remove all
            </button>
          </div>
          <p className="text-xs text-amber-600 mb-2">
            These have no ontology code, so Step 4 will block on them. Remove any you don&apos;t need in the query.
          </p>
          <div className="flex flex-wrap gap-2">
            {(mappings.unmappedConcepts as unknown[]).map((c, i) => {
              // step3 @5b617ce emits {concept, category, reason} objects; older
              // step3 emitted bare strings. Render either without crashing.
              const item = c as { concept?: string; reason?: string } | string;
              const label = typeof item === "string" ? item : item?.concept ?? JSON.stringify(item);
              const reason = typeof item === "string" ? undefined : item?.reason;
              return (
                <span key={i} title={reason} className="inline-flex items-center gap-1.5 text-sm px-2 py-1 rounded bg-amber-100 text-amber-800">
                  {label}
                  <button
                    onClick={() => removeUnmapped(i)}
                    title="Remove this unmapped concept"
                    className="text-amber-500 hover:text-red-600"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Nest a flat ICD code list into a parent/child tree by code prefix — a code's
// parent is the longest other code that is a prefix of it (E11 → E11.0 → E11.01).
interface IcdTreeNode {
  code: MappingCode;
  children: IcdTreeNode[];
}

function buildIcdTree(codes: MappingCode[]): IcdTreeNode[] {
  const nodes = [...codes]
    .sort((a, b) => a.code.length - b.code.length || a.code.localeCompare(b.code))
    .map((c) => ({ code: c, children: [] as IcdTreeNode[] }));
  const byCode = new Map(nodes.map((n) => [n.code.code, n]));
  const roots: IcdTreeNode[] = [];
  for (const n of nodes) {
    const code = n.code.code;
    let parent: IcdTreeNode | undefined;
    for (let i = code.length - 1; i >= 3; i--) {
      const cand = byCode.get(code.slice(0, i));
      if (cand) {
        parent = cand;
        break;
      }
    }
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  return roots;
}

// Reviewable checklist of the ingredients an expanded drug class resolves to.
//
// Every member is shown with the literal path Step 4 will query, and every one
// can be ticked out — a reviewer with clinical context the ontology lacks is
// the right person to decide that, say, a fixed-dose combination containing the
// study's comparator doesn't belong in the exposure arm. Ticked-out members are
// kept and greyed rather than deleted, so the decision is visible and undoable.
function ExpandedClassPaths({
  included,
  excluded,
  onToggle,
}: {
  included: ClassPath[];
  excluded: ClassPath[];
  onToggle: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const all = [...included, ...excluded].sort((a, b) => {
    const ca = a.display.includes("/") ? 1 : 0;
    const cb = b.display.includes("/") ? 1 : 0;
    if (ca !== cb) return ca - cb;
    return a.display.localeCompare(b.display);
  });
  const combos = included.filter((p) => p.display.includes("/")).length;
  const singles = included.length - combos;

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen(!open)}
        className="text-xs text-teal-800 hover:text-teal-900 hover:underline"
      >
        {open ? "▾" : "▸"} {included.length} of {all.length} ingredient paths
        OR-ed into one criterion ({singles} single agent
        {singles === 1 ? "" : "s"}
        {combos ? `, ${combos} combination` : ""})
        {excluded.length ? ` · ${excluded.length} excluded` : ""}
      </button>

      {included.length === 0 && (
        <div className="mt-1 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
          Every ingredient is excluded — this concept will reach Step 4 with no
          path and produce no criterion. Tick at least one back in, or remove
          the concept.
        </div>
      )}

      {open && (
        <ul className="mt-1.5 space-y-1 border-l-2 border-teal-200 pl-3">
          {all.map((p) => {
            const on = included.some((q) => q.code === p.code);
            return (
              <li key={p.code} className="text-xs">
                <label className="flex items-start gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => onToggle(p.code)}
                    className="mt-0.5 accent-teal-700"
                  />
                  <span className={on ? "" : "opacity-45 line-through"}>
                    <span className="font-mono text-teal-900">{p.code}</span>{" "}
                    <span className="text-gray-900">
                      {p.display.replace(/ \(\d+\).*$/, "")}
                    </span>
                    {p.display.includes("/") && (
                      <span
                        className="ml-1 text-amber-700"
                        title="Combination product — check it doesn't also contain the comparator drug."
                      >
                        ⚠
                      </span>
                    )}
                    <span className="block font-mono text-[10px] text-gray-500 break-all">
                      {p.path}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Collapsible HIERARCHY of the ICD codes a PheCode phenotype covers. Each node
// can be removed (cascading to its sub-codes) to curate the phenotype.
function ConstituentCodes({
  codes,
  onRemove,
}: {
  codes: MappingCode[];
  onRemove: (codeStr: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const tree = buildIcdTree(codes);
  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition-colors"
      >
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
        {open ? "Hide" : "Show"} {codes.length} ICD codes under this phenotype
      </button>
      {open && (
        <ul className="mt-2 border-l-2 border-indigo-100 pl-2">
          {tree.map((n) => (
            <IcdNode key={n.code.code} node={n} depth={0} onRemove={onRemove} />
          ))}
        </ul>
      )}
    </div>
  );
}

function IcdNode({
  node,
  depth,
  onRemove,
}: {
  node: IcdTreeNode;
  depth: number;
  onRemove: (codeStr: string) => void;
}) {
  const kids = node.children.length;
  return (
    <li>
      <div
        className="group flex items-center gap-1.5 py-0.5"
        style={{ paddingLeft: depth * 14 }}
      >
        <span className="font-mono text-xs text-gray-700">{node.code.code}</span>
        {node.code.display && node.code.display !== node.code.code && (
          <span className="text-xs text-gray-400">
            {node.code.display.slice(0, 48)}
          </span>
        )}
        <button
          onClick={() => onRemove(node.code.code)}
          title={
            kids
              ? `Remove ${node.code.code} and its ${kids} sub-code${kids === 1 ? "" : "s"}`
              : `Remove ${node.code.code}`
          }
          className="w-4 h-4 rounded flex items-center justify-center text-gray-300 opacity-0 group-hover:opacity-100 hover:text-red-600 hover:bg-red-50 transition"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      {kids > 0 && (
        <ul>
          {node.children.map((c) => (
            <IcdNode key={c.code.code} node={c} depth={depth + 1} onRemove={onRemove} />
          ))}
        </ul>
      )}
    </li>
  );
}

// ─── Review Panel wrapper (reused for steps 1, 2, 4) ───
function ReviewPanel({
  title,
  subtitle,
  children,
  continueLabel,
  onContinue,
  onBack,
  backLabel,
  disabled,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  continueLabel: string;
  onContinue: () => void;
  onBack?: () => void;
  backLabel?: string;
  disabled?: boolean;
}) {
  return (
    <div className="rounded-2xl border-2 border-amber-400 overflow-hidden animate-slide-in shadow-lg shadow-amber-100">
      <div className="bg-gradient-to-r from-amber-50 to-violet-50 border-b border-amber-300 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-100 border border-amber-300 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
            </svg>
          </div>
          <div>
            <h4 className="text-base font-bold text-gray-900">{title}</h4>
            <p className="text-base text-gray-900">{subtitle}</p>
          </div>
        </div>
      </div>
      <div className="bg-white px-6 py-5">
        {children}
        <div className="flex items-center justify-between mt-5 pt-4 border-t border-gray-200">
          <div>
            {onBack && (
              <button
                onClick={onBack}
                className="flex items-center gap-1.5 text-sm px-4 py-2.5 rounded-xl text-gray-600 bg-gray-100 border border-gray-200 hover:bg-gray-200 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
                </svg>
                {backLabel ?? "Go Back"}
              </button>
            )}
          </div>
          <button
            onClick={onContinue}
            disabled={disabled}
            className="px-8 py-3 rounded-xl bg-gradient-to-r from-amber-500 to-violet-600 text-white font-semibold text-base hover:from-amber-400 hover:to-violet-500 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-3 shadow-lg shadow-amber-200 hover:shadow-amber-300"
          >
            {continueLabel}
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ───
export default function Home() {
  const [question, setQuestion] = useState("");
  const [stages, setStages] = useState<StageState[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [pipelineMessage, setPipelineMessage] = useState<string | null>(null);

  // Step 1 review state
  const [awaitingReview, setAwaitingReview] = useState<1 | 2 | 3 | 4 | null>(null);
  const [revisedQuestion, setRevisedQuestion] = useState("");
  const [intakeData, setIntakeData] = useState<Record<string, unknown> | null>(null);

  // Step 2 review state
  const [editedConcepts, setEditedConcepts] = useState<Record<string, unknown> | null>(null);

  // Step 3 review state
  const [editedMappings, setEditedMappings] = useState<Record<string, unknown> | null>(null);

  // Step 4 review state
  const [editedQueryPlan, setEditedQueryPlan] = useState<Step4QueryPlan | null>(null);
  const [step4AuthoritativeItems, setStep4AuthoritativeItems] = useState<
    QueryPlanItem[] | null
  >(null);
  const [step4ArtifactToken, setStep4ArtifactToken] = useState<string | null>(null);
  const editedQueryPlanHasErrors = editedQueryPlan
    ? hasValidationErrors(editedQueryPlan)
    : false;

  // step 5
  const [patientCounts, setPatientCounts] = useState<Map<string, number>>(new Map());

  const abortRef = useRef<AbortController | null>(null);

  const streamEvents = useCallback(async (
    body: Record<string, unknown>,
    signal: AbortSignal
  ) => {
    const ACE_REST_URL = (typeof window === 'undefined') ? '' : window.ACE_REST_URL;
    const response = await fetch(`${ACE_REST_URL}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    try {
      await assertAgentStreamResponse(response);
    } catch (error) {
      const reviewStage = reviewStageForFailedContinuation(body.startFromStage);
      if (reviewStage !== null) setAwaitingReview(reviewStage);
      throw error;
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("Agent response did not include a stream body.");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(line.slice(6));

          if (event.type === "stage_start") {
            setStages((prev) =>
              prev.map((s) =>
                s.stage === event.stage ? { ...s, status: "running" } : s
              )
            );
          } else if (event.type === "stage_complete") {
            const completion = classifyStageCompletion(
              event.stage,
              event.result?.status
            );
            setStages((prev) =>
              prev.map((s) =>
                s.stage === event.stage
                  ? {
                    ...s,
                    status: completion.stageStatus,
                    result: event.result,
                  }
                  : s
              )
            );
            // Capture data for review states
            if (event.stage === 1 && event.result?.data) {
              setIntakeData(event.result.data);
              setRevisedQuestion(event.result.data.refinedQuestion || "");
            }
            if (event.stage === 2 && event.result?.data) {
              setEditedConcepts({ ...event.result.data });
            }
            if (event.stage === 3 && event.result?.data) {
              setEditedMappings({ ...event.result.data });
            }
            if (event.stage === 4) {
              const reviewUpdate = getSafeStep4ReviewUpdate(event.result);
              if (reviewUpdate) {
                setEditedQueryPlan(reviewUpdate.plan);
                setStep4AuthoritativeItems(
                  reviewUpdate.reviewContext.authoritativeItems
                );
                setStep4ArtifactToken(
                  reviewUpdate.reviewContext.artifactToken ?? null
                );
              }
            }
            if (event.stage === 5 && event.result?.data) {
              const counts: Map<string, number> = await getPatientCounts(event.result.data);

              setPatientCounts(counts);
            }

            if (completion.restoreStep4Review) {
              const recovery = resolveStep4ReviewRecovery(event.result);
              const reviewUpdate = recovery.update;
              if (reviewUpdate) {
                setEditedQueryPlan(reviewUpdate.plan);
                setStep4AuthoritativeItems(
                  reviewUpdate.reviewContext.authoritativeItems
                );
              }
              setStep4ArtifactToken(recovery.artifactToken);
              setAwaitingReview(4);
              setPipelineMessage(
                event.result.summary ||
                "Step 4 authorization failed. Review the refreshed query plan."
              );
            } else if (completion.clearStep4Review) {
              setAwaitingReview(null);
            } else if (event.stage === 5 && completion.stageStatus === "error") {
              setPipelineMessage(
                event.result?.summary || "Step 5 compilation failed."
              );
            }
          } else if (event.type === "stage1_review") {
            setAwaitingReview(1);
          } else if (event.type === "stage2_review") {
            setAwaitingReview(2);
          } else if (event.type === "stage3_review") {
            setAwaitingReview(3);
          } else if (event.type === "stage4_review") {
            setAwaitingReview(4);
          } else if (event.type === "pipeline_complete") {
            setPipelineMessage(event.message);
          } else if (event.type === "error") {
            setPipelineMessage(`Error: ${event.message}`);
          }
        } catch {
          // skip unparseable chunks
        }
      }
    }
  }, []);

  const runPipeline = useCallback(async (q: string) => {
    const questionToUse = q || question;
    if (!questionToUse.trim() || isRunning) return;

    setIsRunning(true);
    setPipelineMessage(null);
    setAwaitingReview(null);
    setIntakeData(null);
    setEditedConcepts(null);
    setEditedMappings(null);
    setEditedQueryPlan(null);
    setStep4AuthoritativeItems(null);
    setStep4ArtifactToken(null);
    setStages(STAGES.map((s) => ({ stage: s.num, agent: s.name, status: "pending" })));
    setPatientCounts(new Map())

    abortRef.current = new AbortController();

    try {
      await streamEvents({ clinicalQuestion: questionToUse }, abortRef.current.signal);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setPipelineMessage(`Error: ${(err as Error).message}`);
      }
    } finally {
      setIsRunning(false);
    }
  }, [question, isRunning, streamEvents]);

  const continueToStage2 = useCallback(async () => {
    const questionToUse = revisedQuestion.trim() || question;
    if (!questionToUse || isRunning) return;

    setIsRunning(true);
    setAwaitingReview(null);
    setPipelineMessage(null);
    setQuestion(questionToUse);

    abortRef.current = new AbortController();
    try {
      await streamEvents(
        { clinicalQuestion: questionToUse, startFromStage: 2, intakeData },
        abortRef.current.signal
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setPipelineMessage(`Error: ${(err as Error).message}`);
      }
    } finally {
      setIsRunning(false);
    }
  }, [revisedQuestion, question, isRunning, intakeData, streamEvents]);

  const continueToStage3 = useCallback(async () => {
    if (!editedConcepts || isRunning) return;

    setIsRunning(true);
    setAwaitingReview(null);
    setPipelineMessage(null);

    abortRef.current = new AbortController();
    try {
      await streamEvents(
        { clinicalQuestion: question, startFromStage: 3, editedConcepts },
        abortRef.current.signal
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setPipelineMessage(`Error: ${(err as Error).message}`);
      }
    } finally {
      setIsRunning(false);
    }
  }, [editedConcepts, question, isRunning, streamEvents]);

  const continueToStage4 = useCallback(async () => {
    if (!editedMappings || isRunning) return;

    setIsRunning(true);
    setAwaitingReview(null);
    setPipelineMessage(null);
    setStep4AuthoritativeItems(null);
    setStep4ArtifactToken(null);

    abortRef.current = new AbortController();
    try {
      await streamEvents(
        { clinicalQuestion: question, startFromStage: 4, editedConcepts, editedMappings },
        abortRef.current.signal
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setPipelineMessage(`Error: ${(err as Error).message}`);
      }
    } finally {
      setIsRunning(false);
    }
  }, [editedMappings, editedConcepts, question, isRunning, streamEvents]);

  const continueToStage5 = useCallback(async () => {
    if (!editedQueryPlan || isRunning) return;
    if (!step4ArtifactToken) {
      setPipelineMessage(
        "Step 4 review authorization is unavailable. Run Step 4 again before compiling."
      );
      return;
    }
    if (hasValidationErrors(editedQueryPlan)) {
      setPipelineMessage("Resolve Step 4 query plan errors before continuing to Step 5.");
      return;
    }

    setIsRunning(true);
    setPipelineMessage(null);

    abortRef.current = new AbortController();
    try {
      await streamEvents(
        {
          clinicalQuestion: question,
          startFromStage: 5,
          editedQueryLogic: editedQueryPlan,
          artifactToken: step4ArtifactToken,
        },
        abortRef.current.signal
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setPipelineMessage(`Error: ${(err as Error).message}`);
      }
    } finally {
      setIsRunning(false);
    }
  }, [editedQueryPlan, step4ArtifactToken, question, isRunning, streamEvents]);

  const goBackToStage = useCallback((stage: 1 | 2 | 3 | 4) => {
    if (isRunning) return;
    // Clear all stages after the target stage
    setStages((prev) =>
      prev.map((s) =>
        s.stage > stage ? { ...s, status: "pending", result: undefined } : s
      )
    );
    // Clear downstream state
    if (stage <= 1) {
      setEditedConcepts(null);
      setEditedMappings(null);
      setEditedQueryPlan(null);
      setStep4AuthoritativeItems(null);
    }
    if (stage <= 2) {
      setEditedMappings(null);
      setEditedQueryPlan(null);
      setStep4AuthoritativeItems(null);
    }
    if (stage <= 3) {
      setEditedQueryPlan(null);
      setStep4AuthoritativeItems(null);
      setStep4ArtifactToken(null);
    }
    setPipelineMessage(null);
    setAwaitingReview(stage);
  }, [isRunning]);

  // Reset everything back to a blank question (worktree-feat UX).
  const handleStartOver = useCallback(() => {
    if (isRunning) abortRef.current?.abort();
    setQuestion("");
    setStages([]);
    setIsRunning(false);
    setPipelineMessage(null);
    setAwaitingReview(null);
    setRevisedQuestion("");
    setIntakeData(null);
    setEditedConcepts(null);
    setEditedMappings(null);
    setEditedQueryPlan(null);
    setStep4AuthoritativeItems(null);
    setStep4ArtifactToken(null);
  }, [isRunning]);

  // Return to the question box, keeping the typed question (worktree-feat UX).
  const goBackToQuestion = useCallback(() => {
    if (isRunning) return;
    setStages([]);
    setAwaitingReview(null);
    setIntakeData(null);
    setEditedConcepts(null);
    setEditedMappings(null);
    setEditedQueryPlan(null);
    setStep4AuthoritativeItems(null);
    setStep4ArtifactToken(null);
    setPipelineMessage(null);
  }, [isRunning]);

  const [copiedStage, setCopiedStage] = useState<number | null>(null);

  const reviewStageLabel = awaitingReview === 1
    ? "Review Step 1 results below"
    : awaitingReview === 2
      ? "Edit concepts below"
      : awaitingReview === 3
        ? "Edit ontology mappings below"
        : awaitingReview === 4
          ? "Edit query plan below"
          : null;
  const stage5NeedsReview = stages.some(
    (stage) => stage.stage === 5 && stage.status === "needs_review"
  );

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
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
            {stages.length > 0 && (
              <button
                onClick={handleStartOver}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg text-gray-600 bg-gray-100 border border-gray-200 hover:bg-gray-200 transition-colors mr-2"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                </svg>
                Start Over
              </button>
            )}
            <div className="hidden items-center gap-2 sm:flex">
              <span className="text-xs px-2 py-1 rounded-full bg-amber-50 text-amber-600 border border-amber-300 font-medium">ACE Clinician</span>
              <span className="text-xs px-2 py-1 rounded-full bg-violet-50 text-violet-600 border border-violet-300 font-medium">Informatics</span>
              <span className="text-xs px-2 py-1 rounded-full bg-blue-50 text-blue-600 border border-blue-300 font-medium">Statistics</span>
              <span className="text-xs px-2 py-1 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-500/30 font-medium">Analyst</span>
            </div>
          </div>
        </div>
        {stages.length > 0 && (() => {
          const runningStage = stages.find((s) => s.status === "running");
          const isError = pipelineMessage?.startsWith("Error");
          return (
            <div className={`border-t px-6 py-2 flex items-center gap-3 text-xs font-medium ${isError
              ? "border-red-200 bg-red-50"
              : runningStage
                ? "border-amber-200 bg-amber-50"
                : awaitingReview || stage5NeedsReview
                  ? "border-amber-400 bg-amber-100"
                  : pipelineMessage
                    ? "border-emerald-200 bg-emerald-50"
                    : "border-gray-100 bg-white/80"
              }`}>
              {isError ? (
                <>
                  <div className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
                  <span className="text-red-600 truncate">{pipelineMessage}</span>
                </>
              ) : runningStage ? (
                <>
                  <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
                  <span className="text-amber-700">Processing Stage {runningStage.stage}: {runningStage.agent}</span>
                </>
              ) : awaitingReview ? (
                <>
                  <div className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
                  <span className="text-amber-800 font-semibold">Your review needed — Step {awaitingReview}</span>
                  <span className="text-amber-600 font-normal">Scroll down to continue</span>
                </>
              ) : pipelineMessage ? (
                <>
                  <div className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                  <span className="text-emerald-700">{pipelineMessage}</span>
                </>
              ) : null}
            </div>
          );
        })()}
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Input Section */}
        <div className="mb-8">
          <div className="bg-gray-50 rounded-2xl border border-gray-200 p-6">
            <label className="block text-base font-medium text-gray-900 mb-2">
              Clinical Question
            </label>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Enter a clinical question (e.g., Is calf muscle injury associated with increased risk of deep vein thrombosis?)"
              className="w-full h-32 bg-white border border-gray-300 rounded-xl px-4 py-3 text-base text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500/50 resize-none"
              disabled={isRunning}
            />
            <div className="mt-4 flex flex-col items-stretch gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-wrap gap-2">
                <span className="text-sm text-gray-600">Examples:</span>
                {EXAMPLE_QUESTIONS.map((eq, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setQuestion(eq);
                      setStages([]);
                      setPipelineMessage(null);
                    }}
                    className="text-xs px-2.5 py-1 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 hover:text-gray-900 transition-colors border border-gray-200 max-w-[200px] truncate"
                    disabled={isRunning}
                  >
                    {eq.slice(0, 60)}...
                  </button>
                ))}
              </div>
              <button
                onClick={() => runPipeline(question)}
                disabled={isRunning || !question.trim()}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-violet-600 px-4 py-2.5 text-center text-sm font-medium text-white transition-all hover:from-amber-400 hover:to-violet-500 disabled:cursor-not-allowed disabled:opacity-40 sm:ml-4 sm:w-auto sm:shrink-0 sm:px-6"
              >
                {isRunning ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Processing...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    Start Automated Clinical Evidence Generation
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Pipeline Visualization */}
        {stages.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
            {/* Stage Progress Sidebar */}
            <div className="bg-gray-50 rounded-2xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-900 mb-4">Agent Pipeline</h3>
              <div className="space-y-1">
                {STAGES.map((stage, i) => {
                  const state = stages.find((s) => s.stage === stage.num);
                  const isActive = state?.status === "running";
                  const isComplete = state?.status === "complete";
                  const needsReview = state?.status === "needs_review";
                  return (
                    <div key={stage.num}>
                      <div className={`flex items-start gap-3 p-3 rounded-xl transition-all ${isActive ? "bg-gray-100" : ""}`}>
                        <StatusIcon status={state?.status || "pending"} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`text-sm font-medium ${isComplete || isActive ? "text-gray-900" : needsReview ? "text-amber-800" : "text-gray-400"}`}>
                              {stage.name}
                            </span>
                          </div>
                          <p className={`text-xs mt-0.5 ${isActive || isComplete ? "text-gray-600" : needsReview ? "text-amber-700" : "text-gray-400"}`}>
                            {stage.description}
                          </p>
                          <span className={`inline-block text-xs mt-1 px-1.5 py-0.5 rounded ${colorClass(stage.color, "bg")} ${colorClass(stage.color, "text")}`}>
                            {stage.team}
                          </span>
                        </div>
                      </div>
                      {i < STAGES.length - 1 && (
                        <div className="flex justify-start ml-[15px] my-0.5">
                          <div className={`w-0.5 h-4 ${isComplete ? "bg-emerald-500/50" : "bg-gray-200"}`} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {awaitingReview && (
                <div className="mt-4 p-3 rounded-xl bg-amber-50 border border-amber-300 animate-pulse">
                  <div className="flex items-center gap-2 text-xs text-amber-600 font-semibold">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25v13.5m-7.5-13.5v13.5" />
                    </svg>
                    Waiting for your review
                  </div>
                  <p className="text-xs text-amber-500 mt-1">{reviewStageLabel}</p>
                </div>
              )}
              {pipelineMessage && (
                <div className={`mt-4 p-3 rounded-xl text-xs ${pipelineMessage.startsWith("Error") ? "bg-red-50 text-red-600 border border-red-200" : stage5NeedsReview ? "bg-amber-50 text-amber-800 border border-amber-200" : "bg-emerald-50 text-emerald-700 border border-emerald-200"}`}>
                  {pipelineMessage}
                </div>
              )}
            </div>

            {/* Stage Details */}
            <div className="space-y-4">
              {stages.map((state) => {
                const stageDef = STAGES.find((s) => s.num === state.stage)!;
                if (state.status === "pending") return null;

                return (
                  <div
                    key={state.stage}
                    className={`bg-gray-50 rounded-2xl border p-5 animate-slide-in ${state.status === "running"
                      ? "border-amber-300"
                      : state.status === "complete"
                        ? `${colorClass(stageDef.color, "border")}`
                        : state.status === "needs_review"
                          ? "border-amber-300"
                          : "border-red-500/30"
                      }`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <span className={`text-xs font-bold px-2 py-1 rounded-lg ${colorClass(stageDef.color, "bg")} ${colorClass(stageDef.color, "text")}`}>
                          Stage {state.stage}
                        </span>
                        <h4 className="text-sm font-semibold text-gray-900">{state.agent}</h4>
                      </div>
                      <div className="flex items-center gap-2">
                        {state.status === "running" && (
                          <div className="flex items-center gap-2 text-xs text-amber-600">
                            <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                            Processing...
                          </div>
                        )}
                        {state.status === "complete" && state.result && (
                          <button
                            onClick={() => {
                              const json = JSON.stringify(state.result!.data, null, 2);
                              navigator.clipboard.writeText(json).then(() => {
                                setCopiedStage(state.stage);
                                setTimeout(() => setCopiedStage(null), 2000);
                              }).catch(() => { });
                            }}
                            title="Copy stage output as JSON"
                            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg text-gray-500 bg-gray-100 border border-gray-200 hover:bg-gray-200 hover:text-gray-700 transition-colors"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                            </svg>
                            {copiedStage === state.stage ? "Copied!" : "Copy"}
                          </button>
                        )}
                        {state.status === "complete" && state.stage < 5 && !isRunning && awaitingReview !== state.stage && (
                          <button
                            onClick={() => goBackToStage(state.stage as 1 | 2 | 3 | 4)}
                            className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg text-violet-600 bg-violet-50 border border-violet-200 hover:bg-violet-100 transition-colors"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
                            </svg>
                            Edit this step
                          </button>
                        )}
                      </div>
                    </div>

                    {state.status === "running" && (
                      <div className="h-1 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-amber-500 to-violet-500 rounded-full animate-shimmer" style={{ width: "100%" }} />
                      </div>
                    )}

                    {state.result && (
                      <>
                        <p className="text-base text-gray-800 mb-3">{state.result.summary}</p>
                        <StageDetail
                          result={
                            state.stage === 2 && editedConcepts
                              ? { ...state.result, data: editedConcepts }
                              : state.stage === 3 && editedMappings
                                ? { ...state.result, data: editedMappings }
                                : state.stage === 4 && editedQueryPlan
                                  ? { ...state.result, data: editedQueryPlan as unknown as Record<string, unknown> }
                                  : { ...state.result, patientCounts: patientCounts }
                          }
                          stageNum={state.stage}
                          forceExpand={(state.stage === 1 && awaitingReview === 1) || (state.stage === 2 && awaitingReview === 2) || (state.stage === 3 && awaitingReview === 3) || (state.stage === 4 && awaitingReview === 4)}
                        />
                      </>
                    )}
                  </div>
                );
              })}

              {/* ─── Step 1 Review Panel ─── */}
              {awaitingReview === 1 && intakeData && (
                <ReviewPanel
                  title="Your Action Required"
                  subtitle="Review the literature findings above, then refine your question and continue."
                  continueLabel="Continue to Step 2"
                  onContinue={continueToStage2}
                  onBack={goBackToQuestion}
                  backLabel="← Edit question"
                  disabled={isRunning || !revisedQuestion.trim()}
                >
                  {/* Step instructions */}
                  <div className="flex items-start gap-6 mb-5 pb-5 border-b border-gray-200">
                    <div className="flex items-center gap-2 text-xs text-gray-700">
                      <span className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center text-xs font-bold">1</span>
                      Review literature
                    </div>
                    <svg className="w-4 h-4 text-gray-700 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5" />
                    </svg>
                    <div className="flex items-center gap-2 text-xs text-amber-600 font-medium">
                      <span className="w-5 h-5 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center text-xs font-bold">2</span>
                      Pick or write your question
                    </div>
                    <svg className="w-4 h-4 text-gray-700 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5" />
                    </svg>
                    <div className="flex items-center gap-2 text-xs text-gray-700">
                      <span className="w-5 h-5 rounded-full bg-gray-200 text-gray-700 flex items-center justify-center text-xs font-bold">3</span>
                      Continue
                    </div>
                  </div>

                  {/* Warning if not suitable for SHRINE */}
                  {!intakeData.suitableForShrine && (
                    <div className="mb-5 p-4 rounded-xl bg-amber-50 border border-amber-300">
                      <div className="flex items-start gap-3">
                        <svg className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                        </svg>
                        <div>
                          <h5 className="text-sm font-semibold text-amber-700">This question may not be ideal for SHRINE querying</h5>
                          <p className="text-xs text-amber-600 mt-1">{String(intakeData.suitabilityNotes || "The intake analysis flagged this question as potentially unsuitable for SHRINE. You may still proceed, but results may be limited.")}</p>
                          <p className="text-xs text-gray-700 mt-2">You can still continue to generate a SHRINE query, or revise your question below.</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Suggested revised questions */}
                  {(intakeData.revisedQuestions as { question: string; clarification: string }[])?.length > 0 && (
                    <div className="mb-5">
                      <h5 className="text-base font-semibold text-gray-900 mb-3">Suggested Revised Questions</h5>
                      <div className="space-y-2">
                        {(intakeData.revisedQuestions as { question: string; clarification: string }[]).map((rq, i) => (
                          <button
                            key={i}
                            onClick={() => setRevisedQuestion(rq.question)}
                            className={`w-full text-left p-4 rounded-xl border-2 transition-all group ${revisedQuestion === rq.question
                              ? "bg-violet-50 border-violet-400"
                              : "bg-gray-50 border-gray-200 hover:border-gray-400 hover:bg-gray-100"
                              }`}
                          >
                            <div className="flex items-start gap-3">
                              <div className={`w-5 h-5 mt-0.5 rounded-full border-2 flex items-center justify-center shrink-0 transition-all ${revisedQuestion === rq.question ? "border-violet-500 bg-violet-500" : "border-gray-400 group-hover:border-gray-500"
                                }`}>
                                {revisedQuestion === rq.question && <div className="w-2 h-2 rounded-full bg-white" />}
                              </div>
                              <div className="flex-1">
                                <p className={`text-base ${revisedQuestion === rq.question ? "text-gray-900" : "text-gray-800"}`}>{rq.question}</p>
                                <p className="text-sm text-violet-600 mt-1.5 flex items-center gap-1">
                                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                  </svg>
                                  {rq.clarification}
                                </p>
                              </div>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-4 mb-5">
                    <div className="flex-1 h-px bg-gray-200" />
                    <span className="text-sm text-gray-500 font-medium uppercase">or write your own</span>
                    <div className="flex-1 h-px bg-gray-200" />
                  </div>

                  <textarea
                    value={revisedQuestion}
                    onChange={(e) => setRevisedQuestion(e.target.value)}
                    className="w-full h-32 bg-white border-2 border-gray-300 rounded-xl px-4 py-3 text-base text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500/50 resize-none"
                    placeholder="Type or edit your clinical question here..."
                  />
                </ReviewPanel>
              )}

              {/* ─── Step 2 Review Panel: Concept Editor ─── */}
              {awaitingReview === 2 && editedConcepts && (
                <ReviewPanel
                  title="Review Extracted Concepts"
                  subtitle="Remove incorrect concepts or add missing ones before ontology mapping."
                  continueLabel="Continue to Step 3"
                  onContinue={continueToStage3}
                  onBack={() => goBackToStage(1)}
                  backLabel="← Back to Step 1"
                  disabled={isRunning}
                >
                  <ConceptEditor concepts={editedConcepts} onChange={setEditedConcepts} />
                </ReviewPanel>
              )}

              {/* ─── Step 3 Review Panel: Mapping Editor ─── */}
              {awaitingReview === 3 && editedMappings && (
                <ReviewPanel
                  title="Review Ontology Mappings"
                  subtitle="Add or remove ICD/RxNorm/LOINC codes for each concept before building query logic."
                  continueLabel="Continue to Step 4"
                  onContinue={continueToStage4}
                  onBack={() => goBackToStage(2)}
                  backLabel="← Back to Step 2"
                  disabled={isRunning}
                >
                  <MappingEditor mappings={editedMappings} onChange={setEditedMappings} />
                </ReviewPanel>
              )}

              {/* ─── Step 4 Review Panel: Query Plan Review ─── */}
              {awaitingReview === 4 && editedQueryPlan && (
                <ReviewPanel
                  title="Review Query Plan"
                  subtitle="Review count queries, panels, authoritative mapped items, and the optional temporal rule for each query."
                  continueLabel="Run Queries"
                  onContinue={continueToStage5}
                  disabled={
                    isRunning || editedQueryPlanHasErrors || !step4ArtifactToken
                  }
                >
                  {!step4ArtifactToken ? (
                    <div
                      role="alert"
                      className="mb-4 border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
                    >
                      <h5 className="font-semibold">Regenerate Step 4 authorization</h5>
                      <p className="mt-1">
                        This review artifact is unavailable, invalid, or expired. Generate a fresh
                        server-authorized plan before continuing.
                      </p>
                      <button
                        type="button"
                        onClick={continueToStage4}
                        disabled={isRunning || !editedMappings}
                        className="mt-3 rounded-md bg-amber-900 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Regenerate Step 4
                      </button>
                    </div>
                  ) : null}
                  {editedQueryPlanHasErrors ? (
                    <div
                      role="alert"
                      className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
                    >
                      <h5 className="font-semibold">Resolve query plan errors before continuing</h5>
                      <p className="mt-1">
                        Step 5 is disabled until the error-level validation issues below are fixed.
                      </p>
                    </div>
                  ) : null}
                  <QueryPlanReview
                    plan={editedQueryPlan}
                    authoritativeItems={step4AuthoritativeItems ?? undefined}
                    onChange={setEditedQueryPlan}
                  />
                </ReviewPanel>
              )}
            </div>
          </div>
        )}

        {/* Empty State */}
        {stages.length === 0 && (
          <div className="text-center py-20">
            <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-amber-50 to-violet-50 border border-gray-200 flex items-center justify-center">
              <svg className="w-10 h-10 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-gray-700 mb-2">ACE Process Flow Automation</h3>
            <p className="text-sm text-gray-900 max-w-lg mx-auto mb-6">
              Enter a clinical question above. The multi-agent pipeline will process it through 5 stages
              — mirroring the ACE workflow from Figure 2 — to generate Sharephe-ready i2b2 XML.
            </p>
            <div className="flex justify-center gap-4 text-xs text-gray-700">
              <span>Intake</span>
              <span>-&gt;</span>
              <span>Concepts</span>
              <span>-&gt;</span>
              <span>Ontology</span>
              <span>-&gt;</span>
              <span>Logic</span>
              <span>-&gt;</span>
              <span>i2b2 XML</span>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
