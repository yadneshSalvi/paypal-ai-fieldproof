import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import type { SettlementReceipt } from "../contracts";
import { projectFundingPositions, type FundingAssignment, type FundingDeductions, type FundingScope, type FundingUse } from "../domain/funding-positions";
import type { FundingJournal, FundingOrigin } from "../domain/funding-lots";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { database, query } from "./db";
import { requireCurrentRole } from "./membership";
import { openPrivate } from "./private-values";
import { pledgeContract, type PledgeRow } from "./purpose-store";
import { readSampleOrigins } from "./sample-funding-origins";

export const assignmentContext = (scope: FundingScope, id: string) => `funding-assignment:${scope.tenantId}:${scope.projectId}:${id}`;
export const deductionContext = (scope: FundingScope, receiptId: string, version: number) => `funding-deduction:${scope.tenantId}:${scope.projectId}:${receiptId}:${version}`;

function conflict(): never {
  throw new DomainError("FUNDING_SAVED_IDENTITY", "The saved funding journal needs reconciliation before it can establish available funds.");
}

/** Internal read: caller supplies its transaction and authorizes disclosure.
 * It always loads the complete conditional-credit journal for this workspace.
 * Filtering by a destination first would lose original receipt lineage. */
export async function readFundingJournal(scope: FundingScope, tx: SqlConnection): Promise<FundingJournal> {
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
  return {sources,assignments,deductions,uses:uses.map(row=>({id:row.id,receiptId:row.receipt_id,packageId:row.package_id,state:row.state,amountMinor:Number(row.amount_minor)}))};
}

export async function readFundingProjection(scope: FundingScope, tx: SqlConnection) {
  return projectFundingPositions(await readFundingJournal(scope,tx),scope);
}

/** Read only exact original authority. A missing original is left missing for
 * the strict executor to reject; current package versions are never a fallback. */
export async function readFundingOrigins(scope: FundingScope, tx: SqlConnection): Promise<FundingOrigin[]> {
  const rows=await query<{receipt_id:string;package_id:string;package_version:number;round_id:string;consent_id:string;consent_version:number;consent_digest:string;donor_actor_id:string;created_at:Date}>(
    `SELECT sr.id receipt_id,sr.package_id,c.package_version,r.id round_id,c.id consent_id,i.consent_version,i.consent_digest,o.actor_id donor_actor_id,sr.created_at
     FROM fp_settlement_receipts sr JOIN fp_obligations o ON o.id=sr.obligation_id AND o.tenant_id=sr.tenant_id AND o.project_id=sr.project_id
     JOIN fp_collection_items i ON i.obligation_id=o.id JOIN fp_conditional_consents c ON c.id=i.consent_id AND c.obligation_id=o.id
     JOIN fp_collection_rounds r ON r.id=i.round_id AND r.id=c.round_id
     WHERE sr.tenant_id=$1 AND sr.project_id=$2 AND o.purpose='conditional_pledge'
       AND c.tenant_id=sr.tenant_id AND c.project_id=sr.project_id AND c.actor_id=o.actor_id
       AND r.tenant_id=sr.tenant_id AND r.project_id=sr.project_id AND r.package_id=sr.package_id
       AND c.package_id=sr.package_id AND o.package_id=sr.package_id AND c.package_version=r.package_version
       AND c.version=i.consent_version AND c.policy_digest=i.consent_digest ORDER BY r.id,sr.created_at,sr.id`,[scope.tenantId,scope.projectId],tx);
  const originals = rows.map(row=>({receiptId:row.receipt_id,packageId:row.package_id,packageVersion:row.package_version,roundId:row.round_id,
    consentId:row.consent_id,consentVersion:row.consent_version,consentDigest:row.consent_digest,donorActorId:row.donor_actor_id,receiptCreatedAt:row.created_at.toISOString()}));
  const pledges=await query<PledgeRow&{receipt_id:string;receipt_created_at:Date}>(`SELECT p.*,sr.id receipt_id,sr.created_at receipt_created_at FROM fp_purpose_pledges p
    JOIN fp_settlement_receipts sr ON sr.obligation_id=p.obligation_id AND sr.tenant_id=p.tenant_id AND sr.project_id=p.project_id
    JOIN fp_obligations o ON o.id=p.obligation_id AND o.tenant_id=p.tenant_id AND o.project_id=p.project_id AND o.actor_id=p.donor_actor_id AND o.package_id=p.package_id
    JOIN fp_funding_policies f ON f.id=p.policy_id AND f.tenant_id=p.tenant_id AND f.project_id=p.project_id AND f.round_id=p.round_id AND f.package_id=p.package_id AND f.package_version=p.package_version
    WHERE p.tenant_id=$1 AND p.project_id=$2 AND sr.package_id=p.package_id AND o.purpose='conditional_pledge' ORDER BY p.round_id,sr.created_at,sr.id`,[scope.tenantId,scope.projectId],tx);
  return [...originals,...await readSampleOrigins(scope,tx),...pledges.map(row=>{const value=pledgeContract(row);if(value.provenance!==scope.provenance)conflict();return{receiptId:row.receipt_id,packageId:value.packageId,packageVersion:value.packageVersion,roundId:value.roundId,consentId:value.id,consentVersion:value.version,consentDigest:row.digest,donorActorId:value.donorActorId,receiptCreatedAt:row.receipt_created_at.toISOString(),title:value.title,purpose:value.purpose};})];
}

/** Caller takes claims:<project> before this function. Every funding mutation
 * shares this order: all source/destination rounds, packages, obligations, then
 * receipts. Scope-wide locking also serializes a newly discovered credit lot. */
export async function lockFundingScope(scope: Pick<FundingScope,"tenantId"|"projectId">, tx: SqlConnection): Promise<void> {
  await tx.query("SELECT id FROM fp_collection_rounds WHERE tenant_id=$1 AND project_id=$2 ORDER BY id FOR UPDATE",[scope.tenantId,scope.projectId]);
  await tx.query("SELECT p.id FROM fp_packages p JOIN fp_projects project ON project.id=p.project_id WHERE project.tenant_id=$1 AND p.project_id=$2 ORDER BY p.id FOR UPDATE OF p",[scope.tenantId,scope.projectId]);
  await tx.query("SELECT id FROM fp_obligations WHERE tenant_id=$1 AND project_id=$2 ORDER BY id FOR UPDATE",[scope.tenantId,scope.projectId]);
  await tx.query("SELECT id FROM fp_settlement_receipts WHERE tenant_id=$1 AND project_id=$2 ORDER BY id FOR UPDATE",[scope.tenantId,scope.projectId]);
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
