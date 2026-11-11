import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import type { SettlementReceipt } from "../contracts";
import type { FundingJournal } from "../domain/funding-lots";
import { projectFundingPositions, type FundingAssignment, type FundingDeductions, type FundingScope } from "../domain/funding-positions";
import { DomainError, validateReceipt } from "../domain/money";
import { assignmentContext, deductionContext, readFundingJournal } from "./funding-positions";
import { query } from "./db";
import { sealPrivate } from "./private-values";

export function fundingSourceDigest(journal: FundingJournal, receiptId: string): string {
  const source=journal.sources.find(source=>source.receipt.id===receiptId);
  if (!source) throw new DomainError("FUNDING_SOURCE_MISSING","The original contribution is missing from the funding journal.");
  return sha256(canonicalJson({version:"funding-source-v1",source,
    assignments:journal.assignments.filter(entry=>entry.receiptId===receiptId).sort((a,b)=>a.sequence-b.sequence),
    deductions:journal.deductions.find(row=>row.receiptId===receiptId)??null}));
}

export async function appendFundingAssignment(tx:SqlConnection,scope:FundingScope,entry:FundingAssignment):Promise<void> {
  await tx.query(`INSERT INTO fp_funding_assignments(id,tenant_id,project_id,receipt_id,sequence,kind,amount_minor,debit_package_id,credit_package_id,consent_id,consent_digest,document_digest,encrypted_data,committed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[entry.id,scope.tenantId,scope.projectId,entry.receiptId,entry.sequence,entry.kind,entry.amountMinor,
    entry.debit.packageId,entry.credit.packageId,entry.consentId,entry.consentDigest,sha256(canonicalJson(entry)),sealPrivate(entry,assignmentContext(scope,entry.id)),entry.committedAt]);
}

/** The caller has locked original rounds, obligations and receipts. All changed
 * refund/exclusion counters are attributed in the same transaction as the new
 * receipt version. Alias-only observations carry attribution forward. */
export async function persistFundingReceipt(tx:SqlConnection,scope:FundingScope,current:{version:number;data:SettlementReceipt},next:SettlementReceipt,
  deltas:{packageId:string;refundedMinor?:number;pendingRefundMinor?:number;excludedMinor?:number}[]=[]):Promise<number> {
  validateReceipt(next);
  if (current.data.id!==next.id || current.data.tenantId!==scope.tenantId || current.data.projectId!==scope.projectId ||
    current.data.packageId!==next.packageId || current.data.donorObligationId!==next.donorObligationId || next.provenance!==scope.provenance)
    throw new DomainError("FUNDING_SOURCE_IDENTITY","A receipt update cannot change its original owner or purpose.");
  const journal=await readFundingJournal(scope,tx),source=journal.sources.find(source=>source.receipt.id===next.id);
  let attribution:FundingDeductions|null=null;
  if (source) {
    if (source.version!==current.version || canonicalJson(source.receipt)!==canonicalJson(current.data))
      throw new DomainError("FUNDING_SOURCE_CHANGED","The current contribution changed before its deduction was recorded.");
    projectFundingPositions(journal,scope);
    const saved=journal.deductions.find(row=>row.receiptId===next.id);
    attribution={receiptId:next.id,receiptVersion:current.version,positions:structuredClone(saved?.positions??[{
      packageId:current.data.packageId,refundedMinor:current.data.completedAttributedRefundMinor,
      pendingRefundMinor:current.data.pendingAttributedRefundReserveMinor,excludedMinor:current.data.excludedMinor,
    }])};
    for (const delta of deltas) {
      let part=attribution.positions.find(part=>part.packageId===delta.packageId);
      if (!part) attribution.positions.push(part={packageId:delta.packageId,refundedMinor:0,pendingRefundMinor:0,excludedMinor:0});
      for (const key of ["refundedMinor","pendingRefundMinor","excludedMinor"] as const) part[key]+=delta[key]??0;
    }
    attribution.positions.sort((a,b)=>a.packageId<b.packageId?-1:a.packageId>b.packageId?1:0);
  } else if (deltas.length) throw new DomainError("FUNDING_SOURCE_MISSING","A funding deduction needs an owned conditional contribution.");
  const [written]=await query<{version:number}>("UPDATE fp_settlement_receipts SET data=$4::jsonb WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND version=$5 RETURNING version",[next.id,scope.tenantId,scope.projectId,JSON.stringify(next),current.version],tx);
  if (!written) throw new DomainError("FUNDING_SOURCE_CHANGED","Reload the current receipt before recording its deduction.");
  if (attribution) {
    attribution.receiptVersion=written.version;
    // Replaying the same observed receipt must neither advance its version nor
    // replace an immutable earlier attribution.
    const digest=sha256(canonicalJson(attribution));
    const prior=await query<{document_digest:string}>("SELECT document_digest FROM fp_funding_deductions WHERE receipt_id=$1 AND receipt_version=$2",[next.id,written.version],tx);
    if (prior.length && prior[0].document_digest!==digest) throw new DomainError("FUNDING_ATTRIBUTION_CHANGED","The exact receipt version already has a different deduction attribution.");
    if (!prior.length) await tx.query("INSERT INTO fp_funding_deductions(receipt_id,receipt_version,tenant_id,project_id,document_digest,encrypted_data) VALUES($1,$2,$3,$4,$5,$6)",
      [next.id,written.version,scope.tenantId,scope.projectId,digest,sealPrivate(attribution,deductionContext(scope,next.id,written.version))]);
    projectFundingPositions({...journal,sources:journal.sources.map(source=>source.receipt.id===next.id?{receipt:next,version:written.version}:source),
      deductions:[...journal.deductions.filter(row=>row.receiptId!==next.id),attribution]},scope);
  }
  return written.version;
}
