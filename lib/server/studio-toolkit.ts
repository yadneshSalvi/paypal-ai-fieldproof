import { randomUUID } from "node:crypto";
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/openai";
import { canonicalJson, sha256 } from "@fracture/paypal-core";
import { z } from "zod";
import type { SettlementReceipt } from "../contracts";
import type { StudioSnapshot } from "../studio/contracts";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { query } from "./db";
import { requireCurrentRole } from "./membership";
import { providerConfiguration } from "./payments";
import { studioOwnedReadInput } from "../studio/server-tools";
import { requireStudioDataset } from "./studio-datasets";

export const ownedToolkitReadSchema = studioOwnedReadInput;
export function toolkitLoggingEnabled(setting = process.env.DEBUG ?? ""): boolean {
  const patterns = setting.split(/[\s,]+/).filter(Boolean);
  const matches = (pattern: string, namespace: string) => new RegExp(`^${pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(namespace);
  return ["agent-toolkit:payloadUtils", "agent-toolkit:functions", "agent-toolkit:client"].some(namespace =>
    patterns.some(pattern => !pattern.startsWith("-") && matches(pattern, namespace)) && !patterns.some(pattern => pattern.startsWith("-") && matches(pattern.slice(1), namespace)));
}
export interface ToolkitReader { read(tool: "get_order" | "get_invoice", providerId: string): Promise<unknown>; }
export const actualToolkitReader: ToolkitReader = {
  async read(tool, providerId) {
    const config = providerConfiguration();
    if (!["https://api-m.sandbox.paypal.com", "https://api.sandbox.paypal.com"].includes(config.baseUrl)) throw new DomainError("TOOLKIT_HOST_DENIED", "The Toolkit read needs the isolated sandbox connection.", 503);
    // The official package's handleToolCall does NOT enforce its configured action list.
    // Our closed switch is the authority boundary; never pass an arbitrary model tool name.
    if (tool !== "get_order" && tool !== "get_invoice") throw new DomainError("TOOLKIT_ACTION_DENIED", "This report can only read an exact owned payment resource.", 403);
    if (toolkitLoggingEnabled()) throw new DomainError("TOOLKIT_DEBUG_UNSAFE", "The private Toolkit read is unavailable while provider debug logging is enabled.", 503);
    if (!/^[A-Z0-9-]{8,60}$/.test(providerId)) throw new DomainError("TOOLKIT_RESOURCE_INVALID", "The stored provider identity is invalid.", 409);
    // A short-lived read client avoids the package's non-expiring cached access token. The
    // SDK transport is deliberately separate from all application financial-write adapters.
    const toolkit = new PayPalAgentToolkit({ clientId: config.clientId, clientSecret: config.clientSecret,
      configuration: { actions: { orders: { get: true }, invoices: { get: true } }, context: { sandbox: true, debug: false } } });
    const parameters = tool === "get_order" ? { id: providerId } : { invoice_id: providerId };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        toolkit.handleToolCall({ id: randomUUID(), type: "function", function: { name: tool, arguments: JSON.stringify(parameters) } }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new DomainError("TOOLKIT_READ_UNAVAILABLE", "The exact PayPal read did not finish. No financial record was changed.", 502)), 25000); }),
      ]);
      if (typeof response.content !== "string" || response.content.length > 1_500_000) throw new Error("Unexpected Toolkit read response.");
      const value: unknown = JSON.parse(response.content);
      if (!value || typeof value !== "object" || "error" in value || !("id" in value) || value.id !== providerId) throw new DomainError("TOOLKIT_READ_UNAVAILABLE", "PayPal could not return the exact owned resource. No financial record was changed.", 502);
      return value;
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("TOOLKIT_READ_UNAVAILABLE", "PayPal could not complete this read. No financial record was changed.", 502);
    } finally { if (timeout) clearTimeout(timeout); }
  },
};

/** Resolve app identity to provider identity on the server; never accept a provider id or URL
 * from the model. The saved cutoff is an inventory constraint, not a current authorization. */
export async function readOwnedToolkitResource(session: Session, requestedSnapshot: StudioSnapshot, value: unknown, reader: ToolkitReader = actualToolkitReader) {
  const input = ownedToolkitReadSchema.parse(value);
  const snapshot = await requireStudioDataset(session, requestedSnapshot.datasetHandle);
  await requireCurrentRole(session, session.role);
  if (!["donor", "organizer", "auditor"].includes(session.role)) throw new DomainError("TOOLKIT_ROLE_DENIED", "This role cannot read payment resources.", 403);
  if (!snapshot.data.settlements.some(row => row.id === input.receiptId)) throw new DomainError("TOOLKIT_RESOURCE_DENIED", "This receipt is not in the role’s scoped report cutoff.", 403);
  if (snapshot.mode !== "live_sandbox") throw new DomainError("TOOLKIT_SAMPLE_SOURCE", "Sample receipts have no provider resource to read. Use their clearly marked sample facts.", 409);
  // The materialized inventory is authoritative for inclusion. PostgreSQL timestamps
  // carry microseconds while the JSON cutoff has Date's millisecond precision; compare
  // those at the same precision so a just-created, already-included receipt stays readable.
  const [row] = await query<{ data: SettlementReceipt; actor_id: string }>(`SELECT r.data,o.actor_id FROM fp_settlement_receipts r JOIN fp_obligations o ON o.id=r.obligation_id
    WHERE r.id=$1 AND r.tenant_id=$2 AND r.project_id=$3 AND date_trunc('milliseconds',r.created_at)<=$4`, [input.receiptId, session.tenantId, session.projectId, snapshot.asOf]);
  if (!row || row.data.provenance !== "live_sandbox" || (session.role === "donor" && row.actor_id !== session.actorId)) throw new DomainError("TOOLKIT_RESOURCE_DENIED", "This receipt is not available to the current role.", 403);
  const receipt = row.data;
  const providerId = input.tool === "get_order" ? receipt.sourceOrderId : receipt.sourceInvoiceId;
  if (!providerId || (input.tool === "get_order") !== (receipt.sourceKind === "orders_capture")) throw new DomainError("TOOLKIT_RAIL_MISMATCH", "Choose the exact payment rail recorded for this receipt.", 422);
  if (input.tool === "get_order") {
    const owned = await query("SELECT order_id FROM fp_provider_orders WHERE order_id=$1 AND tenant_id=$2 AND project_id=$3 AND obligation_id=$4", [providerId, session.tenantId, session.projectId, receipt.donorObligationId]);
    if (!owned.length) throw new DomainError("TOOLKIT_RESOURCE_DENIED", "The order has no matching workspace ownership record.", 403);
  } else {
    const owned = await query("SELECT id FROM fp_recovery_invoices WHERE provider_invoice_hash=$1 AND tenant_id=$2 AND project_id=$3 AND obligation_id=$4", [sha256(providerId), session.tenantId, session.projectId, receipt.donorObligationId]);
    if (!owned.length) throw new DomainError("TOOLKIT_RESOURCE_DENIED", "The invoice has no matching workspace ownership record.", 403);
  }
  const raw = await reader.read(input.tool, providerId);
  await requireStudioDataset(session, snapshot.datasetHandle); // revocation or cutoff expiry during the network read
  const result = z.object({ id: z.string(), status: z.string().regex(/^[A-Z][A-Z_]{1,79}$/) }).passthrough().parse(raw);
  if (result.id !== providerId) throw new DomainError("TOOLKIT_RESOURCE_CHANGED", "PayPal returned a different identity. This observation cannot be used.", 502);
  const merchant = process.env.PAYPAL_MERCHANT_ID;
  if (merchant && input.tool === "get_order") {
    const units = (raw as { purchase_units?: { payee?: { merchant_id?: string } }[] }).purchase_units;
    if (!units?.length || units.some(unit => unit.payee?.merchant_id !== merchant)) throw new DomainError("TOOLKIT_MERCHANT_MISMATCH", "The returned order does not match the configured merchant.", 502);
  }
  // Return an allowlist, never the provider object (payer, address, links, and payee stay private).
  return { toolkit: "@paypal/agent-toolkit@1.11.0", tool: input.tool, receiptId: receipt.id, sourceKind: receipt.sourceKind,
    resourceState: result.status, observedAt: new Date().toISOString(), reportCutoff: snapshot.asOf,
    storedReceiptState: receipt.authoritativeObservedState, responseHash: sha256(canonicalJson(raw)),
    effect: "Read only. No settlement, funding, refund, allocation, or payout state was changed.",
    authority: "This is the exact resource’s current status. It is separate from the stored settlement and does not authorize money movement." };
}
