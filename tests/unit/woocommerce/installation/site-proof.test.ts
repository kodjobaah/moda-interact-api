import assert from "node:assert/strict";
import test from "node:test";
import { createSiteProof, verifySiteProof } from "../../../../src/woocommerce/installation/site-proof.js";

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

test("site proof denies a different attempt, nonce, or tampered proof", () => {
  const secret = Buffer.alloc(32, 19);
  const attempt = "connect-attempt";
  const nonce = Buffer.alloc(32, 9).toString("base64url");
  const site = "https://merchant.example/shop";
  const proof = createSiteProof(secret, attempt, nonce, site);
  assert.equal(verifySiteProof(secret, attempt, nonce, site, proof), true);
  assert.equal(verifySiteProof(secret, "other-attempt", nonce, site, proof), false);
  assert.equal(verifySiteProof(secret, attempt, Buffer.alloc(32, 10).toString("base64url"), site, proof), false);
  assert.equal(verifySiteProof(Buffer.alloc(32, 20), attempt, nonce, site, proof), false);
  assert.equal(verifySiteProof(secret, attempt, nonce, site, `z${proof.slice(1)}`), false);
  assert.equal(verifySiteProof(secret, attempt, nonce, site, `${proof}=`), false);
});
