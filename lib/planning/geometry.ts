import type { AffineMatrix, AnchorPair, PlanIssue, PlanPoint, PlanSourceBinding, PlanValidation, ProposedPlan } from "./contracts";
import { defaultRequirements } from "./contracts";
import { mandatoryDependencies } from "../community/templates";

const EPS = 1e-9;
export const samePoint = (a: PlanPoint, b: PlanPoint) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
export const cross = (a: PlanPoint, b: PlanPoint, c: PlanPoint) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
export function signedArea(points: PlanPoint[]): number {
  return points.slice(0, -1).reduce((sum, point, i) => sum + point.x * points[i + 1].y - points[i + 1].x * point.y, 0) / 2;
}
export function pointOnSegment(p: PlanPoint, a: PlanPoint, b: PlanPoint): boolean {
  return Math.abs(cross(a, b, p)) < EPS && p.x >= Math.min(a.x, b.x) - EPS && p.x <= Math.max(a.x, b.x) + EPS && p.y >= Math.min(a.y, b.y) - EPS && p.y <= Math.max(a.y, b.y) + EPS;
}
export function pointInPolygon(p: PlanPoint, polygon: PlanPoint[], boundary = true): boolean {
  let inside = false;
  for (let i = 0; i < polygon.length - 1; i++) {
    const a = polygon[i], b = polygon[i + 1];
    if (pointOnSegment(p, a, b)) return boundary;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function properIntersection(a: PlanPoint, b: PlanPoint, c: PlanPoint, d: PlanPoint): boolean {
  return cross(a, b, c) * cross(a, b, d) < -EPS * EPS && cross(c, d, a) * cross(c, d, b) < -EPS * EPS;
}
function intersects(a: PlanPoint, b: PlanPoint, c: PlanPoint, d: PlanPoint): boolean {
  return properIntersection(a, b, c, d) || pointOnSegment(a, c, d) || pointOnSegment(b, c, d) || pointOnSegment(c, a, b) || pointOnSegment(d, a, b);
}
export function polygonErrors(points: PlanPoint[]): string[] {
  if (points.length < 4 || points.length > 65 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) return ["COORDINATES_INVALID"];
  const errors: string[] = [];
  if (!samePoint(points[0], points.at(-1)!)) errors.push("POLYGON_OPEN");
  if (Math.abs(signedArea(points)) < 0.00001) errors.push("POLYGON_EMPTY");
  const n = points.length - 1;
  for (let i = 0; i < n; i++) {
    if (samePoint(points[i], points[i + 1])) errors.push("VERTEX_REPEATED");
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (intersects(points[i], points[i + 1], points[j], points[j + 1])) errors.push("POLYGON_SELF_INTERSECTION");
    }
  }
  return [...new Set(errors)];
}
export function polygonInside(zone: PlanPoint[], outline: PlanPoint[]): boolean {
  if (zone.some(p => !pointInPolygon(p, outline))) return false;
  for (let i = 0; i < zone.length - 1; i++) {
    const a = zone[i], b = zone[i + 1];
    // In a concave room, two contained endpoints need not imply a contained edge.
    for (let j = 0; j < outline.length - 1; j++) if (properIntersection(a, b, outline[j], outline[j + 1])) return false;
    const cuts = [0, 1];
    for (const p of outline) if (pointOnSegment(p, a, b)) {
      const dx = b.x - a.x, dy = b.y - a.y;
      cuts.push(Math.abs(dx) > Math.abs(dy) ? (p.x - a.x) / dx : (p.y - a.y) / dy);
    }
    cuts.sort((x, y) => x - y);
    for (let j = 0; j < cuts.length - 1; j++) {
      const t = (cuts[j] + cuts[j + 1]) / 2;
      if (!pointInPolygon({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }, outline)) return false;
    }
  }
  return true;
}
export function polygonsOverlap(a: PlanPoint[], b: PlanPoint[]): boolean {
  if (a.some(p => pointInPolygon(p, b, false)) || b.some(p => pointInPolygon(p, a, false))) return true;
  for (let i = 0; i < a.length - 1; i++) for (let j = 0; j < b.length - 1; j++) if (properIntersection(a[i], a[i + 1], b[j], b[j + 1])) return true;
  // Identical outlines or aligned overlapping rectangles can have only boundary
  // vertices. Probe just inside every edge, using the polygon winding.
  for (const [first, second] of [[a, b], [b, a]]) {
    const winding = Math.sign(signedArea(first));
    for (let i = 0; i < first.length - 1; i++) {
      const p = first[i], q = first[i + 1], length = Math.hypot(q.x - p.x, q.y - p.y);
      if (length < EPS) continue;
      const probe = { x: (p.x + q.x) / 2 - winding * (q.y - p.y) / length * 1e-7, y: (p.y + q.y) / 2 + winding * (q.x - p.x) / length * 1e-7 };
      if (pointInPolygon(probe, first, false) && pointInPolygon(probe, second, false)) return true;
    }
  }
  return false;
}
export function polygonLabel(points: PlanPoint[]): PlanPoint {
  const area = signedArea(points);
  if (Math.abs(area) > EPS) {
    let x = 0, y = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1], weight = a.x * b.y - b.x * a.y;
      x += (a.x + b.x) * weight; y += (a.y + b.y) * weight;
    }
    const center = { x: x / (6 * area), y: y / (6 * area) };
    if (pointInPolygon(center, points)) return center;
  }
  for (let y = 0.02; y < 1; y += 0.02) for (let x = 0.02; x < 1; x += 0.02) if (pointInPolygon({ x, y }, points, false)) return { x, y };
  return points[0] ?? { x: 0.5, y: 0.5 };
}
export function moveVertex(points: PlanPoint[], index: number, next: PlanPoint): PlanPoint[] {
  const result = points.map(p => ({ ...p }));
  const normalized = { x: Math.round(Math.max(0, Math.min(1, next.x)) * 10000) / 10000, y: Math.round(Math.max(0, Math.min(1, next.y)) * 10000) / 10000 };
  result[index] = normalized;
  if (index === 0 || index === points.length - 1) result[0] = result[result.length - 1] = normalized;
  return result;
}
export function validatePlan(plan: ProposedPlan, sources: PlanSourceBinding[], packageIds: string[], publication = false): PlanValidation {
  const issues: PlanIssue[] = [];
  const add = (code: string, path: string, message: string, severity: PlanIssue["severity"] = "error") => issues.push({ code, path, message, severity });
  const polygon = (points: PlanPoint[], path: string) => polygonErrors(points).forEach(code => add(code, path, code === "POLYGON_SELF_INTERSECTION" ? "Two edges cross. Move a corner to untangle this shape." : code === "POLYGON_OPEN" ? "Close this shape by returning to its first corner." : "This shape needs distinct corners and a positive area."));
  polygon(plan.outline, "outline");
  const unique = (ids: string[], path: string) => { if (new Set(ids).size !== ids.length) add("IDENTITY_REPEATED", path, "Each item needs its own stable identifier."); };
  unique(plan.zones.map(z => z.id), "zones"); unique(plan.walls.map(w => w.id), "walls"); unique(plan.openings.map(o => o.id), "openings");
  unique(plan.citations.map(c => c.id), "citations"); unique(plan.packages.map(p => p.packageId), "packages");
  const source = sources.find(s => s.documentId === plan.sourceDocumentId);
  if (!source || source.purpose !== "sketch" || !source.pages.some(p => p.number === plan.sourcePage)) add("SOURCE_SKETCH_MISSING", "sourceDocumentId", "Choose a validated sketch and one of its pages.");
  const citations = new Map(plan.citations.map(c => [c.id, c]));
  for (const citation of plan.citations) {
    const binding = sources.find(s => s.documentId === citation.documentId), r = citation.region;
    if (!binding || !binding.pages.some(p => p.number === citation.page) || r.x + r.width > 1 + EPS || r.y + r.height > 1 + EPS) add("SOURCE_REGION_INVALID", `citations.${citation.id}`, "This source box must fit on a validated page in this plan.");
    if (citation.kind === "quote" && binding?.purpose !== "quote") add("QUOTE_SOURCE_INVALID", `citations.${citation.id}`, "A quote citation needs a quote document.");
  }
  const quoteRefs = (refs: string[], path: string) => {
    if (!refs.length) add("QUOTE_LINK_MISSING", path, "Link a supplier quote before reviewing this package.", "review");
    for (const ref of refs) if (citations.get(ref)?.kind !== "quote") add("QUOTE_LINK_INVALID", path, "This quote reference is missing or points to a different source kind.");
  };
  for (const zone of plan.zones) {
    polygon(zone.polygon, `zones.${zone.id}`);
    if (!polygonErrors(zone.polygon).length && !polygonErrors(plan.outline).length && !polygonInside(zone.polygon, plan.outline)) add("ZONE_OUTSIDE_ROOM", `zones.${zone.id}`, "Keep every edge of the zone inside the room.");
    if (!zone.packageId || !packageIds.includes(zone.packageId)) add("ZONE_PACKAGE_UNKNOWN", `zones.${zone.id}`, "Choose a current work package for this zone.");
    if (!zone.sourceCitationId || !citations.has(zone.sourceCitationId)) add("ZONE_SOURCE_MISSING", `zones.${zone.id}`, "Draw a source box on the sketch for this zone.", "review");
    else if (citations.get(zone.sourceCitationId)?.documentId !== plan.sourceDocumentId || citations.get(zone.sourceCitationId)?.page !== plan.sourcePage) add("ZONE_SOURCE_INVALID", `zones.${zone.id}`, "The zone's source box must be on this layout's sketch page.");
    quoteRefs(zone.quoteCitationIds, `zones.${zone.id}`);
    if (zone.reviewState !== "reviewed") add("ZONE_REVIEW_NEEDED", `zones.${zone.id}`, "Check this zone's position, package, and source before approving it.", "review");
  }
  for (let i = 0; i < plan.zones.length; i++) for (let j = i + 1; j < plan.zones.length; j++) {
    const a = plan.zones[i], b = plan.zones[j];
    if (!polygonErrors(a.polygon).length && !polygonErrors(b.polygon).length && polygonsOverlap(a.polygon, b.polygon)) add("ZONES_OVERLAP", `zones.${a.id}`, `${a.label} overlaps ${b.label}. Leave a clear boundary between the spaces.`);
  }
  for (const id of packageIds) {
    if (plan.zones.filter(z => z.packageId === id).length !== 1) add("PACKAGE_ZONE_REQUIRED", `packages.${id}`, "Each current package needs exactly one mapped zone.");
    if (!plan.packages.some(p => p.packageId === id)) add("PACKAGE_PLAN_MISSING", `packages.${id}`, "This plan must retain every current package.");
  }
  for (const pkg of plan.packages) {
    if (!packageIds.includes(pkg.packageId)) add("PACKAGE_UNKNOWN", `packages.${pkg.packageId}`, "This package is outside the current approved project.");
    if (pkg.budgetMinor === null) add("COST_UNKNOWN", `packages.${pkg.packageId}`, "An unreadable cost needs a reviewed source; it is not zero.", "review");
    quoteRefs(pkg.quoteCitationIds, `packages.${pkg.packageId}`);
    if (pkg.reviewState !== "reviewed") add("PACKAGE_REVIEW_NEEDED", `packages.${pkg.packageId}`, "Check the quoted amount and evidence requirements.", "review");
    unique(pkg.requirements.map(r => r.id), `packages.${pkg.packageId}.requirements`);
    for (const requirement of pkg.requirements) {
      const requiredScope = { photo_association: null, installation_review: "equipment_setup", ventilation_check: "ventilation", electrical_check: "electrical_safety", laser_safety_check: "laser_safety", site_review: "soil_suitability", access_review: "site_access", water_review: "water_safety", food_handling_review: "food_safety", distribution_review: "distribution_safety" }[requirement.kind];
      if (requirement.scope !== requiredScope) add("EVIDENCE_SCOPE_INVALID", `packages.${pkg.packageId}`, "The evidence requirement needs its corresponding reviewer competence.");
    }
    if (!pkg.requirements.some(r => r.kind === "photo_association")) add("PHOTO_REQUIREMENT_MISSING", `packages.${pkg.packageId}`, "Retain the reviewed image association requirement.");
    if (!defaultRequirements(pkg.packageId).every(required => pkg.requirements.some(r => r.kind === required.kind && r.scope === required.scope))) add("BASELINE_REQUIREMENT_MISSING", `packages.${pkg.packageId}`, "Retain the package's baseline image and scoped physical review requirements. An image alone cannot accept physical work.");
    if (pkg.packageId === "safety" && (!["ventilation_check", "electrical_check"].every(kind => pkg.requirements.some(r => r.kind === kind)))) add("SAFETY_REQUIREMENT_MISSING", "packages.safety", "Safety & Ventilation needs both ventilation and electrical reviews.");
    if (pkg.packageId === "laser" && !pkg.requirements.some(r => r.kind === "laser_safety_check")) add("SAFETY_REQUIREMENT_MISSING", "packages.laser", "Laser Station needs a qualified laser safety sign-off.");
  }
  unique(plan.walls.map(w => String(w.edgeIndex)), "walls");
  if (plan.walls.length !== plan.outline.length - 1 || plan.walls.some(w => w.edgeIndex >= plan.outline.length - 1)) add("WALL_OUTLINE_MISMATCH", "walls", "Each room edge needs one wall reference.");
  for (const opening of plan.openings) {
    if (!plan.walls.some(w => w.id === opening.wallId) || opening.end - opening.start < 0.005) add("OPENING_INVALID", `openings.${opening.id}`, "Choose a wall and a distinct start and end along it.");
    if (opening.citationId && !citations.has(opening.citationId)) add("OPENING_SOURCE_INVALID", `openings.${opening.id}`, "This opening's source reference is unavailable.");
    if (!opening.citationId) add("OPENING_SOURCE_MISSING", `openings.${opening.id}`, "Link this door or window to a source region before approving its position.", "review");
  }
  for (let i = 0; i < plan.openings.length; i++) for (let j = i + 1; j < plan.openings.length; j++) {
    const a = plan.openings[i], b = plan.openings[j];
    if (a.wallId === b.wallId && Math.min(a.end, b.end) - Math.max(a.start, b.start) > EPS) add("OPENINGS_OVERLAP", `openings.${a.id}`, "Door and window segments cannot overlap on the same wall.");
  }
  const scale = plan.scale;
  if (scale.state === "unknown") add("SCALE_UNKNOWN", "scale", "Illustrative plan · no measured dimensions.", "notice");
  else if (!scale.distance || !scale.unit || !scale.from || !scale.to || Math.hypot(scale.from.x - scale.to.x, scale.from.y - scale.to.y) < 0.01 || !scale.citationId || !citations.has(scale.citationId)) add("SCALE_REFERENCE_INVALID", "scale", "A scale needs two separate anchors, a distance, units, and a source citation.");
  else if (scale.state === "estimated") add("SCALE_ESTIMATED", "scale", "Dimension estimates remain labelled until a person checks the source.", "notice");
  const edges = new Map(packageIds.map(id => [id, [] as string[]]));
  const edgeIds = new Set<string>();
  for (const dependency of plan.dependencies) {
    const id = `${dependency.packageId}:${dependency.prerequisiteId}`;
    if (edgeIds.has(id)) add("DEPENDENCY_REPEATED", "dependencies", "Keep one explicit requirement for each prerequisite pair.");
    edgeIds.add(id);
    if (!edges.has(dependency.packageId) || !edges.has(dependency.prerequisiteId) || dependency.packageId === dependency.prerequisiteId) add("DEPENDENCY_INVALID", "dependencies", "A prerequisite must be a different package in this plan.");
    else edges.get(dependency.packageId)!.push(dependency.prerequisiteId);
    if (dependency.citationId && !citations.has(dependency.citationId)) add("DEPENDENCY_SOURCE_INVALID", "dependencies", "This dependency's source reference is unavailable.");
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false; if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of edges.get(id) ?? []) if (!visit(dependency)) return false;
    visiting.delete(id); visited.add(id); return true;
  };
  if (packageIds.some(id => !visit(id))) add("DEPENDENCY_CYCLE", "dependencies", "The prerequisites form a loop. A package cannot depend on itself through another package.");
  if (packageIds.includes("laser") && packageIds.includes("safety") && !plan.dependencies.some(d => d.packageId === "laser" && d.prerequisiteId === "safety" && d.kind === "safety_signoff")) add("SAFETY_PREREQUISITE_REQUIRED", "dependencies", "Laser Station must retain the qualified Safety & Ventilation prerequisite.");
  for (const baseline of mandatoryDependencies(packageIds)) if (!plan.dependencies.some(d => d.packageId === baseline.packageId && d.prerequisiteId === baseline.prerequisiteId && d.kind === baseline.kind)) add("TEMPLATE_PREREQUISITE_REQUIRED", "dependencies", "Retain every template prerequisite and its acceptance kind; evidence cannot be replaced by a purchase.");
  const geometryValid = !issues.some(i => i.severity === "error" && /outline|zones|walls|openings|scale/.test(i.path));
  const reviewReady = !issues.some(i => i.severity === "error");
  return { issues, geometryValid, reviewReady, publishable: reviewReady && !issues.some(i => i.severity === "review") && (!publication || plan.packages.every(p => p.budgetMinor !== null)) };
}
export function solveAffine(anchors: AnchorPair[]): { matrix: AffineMatrix; residualRms: number; conditioning: number } {
  if (anchors.length !== 3 || anchors.some(pair => [pair.photo, pair.plan].some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1))) throw new Error("Choose exactly three anchor pairs inside the image and plan.");
  const [p, q, r] = anchors.map(a => a.photo), [u, v, w] = anchors.map(a => a.plan);
  const determinant = cross(p, q, r), targetDeterminant = cross(u, v, w);
  if (Math.abs(determinant) < 0.0001 || Math.abs(targetDeterminant) < 0.0001) throw new Error("The three anchors must form a clear triangle in both views. Spread them apart.");
  const x1 = q.x - p.x, y1 = q.y - p.y, x2 = r.x - p.x, y2 = r.y - p.y;
  const a = ((v.x - u.x) * y2 - (w.x - u.x) * y1) / determinant;
  const c = (x1 * (w.x - u.x) - x2 * (v.x - u.x)) / determinant;
  const b = ((v.y - u.y) * y2 - (w.y - u.y) * y1) / determinant;
  const d = (x1 * (w.y - u.y) - x2 * (v.y - u.y)) / determinant;
  const matrix: AffineMatrix = [a, b, c, d, u.x - a * p.x - c * p.y, u.y - b * p.x - d * p.y];
  const conditioning = Math.max(Math.hypot(x1, y1), Math.hypot(x2, y2)) ** 2 / Math.abs(determinant);
  if (conditioning > 1000 || matrix.some(n => !Number.isFinite(n) || Math.abs(n) > 1000)) throw new Error("These anchors produce an unstable alignment. Reset and use three widely separated landmarks.");
  const residualRms = Math.sqrt(anchors.reduce((sum, anchor) => { const result = transformPoint(matrix, anchor.photo); return sum + (result.x - anchor.plan.x) ** 2 + (result.y - anchor.plan.y) ** 2; }, 0) / 3);
  return { matrix, residualRms, conditioning };
}
export function transformPoint([a, b, c, d, e, f]: AffineMatrix, point: PlanPoint): PlanPoint { return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f }; }
export function scaleLabel(plan: ProposedPlan): string {
  return plan.scale.state === "unknown" ? "Illustrative · no measured scale" : `${plan.scale.state === "estimated" ? "Estimated" : "Source checked"} scale · ${plan.scale.distance} ${plan.scale.unit} between anchors`;
}
