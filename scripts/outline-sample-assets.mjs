import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { GlobalFonts, convertSVGTextToPath } from "@napi-rs/canvas";

// Server images must not depend on fonts installed on a deployment host. Keep
// the authored SVGs editable; only the generated, outlined copies are rasterized.
const check = process.argv.includes("--check");
const hash = value => createHash("sha256").update(value).digest("hex");
const fontFiles = [
  ["sans", 400, "Fieldproof Sans"], ["sans", 700, "Fieldproof Sans"],
  ["mono", 400, "Fieldproof Mono"],
];
const fonts = [];
for (const [family, weight, alias] of fontFiles) {
  const path = `node_modules/@fontsource/ibm-plex-${family}/files/ibm-plex-${family}-latin-${weight}-normal.woff`;
  const bytes = await readFile(path);
  assert.ok(GlobalFonts.register(bytes, alias), `Cannot load bundled ${family} ${weight}`);
  fonts.push({ family, weight, sha256: hash(bytes) });
}
const assets = [];
async function output(path, bytes) {
  if (check) assert.deepEqual(await readFile(path), Buffer.from(bytes), `${path} is out of date`);
  else await writeFile(path, bytes);
}
async function outline(input, outputPath, sourceName) {
  const prepared = input.replaceAll('font-family="Arial,sans-serif"', 'font-family="Fieldproof Sans"')
    .replaceAll('font-family="monospace"', 'font-family="Fieldproof Mono"');
  // Skia's complete SVG round-trip drops pattern paints. Outline only our
  // simple authored text nodes and preserve all original non-text geometry.
  // Reject new unsupported constructs rather than silently corrupting them.
  const svgOpen = prepared.match(/<svg\b[^>]*>/)?.[0];
  assert.ok(svgOpen && !/<(?:tspan|style|use)\b/.test(prepared), `${sourceName} needs an explicit text-layout review`);
  const groups = [];
  const result = prepared.replace(/<g\b[^>]*>|<\/g>|<text\b[^>]*>[\s\S]*?<\/text>/g, token => {
    if (token.startsWith("<g")) {
      assert.ok(!/\b(?:transform|opacity|filter|clip-path)=/.test(token), "Text outlining needs untransformed authored groups");
      groups.push(token); return token;
    }
    if (token === "</g>") { assert.ok(groups.pop()); return token; }
    const isolated = `${svgOpen}${groups.join("")}${token}${"</g>".repeat(groups.length)}</svg>`;
    const converted = convertSVGTextToPath(isolated).toString();
    const inner = converted.match(/<svg\b[^>]*>([\s\S]*)<\/svg>/)?.[1];
    assert.ok(inner && !/<(?:text|tspan)\b/.test(inner), `${sourceName} contains unconverted text`);
    return inner;
  });
  assert.equal(groups.length, 0, "Unbalanced authored groups");
  const outlined = Buffer.from(result.replace(/\sfont-family="[^"]*"/g, ""));
  assert.ok(!/<(?:text|tspan)\b|font-family\s*=|<image\b/i.test(outlined.toString()), `${sourceName} still requires a font or external image`);
  assert.ok((outlined.toString().match(/<path\b/g) ?? []).length > 30, `${sourceName} has no outlined lettering`);
  await output(outputPath, outlined);
  assets.push({ source: sourceName, output: outputPath, sourceSha256: hash(input), sha256: hash(outlined), bytes: outlined.length });
}
for (const dir of ["public/samples/outlined", "public/proof-stamps", "public/asset-fonts"]) await mkdir(dir, { recursive: true });
for (const name of ["eastside-sketch", "eastside-quotes", "eastside-alignment", "eastside-review-scope", "maria-receipt", ...["garden", "mutual-aid"].flatMap(prefix => ["sketch", "quotes", "alignment", "review-scope"].map(suffix => `${prefix}-${suffix}`))]) {
  const path = `public/samples/${name}.svg`;
  await outline(await readFile(path, "utf8"), `public/samples/outlined/${name}.svg`, path);
}
for (const [name, label] of [
  ["sample", "SAMPLE EVIDENCE · FICTIONAL SOURCE · PUBLIC COPY"],
  ["redacted", "REDACTED PUBLIC COPY · SCOPE SHOWN ON PROOF PAGE"],
]) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="40" viewBox="0 0 900 40"><rect width="900" height="40" fill="#fffdf7"/><text x="14" y="26" font-family="Arial,sans-serif" font-size="16" fill="#18354a">${label}</text></svg>`;
  await outline(svg, `public/proof-stamps/${name}.svg`, `authored-${name}-proof-stamp`);
}
await output("public/asset-fonts/OFL.txt", await readFile("node_modules/@fontsource/ibm-plex-sans/LICENSE"));
await output("public/samples/outlined/manifest.json", JSON.stringify({
  purpose: "Font-independent raster inputs. Original editable Sample SVGs are retained separately. Existing stored evidence is never rewritten.",
  generator: "@napi-rs/canvas 1.1.0 convertSVGTextToPath", fontLicense: "/asset-fonts/OFL.txt", fonts, assets,
}, null, 2) + "\n");
console.log(JSON.stringify({ checked: check, outlinedAssets: assets.length, fontFiles: fonts.length, bytes: assets.reduce((sum, asset) => sum + asset.bytes, 0) }));
