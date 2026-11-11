import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { query } from "../lib/server/db";
import { expirePlanExtractions, nextPlanContinuations, planRuns, retryPlanExtraction, runPlanExtraction, startPlanExtraction, type PlanBackgroundObservation, type PlanModel, type PlanRunRow } from "../lib/server/planning-extraction";
import { beginOpenAIPlan, pollOpenAIPlan } from "../lib/server/planning-openai";
import { openPrivate } from "../lib/server/private-values";
import { setPlanningSourcePermission } from "../lib/server/planning-sources";
import { readPlanningWorkspace, savePlan } from "../lib/server/planning";
import { planningHash } from "../lib/server/planning-store";
import { addActor, errorCode, isolatedPlanningDatabase, planningFixture, type PlanningFixture } from "./helpers/planning";

isolatedPlanningDatabase();
const originalFetch = globalThis.fetch, originalKey = process.env.OPENAI_API_KEY, originalModel = process.env.OPENAI_LAYOUT_MODEL;
before(() => { process.env.OPENAI_API_KEY = "controlled-no-network-test-key"; process.env.OPENAI_LAYOUT_MODEL = "controlled-layout-fixture"; globalThis.fetch = async () => { throw new Error("An isolated planning test attempted an unmocked external request"); }; });
after(() => { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey; if (originalModel === undefined) delete process.env.OPENAI_LAYOUT_MODEL; else process.env.OPENAI_LAYOUT_MODEL = originalModel; });
const start = (f: PlanningFixture) => startPlanExtraction(f.session, { sketchId: f.sketch.id, quoteIds: [f.quote.id], provider: "openai", acknowledged: true });
const responseId = () => `resp_controlled_${randomUUID().replaceAll("-", "")}`;
async function stored(id: string) { return (await query<PlanRunRow>("SELECT * FROM fp_plan_runs WHERE id=$1", [id]))[0]; }
async function due(id: string) { await query("UPDATE fp_plan_runs SET next_poll_at=now()-interval '1 second' WHERE id=$1", [id]); }
const complete = (f: PlanningFixture, id: string): PlanBackgroundObservation => ({ responseId: id, status: "completed", privateDiagnostic: null, result: { proposal: structuredClone(f.plan), responseId: id, inputTokens: 421, outputTokens: 912 } });
function backgroundFixture(f: PlanningFixture) {
  const id = responseId(); let starts = 0, polls = 0;
  const model: PlanModel = {
    async extract() { throw new Error("A durable response must not call the foreground adapter"); },
    async beginBackground() { starts++; return { responseId: id, status: "in_progress", privateDiagnostic: null }; },
    async pollBackground(saved) { assert.equal(saved, id); polls++; return complete(f, id); },
  };
  return { id, model, counts: () => ({ starts, polls }) };
}
async function privateAttempt(id: string, attempt = 1) {
  const row = await stored(id), [data] = await query<{ encrypted_result: string }>("SELECT encrypted_result FROM fp_plan_run_attempts WHERE run_id=$1 AND attempt=$2", [id, attempt]);
  return openPrivate<{ code?: string; privateResult?: unknown }>(data.encrypted_result, `plan-run:${row.tenant_id}:${row.project_id}:${row.id}`);
}

describe("durable plan extraction without automatic redispatch", () => {
  it("submits once, coalesces concurrent workers and resumes the exact encrypted response identity", async () => {
    const f = await planningFixture(), run = await start(f), model = backgroundFixture(f);
    assert.equal((await start(f)).id, run.id);
    await Promise.all([runPlanExtraction(run.id, model.model, f.storage), runPlanExtraction(run.id, model.model, f.storage)]);
    assert.deepEqual(model.counts(), { starts: 1, polls: 0 }); assert.equal((await stored(run.id)).state, "running");
    const view = (await planRuns(f.session))[0]; assert.equal(view.providerStatus, "in_progress"); assert.equal(view.retryAvailable, false); assert.equal(JSON.stringify(view).includes(model.id), false);
    await due(run.id); await Promise.all([runPlanExtraction(run.id, model.model, f.storage), runPlanExtraction(run.id, model.model, f.storage)]);
    assert.deepEqual(model.counts(), { starts: 1, polls: 1 });
    const finished = (await planRuns(f.session))[0]; assert.equal(finished.state, "succeeded"); assert.equal(finished.attempt, 1); assert.equal(finished.stats?.inputTokens, 421);
    assert.ok(finished.proposal?.zones.every(z => z.reviewState === "needs_review")); assert.ok(finished.proposal?.packages.every(p => p.reviewState === "needs_review"));
    assert.equal(finished.validation?.publishable, false, "Model output cannot manufacture a person's review");
    const edited = structuredClone(finished.proposal!); edited.title = "A person's corrected plan";
    await assert.rejects(savePlan(f.session, { intentId: randomUUID(), expectedVersion: 0, plan: edited, origin: "model", sourceRunId: run.id }), errorCode("MODEL_PROPOSAL_CHANGED"));
    await savePlan(f.session, { intentId: randomUUID(), expectedVersion: 0, plan: edited, origin: "manual", sourceRunId: run.id });
    assert.equal((await readPlanningWorkspace(f.session)).current?.sourceRunId, run.id);
  });
  it("records submit-response loss as unconfirmed and never automatically dispatches again", async () => {
    const f = await planningFixture(), run = await start(f); let starts = 0;
    const model: PlanModel = { async extract() { throw new Error("Wrong transport"); }, async beginBackground() { starts++; throw new OpenAI.APIConnectionTimeoutError(); }, async pollBackground() { throw new Error("No response ID is available to poll"); } };
    await runPlanExtraction(run.id, model, f.storage);
    assert.equal((await stored(run.id)).code, "PLAN_SUBMISSION_UNCONFIRMED"); assert.equal((await stored(run.id)).encrypted_checkpoint, null);
    await runPlanExtraction(run.id, model, f.storage); await expirePlanExtractions(); assert.equal(starts, 1);
    assert.equal((await nextPlanContinuations(f.session)).includes(run.id), false); assert.equal((await privateAttempt(run.id)).code, "PLAN_SUBMISSION_UNCONFIRMED");
    await retryPlanExtraction(f.session, run.id); await runPlanExtraction(run.id, model, f.storage);
    assert.equal(starts, 2); assert.equal((await stored(run.id)).attempt, 2); assert.equal((await privateAttempt(run.id, 1)).code, "PLAN_SUBMISSION_UNCONFIRMED");
  });
  it("retains poll timeouts and resumes only GET against the same response", async () => {
    const f = await planningFixture(), run = await start(f), stub = backgroundFixture(f); let timeout = true;
    const original = stub.model.pollBackground!; stub.model.pollBackground = async id => { if (timeout) { timeout = false; throw new OpenAI.APIConnectionTimeoutError(); } return original(id); };
    await runPlanExtraction(run.id, stub.model, f.storage); await due(run.id); await runPlanExtraction(run.id, stub.model, f.storage);
    assert.equal((await stored(run.id)).state, "running"); assert.equal((await stored(run.id)).code, "PLAN_POLL_RETRY_PENDING"); assert.equal((await stored(run.id)).attempt, 1);
    assert.equal((await retryPlanExtraction(f.session, run.id)).state, "running"); assert.equal(stub.counts().starts, 1);
    await due(run.id); await runPlanExtraction(run.id, stub.model, f.storage); assert.equal((await stored(run.id)).state, "succeeded");
    const observations = await query<{ code: string | null; encrypted_data: string }>("SELECT code,encrypted_data FROM fp_plan_provider_observations WHERE run_id=$1", [run.id]);
    assert.ok(observations.some(o => o.code === "PLAN_POLL_RETRY_PENDING")); assert.equal(JSON.stringify(observations).includes(stub.id), false);
  });
  it("keeps a revoked session from polling or publishing its pending result", async () => {
    const f = await planningFixture(), run = await start(f), stub = backgroundFixture(f);
    await runPlanExtraction(run.id, stub.model, f.storage); await query("UPDATE fp_sessions SET revoked_at=now() WHERE id=$1", [f.session.id]); await due(run.id);
    await runPlanExtraction(run.id, stub.model, f.storage); assert.equal(stub.counts().polls, 0); assert.equal((await stored(run.id)).state, "failed");
    assert.equal((await stored(run.id)).encrypted_output, null); await assert.rejects(planRuns(f.session));
  });
  it("retains a late output but refuses it when access is revoked during the provider GET", async () => {
    const f = await planningFixture(), run = await start(f), stub = backgroundFixture(f);
    stub.model.pollBackground = async () => { await query("UPDATE fp_sessions SET revoked_at=now() WHERE id=$1", [f.session.id]); return complete(f, stub.id); };
    await runPlanExtraction(run.id, stub.model, f.storage); await due(run.id); await runPlanExtraction(run.id, stub.model, f.storage);
    assert.equal((await stored(run.id)).state, "failed"); assert.ok((await privateAttempt(run.id)).privateResult); assert.equal((await stored(run.id)).encrypted_output, null);
  });
  it("checks exact source permission both before a poll and after completed model output", async () => {
    const f = await planningFixture(), run = await start(f), stub = backgroundFixture(f);
    stub.model.pollBackground = async () => { await setPlanningSourcePermission(f.session, f.quote.id, { intentId: randomUUID(), expectedVersion: 1, permission: "withdrawn", reason: "Controlled source withdrawal during a provider poll" }); return complete(f, stub.id); };
    await runPlanExtraction(run.id, stub.model, f.storage); await due(run.id); await runPlanExtraction(run.id, stub.model, f.storage);
    assert.equal((await stored(run.id)).code, "PLAN_SOURCE_CHANGED_AFTER_MODEL"); assert.ok((await privateAttempt(run.id)).privateResult);
    await assert.rejects(retryPlanExtraction(f.session, run.id), errorCode("PLAN_RUN_SOURCE_CHANGED"));
    assert.equal((await readPlanningWorkspace(f.session)).runs[0].proposal, null);
  });
  it("does not infer success or resubmit when retention expires or a response disappears", async () => {
    const f = await planningFixture(), run = await start(f), stub = backgroundFixture(f);
    await runPlanExtraction(run.id, stub.model, f.storage); await query("UPDATE fp_plan_runs SET resume_until=now()-interval '1 second' WHERE id=$1", [run.id]);
    await expirePlanExtractions(); await runPlanExtraction(run.id, stub.model, f.storage);
    assert.equal((await stored(run.id)).code, "PLAN_RESPONSE_WINDOW_EXPIRED"); assert.deepEqual(stub.counts(), { starts: 1, polls: 0 });
    const next = await retryPlanExtraction(f.session, run.id); assert.equal(next.state, "queued");
    await runPlanExtraction(run.id, stub.model, f.storage); await due(run.id);
    stub.model.pollBackground = async () => { throw new OpenAI.NotFoundError(404, { message: "Controlled response retention expiry" }, "Controlled response retention expiry", new Headers()); };
    await runPlanExtraction(run.id, stub.model, f.storage); assert.equal((await stored(run.id)).code, "PLAN_RESPONSE_WINDOW_EXPIRED"); assert.equal(stub.counts().starts, 2);
  });
  it("does not let an old result overwrite an explicitly retried attempt", async () => {
    const f = await planningFixture(), run = await start(f), old = backgroundFixture(f), newer = backgroundFixture(f);
    await runPlanExtraction(run.id, old.model, f.storage); await due(run.id);
    old.model.pollBackground = async () => {
      await query("UPDATE fp_plan_runs SET lease_until=now()-interval '1 second',resume_until=now()-interval '1 second' WHERE id=$1", [run.id]);
      await expirePlanExtractions(); await retryPlanExtraction(f.session, run.id); await runPlanExtraction(run.id, newer.model, f.storage); await due(run.id); await runPlanExtraction(run.id, newer.model, f.storage);
      return complete(f, old.id);
    };
    await runPlanExtraction(run.id, old.model, f.storage);
    const row = await stored(run.id); assert.equal(row.state, "succeeded"); assert.equal(row.attempt, 2); assert.ok((await privateAttempt(run.id, 1)).privateResult);
    const output = openPrivate<{ responseId: string }>(row.encrypted_output!, `plan-run:${row.tenant_id}:${row.project_id}:${row.id}`); assert.equal(output.responseId, newer.id);
  });
  it("rejects forged model source citations and retains the private invalid output", async () => {
    const f = await planningFixture(), run = await start(f), stub = backgroundFixture(f);
    stub.model.pollBackground = async () => { const result = complete(f, stub.id); const proposal = structuredClone(f.plan); proposal.citations[0].documentId = randomUUID(); result.result!.proposal = proposal; return result; };
    await runPlanExtraction(run.id, stub.model, f.storage); await due(run.id); await runPlanExtraction(run.id, stub.model, f.storage);
    assert.equal((await stored(run.id)).code, "PLAN_MODEL_SOURCE_FORGED"); assert.ok((await privateAttempt(run.id)).privateResult);
    const other = await planningFixture(), donor = await addActor(f.session, "donor"); assert.deepEqual(await planRuns(donor), []); assert.equal((await planRuns(other.session)).length, 0);
    await assert.rejects(retryPlanExtraction(other.session, run.id), errorCode("PLAN_RUN_NOT_FOUND")); assert.deepEqual(await nextPlanContinuations(other.session), []);
  });
  it("expires an interrupted unknown submission without automatic inference", async () => {
    const f = await planningFixture(), run = await start(f);
    await query("UPDATE fp_plan_runs SET state='running',attempt=1,lease_id=$2,lease_until=now()-interval '1 second' WHERE id=$1", [run.id, randomUUID()]);
    const row = await stored(run.id); await query("INSERT INTO fp_plan_run_attempts(run_id,attempt,lease_id,state) VALUES($1,1,$2,'running')", [row.id, row.lease_id]);
    await expirePlanExtractions(); assert.equal((await stored(run.id)).code, "PLAN_SUBMISSION_UNCONFIRMED"); assert.equal((await stored(run.id)).state, "failed");
  });
});

describe("actual OpenAI SDK wire shape through a controlled transport", () => {
  it("sets background and store:false, then retrieves the original response without another POST", async () => {
    const calls: { method: string; url: string; body: unknown }[] = [], protectedFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const req = new Request(input, init), body = req.method === "POST" ? await req.json() : null;
      calls.push({ method: req.method, url: req.url, body });
      return new Response(JSON.stringify({ id: "resp_controlled_wire", status: "queued", output: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    try {
      const started = await beginOpenAIPlan({ provider: "openai", model: "controlled-layout-fixture", pages: [{ documentId: randomUUID(), page: 1, purpose: "sketch", provenance: "sample_document", bytes: Buffer.from("synthetic fixture bytes") }], packages: [], sketchId: randomUUID(), reasoningEffort: "max" }, "Controlled instruction fixture");
      await pollOpenAIPlan(started.responseId);
      assert.deepEqual(calls.map(c => c.method), ["POST", "GET"]); assert.match(calls[1].url, /\/responses\/resp_controlled_wire$/);
      const body = calls[0].body as { background: boolean; store: boolean; reasoning: { effort: string }; text: { format: { type: string } } };
      assert.equal(body.background, true); assert.equal(body.store, false); assert.equal(body.reasoning.effort, "max"); assert.equal(body.text.format.type, "json_schema");
    } finally { globalThis.fetch = protectedFetch; }
  });
});
