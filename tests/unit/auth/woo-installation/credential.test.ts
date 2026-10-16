import assert from "node:assert/strict";
import test from "node:test";
import {
  constantTimeDigestMatches,
  decodeSecret,
  digestSecret,
  encodeSecret,
  randomSecret,
} from "../../../../src/auth/woo-installation/credential.js";

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
