import {
  isAnalysisType,
  STEP4_QUERY_PLAN_VERSION,
  type CountQuery,
  type QueryPanel,
  type Step4QueryPlan,
  type TemporalRule,
  type ValidationIssue,
} from "../common/query-plan-types";

const PANEL_TIMINGS = new Set(["ANY", "SAMEVISIT", "SAMEINSTANCENUM"]);
const XML_INVALID_CONTROL_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

const STRUCTURAL_ISSUE_CODES = new Set([
  "invalid_version",
  "invalid_analysis_type",
  "missing_queries",
  "invalid_query_name",
  "invalid_query_purpose",
  "duplicate_query_id",
  "duplicate_panel_id",
  "duplicate_temporal_rule_id",
  "empty_panel",
  "missing_path",
  "invalid_occurs_at_least",
  "invalid_panel_timing",
  "invalid_date_range",
  "invalid_temporal_reference",
  "identical_temporal_endpoints",
  "invalid_temporal_day_range",
  "multiple_temporal_rules",
  "invalid_analysis_cells",
  "missing_analysis_cells",
  "invalid_analysis_cell",
  "duplicate_analysis_cell_id",
  "duplicate_analysis_query_reference",
  "invalid_analysis_query_reference",
  "unreferenced_count_query",
  "invalid_denominator_outcome",
  "invalid_outcome_positive_outcome",
  "missing_arm_denominator",
  "comparative_count_requires_two_arms",
  "malformed_submitted_plan",
  "unknown_mapping_id",
  "authoritative_item_mismatch",
  "clinical_question_mismatch",
  "generation_mismatch",
  "xml_invalid_control_character",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function addIssue(
  issues: ValidationIssue[],
  seen: Set<string>,
  issue: ValidationIssue
): void {
  const key = JSON.stringify([
    issue.code,
    issue.target ?? null,
    issue.message,
    issue.severity,
  ]);
  if (seen.has(key)) return;
  seen.add(key);
  issues.push(issue);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function invalidDateRange(dateRange: unknown): boolean {
  if (dateRange === undefined) return false;
  if (!isRecord(dateRange)) return true;

  const start = dateRange.start;
  const end = dateRange.end;
  if (start !== undefined && (typeof start !== "string" || !validDate(start))) {
    return true;
  }
  if (end !== undefined && (typeof end !== "string" || !validDate(end))) {
    return true;
  }
  return typeof start === "string" && typeof end === "string" && start > end;
}

function invalidDayRange(rule: TemporalRule): boolean {
  const min = rule.minDays;
  const max = rule.maxDays;
  const invalidNumber = (value: unknown) =>
    value !== undefined &&
    (!Number.isInteger(value) || typeof value !== "number" || value < 0);

  if (invalidNumber(min) || invalidNumber(max)) return true;
  return typeof min === "number" && typeof max === "number" && min > max;
}

function xmlInvalidControlCharacterTargets(
  value: unknown,
  target = "",
  seen = new Set<unknown>()
): string[] {
  if (typeof value === "string") {
    return XML_INVALID_CONTROL_CHAR.test(value) ? [target || "queryPlan"] : [];
  }
  if (!isRecord(value) && !Array.isArray(value)) return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const entries = Array.isArray(value)
    ? value.map((child, index) => [`${target}[${index}]`, child] as const)
    : Object.entries(value).map(
        ([key, child]) => [`${target ? `${target}.` : ""}${key}`, child] as const
      );
  return entries.flatMap(([childTarget, child]) =>
    xmlInvalidControlCharacterTargets(child, childTarget, seen)
  );
}

function addDuplicateIssue(
  ids: string[],
  issues: ValidationIssue[],
  seen: Set<string>,
  code: string,
  message: string,
  target: string
): void {
  const observed = new Set<string>();
  for (const id of ids) {
    if (!observed.has(id)) {
      observed.add(id);
      continue;
    }
    addIssue(issues, seen, { code, severity: "error", message, target });
    return;
  }
}

function validatePanel(
  panel: QueryPanel,
  issues: ValidationIssue[],
  seen: Set<string>,
  target: string
): void {
  if (!Array.isArray(panel.items) || panel.items.length === 0) {
    addIssue(issues, seen, {
      code: "empty_panel",
      severity: "error",
      message: "Query panels must contain at least one mapped item.",
      target,
    });
  }

  if (!Number.isInteger(panel.occursAtLeast) || panel.occursAtLeast < 1) {
    addIssue(issues, seen, {
      code: "invalid_occurs_at_least",
      severity: "error",
      message: "Panel occurrences must be a positive integer.",
      target: `${target}.occursAtLeast`,
    });
  }

  if (!PANEL_TIMINGS.has(panel.panelTiming)) {
    addIssue(issues, seen, {
      code: "invalid_panel_timing",
      severity: "error",
      message: "Panel timing must be ANY, SAMEVISIT, or SAMEINSTANCENUM.",
      target: `${target}.panelTiming`,
    });
  }

  if (invalidDateRange(panel.dateRange)) {
    addIssue(issues, seen, {
      code: "invalid_date_range",
      severity: "error",
      message: "Panel date ranges must use valid YYYY-MM-DD dates with start on or before end.",
      target: `${target}.dateRange`,
    });
  }

  if (Array.isArray(panel.items)) {
    panel.items.forEach((item, index) => {
      if (!nonEmptyString(item.path)) {
        addIssue(issues, seen, {
          code: "missing_path",
          severity: "error",
          message: "Query plan items must include an authoritative ontology path.",
          target: `${target}.items[${index}].path`,
        });
      }
    });
  }
}

function validateTemporalRule(
  rule: TemporalRule,
  panelIds: Set<string>,
  issues: ValidationIssue[],
  seen: Set<string>,
  target: string
): void {
  if (!panelIds.has(rule.firstPanelId) || !panelIds.has(rule.secondPanelId)) {
    addIssue(issues, seen, {
      code: "invalid_temporal_reference",
      severity: "error",
      message: "Temporal rules must reference panels in the same count query.",
      target,
    });
  }

  if (
    nonEmptyString(rule.firstPanelId) &&
    rule.firstPanelId === rule.secondPanelId
  ) {
    addIssue(issues, seen, {
      code: "identical_temporal_endpoints",
      severity: "error",
      message: "Temporal rules must reference two distinct panels.",
      target,
    });
  }

  if (invalidDayRange(rule)) {
    addIssue(issues, seen, {
      code: "invalid_temporal_day_range",
      severity: "error",
      message: "Temporal day ranges must be non-negative integers with minDays no greater than maxDays.",
      target,
    });
  }
}

function validateAnalysisCells(
  plan: Step4QueryPlan,
  countQueries: CountQuery[],
  issues: ValidationIssue[],
  seen: Set<string>
): void {
  const queryIds = new Set(
    countQueries.map((query) => query.id).filter(nonEmptyString)
  );
  const rawCells: unknown = plan.analysisCells;
  if (!Array.isArray(rawCells)) {
    addIssue(issues, seen, {
      code: "invalid_analysis_cells",
      severity: "error",
      message: "Analysis cells must be an array.",
      target: "analysisCells",
    });
    return;
  }

  if (countQueries.length > 0 && rawCells.length === 0) {
    addIssue(issues, seen, {
      code: "missing_analysis_cells",
      severity: "error",
      message: "Every count query must have one analysis cell.",
      target: "analysisCells",
    });
  }

  const cellIds: string[] = [];
  const queryReferenceCounts = new Map<string, number>();
  const denominators: Array<{ arm: string; outcome: string; target: string }> = [];
  const outcomes: Array<{ arm: string; outcome: string; target: string }> = [];

  rawCells.forEach((value, index) => {
    const target = `analysisCells[${index}]`;
    if (!isRecord(value)) {
      addIssue(issues, seen, {
        code: "invalid_analysis_cell",
        severity: "error",
        message: "Analysis cells must contain an ID, arm, outcome, kind, and query reference.",
        target,
      });
      return;
    }

    const id = value.id;
    const arm = value.arm;
    const outcome = value.outcome;
    const kind = value.kind;
    const queryId = value.queryId;
    const validKind = kind === "denominator" || kind === "outcome_positive";
    if (
      !nonEmptyString(id) ||
      !nonEmptyString(arm) ||
      !nonEmptyString(outcome) ||
      !validKind ||
      !nonEmptyString(queryId)
    ) {
      addIssue(issues, seen, {
        code: "invalid_analysis_cell",
        severity: "error",
        message: "Analysis cells must contain an ID, arm, outcome, kind, and query reference.",
        target,
      });
    }

    if (nonEmptyString(id)) cellIds.push(id);
    if (nonEmptyString(queryId)) {
      const referenceCount = (queryReferenceCounts.get(queryId) ?? 0) + 1;
      queryReferenceCounts.set(queryId, referenceCount);
      if (referenceCount > 1) {
        addIssue(issues, seen, {
          code: "duplicate_analysis_query_reference",
          severity: "error",
          message: "Each count query must be referenced by exactly one analysis cell.",
          target: `${target}.queryId`,
        });
      }
      if (!queryIds.has(queryId)) {
        addIssue(issues, seen, {
          code: "invalid_analysis_query_reference",
          severity: "error",
          message: "Every analysis cell must reference an existing count query.",
          target: `${target}.queryId`,
        });
      }
    }

    if (!nonEmptyString(arm) || !nonEmptyString(outcome) || !validKind) return;
    const normalized = {
      arm: arm.trim().toLowerCase(),
      outcome: outcome.trim().toLowerCase(),
      target,
    };
    if (kind === "denominator") {
      denominators.push(normalized);
      if (normalized.outcome !== "cohort") {
        addIssue(issues, seen, {
          code: "invalid_denominator_outcome",
          severity: "error",
          message: "Denominator analysis cells must use cohort as the outcome.",
          target: `${target}.outcome`,
        });
      }
    } else {
      outcomes.push(normalized);
      if (normalized.outcome === "cohort") {
        addIssue(issues, seen, {
          code: "invalid_outcome_positive_outcome",
          severity: "error",
          message: "Outcome-positive analysis cells must identify a non-cohort outcome.",
          target: `${target}.outcome`,
        });
      }
    }
  });

  addDuplicateIssue(
    cellIds,
    issues,
    seen,
    "duplicate_analysis_cell_id",
    "Analysis cell IDs must be unique.",
    "analysisCells"
  );

  countQueries.forEach((query, index) => {
    if (!nonEmptyString(query.id)) return;
    if ((queryReferenceCounts.get(query.id) ?? 0) === 0) {
      addIssue(issues, seen, {
        code: "unreferenced_count_query",
        severity: "error",
        message: "Every count query must be referenced by exactly one analysis cell.",
        target: `countQueries[${index}].id`,
      });
    }
  });

  if (denominators.length > 0) {
    const denominatorArms = new Set(denominators.map((cell) => cell.arm));
    for (const outcome of outcomes) {
      if (!denominatorArms.has(outcome.arm)) {
        addIssue(issues, seen, {
          code: "missing_arm_denominator",
          severity: "error",
          message: "Each outcome-positive analysis cell must have a denominator for the same arm.",
          target: outcome.target,
        });
      }
    }
  }

  if (
    plan.analysisType === "comparative_count" &&
    new Set(denominators.map((cell) => cell.arm)).size < 2
  ) {
    addIssue(issues, seen, {
      code: "comparative_count_requires_two_arms",
      severity: "error",
      message: "Comparative count plans require at least two distinct denominator arms.",
      target: "analysisCells",
    });
  }
}

export function validateStep4QueryPlan(plan: Step4QueryPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();

  if (plan.version !== STEP4_QUERY_PLAN_VERSION) {
    addIssue(issues, seen, {
      code: "invalid_version",
      severity: "error",
      message: "Step 4 query plan version is not supported.",
      target: "version",
    });
  }

  if (!isAnalysisType(plan.analysisType)) {
    addIssue(issues, seen, {
      code: "invalid_analysis_type",
      severity: "error",
      message: "Analysis type must be cohort_count or comparative_count.",
      target: "analysisType",
    });
  }

  if (!Array.isArray(plan.countQueries) || plan.countQueries.length === 0) {
    addIssue(issues, seen, {
      code: "missing_queries",
      severity: "error",
      message: "Step 4 query plan must contain at least one count query.",
      target: "countQueries",
    });
  }

  for (const target of xmlInvalidControlCharacterTargets(plan)) {
    addIssue(issues, seen, {
      code: "xml_invalid_control_character",
      severity: "error",
      message: "Query plans cannot contain XML-invalid control characters.",
      target,
    });
  }

  const countQueries = Array.isArray(plan.countQueries) ? plan.countQueries : [];
  addDuplicateIssue(
    countQueries.map((query) => query.id).filter(nonEmptyString),
    issues,
    seen,
    "duplicate_query_id",
    "Count query IDs must be unique.",
    "countQueries"
  );

  const allPanelIds: string[] = [];
  const allRuleIds: string[] = [];

  countQueries.forEach((query: CountQuery, queryIndex) => {
    const queryTarget = `countQueries[${queryIndex}]`;
    if (!nonEmptyString(query.name)) {
      addIssue(issues, seen, {
        code: "invalid_query_name",
        severity: "error",
        message: "Count queries must have a nonblank name.",
        target: `${queryTarget}.name`,
      });
    }
    if (!nonEmptyString(query.purpose)) {
      addIssue(issues, seen, {
        code: "invalid_query_purpose",
        severity: "error",
        message: "Count queries must have a nonblank purpose.",
        target: `${queryTarget}.purpose`,
      });
    }
    const panels = Array.isArray(query.panels) ? query.panels : [];
    if (panels.length === 0) {
      addIssue(issues, seen, {
        code: "empty_panel",
        severity: "error",
        message: "Count queries must contain at least one panel.",
        target: `${queryTarget}.panels`,
      });
    }

    const queryPanelIds = new Set<string>();
    panels.forEach((panel, panelIndex) => {
      if (nonEmptyString(panel.id)) {
        allPanelIds.push(panel.id);
        queryPanelIds.add(panel.id);
      }
      validatePanel(panel, issues, seen, `${queryTarget}.panels[${panelIndex}]`);
    });

    const temporalRules = Array.isArray(query.temporalRules) ? query.temporalRules : [];
    if (temporalRules.length > 1) {
      addIssue(issues, seen, {
        code: "multiple_temporal_rules",
        severity: "error",
        message: "Each count query supports only one simple temporal rule.",
        target: `${queryTarget}.temporalRules`,
      });
    }
    temporalRules.forEach((rule, ruleIndex) => {
      if (nonEmptyString(rule.id)) {
        allRuleIds.push(rule.id);
      }
      validateTemporalRule(
        rule,
        queryPanelIds,
        issues,
        seen,
        `${queryTarget}.temporalRules[${ruleIndex}]`
      );
    });
  });

  addDuplicateIssue(
    allPanelIds,
    issues,
    seen,
    "duplicate_panel_id",
    "Panel IDs must be unique across the query plan.",
    "countQueries.panels"
  );
  addDuplicateIssue(
    allRuleIds,
    issues,
    seen,
    "duplicate_temporal_rule_id",
    "Temporal rule IDs must be unique across the query plan.",
    "countQueries.temporalRules"
  );

  validateAnalysisCells(plan, countQueries, issues, seen);

  return issues;
}

function isStructuralIssue(issue: ValidationIssue): boolean {
  if (issue.code === "missing_path") {
    return typeof issue.target === "string" && issue.target.startsWith("countQueries");
  }
  return STRUCTURAL_ISSUE_CODES.has(issue.code);
}

export function persistentStep4ValidationIssues(
  issues: ValidationIssue[]
): ValidationIssue[] {
  return issues
    .filter((issue) => !isStructuralIssue(issue))
    .map((issue) => ({ ...issue }));
}

export function revalidateEditedQueryPlan(plan: Step4QueryPlan): Step4QueryPlan {
  return {
    ...plan,
    validationIssues: [
      ...plan.validationIssues.filter((issue) => !isStructuralIssue(issue)),
      ...validateStep4QueryPlan(plan),
    ],
  };
}
