import type { ValueConstraint } from "./ontology/valueConstraint";
import {
  isAnalysisType,
  STEP4_QUERY_PLAN_VERSION,
  type AnalysisCell,
  type AnalysisType,
  type CountQuery,
  type PanelLogic,
  type PanelTiming,
  type PreparedMapping,
  type QueryPanel,
  type QueryPlanItem,
  type Step4QueryPlan,
  type TemporalRelation,
  type TemporalRule,
  type ValidationIssue,
} from "./query-plan-types";
import type { PreparedStep3Input } from "./step3-query-input";
import { toQueryPlanItem } from "./step3-query-input";
import { validateStep4QueryPlan } from "./query-plan-validation";

interface PanelGroup {
  title: string;
  role?: string;
  mappings: PreparedMapping[];
}

interface DraftPanel {
  id?: unknown;
  title?: unknown;
  logic?: unknown;
  mappingIds?: unknown;
  occursAtLeast?: unknown;
  panelTiming?: unknown;
  dateRange?: unknown;
}

interface DraftQuery {
  id?: unknown;
  name?: unknown;
  purpose?: unknown;
  panels?: unknown;
  temporalRules?: unknown;
}

interface DraftPlan {
  analysisType?: unknown;
  querySetName?: unknown;
  countQueries?: unknown;
  analysisCells?: unknown;
}

const FALLBACK_ISSUE: ValidationIssue = {
  code: "step4_model_fallback",
  severity: "warning",
  message: "Step 4 used the deterministic fallback query planner.",
};

const MODEL_UNAVAILABLE_ISSUE: ValidationIssue = {
  code: "step4_model_unavailable",
  severity: "warning",
  message: "Step 4 could not use the model draft and used the deterministic fallback query planner.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAnalysisCellKind(value: unknown): value is AnalysisCell["kind"] {
  return value === "denominator" || value === "outcome_positive";
}

function analysisTypeOrDefault(value: unknown): AnalysisType | null {
  if (value === undefined) return "cohort_count";
  return isAnalysisType(value) ? value : null;
}

function isPanelLogic(value: unknown): value is PanelLogic {
  return value === "WITH" || value === "WITHOUT";
}

function isPanelTiming(value: unknown): value is PanelTiming {
  return value === "ANY" || value === "SAMEVISIT" || value === "SAMEINSTANCENUM";
}

function isTemporalRelation(value: unknown): value is TemporalRelation {
  return (
    value === "BEFORE" ||
    value === "AFTER" ||
    value === "BEFORE_OR_SAME" ||
    value === "AFTER_OR_SAME"
  );
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function groupKey(mapping: PreparedMapping): string {
  return `${normalize(mapping.category)}:${normalize(mapping.concept)}`;
}

function mappingRole(mapping: PreparedMapping): string {
  return normalize(mapping.role ?? "");
}

function mappingCategory(mapping: PreparedMapping): string {
  return normalize(mapping.category);
}

function isArm(group: PanelGroup): boolean {
  const role = normalize(group.role ?? "");
  return role === "exposure" || role === "comparator";
}

function isOutcome(group: PanelGroup): boolean {
  return mappingCategory(group.mappings[0]) === "outcome" || mappingCategory(group.mappings[0]) === "outcomes";
}

function clonePanel(panel: QueryPanel): QueryPanel {
  return {
    ...panel,
    items: panel.items.map((item) => ({ ...item })),
    dateRange: panel.dateRange ? { ...panel.dateRange } : undefined,
  };
}

function panelFromGroup(group: PanelGroup, id: string): QueryPanel {
  const items = group.mappings.map((mapping) => toQueryPlanItem(mapping));
  return {
    id,
    title: group.title,
    logic: group.mappings.some((mapping) => mappingRole(mapping) === "exclusion")
      ? "WITHOUT"
      : "WITH",
    items,
    occursAtLeast: 1,
    panelTiming: "ANY",
  };
}

function groupMappings(mappings: PreparedMapping[]): PanelGroup[] {
  const groups = new Map<string, PanelGroup>();
  for (const mapping of mappings) {
    const key = groupKey(mapping);
    const existing = groups.get(key);
    if (existing) {
      existing.mappings.push(mapping);
      continue;
    }
    groups.set(key, {
      title: mapping.concept.trim() || mapping.display,
      role: mapping.role,
      mappings: [mapping],
    });
  }
  return Array.from(groups.values());
}

function queryPlanIssues(
  plan: Step4QueryPlan,
  carriedIssues: ValidationIssue[]
): ValidationIssue[] {
  return [...carriedIssues, ...validateStep4QueryPlan(plan)];
}

function withModelUnavailableIssue(plan: Step4QueryPlan): Step4QueryPlan {
  if (
    plan.generation !== "deterministic_fallback" ||
    plan.validationIssues.some((issue) => issue.code === MODEL_UNAVAILABLE_ISSUE.code)
  ) {
    return plan;
  }
  return {
    ...plan,
    validationIssues: [...plan.validationIssues, MODEL_UNAVAILABLE_ISSUE],
  };
}

function cell(
  id: string,
  arm: string,
  outcome: string,
  kind: AnalysisCell["kind"],
  queryId: string
): AnalysisCell {
  return { id, arm, outcome, kind, queryId };
}

function countQuery(
  id: string,
  name: string,
  purpose: string,
  panels: QueryPanel[],
  temporalRules: TemporalRule[] = []
): CountQuery {
  return {
    id,
    name,
    purpose,
    panels: panels.map(clonePanel),
    temporalRules,
  };
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  const id = `${base}-${suffix}`;
  used.add(id);
  return id;
}

function ensureGlobalPanelAndRuleIds(queries: CountQuery[]): CountQuery[] {
  const panelIds = new Set<string>();
  const ruleIds = new Set<string>();
  return queries.map((query) => {
    const replacements = new Map<string, string>();
    const panels = query.panels.map((panel) => {
      const id = uniqueId(panel.id, panelIds);
      replacements.set(panel.id, id);
      return { ...panel, id };
    });
    const temporalRules = query.temporalRules.map((rule) => ({
      ...rule,
      id: uniqueId(rule.id, ruleIds),
      firstPanelId: replacements.get(rule.firstPanelId) ?? rule.firstPanelId,
      secondPanelId: replacements.get(rule.secondPanelId) ?? rule.secondPanelId,
    }));
    return { ...query, panels, temporalRules };
  });
}

function allPanelsContain(query: CountQuery, firstPanelId: string, secondPanelId: string): boolean {
  const ids = new Set(query.panels.map((panel) => panel.id));
  return ids.has(firstPanelId) && ids.has(secondPanelId);
}

function temporalRelationships(concepts: Record<string, unknown>): Record<string, unknown>[] {
  const value = concepts.temporalRelationships;
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function eventMatchesPanel(event: string, panel: QueryPanel): boolean {
  const eventText = normalize(event);
  if (!eventText) return false;
  const candidates = [
    panel.title,
    ...panel.items.flatMap((item) => [item.concept, item.display]),
  ].map(normalize);

  return candidates.some(
    (candidate) =>
      candidate === eventText ||
      candidate.includes(eventText) ||
      eventText.includes(candidate)
  );
}

function simpleTemporalRule(
  concepts: Record<string, unknown>,
  panels: QueryPanel[],
  issues: ValidationIssue[]
): TemporalRule | null {
  const relationships = temporalRelationships(concepts);
  if (relationships.length === 0) return null;

  const warn = () => {
    issues.push({
      code: "temporal_logic_requires_review",
      severity: "warning",
      message: "Step 2 temporal metadata could not be reduced to one unambiguous two-event rule.",
    });
  };

  if (relationships.length !== 1 || typeof relationships[0].sequence !== "string") {
    warn();
    return null;
  }

  const events = relationships[0].sequence
    .split("->")
    .map((event) => event.trim());
  if (events.length !== 2 || events.some((event) => event.length === 0)) {
    warn();
    return null;
  }

  const firstMatches = panels.filter((panel) => eventMatchesPanel(events[0], panel));
  const secondMatches = panels.filter((panel) => eventMatchesPanel(events[1], panel));
  if (
    firstMatches.length !== 1 ||
    secondMatches.length !== 1 ||
    firstMatches[0].id === secondMatches[0].id
  ) {
    warn();
    return null;
  }

  return {
    id: "temporal-rule-1",
    relation: "BEFORE",
    firstPanelId: firstMatches[0].id,
    secondPanelId: secondMatches[0].id,
  };
}

function attachTemporalRule(queries: CountQuery[], rule: TemporalRule | null): void {
  if (!rule) return;
  const query = queries.find((candidate) =>
    allPanelsContain(candidate, rule.firstPanelId, rule.secondPanelId)
  );
  if (query) query.temporalRules = [rule];
}

function fallbackPlan(args: {
  question: string;
  concepts: Record<string, unknown>;
  step3: PreparedStep3Input;
}): Step4QueryPlan {
  const groups = groupMappings(args.step3.mappings);
  const baselinePanels = groups
    .filter((group) => !isArm(group) && !isOutcome(group))
    .map((group, index) => panelFromGroup(group, `baseline-${index + 1}`));
  const armPanels = groups
    .filter(isArm)
    .map((group, index) => panelFromGroup(group, `arm-${index + 1}`));
  const outcomePanels = groups
    .filter(isOutcome)
    .map((group, index) => panelFromGroup(group, `outcome-${index + 1}`));

  const countQueries: CountQuery[] = [];
  const analysisCells: AnalysisCell[] = [];

  if (armPanels.length > 0) {
    armPanels.forEach((armPanel, armIndex) => {
      const armNumber = armIndex + 1;
      const denominatorId = `arm-${armNumber}-denominator`;
      countQueries.push(
        countQuery(
          denominatorId,
          `${armPanel.title} denominator`,
          `Count patients in the ${armPanel.title} arm.`,
          [...baselinePanels, armPanel]
        )
      );
      analysisCells.push(
        cell(`cell-${denominatorId}`, armPanel.title, "cohort", "denominator", denominatorId)
      );

      outcomePanels.forEach((outcomePanel, outcomeIndex) => {
        const outcomeNumber = outcomeIndex + 1;
        const queryId = `arm-${armNumber}-outcome-${outcomeNumber}`;
        countQueries.push(
          countQuery(
            queryId,
            `${armPanel.title} ${outcomePanel.title}`,
            `Count ${outcomePanel.title} in the ${armPanel.title} arm.`,
            [...baselinePanels, armPanel, outcomePanel]
          )
        );
        analysisCells.push(
          cell(
            `cell-${queryId}`,
            armPanel.title,
            outcomePanel.title,
            "outcome_positive",
            queryId
          )
        );
      });
    });
  } else if (outcomePanels.length > 0) {
    if (baselinePanels.length === 0) {
      outcomePanels.forEach((outcomePanel, outcomeIndex) => {
        const outcomeNumber = outcomeIndex + 1;
        const queryId = outcomePanels.length === 1
          ? "outcome-only-cohort"
          : `outcome-only-cohort-${outcomeNumber}`;
        const queryName = outcomePanels.length === 1
          ? `${outcomePanel.title} cohort`
          : `${outcomePanel.title} cohort ${outcomeNumber}`;
        countQueries.push(
          countQuery(
            queryId,
            queryName,
            `Count patients with ${outcomePanel.title}; population semantics require review.`,
            [outcomePanel]
          )
        );
        analysisCells.push(
          cell(`cell-${queryId}`, "overall", outcomePanel.title, "outcome_positive", queryId)
        );
      });
    } else {
      const denominatorId = "baseline-denominator";
      countQueries.push(
        countQuery(
          denominatorId,
          "Baseline denominator",
          "Count patients in the baseline cohort.",
          baselinePanels
        )
      );
      analysisCells.push(
        cell(`cell-${denominatorId}`, "overall", "cohort", "denominator", denominatorId)
      );

      outcomePanels.forEach((outcomePanel, outcomeIndex) => {
        const queryId = `baseline-outcome-${outcomeIndex + 1}`;
        countQueries.push(
          countQuery(
            queryId,
            `Baseline ${outcomePanel.title}`,
            `Count ${outcomePanel.title} in the baseline cohort.`,
            [...baselinePanels, outcomePanel]
          )
        );
        analysisCells.push(
          cell(`cell-${queryId}`, "overall", outcomePanel.title, "outcome_positive", queryId)
        );
      });
    }
  } else {
    const queryId = "baseline-cohort";
    countQueries.push(
      countQuery(
        queryId,
        "Baseline cohort",
        "Count patients matching the baseline cohort.",
        baselinePanels
      )
    );
    analysisCells.push(cell(`cell-${queryId}`, "overall", "cohort", "denominator", queryId));
  }

  const fallbackIssues = [...args.step3.validationIssues, FALLBACK_ISSUE];
  if (outcomePanels.length > 0 && baselinePanels.length === 0 && armPanels.length === 0) {
    fallbackIssues.push({
      code: "population_semantics_requires_review",
      severity: "warning",
      message: "Outcome-only mappings do not define sufficient population semantics for a denominator.",
    });
  }
  const temporalRule = simpleTemporalRule(
    args.concepts,
    [...baselinePanels, ...armPanels, ...outcomePanels],
    fallbackIssues
  );
  attachTemporalRule(countQueries, temporalRule);
  const normalizedCountQueries = ensureGlobalPanelAndRuleIds(countQueries);

  const plan: Step4QueryPlan = {
    version: STEP4_QUERY_PLAN_VERSION,
    question: args.question,
    analysisType: armPanels.length >= 2 ? "comparative_count" : "cohort_count",
    querySetName: args.question,
    countQueries: normalizedCountQueries,
    analysisCells,
    validationIssues: [],
    generation: "deterministic_fallback",
  };

  return {
    ...plan,
    validationIssues: queryPlanIssues(plan, fallbackIssues),
  };
}

function parseJsonObject(rawDraft: string | null | undefined): DraftPlan | null {
  const text = rawDraft?.trim();
  if (!text) return null;

  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidates = fenced ? [fenced[1]] : [text, objectSubstring(text)].filter(nonEmptyString);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      return isRecord(parsed) ? parsed : null;
    } catch {
      continue;
    }
  }
  return null;
}

function objectSubstring(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function draftQueries(draft: DraftPlan): DraftQuery[] | null {
  if (!Array.isArray(draft.countQueries) || draft.countQueries.length === 0) {
    return null;
  }
  const queries = draft.countQueries.filter(isRecord);
  return queries.length === draft.countQueries.length ? queries : null;
}

function draftPanels(query: DraftQuery): DraftPanel[] | null {
  if (!Array.isArray(query.panels) || query.panels.length === 0) return null;
  const panels = query.panels.filter(isRecord);
  return panels.length === query.panels.length ? panels : null;
}

function draftMappingIds(panel: DraftPanel): string[] | null {
  if (!Array.isArray(panel.mappingIds) || panel.mappingIds.length === 0) {
    return null;
  }
  const mappingIds = panel.mappingIds.filter(nonEmptyString);
  return mappingIds.length === panel.mappingIds.length ? mappingIds : null;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return nonEmptyString(value) ? value : fallback;
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function timingOrDefault(value: unknown): PanelTiming | null {
  if (value === undefined) return "ANY";
  return isPanelTiming(value) ? value : null;
}

function logicOrDefault(value: unknown): PanelLogic | null {
  if (value === undefined) return "WITH";
  return isPanelLogic(value) ? value : null;
}

function dateRange(value: unknown): QueryPanel["dateRange"] {
  if (!isRecord(value)) return undefined;
  return {
    start: typeof value.start === "string" ? value.start : undefined,
    end: typeof value.end === "string" ? value.end : undefined,
  };
}

function temporalRule(value: unknown): TemporalRule | null {
  if (!isRecord(value)) return null;
  if (
    !nonEmptyString(value.id) ||
    !isTemporalRelation(value.relation) ||
    !nonEmptyString(value.firstPanelId) ||
    !nonEmptyString(value.secondPanelId)
  ) {
    return null;
  }
  return {
    id: value.id,
    relation: value.relation,
    firstPanelId: value.firstPanelId,
    secondPanelId: value.secondPanelId,
    minDays: typeof value.minDays === "number" ? value.minDays : undefined,
    maxDays: typeof value.maxDays === "number" ? value.maxDays : undefined,
  };
}

function analysisCell(value: unknown): AnalysisCell | null {
  if (!isRecord(value)) return null;
  if (
    !nonEmptyString(value.id) ||
    !nonEmptyString(value.arm) ||
    !nonEmptyString(value.outcome) ||
    !isAnalysisCellKind(value.kind) ||
    !nonEmptyString(value.queryId)
  ) {
    return null;
  }
  return {
    id: value.id,
    arm: value.arm,
    // A denominator cell's `outcome` is a fixed sentinel ("cohort"), not real
    // information — it just marks "count the whole arm". Models routinely fill
    // it with the outcome label or a description instead, which trips
    // validateAnalysisCells' invalid_denominator_outcome and discards the whole
    // (otherwise valid) draft — the "only 2 of 5 count queries" bug. Coerce it:
    // for a denominator the sentinel is the only correct value, so this is
    // lossless and can never hide a real modeling error.
    outcome: value.kind === "denominator" ? "cohort" : value.outcome,
    kind: value.kind,
    queryId: value.queryId,
  };
}

function draftPlan(args: {
  question: string;
  step3: PreparedStep3Input;
  draft: DraftPlan;
}): Step4QueryPlan | null {
  const analysisType = analysisTypeOrDefault(args.draft.analysisType);
  if (!analysisType) return null;

  const authoritativeMappings = new Map(
    args.step3.mappings.map((mapping) => [mapping.mappingId, mapping])
  );
  const authoritativeGroups = new Map<string, PreparedMapping[]>();
  for (const mapping of args.step3.mappings) {
    const key = groupKey(mapping);
    const group = authoritativeGroups.get(key) ?? [];
    group.push(mapping);
    authoritativeGroups.set(key, group);
  }
  const queries = draftQueries(args.draft);
  if (!queries) return null;

  const countQueries: CountQuery[] = [];
  for (const query of queries) {
    const panels = draftPanels(query);
    if (!panels) return null;

    const hydratedPanels: QueryPanel[] = [];
    const groupPanelIndexes = new Map<string, number>();
    for (const panel of panels) {
      const mappingIds = draftMappingIds(panel);
      if (!mappingIds) return null;

      const items: QueryPlanItem[] = [];
      const includedMappingIds = new Set<string>();
      for (const mappingId of mappingIds) {
        const mapping = authoritativeMappings.get(mappingId);
        if (!mapping) return null;
        const key = groupKey(mapping);
        const existingPanelIndex = groupPanelIndexes.get(key);
        if (
          existingPanelIndex !== undefined &&
          existingPanelIndex !== hydratedPanels.length
        ) {
          return null;
        }
        groupPanelIndexes.set(key, hydratedPanels.length);
        for (const groupedMapping of authoritativeGroups.get(key) ?? [mapping]) {
          if (includedMappingIds.has(groupedMapping.mappingId)) continue;
          includedMappingIds.add(groupedMapping.mappingId);
          items.push(toQueryPlanItem(groupedMapping));
        }
      }

      const logic = logicOrDefault(panel.logic);
      const panelTiming = timingOrDefault(panel.panelTiming);
      if (!logic || !panelTiming) return null;

      hydratedPanels.push({
        id: stringOrDefault(panel.id, `panel-${hydratedPanels.length + 1}`),
        title: stringOrDefault(panel.title, items[0].concept),
        logic,
        items,
        dateRange: dateRange(panel.dateRange),
        occursAtLeast: numberOrDefault(panel.occursAtLeast, 1),
        panelTiming,
      });
    }

    const temporalRules: TemporalRule[] = [];
    if (query.temporalRules !== undefined) {
      if (!Array.isArray(query.temporalRules)) return null;
      for (const value of query.temporalRules) {
        const parsedRule = temporalRule(value);
        if (!parsedRule) return null;
        temporalRules.push(parsedRule);
      }
    }

    countQueries.push({
      id: stringOrDefault(query.id, `query-${countQueries.length + 1}`),
      name: typeof query.name === "string" ? query.name : "Draft count query",
      purpose: typeof query.purpose === "string" ? query.purpose : "count",
      panels: hydratedPanels,
      temporalRules,
    });
  }

  const analysisCells: AnalysisCell[] = [];
  if (args.draft.analysisCells !== undefined) {
    if (!Array.isArray(args.draft.analysisCells)) return null;
    for (const value of args.draft.analysisCells) {
      const parsedCell = analysisCell(value);
      if (!parsedCell) return null;
      analysisCells.push(parsedCell);
    }
  }

  const plan: Step4QueryPlan = {
    version: STEP4_QUERY_PLAN_VERSION,
    question: args.question,
    analysisType,
    querySetName: stringOrDefault(args.draft.querySetName, args.question),
    countQueries,
    analysisCells,
    validationIssues: [],
    generation: "llm",
  };

  return {
    ...plan,
    validationIssues: queryPlanIssues(plan, args.step3.validationIssues),
  };
}

export function queryPlanPromptInput(
  mappings: PreparedMapping[]
): Array<{
  mappingId: string;
  concept: string;
  category: string;
  role?: string;
  display: string;
  valueConstraint?: ValueConstraint;
}> {
  return mappings.map((mapping) => {
    const input: {
      mappingId: string;
      concept: string;
      category: string;
      role?: string;
      display: string;
      valueConstraint?: ValueConstraint;
    } = {
      mappingId: mapping.mappingId,
      concept: mapping.concept,
      category: mapping.category,
      role: mapping.role,
      display: mapping.display,
    };
    if (mapping.valueConstraint !== undefined) {
      input.valueConstraint = mapping.valueConstraint;
    }
    return input;
  });
}

export function buildStep4QueryPlan(args: {
  question: string;
  concepts: Record<string, unknown>;
  step3: PreparedStep3Input;
  rawDraft?: string | null;
  modelUnavailable?: boolean;
}): Step4QueryPlan {
  const parsedDraft = parseJsonObject(args.rawDraft);
  if (parsedDraft) {
    const hydratedDraft = draftPlan({
      question: args.question,
      step3: args.step3,
      draft: parsedDraft,
    });
    if (
      hydratedDraft &&
      !validateStep4QueryPlan(hydratedDraft).some(
        (issue) => issue.severity === "error"
      )
    ) {
      return hydratedDraft;
    }
  }

  const plan = fallbackPlan({
    question: args.question,
    concepts: args.concepts,
    step3: args.step3,
  });
  return args.modelUnavailable ? withModelUnavailableIssue(plan) : plan;
}
