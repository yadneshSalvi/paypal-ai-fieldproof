import { z } from "zod";
import { recognitionHash, recognitionJournalSchema, type RecognitionJournal } from "./contracts";

export class RecognitionRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status: number, readonly recoverable = false) { super(message); }
}
const errorSchema = z.object({ error: z.object({ code: z.string().max(100), message: z.string().max(500), recoverable: z.boolean() }).strict() }).strict();
export async function recognitionFetch<T>(path: string, schema: z.ZodType<T>, options: { input?: unknown; accessId?: string; signal?: AbortSignal } = {}): Promise<T> {
  if (!/^\/api\/(?:recognition(?:\/|\?|$)|public-recognition\/)/.test(path) || path.includes("..") || path.includes("#")) throw new Error("Use the same-origin recognition API.");
  const response = await fetch(path, { method: options.input === undefined ? "GET" : "POST", credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store", signal: options.signal,
    headers: { ...(options.input === undefined ? {} : { "Content-Type": "application/json" }), ...(options.accessId ? { "X-Recognition-Access": options.accessId } : {}) },
    ...(options.input === undefined ? {} : { body: JSON.stringify(options.input) }) });
  if (options.signal?.aborted) throw new DOMException("The current request was interrupted.", "AbortError");
  if (!/application\/json/i.test(response.headers.get("content-type") ?? "")) throw new RecognitionRequestError("The current recognition response could not be verified. Reload its status.", "RECOGNITION_RESPONSE_INVALID", 503, true);
  const reader = response.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  if (reader) try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > 128_000) { await reader.cancel(); throw new RecognitionRequestError("The response exceeded this view's safe limit.", "RECOGNITION_RESPONSE_INVALID", 503, true); }
      chunks.push(value); }
  } finally { reader.releaseLock(); }
  if (options.signal?.aborted) throw new DOMException("The current request was interrupted.", "AbortError");
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(joinBytes(chunks, size))); }
  catch { throw new RecognitionRequestError("This response could not be checked. Reload the original status.", "RECOGNITION_RESPONSE_INVALID", 503, true); }
  if (!response.ok) {
    const parsed = errorSchema.safeParse(body);
    throw new RecognitionRequestError(parsed.success ? parsed.data.error.message : "The current recognition check could not finish.", parsed.success ? parsed.data.error.code : "RECOGNITION_UNAVAILABLE", response.status, parsed.success && parsed.data.error.recoverable);
  }
  const parsed = z.object({ data: schema }).strict().safeParse(body);
  if (!parsed.success) throw new RecognitionRequestError("This recognition response contains unsupported fields. Nothing from it was displayed.", "RECOGNITION_RESPONSE_INVALID", 503, true);
  return parsed.data.data;
}
function joinBytes(chunks: Uint8Array[], size: number) { const all = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; } return all; }
export const recognitionJournalKey = (accessId: string) => `fieldproof:recognition:request:${recognitionHash.parse(accessId)}`;
export function readRecognitionJournal(storage: Pick<Storage, "getItem">, accessId: string): RecognitionJournal | null {
  const raw = storage.getItem(recognitionJournalKey(accessId));
  if (!raw) return null;
  const parsed = recognitionJournalSchema.safeParse(JSON.parse(raw));
  if (!parsed.success || parsed.data.accessId !== accessId) throw new Error("The original request journal could not be verified. No request was replayed.");
  return parsed.data;
}
export function writeRecognitionJournal(storage: Pick<Storage, "setItem" | "getItem">, journal: RecognitionJournal) {
  const safe = recognitionJournalSchema.parse(journal), key = recognitionJournalKey(safe.accessId), bytes = JSON.stringify(safe);
  storage.setItem(key, bytes);
  if (storage.getItem(key) !== bytes) throw new Error("This browser could not retain the original request. No decision was sent.");
}
export function clearRecognitionJournal(storage: Pick<Storage, "removeItem">, accessId: string) { storage.removeItem(recognitionJournalKey(accessId)); }
export const recognitionDate = (value: string) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value)) + " UTC";
