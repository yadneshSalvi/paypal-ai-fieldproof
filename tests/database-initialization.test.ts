import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresDatabase } from "@fracture/paypal-core";
import { initializeDatabaseAt } from "../lib/server/db";
import { routeFailure } from "../lib/server/http";

const baseUrl = process.env.DATABASE_URL!;
const name = `fp_initialization_${randomUUID().replaceAll("-", "")}`;
const admin = new PostgresDatabase(baseUrl);
let target: PostgresDatabase;
before(async () => {
  await admin.query(`CREATE SCHEMA "${name}"`);
  const url = new URL(baseUrl); url.searchParams.set("options", `-c search_path=${name}`);
  target = new PostgresDatabase(url.href);
});
after(async () => { await target.close(); await admin.query(`DROP SCHEMA "${name}" CASCADE`); await admin.close(); });

describe("bounded cold database initialization", () => {
  it("returns a safe retryable 503 when a migration lock is busy, then succeeds after release", async () => {
    let entered!: () => void, release!: () => void;
    const locked = new Promise<void>(resolve => { entered = resolve; });
    const drain = new Promise<void>(resolve => { release = resolve; });
    const holder = admin.transaction(async tx => { await tx.query("SELECT pg_advisory_xact_lock(410202611)"); entered(); await drain; });
    await locked;
    const started = Date.now();
    try {
      await assert.rejects(initializeDatabaseAt(target), error => {
        const response = routeFailure(error);
        assert.equal(response.status, 503); assert.equal(response.headers.get("Retry-After"), "30");
        return typeof error === "object" && error !== null && "code" in error && error.code === "DATABASE_INITIALIZING";
      });
      assert.ok(Date.now() - started < 4500, "initialization should not wait for the long import");
      assert.equal((await target.query("SELECT to_regclass('fp_schema_versions')::text AS present")).rows[0].present, null);
    } finally { release(); await holder; }
    await initializeDatabaseAt(target);
    assert.equal((await target.query("SELECT max(version) AS version FROM fp_schema_versions")).rows[0].version, 14);
    for (const table of ["fp_proof_heads", "fp_proof_derivatives", "fp_proof_snapshots"]) assert.ok((await target.query("SELECT to_regclass($1)::text AS present", [table])).rows[0].present);
    assert.ok((await target.query("SELECT to_regclass('paycore_provider_identity')::text AS present")).rows[0].present);
    assert.ok((await target.query("SELECT to_regclass('fp_plan_provider_observations')::text AS present")).rows[0].present);
    assert.equal((await target.query("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='fp_plan_runs' AND column_name='resume_until'")).rows[0].count, 1);
    for (const table of ["fp_workspace_libraries", "fp_workspace_library_entries", "fp_community_snapshots", "fp_community_translations", "fp_community_runs", "fp_community_update_previews"]) assert.ok((await target.query("SELECT to_regclass($1)::text AS present", [table])).rows[0].present);
  });

  it("does not rerun DDL on a ready schema while an import owns table and migration locks", async () => {
    let entered!: () => void, release!: () => void;
    const locked = new Promise<void>(resolve => { entered = resolve; });
    const drain = new Promise<void>(resolve => { release = resolve; });
    const holder = target.transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(410202611)");
      await tx.query("LOCK TABLE fp_projects IN SHARE ROW EXCLUSIVE MODE");
      entered(); await drain;
    });
    await locked;
    try { await initializeDatabaseAt(target); }
    finally { release(); await holder; }
    assert.equal((await target.query("SELECT count(*)::int AS count FROM fp_projects")).rows[0].count, 0);
  });

  it("repairs a missing payment-store index instead of accepting only the app version marker", async () => {
    await target.query("DROP INDEX paycore_provider_identity");
    await initializeDatabaseAt(target);
    assert.ok((await target.query("SELECT to_regclass('paycore_provider_identity')::text AS present")).rows[0].present);
  });

  it("repairs an incomplete community schema even when its version marker is current", async () => {
    await target.query("DROP TABLE fp_community_update_previews");
    await initializeDatabaseAt(target);
    assert.ok((await target.query("SELECT to_regclass('fp_community_update_previews')::text AS present")).rows[0].present);
    await target.query("DROP INDEX fp_community_due_runs");
    await initializeDatabaseAt(target);
    assert.ok((await target.query("SELECT to_regclass('fp_community_due_runs')::text AS present")).rows[0].present);
    assert.equal((await target.query("SELECT max(version) AS version FROM fp_schema_versions")).rows[0].version, 14);
  });

  it("repairs disabled funding-history and receipt-version guards", async () => {
    await target.query("ALTER TABLE fp_settlement_receipts DISABLE TRIGGER fp_receipt_version_on_change");
    await target.query("DROP TRIGGER fp_funding_assignment_immutable ON fp_funding_assignments");
    await initializeDatabaseAt(target);
    const result=await target.query("SELECT count(*)::int AS count FROM pg_trigger WHERE tgrelid=ANY(ARRAY[to_regclass('fp_settlement_receipts'),to_regclass('fp_funding_assignments')]) AND tgname IN ('fp_receipt_version_on_change','fp_funding_assignment_immutable') AND tgenabled='O'");
    assert.equal(result.rows[0].count,2);
  });
});
