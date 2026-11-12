import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../app/supporters/supporters.css", import.meta.url), "utf8");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
function property(selector: string, key: string) {
  const rule = rules.find(rule => rule.selector.split(",").some(item => item.trim() === selector));
  assert.ok(rule, `The rendered selector ${selector} exists`);
  const value = rule.body.match(new RegExp(`(?:^|;)${key}:(#[a-f0-9]{6})(?:!important)?(?:;|$)`))?.[1];
  assert.ok(value, `${selector} declares its ${key} color`); return value;
}
function luminance(hex: string) {
  const values = hex.slice(1).match(/../g)!.map(value => Number.parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
}
function ratio(foreground: string, background: string) { const a = luminance(foreground), b = luminance(background); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); }
const surfaces = { shell: property(".sp-shell", "background"), card: property(".sp-card", "background"), selected: property(".sp-role-choice label:has(input:checked)", "background"), empty: property(".sp-empty", "background"), note: property(".sp-private-link", "background"), dialog: property(".sp-dialog", "background") };

describe("supporter text contrast on its rendered surfaces", () => {
  it("meets WCAG AA normal-text contrast for secondary copy, hints, deadlines and recovery notes", () => {
    const pairs: [string, string][] = [
      [".sp-header-caption", surfaces.shell], [".sp-eyebrow", surfaces.shell], [".sp-hero p:not(.sp-eyebrow)", surfaces.shell],
      [".sp-card>p", surfaces.card], [".sp-field>span:last-child:not(:first-child)", surfaces.card], [".sp-role-choice small", surfaces.selected],
      [".sp-ack", surfaces.card], [".sp-count-heading p", surfaces.shell], [".sp-invitation p", surfaces.card], [".sp-invitation details", surfaces.card],
      [".sp-empty p", surfaces.empty], [".sp-link-note", surfaces.note], [".sp-smallprint", surfaces.shell], [".sp-dialog p", surfaces.dialog],
      [".sp-entry-intro>p:not(.sp-eyebrow)", surfaces.shell], [".sp-entry-note", surfaces.shell], [".sp-entry-terms li", surfaces.card],
      [".sp-deadline span", surfaces.card], [".sp-footer", surfaces.shell], [".sp-muted", surfaces.shell],
    ];
    for (const [selector, background] of pairs) { const observed = ratio(property(selector, "color"), background); assert.ok(observed >= 4.5, `${selector} normal text contrast is ${observed.toFixed(3)}:1; minimum 4.5:1`); }
  });
  it("retains readable statuses, failure messages and invitation actions", () => {
    for (const selector of [".sp-status.joined", ".sp-status.expired", ".sp-notice", ".sp-notice.is-error"]) assert.ok(ratio(property(selector, "color"), property(selector, "background")) >= 4.5, `${selector} uses readable text`);
    for (const selector of [".sp-refresh", ".sp-withdraw", ".sp-entry-help button", ".sp-success-mark"]) assert.ok(ratio(property(selector, "color"), surfaces.shell) >= 4.5, `${selector} action text remains readable`);
  });
  it("keeps loading copy readable through its gradient and form boundaries distinguishable", () => {
    const skeleton = rules.find(rule => rule.selector === ".sp-skeleton")!, gradient = skeleton.body.match(/background:([^;]+)/)?.[1].match(/#[a-f0-9]{6}/g) ?? [];
    assert.ok(gradient.length > 1); for (const background of gradient) assert.ok(ratio(property(".sp-skeleton", "color"), background) >= 4.5, "Loading text contrasts with every gradient stop");
    const control = rules.find(rule => rule.selector.includes(".sp-form input:not"))!, border = control.body.match(/border:1px solid (#[a-f0-9]{6})/)?.[1];
    assert.ok(border); assert.ok(ratio(border, surfaces.card) >= 3, "Input and select boundaries need 3:1 against their card");
    assert.ok(ratio(border, property(".sp-private-link input", "background")) >= 3, "Private-link input boundary remains distinguishable");
    assert.ok(ratio(property(".sp-form input::placeholder", "color"), property(".sp-private-link input", "background")) >= 4.5, "Invitation hint text must not depend on a browser's placeholder color");
    assert.match(rules.find(rule => rule.selector === ".sp-form input::placeholder")!.body, /(?:^|;)opacity:1(?:;|$)/);
  });
});
