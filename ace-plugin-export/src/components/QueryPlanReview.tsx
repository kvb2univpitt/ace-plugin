"use client";

import { useState } from "react";
import type * as React from "react";
import {
  addCountQueryToPlan,
  addItemToPanel,
  addPanelToQuery,
  addTemporalRuleToQuery,
  availableItemsForPanel,
  collectInitialItemPool,
  removeCountQueryFromPlan,
  removeItemFromPanel,
  removePanelFromQuery,
  removeTemporalRules,
  setOnlyTemporalRule,
  updateCountQueryInPlan,
  updatePanelDateRange,
  updatePanelInPlan,
} from "@/lib/query-plan-review";
import type {
  CountQuery,
  PanelLogic,
  PanelTiming,
  QueryPanel,
  QueryPlanItem,
  Step4QueryPlan,
  TemporalRelation,
  TemporalRule,
  ValidationIssue,
} from "@/lib/query-plan-types";

const PANEL_LOGICS: PanelLogic[] = ["WITH", "WITHOUT"];
const PANEL_TIMINGS: PanelTiming[] = ["ANY", "SAMEVISIT", "SAMEINSTANCENUM"];
const TEMPORAL_RELATIONS: TemporalRelation[] = [
  "BEFORE",
  "AFTER",
  "BEFORE_OR_SAME",
  "AFTER_OR_SAME",
];

const OPERATOR_LABEL: Record<string, string> = {
  GreaterThan: ">",
  GreaterThanOrEqual: ">=",
  Equal: "=",
  LessThanOrEqual: "<=",
  LessThan: "<",
};

function classNames(...names: Array<string | false | undefined>): string {
  return names.filter(Boolean).join(" ");
}

function controlId(...parts: Array<string | number>): string {
  return parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
}

function formatGeneration(generation: Step4QueryPlan["generation"]): string {
  return generation === "llm" ? "LLM draft" : "Deterministic fallback";
}

function formatValueConstraint(item: QueryPlanItem): string | null {
  const constraint = item.valueConstraint;
  if (!constraint) return null;

  if (constraint.type === "flag") {
    return constraint.flag;
  }
  if (constraint.type === "single") {
    return `${OPERATOR_LABEL[constraint.operator] ?? constraint.operator} ${constraint.value}${
      constraint.unit ? ` ${constraint.unit}` : ""
    }`;
  }
  return `${constraint.value1}-${constraint.value2}${constraint.unit ? ` ${constraint.unit}` : ""}`;
}

function formatDateRange(panel: QueryPanel): string {
  const start = panel.dateRange?.start;
  const end = panel.dateRange?.end;
  if (start && end) return `${start} to ${end}`;
  if (start) return `from ${start}`;
  if (end) return `through ${end}`;
  return "Any date";
}

function issueTone(issue: ValidationIssue): string {
  return issue.severity === "error"
    ? "border-red-200 bg-red-50 text-red-700"
    : "border-amber-200 bg-amber-50 text-amber-700";
}

function logicTone(logic: PanelLogic): string {
  return logic === "WITH"
    ? "bg-emerald-100 text-emerald-700 border-emerald-200"
    : "bg-red-100 text-red-700 border-red-200";
}

function QueryPlanIssues({ issues }: { issues: ValidationIssue[] }): React.ReactNode {
  if (issues.length === 0) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
        No validation issues.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {issues.map((issue, index) => (
        <div
          key={`${issue.code}-${issue.target ?? index}`}
          className={classNames(
            "rounded-lg border px-3 py-2 text-sm",
            issueTone(issue)
          )}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold uppercase">{issue.severity}</span>
            <span className="font-mono text-xs">{issue.code}</span>
            {issue.target ? (
              <span className="min-w-0 break-all text-xs opacity-80">
                {issue.target}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm">{issue.message}</p>
        </div>
      ))}
    </div>
  );
}

function ItemDetails({
  item,
  onRemove,
}: {
  item: QueryPlanItem;
  onRemove?: () => void;
}): React.ReactNode {
  const valueConstraint = formatValueConstraint(item);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-gray-900 break-words">
              {item.concept}
            </p>
            <span className="rounded-md bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
              {item.category}
            </span>
            {item.role ? (
              <span className="rounded-md bg-violet-50 px-2 py-0.5 text-xs text-violet-700">
                {item.role}
              </span>
            ) : null}
            {valueConstraint ? (
              <span className="rounded-md bg-amber-50 px-2 py-0.5 text-xs font-mono text-amber-700">
                {valueConstraint}
              </span>
            ) : null}
          </div>
          <div className="mt-2 grid gap-1 text-xs text-gray-700">
            <p className="min-w-0 break-words">
              <span className="font-semibold text-gray-800">Display:</span>{" "}
              {item.display}
            </p>
            <p className="font-mono text-xs text-gray-800">
              {item.system}: {item.code}
            </p>
            <p className="min-w-0 break-all font-mono text-xs text-gray-700">
              {item.path}
            </p>
            <p className="min-w-0 break-all text-xs text-gray-600">
              <span className="font-semibold text-gray-700">Source:</span>{" "}
              {item.source} / {item.mappingId}
            </p>
          </div>
        </div>
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="shrink-0 rounded-md border border-gray-200 px-2 py-1 text-xs font-medium text-gray-600 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-red-500/30"
          >
            Remove
          </button>
        ) : null}
      </div>
    </div>
  );
}

function PlanHeader({ plan }: { plan: Step4QueryPlan }): React.ReactNode {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
        <p className="text-xs font-semibold uppercase text-gray-500">
          Query set
        </p>
        <p className="mt-1 min-w-0 break-words text-sm font-semibold text-gray-900">
          {plan.querySetName || "Untitled query set"}
        </p>
      </div>
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
        <p className="text-xs font-semibold uppercase text-gray-500">
          Generation mode
        </p>
        <p className="mt-1 text-sm font-semibold text-gray-900">
          {formatGeneration(plan.generation)}
        </p>
      </div>
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
        <p className="text-xs font-semibold uppercase text-gray-500">
          Count queries
        </p>
        <p className="mt-1 text-sm font-semibold text-gray-900">
          {plan.countQueries.length}
        </p>
      </div>
    </div>
  );
}

function QuerySummaryCard({ query }: { query: CountQuery }): React.ReactNode {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h5 className="break-words text-sm font-semibold text-gray-900">
            {query.name || "Untitled count query"}
          </h5>
          <p className="mt-1 break-words text-sm text-gray-700">
            {query.purpose || "No purpose entered."}
          </p>
        </div>
        <span className="rounded-md bg-gray-100 px-2 py-1 font-mono text-xs text-gray-700">
          {query.id}
        </span>
      </div>

      <div className="mt-3 space-y-2">
        {query.panels.map((panel) => (
          <div
            key={panel.id}
            className="rounded-lg border border-gray-200 bg-gray-50 p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={classNames(
                  "rounded-md border px-2 py-0.5 text-xs font-bold",
                  logicTone(panel.logic)
                )}
              >
                {panel.logic}
              </span>
              <span className="min-w-0 break-words text-sm font-medium text-gray-900">
                {panel.title || "Untitled panel"}
              </span>
              <span className="text-xs text-gray-600">
                occurs at least {panel.occursAtLeast}; {panel.panelTiming};{" "}
                {formatDateRange(panel)}
              </span>
            </div>
            <div className="mt-2 grid gap-2">
              {panel.items.length > 0 ? (
                panel.items.map((item) => (
                  <ItemDetails key={item.mappingId} item={item} />
                ))
              ) : (
                <p className="rounded-md border border-dashed border-gray-300 px-3 py-2 text-sm text-gray-500">
                  No authoritative items in this panel.
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      {query.temporalRules.length > 0 ? (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {query.temporalRules.map((rule) => (
            <p key={rule.id} className="break-words">
              {rule.firstPanelId} {rule.relation} {rule.secondPanelId}
              {typeof rule.minDays === "number" || typeof rule.maxDays === "number"
                ? ` (${rule.minDays ?? 0}-${rule.maxDays ?? "open"} days)`
                : ""}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AddItemSelect({
  panel,
  itemPool,
  onAdd,
}: {
  panel: QueryPanel;
  itemPool: QueryPlanItem[];
  onAdd: (mappingId: string) => void;
}): React.ReactNode {
  const available = availableItemsForPanel(panel, itemPool);

  return (
    <label className="mt-2 block">
      <span className="mb-1 block text-xs font-medium text-gray-700">
        Add authoritative item
      </span>
      <select
        value=""
        onChange={(event) => {
          if (event.target.value) onAdd(event.target.value);
        }}
        disabled={available.length === 0}
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 transition-colors focus:outline-none focus:ring-2 focus:ring-violet-500/30 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400"
      >
        <option value="">
          {available.length > 0
            ? "Select from initial item pool"
            : "All initial items are already in this panel"}
        </option>
        {available.map((item) => (
          <option key={item.mappingId} value={item.mappingId}>
            {item.concept} ({item.category})
          </option>
        ))}
      </select>
    </label>
  );
}

function TemporalRuleEditor({
  plan,
  onChange,
}: {
  plan: Step4QueryPlan;
  onChange: (plan: Step4QueryPlan) => void;
}): React.ReactNode {
  const eligibleQueries = plan.countQueries.filter(
    (query) => query.panels.length >= 2
  );
  const [selectedQueryId, setSelectedQueryId] = useState(
    eligibleQueries.find((query) => query.temporalRules.length > 0)?.id ??
      eligibleQueries[0]?.id ??
      ""
  );

  const selectedQuery =
    eligibleQueries.find((query) => query.id === selectedQueryId) ??
    eligibleQueries[0] ??
    null;
  const existingRule = selectedQuery?.temporalRules[0] ?? null;

  if (!existingRule || !selectedQuery) {
    return (
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-xs font-medium text-gray-700">
              Temporal query
            </span>
            <select
              value={selectedQuery?.id ?? ""}
              onChange={(event) => setSelectedQueryId(event.target.value)}
              disabled={eligibleQueries.length === 0}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-500/30 disabled:bg-gray-50"
            >
              {eligibleQueries.map((query) => (
                <option key={query.id} value={query.id}>
                  {query.name || query.id}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!selectedQuery}
            onClick={() => {
              if (!selectedQuery) return;
              onChange(addTemporalRuleToQuery(plan, selectedQuery.id));
            }}
            className="rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add temporal rule
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-600">
          One simple temporal rule can be defined for each count query.
        </p>
      </div>
    );
  }

  const panelOptions = selectedQuery.panels;
  const updateRule = (rule: TemporalRule) => {
    onChange(setOnlyTemporalRule(plan, selectedQuery.id, rule));
  };

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <div className="grid gap-3 md:grid-cols-2">
        <label>
          <span className="mb-1 block text-xs font-medium text-gray-700">
            Temporal query
          </span>
          <select
            value={selectedQuery.id}
            onChange={(event) => setSelectedQueryId(event.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
          >
            {eligibleQueries.map((query) => (
              <option key={query.id} value={query.id}>
                {query.name || query.id}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span className="mb-1 block text-xs font-medium text-gray-700">
            Relation
          </span>
          <select
            value={existingRule.relation}
            onChange={(event) =>
              updateRule({
                ...existingRule,
                relation: event.target.value as TemporalRelation,
              })
            }
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
          >
            {TEMPORAL_RELATIONS.map((relation) => (
              <option key={relation} value={relation}>
                {relation}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span className="mb-1 block text-xs font-medium text-gray-700">
            First panel
          </span>
          <select
            value={existingRule.firstPanelId}
            onChange={(event) =>
              updateRule({
                ...existingRule,
                firstPanelId: event.target.value,
              })
            }
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
          >
            <option value="">Select panel</option>
            {panelOptions.map((panel) => (
              <option
                key={panel.id}
                value={panel.id}
                disabled={panel.id === existingRule.secondPanelId}
              >
                {panel.title || panel.id}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span className="mb-1 block text-xs font-medium text-gray-700">
            Second panel
          </span>
          <select
            value={existingRule.secondPanelId}
            onChange={(event) =>
              updateRule({
                ...existingRule,
                secondPanelId: event.target.value,
              })
            }
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
          >
            <option value="">Select panel</option>
            {panelOptions.map((panel) => (
              <option
                key={panel.id}
                value={panel.id}
                disabled={panel.id === existingRule.firstPanelId}
              >
                {panel.title || panel.id}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span className="mb-1 block text-xs font-medium text-gray-700">
            Minimum days
          </span>
          <input
            type="number"
            min={0}
            value={existingRule.minDays ?? ""}
            onChange={(event) =>
              updateRule({
                ...existingRule,
                minDays: event.target.value
                  ? Number(event.target.value)
                  : undefined,
              })
            }
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
          />
        </label>

        <label>
          <span className="mb-1 block text-xs font-medium text-gray-700">
            Maximum days
          </span>
          <input
            type="number"
            min={0}
            value={existingRule.maxDays ?? ""}
            onChange={(event) =>
              updateRule({
                ...existingRule,
                maxDays: event.target.value
                  ? Number(event.target.value)
                  : undefined,
              })
            }
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
          />
        </label>
      </div>

      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={() => onChange(removeTemporalRules(plan, selectedQuery.id))}
          className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30"
        >
          Remove temporal rule
        </button>
      </div>
    </div>
  );
}

export function QueryPlanSummary(props: {
  plan: Step4QueryPlan;
}): React.ReactNode {
  const { plan } = props;

  return (
    <div className="space-y-4">
      <PlanHeader plan={plan} />
      <div className="space-y-3">
        {plan.countQueries.length > 0 ? (
          plan.countQueries.map((query) => (
            <QuerySummaryCard key={query.id} query={query} />
          ))
        ) : (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            No count queries were generated.
          </p>
        )}
      </div>

      {plan.analysisCells.length > 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <h5 className="text-sm font-semibold text-gray-900">Analysis cells</h5>
          <div className="mt-2 grid gap-2">
            {plan.analysisCells.map((cell) => (
              <div
                key={cell.id}
                className="grid gap-1 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-700 sm:grid-cols-4"
              >
                <span className="min-w-0 break-words">{cell.arm}</span>
                <span className="min-w-0 break-words">{cell.outcome}</span>
                <span>{cell.kind}</span>
                <span className="min-w-0 break-all font-mono">
                  {cell.queryId}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <QueryPlanIssues issues={plan.validationIssues} />
    </div>
  );
}

export function QueryPlanReview(props: {
  plan: Step4QueryPlan;
  authoritativeItems?: QueryPlanItem[];
  onChange: (plan: Step4QueryPlan) => void;
}): React.ReactNode {
  const { plan, authoritativeItems, onChange } = props;
  const [itemPool] = useState(() =>
    collectInitialItemPool(plan, authoritativeItems)
  );

  return (
    <div className="space-y-5">
      <PlanHeader plan={plan} />
      <QueryPlanIssues issues={plan.validationIssues} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h5 className="text-sm font-semibold text-gray-900">Count queries</h5>
          <p className="text-xs text-gray-600">
            Item choices come from the immutable initial pool of {itemPool.length}{" "}
            authoritative mappings.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onChange(addCountQueryToPlan(plan))}
          className="rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
        >
          Add query
        </button>
      </div>

      <div className="space-y-4">
        {plan.countQueries.map((query, queryIndex) => {
          const nameId = controlId(query.id, "name");
          const purposeId = controlId(query.id, "purpose");
          return (
            <section
              key={query.id}
              className="rounded-xl border border-gray-200 bg-gray-50 p-4"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 sm:flex-1">
                  <label htmlFor={nameId} className="block text-xs font-medium text-gray-700">
                    Query name
                  </label>
                  <input
                    id={nameId}
                    value={query.name}
                    onChange={(event) =>
                      onChange(
                        updateCountQueryInPlan(plan, queryIndex, {
                          ...query,
                          name: event.target.value,
                        })
                      )
                    }
                    className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => onChange(removeCountQueryFromPlan(plan, queryIndex))}
                  className="self-start rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-red-500/30"
                >
                  Remove query
                </button>
              </div>

              <label htmlFor={purposeId} className="mt-3 block text-xs font-medium text-gray-700">
                Purpose
              </label>
              <textarea
                id={purposeId}
                value={query.purpose}
                onChange={(event) =>
                  onChange(
                    updateCountQueryInPlan(plan, queryIndex, {
                      ...query,
                      purpose: event.target.value,
                    })
                  )
                }
                rows={2}
                className="mt-1 w-full resize-y rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
              />

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-4">
                <h6 className="text-xs font-semibold uppercase text-gray-600">
                  Panels
                </h6>
                <button
                  type="button"
                  onClick={() => onChange(addPanelToQuery(plan, queryIndex))}
                  className="rounded-lg border border-violet-200 bg-white px-3 py-2 text-sm font-medium text-violet-700 transition-colors hover:bg-violet-50 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                >
                  Add panel
                </button>
              </div>

              <div className="mt-3 space-y-3">
                {query.panels.map((panel, panelIndex) => {
                  const titleId = controlId(query.id, panel.id, "title");
                  const logicId = controlId(query.id, panel.id, "logic");
                  const timingId = controlId(query.id, panel.id, "timing");
                  const occursId = controlId(query.id, panel.id, "occurs");
                  const startId = controlId(query.id, panel.id, "start");
                  const endId = controlId(query.id, panel.id, "end");
                  return (
                    <div
                      key={panel.id}
                      className="rounded-xl border border-gray-200 bg-white p-4"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 sm:flex-1">
                          <label
                            htmlFor={titleId}
                            className="block text-xs font-medium text-gray-700"
                          >
                            Panel title
                          </label>
                          <input
                            id={titleId}
                            value={panel.title}
                            onChange={(event) =>
                              onChange(
                                updatePanelInPlan(plan, queryIndex, panelIndex, {
                                  ...panel,
                                  title: event.target.value,
                                })
                              )
                            }
                            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            onChange(removePanelFromQuery(plan, queryIndex, panelIndex))
                          }
                          className="self-start rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-red-500/30"
                        >
                          Remove panel
                        </button>
                      </div>

                      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                        <label>
                          <span className="mb-1 block text-xs font-medium text-gray-700">
                            Logic
                          </span>
                          <select
                            id={logicId}
                            value={panel.logic}
                            onChange={(event) =>
                              onChange(
                                updatePanelInPlan(plan, queryIndex, panelIndex, {
                                  ...panel,
                                  logic: event.target.value as PanelLogic,
                                })
                              )
                            }
                            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                          >
                            {PANEL_LOGICS.map((logic) => (
                              <option key={logic} value={logic}>
                                {logic}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label>
                          <span className="mb-1 block text-xs font-medium text-gray-700">
                            Timing
                          </span>
                          <select
                            id={timingId}
                            value={panel.panelTiming}
                            onChange={(event) =>
                              onChange(
                                updatePanelInPlan(plan, queryIndex, panelIndex, {
                                  ...panel,
                                  panelTiming: event.target.value as PanelTiming,
                                })
                              )
                            }
                            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                          >
                            {PANEL_TIMINGS.map((timing) => (
                              <option key={timing} value={timing}>
                                {timing}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label>
                          <span className="mb-1 block text-xs font-medium text-gray-700">
                            Occurrences
                          </span>
                          <input
                            id={occursId}
                            type="number"
                            min={1}
                            value={panel.occursAtLeast}
                            onChange={(event) =>
                              onChange(
                                updatePanelInPlan(plan, queryIndex, panelIndex, {
                                  ...panel,
                                  occursAtLeast: Number(event.target.value),
                                })
                              )
                            }
                            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                          />
                        </label>

                        <label>
                          <span className="mb-1 block text-xs font-medium text-gray-700">
                            Start date
                          </span>
                          <input
                            id={startId}
                            type="date"
                            value={panel.dateRange?.start ?? ""}
                            onChange={(event) =>
                              onChange(
                                updatePanelInPlan(
                                  plan,
                                  queryIndex,
                                  panelIndex,
                                  updatePanelDateRange(
                                    panel,
                                    "start",
                                    event.target.value
                                  )
                                )
                              )
                            }
                            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                          />
                        </label>

                        <label>
                          <span className="mb-1 block text-xs font-medium text-gray-700">
                            End date
                          </span>
                          <input
                            id={endId}
                            type="date"
                            value={panel.dateRange?.end ?? ""}
                            onChange={(event) =>
                              onChange(
                                updatePanelInPlan(
                                  plan,
                                  queryIndex,
                                  panelIndex,
                                  updatePanelDateRange(
                                    panel,
                                    "end",
                                    event.target.value
                                  )
                                )
                              )
                            }
                            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
                          />
                        </label>
                      </div>

                      <div className="mt-4 space-y-2">
                        {panel.items.length > 0 ? (
                          panel.items.map((item) => (
                            <ItemDetails
                              key={item.mappingId}
                              item={item}
                              onRemove={() =>
                                onChange(
                                  removeItemFromPanel(
                                    plan,
                                    queryIndex,
                                    panelIndex,
                                    item.mappingId
                                  )
                                )
                              }
                            />
                          ))
                        ) : (
                          <p className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-500">
                            No items in this panel.
                          </p>
                        )}
                        <AddItemSelect
                          panel={panel}
                          itemPool={itemPool}
                          onAdd={(mappingId) =>
                            onChange(
                              addItemToPanel(
                                plan,
                                itemPool,
                                queryIndex,
                                panelIndex,
                                mappingId
                              )
                            )
                          }
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      <div>
        <h5 className="mb-2 text-sm font-semibold text-gray-900">
          Temporal rule
        </h5>
        <TemporalRuleEditor plan={plan} onChange={onChange} />
      </div>
    </div>
  );
}
