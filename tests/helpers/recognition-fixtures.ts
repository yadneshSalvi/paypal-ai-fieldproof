import { randomBytes, randomUUID } from "node:crypto";
import { SUPPORTER_ACCESS_VERSION } from "../../lib/supporters/contracts";
import { tokenHash, type Session } from "../../lib/server/auth";
import { database, query } from "../../lib/server/db";
import { createProject } from "../../lib/server/seed";
import { createProofDerivative, createProofDraft, decideProofSnapshot, readProofDesk, reviewProofDerivative } from "../../lib/server/proof";
import { createReviewerInvite, redeemReviewerInvite } from "../../lib/server/planning-reviewer-access";
import { acceptSupporterInvite, createSupporterInvite, supporterDesk, supporterEntryScope, type SupporterEntryContext } from "../../lib/server/supporter-access";
import { sealPrivate } from "../../lib/server/private-values";
import { memoryStorage, uploadFixture } from "./planning";
import { readRecognitionDesk } from "../../lib/server/recognition-store";
import { RECOGNITION_VERSION, type RecognitionCommand } from "../../lib/recognition/contracts";

export const recognitionTestToken = () => randomBytes(32).toString("base64url");
export async function recognitionFixture(image = false) {
  const token = recognitionTestToken(), session: Session = { id: randomUUID(), tenantId: randomUUID(), projectId: randomUUID(), actorId: randomUUID(), role: "organizer",
    mode: "sample", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  await database().transaction(async tx => {
    await createProject(tx, session.tenantId, session.projectId, `recognition-controlled-${randomUUID()}`, "sample");
    await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,'[\"organizer\"]'::jsonb)", [session.tenantId, session.projectId, session.actorId]);
    await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,'organizer',$6)", [session.id, tokenHash(token), session.tenantId, session.projectId, session.actorId, session.expiresAt]);
  });
  const { storage } = memoryStorage(); let documentId: string | null = null;
  const derivativeIds: string[] = [];
  if (image) {
    const document = await uploadFixture(session, storage, "photo", "sample_document"); documentId = document.id;
    const saved = await createProofDerivative(session, { intentId: randomUUID(), documentId, page: 1, packageId: "electronics", crop: { x: 0, y: 0, width: 1, height: 1 }, masks: [] }, storage);
    const derivative = (await readProofDesk(session)).derivatives.find(row => row.id === saved.id)!;
    await reviewProofDerivative(session, saved.id, { intentId: randomUUID(), contentHash: derivative.contentHash, expectedVersion: derivative.reviewVersion, privacyChecked: true, publicSharingConfirmed: true });
    derivativeIds.push(saved.id);
  }
  const draft = await createProofDraft(session, { intentId: randomUUID(), packageId: "electronics", expectedVersion: 0, derivativeIds });
  let desk = await readProofDesk(session), snapshot = desk.snapshots.find(row => row.id === draft.id)!;
  await decideProofSnapshot(session, "review", { intentId: randomUUID(), snapshotId: snapshot.id, expectedVersion: desk.packages.find(row => row.id === "electronics")!.headVersion, contentHash: snapshot.contentHash, acknowledged: true });
  desk = await readProofDesk(session); snapshot = desk.snapshots.find(row => row.id === draft.id)!;
  const publication = await decideProofSnapshot(session, "publish", { intentId: randomUUID(), snapshotId: snapshot.id, expectedVersion: desk.packages.find(row => row.id === "electronics")!.headVersion, contentHash: snapshot.contentHash, acknowledged: true });
  return { session, token, request: { projectToken: token }, browserKey: recognitionTestToken(), slug: publication.slug, documentId, storage };
}
export type RecognitionFixture = Awaited<ReturnType<typeof recognitionFixture>>;
export async function recognitionDonor(f: RecognitionFixture, purpose: "donor" | "sponsor" = "donor", shortMs?: number) {
  let invitation: { token: string; id: string };
  if (shortMs === undefined) invitation = await createSupporterInvite(f.session, f.browserKey, { intentId: randomUUID(), expectedScope: (await supporterDesk(f.session)).scope,
    label: "Controlled private invitation", purpose, expiresHours: 1, acknowledged: true });
  else {
    // Initially short, explicitly synthetic nonfinancial boundary fixture. No
    // accepted invitation/session deadline is edited or renewed.
    const id = randomUUID(), token = randomBytes(48).toString("base64url"), context = `supporter-invite:${f.session.tenantId}:${f.session.projectId}:${id}`;
    await query(`INSERT INTO fp_supporter_invites(id,tenant_id,project_id,issuer_actor_id,issuer_session_id,issuer_membership_version,issuer_browser_hash,purpose,role,token_hash,encrypted_token,encrypted_data,expires_at)
      VALUES($1,$2,$3,$4,$5,1,$6,$7,'donor',$8,$9,$10,date_trunc('milliseconds',clock_timestamp())+$11::integer*interval '1 millisecond')`,
      [id, f.session.tenantId, f.session.projectId, f.session.actorId, f.session.id, tokenHash(f.browserKey), purpose, tokenHash(token), sealPrivate(token, `${context}:token`),
        sealPrivate({ label: "Initially short controlled recognition fixture", contractVersion: SUPPORTER_ACCESS_VERSION }, context), shortMs]);
    invitation = { id, token };
  }
  const context: SupporterEntryContext = { session: null, credentialHash: null, browserKey: recognitionTestToken() };
  const accepted = await acceptSupporterInvite({ token: invitation.token, intentId: randomUUID(), expectedScope: supporterEntryScope(context),
    displayName: "PRIVATE PROFILE CANARY never copied", contractVersion: SUPPORTER_ACCESS_VERSION, acknowledged: true }, context);
  return { ...accepted, request: { projectToken: accepted.sessionToken }, invitationId: invitation.id };
}
export async function recognitionVolunteer(f: RecognitionFixture) {
  const invitation = await createReviewerInvite(f.session, { intentId: randomUUID(), label: "Controlled separate volunteer", scopes: ["electrical_safety"], expiresHours: 1, acknowledged: true });
  const accepted = await redeemReviewerInvite({ token: invitation.token, redemptionNonce: randomUUID(), acknowledged: true }, null);
  return { ...accepted, request: { projectToken: accepted.sessionToken }, invitationId: invitation.id };
}
export async function recognitionConsentInput(request: { projectToken: string | null }, slug: string, label = "Asha R."): Promise<Extract<RecognitionCommand, { action: "consent" }>> {
  const desk = await readRecognitionDesk(request, slug), target = desk.targets.find(row => row.slug === slug)!;
  return { schema: RECOGNITION_VERSION, action: "consent", intentId: randomUUID(), accessId: desk.access.accessId, sessionExpiresAt: desk.access.sessionExpiresAt,
    expectedVersion: desk.own?.version ?? 0, slug, reviewKey: target.reviewKey, label, publicVisibilityAcknowledged: true, selfDeclaredAcknowledged: true };
}
export async function recognitionFingerprint(projectId: string) {
  const tables = ["fp_sessions", "fp_memberships", "fp_proof_heads", "fp_proof_snapshots", "fp_plan_source_controls", "fp_recognition_heads", "fp_recognition_consents", "fp_recognition_commands"];
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, await query(`SELECT * FROM ${table} WHERE project_id=$1 ORDER BY to_jsonb(${table})::text`, [projectId])])));
}
export const recognitionErrorCode = (code: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code;
