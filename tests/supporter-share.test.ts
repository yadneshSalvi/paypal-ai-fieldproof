import assert from "node:assert/strict";
import { describe,it } from "node:test";
import { bindStoryBudget,contributionShare,type BudgetCandidate } from "../lib/domain/supporter-share";
const review={status:"missing" as const,scope:"Budget review",reviewerLabel:null,reviewedAt:null,sourceHash:null};
const candidate=(version:number,amountMinor:number,basis:BudgetCandidate["basis"]="current_package"):BudgetCandidate=>({packageId:"benches",version,title:`Benches v${version}`,purpose:"Six shared work places",amountMinor,basis,sourceHashes:[`${basis}:${version}:${amountMinor}`],review});
describe("exact contribution shares",()=>{
  it("preserves exact reduced rational percentages and rounds only the displayed tenth",()=>{
    assert.deepEqual(contributionShare(10001,30000,"current-purpose-net-credit-v1"),{numeratorMinor:10001,denominatorMinor:30000,percentNumerator:"10001",percentDenominator:"300",percentTenths:"333",basis:"current-purpose-net-credit-v1"});
    assert.equal(contributionShare(1,400,"current-purpose-net-credit-v1").percentTenths,"3");
    assert.equal(contributionShare(0,96000,"current-purpose-net-credit-v1").percentNumerator,"0");
    assert.equal(contributionShare(Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,"current-purpose-net-credit-v1").percentTenths,"1000");
    assert.equal(contributionShare(12000,10000,"current-purpose-net-credit-v1").percentTenths,"1200");
  });
  it("rejects unsafe, fractional, negative and zero-denominator money",()=>{
    for(const [a,b] of [[1,0],[-1,10],[1.01,100],[1,NaN],[Number.MAX_SAFE_INTEGER+1,10]])assert.throws(()=>contributionShare(a,b,"current-purpose-net-credit-v1"));
  });
  it("keeps the saved version denominator when a current package has a different budget",()=>{
    const bound=bindStoryBudget("benches",1,[candidate(2,50000),candidate(1,96000,"saved_purpose")],{title:"Earlier purpose"});
    assert.equal(bound.amountMinor,96000);assert.equal(bound.version,1);assert.equal(bound.basis,"saved_purpose");
    assert.equal(bindStoryBudget("benches",1,[candidate(2,50000)],{title:"Earlier purpose"}).status,"missing");
    assert.equal(bindStoryBudget("benches",null,[candidate(1,96000)],{title:"Earlier purpose"}).amountMinor,null);
  });
  it("refuses conflicting same-version budgets and unrelated package amounts",()=>{
    const conflict=bindStoryBudget("benches",1,[candidate(1,96000),candidate(1,88000,"saved_plan")],{title:"Earlier purpose"});
    assert.equal(conflict.status,"conflict");assert.equal(conflict.amountMinor,null);assert.equal(conflict.sourceHashes.length,2);
    assert.equal(bindStoryBudget("materials",1,[candidate(1,96000)],{title:"Materials"}).status,"missing");
  });
});
