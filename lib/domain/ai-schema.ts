/** Gemini's constrained decoder rejects large bounded array grammars. Keep the
 * shape on the provider boundary; the original Zod schema still validates every
 * returned value, length, bound and extra property before anything is stored. */
export function geminiOutputShape(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiOutputShape);
  if (!schema || typeof schema !== "object") return schema;
  const deferred = new Set(["$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "minItems", "maxItems"]);
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !deferred.has(key)).map(([key, value]) => [key, geminiOutputShape(value)]));
}
