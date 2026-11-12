import { randomUUID } from "node:crypto";
import type { SqlConnection } from "@fracture/paypal-core";
import { DomainError } from "../domain/money";
import { RECOGNITION_VERSION, recognitionCommandSchema, recognitionReceiptSchema, recognitionReviewSchema, type RecognitionCommand, type RecognitionReceipt, type RecognitionReview } from "../recognition/contracts";
import { query } from "./db";
import { openPrivate, sealPrivate } from "./private-values";
import { assertRecognitionAuthority, changedRecognition, recognitionAuthority, recognitionNow, recognitionSource,
  type RecognitionAuthority, type RecognitionRequest } from "./recognition-source";
import { commandContext, consentContext, consentForHead, eligibleConsent, ownRecognitionHead, publicConsentLabel, recognitionInputHash,
  recognitionTransaction, suppressionContext, suppressionHandleSchema, type RecognitionHead } from "./recognition-store";

interface CommandRow { id: string; intent_id: string; tenant_id: string; project_id: string; actor_id: string; role: string;
  session_id: string; session_hash: string; access_id: string; input_hash: string; receipt: RecognitionReceipt; }
const changedIntent = () => new DomainError("RECOGNITION_INTENT_CHANGED", "This original request belongs to different fields or access. Check its saved status before starting a new decision.", 409);
const versionChanged = () => new DomainError("RECOGNITION_VERSION_CHANGED", "Your public recognition choice changed. Reload it, then make a separate decision.", 409);
function commandMatches(row: CommandRow, authority: RecognitionAuthority) {
  return row.tenant_id === authority.session.tenantId && row.project_id === authority.session.projectId && row.actor_id === authority.session.actorId
    && row.session_id === authority.session.id && row.session_hash === authority.tokenHash && row.role === authority.session.role && row.access_id === authority.access.accessId;
}
async function lockedOwn(tx: SqlConnection, authority: RecognitionAuthority, slug: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`recognition-head:${authority.session.tenantId}:${authority.session.projectId}:${authority.session.actorId}:${authority.session.role}:${slug}`]);
  return ownRecognitionHead(tx, authority, slug, true);
}
async function suppressible(tx: SqlConnection, authority: RecognitionAuthority, input: Extract<RecognitionCommand, { action: "suppress" }>) {
  let handle: ReturnType<typeof suppressionHandleSchema.parse>;
  try { handle = suppressionHandleSchema.parse(openPrivate(input.handle, suppressionContext)); }
  catch { throw new DomainError("RECOGNITION_LABEL_UNAVAILABLE", "That public label is no longer available for this decision.", 404); }
  if (handle.accessId !== authority.access.accessId) throw changedRecognition();
  const [head] = await query<RecognitionHead>("SELECT * FROM fp_recognition_heads WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND slug=$4 FOR UPDATE",
    [handle.headId, authority.session.tenantId, authority.session.projectId, handle.slug], tx);
  if (!head || head.current_consent_id !== handle.consentId || head.version !== handle.version || head.version !== input.expectedVersion) throw versionChanged();
  const source = await recognitionSource(tx, head.slug, authority.session), consent = await consentForHead(tx, head);
  if (!await eligibleConsent(tx, head, consent, source)) throw new DomainError("RECOGNITION_LABEL_UNAVAILABLE", "That label is no longer currently public. Its private history stays with the participant.", 409);
  return { head, reviewKey: source!.target.reviewKey };
}

/** All effects and the immutable minimal receipt commit in one local transaction. */
export async function executeRecognitionCommand(request: RecognitionRequest, raw: unknown): Promise<RecognitionReceipt> {
  const input = recognitionCommandSchema.parse(raw);
  return recognitionTransaction(async tx => {
    const authority = await recognitionAuthority(tx, request, input);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`recognition-intent:${input.intentId}`]);
    await assertRecognitionAuthority(tx, request, authority);
    const [prior] = await query<CommandRow>("SELECT * FROM fp_recognition_commands WHERE intent_id=$1 FOR SHARE", [input.intentId], tx);
    if (prior) {
      if (!commandMatches(prior, authority) || prior.input_hash !== recognitionInputHash(input)) throw changedIntent();
      const receipt = recognitionReceiptSchema.parse(prior.receipt), serialized = JSON.stringify(receipt);
      await assertRecognitionAuthority(tx, request, authority);
      return JSON.parse(serialized) as RecognitionReceipt;
    }
    const participant = authority.session.role === "donor" || authority.session.role === "volunteer";
    if (input.action === "suppress" ? authority.session.role !== "organizer" : !participant)
      throw new DomainError("RECOGNITION_ROLE_DENIED", "Participants decide only for themselves. An organizer may only suppress an already public label.", 403);
    let head: RecognitionHead | null, sourceReview: { slug: string; key: string } | null = null;
    if (input.action === "suppress") {
      const result = await suppressible(tx, authority, input); head = result.head;
      sourceReview = { slug: head.slug, key: result.reviewKey };
    } else {
      head = await lockedOwn(tx, authority, input.slug);
      if ((head?.version ?? 0) !== input.expectedVersion) throw versionChanged();
    }
    await assertRecognitionAuthority(tx, request, authority);
    const at = await recognitionNow(tx), version = (head?.version ?? 0) + 1;
    let headId = head?.id ?? randomUUID();
    if (input.action === "consent") {
      const source = await recognitionSource(tx, input.slug, authority.session);
      if (!source || source.target.reviewKey !== input.reviewKey) throw new DomainError("RECOGNITION_SOURCE_CHANGED", "That public page or its permission changed. Review its current page before opting in.", 409);
      if (!authority.entry) throw new DomainError("RECOGNITION_INDEPENDENT_ENTRY_REQUIRED", "A current independent participant entry is required.", 403);
      sourceReview = { slug: input.slug, key: input.reviewKey };
      const id = randomUUID(), encrypted = sealPrivate({ label: input.label, publicVisibilityAcknowledged: true, selfDeclaredAcknowledged: true },
        consentContext({ id, tenant_id: authority.session.tenantId, project_id: authority.session.projectId }));
      await tx.query(`INSERT INTO fp_recognition_consents(id,head_id,tenant_id,project_id,actor_id,role,version,session_id,session_hash,membership_version,
        session_expires_at,entry_kind,entry_id,entry_expires_at,expires_at,slug,proof_snapshot_id,proof_hash,review_key,access_id,mode,encrypted_data,consented_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [id, headId, authority.session.tenantId, authority.session.projectId, authority.session.actorId, authority.session.role, version,
          authority.session.id, authority.tokenHash, authority.membershipVersion, authority.access.sessionExpiresAt, authority.entry.kind,
          authority.entry.id, authority.entry.expiresAt, authority.access.validUntil, input.slug, source.snapshotId, source.target.contentHash,
          input.reviewKey, authority.access.accessId, authority.session.mode, encrypted, at]);
      if (head) await tx.query("UPDATE fp_recognition_heads SET version=$2,state='consented',current_consent_id=$3,updated_at=$4 WHERE id=$1", [head.id, version, id, at]);
      else await tx.query("INSERT INTO fp_recognition_heads(id,tenant_id,project_id,actor_id,role,slug,version,state,current_consent_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'consented',$8,$9,$9)",
        [headId, authority.session.tenantId, authority.session.projectId, authority.session.actorId, authority.session.role, input.slug, version, id, at]);
    } else {
      if (!head || head.state !== "consented") throw new DomainError("RECOGNITION_ALREADY_PRIVATE", "This choice is already private. A new listing always needs a separate participant decision.", 409);
      headId = head.id;
      await tx.query("UPDATE fp_recognition_heads SET version=$2,state=$3,updated_at=$4 WHERE id=$1", [headId, version, input.action === "withdraw" ? "withdrawn" : "suppressed", at]);
    }
    const commandId = randomUUID();
    const receipt = recognitionReceiptSchema.parse({ schema: RECOGNITION_VERSION, intentId: input.intentId, commandId, action: input.action,
      outcome: "committed", version, committedAt: at });
    await tx.query(`INSERT INTO fp_recognition_commands(id,intent_id,tenant_id,project_id,actor_id,role,session_id,session_hash,access_id,input_hash,action,encrypted_input,receipt)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`, [commandId, input.intentId, authority.session.tenantId, authority.session.projectId, authority.session.actorId,
      authority.session.role, authority.session.id, authority.tokenHash, authority.access.accessId, recognitionInputHash(input), input.action,
      sealPrivate(input, commandContext(commandId)), JSON.stringify(receipt)]);
    const auditId = randomUUID();
    await tx.query("INSERT INTO fp_recognition_audit(id,command_id,head_id,kind,encrypted_data) VALUES($1,$2,$3,$4,$5)",
      [auditId, commandId, headId, input.action, sealPrivate({ actorId: authority.session.actorId, sessionId: authority.session.id, membershipVersion: authority.membershipVersion,
        originalSessionExpiresAt: authority.access.sessionExpiresAt, accessId: authority.access.accessId, reason: input.action === "suppress" ? input.reason : null }, `recognition-audit:${auditId}`)]);
    const serialized = JSON.stringify(receipt);
    if (sourceReview && (await recognitionSource(tx, sourceReview.slug, authority.session))?.target.reviewKey !== sourceReview.key)
      throw new DomainError("RECOGNITION_SOURCE_CHANGED", "The reviewed public page changed during this decision. No listing decision was committed.", 409);
    await assertRecognitionAuthority(tx, request, authority);
    return JSON.parse(serialized) as RecognitionReceipt;
  });
}
export async function readRecognitionCommand(request: RecognitionRequest, intentId: string, accessId: string): Promise<RecognitionReceipt> {
  return recognitionTransaction(async tx => {
    const authority = await recognitionAuthority(tx, request);
    if (accessId !== authority.access.accessId) throw changedRecognition();
    const [prior] = await query<CommandRow>("SELECT * FROM fp_recognition_commands WHERE intent_id=$1 FOR SHARE", [intentId], tx);
    if (!prior || !commandMatches(prior, authority)) throw new DomainError("RECOGNITION_COMMAND_NOT_FOUND", "This exact original access has no accepted receipt for that request. You may explicitly retry its unchanged request.", 404);
    const serialized = JSON.stringify(recognitionReceiptSchema.parse(prior.receipt));
    await assertRecognitionAuthority(tx, request, authority);
    return JSON.parse(serialized) as RecognitionReceipt;
  });
}

/** Current exact preview; creates no intent, audit, consent, session or control. */
export async function reviewRecognitionCommand(request: RecognitionRequest, raw: unknown): Promise<RecognitionReview> {
  const input = recognitionCommandSchema.parse(raw);
  return recognitionTransaction(async tx => {
    const authority = await recognitionAuthority(tx, request, input);
    if (input.action === "suppress" ? authority.session.role !== "organizer" : !["donor", "volunteer"].includes(authority.session.role))
      throw new DomainError("RECOGNITION_ROLE_DENIED", "Participants decide only for themselves. An organizer may only suppress an already public label.", 403);
    const [prior] = await query<CommandRow>("SELECT * FROM fp_recognition_commands WHERE intent_id=$1", [input.intentId], tx);
    if (prior) throw new DomainError("RECOGNITION_CHECK_ORIGINAL", "This request already has a saved result. Check its original receipt before making another decision.", 409);
    let slug: string, label: string | null = null, sourceKey: string | null = null;
    if (input.action === "suppress") {
      const result = await suppressible(tx, authority, input); slug = result.head.slug; sourceKey = result.reviewKey;
      label = publicConsentLabel(await consentForHead(tx, result.head));
    } else {
      slug = input.slug;
      const head = await ownRecognitionHead(tx, authority, slug);
      if ((head?.version ?? 0) !== input.expectedVersion) throw versionChanged();
      if (input.action === "consent") {
        const source = await recognitionSource(tx, slug, authority.session);
        if (!source || source.target.reviewKey !== input.reviewKey) throw new DomainError("RECOGNITION_SOURCE_CHANGED", "Review the current public page before making this choice.", 409);
        label = input.label; sourceKey = input.reviewKey;
      } else if (!head || head.state !== "consented") throw new DomainError("RECOGNITION_ALREADY_PRIVATE", "Your listing is already private.", 409);
    }
    const reviewedAt = await recognitionNow(tx), freshness = `${new Date(Date.parse(reviewedAt) + 30_000).toISOString().slice(0, -1)}000Z`;
    const review = recognitionReviewSchema.parse({ schema: RECOGNITION_VERSION, intentId: input.intentId, action: input.action, label, slug,
      proofHref: `/proof/${slug}`, wallHref: `/recognition/${slug}`, expectedVersion: input.expectedVersion, reviewedAt,
      validUntil: authority.access.validUntil < freshness ? authority.access.validUntil : freshness });
    const serialized = JSON.stringify(review);
    if (sourceKey && (await recognitionSource(tx, slug, authority.session))?.target.reviewKey !== sourceKey) throw new DomainError("RECOGNITION_SOURCE_CHANGED", "This public page changed during the preview. Reload before deciding.", 409);
    await assertRecognitionAuthority(tx, request, authority);
    return JSON.parse(serialized) as RecognitionReview;
  });
}
