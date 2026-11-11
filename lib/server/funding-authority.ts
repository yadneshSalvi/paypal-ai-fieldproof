import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import type { FundingAssignment, FundingScope } from "../domain/funding-positions";
import { DomainError } from "../domain/money";
import type { FundingChoiceContract } from "../funding/contracts";
import { query } from "./db";
import { openPrivate } from "./private-values";

export const choiceContext = (scope: Pick<FundingScope,"tenantId"|"projectId">, id: string) => `funding-choice:${scope.tenantId}:${scope.projectId}:${id}`;
/** Consent is consumed at commit. Revocation and expiry prevent a future
 * assignment; they cannot erase an already executed, immutable donor decision.
 * Every journal entry used by a lot must have its exact durable decision. */
export async function assertCommittedFundingChoices(scope: FundingScope, entries: FundingAssignment[], tx: SqlConnection): Promise<void> {
  if (!entries.length) return;
  const rows=await query<{id:string;state:string;revoked_at:Date|null;executed_id:string|null;digest:string;encrypted_data:string}>(
    "SELECT id,state,revoked_at,executed_id,digest,encrypted_data FROM fp_funding_choices WHERE tenant_id=$1 AND project_id=$2 AND id=ANY($3::text[])",
    [scope.tenantId,scope.projectId,[...new Set(entries.map(entry=>entry.consentId))]],tx);
  for (const entry of entries) {
    const row=rows.find(row=>row.id===entry.consentId);
    if (!row || row.state!=="executed" || row.revoked_at || row.executed_id!==entry.id || row.digest!==entry.consentDigest)
      throw new DomainError("FUNDING_CONSENT_UNPROVEN","A funding lot is missing its exact executed donor decision.");
    const value=openPrivate<FundingChoiceContract>(row.encrypted_data,choiceContext(scope,row.id));
    if (sha256(canonicalJson(value))!==row.digest || value.id!==row.id || value.tenantId!==scope.tenantId || value.projectId!==scope.projectId || value.provenance!==scope.provenance ||
      value.authority!=="donor" || value.receiptId!==entry.receiptId || value.kind!==entry.kind || value.amountMinor!==entry.amountMinor || value.donorActorId!==entry.donorActorId ||
      value.sourcePackageId!==entry.debit.packageId || value.sourcePackageVersion!==entry.debit.packageVersion || value.destination?.packageId!==entry.credit.packageId ||
      value.destination.packageVersion!==entry.credit.packageVersion || value.consentedAt!==entry.consentedAt || value.expiresAt!==entry.consentExpiresAt)
      throw new DomainError("FUNDING_CONSENT_UNPROVEN","The saved donor choice does not match every side and version of its funding lot.");
  }
}
