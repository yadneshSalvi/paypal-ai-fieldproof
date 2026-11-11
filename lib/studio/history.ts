import type { AgReportHistory, AgReportState } from "ag-studio";
import { z } from "zod";

export const STUDIO_WIDGET_IDS = ["fieldproof-blueprint", "fieldproof-rings", "fieldproof-allocation", "fieldproof-evidence", "fieldproof-matrix", "fieldproof-exceptions"] as const;
const record = z.record(z.string(), z.unknown());
const stateSchema = z.object({
  pages: z.array(z.object({ id: z.string().min(1).max(100), widgets: record.optional(), widgetLayout: record.optional(),
    layout: record.optional(), filter: record.optional(), crossFilter: record.optional(), selection: record.optional(),
  }).strict()).min(1).max(30), selectedPageId: z.string().min(1).max(100), panels: record.optional(), schema: record.optional(), version: z.string().max(30).optional(),
}).strict();
const entrySchema = z.object({
  id: z.string().min(1).max(160), state: stateSchema, label: z.string().max(500), labelKey: z.string().min(1).max(200),
  labelVariableValues: record.optional(), at: z.number().int().nonnegative(), focus: record.optional(), source: record,
}).strict();
const historySchema = z.object({ type: z.literal("AgReportHistory"), current: stateSchema, undo: z.array(entrySchema).max(500), redo: z.array(entrySchema).max(500) }).strict();

/** Preserve all native undo/redo entries; reject malformed state rather than silently saving only current. */
export function validateStudioHistory(value: unknown): AgReportHistory {
  const parsed = historySchema.parse(value);
  if (JSON.stringify(parsed).length > 3_000_000) throw new Error("This report history exceeds the private report size limit.");
  function inspect(item: unknown, depth = 0): void {
    if (depth > 35) throw new Error("The report contains an invalid nested value.");
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("The report contains an invalid number.");
    if (typeof item === "string" && (item.length > 16000 || /^(?:https?:|data:|javascript:|file:|blob:)/i.test(item.trim()))) throw new Error("External content is not available in this private report.");
    if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("The report contains an invalid property.");
      inspect(child, depth + 1);
    }
  }
  inspect(parsed);
  for (const state of [parsed.current, ...parsed.undo.map(entry => entry.state), ...parsed.redo.map(entry => entry.state)]) {
    if (!state.pages.some(page => page.id === state.selectedPageId) || new Set(state.pages.map(page => page.id)).size !== state.pages.length) throw new Error("The selected report page is missing or repeated.");
    for (const page of state.pages) {
      if (Object.keys(page.widgets ?? {}).length > 100) throw new Error("This report page contains too many widgets.");
      for (const widget of Object.values(page.widgets ?? {})) {
        if (!widget || typeof widget !== "object" || !("type" in widget) || ![...STUDIO_WIDGET_IDS, "grid", "value"].includes(String(widget.type))) throw new Error("This widget is not enabled for Fieldproof reports.");
      }
    }
  }
  return parsed as unknown as AgReportHistory;
}

/**
 * Decide when to auto-save, never what to save. AG 3.1 marks panels, the selected
 * page and each page's widget selection as ephemeral. Hydration and panel changes
 * must not compete with another tab's report edits. History entries still count:
 * clearing or moving a stack can leave the current report itself unchanged.
 */
export function studioDurableHistorySignature(history: AgReportHistory): string {
  const durableState = (state: AgReportState) => {
    const { panels: _panels, selectedPageId: _selectedPageId, ...report } = state;
    return { ...report, pages: state.pages.map(({ selection: _selection, ...page }) => page) };
  };
  const durable = {
    ...history, current: durableState(history.current),
    undo: history.undo.map(entry => ({ ...entry, state: durableState(entry.state) })),
    redo: history.redo.map(entry => ({ ...entry, state: durableState(entry.state) })),
  };
  // Serialization order and absent optional values may differ after native
  // hydration. Keep array order and every durable field/entry intact.
  return JSON.stringify(durable, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}
export function reportHistorySummary(history: AgReportHistory) {
  const widgets = history.current.pages.flatMap(page => Object.entries(page.widgets ?? {}).map(([id, widget]) => ({ id, pageId: page.id, type: widget?.type ?? "unknown" })));
  const latest = history.undo.at(-1);
  return { pages: history.current.pages.length, widgets, undo: history.undo.length, redo: history.redo.length,
    latest: latest ? { id: latest.id, label: latest.label, labelKey: latest.labelKey, at: latest.at, source: latest.source } : null,
    provenance: "client_observed_layout" as const };
}
export interface StudioReportRecord {
  revision: number; history: AgReportHistory | null; savedAt: string | null;
  audit: { revision: number; savedAt: string; label: string; undo: number; redo: number; provenance: "client_observed_layout" }[];
}
export type StudioInitialState = AgReportState | AgReportHistory;
