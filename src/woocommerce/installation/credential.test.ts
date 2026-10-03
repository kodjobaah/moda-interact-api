import assert from "node:assert/strict";
import test from "node:test";
import {
  constantTimeDigestMatches,
  createSiteProof,
  decodeSecret,
  digestSecret,
  encodeSecret,
  randomSecret,
  verifySiteProof,
} from "./credential.js";

test("installation secrets use exactly 32 random bytes and canonical base64url", () => {
  const secret = randomSecret();
  assert.equal(secret.length, 32);
  const encoded = encodeSecret(secret);
  assert.equal(encoded.length, 43);
  assert.deepEqual(decodeSecret(encoded), secret);
  assert.equal(decodeSecret(`${encoded}=`), undefined);
  assert.equal(decodeSecret("not-a-secret"), undefined);
});

test("credential digest is SHA-256 and comparisons reject wrong-length inputs", () => {
  const secret = Buffer.alloc(32, 7);
  const digest = digestSecret(secret);
  assert.equal(digest.length, 32);
  assert.equal(
    digest.toString("hex"),
    "4bb06f8e4e3a7715d201d573d0aa423762e55dabd61a2c02278fa56cc6d294e0",
  );
  assert.equal(constantTimeDigestMatches(digest, Buffer.from(digest)), true);
  assert.equal(constantTimeDigestMatches(digest, Buffer.alloc(31)), false);
});

test("site proof uses the fixed v1 message and verifies in constant time", () => {
  const secret = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");
  const attemptId = "550e8400-e29b-41d4-a716-446655440000";
  const nonce = Buffer.alloc(32, 1).toString("base64url");
  const site = "https://merchant.example/base";
  const proof = createSiteProof(secret, attemptId, nonce, site);
  assert.equal(proof, "VZak_spzGdmnwS6X79PVOzigQamKMNR0tdM_I69gtRU");
  assert.equal(verifySiteProof(secret, attemptId, nonce, site, proof), true);
  assert.equal(verifySiteProof(secret, attemptId, nonce, `${site}/wrong`, proof), false);
});