import assert from "node:assert/strict";
import test from "node:test";
import { WooBillingClient, WooBillingProviderError } from "./woo-billing-client.js";
import { loadWooBillingConfig } from "./woo-billing-config.js";

const sandbox = loadWooBillingConfig({
  WOO_BILLING_ENVIRONMENT: "sandbox",
  WOO_BILLING_API_KEY: "test-key",
  WOO_BILLING_API_SECRET: "test-secret",
})!;

test("Woo billing config selects only fixed HTTPS sandbox and production hosts", () => {
  assert.equal(loadWooBillingConfig({}), null);
  assert.equal(sandbox.baseUrl, "https://sandbox.woocommerce.com/wp-json/wccom/billing/1.0/");
  assert.equal(loadWooBillingConfig({
    WOO_BILLING_ENVIRONMENT: "production", WOO_BILLING_API_KEY: "key", WOO_BILLING_API_SECRET: "secret",
  })?.baseUrl, "https://woocommerce.com/wp-json/wccom/billing/1.0/");
  assert.throws(() => loadWooBillingConfig({ WOO_BILLING_ENVIRONMENT: "https://evil.invalid" }), /must be sandbox or production/);
  assert.throws(() => loadWooBillingConfig({ WOO_BILLING_ENVIRONMENT: "sandbox", WOO_BILLING_API_KEY: "key" }), /required together/);
});

test("provider client sends Basic auth, JSON and disables redirects", async () => {
  let call: { url: URL; init: RequestInit } | undefined;
  const client = new WooBillingClient(sandbox, async (input, init) => {
    call = { url: new URL(String(input)), init: init! };
    return new Response(JSON.stringify({ id: "woo-id", confirmation_url: "https://sandbox.woocommerce.com/confirm" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  });
  const response = await client.createSubscription({
    name: "Growth", price: "19.99", billing_period: "month", billing_interval: 1,
    return_url: "https://merchant.example/wp-admin/admin.php",
  });
  assert.deepEqual(response, { id: "woo-id", confirmation_url: "https://sandbox.woocommerce.com/confirm" });
  assert.equal(call?.url.href, "https://sandbox.woocommerce.com/wp-json/wccom/billing/1.0/subscriptions");
  assert.equal((call?.init.headers as Record<string, string>).authorization, `Basic ${Buffer.from("test-key:test-secret").toString("base64")}`);
  assert.equal(call?.init.redirect, "manual");
  assert.equal((call?.init.headers as Record<string, string>)["content-type"], "application/json");
  assert.ok(call?.init.signal);
});

test("provider client rejects redirects/5xx ambiguously and complete 4xx definitely", async () => {
  for (const [status, outcome] of [[302, "OUTCOME_UNKNOWN"], [503, "OUTCOME_UNKNOWN"], [422, "DEFINITE_REJECTION"]] as const) {
    const client = new WooBillingClient(sandbox, async () => new Response("secret-provider-body", { status }));
    await assert.rejects(client.createSubscription({
      name: "Growth", price: "19.99", billing_period: "month", billing_interval: 1,
      return_url: "https://merchant.example/return",
    }), (error: unknown) => {
      assert.ok(error instanceof WooBillingProviderError);
      assert.equal(error.outcome, outcome);
      assert.doesNotMatch(error.message, /secret-provider-body/);
      return true;
    });
  }
});

test("provider client bounds streamed response bodies and treats malformed success as unknown", async () => {
  const largeClient = new WooBillingClient(sandbox, async () => new Response("x".repeat(65 * 1024), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  await assert.rejects(largeClient.createSubscription({
    name: "Growth", price: "19.99", billing_period: "month", billing_interval: 1,
    return_url: "https://merchant.example/return",
  }), (error: unknown) => error instanceof WooBillingProviderError && error.outcome === "OUTCOME_UNKNOWN");

  const malformedClient = new WooBillingClient(sandbox, async () => new Response("not json", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  await assert.rejects(malformedClient.createSubscription({
    name: "Growth", price: "19.99", billing_period: "month", billing_interval: 1,
    return_url: "https://merchant.example/return",
  }), (error: unknown) => error instanceof WooBillingProviderError && error.safeCode === "PROVIDER_RESPONSE_INVALID");

  const wrongMediaType = new WooBillingClient(sandbox, async () => new Response("{}", {
    status: 200,
    headers: { "content-type": "text/plain" },
  }));
  await assert.rejects(wrongMediaType.createSubscription({
    name: "Growth", price: "19.99", billing_period: "month", billing_interval: 1,
    return_url: "https://merchant.example/return",
  }), (error: unknown) => error instanceof WooBillingProviderError && error.safeCode === "PROVIDER_RESPONSE_INVALID");
});

test("provider client accepts an empty successful cancellation response", async () => {
  const client = new WooBillingClient(sandbox, async (input, init) => {
    assert.equal(new URL(String(input)).pathname.endsWith("/subscriptions/contract%2Fid"), true);
    assert.equal(init?.method, "DELETE");
    assert.equal(init?.body, undefined);
    return new Response(null, { status: 204 });
  });
  await client.cancelSubscription("contract/id");
});

test("provider transport failures are ambiguous and are never automatically retried", async () => {
  let attempts = 0;
  const client = new WooBillingClient(sandbox, async () => {
    attempts += 1;
    throw new Error("secret transport detail");
  });
  await assert.rejects(client.createSubscription({
    name: "Growth", price: "19.99", billing_period: "month", billing_interval: 1,
    return_url: "https://merchant.example/return",
  }), (error: unknown) => {
    assert.ok(error instanceof WooBillingProviderError);
    assert.equal(error.outcome, "OUTCOME_UNKNOWN");
    assert.equal(error.safeCode, "PROVIDER_TRANSPORT_ERROR");
    assert.doesNotMatch(error.message, /secret transport detail/);
    return true;
  });
  assert.equal(attempts, 1);
});