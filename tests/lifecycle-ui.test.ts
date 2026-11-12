import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { lifecycleOccurrenceMetadata, lifecycleScheduleMetadata, lifecycleDesk, lifecycleOccurrenceDetail, lifecycleSchedule } from "./helpers/lifecycle";
import * as C from "../lib/lifecycle/contracts";

/** Server rendering is compared across actual process timezones, without a
 * browser, provider, DB, source fetch or invented participation. */
describe("actual lifecycle components under different host timezones", () => {
  it("renders the same real workspace/UTC form dates for all three template profiles in UTC, India and Los Angeles", () => {
    const script = `import React from 'react'; globalThis.React=React; const {renderToStaticMarkup}=await import('react-dom/server'); const {LifecycleWorkspace}=await import('./components/lifecycle/workspace.tsx'); const {LifecycleScheduleEditor}=await import('./components/lifecycle/schedules.tsx'); const {lifecycleContext,lifecycleDesk}=await import('./tests/helpers/lifecycle.ts'); let output=[]; const api={blocked:()=>false,read:async()=>null,saved:[],busy:false,error:null,receipt:null,storageWarning:'',recovering:false}; for(const templateId of ['makerspace','garden','mutual-aid']){const context=lifecycleContext('organizer');context.project.profile.project.templateId=templateId;context.project.profile.project.title='Controlled '+templateId+' project';output.push(renderToStaticMarkup(React.createElement(LifecycleWorkspace,{initialContext:context})));output.push(renderToStaticMarkup(React.createElement(LifecycleScheduleEditor,{context,desk:lifecycleDesk(),api,schedule:null,close(){}})));}process.stdout.write(JSON.stringify(output));`;
    const values = ["UTC", "Asia/Kolkata", "America/Los_Angeles"].map(TZ => { const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), env: { ...process.env, TZ }, encoding: "utf8", timeout: 20000 }); assert.equal(result.status, 0, result.stderr); return result.stdout; });
    assert.equal(values[0], values[1]); assert.equal(values[0], values[2]); const markup = JSON.parse(values[0]) as string[]; assert.equal(markup.length, 6); assert.match(values[0], /UTC/); for (const template of ["makerspace", "garden", "mutual-aid"]) assert.match(values[0], new RegExp(`Controlled ${template} project`)); assert.doesNotMatch(values[0], /Fixture chooser|Choose actor|sendEmail|type=\\"email/);
  });
  it("keeps source-private data out of organization-only metadata while preserving the original identity and visible skip state", () => {
    const definition = lifecycleSchedule(), metadata = lifecycleScheduleMetadata(definition), occurrence = lifecycleOccurrenceDetail().occurrence, hidden = lifecycleOccurrenceMetadata(occurrence);
    assert.equal(C.lifecycleScheduleDeskSchema.parse({ ...lifecycleDesk(), schedules: [metadata] }).schedules[0].definition, null); assert.equal(metadata.id, definition.id); assert.equal(metadata.definitionHash, definition.definitionHash); assert.equal(metadata.canDisable, true);
    const page = C.lifecycleOccurrencePageSchema.parse({ scope: lifecycleDesk().scope, checkedAt: lifecycleDesk().checkedAt, occurrences: [hidden], nextCursor: null }); assert.equal(page.occurrences[0].occurrenceKey, occurrence.occurrenceKey); assert.equal(page.occurrences[0].dueAt, occurrence.dueAt); assert.equal(page.occurrences[0].snapshotHash, null); assert.equal(page.occurrences[0].canRetry, false); assert.equal(page.occurrences[0].title, null);
  });
});

const luminance = (color: string) => { const parts = color.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4); return .2126 * parts[0] + .7152 * parts[1] + .0722 * parts[2]; };
const ratio = (a: string, b: string) => { const values = [luminance(a), luminance(b)].sort((a, b) => b - a); return (values[0] + .05) / (values[1] + .05); };
describe("authored lifecycle stylesheet accessibility", () => {
  const css = readFileSync(new URL("../app/lifecycle/lifecycle.css", import.meta.url), "utf8"), root = css.match(/\.lc-shell\{([^}]+)\}/)![1];
  const variables = new Map([...root.matchAll(/(--lc-[a-z-]+):(#[a-fA-F0-9]{6})/g)].map(match => [match[1], match[2]]));
  function declarations(selector: string) { const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), rule = css.match(new RegExp(`(?:^|})${escaped}\\{([^}]+)\\}`)); assert.ok(rule, `Actual stylesheet rule missing: ${selector}`); return rule[1]; }
  function color(rule: string, property: string) { const value = rule.match(new RegExp(`(?:^|;)${property}:([^;]+)`))?.[1]; assert.ok(value, `No ${property} on actual rule`); return value.startsWith("var(") ? variables.get(value.slice(4, -1))! : value; }
  it("meets normal text contrast on actual secondary, status, citation and button rules, including paper and tinted backgrounds", () => {
    const paper = variables.get("--lc-paper")!, ground = variables.get("--lc-ground")!, secondary = variables.get("--lc-secondary")!;
    const pairs = [[variables.get("--lc-ink")!, ground], [secondary, paper], [secondary, ground], [secondary, "#f5f6ed"], [secondary, "#f2f4ea"], [secondary, "#e9eedf"]];
    for (const selector of [".lc-badge", ".lc-button", ".lc-button.secondary", ".lc-notice", ".lc-notice.is-error", ".lc-form-error", ".lc-citations button"]) { const rule = declarations(selector); pairs.push([color(rule, "color"), color(rule, "background")]); }
    for (const [foreground, background] of pairs) assert.ok(ratio(foreground, background) >= 4.5, `${foreground} on ${background}: ${ratio(foreground, background).toFixed(2)}:1`);
    const placeholder = declarations('.lc-field :where(input,textarea)::placeholder'); assert.ok(ratio(color(placeholder, "color"), paper) >= 4.5); assert.match(placeholder, /opacity:1/);
  });
  it("keeps real input boundaries/focus visible, responsive overflow paths and reduced-motion behavior", () => {
    const field = declarations(".lc-field :where(input,select,textarea)"); const border = field.match(/border:1px solid (#[a-f0-9]{6})/)![1]; assert.ok(ratio(border, variables.get("--lc-paper")!) >= 3); assert.match(css, /:focus-visible\{outline:3px solid #336731/); assert.ok(ratio("#336731", variables.get("--lc-ground")!) >= 3); assert.match(css, /@media\(max-width:390px\)/); assert.match(css, /@media\(max-width:760px\)/); assert.match(css, /max-height:calc\(100dvh - 20px\)/); assert.match(css, /prefers-reduced-motion:reduce/); assert.match(declarations(".lc-tabs"), /overflow-x:auto/);
  });
});
