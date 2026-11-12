/** Test-only: import before application modules. No runtime config is read. */
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import dgram from "node:dgram";

const key = Symbol.for("fieldproof.toolkit.controlled-network");
if (!globalThis[key]) {
  const state = { attempts: 0, events: [] }; globalThis[key] = state;
  const deny = () => { state.attempts++; const error = new Error("TOOLKIT_TEST_NETWORK_FORBIDDEN"); state.events.push(error.stack); throw error; };
  globalThis.fetch = async () => deny();
  net.Socket.prototype.connect = deny;
  tls.connect = deny;
  for (const api of [http, https]) { api.request = deny; api.get = deny; }
  dgram.createSocket = deny;
  for (const api of [dns, dns.promises]) for (const name of Object.keys(api)) if (/^(?:lookup|resolve|reverse|Resolver)/.test(name)) api[name] = deny;
  syncBuiltinESMExports();
  for (const name of Object.keys(process.env)) if (/(?:TOKEN|SECRET|API_KEY|CREDENTIAL|CLIENT_ID|DATABASE_URL|APP_URL|FIELDPROOF_|^AWS_|^AZURE_|^GOOGLE_|^GCP_|^OPENAI_|^GEMINI_|^PAYPAL_|^VERCEL_|^BLOB_|^PG[A-Z_]*$|^DEBUG$)/i.test(name)) delete process.env[name];
}
export function toolkitNetworkAttempts() { return globalThis[key].attempts; }
export function toolkitDeniedNetworkReceipt() { return [...globalThis[key].events]; }
