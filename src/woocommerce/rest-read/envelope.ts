import {
  createWooRestReadGrantAad,
  decryptCredential,
  encryptCredential,
  type CredentialEnvelope,
  type CredentialKeyring,
} from "@modainteract/moda-interact-shared/security/credentials/node";
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

/** The API owns database-column mapping; Shared owns all cryptographic operations. */
function toDatabaseEnvelope(envelope: CredentialEnvelope): WooSealedGrant {
  return {
    credentialCiphertext: Buffer.from(envelope.ciphertext),
    credentialNonce: Buffer.from(envelope.nonce),
    credentialAuthTag: Buffer.from(envelope.authTag),
    encryptionKeyId: envelope.keyId,
  };
}

export function sealWooReadCredentials(
  credentials: WooRestReadCredential,
  context: WooGrantContext,
  config: Pick<WooRestReadAuthorizationConfig, "keyring" | "activeKeyId">,
): WooSealedGrant {
  return toDatabaseEnvelope(encryptCredential({
    keyring: config.keyring,
    activeKeyId: config.activeKeyId,
    plaintext: JSON.stringify([credentials.consumerKey, credentials.consumerSecret]),
    aad: createWooRestReadGrantAad(context),
  }));
}

/** Decrypted text is never trusted as valid Woo credential data without domain checks. */
export function openWooReadCredentials(
  envelope: WooSealedGrant,
  context: WooGrantContext,
  config: { keyring: CredentialKeyring },
): WooRestReadCredential {
  try {
    const text = decryptCredential({
      keyring: config.keyring,
      envelope: {
        keyId: envelope.encryptionKeyId,
        nonce: envelope.credentialNonce,
        ciphertext: envelope.credentialCiphertext,
        authTag: envelope.credentialAuthTag,
      },
      aad: createWooRestReadGrantAad(context),
    });
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length !== 2 || !parsed.every((item) => typeof item === "string")) {
      throw new Error("invalid");
    }
    return { consumerKey: parsed[0] as string, consumerSecret: parsed[1] as string };
  } catch {
    // Preserve the existing bounded provider-unavailable classification.
    throw new Error("woo_rest_read_envelope_invalid");
  }
}
