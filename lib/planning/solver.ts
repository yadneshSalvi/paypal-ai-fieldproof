import type { PlanDependency } from "./contracts";

export interface ScenarioPackage { id: string; title: string; costMinor: number | null; capabilities: string[]; available: boolean; }
export interface FundingPool { id: string; amountMinor: number; allowedPackageIds: string[]; }
export interface ScenarioSelection {
  packageIds: string[]; totalMinor: number; unspentMinor: number; capabilities: string[];
  assignments: { poolId: string; packageId: string; amountMinor: number }[];
}
export interface ScenarioResult {
  requested: { packageIds: string[]; closure: string[]; totalMinor: number | null; feasible: boolean; reasons: string[] };
  alternatives: ScenarioSelection[]; availableBudgetMinor: number;
  excluded: { packageId: string; reason: string }[]; evaluatedSelections: number;
  meaning: "budget_model_only";
}

export function prerequisiteClosure(ids: string[], packages: ScenarioPackage[], dependencies: Pick<PlanDependency, "packageId" | "prerequisiteId">[]): string[] {
  const known = new Set(packages.map(p => p.id)), seen = new Set<string>(), active = new Set<string>();
  const edges = new Map(packages.map(p => [p.id, dependencies.filter(d => d.packageId === p.id).map(d => d.prerequisiteId)]));
  if (known.size !== packages.length || dependencies.some(d => !known.has(d.packageId) || !known.has(d.prerequisiteId))) throw new Error("The package graph includes an unknown or repeated package.");
  const visit = (id: string) => {
    if (!known.has(id)) throw new Error("Choose packages from the current plan.");
    if (active.has(id)) throw new Error("The prerequisite graph contains a cycle.");
    if (seen.has(id)) return;
    active.add(id);
    for (const predecessor of edges.get(id) ?? []) visit(predecessor);
    active.delete(id); seen.add(id);
  };
  // Invalid unused branches are rejected too; the same graph feeds every scenario.
  for (const id of known) visit(id);
  seen.clear();
  for (const id of ids) visit(id);
  return [...seen].sort();
}

/** Integer-capacity max flow: restricted support can only cover its allowed packages. */
export function allocateScenarioFunds(selected: ScenarioPackage[], pools: FundingPool[]): ScenarioSelection["assignments"] | null {
  const total = selected.reduce((sum, p) => sum + (p.costMinor ?? 0), 0);
  if (selected.some(p => p.costMinor === null || !p.available)) return null;
  const count = 2 + pools.length + selected.length, source = count - 2, sink = count - 1;
  type Edge = { to: number; reverse: number; remaining: number; initial: number };
  const graph: Edge[][] = Array.from({ length: count }, () => []);
  const add = (from: number, to: number, capacity: number) => {
    const forward = { to, reverse: graph[to].length, remaining: capacity, initial: capacity }, reverse = { to: from, reverse: graph[from].length, remaining: 0, initial: 0 };
    graph[from].push(forward); graph[to].push(reverse); return forward;
  };
  const recorded: { poolId: string; packageId: string; edge: Edge }[] = [];
  for (let i = 0; i < pools.length; i++) {
    add(source, i, pools[i].amountMinor);
    for (let j = 0; j < selected.length; j++) if (pools[i].allowedPackageIds.includes(selected[j].id)) recorded.push({ poolId: pools[i].id, packageId: selected[j].id, edge: add(i, pools.length + j, total) });
  }
  selected.forEach((pkg, j) => add(pools.length + j, sink, pkg.costMinor!));
  let flow = 0;
  while (true) {
    const level = Array(count).fill(-1) as number[], queue = [source]; level[source] = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) for (const edge of graph[queue[cursor]]) if (edge.remaining > 0 && level[edge.to] === -1) { level[edge.to] = level[queue[cursor]] + 1; queue.push(edge.to); }
    if (level[sink] === -1) break;
    const next = Array(count).fill(0) as number[];
    const send = (vertex: number, capacity: number): number => {
      if (vertex === sink) return capacity;
      for (; next[vertex] < graph[vertex].length; next[vertex]++) {
        const edge = graph[vertex][next[vertex]];
        if (edge.remaining <= 0 || level[edge.to] !== level[vertex] + 1) continue;
        const amount = send(edge.to, Math.min(capacity, edge.remaining));
        if (amount > 0) { edge.remaining -= amount; graph[edge.to][edge.reverse].remaining += amount; return amount; }
      }
      return 0;
    };
    let sent: number; while ((sent = send(source, total)) > 0) flow += sent;
  }
  return flow === total ? recorded.filter(r => r.edge.initial > r.edge.remaining).map(r => ({ poolId: r.poolId, packageId: r.packageId, amountMinor: r.edge.initial - r.edge.remaining })) : null;
}

/** Exhaustive, deterministic closure search for the plan's bounded (20-package) schema.
 * Results describe a budget scenario. They never dispatch, reserve, or approve money. */
export function solveScenario(packages: ScenarioPackage[], dependencies: PlanDependency[], requestedIds: string[], pools: FundingPool[]): ScenarioResult {
  if (!packages.length || packages.length > 20) throw new Error("A scenario requires between one and twenty packages.");
  if (packages.some(p => p.costMinor !== null && (!Number.isSafeInteger(p.costMinor) || p.costMinor <= 0)) || pools.some(p => !Number.isSafeInteger(p.amountMinor) || p.amountMinor < 0)) throw new Error("Scenario amounts must be nonnegative integer minor units; unknown costs stay unknown.");
  if (new Set(pools.map(p => p.id)).size !== pools.length) throw new Error("Each funding pool needs a distinct identity.");
  const known = new Set(packages.map(p => p.id));
  if (pools.some(p => p.allowedPackageIds.some(id => !known.has(id)))) throw new Error("A restriction names a package outside this plan.");
  const budget = pools.reduce((sum, p) => sum + p.amountMinor, 0);
  if (!Number.isSafeInteger(budget)) throw new Error("The scenario budget is too large.");
  const sorted = [...packages].sort((a, b) => a.id.localeCompare(b.id));
  const closure = prerequisiteClosure(requestedIds, sorted, dependencies), requested = sorted.filter(p => closure.includes(p.id));
  const reasons: string[] = [];
  requested.filter(p => p.costMinor === null).forEach(p => reasons.push(`${p.title} has an unknown cost.`));
  requested.filter(p => !p.available).forEach(p => reasons.push(`${p.title} is unavailable.`));
  const requestedTotal = requested.some(p => p.costMinor === null) ? null : requested.reduce((sum, p) => sum + p.costMinor!, 0);
  if (requestedTotal !== null && requestedTotal > budget) reasons.push("The selected packages and all their prerequisites exceed this budget.");
  if (!reasons.length && allocateScenarioFunds(requested, pools) === null) reasons.push("The available support is restricted to different packages. It cannot be moved to make this scenario fit.");
  const index = new Map(sorted.map((p, i) => [p.id, i]));
  const closures = sorted.map(p => prerequisiteClosure([p.id], sorted, dependencies).reduce((mask, id) => mask | (1 << index.get(id)!), 0));
  const excluded = sorted.filter(p => p.costMinor === null || !p.available).map(p => ({ packageId: p.id, reason: p.costMinor === null ? "Cost needs a reviewed source." : "This package is unavailable." }));
  type Candidate = ScenarioSelection & { score: number; key: string };
  const best: Candidate[] = []; let evaluatedSelections = 0;
  const priority = new Set(requestedIds);
  const compare = (a: Candidate, b: Candidate) => b.score - a.score || b.capabilities.length - a.capabilities.length || b.packageIds.length - a.packageIds.length || a.totalMinor - b.totalMinor || a.key.localeCompare(b.key);
  for (let mask = 1; mask < 2 ** sorted.length; mask++) {
    const selected: ScenarioPackage[] = []; let total = 0, invalid = false;
    for (let i = 0; i < sorted.length; i++) if (mask & (1 << i)) {
      const pkg = sorted[i];
      if (!pkg.available || pkg.costMinor === null || (closures[i] & mask) !== closures[i]) { invalid = true; break; }
      total += pkg.costMinor; if (total > budget) { invalid = true; break; } selected.push(pkg);
    }
    if (invalid) continue;
    evaluatedSelections++;
    const ids = selected.map(p => p.id), capabilities = [...new Set(selected.flatMap(p => p.capabilities))].sort();
    const candidate: Candidate = { packageIds: ids, totalMinor: total, unspentMinor: budget - total, capabilities, assignments: [], score: selected.filter(p => priority.has(p.id)).length, key: ids.join("|") };
    if (best.length >= 3 && compare(candidate, best.at(-1)!) >= 0) continue;
    const assignment = allocateScenarioFunds(selected, pools); if (!assignment) continue;
    candidate.assignments = assignment; best.push(candidate); best.sort(compare); if (best.length > 3) best.pop();
  }
  return { requested: { packageIds: [...new Set(requestedIds)].sort(), closure, totalMinor: requestedTotal, feasible: reasons.length === 0, reasons },
    alternatives: best.map(({ score: _score, key: _key, ...value }) => value), availableBudgetMinor: budget, excluded, evaluatedSelections, meaning: "budget_model_only" };
}
