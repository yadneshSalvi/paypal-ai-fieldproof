import type { SqlConnection } from "@fracture/paypal-core";
import { currentPledgeCommitment } from "../funding/pledges";
import type { Session } from "./auth";
import { query } from "./db";
import { pledgeContract, type PledgeRow } from "./purpose-store";

/** Promises are a separate measure from canonical collected funding. All
 * project and report consumers use the same current acceptance rules. */
export async function readFundingPromises(scope:Pick<Session,"tenantId"|"projectId"|"mode">,tx:SqlConnection,cutoff=Date.now()):Promise<Map<string,number>>{
  const obligations=await query<{id:string;package_id:string;amount_minor:string;channel:string;eligible:boolean|null;current_version:number;consent_id:string|null;consent_version:number|null;consent_state:string|null;withdrawn_at:Date|null;expires_at:Date|null;round_id:string|null;current_policy:boolean;has_receipt:boolean}>(`SELECT o.id,o.package_id,o.amount_minor,o.channel,(o.data->>'eligible')::boolean eligible,p.version current_version,
    c.id consent_id,c.package_version consent_version,c.status consent_state,c.withdrawn_at,c.expires_at,c.round_id,
    EXISTS(SELECT 1 FROM fp_funding_policies f WHERE f.tenant_id=o.tenant_id AND f.project_id=o.project_id AND f.package_id=o.package_id AND f.package_version=p.version) current_policy,
    EXISTS(SELECT 1 FROM fp_settlement_receipts r WHERE r.obligation_id=o.id AND r.tenant_id=o.tenant_id AND r.project_id=o.project_id) has_receipt
    FROM fp_obligations o JOIN fp_packages p ON p.project_id=o.project_id AND p.id=o.package_id LEFT JOIN fp_conditional_consents c ON c.obligation_id=o.id
    WHERE o.tenant_id=$1 AND o.project_id=$2 AND o.purpose='conditional_pledge' ORDER BY o.id`,[scope.tenantId,scope.projectId],tx);
  const pledges=await query<PledgeRow>("SELECT * FROM fp_purpose_pledges WHERE tenant_id=$1 AND project_id=$2",[scope.tenantId,scope.projectId],tx),byObligation=new Map(pledges.map(row=>[row.obligation_id,row]));
  const result=new Map<string,number>();
  for(const row of obligations){
    const pledge=byObligation.get(row.id);let amount=0;
    if(pledge){const value=pledgeContract(pledge);amount=value.packageVersion!==row.current_version?Number(pledge.collected_minor):currentPledgeCommitment({state:pledge.state,amountMinor:value.amountMinor,collectedMinor:Number(pledge.collected_minor),expiresAt:value.expiresAt,operationId:pledge.operation_id},cutoff);}
    else if(scope.mode==="sample"){
      if(row.eligible!==false&&!["withdrawn","cancelled","refunded"].includes(row.channel)&&(!row.current_policy||row.has_receipt))amount=Number(row.amount_minor);
    }else if(row.eligible&&row.consent_id&&!row.withdrawn_at&&row.consent_version===row.current_version&&["ready","collecting","collected"].includes(row.consent_state??"")&&(row.round_id||row.expires_at&&row.expires_at.getTime()>cutoff))amount=Number(row.amount_minor);
    result.set(row.package_id,(result.get(row.package_id)??0)+amount);
  }return result;
}
