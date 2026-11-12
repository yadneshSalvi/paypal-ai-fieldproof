import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SqlConnection } from "@fracture/paypal-core";
import type { z } from "zod";
import type { SettlementReceipt } from "../contracts";
import { DomainError } from "../domain/money";
import { packagePositionTotals } from "../domain/funding-positions";
import { readFundingProjection } from "./funding-positions";
import { proofDerivativeInput, proofDerivativeReview, proofDraftInput, proofDecisionInput, proofWithdrawInput, type ProofDesk, type ProofEvidence, type ProofPayload, type ProofSnapshotView, type PublicProof } from "../proof/contracts";
import type { Session } from "./auth";
import { database, initializeDatabase, query } from "./db";
import { documentPrivate, documentPreview, requireDocument, type DocumentRow } from "./documents";
import type { DocumentStorage } from "./document-storage";
import { planningDocumentStorage } from "./planning-sources";
import { lockPlanningAuthority, planningAction, planningHash, publishedPlan, sourceControl } from "./planning-store";
import { signoffViews } from "./planning-evidence";
import { requireCurrentRole } from "./membership";
import { openPrivate, sealPrivate } from "./private-values";
import { appendEvent } from "./repository";
import { renderProofImage } from "./proof-images";

interface Head { tenant_id: string; project_id: string; package_id: string; slug: string; version: number; current_snapshot_id: string | null; state: "private" | "published" | "withdrawn"; }
interface Derivative { id: string; tenant_id: string; project_id: string; package_id: string; document_id: string; content_hash: string; encrypted_data: string; version: number; state: "draft" | "reviewed" | "revoked"; reviewed_by: string | null; reviewer_membership_version: number | null; }
interface DerivativeData { documentVersion: number; documentHash: string; controlVersion: number; page: number; sourcePageHash: string; pathname: string; width: number; height: number; kind: "receipt" | "photo"; sample: boolean; crop: z.infer<typeof proofDerivativeInput>["crop"]; masks: z.infer<typeof proofDerivativeInput>["masks"]; }
interface Snapshot extends Omit<ProofSnapshotView, "contentHash" | "reviewedAt" | "publishedAt"> { tenant_id: string; project_id: string; package_id: string; revision: number; content_hash: string; encrypted_bindings: string; source_hash: string; reviewed_by: string | null; reviewer_membership_version: number | null; reviewed_at: Date | null; published_at: Date | null; }
interface Bindings { derivativeIds: string[]; signoffIds: string[]; planHash: string | null; }
const scope = (s: Pick<Session, "tenantId" | "projectId">) => [s.tenantId, s.projectId];
const context = (kind: string, row: { id: string; tenant_id: string; project_id: string }) => `proof-${kind}:${row.tenant_id}:${row.project_id}:${row.id}`;
const safeHash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const view = (row: Snapshot): ProofSnapshotView => ({ id: row.id, state: row.state, contentHash: row.content_hash, payload: row.payload, reviewedAt: row.reviewed_at?.toISOString() ?? null, publishedAt: row.published_at?.toISOString() ?? null });
const imageData = (row: Derivative) => openPrivate<DerivativeData>(row.encrypted_data, context("image", row));
function evidence(row: Derivative): ProofEvidence {
  const data = imageData(row);
  return { id: row.id, kind: data.kind, label: data.kind === "receipt" ? "Redacted receipt excerpt" : "Redacted image excerpt", contentHash: row.content_hash, reviewVersion: row.version, width: data.width, height: data.height, sample: data.sample };
}
async function head(session: Session, packageId: string, tx: SqlConnection): Promise<Head> {
  const [pkg] = await query("SELECT id FROM fp_packages WHERE project_id=$1 AND id=$2 FOR SHARE", [session.projectId, packageId], tx);
  if (!pkg) throw new DomainError("PACKAGE_NOT_FOUND", "Choose a package in this workspace.", 404);
  await tx.query("INSERT INTO fp_proof_heads(tenant_id,project_id,package_id,slug) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [...scope(session), packageId, randomBytes(18).toString("base64url")]);
  return (await query<Head>("SELECT * FROM fp_proof_heads WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3 FOR UPDATE", [...scope(session), packageId], tx))[0];
}
function versionCheck(row: Head, version: number) { if (row.version !== version) throw new DomainError("PROOF_VERSION_CHANGED", "The publication desk changed. Refresh and review the latest version before continuing.", 409); }
async function bump(row: Head, tx: SqlConnection) { await tx.query("UPDATE fp_proof_heads SET version=version+1,updated_at=now() WHERE project_id=$1 AND package_id=$2", [row.project_id, row.package_id]); }
async function reviewerCurrent(row: { tenant_id: string; project_id: string; reviewed_by: string | null; reviewer_membership_version: number | null }, tx: SqlConnection, lock = true) {
  if (!row.reviewed_by) return false;
  const [member] = await query<{ version: number; state: string; roles: string[] }>(`SELECT version,state,roles FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3${lock ? " FOR SHARE" : ""}`, [row.tenant_id, row.project_id, row.reviewed_by], tx);
  return !!member && member.state === "active" && member.roles.includes("organizer") && member.version === row.reviewer_membership_version;
}
async function currentDerivative(row: Derivative, tx: SqlConnection, reviewed = true, lock = true) {
  if (row.state === "revoked" || (reviewed && (row.state !== "reviewed" || !await reviewerCurrent(row, tx, lock)))) return false;
  const data = imageData(row);
  const [document] = await query<DocumentRow>(`SELECT * FROM fp_documents WHERE id=$1 AND tenant_id=$2 AND project_id=$3${lock ? " FOR SHARE" : ""}`, [row.document_id, row.tenant_id, row.project_id], tx);
  if (!document || document.state !== "ready" || document.version !== data.documentVersion || document.sha256 !== data.documentHash) return false;
  const control = await sourceControl(document, tx, false, lock);
  return control.permission === "allowed" && control.version === data.controlVersion && documentPrivate(document).pages.some(p => p.number === data.page && p.sha256 === data.sourcePageHash);
}
async function getDerivative(session: Pick<Session, "tenantId" | "projectId">, id: string, tx: SqlConnection, lock = true) {
  const [row] = await query<Derivative>(`SELECT * FROM fp_proof_derivatives WHERE id=$1 AND tenant_id=$2 AND project_id=$3${lock ? " FOR UPDATE" : ""}`, [id, ...scope(session)], tx);
  if (!row) throw new DomainError("PROOF_IMAGE_NOT_FOUND", "This public copy is not part of your workspace.", 404);
  return row;
}
export async function createProofDerivative(session: Session, raw: z.infer<typeof proofDerivativeInput>, storage: DocumentStorage = planningDocumentStorage()) {
  const input = proofDerivativeInput.parse(raw);
  return database().transaction(async tx => {
    await lockPlanningAuthority(session, ["organizer"], tx);
    return planningAction(session, input.intentId, "proof.image.create", input, tx, async () => {
      await head(session, input.packageId, tx);
      const [document] = await query<DocumentRow>("SELECT * FROM fp_documents WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR SHARE", [input.documentId, ...scope(session)], tx);
      if (!document || document.state !== "ready" || !document.sha256 || !["receipt", "photo"].includes(document.purpose)) throw new DomainError("PROOF_SOURCE_UNAVAILABLE", "Choose a validated receipt or photograph in this workspace.", 409);
      const control = await sourceControl(document, tx, true, true), page = documentPrivate(document).pages.find(p => p.number === input.page);
      if (control.permission !== "allowed" || !page) throw new DomainError("PROOF_SOURCE_UNAVAILABLE", "This source page is no longer available for sharing.", 409);
      const original = await storage.read(page.pathname, 20 * 1024 * 1024);
      if (original.contentType !== "image/png" || safeHash(original.bytes) !== page.sha256) throw new DomainError("PROOF_SOURCE_INTEGRITY", "The source page no longer matches its validated bytes.", 409);
      const id = randomUUID(), sample = document.provenance === "sample_document";
      const rendered = await renderProofImage(original.bytes, input.crop, input.masks, sample);
      const pathname = `fieldproof/${document.id}/public-proof/${id}/redacted.png`;
      await storage.write(pathname, rendered.bytes, "image/png");
      const data: DerivativeData = { documentVersion: document.version, documentHash: document.sha256, controlVersion: control.version, page: page.number, sourcePageHash: page.sha256, pathname,
        width: rendered.width, height: rendered.height, kind: document.purpose as "receipt" | "photo", sample, crop: input.crop, masks: input.masks };
      await tx.query("INSERT INTO fp_proof_derivatives(id,tenant_id,project_id,package_id,document_id,content_hash,encrypted_data,author_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [id, ...scope(session), input.packageId, document.id, rendered.sha256, sealPrivate(data, context("image", { id, tenant_id: session.tenantId, project_id: session.projectId })), session.actorId]);
      await appendEvent(tx, session, "proof.image_prepared", "A public copy is ready for review", "Opaque masks and the crop are flattened into a new private image. The original remains private; this copy is not published.");
      return { id };
    });
  });
}
export async function reviewProofDerivative(session: Session, id: string, raw: z.infer<typeof proofDerivativeReview>) {
  const input = proofDerivativeReview.parse(raw);
  return database().transaction(async tx => {
    const membershipVersion = await lockPlanningAuthority(session, ["organizer"], tx);
    return planningAction(session, input.intentId, "proof.image.review", { id, ...input }, tx, async () => {
      const row = await getDerivative(session, id, tx);
      if (row.version !== input.expectedVersion || row.content_hash !== input.contentHash || row.state !== "draft" || !await currentDerivative(row, tx, false)) throw new DomainError("PROOF_IMAGE_CHANGED", "Review the current source and exact rendered copy before sharing.", 409);
      await tx.query("UPDATE fp_proof_derivatives SET state='reviewed',reviewed_by=$2,reviewer_membership_version=$3,reviewed_at=now() WHERE id=$1", [id, session.actorId, membershipVersion]);
      await appendEvent(tx, session, "proof.image_reviewed", "A public copy passed its privacy review", "The organizer reviewed this exact rendered image for public sharing. Publication remains a separate action.");
      return { id };
    });
  });
}
export async function revokeProofDerivative(session: Session, id: string, intentId: string) {
  return database().transaction(async tx => {
    await lockPlanningAuthority(session, ["organizer"], tx);
    return planningAction(session, intentId, "proof.image.revoke", { id }, tx, async () => {
      const row = await getDerivative(session, id, tx);
      if (row.state !== "revoked") await tx.query("UPDATE fp_proof_derivatives SET state='revoked',version=version+1 WHERE id=$1", [id]);
      await appendEvent(tx, session, "proof.image_withdrawn", "A shared image was withdrawn", "Public pages using this version now withhold their content. Private originals and review history remain available.");
      return { id };
    });
  });
}

async function projection(session: Session, packageId: string, ids: string[], revision: number, cutoff: string, tx: SqlConnection): Promise<{ payload: ProofPayload; bindings: Bindings; sourceHash: string }> {
  const [project] = await query<{ metadata: { title: string }; projection_version: number }>("SELECT metadata,projection_version FROM fp_projects WHERE tenant_id=$1 AND id=$2 FOR SHARE", scope(session), tx);
  const [pkg] = await query<{ version: number; budget_minor: string; data: { title: string } }>("SELECT version,budget_minor,data FROM fp_packages WHERE project_id=$1 AND id=$2 FOR SHARE", [session.projectId, packageId], tx);
  if (!project || !pkg) throw new DomainError("PROOF_PACKAGE_UNAVAILABLE", "This package is no longer available.", 404);
  const allocation=await readFundingProjection({tenantId:session.tenantId,projectId:session.projectId,provenance:session.mode},tx);
  const positions=allocation.positions.filter(p=>p.packageId===packageId);
  const receiptIds=positions.map(p=>p.receiptId);
  const receipts = (await query<{ data: SettlementReceipt }>(`SELECT r.data FROM fp_settlement_receipts r JOIN fp_obligations o ON o.id=r.obligation_id AND o.project_id=r.project_id AND o.tenant_id=r.tenant_id
    WHERE r.tenant_id=$1 AND r.project_id=$2 AND r.id=ANY($3::text[]) AND o.purpose='conditional_pledge' ORDER BY r.id FOR SHARE OF r,o`, [...scope(session), receiptIds], tx)).map(r => r.data).filter(r => r.provenance === session.mode);
  const totals = packagePositionTotals(positions,packageId,Number(pkg.budget_minor));
  const images: ProofEvidence[] = [];
  for (const id of [...new Set(ids)].sort()) {
    const row = await getDerivative(session, id, tx);
    if (row.package_id !== packageId || !await currentDerivative(row, tx)) throw new DomainError("PROOF_IMAGE_UNREVIEWED", "Every selected image needs a current privacy review for this package.", 409);
    images.push(evidence(row));
  }
  const published = await publishedPlan(session, tx), currentPlan = published?.view.state === "current" ? published : null;
  const signoffs = (await signoffViews(session, tx, true)).filter(s => s.packageId === packageId && s.current);
  const payload: ProofPayload = {
    schema: "fieldproof.public-proof.v1", revision, cutoff, mode: session.mode,
    projectTitle: String(project.metadata.title).slice(0, 160), package: { id: packageId, title: String(pkg.data.title).slice(0, 160), version: pkg.version, targetMinor: Number(pkg.budget_minor) },
    funding: { ...totals, ordersMinor: positions.filter(r => r.sourceKind === "orders_capture").reduce((n, r) => n + r.collectedMinor, 0),
      invoiceMinor: positions.filter(r => r.sourceKind === "invoice_payment").reduce((n, r) => n + r.collectedMinor, 0),
      refundedMinor: positions.reduce((n, r) => n + r.refundedMinor, 0), excludedMinor: positions.reduce((n, r) => n + r.excludedMinor, 0), paymentCount: receipts.length,
      referenceSuffixes: receipts.slice(0, 20).map(r => r.actualProviderPaymentRef.replace(/[^a-zA-Z0-9]/g, "").slice(-4)) },
    evidence: images,
    signoffs: signoffs.map(s => ({ scope: s.scope, decision: s.decision, observedAt: s.observedAt, provenance: s.provenance, label: "Scoped project reviewer" })),
    plan: currentPlan ? { revision: currentPlan.row.revision, outline: currentPlan.view.outline, zones: currentPlan.view.zones.map(z => ({ polygon: z.polygon, selected: z.packageId === packageId })),
      requiredReviews: currentPlan.payload.plan.packages.find(p => p.packageId === packageId)?.requirements.filter(r => r.kind !== "photo_association").length ?? 0,
      acceptedReviews: signoffs.filter(s => s.decision === "accepted").length } : null,
    limitations: [session.mode === "sample" ? "Fictional demonstration. No real payment, purchase, installation or professional inspection is established." : "PayPal sandbox test funds. This record does not establish a real-world purchase or completed physical work.",
      "Funding is a dated receipt-ledger total, not a current merchant balance or permission to spend.", "An image is evidence for review, not a safety or completion certificate.", "Downloaded or printed copies cannot be recalled. Scan the QR code to check the current publication state."]
  };
  return { payload, bindings: { derivativeIds: images.map(i => i.id), signoffIds: signoffs.map(s => s.id), planHash: currentPlan?.row.content_hash ?? null }, sourceHash: planningHash({ payload, projectionVersion: project.projection_version }) };
}
export async function createProofDraft(session: Session, raw: z.infer<typeof proofDraftInput>) {
  const input = proofDraftInput.parse(raw);
  return database().transaction(async tx => {
    await lockPlanningAuthority(session, ["organizer"], tx);
    return planningAction(session, input.intentId, "proof.draft", input, tx, async () => {
      const current = await head(session, input.packageId, tx); versionCheck(current, input.expectedVersion);
      const [last] = await query<{ revision: number }>("SELECT COALESCE(max(revision),0) AS revision FROM fp_proof_snapshots WHERE project_id=$1 AND package_id=$2", [session.projectId, input.packageId], tx);
      const id = randomUUID(), cutoff = new Date().toISOString();
      const { payload, bindings, sourceHash } = await projection(session, input.packageId, input.derivativeIds, Number(last.revision) + 1, cutoff, tx);
      await tx.query("INSERT INTO fp_proof_snapshots(id,tenant_id,project_id,package_id,revision,payload,content_hash,encrypted_bindings,source_hash,author_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)",
        [id, ...scope(session), input.packageId, payload.revision, JSON.stringify(payload), planningHash(payload), sealPrivate(bindings, context("snapshot", { id, tenant_id: session.tenantId, project_id: session.projectId })), sourceHash, session.actorId]);
      await bump(current, tx);
      // No domain projection mutation: a draft must not invalidate its own funding cutoff.
      return { id };
    });
  });
}
async function snapshotForDecision(session: Session, input: z.infer<typeof proofDecisionInput>, tx: SqlConnection) {
  const [row] = await query<Snapshot>("SELECT * FROM fp_proof_snapshots WHERE id=$1 AND tenant_id=$2 AND project_id=$3 FOR UPDATE", [input.snapshotId, ...scope(session)], tx);
  if (!row) throw new DomainError("PROOF_NOT_FOUND", "This draft does not belong to your workspace.", 404);
  const current = await head(session, row.package_id, tx); versionCheck(current, input.expectedVersion);
  if (input.contentHash !== row.content_hash || planningHash(row.payload) !== row.content_hash) throw new DomainError("PROOF_HASH_CHANGED", "The reviewed page no longer matches this snapshot.", 409);
  const bindings = openPrivate<Bindings>(row.encrypted_bindings, context("snapshot", row));
  const fresh = await projection(session, row.package_id, bindings.derivativeIds, row.revision, row.payload.cutoff, tx);
  if (planningHash(fresh.payload) !== row.content_hash || planningHash(fresh.bindings) !== planningHash(bindings) || fresh.sourceHash !== row.source_hash) throw new DomainError("PROOF_SOURCE_CHANGED", "The source, funding or review state changed. Prepare and review a new snapshot.", 409);
  return { row, current };
}
export async function decideProofSnapshot(session: Session, decision: "review" | "publish", raw: z.infer<typeof proofDecisionInput>) {
  const input = proofDecisionInput.parse(raw);
  return database().transaction(async tx => {
    const membershipVersion = await lockPlanningAuthority(session, ["organizer"], tx);
    return planningAction(session, input.intentId, `proof.${decision}`, input, tx, async () => {
      const { row, current } = await snapshotForDecision(session, input, tx);
      if (decision === "review") {
        if (row.state !== "draft") throw new DomainError("PROOF_REVIEW_STATE", "Choose a draft that still needs review.", 409);
        await tx.query("UPDATE fp_proof_snapshots SET state='reviewed',reviewed_by=$2,reviewer_membership_version=$3,reviewed_at=now() WHERE id=$1", [row.id, session.actorId, membershipVersion]);
      } else {
        if (row.state !== "reviewed" || !await reviewerCurrent(row, tx)) throw new DomainError("PROOF_REVIEW_REQUIRED", "A current organizer must review this exact snapshot before publication.", 409);
        await tx.query("UPDATE fp_proof_snapshots SET state='superseded' WHERE project_id=$1 AND package_id=$2 AND state='published'", [session.projectId, row.package_id]);
        await tx.query("UPDATE fp_proof_snapshots SET state='published',published_at=now() WHERE id=$1", [row.id]);
        await tx.query("UPDATE fp_proof_heads SET state='published',current_snapshot_id=$3 WHERE project_id=$1 AND package_id=$2", [session.projectId, row.package_id, row.id]);
        await appendEvent(tx, session, "proof.published", "A reviewed public edition was published", "The exact funding cutoff, reviewed public copies and scoped sign-offs are bound to an immutable snapshot. The stable link checks current permissions.");
      }
      await bump(current, tx);
      return { id: row.id, slug: current.slug };
    });
  });
}
export async function withdrawProof(session: Session, packageId: string, raw: z.infer<typeof proofWithdrawInput>) {
  const input = proofWithdrawInput.parse(raw);
  return database().transaction(async tx => {
    await lockPlanningAuthority(session, ["organizer"], tx);
    return planningAction(session, input.intentId, "proof.withdraw", { packageId, ...input }, tx, async () => {
      const current = await head(session, packageId, tx); versionCheck(current, input.expectedVersion);
      await tx.query("UPDATE fp_proof_heads SET state='withdrawn',version=version+1,updated_at=now() WHERE project_id=$1 AND package_id=$2", [session.projectId, packageId]);
      await tx.query("UPDATE fp_proof_snapshots SET state='revoked' WHERE project_id=$1 AND package_id=$2 AND state IN ('published','superseded')", [session.projectId, packageId]);
      await appendEvent(tx, session, "proof.withdrawn", "The public page was withdrawn for review", "The stable QR now displays a minimal withdrawal notice. Previously downloaded and printed copies cannot be recalled.");
      return { slug: current.slug };
    });
  });
}

export async function readProofDesk(session: Session): Promise<ProofDesk> {
  await initializeDatabase(); await requireCurrentRole(session, "organizer");
  return database().transaction(async tx => {
    await lockPlanningAuthority(session, ["organizer"], tx);
    const packages = await query<{ id: string; version: number; budget_minor: string; data: { title: string }; head_version: number | null; slug: string | null; publication_state: Head["state"] | null }>(`SELECT p.*,h.version AS head_version,h.slug,h.state AS publication_state FROM fp_packages p LEFT JOIN fp_proof_heads h ON h.project_id=p.project_id AND h.package_id=p.id WHERE p.project_id=$1 ORDER BY p.id`, [session.projectId], tx);
    const rows = await query<Derivative>("SELECT * FROM fp_proof_derivatives WHERE tenant_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 150", scope(session), tx), derivatives: ProofDesk["derivatives"] = [];
    for (const row of rows) { const data = imageData(row); derivatives.push({ ...evidence(row), state: row.state, packageId: row.package_id, documentId: row.document_id, sourcePage: data.page, previewUrl: `/api/proof/images/${row.id}`, available: await currentDerivative(row, tx, false) }); }
    const sources: ProofDesk["sources"] = [];
    for (const doc of await query<DocumentRow>("SELECT * FROM fp_documents WHERE tenant_id=$1 AND project_id=$2 AND state='ready' AND purpose IN ('receipt','photo') ORDER BY created_at DESC LIMIT 150", scope(session), tx)) {
      if ((await sourceControl(doc, tx)).permission !== "allowed") continue;
      sources.push({ id: doc.id, purpose: doc.purpose as "receipt" | "photo", sample: doc.provenance === "sample_document", pages: documentPrivate(doc).pages.map(p => ({ number: p.number, width: p.width, height: p.height, previewUrl: `/api/proof/sources/${doc.id}?page=${p.number}` })) });
    }
    const packageViews: ProofDesk["packages"] = [];
    for (const p of packages) {
      let publicationState = p.publication_state ?? "private";
      if (publicationState === "published" && p.slug && (await publicRecord(p.slug, undefined, tx)).record.state !== "published") publicationState = "withdrawn";
      packageViews.push({ id: p.id, title: p.data.title, budgetMinor: Number(p.budget_minor), version: p.version, headVersion: p.head_version ?? 0, slug: p.slug, publicationState });
    }
    return { mode: session.mode, packages: packageViews, derivatives, sources,
      snapshots: (await query<Snapshot>("SELECT * FROM fp_proof_snapshots WHERE tenant_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 150", scope(session), tx)).map(view) };
  });
}
export async function privateProofImage(session: Session, id: string, storage: DocumentStorage = planningDocumentStorage()) {
  return database().transaction(async tx => {
    await lockPlanningAuthority(session, ["organizer"], tx);
    const row = await getDerivative(session, id, tx);
    if (!await currentDerivative(row, tx, false)) throw new DomainError("PROOF_IMAGE_UNAVAILABLE", "This source or public copy has been withdrawn.", 410);
    return readImage(row, storage);
  });
}
export async function privateProofSource(session: Session, id: string, page: number) {
  await requireCurrentRole(session, "organizer");
  const doc = await requireDocument(session, id);
  if (!["receipt", "photo"].includes(doc.purpose) || (await sourceControl(doc)).permission !== "allowed") throw new DomainError("PROOF_SOURCE_UNAVAILABLE", "This source is unavailable for public-copy review.", 410);
  return documentPreview(session, id, page, planningDocumentStorage());
}
async function readImage(row: Derivative, storage: DocumentStorage) {
  const data = imageData(row), file = await storage.read(data.pathname, 20 * 1024 * 1024);
  if (file.contentType !== "image/png" || safeHash(file.bytes) !== row.content_hash) throw new DomainError("PROOF_IMAGE_INTEGRITY", "This image cannot be verified.", 409);
  return file.bytes;
}
async function publicRecord(slug: string, revision: number | undefined, tx: SqlConnection, lock = true): Promise<{ record: PublicProof; row?: Snapshot }> {
  const empty: PublicProof = { slug, state: "unavailable", currentRevision: null, snapshot: null, history: [] };
  if (!/^[a-zA-Z0-9_-]{24}$/.test(slug)) return { record: empty };
  const [current] = await query<Head>(`SELECT * FROM fp_proof_heads WHERE slug=$1${lock ? " FOR SHARE" : ""}`, [slug], tx);
  if (!current || current.state === "private") return { record: empty };
  const withdrawn = { ...empty, state: "withdrawn" as const };
  if (current.state !== "published") return { record: withdrawn };
  const rows = await query<Snapshot>("SELECT * FROM fp_proof_snapshots WHERE tenant_id=$1 AND project_id=$2 AND package_id=$3 AND state IN ('published','superseded') ORDER BY revision DESC", [current.tenant_id, current.project_id, current.package_id], tx);
  const latest = rows.find(r => r.id === current.current_snapshot_id), row = revision === undefined ? latest : rows.find(r => r.revision === revision);
  if (!latest || !row || planningHash(row.payload) !== row.content_hash || !await reviewerCurrent(row, tx, lock)) return { record: withdrawn };
  const bindings = openPrivate<Bindings>(row.encrypted_bindings, context("snapshot", row));
  for (const image of row.payload.evidence) {
    const derivative = await getDerivative({ tenantId: row.tenant_id, projectId: row.project_id }, image.id, tx, lock);
    if (derivative.version !== image.reviewVersion || derivative.content_hash !== image.contentHash || !await currentDerivative(derivative, tx, true, lock)) return { record: withdrawn };
  }
  const readScope: Session = { id: "public-proof-read", actorId: "public", tenantId: row.tenant_id, projectId: row.project_id, role: "auditor", mode: row.payload.mode, expiresAt: new Date().toISOString() };
  if (bindings.planHash && (await publishedPlan(readScope, tx))?.view.state !== "current") return { record: withdrawn };
  if (bindings.planHash && (await publishedPlan(readScope, tx))?.row.content_hash !== bindings.planHash) return { record: withdrawn };
  if (bindings.signoffIds.length) {
    const currentSignoffs = await signoffViews(readScope, tx, true);
    if (bindings.signoffIds.some(id => !currentSignoffs.some(s => s.id === id && s.current))) return { record: withdrawn };
  }
  return { row, record: { slug, state: "published", currentRevision: latest.revision, snapshot: view(row), history: rows.map(r => ({ revision: r.revision, cutoff: r.payload.cutoff, contentHash: r.content_hash })) } };
}
/** The personal story consumes the SAME published, privacy-reviewed projection.
 * No private draft, original filename or unpublished derivative crosses here.
 * Its caller supplies a repeatable-read snapshot; image delivery still uses
 * the existing locking public read and checks current source permissions. */
export async function supporterProofRecords(session: Session, tx: SqlConnection) {
  await requireCurrentRole(session, session.role, tx);
  const heads = await query<Head>("SELECT * FROM fp_proof_heads WHERE tenant_id=$1 AND project_id=$2 AND state<>'private' ORDER BY package_id", scope(session), tx);
  const records: { packageId: string; proof: PublicProof; reviews: { id: string; reviewedAt: string | null; reviewerLabel: string | null }[] }[] = [];
  for (const head of heads) {
    let record:PublicProof;
    try { record=(await publicRecord(head.slug, undefined, tx, false)).record; }
    catch(error) {
      // A former publication may retain a head after its source is gone. Show
      // the unavailable edition, never a private substitute or cached image.
      if(!(error instanceof DomainError)||!["PROOF_IMAGE_NOT_FOUND","PLAN_NOT_FOUND","PROOF_IMAGE_INTEGRITY","PLAN_INTEGRITY"].includes(error.code))throw error;
      record={slug:head.slug,state:"withdrawn",currentRevision:null,snapshot:null,history:[]};
    }
    const reviews = [];
    for (const image of record.snapshot?.payload.evidence ?? []) {
      const [row] = await query<{ id: string; reviewed_at: Date | null; reviewed_by: string | null }>("SELECT id,reviewed_at,reviewed_by FROM fp_proof_derivatives WHERE id=$1 AND tenant_id=$2 AND project_id=$3", [image.id, ...scope(session)], tx);
      reviews.push({ id: image.id, reviewedAt: row?.reviewed_at?.toISOString() ?? null, reviewerLabel: row?.reviewed_by ? "Project organizer · privacy review" : null });
    }
    records.push({ packageId: head.package_id, proof: record, reviews });
  }
  return records;
}
export async function readPublicProof(slug: string, revision?: number): Promise<PublicProof> {
  await initializeDatabase();
  return database().transaction(async tx => (await publicRecord(slug, revision, tx)).record);
}
/** Reuses the exact publication and source-permission contract within a caller's
 * authorized database snapshot. The returned record never contains originals. */
export async function readPublicProofWithin(slug: string, revision: number, tx: SqlConnection): Promise<PublicProof> {
  return (await publicRecord(slug, revision, tx)).record;
}
/** A live, independently consented recognition wall uses only the latest
 * currently permitted public edition. It adds no name to immutable proofs. */
export async function readCurrentPublicProofWithin(slug: string, tx: SqlConnection): Promise<PublicProof> {
  return (await publicRecord(slug, undefined, tx)).record;
}
export async function publicProofImage(slug: string, id: string, revision?: number, storage: DocumentStorage = planningDocumentStorage()) {
  await initializeDatabase();
  return database().transaction(async tx => {
    const result = await publicRecord(slug, revision, tx), row = result.row;
    if (!row || !row.payload.evidence.some(e => e.id === id)) throw new DomainError("PUBLIC_PROOF_WITHDRAWN", "This public evidence is unavailable or withdrawn for review.", 410);
    return readImage(await getDerivative({ tenantId: row.tenant_id, projectId: row.project_id }, id, tx), storage);
  });
}
