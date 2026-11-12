import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PackageView, ProjectSnapshot, WorkspaceRole } from "../lib/contracts";
import { COMMUNITY_TEMPLATES, type CommunityTemplate } from "../lib/community/templates";

// Render the actual route/components while leaving stylesheet loading to Next.
const styles = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith(".css") ? { format: "module", source: "export {};", shortCircuit: true } : nextLoad(url, context);
} });
const { TemplateProject } = await import("../components/community/template-project");
const { default: Page } = await import("../app/[[...path]]/page");
styles.deregister();

function snapshot(template: CommunityTemplate, role: WorkspaceRole | null): ProjectSnapshot {
  const packages: PackageView[] = template.packages.map(pkg => ({
    id: pkg.id, title: pkg.title, shortTitle: pkg.shortTitle, description: pkg.description, budgetMinor: pkg.budgetMinor,
    version: 1, pledgedMinor: 0, collectedMinor: 0, fundingEligibleMinor: 0, shortfallMinor: pkg.budgetMinor,
    pendingRefundMinor: 0, excessLiabilityMinor: 0, fundingState: "open", workState: "planned", evidenceAccepted: 0,
    evidenceRequired: pkg.requirements.length, dependencies: template.dependencies.filter(item => item.packageId === pkg.id).map(item => item.prerequisiteId),
    category: pkg.category, icon: pkg.icon,
    zone: { packageId: pkg.id, points: [{ x: .1, y: .1 }, { x: .4, y: .1 }, { x: .4, y: .4 }, { x: .1, y: .4 }], label: { x: .25, y: .25 } },
  }));
  return {
    templateId: template.id, templateWorkspace: true, id: `synthetic-${template.id}`, tenantId: "synthetic-template-tenant",
    slug: template.id, title: template.title, subtitle: template.subtitle, organizer: template.organizer, location: template.location,
    currency: "USD", mode: "sample", version: 1, projectionVersion: 1, targetMinor: template.totalMinor,
    deadline: "2099-12-31T23:59:59.000Z", packages, obligations: [], receipts: [], financialScope: "none", evidence: [], events: [], tourStep: 0,
    session: role ? { role, actorId: "synthetic-template-actor", expiresAt: "2099-12-31T23:59:59.000Z" } : null,
    capabilities: { checkoutConfigured: false, savedWalletQualified: false, payoutQualified: false, invoiceQualified: false, studioConfigured: false },
  };
}
function renderTemplate(template: CommunityTemplate, role: WorkspaceRole | null) {
  return renderToStaticMarkup(createElement(TemplateProject, {
    snapshot: snapshot(template, role), view: "organizer", busy: false, message: null, messageIsError: false,
    onRoleChange() {}, async onRefresh() {},
  }));
}

describe("supporter invitation navigation and disclosures", () => {
  it("gives each template organizer an invitation entry while preserving other roles' scope", () => {
    assert.deepEqual(COMMUNITY_TEMPLATES.map(template => template.id), ["makerspace", "community-garden", "mutual-aid"]);
    for (const template of COMMUNITY_TEMPLATES) {
      const organizer = renderTemplate(template, "organizer");
      assert.match(organizer, /aria-label="Project views"/);
      assert.match(organizer, /href="\/supporters">Invite supporters<\/a>/, template.id);
      for (const role of ["donor", "auditor", "volunteer", null] as const)
        assert.doesNotMatch(renderTemplate(template, role), /href="\/supporters"/, `${template.id}: ${role ?? "visitor"}`);
    }
  });

  it("discloses the invitation deadline and private browser data instead of a twelve-hour-only operation-ID policy", async () => {
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ path: ["privacy"] }) }));
    assert.match(html, /up to seven days/);
    assert.match(html, /private return key/);
    assert.match(html, /HttpOnly cookies/);
    assert.match(html, /per-tab session storage/);
    assert.match(html, /self-declared name/);
    assert.match(html, /does not independently verify a person, email address, organization or PayPal identity/);
    assert.doesNotMatch(html, /Browser storage holds only|Demonstration sessions expire after twelve hours/);
  });

  it("distinguishes the connection test from exact-purpose payments and separate payer consent", async () => {
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ path: ["terms"] }) }));
    assert.match(html, /connection test requests a \$1\.00 sandbox contribution/);
    assert.match(html, /exact amount, named purpose/);
    assert.match(html, /not a payment approval/);
    assert.match(html, /Approving one checkout does not approve future charges/);
    assert.doesNotMatch(html, /requests a single \$1\.00 sandbox test contribution/);
  });
});
