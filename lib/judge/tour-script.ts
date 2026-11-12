/**
 * The scripted 60-second judge tour. Pure data: the same numbers drive the browser
 * timeline, the unit tests and the measurement script.
 */
export const HERO_AMOUNTS = [20000, 20000, 17500, 15000, 10000, 5000, 5000, 3500] as const;
export const HERO_LABELS = ["A neighbour", "A family", "A neighbour", "A family", "A local maker", "You", "A neighbour", "A family"] as const;
export const HERO_TARGET_MINOR = 96000;
export const HERO_CAPTURED_MINOR = 92500;
export const HERO_RECOVERY_MINOR = 3500;
export const PROJECT_TOTAL_MINOR = 841000;
export const RECOVERY_LABEL = "$925 Orders captures + $35 invoice payment";
export const COMPRESSED_CAPTION = "The 48-hour recovery window is shown compressed.";

export type ReceiptTarget = "electronics" | "materials" | "review";
export interface TourReceiptLine { id: string; label: string; quantity: number; amountMinor: number; target: ReceiptTarget }
/** Maria's fictional seven-line receipt, as printed on the Sample source document. */
export const MARIA_RECEIPT: TourReceiptLine[] = [
  { id: "solder", label: "Solder wire, lead-free", quantity: 2, amountMinor: 1800, target: "electronics" },
  { id: "stripper", label: "Precision wire stripper", quantity: 1, amountMinor: 1250, target: "electronics" },
  { id: "breadboard", label: "Breadboard starter set", quantity: 4, amountMinor: 1600, target: "electronics" },
  { id: "jumper", label: "Jumper leads, assorted", quantity: 3, amountMinor: 900, target: "electronics" },
  { id: "glasses", label: "Safety glasses", quantity: 6, amountMinor: 1200, target: "materials" },
  { id: "boxes", label: "Storage boxes", quantity: 3, amountMinor: 1050, target: "materials" },
  { id: "parts", label: "Parts", quantity: 1, amountMinor: 840, target: "review" },
];
export const MARIA_TOTAL_MINOR = 8640;
export const receiptSubtotal = (target: ReceiptTarget) => MARIA_RECEIPT.filter(line => line.target === target).reduce((sum, line) => sum + line.amountMinor, 0);
export const MARIA_APPROVED_MINOR = receiptSubtotal("electronics") + receiptSubtotal("materials");
export const MARIA_HELD_MINOR = receiptSubtotal("review");

export type BeatId = "sketch" | "collection" | "receipt";
export interface TourCue { at: number; id: string; say: string }
export interface TourBeat { id: BeatId; step: 1 | 2 | 3; title: string; kicker: string; durationMs: number; cues: TourCue[] }

/** The single sketch-to-blueprint stroke redraw. */
export const REDRAW_MS = 1400;
export const TOUR_BEATS: TourBeat[] = [
  { id: "sketch", step: 1, kicker: "Ms. Okafor · organizer", title: "A rough sketch becomes a plan.", durationMs: 15000, cues: [
    { at: 0, id: "sketch", say: "Ms. Okafor's rough sketch of an empty classroom." },
    { at: 2400, id: "redraw", say: "The sketch is redrawn as a blueprint with six work packages." },
    { at: 2400 + REDRAW_MS, id: "drawn", say: "Six packages, $8,410 in all. Each one has its own budget and proof it still needs." },
    { at: 7200, id: "source", say: "Every zone keeps a link to the part of the sketch it came from." },
    { at: 10800, id: "review", say: "Review before publishing: a person checks every zone and budget before supporters see the plan." },
  ] },
  { id: "collection", step: 2, kicker: "Eight supporters · one of them is you", title: "Eight pledges are collected. One needs a second way.", durationMs: 21000, cues: [
    { at: 0, id: "pledged", say: "Eight pledges reach the $960 Electronics benches goal, so collection begins." },
    { at: 1400, id: "capturing", say: "Each pledge is collected as its own PayPal order." },
    { at: 6400, id: "declined", say: "Seven captures total $925. The $35 payment is declined." },
    { at: 9600, id: "invoice", say: "The same $35 obligation gets one recovery invoice with a QR code to pay from a phone." },
    { at: 13400, id: "settling", say: "The invoice payment is observed." },
    { at: 14600, id: "settled", say: "Collected moves from $925 to $960: $925 Orders captures plus a $35 invoice payment." },
  ] },
  { id: "receipt", step: 3, kicker: "Maria · volunteer", title: "A receipt becomes a repayment.", durationMs: 18000, cues: [
    { at: 0, id: "receipt", say: "Maria paid $86.40 for supplies and photographs the receipt." },
    { at: 1400, id: "lines", say: "Each line is proposed for a package: Electronics benches or Student materials." },
    { at: 6000, id: "ambiguous", say: "One $8.40 line just says Parts. It waits for a person." },
    { at: 7400, id: "duplicate", say: "A second upload looks like the same receipt, so the two open side by side." },
    { at: 11200, id: "approval", say: "Ms. Okafor approves $78.00, holds $8.40 and sets the duplicate aside." },
    { at: 14200, id: "repayment", say: "Maria can follow her repayment from approval to arrival." },
  ] },
];
export const TOUR_SCRIPTED_MS = TOUR_BEATS.reduce((sum, beat) => sum + beat.durationMs, 0);
/** The capture ripple: chip `index` (0–6) settles at this offset inside the collection beat. */
export const captureAt = (index: number) => 1400 + index * 640 + 520;
export const lineAt = (index: number) => 1400 + index * 620;
export function activeCue(beat: TourBeat, elapsedMs: number): TourCue {
  let current = beat.cues[0];
  for (const cue of beat.cues) if (elapsedMs >= cue.at) current = cue;
  return current;
}
export const cueReached = (beat: TourBeat, id: string, elapsedMs: number) => elapsedMs >= (beat.cues.find(cue => cue.id === id)?.at ?? Infinity);
export const dollars = (minor: number, cents = false) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 }).format(minor / 100);

/** Role deep links: the best page for a fresh judge tenant in each role. */
export const ROLE_LINKS = [
  { role: "donor", person: "A supporter (you)", href: "/my-contribution", title: "Follow your own $50", text: "See what your Electronics benches share supported, then decide what happens to your $100 Woodworking share now that the corner is postponed." },
  { role: "volunteer", person: "Maria", href: "/my-expenses", title: "Hand in a receipt", text: "Add Maria's Sample receipt, let AI read its seven lines, correct anything it got wrong and submit it for review." },
  { role: "organizer", person: "Ms. Okafor", href: "/organizer", title: "Run the project", text: "Budgets, the collection, the postponed Woodworking decision, the review queue and the plan, in one workspace." },
  { role: "auditor", person: "An auditor", href: "/studio", title: "Check the record", text: "Read-only: every package, payment and review in Proof Studio, with no way to move money." },
] as const;
export type JudgeRole = typeof ROLE_LINKS[number]["role"];
