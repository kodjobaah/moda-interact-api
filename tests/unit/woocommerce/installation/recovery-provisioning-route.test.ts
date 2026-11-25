import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { WooInstallationPrincipal } from "../../../../src/auth/woo-installation/principal.js";
import { CONNECT_ROUTE_PATH, createWooInstallationRoutes } from "../../../../src/woocommerce/installation/routes.js";
import { WooSiteControlRejectedError } from "../../../../src/woocommerce/installation/connection-service.js";

const principal = { installationId: "install_123", shopId: "shop_456", canonicalSiteUrl: "https://merchant.example", credentialVersion: 2 };
const credential = Buffer.alloc(32, 7).toString("base64url");
const request = { siteUrl: principal.canonicalSiteUrl, attemptId: "550e8400-e29b-41d4-a716-446655440000", bootstrapSecret: Buffer.alloc(32, 2).toString("base64url") };

async function exercise(options: { connection?: "CREATED" | "RECONNECTED"; deny?: boolean; fail?: boolean; elapsed?: number } = {}) {
  const calls: string[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const provisions: Array<{ principal: WooInstallationPrincipal; budget: number }> = [];
  const record = (event: string, fields: Record<string, unknown>) => { logs.push({ event, fields }); };
  let now = 1000;
  const connection = options.connection ?? "CREATED";
  const result = { ...principal, credential, connection };
  const route = createWooInstallationRoutes({ mode: "public", logger: { info: record, warn: record, error: record } as never,
    authenticator: {} as never, now: () => now,
    connectionService: { connect: async () => {
      calls.push("verified-connect");
      if (options.deny) throw new WooSiteControlRejectedError();
      now += options.elapsed ?? 0;
      calls.push("committed");
      return result;
    } } as never,
    recoveryTemplates: { provision: async (identity, budget = 0) => {
      calls.push("provision"); provisions.push({ principal: identity, budget });
      if (options.fail) throw new Error("injected template persistence failure");
    } },
  });
  const server = createServer((req, res) => {
    void route.handle(req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } }).catch(error => { res.statusCode = 500; res.end(String(error)); });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${CONNECT_ROUTE_PATH}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
    });
    return { status: response.status, body: await response.json(), calls, logs, provisions, result };
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test("connect and reconnect provision only the committed installation identity, never its secret", async () => {
  for (const connection of ["CREATED", "RECONNECTED"] as const) {
    const r = await exercise({ connection });
    assert.equal(r.status, connection === "CREATED" ? 201 : 200); assert.deepEqual(r.body, r.result);
    assert.deepEqual(r.calls, ["verified-connect", "committed", "provision"]);
    assert.deepEqual(r.provisions, [{ principal, budget: 8000 }]);
  }
});
test("post-commit provisioning failure does not invalidate a successful connection", async () => {
  const r = await exercise({ fail: true });
  assert.equal(r.status, 201); assert.deepEqual(r.body, r.result);
  assert.ok(r.logs.some(l => l.event === "woocommerce.onboarding.template_assignment.failed" && l.fields.errorMessage === "injected template persistence failure"));
});
test("failed site control does not provision; slow connect reduces remaining budget", async () => {
  const denied = await exercise({ deny: true }); assert.equal(denied.status, 422); assert.equal(denied.provisions.length, 0);
  const slow = await exercise({ elapsed: 24_500 }); assert.equal(slow.status, 201); assert.equal(slow.provisions[0]?.budget, 500);
  const exhausted = await exercise({ elapsed: 26_000 }); assert.equal(exhausted.status, 201); assert.equal(exhausted.provisions[0]?.budget, 0);
});
