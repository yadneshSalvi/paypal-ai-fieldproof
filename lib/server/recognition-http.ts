import { z, ZodError } from "zod";
import { DomainError } from "../domain/money";
import { recognitionHash, recognitionSlug, type RecognitionEnvelope } from "../recognition/contracts";
import { assertSameOrigin, sessionCookieName } from "./auth";
import { requestJson } from "./http";
import { executeRecognitionCommand, readRecognitionCommand, reviewRecognitionCommand } from "./recognition-commands";
import { readPublicRecognition, readRecognitionDesk, readRecognitionModeration } from "./recognition-store";
import type { RecognitionRequest } from "./recognition-source";

export const RECOGNITION_HEADERS = { "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff", "Vary": "Cookie, X-Recognition-Access", "Content-Type": "application/json; charset=utf-8" };
export function recognitionJson<T>(data: T, status = 200) {
  return new Response(JSON.stringify({ data } satisfies RecognitionEnvelope<T>), { status, headers: RECOGNITION_HEADERS });
}
export function recognitionFailure(error: unknown) {
  const known = error instanceof DomainError;
  const status = known ? error.status : error instanceof ZodError || error instanceof SyntaxError ? 400 : 503;
  return new Response(JSON.stringify({ error: { code: known ? error.code : status === 400 ? "RECOGNITION_INVALID_INPUT" : "RECOGNITION_UNAVAILABLE",
    message: known ? error.message : status === 400 ? "Check the submitted fields. No new decision was accepted." : "This current recognition check could not finish. Reload its original status before trying again.",
    recoverable: [404, 409, 429, 503].includes(status) } }), { status, headers: RECOGNITION_HEADERS });
}
/** Reads the ordinary server-issued project cookie. No recognition login exists. */
export function recognitionRequest(request: Request): RecognitionRequest {
  const name = sessionCookieName(), matches = (request.headers.get("cookie") ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matches.length > 1) throw new DomainError("RECOGNITION_COOKIE_AMBIGUOUS", "Reload your ordinary project entry before continuing.", 400);
  const token = matches[0]?.slice(name.length + 1) ?? null;
  if (token && !/^[A-Za-z0-9_-]{20,128}$/.test(token)) throw new DomainError("RECOGNITION_ACCESS_ENDED", "The original project profile is unavailable. Open its ordinary entry.", 410);
  return { projectToken: token };
}
function accessHeader(request: Request, required = false) {
  const value = request.headers.get("X-Recognition-Access");
  return value === null && !required ? undefined : recognitionHash.parse(value);
}
function queryValues(request: Request, allowed: string[]) {
  const values = new URL(request.url).searchParams;
  for (const key of values.keys()) if (!allowed.includes(key) || values.getAll(key).length !== 1) throw new DomainError("RECOGNITION_INVALID_INPUT", "This recognition address contains unsupported fields.", 400);
  return values;
}
export async function recognitionGet(request: Request, parts: string[] = []) {
  try {
    if (request.headers.get("Sec-Fetch-Site") === "cross-site") throw new DomainError("ORIGIN_DENIED", "Open this private view from your current Fieldproof project.", 403);
    const current = recognitionRequest(request), path = parts.join("/");
    if (!path) {
      const values = queryValues(request, ["slug"]), slug = values.has("slug") ? recognitionSlug.parse(values.get("slug")) : undefined;
      return recognitionJson(await readRecognitionDesk(current, slug, accessHeader(request)));
    }
    if (parts.length === 2 && parts[0] === "commands") {
      queryValues(request, []);
      return recognitionJson(await readRecognitionCommand(current, z.uuid().parse(parts[1]), accessHeader(request, true)!));
    }
    if (parts.length === 2 && parts[0] === "moderation") {
      const values = queryValues(request, ["cursor"]), cursor = values.has("cursor") ? z.string().min(1).max(3000).parse(values.get("cursor")) : undefined;
      return recognitionJson(await readRecognitionModeration(current, recognitionSlug.parse(parts[1]), cursor, accessHeader(request, true)!));
    }
    throw new DomainError("NOT_FOUND", "This private recognition view is unavailable.", 404);
  } catch (error) { return recognitionFailure(error); }
}
export async function recognitionPost(request: Request, parts: string[] = []) {
  try {
    assertSameOrigin(request);
    const path = parts.join("/");
    if (!["commands", "review"].includes(path)) throw new DomainError("NOT_FOUND", "This recognition action is unavailable.", 404);
    queryValues(request, []);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") ?? "")) throw new DomainError("RECOGNITION_INVALID_INPUT", "Use the ordinary recognition form to review this decision.", 415);
    const body = await requestJson(request, 6_000), current = recognitionRequest(request);
    return recognitionJson(await (path === "review" ? reviewRecognitionCommand(current, body) : executeRecognitionCommand(current, body)));
  } catch (error) { return recognitionFailure(error); }
}
export async function publicRecognitionGet(request: Request, slug: string) {
  try {
    const values = queryValues(request, ["cursor"]), cursor = values.has("cursor") ? z.string().min(1).max(3000).parse(values.get("cursor")) : undefined;
    return recognitionJson(await readPublicRecognition(recognitionSlug.parse(slug), cursor));
  } catch (error) { return recognitionFailure(error); }
}
