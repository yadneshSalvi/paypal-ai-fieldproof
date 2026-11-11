import { modelBriefSchema, translationSchema, type BriefDraft, type BriefSource, type BriefStatement, type BriefValue, type CommunityLocale, type TranslationParagraph } from "./contracts";
import { DomainError } from "../domain/money";

const slotPattern = /\{\{([a-z][a-z0-9_]*)\}\}/g;
export function valueText(value: BriefValue, locale: CommunityLocale): string {
  if (value.kind === "money") {
    if (!Number.isSafeInteger(value.value) || Number(value.value) < 0) throw new DomainError("BRIEF_VALUE_INVALID", "A source amount must be whole, non-negative cents.", 422);
    return new Intl.NumberFormat(locale === "es" ? "es-US" : "en-US", { style: "currency", currency: "USD", currencyDisplay: "code", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value.value) / 100);
  }
  if (value.kind === "count") {
    if (!Number.isSafeInteger(value.value) || Number(value.value) < 0) throw new DomainError("BRIEF_VALUE_INVALID", "A source count is invalid.", 422);
    return new Intl.NumberFormat(locale === "es" ? "es-US" : "en-US").format(Number(value.value));
  }
  if (value.kind === "date") {
    if (!Number.isFinite(Date.parse(String(value.value)))) throw new DomainError("BRIEF_VALUE_INVALID", "A source date is invalid.", 422);
    return new Intl.DateTimeFormat(locale === "es" ? "es-US" : "en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value.value)) + " UTC";
  }
  return locale === "es" && value.displayEs ? value.displayEs : String(value.value);
}
export function renderStatement(statement: BriefStatement, locale: CommunityLocale, translated?: string): string {
  const text = translated ?? (locale === "es" ? statement.spanish : statement.english);
  const values = new Map(statement.values.map(value => [value.key, value]));
  if (/\{\{|\}\}/.test(text.replace(slotPattern, ""))) throw new DomainError("BRIEF_SLOT_UNKNOWN", "A source placeholder is incomplete.", 422);
  const output = text.replace(slotPattern, (_, key: string) => {
    const value = values.get(key); if (!value) throw new DomainError("BRIEF_SLOT_UNKNOWN", "This sentence refers to an unavailable source value.", 422);
    return valueText(value, locale);
  });
  return output;
}
const slots = (text: string) => [...text.matchAll(slotPattern)].map(match => match[1]).sort();
export function assertStatementSources(source: Pick<BriefSource, "statements" | "rows">) {
  const rows = new Map(source.rows.map(row => [row.id, row]));
  if (rows.size !== source.rows.length || new Set(source.statements.map(s => s.id)).size !== source.statements.length) throw new DomainError("BRIEF_SOURCE_DUPLICATE", "The scoped source contains duplicate identities.", 422);
  for (const statement of source.statements) {
    if (!statement.citations.length || statement.citations.some(citation => rows.get(citation.rowId)?.hash !== citation.rowHash)) throw new DomainError("BRIEF_CITATION_INVALID", "Every sentence needs an exact row from its authorized snapshot.", 422);
    const english = slots(statement.english), spanish = slots(statement.spanish), values = statement.values.map(v => v.key).sort();
    if (JSON.stringify(english) !== JSON.stringify(spanish) || JSON.stringify(english) !== JSON.stringify(values)) throw new DomainError("BRIEF_SLOTS_INVALID", "English, Spanish and source values must contain the same exact placeholders.", 422);
    renderStatement(statement, "en"); renderStatement(statement, "es");
  }
}
/** Models can choose and order supported facts; they cannot invent factual prose. */
export function compileModelBrief(source: BriefSource, raw: unknown): BriefStatement[] {
  const input = modelBriefSchema.parse(raw); assertStatementSources(source);
  if (input.unknownStatementIds.length) throw new DomainError("BRIEF_UNKNOWN_FACTS", "The model requested facts outside the supplied source. Review the saved attempt and choose supported sentences.", 422);
  const selected = new Set<string>();
  return input.selections.map(selection => {
    const statement = source.statements.find(item => item.id === selection.statementId);
    if (!statement || selected.has(statement.id)) throw new DomainError("BRIEF_STATEMENT_INVALID", "The model selected an unavailable or repeated source sentence.", 422);
    selected.add(statement.id);
    if (JSON.stringify([...selection.citationRowIds].sort()) !== JSON.stringify(statement.citations.map(c => c.rowId).sort())) throw new DomainError("BRIEF_CITATION_INVALID", "A model sentence changed its exact factual citations.", 422);
    return structuredClone(statement);
  });
}
export function selectStatements(source: BriefSource, ids: string[]): BriefStatement[] {
  if(new Set(ids).size!==ids.length||ids.some(id=>!source.statements.some(statement=>statement.id===id)))throw new DomainError("BRIEF_STATEMENT_INVALID","Choose each factual sentence once from this exact authorized snapshot.",422);
  return compileModelBrief(source, { selections: ids.map(id => ({ statementId: id, citationRowIds: source.statements.find(s => s.id === id)?.citations.map(c => c.rowId) ?? [] })), unknownStatementIds: [] });
}
/** All amounts, counts, dates and names remain server-rendered source slots. */
export function validateTranslation(draft: Pick<BriefDraft, "paragraphs">, raw: unknown): TranslationParagraph[] {
  const input = translationSchema.parse(raw), expected = draft.paragraphs.map(p => p.id);
  if (input.paragraphs.length !== expected.length || new Set(input.paragraphs.map(p => p.paragraphId)).size !== expected.length || input.paragraphs.some(p => !expected.includes(p.paragraphId))) throw new DomainError("TRANSLATION_PARAGRAPHS_CHANGED", "Keep every source paragraph exactly once and preserve its identity.", 422);
  return draft.paragraphs.map(statement => {
    const paragraph = input.paragraphs.find(p => p.paragraphId === statement.id)!;
    if (JSON.stringify(slots(paragraph.text)) !== JSON.stringify(slots(statement.english))) throw new DomainError("TRANSLATION_VALUES_CHANGED", "Preserve every protected source placeholder exactly once. Amounts and conditions are rendered from the saved record.", 422);
    const prose = paragraph.text.replace(slotPattern, "");
    if (/[\d\p{Sc}]|\b(?:USD|EUR|GBP|http|https|javascript)\b|<\/?[a-z]|\{\{|\}\}/iu.test(prose)) throw new DomainError("TRANSLATION_UNSOURCED_VALUE", "Keep amounts, counts, names and dates in their protected source placeholders; links and markup are not part of a translation.", 422);
    return paragraph;
  });
}
export const authoredTranslation = (draft: Pick<BriefDraft, "paragraphs">): TranslationParagraph[] => validateTranslation(draft, { paragraphs: draft.paragraphs.map(p => ({ paragraphId: p.id, text: p.spanish })) });
