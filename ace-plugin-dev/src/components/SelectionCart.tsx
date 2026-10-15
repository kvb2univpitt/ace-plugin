// Floating selection cart for Step 3. Sticks to the bottom-right; expands
// on click to show selected rows and export options. Persists via useSelection
// (localStorage) so the cart works across /step3 and /step3/bundle.
//
// The cart shows the *collapsed* set (top-paths only via collapseToTopPaths):
// descendants of selected ancestors are folded away because SHRINE includes
// the whole subtree when you query a parent path. Rows are grouped by
// category so a phenotype set is easy to scan at a glance.

"use client";

import { useMemo, useState } from "react";
import {
  useSelection,
  useSets,
  toJson,
  toCsv,
  toPlainPaths,
  toStep4Json,
  collapseToTopPaths,
  type SelectedPath,
} from "@/lib/selection/useSelection";
import { formatValueConstraint } from "@/lib/ontology/valueConstraint";
import { summarizeDerivation } from "@/lib/ontology/derivation";

type PreviewKind = "paths" | "json" | "csv" | "step4";

const PREVIEW_LABEL: Record<PreviewKind, string> = {
  paths: "paths",
  json: "json",
  csv: "csv",
  step4: "step 4",
};

const CATEGORY_PILL: Record<string, string> = {
  diagnosis: "bg-blue-100 text-blue-800 ring-blue-200",
  medication: "bg-emerald-100 text-emerald-800 ring-emerald-200",
  lab: "bg-amber-100 text-amber-800 ring-amber-200",
  procedure: "bg-violet-100 text-violet-800 ring-violet-200",
  demographic: "bg-stone-100 text-stone-800 ring-stone-200",
  vaccine: "bg-rose-100 text-rose-800 ring-rose-200",
  vital_sign: "bg-sky-100 text-sky-800 ring-sky-200",
  visit_detail: "bg-fuchsia-100 text-fuchsia-800 ring-fuchsia-200",
};

const SYSTEM_PILL: Record<string, string> = {
  PheCode: "bg-emerald-700 text-white ring-emerald-800",
  Elixhauser: "bg-emerald-600 text-white ring-emerald-700",
  Charlson: "bg-emerald-600 text-white ring-emerald-700",
};

function pillForCategory(cat?: string): string {
  return CATEGORY_PILL[cat ?? ""] ?? "bg-gray-100 text-gray-700 ring-gray-200";
}

function pillForSystem(sys: string): string {
  return SYSTEM_PILL[sys] ?? "bg-gray-700 text-white ring-gray-800";
}

export function SelectionCart() {
  const { items, mounted, remove, clear } = useSelection();
  const { save } = useSets();
  const [open, setOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [preview, setPreview] = useState<PreviewKind>("paths");
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  // Two-step inline confirm for "clear all" — native confirm() is unreliable
  // in embedded webviews (returns false / no dialog), which silently swallowed
  // the clear. Arms on first click, clears on the second.
  const [confirmingClear, setConfirmingClear] = useState(false);

  // Cart shows the collapsed list (descendants of selected ancestors are
  // implied by SHRINE's subtree semantics; explicit ticks of those
  // descendants stay in localStorage but are hidden from view).
  const collapsed = useMemo(() => collapseToTopPaths(items), [items]);
  const impliedCount = items.length - collapsed.length;
  const grouped = useMemo(() => groupByCategoryThenConcept(collapsed), [collapsed]);

  const count = collapsed.length;
  const totalSelected = items.length;

  const previewContent = useMemo(() => {
    if (preview === "paths") return toPlainPaths(items);
    if (preview === "json") return toJson(items);
    if (preview === "step4") return toStep4Json(items);
    return toCsv(items);
  }, [items, preview]);

  function flash(msg: string, err = false) {
    setToast({ msg, err });
    setTimeout(() => setToast(null), 2000);
  }

  function download(filename: string, mime: string, content: string) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard?.writeText(text).then(
      () => flash(`copied ${label} to clipboard`),
      () => flash(`copy failed`, true)
    );
  }

  if (!mounted) return null;

  return (
    <>
      {toast && (
        <div
          className={`fixed bottom-24 right-6 z-[60] rounded-md px-3 py-2 text-sm shadow-lg ring-1 ${
            toast.err
              ? "bg-red-50 text-red-700 ring-red-200"
              : "bg-gray-900 text-white ring-gray-700"
          }`}
        >
          {toast.msg}
        </div>
      )}

      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-full bg-emerald-600 px-5 py-3 text-sm font-medium text-white shadow-xl ring-1 ring-emerald-700/50 hover:bg-emerald-500"
        >
          <svg
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293A1 1 0 005.414 17H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z"
            />
          </svg>
          Selected paths
          <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs font-bold">
            {count}
          </span>
        </button>
      )}

      {open && (
        <div className="fixed bottom-6 right-6 z-50 flex max-h-[85vh] w-[min(640px,calc(100vw-3rem))] flex-col rounded-xl bg-white shadow-2xl ring-1 ring-gray-200">
          <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
            <div className="flex items-baseline gap-2">
              <h3 className="text-sm font-semibold text-gray-900">
                Selected paths
              </h3>
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-700">
                {count}
              </span>
              {impliedCount > 0 && (
                <span
                  className="text-[10px] text-gray-500"
                  title={`${impliedCount} descendant path(s) you ticked are folded under selected ancestors`}
                >
                  · {impliedCount} implied
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (totalSelected === 0) return;
                  if (!confirmingClear) {
                    setConfirmingClear(true);
                    setTimeout(() => setConfirmingClear(false), 3000);
                    return;
                  }
                  const n = totalSelected;
                  clear();
                  setConfirmingClear(false);
                  flash(`cleared ${n} selected path${n === 1 ? "" : "s"}`);
                }}
                disabled={totalSelected === 0}
                className={`text-xs disabled:opacity-40 ${
                  confirmingClear
                    ? "font-semibold text-red-600"
                    : "text-gray-500 hover:text-red-600"
                }`}
                title={
                  confirmingClear
                    ? "click again to remove all selected paths"
                    : "clear the whole selection"
                }
              >
                {confirmingClear ? "confirm clear all?" : "clear all"}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-gray-400 hover:text-gray-700"
                aria-label="close"
              >
                ✕
              </button>
            </div>
          </div>

          {count === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-gray-500">
              No paths selected yet. Tick the checkboxes on result rows to add
              paths to the cart.
            </div>
          ) : (
            <ul className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {grouped.map(([category, byConcept]) => (
                <li key={category || "(uncategorized)"}>
                  <div className="mb-1.5 flex items-baseline gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ${pillForCategory(category)}`}
                    >
                      {category || "uncategorized"}
                    </span>
                    <span className="text-[10px] text-gray-500">
                      {countLeaves(byConcept)} path
                      {countLeaves(byConcept) === 1 ? "" : "s"}
                    </span>
                  </div>
                  <ul className="space-y-2">
                    {byConcept.map(([concept, rows]) => (
                      <li key={concept || "(unnamed)"}>
                        <div className="mb-0.5 text-[11px] font-semibold text-gray-700">
                          {concept || "(unnamed concept)"}
                        </div>
                        <ul className="space-y-1">
                          {rows.map((r) => (
                            <li
                              key={r.path}
                              className="group flex items-start gap-2 rounded-md bg-gray-50 px-2 py-1.5 ring-1 ring-gray-200"
                            >
                              <div className="flex-1 min-w-0">
                                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                                  <span
                                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] ring-1 ${pillForSystem(r.system)}`}
                                  >
                                    {r.system}
                                  </span>
                                  <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-800 ring-1 ring-emerald-200">
                                    {r.code}
                                  </span>
                                  {r.valueConstraint && (
                                    <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-800 ring-1 ring-amber-200">
                                      {formatValueConstraint(r.valueConstraint)}
                                    </span>
                                  )}
                                  {r.derivation?.isDerived && (
                                    <span
                                      className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-800 ring-1 ring-sky-200"
                                      title={summarizeDerivation(r.derivation)}
                                    >
                                      🧮 derived
                                    </span>
                                  )}
                                  <span className="text-gray-700">{r.display}</span>
                                </div>
                                <div className="mt-0.5 break-all font-mono text-[10px] text-gray-500">
                                  {r.path}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => remove(r.path)}
                                className="text-gray-400 opacity-0 transition group-hover:opacity-100 hover:text-red-600"
                                aria-label="remove"
                                title="remove from selection"
                              >
                                ✕
                              </button>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}

          {count > 0 && (
            <div className="space-y-3 border-t border-gray-200 p-3">
              {/* Inline preview — exactly what `Export → ⬇ JSON / CSV` writes. */}
              <div className="rounded-md bg-gray-900/95 text-gray-100">
                <div className="flex items-center justify-between gap-2 border-b border-gray-700 px-3 py-1.5">
                  <div className="flex items-center gap-1">
                    {(["paths", "json", "csv", "step4"] as PreviewKind[]).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setPreview(k)}
                        className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition ${
                          preview === k
                            ? "bg-emerald-500 text-white"
                            : "text-gray-300 hover:bg-gray-800 hover:text-white"
                        }`}
                      >
                        {PREVIEW_LABEL[k]}
                      </button>
                    ))}
                    <span className="ml-2 text-[10px] text-gray-400">
                      {preview === "step4"
                        ? "Step 4 mappings format"
                        : "top paths only"}{" "}
                      · {count} row{count === 1 ? "" : "s"}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      copyToClipboard(previewContent, PREVIEW_LABEL[preview])
                    }
                    className="rounded bg-emerald-500 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-emerald-400"
                    title={
                      preview === "step4"
                        ? "copy the Step 4 ontology-mappings JSON to clipboard"
                        : `copy this ${preview} to clipboard`
                    }
                  >
                    ⧉ copy
                  </button>
                </div>
                <pre className="max-h-48 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
                  {previewContent}
                </pre>
              </div>

              {/* Save as named set (in-app library) */}
              <div className="rounded-md bg-emerald-50/60 p-2 ring-1 ring-emerald-200">
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                  Save to library
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    type="text"
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && saveName.trim()) {
                        save(saveName.trim(), items);
                        flash(`saved "${saveName.trim()}" (${count} paths)`);
                        setSaveName("");
                      }
                    }}
                    placeholder="set name, e.g. T2DM phenotype v1"
                    className="flex-1 rounded border-0 px-2 py-1 text-xs text-gray-900 ring-1 ring-inset ring-gray-300 focus:ring-2 focus:ring-emerald-500"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (!saveName.trim()) return;
                      save(saveName.trim(), items);
                      flash(`saved "${saveName.trim()}" (${count} paths)`);
                      setSaveName("");
                    }}
                    disabled={!saveName.trim()}
                    className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    save
                  </button>
                </div>
                <p className="mt-1 text-[10px] text-emerald-700/80">
                  Saved sets appear in the library above; they persist across
                  reloads and survive cart edits.
                </p>
              </div>

              {/* Download / next step */}
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  Export &amp; next
                </label>
                <div className="mt-1 grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      download(
                        `step3-selection-${Date.now()}.json`,
                        "application/json",
                        toJson(items)
                      )
                    }
                    className="rounded-md bg-gray-100 px-2 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-200"
                  >
                    ⬇ JSON
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      download(
                        `step3-selection-${Date.now()}.csv`,
                        "text/csv",
                        toCsv(items)
                      )
                    }
                    className="rounded-md bg-gray-100 px-2 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-200"
                  >
                    ⬇ CSV
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      copyToClipboard(toStep4Json(items), "Step 4 mappings")
                    }
                    className="rounded-md bg-emerald-600 px-2 py-1.5 text-center text-xs font-medium text-white hover:bg-emerald-500"
                    title="copy the Step 4 ontology-mappings JSON to clipboard (paste into the Query Logic Builder)"
                  >
                    ⧉ Step 4 JSON
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

function groupByCategoryThenConcept(
  items: SelectedPath[]
): Array<[string, Array<[string, SelectedPath[]]>]> {
  const byCat = new Map<string, Map<string, SelectedPath[]>>();
  for (const it of items) {
    const cat = it.category ?? "";
    const concept = it.concept ?? "";
    const conceptMap = byCat.get(cat) ?? new Map<string, SelectedPath[]>();
    const list = conceptMap.get(concept) ?? [];
    list.push(it);
    conceptMap.set(concept, list);
    byCat.set(cat, conceptMap);
  }
  return Array.from(byCat.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cat, conceptMap]) => [
      cat,
      Array.from(conceptMap.entries()).sort(([a], [b]) => a.localeCompare(b)),
    ]);
}

function countLeaves(byConcept: Array<[string, SelectedPath[]]>): number {
  return byConcept.reduce((sum, [, rows]) => sum + rows.length, 0);
}
