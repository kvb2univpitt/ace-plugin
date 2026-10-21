import { XMLValidator } from "fast-xml-parser";
import type { ValueConstraint } from "../stage3/valueConstraint";
import type {
  CountQuery,
  QueryPanel,
  QueryPlanItem,
  Step4QueryPlan,
  Step5ArtifactStatus,
  Step5XmlArtifact,
  Step5XmlPackage,
  TemporalRule,
  ValidationIssue,
} from "../common/query-plan-types";
import { validateStep4QueryPlan } from "../stage4/query-plan-validation";

const VALUE_OPERATORS: Record<
  Extract<ValueConstraint, { type: "single" }>['operator'],
  string
> = {
  GreaterThan: "GT",
  GreaterThanOrEqual: "GE",
  Equal: "EQ",
  LessThanOrEqual: "LE",
  LessThan: "LT",
};

const FLAG_VALUES: Record<
  Extract<ValueConstraint, { type: "flag" }>['flag'],
  string
> = {
  Low: "L",
  Normal: "@",
  High: "H",
};

const MAPPING_ERROR_CODES = new Set([
  "missing_path",
  "missing_mapping",
  "missing_item_key",
  "unmapped_concept",
  "no_authoritative_mappings",
  "unverified_ontology_anchor",
  "incoherent_code_path",
  "mapping_recovery_failed",
  "conflicting_mapping_id",
  "invalid_concept_set_member",
  "conflicting_concept_set_path",
  "unsupported_selection_mode",
  "conflicting_selection_mode",
]);

const SUPPORTED_RELATIONS = new Set([
  "BEFORE",
  "AFTER",
  "BEFORE_OR_SAME",
  "AFTER_OR_SAME",
]);

function xmlEscape(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function compact(lines: string[]): string {
  return lines.filter((line) => line.length > 0).join("\n");
}

function valueConstraintXml(
  constraint: ValueConstraint | undefined,
  indent: string
): string {
  if (!constraint) return "";
  const inner = `${indent}  `;
  if (constraint.type === "flag") {
    return compact([
      `${indent}<constrain_by_value>`,
      `${inner}<value_type>FLAG</value_type>`,
      `${inner}<value_operator>EQ</value_operator>`,
      `${inner}<value_constraint>${FLAG_VALUES[constraint.flag]}</value_constraint>`,
      `${indent}</constrain_by_value>`,
    ]);
  }
  if (constraint.type === "range") {
    return compact([
      `${indent}<constrain_by_value>`,
      `${inner}<value_type>NUMBER</value_type>`,
      constraint.unit
        ? `${inner}<value_unit_of_measure>${xmlEscape(constraint.unit)}</value_unit_of_measure>`
        : "",
      `${inner}<value_operator>BETWEEN</value_operator>`,
      `${inner}<value_constraint>${xmlEscape(`${constraint.value1} and ${constraint.value2}`)}</value_constraint>`,
      `${indent}</constrain_by_value>`,
    ]);
  }
  return compact([
    `${indent}<constrain_by_value>`,
    `${inner}<value_type>NUMBER</value_type>`,
    constraint.unit
      ? `${inner}<value_unit_of_measure>${xmlEscape(constraint.unit)}</value_unit_of_measure>`
      : "",
    `${inner}<value_operator>${VALUE_OPERATORS[constraint.operator]}</value_operator>`,
    `${inner}<value_constraint>${xmlEscape(constraint.value)}</value_constraint>`,
    `${indent}</constrain_by_value>`,
  ]);
}

function itemDateXml(panel: QueryPanel, indent: string): string {
  const inner = `${indent}  `;
  return compact([
    `${indent}<constrain_by_date>`,
    panel.dateRange?.start
      ? `${inner}<date_from>${xmlEscape(panel.dateRange.start)}</date_from>`
      : "",
    panel.dateRange?.end
      ? `${inner}<date_to>${xmlEscape(panel.dateRange.end)}</date_to>`
      : "",
    `${indent}</constrain_by_date>`,
  ]);
}

function itemXml(item: QueryPlanItem, panel: QueryPanel, indent: string): string {
  const inner = `${indent}  `;
  return compact([
    `${indent}<item>`,
    `${inner}<hlevel>${xmlEscape(item.level)}</hlevel>`,
    `${inner}<item_name>${xmlEscape(item.display || item.concept)}</item_name>`,
    `${inner}<item_key>${xmlEscape(item.path)}</item_key>`,
    `${inner}<tooltip>${xmlEscape(item.path)}</tooltip>`,
    `${inner}<class>ENC</class>`,
    itemDateXml(panel, inner),
    valueConstraintXml(item.valueConstraint, inner),
    `${inner}<item_icon>LA</item_icon>`,
    `${inner}<item_is_synonym>false</item_is_synonym>`,
    `${indent}</item>`,
  ]);
}

function panelXml(
  panel: QueryPanel,
  panelNumber: number,
  indent: string,
  timingOverride?: QueryPanel["panelTiming"]
): string {
  const inner = `${indent}  `;
  return compact([
    `${indent}<panel>`,
    `${inner}<panel_number>${panelNumber}</panel_number>`,
    panel.dateRange?.start
      ? `${inner}<panel_date_from>${xmlEscape(panel.dateRange.start)}</panel_date_from>`
      : "",
    panel.dateRange?.end
      ? `${inner}<panel_date_to>${xmlEscape(panel.dateRange.end)}</panel_date_to>`
      : "",
    `${inner}<panel_accuracy_scale>100</panel_accuracy_scale>`,
    `${inner}<invert>${panel.logic === "WITHOUT" ? "1" : "0"}</invert>`,
    `${inner}<panel_timing>${timingOverride ?? panel.panelTiming}</panel_timing>`,
    `${inner}<total_item_occurrences>${panel.occursAtLeast}</total_item_occurrences>`,
    ...panel.items.map((item) => itemXml(item, panel, inner)),
    `${indent}</panel>`,
  ]);
}

function spanXml(
  operator: "GREATEREQUAL" | "LESSEQUAL",
  days: number | undefined
): string {
  if (days === undefined) return "";
  return compact([
    "    <span>",
    `      <operator>${operator}</operator>`,
    `      <span_value>${days}</span_value>`,
    "      <units>DAY</units>",
    "    </span>",
  ]);
}

function temporalConstraintXml(rule: TemporalRule, inclusive: boolean): string {
  return compact([
    "  <subquery_constraint>",
    "    <first_query>",
    "      <query_id>Event 1</query_id>",
    "      <join_column>STARTDATE</join_column>",
    "      <aggregate_operator>ANY</aggregate_operator>",
    "    </first_query>",
    `    <operator>${inclusive ? "LESSEQUAL" : "LESS"}</operator>`,
    "    <second_query>",
    "      <query_id>Event 2</query_id>",
    "      <join_column>STARTDATE</join_column>",
    "      <aggregate_operator>ANY</aggregate_operator>",
    "    </second_query>",
    spanXml("GREATEREQUAL", rule.minDays),
    spanXml("LESSEQUAL", rule.maxDays),
    "  </subquery_constraint>",
  ]);
}

function subqueryXml(
  query: CountQuery,
  panel: QueryPanel,
  eventNumber: number
): string {
  return compact([
    "  <subquery>",
    `    <query_id>Event ${eventNumber}</query_id>`,
    "    <query_type>EVENT</query_type>",
    `    <query_name>${xmlEscape(`${query.id} Event ${eventNumber}`)}</query_name>`,
    "    <query_timing>SAMEINSTANCENUM</query_timing>",
    "    <specificity_scale>0</specificity_scale>",
    "    <use_shrine>1</use_shrine>",
    panelXml(panel, 1, "    ", "SAMEINSTANCENUM"),
    "  </subquery>",
  ]);
}

function chronologicalPanels(
  query: CountQuery,
  rule: TemporalRule
): {
  first: QueryPanel;
  second: QueryPanel;
  inclusive: boolean;
} | null {
  if (!SUPPORTED_RELATIONS.has(rule.relation)) return null;
  const firstPanel = query.panels.find(
    (panel) => panel.id === rule.firstPanelId
  );
  const secondPanel = query.panels.find(
    (panel) => panel.id === rule.secondPanelId
  );
  if (!firstPanel || !secondPanel || firstPanel.id === secondPanel.id) {
    return null;
  }
  const reverse =
    rule.relation === "AFTER" || rule.relation === "AFTER_OR_SAME";
  return {
    first: reverse ? secondPanel : firstPanel,
    second: reverse ? firstPanel : secondPanel,
    inclusive:
      rule.relation === "BEFORE_OR_SAME" ||
      rule.relation === "AFTER_OR_SAME",
  };
}

function panelSummary(query: CountQuery): string {
  const panelDescriptions = query.panels.map((panel) => {
    const items = panel.items
      .map((item) => item.display || item.concept)
      .join(" OR ");
    return `${panel.logic} ${panel.title}: ${items}`;
  });
  const temporalDescriptions = query.temporalRules.map((rule) => {
    const first = query.panels.find((panel) => panel.id === rule.firstPanelId);
    const second = query.panels.find((panel) => panel.id === rule.secondPanelId);
    return `${first?.title ?? rule.firstPanelId} ${rule.relation.replaceAll("_", " ")} ${second?.title ?? rule.secondPanelId}`;
  });
  return [...panelDescriptions, ...temporalDescriptions].join("; ");
}

function dedupeIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((current) => {
    const identity = JSON.stringify([
      current.code,
      current.severity,
      current.message,
      current.target ?? null,
    ]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function issueAppliesToQuery(
  issue: ValidationIssue,
  query: CountQuery,
  queryIndex: number,
  plan: Step4QueryPlan
): boolean {
  if (!issue.target) return true;
  const indexedTarget = /^countQueries\[(\d+)\]/.exec(issue.target);
  if (indexedTarget) return Number(indexedTarget[1]) === queryIndex;
  const analysisTarget = /^analysisCells\[(\d+)\]/.exec(issue.target);
  if (analysisTarget) {
    return plan.analysisCells[Number(analysisTarget[1])]?.queryId === query.id;
  }
  if (
    issue.target === query.id ||
    issue.target === query.name ||
    issue.target.startsWith(`${query.id}.`) ||
    issue.target.startsWith(`${query.id}:`) ||
    issue.target.startsWith(`${query.name}:`)
  ) {
    return true;
  }
  const mappingIds = new Set(
    query.panels.flatMap((panel) => panel.items.map((item) => item.mappingId))
  );
  if (mappingIds.has(issue.target)) return true;
  const belongsToAnotherQuery = plan.countQueries.some(
    (candidate) =>
      candidate.id !== query.id &&
      candidate.panels.some((panel) =>
        panel.items.some((item) => item.mappingId === issue.target)
      )
  );
  if (belongsToAnotherQuery) return false;

  return (
    issue.target.startsWith("countQueries.") ||
    issue.target === "countQueries" ||
    issue.target === "analysisCells" ||
    issue.target === "queryPlan" ||
    issue.target === "version" ||
    issue.target === "analysisType" ||
    !issue.target.includes("countQueries[")
  );
}

function statusForIssues(issues: ValidationIssue[]): Step5ArtifactStatus {
  const errors = issues.filter((current) => current.severity === "error");
  if (errors.some((current) => MAPPING_ERROR_CODES.has(current.code))) {
    return "needs_mapping";
  }
  return errors.length > 0 ? "needs_manual_review" : "ready";
}

function compileReadyQuery(query: CountQuery): {
  xml: string | null;
  status: Step5ArtifactStatus;
  warnings: string[];
} {
  if (query.temporalRules.length > 1) {
    return {
      xml: null,
      status: "needs_manual_review",
      warnings: ["Only one simple two-event temporal rule is supported."],
    };
  }

  let temporal:
    | {
        rule: TemporalRule;
        first: QueryPanel;
        second: QueryPanel;
        inclusive: boolean;
      }
    | undefined;
  if (query.temporalRules.length === 1) {
    const rule = query.temporalRules[0];
    const ordered = chronologicalPanels(query, rule);
    if (!ordered) {
      return {
        xml: null,
        status: "needs_manual_review",
        warnings: ["The temporal rule cannot be encoded as two ordered events."],
      };
    }
    if (ordered.first.logic !== "WITH" || ordered.second.logic !== "WITH") {
      return {
        xml: null,
        status: "needs_manual_review",
        warnings: ["Temporal event panels must use WITH logic."],
      };
    }
    temporal = { rule, ...ordered };
  }

  const temporalPanelIds = new Set(
    temporal ? [temporal.first.id, temporal.second.id] : []
  );
  const topLevelPanels = query.panels
    .filter((panel) => !temporalPanelIds.has(panel.id))
    .map((panel, index) => panelXml(panel, index + 1, "  "));
  const xml = compact([
    "<query_definition>",
    `  <query_name>${xmlEscape(query.name)}</query_name>`,
    "  <query_timing>ANY</query_timing>",
    "  <specificity_scale>0</specificity_scale>",
    "  <use_shrine>1</use_shrine>",
    ...topLevelPanels,
    temporal
      ? temporalConstraintXml(temporal.rule, temporal.inclusive)
      : "",
    temporal ? subqueryXml(query, temporal.first, 1) : "",
    temporal ? subqueryXml(query, temporal.second, 2) : "",
    "</query_definition>",
  ]);

  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    return {
      xml: null,
      status: "needs_manual_review",
      warnings: [
        `Final i2b2 XML validation failed: ${validation.err?.msg ?? "unknown XML error"}`,
      ],
    };
  }
  return { xml, status: "ready", warnings: [] };
}

export function compileI2b2XmlPackage(
  plan: Step4QueryPlan
): Step5XmlPackage {
  const allIssues = dedupeIssues([
    ...plan.validationIssues,
    ...validateStep4QueryPlan(plan),
  ]);
  const artifacts: Step5XmlArtifact[] = plan.countQueries.map(
    (query, queryIndex) => {
      const queryIssues = allIssues.filter((current) =>
        issueAppliesToQuery(current, query, queryIndex, plan)
      );
      const issueStatus = statusForIssues(queryIssues);
      const compiled =
        issueStatus === "ready"
          ? compileReadyQuery(query)
          : { xml: null, status: issueStatus, warnings: [] };
      const warnings = Array.from(
        new Set([
          ...queryIssues.map((current) => current.message),
          ...compiled.warnings,
        ])
      );
      return {
        queryId: query.id,
        queryName: query.name,
        xml: compiled.xml,
        status: compiled.status,
        sharepheReady: compiled.status === "ready",
        warnings,
        panelSummary: panelSummary(query),
      };
    }
  );
  const warnings = Array.from(
    new Set([
      ...allIssues.map((current) => current.message),
      ...artifacts.flatMap((artifact) => artifact.warnings),
    ])
  );

  return {
    version: "step5-i2b2-xml-v1",
    querySetName: plan.querySetName,
    artifacts,
    validationSummary: {
      readyCount: artifacts.filter((artifact) => artifact.status === "ready")
        .length,
      needsMappingCount: artifacts.filter(
        (artifact) => artifact.status === "needs_mapping"
      ).length,
      needsManualReviewCount: artifacts.filter(
        (artifact) => artifact.status === "needs_manual_review"
      ).length,
      warnings,
    },
  };
}
