import { randomUUID } from "node:crypto";
import { sha256, type SqlConnection } from "@fracture/paypal-core";
import sharp from "sharp";
import type { TemplateId } from "../../lib/community/templates";
import type { Session } from "../../lib/server/auth";
import type { OrganizationProjectAggregateInput } from "../../lib/server/organization-project-aggregate";
import { database, query } from "../../lib/server/db";
import { createClaim, reviewClaim, saveClaimDraft } from "../../lib/server/claims";
import { createUploadDocument, finalizeDocument } from "../../lib/server/documents";
import { recordSampleFundingUse } from "../../lib/server/funding-adjustments";
import { sealPrivate } from "../../lib/server/private-values";
import { communityFixture } from "./community";
import { addActor, bytesHash, memoryStorage } from "./planning";
import { storyReceipt, type StoryFixture } from "./supporter-story";

/** Ordinary empty template entry, followed by explicitly synthetic actors in
 * the test's owned disposable schema. No actor, credential or payment is real. */
export async function organizationAggregateFixture(template: TemplateId = "makerspace"): Promise<StoryFixture & { token: string; expiresAt: string }> {
  const workspace = await communityFixture(template), organizer = workspace.session, donors = [await addActor(organizer, "donor"), await addActor(organizer, "donor")], auditor = await addActor(organizer, "auditor"), volunteer = await addActor(organizer), { storage, files } = memoryStorage();
  if (organizer.mode !== "sample") throw new Error("An ordinary controlled template fixture must be Sample.");
  return { tenantId: organizer.tenantId as ReturnType<typeof randomUUID>, projectId: organizer.projectId as ReturnType<typeof randomUUID>, mode: "sample", expiresAt: organizer.expiresAt, organizer, donors, auditor, volunteer, token: workspace.token, storage, files,
    actors: [organizer, ...donors, auditor, volunteer].map((session, index) => ({ key: `Controlled synthetic actor ${index}`, token: "", session })) };
}

export function organizationAggregateInput(f: Pick<Session, "tenantId" | "projectId" | "expiresAt">, overrides: Partial<OrganizationProjectAggregateInput> = {}): OrganizationProjectAggregateInput {
  return { tenantId: f.tenantId, projectId: f.projectId, linkId: randomUUID(), linkVersion: 1, consentRevision: 1, consentHash: "a".repeat(64), consentExpiresAt: f.expiresAt, disclosure: ["budget", "funding", "expenses", "evidence"], asOf: new Date().toISOString(), ...overrides };
}
export async function organizationAggregateRead<T>(input: OrganizationProjectAggregateInput, work: (tx: SqlConnection, exact: OrganizationProjectAggregateInput) => Promise<T>): Promise<T> {
  return database().transaction(async tx => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const [cutoff] = await query<{ as_of: Date }>("SELECT transaction_timestamp() as_of", [], tx);
    return work(tx, { ...input, asOf: cutoff.as_of.toISOString() });
  });
}

/** Controlled manual source, reviewed lines and stored fictional payout facts.
 * This adapts the real claim/allocation constructors to the ordinary template;
 * it never imports a walkthrough receipt, dispatches money or calls a provider. */
export async function organizationExpenseFixture(f: StoryFixture, terminal = false) {
  const canaries = [`PRIVATE-ORG-PAYEE-${randomUUID()}`, `PRIVATE-ORG-MERCHANT-${randomUUID()}`, `Private org expense claimant ${randomUUID()}`];
  const bytes = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#faf0db" } }).composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><text x="40" y="130" font-size="26">FICTIONAL ORGANIZATION AGGREGATE TEST</text><text x="40" y="180" font-size="20">No purchase, provider or independent person is claimed.</text></svg>') }]).png().toBuffer();
  const upload = await createUploadDocument(f.volunteer, { intentId: randomUUID(), filename: `Private org expense source ${randomUUID()}.png`, purpose: "receipt", contentType: "image/png", size: bytes.length, sha256: bytesHash(bytes), permissionConfirmed: true }, "sample_document");
  await f.storage.write(upload.pathname, bytes, "image/png");
  const document = await finalizeDocument(f.volunteer, upload.document.id, f.storage);
  let claim = await createClaim(f.volunteer, { documentId: document.id, runId: null, intentId: randomUUID() });
  const lines = [1800, 1250].map((requestedMinor, index) => ({ id: `line-${index + 1}`, description: `Private org expense line ${index + 1}`, requestedMinor, packageId: "printing" }));
  claim = await saveClaimDraft(f.volunteer, claim.id, { expectedVersion: claim.version, title: canaries[2], note: "Fictional stored test facts; no payment or inspection occurred.", currency: "USD", totalMinor: 3050, lines }, true);
  claim = await reviewClaim(f.organizer, claim.id, { expectedVersion: claim.version, sourceTotalMinor: 3050, currency: "USD", note: "Controlled synthetic source review only.", sourceChecked: true, sampleAcknowledged: true, receiptSplit: false, duplicateResolutions: [], lines: lines.map((line, index) => ({ id: line.id, description: line.description, packageId: line.packageId, sourceMinor: line.requestedMinor, approvedMinor: line.requestedMinor, receiptLineKey: String(index + 1), decision: "approved", reviewNote: "Synthetic source and scope checked.", uncertaintyResolved: true })) });
  const receipt = await storyReceipt(f, f.donors[1], "printing", 96000), recipientId = randomUUID(), balanceId = randomUUID(), earlier = new Date(Date.now() - 30_000).toISOString(), payables: string[] = [];
  await database().transaction(async tx => {
    await tx.query("INSERT INTO fp_recipient_accounts(id,tenant_id,actor_id,encrypted_destination,masked_label,verification_method,account_verified,verified_at) VALUES($1,$2,$3,$4,'Synthetic recipient · unverified','controlled_sample',false,$5)", [recipientId, f.tenantId, f.volunteer.actorId, sealPrivate({ sample: true, destination: canaries[0] }, `organization-test-recipient:${recipientId}`), earlier]);
    await tx.query("INSERT INTO fp_balance_observations(id,merchant_scope,as_of_time,last_refresh_time,observed_at,available_minor,body_hash,encrypted_data) VALUES($1,$2,$3,$3,$3,500000,$4,$5)", [balanceId, canaries[1], earlier, sha256("Fictional test balance; no provider observation"), sealPrivate({ sample: true, noProviderCall: true }, `organization-test-balance:${balanceId}`)]);
    for (const [index, line] of lines.entries()) {
      const id = randomUUID(), approvalId = randomUUID(), paid = index === 0, fee = paid ? 25 : 75; payables.push(id);
      await tx.query("INSERT INTO fp_approval_records(id,tenant_id,project_id,actor_id,resource_id,resource_version,digest,expires_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)", [approvalId, f.tenantId, f.projectId, f.organizer.actorId, claim.id, claim.version, sha256(`Fictional org approval ${id}`), f.organizer.expiresAt, JSON.stringify({ sample: true, noActualApproval: true })]);
      await tx.query(`INSERT INTO fp_payables(id,tenant_id,project_id,merchant_scope,claim_id,claim_version,actor_id,session_id,membership_version,intent_id,recipient_id,recipient_version,recipient_label,amount_minor,fee_allowance_minor,actual_fee_minor,fee_state,approval_id,request_hash,encrypted_data,state,provider_status,balance_observation_id,observed_at,principal_paid_at,principal_returned_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,1,'Fictional recipient',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`, [id, f.tenantId, f.projectId, canaries[1], claim.id, claim.version, f.organizer.actorId, f.organizer.id, randomUUID(), recipientId, line.requestedMinor, fee, paid ? fee : null, paid ? "confirmed" : "reserved", approvalId, sha256(`Fictional org payable ${id}`), sealPrivate({ sample: true, noProviderCall: true }, `organization-test-payable:${id}`), terminal ? paid ? "returned" : "failed" : paid ? "succeeded" : "queued", "SAMPLE_NOT_PROVIDER_OBSERVED", balanceId, paid ? earlier : null, paid ? earlier : null, terminal ? earlier : null]);
      await tx.query("INSERT INTO fp_payable_lines(payable_id,claim_id,claim_line_id,amount_minor,package_id) VALUES($1,$2,$3,$4,'printing')", [id, claim.id, line.id, line.requestedMinor]);
      for (const kind of ["claim", "fee"] as const) {
        const allocationId = randomUUID(), amount = kind === "claim" ? line.requestedMinor : fee, state = terminal && kind === "claim" || terminal && !paid ? "released" : paid ? "paid" : "reserved";
        await tx.query("INSERT INTO fp_receipt_allocations(id,tenant_id,project_id,receipt_id,claim_id,claim_line_id,package_id,amount_minor,initial_amount_minor,state,kind,payable_id) VALUES($1,$2,$3,$4,$5,$6,'printing',$7,$7,$8,$9,$10)", [allocationId, f.tenantId, f.projectId, receipt.id, claim.id, kind === "fee" ? `fee:${id}` : line.id, amount, state, kind, id]);
        await tx.query("INSERT INTO fp_allocation_revisions(id,allocation_id,revision,receipt_id,payable_id,package_id,purpose,amount_minor,state,reason) VALUES($1,$2,1,$3,$4,'printing',$5,$6,$7,'Fictional test facts; no real repayment')", [randomUUID(), allocationId, receipt.id, id, kind === "fee" ? "provider_fee" : "reviewed_expense", amount, state]);
        if (state === "paid") await recordSampleFundingUse(tx, f.organizer, allocationId);
      }
    }
  });
  return { document, claim, receipt, payables, canaries };
}
