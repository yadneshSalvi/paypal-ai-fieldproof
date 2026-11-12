import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { recognitionFixture, recognitionDonor, recognitionVolunteer, recognitionConsentInput, recognitionFingerprint, recognitionErrorCode as code, recognitionTestToken } from "./helpers/recognition-fixtures";
import { readPublicRecognition, readRecognitionDesk, readRecognitionModeration } from "../lib/server/recognition-store";
import { executeRecognitionCommand, readRecognitionCommand } from "../lib/server/recognition-commands";
import { database, query } from "../lib/server/db";
import { tokenHash } from "../lib/server/auth";
import { RECOGNITION_VERSION, type RecognitionCommand } from "../lib/recognition/contracts";
import { readProofDesk, withdrawProof } from "../lib/server/proof";
import { setPlanningSourcePermission } from "../lib/server/planning-sources";
import { RECOGNITION_SCHEMA } from "../lib/server/recognition-schema";

async function withdraw(request: { projectToken: string }, slug: string) {
  const desk = await readRecognitionDesk(request, slug);
  return executeRecognitionCommand(request, { schema: RECOGNITION_VERSION, action: "withdraw", intentId: randomUUID(), accessId: desk.access.accessId,
    sessionExpiresAt: desk.access.sessionExpiresAt, expectedVersion: desk.own!.version, slug, confirmed: true });
}

describe("recognition actual PostgreSQL consent", () => {
  it("defaults private, accepts own exact explicit consent, and retains a label-free receipt", async () => {
    const f = await recognitionFixture(), donor = await recognitionDonor(f), input = await recognitionConsentInput(donor.request, f.slug);
    assert.equal((await readRecognitionDesk(donor.request, f.slug)).own?.state, "private");
    assert.deepEqual((await readPublicRecognition(f.slug)).entries, []);
    const result = await executeRecognitionCommand(donor.request, input);
    assert.equal(result.version, 1); assert.equal(JSON.stringify(result).includes(input.label), false);
    assert.deepEqual(await readRecognitionCommand(donor.request, input.intentId, input.accessId), result);
    assert.deepEqual((await readPublicRecognition(f.slug)).entries, [{ label: "Asha R.", provenance: "sample_self_declared" }]);
    const before = await recognitionFingerprint(f.session.projectId);
    assert.equal((await readRecognitionDesk(donor.request, f.slug)).own?.label, "Asha R.");
    await readPublicRecognition(f.slug); await readRecognitionCommand(donor.request, input.intentId, input.accessId);
    assert.deepEqual(await recognitionFingerprint(f.session.projectId), before);
  });
  it("permits the independent sponsor donor and reviewer volunteer without implying a payment or human verification", async () => {
    const f = await recognitionFixture(), donor = await recognitionDonor(f, "sponsor"), volunteer = await recognitionVolunteer(f);
    for (const [person, label] of [[donor, "Sponsor initials"], [volunteer, "Volunteer initials"]] as const)
      await executeRecognitionCommand(person.request, await recognitionConsentInput(person.request, f.slug, label));
    assert.deepEqual((await readPublicRecognition(f.slug)).entries.map(row => row.label).sort(), ["Sponsor initials", "Volunteer initials"]);
    const [payments] = await query<{ count: string }>("SELECT count(*) FROM fp_settlement_receipts r JOIN fp_obligations o ON o.id=r.obligation_id WHERE r.project_id=$1 AND o.actor_id=ANY($2::text[])", [f.session.projectId, [donor.session.actorId, volunteer.session.actorId]]);
    assert.equal(Number(payments.count), 0);
  });
  it("does not let organizer/auditor/broad-role sample profiles give participant consent", async () => {
    const f = await recognitionFixture(), donor = await recognitionDonor(f), input = await recognitionConsentInput(donor.request, f.slug), organizer = await readRecognitionDesk(f.request, f.slug);
    await assert.rejects(executeRecognitionCommand(f.request, { ...input, accessId: organizer.access.accessId, sessionExpiresAt: organizer.access.sessionExpiresAt }), code("RECOGNITION_ROLE_DENIED"));
    await query("UPDATE fp_sessions SET role='auditor' WHERE id=$1", [f.session.id]);
    await query("UPDATE fp_memberships SET roles='[\"organizer\",\"auditor\"]'::jsonb,version=version+1 WHERE project_id=$1 AND actor_id=$2", [f.session.projectId, f.session.actorId]);
    await assert.rejects(readRecognitionDesk(f.request), code("RECOGNITION_ROLE_DENIED"));
    await query("UPDATE fp_memberships SET roles='[\"donor\",\"organizer\"]'::jsonb,version=version+1 WHERE project_id=$1 AND actor_id=$2", [donor.session.projectId, donor.session.actorId]);
    await assert.rejects(readRecognitionDesk(donor.request), code("RECOGNITION_INDEPENDENT_ENTRY_REQUIRED"));
  });
  it("rejects a foreign project and copied original access without leaking its private consent", async () => {
    const f = await recognitionFixture(), foreign = await recognitionFixture(), donor = await recognitionDonor(f), other = await recognitionDonor(foreign);
    const input = await recognitionConsentInput(donor.request, f.slug), otherInput = await recognitionConsentInput(other.request, foreign.slug);
    await assert.rejects(executeRecognitionCommand(other.request, input), code("RECOGNITION_CONTEXT_CHANGED"));
    await assert.rejects(executeRecognitionCommand(donor.request, { ...input, slug: foreign.slug, reviewKey: otherInput.reviewKey }), code("RECOGNITION_SOURCE_CHANGED"));
    await assert.rejects(readRecognitionDesk(donor.request, foreign.slug), code("RECOGNITION_TARGET_UNAVAILABLE"));
    await assert.rejects(readRecognitionCommand(other.request, input.intentId, otherInput.accessId), code("RECOGNITION_COMMAND_NOT_FOUND"));
  });
  it("six concurrent exact requests create one consent, one audit, one immutable result", async () => {
    const f = await recognitionFixture(), donor = await recognitionDonor(f), input = await recognitionConsentInput(donor.request, f.slug);
    const results = await Promise.all(Array.from({ length: 6 }, () => executeRecognitionCommand(donor.request, input)));
    for (const result of results) assert.deepEqual(result, results[0]);
    for (const table of ["fp_recognition_consents", "fp_recognition_commands"]) assert.equal((await query<{ count: string }>(`SELECT count(*) FROM ${table} WHERE project_id=$1`, [f.session.projectId]))[0].count, "1");
    assert.equal((await query<{ count: string }>("SELECT count(*) FROM fp_recognition_audit WHERE command_id=$1", [results[0].commandId]))[0].count, "1");
    await assert.rejects(executeRecognitionCommand(donor.request, { ...input, label: "Changed label" }), code("RECOGNITION_INTENT_CHANGED"));
    await assert.rejects(executeRecognitionCommand(donor.request, { ...input, expectedVersion: 1 }), code("RECOGNITION_INTENT_CHANGED"));
  });
  it("concurrent altered bodies accept one exact outcome and retain the conflict", async () => {
    const f = await recognitionFixture(), donor = await recognitionDonor(f), input = await recognitionConsentInput(donor.request, f.slug);
    const outcomes = await Promise.allSettled([executeRecognitionCommand(donor.request, input), executeRecognitionCommand(donor.request, { ...input, label: "Different name" })]);
    assert.equal(outcomes.filter(row => row.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(row => row.status === "rejected" && code("RECOGNITION_INTENT_CHANGED")(row.reason)).length, 1);
    assert.equal((await readPublicRecognition(f.slug)).entries.length, 1);
  });
  it("withdraws without retaining a public/private old label, including replay of the original accepted consent", async () => {
    const f = await recognitionFixture(), donor = await recognitionDonor(f), input = await recognitionConsentInput(donor.request, f.slug, "Withdraw canary");
    const receipt = await executeRecognitionCommand(donor.request, input); await withdraw(donor.request, f.slug);
    assert.deepEqual((await readPublicRecognition(f.slug)).entries, []);
    const own = await readRecognitionDesk(donor.request, f.slug); assert.equal(own.own?.state, "withdrawn"); assert.equal(own.own?.label, null);
    assert.deepEqual(await executeRecognitionCommand(donor.request, input), receipt);
    assert.deepEqual(await readRecognitionCommand(donor.request, input.intentId, input.accessId), receipt);
    assert.equal(JSON.stringify([own, receipt]).includes("Withdraw canary"), false);
    assert.deepEqual((await readPublicRecognition(f.slug)).entries, []);
    const renewed = await recognitionConsentInput(donor.request, f.slug, "Explicit new choice"); assert.equal(renewed.expectedVersion, 2);
    await executeRecognitionCommand(donor.request, renewed);
    assert.equal((await readPublicRecognition(f.slug)).entries[0].label, "Explicit new choice");
  });
  it("organizer suppression cannot rename, opt in or undo a participant decision", async () => {
    const f = await recognitionFixture(), donor = await recognitionDonor(f), input = await recognitionConsentInput(donor.request, f.slug, "Moderation canary");
    await executeRecognitionCommand(donor.request, input);
    const moderation = await readRecognitionModeration(f.request, f.slug);
    assert.equal(moderation.entries[0].label, "Moderation canary");
    const command: RecognitionCommand = { schema: RECOGNITION_VERSION, action: "suppress", intentId: randomUUID(), accessId: moderation.access.accessId,
      sessionExpiresAt: moderation.access.sessionExpiresAt, expectedVersion: moderation.entries[0].version, handle: moderation.entries[0].handle, reason: "privacy_request", confirmed: true };
    await assert.rejects(executeRecognitionCommand(donor.request, { ...command, accessId: input.accessId, sessionExpiresAt: input.sessionExpiresAt }), code("RECOGNITION_ROLE_DENIED"));
    const receipt = await executeRecognitionCommand(f.request, command); assert.equal(receipt.version, 2);
    assert.deepEqual((await readPublicRecognition(f.slug)).entries, []);
    assert.deepEqual((await readRecognitionModeration(f.request, f.slug)).entries, []);
    const own = await readRecognitionDesk(donor.request, f.slug); assert.equal(own.own?.state, "suppressed"); assert.equal(own.own?.label, null);
    await assert.rejects(executeRecognitionCommand(f.request, { ...command, intentId: randomUUID() }), code("RECOGNITION_VERSION_CHANGED"));
    await executeRecognitionCommand(donor.request, await recognitionConsentInput(donor.request, f.slug, "Separate new decision"));
    assert.equal((await readPublicRecognition(f.slug)).entries[0].label, "Separate new decision");
  });
  for (const mutation of ["membership", "role", "token", "microsecond_deadline", "revoked"] as const) it(`withholds an original listing after ${mutation} changes and fences a never-received instruction`, async () => {
    const f = await recognitionFixture(), donor = await recognitionDonor(f), input = await recognitionConsentInput(donor.request, f.slug);
    await executeRecognitionCommand(donor.request, input);
    const neverReceived = { ...input, intentId: randomUUID(), expectedVersion: 1 };
    let request = donor.request;
    if (mutation === "membership") await query("UPDATE fp_memberships SET version=version+1 WHERE project_id=$1 AND actor_id=$2", [f.session.projectId, donor.session.actorId]);
    if (mutation === "role") await query("UPDATE fp_sessions SET role='volunteer' WHERE id=$1", [donor.session.id]);
    if (mutation === "revoked") await query("UPDATE fp_sessions SET revoked_at=clock_timestamp() WHERE id=$1", [donor.session.id]);
    if (mutation === "microsecond_deadline") await query("UPDATE fp_sessions SET expires_at=expires_at+interval '1 microsecond' WHERE id=$1", [donor.session.id]);
    if (mutation === "token") { const token = recognitionTestToken(); await query("UPDATE fp_sessions SET token_hash=$2 WHERE id=$1", [donor.session.id, tokenHash(token)]); request = { projectToken: token }; }
    assert.deepEqual((await readPublicRecognition(f.slug)).entries, []);
    await assert.rejects(executeRecognitionCommand(request, neverReceived));
    assert.equal((await query<{ count: string }>("SELECT count(*) FROM fp_recognition_commands WHERE intent_id=$1", [neverReceived.intentId]))[0].count, "0");
  });
  it("original fixed expiry is checked after a real session lock wait and never produces accepted effects", async () => {
    const f = await recognitionFixture(), donor = await recognitionDonor(f, "donor", 1_000), input = await recognitionConsentInput(donor.request, f.slug);
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), acquired = new Promise<void>(resolve => { locked = resolve; });
    const blocker = database().transaction(async tx => { await tx.query("SELECT id FROM fp_sessions WHERE id=$1 FOR UPDATE", [donor.session.id]); locked(); await gate; });
    await acquired;
    const result = executeRecognitionCommand(donor.request, input).then(value => ({ value }), error => ({ error }));
    try { await delay(Math.max(50, Date.parse(input.sessionExpiresAt) - Date.now() + 70)); } finally { release(); }
    await blocker; const outcome = await result; assert("error" in outcome);
    assert.equal((await query<{ count: string }>("SELECT count(*) FROM fp_recognition_commands WHERE intent_id=$1", [input.intentId]))[0].count, "0");
    assert.deepEqual((await readPublicRecognition(f.slug)).entries, []);
  });
  it("public proof withdrawal withholds names while own withdrawal remains independently available", async () => {
    const f = await recognitionFixture(), donor = await recognitionDonor(f), input = await recognitionConsentInput(donor.request, f.slug);
    await executeRecognitionCommand(donor.request, input);
    const desk = await readProofDesk(f.session);
    await withdrawProof(f.session, "electronics", { intentId: randomUUID(), expectedVersion: desk.packages.find(row => row.id === "electronics")!.headVersion, acknowledged: true });
    const page = await readPublicRecognition(f.slug); assert.equal(page.state, "unavailable"); assert.deepEqual(page.entries, []);
    assert.equal((await readRecognitionDesk(donor.request, f.slug)).own?.state, "withheld");
    await withdraw(donor.request, f.slug); assert.equal((await readRecognitionDesk(donor.request)).own?.state, "withdrawn");
  });
  it("first source-control insertion races cannot disclose a stale pre-withdrawal label", async () => {
    const f = await recognitionFixture(true), donor = await recognitionDonor(f);
    // A new controlled legacy-shaped source uses the shared reader's implicit
    // allowed/version1 contract before its FIRST explicit control is inserted.
    // No accepted authority, immutable proof bytes or old fixture is edited.
    await query("DELETE FROM fp_plan_source_controls WHERE document_id=$1 AND version=1 AND permission='allowed'", [f.documentId]);
    await executeRecognitionCommand(donor.request, await recognitionConsentInput(donor.request, f.slug));
    assert.equal((await query<{ count: string }>("SELECT count(*) FROM fp_plan_source_controls WHERE document_id=$1", [f.documentId]))[0].count, "0");
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), acquired = new Promise<void>(resolve => { locked = resolve; });
    const blocker = database().transaction(async tx => { await tx.query("INSERT INTO fp_plan_source_controls(document_id,tenant_id,project_id,classification,permission) VALUES($1,$2,$3,'illustration','withdrawn')", [f.documentId, f.session.tenantId, f.session.projectId]); locked(); await gate; });
    await acquired;
    try { await assert.rejects(readPublicRecognition(f.slug), code("RECOGNITION_BUSY")); } finally { release(); await blocker; }
    assert.equal((await readPublicRecognition(f.slug)).state, "unavailable");
    assert.equal((await readRecognitionDesk(donor.request, f.slug)).own?.label, null);
  });
  it("schema is additive/idempotent, repairs an individually missing trigger and rejects cross-actor head linkage", async () => {
    const f = await recognitionFixture(), donor = await recognitionDonor(f), other = await recognitionDonor(f);
    await executeRecognitionCommand(donor.request, await recognitionConsentInput(donor.request, f.slug));
    await executeRecognitionCommand(other.request, await recognitionConsentInput(other.request, f.slug, "Other participant"));
    const rows = await query<{ id: string; current_consent_id: string }>("SELECT id,current_consent_id FROM fp_recognition_heads WHERE project_id=$1 ORDER BY id", [f.session.projectId]);
    await assert.rejects(database().transaction(tx => tx.query("UPDATE fp_recognition_heads SET version=version+1,current_consent_id=$2 WHERE id=$1", [rows[0].id, rows[1].current_consent_id])));
    await assert.rejects(query("UPDATE fp_recognition_consents SET encrypted_data='changed' WHERE id=$1", [rows[0].current_consent_id]), /immutable/i);
    await query("DROP TRIGGER fp_recognition_commands_immutable ON fp_recognition_commands");
    await database().query(RECOGNITION_SCHEMA); await database().query(RECOGNITION_SCHEMA);
    assert.equal((await query<{ count: string }>("SELECT count(*) FROM pg_trigger WHERE tgrelid='fp_recognition_commands'::regclass AND tgname='fp_recognition_commands_immutable' AND NOT tgisinternal"))[0].count, "1");
    await assert.rejects(query("DELETE FROM fp_recognition_commands WHERE project_id=$1", [f.session.projectId]), /immutable/i);
  });
  it("public/private responses and stored metadata exclude private identity and prior-label canaries", async () => {
    const f = await recognitionFixture(), donor = await recognitionDonor(f), input = await recognitionConsentInput(donor.request, f.slug, "Only explicit label");
    const receipt = await executeRecognitionCommand(donor.request, input), page = await readPublicRecognition(f.slug), own = await readRecognitionDesk(donor.request, f.slug);
    const publicBytes = JSON.stringify(page), privateBytes = JSON.stringify([own, receipt]);
    for (const canary of [f.session.tenantId, f.session.projectId, donor.session.actorId, donor.session.id, donor.sessionToken, donor.recoveryToken,
      "PRIVATE PROFILE CANARY", "membershipVersion", "session_hash", "receipt", "paid", "hiddenCount"]) assert.equal(publicBytes.includes(canary), false, canary);
    assert.equal(privateBytes.includes("PRIVATE PROFILE CANARY"), false);
    const [stored] = await query<{ bytes: string }>("SELECT to_jsonb(c)::text bytes FROM fp_recognition_consents c WHERE c.project_id=$1", [f.session.projectId]);
    assert.equal(stored.bytes.includes(input.label), false);
    await withdraw(donor.request, f.slug);
    assert.equal(JSON.stringify(await readRecognitionDesk(donor.request, f.slug)).includes(input.label), false);
  });
  it("fails closed for absent procurement23, then checks its exact approved independent-entry contract", async () => {
    const f = await recognitionFixture();
    async function computationalVolunteer() {
      const actorId = randomUUID(), sessionId = randomUUID(), token = recognitionTestToken();
      const [end] = await query<{ at: string }>("SELECT to_char((date_trunc('milliseconds',clock_timestamp())+interval '1 hour') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') at");
      await query("INSERT INTO fp_memberships(tenant_id,project_id,actor_id,roles) VALUES($1,$2,$3,'[\"volunteer\"]'::jsonb)", [f.session.tenantId, f.session.projectId, actorId]);
      await query("INSERT INTO fp_sessions(id,token_hash,tenant_id,project_id,actor_id,role,expires_at) VALUES($1,$2,$3,$4,$5,'volunteer',$6)", [sessionId, tokenHash(token), f.session.tenantId, f.session.projectId, actorId, end.at]);
      return { actorId, sessionId, token, end: end.at, request: { projectToken: token } };
    }
    const person = await computationalVolunteer();
    await assert.rejects(readRecognitionDesk(person.request), code("RECOGNITION_INDEPENDENT_ENTRY_REQUIRED"));
    // Read-contract fixtures only, NOT migration23 or evidence of its acceptance
    // UI/service. The separate23 owner qualifies actual entry creation. These
    // new disposable rows exercise precisely their reviewed SQL projection.
    await query("CREATE TABLE fp_procurement_invites(id text PRIMARY KEY,tenant_id text,project_id text,state text,version integer,role text,expires_at timestamptz)");
    await assert.rejects(readRecognitionDesk(person.request), code("RECOGNITION_INDEPENDENT_ENTRY_REQUIRED"));
    await query("CREATE TABLE fp_procurement_access(id text PRIMARY KEY,invitation_id text,tenant_id text,project_id text,actor_id text,session_id text,membership_version integer,expires_at timestamptz,created_at timestamptz DEFAULT clock_timestamp())");
    async function entry(value: Awaited<ReturnType<typeof computationalVolunteer>>, version = 2, entryProject = f.session.projectId) {
      const invite = randomUUID();
      await query("INSERT INTO fp_procurement_invites VALUES($1,$2,$3,'joined',$4,'volunteer',$5)", [invite, f.session.tenantId, entryProject, version, value.end]);
      await query("INSERT INTO fp_procurement_access(id,invitation_id,tenant_id,project_id,actor_id,session_id,membership_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,1,$7)", [randomUUID(), invite, f.session.tenantId, f.session.projectId, value.actorId, value.sessionId, value.end]);
      return invite;
    }
    const invite = await entry(person);
    await executeRecognitionCommand(person.request, await recognitionConsentInput(person.request, f.slug, "Controlled procurement initials"));
    assert.equal((await readPublicRecognition(f.slug)).entries[0].label, "Controlled procurement initials");
    await query("UPDATE fp_procurement_invites SET state='revoked',version=version+1 WHERE id=$1", [invite]);
    assert.deepEqual((await readPublicRecognition(f.slug)).entries, []);
    await assert.rejects(readRecognitionDesk(person.request), code("RECOGNITION_INDEPENDENT_ENTRY_REQUIRED"));
    const badVersion = await computationalVolunteer(); await entry(badVersion, 3);
    await assert.rejects(readRecognitionDesk(badVersion.request), code("RECOGNITION_INDEPENDENT_ENTRY_REQUIRED"));
    const foreign = await computationalVolunteer(); await entry(foreign, 2, randomUUID());
    await assert.rejects(readRecognitionDesk(foreign.request), code("RECOGNITION_INDEPENDENT_ENTRY_REQUIRED"));
  });
});
