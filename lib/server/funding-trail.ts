import type { FundingReceiptTrail } from "../funding/contracts";
import { projectFundingPositions } from "../domain/funding-positions";
import { DomainError } from "../domain/money";
import type { Session } from "./auth";
import { database, query } from "./db";
import { readFundingJournal, readFundingOrigins } from "./funding-positions";
import { fundingChoiceContract } from "./funding-lifecycle";
import { requireCurrentRole } from "./membership";
import { externalReturnRecord } from "./funding-return-reconciliation";

export async function fundingReceiptTrail(session:Session,receiptId:string):Promise<FundingReceiptTrail>{
  const result=await database().transaction(async tx=>{
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");await requireCurrentRole(session,session.role,tx);
    const [owned]=await query<{id:string}>(`SELECT r.id FROM fp_settlement_receipts r JOIN fp_obligations o ON o.id=r.obligation_id AND o.tenant_id=r.tenant_id AND o.project_id=r.project_id
      WHERE r.id=$1 AND r.tenant_id=$2 AND r.project_id=$3 AND o.purpose='conditional_pledge' AND ($4 OR ($5='donor' AND o.actor_id=$6))`,[receiptId,session.tenantId,session.projectId,["organizer","auditor"].includes(session.role),session.role,session.actorId],tx);
    if(!owned)throw new DomainError("FUNDING_RECEIPT_NOT_FOUND","This contribution trail is outside your current view.",404);
    const scope={tenantId:session.tenantId,projectId:session.projectId,provenance:session.mode},journal=await readFundingJournal(scope,tx),source=journal.sources.find(row=>row.receipt.id===receiptId)!,receipt=source.receipt;
    const packages=await query<{id:string;title:string}>("SELECT id,data->>'title' title FROM fp_packages WHERE project_id=$1",[session.projectId],tx),title=(id:string)=>packages.find(pkg=>pkg.id===id)?.title??id;
    const choices=await query<Parameters<typeof fundingChoiceContract>[0]&{executed_at:Date|null}>("SELECT * FROM fp_funding_choices WHERE tenant_id=$1 AND project_id=$2 AND receipt_id=$3 ORDER BY created_at,id",[session.tenantId,session.projectId,receiptId],tx);
    const origin=(await readFundingOrigins(scope,tx)).find(row=>row.receiptId===receiptId);
    const returns=await query<{id:string;amount_minor:string;state:string;created_at:Date;completed_at:Date|null}>("SELECT id,amount_minor,state,created_at,completed_at FROM fp_refunds WHERE tenant_id=$1 AND project_id=$2 AND receipt_id=$3 ORDER BY created_at,id",[session.tenantId,session.projectId,receiptId],tx);
    const outside=await query<Parameters<typeof externalReturnRecord>[0]>("SELECT * FROM fp_funding_external_returns WHERE tenant_id=$1 AND project_id=$2 AND receipt_id=$3 ORDER BY created_at,id",[session.tenantId,session.projectId,receiptId],tx);
    return{id:receiptId,version:source.version,originalPackageId:receipt.packageId,originalPackageVersion:origin?.packageVersion??null,originalTitle:origin?.title??`Original purpose: ${receipt.packageId}`,originalPurpose:origin?.purpose??null,sourceKind:receipt.sourceKind,referenceSuffix:receipt.actualProviderPaymentRef.slice(-8),provenance:receipt.provenance,observedAt:receipt.observedAt,grossMinor:receipt.grossSettledMinor,creditedMinor:receipt.creditedMinor,returnedMinor:receipt.completedAttributedRefundMinor,pendingReturnMinor:receipt.pendingAttributedRefundReserveMinor,
      positions:projectFundingPositions(journal,scope).positions.filter(row=>row.receiptId===receiptId).map(row=>({packageId:row.packageId,title:title(row.packageId),assignedMinor:row.assignedMinor,returnedMinor:row.refundedMinor,pendingReturnMinor:row.pendingRefundMinor,paidMinor:row.paidMinor,reservedMinor:row.reservedMinor,excludedMinor:row.excludedMinor,availableMinor:row.availableMinor})),
      decisions:journal.assignments.filter(row=>row.receiptId===receiptId).map(row=>{const choice=choices.find(choice=>choice.id===row.consentId),value=choice?fundingChoiceContract(choice):null;return{id:row.id,kind:row.kind,amountMinor:row.amountMinor,fromPackageId:row.debit.packageId,fromVersion:row.debit.packageVersion,toPackageId:row.credit.packageId,toVersion:row.credit.packageVersion,title:value?.destination?.title??`Saved purpose: ${row.credit.packageId}`,purpose:value?.destination?.purpose??"Original consent record unavailable; retain this as historical movement only.",consentedAt:row.consentedAt,committedAt:row.committedAt};}),
      returns:[...outside.map(row=>{const value=externalReturnRecord(row);return{id:row.id,amountMinor:value.amountMinor,state:"completed",requestedAt:row.created_at.toISOString(),completedAt:null,sample:receipt.provenance==="sample",reconciledOutside:true};}),...returns.map(row=>({id:row.id,amountMinor:Number(row.amount_minor),state:row.state,requestedAt:row.created_at.toISOString(),completedAt:row.completed_at?.toISOString()??null,sample:false})),...choices.filter(row=>receipt.provenance==="sample"&&row.kind==="return"&&row.state==="returned").map(row=>({id:row.id,amountMinor:Number(row.amount_minor),state:row.state,requestedAt:row.created_at.toISOString(),completedAt:row.executed_at?.toISOString()??null,sample:true}))].sort((a,b)=>a.requestedAt.localeCompare(b.requestedAt))};
  });await requireCurrentRole(session,session.role);return result;
}
