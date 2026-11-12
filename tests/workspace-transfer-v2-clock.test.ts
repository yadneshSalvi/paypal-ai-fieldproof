import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ownedState } from "./helpers/operations-v2-fixtures";

test("observe the owned database clock without editing time, deadlines or original rows", async () => {
  const { source, target, schemas } = ownedState();
  const sql = `SELECT clock_timestamp()::text clock,statement_timestamp()::text statement,transaction_timestamp()::text transaction,pg_catalog.clock_timestamp()::text catalog_clock,
    (extract(epoch FROM pg_catalog.clock_timestamp())*1000000)::bigint::text micros,current_setting('TimeZone') timezone,
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema() AND p.proname IN ('clock_timestamp','statement_timestamp','transaction_timestamp')) local_clock_overrides,
    extract(epoch FROM (to_char(clock_timestamp()+interval '150 milliseconds','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::timestamptz-pg_catalog.clock_timestamp())::text mislabeled_z_delta_seconds`;
  const before = await source.transaction(async tx => (await tx.query(sql)).rows[0]);
  await new Promise(resolve => setTimeout(resolve, 150));
  // A separately committed connection/pool, with its own sole fresh namespace.
  const after = await target.transaction(async tx => (await tx.query(sql)).rows[0]);
  const result = { qualificationClock: "two-owned-private-schema-connections", before, after, elapsedMicros: (BigInt(String(after.micros)) - BigInt(String(before.micros))).toString(), hostWaitMilliseconds: 150, changedClock: false };
  assert.equal(before.local_clock_overrides, 0); assert.equal(after.local_clock_overrides, 0); assert(BigInt(result.elapsedMicros) > 100_000n);
  await writeFile(path.resolve(process.cwd(), `.local/operations-v2-unit/clock-probe-${schemas.source}.private.json`), JSON.stringify({ sql, ...result }, null, 2), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(result));
});
