import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

test("API-013 OpenAPI exposes only bounded installation-authenticated Recovery Detail reads", () => {
  const spec = parse(readFileSync(new URL("../../../../../openapi/merchant-recovery-detail-v1.yaml", import.meta.url), "utf8")) as {
    openapi: string;
    security: Array<Record<string, unknown>>;
    paths: Record<string, { get: { operationId: string; parameters: Array<{ name?: string }>; responses: Record<string, unknown> } }>;
    components: { schemas: Record<string, { properties: Record<string, { maxItems?: number }>; additionalProperties?: boolean }> };
  };
  assert.equal(spec.openapi, "3.1.0");
  assert.deepEqual(spec.security, [{ installationBearer: [], installationId: [] }]);
  const endpoints = [
    "/v1/merchant/recoveries/{recoveryId}",
    "/v1/merchant/recoveries/{recoveryId}/messages",
    "/v1/merchant/recoveries/{recoveryId}/related",
  ];
  assert.deepEqual(Object.keys(spec.paths), endpoints);
  for (const path of endpoints) {
    const route = spec.paths[path]?.get;
    assert.ok(route);
    assert.ok(route.parameters.some((param) => param.name === undefined || param.name === "recoveryId"));
    for (const code of ["200", "400", "401", "404", "409", "500"]) {
      assert.ok(route.responses[code], `${path}: response ${code}`);
    }
  }
  assert.equal(spec.components.schemas.MessagePage?.properties.items?.maxItems, 50);
  assert.equal(spec.components.schemas.RelatedPage?.properties.items?.maxItems, 5);
  assert.equal(spec.components.schemas.Basket?.properties.items?.maxItems, 50);
  const detailProps = spec.components.schemas.DetailSummary?.properties;
  for (const field of ["basket", "conversation", "humanMessagingAllowed", "humanMessagingStatus"]) {
    assert.ok(detailProps && field in detailProps, field);
  }
  const moderation = spec.components.schemas.Message?.properties;
  assert.ok(moderation && "moderationStatus" in moderation);
  assert.ok(moderation && "moderationReasonCode" in moderation);
  for (const key of ["DetailSummary", "MessagePage", "RelatedPage", "Message", "Related", "Money", "Basket", "BasketItem", "SnapshotMoney", "ConversationDetail"]) {
    assert.equal(spec.components.schemas[key]?.additionalProperties, false);
  }
  const json = JSON.stringify(spec);
  for (const forbidden of ["checkoutToken", "checkoutUrl", "providerMediaId", "providerMessageId", "shopId", "apiSecret"]) {
    assert.equal(json.includes(forbidden), false, forbidden);
  }
});
