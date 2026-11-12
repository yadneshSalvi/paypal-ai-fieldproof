import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { recognitionFixture, recognitionDonor, recognitionConsentInput, recognitionErrorCode as code } from "./helpers/recognition-fixtures";
import { database, query } from "../lib/server/db";
import { readPublicRecognition, readRecognitionDesk, consentContext } from "../lib/server/recognition-store";
import { executeRecognitionCommand } from "../lib/server/recognition-commands";
import { recognitionAuthority, recognitionSource } from "../lib/server/recognition-source";
import { sealPrivate } from "../lib/server/private-values";
import { createProofDraft, decideProofSnapshot, readProofDesk, withdrawProof } from "../lib/server/proof";

describe("recognition real millisecond keyset and edition boundaries", () => {
  it("pages exact equal-millisecond timestamps without skips, duplicates or old-proof revival", async () => {
    const f = await recognitionFixture(), people: Awaited<ReturnType<typeof recognitionDonor>>[] = [];
    for (let index = 0; index < 23; index++) {
      const person = await recognitionDonor(f); people.push(person);
      await executeRecognitionCommand(person.request, await recognitionConsentInput(person.request, f.slug, `Controlled person ${index}`));
    }
    const [edge] = await query<{ at: string; id: string }>(`SELECT to_char(date_trunc('milliseconds',consented_at AT TIME ZONE 'UTC'),'YYYY-MM-DD"T"HH24:MI:SS.MS') at,id
      FROM fp_recognition_consents WHERE project_id=$1 ORDER BY consented_at DESC,id DESC LIMIT 1`, [f.session.projectId]);
    // Two ADDITIONAL computational initial rows, never edited history. Their
    // independent entries are real ordinary-service entries. All scope/FK/
    // immutable guards run, but no human consent or provider observation is
    // claimed by this deterministic timestamp construction.
    const boundaryLabels = ["Synthetic boundary A", "Synthetic boundary B"];
    for (let index = 0; index < 2; index++) {
      const person = await recognitionDonor(f), id = index === 0 ? "ffffffff-ffff-4fff-bfff-fffffffffffe" : "ffffffff-ffff-4fff-bfff-ffffffffffff", head = randomUUID();
      assert(edge.id < id); people.push(person);
      await database().transaction(async tx => {
        await tx.query("LOCK TABLE fp_plan_source_controls IN SHARE MODE");
        const authority = await recognitionAuthority(tx, person.request), source = (await recognitionSource(tx, f.slug, person.session))!;
        await tx.query(`INSERT INTO fp_recognition_consents(id,head_id,tenant_id,project_id,actor_id,role,version,session_id,session_hash,membership_version,
          session_expires_at,entry_kind,entry_id,entry_expires_at,expires_at,slug,proof_snapshot_id,proof_hash,review_key,access_id,mode,encrypted_data,consented_at)
          VALUES($1,$2,$3,$4,$5,'donor',1,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'sample',$19,$20)`,
        [id, head, person.session.tenantId, person.session.projectId, person.session.actorId, person.session.id, authority.tokenHash, authority.membershipVersion,
          authority.access.sessionExpiresAt, authority.entry!.kind, authority.entry!.id, authority.entry!.expiresAt, authority.access.validUntil, f.slug, source.snapshotId,
          source.target.contentHash, source.target.reviewKey, authority.access.accessId, sealPrivate({ label: boundaryLabels[index], publicVisibilityAcknowledged: true, selfDeclaredAcknowledged: true },
            consentContext({ id, tenant_id: person.session.tenantId, project_id: person.session.projectId })), `${edge.at}${index === 0 ? "100" : "900"}Z`]);
        await tx.query("INSERT INTO fp_recognition_heads(id,tenant_id,project_id,actor_id,role,slug,version,state,current_consent_id) VALUES($1,$2,$3,$4,'donor',$5,1,'consented',$6)", [head, person.session.tenantId, person.session.projectId, person.session.actorId, f.slug, id]);
      });
    }
    const first = await readPublicRecognition(f.slug); assert.equal(first.entries.length, 24); assert(first.nextCursor);
    assert(first.entries.some(row => row.label === boundaryLabels[0])); assert(!first.entries.some(row => row.label === boundaryLabels[1]));
    const second = await readPublicRecognition(f.slug, first.nextCursor); assert.deepEqual(second.entries.map(row => row.label), [boundaryLabels[1]]); assert.equal(second.nextCursor, null);
    const all = [...first.entries, ...second.entries].map(row => row.label); assert.equal(new Set(all).size, 25);
    for (const label of boundaryLabels) assert(all.includes(label));
    const foreign = await recognitionFixture(); await assert.rejects(readPublicRecognition(foreign.slug, first.nextCursor), code("RECOGNITION_PAGE_CHANGED"));
    const before = await readProofDesk(f.session), pkg = before.packages.find(row => row.id === "electronics")!;
    await withdrawProof(f.session, "electronics", { intentId: randomUUID(), expectedVersion: pkg.headVersion, acknowledged: true });
    const unavailable = await readPublicRecognition(f.slug, first.nextCursor); assert.equal(unavailable.state, "unavailable"); assert.deepEqual(unavailable.entries, []);
    let desk = await readProofDesk(f.session);
    const draft = await createProofDraft(f.session, { intentId: randomUUID(), packageId: "electronics", expectedVersion: desk.packages.find(row => row.id === "electronics")!.headVersion, derivativeIds: [] });
    for (const action of ["review", "publish"] as const) {
      desk = await readProofDesk(f.session); const snapshot = desk.snapshots.find(row => row.id === draft.id)!;
      await decideProofSnapshot(f.session, action, { intentId: randomUUID(), snapshotId: draft.id, expectedVersion: desk.packages.find(row => row.id === "electronics")!.headVersion, contentHash: snapshot.contentHash, acknowledged: true });
    }
    assert.deepEqual((await readPublicRecognition(f.slug)).entries, []);
    await assert.rejects(readPublicRecognition(f.slug, first.nextCursor), code("RECOGNITION_PAGE_CHANGED"));
    assert.equal((await readRecognitionDesk(people[0].request, f.slug)).own?.label, null);
    await executeRecognitionCommand(people[0].request, await recognitionConsentInput(people[0].request, f.slug, "Separate current edition choice"));
    assert.deepEqual((await readPublicRecognition(f.slug)).entries.map(row => row.label), ["Separate current edition choice"]);
  });
});
