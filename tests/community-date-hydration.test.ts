import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { WorkspaceEntry, WorkspaceLibrary } from "../lib/community/contracts";

const zones = ["UTC", "Asia/Kolkata", "America/Los_Angeles"];
const midnight = "2030-02-17T19:05:18.835Z";
const repeatedHour = ["2026-11-01T08:30:00.000Z", "2026-11-01T09:30:00.000Z"];
function entry(index: number, expiresAt: string, available = true): WorkspaceEntry {
  return {
    sessionId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    projectId: "offline-render-project", title: "Offline rendering example", subtitle: "No workspace or person is created",
    templateId: "makerspace", mode: "sample", role: index === 1 ? "organizer" : "donor",
    profileLabel: index === 1 ? "Offline organizer profile" : "Offline donor profile",
    identityProvenance: index === 1 ? "workspace_session" : "self_declared",
    expiresAt, available, current: available && index === 1,
  };
}
function library(entries: WorkspaceEntry[], state: "active" | "ended" = "active"): WorkspaceLibrary {
  return { context: { hash: "1".repeat(64), state }, ready: true, currentProjectId: state === "active" ? "offline-render-project" : null, entries };
}
const cases = {
  midnight: library([entry(1, midnight), entry(2, midnight)]),
  daylight_saving: library([entry(1, repeatedHour[0]), entry(2, repeatedHour[1])]),
  ended_cookie: library([entry(1, midnight, false), entry(2, midnight)], "ended"),
  all_ended: library([entry(1, midnight, false), entry(2, midnight, false)], "ended"),
};
type CaseName = keyof typeof cases;
interface Rendered { html: string; dates: string[]; propsUnchanged: boolean; }

if (process.argv.includes("--render-community-library")) {
  // Render the actual initial client-component tree without browser effects,
  // HTTP, a database or a copied date-formatting implementation. Each process
  // gets its own ambient zone, including Intl's default-zone initialization.
  const name = process.argv.at(-1) as CaseName;
  assert.ok(Object.hasOwn(cases, name));
  const initial = cases[name], original = JSON.stringify(initial);
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { TemplateLibrary } = await import("../components/community/template-library");
  const { communityDate } = await import("../components/community/shared");
  const html = renderToStaticMarkup(React.createElement(TemplateLibrary, { initial, returnPath: "/funding" }));
  process.stdout.write(JSON.stringify({ html, dates: initial.entries.filter(row => row.available).map(row => communityDate(row.expiresAt)), propsUnchanged: JSON.stringify(initial) === original } satisfies Rendered));
} else {
  const cache = new Map<string, Rendered>();
  function render(name: CaseName, zone: string): Rendered {
    const key = `${name}:${zone}`, previous = cache.get(key);
    if (previous) return previous;
    const output = execFileSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--render-community-library", name], {
      cwd: process.cwd(), env: { ...process.env, TZ: zone }, encoding: "utf8", maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(output) as Rendered; cache.set(key, result); return result;
  }
  function equalInitialMarkup(name: CaseName): Rendered {
    const [server, ...clients] = zones.map(zone => render(name, zone));
    for (const client of clients) assert.equal(client.html, server.html, `${name}: the same initial props must produce the same server/client markup across time zones`);
    assert.ok(server.html.includes('class="cm-shell"') && server.html.includes('class="cm-library-saved"'));
    assert.ok([server, ...clients].every(result => result.propsUnchanged), "Displaying a fixed deadline must not change the original props");
    return server;
  }
  describe("saved-workspace deadline hydration", () => {
    it("keeps active same-project profile deadlines identical when a local date crosses midnight", () => {
      const result = equalInitialMarkup("midnight");
      assert.deepEqual(result.dates, ["Feb 17, 2030, 7:05 PM UTC", "Feb 17, 2030, 7:05 PM UTC"]);
      assert.ok(result.html.includes("Offline organizer profile") && result.html.includes("Offline donor profile"));
    });
    it("distinguishes the original instants across a repeated daylight-saving hour", () => {
      const result = equalInitialMarkup("daylight_saving");
      assert.deepEqual(result.dates, ["Nov 1, 2026, 8:30 AM UTC", "Nov 1, 2026, 9:30 AM UTC"]);
    });
    it("keeps an available saved profile deterministic while the current cookie has ended", () => {
      const result = equalInitialMarkup("ended_cookie");
      assert.deepEqual(result.dates, ["Feb 17, 2030, 7:05 PM UTC"]);
      assert.ok(result.html.includes("Clear ended workspace") && result.html.includes("This saved session has ended; project records remain saved."));
    });
    it("renders the all-ended control consistently without a date or a replacement deadline", () => {
      const result = equalInitialMarkup("all_ended");
      assert.deepEqual(result.dates, []);
      assert.ok(!result.html.includes("Access ends "));
      assert.equal(result.html.split("This saved session has ended; project records remain saved.").length - 1, 2);
    });
  });
}
