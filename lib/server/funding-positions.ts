import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import type { SettlementReceipt } from "../contracts";
import { projectFundingPositions, type FundingAssignment, type FundingDeductions, type FundingScope, type FundingUse } from "../domain/funding-positions";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { database, query } from "./db";
import { requireCurrentRole } from "./membership";
import { openPrivate } from "./private-values";

export const assignmentContext = (scope: FundingScope, id: string) => `funding-assignment:${scope.tenantId}:${scope.projectId}:${id}`;
export const deductionContext = (scope: FundingScope, receiptId: string, version: number) => `funding-deduction:${scope.tenantId}:${scope.projectId}:${receiptId}:${version}`;

function conflict(): never {
  throw new DomainError("FUNDING_SAVED_IDENTITY", "The saved funding journal needs reconciliation before it can establish available funds.");
}

/** Internal read: caller supplies its transaction and authorizes disclosure.
 * It always loads the complete conditional-credit journal for this workspace.
 * Filtering by a destination first would lose original receipt lineage. */
export async function readFundingProjection(scope: FundingScope, tx: SqlConnection) {
  const receipts = await query<{ id: string; version: number; package_id: string; obligation_id: string; purpose: string | null; data: SettlementReceipt }>(
    `SELECT r.id,r.version,r.package_id,r.obligation_id,o.purpose,r.data FROM fp_settlement_receipts r
     LEFT JOIN fp_obligations o ON o.id=r.obligation_id AND o.tenant_id=r.tenant_id AND o.project_id=r.project_id
     WHERE r.tenant_id=$1 AND r.project_id=$2 ORDER BY r.id`, [scope.tenantId,scope.projectId],tx);
  for (const row of receipts) {
    if (!row.purpose || row.id!==row.data.id || row.package_id!==row.data.packageId || row.obligation_id!==row.data.donorObligationId ||
      row.data.tenantId!==scope.tenantId || row.data.projectId!==scope.projectId || row.data.provenance!==scope.provenance) conflict();
  }
  const sources=receipts.filter(row=>row.purpose==="conditional_pledge").map(row=>({receipt:row.data,version:row.version}));
  const entries=await query<{id:string;receipt_id:string;sequence:number;kind:string;amount_minor:string;debit_package_id:string;credit_package_id:string;consent_id:string;consent_digest:string;document_digest:string;encrypted_data:string;committed_at:Date}>(
    "SELECT * FROM fp_funding_assignments WHERE tenant_id=$1 AND project_id=$2 ORDER BY receipt_id,sequence",[scope.tenantId,scope.projectId],tx);
  const assignments=entries.map(row=>{
    const value=openPrivate<FundingAssignment>(row.encrypted_data,assignmentContext(scope,row.id));
    if (sha256(canonicalJson(value))!==row.document_digest || value.id!==row.id || value.receiptId!==row.receipt_id ||
      value.sequence!==row.sequence || value.kind!==row.kind || value.amountMinor!==Number(row.amount_minor) ||
      value.debit.packageId!==row.debit_package_id || value.credit.packageId!==row.credit_package_id ||
      value.consentId!==row.consent_id || value.consentDigest!==row.consent_digest ||
      Date.parse(value.committedAt)!==row.committed_at.getTime()) conflict();
    return value;
  });
  const attributions=await query<{receipt_id:string;receipt_version:number;document_digest:string;encrypted_data:string}>(
    `SELECT d.* FROM fp_funding_deductions d JOIN fp_settlement_receipts r ON r.id=d.receipt_id
     AND r.tenant_id=d.tenant_id AND r.project_id=d.project_id AND r.version=d.receipt_version
     WHERE d.tenant_id=$1 AND d.project_id=$2 ORDER BY d.receipt_id`,[scope.tenantId,scope.projectId],tx);
  const deductions=attributions.map(row=>{
    const value=openPrivate<FundingDeductions>(row.encrypted_data,deductionContext(scope,row.receipt_id,row.receipt_version));
    if (sha256(canonicalJson(value))!==row.document_digest || value.receiptId!==row.receipt_id || value.receiptVersion!==row.receipt_version) conflict();
    return value;
  });
  const uses=await query<{id:string;tenant_id:string;project_id:string;receipt_id:string;package_id:string;state:FundingUse["state"];amount_minor:string}>(
    `SELECT a.id,a.tenant_id,a.project_id,a.receipt_id,a.package_id,a.state,a.amount_minor FROM fp_receipt_allocations a
     JOIN fp_settlement_receipts r ON r.id=a.receipt_id
     JOIN fp_obligations o ON o.id=r.obligation_id AND o.tenant_id=r.tenant_id AND o.project_id=r.project_id
     WHERE r.tenant_id=$1 AND r.project_id=$2 AND a.state IN ('reserved','paid') AND o.purpose='conditional_pledge'
     ORDER BY a.id`,[scope.tenantId,scope.projectId],tx);
  if (uses.some(row=>row.tenant_id!==scope.tenantId || row.project_id!==scope.projectId)) conflict();
  return projectFundingPositions({sources,assignments,deductions,uses:uses.map(row=>({id:row.id,receiptId:row.receipt_id,packageId:row.package_id,state:row.state,amountMinor:Number(row.amount_minor)}))},scope);
}

/** Authorized complete organizer/Auditor read. Donor disclosure needs a separate
 * own-obligation projection, not the full internal journal. */
export async function readWorkspaceFunding(session: Session) {
  if (!["organizer","auditor"].includes(session.role)) throw new DomainError("ROLE_DENIED","The complete funding position is for the organizer or Auditor.",403);
  const result=await database().transaction(async tx=>{
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    await requireCurrentRole(session,session.role,tx);
    const value=await readFundingProjection({tenantId:session.tenantId,projectId:session.projectId,provenance:session.mode},tx);
    await requireCurrentRole(session,session.role,tx);
    return value;
  });
  await requireCurrentRole(session,session.role);
  return result;
}
