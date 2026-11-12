import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir,readFile,writeFile,lstat } from "node:fs/promises";
import path from "node:path";
import { before,test } from "node:test";
import { canonicalJson,sha256 } from "@fracture/paypal-core";
import { digest,hash,OperationsError,type Row,type TransferReceiptV2,type WorkspaceBundleV2 } from "../lib/operations/contracts";
import { assertCatalog,assertRegistry,CURRENT_TABLES,SCHEMA24_CATALOG_HASH } from "../lib/operations/current-registry";
import { EXTENSION_TABLES,EXTENSION_FRAGMENTS } from "../lib/operations/extensions";
import { readCatalog,readRows } from "../lib/operations/catalog";
import { openOriginal,sealOriginal,openTransferFile } from "../lib/operations/crypto";
import { assertOriginalLineage,originalRows,insertionOrder,keyHash,timestampMicros } from "../lib/operations/lineage";
import { inspectPrivateLineage,privateContext } from "../lib/operations/private-lineage";
import { beginSnapshot,snapshotIn,assertFreshDestination } from "../lib/operations/snapshot";
import { HISTORICAL_RESTORE_GUARDS,withHistoricalRestoreGuards } from "../lib/operations/restore-guards";
import { captureWorkspaceV2,applyWorkspaceTransferV2,planWorkspaceTransferV2,verifyWorkspaceTransferV2 } from "../lib/server/workspace-transfer-v2";
import { lifecycleInbox } from "../lib/server/lifecycle-personal";
import { readPublicRecognition } from "../lib/server/recognition-store";
import { openPrivate } from "../lib/server/private-values";
import { runWorkspaceTransferV2 } from "../scripts/workspace-transfer-v2";
import { createExtensionFixture,type ExtensionFixture } from "./helpers/operations-v2-extension-fixtures";
import { interceptDatabase } from "./helpers/operations-v2-complete-fixtures";
let f:ExtensionFixture,receipt:TransferReceiptV2;
let cli:{config:string;bundle:string;plan:string;receipt:string;directory:string};
const rejection=(code:string)=>(error:unknown)=>error instanceof OperationsError && error.code===code;
const stableHash=(value:unknown)=>sha256(canonicalJson(value));
const mutate=(table:string,work:(rows:Row[])=>Row[])=>{const copy=structuredClone(f.bundle),item=copy.source.tables.find(row=>row.name===table)!;item.rows=work(item.rows.map(text=>JSON.parse(text))).map(row=>JSON.stringify(row));item.count=item.rows.length;item.hash=digest(item.rows);copy.source.rowsHash=digest(copy.source.tables);return copy;};
const validateOriginal=(bundle:WorkspaceBundleV2)=>{const rows=originalRows(bundle.source.tables,bundle.source.catalog);assertOriginalLineage(rows,bundle.source.catalog);return inspectPrivateLineage(rows,bundle.source.tables,f.secret);};
const unchangedTarget=async()=>{const actual=await captureWorkspaceV2(f.target,true);assert.equal(actual.rowsHash,f.plan.destination.rowsHash);assert.equal(actual.catalogHash,SCHEMA24_CATALOG_HASH);assert.equal(actual.sequenceHash,f.plan.destination.sequenceHash);assert(actual.catalog.tables.every(table=>table.triggers.every(trigger=>trigger.enabled==="O")));};
before(async()=>{f=await createExtensionFixture();});

test("all40 new families have original rows, exact keys/private codecs and joined177 coverage",()=>{
 assert.equal(CURRENT_TABLES.length,177);assert.equal(EXTENSION_TABLES.length,40);assert.equal(new Set(CURRENT_TABLES.map(row=>row.name)).size,177);
 for(const table of EXTENSION_TABLES) assert(f.bundle.source.tables.find(row=>row.name===table.name)!.count>0,table.name);
 const ordered=insertionOrder(f.bundle.source.catalog,originalRows(f.bundle.source.tables,f.bundle.source.catalog)).map(row=>row.table);assert(ordered.indexOf("fp_memberships")<ordered.indexOf("fp_lifecycle_preference_heads"));assert(ordered.slice(0,137).every(name=>!EXTENSION_TABLES.some(table=>table.name===name)));
 assert.equal(f.bundle.schemaVersion,24);assert.equal(f.bundle.codeCommit,"ddadae2c259ce874ab760b1f9f133cf653021e85");assertCatalog(f.bundle.source.catalog);
 const rows=originalRows(f.bundle.source.tables,f.bundle.source.catalog);assertRegistry(f.bundle.source.catalog,rows.get("fp_schema_versions")!);assertOriginalLineage(rows,f.bundle.source.catalog);
});
test("v24 CLI basis/export/plan produces private original files and a concrete177-table review",async()=>{
 const directory=path.join(f.owned.artifactRoot,"operator-cli");await mkdir(directory,{mode:0o700});cli={directory,config:path.join(directory,"operator.private.json"),bundle:path.join(directory,"bundle.sealed.json"),plan:path.join(directory,"plan.sealed.json"),receipt:path.join(directory,"receipt.sealed.json")};
 const local=JSON.parse(await readFile(path.resolve(process.cwd(),".local/operations-complete-v2-unit/private.json"),"utf8")) as {DATABASE_URL:string};
 const endpoint=(value:typeof f.source,directory:string)=>({databaseUrl:local.DATABASE_URL,schema:value.schema,label:value.label,authSecret:f.secret,merchantClientId:value.merchantClientId,artifacts:{kind:"private-files",directory,namespace:value.artifactStore.namespace}});
 await writeFile(cli.config,JSON.stringify({format:"fieldproof-workspace-operator/v2",source:endpoint(f.source,f.sourceDirectory),destination:endpoint(f.target,f.targetDirectory)}),{mode:0o600});
 const backup=path.join(directory,"synthetic.backup.private"),review=path.join(directory,"backup-review.private.json");await writeFile(backup,f.backupBytes,{mode:0o600});await writeFile(review,JSON.stringify(f.backup),{mode:0o600});const output:unknown[]=[];
 await runWorkspaceTransferV2(["basis","--config",cli.config,"--out",path.join(directory,"basis.private.json")],value=>output.push(value));
 await runWorkspaceTransferV2(["export","--config",cli.config,"--backup",backup,"--backup-review",review,"--out",cli.bundle],value=>output.push(value));
 f.bundle=openTransferFile<WorkspaceBundleV2>(await readFile(cli.bundle,"utf8"),"bundle",f.secret);
 await runWorkspaceTransferV2(["plan","--config",cli.config,"--bundle",cli.bundle,"--reason",f.plan.operatorReason,"--out",cli.plan],value=>output.push(value));f.plan=openTransferFile(await readFile(cli.plan,"utf8"),"plan",f.secret);
 assert.equal((output.at(-1) as Row).tables,177);assert.equal((output.at(-1) as Row).reviewHash,digest(f.plan));assert.equal((await lstat(cli.bundle)).mode&0o777,0o600);assert.equal((await lstat(cli.plan)).mode&0o777,0o600);
 for(const value of [f.secret,local.DATABASE_URL,f.extension.tokens.donor,f.extension.ids.donorSession]) assert(!JSON.stringify(output).includes(value));await unchangedTarget();
});
test("ended grants retain exact original roles, tokens and deadlines after ordinary mutable role/member changes",()=>{
 const rows=originalRows(f.bundle.source.tables,f.bundle.source.catalog),grant=rows.get("fp_lifecycle_preference_versions")!.find(row=>row.id===f.extension.ids.preference1)!,session=rows.get("fp_sessions")!.find(row=>row.id===f.extension.ids.donorSession)!;
 assert.equal(session.role,"volunteer");assert.equal(grant.membership_version,1);const decoded=openOriginal<Row>(grant.encrypted_grant,privateContext("fp_lifecycle_preference_versions","encrypted_grant",grant,rows),f.secret);
 assert.equal(decoded.role,"donor");assert.equal(decoded.projectToken,f.extension.tokens.donor);assert.equal(hash(String(decoded.projectToken)),session.token_hash);assert.equal(timestampMicros(String(decoded.expiresAt)),timestampMicros(String(session.expires_at)));assert.equal(timestampMicros(String(session.expires_at)),timestampMicros(f.extension.deadline));
 assert.equal(rows.get("fp_memberships")!.find(row=>row.actor_id===f.extension.donor)!.version,2);validateOriginal(f.bundle);
});
test("complete original histories retain both quote versions, nine operational changes and all public consent decisions",()=>{
 const rows=originalRows(f.bundle.source.tables,f.bundle.source.catalog);assert.equal(rows.get("fp_procurement_quote_versions")!.length,2);assert.equal(rows.get("fp_package_operation_events")!.length,9);assert.equal(rows.get("fp_package_operations")![0].cycle,2);
 assert.equal(rows.get("fp_recognition_commands")!.length,6);assert.equal(rows.get("fp_recognition_consents")!.length,4);assert.equal(rows.get("fp_recognition_heads")!.find(row=>row.id===f.extension.ids.recognitionDonor)!.version,3);
 assert.equal(rows.get("fp_proof_heads")![0].state,"withdrawn");assert.equal(rows.get("fp_proof_snapshots")!.find(row=>row.id===f.extension.ids.proof1)!.state,"superseded");
 assert.equal(rows.get("fp_lifecycle_program_heads")![0].state,"disabled");assert.equal(rows.get("fp_lifecycle_program_versions")!.length,2);assert.equal(rows.get("fp_lifecycle_schedule_versions")!.length,2);assert.equal(rows.get("fp_lifecycle_schedule_events")!.length,4);
});
test("original lifecycle cutoff, skip, retry, running attempt and observer lease remain byte-exact pending review",()=>{
 const rows=originalRows(f.bundle.source.tables,f.bundle.source.catalog),scheduled=rows.get("fp_lifecycle_snapshots")![0];assert.equal(timestampMicros(String(scheduled.captured_at)),timestampMicros(f.extension.scheduled.asOf));
 assert.equal(rows.get("fp_lifecycle_occurrences")!.find(row=>row.id===f.extension.ids.skip)!.snapshot_hash,null);assert.equal(rows.get("fp_lifecycle_attempts")!.find(row=>row.occurrence_id===f.extension.ids.running)!.outcome,"running");
 const observer=rows.get("fp_lifecycle_observer_heads")![0];assert.equal(observer.lease_token,"synthetic-original-observer-lease");assert(observer.encrypted_cursor);assert.equal(f.bundle.source.execution.activeWorkers,0);
 for(const name of ["fp_lifecycle_schedules","fp_lifecycle_occurrences","fp_lifecycle_attempts","fp_lifecycle_observer_heads","fp_procurement_invites","fp_procurement_access","fp_recognition_heads"]) assert(f.bundle.activation.records.some(row=>row.table===name));
});
test("withdrawn quote sources keep original private bytes/encryption bindings and unknown amounts rather than zero",async()=>{
 const rows=originalRows(f.bundle.source.tables,f.bundle.source.catalog),quote=rows.get("fp_procurement_quote_versions")!.find(row=>row.version===2)!,payload=openOriginal<Row>(quote.encrypted_data,privateContext("fp_procurement_quote_versions","encrypted_data",quote,rows),f.secret);
 assert.equal((payload.draft as Row).statedTotalMinor,null);assert.equal(rows.get("fp_procurement_progress")![0].percent,null);assert.equal(rows.get("fp_plan_source_controls")!.find(row=>row.document_id===f.extension.ids.quoteDocument)!.permission,"withdrawn");
 const source=f.bundle.artifacts.find(row=>row.key===`fieldproof/${f.extension.ids.quoteDocument}/original.png`)!;assert.equal(source.hash,f.imageHash);assert.equal(hash(Buffer.from(source.bytes,"base64")),f.imageHash);await f.source.artifactStore.verify(source.key,source.hash,source.size,source.contentType);
});
test("historical private body and unsent preview never become current access or a renewed public listing",async()=>{
 const before=await captureWorkspaceV2(f.source),page=await readPublicRecognition(f.extension.slug);assert.equal(page.state,"unavailable");assert.deepEqual(page.entries,[]);
 await assert.rejects(lifecycleInbox({organizationToken:null,libraryToken:null,browserKey:"synthetic-private-browser",projectToken:f.extension.tokens.donor,personalScope:String(f.extension.originalGrant.scope)}),error=>typeof error==="object"&&error!==null&&"code" in error&&error.code==="LIFECYCLE_AUTHORITY_ENDED");
 const rows=originalRows(f.bundle.source.tables,f.bundle.source.catalog),inbox=rows.get("fp_lifecycle_inbox")![0],saved=openOriginal<Row>(inbox.encrypted_data,privateContext("fp_lifecycle_inbox","encrypted_data",inbox,rows),f.secret);assert.equal((saved.emailPreview as Row).destination,null);assert.equal((saved.emailPreview as Row).sent,false);
 const after=await captureWorkspaceV2(f.source);assert.equal(after.rowsHash,before.rowsHash);assert.equal(after.catalogHash,before.catalogHash);assert.equal(after.sequenceHash,before.sequenceHash);
});
test("older schema21, unknown25, missing new families, keys or private columns refuse without initialization",async()=>{
 for(const version of [21,25]) await assert.rejects(planWorkspaceTransferV2(f.source,f.target,{...f.bundle,schemaVersion:version} as WorkspaceBundleV2,f.plan.operatorReason),rejection("UNSUPPORTED_COVERAGE"));
 for(const work of [(catalog:typeof f.bundle.source.catalog)=>{catalog.tables=catalog.tables.filter(table=>table.name!=="fp_recognition_consents");},(catalog:typeof f.bundle.source.catalog)=>{catalog.tables.find(table=>table.name==="fp_procurement_quote_versions")!.keys=[];},(catalog:typeof f.bundle.source.catalog)=>{catalog.tables.find(table=>table.name==="fp_lifecycle_inbox")!.columns=catalog.tables.find(table=>table.name==="fp_lifecycle_inbox")!.columns.filter(column=>column.name!=="encrypted_data");}]) {const catalog=structuredClone(f.bundle.source.catalog);work(catalog);assert.throws(()=>assertCatalog(catalog),rejection("CATALOG_CHANGED"));}
 await unchangedTarget();
});
test("omitting an old quote revision, operation event, schedule decision or recognition command cannot silently pass",()=>{
 for(const [table,drop] of [["fp_procurement_quote_versions",(row:Row)=>row.version===1],["fp_package_operation_events",(row:Row)=>row.version===3],["fp_lifecycle_schedule_events",(row:Row)=>row.schedule_version===2],["fp_recognition_commands",(row:Row)=>row.action==="withdraw"]] as const) assert.throws(()=>validateOriginal(mutate(table,rows=>rows.filter(row=>!drop(row)))),rejection("PRIVATE_LINEAGE"));
});
test("crossed actor/session/source identities and widened original grant deadlines are rejected",()=>{
 for(const changed of [mutate("fp_procurement_quote_versions",rows=>rows.map(row=>({...row,actor_id:f.extension.donor}))),mutate("fp_recognition_consents",rows=>rows.map(row=>({...row,session_hash:hash("different-token")}))),mutate("fp_lifecycle_inbox",rows=>rows.map(row=>({...row,expires_at:"2031-01-01T00:00:00.000000Z"}))),mutate("fp_procurement_quote_versions",rows=>rows.map(row=>({...row,source_document_id:f.id.document})))]) assert.throws(()=>validateOriginal(changed),rejection("PRIVATE_LINEAGE"));
});
test("authenticated original grant and source bodies still require their recorded role/version and frozen content hashes",()=>{
 const row=originalRows(f.bundle.source.tables,f.bundle.source.catalog).get("fp_lifecycle_preference_versions")![0],grant=openOriginal<Row>(row.encrypted_grant,`lifecycle:private-lifecycle-v1:preference:${row.id}`,f.secret),changedGrant={...grant,role:"volunteer"};
 const changed=mutate("fp_lifecycle_preference_versions",rows=>rows.map(value=>value.id===row.id?{...value,encrypted_grant:sealOriginal(changedGrant,`lifecycle:private-lifecycle-v1:preference:${row.id}`,f.secret),content_hash:stableHash(changedGrant)}:value));assert.throws(()=>validateOriginal(changed),rejection("PRIVATE_LINEAGE"));
 const altered=mutate("fp_lifecycle_contents",rows=>rows.map(value=>({...value,content_hash:hash("changed-private-content")})));assert.throws(()=>validateOriginal(altered),rejection("PRIVATE_LINEAGE"));
});
test("the exact21 target exceptions refuse a read transaction without all177 exclusive locks",async()=>{
 assert.equal(HISTORICAL_RESTORE_GUARDS.length,21);assert.equal(new Set(HISTORICAL_RESTORE_GUARDS.map(row=>row.trigger)).size,21);
 await assert.rejects(f.target.database.transaction(async tx=>{await beginSnapshot(tx,f.target);await withHistoricalRestoreGuards(tx,f.plan.destination,async()=>{assert.fail("No issuance exception window may open without its actual exclusive target locks");});}),rejection("DESTINATION_NOT_FRESH"));await unchangedTarget();
});
test("a real FK violation inside the narrow target window rolls back every insertion and every trigger mode",async()=>{
 let reached=false;const target={...f.target,database:interceptDatabase(f.target.database,async(sql,params,next,tx)=>{
  if(sql.includes("RESTORE ORIGINAL ROWS V2")) {reached=true;await tx.query("INSERT INTO fp_recognition_commands(id,intent_id,tenant_id,project_id,actor_id,role,session_id,session_hash,access_id,input_hash,action,encrypted_input,receipt) VALUES($1,$2,'synthetic-missing-tenant','synthetic-missing-project','synthetic-missing-actor','donor','synthetic-missing-session','synthetic-hash','synthetic-access','synthetic-input','withdraw','synthetic-private','{}'::jsonb)",[randomUUID(),randomUUID()]);assert.fail("All ordinary FK guards must remain enabled");}return next();})};
 await assert.rejects(applyWorkspaceTransferV2(f.source,target,f.bundle,f.plan,digest(f.plan)),rejection("IMPORT_FAILED"));assert(reached);await unchangedTarget();
});
test("a crash after all originals insert keeps only21 guards suspended, then rolls back rows and original modes",async()=>{
 let reached=false;const target={...f.target,database:interceptDatabase(f.target.database,async(sql,params,next,tx)=>{
  const result=await next();if(sql.includes("RESTORE ORIGINAL ROWS V2")) {reached=true;const catalog=await readCatalog(tx),allowed=new Set<string>(HISTORICAL_RESTORE_GUARDS.map(row=>row.trigger));let disabled=0;for(const table of catalog.tables) for(const trigger of table.triggers) {if(allowed.has(String(trigger.name))) {assert.equal(trigger.enabled,"D");disabled++;}else assert.equal(trigger.enabled,"O");}assert.equal(disabled,21);
   const copied=await readRows(tx,f.bundle.source.catalog);for(const table of EXTENSION_TABLES) assert.deepEqual(copied.find(row=>row.name===table.name)!.rows,f.bundle.source.tables.find(row=>row.name===table.name)!.rows);
   throw new Error("Synthetic crash after original insertion before re-enable/commit");}return result;})};
 await assert.rejects(applyWorkspaceTransferV2(f.source,target,f.bundle,f.plan,digest(f.plan)),rejection("IMPORT_FAILED"));assert(reached,"The complete177 original insertion reached the intentional crash checkpoint");await unchangedTarget();
});
test("one reviewed CLI apply restores the full joined manifest while every target trigger returns to originalO",async()=>{
 const output:unknown[]=[];await runWorkspaceTransferV2(["apply","--config",cli.config,"--bundle",cli.bundle,"--plan",cli.plan,"--review-hash",digest(f.plan),"--out",cli.receipt],value=>output.push(value));receipt=openTransferFile(await readFile(cli.receipt,"utf8"),"receipt",f.secret);
 assert.equal(receipt.originalTables,176);assert.equal((output[0] as Row).unchangedTables,174);assert.equal((await lstat(cli.receipt)).mode&0o777,0o600);
 const actual=await captureWorkspaceV2(f.target,true);assert.equal(actual.catalogHash,SCHEMA24_CATALOG_HASH);assert(actual.catalog.tables.every(table=>table.triggers.every(trigger=>trigger.enabled==="O")));
 for(const table of EXTENSION_TABLES) assert.deepEqual(actual.tables.find(row=>row.name===table.name)!.rows,f.bundle.source.tables.find(row=>row.name===table.name)!.rows);
});
test("final177 comparison preserves every original table and sequence except the three declared control/import deltas",async()=>{
 assert(receipt,"The preceding reviewed restore must succeed before its final verification");const result=await verifyWorkspaceTransferV2(f.target,f.bundle,f.plan,receipt);assert.equal(result.originalFamilies,176);assert.equal(result.unchangedTables,174);assert.equal(result.execution,"held");
 const source=await captureWorkspaceV2(f.source),target=await captureWorkspaceV2(f.target,true);assert.equal(source.rowsHash,f.bundle.source.rowsHash);assert.equal(source.catalogHash,f.bundle.source.catalogHash);assert.equal(source.sequenceHash,f.bundle.source.sequenceHash);assert.equal(target.sequenceHash,source.sequenceHash);
 for(const table of source.tables) if(!["fp_runtime_control","fp_runtime_control_events","fp_workspace_imports"].includes(table.name)) assert.deepEqual(target.tables.find(row=>row.name===table.name)!.rows,table.rows,table.name);
 const rows=originalRows(target.tables,target.catalog);assert.equal(rows.get("fp_runtime_control")![0].held,true);assert.equal(rows.get("fp_workspace_imports")!.length,1);assert.equal(rows.get("fp_runtime_control_events")!.length,3);
 const report={sourceCommit:f.bundle.codeCommit,schemaVersion:24,fragments:EXTENSION_FRAGMENTS,completeCatalogHash:target.catalogHash,sourceRowsHash:source.rowsHash,sourceSequenceHash:source.sequenceHash,targetRowsHash:target.rowsHash,tables:177,originalFamilies:176,unchangedWholeTables:174,originalRows:receipt.originalRows,newFamilyRows:EXTENSION_TABLES.map(contract=>({table:contract.name,rows:source.tables.find(table=>table.name===contract.name)!.count})),originalTriggerModes:true,approvedExceptions:HISTORICAL_RESTORE_GUARDS.map(row=>row.trigger),receiptHash:digest(receipt),planHash:receipt.planHash,sourcePreserved:true,execution:"held",syntheticQualificationOnly:true,productionRestore:false};
 await writeFile(path.resolve(process.cwd(),".local/operations-complete-v2-unit/schema24-restore-receipt.private.json"),JSON.stringify(report,null,2)+"\n",{mode:0o600});console.log(JSON.stringify({...result,catalogHash:target.catalogHash,newFamilies:40,sourcePreserved:true}));
});
test("lost-response retry keeps the original receipt and never reopens the historical exception window",async()=>{
 assert(receipt,"The preceding reviewed restore must succeed before receipt recovery");let windows=0;const before=await captureWorkspaceV2(f.target,true),target={...f.target,database:interceptDatabase(f.target.database,async(sql,params,next)=>{if(sql.includes("DISABLE TRIGGER")) windows++;return next();})};
 assert.deepEqual(await applyWorkspaceTransferV2(f.source,target,f.bundle,f.plan,digest(f.plan)),receipt);assert.equal(windows,0);const after=await captureWorkspaceV2(f.target,true);assert.equal(after.rowsHash,before.rowsHash);assert.equal(after.sequenceHash,before.sequenceHash);
});
test("the populated target refuses a new plan and imported expired/revoked originals cannot issue fresh authority",async()=>{
 assert(receipt,"The preceding reviewed restore must succeed before populated-target checks");await assert.rejects(planWorkspaceTransferV2(f.source,f.target,f.bundle,"Refuse nonempty original manifest destination"),rejection("DESTINATION_NOT_FRESH"));
 let denied=false;try {await f.target.database.transaction(async tx=>{await tx.query("INSERT INTO fp_procurement_suppliers(id,tenant_id,project_id,created_by,created_role,created_session_id,created_membership_version) VALUES($1,$2,$3,$4,'organizer',$5,1)",[randomUUID(),f.id.tenant,f.id.project,f.extension.actor,f.extension.ids.organizerSession]);throw new Error("UNEXPECTEDLY_ALLOWED_ROLL_BACK");});}catch(error){assert(!(error instanceof Error&&error.message==="UNEXPECTEDLY_ALLOWED_ROLL_BACK"));denied=true;}assert(denied);
 const rows=(await captureWorkspaceV2(f.target,true)).tables;assert.deepEqual(rows.find(table=>table.name==="fp_procurement_suppliers")!.rows,f.bundle.source.tables.find(table=>table.name==="fp_procurement_suppliers")!.rows);
 const original=originalRows(f.bundle.source.tables,f.bundle.source.catalog).get("fp_lifecycle_preference_versions")![0];assert.equal((openPrivate<Row>(String(original.encrypted_grant),`lifecycle:private-lifecycle-v1:preference:${original.id}`)).expiresAt,f.extension.originalGrant.expiresAt);
});
