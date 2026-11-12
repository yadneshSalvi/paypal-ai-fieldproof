import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it, type TestContext } from "node:test";
import type { Session } from "../lib/server/auth";
import { database, query } from "../lib/server/db";
import { requireDocument } from "../lib/server/documents";
import { lockPlanningAuthority, sourceControl } from "../lib/server/planning-store";
import { captureBoardPack, exportBoardPack, readBoardPack, readBoardPackDesk, readBoardPackImage, readBoardPackSource } from "../lib/server/board-packs";
import { boardPackSourceId } from "../lib/reports/board-pack-contracts";
import { addActor, alignedFixture, isolatedPlanningDatabase, publishFixture } from "./helpers/planning";
import { storyFixture, storyPlanning } from "./helpers/supporter-story";
import { boardPackExpenseFixture } from "./helpers/board-pack";
import { createProofDerivative } from "../lib/server/proof";
import { setPlanningSourcePermission } from "../lib/server/planning-sources";

isolatedPlanningDatabase();

async function blockedReader(blockerPid: number): Promise<{ pid: number; query: string }> {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const [row] = await query<{ pid: number; query: string }>("SELECT pid,query FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'", [blockerPid]);
    if (row && /fp_memberships/.test(row.query)) return row;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("The report reader must be observed waiting on this fixture's held membership lock.");
}

/** Models the first explicit permission record for a previously implicit-allowed
 * private source, under a different current organizer's real authority locks.
 * Only a disposable synthetic schema is mutated; no retained fixture is used. */
async function firstSourceWithdrawal(writer: Session, documentId: string) {
  await database().transaction(async tx => {
    await lockPlanningAuthority(writer, ["organizer"], tx);
    const document = await requireDocument(writer, documentId, tx);
    await sourceControl(document, tx, true);
    await tx.query("UPDATE fp_plan_source_controls SET permission='withdrawn',version=version+1,updated_at=clock_timestamp() WHERE document_id=$1 AND tenant_id=$2 AND project_id=$3", [documentId, writer.tenantId, writer.projectId]);
  });
}

async function holdMembership(session: Session) {
  let release!: () => void, announce!: (pid: number) => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<number>(resolve => { announce = resolve; });
  const finished = database().transaction(async tx => {
    const [{ pid }] = await query<{ pid: number }>("SELECT pg_backend_pid() pid", [], tx);
    await tx.query("SELECT actor_id FROM fp_memberships WHERE tenant_id=$1 AND project_id=$2 AND actor_id=$3 FOR UPDATE", [session.tenantId, session.projectId, session.actorId]);
    announce(pid); await gate;
  });
  return { pid: await ready, release, finished };
}

async function raceFirstWithdrawal(t: TestContext, kind: "desk" | "report" | "source" | "csv") {
  const fixture = await storyFixture(), expense = await boardPackExpenseFixture(fixture), writer = await addActor(fixture, "organizer", ["organizer"]);
  assert.equal((await query("SELECT document_id FROM fp_plan_source_controls WHERE document_id=$1", [expense.document.id])).length, 0, "This source begins with implicit allowed permission, not an existing lockable control row.");
  const desk = await readBoardPackDesk(fixture.organizer), saved = await captureBoardPack(fixture.organizer, { intentId: randomUUID(), label: "Synthetic permission-race report", expectedProjectionVersion: desk.projectionVersion });
  assert.ok(saved.report); assert.equal(saved.report.expenses[0].title, expense.canaries[2]);
  const held = await holdMembership(fixture.organizer);
  const pending = (kind === "desk" ? readBoardPackDesk(fixture.organizer) : kind === "report" ? readBoardPack(fixture.organizer, saved.summary.id)
    : kind === "source" ? readBoardPackSource(fixture.organizer, saved.summary.id, boardPackSourceId("expense", expense.claim.id))
      : exportBoardPack(fixture.organizer, saved.summary.id)).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  let reader: { pid: number; query: string } | undefined;
  try {
    reader = await blockedReader(held.pid);
    await firstSourceWithdrawal(writer, expense.document.id);
    assert.equal((await query<{ permission: string }>("SELECT permission FROM fp_plan_source_controls WHERE document_id=$1", [expense.document.id]))[0].permission, "withdrawn");
  } finally { held.release(); await held.finished; }
  const outcome = await pending, fresh = await readBoardPack(fixture.organizer, saved.summary.id);
  assert.equal(fresh.status, "withdrawn"); assert.equal(fresh.report, null, "The ordinary fresh read must agree that this same source was withdrawn.");
  if (!outcome.ok) {
    const code = (outcome.error as { code?: string }).code;
    t.diagnostic(JSON.stringify({ kind, observedMembershipWait: Boolean(reader), blockedReaderPid: reader?.pid, sourceWithdrawnBeforeRelease: true, deniedCode: code }));
    assert.ok(["40001", "BOARD_PACK_SOURCE_WITHDRAWN", "BOARD_PACK_SOURCE_CHANGED"].includes(code ?? ""), `Unexpected error instead of a source withdrawal denial: ${code}`);
    return;
  }
  const serialized = JSON.stringify(outcome.value), canaryVisible = serialized.includes(expense.canaries[2]);
  t.diagnostic(JSON.stringify({ kind, observedMembershipWait: Boolean(reader), blockedReaderPid: reader?.pid, sourceWithdrawnBeforeRelease: true, privateCanaryVisible: canaryVisible, freshReadWithheld: true }));
  assert.equal(canaryVisible, false, `A ${kind} disclosure resumed from an older snapshot must not carry private source text after a committed withdrawal.`);
  if (kind === "report") assert.equal((outcome.value as Awaited<ReturnType<typeof readBoardPack>>).report, null);
  else if (kind === "desk") assert.equal((outcome.value as Awaited<ReturnType<typeof readBoardPackDesk>>).selected?.report, null);
  else assert.fail(`A ${kind} disclosure should be refused after the captured source is withdrawn.`);
}

describe("current source permission after a frozen report snapshot waits", () => {
  for (const kind of ["desk", "report", "source", "csv"] as const) it(`withholds private ${kind} content after a first permission withdrawal commits during the membership wait`, { timeout: 20_000 }, t => raceFirstWithdrawal(t, kind));

  it("agrees with a fresh read after the reachable first control insertion from proof preparation", { timeout: 20_000 }, async t => {
    const fixture = await storyFixture(), expense = await boardPackExpenseFixture(fixture), writer = await addActor(fixture, "organizer", ["organizer"]);
    assert.equal((await query("SELECT document_id FROM fp_plan_source_controls WHERE document_id=$1", [expense.document.id])).length, 0);
    const desk = await readBoardPackDesk(fixture.organizer), saved = await captureBoardPack(fixture.organizer, { intentId: randomUUID(), label: "Synthetic real-action insertion race", expectedProjectionVersion: desk.projectionVersion });
    const held = await holdMembership(fixture.organizer), pending = readBoardPack(fixture.organizer, saved.summary.id).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    try {
      await blockedReader(held.pid);
      await createProofDerivative(writer, { intentId: randomUUID(), documentId: expense.document.id, page: 1, packageId: "electronics", crop: { x: 0, y: 0, width: 1, height: 1 }, masks: [{ x: .1, y: .1, width: .2, height: .2 }] }, fixture.storage);
      assert.equal((await query<{ permission: string }>("SELECT permission FROM fp_plan_source_controls WHERE document_id=$1", [expense.document.id]))[0].permission, "allowed");
    } finally { held.release(); await held.finished; }
    const outcome = await pending, fresh = await readBoardPack(fixture.organizer, saved.summary.id);
    if (!outcome.ok) { assert.equal((outcome.error as { code?: string }).code, "40001"); return; }
    t.diagnostic(JSON.stringify({ actualProofAction: true, sourceStillAllowed: true, blockedStatus: outcome.value.status, freshStatus: fresh.status }));
    assert.equal(outcome.value.status, fresh.status, "A first allowed control is a reachable exact-binding change, not a receipt withdrawal API; resumed status must still match current policy.");
    assert.equal(outcome.value.report === null, fresh.report === null);
  });

  it("fails closed for the actual planning withdrawal action with an existing control", { timeout: 20_000 }, async t => {
    const fixture = await storyFixture(), plan = await storyPlanning(fixture); await publishFixture(plan);
    const image = await alignedFixture(plan); await image.review();
    const reader = fixture.donors[0], desk = await readBoardPackDesk(reader), saved = await captureBoardPack(reader, { intentId: randomUUID(), label: "Synthetic reachable withdrawal race", expectedProjectionVersion: desk.projectionVersion });
    const held = await holdMembership(reader), pending = readBoardPack(reader, saved.summary.id).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    try {
      await blockedReader(held.pid);
      await setPlanningSourcePermission(fixture.organizer, plan.photo.id, { intentId: randomUUID(), expectedVersion: 1, permission: "withdrawn", reason: "Controlled actual-action withdrawal after the report snapshot began." });
    } finally { held.release(); await held.finished; }
    const outcome = await pending;
    if (!outcome.ok) { assert.ok(["40001", "BOARD_PACK_SOURCE_WITHDRAWN"].includes((outcome.error as { code?: string }).code ?? "")); t.diagnostic("Existing-control withdrawal denied by a serialization/current-source guard."); return; }
    assert.equal(outcome.value.status, "withdrawn"); assert.equal(outcome.value.report, null);
  });

  it("keeps inherited object properties outside the captured source allowlist", async t => {
    const fixture = await storyFixture(), desk = await readBoardPackDesk(fixture.organizer), saved = await captureBoardPack(fixture.organizer, { intentId: randomUUID(), label: "Synthetic source-index boundary", expectedProjectionVersion: desk.projectionVersion });
    const names = ["__proto__", "constructor", "toString", "not-a-captured-source"];
    const results = await Promise.allSettled(names.map(name => readBoardPackSource(fixture.organizer, saved.summary.id, name)));
    const accepted = names.filter((_, index) => results[index].status === "fulfilled");
    t.diagnostic(JSON.stringify({ inheritedSourceKeysAccepted: accepted }));
    assert.deepEqual(accepted, [], "Only source IDs actually retained in this capture may produce a source detail response.");
    for (const result of results) if (result.status === "rejected") assert.equal((result.reason as { code?: string }).code, "BOARD_PACK_SOURCE_UNAVAILABLE");
    for (const name of names) await assert.rejects(readBoardPackImage(fixture.organizer, saved.summary.id, name, fixture.storage), error => (error as { code?: string }).code === "BOARD_PACK_IMAGE_UNAVAILABLE");
  });
});
