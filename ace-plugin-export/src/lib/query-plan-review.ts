import { revalidateEditedQueryPlan } from "./query-plan-validation";
import type {
  CountQuery,
  QueryPanel,
  QueryPlanItem,
  Step4QueryPlan,
  TemporalRule,
} from "./query-plan-types";

function cloneItem(item: QueryPlanItem): QueryPlanItem {
  return {
    ...item,
    valueConstraint: item.valueConstraint
      ? { ...item.valueConstraint }
      : undefined,
  };
}

function slugId(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function allPanelIds(plan: Step4QueryPlan): string[] {
  return plan.countQueries.flatMap((query) =>
    query.panels.map((panel) => panel.id)
  );
}

export function uniqueQueryPlanId(
  base: string,
  usedIds: Iterable<string>
): string {
  const used = new Set(usedIds);
  const root = slugId(base, "item");
  if (!used.has(root)) return root;

  let next = 2;
  while (used.has(`${root}-${next}`)) next += 1;
  return `${root}-${next}`;
}

export function hasValidationErrors(plan: Step4QueryPlan): boolean {
  return plan.validationIssues.some((issue) => issue.severity === "error");
}

export function collectInitialItemPool(
  plan: Step4QueryPlan,
  authoritativeItems?: QueryPlanItem[]
): QueryPlanItem[] {
  const byMappingId = new Map<string, QueryPlanItem>();
  const selectedItems = plan.countQueries.flatMap((query) =>
    query.panels.flatMap((panel) => panel.items)
  );
  const source = authoritativeItems ?? selectedItems;

  for (const item of source) {
    if (!byMappingId.has(item.mappingId)) {
      byMappingId.set(item.mappingId, cloneItem(item));
    }
  }
  return [...byMappingId.values()].sort((a, b) =>
    `${a.category}:${a.concept}`.localeCompare(`${b.category}:${b.concept}`)
  );
}

export function availableItemsForPanel(
  panel: QueryPanel,
  itemPool: QueryPlanItem[]
): QueryPlanItem[] {
  const used = new Set(panel.items.map((item) => item.mappingId));
  return itemPool.filter((item) => !used.has(item.mappingId));
}

export function updateCountQueryInPlan(
  plan: Step4QueryPlan,
  queryIndex: number,
  query: CountQuery
): Step4QueryPlan {
  return revalidateEditedQueryPlan({
    ...plan,
    countQueries: plan.countQueries.map((current, index) =>
      index === queryIndex ? query : current
    ),
  });
}

export function updatePanelInPlan(
  plan: Step4QueryPlan,
  queryIndex: number,
  panelIndex: number,
  panel: QueryPanel
): Step4QueryPlan {
  const query = plan.countQueries[queryIndex];
  if (!query) return plan;

  return updateCountQueryInPlan(plan, queryIndex, {
    ...query,
    panels: query.panels.map((current, index) =>
      index === panelIndex ? panel : current
    ),
  });
}

export function updatePanelDateRange(
  panel: QueryPanel,
  field: "start" | "end",
  value: string
): QueryPanel {
  const dateRange = {
    ...(panel.dateRange ?? {}),
    [field]: value.trim() || undefined,
  };
  const normalized = Object.fromEntries(
    Object.entries(dateRange).filter(([, current]) => current !== undefined)
  ) as QueryPanel["dateRange"];

  return {
    ...panel,
    dateRange:
      normalized && (normalized.start || normalized.end) ? normalized : undefined,
  };
}

export function addCountQueryToPlan(plan: Step4QueryPlan): Step4QueryPlan {
  const id = uniqueQueryPlanId(
    `query-${plan.countQueries.length + 1}`,
    plan.countQueries.map((query) => query.id)
  );
  const panelId = uniqueQueryPlanId(`${id}-panel-1`, allPanelIds(plan));
  const analysisCellId = uniqueQueryPlanId(
    `cell-${id}`,
    plan.analysisCells.map((cell) => cell.id)
  );

  return revalidateEditedQueryPlan({
    ...plan,
    countQueries: [
      ...plan.countQueries,
      {
        id,
        name: "New count query",
        purpose: "Define the cohort counted by this query.",
        panels: [
          {
            id: panelId,
            title: "New panel",
            logic: "WITH",
            items: [],
            occursAtLeast: 1,
            panelTiming: "ANY",
          },
        ],
        temporalRules: [],
      },
    ],
    analysisCells: [
      ...plan.analysisCells,
      {
        id: analysisCellId,
        arm: "overall",
        outcome: "cohort",
        kind: "denominator",
        queryId: id,
      },
    ],
  });
}

export function removeCountQueryFromPlan(
  plan: Step4QueryPlan,
  queryIndex: number
): Step4QueryPlan {
  const removed = plan.countQueries[queryIndex];
  if (!removed) return plan;

  return revalidateEditedQueryPlan({
    ...plan,
    countQueries: plan.countQueries.filter((_, index) => index !== queryIndex),
    analysisCells: plan.analysisCells.filter(
      (cell) => cell.queryId !== removed.id
    ),
  });
}

export function addPanelToQuery(
  plan: Step4QueryPlan,
  queryIndex: number
): Step4QueryPlan {
  const query = plan.countQueries[queryIndex];
  if (!query) return plan;

  const id = uniqueQueryPlanId(
    `${query.id}-panel-${query.panels.length + 1}`,
    allPanelIds(plan)
  );

  return updateCountQueryInPlan(plan, queryIndex, {
    ...query,
    panels: [
      ...query.panels,
      {
        id,
        title: "New panel",
        logic: "WITH",
        items: [],
        occursAtLeast: 1,
        panelTiming: "ANY",
      },
    ],
  });
}

export function removePanelFromQuery(
  plan: Step4QueryPlan,
  queryIndex: number,
  panelIndex: number
): Step4QueryPlan {
  const query = plan.countQueries[queryIndex];
  const panel = query?.panels[panelIndex];
  if (!query || !panel) return plan;

  return updateCountQueryInPlan(plan, queryIndex, {
    ...query,
    panels: query.panels.filter((_, index) => index !== panelIndex),
    temporalRules: query.temporalRules.filter(
      (rule) =>
        rule.firstPanelId !== panel.id && rule.secondPanelId !== panel.id
    ),
  });
}

export function addItemToPanel(
  plan: Step4QueryPlan,
  itemPool: QueryPlanItem[],
  queryIndex: number,
  panelIndex: number,
  mappingId: string
): Step4QueryPlan {
  const panel = plan.countQueries[queryIndex]?.panels[panelIndex];
  const item = itemPool.find((candidate) => candidate.mappingId === mappingId);
  if (!panel || !item) return plan;
  if (panel.items.some((current) => current.mappingId === mappingId)) {
    return plan;
  }

  return updatePanelInPlan(plan, queryIndex, panelIndex, {
    ...panel,
    items: [...panel.items, cloneItem(item)],
  });
}

export function removeItemFromPanel(
  plan: Step4QueryPlan,
  queryIndex: number,
  panelIndex: number,
  mappingId: string
): Step4QueryPlan {
  const panel = plan.countQueries[queryIndex]?.panels[panelIndex];
  if (!panel) return plan;

  return updatePanelInPlan(plan, queryIndex, panelIndex, {
    ...panel,
    items: panel.items.filter((item) => item.mappingId !== mappingId),
  });
}

export function setOnlyTemporalRule(
  plan: Step4QueryPlan,
  queryId: string,
  rule: TemporalRule
): Step4QueryPlan {
  return revalidateEditedQueryPlan({
    ...plan,
    countQueries: plan.countQueries.map((query) => ({
      ...query,
      temporalRules: query.id === queryId ? [rule] : query.temporalRules,
    })),
  });
}

export function addTemporalRuleToQuery(
  plan: Step4QueryPlan,
  queryId: string
): Step4QueryPlan {
  const query = plan.countQueries.find((candidate) => candidate.id === queryId);
  if (!query) return plan;

  if (query.panels.length < 2) {
    return revalidateEditedQueryPlan(plan);
  }

  const firstPanelId = query.panels[0].id;
  const secondPanelId = query.panels[1].id;
  const ruleId = uniqueQueryPlanId(
    `${query.id}-temporal`,
    plan.countQueries.flatMap((candidate) =>
      candidate.temporalRules.map((rule) => rule.id)
    )
  );

  return setOnlyTemporalRule(plan, query.id, {
    id: ruleId,
    relation: "BEFORE",
    firstPanelId,
    secondPanelId,
  });
}

export function removeTemporalRules(
  plan: Step4QueryPlan,
  queryId?: string
): Step4QueryPlan {
  return revalidateEditedQueryPlan({
    ...plan,
    countQueries: plan.countQueries.map((query) => ({
      ...query,
      temporalRules:
        queryId === undefined || query.id === queryId
          ? []
          : query.temporalRules,
    })),
  });
}
