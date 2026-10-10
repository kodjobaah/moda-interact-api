import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { createWooRestReadAuthorizationRoutes } from "./authorization.routes.js";

const token = Buffer.alloc(32, 15).toString("base64url");
const payload = {
  key_id: 12, user_id: "attempt_opaque_12",
  consumer_key: `ck_${"a".repeat(40)}`, consumer_secret: `cs_${"b".repeat(40)}`,
  key_permissions: "read",
};

async function withRoutes(
  callback: (origin: string, logs: string[], calls: string[]) => Promise<void>,
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
      start: async () => {
        calls.push("start");
        return { schemaVersion: 1, authorizationUrl: "https://shop.example.org/consent", expiresAt: "2026-10-10T15:00:00.000Z" };
      },
      status: async () => { calls.push("status"); return { schemaVersion: 1, status: "NOT_CONNECTED", providerRevocationRequired: false }; },
      revoke: async () => { calls.push("revoke"); return { schemaVersion: 1, status: "REVOKED", providerRevocationRequired: true }; },
      callback: async (_token: string, data: { key_permissions: string }) => { calls.push(`callback:${data.key_permissions}`); },
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
    assert.equal(success.status, 204);
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
