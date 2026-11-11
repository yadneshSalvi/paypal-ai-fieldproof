import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AgAiThread } from "ag-studio";
import type { Session } from "../lib/server/auth";
import { database, initializeDatabase, query } from "../lib/server/db";
import { createProject } from "../lib/server/seed";
import { deleteStudioChat, listStudioChats, readStudioChat, saveStudioChat } from "../lib/server/studio-chats";
import { validateStudioThread } from "../lib/studio/chat-history";

before(initializeDatabase);
after(async () => { await database().close(); });
async function fixture() {
  const session: Session = { id: randomUUID(), tenantId: randomUUID(), projectId: randomUUID(), actorId: randomUUID(), role: "organizer", mode: "sample", expiresAt: new Date(Date.now() + 3600000).toISOString() };
  await database().transaction(async tx => {
    await createProject(tx, session.tenantId, session.projectId, `chat-fixture-${randomUUID()}`, session.mode);
    await tx.query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [session.id, randomUUID(), session.tenantId, session.projectId, session.actorId, session.role, session.expiresAt]);
    await tx.query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,'[\"organizer\",\"auditor\"]')", [session.tenantId, session.projectId, session.actorId]);
  });
  const thread: AgAiThread = { summary: { threadId: randomUUID(), agentId: "fieldproof-steward", title: "Private evidence question", updatedAt: 8 },
    messages: [{ id: randomUUID(), role: "user", createdAt: Date.now(), parts: [{ type: "text", text: "A private source question at confidential@example.invalid" }] },
      { id: randomUUID(), role: "assistant", createdAt: Date.now(), parts: [{ type: "text", text: "This is a scoped sample response." }, { type: "reasoning", text: "Private reasoning must not be stored" }] }],
    artifacts: [{ id: "plan", type: "plan", data: { status: "proposed", widgets: [] } }], sharedState: { selectedPackage: "electronics" } };
  return { session, thread };
}
const code = (value: string) => (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === value;
describe("scoped native chat persistence", () => {
  it("round-trips visible conversation, artifacts and shared state privately without retaining hidden reasoning", async () => {
    const { session, thread } = await fixture();
    assert.deepEqual(await saveStudioChat(session, 0, thread), { revision: 1 });
    const saved = await readStudioChat(session, thread.summary.threadId);
    assert.equal(saved?.provenance, "client_observed_conversation"); assert.deepEqual(saved?.thread, validateStudioThread(thread));
    assert.equal(JSON.stringify(saved).includes("Private reasoning"), false);
    const [stored] = await query<{ encrypted_thread: string; encrypted_summary: string }>("SELECT encrypted_thread,encrypted_summary FROM fp_studio_chat_threads WHERE thread_id=$1", [thread.summary.threadId]);
    assert.equal(stored.encrypted_thread.includes("confidential"), false); assert.equal(stored.encrypted_summary.includes("Private evidence"), false);
    assert.equal((await listStudioChats(session))[0].summary.title, "Private evidence question");
  });
  it("treats identical writes as retries and refuses conflicting revisions from another tab", async () => {
    const { session, thread } = await fixture(); await saveStudioChat(session, 0, thread);
    assert.deepEqual(await saveStudioChat(session, 0, thread), { revision: 1 });
    const changed = { ...thread, summary: { ...thread.summary, title: "A new question", updatedAt: 9 } };
    await assert.rejects(saveStudioChat(session, 0, changed), code("STUDIO_CHAT_CONFLICT"));
    assert.deepEqual(await saveStudioChat(session, 1, changed), { revision: 2 });
    await assert.rejects(deleteStudioChat(session, thread.summary.threadId, 1), code("STUDIO_CHAT_CONFLICT"));
    await deleteStudioChat(session, thread.summary.threadId, 2);
    assert.equal(await readStudioChat(session, thread.summary.threadId), null); assert.deepEqual(await listStudioChats(session), []);
    await assert.rejects(saveStudioChat(session, 2, changed), code("STUDIO_CHAT_DELETED"));
  });
  it("does not expose one role's private conversation after switching or revoking access", async () => {
    const { session, thread } = await fixture(); await saveStudioChat(session, 0, thread);
    await query("UPDATE fp_sessions SET role='auditor' WHERE id=$1", [session.id]);
    await assert.rejects(readStudioChat(session, thread.summary.threadId), code("ROLE_DENIED"));
    const auditor = { ...session, role: "auditor" as const };
    assert.equal(await readStudioChat(auditor, thread.summary.threadId), null); assert.deepEqual(await listStudioChats(auditor), []);
    await query("UPDATE fp_memberships SET state='revoked',version=version+1 WHERE project_id=$1", [session.projectId]);
    await assert.rejects(listStudioChats(auditor), code("MEMBERSHIP_DENIED"));
  });
  it("rejects corrupted encrypted history and prototype-bearing artifact input", async () => {
    const { session, thread } = await fixture(); await saveStudioChat(session, 0, thread);
    await query("UPDATE fp_studio_chat_threads SET content_hash=$2 WHERE thread_id=$1", [thread.summary.threadId, "bad-hash"]);
    await assert.rejects(readStudioChat(session, thread.summary.threadId), code("STUDIO_CHAT_CHANGED"));
    const unsafe = { ...thread, sharedState: JSON.parse('{"__proto__":{"admin":true}}') };
    await assert.rejects(saveStudioChat(session, 1, unsafe), code("STUDIO_CHAT_INVALID"));
  });
});
