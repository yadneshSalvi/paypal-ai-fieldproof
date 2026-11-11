import type { PackageView } from "../contracts";
import type { EvidenceRequirement, PlanDependency } from "../planning/contracts";

export const TEMPLATE_IDS = ["makerspace", "community-garden", "mutual-aid"] as const;
export type TemplateId = typeof TEMPLATE_IDS[number];
export interface CommunityPackage {
  id: string; title: string; titleEs: string; shortTitle: string; description: string; budgetMinor: number;
  category: string; icon: PackageView["icon"]; box: [number, number, number, number]; capabilities: string[];
  requirements: EvidenceRequirement[];
}
export interface CommunityTemplate {
  id: TemplateId; version: 1; name: string; eyebrow: string; title: string; titleEs: string; subtitle: string;
  description: string; story: string; organizer: string; location: string; accent: "blue" | "green" | "coral";
  totalMinor: number; assetPrefix: string; planNotes: string; packages: CommunityPackage[];
  dependencies: Omit<PlanDependency, "citationId">[];
}
const photo = (): EvidenceRequirement => ({ id: "photo", label: "Reviewed image association", kind: "photo_association", scope: null });
const setup = (): EvidenceRequirement => ({ id: "installation", label: "Equipment installation review", kind: "installation_review", scope: "equipment_setup" });
const requirement = (id: string, label: string, kind: EvidenceRequirement["kind"], scope: EvidenceRequirement["scope"]): EvidenceRequirement => ({ id, label, kind, scope });
const pkg = (id: string, title: string, titleEs: string, shortTitle: string, budgetMinor: number, icon: PackageView["icon"], box: CommunityPackage["box"], description: string, capability: string, requirements: EvidenceRequirement[] = [photo(), setup()]): CommunityPackage => ({ id, title, titleEs, shortTitle, budgetMinor, icon, box, description, category: capability, capabilities: [capability], requirements });

export const COMMUNITY_TEMPLATES: readonly CommunityTemplate[] = [
  {
    id: "makerspace", version: 1, name: "Makerspace", eyebrow: "MAKE ROOM FOR A FIRST IDEA", title: "Room for possibility.", titleEs: "Espacio para las posibilidades.",
    subtitle: "The Eastside makerspace project", description: "A shared room for making, with safety prerequisites that stay visible.",
    story: "An empty classroom. A community full of ideas. Plan a place to make, discover, and belong.", organizer: "The Eastside project team", location: "Eastside Middle School · fictional plan", accent: "blue", totalMinor: 841000, assetPrefix: "eastside",
    planNotes: "Illustrative sketch. No measured scale. Laser use requires accepted ventilation and electrical checks, plus a qualified laser safety sign-off.",
    packages: [
      pkg("electronics", "Electronics benches", "Mesas de electrónica", "Electronics", 96000, "spark", [.49, .25, .41, .23], "Six places to solder, tinker, and turn a first idea into something that works.", "Six places to learn circuits and soldering"),
      pkg("printing", "3D-printer bay", "Zona de impresión 3D", "3D printing", 120000, "printer", [.10, .25, .34, .23], "A home for three student-ready printers and the first small prototypes.", "Turn digital designs into physical prototypes"),
      pkg("woodworking", "Woodworking corner", "Rincón de carpintería", "Woodworking", 140000, "saw", [.10, .53, .24, .26], "A workbench, hand tools, and room to make carefully, together.", "Make small objects with supervised hand tools"),
      pkg("safety", "Safety & ventilation", "Seguridad y ventilación", "Safety & air", 210000, "shield", [.39, .53, .23, .26], "Fresh air, protective equipment, and qualified review before use.", "Ventilation and electrical reviews for supervised use", [photo(), requirement("ventilation", "Ventilation inspection", "ventilation_check", "ventilation"), requirement("electrical", "Electrical safety inspection", "electrical_check", "electrical_safety")]),
      pkg("laser", "Laser-cutter station", "Estación de corte láser", "Laser cutting", 185000, "laser", [.67, .53, .23, .15], "Precision tools after ventilation, electrical and laser safety acceptance.", "Precision cutting after qualified safety acceptance", [photo(), setup(), requirement("laser-safety", "Laser safety sign-off", "laser_safety_check", "laser_safety")]),
      pkg("materials", "Student materials fund", "Fondo de materiales", "Materials", 90000, "box", [.67, .72, .23, .07], "Everyday shared supplies with a clear record of purchases and use.", "Shared supplies for students"),
    ],
    dependencies: [{ packageId: "laser", prerequisiteId: "safety", kind: "safety_signoff", reason: "Accept ventilation and electrical inspections before laser use; a purchase does not satisfy this prerequisite." }],
  },
  {
    id: "community-garden", version: 1, name: "Community garden", eyebrow: "A LITTLE SPACE. A SHARED SEASON.", title: "Good things take root.", titleEs: "Lo bueno echa raíces.",
    subtitle: "The Maple Corner community garden", description: "A garden planned from the ground up, with soil, water and access reviewed before planting.",
    story: "A quiet patch of ground can bring neighbours together. Start with a plan for the soil, the paths, and the people who will care for it.", organizer: "The Maple Corner garden team", location: "Maple Corner · fictional garden plan", accent: "green", totalMinor: 486000, assetPrefix: "garden",
    planNotes: "Illustrative site plan. No measured scale. Review soil suitability before raised beds; review beds and water before planting. Paths require an access review. No harvest or safe soil is claimed.",
    packages: [
      pkg("garden-soil", "Soil & site preparation", "Suelo y preparación del terreno", "Soil & site", 78000, "leaf", [.10, .25, .34, .23], "A source-backed soil plan, preparation supplies, and a suitability review.", "Prepare a reviewed growing site", [photo(), requirement("soil", "Soil suitability review", "site_review", "soil_suitability")]),
      pkg("garden-paths", "Accessible garden paths", "Senderos accesibles", "Garden paths", 66000, "path", [.49, .25, .41, .13], "A proposed route through the site, checked for access before use.", "Make the planned growing areas reachable", [photo(), requirement("access", "Path access review", "access_review", "site_access")]),
      pkg("garden-beds", "Shared raised beds", "Bancales compartidos", "Raised beds", 144000, "box", [.49, .43, .41, .22], "Six raised-bed kits, with construction and soil conditions reviewed.", "Provide six proposed shared growing beds", [photo(), setup()]),
      pkg("garden-water", "Water & irrigation", "Agua y riego", "Water & irrigation", 96000, "drop", [.10, .53, .24, .26], "A proposed irrigation kit and water-source suitability review.", "Plan a reviewed water supply", [photo(), requirement("water", "Water-source and irrigation review", "water_review", "water_safety")]),
      pkg("garden-tools", "Shared tool shed", "Caseta de herramientas", "Shared tools", 54000, "saw", [.39, .70, .23, .09], "Shared hand tools, storage and a checked setup for volunteers.", "Keep shared tools organized", [photo(), setup()]),
      pkg("garden-seedlings", "Seedlings & first season", "Plantones y primera temporada", "First season", 48000, "leaf", [.67, .70, .23, .09], "Proposed planting supplies. Buying them does not prove planting or a harvest.", "Prepare the first shared planting season", [photo(), requirement("growing", "Growing-site suitability review", "site_review", "soil_suitability")]),
    ],
    dependencies: [
      { packageId: "garden-beds", prerequisiteId: "garden-soil", kind: "accepted_work", reason: "Review site and soil suitability before installing growing beds." },
      { packageId: "garden-seedlings", prerequisiteId: "garden-beds", kind: "accepted_work", reason: "Accept the raised-bed setup before planting." },
      { packageId: "garden-seedlings", prerequisiteId: "garden-water", kind: "safety_signoff", reason: "Review the water source and irrigation before planting." },
    ],
  },
  {
    id: "mutual-aid", version: 1, name: "Mutual-aid supply drive", eyebrow: "CARE, WITH A CLEAR NEXT STEP", title: "A place to show up.", titleEs: "Un lugar para ayudarnos.",
    subtitle: "The Neighbour Table supply drive", description: "A clear route from donated supplies to reviewed storage and distribution, without exposing recipients.",
    story: "People bring what they can. A shared plan makes room for sorting, safe storage, and a distribution day people can understand.", organizer: "The Neighbour Table team", location: "Neighbour Table · fictional supply-drive plan", accent: "coral", totalMinor: 580000, assetPrefix: "mutual-aid",
    planNotes: "Illustrative supply-drive plan. No measured scale. Sort and review supplies before distribution. Cold storage requires electrical and food-handling reviews. Delivery needs the intake and access desk. No recipient or delivery outcome is claimed.",
    packages: [
      pkg("aid-intake", "Intake & sorting", "Recepción y clasificación", "Intake & sorting", 72000, "box", [.10, .25, .34, .23], "Sorting tables, labelled bins and a review of the distribution setup.", "Give incoming supplies a clear place", [photo(), requirement("distribution", "Supply handling and distribution review", "distribution_review", "distribution_safety")]),
      pkg("aid-pantry", "Shelf-stable pantry supplies", "Alimentos de despensa", "Pantry supplies", 180000, "box", [.49, .25, .41, .23], "A fictional supplier list for shelf-stable goods, with condition checks.", "Plan a traceable pantry supply order", [photo(), requirement("food", "Food handling review", "food_handling_review", "food_safety")]),
      pkg("aid-hygiene", "Household hygiene packs", "Paquetes de higiene", "Hygiene packs", 96000, "hand", [.10, .53, .24, .26], "A proposed contents list, checked packaging and clear distribution records.", "Prepare household hygiene packs", [photo(), requirement("distribution", "Pack contents and handling review", "distribution_review", "distribution_safety")]),
      pkg("aid-cold", "Cold-storage station", "Zona de almacenamiento en frío", "Cold storage", 125000, "shield", [.39, .53, .23, .26], "A proposed refrigerated station. Purchase does not establish safe food storage.", "Plan reviewed cold storage", [photo(), requirement("electrical", "Electrical safety inspection", "electrical_check", "electrical_safety"), requirement("food", "Cold-storage food handling review", "food_handling_review", "food_safety")]),
      pkg("aid-delivery", "Neighbourhood delivery routes", "Rutas de entrega", "Delivery routes", 64000, "truck", [.67, .53, .23, .15], "A proposed route and handover plan that keeps household identities private.", "Plan accountable local handovers", [photo(), requirement("distribution", "Delivery and handover review", "distribution_review", "distribution_safety")]),
      pkg("aid-access", "Welcome & access desk", "Mesa de bienvenida y acceso", "Welcome desk", 43000, "hand", [.67, .72, .23, .07], "A welcoming desk with a reviewed access route and clear information.", "Make the collection point understandable", [photo(), requirement("access", "Collection-point access review", "access_review", "site_access")]),
    ],
    dependencies: [
      { packageId: "aid-pantry", prerequisiteId: "aid-intake", kind: "accepted_work", reason: "Review sorting and handling before pantry distribution." },
      { packageId: "aid-hygiene", prerequisiteId: "aid-intake", kind: "accepted_work", reason: "Review intake and pack handling before distribution." },
      { packageId: "aid-delivery", prerequisiteId: "aid-intake", kind: "accepted_work", reason: "Accept intake and sorting before dispatching supplies." },
      { packageId: "aid-delivery", prerequisiteId: "aid-access", kind: "accepted_work", reason: "Review the welcome and access arrangement before handovers." },
    ],
  },
];
export function communityTemplate(id: string | null | undefined): CommunityTemplate {
  const template = COMMUNITY_TEMPLATES.find(item => item.id === (id ?? "makerspace"));
  if (!template) throw new Error("Unknown community template.");
  return template;
}
export function packageTemplate(packageId: string): CommunityPackage | undefined {
  return COMMUNITY_TEMPLATES.flatMap(template => template.packages).find(pkg => pkg.id === packageId);
}
export function templateForPackages(ids: string[]): CommunityTemplate | null {
  return COMMUNITY_TEMPLATES.find(template => ids.length === template.packages.length && template.packages.every(pkg => ids.includes(pkg.id))) ?? null;
}
export function mandatoryDependencies(ids: string[]): Omit<PlanDependency, "citationId">[] {
  return COMMUNITY_TEMPLATES.flatMap(template => template.dependencies).filter(dep => ids.includes(dep.packageId) && ids.includes(dep.prerequisiteId));
}
