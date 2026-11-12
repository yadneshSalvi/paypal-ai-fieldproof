import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import * as C from "../lib/organizations/contracts";
import { OrganizationMembers } from "../components/organizations/members";
import { OrganizationProjects } from "../components/organizations/projects";
import { OrganizationPolicies } from "../components/organizations/policies";
import { OrganizationApplicationFacts, OrganizationProjectRule } from "../components/organizations/policy-application";
import { OrganizationPortfolioDocument } from "../components/organizations/portfolio";
import { OrganizationWorkspace } from "../components/organizations/desk";
import { orgDate } from "../components/organizations/shared";
import { newOrgPolicy, OrgPolicyEditor } from "../components/organizations/policy-editor";
import { ORG_UI_AS_OF, orgUiApi, orgUiApplication, orgUiBootstrap, orgUiDesk, orgUiParticipation, orgUiSnapshot, orgUiView } from "./helpers/organization-ui";

function documentFor(element: React.ReactElement) { return new JSDOM(renderToStaticMarkup(element)).window.document; }
describe("actual organization component rendering", () => {
  it("shows exactly the authorized organization role controls and own-membership privacy on every template", () => {
    for (const template of ["makerspace", "community-garden", "mutual-aid"] as const) for (const role of C.orgRoleSchema.options) {
      const desk = orgUiDesk(role, template), api = orgUiApi();
      const members = documentFor(createElement(OrganizationMembers, { desk, api }));
      assert.equal(members.body.textContent?.includes("Invite an organization member"), role === "owner");
      assert.equal(!!members.querySelector("table"), role === "owner");
      assert.equal(members.querySelectorAll("select option").length, role === "owner" ? 3 : 0);
      assert.match(members.body.textContent ?? "", /independently issued.*project grants remain intact/i);
      const policies = documentFor(createElement(OrganizationPolicies, { desk, participation: orgUiParticipation(template), api }));
      assert.equal(policies.body.textContent?.includes("Create a reusable draft"), role !== "auditor");
      const root = documentFor(createElement(OrganizationWorkspace, { initial: orgUiBootstrap(role), initialDesk: desk, initialParticipation: orgUiParticipation(template) }));
      assert.equal(root.querySelector("[data-template]")?.getAttribute("data-template"), template);
      assert.equal(root.body.textContent?.includes("Edit organization details"), role === "owner");
      assert.equal(root.querySelectorAll('[role="tab"]').length, 5);
    }
  });
  it("does not expose project links, rule/source details or administration controls to a non-organizer context", () => {
    const participation = orgUiParticipation();
    participation.projectContext = { ...participation.projectContext, role: "donor", sources: [], packages: [], currentPlan: null, basis: null, maxLinkExpiresAt: null, canLink: false, canAdopt: false, canMaterialize: false, canReviseEmptyPackages: false };
    // Defense in depth in the real renderer, even if an invalid caller supplies
    // lists that the strict server DTO is required to omit.
    participation.links[0].organizationName = "PRIVATE_ORG_LIST_CANARY";
    participation.adoptions = [orgUiApplication().summary];
    const document = documentFor(createElement(OrganizationProjects, { desk: null, participation, api: orgUiApi() }));
    assert.doesNotMatch(document.body.textContent ?? "", /PRIVATE_ORG_LIST_CANARY|Inspect project rule|Withdraw as project organizer|Target sketch/);
    assert.match(document.body.textContent ?? "", /Project governance needs the current project organizer/);
  });
  it("renders the original500/returned200/current300 lineage without deriving unpaid amounts or adding sponsor promises twice", () => {
    const view = orgUiView(), document = documentFor(createElement(OrganizationPortfolioDocument, { organizationName: "Synthetic civic group", audience: view.report!.audience.label, snapshot: view.report!.snapshot, report: view.report }));
    function amount(label: string) { const row = [...document.querySelectorAll("tr")].find(row => row.querySelector("th")?.textContent === label); assert.ok(row, label); return row.querySelector("td")?.textContent; }
    assert.equal(amount("Original provider gross"), "$5.00"); assert.equal(amount("Completed returns"), "$2.00"); assert.equal(amount("Current collected"), "$3.00");
    assert.equal(amount("Current unpaid commitments"), "$7.00"); assert.equal(amount("Accepted sponsor unpaid"), "$2.00");
    assert.match(document.body.textContent ?? "", /Included in current unpaid commitments; do not add again/);
    assert.match(document.body.textContent ?? "", /1 \/ 14/); assert.match(document.body.textContent ?? "", /0 \/ 6/);
    assert.match(document.body.textContent ?? "", /0 current scoped physical signoffs · 1 reviewed illustrative images/);
    assert.doesNotMatch(document.body.textContent ?? "", /100%/);
  });
  it("keeps currencies/provenance separate and names mixed-plan weighted denominators instead of averaging percentages", () => {
    const snapshot = orgUiSnapshot(); snapshot.groups[0] = { ...snapshot.groups[0], projectCount: 2, evidence: { ...snapshot.groups[0].evidence!, acceptedReviewItems: 1, requiredReviewItems: 24, planRevision: null } };
    snapshot.groups.push({ ...snapshot.groups[0], currency: "EUR", provenance: "replay", funding: null, expenses: null, evidence: null });
    const document = documentFor(createElement(OrganizationPortfolioDocument, { organizationName: "Synthetic mixed group", audience: "Synthetic auditor", snapshot }));
    const headings = [...document.querySelectorAll("h3")].map(node => node.textContent);
    assert.ok(headings.includes("USD · Sample · fictional")); assert.ok(headings.includes("EUR · Replay · recorded"));
    assert.match(document.body.textContent ?? "", /1 \/ 24/); assert.match(document.body.textContent ?? "", /Multiple project plans: revisions remain on each project/);
    assert.match(document.body.textContent ?? "", /Not disclosed/); assert.doesNotMatch(document.body.textContent ?? "", /average.*100%/);
  });
  it("withholds withdrawn project identity and source lineage while retaining safe organization-link metadata", () => {
    const snapshot = orgUiSnapshot(); snapshot.projects[0] = { ...snapshot.projects[0], state: "withdrawn", project: null, lineage: null, budget: null, money: [], evidence: [], reasons: ["Disclosure withdrawn"], notices: [] }; snapshot.groups = []; snapshot.activeLinks = 0; snapshot.withdrawnLinks = 1;
    const document = documentFor(createElement(OrganizationPortfolioDocument, { organizationName: "Synthetic civic group", audience: "Synthetic auditor", snapshot }));
    assert.match(document.body.textContent ?? "", /Project content withheld/); assert.doesNotMatch(document.body.textContent ?? "", /Synthetic Makerspace|Projection 28|event 44|Original provider gross/);
    assert.equal(document.querySelectorAll("button").length, 0);
  });
  it("distinguishes a real materialized plan and enforced rule from publication or physical acceptance, and keeps project-only controls independent", () => {
    const application = orgUiApplication(), facts = documentFor(createElement(OrganizationApplicationFacts, { application }));
    assert.match(facts.body.textContent ?? "", /Real editable target plan revision 4/); assert.match(facts.body.textContent ?? "", /materialized/); assert.match(facts.body.textContent ?? "", /enforced/);
    assert.match(facts.body.textContent ?? "", /Needs ordinary project review and publication/); assert.match(facts.body.textContent ?? "", /no physical signoff/);
    const projectOnly = documentFor(createElement(OrganizationProjectRule, { application, participation: orgUiParticipation(), api: orgUiApi(), updated() {} }));
    assert.match(projectOnly.body.textContent ?? "", /Review project rule deactivation/); assert.match(projectOnly.body.textContent ?? "", /Create a project-owned replacement/);
  });
  it("shows permitted org-safe adoption state to an auditor without exposing private project application details", () => {
    const desk = orgUiDesk("auditor"), application = orgUiApplication(); desk.adoptions = [application.summary];
    const document = documentFor(createElement(OrganizationProjects, { desk, participation: null, api: orgUiApi() }));
    assert.match(document.body.textContent ?? "", /Synthetic prospective funding rules/); assert.match(document.body.textContent ?? "", /gap/); assert.match(document.body.textContent ?? "", /Real draft revision 4/);
    assert.doesNotMatch(document.body.textContent ?? "", new RegExp(application.materializedPlan!.id)); assert.equal(document.querySelectorAll('a[href="/planning"]').length, 0); assert.doesNotMatch(document.body.textContent ?? "", /Inspect project rule|Review current project disclosure/);
  });
  it("renders actual typed editors for all three policy families on the compatible target template", () => {
    for (const kind of C.orgPolicyKindSchema.options) {
      const document = documentFor(createElement(OrgPolicyEditor, { value: newOrgPolicy(kind, "community-garden"), change() {} }));
      const garden = [...document.querySelectorAll("label")].find(label => label.textContent?.includes("Community garden"))?.querySelector<HTMLInputElement>("input");
      assert.equal(garden?.checked, true); assert.ok(document.querySelectorAll("input,select,textarea").length > 5);
      assert.doesNotMatch(document.body.textContent ?? "", /Verified person|Grant project role|Pay now/);
      if (kind !== "fund_restriction") assert.match(document.body.textContent ?? "", /Prospective evidence requirements/);
    }
  });
  it("renders the whole report with explicit identical UTC text across server/client time zones", () => {
    const before = process.env.TZ, renders: string[] = [];
    try { for (const timeZone of ["UTC", "Asia/Kolkata", "America/Los_Angeles"]) { process.env.TZ = timeZone; renders.push(renderToStaticMarkup(createElement(OrganizationPortfolioDocument, { organizationName: "Synthetic cross-zone group", audience: "Synthetic owner", snapshot: orgUiSnapshot() }))); assert.match(orgDate(ORG_UI_AS_OF), /UTC$/); } }
    finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
    assert.equal(renders[0], renders[1]); assert.equal(renders[1], renders[2]);
  });
});

describe("authored organization stylesheet contrast and print paper", () => {
  it("uses readable actual text/background declarations and visible form boundaries", async () => {
    const css = await readFile(new URL("../app/organizations/organizations.css", import.meta.url), "utf8"), blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const rule = (selector: string) => blocks.find(block => block[1].split(",").some(item => item.trim() === selector))?.[2] ?? "";
    const property = (selector: string, name: string) => { const match = rule(selector).match(new RegExp(`(?:^|;)\\s*${name}:([^;]+)`)); assert.ok(match, `${selector} ${name}`); return match[1]; };
    const variables = Object.fromEntries([...rule(".og-shell").matchAll(/(--[a-z-]+):([^;]+)/g)].map(match => [match[1], match[2]]));
    const resolve = (value: string): string => value.replace(/var\((--[a-z-]+)\)/g, (_, key: string) => variables[key]);
    const luminance = (color: string) => { const match = color.match(/#[a-f0-9]{6}/i); assert.ok(match, color); const values = [1, 3, 5].map(index => parseInt(match[0].slice(index, index + 2), 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4); return values[0] * .2126 + values[1] * .7152 + values[2] * .0722; };
    const contrast = (a: string, b: string) => { const x = luminance(resolve(a)), y = luminance(resolve(b)); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
    for (const selector of [".og-notice", ".og-inline-error", ".og-badge", ".og-badge.is-withdrawn", ".og-shell button:disabled", ".og-report-numbers dt"]) {
      const background = selector === ".og-report-numbers dt" ? property(".og-report-numbers", "background") : property(selector, "background");
      assert.ok(contrast(property(selector, "color"), background) >= 4.5, `${selector} contrast must reach4.5:1`);
    }
    assert.ok(contrast(variables["--og-muted"], variables["--og-paper"]) >= 4.5);
    assert.ok(contrast(variables["--og-control"], variables["--og-paper"]) >= 3);
    assert.match(css, /@page og-a4\{size:A4;margin:13mm\}/); assert.match(css, /@page og-letter\{size:letter;margin:13mm\}/);
  });
});
