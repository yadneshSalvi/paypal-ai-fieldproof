import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import type { FundingOrigin } from "../domain/funding-lots";
import type { FundingScope } from "../domain/funding-positions";
import { DomainError } from "../domain/money";
import { query } from "./db";
import { openPrivate, sealPrivate } from "./private-values";

interface SampleOrigin {
  schemaVersion:"sample-original-purpose-v1";id:string;tenantId:string;projectId:string;provenance:"sample";
  obligationId:string;packageId:string;packageVersion:number;donorActorId:string;amountMinor:number;title:string;purpose:string;
  statement:"Fictional starting contribution for the Sample walkthrough; no actual donor consent or provider payment.";
}
const context=(scope:Pick<FundingScope,"tenantId"|"projectId">,id:string)=>`sample-funding-origin:${scope.tenantId}:${scope.projectId}:${id}`;

/** New Sample seeds record their known original purpose at creation. A reader
 * never guesses a historical version from today's mutable package. */
export async function recordSampleOrigin(tx:SqlConnection,input:Omit<SampleOrigin,"schemaVersion"|"id"|"statement"|"provenance">):Promise<void>{
  const value:SampleOrigin={...input,id:`sample-origin:${input.obligationId}`,schemaVersion:"sample-original-purpose-v1",provenance:"sample",statement:"Fictional starting contribution for the Sample walkthrough; no actual donor consent or provider payment."};
  await tx.query("INSERT INTO fp_sample_funding_origins(id,tenant_id,project_id,obligation_id,package_id,package_version,digest,encrypted_data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[value.id,value.tenantId,value.projectId,value.obligationId,value.packageId,value.packageVersion,sha256(canonicalJson(value)),sealPrivate(value,context(value,value.id))]);
}
export async function readSampleOrigins(scope:FundingScope,tx:SqlConnection):Promise<FundingOrigin[]>{
  if(scope.provenance!=="sample")return[];
  const rows=await query<{id:string;obligation_id:string;package_id:string;package_version:number;digest:string;encrypted_data:string;actor_id:string;amount_minor:string;receipt_id:string;receipt_created_at:Date}>(`SELECT f.*,o.actor_id,o.amount_minor,r.id receipt_id,r.created_at receipt_created_at FROM fp_sample_funding_origins f
    JOIN fp_obligations o ON o.id=f.obligation_id AND o.tenant_id=f.tenant_id AND o.project_id=f.project_id AND o.package_id=f.package_id
    JOIN fp_settlement_receipts r ON r.obligation_id=o.id AND r.tenant_id=f.tenant_id AND r.project_id=f.project_id AND r.package_id=f.package_id AND r.provenance='sample'
    WHERE f.tenant_id=$1 AND f.project_id=$2 AND o.purpose='conditional_pledge' ORDER BY r.id`,[scope.tenantId,scope.projectId],tx);
  return rows.map(row=>{const value=openPrivate<SampleOrigin>(row.encrypted_data,context(scope,row.id));
    if(value.schemaVersion!=="sample-original-purpose-v1"||value.provenance!=="sample"||value.id!==row.id||value.tenantId!==scope.tenantId||value.projectId!==scope.projectId||value.obligationId!==row.obligation_id||value.packageId!==row.package_id||value.packageVersion!==row.package_version||value.donorActorId!==row.actor_id||value.amountMinor!==Number(row.amount_minor)||sha256(canonicalJson(value))!==row.digest)
      throw new DomainError("SAMPLE_ORIGIN_CHANGED","The fictional starting contribution no longer matches its saved original purpose.");
    return{receiptId:row.receipt_id,packageId:value.packageId,packageVersion:value.packageVersion,roundId:`sample-seed:${scope.projectId}:${value.packageId}`,consentId:value.id,consentVersion:1,consentDigest:row.digest,donorActorId:value.donorActorId,receiptCreatedAt:row.receipt_created_at.toISOString(),title:value.title,purpose:value.purpose};
  });
}
