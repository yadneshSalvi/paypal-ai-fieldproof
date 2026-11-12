import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { hash,requireOperation,type Row } from "./contracts";
const semver=createRequire(import.meta.url)("semver") as { valid(value:string):string|null;satisfies(version:string,range:string):boolean };
const BULK="https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
const ghsa=/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
interface LockedInstance {name:string;version:string;location:string;source:string;}
interface Advisory {id:string;url:string;title:string;severity:string;range:string;}
async function officialJson(url:string,init:RequestInit={},fetcher:typeof fetch=fetch):Promise<{value:unknown;bodyHash:string}> {
 const response=await fetcher(url,{...init,redirect:"error",signal:AbortSignal.timeout(20_000),headers:{accept:"application/json","user-agent":"Fieldproof-read-only-operations-review",...init.headers}});
 requireOperation(response.ok&&!!response.body,"INVALID_CONFIGURATION","The explicit official dependency query did not return a complete successful response.");
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try {for(;;) {const next=await reader.read();if(next.done) break;size+=next.value.length;if(size>8*1024*1024) {await reader.cancel();requireOperation(false,"UNSUPPORTED_COVERAGE","The official advisory response exceeded the bounded review; no findings were omitted.");}chunks.push(next.value);}}
 finally {reader.releaseLock();}
 const bytes=Buffer.concat(chunks);let value:unknown;try {value=JSON.parse(bytes.toString("utf8"));}catch {requireOperation(false,"UNSUPPORTED_COVERAGE","The official dependency response is not a supported JSON record.");}
 return {value,bodyHash:hash(bytes)};
}
/** Explicit operator review only. It reads the lock and public npm/GitHub data;
 * no env, package mutation/install, application, provider or model is involved. */
export async function reviewLockedSecurity(root:string,fetcher:typeof fetch=fetch) {
 requireOperation(path.isAbsolute(root),"INVALID_CONFIGURATION","Use an explicit absolute source root for dependency review.");
 const text=await readFile(path.join(root,"package-lock.json"),"utf8"),lock=JSON.parse(text) as {lockfileVersion:number;packages:Record<string,Row>};
 requireOperation(lock.lockfileVersion===3&&!!lock.packages,"UNSUPPORTED_COVERAGE","Only an explicit version3 dependency lock is eligible for this review.");
 const locked:LockedInstance[]=Object.entries(lock.packages).filter(([location])=>location!=="").map(([location,row])=>({name:location.split("node_modules/").at(-1)!,version:String(row.version??"unknown"),location,source:String(row.resolved??"unknown")}));
 const included=locked.filter(row=>row.source.startsWith("https://registry.npmjs.org/")&&!!semver.valid(row.version));
 const excluded=locked.filter(row=>!included.includes(row)).map(row=>({...row,reason:row.source.startsWith("git+")?"pinned-git-name-does-not-establish-registry-code-identity":row.source.startsWith("file:")?"local-vendor-needs-separate-source-review":"unsupported-or-missing-registry-provenance"}));
 const versions:Record<string,string[]>={};for(const row of included) {requireOperation(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(row.name),"UNSUPPORTED_COVERAGE","A locked package name is outside the explicit registry query contract.");versions[row.name]??=[];if(!versions[row.name].includes(row.version)) versions[row.name].push(row.version);}
 const request=JSON.stringify(versions),bulk=await officialJson(BULK,{method:"POST",headers:{"content-type":"application/json"},body:request},fetcher),advisories=bulk.value as Record<string,unknown>;
 requireOperation(!!advisories&&typeof advisories==="object"&&!Array.isArray(advisories),"UNSUPPORTED_COVERAGE","The official registry advisory contract is unsupported.");
 const matched:Map<string,Advisory>=new Map(),instances:{name:string;version:string;location:string;advisories:Advisory[]}[]=[];
 for(const row of included) {
  const list=advisories[row.name]??[];requireOperation(Array.isArray(list),"UNSUPPORTED_COVERAGE","The official registry omitted a supported advisory family.");
  const affected:Advisory[]=[];
  for(const entry of list as Row[]) {
   const match=typeof entry.url==="string"?/^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9-]+)$/.exec(entry.url):null;
   requireOperation(match&&ghsa.test(match[1])&&typeof entry.title==="string"&&entry.title.length<=1000&&typeof entry.vulnerable_versions==="string"&&entry.vulnerable_versions.length<=1000&&["low","moderate","high","critical"].includes(String(entry.severity)),"UNSUPPORTED_COVERAGE","A registry advisory has an unsupported identity, range or severity; no entry was ignored.");
   if(semver.satisfies(row.version,String(entry.vulnerable_versions))) {const advisory={id:match[1],url:entry.url as string,title:entry.title as string,severity:String(entry.severity),range:String(entry.vulnerable_versions)};matched.set(advisory.id,advisory);affected.push(advisory);}
  }
  if(affected.length) instances.push({name:row.name,version:row.version,location:row.location,advisories:affected});
 }
 const ids=[...matched.keys()].sort(),confirmations:Row[]=[];
 // Four independent official reads per bounded batch; every result is retained.
 for(let index=0;index<ids.length;index+=4) {
  const batch=ids.slice(index,index+4),results=await Promise.allSettled(batch.map(async id=>{
   const url=`https://api.github.com/advisories/${id}`,result=await officialJson(url,{},fetcher),doc=result.value as Row;
   requireOperation(doc.ghsa_id===id&&Array.isArray(doc.vulnerabilities),"UNSUPPORTED_COVERAGE","An upstream advisory response changed its exact identity contract.");
   return {id,url,bodyHash:result.bodyHash,htmlUrl:`https://github.com/advisories/${id}`,publishedAt:doc.published_at,updatedAt:doc.updated_at,withdrawnAt:doc.withdrawn_at,severity:doc.severity,cve:doc.cve_id,vulnerabilities:(doc.vulnerabilities as Row[]).filter(item=>(item.package as Row)?.ecosystem==="npm").map(item=>({name:(item.package as Row).name,range:item.vulnerable_version_range,firstPatched:item.first_patched_version}))};
  }));
  for(let at=0;at<results.length;at++) {const result=results[at];confirmations.push(result.status==="fulfilled"?{confirmed:true,...result.value}:{confirmed:false,id:batch[at],reason:"official-upstream-response-unavailable-or-unsupported"});}
 }
 return {format:"fieldproof-locked-security-review/v1",capturedAt:new Date().toISOString(),lockFileSha256:hash(text),lockedInstances:locked.length,registryNames:Object.keys(versions).length,registryNameVersions:Object.values(versions).reduce((sum,list)=>sum+list.length,0),query:{url:BULK,requestSha256:hash(request),responseSha256:bulk.bodyHash},excludedNonRegistry:excluded,affectedInstances:instances.length,affectedNames:new Set(instances.map(row=>row.name)).size,uniqueAdvisories:ids.length,instanceAdvisoryMatches:instances.reduce((sum,row)=>sum+row.advisories.length,0),advisories:[...matched.values()].sort((a,b)=>a.id.localeCompare(b.id)),instances,upstream:confirmations,upstreamComplete:confirmations.every(row=>row.confirmed===true),securityClearance:false,scope:"dated-public-advisory-data-for-exact-lock; package-level-findings-not-runtime-exploitability",packageChanges:false,installScripts:false,providerCalls:false,modelCalls:false};
}
