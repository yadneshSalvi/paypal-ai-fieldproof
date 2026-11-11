import { defaultRequirements, type PlanPackageBinding, type PlanPoint, type ProposedPlan } from "./contracts";
import { mandatoryDependencies, templateForPackages } from "../community/templates";

export const rectangle = (x: number, y: number, width: number, height: number): PlanPoint[] => [
  { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }, { x, y },
];
const sampleZones: Record<string, [number, number, number, number]> = {
  printing: [.10, .25, .34, .23], electronics: [.49, .25, .41, .23], woodworking: [.10, .53, .24, .26],
  safety: [.39, .53, .23, .26], laser: [.67, .53, .23, .15], materials: [.67, .72, .23, .07],
};
const capabilities: Record<string, string[]> = {
  printing: ["Turn digital designs into physical prototypes"], electronics: ["Six places to learn circuits and soldering"], woodworking: ["Make small objects with supervised hand tools"],
  safety: ["Ventilation and electrical reviews for supervised use"], laser: ["Precision cutting after qualified safety acceptance"], materials: ["Shared supplies for students"],
};
// Exact contents of the labelled fictional source, independent of the current
// approved package budget. Changing that budget cannot rewrite a source quote.
const sampleQuotes: Record<string, { title: string; minor: number }> = {
  electronics: { title: "Electronics benches", minor: 96000 }, printing: { title: "3D-printer bay", minor: 120000 },
  woodworking: { title: "Woodworking corner", minor: 140000 }, safety: { title: "Safety & ventilation", minor: 210000 },
  laser: { title: "Laser-cutter station", minor: 185000 }, materials: { title: "Student materials fund", minor: 90000 },
};
/** Hand-authored fixture. The caller must label it sample; this is never a model result. */
export function samplePlan(sketchId: string, quoteId: string, packages: PlanPackageBinding[]): ProposedPlan {
  const template = templateForPackages(packages.map(pkg => pkg.packageId));
  if (template && template.id !== "makerspace") return {
    schemaVersion: 1, title: template.title, sourceDocumentId: sketchId, sourcePage: 1,
    outline: rectangle(.07, .21, .86, .62), walls: ["north", "east", "south", "west"].map((id, edgeIndex) => ({ id, edgeIndex })),
    openings: [], scale: { state: "unknown", distance: null, unit: null, from: null, to: null, citationId: null, note: "Illustrative boundaries only. No surveyed dimensions or physical walls are established by this drawing." },
    zones: template.packages.map(pkg => ({ id: `zone-${pkg.id}`, packageId: pkg.id, label: pkg.title, polygon: rectangle(...pkg.box), sourceCitationId: `sketch-${pkg.id}`, quoteCitationIds: [`quote-${pkg.id}`], confidence: 1, reviewState: "needs_review" })),
    citations: [
      { id: "site-notes", documentId: sketchId, page: 1, region: { x: .07, y: .85, width: .86, height: .12 }, text: template.planNotes, confidence: 1, kind: "sketch" },
      ...template.packages.map(pkg => { const [x, y, width, height] = pkg.box; return { id: `sketch-${pkg.id}`, documentId: sketchId, page: 1, region: { x, y, width, height }, text: pkg.title, confidence: 1, kind: "sketch" as const }; }),
      ...template.packages.map((pkg, index) => ({ id: `quote-${pkg.id}`, documentId: quoteId, page: 1, region: { x: .07, y: .25 + index * .085, width: .86, height: .07 }, text: `${pkg.title}: USD ${(pkg.budgetMinor / 100).toFixed(2)}. Fictional quote; total includes the stated package contents.`, confidence: 1, kind: "quote" as const })),
    ],
    packages: template.packages.map(pkg => ({ packageId: pkg.id, title: pkg.title, budgetMinor: pkg.budgetMinor, currency: "USD", quoteCitationIds: [`quote-${pkg.id}`], reviewState: "needs_review", capabilities: [...pkg.capabilities], requirements: defaultRequirements(pkg.id) })),
    dependencies: template.dependencies.map(dep => ({ ...dep, citationId: "site-notes" })),
    assumptions: ["This is a hand-authored sample draft, not an AI extraction.", "Every supplier, quote and site in this pack is fictional.", "Boundaries and image alignment cannot certify location, installation, safety, delivery, planting, or completion."],
  };
  if (packages.some(pkg => !sampleQuotes[pkg.packageId])) throw new Error("The sample sketch and quote do not describe these packages. Start a manual plan from your own sources.");
  const quoteOrder = ["electronics", "printing", "woodworking", "safety", "laser", "materials"];
  return {
    schemaVersion: 1, title: "Room for possibility", sourceDocumentId: sketchId, sourcePage: 1,
    outline: rectangle(.07, .21, .86, .62), walls: ["north", "east", "south", "west"].map((id, edgeIndex) => ({ id, edgeIndex })),
    openings: [{ id: "entry", kind: "door", wallId: "south", start: .49, end: .61, citationId: "room-notes" }, { id: "daylight", kind: "window", wallId: "north", start: .08, end: .38, citationId: "room-notes" }],
    scale: { state: "unknown", distance: null, unit: null, from: null, to: null, citationId: null, note: "The source is an illustrative sketch with no measured room dimensions." },
    zones: packages.map(pkg => ({ id: `zone-${pkg.packageId}`, packageId: pkg.packageId, label: sampleQuotes[pkg.packageId].title,
      polygon: rectangle(...(sampleZones[pkg.packageId] ?? [.1, .25, .2, .2])), sourceCitationId: `sketch-${pkg.packageId}`,
      quoteCitationIds: [`quote-${pkg.packageId}`], confidence: 1, reviewState: "needs_review" })),
    citations: [
      { id: "room-notes", documentId: sketchId, page: 1, region: { x: .07, y: .87, width: .86, height: .09 }, text: "Illustrative sketch. No measured scale. Laser use requires accepted ventilation and electrical checks, plus a qualified laser safety sign-off.", confidence: 1, kind: "sketch" },
      ...packages.map(pkg => { const [x, y, width, height] = sampleZones[pkg.packageId] ?? [.1, .25, .2, .2];
        return { id: `sketch-${pkg.packageId}`, documentId: sketchId, page: 1, region: { x, y, width, height }, text: sampleQuotes[pkg.packageId].title, confidence: 1, kind: "sketch" as const }; }),
      ...packages.map(pkg => ({ id: `quote-${pkg.packageId}`, documentId: quoteId, page: 1, region: { x: .07, y: .25 + quoteOrder.indexOf(pkg.packageId) * .085, width: .86, height: .07 },
        text: `${sampleQuotes[pkg.packageId].title}: USD ${(sampleQuotes[pkg.packageId].minor / 100).toFixed(2)}. Fictional quote; total includes the stated package contents.`, confidence: 1, kind: "quote" as const })),
    ],
    packages: packages.map(pkg => ({ packageId: pkg.packageId, title: sampleQuotes[pkg.packageId].title, budgetMinor: sampleQuotes[pkg.packageId].minor, currency: "USD", quoteCitationIds: [`quote-${pkg.packageId}`],
      reviewState: "needs_review", capabilities: capabilities[pkg.packageId] ?? [pkg.title], requirements: defaultRequirements(pkg.packageId) })),
    dependencies: packages.some(p => p.packageId === "laser") && packages.some(p => p.packageId === "safety") ? [{ packageId: "laser", prerequisiteId: "safety", kind: "safety_signoff", reason: "Accept ventilation and electrical inspections before laser use; a purchase does not satisfy this prerequisite.", citationId: "room-notes" }] : [],
    assumptions: ["This is a hand-authored sample draft, not an AI extraction.", "Every supplier, quote and room in this pack is fictional.", "Illustrative placement and image alignment cannot certify location, installation, safety, or completion."],
  };
}
/** A visible starting outline; every source/zone/cost still needs a person's review. */
export function manualPlan(sketchId: string, page: number, packages: PlanPackageBinding[]): ProposedPlan {
  return {
    schemaVersion: 1, title: "A new room plan", sourceDocumentId: sketchId, sourcePage: page, outline: rectangle(.05, .05, .9, .9),
    walls: ["wall-1", "wall-2", "wall-3", "wall-4"].map((id, edgeIndex) => ({ id, edgeIndex })), openings: [],
    scale: { state: "unknown", distance: null, unit: null, from: null, to: null, citationId: null, note: "Draw the room boundary over the source. No measured dimensions have been supplied." },
    zones: [], citations: [], packages: packages.map(pkg => ({ packageId: pkg.packageId, title: pkg.title, budgetMinor: null, currency: "USD", quoteCitationIds: [], reviewState: "needs_review", capabilities: [], requirements: defaultRequirements(pkg.packageId) })),
    dependencies: mandatoryDependencies(packages.map(pkg => pkg.packageId)).map(dep => ({ ...dep, citationId: null })),
    assumptions: ["The starting rectangle is a drawing aid; adjust it to the source before review."],
  };
}
