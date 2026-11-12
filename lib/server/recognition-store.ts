import { canonicalJson, sha256, type SqlConnection } from "@fracture/paypal-core";
import { z } from "zod";
import { DomainError } from "../domain/money";
import { RECOGNITION_PAGE_SIZE, RECOGNITION_VERSION, recognitionDeskSchema, recognitionModerationPageSchema,
  recognitionPublicPageSchema, publicLabelSchema, type RecognitionDesk, type RecognitionModerationPage, type RecognitionOwn,
  type RecognitionPublicEntry, type RecognitionPublicPage } from "../recognition/contracts";
import { database, initializeDatabase, query } from "./db";
import { openPrivate, sealPrivate } from "./private-values";
import { assertRecognitionAuthority, consentAuthorityCurrent, preciseTimestamp, recognitionAuthority, recognitionNow,
  recognitionSource, recognitionTargets, type RecognitionAuthority, type RecognitionConsentAuthority, type RecognitionRequest, type RecognitionSource } from "./recognition-source";

export interface RecognitionHead { id: string; tenant_id: string; project_id: string; actor_id: string; role: "donor" | "volunteer"; slug: string;
  version: number; state: "consented" | "withdrawn" | "suppressed"; current_consent_id: string; }
export interface RecognitionConsent extends RecognitionConsentAuthority { id: string; head_id: string; version: number; slug: string; mode: "sample" | "live_sandbox";
  proof_snapshot_id: string; proof_hash: string; review_key: string; access_id: string; encrypted_data: string; at_ms: string; }
export const consentColumns = `c.*,${preciseTimestamp("c.session_expires_at")} session_deadline,${preciseTimestamp("c.entry_expires_at")} entry_deadline,
  ${preciseTimestamp("c.expires_at")} deadline,to_char(date_trunc('milliseconds',c.consented_at AT TIME ZONE 'UTC'),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at_ms`;
export const consentContext = (row: Pick<RecognitionConsent, "tenant_id" | "project_id" | "id">) => `recognition-consent:${row.tenant_id}:${row.project_id}:${row.id}`;
export const commandContext = (id: string) => `recognition-command:${id}`;
export const recognitionInputHash = (input: unknown) => sha256(canonicalJson(input));
export async function recognitionTransaction<T>(work: (tx: SqlConnection) => Promise<T>): Promise<T> {
  await initializeDatabase();
  try { return await database().transaction(async tx => {
    // FIRST statement, before any snapshot read. NOWAIT also bounds this first
    // table-lock wait without establishing a snapshot before the lock.
    await tx.query("LOCK TABLE fp_plan_source_controls IN SHARE MODE NOWAIT");
    await tx.query("SET LOCAL lock_timeout='4000ms'; SET LOCAL statement_timeout='12000ms'");
    const [ready] = await query<{ ready: boolean }>("SELECT to_regclass('fp_recognition_heads') IS NOT NULL AND to_regclass('fp_recognition_consents') IS NOT NULL AND to_regclass('fp_recognition_commands') IS NOT NULL AND to_regclass('fp_recognition_audit') IS NOT NULL ready", [], tx);
    if (!ready.ready) throw new DomainError("RECOGNITION_NOT_READY", "Public recognition is not available on this installation yet.", 503);
    const [guarded] = await query<{ ready: boolean }>(`SELECT count(*)=7 AND EXISTS(SELECT 1 FROM pg_constraint
      WHERE conrelid='fp_recognition_heads'::regclass AND confrelid='fp_recognition_consents'::regclass
        AND conname='fp_recognition_current_consent_scope' AND condeferrable AND convalidated) ready FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
      AND tgrelid=ANY(ARRAY['fp_recognition_heads'::regclass,'fp_recognition_consents'::regclass,'fp_recognition_commands'::regclass,'fp_recognition_audit'::regclass])
      AND tgname IN ('fp_recognition_consents_immutable','fp_recognition_commands_immutable','fp_recognition_audit_immutable',
        'fp_recognition_head_guard','fp_recognition_consent_lineage','fp_recognition_current_version','fp_recognition_command_lineage')`, [], tx);
    if (!guarded.ready) throw new DomainError("RECOGNITION_NOT_READY", "The recognition installation is awaiting its integrity guards.", 503);
    return work(tx);
  }); } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["55P03", "57014", "40P01"].includes(String(error.code)))
      throw new DomainError("RECOGNITION_BUSY", "A current permission is being changed. Reload its status before trying again.", 503);
    throw error;
  }
}
export async function ownRecognitionHead(tx: SqlConnection, authority: RecognitionAuthority, slug: string, lock = false): Promise<RecognitionHead | null> {
  const [row] = await query<RecognitionHead>(`SELECT * FROM fp_recognition_heads WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 AND role=$4 AND slug=$5${lock ? " FOR UPDATE" : " FOR SHARE"}`,
    [authority.session.tenantId, authority.session.projectId, authority.session.actorId, authority.session.role, slug], tx);
  return row ?? null;
}
export async function consentForHead(tx: SqlConnection, head: RecognitionHead): Promise<RecognitionConsent> {
  const [row] = await query<RecognitionConsent>(`SELECT ${consentColumns} FROM fp_recognition_consents c WHERE c.id=$1 AND c.head_id=$2 AND c.tenant_id=$3 AND c.project_id=$4 FOR SHARE`, [head.current_consent_id, head.id, head.tenant_id, head.project_id], tx);
  if (!row) throw new DomainError("RECOGNITION_HISTORY_UNAVAILABLE", "This decision's original history could not be checked. It remains private.", 409);
  return row;
}
export function publicConsentLabel(row: RecognitionConsent): string {
  return z.object({ label: publicLabelSchema, publicVisibilityAcknowledged: z.literal(true), selfDeclaredAcknowledged: z.literal(true) }).strict()
    .parse(openPrivate(row.encrypted_data, consentContext(row))).label;
}
export async function eligibleConsent(tx: SqlConnection, head: RecognitionHead, row: RecognitionConsent, source: RecognitionSource | null): Promise<boolean> {
  return head.state === "consented" && !!source && row.proof_snapshot_id === source.snapshotId && row.proof_hash === source.target.contentHash
    && row.review_key === source.target.reviewKey && source.tenantId === row.tenant_id && source.projectId === row.project_id
    && await consentAuthorityCurrent(tx, row);
}
async function ownView(tx: SqlConnection, authority: RecognitionAuthority, slug: string): Promise<RecognitionOwn> {
  const head = await ownRecognitionHead(tx, authority, slug);
  if (!head) return { version: 0, state: "private", label: null, expiresAt: null };
  if (head.state !== "consented") return { version: head.version, state: head.state, label: null, expiresAt: null };
  const consent = await consentForHead(tx, head), source = await recognitionSource(tx, slug, authority.session);
  const available = consent.access_id === authority.access.accessId && await eligibleConsent(tx, head, consent, source);
  return { version: head.version, state: available ? "listed" : "withheld", label: available ? publicConsentLabel(consent) : null, expiresAt: consent.deadline };
}
/** Serialization occurs before the last current-authority and source checks. */
export async function readRecognitionDesk(request: RecognitionRequest, selectedSlug?: string, expectedAccessId?: string): Promise<RecognitionDesk> {
  return recognitionTransaction(async tx => {
    const authority = await recognitionAuthority(tx, request);
    if (expectedAccessId && expectedAccessId !== authority.access.accessId) throw new DomainError("RECOGNITION_CONTEXT_CHANGED", "Another tab changed this project profile. Reload to view its current recognition choices.", 409);
    const targets = await recognitionTargets(tx, authority);
    let slug = selectedSlug ?? targets[0]?.slug ?? null;
    if (!slug && authority.session.role !== "organizer") {
      const [own] = await query<{ slug: string }>("SELECT slug FROM fp_recognition_heads WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 AND role=$4 ORDER BY updated_at DESC,id DESC LIMIT 1 FOR SHARE", [authority.session.tenantId, authority.session.projectId, authority.session.actorId, authority.session.role], tx);
      slug = own?.slug ?? null;
    }
    if (selectedSlug && !targets.some(target => target.slug === selectedSlug)) {
      if (authority.session.role === "organizer" || !await ownRecognitionHead(tx, authority, selectedSlug)) throw new DomainError("RECOGNITION_TARGET_UNAVAILABLE", "That public page is unavailable in your current project.", 404);
    }
    const desk = recognitionDeskSchema.parse({ schema: RECOGNITION_VERSION, kind: authority.session.role === "organizer" ? "organizer" : "participant",
      access: authority.access, targets, selectedSlug: slug, own: authority.session.role === "organizer" || !slug ? null : await ownView(tx, authority, slug), observedAt: await recognitionNow(tx) });
    const serialized = JSON.stringify(desk);
    await assertRecognitionAuthority(tx, request, authority);
    for (const target of targets) if ((await recognitionSource(tx, target.slug, authority.session))?.target.reviewKey !== target.reviewKey) throw new DomainError("RECOGNITION_SOURCE_CHANGED", "The public page changed during this read. Reload to review its current permission.", 409);
    if (desk.own?.label && desk.selectedSlug) {
      const current = await ownView(tx, authority, desk.selectedSlug);
      if (current.state !== "listed" || current.version !== desk.own.version) throw new DomainError("RECOGNITION_SOURCE_CHANGED", "Your public listing changed during this read. Reload its current state.", 409);
    }
    return JSON.parse(serialized) as RecognitionDesk;
  });
}

const cursorSchema = z.object({ slug: z.string(), sourceKey: z.string(), at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/), id: z.uuid(), cutoff: z.string() }).strict();
function decodeCursor(value: string | undefined, slug: string, sourceKey: string) {
  if (!value) return null;
  try {
    const decoded = cursorSchema.parse(openPrivate(value, "recognition-page-cursor"));
    if (decoded.slug !== slug || decoded.sourceKey !== sourceKey) throw new Error();
    return decoded;
  } catch { throw new DomainError("RECOGNITION_PAGE_CHANGED", "This wall's current permission or page changed. Return to its first page.", 409); }
}
export const suppressionContext = "recognition-suppression-handle";
export const suppressionHandleSchema = z.object({ headId: z.uuid(), consentId: z.uuid(), version: z.number().int().positive(), slug: z.string(), accessId: z.string() }).strict();
const earlier = (a: string, b: string) => a < b ? a : b;
const freshUntil = (at: string) => `${new Date(Date.parse(at) + 5_000).toISOString().slice(0, -1)}000Z`;
interface PageRow extends RecognitionConsent { head_version: number; head_state: RecognitionHead["state"]; }
async function wallPage(tx: SqlConnection, slug: string, cursor: string | undefined, moderator: RecognitionAuthority | null) {
  const at = await recognitionNow(tx), source = await recognitionSource(tx, slug, moderator?.session);
  if (!source) return { source: null, entries: [], nextCursor: null, observedAt: at, validUntil: freshUntil(at), retained: [] as PageRow[] };
  const start = decodeCursor(cursor, slug, source.target.reviewKey), cutoff = start?.cutoff ?? at;
  let last = start ? { at: start.at, id: start.id } : null, exhausted = false, scanned = 0;
  const retained: PageRow[] = [];
  // A read examines at most512 candidates. An empty continuation is possible;
  // no private count or individual exclusion reason is ever emitted.
  while (retained.length <= RECOGNITION_PAGE_SIZE && !exhausted && scanned < 512) {
    const rows: PageRow[] = await query<PageRow>(`SELECT ${consentColumns},h.version head_version,h.state head_state
      FROM fp_recognition_consents c JOIN fp_recognition_heads h ON h.current_consent_id=c.id AND h.id=c.head_id
      WHERE c.slug=$1 AND c.tenant_id=$2 AND c.project_id=$3 AND c.proof_snapshot_id=$4 AND c.proof_hash=$5 AND c.review_key=$6
        AND h.state='consented' AND c.expires_at>clock_timestamp() AND c.consented_at<=$7::timestamptz
        AND ($8::timestamp IS NULL OR (date_trunc('milliseconds',c.consented_at AT TIME ZONE 'UTC'),c.id)>($8::timestamp,$9::text))
      ORDER BY date_trunc('milliseconds',c.consented_at AT TIME ZONE 'UTC'),c.id LIMIT 32 FOR SHARE OF h,c`,
      [slug, source.tenantId, source.projectId, source.snapshotId, source.target.contentHash, source.target.reviewKey, cutoff, last?.at ?? null, last?.id ?? ""], tx);
    exhausted = rows.length < 32;
    for (const row of rows) {
      scanned++; last = { at: row.at_ms, id: row.id };
      if (await consentAuthorityCurrent(tx, row)) retained.push(row);
      if (retained.length > RECOGNITION_PAGE_SIZE) break;
    }
  }
  const visible = retained.slice(0, RECOGNITION_PAGE_SIZE);
  const resume = retained.length > RECOGNITION_PAGE_SIZE ? { at: visible.at(-1)!.at_ms, id: visible.at(-1)!.id } : !exhausted ? last : null;
  const nextCursor = resume ? sealPrivate({ slug, sourceKey: source.target.reviewKey, ...resume, cutoff }, "recognition-page-cursor") : null;
  let validUntil = moderator ? earlier(freshUntil(at), moderator.access.validUntil) : freshUntil(at);
  for (const row of visible) validUntil = earlier(validUntil, row.deadline);
  const entries = visible.map(row => {
    const entry: RecognitionPublicEntry = { label: publicConsentLabel(row), provenance: row.mode === "sample" ? "sample_self_declared" : "self_declared" };
    return moderator ? { ...entry, version: row.head_version, handle: sealPrivate({ headId: row.head_id, consentId: row.id, version: row.head_version, slug, accessId: moderator.access.accessId }, suppressionContext) } : entry;
  });
  return { source, entries, nextCursor, observedAt: at, validUntil, retained: visible };
}
async function recheckPage(tx: SqlConnection, result: Awaited<ReturnType<typeof wallPage>>, slug: string) {
  const now = await recognitionNow(tx);
  if (!result.source) return;
  if (now >= result.validUntil || (await recognitionSource(tx, slug))?.target.reviewKey !== result.source.target.reviewKey) throw new DomainError("RECOGNITION_SOURCE_CHANGED", "The wall changed while it was being checked. Reload its current state.", 409);
  for (const row of result.retained) if (!await consentAuthorityCurrent(tx, row)) throw new DomainError("RECOGNITION_SOURCE_CHANGED", "A participant's original permission ended during this read. Reload the wall.", 409);
}
export async function readPublicRecognition(slug: string, cursor?: string): Promise<RecognitionPublicPage> {
  return recognitionTransaction(async tx => {
    const result = await wallPage(tx, slug, cursor, null);
    const page = recognitionPublicPageSchema.parse({ schema: RECOGNITION_VERSION, slug, state: result.source ? "available" : "unavailable",
      entries: result.entries, proofHref: `/proof/${slug}`, nextCursor: result.nextCursor, observedAt: result.observedAt, validUntil: result.validUntil });
    const serialized = JSON.stringify(page); await recheckPage(tx, result, slug);
    return JSON.parse(serialized) as RecognitionPublicPage;
  });
}
export async function readRecognitionModeration(request: RecognitionRequest, slug: string, cursor?: string, expectedAccessId?: string): Promise<RecognitionModerationPage> {
  return recognitionTransaction(async tx => {
    const authority = await recognitionAuthority(tx, request);
    if (authority.session.role !== "organizer") throw new DomainError("RECOGNITION_ROLE_DENIED", "Only the current project organizer can suppress a public label.", 403);
    if (expectedAccessId && expectedAccessId !== authority.access.accessId) throw new DomainError("RECOGNITION_CONTEXT_CHANGED", "Your original organizer access changed. Reload before moderating.", 409);
    const result = await wallPage(tx, slug, cursor, authority);
    if (!result.source) throw new DomainError("RECOGNITION_TARGET_UNAVAILABLE", "That current public page is unavailable in this project.", 404);
    const page = recognitionModerationPageSchema.parse({ schema: RECOGNITION_VERSION, access: authority.access, slug, entries: result.entries,
      nextCursor: result.nextCursor, observedAt: result.observedAt, validUntil: result.validUntil });
    const serialized = JSON.stringify(page); await assertRecognitionAuthority(tx, request, authority); await recheckPage(tx, result, slug);
    return JSON.parse(serialized) as RecognitionModerationPage;
  });
}
