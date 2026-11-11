import type { PlanVersionView, ProposedPlan } from "@/lib/planning/contracts";
export interface DraftState {
  plan: ProposedPlan | null; past: ProposedPlan[]; future: ProposedPlan[]; dirty: boolean;
  baseVersion: number; basePlanId: string | null; origin: PlanVersionView["origin"]; sourceRunId: string | null;
}
export type DraftAction = { type: "load"; plan: ProposedPlan | null; version: number; planId: string | null; origin: DraftState["origin"]; sourceRunId?: string | null; dirty?: boolean }
  | { type: "edit"; update: (plan: ProposedPlan) => ProposedPlan; checkpoint: boolean } | { type: "checkpoint" | "undo" | "redo" };
export function initialDraft(version: PlanVersionView | null, headVersion: number): DraftState {
  return { plan: version?.plan ?? null, past: [], future: [], dirty: false, baseVersion: headVersion, basePlanId: version?.id ?? null, origin: version?.origin ?? "manual", sourceRunId: version?.sourceRunId ?? null };
}
export function draftReducer(state: DraftState, action: DraftAction): DraftState {
  if (action.type === "load") return { plan: action.plan, past: [], future: [], dirty: action.dirty ?? false, baseVersion: action.version, basePlanId: action.planId, origin: action.origin, sourceRunId: action.sourceRunId ?? null };
  if (!state.plan) return state;
  if (action.type === "checkpoint") return { ...state, past: [...state.past.slice(-39), state.plan], future: [] };
  if (action.type === "edit") {
    const next = action.update(state.plan); if (JSON.stringify(next) === JSON.stringify(state.plan)) return state;
    return { ...state, plan: next, dirty: true, origin: state.origin === "model" ? "manual" : state.origin, past: action.checkpoint ? [...state.past.slice(-39), state.plan] : state.past, future: [] };
  }
  if (action.type === "undo" && state.past.length) return { ...state, plan: state.past.at(-1)!, past: state.past.slice(0, -1), future: [state.plan, ...state.future.slice(0, 39)], dirty: true, origin: state.origin === "model" ? "manual" : state.origin };
  if (action.type === "redo" && state.future.length) return { ...state, plan: state.future[0], past: [...state.past.slice(-39), state.plan], future: state.future.slice(1), dirty: true, origin: state.origin === "model" ? "manual" : state.origin };
  return state;
}
