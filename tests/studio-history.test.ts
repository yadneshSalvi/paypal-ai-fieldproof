import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgReportHistory, AgReportState } from "ag-studio";
import { studioDurableHistorySignature, validateStudioHistory } from "../lib/studio/history";

function state(): AgReportState {
  return { version: "3.1.0", selectedPageId: "board", panels: { ai: { collapsed: false, width: 360 } }, pages: [
    { id: "board", widgets: { evidence: { type: "fieldproof-evidence", format: { title: { text: "Evidence for review", enabled: true } }, dataMapping: {} } },
      widgetLayout: { evidence: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 10 } } },
    { id: "appendix", widgets: {} },
  ] } as unknown as AgReportState;
}
function history(): AgReportHistory {
  const before = state(), current = state();
  current.pages[0].widgetLayout!.evidence!.xSpan = 14;
  return { type: "AgReportHistory", current, undo: [{ id: "native-edit-1", label: "Resize widget", labelKey: "historyResizeWidget", at: 1794370000000,
    source: { type: "ui" }, focus: { selectedPageId: "board", pageSelection: { type: "widget", id: "evidence" } }, state: before }], redo: [] } as unknown as AgReportHistory;
}
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]));
  return value;
}

describe("Studio durable auto-save boundary", () => {
  it("does not treat restored panels, page selection or widget selection as a new edit", () => {
    const saved = history(), hydrated = structuredClone(saved);
    for (const item of [hydrated.current, ...hydrated.undo.map(entry => entry.state)]) {
      item.panels = { ai: { collapsed: true, width: 250 }, data: { collapsed: false }, edit: { collapsed: false } };
      item.selectedPageId = "appendix";
      item.pages[0].selection = { type: "widget", id: "evidence" };
    }
    assert.equal(studioDurableHistorySignature(hydrated), studioDurableHistorySignature(saved));
    assert.deepEqual(validateStudioHistory(hydrated), hydrated, "an explicit save still preserves the complete native view state");
    assert.notDeepEqual(hydrated, saved);
  });
  it("ignores property order and undefined optional values introduced by hydration", () => {
    const saved = history(), hydrated = reverseKeys(saved) as AgReportHistory;
    hydrated.current.schema = undefined;
    hydrated.undo[0].labelVariableValues = undefined;
    assert.equal(studioDurableHistorySignature(hydrated), studioDurableHistorySignature(saved));
  });
  it("detects real widget, geometry, cross-filter and schema changes without relying on event flags", () => {
    const saved = history(), signature = studioDurableHistorySignature(saved);
    const title = structuredClone(saved);
    (title.current.pages[0].widgets!.evidence as unknown as { format: { title: { text: string } } }).format.title.text = "Evidence for our next review";
    const geometry = structuredClone(saved); geometry.current.pages[0].widgetLayout!.evidence!.xTrack = 10;
    const filter = structuredClone(saved); filter.current.pages[0].crossFilter = { "packages.packageId": { values: ["electronics"] } } as never;
    const schema = structuredClone(saved); schema.current.schema = { fields: { "packages.budgetMinor": { name: "Reviewed budget" } } } as never;
    for (const changed of [title, geometry, filter, schema]) assert.notEqual(studioDurableHistorySignature(changed), signature);
  });
  it("detects stack-only changes, including clear history and restored redo entries", () => {
    const saved = history(), signature = studioDurableHistorySignature(saved);
    const cleared = structuredClone(saved); cleared.undo = [];
    const restoredRedo = structuredClone(saved); restoredRedo.redo = [restoredRedo.undo.pop()!];
    const differentPast = structuredClone(saved); differentPast.undo[0].state.pages[0].widgetLayout!.evidence!.xSpan = 10;
    const differentSource = structuredClone(saved); differentSource.undo[0].source = { type: "ai", agentId: "widget", runId: "controlled-run" } as never;
    for (const changed of [cleared, restoredRedo, differentPast, differentSource]) {
      assert.deepEqual(changed.current, saved.current);
      assert.notEqual(studioDurableHistorySignature(changed), signature);
    }
  });
  it("leaves the saved native history, all entry metadata and array order untouched", () => {
    const saved = history(), before = structuredClone(saved);
    const signature = studioDurableHistorySignature(saved);
    assert.deepEqual(saved, before);
    const reordered = structuredClone(saved); reordered.current.pages.reverse();
    assert.notEqual(studioDurableHistorySignature(reordered), signature);
    const metadata = structuredClone(saved); metadata.undo[0].label = "A different recorded action";
    assert.notEqual(studioDurableHistorySignature(metadata), signature);
  });
});
