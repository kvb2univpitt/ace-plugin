import type { MappingCode } from "../stage3/mapper";
import type { ValueConstraint } from "../stage3/valueConstraint";

export const STEP4_QUERY_PLAN_VERSION = "step4-query-plan-v1" as const;
export const ANALYSIS_TYPES = ["cohort_count", "comparative_count"] as const;
export type AnalysisType = (typeof ANALYSIS_TYPES)[number];

export function isAnalysisType(value: unknown): value is AnalysisType {
  return ANALYSIS_TYPES.some((type) => type === value);
}

export interface ValidationIssue {
  code: string;
  severity: "warning" | "error";
  message: string;
  target?: string;
}

export type MappingSource = "step3_reviewed" | "enact_lookup_recovery";

export interface QueryPlanItem {
  mappingId: string;
  concept: string;
  category: string;
  role?: string;
  code: string;
  display: string;
  path: string;
  system: string;
  level: number;
  source: MappingSource;
  valueConstraint?: ValueConstraint;
}

export interface Step4ReviewContext {
  authoritativeItems: QueryPlanItem[];
  artifactToken?: string;
}

export interface PreparedMapping extends QueryPlanItem {
  codes: MappingCode[];
  phenotype?: { system: string; code: string; display: string; path: string };
  constituentCodes?: MappingCode[];
}

export type PanelLogic = "WITH" | "WITHOUT";
export type PanelTiming = "ANY" | "SAMEVISIT" | "SAMEINSTANCENUM";

export interface QueryPanel {
  id: string;
  title: string;
  logic: PanelLogic;
  items: QueryPlanItem[];
  dateRange?: { start?: string; end?: string };
  occursAtLeast: number;
  panelTiming: PanelTiming;
}

export type TemporalRelation =
  | "BEFORE"
  | "AFTER"
  | "BEFORE_OR_SAME"
  | "AFTER_OR_SAME";

export interface TemporalRule {
  id: string;
  relation: TemporalRelation;
  firstPanelId: string;
  secondPanelId: string;
  minDays?: number;
  maxDays?: number;
}

export interface CountQuery {
  id: string;
  name: string;
  purpose: string;
  panels: QueryPanel[];
  temporalRules: TemporalRule[];
}

export interface AnalysisCell {
  id: string;
  arm: string;
  outcome: string;
  kind: "denominator" | "outcome_positive";
  queryId: string;
}

export interface Step4QueryPlan {
  version: typeof STEP4_QUERY_PLAN_VERSION;
  question: string;
  analysisType: AnalysisType;
  querySetName: string;
  countQueries: CountQuery[];
  analysisCells: AnalysisCell[];
  validationIssues: ValidationIssue[];
  generation: "llm" | "deterministic_fallback";
}

export type Step5ArtifactStatus =
  | "ready"
  | "needs_mapping"
  | "needs_manual_review";

export interface Step5XmlArtifact {
  queryId: string;
  queryName: string;
  xml: string | null;
  status: Step5ArtifactStatus;
  sharepheReady: boolean;
  warnings: string[];
  panelSummary: string;
  tableCell: string;
}

export interface Step5XmlPackage {
  version: "step5-i2b2-xml-v1";
  querySetName: string;
  artifacts: Step5XmlArtifact[];
  validationSummary: {
    readyCount: number;
    needsMappingCount: number;
    needsManualReviewCount: number;
    warnings: string[];
  };
}
