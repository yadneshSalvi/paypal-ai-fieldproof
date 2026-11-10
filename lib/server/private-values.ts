import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { OperationDocumentCodec, OperationDocumentContext } from "@fracture/paypal-core";

function encryptionKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("Fieldproof private values require a configured encryption secret.");
  return createHash("sha256").update(`fieldproof-private-values-v1:${secret}`).digest();
}
export function sealPrivate(value: unknown, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}
export function openPrivate<T>(value: string, context: string): T {
  const [version, iv, tag, ciphertext, extra] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext || extra) throw new Error("The private value could not be read.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8")) as T;
}
function operationContext(context: OperationDocumentContext): string {
  return `paycore-operation:${context.scope.tenantId}:${context.scope.projectId}:${context.operationId}`;
}
export const paymentOperationCodec: OperationDocumentCodec = {
  encode: (plaintext, context) => sealPrivate(plaintext, operationContext(context)),
  decode: (ciphertext, context) => openPrivate<string>(ciphertext, operationContext(context)),
};
