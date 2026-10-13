// Saved concept-sets library for Step 3. Always-visible panel that lists
// the user's named sets (persisted in localStorage). Each row can be Loaded
// (replaces the cart), Appended (merges into the cart), Renamed, or Deleted.

"use client";

import { useState } from "react";
import {
  useSelection,
  useSets,
  toJson,
  toCsv,
  toPlainPaths,
  type ConceptSet,
} from "@/lib/selection/useSelection";

export function SavedSetsLibrary() {
  const { sets, mounted, rename, remove } = useSets();
  const { replaceAll, addMany, items: cartItems } = useSelection();
  const [collapsed, setCollapsed] = useState(false);

  if (!mounted) return null;

  return (
    <section
      id="concept-set-library"
      className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-gray-200 scroll-mt-6"
    >
      <div className="flex items-baseline justify-between">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-baseline gap-2 text-left"
        >
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">
            Concept set library
          </h2>
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
            {sets.length} saved
          </span>
          <span className="text-xs text-gray-400">
            {collapsed ? "▸ show" : "▾ hide"}
          </span>
        </button>
        <span className="text-xs text-gray-500">
          {cartItems.length} in current cart
        </span>
      </div>

      {!collapsed && (
        <>
          {sets.length === 0 ? (
            <div className="mt-3 rounded-md border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
              No saved sets yet. Select paths from the search results, then use{" "}
              <span className="font-semibold">Save to library</span> in the
              cart panel (bottom-right) to keep them under a name.
            </div>
          ) : (
            <ul className="mt-3 space-y-2">
              {sets
                .slice()
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                .map((set) => (
                  <SetRow
                    key={set.id}
                    set={set}
                    cartCount={cartItems.length}
                    onLoad={() => replaceAll(set.paths)}
                    onAppend={() => addMany(set.paths)}
                    onRename={(newName) => rename(set.id, newName)}
                    onDelete={() => remove(set.id)}
                  />
                ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function SetRow({
  set,
  cartCount,
  onLoad,
  onAppend,
  onRename,
  onDelete,
}: {
  set: ConceptSet;
  cartCount: number;
  onLoad: () => void;
  /** Performs the append and returns how many new paths were added. */
  onAppend: () => number;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(set.name);
  // Inline two-step confirms (webview-safe — no native confirm/alert).
  const [confirmLoad, setConfirmLoad] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [appendMsg, setAppendMsg] = useState<string | null>(null);

  function handleLoad() {
    if (cartCount > 0 && !confirmLoad) {
      setConfirmLoad(true);
      setTimeout(() => setConfirmLoad(false), 3000);
      return;
    }
    onLoad();
    setConfirmLoad(false);
  }

  function handleAppend() {
    const added = onAppend();
    setAppendMsg(
      `+${added} new${set.paths.length - added > 0 ? `, ${set.paths.length - added} dupe${set.paths.length - added === 1 ? "" : "s"}` : ""}`
    );
    setTimeout(() => setAppendMsg(null), 3000);
  }

  function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    onDelete();
  }

  function exportSet(fmt: "json" | "csv" | "paths") {
    const stamp = Date.now();
    const safeName = set.name.replace(/[^\w.-]+/g, "_").slice(0, 60) || "set";
    if (fmt === "paths") {
      navigator.clipboard?.writeText(toPlainPaths(set.paths)).catch(() => {});
      return;
    }
    const mime = fmt === "json" ? "application/json" : "text/csv";
    const ext = fmt === "json" ? "json" : "csv";
    const content =
      fmt === "json" ? toJson(set.paths) : toCsv(set.paths);
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `step3-${safeName}-${stamp}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <li className="rounded-md border border-gray-200 bg-gray-50/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {editing ? (
          <input
            type="text"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onRename(draftName);
                setEditing(false);
              } else if (e.key === "Escape") {
                setDraftName(set.name);
                setEditing(false);
              }
            }}
            onBlur={() => {
              onRename(draftName);
              setEditing(false);
            }}
            autoFocus
            className="rounded border-0 px-2 py-0.5 text-sm font-medium text-gray-900 ring-1 ring-inset ring-emerald-300 focus:ring-2 focus:ring-emerald-500"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-left text-sm font-medium text-gray-900 hover:text-emerald-700"
            title="click to rename"
          >
            {set.name}
          </button>
        )}
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
          {set.paths.length} paths
        </span>
        <span className="text-[10px] text-gray-500">
          updated {timeAgo(set.updatedAt)}
        </span>

        <div className="ml-auto flex items-center gap-1">
          {appendMsg && (
            <span className="text-[10px] font-medium text-emerald-700">
              {appendMsg}
            </span>
          )}
          <button
            type="button"
            onClick={handleLoad}
            className={`rounded px-2 py-1 text-xs font-medium text-white ${
              confirmLoad
                ? "bg-red-600 hover:bg-red-500"
                : "bg-emerald-600 hover:bg-emerald-500"
            }`}
            title={
              cartCount > 0
                ? `replace ${cartCount} cart paths with this set`
                : "load this set into the cart"
            }
          >
            {confirmLoad ? "replace cart?" : "load"}
          </button>
          <button
            type="button"
            onClick={handleAppend}
            className="rounded bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100"
            title="add to current cart (skips duplicates)"
          >
            + append
          </button>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-600 hover:bg-gray-200"
          >
            {open ? "hide" : "show"}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className={`rounded px-2 py-1 text-xs ${
              confirmDelete
                ? "bg-red-600 font-semibold text-white hover:bg-red-500"
                : "text-gray-400 hover:bg-red-50 hover:text-red-600"
            }`}
            aria-label="delete"
            title={confirmDelete ? "click again to delete" : "delete this saved set"}
          >
            {confirmDelete ? "delete?" : "✕"}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3 space-y-2">
          <ul className="max-h-64 overflow-y-auto space-y-1 rounded border border-gray-200 bg-white p-2">
            {set.paths.map((p, i) => (
              <li key={i} className="text-xs">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-800 ring-1 ring-emerald-200">
                    {p.system}: {p.code}
                  </span>
                  <span className="text-gray-700">{p.display}</span>
                  {p.concept && (
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">
                      {p.concept}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 break-all font-mono text-[10px] text-gray-500">
                  {p.path}
                </div>
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2 text-xs">
            <button
              type="button"
              onClick={() => exportSet("paths")}
              className="rounded bg-gray-100 px-2 py-1 hover:bg-gray-200"
            >
              copy paths
            </button>
            <button
              type="button"
              onClick={() => exportSet("json")}
              className="rounded bg-gray-100 px-2 py-1 hover:bg-gray-200"
            >
              ⬇ JSON
            </button>
            <button
              type="button"
              onClick={() => exportSet("csv")}
              className="rounded bg-gray-100 px-2 py-1 hover:bg-gray-200"
            >
              ⬇ CSV
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
