import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { StructuredLogger } from "@modainteract/moda-interact-shared/logging";
import type { WooInstallationAuthenticator } from "../../../../src/auth/woo-installation/authenticator.js";
import { WooUnauthenticatedError } from "../../../../src/auth/woo-installation/authenticator.js";
import { createMerchantKnowledgeCommandRoute } from "../../../../src/merchant/merchant-knowledge/commands.routes.js";
import { KnowledgeCommandError, parseCreateWebSource, parseKnowledgeHttpsUrl, parsePatchWebSource,
  parseSourceGeneration, parseSourceOrder } from "../../../../src/merchant/merchant-knowledge/commands.contract.js";
import type { MerchantKnowledgeCommandService } from "../../../../src/merchant/merchant-knowledge/commands.service.js";

const rejects = (fn: () => unknown) => assert.throws(fn, (error: unknown) => error instanceof KnowledgeCommandError && error.status === 400);
const create = { name: "FAQ", purposeKey: "FAQ", dataFormatKey: "WEB_PAGE", url: "https://example.org/help", languageTag: "en" };

test("strict URL entry gate and Shared source types exclude SSRF candidates", () => {
  assert.equal(parseKnowledgeHttpsUrl("https://shop.example.org/help"), "https://shop.example.org/help");
  for (const value of ["http://example.org", "https://localhost", "https://127.0.0.1/private",
    "https://0x7f000001/private", "https://[::1]/", "https://foo.local/", "https://user:secret@example.org/",
    "https://example.org:8443/private", "https://example.org /", "https://metadata.google.internal/", "https://a.test/"]) {
    rejects(() => parseKnowledgeHttpsUrl(value));
  }
  for (const input of [{ ...create, dataFormatKey: "CSV" }, { ...create, languageTag: "zz" },
    { ...create, credential: "secret" }, { ...create, url: "https://localhost/" }]) {
    rejects(() => parseCreateWebSource(input));
  }
  // Reject ASCII control bytes even when URL parsing would otherwise strip them.
  for (const character of ["\u0000", "\u001f", "\u0020", "\u007f"]) {
    rejects(() => parseKnowledgeHttpsUrl(`https://example.org/${character}unsafe`));
  }
  for (const character of ["\u0000", "\u001f", "\u007f"]) {
    rejects(() => parseCreateWebSource({ ...create, name: `FAQ${character}unsafe` }));
  }
  assert.deepEqual(parseCreateWebSource(create), create);
});

test("command parsers reject duplicates, unknown fields and invalid CAS generations", () => {
  rejects(() => parsePatchWebSource({ expectedGeneration: 1 }));
  rejects(() => parsePatchWebSource({ expectedGeneration: 0, name: "Updated" }));
  rejects(() => parsePatchWebSource({ expectedGeneration: 1, url: "https://example.org", exploit: "secret" }));
  rejects(() => parseSourceGeneration({ expectedGeneration: 1, another: true }));
  rejects(() => parseSourceOrder({ sourceIds: ["s1", "s1"] }));
  rejects(() => parseSourceOrder({ sourceIds: ["s1", "../../../secret"] }));
  assert.deepEqual(parseSourceGeneration({ expectedGeneration: 2 }), { expectedGeneration: 2 });
  assert.deepEqual(parseSourceOrder({ sourceIds: ["a", "b"] }), { sourceIds: ["a", "b"] });
});

test("all five command endpoints require installation authentication and reject invalid bodies", async () => {
  const calls: string[] = [];
  const principal = { shopId: "shop1", installationId: "installation1", credentialVersion: 1, canonicalSiteUrl: "https://shop.example.org" };
  const auth = { authenticate: async () => principal } as unknown as WooInstallationAuthenticator;
  const logger = { info() {}, warn() {}, error() {} } as unknown as StructuredLogger;
  const knowledge = { schemaVersion: 1, sources: [] };
  const service = Object.fromEntries(["create", "patch", "remove", "refresh", "order"].map((method) =>
    [method, async () => { calls.push(method); return { sourceId: "s1", created: true, knowledge }; }])) as unknown as MerchantKnowledgeCommandService;
  const route = createMerchantKnowledgeCommandRoute({ authenticator: auth, service, logger });
  const server = createServer(async (req, res) => { if (!await route.handle(req, res)) { res.statusCode = 404; res.end(); } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const cases: Array<[string, string, unknown]> = [
      ["POST", "/v1/merchant/merchant-knowledge/sources", create],
      ["PATCH", "/v1/merchant/merchant-knowledge/sources/s1", { expectedGeneration: 1, name: "Edited" }],
      ["DELETE", "/v1/merchant/merchant-knowledge/sources/s1", { expectedGeneration: 1 }],
      ["POST", "/v1/merchant/merchant-knowledge/sources/s1/refresh", { expectedGeneration: 1 }],
      ["PUT", "/v1/merchant/merchant-knowledge/order", { sourceIds: ["s1"] }],
    ];
    for (const [method, path, input] of cases) {
      const response = await fetch(origin + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      assert.equal(response.status, method === "POST" && path.endsWith("/sources") ? 201 : 200, `${method} ${path}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.deepEqual(calls, ["create", "patch", "remove", "refresh", "order"]);
    const malformed = await fetch(origin + cases[0]![1], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...create, extra: "wrong" }) });
    assert.equal(malformed.status, 400);
    const authRoute = createMerchantKnowledgeCommandRoute({ authenticator: {
      authenticate: async () => { throw new WooUnauthenticatedError(); },
    } as unknown as WooInstallationAuthenticator, service, logger });
    const denyServer = createServer(async (req, res) => { await authRoute.handle(req, res); });
    await new Promise<void>((resolve) => denyServer.listen(0, "127.0.0.1", resolve));
    try {
      const denyAddress = denyServer.address(); assert.ok(denyAddress && typeof denyAddress !== "string");
      for (const [method, path, input] of cases) {
        const response: Response = await fetch(`http://127.0.0.1:${denyAddress.port}${path}`, { method,
          headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
        assert.equal(response.status, 401);
      }
    } finally { await new Promise<void>((resolve) => denyServer.close(() => resolve())); }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
