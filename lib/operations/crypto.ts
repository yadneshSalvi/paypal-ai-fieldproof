import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { digest, hash, OperationsError, requireOperation } from "./contracts";

const key = (secret: string, label = "fieldproof-private-values-v1") => {
  requireOperation(typeof secret === "string" && secret.length >= 32, "KEY_MISMATCH", "An explicit original encryption key is required.");
  return createHash("sha256").update(`${label}:${secret}`).digest();
};
export function encryptionKeyHash(secret: string): string { return hash(key(secret)); }
export function sealOriginal(value: unknown, context: string, secret: string): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  cipher.setAAD(Buffer.from(context));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), bytes.toString("base64url")].join(".");
}
export function openOriginal<T = unknown>(value: unknown, context: string, secret: string, recipient = false): T {
  try {
    if (typeof value !== "string") throw new Error();
    const [version, iv, tag, ciphertext, extra] = value.split(".");
    if (version !== "v1" || !iv || !tag || !ciphertext || extra) throw new Error();
    const nonce = Buffer.from(iv, "base64url"), auth = Buffer.from(tag, "base64url");
    if (nonce.length !== 12 || auth.length !== 16) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key(secret, recipient ? "fieldproof-recipient-v1" : undefined), nonce);
    decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(auth);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
    if (recipient) { if (!/^[A-Z0-9]{5,64}$/.test(plaintext)) throw new Error(); return plaintext as T; }
    return JSON.parse(plaintext) as T;
  } catch { throw new OperationsError("PRIVATE_LINEAGE", "An original private source cannot be authenticated with its exact key and identity binding."); }
}
/** Files contain ciphertext, never configuration secrets. The purpose and ID are authenticated. */
export function sealTransferFile(value: unknown, purpose: "bundle" | "plan" | "receipt", id: string, secret: string): string {
  return JSON.stringify({ format: "fieldproof-private-file/v2", purpose, id, hash: digest(value), ciphertext: sealOriginal(value, `fieldproof-operations-v2:${purpose}:${id}`, secret) });
}
export function openTransferFile<T>(text: string, purpose: "bundle" | "plan" | "receipt", secret: string): T {
  try {
    const envelope = JSON.parse(text) as Record<string, unknown>;
    requireOperation(Object.keys(envelope).sort().join(",") === "ciphertext,format,hash,id,purpose" && envelope.format === "fieldproof-private-file/v2" && envelope.purpose === purpose && typeof envelope.id === "string" && /^[a-f0-9-]{36}$/.test(envelope.id), "INVALID_BUNDLE", "The private transfer file has an unsupported envelope.");
    const result = openOriginal<T>(envelope.ciphertext, `fieldproof-operations-v2:${purpose}:${envelope.id}`, secret);
    requireOperation(digest(result) === envelope.hash, "INVALID_BUNDLE", "The private transfer file does not match its original digest.");
    return result;
  } catch (error) { if (error instanceof OperationsError) throw error; throw new OperationsError("INVALID_BUNDLE", "The private transfer file could not be verified."); }
}
