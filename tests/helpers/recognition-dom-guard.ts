/** Component qualification only. No DB, browser, credentials or remote transport. */
import assert from "node:assert/strict";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import dns from "node:dns";

assert.equal(process.cwd(), "/Users/yadneshsalvi/code/hackathons/paypal-ai-hackathon/fieldproof/.local/recognition-stage14");
for (const key of Object.keys(process.env)) assert(!/(?:^PAYPAL_|^OPENAI_|^GEMINI_|^GOOGLE_|^BLOB_|DATABASE_URL|AUTH_SECRET|^VERCEL_)/.test(key) || !process.env[key], "Run component qualification in an empty credential environment.");
const denied = () => { throw new Error("Recognition component qualification allows only controlled in-memory responses."); };
globalThis.fetch = (async () => denied()) as typeof fetch;
net.Socket.prototype.connect = denied as typeof net.Socket.prototype.connect;
tls.connect = denied as typeof tls.connect; http.request = denied as typeof http.request; http.get = denied as typeof http.get;
https.request = denied as typeof https.request; https.get = denied as typeof https.get; dgram.createSocket = denied as typeof dgram.createSocket;
for (const owner of [dns, dns.promises]) for (const key of Object.keys(owner)) if (/^(lookup|resolve|reverse|Resolver)/.test(key)) Reflect.set(owner, key, denied);
syncBuiltinESMExports();
registerHooks({ load(url, context, next) {
  if (url.endsWith("/components/recognition/recognition.module.css")) return { format: "module", source: "export default new Proxy({}, {get:(_,key)=>String(key)})", shortCircuit: true };
  return next(url, context);
} });
