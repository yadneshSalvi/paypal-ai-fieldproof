import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { DomainError } from "../domain/money";

export const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
export function privateJson(value: unknown, status = 200) { return NextResponse.json(value, { status, headers: PRIVATE_HEADERS }); }
export function routeFailure(error: unknown) {
  if (error instanceof DomainError) return privateJson({ error: error.message, code: error.code }, error.status);
  if (error instanceof ZodError || error instanceof SyntaxError) return privateJson({ error: "Check the submitted fields and try again.", code: "INVALID_INPUT" }, 400);
  const requestId = randomUUID();
  console.error(JSON.stringify({ event: "request.failed", requestId, errorType: error instanceof Error ? error.name : "unknown" }));
  return privateJson({ error: "This step could not finish. Your saved draft is still available; refresh its status before trying again.", code: "REQUEST_UNAVAILABLE", requestId }, 500);
}
export async function requestJson(request: Request, maxBytes = 96 * 1024): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > maxBytes) throw new DomainError("INPUT_TOO_LARGE", "This request is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new DomainError("INPUT_TOO_LARGE", "This request is too large.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
