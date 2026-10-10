import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { WooRestReadAuthorizationConfig } from "./config.js";

export interface WooRestReadCredential {
  consumerKey: string;
  consumerSecret: string;
}

export interface WooGrantContext {
  shopId: string;
  installationId: string;
  authorizationAttemptId: string;
  credentialVersionSnapshot: number;
}

export interface WooSealedGrant {
  credentialCiphertext: Buffer;
  credentialNonce: Buffer;
  credentialAuthTag: Buffer;
  encryptionKeyId: string;
}

function aad(context: WooGrantContext): Buffer {
  return Buffer.from(JSON.stringify([
    "moda-woo-rest-read-v1", context.shopId, context.installationId,
    context.authorizationAttemptId, context.credentialVersionSnapshot,
  ]), "utf8");
}

export function sealWooReadCredentials(
  credentials: WooRestReadCredential,
  context: WooGrantContext,
  config: WooRestReadAuthorizationConfig,
): WooSealedGrant {
  const key = config.keys.get(config.activeKeyId);
  if (!key || key.byteLength !== 32) throw new Error("woo_rest_read_key_unavailable");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(context));
  const message = Buffer.from(JSON.stringify([credentials.consumerKey, credentials.consumerSecret]), "utf8");
  try {
    const credentialCiphertext = Buffer.concat([cipher.update(message), cipher.final()]);
    return { credentialCiphertext, credentialNonce: nonce, credentialAuthTag: cipher.getAuthTag(), encryptionKeyId: config.activeKeyId };
  } finally {
    message.fill(0);
  }
}

export function openWooReadCredentials(
  envelope: WooSealedGrant,
  context: WooGrantContext,
  config: Pick<WooRestReadAuthorizationConfig, "keys">,
): WooRestReadCredential {
  const key = config.keys.get(envelope.encryptionKeyId);
  if (!key || key.byteLength !== 32 || envelope.credentialNonce.length !== 12 || envelope.credentialAuthTag.length !== 16) {
    throw new Error("woo_rest_read_envelope_invalid");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.credentialNonce);
    decipher.setAAD(aad(context));
    decipher.setAuthTag(envelope.credentialAuthTag);
    const plaintext = Buffer.concat([decipher.update(envelope.credentialCiphertext), decipher.final()]);
    try {
      const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
      if (!Array.isArray(parsed) || parsed.length !== 2 || !parsed.every((item) => typeof item === "string")) {
        throw new Error("invalid");
      }
      return { consumerKey: parsed[0] as string, consumerSecret: parsed[1] as string };
    } finally {
      plaintext.fill(0);
    }
  } catch {
    throw new Error("woo_rest_read_envelope_invalid");
  }
}
