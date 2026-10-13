import {
  isAnalysisType,
  STEP4_QUERY_PLAN_VERSION,
  type AnalysisCell,
  type CountQuery,
  type PanelLogic,
  type PanelTiming,
  type QueryPanel,
  type QueryPlanItem,
  type Step4QueryPlan,
  type TemporalRelation,
  type TemporalRule,
  type ValidationIssue,
} from "./query-plan-types";
import { validateStep4QueryPlan } from "./query-plan-validation";
import type { Step4ReviewArtifactClaims } from "./step4-review-artifact";
import { clonePlainData } from "./plain-data";

export interface Step4QueryPlanAuthorizationResult {
  authorized: boolean;
  plan: Step4QueryPlan;
}

const PANEL_LOGIC = new Set<PanelLogic>(["WITH", "WITHOUT"]);
const PANEL_TIMING = new Set<PanelTiming>([
  "ANY",
  "SAMEVISIT",
  "SAMEINSTANCENUM",
]);
const TEMPORAL_RELATION = new Set<TemporalRelation>([
  "BEFORE",
  "AFTER",
  "BEFORE_OR_SAME",
  "AFTER_OR_SAME",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function cloneItem(item: QueryPlanItem): QueryPlanItem {
  return {
    ...item,
    valueConstraint: item.valueConstraint
      ? { ...item.valueConstraint }
      : undefined,
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && sameValue(left[key], right[key])
    )
  );
}

function issue(
  issues: ValidationIssue[],
  code: string,
  message: string,
  target?: string
): void {
  issues.push({ code, severity: "error", message, target });
}

function malformed(
  issues: ValidationIssue[],
  target: string,
  expectation: string
): void {
  issue(
    issues,
    "malformed_submitted_plan",
    `The submitted Step 4 plan has an invalid ${expectation}.`,
    target
  );
}

function requiredString(
  value: unknown,
  issues: ValidationIssue[],
  target: string
): string {
  if (nonEmptyString(value)) return value;
  malformed(issues, target, "required string");
  return "";
}

function optionalNumber(
  value: unknown,
  issues: ValidationIssue[],
  target: string
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  malformed(issues, target, "number");
  return undefined;
}

function parseDateRange(
  value: unknown,
  issues: ValidationIssue[],
  target: string
): QueryPanel["dateRange"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    malformed(issues, target, "date range");
    return undefined;
  }
  const result: NonNullable<QueryPanel["dateRange"]> = {};
  for (const key of ["start", "end"] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string") {
      malformed(issues, `${target}.${key}`, "date string");
      continue;
    }
    result[key] = value[key];
  }
  return result;
}

function parseItem(
  value: unknown,
  authoritative: Map<string, QueryPlanItem>,
  issues: ValidationIssue[],
  target: string
): QueryPlanItem | null {
  if (!isRecord(value) || !nonEmptyString(value.mappingId)) {
    malformed(issues, target, "query plan item");
    return null;
  }

  const trusted = authoritative.get(value.mappingId);
  if (!trusted) {
    issue(
      issues,
      "unknown_mapping_id",
      "The submitted item does not exist in the freshly prepared Step 3 mappings.",
      `${target}.mappingId`
    );
    return null;
  }

  for (const field of [
    "mappingId",
    "concept",
    "category",
    "role",
    "code",
    "display",
    "path",
    "system",
    "level",
    "source",
    "valueConstraint",
  ] as const) {
    if (!sameValue(value[field], trusted[field])) {
      issue(
        issues,
        "authoritative_item_mismatch",
        "The submitted item differs from its freshly prepared Step 3 mapping.",
        `${target}.${field}`
      );
    }
  }

  return cloneItem(trusted);
}

function parsePanel(
  value: unknown,
  authoritative: Map<string, QueryPlanItem>,
  issues: ValidationIssue[],
  target: string
): QueryPanel | null {
  if (!isRecord(value)) {
    malformed(issues, target, "panel object");
    return null;
  }

  const logic = PANEL_LOGIC.has(value.logic as PanelLogic)
    ? (value.logic as PanelLogic)
    : null;
  if (!logic) malformed(issues, `${target}.logic`, "panel logic");

  const panelTiming = PANEL_TIMING.has(value.panelTiming as PanelTiming)
    ? (value.panelTiming as PanelTiming)
    : null;
  if (!panelTiming) malformed(issues, `${target}.panelTiming`, "panel timing");

  const items: QueryPlanItem[] = [];
  if (!Array.isArray(value.items)) {
    malformed(issues, `${target}.items`, "item array");
  } else {
    value.items.forEach((item, index) => {
      const parsed = parseItem(
        item,
        authoritative,
        issues,
        `${target}.items[${index}]`
      );
      if (parsed) items.push(parsed);
    });
  }

  const occursAtLeast = typeof value.occursAtLeast === "number" &&
    Number.isFinite(value.occursAtLeast)
    ? value.occursAtLeast
    : 0;
  if (occursAtLeast === 0 && value.occursAtLeast !== 0) {
    malformed(issues, `${target}.occursAtLeast`, "occurrence number");
  }

  return {
    id: requiredString(value.id, issues, `${target}.id`),
    title: requiredString(value.title, issues, `${target}.title`),
    logic: logic ?? "WITH",
    items,
    dateRange: parseDateRange(value.dateRange, issues, `${target}.dateRange`),
    occursAtLeast,
    panelTiming: panelTiming ?? "ANY",
  };
}

function parseTemporalRule(
  value: unknown,
  issues: ValidationIssue[],
  target: string
): TemporalRule | null {
  if (!isRecord(value)) {
    malformed(issues, target, "temporal rule object");
    return null;
  }
  const relation = TEMPORAL_RELATION.has(value.relation as TemporalRelation)
    ? (value.relation as TemporalRelation)
    : null;
  if (!relation) malformed(issues, `${target}.relation`, "temporal relation");

  return {
    id: requiredString(value.id, issues, `${target}.id`),
    relation: relation ?? "BEFORE",
    firstPanelId: requiredString(
      value.firstPanelId,
      issues,
      `${target}.firstPanelId`
    ),
    secondPanelId: requiredString(
      value.secondPanelId,
      issues,
      `${target}.secondPanelId`
    ),
    minDays: optionalNumber(value.minDays, issues, `${target}.minDays`),
    maxDays: optionalNumber(value.maxDays, issues, `${target}.maxDays`),
  };
}

function parseQuery(
  value: unknown,
  authoritative: Map<string, QueryPlanItem>,
  issues: ValidationIssue[],
  target: string
): CountQuery | null {
  if (!isRecord(value)) {
    malformed(issues, target, "count query object");
    return null;
  }

  const panels: QueryPanel[] = [];
  if (!Array.isArray(value.panels)) {
    malformed(issues, `${target}.panels`, "panel array");
  } else {
    value.panels.forEach((panel, index) => {
      const parsed = parsePanel(
        panel,
        authoritative,
        issues,
        `${target}.panels[${index}]`
      );
      if (parsed) panels.push(parsed);
    });
  }

  const temporalRules: TemporalRule[] = [];
  if (!Array.isArray(value.temporalRules)) {
    malformed(issues, `${target}.temporalRules`, "temporal rule array");
  } else {
    value.temporalRules.forEach((rule, index) => {
      const parsed = parseTemporalRule(
        rule,
        issues,
        `${target}.temporalRules[${index}]`
      );
      if (parsed) temporalRules.push(parsed);
    });
  }

  return {
    id: requiredString(value.id, issues, `${target}.id`),
    name: requiredString(value.name, issues, `${target}.name`),
    purpose: requiredString(value.purpose, issues, `${target}.purpose`),
    panels,
    temporalRules,
  };
}

function parseAnalysisCell(
  value: unknown,
  issues: ValidationIssue[],
  target: string
): AnalysisCell | null {
  if (!isRecord(value)) {
    malformed(issues, target, "analysis cell object");
    return null;
  }
  const kind = value.kind === "denominator" || value.kind === "outcome_positive"
    ? value.kind
    : null;
  if (!kind) malformed(issues, `${target}.kind`, "analysis cell kind");

  return {
    id: requiredString(value.id, issues, `${target}.id`),
    arm: requiredString(value.arm, issues, `${target}.arm`),
    outcome: requiredString(value.outcome, issues, `${target}.outcome`),
    kind: kind ?? "denominator",
    queryId: requiredString(value.queryId, issues, `${target}.queryId`),
  };
}

function deduplicateIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((current) => {
    const key = JSON.stringify(current);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function authorizeStep4QueryPlan(args: {
  submittedPlan: unknown;
  claims: Step4ReviewArtifactClaims;
}): Step4QueryPlanAuthorizationResult {
  try {
    return authorizeClonedStep4QueryPlan({
      submittedPlan: clonePlainData(args.submittedPlan),
      claims: args.claims,
    });
  } catch {
    const malformedIssue: ValidationIssue = {
      code: "malformed_submitted_plan",
      severity: "error",
      message: "The submitted Step 4 plan is malformed.",
      target: "queryPlan",
    };
    const plan: Step4QueryPlan = {
      version: STEP4_QUERY_PLAN_VERSION,
      question: args.claims.clinicalQuestion,
      analysisType: "cohort_count",
      querySetName: args.claims.clinicalQuestion,
      countQueries: [],
      analysisCells: [],
      validationIssues: [],
      generation: args.claims.generation,
    };
    plan.validationIssues = deduplicateIssues([
      ...args.claims.persistentIssues.map((current) => ({ ...current })),
      malformedIssue,
      ...validateStep4QueryPlan(plan),
    ]);
    return { authorized: false, plan };
  }
}

function authorizeClonedStep4QueryPlan(args: {
  submittedPlan: unknown;
  claims: Step4ReviewArtifactClaims;
}): Step4QueryPlanAuthorizationResult {
  const authorizationIssues: ValidationIssue[] = [];
  const submitted = isRecord(args.submittedPlan) ? args.submittedPlan : {};
  if (!isRecord(args.submittedPlan)) {
    malformed(authorizationIssues, "queryPlan", "query plan object");
  }

  if (submitted.version !== STEP4_QUERY_PLAN_VERSION) {
    malformed(authorizationIssues, "version", "query plan version");
  }
  if (submitted.question !== args.claims.clinicalQuestion) {
    issue(
      authorizationIssues,
      "clinical_question_mismatch",
      "The submitted plan does not match the current clinical question.",
      "question"
    );
  }

  const analysisType = isAnalysisType(submitted.analysisType)
    ? submitted.analysisType
    : "cohort_count";
  if (!isAnalysisType(submitted.analysisType)) {
    malformed(authorizationIssues, "analysisType", "analysis type");
  }

  if (
    submitted.generation !== "llm" &&
    submitted.generation !== "deterministic_fallback"
  ) {
    malformed(authorizationIssues, "generation", "generation mode");
  } else if (submitted.generation !== args.claims.generation) {
    issue(
      authorizationIssues,
      "generation_mismatch",
      "The submitted generation mode differs from the signed Step 4 result.",
      "generation"
    );
  }

  const authoritative = new Map(
    args.claims.authoritativeItems.map((authoritativeItem) => {
      const item = cloneItem(authoritativeItem);
      return [item.mappingId, item] as const;
    })
  );

  const countQueries: CountQuery[] = [];
  if (!Array.isArray(submitted.countQueries)) {
    malformed(authorizationIssues, "countQueries", "count query array");
  } else {
    submitted.countQueries.forEach((query, index) => {
      const parsed = parseQuery(
        query,
        authoritative,
        authorizationIssues,
        `countQueries[${index}]`
      );
      if (parsed) countQueries.push(parsed);
    });
  }

  const analysisCells: AnalysisCell[] = [];
  if (!Array.isArray(submitted.analysisCells)) {
    malformed(authorizationIssues, "analysisCells", "analysis cell array");
  } else {
    submitted.analysisCells.forEach((cell, index) => {
      const parsed = parseAnalysisCell(
        cell,
        authorizationIssues,
        `analysisCells[${index}]`
      );
      if (parsed) analysisCells.push(parsed);
    });
  }

  const plan: Step4QueryPlan = {
    version: STEP4_QUERY_PLAN_VERSION,
    question: args.claims.clinicalQuestion,
    analysisType,
    querySetName: requiredString(
      submitted.querySetName,
      authorizationIssues,
      "querySetName"
    ),
    countQueries,
    analysisCells,
    validationIssues: [],
    generation: args.claims.generation,
  };
  const authorityIssues = [
    ...args.claims.persistentIssues.map((current) => ({ ...current })),
    ...authorizationIssues,
  ];
  const validationIssues = deduplicateIssues([
    ...authorityIssues,
    ...validateStep4QueryPlan(plan),
  ]);
  const safePlan = { ...plan, validationIssues };

  return {
    authorized: !authorityIssues.some((current) => current.severity === "error"),
    plan: safePlan,
  };
}
