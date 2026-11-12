import { afterEach,beforeEach,describe,it } from "node:test";
import assert from "node:assert/strict";
import { assertSameOrigin,sessionCookieName,sessionCookieSecure } from "../lib/server/auth";
import { workspaceLibraryCookieName } from "../lib/server/community-workspaces";
import { assertProviderAccess,supporterQaEnabled } from "../lib/server/provider-access";
import { supporterQaActors } from "../lib/server/supporter-qa";
let saved:NodeJS.ProcessEnv;
beforeEach(()=>{saved={...process.env};delete process.env.FIELDPROOF_SUPPORTER_QA_PROFILE;for(const key of Object.keys(process.env))if(/^(PAYPAL_|NEXT_PUBLIC_PAYPAL_)/.test(key))process.env[key]="";Object.assign(process.env,{NODE_ENV:"production",VERCEL:"0",FIELDPROOF_SUPPORTER_QA:"true",FIELDPROOF_PROVIDER_ACCESS:"disabled",FIELDPROOF_PURPOSE_CHECKOUT_ENABLED:"false",APP_URL:"http://localhost:4553",DATABASE_URL:"postgresql://fp_story_stage8:synthetic@127.0.0.1:55554/fp_story_stage8",OPENAI_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:"",BLOB_READ_WRITE_TOKEN:""});});
afterEach(()=>{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);});
const request=(origin:string,host=new URL(origin).host)=>new Request(`http://${host}/api/supporter-qa`,{method:"POST",headers:{origin,host,"sec-fetch-site":"same-origin"}});
describe("independent supporter review confinement",()=>{
  it("rejects a null or missing form origin while permitting an explicit same-origin client request",()=>{
    for(const headers of [new Headers({origin:"null",host:"localhost:4553"}),new Headers({host:"localhost:4553"})])assert.throws(()=>assertSameOrigin(new Request("http://localhost:4553/api/supporter-qa",{method:"POST",headers})),{code:"ORIGIN_DENIED"});
    assert.doesNotThrow(()=>assertSameOrigin(new Request("http://localhost:4553/api/supporter-qa",{method:"POST",headers:{origin:"http://localhost:4553",host:"localhost:4553",accept:"application/json","content-type":"application/x-www-form-urlencoded"},body:"actor=donor-a"})));
  });
  it("isolates the new cookies and exact origin without weakening provider denial",()=>{assert.equal(supporterQaEnabled(),true);assert.equal(sessionCookieName(),"fieldproof_supporter_story_stage8_session");assert.equal(workspaceLibraryCookieName(),"fieldproof_supporter_story_stage8_session_library");assert.equal(sessionCookieSecure(),false);assert.doesNotThrow(()=>assertSameOrigin(request("http://localhost:4553")));assert.throws(()=>assertSameOrigin(request("http://localhost:4535")),{code:"ORIGIN_DENIED"});assert.throws(()=>assertSameOrigin(request("http://localhost:4553","localhost:4535")),{code:"ORIGIN_DENIED"});assert.throws(assertProviderAccess,{code:"PROVIDERS_DISABLED"});});
  it("refuses any original/hosted/wrong-port database, hosted process, provider credential or checkout enablement",()=>{
    const original=process.env.DATABASE_URL;
    for(const value of ["postgresql://fp_story_stage8:synthetic@hosted.example.invalid:55554/fp_story_stage8","postgresql://fp_story_stage8:synthetic@127.0.0.1:5432/fp_story_stage8","postgresql://other:synthetic@127.0.0.1:55554/fp_story_stage8","postgresql://fp_story_stage8:synthetic@127.0.0.1:55554/original"]){process.env.DATABASE_URL=value;assert.throws(supporterQaEnabled,{code:"QA_STORAGE_ISOLATION"});}process.env.DATABASE_URL=original;
    process.env.VERCEL="1";assert.throws(supporterQaEnabled,{code:"QA_STORAGE_ISOLATION"});process.env.VERCEL="0";
    for(const key of ["OPENAI_API_KEY","GEMINI_API_KEY","PAYPAL_CLIENT_ID","PAYPAL_CLIENT_SECRET","NEXT_PUBLIC_PAYPAL_CLIENT_ID","BLOB_READ_WRITE_TOKEN"]){process.env[key]="synthetic-only";assert.throws(supporterQaEnabled,{code:"QA_PROVIDER_ISOLATION"});process.env[key]="";}
    process.env.FIELDPROOF_PURPOSE_CHECKOUT_ENABLED="true";assert.throws(supporterQaEnabled,{code:"QA_PROVIDER_ISOLATION"});
  });
  it("keeps normal production secure and makes fixture access unavailable without its flag",()=>{delete process.env.FIELDPROOF_SUPPORTER_QA;assert.equal(supporterQaEnabled(),false);assert.equal(sessionCookieName(),"fieldproof_session");assert.equal(sessionCookieSecure(),true);assert.throws(supporterQaActors,{code:"NOT_FOUND"});assert.throws(()=>assertSameOrigin(request("http://localhost:4553")),{code:"ORIGIN_DENIED"});});
  it("isolates the new correction fixture from the frozen original, including cookies and origin",()=>{
    process.env.FIELDPROOF_SUPPORTER_QA_PROFILE="native-repair-stage9";
    assert.throws(supporterQaEnabled,{code:"QA_STORAGE_ISOLATION"});
    process.env.DATABASE_URL="postgresql://fp_story_stage9:synthetic@127.0.0.1:55558/fp_story_stage9";process.env.APP_URL="http://localhost:4559";
    assert.equal(supporterQaEnabled(),true);assert.equal(sessionCookieName(),"fieldproof_supporter_native_stage9_session");assert.equal(workspaceLibraryCookieName(),"fieldproof_supporter_native_stage9_session_library");
    assert.doesNotThrow(()=>assertSameOrigin(request("http://localhost:4559")));assert.throws(()=>assertSameOrigin(request("http://localhost:4553")),{code:"ORIGIN_DENIED"});assert.throws(assertProviderAccess,{code:"PROVIDERS_DISABLED"});
    process.env.FIELDPROOF_SUPPORTER_QA_PROFILE="arbitrary-profile";assert.throws(supporterQaEnabled,{code:"QA_STORAGE_ISOLATION"});
  });
});
