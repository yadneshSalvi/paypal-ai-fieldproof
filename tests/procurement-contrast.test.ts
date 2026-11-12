import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/** Declaration-level measurements, not a browser layout/zoom assessment. Every
 * color is read from the stylesheet the actual procurement pages import. */
const css = readFileSync(new URL("../app/procurement/procurement.css", import.meta.url), "utf8"), rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
function rule(selector: string) { const found = rules.find(value => value.selector.split(",").some(part => part.trim() === selector)); assert.ok(found, `The actual selector ${selector} exists.`); return found; }
function raw(selector: string, property: string) { const result = rule(selector).body.match(new RegExp(`(?:^|;)${property}:([^;]+)`))?.[1]; assert.ok(result, `${selector} declares ${property}.`); return result; }
function variables(selector: string) { return Object.fromEntries([...rule(selector).body.matchAll(/(--pr-[a-z]+):(#[a-f0-9]{6})/g)].map(([, key, value]) => [key, value])); }
function color(selector: string, property: string, values: Record<string, string> = {}) { const result = raw(selector, property).replace(/var\((--pr-[a-z]+)\)/g, (_, name: string) => values[name]); assert.match(result, /^#[a-f0-9]{6}$/); return result; }
function luminance(hex: string) { const rgb = hex.slice(1).match(/../g)!.map(value => Number.parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; }
function contrast(a: string, b: string) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
function meets(a: string, b: string, label: string, minimum = 4.5) { const actual = contrast(a, b); assert.ok(actual >= minimum, `${label}: ${actual.toFixed(3)}:1 (minimum ${minimum}:1)`); }
const base = variables(".pr-shell"), themes = [base, { ...base, ...variables(".pr-template-community-garden") }, { ...base, ...variables(".pr-template-mutual-aid") }];

describe("actual procurement stylesheet contrast and usable controls", () => {
  it("keeps primary, secondary and action text legible on every template's paper and tinted surfaces", () => {
    for (const theme of themes) for (const background of [theme["--pr-bg"], theme["--pr-paper"], theme["--pr-soft"], color(".pr-line-editor", "background")]) {
      meets(theme["--pr-ink"], background, "Body and heading text"); meets(color(".pr-fineprint", "color", theme), background, "Secondary copy, deadlines and provenance"); meets(theme["--pr-accent"], background, "Current actions and linked source labels");
    }
    for (const theme of themes) { meets(color(".pr-button.primary", "color", theme), color(".pr-button.primary", "background", theme), "Primary action"); meets(color(".pr-tabs button[aria-current=page]", "color", theme), color(".pr-tabs button[aria-current=page]", "background", theme), "Current section"); }
  });
  it("measures the status, error, loading and source-quotation text against their actual backgrounds", () => {
    for (const selector of [".pr-status", ".pr-status.good", ".pr-status.warning", ".pr-status.danger", ".pr-notice", ".pr-notice.error", ".pr-source-detail blockquote", ".pr-revision-list blockquote"]) meets(color(selector, "color", base), color(selector, "background", base), selector);
    for (const theme of themes) meets(color(".pr-busy", "color", theme), color(".pr-busy", "background", theme), "Loading/readiness copy");
  });
  it("keeps actual input boundaries, focus rings and explicit placeholders distinguishable", () => {
    const selector = ".pr-form input:not([type=checkbox])", border = raw(selector, "border").replace("1px solid ", "").replace("var(--pr-line)", base["--pr-line"]);
    meets(border, color(selector, "background", base), "Form field boundary", 3);
    meets(color(".pr-form input::placeholder", "color"), base["--pr-paper"], "Source and identity placeholders"); assert.match(rule(".pr-form input::placeholder").body, /(?:^|;)opacity:1(?:;|$)/);
    const focus = raw(".pr-shell :focus-visible", "outline").replace("3px solid ", ""); for (const surface of [base["--pr-paper"], base["--pr-bg"]]) meets(focus, surface, "Visible keyboard focus", 3);
    assert.match(rule(".pr-button").body, /min-height:46px/); assert.match(rule(".pr-text-button").body, /min-height:44px/); assert.match(rule(".pr-icon-button").body, /width:44px;height:44px/);
  });
});
