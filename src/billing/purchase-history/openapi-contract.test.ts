import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { WOO_PURCHASE_HISTORY_ROUTE_PATH } from "./routes.js";

test("purchase-history OpenAPI exposes one GET-only authenticated merchant-safe read model", async () => {
  const source = await readFile(new URL("../../../openapi/woocommerce-billing-purchase-history-v1.yaml", import.meta.url), "utf8");
  const document = parse(source) as Record<string, unknown>;
  assert.equal(document.openapi, "3.1.0");
  const paths = document.paths as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(paths), [WOO_PURCHASE_HISTORY_ROUTE_PATH]);
  assert.deepEqual(Object.keys(paths[WOO_PURCHASE_HISTORY_ROUTE_PATH]!), ["get"]);
  const get = paths[WOO_PURCHASE_HISTORY_ROUTE_PATH]!.get as Record<string, unknown>;
  assert.deepEqual(get.security, [{ WooInstallationId: [], WooInstallationCredential: [] }]);
  const params = get.parameters as Array<{ name: string }>;
  assert.deepEqual(params.map(({ name }) => name), ["filter", "page", "pageSize"]);
  const components = document.components as Record<string, Record<string, Record<string, unknown>>>;
  for (const schema of Object.values(components.schemas!)) {
    if (schema.type === "object") assert.equal(schema.additionalProperties, false);
  }
  const history = components.schemas!.PurchaseHistory!;
  const request = components.schemas!.RefundRequest!;
  assert.equal((request.properties as Record<string, Record<string, unknown>>).url?.const,
    "https://woocommerce.com/my-account/orders/");
  assert.deepEqual((history.properties as Record<string, Record<string, unknown>>).refundRequest,
    { $ref: "#/components/schemas/RefundRequest" });
  assert.equal(source.includes("/reactivate"), false);
  assert.equal(source.includes("recovery-credit-refunds"), false);
});
