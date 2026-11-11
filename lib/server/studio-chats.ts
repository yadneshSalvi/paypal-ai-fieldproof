import { randomUUID } from "node:crypto";
import { canonicalJson, sha256 } from "@fracture/paypal-core";
import type { AgAiThread, AgAiThreadSummary } from "ag-studio";
import { DomainError } from "../domain/money";
import { validateStudioThread } from "../studio/chat-history";
import type { Session } from "./auth";
import { database, query } from "./db";
import { requireCurrentRole } from "./membership";
import { openPrivate, sealPrivate } from "./private-values";
import { studioScope } from "./studio-datasets";

const context = (scope: string, id: string, revision: number) => `studio-chat:${scope}:${id}:v${revision}`;
interface ChatRow { id: string; thread_id: string; agent_id: string; revision: number; content_hash: string; encrypted_summary: string; encrypted_thread: string; deleted_at: Date | null; }
export async function listStudioChats(session: Session) {
  return database().transaction(async tx => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { membershipVersion } = await requireCurrentRole(session, session.role, tx), scope = studioScope(session, membershipVersion);
    const rows = await query<ChatRow>("SELECT * FROM fp_studio_chat_threads WHERE scope_hash=$1 AND deleted_at IS NULL ORDER BY updated_at DESC", [scope], tx);
    return rows.map(row => ({ summary: openPrivate<AgAiThreadSummary>(row.encrypted_summary, `${context(scope, row.thread_id, row.revision)}:summary`), revision: row.revision }));
  });
}
export async function readStudioChat(session: Session, threadId: string) {
  return database().transaction(async tx => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { membershipVersion } = await requireCurrentRole(session, session.role, tx), scope = studioScope(session, membershipVersion);
    const [row] = await query<ChatRow>("SELECT * FROM fp_studio_chat_threads WHERE scope_hash=$1 AND thread_id=$2 AND deleted_at IS NULL", [scope, threadId], tx);
    if (!row) return null;
    const thread = validateStudioThread(openPrivate(row.encrypted_thread, context(scope, threadId, row.revision)));
    if (sha256(canonicalJson(thread)) !== row.content_hash || thread.summary.threadId !== threadId) throw new DomainError("STUDIO_CHAT_CHANGED", "The saved conversation could not be verified.", 409);
    return { thread, revision: row.revision, provenance: "client_observed_conversation" as const };
  });
}
export async function saveStudioChat(session: Session, expectedRevision: number, value: unknown) {
  let thread: AgAiThread;
  try { thread = validateStudioThread(value); } catch { throw new DomainError("STUDIO_CHAT_INVALID", "This conversation could not be saved. Its applied report changes have their own history.", 422); }
  const threadId = thread.summary.threadId, hash = sha256(canonicalJson(thread));
  return database().transaction(async tx => {
    const { membershipVersion } = await requireCurrentRole(session, session.role, tx), scope = studioScope(session, membershipVersion);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,410212))", [`${scope}:${threadId}`]);
    const [current] = await query<ChatRow>("SELECT * FROM fp_studio_chat_threads WHERE scope_hash=$1 AND thread_id=$2 FOR UPDATE", [scope, threadId], tx);
    if (current?.deleted_at) throw new DomainError("STUDIO_CHAT_DELETED", "This conversation was removed in another tab.", 409);
    if (current?.content_hash === hash) return { revision: current.revision };
    if ((current?.revision ?? 0) !== expectedRevision || current && current.agent_id !== thread.summary.agentId) throw new DomainError("STUDIO_CHAT_CONFLICT", "This conversation changed in another tab. Reload before continuing its saved history.", 409);
    const revision = expectedRevision + 1;
    const encrypted = sealPrivate(thread, context(scope, threadId, revision));
    const summary = sealPrivate(thread.summary, `${context(scope, threadId, revision)}:summary`);
    if (current) await tx.query("UPDATE fp_studio_chat_threads SET revision=$2,content_hash=$3,encrypted_summary=$4,encrypted_thread=$5,updated_at=now() WHERE id=$1", [current.id, revision, hash, summary, encrypted]);
    else await tx.query(`INSERT INTO fp_studio_chat_threads(id,tenant_id,project_id,actor_id,role,scope_hash,membership_version,thread_id,agent_id,revision,content_hash,encrypted_summary,encrypted_thread)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [randomUUID(), session.tenantId, session.projectId, session.actorId, session.role, scope, membershipVersion, threadId, thread.summary.agentId, revision, hash, summary, encrypted]);
    return { revision };
  });
}
export async function deleteStudioChat(session: Session, threadId: string, expectedRevision: number) {
  const { membershipVersion } = await requireCurrentRole(session, session.role), scope = studioScope(session, membershipVersion);
  const rows = await query("UPDATE fp_studio_chat_threads SET deleted_at=now(),updated_at=now() WHERE scope_hash=$1 AND thread_id=$2 AND revision=$3 AND deleted_at IS NULL RETURNING id", [scope, threadId, expectedRevision]);
  if (!rows.length) {
    const current = await query("SELECT id FROM fp_studio_chat_threads WHERE scope_hash=$1 AND thread_id=$2 AND deleted_at IS NULL", [scope, threadId]);
    if (current.length) throw new DomainError("STUDIO_CHAT_CONFLICT", "This conversation changed in another tab. Reload before removing it.", 409);
  }
  return { removed: true, retained: "Server tool receipts and report history remain separately auditable." };
}
