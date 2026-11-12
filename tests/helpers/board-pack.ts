import { randomUUID } from "node:crypto";
import { sha256 } from "@fracture/paypal-core";
import { createClaim, reviewClaim, saveClaimDraft } from "../../lib/server/claims";
import { importSampleReceipt } from "../../lib/server/documents";
import { database, query } from "../../lib/server/db";
import { sealPrivate } from "../../lib/server/private-values";
import { recordSampleFundingUse } from "../../lib/server/funding-adjustments";
import { storyReceipt, type StoryFixture } from "./supporter-story";

/** Explicitly fictional stored repayment history for report projection checks.
 * No gateway, provider identity, payment approval or external call is performed.
 * The private records say Sample and cannot establish a real repayment. */
export async function boardPackExpenseFixture(f: StoryFixture) {
  const document = await importSampleReceipt(f.volunteer, randomUUID(), "original", f.storage);
  let claim = await createClaim(f.volunteer, { documentId: document.id, runId: null, intentId: randomUUID() });
  const draft = [
    { id: "line-1", description: "Private Sample solder wire canary", requestedMinor: 1800, packageId: "electronics" },
    { id: "line-2", description: "Private Sample heat-shrink canary", requestedMinor: 1250, packageId: "electronics" },
  ];
  claim = await saveClaimDraft(f.volunteer, claim.id, { expectedVersion: claim.version, title: "Private Sample claimant expense canary", note: "Controlled report fixture only; no purchase or actual repayment.", currency: "USD", totalMinor: 8640, lines: draft }, true);
  claim = await reviewClaim(f.organizer, claim.id, { expectedVersion: claim.version, sourceTotalMinor: 8640, currency: "USD", note: "Controlled source review only, no independent person.", sourceChecked: true, sampleAcknowledged: true, receiptSplit: false, duplicateResolutions: [],
    lines: draft.map((line, index) => ({ id: line.id, description: line.description, packageId: line.packageId, sourceMinor: line.requestedMinor, approvedMinor: line.requestedMinor, receiptLineKey: String(index + 1), decision: "approved" as const, reviewNote: "Controlled source and scope checked.", uncertaintyResolved: true })) });
  const receipt = await storyReceipt(f, f.donors[0], "electronics", 96000);
  const recipientId = randomUUID(), balanceId = randomUUID(), earlier = new Date(Date.now() - 30_000).toISOString();
  const canaries = ["SAMPLE-NO-ACTUAL-PAYEE", "PRIVATE-SAMPLE-MERCHANT", "Private Sample claimant expense canary", ...draft.map(line => line.description)];
  const repayments: string[] = [];
  await database().transaction(async tx => {
    await tx.query("INSERT INTO fp_recipient_accounts(id,tenant_id,actor_id,encrypted_destination,masked_label,verification_method,account_verified,verified_at) VALUES($1,$2,$3,$4,'Sample recipient · unverified','controlled_sample',false,$5)", [recipientId, f.tenantId, f.volunteer.actorId, sealPrivate({ sample: true, destination: canaries[0] }, `board-pack-fixture-recipient:${recipientId}`), earlier]);
    await tx.query("INSERT INTO fp_balance_observations(id,merchant_scope,as_of_time,last_refresh_time,observed_at,available_minor,body_hash,encrypted_data) VALUES($1,$2,$3,$3,$3,500000,$4,$5)", [balanceId, canaries[1], earlier, sha256("Controlled Sample balance; no actual provider observation"), sealPrivate({ sample: true, noProviderCall: true }, `board-pack-fixture-balance:${balanceId}`)]);
    for (const [index, state] of ["succeeded", "queued"].entries()) {
      const id = randomUUID(), approvalId = randomUUID(), line = draft[index], paid = state === "succeeded", fee = paid ? 25 : 75;
      repayments.push(id);
      await tx.query("INSERT INTO fp_approval_records(id,tenant_id,project_id,actor_id,resource_id,resource_version,digest,expires_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)", [approvalId, f.tenantId, f.projectId, f.organizer.actorId, claim.id, claim.version, sha256(`Sample stored report fixture ${id}`), f.organizer.expiresAt, JSON.stringify({ sample: true, noActualApproval: true })]);
      await tx.query(`INSERT INTO fp_payables(id,tenant_id,project_id,merchant_scope,claim_id,claim_version,actor_id,session_id,membership_version,intent_id,recipient_id,recipient_version,recipient_label,amount_minor,fee_allowance_minor,actual_fee_minor,fee_state,approval_id,request_hash,encrypted_data,state,provider_status,balance_observation_id,observed_at,principal_paid_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,1,'Sample recipient', $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`, [id, f.tenantId, f.projectId, canaries[1], claim.id, claim.version, f.organizer.actorId, f.organizer.id, randomUUID(), recipientId, line.requestedMinor, fee, paid ? fee : null, paid ? "confirmed" : "reserved", approvalId, sha256(`fictional-payable:${id}`), sealPrivate({ sample: true, noProviderCall: true }, `board-pack-fixture-payable:${id}`), state, paid ? "SAMPLE_SUCCESS" : "SAMPLE_PENDING", balanceId, earlier, paid ? earlier : null]);
      await tx.query("INSERT INTO fp_payable_lines(payable_id,claim_id,claim_line_id,amount_minor,package_id) VALUES($1,$2,$3,$4,'electronics')", [id, claim.id, line.id, line.requestedMinor]);
      for (const kind of ["claim", "fee"] as const) {
        const allocationId = randomUUID(), amount = kind === "claim" ? line.requestedMinor : fee, allocationState = paid ? "paid" : "reserved";
        await tx.query("INSERT INTO fp_receipt_allocations(id,tenant_id,project_id,receipt_id,claim_id,claim_line_id,package_id,amount_minor,initial_amount_minor,state,kind,payable_id) VALUES($1,$2,$3,$4,$5,$6,'electronics',$7,$7,$8,$9,$10)", [allocationId, f.tenantId, f.projectId, receipt.id, claim.id, kind === "fee" ? `fee:${id}` : line.id, amount, allocationState, kind, id]);
        await tx.query("INSERT INTO fp_allocation_revisions(id,allocation_id,revision,receipt_id,payable_id,package_id,purpose,amount_minor,state,reason) VALUES($1,$2,1,$3,$4,'electronics',$5,$6,$7,'Fictional Sample report fixture; no provider payment occurred')", [randomUUID(), allocationId, receipt.id, id, kind === "fee" ? "provider_fee" : "reviewed_expense", amount, allocationState]);
        if (paid) await recordSampleFundingUse(tx, f.organizer, allocationId);
      }
    }
  });
  return { claim, document, receipt, repayments, earlier, canaries };
}
