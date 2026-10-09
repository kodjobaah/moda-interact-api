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

test("Woo connection mode defaults to public and accepts explicit local development", () => {
  const base = { DATABASE_URL: "postgresql://user:secret@localhost:5432/moda" };
  assert.equal(loadRuntimeConfig(base).woocommerceConnectionMode, "public");
  assert.equal(
    loadRuntimeConfig({
      ...base,
      MODA_WOOCOMMERCE_CONNECTION_MODE: "local-development",
    }).woocommerceConnectionMode,
    "local-development",
  );
});

test("Woo connection mode rejects unknown values and local development in production", () => {
  const databaseUrl = "postgresql://user:secret@localhost:5432/moda";
  assert.throws(
    () =>
      loadRuntimeConfig({
        DATABASE_URL: databaseUrl,
        MODA_WOOCOMMERCE_CONNECTION_MODE: "development",
      }),
    /must be public or local-development/,
  );
  assert.throws(
    () =>
      loadRuntimeConfig({
        DATABASE_URL: databaseUrl,
        NODE_ENV: "production",
        MODA_WOOCOMMERCE_CONNECTION_MODE: "local-development",
      }),
    /forbidden in production/,
  );
});

test("Woo billing runtime configuration is optional but complete and environment-bounded when supplied", () => {
  const databaseUrl = "postgresql://user:secret@localhost:5432/moda";
  assert.equal(loadRuntimeConfig({ DATABASE_URL: databaseUrl }).wooBilling, null);
  assert.equal(loadRuntimeConfig({
    DATABASE_URL: databaseUrl,
    WOO_BILLING_ENVIRONMENT: "sandbox",
    WOO_BILLING_API_KEY: "secret-key",
    WOO_BILLING_API_SECRET: "secret-value",
  }).wooBilling?.baseUrl, "https://sandbox.woocommerce.com/wp-json/wccom/billing/1.0/");
  assert.throws(() => loadRuntimeConfig({
    DATABASE_URL: databaseUrl,
    WOO_BILLING_ENVIRONMENT: "https://provider.example",
    WOO_BILLING_API_KEY: "secret-key",
    WOO_BILLING_API_SECRET: "secret-value",
  }), /WOO_BILLING_ENVIRONMENT must be sandbox or production/);
});