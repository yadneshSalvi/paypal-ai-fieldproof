import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { defaultRequirements, proposedPlanSchema, type PlanDependency, type PlanPackageBinding, type PlanSourceBinding, type ProposedPlan } from "../lib/planning/contracts";
import { moveVertex, pointInPolygon, polygonErrors, polygonInside, polygonLabel, polygonsOverlap, scaleLabel, solveAffine, transformPoint, validatePlan } from "../lib/planning/geometry";
import { samplePlan } from "../lib/planning/templates";
import { allocateScenarioFunds, prerequisiteClosure, solveScenario, type ScenarioPackage } from "../lib/planning/solver";
import { draftReducer, initialDraft } from "../components/planning/draft";

const rectangle = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }];
const costs: Record<string, number> = { electronics: 96000, printing: 120000, woodworking: 140000, safety: 210000, laser: 185000, materials: 90000 };
function proposal() {
  const sketch = randomUUID(), quote = randomUUID();
  const packages: PlanPackageBinding[] = Object.entries(costs).map(([packageId, budgetMinor]) => ({ packageId, version: 1, budgetMinor, title: packageId }));
  const source = (documentId: string, purpose: PlanSourceBinding["purpose"]): PlanSourceBinding => ({ documentId, purpose, contentHash: "a".repeat(64), documentVersion: 1, controlVersion: 1, provenance: "sample_document", pageHashes: ["b".repeat(64)], pages: [{ number: 1, width: 1200, height: 840 }] });
  const sources = [source(sketch, "sketch"), source(quote, "quote")];
  const plan = samplePlan(sketch, quote, packages);
  plan.zones.forEach(zone => zone.reviewState = "reviewed"); plan.packages.forEach(pkg => pkg.reviewState = "reviewed");
  return { plan, sources, packages, validate: (value: ProposedPlan = plan) => validatePlan(value, sources, packages.map(p => p.packageId), true) };
}

describe("reviewable normalized geometry", () => {
  it("keeps fictional source quotes unchanged when a current package budget or label changes", () => {
    const f = proposal();
    const changed = f.packages.map(pkg => ({ ...pkg, title: "Changed approved label", budgetMinor: 1 }));
    const plan = samplePlan(f.plan.sourceDocumentId, f.sources[1].documentId, changed);
    assert.equal(plan.packages.find(pkg => pkg.packageId === "electronics")?.budgetMinor, 96000);
    assert.match(plan.citations.find(citation => citation.id === "quote-electronics")!.text, /Electronics benches: USD 960.00/);
    assert.throws(() => samplePlan(f.plan.sourceDocumentId, f.sources[1].documentId, [{ packageId: "unquoted", title: "Unquoted", version: 1, budgetMinor: 100 }]), /do not describe/);
  });
  it("requires explicit closure, finite coordinates and nonintersecting positive-area polygons", () => {
    assert.deepEqual(polygonErrors(rectangle(.1, .1, .8, .8)), []);
    assert.ok(polygonErrors([{ x: .1, y: .1 }, { x: .9, y: .1 }, { x: .9, y: .9 }, { x: .1, y: .9 }]).includes("POLYGON_OPEN"));
    assert.ok(polygonErrors([{ x: .1, y: .1 }, { x: .9, y: .9 }, { x: .1, y: .9 }, { x: .9, y: .1 }, { x: .1, y: .1 }]).includes("POLYGON_SELF_INTERSECTION"));
    assert.deepEqual(polygonErrors(rectangle(-.1, 0, 1, 1)), ["COORDINATES_INVALID"]);
    assert.deepEqual(polygonErrors([{ x: NaN, y: .1 }, ...rectangle(.1, .1, .5, .5)]), ["COORDINATES_INVALID"]);
  });
  it("checks edges through concave notches even when every endpoint lies in the room", () => {
    const room = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: .6, y: 1 }, { x: .6, y: .4 }, { x: .4, y: .4 }, { x: .4, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0 }];
    const bridge = rectangle(.2, .5, .6, .3);
    assert.ok(bridge.every(p => pointInPolygon(p, room)));
    assert.equal(polygonInside(bridge, room), false);
    assert.equal(polygonInside(rectangle(.05, .05, .9, .3), room), true);
    assert.ok(pointInPolygon(polygonLabel(room), room));
  });
  it("allows shared boundaries but detects coincident, contained, crossing and aligned overlap", () => {
    const a = rectangle(.1, .1, .3, .3);
    assert.equal(polygonsOverlap(a, rectangle(.4, .1, .3, .3)), false);
    assert.equal(polygonsOverlap(a, rectangle(.4, .4, .3, .3)), false);
    assert.equal(polygonsOverlap(a, [...a].reverse()), true);
    assert.equal(polygonsOverlap(a, rectangle(.2, .2, .1, .1)), true);
    assert.equal(polygonsOverlap(a, rectangle(.2, .1, .3, .3)), true);
    assert.equal(polygonsOverlap(rectangle(.1, .4, .8, .1), rectangle(.4, .1, .1, .8)), true);
  });
  it("keeps closure and the previous immutable polygon when a keyboard corner moves", () => {
    const original = rectangle(.1, .1, .3, .3), snapshot = structuredClone(original);
    const moved = moveVertex(original, 0, { x: -1, y: .123456 });
    assert.deepEqual(original, snapshot); assert.deepEqual(moved[0], { x: 0, y: .1235 }); assert.deepEqual(moved[0], moved.at(-1));
  });
  it("permits an honestly unknown scale and demands separate source and package reviews", () => {
    const f = proposal(); assert.equal(f.validate().publishable, true); assert.match(scaleLabel(f.plan), /no measured scale/);
    f.plan.packages[0].reviewState = "needs_review"; assert.equal(f.validate().publishable, false);
    f.plan.packages[0].reviewState = "reviewed"; f.plan.packages[0].budgetMinor = null;
    assert.ok(f.validate().issues.some(i => i.code === "COST_UNKNOWN"));
  });
  it("rejects outside source boxes, foreign quote documents and sketch references on the wrong page", () => {
    const f = proposal();
    f.plan.citations[0].region = { x: .9, y: .9, width: .2, height: .2 };
    assert.ok(f.validate().issues.some(i => i.code === "SOURCE_REGION_INVALID"));
    f.plan.citations[0].documentId = randomUUID();
    assert.equal(f.validate().publishable, false);
    const q = f.plan.citations.find(c => c.kind === "quote")!; q.documentId = f.plan.sourceDocumentId;
    assert.ok(f.validate().issues.some(i => i.code === "QUOTE_SOURCE_INVALID"));
  });
  it("cannot reduce acceptance to a photo or remove the qualified laser prerequisite", () => {
    const f = proposal(), safety = f.plan.packages.find(p => p.packageId === "safety")!;
    safety.requirements = safety.requirements.filter(r => r.kind === "photo_association");
    f.plan.dependencies = [];
    const codes = f.validate().issues.map(i => i.code);
    assert.ok(codes.includes("BASELINE_REQUIREMENT_MISSING")); assert.ok(codes.includes("SAFETY_REQUIREMENT_MISSING")); assert.ok(codes.includes("SAFETY_PREREQUISITE_REQUIRED"));
    safety.requirements = defaultRequirements("safety"); safety.requirements[1].scope = "equipment_setup";
    assert.ok(f.validate().issues.some(i => i.code === "EVIDENCE_SCOPE_INVALID"));
  });
  it("rejects wall collisions, invalid openings, scale without evidence and prerequisite loops", () => {
    const f = proposal(); f.plan.openings.push({ ...f.plan.openings[0], id: "colliding-opening" });
    f.plan.scale = { state: "reviewed", distance: 10, unit: "ft", from: { x: .1, y: .1 }, to: { x: .1, y: .1 }, citationId: null, note: "No measured source" };
    f.plan.dependencies.push({ packageId: "safety", prerequisiteId: "laser", kind: "accepted_work", reason: "A controlled invalid cycle", citationId: null });
    const codes = f.validate().issues.map(i => i.code);
    assert.ok(codes.includes("OPENINGS_OVERLAP")); assert.ok(codes.includes("SCALE_REFERENCE_INVALID")); assert.ok(codes.includes("DEPENDENCY_CYCLE"));
    f.plan.openings[0].citationId = null; assert.ok(f.validate().issues.some(i => i.code === "OPENING_SOURCE_MISSING"));
  });
  it("structurally bounds source fields and treats no extra model key as authority", () => {
    const f = proposal(); assert.equal(proposedPlanSchema.safeParse(f.plan).success, true);
    assert.equal(proposedPlanSchema.safeParse({ ...f.plan, approved: true }).success, false);
    f.plan.zones[0].polygon[0].x = 1.01; assert.equal(proposedPlanSchema.safeParse(f.plan).success, false);
  });
});

describe("three-anchor illustrative registration", () => {
  it("solves a known affine mapping without calling its interpolation residual real-world accuracy", () => {
    const pairs = [{ x: .1, y: .1 }, { x: .9, y: .2 }, { x: .2, y: .9 }].map(photo => ({ photo, plan: { x: .1 + .6 * photo.x + .1 * photo.y, y: .05 + .1 * photo.x + .7 * photo.y } }));
    const result = solveAffine(pairs);
    const transformed = transformPoint(result.matrix, { x: .5, y: .5 });
    assert.ok(Math.abs(transformed.x - .45) < 1e-12); assert.ok(Math.abs(transformed.y - .45) < 1e-12);
    assert.ok(result.residualRms < 1e-12); assert.ok(result.conditioning < 10);
    assert.deepEqual(Object.keys(result).sort(), ["conditioning", "matrix", "residualRms"]);
  });
  it("rejects insufficient, outside, collinear and nearly collinear landmarks in either view", () => {
    const a = [{ x: .1, y: .1 }, { x: .5, y: .5 }, { x: .9, y: .90001 }].map(photo => ({ photo, plan: photo }));
    assert.throws(() => solveAffine(a), /triangle/); assert.throws(() => solveAffine(a.slice(0, 2)), /exactly three/);
    a[2].photo = { x: 1.1, y: .3 }; assert.throws(() => solveAffine(a), /inside/);
    const clear = [{ x: .1, y: .1 }, { x: .9, y: .1 }, { x: .1, y: .9 }].map((photo, i) => ({ photo, plan: { x: .1 + i * .3, y: .1 + i * .3 } }));
    assert.throws(() => solveAffine(clear), /triangle/);
  });
});

describe("private geometry edit history", () => {
  it("groups a drag into one undo step and keeps model lineage after manual edits", () => {
    const { plan } = proposal(), runId = randomUUID();
    let state = draftReducer(initialDraft(null, 3), { type: "load", plan, version: 3, planId: null, origin: "model", sourceRunId: runId });
    state = draftReducer(state, { type: "checkpoint" });
    for (const x of [.11, .12, .13]) state = draftReducer(state, { type: "edit", checkpoint: false, update: p => ({ ...p, outline: moveVertex(p.outline, 0, { x, y: .2 }) }) });
    assert.equal(state.past.length, 1); assert.equal(state.origin, "manual"); assert.equal(state.sourceRunId, runId); assert.equal(state.baseVersion, 3);
    const changed = state.plan; state = draftReducer(state, { type: "undo" }); assert.deepEqual(state.plan, plan);
    state = draftReducer(state, { type: "redo" }); assert.deepEqual(state.plan, changed);
    state = draftReducer(state, { type: "load", plan: null, version: 4, planId: null, origin: "manual" });
    assert.equal(state.past.length + state.future.length, 0); assert.equal(state.plan, null); assert.equal(state.sourceRunId, null);
  });
});

const pkg = (id: string, costMinor: number | null, available = true): ScenarioPackage => ({ id, title: id, costMinor, available, capabilities: [`Use ${id}`] });
const dependency = (packageId: string, prerequisiteId: string): PlanDependency => ({ packageId, prerequisiteId, kind: "safety_signoff", reason: "A sourced prerequisite", citationId: null });
describe("complete, restricted-fund budget models", () => {
  it("computes the full prerequisite closure and rejects even an unused cycle", () => {
    const packages = [pkg("laser", 200), pkg("safety", 100), pkg("electrical", 50)];
    assert.deepEqual(prerequisiteClosure(["laser"], packages, [dependency("laser", "safety"), dependency("safety", "electrical")]), ["electrical", "laser", "safety"]);
    assert.throws(() => prerequisiteClosure(["laser"], [...packages, pkg("other", 10)], [dependency("safety", "electrical"), dependency("electrical", "safety")]), /cycle/);
    assert.throws(() => prerequisiteClosure(["unknown"], packages, []), /current plan/);
  });
  it("uses max flow when a greedy flexible-first allocation would fail", () => {
    const packages = [pkg("a", 100), pkg("b", 100)], pools = [{ id: "flexible", amountMinor: 100, allowedPackageIds: ["a", "b"] }, { id: "only-a", amountMinor: 100, allowedPackageIds: ["a"] }];
    const result = allocateScenarioFunds(packages, pools)!;
    assert.deepEqual(result, [{ poolId: "flexible", packageId: "b", amountMinor: 100 }, { poolId: "only-a", packageId: "a", amountMinor: 100 }]);
  });
  it("never uses restricted support elsewhere even when total funds appear sufficient", () => {
    const result = solveScenario([pkg("a", 100), pkg("b", 100)], [], ["a", "b"], [{ id: "restricted", amountMinor: 200, allowedPackageIds: ["a"] }]);
    assert.equal(result.requested.feasible, false); assert.match(result.requested.reasons.join(" "), /restricted/);
    assert.deepEqual(result.alternatives.map(a => a.packageIds), [["a"]]); assert.equal(result.alternatives[0].unspentMinor, 100);
  });
  it("includes safety costs, preserves unknowns, and returns three deterministic complete alternatives", () => {
    const packages = [pkg("laser", 200), pkg("safety", 100), pkg("bench", 80), pkg("storage", 70), pkg("unknown", null), pkg("unavailable", 1, false)];
    const pool = [{ id: "prospective", amountMinor: 250, allowedPackageIds: packages.map(p => p.id) }];
    const result = solveScenario(packages, [dependency("laser", "safety")], ["laser"], pool);
    assert.equal(result.requested.totalMinor, 300); assert.equal(result.requested.feasible, false); assert.equal(result.alternatives.length, 3);
    assert.deepEqual(result.alternatives[0].packageIds, ["bench", "safety", "storage"]);
    assert.ok(result.alternatives.every(a => !a.packageIds.includes("laser") && !a.packageIds.includes("unknown") && !a.packageIds.includes("unavailable")));
    assert.equal(result.meaning, "budget_model_only"); assert.equal(result.excluded.length, 2);
    assert.equal(solveScenario(packages, [], ["unknown"], pool).requested.totalMinor, null);
  });
  it("rejects unsafe amounts, duplicate pools, foreign restrictions and excessive package counts", () => {
    assert.throws(() => solveScenario([pkg("a", .1)], [], ["a"], []), /integer/);
    assert.throws(() => solveScenario([pkg("a", 10)], [], ["a"], [{ id: "x", amountMinor: 10, allowedPackageIds: ["b"] }]), /outside/);
    assert.throws(() => solveScenario(Array.from({ length: 21 }, (_, i) => pkg(String(i), 1)), [], [], []), /twenty/);
    assert.throws(() => solveScenario([pkg("a", 10)], [], [], [{ id: "x", amountMinor: 1, allowedPackageIds: [] }, { id: "x", amountMinor: 1, allowedPackageIds: [] }]), /distinct/);
  });
});
