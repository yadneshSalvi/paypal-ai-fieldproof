import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { announceOrganizationChange, createOrgBoundary, listenForOrganizationChanges, orgApiPath, organizationTabIdentity, orgRecoveryForError, orgRequest, OrgRequestError, type OrgChannel } from "../lib/organizations/client-boundary";
import { ORG_CHANGE_CHANNEL, ORG_PROJECT_SCOPE_HEADER, ORG_SCOPE_HEADER } from "../lib/organizations/contracts";

describe("organization request authority boundaries", () => {
  it("keeps organization reads and invitation entry current across a project identity switch, while aborting both project and dual work", () => {
    const boundary = createOrgBoundary(), organization = boundary.start(), entry = boundary.start("entry"), project = boundary.start("project"), dual = boundary.start("dual");
    boundary.invalidate("project");
    assert.equal(organization.current(), true); assert.equal(entry.current(), true);
    for (const ticket of [project, dual]) { assert.equal(ticket.current(), false); assert.equal(ticket.signal.aborted, true); }
    const renewed = boundary.start("dual"); assert.equal(renewed.current(), true);
    boundary.dispose(); assert.equal(organization.current(), false); assert.equal(renewed.current(), false);
  });
  it("does not let org role/version changes abort an independently authorized project-only withdrawal", () => {
    const boundary = createOrgBoundary(), project = boundary.start("project"), organization = boundary.start(), entry = boundary.start("entry"), dual = boundary.start("dual");
    boundary.invalidate("organization");
    assert.equal(project.current(), true);
    for (const ticket of [organization, entry, dual]) { assert.equal(ticket.current(), false); assert.equal(ticket.signal.aborted, true); }
    boundary.dispose(); assert.throws(() => boundary.start(), /closed/);
  });
  it("fences a late same-document fragment response without blanking a current organization read", async () => {
    const boundary = createOrgBoundary(), oldEntry = boundary.start("entry"), organization = boundary.start();
    let release!: (value: string) => void;
    const delayed = new Promise<string>(resolve => { release = resolve; });
    boundary.invalidate("entry"); const replacement = boundary.start("entry"); release("private earlier identity");
    const rendered: string[] = []; const old = await delayed;
    if (oldEntry.current()) rendered.push(old);
    assert.deepEqual(rendered, []); assert.equal(replacement.current(), true); assert.equal(organization.current(), true);
    boundary.dispose();
  });
  it("sends only explicit organization/project contexts, with capability-bearing input in the body", async () => {
    const requests: { path: string; options: RequestInit }[] = [], scope = "a".repeat(64), projectScope = "b".repeat(64), token = "p".repeat(64);
    const fetcher = (async (input, init) => { requests.push({ path: String(input), options: init! }); return Response.json({ result: "okay" }); }) as typeof fetch;
    const schema = z.object({ result: z.literal("okay") }).strict();
    await orgRequest("", schema, undefined, { scope, fetcher });
    await orgRequest("projects/review", schema, { token, expectedScope: scope, expectedProjectScope: projectScope }, { scope, projectScope, fetcher });
    const first = new Headers(requests[0].options.headers), second = new Headers(requests[1].options.headers);
    assert.equal(first.get(ORG_SCOPE_HEADER), scope); assert.equal(first.has(ORG_PROJECT_SCOPE_HEADER), false);
    assert.equal(first.has("X-Fieldproof-Project"), false); assert.equal(second.get(ORG_PROJECT_SCOPE_HEADER), projectScope);
    assert.equal(requests[1].path.includes(token), false); assert.equal(JSON.parse(String(requests[1].options.body)).token, token);
    for (const { options } of requests) { assert.equal(options.credentials, "same-origin"); assert.equal(options.cache, "no-store"); assert.equal(options.referrerPolicy, "no-referrer"); }
  });
  it("rejects a capability fragment, secret query, duplicate cursor and escaped API path before fetch", () => {
    for (const path of ["https://example.invalid/", "//example.invalid/", "../private", "entry#invite=private", "entry?token=private", "policies?before=a&before=b", "entry\\elsewhere"])
      assert.throws(() => orgApiPath(path), TypeError, path);
    assert.equal(orgApiPath("policies?before=a%3Ab&version=00000000-0000-4000-8000-000000000001"), "/api/organizations/policies?before=a%3Ab&version=00000000-0000-4000-8000-000000000001");
  });
  it("treats an unreadable or wrong-contract success as unresolved rather than a completed command", async () => {
    const schema = z.object({ result: z.literal("committed") }).strict();
    const wrong = (async () => Response.json({ result: "okay", privateData: "unapproved" })) as typeof fetch;
    await assert.rejects(orgRequest("members", schema, undefined, { fetcher: wrong }), error => error instanceof OrgRequestError && orgRecoveryForError(error) === "same_attempt");
    const unreadable = (async () => new Response("interrupted", { status: 200 })) as typeof fetch;
    await assert.rejects(orgRequest("members", schema, undefined, { fetcher: unreadable }), error => error instanceof OrgRequestError && orgRecoveryForError(error) === "same_attempt");
    const denied = (async () => Response.json({ error: "Role ended", code: "ORG_ROLE_DENIED" }, { status: 403 })) as typeof fetch;
    await assert.rejects(orgRequest("members", schema, undefined, { fetcher: denied }), error => error instanceof OrgRequestError && orgRecoveryForError(error) === "stopped");
  });
  it("broadcasts no private identity and separately handles organization and project change channels", () => {
    class Channel implements OrgChannel {
      onmessage: OrgChannel["onmessage"] = null; messages: unknown[] = []; closed = false;
      postMessage(message: { origin: string }) { this.messages.push(message); }
      close() { this.closed = true; }
      send(data: unknown) { this.onmessage?.(new MessageEvent("message", { data })); }
    }
    const channels: { name: string; channel: Channel }[] = [], factory = (name: string) => { const channel = new Channel(); channels.push({ name, channel }); return channel; };
    const boundary = createOrgBoundary(), calls: string[] = [];
    const close = listenForOrganizationChanges(boundary, { organizationChanged: () => calls.push("org"), projectChanged: () => calls.push("project") }, factory);
    assert.deepEqual(channels.map(value => value.name), [ORG_CHANGE_CHANNEL, "fieldproof-workspace-changed"]);
    channels[0].channel.send({ origin: organizationTabIdentity() }); assert.deepEqual(calls, []);
    const org = boundary.start(), project = boundary.start("project");
    channels[1].channel.send({ origin: "independent-project-tab" }); assert.equal(org.current(), true); assert.equal(project.current(), false);
    channels[0].channel.send({ origin: "independent-organization-tab" }); assert.equal(org.current(), false); assert.deepEqual(calls, ["project", "org"]);
    announceOrganizationChange(factory); assert.deepEqual(channels[2].channel.messages, [{ origin: organizationTabIdentity() }]); assert.equal(channels[2].channel.closed, true);
    close(); for (const { channel } of channels.slice(0, 2)) { assert.equal(channel.closed, true); assert.equal(channel.onmessage, null); }
    boundary.dispose();
  });
});
