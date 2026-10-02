import assert from "node:assert/strict";
import test from "node:test";
import { loadRuntimeConfig } from "./runtime-config.js";

test("runtime config requires a valid PostgreSQL URL without echoing it", () => {
  const secret = "postgresql://user:private-secret@[";
  assert.throws(
    () => loadRuntimeConfig({ DATABASE_URL: secret }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /private-secret/);
      return /valid PostgreSQL URL/.test(error.message);
    },
  );
  assert.throws(() => loadRuntimeConfig({}), /DATABASE_URL is required/);
});

test("runtime config honors PORT and binds to all interfaces", () => {
  const config = loadRuntimeConfig({
    DATABASE_URL: "postgresql://user:secret@localhost:5432/moda",
    PORT: "4567",
  });
  assert.equal(config.port, 4567);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.readinessTimeoutMs, 2000);
});

test("runtime config rejects invalid ports without exposing database credentials", () => {
  assert.throws(
    () =>
      loadRuntimeConfig({
        DATABASE_URL: "postgresql://user:private-secret@localhost:5432/moda",
        PORT: "70000",
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /private-secret/);
      return /PORT must be an integer/.test(error.message);
    },
  );
});