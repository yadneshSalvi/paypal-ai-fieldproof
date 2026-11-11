import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertSameOrigin, sessionCookieName, sessionCookieSecure } from "../lib/server/auth";
import { workspaceLibraryCookieName } from "../lib/server/community-workspaces";
import { assertProviderAccess, fundingQaEnabled } from "../lib/server/provider-access";
import { fundingQaActors } from "../lib/server/funding-qa";

let saved:NodeJS.ProcessEnv;
beforeEach(()=>{
  saved={...process.env};
  for(const key of Object.keys(process.env))if(/^(PAYPAL_|NEXT_PUBLIC_PAYPAL_)/.test(key))process.env[key]="";
  Object.assign(process.env,{NODE_ENV:"production",VERCEL:"0",FIELDPROOF_FUNDING_QA:"true",FIELDPROOF_PROVIDER_ACCESS:"disabled",FIELDPROOF_PURPOSE_CHECKOUT_ENABLED:"false",APP_URL:"http://localhost:4535",DATABASE_URL:"postgresql://fp_lifecycle_qa_fixture:synthetic@127.0.0.1:5432/fp_lifecycle_qa_fixture",OPENAI_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:"",BLOB_READ_WRITE_TOKEN:""});
});
afterEach(()=>{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);});
const request=(origin:string,host=new URL(origin).host)=>new Request(`http://${host}/api/funding`,{method:"POST",headers:{origin,host,"sec-fetch-site":"same-origin"}});
describe("independent production-build funding review",()=>{
  it("uses separate session/library cookies and only its exact local origin",()=>{
    assert.equal(fundingQaEnabled(),true);assert.equal(sessionCookieName(),"fieldproof_funding_lifecycle_qa_session");assert.equal(workspaceLibraryCookieName(),"fieldproof_funding_lifecycle_qa_session_library");assert.equal(sessionCookieSecure(),false);
    assert.doesNotThrow(()=>assertSameOrigin(request("http://localhost:4535")));assert.throws(()=>assertSameOrigin(request("http://localhost:4536")),{code:"ORIGIN_DENIED"});assert.throws(()=>assertSameOrigin(request("http://localhost:4535","localhost:4102")),{code:"ORIGIN_DENIED"});assert.throws(assertProviderAccess,{code:"PROVIDERS_DISABLED"});
  });
  it("cannot enable fixture access on hosted/original storage or with any provider credential",()=>{
    const url=process.env.DATABASE_URL;
    for(const value of ["postgresql://fp_lifecycle_qa_fixture:synthetic@hosted.example.invalid:5432/fp_lifecycle_qa_fixture","postgresql://original:synthetic@127.0.0.1:5432/original","postgresql://other:synthetic@127.0.0.1:5432/fp_lifecycle_qa_fixture"]){process.env.DATABASE_URL=value;assert.throws(fundingQaEnabled,{code:"QA_STORAGE_ISOLATION"});}process.env.DATABASE_URL=url;
    process.env.VERCEL="1";assert.throws(fundingQaEnabled,{code:"QA_STORAGE_ISOLATION"});process.env.VERCEL="0";
    for(const name of ["OPENAI_API_KEY","PAYPAL_CLIENT_ID","PAYPAL_CLIENT_SECRET","NEXT_PUBLIC_PAYPAL_CLIENT_ID","BLOB_READ_WRITE_TOKEN"]){process.env[name]="synthetic-not-allowed";assert.throws(fundingQaEnabled,{code:"QA_PROVIDER_ISOLATION"});process.env[name]="";}
    process.env.FIELDPROOF_PURPOSE_CHECKOUT_ENABLED="true";assert.throws(fundingQaEnabled,{code:"QA_PROVIDER_ISOLATION"});assert.throws(assertProviderAccess,{code:"PROVIDERS_DISABLED"});
  });
  it("leaves normal production cookies secure and makes the actor chooser unavailable without the explicit isolated flag",()=>{
    process.env.FIELDPROOF_FUNDING_QA="false";assert.equal(fundingQaEnabled(),false);assert.equal(sessionCookieName(),"fieldproof_session");assert.equal(sessionCookieSecure(),true);assert.throws(fundingQaActors,{code:"NOT_FOUND"});assert.throws(()=>assertSameOrigin(request("http://localhost:4535")),{code:"ORIGIN_DENIED"});
  });
});
