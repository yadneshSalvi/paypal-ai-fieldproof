/**
 * Replay manifest for the judge tour.
 *
 * A `HeroReplay` carries the sanitized, provider-observed facts of ONE real PayPal
 * sandbox run of the Electronics Benches hero round. It is pasted here by a person
 * after that run; nothing in the product writes it. While `HERO_REPLAY` is null the
 * tour shows Sample chips only and says that no provider replay is available.
 *
 * Rules for whoever pastes a manifest:
 *  - identifiers are suffixes only (the last six characters); never a full provider id,
 *    an email address, a payer name, a token or a URL;
 *  - every timestamp is the time the provider state was observed, in ISO-8601 UTC;
 *  - `declineKind` is "sandbox_simulated" when the decline was produced with PayPal
 *    sandbox negative testing, and "provider_observed" only when PayPal declined an
 *    ordinary sandbox attempt without a simulation header;
 *  - run `validateHeroReplay` (tests/judge-replay.test.ts exercises it) before committing.
 */
export type HeroReplayRail = "orders_capture" | "invoice_payment";
export type HeroReplayDeclineKind = "sandbox_simulated" | "provider_observed";

export interface HeroReplayObligation {
  /** 1–8, in the hero order $200 / $200 / $175 / $150 / $100 / $50 / $50 / $35. */
  slot: number;
  amountMinor: number;
  rail: HeroReplayRail;
  /** Last six characters of the provider payment id that settled this obligation. */
  providerIdSuffix: string;
  /** Provider status exactly as observed, e.g. "COMPLETED" or "PAID". */
  observedStatus: string;
  observedAt: string;
}
export interface HeroReplay {
  schemaVersion: "hero-replay-v1";
  /** Short human label shown in the Provider record drawer. */
  label: string;
  environment: "paypal_sandbox";
  /** When the run was recorded into this manifest. */
  recordedAt: string;
  /** Exactly eight settled obligations: seven Orders captures and one invoice payment. */
  obligations: HeroReplayObligation[];
  decline: {
    slot: number;
    amountMinor: number;
    declineKind: HeroReplayDeclineKind;
    /** Provider issue or processor response as observed, e.g. "INSTRUMENT_DECLINED". */
    observedReason: string;
    observedAt: string;
    /** Last six characters of the declined order id, when one exists. */
    providerIdSuffix: string | null;
  };
  invoice: {
    idSuffix: string;
    /** Whether PayPal returned a QR code for the invoice. The image itself is never stored here. */
    qrPresent: boolean;
    observedStatus: string;
    settledAt: string;
    /** Measured seconds between the observed decline and the observed invoice settlement. */
    elapsedSecondsFromDecline: number;
  };
  payout: { itemSuffix: string; observedStatus: string; observedAt: string; amountMinor: number } | null;
  refunds: { idSuffix: string; amountMinor: number; observedStatus: string; observedAt: string }[];
}

/** Paste the validated manifest of the real sandbox hero run here. */
export const HERO_REPLAY: HeroReplay | null = null;

export const HERO_SLOT_AMOUNTS = [20000, 20000, 17500, 15000, 10000, 5000, 5000, 3500] as const;
export const SIMULATED_DECLINE_WORDING = "Sandbox-simulated decline (PayPal negative testing)";
export const OBSERVED_DECLINE_WORDING = "Provider-observed sandbox decline";

export type HeroReplayValidation = { ok: true; value: HeroReplay } | { ok: false; errors: string[] };

const SUFFIX = /^[A-Za-z0-9]{4,6}$/;
const STATUS = /^[A-Z][A-Z0-9_]{1,39}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isInstant = (value: unknown): value is string => typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value));
const isCents = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 10_000_000;

/** Rejects anything that is not a sanitized, internally consistent hero replay. Never throws. */
export function validateHeroReplay(input: unknown, now: Date = new Date()): HeroReplayValidation {
  const errors: string[] = [];
  const fail = (message: string) => { errors.push(message); };
  const keys = (value: Record<string, unknown>, allowed: string[], where: string) => { for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${where}: unexpected field "${key}". Only sanitized fields are allowed.`); };
  const suffix = (value: unknown, where: string) => { if (typeof value !== "string" || !SUFFIX.test(value)) fail(`${where} must be the last 4–6 letters or digits of the provider id, never a full id.`); };
  const status = (value: unknown, where: string) => { if (typeof value !== "string" || !STATUS.test(value)) fail(`${where} must be an upper-case provider status such as COMPLETED.`); };
  const instant = (value: unknown, where: string) => {
    if (!isInstant(value)) { fail(`${where} must be an ISO-8601 UTC timestamp such as 2026-11-20T14:03:11Z.`); return NaN; }
    const time = Date.parse(value);
    if (time > now.getTime() + 5 * 60_000) fail(`${where} is in the future; a replay records what was already observed.`);
    return time;
  };
  if (!isRecord(input)) return { ok: false, errors: ["The manifest must be an object."] };
  keys(input, ["schemaVersion", "label", "environment", "recordedAt", "obligations", "decline", "invoice", "payout", "refunds"], "manifest");
  if (input.schemaVersion !== "hero-replay-v1") fail('schemaVersion must be "hero-replay-v1".');
  if (input.environment !== "paypal_sandbox") fail('environment must be "paypal_sandbox". A replay is never a live payment.');
  if (typeof input.label !== "string" || input.label.trim().length < 6 || input.label.length > 120) fail("label must be a short human description (6–120 characters).");
  else if (/@|https?:|\blive\b/i.test(input.label)) fail('label must not contain an email address, a URL or the word "live".');
  const recordedAt = instant(input.recordedAt, "recordedAt");

  const observedTimes: number[] = [];
  let invoiceSlot = 0, invoiceObligationAt = NaN;
  if (!Array.isArray(input.obligations) || input.obligations.length !== 8) fail("obligations must list exactly eight settled obligations.");
  else {
    const seen = new Set<number>();
    for (const [index, item] of input.obligations.entries()) {
      const where = `obligations[${index}]`;
      if (!isRecord(item)) { fail(`${where} must be an object.`); continue; }
      keys(item, ["slot", "amountMinor", "rail", "providerIdSuffix", "observedStatus", "observedAt"], where);
      const slot = item.slot;
      if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 1 || slot > 8) { fail(`${where}.slot must be 1–8.`); continue; }
      if (seen.has(slot)) fail(`${where}.slot ${slot} appears twice.`);
      seen.add(slot);
      if (item.amountMinor !== HERO_SLOT_AMOUNTS[slot - 1]) fail(`${where}.amountMinor must be ${HERO_SLOT_AMOUNTS[slot - 1]} for slot ${slot}.`);
      if (item.rail !== "orders_capture" && item.rail !== "invoice_payment") fail(`${where}.rail must be "orders_capture" or "invoice_payment".`);
      if (item.rail === "invoice_payment") { if (invoiceSlot) fail("Exactly one obligation settles by invoice payment."); invoiceSlot = slot; }
      suffix(item.providerIdSuffix, `${where}.providerIdSuffix`);
      status(item.observedStatus, `${where}.observedStatus`);
      const time = instant(item.observedAt, `${where}.observedAt`);
      observedTimes.push(time);
      if (item.rail === "invoice_payment") invoiceObligationAt = time;
    }
    if (!invoiceSlot) fail("One obligation must settle by invoice payment (the recovered one).");
    const captures = input.obligations.filter(item => isRecord(item) && item.rail === "orders_capture").reduce((sum, item) => sum + (isRecord(item) && isCents(item.amountMinor) ? item.amountMinor : 0), 0);
    if (!errors.length && captures !== 92500) fail(`Orders captures must total 92500 cents; this manifest totals ${captures}.`);
  }

  let declineAt = NaN;
  if (!isRecord(input.decline)) fail("decline must be an object.");
  else {
    const decline = input.decline;
    keys(decline, ["slot", "amountMinor", "declineKind", "observedReason", "observedAt", "providerIdSuffix"], "decline");
    if (decline.declineKind !== "sandbox_simulated" && decline.declineKind !== "provider_observed") fail('decline.declineKind must be "sandbox_simulated" or "provider_observed".');
    if (invoiceSlot && decline.slot !== invoiceSlot) fail("decline.slot must be the obligation that was later recovered by invoice.");
    if (typeof decline.slot === "number" && decline.amountMinor !== HERO_SLOT_AMOUNTS[decline.slot - 1]) fail("decline.amountMinor must equal the declined obligation's amount.");
    if (typeof decline.observedReason !== "string" || !/^[A-Z0-9][A-Z0-9_ .-]{2,59}$/.test(decline.observedReason)) fail("decline.observedReason must be the provider's short reason code, e.g. INSTRUMENT_DECLINED.");
    if (decline.providerIdSuffix !== null) suffix(decline.providerIdSuffix, "decline.providerIdSuffix");
    declineAt = instant(decline.observedAt, "decline.observedAt");
  }

  if (!isRecord(input.invoice)) fail("invoice must be an object.");
  else {
    const invoice = input.invoice;
    keys(invoice, ["idSuffix", "qrPresent", "observedStatus", "settledAt", "elapsedSecondsFromDecline"], "invoice");
    suffix(invoice.idSuffix, "invoice.idSuffix");
    if (typeof invoice.qrPresent !== "boolean") fail("invoice.qrPresent must be true or false.");
    status(invoice.observedStatus, "invoice.observedStatus");
    const settledAt = instant(invoice.settledAt, "invoice.settledAt");
    const elapsed = invoice.elapsedSecondsFromDecline;
    if (typeof elapsed !== "number" || !Number.isFinite(elapsed) || elapsed <= 0 || elapsed > 48 * 3600) fail("invoice.elapsedSecondsFromDecline must be a positive number of seconds inside the 48-hour recovery window.");
    else if (Number.isFinite(settledAt) && Number.isFinite(declineAt)) {
      if (settledAt <= declineAt) fail("invoice.settledAt must be after decline.observedAt.");
      else if (Math.abs((settledAt - declineAt) / 1000 - elapsed) > 2) fail("invoice.elapsedSecondsFromDecline must match the two observed timestamps (within two seconds).");
    }
    if (Number.isFinite(settledAt) && Number.isFinite(invoiceObligationAt) && Math.abs(settledAt - invoiceObligationAt) > 10 * 60_000) fail("The invoice-payment obligation's observedAt must be the invoice settlement observation.");
  }

  if (input.payout !== null) {
    if (!isRecord(input.payout)) fail("payout must be an object or null.");
    else {
      keys(input.payout, ["itemSuffix", "observedStatus", "observedAt", "amountMinor"], "payout");
      suffix(input.payout.itemSuffix, "payout.itemSuffix");
      status(input.payout.observedStatus, "payout.observedStatus");
      observedTimes.push(instant(input.payout.observedAt, "payout.observedAt"));
      if (!isCents(input.payout.amountMinor)) fail("payout.amountMinor must be a positive whole number of cents.");
    }
  }
  if (!Array.isArray(input.refunds)) fail("refunds must be an array (empty when no refund was observed).");
  else for (const [index, refund] of input.refunds.entries()) {
    const where = `refunds[${index}]`;
    if (!isRecord(refund)) { fail(`${where} must be an object.`); continue; }
    keys(refund, ["idSuffix", "amountMinor", "observedStatus", "observedAt"], where);
    suffix(refund.idSuffix, `${where}.idSuffix`);
    status(refund.observedStatus, `${where}.observedStatus`);
    observedTimes.push(instant(refund.observedAt, `${where}.observedAt`));
    if (!isCents(refund.amountMinor)) fail(`${where}.amountMinor must be a positive whole number of cents.`);
  }
  if (Number.isFinite(recordedAt) && [...observedTimes, declineAt].some(time => Number.isFinite(time) && time > recordedAt + 60_000)) fail("recordedAt must not be earlier than the observations it records.");
  return errors.length ? { ok: false, errors } : { ok: true, value: input as unknown as HeroReplay };
}

/** The only reader the product uses: an invalid pasted manifest is treated as absent, never half-shown. */
export function activeHeroReplay(candidate: HeroReplay | null = HERO_REPLAY): HeroReplay | null {
  if (!candidate) return null;
  const result = validateHeroReplay(candidate);
  return result.ok ? result.value : null;
}
export function declineWording(replay: HeroReplay): string {
  return replay.decline.declineKind === "sandbox_simulated" ? SIMULATED_DECLINE_WORDING : OBSERVED_DECLINE_WORDING;
}
