import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { once } from "node:events";
import { canonicalizeWooSiteUrl } from "../installation/site-url.js";
import { WooReadCredentialVerifier, WooReadVerificationError } from "./credential-verifier.js";
import { prepareWooProductRequest } from "./product-operation.js";

const credential = { consumerKey: "ck_example", consumerSecret: "cs_example" };

async function startFixture(status: number, payload: unknown, encoding?: string) {
  const requests: Array<{ method: string | undefined; url: string | undefined; authorization: string | undefined }> = [];
  const server: Server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    response.writeHead(status, {
      "content-type": "application/json; charset=UTF-8",
      ...(encoding ? { "content-encoding": encoding } : {}),
      ...(status >= 300 && status < 400 ? { location: "http://127.0.0.1:9/steal" } : {}),
    });
    response.end(JSON.stringify(payload));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server, requests,
    site: canonicalizeWooSiteUrl(`http://localhost:${address.port}`, "local-development"),
    close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

function transport(mode: "public" | "local-development" = "local-development") {
  return new WooReadCredentialVerifier({ mode, timeoutMs: 3000, resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
}

test("approved local product GET is pinned to resolved IP and never sends keys in URLs", async () => {
  const fixture = await startFixture(200, [{ id: 4, name: "Cap", sku: "CAP", price: "7", stock_status: "instock", stock_quantity: 2 }]);
  try {
    const request = { operation: "products.list" as const, perPage: 1, search: "帽子" };
    const result = await transport().fetchProductOperation(fixture.site, credential, request);
    assert.ok(Array.isArray(result));
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0]?.method, "GET");
    const path = fixture.requests[0]?.url ?? "";
    assert.equal(new URL(path, "http://localhost").pathname, "/wp-json/wc/v3/products");
    assert.equal(new URL(path, "http://localhost").searchParams.get("context"), "view");
    assert.equal(path.includes("ck_example"), false);
    assert.equal(path.includes("cs_example"), false);
    assert.equal(fixture.requests[0]?.authorization,
      `Basic ${Buffer.from("ck_example:cs_example").toString("base64")}`);
  } finally { await fixture.close(); }
});

test("redirect is rejected rather than following the credential header", async () => {
  const fixture = await startFixture(302, { error: "redirect" });
  try {
    await assert.rejects(() => transport().fetchProductOperation(fixture.site, credential,
      { operation: "products.retrieve", productId: 123 }),
    (error: unknown) => error instanceof WooReadVerificationError && error.reason === "invalid_response");
    assert.equal(fixture.requests.length, 1);
  } finally { await fixture.close(); }
});

test("authorization failure, provider unavailability and oversized content fail closed", async () => {
  for (const [status, payload, expected] of [
    [401, { code: "woocommerce_rest_cannot_view" }, "rejected_credentials"],
    [403, { code: "forbidden" }, "rejected_credentials"],
    [503, { code: "unavailable" }, "provider_unavailable"],
    [200, "x".repeat(150000), "invalid_response"],
  ] as const) {
    const fixture = await startFixture(status, payload);
    try {
      await assert.rejects(() => transport().fetchProductOperation(fixture.site, credential,
        { operation: "products.list" }),
      (error: unknown) => error instanceof WooReadVerificationError && error.reason === expected);
    } finally { await fixture.close(); }
  }
});

test("public network mode refuses a local/private DNS answer", async () => {
  const fixture = await startFixture(200, []);
  try {
    await assert.rejects(() => transport("public").fetchProductOperation(fixture.site, credential,
      { operation: "products.list" }),
    (error: unknown) => error instanceof WooReadVerificationError && error.reason === "unsafe_target");
    assert.equal(fixture.requests.length, 0);
  } finally { await fixture.close(); }
});

test("transport compiles operation itself and rejects forged generic paths", async () => {
  const fixture = await startFixture(200, []);
  try {
    assert.equal(prepareWooProductRequest({ operation: "products.list" }).operation, "products.list");
    await assert.rejects(() => transport().fetchProductOperation(fixture.site, credential,
      { operation: "products.list", headers: { authorization: "injected" } } as never));
    assert.equal(fixture.requests.length, 0);
  } finally { await fixture.close(); }
});
