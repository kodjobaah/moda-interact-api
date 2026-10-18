/** Deterministic ADMIN-002 writer interoperability fixture (non-production credentials).
 * It is the CLOSED six-field decrypted `merchant.knowledge.r2` plaintext shape.
 * Do not substitute the API's r2-prefixed outward projection property names.
 */
export const adminR2PlaintextFixture = Object.freeze({
  endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`,
  bucket: "knowledge-bucket",
  accessKeyId: "fixture-only-access-key",
  secretAccessKey: "fixture-only-secret-key",
  maxUploadBytes: 10000,
  maxXlsxUncompressedBytes: 50000,
});
