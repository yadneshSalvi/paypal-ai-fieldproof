import type { AgAiToolSchema } from "ag-studio";
import { z } from "zod";

export const studioPackageInput = z.object({ packageId: z.string().min(1).max(160).optional() }).strict();
export const studioEvidenceInput = studioPackageInput.extend({ evidenceId: z.string().min(1).max(200).optional() }).strict();
export const studioOwnedReadInput = z.object({ tool: z.enum(["get_order", "get_invoice"]), receiptId: z.string().min(1).max(200) }).strict();

const packageProperties = { packageId: { type: "string", description: "An exact package id from the scoped report. Omit for the whole scoped report." } };
/** Browser declarations and server model declarations share this fixed inventory. The
 * execution schema and authorization still run independently on the server. */
export const studioServerToolSchemas: AgAiToolSchema[] = [
  { name: "fieldproof_snapshot", kind: "server", description: "Read this run's immutable, role-redacted Fieldproof report cutoff. Contains package totals, receipt rows and real allocation history. Amounts are integer USD cents. A funding shortfall, expense review, and physical acceptance are different facts.",
    parameters: { type: "object", properties: packageProperties, additionalProperties: false } },
  { name: "fieldproof_evidence", kind: "server", description: "Read evidence associations that this actor may see at the run's cutoff. A reviewed expense is not accepted physical work. Private originals stay behind their own access checks; this tool does not download them or certify them.",
    parameters: { type: "object", properties: { ...packageProperties, evidenceId: { type: "string", description: "Optional exact evidence identity from the scoped report." } }, additionalProperties: false } },
  { name: "fieldproof_exceptions", kind: "server", description: "Read the report's actual unresolved exceptions and recorded observation times. Unattempted collection is not a provider decline. Exception amounts can overlap and must not be summed as a ledger.",
    parameters: { type: "object", properties: packageProperties, additionalProperties: false } },
  { name: "paypal_owned_read", kind: "server", description: "Read one exact owned PayPal sandbox order or recovery invoice through the official PayPal Agent Toolkit. Supply an app receipt id, never a provider id, URL or other tool name. Sample receipts have no provider resource. A read only observes status and cannot update a settlement or move money.",
    parameters: { type: "object", properties: { tool: { type: "string", enum: ["get_order", "get_invoice"] }, receiptId: { type: "string", description: "The exact settlement receipt id in this run's role-scoped cutoff." } }, required: ["tool", "receiptId"], additionalProperties: false } },
];
