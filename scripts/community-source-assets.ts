import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { COMMUNITY_TEMPLATES, type CommunityTemplate } from "../lib/community/templates";
const check = process.argv.includes("--check");
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
function lines(text: string, max = 80): string[] {
  const result: string[] = []; let line = "";
  for (const word of text.split(/\s+/)) { if (line.length + word.length > max && line) { result.push(line); line = ""; } line += `${line ? " " : ""}${word}`; }
  if (line) result.push(line); return result;
}
function text(x: number, y: number, value: string, size = 18, color = "#263e40", weight = 400) {
  return `<text x="${x}" y="${y}" font-family="Arial,sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}">${escape(value)}</text>`;
}
function sheet(template: CommunityTemplate, title: string, inner: string) {
  const color = template.accent === "green" ? "#2f6652" : "#a74c3b";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1000" viewBox="0 0 900 1000"><rect width="900" height="1000" fill="#f8f6ee"/><rect x="0" y="0" width="900" height="12" fill="${color}"/>${text(63,62,"FIELDPROOF / COMMUNITY SOURCE PACK",16,color,700)}${text(63,112,title,34,color,700)}${text(63,151,template.subtitle,20)}${text(63,182,"SAMPLE · FICTIONAL · ILLUSTRATIVE · NO PHYSICAL WORK CLAIMED",13,color,700)}${inner}${text(63,981,"Editable authored source · Template v1 · Amounts in USD · Not a supplier offer",13)}</svg>\n`;
}
function drawing(template: CommunityTemplate, alignment = false) {
  const color = template.accent === "green" ? "#2f6652" : "#a74c3b", wash = template.accent === "green" ? "#e8eee1" : "#f0e3db";
  let inner = `<rect x="63" y="210" width="774" height="620" rx="4" fill="#fcfbf5" stroke="${color}" stroke-width="3"/>`;
  for (const [index,pkg] of template.packages.entries()) {
    const [x,y,w,h] = pkg.box.map((n,i) => n * (i % 2 ? 1000 : 900));
    inner += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${wash}" stroke="${color}" stroke-width="1.5"/>`;
    const label = lines(pkg.shortTitle, Math.floor(w / 10));
    label.forEach((line,i) => inner += text(x+12,y+25+i*21,line,17,color,700));
    if (h > 115) {
      const cy = y+h-45;
      if (template.id === "community-garden" && [0,2,5].includes(index)) for (let n=0;n<4;n++) inner += `<path d="M${x+35+n*45} ${cy+12}v-24m0 12q-15 -20 -15 -10q0 12 15 10m0 -5q15 -20 15 -10q0 12 -15 10" fill="none" stroke="${color}" stroke-width="2"/>`;
      else for (let n=0;n<3;n++) inner += `<rect x="${x+17+n*(w-30)/3}" y="${cy-14}" width="${Math.min(45,(w-45)/3)}" height="32" fill="none" stroke="${color}" stroke-width="2"/><path d="M${x+21+n*(w-30)/3} ${cy}h26" stroke="${color}"/>`;
    }
  }
  if (alignment) {
    for (const [x,y,n] of [[63,210,1],[837,210,2],[63,830,3]]) inner += `<circle cx="${x}" cy="${y}" r="13" fill="${color}"/>${text(x-4,y+5,String(n),14,"#fff",700)}`;
  }
  lines(template.planNotes,100).forEach((line,index) => inner += text(63,873+index*22,line,15));
  if (alignment) inner += text(63,950,"ILLUSTRATION FOR ALIGNMENT PRACTICE. This is not a site photograph.",15,color,700);
  return sheet(template, alignment ? "A practice image, with clear limits" : "A shared plan, ready for review",inner);
}
function quotes(template: CommunityTemplate) {
  let inner = text(63,231,"PROPOSED PACKAGE",14,"#53676a",700)+text(658,231,"FICTIONAL TOTAL",14,"#53676a",700);
  for (const [index,pkg] of template.packages.entries()) {
    const y=250+index*85;
    inner += `<rect x="63" y="${y}" width="774" height="70" fill="${index%2 ? "#fffdf7" : "#ecefe7"}"/>${text(77,y+28,pkg.title,20,"#263e40",700)}${text(77,y+52,"Fictional quote; stated package contents included.",14)}${text(683,y+37,`USD ${(pkg.budgetMinor/100).toFixed(2)}`,18,"#263e40",700)}`;
  }
  inner += `<path d="M63 792H837" stroke="#596c69"/>${text(63,832,"PROPOSED TOTAL",20,"#263e40",700)}${text(636,832,`USD ${(template.totalMinor/100).toFixed(2)}`,24,"#263e40",700)}`;
  lines("Every amount is a fictional planning assumption. No supplier has issued this quote, no tax advice is provided, and no purchase, donation or completed work is represented.",95).forEach((line,i) => inner += text(63,885+i*22,line,16));
  return sheet(template,"A budget with visible sources",inner);
}
function scope(template: CommunityTemplate) {
  const scopes = [...new Set(template.packages.flatMap(pkg => pkg.requirements.filter(r => r.scope).map(r => r.label)))];
  let inner=text(63,260,"FOR WORKFLOW PRACTICE ONLY",22,"#a74c3b",700)+text(63,302,"This is not a qualification or an inspection record.",22);
  scopes.forEach((label,i) => inner += text(78,365+i*44,`${String(i+1).padStart(2,"0")}  ${label}`,19));
  lines("A real reviewer must supply appropriate authority and inspect the actual conditions. The template does not name a qualified person. An organizer can practice the review workflow with this visibly fictional source, but cannot turn it into a human inspection.",84).forEach((line,i) => inner+=text(63,770+i*28,line,18));
  return sheet(template,"Review the right things",inner);
}
await mkdir("public/samples",{recursive:true});
for (const template of COMMUNITY_TEMPLATES.filter(t=>t.id!=="makerspace")) for (const [suffix,bytes] of [["sketch",drawing(template)],["quotes",quotes(template)],["alignment",drawing(template,true)],["review-scope",scope(template)]]) {
  const path=`public/samples/${template.assetPrefix}-${suffix}.svg`;
  if(check) assert.equal(await readFile(path,"utf8"),bytes,`${path} differs from its exact template`); else await writeFile(path,bytes);
}
console.log(JSON.stringify({checked:check,authoredAssets:8,provenance:"fictional illustrative sources"}));
