/** Qualify the explicit native NFT closure as plain production JavaScript.
 * Only a unique private copy is executed; no app, DB or real transport starts. */
import "./toolkit-deny-network.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url)), require = createRequire(import.meta.url);
const sha = value => createHash("sha256").update(value).digest("hex");
export async function qualifyToolkitTrace() {
  assert.equal(process.cwd() + path.sep, root);
  const unit = path.join(root, ".local/toolkit-transport-unit"), id = randomUUID(), control = path.join(unit, "nft-controls", id), deployed = path.join(control, "deployed");
  fs.mkdirSync(deployed, { recursive: true, mode: 0o700 });
  const ts = require("typescript"), { nodeFileTrace } = require("next/dist/compiled/@vercel/nft");
  const original = fs.readFileSync(path.join(root, "lib/server/studio-toolkit-transport.ts"));
  const source = ts.transpileModule(original.toString("utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const runtime = path.join(control, "studio-toolkit-transport.mjs"); fs.writeFileSync(runtime, source, { flag: "wx", mode: 0o600 });
  const nativeEntry = require.resolve("@paypal/agent-toolkit/openai"), native = createRequire(nativeEntry);
  let report = { id, phase: "tracing", databaseInitialized: false, appRuntimeStarted: false, actualProviderModelCalls: false,
    transportSourceSha256: sha(original), transpiledRuntimeSha256: sha(source), nativeEntry: path.relative(root, nativeEntry), nativeEntrySha256: sha(fs.readFileSync(nativeEntry)) };
  const reportFile = path.join(unit, `nft-qualification-${id}.private.json`);
  try {
    // Dynamic createRequire.resolve is not enough: explicitly seed the native
    // entry, matching the integration owner's production tracing include.
    const traced = await nodeFileTrace([runtime, nativeEntry], { base: root, processCwd: root });
    const required = [nativeEntry, ...["axios", "zod", "mathjs", "lodash", "debug", "@paypal/paypal-server-sdk"].map(name => native.resolve(name))];
    for (const file of required) assert.ok(traced.fileList.has(path.relative(root, file)), `Required native dependency missing from trace: ${path.relative(root, file)}`);
    const copied = [];
    for (const relative of [...traced.fileList].sort()) {
      assert.ok(!path.isAbsolute(relative) && !relative.split(path.sep).includes(".."));
      const from = path.join(root, relative), target = relative === path.relative(root, runtime) ? path.join(deployed, "studio-toolkit-transport.mjs") : path.join(deployed, relative);
      assert.ok(target.startsWith(deployed + path.sep));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.copyFileSync(from, target, fs.constants.COPYFILE_FICLONE);
      const a = fs.statSync(from), b = fs.statSync(target); assert.ok(a.dev !== b.dev || a.ino !== b.ino);
      copied.push({ path: relative === path.relative(root, runtime) ? "studio-toolkit-transport.mjs" : relative, sha256: sha(fs.readFileSync(target)) });
    }
    const probe = path.join(deployed, "probe.mjs");
    fs.writeFileSync(probe, `import assert from 'node:assert/strict';import {createRequire}from'node:module';import path from'node:path';import{createHash}from'node:crypto';import fs from'node:fs';
      const root=process.cwd(),require=createRequire(import.meta.url),nativeEntry=require.resolve('@paypal/agent-toolkit/openai');
      const {readNativeToolkit,TOOLKIT_OPENAI_SHA256}=await import('./studio-toolkit-transport.mjs');const calls=[];
      for(const[tool,id]of[['get_order','5O190127TN364715T'],['get_invoice','INV2-TEST-ONLY-1234']]){
        const result=await readNativeToolkit({tool,providerId:id,clientId:'synthetic-nft-client',clientSecret:'synthetic-nft-secret',fetcher:async(input,init)=>{const url=new URL(String(input));calls.push([init.method,url.pathname]);assert.equal(init.redirect,'error');return Response.json(init.method==='POST'?{access_token:'synthetic-nft-token'}:{id,status:'COMPLETED'});}});assert.equal(result.id,id);
      }
      const loaded=Object.keys(require.cache);assert.ok(loaded.every(file=>file.startsWith(root+path.sep)),'A dependency escaped the copied trace');assert.equal(require.cache[nativeEntry],undefined,'The official source executes in the private factory, not require.cache');
      const sourceHash=createHash('sha256').update(fs.readFileSync(nativeEntry)).digest('hex');assert.equal(sourceHash,TOOLKIT_OPENAI_SHA256);
      assert.deepEqual(calls,[['POST','/v1/oauth2/token'],['GET','/v2/checkout/orders/5O190127TN364715T'],['POST','/v1/oauth2/token'],['GET','/v2/invoicing/invoices/INV2-TEST-ONLY-1234']]);
      const{toolkitNetworkAttempts}=await import(${JSON.stringify(new URL("./toolkit-deny-network.mjs", import.meta.url).href)});assert.equal(toolkitNetworkAttempts(),0);
      console.log(JSON.stringify({calls,nativeSourceSha256:sourceHash,nativeFactoryExecuted:true,publicNativeEntryInRequireCache:false,normalDependencyCache:loaded.map(file=>path.relative(root,file)).sort(),networkAttempts:0}));`, { flag: "wx", mode: 0o600 });
    const guard = fileURLToPath(new URL("./toolkit-deny-network.mjs", import.meta.url));
    const child = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${deployed}`, `--allow-fs-read=${guard}`, "--import", guard, probe],
      { cwd: deployed, env: { NODE_ENV: "test" }, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    report = { ...report, phase: "copied_closure_execution", explicitNativeRootRequired: true, copiedFiles: copied, closureSha256: sha(JSON.stringify(copied)),
      warnings: [...traced.warnings].map(error => error.message), fixedNativeEntries: required.map(file => path.relative(root, file)),
      child: { status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr, error: child.error?.message ?? null },
      parentDependencyFallbackForbiddenByNodePermissions: true };
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const receipt = JSON.parse(child.stdout); for (const file of receipt.normalDependencyCache) assert.ok(copied.some(item => item.path === file), `Loaded dependency was not in NFT closure: ${file}`);
    report.phase = "qualified"; report.receipt = receipt; return { reportFile, copiedFileCount: copied.length, receipt };
  } catch (error) { report.phase = "failed"; report.failure = String(error?.stack ?? error); throw error; }
  finally {
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    assert.ok(control.startsWith(path.join(unit, "nft-controls") + path.sep) && path.basename(control) === id); fs.rmSync(control, { recursive: true });
  }
}
