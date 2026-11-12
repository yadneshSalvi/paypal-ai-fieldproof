import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError } from "../domain/money";
import * as C from "../lifecycle/contracts";
import { buildLifecycleDraft, lifecycleEventKey, personalLifecycleDrafts, verifyLifecycleDraft, verifyLifecycleSnapshot } from "../lifecycle/inbox";
import { lifecycleEmailPreview, lifecycleEventLabels } from "../lifecycle/presentation";
import { query } from "./db";
import {
  assertLifecyclePersonal, findLifecycleCommand, lifecycleAudit, lifecycleCutoff, lifecycleHash, lifecycleNow, lifecyclePrivateContext,
  lifecycleProjectActor, lifecycleRecipient, lifecycleTx, lifecycleUnavailable, lifecycleVersion, lifecycleWritable,
  requireLifecyclePersonal, saveLifecycleCommand,
  type LifecycleInboxRow, type LifecyclePersonalGrant, type LifecyclePreferenceHead, type LifecyclePreferenceRow, type LifecycleRequest,
} from "./lifecycle-core";
import { checkLifecyclePersonalSource, scanLifecyclePersonalSources, type LifecyclePersonalSource } from "./lifecycle-personal-sources";
import type { OrgTx } from "./organization-core";
import type { OrganizationProjectAuthority } from "./organization-projects";
import { openPrivate, sealPrivate } from "./private-values";

const allowedCategories = (role: "donor" | "volunteer"): C.LifecycleCategory[] => role === "donor" ? ["pledges", "contributions", "choices"] : ["repayments"];
const ownerValues = (authority: OrganizationProjectAuthority) => [authority.session.tenantId, authority.session.projectId, authority.session.actorId, authority.session.role];
/** Owns a repeatable-read transaction. Lock before its first snapshot query so
 * a first source withdrawal cannot hide behind an earlier default permission. */
export async function lifecyclePersonalTransaction<T>(work: (tx: OrgTx) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await lifecycleTx(async tx => { await tx.query("LOCK TABLE fp_plan_source_controls IN SHARE MODE"); return work(tx); }, true); }
    catch (error) {
      const busy = error instanceof DomainError && error.code === "ORG_COMMAND_BUSY" || error && typeof error === "object" && "code" in error && error.code === "23505";
      // A repeatable-read transaction may have waited behind the exact same
      // intent before its snapshot could see that committed receipt. Retry the
      // rolled-back local transaction once, with the identical input only.
      if (busy && attempt === 0) continue;
      if (busy) throw new DomainError("LIFECYCLE_BUSY", "Another lifecycle decision is finishing. Retain this exact request and try it again.", 409);
      throw error;
    }
  }
  throw new DomainError("LIFECYCLE_BUSY", "Retain this exact request and try it again.", 409);
}
const personalTransaction = lifecyclePersonalTransaction;
const grantSchema = z.object({ projectToken: z.string().min(1).max(1000), sessionId: z.string().min(1).max(240), tenantId: z.string().min(1).max(240), projectId: z.string().min(1).max(240), actorId: z.string().min(1).max(240), role: z.enum(["donor", "volunteer"]), membershipVersion: z.number().int().positive(), expiresAt: z.iso.datetime(), scope: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
function privateGrant(row: LifecyclePreferenceRow, head: LifecyclePreferenceHead): LifecyclePersonalGrant {
  try {
    const grant = grantSchema.parse(openPrivate(row.encrypted_grant, lifecyclePrivateContext("preference", row.id)));
    if (lifecycleHash(grant) !== row.content_hash || row.head_id !== head.id || grant.tenantId !== head.tenant_id || grant.projectId !== head.project_id || grant.actorId !== head.actor_id || grant.role !== head.role || grant.sessionId !== row.session_id || grant.membershipVersion !== row.membership_version || grant.expiresAt !== row.expires_at.toISOString() || row.recipient_binding_hash !== lifecycleHash({ tenantId: grant.tenantId, projectId: grant.projectId, actorId: grant.actorId, role: grant.role }) || row.categories.some(category => !allowedCategories(grant.role).includes(category))) throw lifecycleUnavailable();
    return grant;
  } catch { throw lifecycleUnavailable(); }
}
function originalGrantMatches(authority: OrganizationProjectAuthority, grant: LifecyclePersonalGrant) {
  return authority.scope === grant.scope && authority.session.id === grant.sessionId && authority.session.tenantId === grant.tenantId && authority.session.projectId === grant.projectId && authority.session.actorId === grant.actorId && authority.session.role === grant.role && authority.membershipVersion === grant.membershipVersion && authority.session.expiresAt === grant.expiresAt;
}
async function assertPersonalDeadline(tx: OrgTx, request: LifecycleRequest, authority: OrganizationProjectAuthority, expiresAt = authority.session.expiresAt) {
  if (Date.parse(expiresAt) <= (await lifecycleNow(tx)).getTime()) throw new DomainError("LIFECYCLE_AUTHORITY_ENDED", "The original private authorization deadline ended. A reload or retry cannot renew it.", 410);
  await assertLifecyclePersonal(tx, request, authority);
  if (Date.parse(expiresAt) <= (await lifecycleNow(tx)).getTime()) throw new DomainError("LIFECYCLE_AUTHORITY_ENDED", "The original private authorization deadline ended. A reload or retry cannot renew it.", 410);
}
async function personalAuthority(tx: OrgTx, request: LifecycleRequest, expected?: string) {
  const authority = await requireLifecyclePersonal(tx, request);
  if (expected !== undefined && expected !== authority.scope) throw new DomainError("LIFECYCLE_PROJECT_CHANGED", "The reviewed personal scope changed. Retain its original request and refresh the current profile.", 409);
  return authority;
}
async function preferenceFor(tx: OrgTx, authority: OrganizationProjectAuthority, lock = false) {
  const [head] = await query<LifecyclePreferenceHead>(`SELECT * FROM fp_lifecycle_preference_heads WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 AND role=$4${lock ? " FOR UPDATE" : ""}`, ownerValues(authority), tx);
  const [row] = head ? await query<LifecyclePreferenceRow>("SELECT * FROM fp_lifecycle_preference_versions WHERE head_id=$1 AND id=$2 AND version=$3", [head.id, head.current_version_id, head.version], tx) : [];
  if (head && !row) throw lifecycleUnavailable();
  const grant = row && head ? privateGrant(row, head) : null, now = await lifecycleNow(tx);
  let status: C.LifecyclePreferences["status"] = !row?.enabled ? "disabled" : row.expires_at <= now ? "expired" : !grant || !originalGrantMatches(authority, grant) ? "authority_changed" : "enabled";
  const reasons = status === "expired" ? ["The original opt-in deadline ended. It is never extended by observation or retry."] : status === "authority_changed" ? ["The opt-in belongs to a different original session, membership version or role. This profile needs its own explicit decision."] : [];
  const view = C.lifecyclePreferencesSchema.parse({ version: head?.version ?? 0, enabled: status === "enabled", categories: row?.categories ?? allowedCategories(authority.session.role as "donor" | "volunteer"), emailPreviews: status === "enabled" && row?.email_previews === true, history: row?.history_mode ?? "future_only", optedInAt: row?.opted_in_at.toISOString() ?? null, expiresAt: row?.expires_at.toISOString() ?? null, status, canEdit: true, reasons });
  return { head: head ?? null, row: row ?? null, grant, view };
}

interface SavedInbox {
  contractVersion: typeof C.LIFECYCLE_VERSION; eventKey: string; kind: C.LifecycleEventKind;
  source: LifecyclePersonalSource; snapshot: C.LifecycleSnapshot; content: C.LifecycleContent; emailPreview: C.LifecycleEmailPreview | null;
}
function savedInbox(row: LifecycleInboxRow): SavedInbox {
  try {
    const saved = openPrivate<SavedInbox>(row.encrypted_data, lifecyclePrivateContext("inbox", row.id)), snapshot = verifyLifecycleSnapshot(saved.snapshot), content = verifyLifecycleDraft(saved.content, snapshot);
    if (saved.contractVersion !== C.LIFECYCLE_VERSION || saved.eventKey !== row.event_key || saved.kind !== saved.source.fact.kind || lifecycleEventKey(saved.source.fact) !== row.event_key || saved.source.fact.sourceHash !== row.source_hash || saved.source.fact.recipientBindingHash !== row.recipient_binding_hash || saved.source.fact.role !== row.role || saved.source.fact.project.id !== row.project_id || saved.source.fact.effectiveAt !== row.occurred_at.toISOString() || snapshot.snapshotHash !== row.snapshot_hash || snapshot.asOf !== row.captured_at.toISOString() || content.contentHash !== row.content_hash || content.origin !== "deterministic") throw lifecycleUnavailable();
    if (saved.emailPreview && lifecycleHash(C.lifecycleEmailPreviewSchema.parse(saved.emailPreview)) !== lifecycleHash(lifecycleEmailPreview(content, snapshot.sources))) throw lifecycleUnavailable();
    return { ...saved, snapshot, content };
  } catch { throw lifecycleUnavailable(); }
}
async function inboxById(tx: OrgTx, authority: OrganizationProjectAuthority, id: string, lock = false) {
  const [row] = await query<LifecycleInboxRow>(`SELECT * FROM fp_lifecycle_inbox WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 AND role=$4 AND id=$5${lock ? " FOR UPDATE" : ""}`, [...ownerValues(authority), z.uuid().parse(id)], tx);
  if (!row) throw lifecycleUnavailable(); return row;
}
function itemMetadata(row: LifecycleInboxRow, status: "withdrawn" | "unavailable", reasons: string[], ownOriginal: boolean): C.LifecycleInboxItem {
  return C.lifecycleInboxItemSchema.parse({ id: row.id, version: row.version, readState: row.read_state, status, kind: null, title: null, occurredAt: null, recordedAt: row.created_at.toISOString(), provenance: null, contentHash: null, canRead: false, canArchive: ownOriginal && row.read_state !== "archived", canRestore: ownOriginal && row.read_state === "archived", reasons });
}
async function presentInbox(tx: OrgTx, authority: OrganizationProjectAuthority, row: LifecycleInboxRow) {
  const [original] = await query<LifecyclePreferenceRow>("SELECT * FROM fp_lifecycle_preference_versions WHERE id=$1", [row.preference_version_id], tx);
  const [head] = original ? await query<LifecyclePreferenceHead>("SELECT * FROM fp_lifecycle_preference_heads WHERE id=$1 AND tenant_id=$2 AND project_id=$3 AND actor_id=$4 AND role=$5", [original.head_id, ...ownerValues(authority)], tx) : [];
  if (!original || !head) return { item: itemMetadata(row, "unavailable", ["The original personal authorization cannot be verified."], false), saved: null };
  const grant = privateGrant(original, head), at = await lifecycleNow(tx);
  const ownOriginal = original.enabled && originalGrantMatches(authority, grant) && row.session_id === grant.sessionId && row.membership_version === grant.membershipVersion && row.recipient_binding_hash === original.recipient_binding_hash && row.expires_at.toISOString() === grant.expiresAt && row.expires_at > at;
  if (!ownOriginal) return { item: itemMetadata(row, "unavailable", ["Only the exact original current session, member version, role and fixed deadline can expose this earlier body."], false), saved: null };
  let saved: SavedInbox;
  try { saved = savedInbox(row); } catch { return { item: itemMetadata(row, "unavailable", ["The original captured content could not be verified."], true), saved: null }; }
  const checked = await checkLifecyclePersonalSource(tx, authority, saved.source, (await lifecycleNow(tx)).toISOString());
  if (["withdrawn", "unavailable"].includes(checked.status)) return { item: itemMetadata(row, checked.status as "withdrawn" | "unavailable", checked.reasons, true), saved: null };
  const historical = checked.status === "historical" || head.current_version_id !== original.id;
  const item = C.lifecycleInboxItemSchema.parse({ id: row.id, version: row.version, readState: row.read_state, status: historical ? "historical" : "current", kind: saved.kind, title: saved.content.title, occurredAt: row.occurred_at.toISOString(), recordedAt: row.created_at.toISOString(), provenance: saved.source.fact.provenance, contentHash: row.content_hash, canRead: true, canArchive: row.read_state !== "archived", canRestore: row.read_state === "archived", reasons: [...checked.reasons, ...(historical && checked.status !== "historical" ? ["These immutable earlier records remain under their original grant; a preference change stops or changes future capture only."] : [])] });
  return { item, saved };
}

const listInputSchema = z.object({ state: C.lifecycleReadStateSchema.nullable().optional(), before: z.string().max(500).optional() }).strict();
const inboxCursorSchema = z.object({ owner: z.string().regex(/^[a-f0-9]{64}$/), at: z.iso.datetime(), id: z.uuid() }).strict();
function inboxCursor(value: string | undefined, owner: string) {
  if (!value) return null;
  try { if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(); const parsed = inboxCursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))); if (parsed.owner !== owner) throw new Error(); return parsed; }
  catch { throw new DomainError("INVALID_INPUT", "This history position belongs to a different personal scope or filter. Refresh the first page.", 400); }
}
export async function lifecycleInbox(request: LifecycleRequest, raw: { state?: C.LifecycleReadState | null; before?: string } = {}): Promise<{ inbox: C.LifecycleInbox }> {
  const input = listInputSchema.parse(raw);
  return personalTransaction(async tx => {
    const authority = await personalAuthority(tx, request), preferences = await preferenceFor(tx, authority), filter = input.state ?? null;
    const owner = lifecycleHash({ scope: authority.scope, filter }), cursor = inboxCursor(input.before, owner);
    const rows = await query<LifecycleInboxRow>("SELECT * FROM fp_lifecycle_inbox WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 AND role=$4 AND ($5::text IS NULL OR read_state=$5) AND ($6::timestamptz IS NULL OR (created_at,id)<($6::timestamptz,$7::text)) ORDER BY created_at DESC,id DESC LIMIT $8", [...ownerValues(authority), filter, cursor?.at ?? null, cursor?.id ?? null, C.LIFECYCLE_PAGE_SIZE + 1], tx);
    const page = rows.slice(0, C.LIFECYCLE_PAGE_SIZE), items: C.LifecycleInboxItem[] = [];
    for (const row of page) items.push((await presentInbox(tx, authority, row)).item);
    const counts = { unread: 0, read: 0, archived: 0 };
    for (const row of await query<{ read_state: C.LifecycleReadState; count: string }>("SELECT read_state,count(*) count FROM fp_lifecycle_inbox WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 AND role=$4 GROUP BY read_state", ownerValues(authority), tx)) counts[row.read_state] = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(Number(row.count));
    const last = page.at(-1), value = C.lifecycleInboxSchema.parse({ scope: authority.scope, checkedAt: (await lifecycleNow(tx)).toISOString(), preferences: preferences.view, items, counts, filter, nextCursor: rows.length > C.LIFECYCLE_PAGE_SIZE && last ? Buffer.from(JSON.stringify({ owner, at: last.created_at.toISOString(), id: last.id })).toString("base64url") : null });
    // Parsing/serialization does not acknowledge an item or materialize events.
    JSON.stringify(value); await assertPersonalDeadline(tx, request, authority);
    for (let i = 0; i < page.length; i++) if (items[i].canRead) { const current = await presentInbox(tx, authority, page[i]); if (!current.saved || current.item.contentHash !== items[i].contentHash) throw new DomainError("LIFECYCLE_SOURCE_WITHDRAWN", "A source changed while this inbox was prepared. Its private content is withheld.", 410); }
    await assertPersonalDeadline(tx, request, authority); return { inbox: value };
  });
}
export async function lifecycleInboxDetail(request: LifecycleRequest, itemId: string): Promise<{ detail: C.LifecycleInboxDetail }> {
  z.uuid().parse(itemId);
  return personalTransaction(async tx => {
    const authority = await personalAuthority(tx, request), row = await inboxById(tx, authority, itemId), presented = await presentInbox(tx, authority, row), saved = presented.saved;
    const detail = C.lifecycleInboxDetailSchema.parse({ scope: authority.scope, checkedAt: (await lifecycleNow(tx)).toISOString(), item: presented.item, content: saved?.content ?? null, sources: saved?.snapshot.sources ?? [], emailPreview: saved?.emailPreview ?? null });
    JSON.stringify(detail); await assertPersonalDeadline(tx, request, authority);
    if (saved && !(await presentInbox(tx, authority, row)).saved) throw new DomainError("LIFECYCLE_SOURCE_WITHDRAWN", "The original source changed during this read. Its private wording is withheld.", 410);
    await assertPersonalDeadline(tx, request, authority); return { detail };
  });
}
export async function lifecyclePersonalSourceDetail(request: LifecycleRequest, itemId: string, sourceId: string): Promise<{ detail: C.LifecycleSourceDetail }> {
  z.uuid().parse(itemId); z.string().regex(/^[a-zA-Z0-9:_-]{1,180}$/).parse(sourceId);
  return personalTransaction(async tx => {
    const authority = await personalAuthority(tx, request), row = await inboxById(tx, authority, itemId), presented = await presentInbox(tx, authority, row);
    if (!presented.saved) throw new DomainError(presented.item.status === "withdrawn" ? "LIFECYCLE_SOURCE_WITHDRAWN" : "LIFECYCLE_AUTHORITY_ENDED", "This original private source is no longer available in the exact current authority and permission scope.", 410);
    const source = presented.saved.snapshot.sources.find(value => value.id === sourceId); if (!source) throw lifecycleUnavailable();
    const detail = C.lifecycleSourceDetailSchema.parse({ scope: authority.scope, source, asOf: row.captured_at.toISOString(), snapshotHash: row.snapshot_hash, status: presented.item.status, notices: presented.saved.snapshot.notices });
    JSON.stringify(detail); if (!(await presentInbox(tx, authority, row)).saved) throw new DomainError("LIFECYCLE_SOURCE_WITHDRAWN", "The original source permission changed during this read.", 410);
    await assertPersonalDeadline(tx, request, authority, row.expires_at.toISOString()); return { detail };
  });
}

function withReceiptAccounting(snapshot: C.LifecycleSnapshot, source: LifecyclePersonalSource): C.LifecycleSnapshot {
  if (source.notices?.length) { const { snapshotHash: _hash, ...body } = snapshot, value = { ...body, notices: [...body.notices, ...source.notices] }; snapshot = verifyLifecycleSnapshot({ ...value, snapshotHash: lifecycleHash(value) }); }
  if (!source.accounting) return snapshot;
  const sources = [...snapshot.sources], statements = [...snapshot.statements], event = lifecycleEventKey(source.fact), originalHash = lifecycleHash({ sourceHash: source.fact.sourceHash, accounting: source.accounting });
  const metrics = [["grossMinor", "Original gross payment", "Pago bruto original"], ["originalCreditMinor", "Originally credited support", "Apoyo acreditado originalmente"], ["retainedMinor", "Retained support across its recorded purposes", "Apoyo retenido entre sus fines registrados"], ["returnedMinor", "Completed attributed returns", "Devoluciones atribuidas completadas"], ["pendingReturnMinor", "Pending attributed return reserves", "Reservas de devoluciones atribuidas pendientes"]] as const;
  for (const [key, label, spanish] of metrics) {
    const body = { id: `accounting:${event}:${key}`, label, topic: "funding" as const, provenance: source.fact.provenance, value: C.lifecycleValueSchema.parse({ kind: "money", currency: source.fact.project.currency, minor: source.accounting[key] }), observedAt: snapshot.asOf, limitation: "Counters for this original payment at capture; no current purpose allocation, merchant balance or spendable amount is inferred." };
    const row = C.lifecycleSourceRowSchema.parse({ ...body, contentHash: lifecycleHash({ contract: C.LIFECYCLE_VERSION, ...body, originHash: originalHash }) }); sources.push(row);
    statements.push({ id: `accounting:${event}:${key}`, topic: "funding", english: `${label}: {{amount}}.`, spanish: `${spanish}: {{amount}}.`, values: [{ key: "amount", sourceId: row.id, sourceHash: row.contentHash }], citations: [{ sourceId: row.id, sourceHash: row.contentHash }] });
  }
  const { snapshotHash: _previous, ...original } = snapshot;
  const body = { ...original, basisHash: lifecycleHash({ eventBasis: snapshot.basisHash, originalHash }), sources: sources.sort((a, b) => a.id.localeCompare(b.id)), statements, notices: [...snapshot.notices, "The event amount, original gross, currently retained support and returns are separate facts. A moved contribution remains in its original payment history. Retained support includes any pending return reservation and does not establish an available balance or current purpose share."] };
  return verifyLifecycleSnapshot({ ...body, snapshotHash: lifecycleHash(body) });
}

async function materialize(tx: OrgTx, request: LifecycleRequest, authority: OrganizationProjectAuthority, preference: LifecyclePreferenceRow, view: C.LifecyclePreferences, cursor?: string) {
  const asOf = await lifecycleCutoff(tx), scanned = await scanLifecyclePersonalSources(tx, authority, { asOf, since: view.history === "future_only" ? view.optedInAt : null, cursor, binding: preference.id });
  const keys = scanned.sources.map(source => lifecycleEventKey(source.fact)), known = await query<{ event_key: string }>("SELECT event_key FROM fp_lifecycle_inbox WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 AND role=$4 AND event_key=ANY($5::text[])", [...ownerValues(authority), keys], tx);
  const generated = personalLifecycleDrafts({ facts: scanned.sources.map(source => source.fact), recipientBindingHash: lifecycleRecipient(authority), projectId: authority.session.projectId, role: authority.session.role, preferences: view, asOf, existingEventKeys: known.map(row => row.event_key) });
  let created = 0;
  for (const draft of generated.drafts) {
    const source = scanned.sources.find(source => lifecycleEventKey(source.fact) === draft.eventKey)!;
    const check = await checkLifecyclePersonalSource(tx, authority, source, asOf); if (!["current", "historical"].includes(check.status)) continue;
    await assertPersonalDeadline(tx, request, authority, preference.expires_at.toISOString());
    const snapshot = withReceiptAccounting(draft.snapshot, source), content = buildLifecycleDraft(snapshot, { title: lifecycleEventLabels[draft.kind] }), preview = preference.email_previews ? lifecycleEmailPreview(content, snapshot.sources) : null;
    const id = randomUUID(), saved: SavedInbox = { contractVersion: C.LIFECYCLE_VERSION, eventKey: draft.eventKey, kind: draft.kind, source, snapshot, content, emailPreview: preview };
    const result = await tx.query("INSERT INTO fp_lifecycle_inbox(id,tenant_id,project_id,actor_id,role,session_id,membership_version,preference_version_id,recipient_binding_hash,event_key,source_hash,snapshot_hash,content_hash,occurred_at,captured_at,expires_at,encrypted_data,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$15,$15) ON CONFLICT(tenant_id,project_id,actor_id,role,event_key) DO NOTHING RETURNING id", [id, ...ownerValues(authority), authority.session.id, authority.membershipVersion, preference.id, lifecycleRecipient(authority), draft.eventKey, source.fact.sourceHash, snapshot.snapshotHash, content.contentHash, draft.occurredAt, asOf, preference.expires_at.toISOString(), sealPrivate(saved, lifecyclePrivateContext("inbox", id))]);
    if (result.rows.length) {
      created++; await lifecycleAudit(tx, { tenantId: authority.session.tenantId, projectId: authority.session.projectId }, lifecycleProjectActor(authority), "personal_event_captured", id, { eventKey: draft.eventKey, preferenceVersionId: preference.id, sourceHash: source.fact.sourceHash, snapshotHash: snapshot.snapshotHash, contentHash: content.contentHash, occurredAt: draft.occurredAt, capturedAt: asOf, destination: null, sent: false });
    }
  }
  await assertPersonalDeadline(tx, request, authority, preference.expires_at.toISOString());
  return { checked: scanned.checked, created, skipped: scanned.skipped + scanned.sources.length - created, nextCursor: scanned.nextCursor };
}

export async function lifecycleSetPreferences(request: LifecycleRequest, raw: unknown): Promise<{ receipt: C.LifecycleReceipt }> {
  const input = C.lifecyclePreferencesInputSchema.parse(raw);
  return personalTransaction(async tx => {
    await lifecycleWritable(tx); const authority = await personalAuthority(tx, request, input.expectedScope), actor = lifecycleProjectActor(authority);
    const prior = await findLifecycleCommand(tx, actor, input, "preferences");
    if (prior) { await assertPersonalDeadline(tx, request, authority); return { receipt: prior }; }
    const categories = allowedCategories(authority.session.role as "donor" | "volunteer");
    if (input.categories.some(category => !categories.includes(category))) throw new DomainError("INVALID_INPUT", "Choose only this current role's own events: donor pledges, contributions and choices, or volunteer repayments.", 422);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`lifecycle-preference:${lifecycleRecipient(authority)}`]);
    const current = await preferenceFor(tx, authority, true); lifecycleVersion(current.head?.version ?? 0, input.expectedVersion, "personal preference");
    const id = randomUUID(), headId = current.head?.id ?? randomUUID(), version = (current.head?.version ?? 0) + 1;
    const optedInAt = await lifecycleCutoff(tx), grant: LifecyclePersonalGrant = { projectToken: request.projectToken!, sessionId: authority.session.id, tenantId: authority.session.tenantId, projectId: authority.session.projectId, actorId: authority.session.actorId, role: authority.session.role as "donor" | "volunteer", membershipVersion: authority.membershipVersion, expiresAt: authority.session.expiresAt, scope: authority.scope };
    if (!current.head) await tx.query("INSERT INTO fp_lifecycle_preference_heads(id,tenant_id,project_id,actor_id,role,version,current_version_id) VALUES($1,$2,$3,$4,$5,$6,$7)", [headId, ...ownerValues(authority), version, id]);
    await tx.query("INSERT INTO fp_lifecycle_preference_versions(id,head_id,version,session_id,membership_version,recipient_binding_hash,enabled,categories,email_previews,history_mode,opted_in_at,expires_at,encrypted_grant,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14)", [id, headId, version, authority.session.id, authority.membershipVersion, lifecycleRecipient(authority), input.enabled, JSON.stringify([...input.categories].sort()), input.emailPreviews, input.history, optedInAt, grant.expiresAt, sealPrivate(grant, lifecyclePrivateContext("preference", id)), lifecycleHash(grant)]);
    if (current.head) await tx.query("UPDATE fp_lifecycle_preference_heads SET version=$2,current_version_id=$3,updated_at=now() WHERE id=$1", [headId, version, id]);
    const next = await preferenceFor(tx, authority);
    if (input.enabled && input.history === "current_records") await materialize(tx, request, authority, next.row!, next.view);
    await lifecycleAudit(tx, { tenantId: authority.session.tenantId, projectId: authority.session.projectId }, actor, "personal_preferences_changed", headId, { version, enabled: input.enabled, categories: input.categories, history: input.history, emailPreviews: input.emailPreviews, optedInAt, expiresAt: grant.expiresAt, destination: null, sent: false });
    await assertPersonalDeadline(tx, request, authority, grant.expiresAt);
    const receipt = await saveLifecycleCommand(tx, actor, input, "preferences", { resourceId: headId, resourceVersion: version, message: input.enabled ? "Your exact current profile opted in to its selected private lifecycle records. Email output is an unsent preview only." : "Future personal lifecycle capture is disabled. Earlier records retain their original authority, source permissions and fixed deadline." });
    await assertPersonalDeadline(tx, request, authority, grant.expiresAt); return { receipt };
  });
}
export async function lifecycleSetInboxState(request: LifecycleRequest, itemId: string, raw: unknown): Promise<{ receipt: C.LifecycleReceipt }> {
  z.uuid().parse(itemId); const input = C.lifecycleInboxActionSchema.parse(raw), binding = { itemId, input };
  return personalTransaction(async tx => {
    await lifecycleWritable(tx); const authority = await personalAuthority(tx, request, input.expectedScope), actor = lifecycleProjectActor(authority);
    const prior = await findLifecycleCommand(tx, actor, input, "inbox_state", binding);
    if (prior) { await assertPersonalDeadline(tx, request, authority); return { receipt: prior }; }
    const row = await inboxById(tx, authority, itemId, true); lifecycleVersion(row.version, input.expectedVersion, "inbox record");
    const presented = await presentInbox(tx, authority, row);
    if (presented.item.contentHash !== input.contentHash) throw new DomainError("LIFECYCLE_SOURCE_CHANGED", "The exact private content or source availability changed. Review this item before another decision.", 409);
    const allowed = input.action === "read" ? presented.item.canRead : input.action === "archive" ? presented.item.canArchive : presented.item.canRestore;
    const already = input.action === "read" && presented.item.canRead && row.read_state === "read" || input.action === "archive" && presented.item.canRestore && row.read_state === "archived";
    if (!allowed && !already) throw new DomainError(presented.item.status === "withdrawn" ? "LIFECYCLE_SOURCE_WITHDRAWN" : "LIFECYCLE_AUTHORITY_ENDED", "This original item no longer permits that state decision in the exact current profile.", 410);
    let state: C.LifecycleReadState = input.action === "read" ? "read" : "archived";
    if (input.action === "unarchive") {
      const [priorRead] = await query<{ present: boolean }>("SELECT EXISTS(SELECT 1 FROM fp_lifecycle_inbox_events WHERE inbox_id=$1 AND action='read') present", [row.id], tx); state = priorRead.present ? "read" : "unread";
    }
    const version = row.version + (state === row.read_state ? 0 : 1);
    if (version !== row.version) {
      await tx.query("UPDATE fp_lifecycle_inbox SET version=$2,read_state=$3,updated_at=now() WHERE id=$1", [row.id, version, state]);
      await tx.query("INSERT INTO fp_lifecycle_inbox_events(id,inbox_id,version,actor_key,action) VALUES($1,$2,$3,$4,$5)", [randomUUID(), row.id, version, actor, input.action]);
    }
    await lifecycleAudit(tx, { tenantId: authority.session.tenantId, projectId: authority.session.projectId }, actor, "personal_inbox_state", row.id, { version, action: input.action, contentHash: input.contentHash });
    if (presented.saved && !(await presentInbox(tx, authority, row)).saved) throw new DomainError("LIFECYCLE_SOURCE_WITHDRAWN", "The original source changed during this decision.", 410);
    await assertPersonalDeadline(tx, request, authority, row.expires_at.toISOString());
    const receipt = await saveLifecycleCommand(tx, actor, input, "inbox_state", { resourceId: row.id, resourceVersion: version, message: state === "archived" ? "This original private record is archived." : state === "read" ? "This original private record is marked as read." : "This unread original record was restored from the archive." }, binding);
    await assertPersonalDeadline(tx, request, authority, row.expires_at.toISOString()); return { receipt };
  });
}

/** Shares lifecyclePersonalTransaction's ALREADY OPEN transaction. The caller
 * must acquire its initial source-control lock before any snapshot query and
 * commit/rollback its result. Equivalent transactions must preserve that order.
 * The supplied grant is verified against the actual encrypted current version;
 * a scheduler's credential is never substituted for this original project one. */
export async function observeLifecyclePersonalGrant(tx: OrgTx, preference: LifecyclePreferenceRow, suppliedGrant: LifecyclePersonalGrant, options: { cursor?: string } = {}) {
  const [context] = await query<{ isolation: string; locked: boolean }>("SELECT current_setting('transaction_isolation') isolation,EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation=to_regclass('fp_plan_source_controls') AND granted AND mode IN ('ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')) locked", [], tx);
  if (context.isolation !== "repeatable read" || !context.locked) throw new DomainError("INVALID_INPUT", "Observe an original personal grant inside lifecyclePersonalTransaction with its initial source-permission lock.", 400);
  await lifecycleWritable(tx);
  const [head] = await query<LifecyclePreferenceHead>("SELECT * FROM fp_lifecycle_preference_heads WHERE id=$1 FOR UPDATE", [preference.head_id], tx);
  if (!head || head.current_version_id !== preference.id || head.version !== preference.version) return { checked: 0, created: 0, skipped: 1, nextCursor: null };
  const [actual] = await query<LifecyclePreferenceRow>("SELECT * FROM fp_lifecycle_preference_versions WHERE id=$1 AND head_id=$2", [preference.id, head.id], tx);
  if (!actual || !actual.enabled) return { checked: 0, created: 0, skipped: 1, nextCursor: null };
  const grant = privateGrant(actual, head);
  if (lifecycleHash(grant) !== lifecycleHash(suppliedGrant)) throw lifecycleUnavailable();
  if (actual.expires_at <= await lifecycleNow(tx)) return { checked: 0, created: 0, skipped: 1, nextCursor: null };
  const request: LifecycleRequest = { organizationToken: null, libraryToken: null, browserKey: "", projectToken: grant.projectToken, personalScope: grant.scope };
  let authority: OrganizationProjectAuthority;
  try { authority = await personalAuthority(tx, request); }
  catch (error) { if (error instanceof DomainError && ["LIFECYCLE_AUTH_REQUIRED", "LIFECYCLE_AUTHORITY_ENDED", "LIFECYCLE_PROJECT_CHANGED"].includes(error.code)) return { checked: 0, created: 0, skipped: 1, nextCursor: null }; throw error; }
  if (!originalGrantMatches(authority, grant)) return { checked: 0, created: 0, skipped: 1, nextCursor: null };
  const view = (await preferenceFor(tx, authority)).view;
  if (!view.enabled) return { checked: 0, created: 0, skipped: 1, nextCursor: null };
  return materialize(tx, request, authority, actual, view, options.cursor);
}

const observerCursorSchema = z.object({ owner: z.literal("personal-observer-v1"), at: z.iso.datetime(), id: z.uuid(), resume: z.boolean(), versionId: z.uuid().nullable(), source: z.string().max(1000).nullable() }).strict();
/** Owns its bounded transactions. At most20 current grants and100 original
 * source candidates per grant are examined per call. Continue nextCursor to
 * finish long histories, then begin a new sweep to observe later transitions.
 * checked counts grants; skipped counts ineligible grants/source candidates. */
export async function observeLifecyclePersonal(raw: { limit?: number; before?: string } = {}): Promise<{ checked: number; created: number; skipped: number; nextCursor: string | null }> {
  const input = z.object({ limit: z.number().int().min(1).max(20).optional(), before: z.string().max(2500).optional() }).strict().parse(raw), limit = input.limit ?? 20;
  let cursor: z.infer<typeof observerCursorSchema> | null = null;
  if (input.before) {
    try { if (!/^[A-Za-z0-9_-]+$/.test(input.before)) throw new Error(); cursor = observerCursorSchema.parse(JSON.parse(Buffer.from(input.before, "base64url").toString("utf8"))); }
    catch { throw new DomainError("INVALID_INPUT", "This private observer position is unavailable. Begin a new bounded sweep.", 400); }
  }
  const heads = await personalTransaction(tx => query<LifecyclePreferenceHead>(`SELECT h.*,date_trunc('milliseconds',h.created_at) created_at FROM fp_lifecycle_preference_heads h JOIN fp_lifecycle_preference_versions v ON v.id=h.current_version_id AND v.head_id=h.id WHERE v.enabled AND ($1::timestamptz IS NULL OR (date_trunc('milliseconds',h.created_at),h.id)${cursor?.resume ? "<=" : "<"}($1::timestamptz,$2::text)) ORDER BY date_trunc('milliseconds',h.created_at) DESC,h.id DESC LIMIT $3`, [cursor?.at ?? null, cursor?.id ?? null, limit + 1], tx));
  let checked = 0, created = 0, skipped = 0;
  for (const head of heads.slice(0, limit)) {
    const result = await personalTransaction(async tx => {
      const [preference] = await query<LifecyclePreferenceRow>("SELECT * FROM fp_lifecycle_preference_versions WHERE head_id=$1 AND id=$2", [head.id, head.current_version_id], tx);
      if (!preference) return { checked: 0, created: 0, skipped: 1, nextCursor: null };
      const grant = privateGrant(preference, head), sourceCursor = cursor?.resume && cursor.id === head.id && cursor.versionId === preference.id ? cursor.source ?? undefined : undefined;
      return observeLifecyclePersonalGrant(tx, preference, grant, { cursor: sourceCursor });
    });
    checked++; created += result.created; skipped += result.skipped;
    if (result.nextCursor) return { checked, created, skipped, nextCursor: Buffer.from(JSON.stringify({ owner: "personal-observer-v1", at: head.created_at.toISOString(), id: head.id, resume: true, versionId: head.current_version_id, source: result.nextCursor })).toString("base64url") };
  }
  const last = heads.slice(0, limit).at(-1);
  return { checked, created, skipped, nextCursor: heads.length > limit && last ? Buffer.from(JSON.stringify({ owner: "personal-observer-v1", at: last.created_at.toISOString(), id: last.id, resume: false, versionId: null, source: null })).toString("base64url") : null };
}
