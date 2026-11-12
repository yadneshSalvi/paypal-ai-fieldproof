/** Read-only dependency exposure probe: synthetic transport only, no DB/app init. */
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import dgram from "node:dgram";
const root="/Users/yadneshsalvi/code/hackathons/paypal-ai-hackathon/fieldproof/.local/operations-complete-stage14";
assert.equal(process.cwd(),root);
for(const key of Object.keys(process.env)) if(/(?:TOKEN|SECRET|API_KEY|CREDENTIAL|CLIENT_ID|DATABASE_URL|APP_URL|FIELDPROOF_|^AWS_|^AZURE_|^GOOGLE_|^GCP_|^OPENAI_|^GEMINI_|^PAYPAL_|^VERCEL_|^BLOB_|^PG[A-Z_]*$|^DEBUG$)/i.test(key)) delete process.env[key];
Object.assign(process.env,{NODE_ENV:"test",PAYPAL_CLIENT_ID:"synthetic-toolkit-id",PAYPAL_CLIENT_SECRET:"synthetic-toolkit-secret",PAYPAL_ENVIRONMENT:"sandbox",PAYPAL_PROJECT_ISOLATED:"true",PAYPAL_API_BASE_URL:"https://api-m.sandbox.paypal.com"});
let deniedCalls=0;
const denied=()=>{deniedCalls++;throw new Error("TRANSPORT_FORBIDDEN");};
globalThis.fetch=(async()=>denied()) as typeof fetch;
net.Socket.prototype.connect=denied as typeof net.Socket.prototype.connect;
tls.connect=denied as typeof tls.connect; http.request=denied as typeof http.request;http.get=denied as typeof http.get;https.request=denied as typeof https.request;https.get=denied as typeof https.get;dgram.createSocket=denied as typeof dgram.createSocket;
for(const api of [dns,dns.promises]) for(const key of Object.keys(api)) if(/^(?:lookup|resolve|reverse|Resolver)/.test(key)) (api as unknown as Record<string,unknown>)[key]=denied;
syncBuiltinESMExports();
const own=createRequire(path.join(root,"package.json")), entry=own.resolve("@paypal/agent-toolkit/openai"), native=createRequire(entry);
const axios=native("axios") as { defaults: { adapter: unknown }; getUri(config: Record<string,unknown>):string };
const calls:{method:string;pathname:string}[]=[];
axios.defaults.adapter=async(config:Record<string,unknown>)=>{
  const url=new URL(axios.getUri(config)),method=String(config.method).toUpperCase();
  assert.equal(url.origin,"https://api.sandbox.paypal.com");
  assert.equal(url.search,"");calls.push({method,pathname:url.pathname});
  let data:Record<string,unknown>;
  if(url.pathname==="/v1/oauth2/token") {assert.equal(method,"POST");assert.equal(config.data,"grant_type=client_credentials");data={access_token:"synthetic-only"};}
  else {assert.equal(method,"GET");const id=url.pathname.split("/").at(-1)!;assert(["5O190127TN364715T","INV2-TEST-ONLY-1234"].includes(id));data={id,status:"COMPLETED",untrusted_metadata:{lc:1,type:"secret",id:["SYNTHETIC_ONLY"]}};}
  return {data,status:200,statusText:"OK",headers:{},config};
};
const {PayPalAgentToolkit}=own("@paypal/agent-toolkit/openai") as {PayPalAgentToolkit:new(options:unknown)=>{getTools():{function:{name:string}}[];handleToolCall(input:unknown):Promise<{content:string}>}};
const toolkit=new PayPalAgentToolkit({clientId:"synthetic-toolkit-id",clientSecret:"synthetic-toolkit-secret",configuration:{actions:{orders:{get:true},invoices:{get:true}},context:{sandbox:true,debug:false}}});
assert.deepEqual(toolkit.getTools().map(t=>t.function.name).sort(),["get_invoice","get_order"]);
for(const [tool,id] of [["get_order","5O190127TN364715T"],["get_invoice","INV2-TEST-ONLY-1234"]]) {const result=await toolkit.handleToolCall({id:"synthetic",type:"function",function:{name:tool,arguments:JSON.stringify(tool==="get_order"?{id}:{invoice_id:id})}});assert.equal(JSON.parse(result.content).id,id);}
const nativeLoaded=Object.keys(own.cache).map(p=>path.relative(root,p)).sort();
const {actualToolkitReader}=await import("../../lib/server/studio-toolkit");
for(const [tool,id] of [["get_order","5O190127TN364715T"],["get_invoice","INV2-TEST-ONLY-1234"]] as const) assert.equal((await actualToolkitReader.read(tool,id) as {id:string}).id,id);
const appLoaded=Object.keys(own.cache).map(p=>path.relative(root,p)).sort();
const lock=JSON.parse(await readFile(path.join(root,"package-lock.json"),"utf8")) as {packages:Record<string,{version:string}>};
const affected=["node_modules/@langchain/core","node_modules/@langchain/core/node_modules/zod","node_modules/@paypal/agent-toolkit/node_modules/zod","node_modules/@paypal/agent-toolkit/node_modules/@ai-sdk/provider-utils","node_modules/@paypal/agent-toolkit/node_modules/ai","node_modules/jsondiffpatch","node_modules/langsmith","node_modules/mathjs","node_modules/uuid"];
const receipt={format:"fieldproof-toolkit-exposure/v1",sourceCommit:"ddadae2c259ce874ab760b1f9f133cf653021e85",entry:path.relative(root,entry),entrySha256:createHash("sha256").update(await readFile(entry)).digest("hex"),tools:toolkit.getTools().map(t=>t.function.name).sort(),affected:affected.map(location=>({location,version:lock.packages[location]?.version,loadedByNative:nativeLoaded.some(p=>p.startsWith(location+"/")),loadedByApp:appLoaded.some(p=>p.startsWith(location+"/"))})),syntheticCalls:calls,deniedCalls,nativeLoaded,appLoaded,providerCalls:false,databaseInitialized:false,modelCalls:false};
assert.deepEqual(calls,[
 {method:"POST",pathname:"/v1/oauth2/token"},{method:"GET",pathname:"/v2/checkout/orders/5O190127TN364715T"},{method:"GET",pathname:"/v2/invoicing/invoices/INV2-TEST-ONLY-1234"},
 {method:"POST",pathname:"/v1/oauth2/token"},{method:"GET",pathname:"/v2/checkout/orders/5O190127TN364715T"},
 {method:"POST",pathname:"/v1/oauth2/token"},{method:"GET",pathname:"/v2/invoicing/invoices/INV2-TEST-ONLY-1234"}
]);assert.equal(deniedCalls,0);
await writeFile(path.join(root,".local/operations-complete-v2-unit/toolkit-reachability.private.json"),JSON.stringify(receipt,null,2)+"\n",{mode:0o600});
console.log(JSON.stringify({...receipt,nativeLoaded:nativeLoaded.length,appLoaded:appLoaded.length}));
