// Persistent selection cart for Step 3 SHRINE paths.
// Backed by localStorage so the cart survives navigation between /step3 and
// /step3/bundle and across browser reloads. Keyed by `path` (the descendant_path
// string is the natural unique ID).

"use client";

import { useCallback, useEffect, useState } from "react";
import type { ValueConstraint } from "@/lib/stage3/valueConstraint";
import type { Derivation } from "@/lib/stage3/derivation";

export interface SelectedPath {
  code: string;
  display: string;
  /**
   * The SHRINE term key — `\\<C_TABLE_CD>` + descendant_path — and the natural
   * unique ID for the selection set. The table prefix is what makes it unique:
   * a bare descendant_path only identifies a term within its own table.
   */
  path: string;
  /** i2b2 C_TABLE_CD of `path`, e.g. "ACT_MED_ALPHA_2018". */
  tableCd?: string;
  level: number;
  system: string;
  /** Source ENACT closure table, e.g. "tc_act_med_alpha_v41". */
  table: string;
  tier: number;
  similarity?: number;
  /** Concept name this path was selected for (for grouping in exports). */
  concept?: string;
  /** Step 2 category (diagnosis | medication | lab | …). */
  category?: string;
  /** Numeric/flag threshold captured for this concept at selection time. */
  valueConstraint?: ValueConstraint;
  /** Formula/derivation metadata when this concept is a computed measure. */
  derivation?: Derivation;
  /** ISO timestamp of when this row was added. */
  addedAt: string;
}

const STORAGE_KEY = "ace-app:step3-selection-v1";
const SETS_STORAGE_KEY = "ace-app:step3-sets-v1";

function read(): SelectedPath[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SelectedPath[]) : [];
  } catch {
    return [];
  }
}

function write(items: SelectedPath[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // quota or disabled storage — silent
  }
}

/** Module-level subscribers so multiple components stay in sync. */
const listeners = new Set<() => void>();
function notify() {
  for (const l of listeners) l();
}

const setsListeners = new Set<() => void>();
function notifySets() {
  for (const l of setsListeners) l();
}

export function useSelection() {
  // Initialize empty so SSR and first client paint agree. Real data loads in
  // the post-mount useEffect — avoids the "hydration failed" warning.
  const [items, setItems] = useState<SelectedPath[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setItems(read());
    setMounted(true);
    const refresh = () => setItems(read());
    listeners.add(refresh);
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const has = useCallback(
    (path: string) => items.some((i) => i.path === path),
    [items]
  );

  const add = useCallback((row: Omit<SelectedPath, "addedAt">) => {
    const current = read();
    if (current.some((i) => i.path === row.path)) return;
    const next = [...current, { ...row, addedAt: new Date().toISOString() }];
    write(next);
    notify();
  }, []);

  const remove = useCallback((path: string) => {
    const next = read().filter((i) => i.path !== path);
    write(next);
    notify();
  }, []);

  const toggle = useCallback(
    (row: Omit<SelectedPath, "addedAt">) => {
      if (read().some((i) => i.path === row.path)) remove(row.path);
      else add(row);
    },
    [add, remove]
  );

  const clear = useCallback(() => {
    write([]);
    notify();
  }, []);

  const replaceAll = useCallback((next: SelectedPath[]) => {
    write(next);
    notify();
  }, []);

  const addMany = useCallback((rows: Array<Omit<SelectedPath, "addedAt">>) => {
    const current = read();
    const seen = new Set(current.map((i) => i.path));
    const additions: SelectedPath[] = [];
    const stamp = new Date().toISOString();
    for (const r of rows) {
      if (seen.has(r.path)) continue;
      seen.add(r.path);
      additions.push({ ...r, addedAt: stamp });
    }
    if (additions.length === 0) return 0;
    write([...current, ...additions]);
    notify();
    return additions.length;
  }, []);

  return { items, mounted, has, add, addMany, remove, toggle, clear, replaceAll };
}

// ── Saved-sets library (named, persistent) ──────────────────────────────────
//
// A "set" is a named snapshot of selected paths the user wants to keep around
// across sessions. The cart holds the *current working* selection; sets are
// what they save out of it (e.g. "T2DM phenotype v1", "AFib exclusion set").

export interface ConceptSet {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  paths: SelectedPath[];
}

function readSets(): ConceptSet[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ConceptSet[]) : [];
  } catch {
    return [];
  }
}

function writeSets(sets: ConceptSet[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SETS_STORAGE_KEY, JSON.stringify(sets));
  } catch {
    // quota or disabled storage — silent
  }
}

export function useSets() {
  const [sets, setSets] = useState<ConceptSet[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setSets(readSets());
    setMounted(true);
    const refresh = () => setSets(readSets());
    setsListeners.add(refresh);
    const onStorage = (e: StorageEvent) => {
      if (e.key === SETS_STORAGE_KEY) refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      setsListeners.delete(refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const save = useCallback(
    (name: string, paths: SelectedPath[]): ConceptSet => {
      const now = new Date().toISOString();
      const set: ConceptSet = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: name.trim() || "untitled set",
        createdAt: now,
        updatedAt: now,
        paths: paths.map((p) => ({ ...p })),
      };
      const next = [...readSets(), set];
      writeSets(next);
      notifySets();
      return set;
    },
    []
  );

  const overwrite = useCallback(
    (id: string, paths: SelectedPath[]) => {
      const now = new Date().toISOString();
      const next = readSets().map((s) =>
        s.id === id ? { ...s, paths: paths.map((p) => ({ ...p })), updatedAt: now } : s
      );
      writeSets(next);
      notifySets();
    },
    []
  );

  const rename = useCallback((id: string, name: string) => {
    const now = new Date().toISOString();
    const next = readSets().map((s) =>
      s.id === id ? { ...s, name: name.trim() || s.name, updatedAt: now } : s
    );
    writeSets(next);
    notifySets();
  }, []);

  const remove = useCallback((id: string) => {
    const next = readSets().filter((s) => s.id !== id);
    writeSets(next);
    notifySets();
  }, []);

  return { sets, mounted, save, overwrite, rename, remove };
}

// ── Export helpers ─────────────────────────────────────────────────────────

/**
 * Collapse the selection to top-level paths only: if an ancestor's path is in
 * the set, any descendant whose path starts with it (treating `\` as the
 * separator) is dropped. SHRINE evaluates a path inclusively over its
 * subtree, so the descendants are implied — emitting both inflates the set
 * with no semantic gain.
 *
 * Returns items in their original order, minus the collapsed descendants.
 */
export function collapseToTopPaths(items: SelectedPath[]): SelectedPath[] {
  if (items.length < 2) return items;
  // Sort by path length ascending so ancestors are seen before their descendants.
  const sorted = [...items].sort((a, b) => a.path.length - b.path.length);
  const kept: SelectedPath[] = [];
  for (const it of sorted) {
    const isDescendantOfKept = kept.some(
      (k) =>
        // Same path is a no-op (dedup is upstream), but be safe.
        it.path !== k.path &&
        it.path.startsWith(k.path.endsWith("\\") ? k.path : k.path + "\\")
    );
    if (!isDescendantOfKept) kept.push(it);
  }
  // Restore original ordering for stable display.
  const keepSet = new Set(kept.map((k) => k.path));
  return items.filter((i) => keepSet.has(i.path));
}

export function toJson(items: SelectedPath[]): string {
  const top = collapseToTopPaths(items);
  return JSON.stringify(
    {
      version: "step3-selection-v1",
      exportedAt: new Date().toISOString(),
      count: top.length,
      paths: top,
    },
    null,
    2
  );
}

/**
 * Serialize the selection into the "ontology mappings" shape Step 4 (the Query
 * Logic Builder agent) consumes — see ontologyMappingAgent / queryLogicAgent in
 * src/lib/agents.ts.
 *
 * Selected paths are grouped by concept (+category) into ONE mapping row each —
 * a "concept set" / OR group: when a concept has several selected paths they
 * become multiple `codes`, and Step 4/5 treat them as "match any of these".
 * Each code keeps its own `shrineOntologyPath` (termPath) so Step 5 can build a
 * Concept node per code; the row-level `shrineOntologyPath` mirrors the first
 * (preferred) path for single-path consumers. These are user-curated
 * selections, so mappingConfidence is "high".
 */
export function toStep4Json(items: SelectedPath[]): string {
  const top = collapseToTopPaths(items);

  // Group by category+concept, preserving first-seen order.
  const order: string[] = [];
  const groups = new Map<
    string,
    { concept: string; category: string; rows: SelectedPath[] }
  >();
  for (const p of top) {
    const concept = p.concept ?? "";
    const category = p.category ?? "";
    const key = `${category} ${concept}`;
    let g = groups.get(key);
    if (!g) {
      g = { concept, category, rows: [] };
      groups.set(key, g);
      order.push(key);
    }
    g.rows.push(p);
  }

  const mappings = order.map((key) => {
    const g = groups.get(key)!;
    // The constraint / derivation are properties of the concept, not of an
    // individual path — take the first one any selected path carried.
    const valueConstraint = g.rows.find((r) => r.valueConstraint)?.valueConstraint;
    const derivation = g.rows.find((r) => r.derivation?.isDerived)?.derivation;
    return {
      concept: g.concept,
      category: g.category,
      codes: g.rows.map((r) => ({
        system: r.system,
        code: r.code,
        display: r.display,
        shrineOntologyPath: r.path,
      })),
      shrineOntologyPath: g.rows[0].path,
      ...(g.rows[0].tableCd
        ? { shrineOntologyTableCd: g.rows[0].tableCd }
        : {}),
      ...(valueConstraint ? { valueConstraint } : {}),
      ...(derivation ? { derivation } : {}),
      notes:
        g.rows.length === 1
          ? `User-selected in Step 3 (tier ${g.rows[0].tier}` +
            (g.rows[0].similarity != null
              ? `, jaro_winkler=${g.rows[0].similarity.toFixed(3)}`
              : "") +
            `, table ${g.rows[0].table}).`
          : `User-selected ${g.rows.length} SHRINE paths in Step 3 (OR group — match any).`,
    };
  });

  return JSON.stringify(
    {
      mappings,
      unmappedConcepts: [],
      mappingConfidence: "high",
      mappingNotes: `User-curated ${top.length} SHRINE path(s) across ${mappings.length} concept(s), selected in Step 3.`,
    },
    null,
    2
  );
}

export function toCsv(items: SelectedPath[]): string {
  const top = collapseToTopPaths(items);
  const cols: Array<keyof SelectedPath> = [
    "concept",
    "category",
    "system",
    "code",
    "display",
    "path",
    "tableCd",
    "level",
    "tier",
    "similarity",
    "table",
    "addedAt",
  ];
  const escape = (v: unknown) => {
    if (v == null) return "";
    const s = String(v);
    if (s.includes(",") || s.includes("\"") || s.includes("\n"))
      return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = cols.join(",");
  const rows = top.map((it) => cols.map((c) => escape(it[c])).join(","));
  return [header, ...rows].join("\n");
}

export function toPlainPaths(items: SelectedPath[]): string {
  return collapseToTopPaths(items)
    .map((i) => i.path)
    .join("\n");
}
