import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import type { ModaSupportedLanguageTag } from "@modainteract/moda-interact-shared/internationalization";
import { createWooRestReadAuthorizationRoutes } from "./authorization.routes.js";

const token = Buffer.alloc(32, 15).toString("base64url");
const payload = {
  key_id: 12, user_id: "attempt_opaque_12",
  consumer_key: `ck_${"a".repeat(40)}`, consumer_secret: `cs_${"b".repeat(40)}`,
  key_permissions: "read",
};

async function withRoutes(
  callback: (origin: string, logs: string[], calls: string[]) => Promise<void>,
  resolveLocale: (attemptId: string | null) => Promise<ModaSupportedLanguageTag> = async () => "en",
): Promise<void> {
  const logs: string[] = [];
  const calls: string[] = [];
  const logger = createLogger({ serviceName: "woo-rest-read-test", environment: "test", sink: (line) => logs.push(JSON.stringify(line)) });
  const handler = createWooRestReadAuthorizationRoutes({
    authenticator: {
      authenticate: async (request: { headers: Record<string, unknown> }) => {
        if (request.headers.authorization !== "Bearer test-installation-credential") throw new Error("unauthorized");
        calls.push("authenticate");
        return { shopId: "shop-1", installationId: "installation-1", credentialVersion: 1, canonicalSiteUrl: "https://shop.example.org" };
      },
    } as never,
    service: {
      start: async (_principal: unknown, adminLocale?: string) => {
        calls.push(adminLocale ? `start:${adminLocale}` : "start");
        return { schemaVersion: 1, authorizationUrl: "https://shop.example.org/consent", expiresAt: "2026-10-10T15:00:00.000Z" };
      },
      status: async () => { calls.push("status"); return { schemaVersion: 1, status: "NOT_CONNECTED", providerRevocationRequired: false }; },
      revoke: async () => { calls.push("revoke"); return { schemaVersion: 1, status: "REVOKED", providerRevocationRequired: true }; },
      callback: async (_token: string, data: { key_permissions: string }) => { calls.push(`callback:${data.key_permissions}`); },
      returnLocale: async (attemptId: string | null, locale?: string | null, proof?: string | null) => {
        calls.push(`returnLocale:${attemptId ?? "missing"}${locale ? `:${locale}:${proof ?? ""}` : ""}`);
        return resolveLocale(attemptId);
      },
    } as never,
    logger,
  });
  const server = createServer((req, res) => { void handler.handle(req, res).then((handled) => {
    if (!handled) { res.writeHead(404); res.end(); }
  }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await callback(`http://127.0.0.1:${address.port}`, logs, calls);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  }
}

test("installation-authenticated start, read, revoke use no-store and do not log URLs", async () => {
  await withRoutes(async (origin, logs, calls) => {
    const headers = { Authorization: "Bearer test-installation-credential" };
    const start = await fetch(`${origin}/v1/woocommerce/read-authorizations`, { method: "POST", headers });
    assert.equal(start.status, 201);
    assert.equal(start.headers.get("cache-control"), "no-store");
    assert.equal((await start.json() as { authorizationUrl: string }).authorizationUrl, "https://shop.example.org/consent");
    const status = await fetch(`${origin}/v1/woocommerce/read-authorization`, { headers });
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { status: string }).status, "NOT_CONNECTED");
    const revoke = await fetch(`${origin}/v1/woocommerce/read-authorization`, { method: "DELETE", headers });
    assert.equal(revoke.status, 200);
    assert.equal((await revoke.json() as { status: string }).status, "REVOKED");
    assert.deepEqual(calls, ["authenticate", "start", "authenticate", "status", "authenticate", "revoke"]);
    assert.equal(logs.join("\n").includes("shop.example.org/consent"), false);
    const invalid = await fetch(`${origin}/v1/woocommerce/read-authorizations?redirect=https://evil.test`, { method: "POST", headers });
    assert.equal(invalid.status, 400);
  });
});

test("start accepts only a bounded administrator locale from the authenticated plugin", async () => {
  await withRoutes(async (origin, _logs, calls) => {
    const url = `${origin}/v1/woocommerce/read-authorizations`;
    const result = await fetch(url, { method: "POST", headers: {
      Authorization: "Bearer test-installation-credential", "X-Moda-Admin-Locale": "de_DE",
    } });
    assert.equal(result.status, 201);
    assert.deepEqual(calls, ["authenticate", "start:de_DE"]);
    const bad = await fetch(url, { method: "POST", headers: {
      Authorization: "Bearer test-installation-credential", "X-Moda-Admin-Locale": "../../en",
    } });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json() as { error: string }).error, "invalid_locale");
    assert.deepEqual(calls, ["authenticate", "start:de_DE", "authenticate"]);
  });
});

test("callback demands exact read payload, never echoes or logs keys or secret path", async () => {
  await withRoutes(async (origin, logs, calls) => {
    const endpoint = `${origin}/v1/woocommerce/read-authorizations/callback/${token}`;
    const wrongPermissions = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, key_permissions: "read_write" }) });
    assert.equal(wrongPermissions.status, 422);
    const extra = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, shopId: "evil" }) });
    assert.equal(extra.status, 400);
    const success = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    // Native WooCommerce rejects all callback statuses other than HTTP 200.
    assert.equal(success.status, 200);
    assert.equal(success.headers.get("cache-control"), "no-store");
    assert.deepEqual(calls, ["callback:read"]);
    for (const secret of [token, payload.consumer_key, payload.consumer_secret]) {
      assert.equal(logs.join("\n").includes(secret), false);
    }
    const returnPage = await fetch(`${origin}/v1/woocommerce/read-authorizations/return?success=0&user_id=${token}`);
    assert.equal(returnPage.status, 200);
    assert.equal((await returnPage.text()).includes(token), false);
    assert.equal(returnPage.headers.get("referrer-policy"), "no-referrer");
  });
});

test("browser return localises by the persisted attempt's shop, not its query parameters", async () => {
  await withRoutes(async (origin, logs, calls) => {
    const completed = await fetch(`${origin}/v1/woocommerce/read-authorizations/return?success=1&user_id=attempt-de&locale=fr`);
    assert.equal(completed.status, 200);
    assert.equal(completed.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(completed.headers.get("content-language"), "de");
    assert.equal(completed.headers.get("cache-control"), "no-store");
    assert.equal(completed.headers.get("referrer-policy"), "no-referrer");
    assert.match(completed.headers.get("content-security-policy") ?? "", /style-src 'sha256-[A-Za-z0-9+/=]+'/);
    assert.match(completed.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const html = await completed.text();
    assert.match(html, /<html lang="de">/);
    assert.match(html, /Kehren Sie zum WooCommerce-Administrationsbereich zurück/);
    assert.doesNotMatch(html, /attempt-de|locale=fr|consumer_secret|authorization was not completed/);

    const cancelled = await fetch(`${origin}/v1/woocommerce/read-authorizations/return?success=0&user_id=attempt-fr`);
    assert.equal(cancelled.headers.get("content-language"), "fr");
    assert.match(await cancelled.text(), /L’autorisation WooCommerce n’a pas été finalisée/);
    assert.deepEqual(calls, ["returnLocale:attempt-de", "returnLocale:attempt-fr"]);
    assert.equal(logs.join("\n").includes("attempt-de"), false);
  }, async (id) => id === "attempt-de" ? "de" : "fr");
});

test("browser return passes presentation proof for verification, without reflecting it", async () => {
  await withRoutes(async (origin, _logs, calls) => {
    const proof = "a".repeat(43);
    const response = await fetch(`${origin}/v1/woocommerce/read-authorizations/return?success=1&user_id=attempt-a&display_locale=en&display_proof=${proof}`);
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [`returnLocale:attempt-a:en:${proof}`]);
    const body = await response.text();
    assert.doesNotMatch(body, new RegExp(proof));
  });
});

test("return locale lookup failure falls back to English without revealing errors", async () => {
  await withRoutes(async (origin, logs) => {
    const result = await fetch(`${origin}/v1/woocommerce/read-authorizations/return?success=1&user_id=opaque-id`);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("content-language"), "en");
    const text = await result.text();
    assert.match(text, /Return to your WooCommerce admin/);
    assert.doesNotMatch(text, /opaque-id|database connection failed/);
    assert.ok(logs.join("\n").includes("woocommerce.rest_read.return_locale.unavailable"));
    assert.equal(logs.join("\n").includes("opaque-id"), false);
  }, async () => { throw new Error("database connection failed"); });
});
