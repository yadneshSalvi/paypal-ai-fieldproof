import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HERO_OBLIGATION_AMOUNTS } from "../lib/contracts";
import { sessionForToken, type Session } from "../lib/server/auth";
import { database, initializeDatabase, query } from "../lib/server/db";
import { judgeScenario, mintJudgeScenario, revokeJudgeSession, JUDGE_DECISION_DAYS } from "../lib/server/judge";
import { advanceTour, projectSnapshot } from "../lib/server/repository";
import { createProject, presentedDeadline, projectMetadata, sampleDeadline, sampleReceipt, sampleTimeline, SAMPLE_DEADLINE_DAYS } from "../lib/server/seed";
import { fundingDesk } from "../lib/server/funding-lifecycle";

const DAY = 24 * 60 * 60 * 1000;
before(async () => { await initializeDatabase(); });
after(async () => { await database().close(); });
const as = (session: Session, role: Session["role"]) => query("UPDATE fp_sessions SET role=$2 WHERE id=$1", [session.id, role]).then(() => ({ ...session, role }));
/** Every ISO instant anywhere in a stored JSON value. */
function instants(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) found.push(value);
  else if (Array.isArray(value)) for (const item of value) instants(item, found);
  else if (value && typeof value === "object") for (const item of Object.values(value)) instants(item, found);
  return found;
}

describe("relative Sample dates", () => {
  it("derives every deadline and observation from the mint instant, at any month of the year", () => {
    for (const mint of ["2026-11-13T09:00:00Z", "2026-12-31T23:30:00Z", "2027-02-27T12:00:00Z", "2028-02-29T00:00:01Z"]) {
      const at = new Date(mint), deadline = Date.parse(sampleDeadline(at)), timeline = sampleTimeline(at), metadata = projectMetadata({ mintedAt: at });
      assert.ok(deadline - at.getTime() > 45 * DAY, `${mint}: deadline is more than 45 days after mint`);
      assert.ok(deadline - at.getTime() <= (SAMPLE_DEADLINE_DAYS + 1) * DAY);
      assert.equal(metadata.deadline, sampleDeadline(at));
      assert.equal(Date.parse(timeline.recoveryEndsAt) - Date.parse(timeline.collectionStartedAt), 48 * 60 * 60 * 1000);
      assert.ok(Date.parse(timeline.collectionStartedAt) < at.getTime() && at.getTime() - Date.parse(timeline.collectionStartedAt) <= 6 * 60 * 60 * 1000, "round started shortly before mint");
      assert.ok(Date.parse(timeline.recoveryEndsAt) > at.getTime() + 40 * 60 * 60 * 1000, "recovery window is still open through a 12-hour visit");
      assert.ok(Date.parse(timeline.declineObservedAt) > Date.parse(timeline.collectionStartedAt) && Date.parse(timeline.declineObservedAt) < at.getTime());
    }
    assert.notEqual(sampleDeadline(new Date("2026-11-13T09:00:00Z")), sampleDeadline(new Date("2026-12-20T09:00:00Z")));
  });
  it("never presents a Sample project as expired, without rewriting its stored deadline", () => {
    const now = new Date("2026-12-30T10:00:00Z");
    assert.equal(presentedDeadline("2026-12-31T23:59:59Z", "sample", now), sampleDeadline(now));
    assert.equal(presentedDeadline("2026-12-31T23:59:59Z", "sample", new Date("2027-03-01T00:00:00Z")), sampleDeadline(new Date("2027-03-01T00:00:00Z")));
    assert.equal(presentedDeadline("2027-03-01T23:59:59Z", "sample", now), "2027-03-01T23:59:59Z");
    assert.equal(presentedDeadline(undefined, "sample", now), sampleDeadline(now));
    assert.equal(presentedDeadline("2026-12-31T23:59:59Z", "live_sandbox", now), "2026-12-31T23:59:59Z");
  });
  it("stamps a Sample receipt at the time it is recorded unless the seed gives an offset", () => {
    const before = Date.now(), receipt = sampleReceipt("t", "p", "o", "electronics", 100, "k");
    assert.ok(Date.parse(receipt.observedAt) >= before - 1000 && Date.parse(receipt.observedAt) <= Date.now() + 1000);
    assert.equal(sampleReceipt("t", "p", "o", "electronics", 100, "k", false, "2027-01-02T03:04:05.000Z").observedAt, "2027-01-02T03:04:05.000Z");
  });
  it("seeds an ordinary Sample workspace with relative dates and the unchanged hero", async () => {
    const tenantId = randomUUID(), projectId = randomUUID(), mintedAt = new Date("2027-01-15T08:00:00Z");
    await database().transaction(tx => createProject(tx, tenantId, projectId, `plain-${randomUUID()}`, "sample", { mintedAt }));
    const [project] = await query<{ metadata: Record<string, unknown> }>("SELECT metadata FROM fp_projects WHERE id=$1", [projectId]);
    assert.equal(project.metadata.deadline, "2027-03-04T23:59:59Z");
    const receipts = await query<{ data: { observedAt: string; creditedMinor: number; packageId: string } }>("SELECT data FROM fp_settlement_receipts WHERE project_id=$1", [projectId]);
    assert.equal(receipts.filter(row => row.data.packageId === "electronics").reduce((sum, row) => sum + row.data.creditedMinor, 0), 92500);
    for (const row of receipts) assert.ok(Date.parse(row.data.observedAt) <= mintedAt.getTime() && Date.parse(row.data.observedAt) > mintedAt.getTime() - 15 * DAY);
    const obligations = await query<{ amount_minor: string; channel: string; package_id: string }>("SELECT amount_minor,channel,package_id FROM fp_obligations WHERE project_id=$1", [projectId]);
    assert.equal(obligations.filter(row => row.package_id === "woodworking").length, 1, "the ordinary seed keeps its single uncollected woodworking pledge");
  });
});

describe("judge scenario", () => {
  it("mints the exact hero arithmetic in an isolated tenant with only relative dates", async () => {
    const started = Date.now(), { session, token, version } = await mintJudgeScenario(null);
    assert.equal(version, 1); assert.equal(session.mode, "sample");
    assert.deepEqual((await sessionForToken(token))?.projectId, session.projectId);
    const organizer = await as(session, "organizer"), snapshot = await projectSnapshot(organizer);
    assert.equal(snapshot.targetMinor, 841000); assert.equal(snapshot.packages.length, 6);
    assert.equal(snapshot.packages.reduce((sum, row) => sum + row.budgetMinor, 0), 841000);
    const hero = snapshot.obligations.filter(row => row.packageId === "electronics");
    assert.deepEqual(hero.map(row => row.amountMinor), [...HERO_OBLIGATION_AMOUNTS]);
    assert.equal(hero.reduce((sum, row) => sum + row.amountMinor, 0), 96000);
    assert.deepEqual(hero.map(row => row.channel), [...Array(7).fill("collected"), "definitively_declined"]);
    assert.equal(hero[7].amountMinor, 3500);
    const captures = snapshot.receipts.filter(row => row.packageId === "electronics");
    assert.equal(captures.length, 7); assert.ok(captures.every(row => row.sourceKind === "orders_capture" && row.provenance === "sample" && row.actualProviderPaymentRef.startsWith("sample-payment-")));
    assert.equal(captures.reduce((sum, row) => sum + row.creditedMinor, 0), 92500);
    assert.equal(snapshot.packages.find(row => row.id === "electronics")!.collectedMinor, 92500);
    // Dates: nothing fixed, nothing expired, deadlines well beyond 45 days.
    assert.ok(Date.parse(snapshot.deadline) > started + 45 * DAY);
    const stored = [
      ...await query<{ v: unknown }>("SELECT metadata AS v FROM fp_projects WHERE id=$1", [session.projectId]),
      ...await query<{ v: unknown }>("SELECT data AS v FROM fp_settlement_receipts WHERE project_id=$1", [session.projectId]),
      ...await query<{ v: unknown }>("SELECT data AS v FROM fp_obligations WHERE project_id=$1", [session.projectId]),
      ...await query<{ v: unknown }>("SELECT data AS v FROM fp_evidence WHERE project_id=$1", [session.projectId]),
      ...await query<{ v: unknown }>("SELECT data AS v FROM fp_events WHERE project_id=$1", [session.projectId]),
    ].flatMap(row => instants(row.v));
    assert.ok(stored.length >= 12);
    for (const value of stored) {
      const time = Date.parse(value);
      assert.ok(time > started - 15 * DAY && time < started + 60 * DAY, `${value} is relative to mint`);
      assert.ok(!["2026-11-10T10:00:00.000Z", "2026-12-31T23:59:59Z"].includes(value) || Math.abs(time - started) < 60 * DAY);
    }
    const scenario = (await judgeScenario(organizer))!;
    assert.equal(scenario.version, 1); assert.equal(scenario.pristine, true); assert.equal(scenario.tourStep, 0);
    assert.ok(Date.parse(scenario.collectionStartedAt) < started && Date.parse(scenario.recoveryEndsAt) > started + 40 * 60 * 60 * 1000);
    assert.ok(Date.parse(scenario.sessionExpiresAt) > started + 11 * 60 * 60 * 1000);
  });
  it("makes the visitor the supporter and opens one cancelled, all-Orders purpose with a choice", async () => {
    const { session } = await mintJudgeScenario(null), donor = await as(session, "donor"), own = await projectSnapshot(donor);
    assert.deepEqual(own.obligations.map(row => [row.packageId, row.amountMinor, row.donorLabel]).sort(), [["electronics", 5000, "You"], ["woodworking", 10000, "You"]]);
    assert.equal(own.receipts.length, 2); assert.ok(own.receipts.every(row => row.sourceKind === "orders_capture"));
    const organizer = await as(session, "organizer"), scenario = (await judgeScenario(organizer))!;
    assert.ok(scenario.cancellation, "the woodworking decision is open");
    assert.equal(scenario.cancellation!.title, "Woodworking corner"); assert.equal(scenario.cancellation!.shares, 3);
    assert.ok(Date.parse(scenario.cancellation!.deadline) > Date.now() + (JUDGE_DECISION_DAYS - 1) * DAY);
    const desk = await fundingDesk(organizer), open = desk.cases.filter(row => row.state !== "superseded");
    assert.equal(open.length, 1); assert.equal(open[0].packageId, "woodworking");
    const wood = await query<{ data: { sourceKind: string; creditedMinor: number } }>("SELECT data FROM fp_settlement_receipts WHERE project_id=$1 AND package_id='woodworking'", [session.projectId]);
    assert.deepEqual(wood.map(row => row.data.creditedMinor).sort((a, b) => a - b), [10000, 12500, 20000]);
    assert.ok(wood.every(row => row.data.sourceKind === "orders_capture"), "every contribution of the cancelled purpose is an Orders capture");
    assert.ok(desk.policies.some(row => row.packageId === "materials"), "a current purpose is open for a moved share");
    // The hero is untouched by the desk seed.
    const snapshot = await projectSnapshot(organizer);
    assert.equal(snapshot.packages.find(row => row.id === "electronics")!.collectedMinor, 92500);
    assert.equal(snapshot.tourStep, 0);
  });
  it("moves Collected from $925 to $960 only when the Sample invoice receipt is recorded", async () => {
    const { session } = await mintJudgeScenario(null), organizer = await as(session, "organizer");
    await advanceTour(organizer, 1);
    assert.equal((await projectSnapshot(organizer)).packages.find(row => row.id === "electronics")!.collectedMinor, 92500);
    await advanceTour(organizer, 2);
    const after = await projectSnapshot(organizer), electronics = after.receipts.filter(row => row.packageId === "electronics");
    assert.equal(after.packages.find(row => row.id === "electronics")!.collectedMinor, 96000);
    assert.equal(electronics.filter(row => row.sourceKind === "orders_capture").reduce((sum, row) => sum + row.creditedMinor, 0), 92500);
    const invoice = electronics.filter(row => row.sourceKind === "invoice_payment");
    assert.equal(invoice.length, 1); assert.equal(invoice[0].creditedMinor, 3500); assert.equal(invoice[0].provenance, "sample");
    assert.ok(Math.abs(Date.parse(invoice[0].observedAt) - Date.now()) < 60_000, "the recovery receipt is stamped when it is recorded");
    await advanceTour(organizer, 2); await advanceTour(organizer, 3);
    assert.equal((await projectSnapshot(organizer)).packages.find(row => row.id === "electronics")!.collectedMinor, 96000, "replays do not add a second payment");
    assert.equal((await judgeScenario(organizer))!.pristine, false);
  });
  it("starts over in a new tenant, revokes the old session and leaves every old row as it was", async () => {
    const first = await mintJudgeScenario(null), organizer = await as(first.session, "organizer");
    await advanceTour(organizer, 1); await advanceTour(organizer, 2);
    const tables = ["fp_tenants", "fp_projects", "fp_packages", "fp_obligations", "fp_settlement_receipts", "fp_economic_aliases", "fp_events", "fp_evidence", "fp_funding_cases", "fp_funding_policies", "fp_memberships", "fp_sample_funding_origins"];
    const fingerprint = async () => {
      const out: Record<string, unknown> = {};
      for (const table of tables) {
        const column = table === "fp_tenants" ? "id" : table === "fp_economic_aliases" ? "merchant_scope" : table === "fp_packages" ? "project_id" : "tenant_id";
        const key = table === "fp_packages" ? first.session.projectId : first.session.tenantId;
        out[table] = await query(`SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) AS digest,count(*) AS rows FROM ${table} t WHERE ${column}=$1`, [key]);
      }
      return JSON.stringify(out);
    };
    const before = await fingerprint();
    const second = await mintJudgeScenario(first.session);
    assert.equal(await revokeJudgeSession(first.session), true);
    assert.equal(second.version, 2);
    assert.notEqual(second.session.tenantId, first.session.tenantId); assert.notEqual(second.session.projectId, first.session.projectId); assert.notEqual(second.session.actorId, first.session.actorId);
    assert.equal(await sessionForToken(first.token), null, "the old browser session no longer opens anything");
    assert.equal((await sessionForToken(second.token))?.tenantId, second.session.tenantId);
    assert.equal(await fingerprint(), before, "no old row was deleted or rewritten");
    assert.equal((await query("SELECT id FROM fp_sessions WHERE id=$1 AND revoked_at IS NOT NULL", [first.session.id])).length, 1);
    const fresh = await projectSnapshot(await as(second.session, "organizer"));
    assert.equal(fresh.tourStep, 0); assert.equal(fresh.packages.find(row => row.id === "electronics")!.collectedMinor, 92500);
    assert.ok(fresh.receipts.every(row => row.tenantId === second.session.tenantId));
    assert.equal(await revokeJudgeSession(first.session), false, "revoking twice changes nothing");
    assert.equal(await revokeJudgeSession({ id: second.session.id, tenantId: first.session.tenantId }), false, "a session is revoked only within its own tenant");
  });
});
